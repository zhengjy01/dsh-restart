/**
 * dsh-restart helper tests.
 *
 * Drives the real detached helper (helper/restart-helper.mjs) against fake
 * hosts on free ports — nothing here touches the running DSH:
 *
 *   A. failing boot  → the helper must classify the crash, capture the stderr
 *      lines that explain it, serve them on the recovery console, and accept a
 *      manual retry;
 *   B. successful boot → the helper must wait for the port, relaunch, detect
 *      readiness, and report the boot time;
 *   C. boot that answers the port and then dies on a plugin → readiness must be
 *      withheld (or withdrawn) and the fatal boot line reported;
 *   D. boot that answers the port and dies silently → liveness alone must end
 *      the readiness claim;
 *   E. healthy boot that prints error-shaped noise → readiness must hold, so
 *      the fatal detection stays narrow.
 */

import { spawn } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HELPER = fileURLToPath(new URL('../helper/restart-helper.mjs', import.meta.url))

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

/** A free TCP port (bind 0, read it, release it). */
function freePort() {
  return new Promise((resolve, reject) => {
    const server = createServer()
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      const port = typeof address === 'object' && address !== null ? address.port : 0
      server.close(() => resolve(port))
    })
  })
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/** Poll a JSON endpoint until a predicate holds (or the budget runs out). */
async function pollJson(url, predicate, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs
  let last = null
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url, { cache: 'no-store' })
      if (response.ok) {
        last = await response.json()
        if (predicate(last)) return last
      }
    } catch {
      /* console not up yet */
    }
    await sleep(150)
  }
  throw new Error(`${label}: predicate never held; last=${JSON.stringify(last)?.slice(0, 400)}`)
}

/** Write a spec and start the helper detached. */
async function startHelper(dir, spec) {
  const specFile = path.join(dir, 'spec.json')
  await writeFile(specFile, JSON.stringify(spec, null, 2))
  const child = spawn(process.execPath, [HELPER, '--spec', specFile], { detached: true, stdio: 'ignore' })
  child.unref()
  return child.pid
}

const HOME = await mkdtemp(path.join(tmpdir(), 'dsh-restart-helper-'))
const spawned = []

console.log('A. failing boot')

{
  const target = await freePort()
  const fallback = await freePort()
  const logFile = path.join(HOME, 'failing.log')
  const statusFile = path.join(HOME, 'failing-status.json')
  const helperPid = await startHelper(HOME, {
    port: target,
    host: '127.0.0.1',
    url: `http://127.0.0.1:${target}`,
    file: process.execPath,
    args: [
      '-e',
      'console.log("booting"); console.error("Error: plugin dsh-broken failed to load"); process.exit(3)',
    ],
    cwd: HOME,
    env: { PATH: process.env.PATH },
    oldPid: 0,
    logFile,
    statusFile,
    fallbackPort: fallback,
    bootTimeoutMs: 10_000,
    maxAttempts: 1,
    killGraceMs: 1_000,
    portFreeTimeoutMs: 3_000,
    lingerMs: 30_000,
    ringLines: 300,
    dshVersion: 'test',
    profile: 'test',
  })
  spawned.push(helperPid)

  const status = await pollJson(
    `http://127.0.0.1:${fallback}/status`,
    (value) => value.phase === 'failed',
    25_000,
    'helper should reach phase=failed',
  )

  check('phase is failed', status.phase === 'failed')
  check('child exit code captured', status.childExit?.code === 3, JSON.stringify(status.childExit))
  check('failure explains the exit', String(status.failure?.message ?? '').includes('code=3'), status.failure?.message)
  check(
    'the crashing stderr line is captured',
    (status.errorLines ?? []).some((entry) => entry.text.includes('dsh-broken')),
    JSON.stringify(status.errorLines),
  )
  check(
    'the last 3 error lines are folded into the failure message',
    String(status.failure?.message ?? '').includes('dsh-broken'),
    status.failure?.message,
  )
  check('the boot output is in the tail', (status.tail ?? []).some((line) => line.includes('booting')))
  check('console port is reported', status.fallbackPort === fallback, String(status.fallbackPort))
  check('a log file was written', (await readFile(logFile, 'utf8')).includes('dsh-broken'))
  check('status.json mirrors the console', JSON.parse(await readFile(statusFile, 'utf8')).phase === 'failed')

  const page = await fetch(`http://127.0.0.1:${fallback}/`)
  const html = await page.text()
  check('the recovery console serves a page', page.ok && html.includes('重启控制台'))
  check('the console page is self-refreshing', html.includes("fetch('/status'"))
  check(
    'the console only jumps to DSH once the phase is ready',
    html.includes("s.phase === 'ready'") && html.includes('location.href = dshUrl'),
  )

  const cors = await fetch(`http://127.0.0.1:${fallback}/status`)
  check('the console is CORS-open for the panel', cors.headers.get('access-control-allow-origin') === '*')

  const logText = await (await fetch(`http://127.0.0.1:${fallback}/log?lines=10`)).text()
  check('the console serves the raw log', logText.includes('dsh-broken'))

  // The copy-ready failure report: one document, everything needed to diagnose.
  const reportPath = statusFile.replace(/status\.json$/, 'last-failure.md')
  const report = await readFile(reportPath, 'utf8')
  check('a failure report file is written', report.startsWith('# DSH 重启失败报告'))
  check('the report names the failing command', report.includes('process.exit(3)'))
  check('the report carries the exit code', report.includes('退出码：3'), report.slice(0, 400))
  check('the report carries the failure reason', report.includes('code=3'))
  check('the report carries the crashing line', report.includes('dsh-broken'))
  check('the report points at the full log', report.includes(logFile))
  const served = await (await fetch(`http://127.0.0.1:${fallback}/report`)).text()
  check('the console serves the same report', served.includes('dsh-broken') && served.includes('重启失败报告'))
  check('the report is not written for a successful boot', !(await readFile(path.join(HOME, 'success-status.json').replace(/status\.json$/, 'last-failure.md'), 'utf8').catch(() => '')).includes('重启失败报告'))

  // Manual retry: the helper must leave `failed` and try again.
  const retry = await fetch(`http://127.0.0.1:${fallback}/retry`, { method: 'POST' })
  check('retry endpoint accepts the request', retry.ok)
  const retried = await pollJson(
    `http://127.0.0.1:${fallback}/status`,
    (value) => value.phase !== 'failed',
    15_000,
    'helper should retry after POST /retry',
  )
  check('helper relaunches on demand', retried.phase === 'retrying' || retried.phase === 'waiting-ready', retried.phase)
}

console.log('B. successful boot')

{
  const target = await freePort()
  const fallback = await freePort()
  const logFile = path.join(HOME, 'success.log')
  const statusFile = path.join(HOME, 'success-status.json')
  const serverCode =
    `require('node:http').createServer((q,s)=>{s.end('ok')}).listen(${target},'127.0.0.1',()=>console.log('fake host up'))`
  const helperPid = await startHelper(HOME, {
    port: target,
    host: '127.0.0.1',
    url: `http://127.0.0.1:${target}`,
    file: process.execPath,
    args: ['-e', serverCode],
    cwd: HOME,
    env: { PATH: process.env.PATH },
    oldPid: 0,
    logFile,
    statusFile,
    fallbackPort: fallback,
    bootTimeoutMs: 20_000,
    maxAttempts: 1,
    killGraceMs: 1_000,
    portFreeTimeoutMs: 3_000,
    lingerMs: 30_000,
    readyConfirmMs: 400,
    bootWatchMs: 1_200,
    ringLines: 300,
    dshVersion: 'test',
    profile: 'test',
  })
  spawned.push(helperPid)

  const status = await pollJson(
    `http://127.0.0.1:${fallback}/status`,
    (value) => value.phase === 'ready',
    25_000,
    'helper should reach phase=ready',
  )
  check('phase is ready', status.phase === 'ready')
  check('boot time is measured', typeof status.bootMs === 'number' && status.bootMs >= 0, String(status.bootMs))
  check('the relaunched pid is reported', Number.isInteger(status.childPid) && status.childPid > 0)
  check('no failure recorded', status.failure === null || status.failure === undefined)
  check('the new host really answers', (await fetch(`http://127.0.0.1:${target}/`)).ok)
  check('the child output is logged', (await readFile(logFile, 'utf8')).includes('fake host up'))

  // Track the relaunched host so it can be cleaned up.
  spawned.push(status.childPid)
}

console.log('C. boot that answers the port and then dies on a plugin')

{
  // The real incident: `dsh web` binds 3080 before the plugin tree loads, so a
  // boot that dies on a plugin answers the port for seconds first. Reporting
  // `ready` on the port alone is what turned a dead host into a "successful"
  // restart.
  const target = await freePort()
  const fallback = await freePort()
  const statusFile = path.join(HOME, 'late-fatal-status.json')
  const serverCode = [
    "require('node:http').createServer((q,s)=>{s.end('ok')}).listen(" + target + ",'127.0.0.1',()=>{",
    "  setTimeout(()=>{",
    "    console.error('Error: dsh: plugin tree failed to load: failed to apply loader entry connection');",
    '    process.exit(1)',
    '  }, 700)',
    '})',
  ].join('\n')
  const helperPid = await startHelper(HOME, {
    port: target,
    host: '127.0.0.1',
    url: `http://127.0.0.1:${target}`,
    file: process.execPath,
    args: ['-e', serverCode],
    cwd: HOME,
    env: { PATH: process.env.PATH },
    oldPid: 0,
    logFile: path.join(HOME, 'late-fatal.log'),
    statusFile,
    fallbackPort: fallback,
    bootTimeoutMs: 20_000,
    maxAttempts: 1,
    killGraceMs: 1_000,
    portFreeTimeoutMs: 3_000,
    lingerMs: 30_000,
    readyConfirmMs: 200,
    bootWatchMs: 6_000,
    ringLines: 300,
    dshVersion: 'test',
    profile: 'test',
  })
  spawned.push(helperPid)

  const status = await pollJson(
    `http://127.0.0.1:${fallback}/status`,
    (value) => value.phase === 'failed',
    25_000,
    'a boot that dies on a plugin must end up failed',
  )

  check('a late boot death is not reported as ready', status.phase === 'failed', status.phase)
  check('the stale ready claim is withdrawn', status.readyAt === null, String(status.readyAt))
  check('the exit code is captured', status.childExit?.code === 1, JSON.stringify(status.childExit))
  check(
    'the failure names the fatal boot line',
    String(status.failure?.message ?? '').includes('plugin tree failed to load'),
    status.failure?.message,
  )
  check(
    'the failure report is written for a late death',
    (await readFile(statusFile.replace(/status\.json$/, 'last-failure.md'), 'utf8')).includes('重启失败报告'),
  )
}

console.log('D. boot that answers the port and then dies silently')

{
  // No error text at all: liveness has to be the signal, not the log.
  const target = await freePort()
  const fallback = await freePort()
  const serverCode = [
    "require('node:http').createServer((q,s)=>{s.end('ok')}).listen(" + target + ",'127.0.0.1',()=>{",
    '  setTimeout(()=>process.exit(7), 700)',
    '})',
  ].join('\n')
  const helperPid = await startHelper(HOME, {
    port: target,
    host: '127.0.0.1',
    url: `http://127.0.0.1:${target}`,
    file: process.execPath,
    args: ['-e', serverCode],
    cwd: HOME,
    env: { PATH: process.env.PATH },
    oldPid: 0,
    logFile: path.join(HOME, 'late-silent.log'),
    statusFile: path.join(HOME, 'late-silent-status.json'),
    fallbackPort: fallback,
    bootTimeoutMs: 20_000,
    maxAttempts: 1,
    killGraceMs: 1_000,
    portFreeTimeoutMs: 3_000,
    lingerMs: 30_000,
    readyConfirmMs: 200,
    bootWatchMs: 6_000,
    ringLines: 300,
    dshVersion: 'test',
    profile: 'test',
  })
  spawned.push(helperPid)

  const status = await pollJson(
    `http://127.0.0.1:${fallback}/status`,
    (value) => value.phase === 'failed',
    25_000,
    'a silent death must end up failed',
  )

  check('a silent late death is not reported as ready', status.phase === 'failed', status.phase)
  check('the exit code is captured without any error line', status.childExit?.code === 7, JSON.stringify(status.childExit))
  check('the readiness claim is withdrawn', status.readyAt === null, String(status.readyAt))
}

console.log('E. a healthy boot that prints error-shaped noise stays ready')

{
  // `dsh web` really does print lines like this on a healthy boot. Fatal
  // detection has to stay narrow enough to ignore them.
  const target = await freePort()
  const fallback = await freePort()
  const serverCode = [
    "require('node:http').createServer((q,s)=>{s.end('ok')}).listen(" + target + ",'127.0.0.1',()=>{",
    "  console.error('[dsh-task-board] session/list failed; treating the roster as unknown')",
    "  console.error('Error: ECONNREFUSED while probing an optional provider')",
    "  console.log('fake host up')",
    '})',
  ].join('\n')
  const helperPid = await startHelper(HOME, {
    port: target,
    host: '127.0.0.1',
    url: `http://127.0.0.1:${target}`,
    file: process.execPath,
    args: ['-e', serverCode],
    cwd: HOME,
    env: { PATH: process.env.PATH },
    oldPid: 0,
    logFile: path.join(HOME, 'noisy.log'),
    statusFile: path.join(HOME, 'noisy-status.json'),
    fallbackPort: fallback,
    bootTimeoutMs: 20_000,
    maxAttempts: 1,
    killGraceMs: 1_000,
    portFreeTimeoutMs: 3_000,
    lingerMs: 30_000,
    readyConfirmMs: 300,
    bootWatchMs: 2_500,
    ringLines: 300,
    dshVersion: 'test',
    profile: 'test',
  })
  spawned.push(helperPid)

  await pollJson(
    `http://127.0.0.1:${fallback}/status`,
    (value) => value.phase === 'ready',
    25_000,
    'a noisy but healthy boot must reach ready',
  )
  // Sit past the watch window: readiness must not be withdrawn afterwards.
  await sleep(3_000)
  const status = await (await fetch(`http://127.0.0.1:${fallback}/status`)).json()

  check('error-shaped noise does not fail a healthy boot', status.phase === 'ready', status.phase)
  check('the readiness claim survives the watch window', status.readyAt !== null, String(status.readyAt))
  check('no failure was recorded', status.failure === null || status.failure === undefined, JSON.stringify(status.failure))
}

await sleep(200)
for (const pid of spawned) {
  if (typeof pid !== 'number' || pid <= 0) continue
  try {
    process.kill(pid, 'SIGKILL')
  } catch {
    /* already gone */
  }
}
await rm(HOME, { recursive: true, force: true })

console.log(`\n${passed} passed, ${failed} failed`)
if (failed > 0) process.exit(1)
