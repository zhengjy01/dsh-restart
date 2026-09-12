/**
 * dsh-restart — plugin config, on-disk layout, and restart history.
 *
 * Everything this plugin owns lives under one directory
 * (`~/.dsh/dsh-restart` by default, override with `DSH_RESTART_HOME`):
 *
 *   config.json    plugin settings (0600)
 *   history.json   one record per requested restart (newest first)
 *   status.json    written by the detached helper — live restart state
 *   pending-spec.json  handoff payload for the next helper run
 *   logs/<stamp>.log   stdout+stderr of one restarted host
 */

import { chmod, mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

/** Default plugin settings; every field is user-overridable. */
export interface RestartConfig {
  /** Master switch — when false the routes and tools stay unmounted. */
  enabled: boolean
  /** Announce the plugin (tools + behaviour) in the agent system prompt. */
  announceToAgent: boolean
  /** Where the panel entry lives in the GUI. */
  entry: 'sidebar' | 'ball' | 'both' | 'off'
  /**
   * How the host is restarted: `auto` asks launchd when the host turns out to be
   * launchd-managed (otherwise it relaunches itself), `helper` always relaunches,
   * `launchd` forces the launchctl path.
   */
  restartMode: 'auto' | 'helper' | 'launchd'
  /** Port for the detached recovery console (tries +9 further when busy). */
  fallbackPort: number
  /** How long the new host may take to answer before the attempt fails. */
  bootTimeoutMs: number
  /** Launch attempts per restart request (1 = no automatic retry). */
  maxAttempts: number
  /** Grace period after SIGTERM before the helper SIGKILLs the old host. */
  killGraceMs: number
  /** How long to wait for the old host to release its port. */
  portFreeTimeoutMs: number
  /** How long the helper keeps its console up after success before exiting. */
  lingerMs: number
  /** Lines of boot log kept for display. */
  logLines: number
  /** Auto-reload the page once the new host answers. */
  autoReload: boolean
  /** Show the full-screen restart overlay while waiting. */
  showOverlay: boolean
  /** Reconnect probe interval (ms). */
  probeIntervalMs: number
  /** Restart records kept in history.json. */
  historyLimit: number
}

/** Shipped defaults. */
export const DEFAULT_CONFIG: RestartConfig = {
  enabled: true,
  announceToAgent: true,
  entry: 'sidebar',
  restartMode: 'auto',
  fallbackPort: 3099,
  bootTimeoutMs: 120_000,
  maxAttempts: 2,
  killGraceMs: 6_000,
  portFreeTimeoutMs: 25_000,
  lingerMs: 4_000,
  logLines: 200,
  autoReload: true,
  showOverlay: true,
  probeIntervalMs: 1_200,
  historyLimit: 30,
}

/** One completed restart request, as rendered in the panel history list. */
export interface RestartRecord {
  at: string
  /** Who asked: the web panel, an agent tool, or another caller. */
  source: string
  reason: string
  oldPid: number
  helperPid: number | null
  port: number
  logFile: string
  statusFile: string
  /** Outcome, filled in by the panel/host once the new process is up. */
  outcome?: string
}

/**
 * Plugin directory.
 *
 * Resolution order mirrors DSH's own: an explicit `DSH_RESTART_HOME` (used by
 * the tests and by anyone running a throwaway instance), then DSH's own
 * `DSH_HOME` when it is set — a launcher or a rescue capsule may relocate the
 * whole home — and only then the conventional `~/.dsh`. Hardcoding `~/.dsh`
 * would silently write a second, wrong home on such setups.
 */
export function restartHome(): string {
  const override = process.env.DSH_RESTART_HOME
  if (typeof override === 'string' && override.trim() !== '') return override
  const dshHome = process.env.DSH_HOME
  const base =
    typeof dshHome === 'string' && dshHome.trim() !== '' ? dshHome : join(homedir(), '.dsh')
  return join(base, 'dsh-restart')
}

/** Settings file (override with DSH_RESTART_CONFIG). */
export function configPath(): string {
  const override = process.env.DSH_RESTART_CONFIG
  if (typeof override === 'string' && override.trim() !== '') return override
  return join(restartHome(), 'config.json')
}

/** Restart history file. */
export function historyPath(): string {
  return join(restartHome(), 'history.json')
}

/** Live helper status file. */
export function statusPath(): string {
  return join(restartHome(), 'status.json')
}

/** Handoff payload for the helper. */
export function specPath(): string {
  return join(restartHome(), 'pending-spec.json')
}

/** Directory holding one log file per restarted host. */
export function logsDir(): string {
  return join(restartHome(), 'logs')
}

/**
 * The detached helper shipped with this package. Resolved from the module URL
 * so it works both from a local checkout and from an installed copy.
 */
export function helperPath(): string {
  return fileURLToPath(new URL('../helper/restart-helper.mjs', import.meta.url))
}

/** Coerce an unknown value into a bounded integer. */
function intIn(value: unknown, fallback: number, min: number, max: number): number {
  const raw = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(raw)) return fallback
  return Math.max(min, Math.min(max, Math.round(raw)))
}

/** Normalize a partial config against the defaults (never throws). */
export function normalizeConfig(patch: Partial<RestartConfig> | undefined, base = DEFAULT_CONFIG): RestartConfig {
  const source = patch ?? {}
  const entry = source.entry
  return {
    enabled: typeof source.enabled === 'boolean' ? source.enabled : base.enabled,
    announceToAgent: typeof source.announceToAgent === 'boolean' ? source.announceToAgent : base.announceToAgent,
    entry: entry === 'sidebar' || entry === 'ball' || entry === 'both' || entry === 'off' ? entry : base.entry,
    restartMode:
      source.restartMode === 'helper' || source.restartMode === 'launchd' || source.restartMode === 'auto'
        ? source.restartMode
        : base.restartMode,
    fallbackPort: intIn(source.fallbackPort ?? base.fallbackPort, base.fallbackPort, 1, 65_535),
    bootTimeoutMs: intIn(source.bootTimeoutMs ?? base.bootTimeoutMs, base.bootTimeoutMs, 5_000, 900_000),
    maxAttempts: intIn(source.maxAttempts ?? base.maxAttempts, base.maxAttempts, 1, 5),
    killGraceMs: intIn(source.killGraceMs ?? base.killGraceMs, base.killGraceMs, 0, 120_000),
    portFreeTimeoutMs: intIn(source.portFreeTimeoutMs ?? base.portFreeTimeoutMs, base.portFreeTimeoutMs, 0, 300_000),
    lingerMs: intIn(source.lingerMs ?? base.lingerMs, base.lingerMs, 0, 600_000),
    logLines: intIn(source.logLines ?? base.logLines, base.logLines, 20, 2_000),
    autoReload: typeof source.autoReload === 'boolean' ? source.autoReload : base.autoReload,
    showOverlay: typeof source.showOverlay === 'boolean' ? source.showOverlay : base.showOverlay,
    probeIntervalMs: intIn(source.probeIntervalMs ?? base.probeIntervalMs, base.probeIntervalMs, 300, 30_000),
    historyLimit: intIn(source.historyLimit ?? base.historyLimit, base.historyLimit, 1, 500),
  }
}

/** Read a JSON file, returning null when it is missing or unparsable. */
async function readJson<T>(file: string): Promise<T | null> {
  try {
    const text = await readFile(file, 'utf8')
    const parsed: unknown = JSON.parse(text)
    return typeof parsed === 'object' && parsed !== null ? (parsed as T) : null
  } catch {
    return null
  }
}

/** Write JSON atomically with mode 0600. */
async function writeJson(file: string, value: unknown): Promise<void> {
  await mkdir(dirname(file), { recursive: true })
  const tmp = `${file}.${process.pid}.tmp`
  await writeFile(tmp, JSON.stringify(value, null, 2), { mode: 0o600 })
  await rename(tmp, file)
  await chmod(file, 0o600).catch(() => undefined)
}

/** The effective config (defaults + file), plus where it came from. */
export async function loadConfig(): Promise<{ config: RestartConfig; exists: boolean; file: string }> {
  const file = configPath()
  const stored = await readJson<Partial<RestartConfig>>(file)
  if (stored === null) return { config: normalizeConfig(undefined), exists: false, file }
  return { config: normalizeConfig(stored), exists: true, file }
}

/** Merge a patch into the stored config and return the fresh value. */
export async function saveConfig(patch: Partial<RestartConfig>): Promise<RestartConfig> {
  const { config } = await loadConfig()
  const next = normalizeConfig(patch, config)
  await writeJson(configPath(), next)
  return next
}

/** Delete the stored config (back to shipped defaults). */
export async function resetConfig(): Promise<RestartConfig> {
  await writeJson(configPath(), DEFAULT_CONFIG)
  return { ...DEFAULT_CONFIG }
}

/** Append one restart record (newest first, bounded by historyLimit). */
export async function appendHistory(record: RestartRecord, limit: number): Promise<void> {
  const existing = (await readJson<RestartRecord[]>(historyPath())) ?? []
  const list = Array.isArray(existing) ? existing : []
  list.unshift(record)
  await writeJson(historyPath(), list.slice(0, Math.max(1, limit)))
}

/** Read the restart history (newest first). */
export async function readHistory(limit = 20): Promise<RestartRecord[]> {
  const existing = await readJson<RestartRecord[]>(historyPath())
  const list = Array.isArray(existing) ? existing : []
  return list.slice(0, Math.max(1, limit))
}

/** Ensure the plugin directories exist (0600 where it matters). */
export async function ensureLayout(): Promise<void> {
  await mkdir(logsDir(), { recursive: true })
  await chmod(restartHome(), 0o700).catch(() => undefined)
}

/**
 * Synchronous config read, for the plugin's apply() path.
 *
 * Mounting must stay synchronous: cordis effects have to be created inside the
 * plugin's own apply scope, so the roster cannot wait on a promise.
 */
export function loadConfigSync(): { config: RestartConfig; exists: boolean; file: string } {
  const file = configPath()
  try {
    const parsed: unknown = JSON.parse(readFileSync(file, 'utf8'))
    if (typeof parsed === 'object' && parsed !== null) {
      return { config: normalizeConfig(parsed as Partial<RestartConfig>), exists: true, file }
    }
  } catch {
    /* missing or corrupt → defaults */
  }
  return { config: normalizeConfig(undefined), exists: false, file }
}

/**
 * Materialize the config file on first run so the settings become discoverable
 * and editable; the composition row only seeds it, the file is authoritative.
 * @param seed - values from the plugin row (enabled / announceToAgent / …).
 */
export function seedConfigSync(seed: Partial<RestartConfig>): boolean {
  const file = configPath()
  if (existsSync(file)) return false
  try {
    mkdirSync(restartHome(), { recursive: true, mode: 0o700 })
    writeFileSync(file, JSON.stringify(normalizeConfig(seed), null, 2), { mode: 0o600 })
    return true
  } catch {
    return false
  }
}
