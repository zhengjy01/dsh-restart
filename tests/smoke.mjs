/**
 * dsh-restart smoke tests.
 *
 * Config store round-trip and clamping, history ordering, log tailing with
 * error detection, the launch signature, and host identity. Everything runs
 * against a temp DSH_RESTART_HOME, so the real ~/.dsh/dsh-restart is untouched.
 */

import { mkdtemp, readFile, rm, stat, writeFile, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

const HOME = await mkdtemp(path.join(tmpdir(), 'dsh-restart-smoke-'))
process.env.DSH_RESTART_HOME = HOME

const {
  DEFAULT_CONFIG,
  appendHistory,
  configPath,
  helperPath,
  loadConfig,
  loadConfigSync,
  logsDir,
  normalizeConfig,
  readHistory,
  restartHome,
  saveConfig,
  seedConfigSync,
  specPath,
  statusPath,
} = await import('../lib/index.js')
const { buildSpec, hostInfo, isAlive, launchSignature, newestLogFile, tailFile } = await import('../lib/index.js')

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

console.log('config store')

check('restartHome honours DSH_RESTART_HOME', restartHome() === HOME, restartHome())

{
  // Portability: a launcher may relocate DSH's whole home ($DSH_HOME); writing
  // to ~/.dsh regardless would create a second, wrong home.
  const savedOverride = process.env.DSH_RESTART_HOME
  const savedHome = process.env.DSH_HOME
  delete process.env.DSH_RESTART_HOME
  process.env.DSH_HOME = path.join(HOME, 'relocated')
  const relocated = restartHome()
  check('restartHome honours DSH_HOME', relocated === path.join(HOME, 'relocated', 'dsh-restart'), relocated)
  check('config/status follow the relocated home', configPath().startsWith(relocated) && statusPath().startsWith(relocated))
  process.env.DSH_RESTART_HOME = savedOverride
  if (savedHome === undefined) delete process.env.DSH_HOME
  else process.env.DSH_HOME = savedHome
  check('DSH_RESTART_HOME still wins over DSH_HOME', restartHome() === HOME, restartHome())
}
check('configPath lives under the home', configPath().startsWith(HOME), configPath())
check('spec/status paths are stable', specPath().endsWith('pending-spec.json') && statusPath().endsWith('status.json'))

const fresh = loadConfigSync()
check('missing config → defaults', fresh.exists === false && fresh.config.fallbackPort === DEFAULT_CONFIG.fallbackPort)

check('seedConfigSync creates the file', seedConfigSync({ bootTimeoutMs: 5_000 }) === true)
check('seedConfigSync is idempotent', seedConfigSync({ bootTimeoutMs: 9_999 }) === false)

const seeded = await loadConfig()
check('seeded value wins', seeded.config.bootTimeoutMs === 5_000, String(seeded.config.bootTimeoutMs))
check('unspecified fields keep defaults', seeded.config.maxAttempts === DEFAULT_CONFIG.maxAttempts)
check('config file is 0600', ((await stat(configPath())).mode & 0o777) === 0o600)

const clamped = await saveConfig({ maxAttempts: 99, fallbackPort: 0, entry: 'nope' })
check('maxAttempts clamps to 5', clamped.maxAttempts === 5, String(clamped.maxAttempts))
check('fallbackPort clamps to >= 1', clamped.fallbackPort === 1, String(clamped.fallbackPort))
check('unknown entry falls back to sidebar', clamped.entry === 'sidebar', String(clamped.entry))
check('normalizeConfig keeps booleans', normalizeConfig({ autoReload: false }).autoReload === false)

// The readiness windows: `dsh web` binds its port before the plugin tree loads,
// so how long a boot has to hold is a real setting, not a constant in the
// helper. Both ends clamp because 0 disables the window on purpose.
check('readiness windows default', DEFAULT_CONFIG.readyConfirmMs === 4_000 && DEFAULT_CONFIG.bootWatchMs === 30_000)
check('readiness windows clamp at 0', normalizeConfig({ readyConfirmMs: -5, bootWatchMs: -5 }).readyConfirmMs === 0)
check(
  'readiness windows clamp at the ceiling',
  normalizeConfig({ bootWatchMs: 10 ** 9 }).bootWatchMs === 600_000,
  String(normalizeConfig({ bootWatchMs: 10 ** 9 }).bootWatchMs),
)
const spec = await buildSpec({
  config: normalizeConfig({ readyConfirmMs: 1_234, bootWatchMs: 5_678 }),
  port: 3080,
  host: '127.0.0.1',
  url: 'http://127.0.0.1:3080',
})
check('the helper spec carries both readiness windows', spec.readyConfirmMs === 1_234 && spec.bootWatchMs === 5_678, JSON.stringify({ r: spec.readyConfirmMs, b: spec.bootWatchMs }))

console.log('history')

const record = (at, helperPid) => ({
  at,
  source: 'test',
  reason: 'smoke',
  oldPid: 1,
  helperPid,
  port: 3080,
  logFile: '/tmp/x.log',
  statusFile: '/tmp/status.json',
  outcome: 'pending',
})
await appendHistory(record('2026-01-01T00:00:00.000Z', 11), 2)
await appendHistory(record('2026-01-02T00:00:00.000Z', 22), 2)
await appendHistory(record('2026-01-03T00:00:00.000Z', 33), 2)
const history = await readHistory(10)
check('history is bounded by the limit', history.length === 2, String(history.length))
check('history is newest-first', history[0].helperPid === 33 && history[1].helperPid === 22)

console.log('logs')

await mkdir(logsDir(), { recursive: true })
const older = path.join(logsDir(), '20260101-000000-1.log')
const newer = path.join(logsDir(), '20260102-000000-2.log')
await writeFile(older, 'boot ok\n')
await new Promise((resolve) => setTimeout(resolve, 20))
await writeFile(
  newer,
  ['booting', 'Error: plugin dsh-broken failed to load', 'EADDRINUSE: address already in use', 'at Object.<anonymous> (/x/y.js:12:5)', 'done'].join('\n'),
)

const tail = await tailFile(newer, 3)
check('tailFile returns the requested window', tail.lines.length === 3, String(tail.lines.length))
check('tailFile marks existence', tail.exists === true)
check('tailFile detects Error lines', tail.errorLines.some((line) => line.includes('plugin dsh-broken')), JSON.stringify(tail.errorLines))
check('tailFile detects EADDRINUSE', tail.errorLines.some((line) => line.includes('EADDRINUSE')))
check('tailFile detects stack frames', tail.errorLines.some((line) => /at .+:\d+:\d+/.test(line)))

check('tailFile tolerates a missing file', (await tailFile(path.join(HOME, 'nope.log'), 5)).exists === false)
check('newestLogFile picks the latest', (await newestLogFile()) === newer, await newestLogFile())

{
  const noisy = path.join(logsDir(), '20260103-000000-3.log')
  await writeFile(
    noisy,
    ['[dsh-restart] restart requested at 2026-09-12T02:08:18.089Z', 'boot ok', 'listening on 3080'].join('\n'),
  )
  const noise = await tailFile(noisy, 10)
  check('timestamps are not mistaken for stack frames', noise.errorLines.length === 0, JSON.stringify(noise.errorLines))
}

console.log('host identity')

const signature = launchSignature()
check('launch signature uses the current node', signature.file === process.argv[0], signature.file)
check('launch signature replays this script', signature.args.includes(process.argv[1]), JSON.stringify(signature.args))
check('isAlive(self)', isAlive(process.pid) === true)
check('isAlive(bogus pid)', isAlive(999_999) === false)

const helper = helperPath()
check('helper ships with the plugin', helper.endsWith(path.join('helper', 'restart-helper.mjs')), helper)
check('helper file is readable and non-trivial', (await stat(helper)).size > 5_000, String((await stat(helper)).size))

const info = await hostInfo({ port: 4321, host: '127.0.0.1', url: 'http://127.0.0.1:4321' })
check('hostInfo reports this pid', info.pid === process.pid)
check('hostInfo echoes the endpoint', info.port === 4321 && info.url === 'http://127.0.0.1:4321')
check('hostInfo finds the helper', info.helperExists === true, info.helperFile)
check('hostInfo includes node version', info.nodeVersion === process.version)
check('hostInfo is not flagged as restarted', info.restarted === false)
check('hostInfo lists the logs dir', info.logsDir === logsDir())

console.log('helper guards')

const helperSource = await readFile(helper, 'utf8')
check('helper is dependency-free ESM', helperSource.includes("from 'node:child_process'") && helperSource.includes("from 'node:http'"))
check('helper serves a recovery console', helperSource.includes('/status') && helperSource.includes('Access-Control-Allow-Origin'))
check('helper never spawns a shell', helperSource.includes('spawn(file, argv') && !helperSource.includes('shell: true'))

await rm(HOME, { recursive: true, force: true })

console.log(`\n${passed} passed, ${failed} failed`)
if (failed > 0) process.exit(1)
