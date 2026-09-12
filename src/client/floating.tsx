/**
 * Sidebar entry for dsh-restart.
 *
 * The restart control belongs next to the other plugin entries in the left
 * sidebar's settings area (`[class*="settingsArea"]`), not in a corner of its
 * own — my other plugins already mount there, so this entry joins their
 * horizontal row when it exists and creates the row when it does not.
 *
 * The button itself only opens the panel; the actual restart is the panel's
 * primary button, so a stray click in the sidebar can never kill the session.
 * The icon reflects live state (idle / restarting / failed) so the sidebar is
 * enough to tell whether something went wrong.
 *
 * If the settings area never appears (a shell without it), the entry falls back
 * to a fixed bottom-right ball. A MutationObserver re-places it whenever the
 * anchor changes, because the sidebar is React-rendered and may be recreated.
 */
import { useEffect, useState } from 'react'
import { createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'

import { RestartApi, type RestartConfig } from './api.ts'
import { RestartPanel } from './RestartPanel.tsx'
import { useRestartState } from './state.ts'

/** Container id, so a hot reload does not stack copies. */
const CONTAINER_ID = 'dsh-restart-entry'

/** Stylesheet id. */
const STYLE_ID = 'dsh-restart/entry.css'

/** Class marking the inline (sidebar) placement. */
const INLINE_CLASS = 'dshrst-inline'

/** The settings area my other plugin entries mount into. */
const SETTINGS_AREA_SELECTOR = '[class*="settingsArea"]'

/** The WeChat bridge's ball — used to seed a shared row when no row exists yet. */
const ANCHOR_BALL_SELECTOR = '.dshwx-ball'

/** Existing shared row (created by dsh-zhihu); reused when present. */
const EXISTING_ROW_SELECTOR = '.dsh-zhihu-row'

/** Row this plugin creates when nothing else provides one. */
const ROW_CLASS = 'dshrst-row'
const ROW_SELECTOR = '.' + ROW_CLASS

/** Debounce for the placement observer (ms). */
const PLACEMENT_DEBOUNCE_MS = 250

/** Accent colours by state. */
const IDLE_COLOR = '#2b6cb0'
const BUSY_COLOR = '#e0a13a'
const FAIL_COLOR = '#c0392b'

const CSS = [
  '#dsh-restart-entry .dshrst-fab{position:fixed;right:24px;bottom:24px;width:50px;height:50px;',
  'border-radius:50%;border:none;outline:none;cursor:pointer;z-index:2147483000;',
  'background:' + IDLE_COLOR + ';color:#fff;display:flex;align-items:center;justify-content:center;',
  'box-shadow:0 6px 20px rgba(43,108,176,.32);transition:transform .15s,background .2s}',
  '#dsh-restart-entry .dshrst-fab:hover{transform:scale(1.06)}',
  '.' + ROW_CLASS + '{display:flex;align-items:center;justify-content:flex-start}',
  '#' + CONTAINER_ID + '.' + INLINE_CLASS + '{display:flex;align-items:center;flex:none}',
  '#' + CONTAINER_ID + '.' + INLINE_CLASS + ' .dshrst-fab{position:static;width:36px;height:36px;',
  'margin:0 0 0 8px;border-radius:8px;background:transparent;color:inherit;box-shadow:none;',
  'border:1px solid rgba(128,128,128,.35);opacity:.78;transition:opacity .15s,border-color .15s,color .2s}',
  '#' + CONTAINER_ID + '.' + INLINE_CLASS + ' .dshrst-fab:hover{opacity:1;border-color:rgba(128,128,128,.7);transform:none}',
  '#' + CONTAINER_ID + ' .dshrst-spin{animation:dshrst-side-spin 1s linear infinite}',
  '@keyframes dshrst-side-spin{to{transform:rotate(360deg)}}',
  '#dsh-restart-entry .dshrst-pop{position:fixed;right:24px;bottom:86px;z-index:2147483001;',
  'border-radius:12px;box-shadow:0 14px 44px rgba(0,0,0,.22);overflow:hidden;color:inherit}',
  '#' + CONTAINER_ID + '.' + INLINE_CLASS + ' .dshrst-pop{right:auto;left:24px;bottom:92px}',
].join('')

/** Inject the stylesheet once. */
function injectStyles(): void {
  if (document.querySelector('style[data-plugin-css=' + JSON.stringify(STYLE_ID) + ']') !== null) return
  const style = document.createElement('style')
  style.dataset.plugin = 'dsh-restart'
  style.dataset.pluginCss = STYLE_ID
  style.textContent = CSS
  document.head.appendChild(style)
}

/** Sample the shell's surface colour so the popover matches the active theme. */
function surfaceColor(): string {
  const isOpaque = (value: string): boolean =>
    value !== '' && value !== 'transparent' && value !== 'rgba(0, 0, 0, 0)'
  const body = getComputedStyle(document.body).backgroundColor
  if (isOpaque(body)) return body
  const html = getComputedStyle(document.documentElement).backgroundColor
  if (isOpaque(html)) return html
  const root = document.documentElement
  const prefersDark =
    root.classList.contains('dark') ||
    root.dataset.theme === 'dark' ||
    window.matchMedia?.('(prefers-color-scheme: dark)').matches === true
  return prefersDark ? '#1c1c1e' : '#ffffff'
}

/** The circular-arrow glyph (monochrome, no emoji). */
function RestartIcon(props: { spinning: boolean }) {
  return createElement(
    'svg',
    {
      viewBox: '0 0 24 24',
      width: 17,
      height: 17,
      fill: 'none',
      stroke: 'currentColor',
      strokeWidth: 2,
      strokeLinecap: 'round',
      strokeLinejoin: 'round',
      'aria-hidden': true,
      className: props.spinning ? 'dshrst-spin' : undefined,
    },
    createElement('path', { d: 'M21 12a9 9 0 1 1-2.64-6.36' }),
    createElement('polyline', { points: '21 3 21 9 15 9' }),
  )
}

/** The entry button plus its popover. */
function Entry(props: { mode: 'sidebar' | 'ball' }) {
  const [open, setOpen] = useState(false)
  const live = useRestartState()
  const busy = live.phase === 'requesting' || live.phase === 'waiting'
  const failed = live.phase === 'failed'
  const colour = failed ? FAIL_COLOR : busy ? BUSY_COLOR : undefined

  return createElement(
    'div',
    null,
    open
      ? createElement(
          'div',
          { className: 'dshrst-pop', style: { background: surfaceColor() } },
          createElement(RestartPanel, { variant: 'floating', onClose: () => setOpen(false) }),
        )
      : null,
    createElement(
      'button',
      {
        type: 'button',
        className: 'dshrst-fab',
        style: colour === undefined ? undefined : { background: props.mode === 'ball' ? colour : undefined, color: props.mode === 'ball' ? '#fff' : colour },
        title: failed ? 'DSH 重启失败 — 点击查看报错' : busy ? 'DSH 正在重启…' : '重启 DSH',
        'aria-label': '重启 DSH',
        onClick: () => setOpen((value) => !value),
      },
      createElement(RestartIcon, { spinning: busy }),
    ),
  )
}

/** React root handle. */
let root: Root | null = null

/** Place the entry into the sidebar (or fall back to a fixed ball). */
function place(container: HTMLElement, mode: 'sidebar' | 'ball'): void {
  if (mode === 'ball') {
    if (container.parentElement !== document.body) document.body.appendChild(container)
    container.classList.remove(INLINE_CLASS)
    return
  }
  const settingsArea = document.querySelector(SETTINGS_AREA_SELECTOR)
  if (settingsArea === null) {
    if (container.parentElement !== document.body) document.body.appendChild(container)
    container.classList.remove(INLINE_CLASS)
    return
  }
  let row: Element | null = document.querySelector(EXISTING_ROW_SELECTOR) ?? document.querySelector(ROW_SELECTOR)
  const anchor = document.querySelector(ANCHOR_BALL_SELECTOR)
  if (row === null && anchor !== null && anchor.parentElement !== null) {
    // Reuse the existing flex row if another plugin made one; otherwise wrap the
    // anchor so the entries sit side by side instead of stacking.
    const parent = anchor.parentElement
    if (parent === settingsArea || settingsArea.contains(parent)) {
      const created = document.createElement('div')
      created.className = ROW_CLASS
      parent.insertBefore(created, anchor)
      created.appendChild(anchor)
      row = created
    }
  }
  const target: Element = row ?? settingsArea
  if (container.parentElement !== target) target.appendChild(container)
  container.classList.add(INLINE_CLASS)
}

/** Mount the sidebar entry (idempotent). */
export async function mountRestartEntry(): Promise<void> {
  if (typeof document === 'undefined') return
  injectStyles()

  let config: RestartConfig | null = null
  try {
    config = (await new RestartApi().status()).config
  } catch {
    config = null
  }
  const entryMode = config?.entry ?? 'sidebar'
  if (entryMode === 'off') return

  let container = document.getElementById(CONTAINER_ID)
  if (container === null) {
    container = document.createElement('div')
    container.id = CONTAINER_ID
    container.dataset.plugin = 'dsh-restart'
  }
  const mode: 'sidebar' | 'ball' = entryMode === 'ball' ? 'ball' : 'sidebar'
  place(container, mode)
  if (root === null) {
    root = createRoot(container)
    root.render(createElement(Entry, { mode }))
  }

  if (entryMode === 'both') {
    // A second, always-visible ball on top of the inline entry.
    const ballId = CONTAINER_ID + '-ball'
    if (document.getElementById(ballId) === null) {
      const ball = document.createElement('div')
      ball.id = ballId
      ball.dataset.plugin = 'dsh-restart'
      document.body.appendChild(ball)
      createRoot(ball).render(createElement(Entry, { mode: 'ball' }))
    }
  }

  // The sidebar can be recreated at any time; re-place when that happens.
  let timer: ReturnType<typeof setTimeout> | null = null
  const observer = new MutationObserver(() => {
    if (timer !== null) clearTimeout(timer)
    timer = setTimeout(() => {
      if (entryMode !== 'ball') place(container as HTMLElement, 'sidebar')
    }, PLACEMENT_DEBOUNCE_MS)
  })
  observer.observe(document.body, { childList: true, subtree: true })
}
