/**
 * dsh-restart handoff test — the whole feature, end to end, on fake ports.
 *
 * Nothing here touches the running DSH: a stand-in host (tests/fixtures/
 * fake-host.mjs) mounts the real route table, and the real detached helper
 * relaunches that same stand-in. Steps:
 *
 *   1. start generation 1 on a free port, with a temp DSH_RESTART_HOME
 *   2. POST /api/dsh-restart/restart → expect 202 with the console URL
 *   3. generation 1 must really exit (SIGTERM from the plugin)
 *   4. the helper must relaunch it and report phase=ready
 *   5. the port must answer again, with a NEW pid and restarted=true
 *   6. the restart must be recorded in history.json
 */

import { spawn } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const FAKE_HOST = path.join(ROOT, 'tests', 'fixtures', 'fake-host.mjs')

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

function freePort() {
  return new Promise((resolve, reject) => {
    const server = createServer()
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      server.close(() => resolve(typeof address === 'object' && address !== null ? address.port : 0))
    })
  })
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/** Poll an HTTP endpoint until it answers (returns the JSON body). */
async function pollOk(url, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs
  let lastError = 'no attempt'
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url, { cache: 'no-store' })
      if (response.ok) return await response.json()
      lastError = 'HTTP ' + response.status
    } catch (error) {
      lastError = String(error?.message ?? error)
    }
    await sleep(150)
  }
  throw new Error(`${label}: never answered (${lastError})`)
}

/** Poll the helper console until a predicate holds. */
async function pollConsole(url, predicate, timeoutMs, label) {
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
      /* console may still be starting */
    }
    await sleep(150)
  }
  throw new Error(`${label}: predicate never held; last=${JSON.stringify(last)?.slice(0, 400)}`)
}

const HOME = await mkdtemp(path.join(tmpdir(), 'dsh-restart-handoff-'))
const cleanup = []

try {
  const port = await freePort()
  const fallbackPort = await freePort()

  await writeFile(
    path.join(HOME, 'config.json'),
    JSON.stringify(
      {
        fallbackPort,
        bootTimeoutMs: 20_000,
        maxAttempts: 1,
        killGraceMs: 3_000,
        portFreeTimeoutMs: 6_000,
        lingerMs: 60_000,
        probeIntervalMs: 300,
      },
      null,
      2,
    ),
  )

  const env = { ...process.env, DSH_RESTART_HOME: HOME }
  delete env.DSH_RESTART_HELPER_PID

  console.log('1. generation 1 boots')

  const host = spawn(process.execPath, [FAKE_HOST, String(port)], { env, stdio: ['ignore', 'pipe', 'pipe'] })
  cleanup.push(host.pid)
  const firstLog = []
  host.stdout?.on('data', (chunk) => firstLog.push(String(chunk)))
  host.stderr?.on('data', (chunk) => firstLog.push(String(chunk)))

  const before = await pollOk(`http://127.0.0.1:${port}/api/dsh-restart/probe`, 15_000, 'generation 1')
  check('generation 1 serves the probe route', before.ok === true)
  check('generation 1 is not flagged as restarted', before.pid === host.pid, `${before.pid} vs ${host.pid}`)

  const status = await pollOk(`http://127.0.0.1:${port}/api/dsh-restart/status`, 5_000, 'status route')
  check('status reports the host', status.host.pid === host.pid)
  check('status reports the configured console port', status.consoleUrl.endsWith(String(fallbackPort)), status.consoleUrl)
  check('status starts with an empty history', Array.isArray(status.history) && status.history.length === 0)

  console.log('2. restart is requested')

  const response = await fetch(`http://127.0.0.1:${port}/api/dsh-restart/restart`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ reason: 'handoff test', source: 'test' }),
  })
  const ack = await response.json()
  check('restart is accepted with 202', response.status === 202, String(response.status))
  check('the helper pid is returned', Number.isInteger(ack.helperPid) && ack.helperPid > 0, JSON.stringify(ack))
  check('the console URL points at the fallback port', ack.fallbackUrl.endsWith(String(fallbackPort)), ack.fallbackUrl)
  check('a log file is reserved', typeof ack.logFile === 'string' && ack.logFile.endsWith('.log'), ack.logFile)
  cleanup.push(ack.helperPid)

  console.log('3. generation 1 exits')

  const exitCode = await new Promise((resolve) => {
    const timer = setTimeout(() => resolve('timeout'), 15_000)
    host.once('exit', (code, signal) => {
      clearTimeout(timer)
      resolve({ code, signal })
    })
  })
  check('generation 1 exited', exitCode !== 'timeout', JSON.stringify(exitCode))
  check('generation 1 logged the shutdown', firstLog.join('').includes('SIGTERM'), firstLog.join('').slice(0, 200))

  console.log('4. the helper relaunches it')

  const consoleStatus = await pollConsole(
    `http://127.0.0.1:${fallbackPort}/status`,
    (value) => value.phase === 'ready',
    40_000,
    'helper console',
  )
  check('the helper reached phase=ready', consoleStatus.phase === 'ready', consoleStatus.phase)
  check('the helper measured the boot', typeof consoleStatus.bootMs === 'number', String(consoleStatus.bootMs))
  check('the helper reports the original pid as oldPid', consoleStatus.oldPid === host.pid, String(consoleStatus.oldPid))
  check(
    'the relaunched process has a new pid',
    Number.isInteger(consoleStatus.childPid) && consoleStatus.childPid !== host.pid,
    `${consoleStatus.childPid} vs ${host.pid}`,
  )
  check('no failure was recorded', !consoleStatus.failure, JSON.stringify(consoleStatus.failure))
  cleanup.push(consoleStatus.childPid)

  console.log('5. the port answers again')

  const after = await pollOk(`http://127.0.0.1:${port}/api/dsh-restart/probe`, 15_000, 'generation 2')
  check('the reconnected probe succeeds', after.ok === true)
  check('the new host has a different pid', after.pid === consoleStatus.childPid, `${after.pid} vs ${consoleStatus.childPid}`)

  const status2 = await pollOk(`http://127.0.0.1:${port}/api/dsh-restart/status`, 5_000, 'status route (gen 2)')
  check('the new host knows it was restarted', status2.host.restarted === true)
  check('the new host still reads the same config', status2.config.fallbackPort === fallbackPort)

  console.log('6. the restart is recorded')

  const history = JSON.parse(await readFile(path.join(HOME, 'history.json'), 'utf8'))
  check('history has exactly one record', Array.isArray(history) && history.length === 1, String(history.length))
  check('the record keeps the reason', history[0].reason === 'handoff test', history[0].reason)
  check('the record keeps the source', history[0].source === 'test', history[0].source)
  check('the record keeps the old pid', history[0].oldPid === host.pid)
  check('the record names the helper', history[0].helperPid === ack.helperPid)

  const bootLog = await readFile(ack.logFile, 'utf8')
  check('the relaunch logs the new generation', bootLog.includes('[fake-host] listening'), bootLog.slice(0, 200))
} finally {
  for (const pid of cleanup.reverse()) {
    if (typeof pid !== 'number' || pid <= 0) continue
    try {
      process.kill(pid, 'SIGKILL')
    } catch {
      /* already gone */
    }
  }
  await rm(HOME, { recursive: true, force: true })
}

console.log(`\n${passed} passed, ${failed} failed`)
if (failed > 0) process.exit(1)
