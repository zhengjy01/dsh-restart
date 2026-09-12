/**
 * dsh-restart — loopback HTTP routes for the web panel.
 *
 * Route family: /api/dsh-restart/*. Every route is loopback-only (127.0.0.1 /
 * ::1, same-origin), matching the other dsh-* panels.
 *
 *   GET  /status          host + live helper + config, plus the last restarts
 *   GET  /probe           tiny liveness probe the page polls while reconnecting
 *   POST /restart         hand the restart to the detached helper, then exit
 *   GET  /logs            boot-log tail (and the lines that look like errors)
 *   GET  /history         one record per requested restart
 *   POST /config          patch / reset the plugin config
 *   GET  /helper          the helper's live status through the host (proxy)
 *   POST /helper/retry    ask a failed helper to try again
 */

import type { IncomingMessage, ServerResponse } from 'node:http'

import type { WebRoute } from '@deepseek-ai/dsh-host-webserver'

import {
  configPath,
  loadConfig,
  readHistory,
  resetConfig,
  saveConfig,
  statusPath,
  type RestartConfig,
} from './config.ts'
import {
  hostInfo,
  launchdInfo,
  listLogs,
  newestLogFile,
  readHelperStatus,
  requestRestart,
  tailFile,
  type HelperStatus,
  type HostInfo,
} from './restart.ts'

/** Route paths. */
export const RESTART_API = {
  status: '/api/dsh-restart/status',
  probe: '/api/dsh-restart/probe',
  restart: '/api/dsh-restart/restart',
  logs: '/api/dsh-restart/logs',
  history: '/api/dsh-restart/history',
  config: '/api/dsh-restart/config',
  helper: '/api/dsh-restart/helper',
  helperRetry: '/api/dsh-restart/helper/retry',
} as const

/** Cap on JSON request bodies. */
const MAX_JSON_BODY_BYTES = 64 * 1024

/** Where this host is reachable (filled in by the plugin at mount time). */
export interface RouteContext {
  /** Listening port of the host's web server. */
  port: number
  /** Bind host. */
  host: string
  /** Base URL used in links and the helper spec. */
  url: string
}

/** Strict loopback fence for every route (the panel is same-origin only). */
function isLoopbackRequest(request: IncomingMessage): boolean {
  const address = request.socket.remoteAddress
  if (address !== '127.0.0.1' && address !== '::1' && address !== '::ffff:127.0.0.1') return false
  const host = request.headers.host
  if (typeof host !== 'string') return false
  let hostUrl: URL
  try {
    hostUrl = new URL(`http://${host}`)
  } catch {
    return false
  }
  if (hostUrl.hostname !== '127.0.0.1' && hostUrl.hostname !== 'localhost' && hostUrl.hostname !== '[::1]') {
    return false
  }
  if (request.headers['sec-fetch-site'] === 'cross-site') return false
  const origin = request.headers.origin
  if (origin === undefined) return true
  try {
    return new URL(origin).host === hostUrl.host
  } catch {
    return false
  }
}

/** One JSON response. */
function writeJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'referrer-policy': 'no-referrer',
  })
  res.end(JSON.stringify(body))
}

/** Read and parse a JSON request body (undefined when invalid). */
async function readJsonBody(request: IncomingMessage): Promise<Record<string, unknown> | undefined> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    size += buffer.length
    if (size > MAX_JSON_BODY_BYTES) return undefined
    chunks.push(buffer)
  }
  if (size === 0) return {}
  try {
    const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'))
    return typeof parsed === 'object' && parsed !== null ? (parsed as Record<string, unknown>) : undefined
  } catch {
    return undefined
  }
}

/** Status payload returned to the panel. */
export interface RestartStatusPayload {
  ok: true
  host: HostInfo
  helper: HelperStatus | null
  helperAlive: boolean
  helperAgeMs: number | null
  config: RestartConfig
  configFile: string
  configExists: boolean
  statusFile: string
  /** Where the detached recovery console is reachable (after a restart). */
  consoleUrl: string
  /** launchd job managing this host, when there is one. */
  launchd: { managed: boolean; label: string; state: string; logFile: string; strategy: string } | null
  /** Restarts requested through this plugin, newest first. */
  history: unknown[]
  logFiles: unknown[]
  endpoints: typeof RESTART_API
}

/** Ask the helper (via its console port) for its live status. */
async function fetchHelperJson(url: string, timeoutMs = 2_000): Promise<HelperStatus | null> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const response = await fetch(url, { signal: controller.signal, cache: 'no-store' })
    if (!response.ok) return null
    return (await response.json()) as HelperStatus
  } catch {
    return null
  } finally {
    clearTimeout(timer)
  }
}

/** Build the route list for ctx.webServer.register. */
export function makeRoutes(deps: RouteContext): WebRoute[] {
  const guard = (req: IncomingMessage, res: ServerResponse, method: string): boolean => {
    if (!isLoopbackRequest(req)) {
      writeJson(res, 403, { error: 'forbidden: loopback-only' })
      return false
    }
    if (req.method !== method) {
      writeJson(res, 405, { error: `method not allowed: ${req.method}` })
      return false
    }
    return true
  }

  const queryOf = (req: IncomingMessage): URLSearchParams =>
    new URL(req.url ?? '/', 'http://127.0.0.1').searchParams

  const intParam = (params: URLSearchParams, key: string, fallback: number, min: number, max: number): number => {
    const raw = Number(params.get(key) ?? '')
    if (!Number.isFinite(raw)) return fallback
    return Math.max(min, Math.min(max, Math.floor(raw)))
  }

  /**
   * Whether a helper snapshot is about THIS host.
   *
   * The plugin home is shared by every DSH instance on the machine, so a fresh
   * `status.json` with a live helper pid may describe a sibling instance's
   * restart. A helper names the pid it replaced (`oldPid`) and the pid it
   * started (`childPid`); one of them being us is the only proof it concerns our
   * restart — freshness alone is not ownership.
   */
  const belongsToThisHost = (status: HelperStatus | null): boolean =>
    status !== null && (status.oldPid === process.pid || (status.childPid ?? null) === process.pid)

  /**
   * Live helper status.
   *
   * status.json is authoritative (it carries the helper pid, so a stale file
   * from an earlier restart is detectable). Only when no live helper is on
   * record do we probe a console port — and the responder must prove it is
   * *our* helper for *this* host:
   *
   *   1. it identifies as dsh-restart,
   *   2. it writes the status file belonging to this plugin home, and
   *   3. it is about this process — either the pid that requested the restart
   *      (still running, restart in flight) or the pid it launched (we are the
   *      process it started).
   *
   * Without (2) and (3) anything shaped like a helper passes: a leftover helper
   * from a different test/demo on the fallback port was reported as "the current
   * restart is failing", which is exactly the kind of lie this surface must not
   * tell.
   */
  const helperState = async (config: RestartConfig): Promise<{ status: HelperStatus | null; alive: boolean; ageMs: number | null }> => {
    const fromFile = await readHelperStatus()
    if (fromFile.alive && fromFile.status !== null && belongsToThisHost(fromFile.status)) return fromFile
    // A live-but-foreign helper still means "no restart of ours is in flight".
    if (fromFile.alive && fromFile.status !== null && !belongsToThisHost(fromFile.status)) {
      return { status: null, alive: false, ageMs: fromFile.ageMs }
    }
    const reported = fromFile.status?.fallbackPort
    const port = typeof reported === 'number' && reported > 0 ? reported : config.fallbackPort
    const live = await fetchHelperJson(`http://${deps.host}:${port}/status`, 1_200)
    if (
      live !== null &&
      live.helper === 'dsh-restart' &&
      live.statusFile === statusPath() &&
      belongsToThisHost(live)
    ) {
      return { status: live, alive: true, ageMs: 0 }
    }
    return { status: null, alive: false, ageMs: null }
  }

  return [
    {
      kind: 'exact' as const,
      path: RESTART_API.probe,
      handler: (req: IncomingMessage, res: ServerResponse) => {
        if (!isLoopbackRequest(req)) {
          writeJson(res, 403, { error: 'forbidden: loopback-only' })
          return
        }
        if (req.method !== 'GET' && req.method !== 'HEAD') {
          writeJson(res, 405, { error: `method not allowed: ${req.method}` })
          return
        }
        // Deliberately tiny: the page hammers this while waiting for a restart.
        writeJson(res, 200, {
          ok: true,
          pid: process.pid,
          startedAt: new Date(Date.now() - process.uptime() * 1000).toISOString(),
          uptimeMs: Math.round(process.uptime() * 1000),
        })
      },
    },
    {
      kind: 'exact' as const,
      path: RESTART_API.status,
      handler: async (req: IncomingMessage, res: ServerResponse) => {
        if (!guard(req, res, 'GET')) return
        const { config, exists, file } = await loadConfig()
        const [host, helper, history, logs, job] = await Promise.all([
          hostInfo(deps),
          helperState(config),
          readHistory(8),
          listLogs(8),
          config.restartMode === 'helper' ? Promise.resolve(null) : launchdInfo(),
        ])
        const payload: RestartStatusPayload = {
          ok: true,
          host,
          helper: helper.status,
          helperAlive: helper.alive,
          helperAgeMs: helper.ageMs,
          config,
          configFile: file,
          configExists: exists,
          statusFile: statusPath(),
          consoleUrl: `http://${deps.host}:${config.fallbackPort}`,
          launchd:
            job === null
              ? null
              : {
                  managed: true,
                  label: job.label,
                  state: job.state,
                  logFile: job.stderrPath !== '' ? job.stderrPath : job.stdoutPath,
                  strategy: config.restartMode === 'helper' ? 'helper' : 'launchd',
                },
          history,
          logFiles: logs,
          endpoints: RESTART_API,
        }
        writeJson(res, 200, payload)
      },
    },
    {
      kind: 'exact' as const,
      path: RESTART_API.restart,
      handler: async (req: IncomingMessage, res: ServerResponse) => {
        if (!guard(req, res, 'POST')) return
        const body = (await readJsonBody(req)) ?? {}
        const { config } = await loadConfig()
        const source = typeof body.source === 'string' && body.source !== '' ? body.source : 'web'
        const reason = typeof body.reason === 'string' ? body.reason : ''
        const outcome = await requestRestart({
          config,
          port: deps.port,
          host: deps.host,
          url: deps.url,
          source,
          reason,
        })
        if (!outcome.ok) {
          writeJson(res, 500, { ...outcome, ok: false, error: outcome.error })
          return
        }
        writeJson(res, 202, {
          ok: true,
          helperPid: outcome.helperPid,
          logFile: outcome.logFile,
          statusFile: outcome.statusFile,
          fallbackPort: outcome.fallbackPort,
          fallbackUrl: outcome.fallbackUrl,
          exitInMs: outcome.exitInMs,
          mode: outcome.mode,
          restartingAt: new Date().toISOString(),
          oldPid: process.pid,
        })
        // The reply is on the wire now; only then hand the host over.
        void outcome.commit()
      },
    },
    {
      kind: 'exact' as const,
      path: RESTART_API.logs,
      handler: async (req: IncomingMessage, res: ServerResponse) => {
        if (!guard(req, res, 'GET')) return
        const params = queryOf(req)
        const { config } = await loadConfig()
        const lines = intParam(params, 'lines', config.logLines, 10, 2_000)
        const which = (params.get('which') ?? 'latest').trim()
        let file: string | null
        if (which === 'latest' || which === 'auto') file = await newestLogFile()
        else if (which === 'helper') file = statusPath().replace(/status\.json$/, 'pending-spec.json')
        else file = which.startsWith('/') ? which : null
        if (file === null) {
          writeJson(res, 200, { ok: true, file: '', exists: false, mtime: '', text: '', lines: [], errorLines: [], logFiles: await listLogs(8) })
          return
        }
        const tail = await tailFile(file, lines)
        writeJson(res, 200, { ok: true, ...tail, logFiles: await listLogs(8) })
      },
    },
    {
      kind: 'exact' as const,
      path: RESTART_API.history,
      handler: async (req: IncomingMessage, res: ServerResponse) => {
        if (!guard(req, res, 'GET')) return
        const { config } = await loadConfig()
        const limit = intParam(queryOf(req), 'limit', 20, 1, config.historyLimit)
        writeJson(res, 200, { ok: true, history: await readHistory(limit) })
      },
    },
    {
      kind: 'exact' as const,
      path: RESTART_API.config,
      handler: async (req: IncomingMessage, res: ServerResponse) => {
        if (!guard(req, res, 'POST')) return
        const body = await readJsonBody(req)
        if (body === undefined) {
          writeJson(res, 400, { error: 'invalid JSON body' })
          return
        }
        const config =
          body.reset === true
            ? await resetConfig()
            : await saveConfig(body as Partial<RestartConfig>)
        writeJson(res, 200, { ok: true, config, configFile: configPath() })
      },
    },
    {
      kind: 'exact' as const,
      path: RESTART_API.helper,
      handler: async (req: IncomingMessage, res: ServerResponse) => {
        if (!guard(req, res, 'GET')) return
        const { config } = await loadConfig()
        const state = await helperState(config)
        writeJson(res, 200, {
          ok: true,
          alive: state.alive,
          ageMs: state.ageMs,
          consoleUrl: `http://${deps.host}:${config.fallbackPort}`,
          status: state.status,
        })
      },
    },
    {
      kind: 'exact' as const,
      path: RESTART_API.helperRetry,
      handler: async (req: IncomingMessage, res: ServerResponse) => {
        if (!guard(req, res, 'POST')) return
        const { config } = await loadConfig()
        const consoleUrl = `http://${deps.host}:${config.fallbackPort}`
        const controller = new AbortController()
        const timer = setTimeout(() => controller.abort(), 2_000)
        try {
          const response = await fetch(`${consoleUrl}/retry`, { method: 'POST', signal: controller.signal })
          writeJson(res, 200, { ok: response.ok, consoleUrl })
        } catch (error) {
          writeJson(res, 502, {
            ok: false,
            error: `无法连接重启控制台 ${consoleUrl}：${String((error as Error)?.message ?? error)}`,
            consoleUrl,
          })
        } finally {
          clearTimeout(timer)
        }
      },
    },
  ]
}
