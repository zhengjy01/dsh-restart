/**
 * dsh-restart — stale-tab self-heal and 401 recovery regression.
 *
 * The two failure modes this suite pins down both live in the browser half, so
 * the test drives the *real* built client bundle (`lib/client.js`) with stubbed
 * globals — sessionStorage, location, fetch — instead of a copy of the logic:
 *
 *   A. 构造失败态 → 宿主恢复 → 页面自愈
 *      A persisted "启动失败" whose host is already answering must be cleared
 *      on mount, not resurrected. An in-flight failure must also clear itself
 *      the moment the host answers again.
 *   B. 命中 401 → 用新 token 地址打开
 *      When the host's index answers 401, the page must fetch this process's
 *      current token URL from the cookie-free plugin route and expose it,
 *      instead of navigating into the plain-text 401 page.
 *
 * Run `npm run build` first: the suite exercises lib/client.js, not src/.
 */

import { createRequire } from 'node:module'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const bundlePath = path.join(here, '..', 'lib', 'client.js')

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

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

// --- browser stubs -----------------------------------------------------------------

/** Minimal Storage stand-in. */
function makeStorage(initial = {}) {
  const map = new Map(Object.entries(initial))
  return {
    getItem: (key) => (map.has(key) ? map.get(key) : null),
    setItem: (key, value) => {
      map.set(key, String(value))
    },
    removeItem: (key) => {
      map.delete(key)
    },
    has: (key) => map.has(key),
  }
}

const pendingKey = 'dsh-restart/pending'
const storage = makeStorage()
let reloads = 0
globalThis.sessionStorage = storage
globalThis.location = {
  origin: 'http://127.0.0.1:3080',
  href: 'http://127.0.0.1:3080/?token=OLD',
  reload: () => {
    reloads++
  },
}
globalThis.window = {
  addEventListener: () => {},
  __ModuleLoader__: { load: (mod) => { captured = mod } },
}
globalThis.document = { visibilityState: 'visible', addEventListener: () => {} }

/** What the fake host currently answers. */
const scenario = {
  /** 'up' | 'down' */
  probe: 'up',
  /** Index status: 200 (cookie good) | 401 (stale token) | 303. */
  index: 200,
  authUrl: 'http://127.0.0.1:3080/?token=FRESH',
  /** 'ok' | 'down' */
  restart: 'ok',
}

/** One JSON response. */
function json(status, body) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  })
}

let fetchCalls = []
globalThis.fetch = async (input, init = {}) => {
  const url = typeof input === 'string' ? input : input.url
  fetchCalls.push({ url, method: init.method ?? 'GET' })
  if (url === '/api/dsh-restart/probe') {
    if (scenario.probe !== 'up') throw new TypeError('fetch failed')
    return json(200, { ok: true, pid: 4321, startedAt: new Date().toISOString(), uptimeMs: 1 })
  }
  if (url === '/api/dsh-restart/auth') {
    return json(200, {
      ok: true,
      authUrl: scenario.authUrl,
      origin: 'http://127.0.0.1:3080',
      port: 3080,
      pid: 4321,
    })
  }
  if (url === '/api/dsh-restart/status') {
    return json(200, {
      ok: true,
      host: { pid: 4321, url: 'http://127.0.0.1:3080' },
      config: { autoReload: true, probeIntervalMs: 1200, showOverlay: true },
      authUrl: scenario.authUrl,
      history: [],
    })
  }
  if (url === '/api/dsh-restart/restart') {
    if (scenario.restart !== 'ok') throw new TypeError('fetch failed')
    return json(202, {
      ok: true,
      helperPid: 99,
      logFile: '/tmp/boot.log',
      statusFile: '/tmp/status.json',
      fallbackPort: 3099,
      fallbackUrl: 'http://127.0.0.1:3099',
      exitInMs: 800,
      restartingAt: new Date().toISOString(),
      oldPid: 4321,
    })
  }
  if (url === '/' && (init.method ?? 'GET') === 'HEAD') {
    return new Response(null, { status: scenario.index })
  }
  throw new Error('unexpected fetch: ' + url)
}

// --- load the real browser bundle --------------------------------------------------

let captured = null
await import(bundlePath)
if (captured === null || typeof captured.factory !== 'function') {
  console.error('✘ lib/client.js did not register with __ModuleLoader__ — run `npm run build` first')
  process.exit(1)
}
const plugin = captured.factory(createRequire(import.meta.url))
const t = plugin.__test
check('bundle exposes the test seam (__test)', t !== undefined && typeof t.resumeIfPending === 'function')
check(
  'bundle still exports the plugin apply/inject',
  typeof plugin.apply === 'function' && Array.isArray(plugin.inject),
)

/** Reset between scenarios. */
async function reset() {
  t.dismiss()
  scenario.probe = 'up'
  scenario.index = 200
  scenario.restart = 'ok'
  await t.checkAuth() // clears the 401 ticker when authenticated
  storage.removeItem(pendingKey)
  reloads = 0
  fetchCalls = []
}

// --- A. 构造失败态 → 宿主恢复 → 页面自愈 ------------------------------------------

console.log('\nA. 构造失败态 → 宿主恢复 → 页面自愈')

storage.setItem(
  pendingKey,
  JSON.stringify({ phase: 'failed', startedAt: Date.now(), error: '启动失败：新进程退出 code=1', fallbackUrl: '', port: 3080 }),
)
scenario.probe = 'up' // the host is healthy again
await t.resumeIfPending()
check('mount drops a persisted failure the host already recovered from', t.getState().phase === 'idle', t.getState().phase)
check('the leftover error text is cleared', t.getState().error === '', t.getState().error)
check('sessionStorage no longer holds the failure', storage.has(pendingKey) === false)
check('the user is told the state was self-healed', t.getState().note.includes('已自动清除'), t.getState().note)
await reset()

// A restart that was in flight and finished while the tab was away: the page is
// stale and must reload to pick up the new code, not silently keep the old bundle.
storage.setItem(pendingKey, JSON.stringify({ phase: 'waiting', startedAt: Date.now(), port: 3080 }))
scenario.probe = 'up'
await t.resumeIfPending()
check('a completed in-flight restart schedules a reload', t.getState().reloadAt !== null, String(t.getState().reloadAt))
await sleep(900)
check('...and actually reloads to the new code', reloads === 1, String(reloads))
await reset()

// An in-flight restart request that failed while the host was mid-restart.
scenario.probe = 'down'
scenario.restart = 'down'
await t.startRestart('self-heal regression', 'test')
check('a failed restart request lands in the failed phase', t.getState().phase === 'failed', t.getState().phase)
check('the failure carries the request error', t.getState().error.includes('重启指令下发失败'), t.getState().error)

// The host comes back.
scenario.probe = 'up'
await t.checkNow()
check('once the host answers, the page leaves the failed phase', t.getState().phase === 'ready', t.getState().phase)
check('and clears the stale error text', t.getState().error === '', t.getState().error)
check('and drops the persisted failure marker', storage.has(pendingKey) === false)
await sleep(900) // the reload is deliberately deferred
check('then reloads itself to load the new code', reloads === 1, String(reloads))
await reset()

// --- B. 命中 401 → 用新 token 地址打开 --------------------------------------------

console.log('\nB. 命中 401 → 用新 token 地址打开')

scenario.probe = 'up'
scenario.index = 401
scenario.authUrl = 'http://127.0.0.1:3080/?token=FRESH'
await t.resumeIfPending()
check('a 401 index marks the page as unauthenticated', t.getState().authRequired === true)
check('the current process token URL is fetched from the cookie-free route', t.getState().authUrl === scenario.authUrl, t.getState().authUrl)
check('and the page does NOT navigate into the 401', reloads === 0, String(reloads))
await reset()

// The combined case: host recovers, but this tab's cookie is gone.
storage.setItem(pendingKey, JSON.stringify({ phase: 'waiting', startedAt: Date.now(), fallbackUrl: '', port: 3080 }))
scenario.probe = 'down'
await t.resumeIfPending()
check('an in-flight restart is resumed while the host is down', t.getState().phase === 'waiting', t.getState().phase)
scenario.probe = 'up'
scenario.index = 401
await t.checkNow()
check('a recovered host still reports ready', t.getState().phase === 'ready', t.getState().phase)
check('but the stale-token page is flagged for re-authentication', t.getState().authRequired === true)
check('the note explains the 401 and points at the new address', t.getState().note.includes('401'), t.getState().note)
check('a reload is withheld (it would land on the plain-text 401 page)', reloads === 0, String(reloads))
check(
  'the fresh token URL is offered for the click-through',
  t.getState().authUrl === 'http://127.0.0.1:3080/?token=FRESH',
  t.getState().authUrl,
)
await sleep(900) // give a wrongly scheduled reload time to fire, so 0 is meaningful
check('a reload is still withheld after the deferred window', reloads === 0, String(reloads))

// Recovery: the token URL was opened (cookie minted) and the page authenticates.
scenario.index = 200
await t.checkAuth()
check('once the cookie is valid again the 401 flag clears', t.getState().authRequired === false)

// A non-DSH deployment (index answers 404) must never be pushed into the 401 path.
scenario.index = 404
await t.checkAuth()
check('an unknown index answer is not treated as 401', t.getState().authRequired === false)

await reset()

// --- done --------------------------------------------------------------------------

console.log(`\n${passed} passed, ${failed} failed`)
if (failed > 0) process.exit(1)
