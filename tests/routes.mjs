/**
 * dsh-restart route tests.
 *
 * Drives the /api/dsh-restart/* handlers directly with synthetic req/res
 * objects, so the panel's whole data path is verified without a restart, a
 * browser, or a real HTTP server. The restart POST is deliberately exercised
 * only through its guard (wrong method / cross-site): a successful restart
 * would end this test process — tests/handoff.mjs covers that path for real.
 */

import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

const HOME = await mkdtemp(path.join(tmpdir(), 'dsh-restart-routes-'))
process.env.DSH_RESTART_HOME = HOME
// A port nothing else on this machine uses: these tests must not depend on (or
// be disturbed by) whatever happens to be listening on the real fallback port.
const TEST_FALLBACK_PORT = 3999
await writeFile(path.join(HOME, 'config.json'), JSON.stringify({ fallbackPort: TEST_FALLBACK_PORT }))

const { apply, makeRoutes, RESTART_API, loadConfig, statusPath } = await import('../lib/index.js')

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

/** Minimal IncomingMessage stand-in (async-iterable so body reads work). */
function makeReq({ method = 'GET', url = '/', host = '127.0.0.1:3080', body = null, remote = '127.0.0.1', origin } = {}) {
  const chunks = body === null ? [] : [Buffer.from(JSON.stringify(body))]
  const headers = { host, 'sec-fetch-site': 'same-origin' }
  if (origin !== undefined) headers.origin = origin
  return {
    method,
    url,
    socket: { remoteAddress: remote },
    headers,
    async *[Symbol.asyncIterator]() {
      for (const chunk of chunks) yield chunk
    },
  }
}

/** Minimal ServerResponse stand-in. */
function makeRes() {
  const state = { status: 0, headers: null, body: '' }
  return {
    state,
    writeHead(status, headers) {
      state.status = status
      state.headers = headers
    },
    end(payload) {
      state.body = payload ?? ''
    },
  }
}

/** Call one route and return { status, json, text }. */
async function call(routes, path, reqOptions = {}) {
  const route = routes.find((entry) => entry.path === path)
  if (route === undefined) throw new Error('no route for ' + path)
  const res = makeRes()
  await route.handler(makeReq({ url: path, ...reqOptions }), res)
  let json = null
  try {
    json = JSON.parse(res.state.body)
  } catch {
    json = null
  }
  return { status: res.state.status, json, text: res.state.body, headers: res.state.headers }
}

const routes = makeRoutes({ port: 4321, host: '127.0.0.1', url: 'http://127.0.0.1:4321' })

console.log('route table')

check('every advertised endpoint is registered', routes.length === Object.keys(RESTART_API).length, String(routes.length))
check('route paths are exact', routes.every((route) => route.kind === 'exact'))

console.log('guards')

const foreign = await call(routes, RESTART_API.status, { remote: '10.0.0.5' })
check('a non-loopback caller is refused', foreign.status === 403, String(foreign.status))

const crossSite = await call(routes, RESTART_API.status, { origin: 'https://evil.example' })
check('a cross-site origin is refused', crossSite.status === 403, String(crossSite.status))

const sameOrigin = await call(routes, RESTART_API.probe, { origin: 'http://127.0.0.1:3080', host: '127.0.0.1:3080' })
check('a same-origin caller is allowed', sameOrigin.status === 200, String(sameOrigin.status))

const wrongMethod = await call(routes, RESTART_API.restart, { method: 'GET' })
check('GET /restart is refused (405)', wrongMethod.status === 405, String(wrongMethod.status))
check('...and never reaches the engine', !wrongMethod.text.includes('helperPid'), wrongMethod.text)

const badMethod = await call(routes, RESTART_API.probe, { method: 'POST' })
check('POST /probe is refused (405)', badMethod.status === 405, String(badMethod.status))

console.log('probe + status')

const probe = await call(routes, RESTART_API.probe)
check('probe reports this process', probe.json.pid === process.pid)
check('probe reports uptime', typeof probe.json.uptimeMs === 'number' && probe.json.uptimeMs >= 0)
check('probe responses are uncached', probe.headers['cache-control'] === 'no-store')

const status = await call(routes, RESTART_API.status)
check('status is ok', status.json.ok === true)
check('status describes the host', status.json.host.pid === process.pid)
check('status echoes the endpoint', status.json.host.port === 4321)
check('status exposes the console URL', status.json.consoleUrl === `http://127.0.0.1:${TEST_FALLBACK_PORT}`, status.json.consoleUrl)
check('status exposes the config', status.json.config.fallbackPort === TEST_FALLBACK_PORT)
check('status lists the endpoints', status.json.endpoints.restart === RESTART_API.restart)
check('status has no live helper', status.json.helperAlive === false)
check('status starts with empty history', Array.isArray(status.json.history) && status.json.history.length === 0)

console.log('auth url (stale-tab 401 recovery)')

const authRoute = await call(routes, RESTART_API.auth)
check('auth route answers without a cookie', authRoute.status === 200 && authRoute.json.ok === true)
check('auth route degrades to an empty URL with no provider', authRoute.json.authUrl === '', authRoute.json.authUrl)
check('auth route echoes the origin', authRoute.json.origin === 'http://127.0.0.1:4321', authRoute.json.origin)
check('auth route reports this process', authRoute.json.pid === process.pid)
check('status carries the (absent) auth URL', status.json.authUrl === '', String(status.json.authUrl))

// The provider must be read per request, never pinned at mount: `dsh web` mints
// a new launch token on every boot, so a URL cached at mount would itself go stale.
let liveToken = 'http://127.0.0.1:4321/?token=FIRST'
const authRoutes = makeRoutes({
  port: 4321,
  host: '127.0.0.1',
  url: 'http://127.0.0.1:4321',
  authUrl: () => liveToken,
})
const firstAuth = await call(authRoutes, RESTART_API.auth)
check('the current token URL is served', firstAuth.json.authUrl === liveToken, firstAuth.json.authUrl)
liveToken = 'http://127.0.0.1:4321/?token=SECOND'
const secondAuth = await call(authRoutes, RESTART_API.auth)
check('a changed token is reflected immediately (not cached)', secondAuth.json.authUrl === liveToken, secondAuth.json.authUrl)
const statusWithAuth = await call(authRoutes, RESTART_API.status)
check('status also carries the current token URL', statusWithAuth.json.authUrl === liveToken, statusWithAuth.json.authUrl)
check('the auth route is registered', RESTART_API.auth === '/api/dsh-restart/auth')

const authForeign = await call(authRoutes, RESTART_API.auth, { remote: '10.0.0.5' })
check('the auth route stays loopback-only', authForeign.status === 403, String(authForeign.status))
const authPost = await call(authRoutes, RESTART_API.auth, { method: 'POST' })
check('POST /auth is refused (405)', authPost.status === 405, String(authPost.status))

console.log('logs + history + helper')

const logs = await call(routes, RESTART_API.logs)
check('logs is ok even with no log files', logs.json.ok === true)
check('logs reports no file yet', logs.json.exists === false, String(logs.json.exists))
check('logs still returns the directory listing', Array.isArray(logs.json.logFiles))

const history = await call(routes, RESTART_API.history)
check('history is ok', history.json.ok === true && Array.isArray(history.json.history))

// Regression: a listener on the fallback port that *looks* like a helper but
// belongs to nobody here must not be reported as the live restart helper.
{
  const { createServer } = await import('node:http')
  const alien = createServer((request, response) => {
    response.writeHead(200, { 'content-type': 'application/json' })
    response.end(
      JSON.stringify({
        ok: true,
        helper: 'dsh-restart',
        phase: 'failed',
        oldPid: 12345,
        childPid: 12346,
        statusFile: '/tmp/somewhere-else/status.json',
        failure: { kind: 'exit', message: '来自另一个实例的失败' },
        fallbackPort: TEST_FALLBACK_PORT,
      }),
    )
  })
  await new Promise((resolve) => alien.listen(TEST_FALLBACK_PORT, '127.0.0.1', resolve))
  try {
    const contaminated = await call(routes, RESTART_API.status)
    check('a foreign helper on the fallback port is ignored', contaminated.json.helperAlive === false, JSON.stringify(contaminated.json.helper))
    check('...and its failure is not attributed to this host', contaminated.json.helper === null, JSON.stringify(contaminated.json.helper))
    const contaminatedHelper = await call(routes, RESTART_API.helper)
    check('the helper route ignores it too', contaminatedHelper.json.alive === false, JSON.stringify(contaminatedHelper.json.status))
  } finally {
    await new Promise((resolve) => alien.close(resolve))
  }
}

// Regression: the plugin home is shared by every DSH instance on the machine,
// so a *fresh* status.json with a *live* helper pid may describe a sibling
// instance's restart. Ownership (oldPid/childPid) decides, not freshness.
{
  await mkdir(HOME, { recursive: true })
  await writeFile(
    statusPath(),
    JSON.stringify({
      ok: true,
      helper: 'dsh-restart',
      helperPid: process.pid, // alive, so the freshness/liveness check passes
      phase: 'ready',
      oldPid: 999_001,
      childPid: 999_002,
      statusFile: statusPath(),
      fallbackPort: TEST_FALLBACK_PORT,
      startedAt: new Date().toISOString(),
    }),
  )
  const sibling = await call(routes, RESTART_API.status)
  check('a sibling instance\'s status.json is not claimed', sibling.json.helperAlive === false, JSON.stringify(sibling.json.helper))

  // ...while the same file naming THIS process is our own restart.
  await writeFile(
    statusPath(),
    JSON.stringify({
      ok: true,
      helper: 'dsh-restart',
      helperPid: process.pid,
      phase: 'waiting-ready',
      oldPid: process.pid,
      childPid: null,
      statusFile: statusPath(),
      fallbackPort: TEST_FALLBACK_PORT,
      startedAt: new Date().toISOString(),
    }),
  )
  const own = await call(routes, RESTART_API.status)
  check('...but our own restart in flight is claimed', own.json.helperAlive === true, JSON.stringify(own.json.helper))
  await rm(statusPath(), { force: true })
}

// ...and a helper that *is* ours (same status file, and about this process) is shown.
{
  const { createServer } = await import('node:http')
  const ours = createServer((request, response) => {
    response.writeHead(200, { 'content-type': 'application/json' })
    response.end(
      JSON.stringify({
        ok: true,
        helper: 'dsh-restart',
        phase: 'failed',
        attempt: 1,
        maxAttempts: 2,
        oldPid: process.pid,
        childPid: null,
        statusFile: statusPath(),
        failure: { kind: 'exit', message: '我们的失败' },
        fallbackPort: TEST_FALLBACK_PORT,
      }),
    )
  })
  await new Promise((resolve) => ours.listen(TEST_FALLBACK_PORT, '127.0.0.1', resolve))
  try {
    const attributed = await call(routes, RESTART_API.status)
    check('our own helper is reported', attributed.json.helperAlive === true, JSON.stringify(attributed.json.helper))
    check('...with its failure intact', attributed.json.helper?.failure?.message === '我们的失败')
  } finally {
    await new Promise((resolve) => ours.close(resolve))
  }
}

const helperRoute = await call(routes, RESTART_API.helper)
check('helper route is ok with nothing running', helperRoute.json.ok === true && helperRoute.json.alive === false)
check('helper route reports the console URL', helperRoute.json.consoleUrl === `http://127.0.0.1:${TEST_FALLBACK_PORT}`)

console.log('config')

const patched = await call(routes, RESTART_API.config, {
  method: 'POST',
  body: { bootTimeoutMs: 8_000, autoReload: false },
})
check('config patch succeeds', patched.status === 200 && patched.json.ok === true)
check('config patch applies', patched.json.config.bootTimeoutMs === 8_000)
check('config patch persists', (await loadConfig()).config.autoReload === false)

const clampedPatch = await call(routes, RESTART_API.config, { method: 'POST', body: { maxAttempts: 42 } })
check('config clamps out-of-range values', clampedPatch.json.config.maxAttempts === 5, String(clampedPatch.json.config.maxAttempts))

const badBody = await call(routes, RESTART_API.config, { method: 'POST', body: { x: 1 } })
check('unknown keys are ignored, not fatal', badBody.status === 200)

const reset = await call(routes, RESTART_API.config, { method: 'POST', body: { reset: true } })
check('config reset restores defaults', reset.json.config.bootTimeoutMs === 120_000, String(reset.json.config.bootTimeoutMs))

console.log('plugin wiring (connection → fresh token URL)')

// The route must read the Web Connection service lazily, so `apply` is driven
// with a fake context here — this is the only place the host half's wiring to
// the launch-token provider is exercised without restarting a real host.
{
  const registered = []
  const fakeCtx = (connection) => ({
    webServer: {
      port: 4321,
      register: (route) => {
        registered.push(route)
        return () => {}
      },
    },
    tools: { register: () => () => {} },
    systemPrompt: { section: () => () => {} },
    effect: (fn) => {
      fn()
      return () => {}
    },
    get: (serviceName) => (serviceName === 'connection' ? connection : undefined),
  })

  apply(fakeCtx({ authenticatedUrl: (base) => `${base}/?token=WIRED` }), { announceToAgent: false })
  const wiredAuth = await call(registered, RESTART_API.auth)
  check(
    'apply wires connection.authenticatedUrl into /auth',
    wiredAuth.json.authUrl === 'http://127.0.0.1:4321/?token=WIRED',
    wiredAuth.json.authUrl,
  )
  const wiredStatus = await call(registered, RESTART_API.status)
  check('the token URL is also on /status', wiredStatus.json.authUrl === 'http://127.0.0.1:4321/?token=WIRED')

  const fallbackRoutes = []
  const fallbackCtx = fakeCtx(undefined)
  fallbackCtx.webServer.register = (route) => {
    fallbackRoutes.push(route)
    return () => {}
  }
  apply(fallbackCtx, { announceToAgent: false })
  const fallbackAuth = await call(fallbackRoutes, RESTART_API.auth)
  check(
    'without a Connection service the plain origin is offered',
    fallbackAuth.json.authUrl === 'http://127.0.0.1:4321',
    fallbackAuth.json.authUrl,
  )
}

await rm(HOME, { recursive: true, force: true })

console.log(`\n${passed} passed, ${failed} failed`)
if (failed > 0) process.exit(1)
