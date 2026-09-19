/**
 * dsh-restart — the full-screen restart overlay.
 *
 * Restarting DSH kills the very server this page is talking to, so without an
 * overlay the tab just goes dead: no spinner, no progress, no explanation.
 * This layer covers the shell while the handoff happens, then reloads the page
 * by itself. When the new host fails to boot, it shows the failing output — the
 * helper streams it to the recovery console, which is still reachable even
 * though DSH is not.
 *
 * Rendered from its own React root so it survives any shell re-render.
 */
import { useEffect, useMemo, useRef, useState } from 'react'
import { createRoot, type Root } from 'react-dom/client'

import { fetchHelperReport } from './api.ts'
import {
  checkNow,
  dismiss,
  installSelfHealWatchers,
  retryBoot,
  resumeIfPending,
  useRestartState,
  type RestartState,
} from './state.ts'

/** Container id, so a hot reload does not stack overlays. */
const CONTAINER_ID = 'dsh-restart-overlay-root'

/** Stylesheet id. */
const STYLE_ID = 'dsh-restart/overlay.css'

/** Accent for primary actions (amber = transient state, red = failure). */
const ACCENT = '#2b6cb0'
const DANGER = '#c0392b'

const CSS = [
  '#dsh-restart-overlay-root .dshrst-mask{position:fixed;inset:0;z-index:2147483100;',
  'background:rgba(12,14,18,.42);backdrop-filter:blur(3px);-webkit-backdrop-filter:blur(3px);',
  'display:flex;align-items:flex-start;justify-content:center;padding:8vh 20px 40px;overflow:auto}',
  '#dsh-restart-overlay-root .dshrst-card{width:100%;max-width:680px;border-radius:14px;overflow:hidden;',
  'box-shadow:0 24px 70px rgba(0,0,0,.35);border:1px solid rgba(128,128,128,.28);color:inherit;',
  'background:var(--dshrst-surface,#fff);display:flex;flex-direction:column}',
  '#dsh-restart-overlay-root .dshrst-head{display:flex;align-items:center;gap:10px;padding:16px 20px;',
  'border-bottom:1px solid rgba(128,128,128,.2)}',
  '#dsh-restart-overlay-root .dshrst-spin{width:15px;height:15px;border-radius:50%;flex:none;',
  'border:2px solid rgba(128,128,128,.35);border-top-color:' + ACCENT + ';animation:dshrst-spin .8s linear infinite}',
  '@keyframes dshrst-spin{to{transform:rotate(360deg)}}',
  '#dsh-restart-overlay-root .dshrst-body{padding:16px 20px;display:flex;flex-direction:column;gap:12px}',
  '#dsh-restart-overlay-root .dshrst-log{margin:0;max-height:220px;overflow:auto;padding:10px 12px;',
  'border-radius:8px;background:rgba(128,128,128,.10);border:1px solid rgba(128,128,128,.22);',
  'font:12px/1.55 ui-monospace,SFMono-Regular,Menlo,monospace;white-space:pre-wrap;word-break:break-word}',
  '#dsh-restart-overlay-root .dshrst-actions{display:flex;gap:8px;flex-wrap:wrap}',
  '#dsh-restart-overlay-root button{font:inherit;font-size:13px;padding:7px 13px;border-radius:7px;',
  'border:1px solid rgba(128,128,128,.35);background:transparent;color:inherit;cursor:pointer}',
  '#dsh-restart-overlay-root button:hover{border-color:rgba(128,128,128,.65)}',
  '#dsh-restart-overlay-root button.primary{background:' + ACCENT + ';border-color:' + ACCENT + ';color:#fff}',
  '#dsh-restart-overlay-root button.danger{background:' + DANGER + ';border-color:' + DANGER + ';color:#fff}',
  '#dsh-restart-overlay-root .dshrst-err{color:' + DANGER + ';font-weight:600}',
  '#dsh-restart-overlay-root .dshrst-muted{opacity:.66;font-size:12px}',
  '#dsh-restart-overlay-root .dshrst-steps{display:flex;gap:6px;flex-wrap:wrap;font-size:12px}',
  '#dsh-restart-overlay-root .dshrst-step{padding:2px 9px;border-radius:999px;border:1px solid rgba(128,128,128,.28)}',
  '#dsh-restart-overlay-root .dshrst-step.on{border-color:' + ACCENT + ';color:' + ACCENT + '}',
  '#dsh-restart-overlay-root .dshrst-auth{display:flex;flex-direction:column;gap:6px;padding:10px 12px;',
  'border-radius:8px;border:1px solid rgba(192,57,43,.5);background:rgba(192,57,43,.08)}',
  '#dsh-restart-overlay-root .dshrst-auth a{color:' + ACCENT + ';font-weight:600;word-break:break-all}',
  '#dsh-restart-overlay-root .dshrst-auth code{font:12px/1.5 ui-monospace,SFMono-Regular,Menlo,monospace;word-break:break-all}',
].join('')

/** Inject the overlay stylesheet once. */
function injectStyles(): void {
  if (document.querySelector('style[data-plugin-css=' + JSON.stringify(STYLE_ID) + ']') !== null) return
  const style = document.createElement('style')
  style.dataset.plugin = 'dsh-restart'
  style.dataset.pluginCss = STYLE_ID
  style.textContent = CSS
  document.head.appendChild(style)
}

/** The four steps shown as a progress strip. */
const STEPS: { key: string; label: string }[] = [
  { key: 'requesting', label: '下发指令' },
  { key: 'restarting', label: '旧进程退出' },
  { key: 'booting', label: '新宿主启动' },
  { key: 'ready', label: '已就绪' },
]

/** Which step is active for a given phase. */
function stepIndex(state: RestartState): number {
  if (state.phase === 'requesting') return 0
  if (state.phase === 'ready') return 3
  if (state.phase === 'failed') return 1
  const waited = state.elapsedMs
  return waited < 2_500 ? 0 : waited < 6_000 ? 1 : 2
}

/** Title for the overlay header. */
function titleOf(state: RestartState): string {
  if (state.authRequired) return 'DSH 登录已失效（旧 token）'
  if (state.phase === 'requesting') return '正在重启 DSH…'
  if (state.phase === 'waiting') return '正在重启 DSH…'
  if (state.phase === 'ready') return 'DSH 已就绪'
  return 'DSH 启动失败'
}

/** Human duration. */
function human(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000))
  const minutes = Math.floor(total / 60)
  const seconds = total % 60
  return minutes > 0 ? `${minutes} 分 ${seconds} 秒` : `${seconds} 秒`
}

/** One overlay render. */
function Overlay() {
  const state = useRestartState()
  const logRef = useRef<HTMLPreElement | null>(null)
  const [copied, setCopied] = useState(false)

  const visible =
    state.authRequired ||
    (state.phase !== 'idle' && (state.config === null || state.config.showOverlay !== false))

  const tail = useMemo(() => {
    const lines = state.helper?.tail ?? []
    const combined = state.helper === null && state.error !== '' ? [state.error] : lines
    return combined.slice(-40)
  }, [state.helper, state.error])

  useEffect(() => {
    if (logRef.current !== null) logRef.current.scrollTop = logRef.current.scrollHeight
  }, [tail])

  useEffect(() => {
    if (!copied) return
    const timer = setTimeout(() => setCopied(false), 1_800)
    return () => clearTimeout(timer)
  }, [copied])

  if (!visible) return null

  const active = stepIndex(state)
  const errorText = state.error !== '' ? state.error : state.helper?.failure?.message ?? ''
  const exit = state.helper?.childExit
  const authUrl = state.authUrl
  const copyAuthUrl = async (): Promise<void> => {
    if (authUrl === '') return
    try {
      await navigator.clipboard?.writeText(authUrl)
      setCopied(true)
    } catch {
      setCopied(false)
    }
  }
  const copy = async (): Promise<void> => {
    // Prefer the helper's own report: it carries the exit code, the detected
    // error lines and the raw boot output in one paste-ready document.
    const report = await fetchHelperReport(state.fallbackUrl)
    if (report !== '') {
      try {
        await navigator.clipboard?.writeText(report)
        setCopied(true)
        return
      } catch {
        /* fall through to the locally composed report */
      }
    }
    const text = [
      `DSH 重启${state.phase === 'failed' ? '失败' : ''}报告`,
      `时间：${new Date(state.startedAt).toISOString()}`,
      `已等待：${human(state.elapsedMs)}`,
      errorText === '' ? '' : `错误：${errorText}`,
      exit != null ? `退出码：${String(exit.code)}${exit.signal != null ? ' / ' + exit.signal : ''}` : '',
      state.logFile !== '' ? `日志：${state.logFile}` : '',
      state.helper?.errorLines?.length ? '\n—— 疑似报错 ——\n' + state.helper.errorLines.map((e) => e.text).join('\n') : '',
      tail.length > 0 ? '\n—— 启动输出 ——\n' + tail.join('\n') : '',
    ]
      .filter((line) => line !== '')
      .join('\n')
    try {
      await navigator.clipboard?.writeText(text)
      setCopied(true)
    } catch {
      setCopied(false)
    }
  }

  return (
    <div className="dshrst-mask">
      <div className="dshrst-card">
        <div className="dshrst-head">
          {state.phase === 'ready' || state.authRequired ? null : (
            <span className="dshrst-spin" style={state.phase === 'failed' ? { borderTopColor: DANGER } : undefined} />
          )}
          <strong style={{ fontSize: 15 }}>{titleOf(state)}</strong>
          {state.phase === 'idle' ? null : (
            <span className="dshrst-muted" style={{ marginLeft: 'auto' }}>
              已等待 {human(state.elapsedMs)}
            </span>
          )}
        </div>

        <div className="dshrst-body">
          {state.phase === 'idle' ? null : (
            <div className="dshrst-steps">
              {STEPS.map((step, index) => (
                <span
                  key={step.key}
                  className={'dshrst-step' + (index <= active ? ' on' : '')}
                  style={state.phase === 'failed' && index === active ? { borderColor: DANGER, color: DANGER } : undefined}
                >
                  {step.label}
                </span>
              ))}
            </div>
          )}

          <div className="dshrst-muted">{state.note}</div>

          {state.authRequired ? (
            <div className="dshrst-auth">
              <strong>本页面已失去登录（401）</strong>
              <div className="dshrst-muted">
                每次 dsh web 启动都会更换 launch token，旧标签页 URL 里的旧 token 会被拒绝；
                cookie 仍有效时也可直接重开站点。请用下面这个当前进程的新地址打开：
              </div>
              {authUrl !== '' ? (
                <a href={authUrl} target="_top" rel="noreferrer">
                  用新 token 地址打开
                </a>
              ) : (
                <span className="dshrst-muted">正在读取新地址…（也可在终端查看 `dsh web` 打印的 URL）</span>
              )}
              {authUrl !== '' ? <code>{authUrl}</code> : null}
            </div>
          ) : null}

          {errorText !== '' ? <div className="dshrst-err">{errorText}</div> : null}

          {state.helper !== null || tail.length > 0 ? (
            <pre className="dshrst-log" ref={logRef}>
              {tail.length > 0 ? tail.join('\n') : '（等待新进程输出…）'}
            </pre>
          ) : (
            <div className="dshrst-muted">等待新进程输出…（旧进程退出后，重启助手会接管并记录日志）</div>
          )}

          <div className="dshrst-muted" style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
            {state.logFile !== '' ? <span>日志：{state.logFile}</span> : null}
            {state.helper?.childPid != null ? <span>新进程 pid：{state.helper.childPid}</span> : null}
            {state.ack !== null ? <span>助手 pid：{state.ack.helperPid ?? '—'}</span> : null}
          </div>

          <div className="dshrst-actions">
            {state.authRequired && authUrl !== '' ? (
              <>
                <button
                  type="button"
                  className="primary"
                  onClick={() => {
                    location.href = authUrl
                  }}
                >
                  用新 token 地址打开
                </button>
                <button type="button" onClick={() => void copyAuthUrl()}>
                  {copied ? '已复制' : '复制新地址'}
                </button>
              </>
            ) : null}
            {state.phase === 'ready' && !state.authRequired ? (
              <button type="button" className="primary" onClick={() => location.reload()}>
                刷新页面
              </button>
            ) : null}
            {state.phase === 'failed' ? (
              <button type="button" className="danger" onClick={() => void retryBoot()} disabled={state.retrying}>
                {state.retrying ? '正在重试…' : '让助手重试启动'}
              </button>
            ) : null}
            <button type="button" onClick={() => void checkNow()}>
              立即检测
            </button>
            {state.fallbackUrl !== '' ? (
              <button type="button" onClick={() => window.open(state.fallbackUrl, '_blank', 'noopener')}>
                打开恢复控制台
              </button>
            ) : null}
            <button type="button" onClick={() => void copy()}>
              {copied ? '已复制' : '复制完整报告'}
            </button>
            {state.phase === 'failed' || state.phase === 'ready' || state.authRequired ? (
              <button
                type="button"
                onClick={() => {
                  dismiss()
                }}
              >
                关闭遮罩
              </button>
            ) : null}
          </div>

          {state.phase !== 'failed' && !state.authRequired ? (
            <div className="dshrst-muted">
              重启期间这个页面会自动重连；新宿主一旦应答，页面会自动刷新加载新代码。
            </div>
          ) : null}
        </div>
      </div>
    </div>
  )
}

/** React root handle, so mounting twice is a no-op. */
let root: Root | null = null

/** Mount the overlay root (called once by the client entry). */
export function mountRestartOverlay(): void {
  if (root !== null) return
  if (typeof document === 'undefined') return
  injectStyles()
  let container = document.getElementById(CONTAINER_ID)
  if (container === null) {
    container = document.createElement('div')
    container.id = CONTAINER_ID
    container.dataset.plugin = 'dsh-restart'
    document.body.appendChild(container)
  }
  root = createRoot(container)
  root.render(<Overlay />)
  // Re-check a failed page the moment the tab is looked at again.
  installSelfHealWatchers()
  // Pick up a restart that was already in flight when this page loaded; a
  // leftover failure whose host is back is cleared instead of resurrected.
  void resumeIfPending()
}
