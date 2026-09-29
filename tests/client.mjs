/**
 * dsh-restart client-bundle placement tests.
 *
 * Executes the emitted `lib/client.js` inside a synthetic
 * `window.__ModuleLoader__` + a small fake DOM, so the sidebar half is verified
 * without a browser or a host restart.
 *
 * The behaviour pinned down here is the shared footer row: the shell renders
 * `[class*="settingsArea"]` as a VERTICAL block, so an entry appended straight
 * to it takes a whole row of its own. Every entry must therefore converge on
 * ONE `.dsh-sidebar-row`, and creating that row must not be keyed on another
 * plugin's DOM — the sidebar used to stack every entry whenever its old anchor
 * (the WeChat bridge's ball) was not installed, which is exactly the desktop
 * profile a user is most likely to run.
 *
 * Run `npm run build` first: the suite exercises lib/client.js, not src/.
 */

import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'

const here = path.dirname(fileURLToPath(import.meta.url))
const require = createRequire(import.meta.url)

let passed = 0
let failed = 0

function check(label, condition, detail = '') {
  if (condition) {
    passed++
    console.log('  ✔ ' + label)
  } else {
    failed++
    console.error('  ✘ ' + label + (detail ? ' — ' + detail : ''))
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/* ------------------------------------------------------------------ */
/* A tiny fake DOM, enough for placement + class assertions            */
/* ------------------------------------------------------------------ */

/** Minimal selector support: `[class*="x"]`, `.x` and `#id`. */
function matchesSelector(node, selector) {
  const bracket = /\[class\*="([^"]+)"\]/.exec(selector)
  if (bracket !== null) return node.className.includes(bracket[1])
  if (selector.startsWith('#')) return node.id === selector.slice(1)
  if (selector.startsWith('.')) return node.className.split(/\s+/).includes(selector.slice(1))
  return false
}

function makeNode(tag) {
  const classes = new Set()
  const node = {
    tagName: tag,
    dataset: {},
    style: {},
    id: '',
    textContent: '',
    parentNode: null,
    children: [],
    appendChild(child) {
      child.parentNode = node
      node.children.push(child)
      return child
    },
    insertBefore(child, reference) {
      const index = reference === null ? node.children.length : node.children.indexOf(reference)
      if (index < 0) throw new Error('insertBefore: reference is not a child')
      child.parentNode = node
      node.children.splice(index, 0, child)
      return child
    },
    removeChild(child) {
      const index = node.children.indexOf(child)
      if (index >= 0) node.children.splice(index, 1)
      child.parentNode = null
      return child
    },
    remove() {
      if (node.parentNode !== null) node.parentNode.removeChild(node)
    },
    querySelector(selector) {
      for (const child of node.children) {
        if (matchesSelector(child, selector)) return child
        const nested = child.querySelector(selector)
        if (nested !== null) return nested
      }
      return null
    },
    querySelectorAll(selector) {
      const found = []
      for (const child of node.children) {
        if (matchesSelector(child, selector)) found.push(child)
        found.push(...child.querySelectorAll(selector))
      }
      return found
    },
    contains(other) {
      if (other === node) return true
      return node.children.some((child) => child.contains(other))
    },
    get childElementCount() {
      return node.children.length
    },
    get lastElementChild() {
      return node.children[node.children.length - 1] ?? null
    },
    get parentElement() {
      return node.parentNode
    },
    get nextSibling() {
      if (node.parentNode === null) return null
      const siblings = node.parentNode.children
      return siblings[siblings.indexOf(node) + 1] ?? null
    },
    classList: {
      add: (name) => classes.add(name),
      remove: (name) => classes.delete(name),
      contains: (name) => classes.has(name),
    },
    get className() {
      return [...classes].join(' ')
    },
    set className(value) {
      classes.clear()
      for (const part of String(value).split(/\s+/).filter(Boolean)) classes.add(part)
    },
  }
  return node
}

const documentRoot = makeNode('html')
const head = makeNode('head')
const body = makeNode('body')
documentRoot.appendChild(head)
documentRoot.appendChild(body)

/** A MutationObserver stub that records registration and can be fired manually. */
const observers = []
class MutationObserverStub {
  constructor(callback) {
    this.callback = callback
    this.targets = []
  }
  observe(target, options) {
    this.targets.push({ target, options })
    observers.push(this)
  }
  disconnect() {
    this.targets = []
  }
  fire() {
    this.callback([], this)
  }
}

/**
 * Build a fresh document stub; optionally with a settings area holding the
 * WeChat ball (the legacy anchor) or a legacy row another plugin created.
 */
function makeDocument({ withSettingsArea = true, wechatBall = false, legacyRowClass = null } = {}) {
  head.children.length = 0
  for (const child of body.children) child.parentNode = null
  body.children.length = 0
  observers.length = 0
  const documentStub = {
    head,
    body,
    visibilityState: 'visible',
    hidden: false,
    documentElement: { classList: { contains: () => false }, dataset: {}, style: {} },
    createElement: (tag) => makeNode(tag),
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    getElementById: (id) => {
      const walk = (node) => {
        for (const child of node.children) {
          if (child.id === id) return child
          const found = walk(child)
          if (found !== null) return found
        }
        return null
      }
      return walk(documentRoot)
    },
    querySelector: (selector) => {
      if (selector.includes('settingsArea')) return withSettingsArea ? findSettingsArea() : null
      return body.querySelector(selector)
    },
    querySelectorAll: (selector) => documentRoot.querySelectorAll(selector),
  }
  if (withSettingsArea) {
    const area = makeNode('div')
    area.className = 'Sidebar_settingsArea__abc123'
    if (legacyRowClass !== null) {
      const legacy = makeNode('div')
      legacy.className = legacyRowClass
      const other = makeNode('div')
      other.id = 'some-other-entry'
      legacy.appendChild(other)
      area.appendChild(legacy)
    }
    if (wechatBall) {
      const ball = makeNode('button')
      ball.id = 'dshwx-ball'
      ball.className = 'dshwx-ball dshwx-inline'
      area.appendChild(ball)
    }
    body.appendChild(area)
  }
  return documentStub
}

function findSettingsArea() {
  return body.querySelector('[class*="settingsArea"]')
}

/* ------------------------------------------------------------------ */
/* Globals the browser half expects outside of the injected parameters */
/* ------------------------------------------------------------------ */

/** Node's own `navigator` / storage globals are getter-only, so define them. */
function defineGlobal(name, value) {
  Object.defineProperty(globalThis, name, { value, configurable: true, writable: true })
}

const storageStub = {
  getItem: () => null,
  setItem: () => undefined,
  removeItem: () => undefined,
}
defineGlobal('sessionStorage', storageStub)
defineGlobal('localStorage', storageStub)
defineGlobal('navigator', { userAgent: 'node-test', language: 'zh-CN' })
globalThis.fetch = async () => {
  throw new Error('offline in test')
}

const code = await readFile(path.join(here, '..', 'lib', 'client.js'), 'utf8')

console.log('\n[1] bundle 形状')
check('带 __ModuleLoader__.load 包裹', code.includes('window.__ModuleLoader__.load('))
check('声明了插件 id', code.includes('"@zhengjunyao/dsh-restart"') || code.includes("'@zhengjunyao/dsh-restart'"))
check('内联了侧栏锚点选择器', code.includes('settingsArea'))
check('内联了共用的横向行容器', code.includes('dsh-sidebar-row'))
check('行不依赖微信球锚点', !code.includes('ANCHOR_BALL_SELECTOR') && !code.includes('EXISTING_ROW_SELECTORS'))

console.log('\n[2] 外部依赖白名单')
const requiredModules = [...code.matchAll(/require\(["']([^"']+)["']\)/g)].map((match) => match[1])
const outsideTable = requiredModules.filter(
  (id) => !['react', 'react/jsx-runtime', 'react-dom', 'react-dom/client'].includes(id),
)
check('只 require 模块表里的包', outsideTable.length === 0, outsideTable.join(', '))

/** Evaluate the bundle against one document stub. */
function evaluate(documentStub) {
  const React = require('react')
  const jsxRuntime = require('react/jsx-runtime')
  const recorded = { loaded: null, roots: 0 }
  const fakeRequire = (id) => {
    if (id === 'react') return React
    if (id === 'react/jsx-runtime') return jsxRuntime
    if (id === 'react-dom/client') {
      return {
        createRoot: () => {
          recorded.roots++
          return { render: () => undefined, unmount: () => undefined }
        },
      }
    }
    if (id === 'react-dom') return {}
    throw new Error('unexpected require in client bundle: ' + id)
  }
  const windowStub = {
    __ModuleLoader__: {
      load: (spec) => {
        recorded.loaded = spec
      },
    },
    matchMedia: () => ({ matches: false }),
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    setTimeout: (fn) => fn(),
    clearTimeout: () => undefined,
    setInterval: () => 0,
    clearInterval: () => undefined,
    location: { origin: 'http://127.0.0.1:3080', href: 'http://127.0.0.1:3080/', reload: () => undefined },
  }
  const moduleStub = { exports: {} }
  const factoryFn = new Function(
    'require', 'module', 'exports', 'window', 'document', 'getComputedStyle', 'MutationObserver',
    'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval',
    code,
  )
  factoryFn(
    fakeRequire, moduleStub, moduleStub.exports, windowStub, documentStub,
    () => ({ backgroundColor: 'rgba(0, 0, 0, 0)' }), MutationObserverStub,
    (fn) => fn(), () => undefined, () => 0, () => undefined,
  )
  const exports = recorded.loaded.factory(fakeRequire)
  const ctx = {
    slots: {
      inject: (name, callback) => callback(),
      register: () => () => undefined,
    },
  }
  return { exports, recorded, ctx }
}

const CONTAINER_ID = 'dsh-restart-entry'
const ROW_SELECTOR = '.dsh-sidebar-row'
const LEGACY_ROW_SELECTORS = ['.dsh-zhihu-row', '.dshupd-row', '.dshrst-row']
const ENTRY_SELECTORS = ['#dshwx-ball', '#dsh-zhihu-floating-entry', '#dsh-updater-entry', '#dsh-restart-entry']

/** Everything inside the settings area that still sits there directly. */
function strays(area) {
  return ENTRY_SELECTORS.flatMap((selector) => area.querySelectorAll(selector)).filter(
    (node) => node.parentNode === area,
  )
}

console.log('\n[3] 微信插件不在场（桌面 App 的真实条件）：仍然成行')
const documentA = makeDocument({ withSettingsArea: true, wechatBall: false })
const runA = evaluate(documentA)
runA.exports.apply(runA.ctx)
await sleep(30)
/** documentA 这次挂载注册的观察器，供 [6] 单独驱动（后面的用例会重置 observers）。 */
const watchedA = observers[observers.length - 1]
const area = findSettingsArea()
const container = documentA.getElementById(CONTAINER_ID)
const row = area.querySelector(ROW_SELECTOR)
check('入口容器已创建', container !== null)
check('入口挂进共用的横向行', container?.parentNode === row, String(container?.parentNode?.className))
check('行挂在 settingsArea 内', row?.parentNode === area)
check('行排在设置按钮之后（settingsArea 最后一个子节点）', area.lastElementChild === row)
check('入口没有直接挂在 settingsArea 下', strays(area).length === 0, strays(area).map((n) => n.id).join(', '))
check('固定 order = 40', container?.style?.order === '40', String(container?.style?.order))
check('没有微信球也不退回 body', container?.parentNode !== body)

console.log('\n[4] 微信球在场：收编进同一行，顺序固定')
const documentB = makeDocument({ withSettingsArea: true, wechatBall: true })
const runB = evaluate(documentB)
runB.exports.apply(runB.ctx)
await sleep(30)
const areaB = findSettingsArea()
const containerB = documentB.getElementById(CONTAINER_ID)
const rowB = areaB.querySelector(ROW_SELECTOR)
const ballB = areaB.querySelector('#dshwx-ball')
check('容器在共用行里', containerB?.parentNode === rowB)
check('微信球被收进同一行', ballB?.parentNode === rowB)
check('只造了一行', areaB.querySelectorAll(ROW_SELECTOR).length === 1)
check('顺序固定：微信球 10、重启入口 40', ballB?.style?.order === '10' && containerB?.style?.order === '40')

console.log('\n[5] 旧行容器被采纳并合并，不出现第二行')
const documentC = makeDocument({ withSettingsArea: true, legacyRowClass: 'dsh-zhihu-row' })
const runC = evaluate(documentC)
runC.exports.apply(runC.ctx)
await sleep(30)
const areaC = findSettingsArea()
check('只剩一个行容器', areaC.querySelectorAll(ROW_SELECTOR).length === 1, String(areaC.querySelectorAll(ROW_SELECTOR).length))
check(
  '整页只有一个行元素（旧行名被吸收，没留第二行）',
  LEGACY_ROW_SELECTORS.every((s) => {
    const found = areaC.querySelector(s)
    return found === null || found === areaC.querySelector(ROW_SELECTOR)
  }),
)
check('复用的旧行被补上统一类名（共享 flex 样式生效）', areaC.querySelector(LEGACY_ROW_SELECTORS[0])?.classList.contains('dsh-sidebar-row') === true)
check('旧行里的邻居被搬进新行', documentC.getElementById('some-other-entry')?.parentNode === areaC.querySelector(ROW_SELECTOR))
check('入口进了同一行', documentC.getElementById(CONTAINER_ID)?.parentNode === areaC.querySelector(ROW_SELECTOR))

console.log('\n[6] 侧栏重建后自愈')
const watched = watchedA
check('注册了 MutationObserver', watched !== undefined)
const area2 = makeNode('div')
area2.className = 'Sidebar_settingsArea__xyz'
const ball2 = makeNode('button')
ball2.id = 'dshwx-ball'
ball2.className = 'dshwx-ball dshwx-inline'
area2.appendChild(ball2)
body.children.length = 0
body.appendChild(area2)
watched?.fire()
await sleep(30)
const row2 = area2.querySelector(ROW_SELECTOR)
check('侧栏重建后自动重新挂回', container?.parentNode === row2, String(container?.parentNode?.className))
check('重建后又造了一个共用的行', row2 !== null && ball2.parentNode === row2)

console.log('\n[7] 没有 settingsArea 时回退右下角')
const documentD = makeDocument({ withSettingsArea: false })
const runD = evaluate(documentD)
runD.exports.apply(runD.ctx)
await sleep(30)
const containerD = documentD.getElementById(CONTAINER_ID)
check('回退挂到 body', containerD?.parentNode === body)
check('回退时不造多余的行', body.querySelector(ROW_SELECTOR) === null)

console.log('\n[8] 重复 apply 不叠加')
runA.exports.apply(runA.ctx)
await sleep(30)
const containers = (() => {
  let count = 0
  const walk = (node) => {
    for (const child of node.children) {
      if (child.id === CONTAINER_ID) count++
      walk(child)
    }
  }
  walk(documentRoot)
  return count
})()
check('整棵树里只有一个入口容器', containers === 1, 'got ' + containers)

console.log('\n' + (failed === 0 ? '全部通过' : '有失败项') + '：' + passed + ' passed, ' + failed + ' failed\n')
process.exit(failed === 0 ? 0 : 1)
