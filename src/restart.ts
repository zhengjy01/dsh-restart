/**
 * dsh-restart — the restart engine (host half).
 *
 * A host cannot restart itself in place: the moment it exits, the browser has
 * nothing to talk to, and any failure would be invisible. So the handoff goes
 * through a detached helper process that survives the host:
 *
 *   panel / tool ──POST /api/dsh-restart/restart──▶ host
 *   host ──writes pending-spec.json, spawns helper──▶ helper (detached)
 *   host ──SIGTERM after a short delay──▶ exit
 *   helper ──waits for the port to free, relaunches the same command──▶ new host
 *   helper ──status.json + fallback console──▶ the page shows progress / errors
 *
 * The relaunch reuses the exact invocation the running host was started with
 * (`process.execArgv` + `argv[1:]`), so `dsh web --port 3080`, a `node` path
 * override, a custom port and a custom cwd all survive a restart unchanged.
 */

import { spawn } from 'node:child_process'
import { access, chmod, mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises'
import { constants, realpathSync } from 'node:fs'
import { dirname, join } from 'node:path'

import { detectLaunchd, kickCommand, type LaunchdInfo } from './launchd.ts'
import {
  appendHistory,
  ensureLayout,
  loadConfig,
  restartHome,
  helperPath,
  logsDir,
  specPath,
  statusPath,
  type RestartConfig,
  type RestartRecord,
} from './config.ts'

/** Everything the panel needs to describe the running host. */
export interface HostInfo {
  pid: number
  ppid: number
  startedAt: string
  uptimeMs: number
  /** Port the host is actually listening on. */
  port: number
  host: string
  url: string
  cwd: string
  nodeVersion: string
  dshVersion: string
  profile: string
  /** Full relaunch command, for display. */
  command: string
  /** True when this host was itself started by a restart helper. */
  restarted: boolean
  platform: string
  logsDir: string
  statusFile: string
  helperFile: string
  helperExists: boolean
  /** macOS launchd job managing this host, when there is one. */
  launchd: {
    managed: boolean
    label: string
    state: string
    pid: number | null
    plistPath: string
    /** Log file the job's stdout/stderr land in ('' when the plist is silent). */
    logFile: string
    /** Which strategy a restart will use right now. */
    strategy: 'helper' | 'launchd'
  }
}

/** Live state written by the detached helper (all fields optional). */
export interface HelperStatus {
  ok?: boolean
  /** Marker set by our own helper; absent on anything else bound to that port. */
  helper?: string
  mode?: 'spawn' | 'observe'
  phase?: string
  attempt?: number
  maxAttempts?: number
  port?: number
  url?: string
  fallbackPort?: number | null
  fallbackUrl?: string
  oldPid?: number | null
  childPid?: number | null
  childExit?: { code: number | null; signal: string | null; at: string } | null
  startedAt?: string
  elapsedMs?: number
  readyAt?: string | null
  bootMs?: number | null
  failure?: { kind: string; message: string; exitCode?: number | null } | null
  logFile?: string | null
  statusFile?: string | null
  errorLines?: { t: number; text: string }[]
  tail?: string[]
  dshVersion?: string | null
  profile?: string | null
  argv?: string[]
}

/** Launch specification handed to the helper. */
export interface RestartSpec {
  port: number
  host: string
  url: string
  file: string
  args: string[]
  cwd: string
  env: NodeJS.ProcessEnv
  oldPid: number
  logFile: string
  statusFile: string
  fallbackPort: number
  bootTimeoutMs: number
  maxAttempts: number
  killGraceMs: number
  portFreeTimeoutMs: number
  lingerMs: number
  readyConfirmMs: number
  bootWatchMs: number
  ringLines: number
  dshVersion: string
  profile: string
  /**
   * `spawn` — the helper relaunches the host itself.
   * `observe` — something else owns the relaunch (launchd); the helper kicks it
   *   and then only watches, so two processes never race for the port.
   */
  mode: 'spawn' | 'observe'
  owner: string
  kickCommand: string[]
  kickDelayMs: number
  observeLog: string
  /** Single self-contained report the helper writes when a boot fails. */
  failureReport: string
}

/**
 * Lines that usually carry the reason a boot failed. The stack-frame branch
 * insists on a real file-ish frame so timestamps ("… at 2026-09-12T02:08:18Z")
 * are not mistaken for errors.
 */
const ERROR_HINT = new RegExp(
  [
    '\\bError\\b', '\\bERROR\\b', 'error:', 'EADDRINUSE', 'ECONNREFUSED', 'ENOENT', 'EACCES',
    'MODULE_NOT_FOUND', 'Cannot find (module|package)', 'UnhandledPromiseRejection',
    'uncaughtException', 'FATAL', 'fatal:', 'SyntaxError', 'TypeError', 'ReferenceError',
    'is not a function', 'failed to load', '加载失败', '启动失败',
    '\\bat\\s+.*(?:\\.(?:js|mjs|cjs|ts|tsx|jsx|json)|node:[\\w/]+):\\d+:\\d+',
  ].join('|'),
)

/** True when a pid is alive (signal 0 probe). */
export function isAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

/** Cached launchd detection (the check shells out, so do not repeat it per poll). */
let launchdCache: { at: number; info: LaunchdInfo | null } | null = null
const LAUNCHD_TTL_MS = 30_000

/** Detect (and cache) the launchd job managing this host. */
export async function launchdInfo(force = false): Promise<LaunchdInfo | null> {
  if (!force && launchdCache !== null && Date.now() - launchdCache.at < LAUNCHD_TTL_MS) return launchdCache.info
  const info = await detectLaunchd().catch(() => null)
  launchdCache = { at: Date.now(), info }
  return info
}

/** Read the DSH version from the package that owns the running entry script. */
async function readDshVersion(): Promise<string> {
  const entry = process.argv[1]
  if (typeof entry !== 'string' || entry === '') return ''
  // `dsh` is usually a symlink (/opt/homebrew/bin/dsh →
  // …/lib/node_modules/@deepseek-ai/dsh/lib/bin.js), so resolve it before
  // walking up to the owning package.json.
  let resolved = entry
  try {
    resolved = realpathSync(entry)
  } catch {
    resolved = entry
  }
  // lib/bin.js → package root; walks up a couple of levels to be safe.
  let dir = dirname(resolved)
  for (let i = 0; i < 3; i++) {
    try {
      const text = await readFile(join(dir, 'package.json'), 'utf8')
      const parsed: unknown = JSON.parse(text)
      const name = (parsed as { name?: unknown }).name
      const version = (parsed as { version?: unknown }).version
      if (typeof version === 'string' && typeof name === 'string' && name.includes('dsh')) return version
      if (typeof version === 'string' && i === 1) return version
    } catch {
      /* keep walking up */
    }
    dir = dirname(dir)
  }
  return ''
}

/** Best-effort profile name for diagnostics. */
function readProfile(): string {
  for (const key of ['DSH_PROFILE', 'DSH_ACTIVE_PROFILE', 'DSH_PROFILE_NAME'] as const) {
    const value = process.env[key]
    if (typeof value === 'string' && value.trim() !== '') return value.trim()
  }
  const args = process.argv.slice(2)
  const index = args.findIndex((token) => token === '--profile' || token === '-P')
  if (index >= 0 && typeof args[index + 1] === 'string') return args[index + 1] ?? ''
  return ''
}

/** The relaunch command, exactly as this host was started. */
export function launchSignature(): { file: string; args: string[]; cwd: string } {
  const entry = process.argv[1] ?? ''
  return {
    file: process.argv[0] ?? process.execPath,
    args: [...process.execArgv, entry, ...process.argv.slice(2)],
    cwd: process.cwd(),
  }
}

/** Describe the running host. */
export async function hostInfo(options: { port: number; host: string; url: string }): Promise<HostInfo> {
  const signature = launchSignature()
  const helper = helperPath()
  let helperExists = false
  try {
    await access(helper, constants.R_OK)
    helperExists = true
  } catch {
    helperExists = false
  }
  const helperPid = Number(process.env.DSH_RESTART_HELPER_PID ?? '')
  const { config } = await loadConfig()
  const job = config.restartMode === 'helper' ? null : await launchdInfo()
  const forced = config.restartMode === 'launchd'
  return {
    pid: process.pid,
    ppid: process.ppid,
    startedAt: new Date(Date.now() - process.uptime() * 1000).toISOString(),
    uptimeMs: Math.round(process.uptime() * 1000),
    port: options.port,
    host: options.host,
    url: options.url,
    cwd: signature.cwd,
    nodeVersion: process.version,
    dshVersion: await readDshVersion(),
    profile: readProfile(),
    command: [signature.file, ...signature.args].join(' '),
    restarted: Number.isInteger(helperPid) && helperPid > 0,
    platform: process.platform,
    logsDir: logsDir(),
    statusFile: statusPath(),
    helperFile: helper,
    helperExists,
    launchd: {
      managed: job !== null,
      label: job?.label ?? '',
      state: job?.state ?? '',
      pid: job?.pid ?? null,
      plistPath: job?.plistPath ?? '',
      logFile: job?.stderrPath !== undefined && job.stderrPath !== '' ? job.stderrPath : (job?.stdoutPath ?? ''),
      strategy: job !== null || forced ? (job === null ? 'helper' : 'launchd') : 'helper',
    },
  }
}

/** Timestamp used in log file names (filesystem-safe, local time). */
function stamp(): string {
  const now = new Date()
  const pad = (value: number, width = 2): string => String(value).padStart(width, '0')
  return (
    `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}` +
    `-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`
  )
}

/** Build the helper spec for a restart of the current host. */
export async function buildSpec(options: {
  config: RestartConfig
  port: number
  host: string
  url: string
  /** Managing launchd job, when the restart will be delegated to it. */
  launchd?: LaunchdInfo | null
}): Promise<RestartSpec> {
  const signature = launchSignature()
  const logFile = join(logsDir(), `${stamp()}-${process.pid}.log`)
  const job = options.launchd ?? null
  return {
    port: options.port,
    host: options.host,
    url: options.url,
    file: signature.file,
    args: signature.args,
    cwd: signature.cwd,
    env: { ...process.env },
    oldPid: process.pid,
    logFile,
    statusFile: statusPath(),
    fallbackPort: options.config.fallbackPort,
    bootTimeoutMs: options.config.bootTimeoutMs,
    maxAttempts: options.config.maxAttempts,
    killGraceMs: options.config.killGraceMs,
    portFreeTimeoutMs: options.config.portFreeTimeoutMs,
    lingerMs: options.config.lingerMs,
    readyConfirmMs: options.config.readyConfirmMs,
    bootWatchMs: options.config.bootWatchMs,
    ringLines: options.config.logLines,
    dshVersion: await readDshVersion(),
    profile: readProfile(),
    mode: job === null ? 'spawn' : 'observe',
    owner: job === null ? 'dsh-restart helper' : `launchd ${job.label}`,
    kickCommand: job === null ? [] : kickCommand(job),
    kickDelayMs: 1_200,
    observeLog: job === null ? '' : job.stderrPath !== '' ? job.stderrPath : job.stdoutPath,
    failureReport: failureReportPath(),
  }
}

/** Outcome of one restart request. */
export interface RestartOutcome {
  ok: boolean
  error: string
  helperPid: number | null
  logFile: string
  statusFile: string
  specFile: string
  fallbackPort: number
  fallbackUrl: string
  /** Milliseconds after which this host stops serving (helper mode). */
  exitInMs: number
  /** Which strategy actually ran. */
  mode: 'helper' | 'launchd'
  record: RestartRecord
  /**
   * Perform the handover. MUST be called after the HTTP reply is on the wire:
   * in launchd mode the helper kickstart terminates this process.
   */
  commit: () => Promise<void>
}

/**
 * Hand the restart over to a detached helper.
 *
 * Returns as soon as the helper is running; the caller is responsible for
 * answering the HTTP request first and only then ending this process (see
 * {@link scheduleSelfExit}), so the browser always gets a definite reply.
 *
 * @param options - config, listen address, and who asked.
 */
export async function requestRestart(options: {
  config: RestartConfig
  port: number
  host: string
  url: string
  source: string
  reason: string
  exitDelayMs?: number
}): Promise<RestartOutcome> {
  const { config } = options
  await ensureLayout()
  // Ask launchd first: a host it manages must be restarted *by it*, otherwise
  // our own relaunch and the job's relaunch race for the listening port.
  const job = config.restartMode === 'helper' ? null : await launchdInfo()
  const forcedLaunchd = config.restartMode === 'launchd'
  const spec = await buildSpec({ ...options, launchd: job })
  const mode: 'helper' | 'launchd' = job === null ? 'helper' : 'launchd'
  const specFile = specPath()

  const record: RestartRecord = {
    at: new Date().toISOString(),
    source: options.source,
    reason: options.reason,
    oldPid: process.pid,
    helperPid: null,
    port: spec.port,
    logFile: spec.logFile,
    statusFile: spec.statusFile,
    outcome: 'pending',
  }

  const fail = (error: string, helperPid: number | null = null): RestartOutcome => ({
    ok: false,
    error,
    helperPid,
    logFile: spec.logFile,
    statusFile: spec.statusFile,
    specFile,
    fallbackPort: config.fallbackPort,
    fallbackUrl: `http://${spec.host}:${config.fallbackPort}`,
    exitInMs: 0,
    mode,
    record,
    commit: async () => undefined,
  })

  // `launchd` forced but no job found: refuse instead of silently doing something else.
  if (forcedLaunchd && job === null) {
    return fail('配置 restartMode=launchd，但没有检测到管理本宿主的 launchd 任务（XPC_SERVICE_NAME 未设置或 launchctl print 失败）')
  }

  const helper = helperPath()
  try {
    await access(helper, constants.R_OK)
  } catch {
    return fail(`找不到重启助手脚本：${helper}（包内 helper/ 目录缺失时请重新安装 dsh-restart）`)
  }

  try {
    await mkdir(dirname(specFile), { recursive: true })
    await writeFile(specFile, JSON.stringify(spec, null, 2), { mode: 0o600 })
    await chmod(specFile, 0o600).catch(() => undefined)
  } catch (error) {
    return fail(`写入交接文件失败：${String((error as Error)?.message ?? error)}`)
  }

  let helperPid: number | null = null
  try {
    const child = spawn(process.execPath, [helper, '--spec', specFile], {
      detached: true,
      stdio: 'ignore',
      cwd: spec.cwd,
      env: { ...process.env },
    })
    child.unref()
    helperPid = child.pid ?? null
  } catch (error) {
    return fail(`拉起重启助手失败：${String((error as Error)?.message ?? error)}`)
  }

  record.helperPid = helperPid
  await appendHistory(record, config.historyLimit).catch(() => undefined)

  const exitInMs = options.exitDelayMs ?? 700
  return {
    ok: true,
    error: '',
    helperPid,
    logFile: spec.logFile,
    statusFile: spec.statusFile,
    specFile,
    fallbackPort: config.fallbackPort,
    fallbackUrl: `http://${spec.host}:${config.fallbackPort}`,
    exitInMs,
    mode,
    record,
    commit: async () => {
      if (mode === 'launchd') {
        // The helper owns the kick (it waits for the reply to land first); this
        // process simply stops serving when launchd terminates it. Nothing to do
        // here beyond reporting a job that is no longer there.
        return
      }
      scheduleSelfExit(exitInMs)
    },
  }
}

/**
 * End this host so the helper can take over.
 *
 * SIGTERM first (lets DSH close sessions and release the port), then a hard
 * exit as a backstop — the helper SIGKILLs anything still holding the port
 * after its own grace period.
 * @param delayMs - how long to wait before signalling (the HTTP reply needs to flush).
 */
export function scheduleSelfExit(delayMs: number): void {
  setTimeout(() => {
    try {
      process.kill(process.pid, 'SIGTERM')
    } catch {
      /* the signal may be blocked; the hard fallback below still fires */
    }
    setTimeout(() => {
      // The helper kills the port holder, but never leave a wedged process behind.
      process.exit(0)
    }, 15_000).unref()
  }, Math.max(0, delayMs)).unref()
}

/** Read the live helper status, if any. */
export async function readHelperStatus(): Promise<{ status: HelperStatus | null; alive: boolean; ageMs: number | null }> {
  const file = statusPath()
  try {
    const [text, info] = await Promise.all([readFile(file, 'utf8'), stat(file)])
    const parsed = JSON.parse(text) as HelperStatus
    const helperPid = Number((parsed as { helperPid?: unknown }).helperPid ?? 0)
    const ageMs = Date.now() - info.mtimeMs
    return { status: parsed, alive: helperPid > 0 && isAlive(helperPid) && ageMs < 15 * 60_000, ageMs }
  } catch {
    return { status: null, alive: false, ageMs: null }
  }
}

/** A log tail plus the lines that look like errors. */
export interface LogTail {
  file: string
  exists: boolean
  mtime: string
  text: string
  lines: string[]
  errorLines: string[]
}

/** Tail a log file (missing files come back as an empty tail, not an error). */
export async function tailFile(file: string, limit: number): Promise<LogTail> {
  const empty: LogTail = { file, exists: false, mtime: '', text: '', lines: [], errorLines: [] }
  try {
    const [text, info] = await Promise.all([readFile(file, 'utf8'), stat(file)])
    const all = text.split(/\r?\n/).filter((line) => line !== '')
    const lines = all.slice(-limit)
    return {
      file,
      exists: true,
      mtime: new Date(info.mtimeMs).toISOString(),
      text: lines.join('\n'),
      lines,
      errorLines: all.filter((line) => ERROR_HINT.test(line)).slice(-40),
    }
  } catch {
    return empty
  }
}

/** Where the helper drops the copy-ready failure report. */
export function failureReportPath(): string {
  return join(restartHome(), 'last-failure.md')
}

/** Read the last failure report ('' when the last restart did not fail). */
export async function readFailureReport(): Promise<{ text: string; file: string; exists: boolean }> {
  const file = failureReportPath()
  try {
    const text = await readFile(file, 'utf8')
    return { text, file, exists: true }
  } catch {
    return { text: '', file, exists: false }
  }
}

/** The newest log file in the logs directory (null when none exist). */
export async function newestLogFile(): Promise<string | null> {
  try {
    const entries = await readdir(logsDir())
    const logs = entries.filter((name) => name.endsWith('.log'))
    if (logs.length === 0) return null
    const stats = await Promise.all(
      logs.map(async (name) => ({ name, mtime: (await stat(join(logsDir(), name))).mtimeMs })),
    )
    stats.sort((a, b) => b.mtime - a.mtime)
    const newest = stats[0]
    return newest === undefined ? null : join(logsDir(), newest.name)
  } catch {
    return null
  }
}

/** List recent log files (newest first). */
export async function listLogs(limit = 20): Promise<{ name: string; file: string; size: number; mtime: string }[]> {
  try {
    const entries = await readdir(logsDir())
    const logs = entries.filter((name) => name.endsWith('.log'))
    const rows = await Promise.all(
      logs.map(async (name) => {
        const info = await stat(join(logsDir(), name))
        return { name, file: join(logsDir(), name), size: info.size, mtime: new Date(info.mtimeMs).toISOString() }
      }),
    )
    rows.sort((a, b) => (a.mtime < b.mtime ? 1 : -1))
    return rows.slice(0, Math.max(1, limit))
  } catch {
    return []
  }
}
