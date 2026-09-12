/**
 * Browser-side API client for the /api/dsh-restart route family.
 *
 * Everything goes over same-origin fetch. The one endpoint that is *not* on the
 * DSH server is the detached helper's recovery console (a different port,
 * CORS-open) — that is the only thing still answering while DSH is down, so the
 * panel uses it to show why a restart failed.
 */

/** Live helper state (mirrors the host contract; every field is optional). */
export interface HelperStatus {
  ok?: boolean
  /** Marker set by our own helper; absent on anything else listening on that port. */
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
  errorLines?: { t: number; text: string }[]
  tail?: string[]
  dshVersion?: string | null
  profile?: string | null
  argv?: string[]
}

/** Host identity. */
export interface HostInfo {
  pid: number
  ppid: number
  startedAt: string
  uptimeMs: number
  port: number
  host: string
  url: string
  cwd: string
  nodeVersion: string
  dshVersion: string
  profile: string
  command: string
  restarted: boolean
  platform: string
  logsDir: string
  statusFile: string
  helperFile: string
  helperExists: boolean
  launchd: {
    managed: boolean
    label: string
    state: string
    pid: number | null
    plistPath: string
    logFile: string
    strategy: string
  }
}

/** One restart record. */
export interface RestartRecord {
  at: string
  source: string
  reason: string
  oldPid: number
  helperPid: number | null
  port: number
  logFile: string
  statusFile: string
  outcome?: string
}

/** Effective plugin config (mirrors the host contract). */
export interface RestartConfig {
  enabled: boolean
  announceToAgent: boolean
  entry: 'sidebar' | 'ball' | 'both' | 'off'
  restartMode: 'auto' | 'helper' | 'launchd'
  fallbackPort: number
  bootTimeoutMs: number
  maxAttempts: number
  killGraceMs: number
  portFreeTimeoutMs: number
  lingerMs: number
  logLines: number
  autoReload: boolean
  showOverlay: boolean
  probeIntervalMs: number
  historyLimit: number
}

/** GET /api/dsh-restart/status. */
export interface StatusPayload {
  ok: boolean
  host: HostInfo
  helper: HelperStatus | null
  helperAlive: boolean
  helperAgeMs: number | null
  launchd: { managed: boolean; label: string; state: string; logFile: string; strategy: string } | null
  config: RestartConfig
  configFile: string
  configExists: boolean
  statusFile: string
  consoleUrl: string
  history: RestartRecord[]
  logFiles: { name: string; file: string; size: number; mtime: string }[]
}

/** GET /api/dsh-restart/logs. */
export interface LogPayload {
  ok: boolean
  file: string
  exists: boolean
  mtime: string
  text: string
  lines: string[]
  errorLines: string[]
  logFiles: { name: string; file: string; size: number; mtime: string }[]
}

/** GET /api/dsh-restart/probe. */
export interface ProbePayload {
  ok: boolean
  pid: number
  startedAt: string
  uptimeMs: number
}

/** POST /api/dsh-restart/restart. */
export interface RestartAck {
  ok: boolean
  helperPid: number | null
  logFile: string
  statusFile: string
  fallbackPort: number
  fallbackUrl: string
  exitInMs: number
  restartingAt: string
  oldPid: number
  mode?: 'helper' | 'launchd'
  error?: string
}

/** Error carrying the route's JSON error message. */
export class RestartApiError extends Error {
  constructor(message: string, readonly status = 0) {
    super(message)
    this.name = 'RestartApiError'
  }
}

/** One JSON request with a hard timeout (a dead server must not hang the UI). */
async function request<T>(path: string, init: RequestInit = {}, timeoutMs = 6_000): Promise<T> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  let response: Response
  try {
    response = await fetch(path, { ...init, signal: controller.signal, cache: 'no-store' })
  } catch (error) {
    throw new RestartApiError(
      error instanceof Error && error.name === 'AbortError'
        ? '请求超时（服务可能正在重启）'
        : '网络请求失败: ' + String(error instanceof Error ? error.message : error),
    )
  } finally {
    clearTimeout(timer)
  }
  let body: unknown
  try {
    body = await response.json()
  } catch {
    throw new RestartApiError('HTTP ' + response.status + ': 响应不是合法 JSON', response.status)
  }
  if (!response.ok) {
    const message =
      typeof body === 'object' && body !== null && typeof (body as { error?: unknown }).error === 'string'
        ? (body as { error: string }).error
        : 'HTTP ' + response.status
    throw new RestartApiError(message, response.status)
  }
  return body as T
}

/** The dsh-restart panel API. */
export class RestartApi {
  /** Host + helper + config + history. */
  async status(): Promise<StatusPayload> {
    return request<StatusPayload>('/api/dsh-restart/status')
  }

  /** Liveness probe used while reconnecting (short timeout, tiny body). */
  async probe(timeoutMs = 2_500): Promise<ProbePayload> {
    return request<ProbePayload>('/api/dsh-restart/probe', {}, timeoutMs)
  }

  /** Ask for a restart; the host answers before it exits. */
  async restart(reason: string, source = 'web'): Promise<RestartAck> {
    return request<RestartAck>(
      '/api/dsh-restart/restart',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ reason, source }),
      },
      10_000,
    )
  }

  /** Boot-log tail; `which: 'latest'` = newest log file on disk. */
  async logs(which = 'latest', lines = 200): Promise<LogPayload> {
    return request<LogPayload>(
      `/api/dsh-restart/logs?which=${encodeURIComponent(which)}&lines=${String(lines)}`,
      {},
      8_000,
    )
  }

  /** Restart history, newest first. */
  async history(limit = 20): Promise<{ ok: boolean; history: RestartRecord[] }> {
    return request<{ ok: boolean; history: RestartRecord[] }>(
      `/api/dsh-restart/history?limit=${String(limit)}`,
    )
  }

  /** Patch (or reset) the plugin config. */
  async setConfig(patch: Partial<RestartConfig> & { reset?: boolean }): Promise<{ ok: boolean; config: RestartConfig }> {
    return request<{ ok: boolean; config: RestartConfig }>('/api/dsh-restart/config', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(patch),
    })
  }

  /** Live helper state (through the host). */
  async helper(): Promise<{ ok: boolean; alive: boolean; ageMs: number | null; consoleUrl: string; status: HelperStatus | null }> {
    return request('/api/dsh-restart/helper')
  }

  /** Ask a failed helper to try again. */
  async helperRetry(): Promise<{ ok: boolean; consoleUrl?: string; error?: string }> {
    return request('/api/dsh-restart/helper/retry', { method: 'POST' }, 4_000)
  }
}

/**
 * Read the detached helper's live state straight from its console port.
 *
 * Used only while DSH itself is unreachable: the helper is a different origin
 * (another port) but answers with `Access-Control-Allow-Origin: *`.
 */
export async function fetchHelperDirect(consoleUrl: string, timeoutMs = 2_500): Promise<HelperStatus | null> {
  if (consoleUrl === '') return null
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const response = await fetch(`${consoleUrl}/status`, { signal: controller.signal, cache: 'no-store' })
    if (!response.ok) return null
    return (await response.json()) as HelperStatus
  } catch {
    return null
  } finally {
    clearTimeout(timer)
  }
}

/**
 * Fetch the helper's copy-ready failure report.
 *
 * Served by the recovery console (a different port, CORS-open), so it is
 * reachable exactly when the main server is not — which is when a failure
 * report matters.
 */
export async function fetchHelperReport(consoleUrl: string, timeoutMs = 3_000): Promise<string> {
  if (consoleUrl === '') return ''
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const response = await fetch(`${consoleUrl}/report`, { signal: controller.signal, cache: 'no-store' })
    return response.ok ? await response.text() : ''
  } catch {
    return ''
  } finally {
    clearTimeout(timer)
  }
}

/** Ask the helper (direct) to relaunch after a failure. */
export async function requestHelperRetry(consoleUrl: string, timeoutMs = 3_000): Promise<boolean> {
  if (consoleUrl === '') return false
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const response = await fetch(`${consoleUrl}/retry`, { method: 'POST', signal: controller.signal })
    return response.ok
  } catch {
    return false
  } finally {
    clearTimeout(timer)
  }
}
