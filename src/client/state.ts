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
}

/** Storage key for resuming across a reload. */
const STORAGE_KEY = 'dsh-restart/pending'

/** A pending restart older than this is treated as stale and dropped. */
const RESUME_WINDOW_MS = 15 * 60_000

/** Grace period before the helper is consulted (the old host needs to die first). */
const HELPER_PROBE_AFTER_MS = 5_000

/** How long the page waits after the server answers before reloading. */
const RELOAD_DELAY_MS = 700

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
}

const listeners = new Set<() => void>()
let ticker: ReturnType<typeof setInterval> | null = null
let prober: ReturnType<typeof setTimeout> | null = null
let probing = false

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

/** Keep the two timers from stacking up. */
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
    setState({ phase: 'ready', helper: null, error: '' })
    stopLoops()
    if (state.config?.autoReload === false) {
      setState({ note: '新宿主已就绪，点击「刷新页面」加载新代码。' })
    } else {
      scheduleReload()
    }
    persist()
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
  scheduleProbe(state.config?.probeIntervalMs ?? 1_200)
}

/** Queue the next probe. */
function scheduleProbe(intervalMs: number): void {
  if (prober !== null) clearTimeout(prober)
  prober = setTimeout(() => {
    void probeOnce()
  }, Math.max(300, intervalMs))
}

/** Load the config once so the reconnect follows the user's preferences. */
export async function refreshConfig(): Promise<RestartConfig | null> {
  try {
    const status = await api.status()
    setState({ config: status.config })
    return status.config
  } catch {
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
      error: '重启指令下发失败：' + message,
      note: '宿主没有接受重启请求，服务仍在运行。',
    })
    persist()
  }
}

/** Probe right now (the overlay's "立即重试" button). */
export async function checkNow(): Promise<void> {
  if (state.phase === 'idle') return
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
  if (ok) {
    startTicker()
    scheduleProbe(1_000)
  }
}

/** Dismiss the overlay without touching the server. */
export function dismiss(): void {
  stopLoops()
  clearPersisted()
  setState({
    phase: 'idle',
    startedAt: 0,
    elapsedMs: 0,
    error: '',
    note: '',
    helper: null,
    ack: null,
    reloadAt: null,
    retrying: false,
  })
}

/** Forget a finished restart (keeps config). */
export function reset(): void {
  dismiss()
}

/**
 * Resume a restart that was in flight when the page went away.
 *
 * Called once at mount by the overlay; a no-op when nothing is pending.
 */
export function resumeIfPending(): void {
  if (state.phase !== 'idle') return
  let raw: string | null = null
  try {
    raw = sessionStorage.getItem(STORAGE_KEY)
  } catch {
    return
  }
  if (raw === null) return
  let parsed: Partial<RestartState> | null = null
  try {
    parsed = JSON.parse(raw) as Partial<RestartState>
  } catch {
    clearPersisted()
    return
  }
  const startedAt = typeof parsed?.startedAt === 'number' ? parsed.startedAt : 0
  if (startedAt === 0 || Date.now() - startedAt > RESUME_WINDOW_MS) {
    clearPersisted()
    return
  }
  if (parsed?.phase !== 'waiting' && parsed?.phase !== 'requesting' && parsed?.phase !== 'failed') return
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

/** React binding: re-renders the caller whenever the restart state changes. */
export function useRestartState(): RestartState {
  return useSyncExternalStore(subscribe, getState, getState)
}
