/**
 * dsh-restart panel — the visible entry for the restart plugin.
 *
 * Rendered in two places from one component: as a settings-page section
 * (`settings.section` slot, variant="settings") and inside the popover opened
 * from the sidebar entry (variant="floating"). It shows what is running, offers
 * the one-click restart, and — this is the point — surfaces the boot log and
 * the lines that look like errors, so a plugin that fails to load is visible
 * without going back to a terminal.
 *
 * Plain React, inline styles only, theme-agnostic, no emoji.
 */
import { useCallback, useEffect, useMemo, useState } from 'react'

import {
  fetchHelperReport,
  RestartApi,
  RestartApiError,
  type LogPayload,
  type RestartConfig,
  type StatusPayload,
} from './api.ts'
import { checkAuth, refreshConfig, startRestart, useRestartState } from './state.ts'

/** Module-level API client (stateless; the component closes over it). */
const api = new RestartApi()

/** Accent for primary actions. */
const ACCENT = '#2b6cb0'
/** Failure colour. */
const DANGER = '#c0392b'
/** Healthy colour. */
const OK = '#2f9e5f'

/** One shared style sheet. */
const s: Record<string, React.CSSProperties> = {
  card: {
    display: 'flex',
    flexDirection: 'column',
    gap: '12px',
    maxWidth: '680px',
    padding: '14px 16px',
    borderRadius: '10px',
    border: '1px solid rgba(128,128,128,0.3)',
    fontSize: '13px',
    color: 'inherit',
    boxSizing: 'border-box',
  },
  floatCard: {
    display: 'flex',
    flexDirection: 'column',
    gap: '10px',
    width: '420px',
    maxHeight: '74vh',
    overflowY: 'auto',
    padding: '14px 16px',
    borderRadius: '12px',
    border: '1px solid rgba(128,128,128,0.3)',
    fontSize: '13px',
    color: 'inherit',
    boxSizing: 'border-box',
  },
  head: { display: 'flex', alignItems: 'center', gap: '8px' },
  dot: { width: 8, height: 8, borderRadius: '50%', flex: 'none', background: '#c9cdd4' },
  title: { fontWeight: 600, fontSize: '13px', margin: 0, flex: 1 },
  grid: {
    display: 'grid',
    gridTemplateColumns: '76px 1fr',
    gap: '4px 12px',
    fontSize: '12px',
  },
  label: { opacity: 0.6 },
  value: { wordBreak: 'break-all' },
  primary: {
    padding: '9px 14px',
    borderRadius: '8px',
    border: '1px solid ' + ACCENT,
    background: ACCENT,
    color: '#fff',
    cursor: 'pointer',
    fontSize: '13px',
    fontWeight: 600,
  },
  danger: {
    padding: '9px 14px',
    borderRadius: '8px',
    border: '1px solid ' + DANGER,
    background: DANGER,
    color: '#fff',
    cursor: 'pointer',
    fontSize: '13px',
    fontWeight: 600,
  },
  button: {
    padding: '6px 11px',
    borderRadius: '7px',
    border: '1px solid rgba(128,128,128,0.35)',
    background: 'transparent',
    color: 'inherit',
    cursor: 'pointer',
    fontSize: '12px',
  },
  row: { display: 'flex', gap: '8px', flexWrap: 'wrap', alignItems: 'center' },
  log: {
    margin: 0,
    maxHeight: '180px',
    overflow: 'auto',
    padding: '9px 11px',
    borderRadius: '8px',
    background: 'rgba(128,128,128,0.10)',
    border: '1px solid rgba(128,128,128,0.22)',
    font: '11.5px/1.55 ui-monospace,SFMono-Regular,Menlo,monospace',
    whiteSpace: 'pre-wrap',
    wordBreak: 'break-word',
    color: 'inherit',
  },
  error: { color: DANGER, fontWeight: 600, wordBreak: 'break-word' },
  muted: { opacity: 0.62, fontSize: '12px' },
  section: {
    display: 'flex',
    flexDirection: 'column',
    gap: '8px',
    paddingTop: '10px',
    borderTop: '1px solid rgba(128,128,128,0.22)',
  },
  field: { display: 'flex', alignItems: 'center', gap: '8px', justifyContent: 'space-between' },
  input: {
    width: '108px',
    padding: '4px 7px',
    borderRadius: '6px',
    border: '1px solid rgba(128,128,128,0.35)',
    background: 'transparent',
    color: 'inherit',
    fontSize: '12px',
    boxSizing: 'border-box',
  },
  badge: {
    padding: '1px 7px',
    borderRadius: '999px',
    border: '1px solid rgba(128,128,128,0.35)',
    fontSize: '11px',
    opacity: 0.85,
  },
}

/** Human duration from milliseconds. */
function human(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return '—'
  const total = Math.round(ms / 1000)
  if (total < 60) return `${total} 秒`
  const minutes = Math.floor(total / 60)
  const seconds = total % 60
  if (minutes < 60) return `${minutes} 分 ${seconds} 秒`
  const hours = Math.floor(minutes / 60)
  return `${hours} 小时 ${minutes % 60} 分`
}

/** Local time from an ISO string. */
function localTime(iso: string): string {
  if (iso === '') return '—'
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return iso
  const pad = (value: number): string => String(value).padStart(2, '0')
  return (
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ` +
    `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
  )
}

/** Phase label for the live helper. */
const PHASE_LABEL: Record<string, string> = {
  'waiting-port-free': '等待旧进程退出',
  starting: '正在启动',
  'waiting-ready': '等待就绪',
  ready: '已就绪',
  retrying: '正在重试',
  failed: '启动失败',
}

/** Copy text to the clipboard, reporting whether it worked. */
async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text)
    return true
  } catch {
    return false
  }
}

/** One panel render. */
export function RestartPanel(props: { variant?: 'settings' | 'floating'; onClose?: () => void }) {
  const variant = props.variant ?? 'settings'
  const live = useRestartState()
  const [status, setStatus] = useState<StatusPayload | null>(null)
  const [logs, setLogs] = useState<LogPayload | null>(null)
  const [draft, setDraft] = useState<RestartConfig | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [showLog, setShowLog] = useState(false)
  const [showSettings, setShowSettings] = useState(false)

  /** Load status + boot log. */
  const load = useCallback(async (): Promise<void> => {
    setBusy(true)
    try {
      const next = await api.status()
      setStatus(next)
      setDraft((current) => current ?? next.config)
      setError('')
      const tail = await api.logs('latest', Math.max(60, next.config.logLines))
      setLogs(tail)
      // Cheap HEAD /: catch an expired cookie while the panel is open, so the
      // fresh-token link appears before a reload lands on the 401 page.
      void checkAuth()
    } catch (caught) {
      setError(caught instanceof RestartApiError ? caught.message : String(caught))
      if (caught instanceof RestartApiError && caught.unauthorized) void checkAuth()
    } finally {
      setBusy(false)
    }
  }, [])

  useEffect(() => {
    void load()
    // A page that lost its launch token must surface the fresh URL right away.
    void checkAuth()
    // Keep the "宿主" facts fresh, but do not fight the reconnect loops.
    const timer = setInterval(() => {
      if (live.phase === 'idle') void load()
    }, 20_000)
    return () => clearInterval(timer)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [load, live.phase])

  useEffect(() => {
    if (!notice) return
    const timer = setTimeout(() => setNotice(''), 2_600)
    return () => clearTimeout(timer)
  }, [notice])

  const restarting = live.phase === 'requesting' || live.phase === 'waiting'
  const config = draft ?? status?.config ?? null
  /**
   * Only ever show helper state that belongs to THIS host.
   *
   * A helper reports the pid it replaced (`oldPid`) and the pid it started
   * (`childPid`); neither matching this process means it is somebody else's
   * restart — a leftover helper on the fallback port, for instance. Rendering
   * that as "重启助手 启动失败" claims a failure the user never had.
   */
  const ownedHelper = useMemo(() => {
    const candidate = live.helper ?? status?.helper ?? null
    if (candidate === null) return null
    const hostPid = status?.host.pid
    if (hostPid === undefined) return live.phase !== 'idle' ? candidate : null
    return candidate.oldPid === hostPid || candidate.childPid === hostPid ? candidate : null
  }, [live.helper, live.phase, status?.helper, status?.host.pid])
  const helper = ownedHelper
  const helperAlive = live.phase !== 'idle' ? live.helper !== null : ownedHelper !== null && (status?.helperAlive ?? false)
  const bootErrors = logs?.errorLines ?? []
  const consoleUrl = live.fallbackUrl !== '' ? live.fallbackUrl : (status?.consoleUrl ?? '')

  /** One-click restart. */
  const onRestart = useCallback(async (): Promise<void> => {
    setNotice('')
    if (restarting) return
    try {
      await refreshConfig()
    } catch {
      /* the host may already be gone; the request below reports it */
    }
    await startRestart('web 面板点击重启', 'web')
  }, [restarting])

  /**
   * Copy a self-contained diagnosis report.
   *
   * The restart failure report (written by the helper) wins when it exists;
   * otherwise compose the same shape from the status + boot log this panel
   * already has, so the button is always useful.
   */
  const copyDiagnosis = useCallback(async (): Promise<void> => {
    const fromHelper = await fetchHelperReport(consoleUrl)
    if (fromHelper !== '') {
      const ok = await copyText(fromHelper)
      setNotice(ok ? '已复制重启失败报告（来自恢复控制台），可直接粘贴给 AI' : '复制失败')
      return
    }
    const lines = [
      '# DSH 重启插件诊断报告',
      '',
      `- 时间：${new Date().toISOString()}`,
      `- 宿主：pid ${status?.host.pid ?? '?'}｜${status?.host.url ?? ''}｜DSH ${status?.host.dshVersion ?? '?'}｜Node ${status?.host.nodeVersion ?? '?'}`,
      `- 已运行：${status === null ? '?' : human(status.host.uptimeMs)}　启动于 ${localTime(status?.host.startedAt ?? '')}`,
      `- 启动命令：${status?.host.command ?? '?'}`,
      `- 重启方式：${status?.host.launchd.managed === true ? `launchd ${status.host.launchd.label}（${status.host.launchd.state}）` : '分离助手自拉起'}`,
      `- 助手：${helperAlive ? `运行中（${PHASE_LABEL[helper?.phase ?? ''] ?? helper?.phase ?? '?'}，第 ${helper?.attempt ?? 1}/${helper?.maxAttempts ?? 1} 次）` : '未运行'}`,
      helper?.failure?.message !== undefined ? `- 上次失败原因：${helper.failure.message}` : '',
      helper?.childExit != null ? `- 退出码：${String(helper.childExit.code)}${helper.childExit.signal != null ? ' / ' + helper.childExit.signal : ''}` : '',
      `- 启动日志：${logs?.file ?? '（无）'}`,
      live.error !== '' ? `- 面板错误：${live.error}` : '',
      error !== '' ? `- 接口错误：${error}` : '',
      '',
      '## 疑似报错行',
      '',
      '```',
      bootErrors.length === 0 ? '（未识别出明显报错行）' : bootErrors.join('\n'),
      '```',
      '',
      '## 启动日志（最后 80 行）',
      '',
      '```',
      (logs?.lines ?? []).slice(-80).join('\n') || '（无日志）',
      '```',
      '',
      '## 最近重启记录',
      '',
      ...(status?.history ?? []).slice(0, 5).map((record) => `- ${record.at}｜${record.source}｜${record.reason}｜pid ${record.oldPid} → 助手 ${record.helperPid ?? '—'}`),
      '',
    ]
      .filter((line) => line !== '')
      .join('\n')
    const ok = await copyText(lines)
    setNotice(ok ? '已复制诊断报告，可直接粘贴给 AI' : '复制失败')
  }, [
    bootErrors,
    consoleUrl,
    error,
    helper,
    helperAlive,
    live.error,
    logs,
    status,
  ])

  /** Persist the config patch. */
  const saveConfig = useCallback(
    async (patch: Partial<RestartConfig>): Promise<void> => {
      try {
        const result = await api.setConfig(patch)
        setDraft(result.config)
        setStatus((current) => (current === null ? current : { ...current, config: result.config }))
        setNotice('已保存（下次重启生效的项会在重启后应用）')
        setError('')
      } catch (caught) {
        setError(caught instanceof RestartApiError ? caught.message : String(caught))
      }
    },
    [],
  )

  /** The boot-log block, shared by both variants. */
  const logBlock = useMemo(() => {
    if (logs === null) return null
    if (!logs.exists) {
      return <div style={s.muted}>暂无启动日志（重启一次后，新宿主的输出会记录在这里）。</div>
    }
    const lines = logs.lines.slice(-80)
    return (
      <>
        <div style={s.row}>
          <span style={s.muted}>{logs.file}</span>
          <span style={{ marginLeft: 'auto' }} />
          <button
            type="button"
            style={s.button}
            onClick={() => {
              void copyText([...bootErrors, '', ...lines].join('\n')).then((ok) =>
                setNotice(ok ? '已复制启动日志' : '复制失败'),
              )
            }}
          >
            复制
          </button>
        </div>
        {bootErrors.length > 0 ? (
          <div style={s.error}>检测到 {bootErrors.length} 行疑似报错：</div>
        ) : (
          <div style={s.muted}>未发现明显报错。</div>
        )}
        {bootErrors.length > 0 ? <pre style={s.log}>{bootErrors.join('\n')}</pre> : null}
        <pre style={s.log}>{lines.join('\n')}</pre>
      </>
    )
  }, [logs, bootErrors])

  return (
    <div style={variant === 'settings' ? s.card : s.floatCard}>
      <div style={s.head}>
        <span style={{ ...s.dot, background: error !== '' ? DANGER : restarting ? '#e0a13a' : OK }} />
        <h3 style={s.title}>重启 DSH</h3>
        <span style={s.badge}>
          {live.authRequired ? '登录失效' : live.phase === 'idle' ? '空闲' : PHASE_LABEL[live.phase] ?? live.phase}
        </span>
        {props.onClose !== undefined ? (
          <button type="button" style={s.button} onClick={props.onClose}>
            收起
          </button>
        ) : null}
      </div>

      {live.authRequired ? (
        <div style={{ ...s.section, borderTop: 'none', border: '1px solid ' + DANGER, borderRadius: '8px', padding: '10px 12px' }}>
          <div style={s.error}>本页面已失去登录（401）：旧标签页的 launch token 已失效</div>
          <div style={s.muted}>
            每次 dsh web 启动都会更换 launch token；cookie 仍有效时重开站点即可。请用当前进程的新地址打开：
          </div>
          {live.authUrl !== '' ? (
            <a
              href={live.authUrl}
              target="_top"
              rel="noreferrer"
              style={{ color: ACCENT, fontWeight: 600, wordBreak: 'break-all', fontSize: '12px' }}
            >
              用新 token 地址打开
            </a>
          ) : (
            <div style={s.muted}>正在读取新地址…（也可在终端查看 dsh web 打印的 URL）</div>
          )}
          {live.authUrl !== '' ? (
            <div style={{ ...s.value, fontFamily: 'ui-monospace, Menlo, monospace', fontSize: '11.5px' }}>
              {live.authUrl}
            </div>
          ) : null}
          <div style={s.row}>
            <button
              type="button"
              style={s.button}
              onClick={() => {
                void copyText(live.authUrl).then((ok) => setNotice(ok ? '已复制新地址' : '复制失败'))
              }}
            >
              复制新地址
            </button>
            <button
              type="button"
              style={s.button}
              onClick={() => {
                void checkAuth()
              }}
            >
              重新检测登录
            </button>
          </div>
        </div>
      ) : null}

      <div style={s.grid}>
        <span style={s.label}>宿主</span>
        <span style={s.value}>
          {status === null ? '读取中…' : `pid ${status.host.pid} · ${status.host.url}`}
        </span>
        <span style={s.label}>版本</span>
        <span style={s.value}>
          {status === null
            ? '—'
            : `DSH ${status.host.dshVersion || '未知'} · Node ${status.host.nodeVersion}`}
        </span>
        <span style={s.label}>已运行</span>
        <span style={s.value}>
          {status === null ? '—' : `${human(status.host.uptimeMs)}（启动于 ${localTime(status.host.startedAt)}）`}
        </span>
        <span style={s.label}>重启方式</span>
        <span style={s.value}>
          {status === null
            ? '—'
            : status.host.launchd.managed
              ? `launchd 托管（${status.host.launchd.label}${status.host.launchd.state === '' ? '' : ' · ' + status.host.launchd.state}）— 由 launchd 拉起，避免与自己拉起的进程抢端口`
              : '分离助手自拉起（等端口释放后用相同命令重启）'}
          {config !== null && config.restartMode !== 'auto' ? `　·　配置强制：${config.restartMode}` : ''}
        </span>
        <span style={s.label}>启动命令</span>
        <span style={{ ...s.value, fontFamily: 'ui-monospace, Menlo, monospace', fontSize: '11.5px' }}>
          {status === null ? '—' : status.host.command}
        </span>
      </div>

      {restarting || live.phase === 'failed' || (live.phase === 'idle' && live.note !== '') ? (
        <div style={live.phase === 'failed' ? s.error : s.muted}>
          {live.note}
          {live.phase === 'failed' && live.error !== '' ? `｜${live.error}` : ''}
        </div>
      ) : null}

      {error !== '' ? <div style={s.error}>{error}</div> : null}
      {notice !== '' ? <div style={s.muted}>{notice}</div> : null}

      <div style={s.row}>
        <button
          type="button"
          style={restarting || busy ? { ...s.primary, opacity: 0.6, cursor: 'default' } : s.primary}
          disabled={restarting}
          onClick={() => {
            void onRestart()
          }}
        >
          {restarting ? '正在重启…' : '立即重启'}
        </button>
        <button
          type="button"
          style={s.button}
          onClick={() => {
            void load()
          }}
        >
          刷新状态
        </button>
        <button
          type="button"
          style={s.button}
          onClick={() => {
            void copyDiagnosis()
          }}
        >
          复制诊断报告
        </button>
        {consoleUrl !== '' ? (
          <button
            type="button"
            style={s.button}
            onClick={() => window.open(consoleUrl, '_blank', 'noopener')}
          >
            恢复控制台
          </button>
        ) : null}
      </div>

      <div style={s.muted}>
        点击后旧进程退出、分离的重启助手用完全相同的命令拉起新宿主，本页会自动重连并刷新；若新宿主启动失败，报错会直接显示在上方遮罩与恢复控制台。
      </div>

      {helperAlive && helper !== null ? (
        <div style={s.section}>
          <div style={s.row}>
            <strong>重启助手</strong>
            <span style={s.badge}>{PHASE_LABEL[helper.phase ?? ''] ?? helper.phase ?? '未知'}</span>
            <span style={s.muted}>
              第 {helper.attempt ?? 1}/{helper.maxAttempts ?? 1} 次 · 已 {human(helper.elapsedMs ?? 0)}
            </span>
          </div>
          {helper.failure?.message !== undefined ? <div style={s.error}>{helper.failure.message}</div> : null}
          {helper.errorLines !== undefined && helper.errorLines.length > 0 ? (
            <pre style={s.log}>{helper.errorLines.map((entry) => entry.text).join('\n')}</pre>
          ) : null}
          {helper.logFile != null && helper.logFile !== '' ? <div style={s.muted}>日志：{helper.logFile}</div> : null}
        </div>
      ) : null}

      <div style={s.section}>
        <div style={s.row}>
          <button type="button" style={s.button} onClick={() => setShowLog((value) => !value)}>
            {showLog ? '收起启动日志' : '上次启动日志'}
          </button>
          {bootErrors.length > 0 ? (
            <span style={s.error}>{bootErrors.length} 行疑似报错</span>
          ) : logs?.exists === true ? (
            <span style={s.muted}>无明显报错</span>
          ) : null}
        </div>
        {showLog ? logBlock : null}
      </div>

      <div style={s.section}>
        <div style={s.row}>
          <strong>重启记录</strong>
          <span style={s.muted}>{status?.history.length ?? 0} 条</span>
        </div>
        {status === null || status.history.length === 0 ? (
          <div style={s.muted}>还没有通过本插件重启过。</div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
            {status.history.slice(0, 6).map((record) => (
              <div key={`${record.at}-${record.helperPid ?? 0}`} style={s.muted}>
                {localTime(record.at)} · {record.source}
                {record.reason === '' ? '' : `（${record.reason}）`} · pid {record.oldPid} →{' '}
                {record.helperPid === null ? '—' : `助手 ${record.helperPid}`}
              </div>
            ))}
          </div>
        )}
      </div>

      <div style={s.section}>
        <div style={s.row}>
          <button type="button" style={s.button} onClick={() => setShowSettings((value) => !value)}>
            {showSettings ? '收起设置' : '插件设置'}
          </button>
          <span style={s.muted}>配置文件：{status?.configFile ?? '—'}</span>
        </div>
        {showSettings && config !== null ? (
          <>
            <label style={s.field}>
              <span>重启方式（auto 自动识别 launchd）</span>
              <select
                style={s.input}
                value={config.restartMode}
                onChange={(event) => void saveConfig({ restartMode: event.target.value as RestartConfig['restartMode'] })}
              >
                <option value="auto">auto</option>
                <option value="launchd">launchd</option>
                <option value="helper">helper</option>
              </select>
            </label>
            <label style={s.field}>
              <span>新宿主应答后自动刷新页面</span>
              <input
                type="checkbox"
                checked={config.autoReload}
                onChange={(event) => void saveConfig({ autoReload: event.target.checked })}
              />
            </label>
            <label style={s.field}>
              <span>重启时显示全屏遮罩</span>
              <input
                type="checkbox"
                checked={config.showOverlay}
                onChange={(event) => void saveConfig({ showOverlay: event.target.checked })}
              />
            </label>
            <label style={s.field}>
              <span>启动超时（毫秒，3000-900000）</span>
              <input
                type="number"
                style={s.input}
                defaultValue={config.bootTimeoutMs}
                onBlur={(event) => void saveConfig({ bootTimeoutMs: Number(event.target.value) })}
              />
            </label>
            <label style={s.field}>
              <span>自动重试次数（1-5）</span>
              <input
                type="number"
                style={s.input}
                defaultValue={config.maxAttempts}
                onBlur={(event) => void saveConfig({ maxAttempts: Number(event.target.value) })}
              />
            </label>
            <label style={s.field}>
              <span>恢复控制台端口（默认 3099）</span>
              <input
                type="number"
                style={s.input}
                defaultValue={config.fallbackPort}
                onBlur={(event) => void saveConfig({ fallbackPort: Number(event.target.value) })}
              />
            </label>
            <div style={s.row}>
              <button
                type="button"
                style={s.button}
                onClick={() => {
                  void api
                    .setConfig({ reset: true })
                    .then((result) => {
                      setDraft(result.config)
                      setNotice('已恢复默认设置')
                    })
                    .catch((caught: unknown) => setError(String(caught)))
                }}
              >
                恢复默认设置
              </button>
              <span style={s.muted}>重启助手每次重启都会重新读取这些设置。</span>
            </div>
          </>
        ) : null}
      </div>
    </div>
  )
}
