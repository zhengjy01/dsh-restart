/**
 * dsh-restart — macOS launchd awareness.
 *
 * A DSH host is often managed by a launchd job (`com.dsh.web` with
 * `KeepAlive: true` on this machine). That changes the correct restart from
 * "relaunch it ourselves" to "ask launchd to restart it": a helper that spawns
 * its own child would race the job for the listening port, and whichever loses
 * dies with `EADDRINUSE`.
 *
 * So the plugin detects the situation and switches strategy:
 *
 *   launchd-managed → `launchctl kickstart -k gui/<uid>/<label>` (the job comes
 *                     back with the plist's own cwd/env/argv) + the helper runs
 *                     in observe mode, following the plist's stdout/stderr.
 *   anything else   → the helper relaunches the exact same command itself.
 *
 * Detection is a pure read of `XPC_SERVICE_NAME` (set by launchd on every
 * process it starts) confirmed by `launchctl print`, and every failure mode
 * falls back to the self-relaunch path — a host that is not launchd-managed must
 * never end up depending on launchctl.
 */

import { execFile } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'

const run = promisify(execFile)

/** What we know about the managing launchd job. */
export interface LaunchdInfo {
  label: string
  uid: number
  domain: string
  plistPath: string
  /** Present when the plist could be parsed. */
  stdoutPath: string
  stderrPath: string
  /** `launchctl print` state, e.g. "running". */
  state: string
  pid: number | null
}

/** Run a command, resolving to { ok, stdout } instead of throwing. */
async function tryRun(
  file: string,
  args: readonly string[],
  timeoutMs = 4_000,
): Promise<{ ok: boolean; stdout: string; stderr: string }> {
  try {
    const { stdout, stderr } = await run(file, [...args], { timeout: timeoutMs, encoding: 'utf8' })
    return { ok: true, stdout: stdout ?? '', stderr: stderr ?? '' }
  } catch (error) {
    const failure = error as { stdout?: string; stderr?: string; message?: string }
    return { ok: false, stdout: failure.stdout ?? '', stderr: failure.stderr ?? failure.message ?? '' }
  }
}

/** Read one raw key out of a plist (empty string when absent/unparsable). */
async function plistValue(plistPath: string, key: string): Promise<string> {
  const result = await tryRun('/usr/bin/plutil', ['-extract', key, 'raw', '-o', '-', plistPath], 3_000)
  return result.ok ? result.stdout.trim() : ''
}

/**
 * Which launchd job owns a pid.
 *
 * `launchctl list` prints `PID  Status  Label`, so matching our own pid is the
 * authoritative answer — and the only reliable one: **Node rewrites
 * `XPC_SERVICE_NAME` to `0` in `process.env`**, so the environment variable
 * launchd set (still visible in the kernel environment, e.g. `ps eww -p <pid>`)
 * cannot be read from inside the process. The env var is kept only as a
 * secondary signal for the case where `launchctl list` is unavailable.
 *
 * @param pid - the process to look up.
 * @returns the job label, or null when the process is not a launchd job.
 */
export async function labelForPid(pid: number): Promise<string | null> {
  const listed = await tryRun('/bin/launchctl', ['list'], 5_000)
  if (listed.ok) {
    for (const line of listed.stdout.split('\n')) {
      const fields = line.trim().split(/\s+/)
      if (fields.length < 3) continue
      if (fields[0] !== String(pid)) continue
      const candidate = fields[2]
      if (candidate !== undefined && candidate !== '' && candidate !== '-') return candidate
    }
  }
  const fromEnv = (process.env.XPC_SERVICE_NAME ?? '').trim()
  if (fromEnv !== '' && fromEnv !== '0' && fromEnv !== '-' && !fromEnv.includes('/')) return fromEnv
  return null
}

/**
 * Detect a managing launchd job for this process.
 *
 * Returns null on non-macOS, when the process is not launchd-managed, or when
 * `launchctl print` cannot see the job — every one of those means the caller
 * must fall back to the self-relaunch strategy.
 */
export async function detectLaunchd(): Promise<LaunchdInfo | null> {
  return detectLaunchdFor(process.pid)
}

/**
 * Detect the launchd job owning an arbitrary pid.
 *
 * The plugin calls it for its own pid (the host is the job); tooling outside the
 * host — a one-off handoff script, a test — needs it for a *different* pid, and
 * in that case `process.env.XPC_SERVICE_NAME` says nothing useful.
 *
 * @param pid - the process to look up.
 */
export async function detectLaunchdFor(pid: number): Promise<LaunchdInfo | null> {
  if (process.platform !== 'darwin') return null
  const label = await labelForPid(pid)
  if (label === null) return null
  const uid = typeof process.getuid === 'function' ? process.getuid() : 0
  const domain = `gui/${uid}`
  const printed = await tryRun('/bin/launchctl', ['print', `${domain}/${label}`], 4_000)
  if (!printed.ok) return null
  const pidMatch = /^\s*pid = (\d+)\s*$/m.exec(printed.stdout)
  const stateMatch = /^\s*state = (\S+)\s*$/m.exec(printed.stdout)
  const plistPath = process.env.DSH_RESTART_PLIST ?? join(homedir(), 'Library', 'LaunchAgents', `${label}.plist`)
  const [stdoutPath, stderrPath] = await Promise.all([
    plistValue(plistPath, 'StandardOutPath'),
    plistValue(plistPath, 'StandardErrorPath'),
  ])
  return {
    label,
    uid,
    domain,
    plistPath,
    stdoutPath,
    stderrPath,
    state: stateMatch?.[1] ?? 'unknown',
    pid: pidMatch === null ? null : Number(pidMatch[1]),
  }
}

/**
 * Ask launchd to restart the job (`kickstart -k`).
 *
 * @param info - the detected job.
 * @returns ok plus launchctl's own output when it refused.
 */
export async function kickstart(info: LaunchdInfo): Promise<{ ok: boolean; error: string }> {
  const result = await tryRun(
    '/bin/launchctl',
    ['kickstart', '-k', `${info.domain}/${info.label}`],
    10_000,
  )
  if (result.ok) return { ok: true, error: '' }
  const message = (result.stderr || result.stdout).trim()
  return { ok: false, error: `launchctl kickstart 失败：${message === '' ? '未知错误' : message}` }
}

/** The command a retry should re-run for a managed host. */
export function kickCommand(info: LaunchdInfo): string[] {
  return ['/bin/launchctl', 'kickstart', '-k', `${info.domain}/${info.label}`]
}

/** Read the tail of a launchd log file ('' when missing). */
export async function readLaunchdLog(file: string, lines: number): Promise<string> {
  if (file === '') return ''
  try {
    const text = await readFile(file, 'utf8')
    const all = text.split(/\r?\n/).filter((line) => line !== '')
    return all.slice(-Math.max(1, lines)).join('\n')
  } catch {
    return ''
  }
}
