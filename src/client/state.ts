/**
 * dsh-restart — the browser-side restart state machine.
 *
 * One module-level store, subscribed to by every surface (settings card,
 * sidebar popover, full-screen overlay). A restart is a process that outlives
 * the page it started from, so the state is mirrored into sessionStorage: if
 * the tab reloads mid-restart, the overlay picks the wait back up instead of
 * leaving the user on a dead page with no explanation.
 *
 * The lifecycle:
 *
 *   requesting ──POST /api/dsh-restart/restart──▶ waiting
 *   waiting ──probe /api/dsh-restart/probe every N ms──▶ ready ──▶ location.reload()
 *   waiting ──helper reports failure──▶ failed (keeps probing; the helper can
 *                                       be retried from the overlay)
 *
 * Two failure modes are healed here rather than left to the user:
 *
 *   1. **Stale failure state.** The phase and its text live only in this page
 *      (memory + sessionStorage). Once the host is back, whether it booted on
 *      its own or launchd rescued it, the leftover "启动失败" must clear by
 *      itself. A watchdog keeps probing a failed state, re-checks the host when
 *      the tab regains focus, and drops a persisted failure the moment the host
 *      answers.
 *   2. **Stale launch token.** Every `dsh web` boot mints a new launch token, so
 *      an old tab's URL is refused with 401 once its cookie is gone. Because the
 *      plugin routes are loopback-only and cookie-free, this page can always ask
 *      the host for its *current* token URL and swap it for a cookie **in place**
 *      (same authority as the tab, no navigation), then reload only once the tab
 *      really authenticates. A link remains for the case where even that fails,
 *      so a dead cookie can never become a reload into the plain-text 401 page.
 */

import { useSyncExternalStore } from 'react'

import {
  fetchHelperDirect,
  requestHelperRetry,
  RestartApi,
  RestartApiError,
  type HelperStatus,
  type RestartAck,
  type RestartConfig,
  type StatusPayload,
} from './api.ts'

/** Restart phase. */
export type Phase = 'idle' | 'requesting' | 'waiting' | 'ready' | 'failed'

/** What every surface renders from. */
export interface RestartState {
  phase: Phase
  /** When this restart started (ms epoch). */
  startedAt: number
  /** Wall-clock while waiting, refreshed by the ticker. */
  elapsedMs: number
  /** Recovery console base URL ('' until the host answered). */
  fallbackUrl: string
  /** Port DSH was serving on when the restart was requested. */
  port: number
  /** Log file the new host writes to. */
  logFile: string
  /** Human-readable failure text ('' when nothing failed). */
  error: string
  /** Progress note for the overlay. */
  note: string
  /** Live helper state (null when the helper is not reachable). */
  helper: HelperStatus | null
  /** The host's acknowledgement of the restart request. */
  ack: RestartAck | null
  /** Effective plugin config, once the status endpoint answered. */
  config: RestartConfig | null
  /** Set when the page is about to reload itself. */
  reloadAt: number | null
  /** Who asked for the restart. */
  source: string
  /** Why (free text, recorded in the host's history). */
  reason: string
  /** True while the helper is being asked to try again. */
  retrying: boolean
  /**
   * True when this page no longer authenticates against the host (401).
   * Only the current process's token URL can mint a fresh cookie.
   */
  authRequired: boolean
  /** This process's fresh launch-token URL for {@link authRequired}. */
  authUrl: string
}

/** Storage key for resuming across a reload. */
const STORAGE_KEY = 'dsh-restart/pending'

/** A pending restart older than this is treated as stale and dropped. */
const RESUME_WINDOW_MS = 15 * 60_000

/** Grace period before the helper is consulted (the old host needs to die first). */
const HELPER_PROBE_AFTER_MS = 5_000

/** How long the page waits after the server answers before reloading. */
const RELOAD_DELAY_MS = 700

/** Re-probe cadence for a failed state — the host may come back on its own. */
const FAILED_PROBE_MS = 3_000

/** How often a 401 page refreshes its recovery link (the token can change again). */
const AUTH_RECHECK_MS = 15_000

/** How long a self-heal notice stays on screen. */
const NOTICE_MS = 12_000

const api = new RestartApi()

let state: RestartState = {
  phase: 'idle',
  startedAt: 0,
  elapsedMs: 0,
  fallbackUrl: '',
  port: 0,
  logFile: '',
  error: '',
  note: '',
  helper: null,
  ack: null,
  config: null,
  reloadAt: null,
  source: 'web',
  reason: '',
  retrying: false,
  authRequired: false,
  authUrl: '',
}

const listeners = new Set<() => void>()
let ticker: ReturnType<typeof setInterval> | null = null
let prober: ReturnType<typeof setTimeout> | null = null
let authTicker: ReturnType<typeof setInterval> | null = null
let noticeTimer: ReturnType<typeof setTimeout> | null = null
let probing = false
let reconciling = false
let watchersInstalled = false
/**
 * One in-place token exchange per page load.
 *
 * A 401 means the tab's cookie is gone; the current process's token is the only
 * thing that can mint another. Trying once is a heal; trying forever would be a
 * loop when cookies cannot be stored at all, so the manual link takes over.
 */
let authExchangeTried = false

/** Current snapshot (stable identity between mutations). */
export function getState(): RestartState {
  return state
}

/** Subscribe to state changes. */
export function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

/** Merge a patch into the snapshot and notify subscribers. */
function setState(patch: Partial<RestartState>): void {
  state = { ...state, ...patch }
  for (const listener of listeners) listener()
}

/** Show a transient note (used for the self-heal confirmation). */
function flashNote(text: string): void {
  if (noticeTimer !== null) clearTimeout(noticeTimer)
  setState({ note: text })
  noticeTimer = setTimeout(() => {
    noticeTimer = null
    if (state.note === text) setState({ note: '' })
  }, NOTICE_MS)
}

/** Remember the essentials so a reload can resume the wait. */
function persist(): void {
  try {
    if (state.phase === 'idle') {
      sessionStorage.removeItem(STORAGE_KEY)
      return
    }
    sessionStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({
        phase: state.phase,
        startedAt: state.startedAt,
        fallbackUrl: state.fallbackUrl,
        port: state.port,
        logFile: state.logFile,
        source: state.source,
        reason: state.reason,
        ack: state.ack,
        error: state.error,
      }),
    )
  } catch {
    /* private mode / quota — resuming is a nicety, not a requirement */
  }
}

/** Drop the persisted marker. */
function clearPersisted(): void {
  try {
    sessionStorage.removeItem(STORAGE_KEY)
  } catch {
    /* ignore */
  }
}

/** Read the persisted marker (null when absent or unparsable). */
function readPersisted(): Partial<RestartState> | null {
  let raw: string | null = null
  try {
    raw = sessionStorage.getItem(STORAGE_KEY)
  } catch {
    return null
  }
  if (raw === null) return null
  try {
    const parsed: unknown = JSON.parse(raw)
    return typeof parsed === 'object' && parsed !== null ? (parsed as Partial<RestartState>) : null
  } catch {
    clearPersisted()
    return null
  }
}

/** Keep the timers from stacking up. */
function stopLoops(): void {
  if (ticker !== null) {
    clearInterval(ticker)
    ticker = null
  }
  if (prober !== null) {
    clearTimeout(prober)
    prober = null
  }
  probing = false
}

/** Start the elapsed-time ticker (cheap; drives the overlay counter). */
function startTicker(): void {
  if (ticker !== null) return
  ticker = setInterval(() => {
    if (state.startedAt === 0) return
    setState({ elapsedMs: Date.now() - state.startedAt })
  }, 250)
}

/** Reload as soon as the new host answered. */
function scheduleReload(): void {
  if (state.reloadAt !== null) return
  const at = Date.now()
  setState({ reloadAt: at, note: '已就绪，正在刷新页面…' })
  clearPersisted()
  setTimeout(() => {
    try {
      location.reload()
    } catch {
      /* ignore */
    }
  }, RELOAD_DELAY_MS)
}

/** Forget a finished restart; keep auth and config facts. */
function clearRestartFields(): void {
  stopLoops()
  clearPersisted()
  setState({
    phase: 'idle',
    startedAt: 0,
    elapsedMs: 0,
    error: '',
    helper: null,
    ack: null,
    reloadAt: null,
    retrying: false,
  })
}

/**
 * Rebuild the host's token URL on **this tab's** authority.
 *
 * Cookies are per authority, so a tab opened as `localhost:3080` cannot use the
 * cookie the host would mint for `127.0.0.1:3080` — and vice versa. Only the
 * token travels with the URL; the origin stays the one the user is already on,
 * so a refresh in the *same* tab keeps working afterwards.
 *
 * @param fresh the host's own token URL ('' when the provider refused).
 * @returns the same token on `location.origin`, or '' when it cannot be rebuilt.
 */
function tokenUrlOnThisOrigin(fresh: string): string {
  if (fresh === '') return ''
  try {
    const origin = typeof location === 'undefined' ? '' : location.origin
    if (origin === '' || origin === 'null') return ''
    const search = new URL(fresh).search
    if (search === '') return ''
    return origin + '/' + search
  } catch {
    return ''
  }
}

/**
 * Ask the host whether this page still authenticates, and remember the answer.
 *
 * Never throws: an unreachable host is "unknown", not "unauthenticated". When
 * the answer is 401, this page swaps the host's *current* launch token for a
 * cookie in place — no navigation — so a restart ends with the tab back on
 * screen instead of an address the user has to copy. Only a 401 that survives
 * that exchange falls back to the clickable link.
 *
 * @returns true when the page is usable (authenticated or unknown).
 */
export async function checkAuth(): Promise<boolean> {
  let verdict = await api.checkIndex()
  // A restart in flight means the host is down, not that the cookie is bad.
  if (verdict === 'unknown' && state.phase !== 'idle') return true
  if (verdict !== 'unauthorized') {
    // Authenticated again: a later restart may heal this tab once more.
    if (verdict === 'authenticated') authExchangeTried = false
    if (state.authRequired) {
      stopAuthTicker()
      setState({ authRequired: false, authUrl: '' })
    }
    return true
  }
  const payload = await api.authUrl()
  const fresh = payload?.authUrl ?? ''
  const local = tokenUrlOnThisOrigin(fresh)
  if (local !== '' && !authExchangeTried) {
    authExchangeTried = true
    if ((await api.exchangeToken(local)) && (await api.checkIndex()) === 'authenticated') {
      // The cookie is back: a later restart may heal this tab once more.
      authExchangeTried = false
      if (state.authRequired) {
        stopAuthTicker()
        setState({ authRequired: false, authUrl: '' })
      }
      return true
    }
  }
  setState({
    authRequired: true,
    authUrl: local !== '' ? local : fresh !== '' ? fresh : state.authUrl,
  })
  startAuthTicker()
  return false
}

/** Poll the auth state while the page is stuck on a 401 so the link stays fresh. */
function startAuthTicker(): void {
  if (authTicker !== null) return
  authTicker = setInterval(() => {
    void checkAuth()
  }, AUTH_RECHECK_MS)
}

/** Stop the 401 recovery poll (the page authenticated again). */
function stopAuthTicker(): void {
  if (authTicker === null) return
  clearInterval(authTicker)
  authTicker = null
}

/** One reconnect probe; schedules the next one. */
async function probeOnce(): Promise<void> {
  if (probing) return
  probing = true
  let ok = false
  try {
    await api.probe()
    ok = true
  } catch {
    ok = false
  }
  probing = false

  if (ok) {
    // The host answered. Only now is it safe to judge the page's authentication.
    const authenticated = await checkAuth()
    setState({ phase: 'ready', helper: null, error: '' })
    stopLoops()
    clearPersisted()
    if (!authenticated) {
      // Booting fine but this tab's cookie is gone: a reload would land on the
      // plain-text 401 page, so keep the page alive and show the fresh URL.
      setState({
        reloadAt: null,
        note: '宿主已恢复，但本页面的旧 token 已失效（401）——请用下方「新地址」重新打开。',
      })
      return
    }
    if (state.config?.autoReload === false) {
      setState({ note: '新宿主已就绪，点击「刷新页面」加载新代码。' })
    } else {
      scheduleReload()
    }
    return
  }

  setState({
    phase: state.phase === 'failed' ? 'failed' : 'waiting',
    note: state.phase === 'failed' ? '启动失败，可重试或查看报错。' : '正在等待新宿主启动…',
  })

  // The old host is gone by now; the helper's console is the only live source.
  const waited = Date.now() - state.startedAt
  if (waited >= HELPER_PROBE_AFTER_MS && state.fallbackUrl !== '') {
    const helper = await fetchHelperDirect(state.fallbackUrl)
    if (helper !== null) {
      const failedNow = helper.phase === 'failed'
      setState({
        helper,
        error: failedNow ? helper.failure?.message ?? '启动失败（助手未给出原因）' : state.error,
        phase: failedNow ? 'failed' : 'waiting',
        note: failedNow
          ? '启动失败：新进程没能起来，下面是它的输出。'
          : '正在启动新宿主…（可通过恢复控制台查看日志）',
      })
    } else if (state.helper === null && waited > 20_000) {
      setState({
        note: '仍在等待新宿主；若长时间没有响应，请打开恢复控制台查看日志。',
      })
    }
  }
  persist()
  // A failed state must keep probing: the host may recover on its own (launchd,
  // a manual fix in the terminal, a delayed boot) and the page has to notice.
  scheduleProbe(state.phase === 'failed' ? FAILED_PROBE_MS : state.config?.probeIntervalMs ?? 1_200)
}

/** Queue the next probe. */
function scheduleProbe(intervalMs: number): void {
  if (prober !== null) clearTimeout(prober)
  prober = setTimeout(() => {
    prober = null
    void probeOnce()
  }, Math.max(300, intervalMs))
}

/** Make sure a non-idle state keeps a probe queued (watchdog). */
function ensureProbeLoop(intervalMs: number): void {
  if (state.phase === 'idle') return
  if (prober === null) scheduleProbe(intervalMs)
}

/**
 * Reconcile a leftover failure with the live host.
 *
 * Called on mount, when the tab regains focus, and by the failure watchdog.
 * If the host answers, a failure recorded in this page is by definition stale:
 * the restart finished, or something else (launchd, a manual relaunch) brought
 * DSH back — so the failure text is cleared instead of left on screen forever.
 *
 * @returns true when a stale failure was cleared.
 */
export async function reconcile(): Promise<boolean> {
  if (reconciling) return false
  const hadFailure = state.phase === 'failed' || readPersisted()?.phase === 'failed'
  if (!hadFailure && state.phase !== 'waiting') return false
  reconciling = true
  try {
    let alive = false
    try {
      await api.probe(2_500)
      alive = true
    } catch {
      alive = false
    }
    if (!alive) return false
    if (state.phase !== 'failed' && readPersisted()?.phase !== 'failed') return false
    clearRestartFields()
    clearPersisted()
    flashNote('宿主已恢复，已自动清除上次的失败状态。')
    void checkAuth()
    return true
  } finally {
    reconciling = false
  }
}

/** Load the config once so the reconnect follows the user's preferences. */
export async function refreshConfig(): Promise<RestartConfig | null> {
  try {
    const status: StatusPayload = await api.status()
    const authUrl = typeof status.authUrl === 'string' ? status.authUrl : state.authUrl
    setState({ config: status.config, authUrl })
    return status.config
  } catch (error) {
    if (error instanceof RestartApiError && error.unauthorized) {
      setState({ authRequired: true })
      startAuthTicker()
    }
    return null
  }
}

/**
 * Start a restart and stay on top of it.
 * @param reason - free-text reason recorded in the host's history.
 * @param source - who asked (the panel passes 'web').
 */
export async function startRestart(reason = '', source = 'web'): Promise<void> {
  if (state.phase === 'requesting' || state.phase === 'waiting') return
  stopLoops()
  setState({
    phase: 'requesting',
    startedAt: Date.now(),
    elapsedMs: 0,
    error: '',
    note: '正在下发重启指令…',
    helper: null,
    ack: null,
    reloadAt: null,
    source,
    reason,
    retrying: false,
  })
  persist()
  try {
    const ack = await api.restart(reason, source)
    const config = state.config ?? (await refreshConfig())
    setState({
      phase: 'waiting',
      ack,
      fallbackUrl: ack.fallbackUrl,
      port: ack.fallbackPort,
      logFile: ack.logFile,
      note: '旧进程正在退出，等待新宿主启动…',
      config,
    })
    persist()
    startTicker()
    scheduleProbe(1_000)
  } catch (error) {
    const message =
      error instanceof RestartApiError ? error.message : String(error instanceof Error ? error.message : error)
    setState({
      phase: 'failed',
      error: error instanceof RestartApiError && error.unauthorized
        ? '本页面已失去登录（401）：请用「新地址」重新打开后再重启。'
        : '重启指令下发失败：' + message,
      note: '宿主没有接受重启请求；正在检测宿主是否仍然健康…',
    })
    if (error instanceof RestartApiError && error.unauthorized) {
      void checkAuth()
    }
    persist()
    // The host may simply have been mid-restart and dead; keep watching so this
    // failure clears by itself once it answers again.
    startTicker()
    scheduleProbe(FAILED_PROBE_MS)
  }
}

/** Probe right now (the overlay's "立即重试" button). */
export async function checkNow(): Promise<void> {
  if (state.phase === 'idle') {
    await reconcile()
    return
  }
  setState({ note: '正在检测…' })
  await probeOnce()
}

/** Ask the helper to relaunch after a failed boot. */
export async function retryBoot(): Promise<void> {
  if (state.phase !== 'failed') return
  setState({ retrying: true, note: '已请求重启助手再试一次…' })
  let ok = false
  try {
    const result = await api.helperRetry()
    ok = result.ok
  } catch {
    ok = await requestHelperRetry(state.fallbackUrl)
  }
  if (!ok) ok = await requestHelperRetry(state.fallbackUrl)
  setState({
    retrying: false,
    phase: ok ? 'waiting' : 'failed',
    error: ok ? '' : state.error,
    note: ok ? '重启助手正在重新拉起…' : '重试请求没有送达；请打开恢复控制台手动重试。',
  })
  startTicker()
  scheduleProbe(ok ? 1_000 : FAILED_PROBE_MS)
}

/** Dismiss the overlay without touching the server. */
export function dismiss(): void {
  clearRestartFields()
  if (noticeTimer !== null) {
    clearTimeout(noticeTimer)
    noticeTimer = null
  }
  setState({ note: '' })
}

/** Forget a finished restart (keeps config). */
export function reset(): void {
  dismiss()
}

/** Open the fresh token URL (the 401 guide's action). */
export function openAuthUrl(): void {
  const target = state.authUrl
  if (target === '') return
  try {
    location.href = target
  } catch {
    /* ignore */
  }
}

/**
 * Resume (or discard) a restart that was in flight when the page went away.
 *
 * The host is consulted first: a persisted failure whose host is already back
 * is stale by definition and is cleared instead of resurrected. Only a restart
 * that is genuinely still in flight is resumed.
 */
export async function resumeIfPending(): Promise<void> {
  if (state.phase !== 'idle') return
  const parsed = readPersisted()

  let alive = false
  try {
    await api.probe(2_500)
    alive = true
  } catch {
    alive = false
  }

  if (parsed === null) {
    await checkAuth()
    return
  }

  const startedAt = typeof parsed.startedAt === 'number' ? parsed.startedAt : 0
  const fresh = startedAt > 0 && Date.now() - startedAt <= RESUME_WINDOW_MS
  const failed = parsed.phase === 'failed'

  if (alive) {
    // Host answered: the restart is over. Never resurrect its failure text.
    clearRestartFields()
    if (!failed) {
      // A restart was in flight and finished while this tab was away: the page
      // is running the old bundle, so reload to pick up the new host's code.
      flashNote('宿主已恢复，上次的重启已经完成。')
      if (state.config?.autoReload !== false) scheduleReload()
      return
    }
    flashNote('宿主已恢复，已自动清除上次的失败状态。')
    await checkAuth()
    return
  }

  if (!fresh) {
    clearPersisted()
    await checkAuth()
    return
  }

  if (failed) {
    setState({
      phase: 'failed',
      startedAt,
      elapsedMs: Date.now() - startedAt,
      fallbackUrl: typeof parsed.fallbackUrl === 'string' ? parsed.fallbackUrl : '',
      port: typeof parsed.port === 'number' ? parsed.port : 0,
      logFile: typeof parsed.logFile === 'string' ? parsed.logFile : '',
      source: typeof parsed.source === 'string' ? parsed.source : 'web',
      reason: typeof parsed.reason === 'string' ? parsed.reason : '',
      ack: (parsed.ack as RestartAck | null) ?? null,
      error: typeof parsed.error === 'string' ? parsed.error : '',
      note: '上次重启失败，正在等待宿主恢复…（回复后本页会自动清除失败状态）',
      authRequired: state.authRequired,
    })
    startTicker()
    scheduleProbe(FAILED_PROBE_MS)
    void refreshConfig()
    return
  }

  setState({
    phase: 'waiting',
    startedAt,
    elapsedMs: Date.now() - startedAt,
    fallbackUrl: typeof parsed.fallbackUrl === 'string' ? parsed.fallbackUrl : '',
    port: typeof parsed.port === 'number' ? parsed.port : 0,
    logFile: typeof parsed.logFile === 'string' ? parsed.logFile : '',
    source: typeof parsed.source === 'string' ? parsed.source : 'web',
    reason: typeof parsed.reason === 'string' ? parsed.reason : '',
    ack: (parsed.ack as RestartAck | null) ?? null,
    note: '检测到未完成的重启，继续等待新宿主…',
    error: typeof parsed.error === 'string' ? parsed.error : '',
  })
  void refreshConfig().then(() => {
    scheduleProbe(600)
  })
  startTicker()
}

/**
 * Install the self-heal watchers (idempotent).
 *
 * Timers are throttled in background tabs, so a failed page that is switched
 * away from can sit stale for minutes. Re-checking the moment the tab becomes
 * visible again is what makes the recovery feel automatic.
 */
export function installSelfHealWatchers(): void {
  if (watchersInstalled) return
  watchersInstalled = true
  const onVisible = (): void => {
    try {
      if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return
    } catch {
      /* ignore */
    }
    if (state.phase === 'failed' || state.phase === 'waiting') {
      void checkNow()
      return
    }
    if (state.authRequired) {
      void checkAuth()
      return
    }
    void reconcile()
  }
  try {
    document.addEventListener('visibilitychange', onVisible)
    window.addEventListener('focus', onVisible)
  } catch {
    /* non-browser environment: nothing to watch */
  }
}

/** React binding: re-renders the caller whenever the restart state changes. */
export function useRestartState(): RestartState {
  return useSyncExternalStore(subscribe, getState, getState)
}
