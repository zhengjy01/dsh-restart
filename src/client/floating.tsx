/**
 * Sidebar entry for dsh-restart.
 *
 * The restart control belongs next to the other plugin entries in the left
 * sidebar's settings area (`[class*="settingsArea"]`). That area is a VERTICAL
 * block in the shell, so an entry appended straight to it takes a whole row of
 * its own; every entry therefore shares ONE horizontal row
 * (`.dsh-sidebar-row`), created by whichever entry mounts first and adopted by
 * the rest — never keyed on another plugin's DOM, since a sibling plugin may
 * simply not be installed.
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

/** The shared footer row every sidebar entry converges on. */
const ROW_CLASS = 'dsh-sidebar-row'

/** Any row a sibling plugin may have made — legacy names included, so a partial upgrade still merges. */
const ROW_SELECTORS = ['.' + ROW_CLASS, '.dsh-zhihu-row', '.dshupd-row', '.dshrst-row']

/** The entries that belong in that row, in the order they should read. */
const ROW_ENTRIES: ReadonlyArray<{ selector: string; order: number }> = [
  { selector: '.dshwx-ball', order: 10 },
  { selector: '#dsh-zhihu-floating-entry', order: 20 },
  { selector: '#dsh-updater-entry', order: 30 },
  { selector: '#dsh-restart-entry', order: 40 },
]

/** This entry's place in the row (fixed, so mount order never reshuffles it). */
const ROW_ORDER = 40

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
  // The shared row keeps every sidebar entry side by side inside the (vertical)
  // settings area, instead of stacking them; it wraps only when it must.
  '.' + ROW_CLASS + '{display:flex;flex-wrap:wrap;align-items:center;justify-content:flex-start;',
  'gap:2px;flex:1 1 auto;min-width:0;box-sizing:border-box}',
  // Inline placement: a plain 36px flex item sitting in that row.
  '#' + CONTAINER_ID + '.' + INLINE_CLASS + '{display:flex;align-items:center;flex:none}',
  // `relative` (not `static`) so the pending badge has a positioning context.
  // But the base rule above pins `right:24px;bottom:24px` for the floating ball,
  // and on a *relative* box those two actually offset it — which shoved this
  // sidebar entry 24px up and to the left, out of the row. Zero all four here;
  // the ball keeps its own fixed inset because this rule does not match it.
  '#' + CONTAINER_ID + '.' + INLINE_CLASS + ' .dshrst-fab{position:relative;',
  'top:auto;right:auto;bottom:auto;left:auto;width:36px;height:36px;',
  'margin:0;border-radius:8px;background:transparent;color:inherit;box-shadow:none;',
  'border:1px solid rgba(128,128,128,.35);opacity:.78;transition:opacity .15s,border-color .15s,color .2s}',
  '#' + CONTAINER_ID + '.' + INLINE_CLASS + ' .dshrst-fab:hover{opacity:1;border-color:rgba(128,128,128,.7);transform:none}',
  // An agent's restart request has to be visible on the entry itself — the user
  // must not have to open a panel to notice that something is waiting for them.
  '#' + CONTAINER_ID + ' .dshrst-fab.dshrst-pending::after{content:"";position:absolute;top:-2px;right:-2px;',
  'width:9px;height:9px;border-radius:50%;background:' + FAIL_COLOR + ';box-shadow:0 0 0 2px rgba(255,255,255,.9)}',
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
  /** An agent asked for a restart and the user has not decided yet. */
  const pending = live.approval !== null
  const colour = failed || pending ? FAIL_COLOR : busy ? BUSY_COLOR : undefined
  const title = failed
    ? 'DSH 重启失败 — 点击查看报错'
    : pending
      ? '有一个重启请求等你确认 — 点击查看'
      : busy
        ? 'DSH 正在重启…'
        : '重启 DSH'

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
        className: pending ? 'dshrst-fab dshrst-pending' : 'dshrst-fab',
        style: colour === undefined ? undefined : { background: props.mode === 'ball' ? colour : undefined, color: props.mode === 'ball' ? '#fff' : colour },
        title,
        'aria-label': title,
        onClick: () => setOpen((value) => !value),
      },
      createElement(RestartIcon, { spinning: busy }),
    ),
  )
}

/** React root handle. */
let root: Root | null = null

/** Find the shared row, whichever plugin made it. */
function findRow(area: Element): HTMLElement | null {
  for (const selector of ROW_SELECTORS) {
    const row = area.querySelector<HTMLElement>(selector)
    if (row !== null) return row
  }
  return null
}

/**
 * Put `container` into the shared footer row, creating the row when none exists.
 *
 * The shell's settings area is a vertical block, so an entry appended straight
 * to it takes a whole row of its own. The row is what makes the entries read as
 * one horizontal line, and creating it must not depend on any other plugin: a
 * sibling entry may simply not be installed, and keying creation on the WeChat
 * ball is what used to leave every entry stacked.
 *
 * Idempotent — it mutates only while something is out of place, so the
 * placement observer settles instead of looping.
 * @param container - this plugin's entry container.
 * @param area - the sidebar's settings area.
 */
function joinRow(container: HTMLElement, area: HTMLElement): void {
  let row = findRow(area)
  if (row === null) {
    row = document.createElement('div')
    row.className = ROW_CLASS
    row.dataset.plugin = 'dsh-sidebar-row'
  } else {
    // Normalise a row another plugin (or an older build) created, so the shared
    // flex styling applies to it as well.
    row.classList.add(ROW_CLASS)
  }
  // Fold duplicate rows into this one (two plugins can mount in the same tick),
  // then adopt every known entry still parked in the vertical settings area.
  for (const selector of ROW_SELECTORS) {
    for (const other of Array.from(area.querySelectorAll<HTMLElement>(selector))) {
      if (other === row) continue
      for (const child of Array.from(other.children)) row.appendChild(child)
      other.remove()
    }
  }
  for (const entry of ROW_ENTRIES) {
    for (const node of Array.from(area.querySelectorAll<HTMLElement>(entry.selector))) {
      if (node.parentElement !== row) row.appendChild(node)
      // Fixed order, so mount order and observer ticks never reshuffle the row.
      node.style.order = String(entry.order)
    }
  }
  if (container.parentElement !== row) row.appendChild(container)
  container.style.order = String(ROW_ORDER)
  // The row reads below the settings button, and has to be mounted.
  if (row.parentElement !== area || area.lastElementChild !== row) area.appendChild(row)
}

/** Place the entry into the sidebar (or fall back to a fixed ball). */
function place(container: HTMLElement, mode: 'sidebar' | 'ball'): void {
  if (mode === 'ball') {
    if (container.parentElement !== document.body) document.body.appendChild(container)
    container.classList.remove(INLINE_CLASS)
    return
  }
  const settingsArea = document.querySelector<HTMLElement>(SETTINGS_AREA_SELECTOR)
  if (settingsArea === null) {
    if (container.parentElement !== document.body) document.body.appendChild(container)
    container.classList.remove(INLINE_CLASS)
    return
  }
  container.classList.add(INLINE_CLASS)
  joinRow(container, settingsArea)
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
