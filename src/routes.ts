/**
 * dsh-restart — loopback HTTP routes for the web panel.
 *
 * Route family: /api/dsh-restart/*. Every route is loopback-only (127.0.0.1 /
 * ::1, same-origin), matching the other dsh-* panels.
 *
 *   GET  /status          host + live helper + config, plus the last restarts
 *   GET  /probe           tiny liveness probe the page polls while reconnecting
 *   GET  /auth            this process's fresh token URL (stale-tab 401 recovery)
 *   POST /restart         a panel click: hand the restart to the detached helper, then exit
 *   GET  /approval        the restart request an agent filed, waiting for the user
 *   POST /approval        the user's decision (approve → restart, deny → drop it)
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
  loadConfigSync,
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
import {
  createApproval,
  decideApproval,
  readApproval,
  type PendingApproval,
} from './approval.ts'

/** Route paths. */
export const RESTART_API = {
  status: '/api/dsh-restart/status',
  probe: '/api/dsh-restart/probe',
  auth: '/api/dsh-restart/auth',
  goto: '/api/dsh-restart/goto',
  restart: '/api/dsh-restart/restart',
  approval: '/api/dsh-restart/approval',
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
  /**
   * This process's browser URL carrying its launch token.
   *
   * Every `dsh web` process mints a new token, so a tab opened before a restart
   * holds a token the new host rejects with 401. The Web Connection service owns
   * the current one; the plugin reads it lazily per request (the service may not
   * exist at mount, and in headless profiles it never does — the plain origin is
   * then the best link we can offer).
   */
  authUrl?: () => string
}

/** Whether a hostname names the loopback authority (localhost, [::1], 127/8). */
function isLoopbackHostname(hostname: string): boolean {
  if (hostname === 'localhost' || hostname === '[::1]' || hostname === '::1') return true
  const parts = hostname.split('.')
  return (
    parts.length === 4 &&
    parts[0] === '127' &&
    parts.every((part) => /^\d{1,3}$/.test(part) && Number(part) <= 255)
  )
}

/**
 * Whether one request authority matches a configured `trustedOrigins` entry.
 *
 * Same shape as the host's own fence: an entry with an explicit port matches
 * that exact authority, a port-less entry matches the hostname on any port.
 * Both sides compare through WHATWG normalization, so case and a redundant
 * `:80` never decide trust.
 *
 * @param hostUrl - the request's parsed Host header.
 * @param trustedOrigins - canonical authorities from the plugin config.
 */
function isTrustedAuthority(hostUrl: URL, trustedOrigins: readonly string[]): boolean {
  for (const entry of trustedOrigins) {
    let entryUrl: URL
    try {
      entryUrl = new URL(`http://${entry}`)
    } catch {
      continue
    }
    const hasPort = /:\d+$/.test(entry)
    if (hasPort ? entryUrl.host === hostUrl.host : entryUrl.hostname === hostUrl.hostname) return true
  }
  return false
}

/**
 * Same-origin fence for every route (the panel is same-origin only).
 *
 * The socket address must be loopback: a request that arrived over another
 * interface did not come from this machine. The Host header must then name
 * either the loopback authority (the browser opened `127.0.0.1:<port>`) or an
 * authority the deployment declared in `trustedOrigins` — the reverse-proxy
 * case, where the edge terminates TLS on a real hostname and forwards to the
 * loopback bind. The remaining checks are unchanged, so a declared authority
 * admits exactly what a loopback Host already admitted: a same-origin request
 * from this machine.
 */
function isLoopbackRequest(request: IncomingMessage, trustedOrigins: readonly string[] = []): boolean {
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
  if (!isLoopbackHostname(hostUrl.hostname) && !isTrustedAuthority(hostUrl, trustedOrigins)) {
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
  /**
   * This process's fresh launch-token URL, so a tab whose token went stale can
   * offer a working link instead of dying on the host's plain-text 401.
   */
  authUrl: string
  /** launchd job managing this host, when there is one. */
  launchd: { managed: boolean; label: string; state: string; logFile: string; strategy: string } | null
  /** Restarts requested through this plugin, newest first. */
  history: unknown[]
  logFiles: unknown[]
  /** An agent's restart request that is still waiting for the user's decision. */
  approval: PendingApproval | null
  /** True when the last request timed out without a decision. */
  approvalExpired: boolean
  endpoints: typeof RESTART_API
}

/** `?token=…` from a token URL ('' when the provider refused or the URL is odd). */
function tokenSearchOf(url: string): string {
  if (url === '') return ''
  try {
    return new URL(url).search
  } catch {
    return ''
  }
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
  /**
   * The authorities this deployment declared, read per request.
   *
   * The panel's own settings surface writes this file, so a change takes effect
   * on the next request without a host restart — the same reason every other
   * setting is read through `loadConfig()` rather than captured at mount.
   * Config that cannot be read falls back to the defaults (no extra
   * authorities), which is the pre-existing behaviour.
   */
  const trustedOrigins = (): readonly string[] => {
    try {
      return loadConfigSync().config.trustedOrigins
    } catch {
      return []
    }
  }

  /** The same-origin fence, resolved against the live config. */
  const allowed = (req: IncomingMessage): boolean => isLoopbackRequest(req, trustedOrigins())

  const guard = (req: IncomingMessage, res: ServerResponse, method: string): boolean => {
    if (!allowed(req)) {
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

  /**
   * This process's fresh launch-token URL ('' when the provider refuses).
   *
   * Read per request, never cached: the token is minted by the running process
   * and must never be pinned into a closure at mount.
   */
  const currentAuthUrl = (): string => {
    try {
      const value = deps.authUrl?.()
      return typeof value === 'string' ? value : ''
    } catch {
      return ''
    }
  }

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
        if (!allowed(req)) {
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
      path: RESTART_API.auth,
      handler: (req: IncomingMessage, res: ServerResponse) => {
        // Unauthenticated on purpose: the page that needs the fresh URL is
        // exactly the one whose cookie/token just went stale, so it must be
        // able to read this. Loopback-only + same-origin, like every route.
        if (!allowed(req)) {
          writeJson(res, 403, { error: 'forbidden: loopback-only' })
          return
        }
        if (req.method !== 'GET' && req.method !== 'HEAD') {
          writeJson(res, 405, { error: `method not allowed: ${req.method}` })
          return
        }
        writeJson(res, 200, {
          ok: true,
          authUrl: currentAuthUrl(),
          origin: deps.url,
          port: deps.port,
          pid: process.pid,
        })
      },
    },
    {
      kind: 'exact' as const,
      path: RESTART_API.goto,
      handler: (req: IncomingMessage, res: ServerResponse) => {
        // The never-expiring entry point: a bookmarkable URL that always walks
        // the browser through the *current* process's token exchange. Without
        // it, a tab whose cookie is gone can only be rescued by copying a token
        // URL out of the terminal — the one step a user should never have to do.
        // Unauthenticated + loopback-only, exactly like `/auth`.
        if (!allowed(req)) {
          writeJson(res, 403, { error: 'forbidden: loopback-only' })
          return
        }
        if (req.method !== 'GET' && req.method !== 'HEAD') {
          writeJson(res, 405, { error: `method not allowed: ${req.method}` })
          return
        }
        // A *relative* Location on purpose: the browser resolves it against the
        // authority it is already on, so a tab opened as `localhost:3080` keeps
        // that authority. Cookies are per authority, so redirecting such a tab
        // to `127.0.0.1:3080` would mint a cookie it cannot use.
        const search = tokenSearchOf(currentAuthUrl())
        res.writeHead(303, {
          'cache-control': 'no-store',
          'referrer-policy': 'no-referrer',
          location: search === '' ? '/' : '/' + search,
        })
        res.end()
      },
    },
    {
      kind: 'exact' as const,
      path: RESTART_API.status,
      handler: async (req: IncomingMessage, res: ServerResponse) => {
        if (!guard(req, res, 'GET')) return
        const { config, exists, file } = await loadConfig()
        const [host, helper, history, logs, job, approval] = await Promise.all([
          hostInfo(deps),
          helperState(config),
          readHistory(8),
          listLogs(8),
          config.restartMode === 'helper' ? Promise.resolve(null) : launchdInfo(),
          readApproval(),
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
          authUrl: currentAuthUrl(),
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
          approval: approval.approval,
          approvalExpired: approval.expired,
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
        // This route is the panel's own button: a human click IS the consent, so
        // it restarts right away. An agent must not borrow it — the tool path
        // files an approval request instead (see `dsh_restart`), and a caller
        // that declares itself an agent is sent there rather than obeyed.
        if (body.agentIntent === true) {
          writeJson(res, 403, {
            ok: false,
            error:
              'agent 发起的重启不能走本路由：请调用 dsh_restart 工具（它只提交待批准请求），' +
              '等用户在网页面板点「批准并重启」后才真正重启。',
          })
          return
        }
        const { config } = await loadConfig()
        // This route cannot tell a panel click from a curl: every route in this
        // plugin is loopback-only and unauthenticated by design, and a caller
        // with shell access can copy any header we could invent. So it does not
        // pretend to. It records the caller's own `source` claim (default
        // 'web') as history — useful for review, never a permission — and
        // leaves the real gate where it can actually work: the tool no longer
        // restarts anything by itself (see ./approval.ts), and the panel keeps
        // showing an agent's request until the user decides on it.
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
      path: RESTART_API.approval,
      handler: async (req: IncomingMessage, res: ServerResponse) => {
        if (!allowed(req)) {
          writeJson(res, 403, { error: 'forbidden: loopback-only' })
          return
        }
        if (req.method === 'GET' || req.method === 'HEAD') {
          const [{ config }, current] = await Promise.all([loadConfig(), readApproval()])
          writeJson(res, 200, {
            ok: true,
            approval: current.approval,
            expired: current.expired,
            file: current.file,
            requireApproval: config.requireApproval,
            ttlMinutes: config.approvalTtlMinutes,
          })
          return
        }
        if (req.method !== 'POST') {
          writeJson(res, 405, { error: 'method not allowed: ' + String(req.method) })
          return
        }
        const body = (await readJsonBody(req)) ?? {}
        const id = typeof body.id === 'string' ? body.id : ''
        const decision = body.decision === 'approve' ? 'approve' : body.decision === 'deny' ? 'deny' : ''
        if (id === '' || decision === '') {
          writeJson(res, 400, { ok: false, error: '需要 { id, decision: "approve" | "deny" }' })
          return
        }
        // Consumes the request: a replay of the same click can never restart twice.
        const verdict = await decideApproval(id, decision)
        if (!verdict.ok || verdict.approval === undefined) {
          writeJson(res, 409, { ok: false, error: verdict.error ?? '无法处理该请求' })
          return
        }
        if (verdict.denied === true) {
          writeJson(res, 200, {
            ok: true,
            denied: true,
            approval: verdict.approval,
            decidedAt: new Date().toISOString(),
          })
          return
        }
        const { config } = await loadConfig()
        const reason = verdict.approval.reason === '' ? 'agent 请求（用户已批准）' : verdict.approval.reason
        const outcome = await requestRestart({
          config,
          port: deps.port,
          host: deps.host,
          url: deps.url,
          source: 'user-approved',
          reason,
        })
        if (!outcome.ok) {
          // Hand the request back rather than swallowing it: the user approved a
          // restart that could not start, and should be able to try again.
          await createApproval({
            reason: verdict.approval.reason,
            ttlMs: verdict.approval.ttlMs,
            claimedConsent: verdict.approval.claimedConsent,
            source: verdict.approval.source,
            ...(verdict.approval.origin === undefined ? {} : { origin: verdict.approval.origin }),
          }).catch(() => undefined)
          writeJson(res, 500, { ok: false, approved: true, error: outcome.error, approval: verdict.approval })
          return
        }
        writeJson(res, 202, {
          ok: true,
          approved: true,
          approval: verdict.approval,
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
