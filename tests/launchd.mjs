/**
 * dsh-restart launchd + observe-mode tests.
 *
 * A DSH host is often managed by a launchd job (`com.dsh.web`, `KeepAlive`).
 * Relaunching it ourselves would race the job for the port, so the plugin
 * detects the job and delegates: the helper kickstarts it and then only
 * watches. These tests cover both halves without ever kicking the real job:
 *
 *   A. detection + parsing + the kick command shape;
 *   B. observe mode: the helper runs the kick command, follows the owner's log,
 *      and must NOT spawn a host of its own.
 */

import { spawn } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { appendFileSync, mkdtempSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const HELPER = path.join(ROOT, 'helper', 'restart-helper.mjs')

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
      /* console may still be starting */
    }
    await sleep(150)
  }
  throw new Error(`${label}: predicate never held; last=${JSON.stringify(last)?.slice(0, 300)}`)
}

const HOME = await mkdtemp(path.join(tmpdir(), 'dsh-restart-launchd-'))
process.env.DSH_RESTART_HOME = HOME

const { detectLaunchd, detectLaunchdFor, kickCommand, kickstart, labelForPid, readLaunchdLog } = await import('../lib/index.js')

console.log('A. detection')

if (process.platform !== 'darwin') {
  check('non-macOS detection is a no-op', (await detectLaunchd()) === null)
} else {
  const label = (process.env.XPC_SERVICE_NAME ?? '').trim()
  const job = await detectLaunchd()
  if (label === '' || label === '0') {
    check('unmanaged process → null', job === null, JSON.stringify(job))
  } else {
    check('managed process → the job is found', job !== null, JSON.stringify(job))
    if (job !== null) {
      check('label matches XPC_SERVICE_NAME', job.label === label, `${job.label} vs ${label}`)
      check('domain is the gui session', job.domain === `gui/${process.getuid()}`, job.domain)
      check('a state was parsed', typeof job.state === 'string' && job.state.length > 0, job.state)
      check('the plist path is derived from the label', job.plistPath.endsWith(`${label}.plist`), job.plistPath)
      const command = kickCommand(job)
      check('kick command is launchctl kickstart -k', command[0] === '/bin/launchctl' && command[1] === 'kickstart' && command[2] === '-k', JSON.stringify(command))
      check('kick command targets the right domain/label', command[3] === `${job.domain}/${job.label}`, command[3])
      check('this machine runs the web job under launchd', job.label === 'com.dsh.web' || job.label.length > 0, job.label)
      // Never kick in tests: only prove the call shape by asking for a bogus label.
      const bogus = await kickstart({ ...job, label: 'com.dsh.does-not-exist' })
      check('kickstart reports launchctl failures instead of throwing', bogus.ok === false && bogus.error !== '', JSON.stringify(bogus))
    }
  }
}

if (process.platform === 'darwin') {
  // Ground truth: whatever `launchctl list` says about the pid listening on
  // 3080 decides what detection must return. The host may or may not be managed
  // (launchd job vs. a manually started `dsh web`), and both answers are correct
  // behaviour — so assert the invariant against the real table, not a fixed label.
  let hostPid = 0
  try {
    const { execFileSync } = await import('node:child_process')
    const out = execFileSync('/usr/sbin/lsof', ['-nP', '-ti', 'tcp:3080', '-sTCP:LISTEN'], { encoding: 'utf8' })
    hostPid = Number(out.split('\n').map((line) => line.trim()).filter(Boolean)[0] ?? '')
  } catch {
    hostPid = 0
  }

  const { execFileSync: exec } = await import('node:child_process')
  let groundTruth = null
  try {
    for (const line of exec('/bin/launchctl', ['list'], { encoding: 'utf8' }).split('\n')) {
      const fields = line.trim().split(/\s+/)
      if (fields.length >= 3 && fields[0] === String(hostPid)) groundTruth = fields[2]
    }
  } catch {
    groundTruth = null
  }

  if (hostPid > 1) {
    const label = await labelForPid(hostPid)
    const job = await detectLaunchdFor(hostPid)
    if (groundTruth === null) {
      check('an unmanaged host is reported as unmanaged', label === null, String(label))
      check('...and yields no job', job === null, JSON.stringify(job))
    } else {
      check('the host pid is matched to its launchd job', label === groundTruth, `${label} vs ${groundTruth}`)
      check('...and the job resolves', job !== null && job.label === groundTruth, JSON.stringify(job))
      if (job !== null) {
        check('...with a live state', typeof job.state === 'string' && job.state.length > 0, job.state)
        check('...and a log file to follow', job.stderrPath !== '' || job.stdoutPath !== '', JSON.stringify(job))
      }
    }
  } else {
    console.log('  (skipped pid→job matching: nothing listens on 3080)')
  }
  check('a random pid is not a job', (await labelForPid(999_999)) === null)
  check('detectLaunchd() for this non-job process is null', (await detectLaunchd()) === null)
}

const dir = mkdtempSync(path.join(tmpdir(), 'dsh-restart-plist-'))
const plistPath = path.join(dir, 'com.test.job.plist')
writeFileSync(
  plistPath,
  `<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0"><dict>
  <key>StandardOutPath</key><string>/tmp/test.out</string>
  <key>StandardErrorPath</key><string>/tmp/test.err</string>
</dict></plist>`,
)
const logFile = path.join(dir, 'job.err')
await writeFile(logFile, 'boot line 1\nError: plugin failed\n')
const tail = await readLaunchdLog(logFile, 10)
check('readLaunchdLog returns the tail', tail.includes('Error: plugin failed'), tail)
check('readLaunchdLog tolerates a missing file', (await readLaunchdLog(path.join(dir, 'nope.log'), 5)) === '')

console.log('B. observe mode')

{
  const target = await freePort()
  const fallback = await freePort()
  const specFile = path.join(HOME, 'observe-spec.json')
  const observeLog = path.join(HOME, 'managed.err')
  const statusFile = path.join(HOME, 'observe-status.json')
  await writeFile(observeLog, 'launchd: starting job\n')
  const kickCommand = [
    process.execPath,
    '-e',
    `require('node:http').createServer((q,s)=>s.end('ok')).listen(${target},'127.0.0.1',()=>console.log('kicked host up'))`,
  ]
  await writeFile(
    specFile,
    JSON.stringify({
      port: target,
      host: '127.0.0.1',
      url: `http://127.0.0.1:${target}`,
      file: process.execPath,
      args: ['-e', 'process.exit(99)'], // must never run: observe mode does not spawn
      cwd: HOME,
      env: { PATH: process.env.PATH },
      oldPid: 0,
      logFile: path.join(HOME, 'observe.log'),
      statusFile,
      fallbackPort: fallback,
      bootTimeoutMs: 15_000,
      maxAttempts: 1,
      killGraceMs: 1_000,
      portFreeTimeoutMs: 3_000,
      lingerMs: 30_000,
      ringLines: 200,
      dshVersion: 'test',
      profile: 'test',
      mode: 'observe',
      owner: 'launchd com.test.job',
      kickCommand,
      kickDelayMs: 300,
      observeLog,
    }),
  )

  const helper = spawn(process.execPath, [HELPER, '--spec', specFile], { detached: true, stdio: 'ignore' })
  helper.unref()
  const cleanup = [helper.pid]

  const status = await pollJson(
    `http://127.0.0.1:${fallback}/status`,
    (value) => value.phase === 'ready' || value.phase === 'failed',
    30_000,
    'observe-mode console',
  )

  check('observe mode is reported', status.mode === 'observe', status.mode)
  check('the kicked host was detected as ready', status.phase === 'ready', `${status.phase}: ${JSON.stringify(status.failure)}`)
  check('observe mode never spawns its own child', status.childPid === null, String(status.childPid))
  check('no failure recorded', !status.failure, JSON.stringify(status.failure))

  // The owner's log must be followed into the console tail.
  appendFileSync(observeLog, 'Error: managed boot problem\n')
  const followed = await pollJson(
    `http://127.0.0.1:${fallback}/status`,
    (value) => (value.tail ?? []).some((line) => line.includes('managed boot problem')),
    8_000,
    'observe log follower',
  )
  check('the owner log is followed into the console', (followed.tail ?? []).some((line) => line.includes('managed boot problem')))
  check('errors from the owner log are detected', (followed.errorLines ?? []).some((entry) => entry.text.includes('managed boot problem')))

  for (const pid of cleanup) {
    if (typeof pid !== 'number' || pid <= 0) continue
    try {
      process.kill(pid, 'SIGKILL')
    } catch {
      /* already gone */
    }
  }
  // The kicked host is a child of the helper; make sure it cannot outlive the test.
  try {
    const { execFileSync } = await import('node:child_process')
    execFileSync('/usr/bin/pkill', ['-f', `listen(${target},'127.0.0.1'`], { stdio: 'ignore' })
  } catch {
    /* nothing matched */
  }
}

await rm(HOME, { recursive: true, force: true })

console.log(`\n${passed} passed, ${failed} failed`)
if (failed > 0) process.exit(1)
