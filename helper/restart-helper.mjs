#!/usr/bin/env node
/**
 * dsh-restart — detached restart helper.
 *
 * Spawned detached by the host plugin the moment a restart is requested. It
 * outlives the DSH process, so it can:
 *
 *   1. wait for the old host to release its listening port,
 *   2. relaunch the exact same `dsh` invocation (same argv / cwd / env),
 *   3. stream the new process's stdout+stderr into a log file while keeping an
 *      in-memory tail,
 *   4. report every transition to status.json,
 *   5. serve a small recovery console on a fallback port — the only way to show
 *      WHY a restart failed, because when the new host dies the main port is
 *      dead too and the browser has nothing left to talk to.
 *
 * Plain Node ESM with zero dependencies: it must run even when the profile is
 * broken (a plugin that fails to load is exactly when it is needed).
 *
 *   node restart-helper.mjs --spec /path/to/pending-spec.json
 *
 * Exit: 0 once the new host answers (after a short linger); if it never does,
 * the process stays alive serving the console so the failure can be read,
 * copied and retried.
 */

import { spawn } from 'node:child_process'
import { appendFileSync, closeSync, openSync, readFileSync, readSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { connect } from 'node:net'

// ---------------------------------------------------------------- spec input

/** Parse `--key value` pairs (the only CLI shape this helper accepts). */
function parseArgs(argv) {
  const out = {}
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i]
    if (!token.startsWith('--')) continue
    const key = token.slice(2)
    const value = argv[i + 1]
    if (value === undefined || value.startsWith('--')) out[key] = true
    else {
      out[key] = value
      i++
    }
  }
  return out
}

const args = parseArgs(process.argv.slice(2))
const specPath = typeof args.spec === 'string' ? args.spec : null
if (specPath === null) {
  console.error('restart-helper: --spec <path> is required')
  process.exit(2)
}

/** @type {any} */
let spec
try {
  spec = JSON.parse(readFileSync(specPath, 'utf8'))
} catch (error) {
  console.error('restart-helper: cannot read spec: ' + String(error?.message ?? error))
  process.exit(2)
}

const PORT = Number(spec.port) || 3080
const HOST = typeof spec.host === 'string' ? spec.host : '127.0.0.1'
const URL_BASE = typeof spec.url === 'string' ? spec.url : `http://${HOST}:${PORT}`
const FALLBACK_PORT = Number(spec.fallbackPort) || 3099
const LOG_FILE = typeof spec.logFile === 'string' ? spec.logFile : ''
const STATUS_FILE = typeof spec.statusFile === 'string' ? spec.statusFile : ''
/**
 * Single self-contained file written on a failed restart: the one artifact a
 * human can copy wholesale into an AI chat (status.json and the raw log are
 * machine-shaped and scattered).
 */
const FAILURE_REPORT =
  typeof spec.failureReport === 'string' && spec.failureReport !== ''
    ? spec.failureReport
    : STATUS_FILE === ''
      ? ''
      : STATUS_FILE.replace(/status\.json$/, 'last-failure.md')
const BOOT_TIMEOUT_MS = Number(spec.bootTimeoutMs) || 120_000
const KILL_GRACE_MS = Number(spec.killGraceMs) || 6_000
const PORT_FREE_TIMEOUT_MS = Number(spec.portFreeTimeoutMs) || 25_000
const MAX_ATTEMPTS = Math.max(1, Number(spec.maxAttempts) || 2)
const RING_LINES = Math.max(200, Number(spec.ringLines) || 600)
const LINGER_MS = Math.max(0, Number(spec.lingerMs) || 4_000)
/**
 * `spawn` (default): this helper relaunches the host itself.
 * `observe`: something else owns the relaunch (a launchd job, a supervisor);
 *   the helper only waits, serves the console, and tails the log that owner
 *   writes — spawning a second host here would race it for the port.
 */
const MODE =
  spec.mode === 'observe' && Array.isArray(spec.kickCommand) && spec.kickCommand.length > 0
    ? 'observe'
    : 'spawn'
/** File the owning launcher writes its output to (observe mode). */
const OBSERVE_LOG = typeof spec.observeLog === 'string' ? spec.observeLog : ''
/**
 * How long to wait before kicking a managed host: the HTTP reply that announced
 * this restart has to be on the wire first, and a launchd restart terminates
 * the process that is still writing it.
 */
const KICK_DELAY_MS = Math.max(0, Number(spec.kickDelayMs) || 1_200)

// ------------------------------------------------------------- status + logs

const startedAt = Date.now()
let phase = 'starting'
let attempt = 1
let childPid = null
let childExit = null
let readyAt = null
let failure = null
const ring = []
const errors = []

/** Strip ANSI escapes so the console renders cleanly in a browser. */
const ANSI = /\u001B\[[0-9;]*[A-Za-z]/g

/**
 * Lines that usually carry the reason a boot failed.
 *
 * The stack-frame branch insists on a real file-ish frame (`…/x.js:12:5`,
 * `node:internal/…:1:2`) — a bare `\bat .+:\d+:\d+` also matches timestamps
 * like "restart requested at 2026-09-12T02:08:18Z" and would fill the error
 * list with noise.
 */
const ERROR_HINT = new RegExp(
  [
    '\\bError\\b', '\\bERROR\\b', 'error:', 'EADDRINUSE', 'ECONNREFUSED', 'ENOENT', 'EACCES',
    'MODULE_NOT_FOUND', 'Cannot find (module|package)', 'UnhandledPromiseRejection',
    'uncaughtException', 'FATAL', 'fatal:', 'SyntaxError', 'TypeError', 'ReferenceError',
    'is not a function', 'failed to load', '加载失败', '启动失败',
    '\\bat\\s+.*(?:\\.(?:js|mjs|cjs|ts|tsx|jsx|json)|node:[\\w/]+):\\d+:\\d+',
  ].join('|'),
)

/** Append one line to the log file and the in-memory ring. */
function record(line, stream = 'out') {
  const text = String(line).replace(ANSI, '')
  const at = Date.now()
  ring.push({ t: at, s: stream, text })
  if (ring.length > RING_LINES) ring.splice(0, ring.length - RING_LINES)
  // Only the host's own output can explain a failed boot; our 'sys' lines are
  // narration and would otherwise trip the detector on their own wording.
  if (stream !== 'sys' && ERROR_HINT.test(text) && errors.length < 120) errors.push({ t: at, text })
  if (LOG_FILE !== '') {
    try {
      appendFileSync(LOG_FILE, text + '\n')
    } catch {
      /* logging must never kill the helper */
    }
  }
}

/** Split a stream chunk into lines, carrying the partial remainder. */
function makeLineSplitter(stream) {
  let buffer = ''
  return (chunk) => {
    buffer += chunk.toString('utf8')
    const parts = buffer.split(/\r?\n/)
    buffer = parts.pop() ?? ''
    for (const part of parts) if (part !== '') record(part, stream)
  }
}

/** Fallback port actually bound (null until the console is listening). */
let activeFallbackPort = null

/** Snapshot written to status.json and served at GET /status. */
function snapshot() {
  return {
    ok: true,
    helper: 'dsh-restart',
    helperPid: process.pid,
    mode: MODE,
    phase,
    attempt,
    maxAttempts: MAX_ATTEMPTS,
    port: PORT,
    url: URL_BASE,
    fallbackPort: activeFallbackPort,
    fallbackUrl: activeFallbackPort === null ? '' : `http://${HOST}:${activeFallbackPort}`,
    oldPid: spec.oldPid ?? null,
    childPid,
    childExit,
    startedAt: new Date(startedAt).toISOString(),
    elapsedMs: Date.now() - startedAt,
    readyAt: readyAt === null ? null : new Date(readyAt).toISOString(),
    bootMs: readyAt === null ? null : readyAt - startedAt,
    failure,
    logFile: LOG_FILE === '' ? null : LOG_FILE,
    statusFile: STATUS_FILE === '' ? null : STATUS_FILE,
    failureReport: FAILURE_REPORT === '' ? null : FAILURE_REPORT,
    errorLines: errors.slice(-25),
    tail: ring.slice(-150).map((entry) => entry.text),
    dshVersion: spec.dshVersion ?? null,
    profile: spec.profile ?? null,
    argv: Array.isArray(spec.args) ? spec.args : [],
  }
}

/** Persist the snapshot (atomic; readers never see a half-written file). */
function persist() {
  if (STATUS_FILE === '') return
  try {
    const tmp = `${STATUS_FILE}.${process.pid}.tmp`
    writeFileSync(tmp, JSON.stringify(snapshot(), null, 2))
    renameSync(tmp, STATUS_FILE)
  } catch {
    /* best effort */
  }
}

/**
 * Write the one file a human (or an AI) can copy wholesale after a failure.
 *
 * Everything needed to diagnose a broken boot is already in this process, but
 * scattered across status.json, an error list and a raw log — so a failed
 * restart also drops a single self-contained report next to them.
 */
function buildFailureReport() {
  const errorLines = errors.slice(-40).map((entry) => entry.text)
  const tail = ring.slice(-150).map((entry) => entry.text)
  const report = [
    '# DSH 重启失败报告',
    '',
    `- 时间：${new Date().toISOString()}`,
    `- 目标地址：${URL_BASE}`,
    `- 重启方式：${MODE}${spec.owner === undefined ? '' : `（${spec.owner}）`}`,
    `- DSH 版本：${spec.dshVersion ?? '未知'}　profile：${spec.profile ?? '未知'}`,
    `- 旧进程 pid：${spec.oldPid ?? '?'}　新进程 pid：${childPid ?? '未起来'}`,
    `- 启动命令：${[spec.file, ...(Array.isArray(spec.args) ? spec.args : [])].join(' ')}`,
    `- 工作目录：${spec.cwd ?? process.cwd()}`,
    `- 尝试次数：${attempt}/${MAX_ATTEMPTS}`,
    childExit === null
      ? null
      : `- 退出码：${childExit.code}${childExit.signal === null ? '' : ` / ${childExit.signal}`}`,
    `- 失败原因：${failure === null ? '未知' : failure.message}`,
    `- 完整日志：${LOG_FILE === '' ? '（未启用）' : LOG_FILE}`,
    `- 恢复控制台：http://${HOST}:${activeFallbackPort ?? FALLBACK_PORT}`,
    '',
    '## 疑似报错行',
    '',
    '```',
    errorLines.length === 0 ? '（未识别出明显的报错行，请直接看下方完整输出）' : errorLines.join('\n'),
    '```',
    '',
    '## 启动输出（最后 150 行）',
    '',
    '```',
    tail.length === 0 ? '（无输出）' : tail.join('\n'),
    '```',
    '',
  ]
    .filter((line) => line !== null)
    .join('\n')
  return report
}

/** Persist the report; a failure here must never mask the failure itself. */
function writeFailureReport() {
  if (FAILURE_REPORT === '') return
  try {
    writeFileSync(FAILURE_REPORT, buildFailureReport(), { mode: 0o600 })
    record(`[dsh-restart] failure report written: ${FAILURE_REPORT}`, 'sys')
  } catch {
    /* best effort */
  }
}

/** Update phase + persist + log the transition. */
function setPhase(next, note = '') {
  phase = next
  if (note !== '') record(`[dsh-restart] ${note}`, 'sys')
  if (next === 'failed') writeFailureReport()
  persist()
}

// ------------------------------------------------------------------ probing

/** Resolve true when something accepts a TCP connection on host:port. */
function portOpen(port, host, timeoutMs = 800) {
  return new Promise((resolve) => {
    const socket = connect({ port, host })
    let settled = false
    const done = (value) => {
      if (settled) return
      settled = true
      socket.destroy()
      resolve(value)
    }
    socket.setTimeout(timeoutMs)
    socket.once('connect', () => done(true))
    socket.once('timeout', () => done(false))
    socket.once('error', () => done(false))
  })
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/** Poll until the port is free (old host exited) or the budget runs out. */
async function waitPortFree(port, host, timeoutMs) {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    if (!(await portOpen(port, host))) return true
    if (Date.now() >= deadline) return false
    await sleep(200)
  }
}

/** Poll until the port answers, bailing out early when the child died. */
async function waitPortReady(port, host, timeoutMs, child) {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    if (child !== null && child.exitCode !== null) return false
    if (await portOpen(port, host)) return true
    if (Date.now() >= deadline) return false
    await sleep(300)
  }
}

// --------------------------------------------------------------- child spawn

/** Launch the new host, wiring both output streams into the log. */
function launch() {
  const file = spec.file
  const argv = Array.isArray(spec.args) ? spec.args : []
  const cwd = typeof spec.cwd === 'string' && spec.cwd !== '' ? spec.cwd : process.cwd()
  const env = { ...(spec.env ?? process.env), DSH_RESTART_HELPER_PID: String(process.pid) }
  record(`[dsh-restart] attempt ${attempt}/${MAX_ATTEMPTS}: ${file} ${argv.join(' ')}`, 'sys')
  record(`[dsh-restart] cwd: ${cwd}`, 'sys')
  let child
  try {
    child = spawn(file, argv, { cwd, env, detached: true, stdio: ['ignore', 'pipe', 'pipe'] })
  } catch (error) {
    failure = { kind: 'spawn', message: String(error?.message ?? error) }
    record(`[dsh-restart] spawn failed: ${failure.message}`, 'sys')
    return null
  }
  childPid = child.pid ?? null
  child.on('error', (error) => {
    failure = { kind: 'spawn', message: String(error?.message ?? error) }
    record(`[dsh-restart] child error: ${failure.message}`, 'sys')
    persist()
  })
  child.stdout?.on('data', makeLineSplitter('out'))
  child.stderr?.on('data', makeLineSplitter('err'))
  child.on('exit', (code, signal) => {
    childExit = { code, signal, at: new Date().toISOString() }
    record(`[dsh-restart] child exited: code=${code} signal=${signal}`, 'sys')
    persist()
  })
  child.unref()
  for (const stream of [child.stdout, child.stderr, child.stdin]) stream?.unref?.()
  return child
}

/** Terminate the old host if it is still holding the port. */
function reapOldHost() {
  const oldPid = Number(spec.oldPid)
  if (!Number.isInteger(oldPid) || oldPid <= 1 || oldPid === process.pid) return
  try {
    process.kill(oldPid, 0) // still alive?
  } catch {
    return
  }
  record(`[dsh-restart] old host ${oldPid} still alive after the port-free wait; sending SIGKILL`, 'sys')
  try {
    process.kill(oldPid, 'SIGKILL')
  } catch (error) {
    record(`[dsh-restart] SIGKILL failed: ${String(error?.message ?? error)}`, 'sys')
  }
}

// ------------------------------------------------------------------- console

const HTML = `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8" />
<meta name="viewport" content="width=device-width,initial-scale=1" />
<title>DSH 重启控制台</title>
<style>
  :root{color-scheme:light dark}
  *{box-sizing:border-box}
  body{margin:0;padding:28px;font:14px/1.6 -apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Hiragino Sans GB",sans-serif;
       background:#f6f7f9;color:#1a1d21}
  @media (prefers-color-scheme:dark){body{background:#16181c;color:#e6e8eb}
    .card{background:#1e2126!important;border-color:#2c3038!important}
    pre{background:#14161a!important;border-color:#2c3038!important}
    .muted{color:#9aa1ab!important}}
  .wrap{max-width:900px;margin:0 auto;display:flex;flex-direction:column;gap:16px}
  h1{font-size:17px;margin:0;font-weight:600;letter-spacing:.2px}
  .row{display:flex;align-items:center;gap:10px;flex-wrap:wrap}
  .card{background:#fff;border:1px solid #e3e5e9;border-radius:10px;padding:16px 18px;
        display:flex;flex-direction:column;gap:12px}
  .badge{display:inline-flex;align-items:center;gap:6px;padding:3px 10px;border-radius:999px;
         font-size:12px;font-weight:600;border:1px solid transparent}
  .b-wait{background:#fff4e5;color:#9a5b00;border-color:#f2d9b0}
  .b-ok{background:#e7f5ec;color:#1d6b3a;border-color:#b9e0c8}
  .b-bad{background:#fdeaea;color:#a02020;border-color:#f3c2c2}
  .b-run{background:#e8f0fe;color:#1a4fa0;border-color:#bed2f5}
  @media (prefers-color-scheme:dark){
    .b-wait{background:#3a2c14;color:#f0b866;border-color:#5a4520}
    .b-ok{background:#15301f;color:#7fd3a0;border-color:#25503a}
    .b-bad{background:#3a1a1a;color:#f09a9a;border-color:#5c2a2a}
    .b-run{background:#16233d;color:#9dbdf5;border-color:#27395c}}
  .kv{display:grid;grid-template-columns:150px 1fr;gap:6px 14px;font-size:13px}
  .kv div:nth-child(odd){color:#6b7280}
  .muted{color:#6b7280}
  code{font:12px/1.5 ui-monospace,SFMono-Regular,Menlo,monospace;background:#f2f3f5;
       border:1px solid #e3e5e9;border-radius:4px;padding:1px 5px}
  pre{margin:0;max-height:420px;overflow:auto;padding:12px;border-radius:8px;background:#f2f3f5;
      border:1px solid #e3e5e9;font:12px/1.55 ui-monospace,SFMono-Regular,Menlo,monospace;
      white-space:pre-wrap;word-break:break-word}
  button{font:inherit;font-size:13px;padding:7px 14px;border-radius:7px;border:1px solid #d2d6dd;
         background:#fff;color:inherit;cursor:pointer}
  button:hover{border-color:#9aa1ab}
  button.primary{background:#2b6cb0;border-color:#2b6cb0;color:#fff}
  button.primary:hover{background:#255d99}
  .err{color:#c0392b}
  @media (prefers-color-scheme:dark){.err{color:#ff8a80}}
</style></head>
<body><div class="wrap">
  <div class="row"><h1>DSH 重启控制台</h1><span id="badge" class="badge b-wait">…</span></div>
  <div class="card">
    <div class="kv" id="kv"></div>
    <div class="row">
      <button class="primary" id="open">打开 DSH</button>
      <button id="retry">重试启动</button>
      <button id="recheck">重新检测</button>
      <button id="copy">复制报错</button>
      <button id="copyAll">复制完整报告</button>
    </div>
    <div class="muted" id="hint" style="font-size:12px"></div>
  </div>
  <div class="card" id="errCard" style="display:none">
    <div class="row"><strong>检测到的报错</strong><span class="muted" id="errCount" style="font-size:12px"></span></div>
    <pre id="err"></pre>
  </div>
  <div class="card">
    <div class="row"><strong>启动日志</strong><span class="muted" id="logMeta" style="font-size:12px"></span></div>
    <pre id="log">加载中…</pre>
  </div>
</div>
<script>
  var $ = function(id){ return document.getElementById(id) }
  var badge=$('badge'), kv=$('kv'), log=$('log'), errCard=$('errCard'), errPre=$('err'),
      errCount=$('errCount'), hint=$('hint'), logMeta=$('logMeta')
  var dshUrl = '/', lastLog = '', opened = false
  var LABEL = { 'waiting-port-free':'等待旧进程退出', starting:'正在启动', 'waiting-ready':'等待就绪',
                ready:'已就绪', retrying:'正在重试', failed:'启动失败' }
  var CLASS = { 'waiting-port-free':'b-run', starting:'b-run', 'waiting-ready':'b-run',
                ready:'b-ok', retrying:'b-wait', failed:'b-bad' }
  function esc(t){ return String(t).replace(/[&<>]/g, function(c){ return ({'&':'&amp;','<':'&lt;','>':'&gt;'})[c] }) }
  function render(s){
    dshUrl = s.url || '/'
    badge.textContent = LABEL[s.phase] || s.phase
    badge.className = 'badge ' + (CLASS[s.phase] || 'b-run')
    var rows = [
      ['DSH 地址', '<code>' + esc(s.url || '') + '</code>'],
      ['本次尝试', s.attempt + ' / ' + s.maxAttempts],
      ['新进程 PID', s.childPid == null ? '—' : s.childPid],
      ['已耗时', (s.elapsedMs/1000).toFixed(1) + ' s'],
      ['启动耗时', s.bootMs == null ? '—' : (s.bootMs/1000).toFixed(1) + ' s'],
      ['退出码', s.childExit == null ? '—' : (s.childExit.code + (s.childExit.signal ? ' / ' + s.childExit.signal : ''))],
      ['DSH 版本', s.dshVersion || '—'],
      ['日志文件', s.logFile ? '<code>' + esc(s.logFile) + '</code>' : '—']
    ]
    if (s.failure && s.failure.message) rows.push(['失败原因', '<span class="err">' + esc(s.failure.message) + '</span>'])
    kv.innerHTML = rows.map(function(r){ return '<div>' + r[0] + '</div><div>' + r[1] + '</div>' }).join('')
    var text = (s.tail || []).join('\\n')
    if (text !== lastLog){ lastLog = text; log.textContent = text || '（暂无输出）'; log.scrollTop = log.scrollHeight }
    logMeta.textContent = (s.tail || []).length + ' 行'
    var errs = s.errorLines || []
    if (errs.length > 0){
      errCard.style.display = ''
      errCount.textContent = errs.length + ' 条'
      errPre.innerHTML = errs.map(function(e){ return '<span class="err">' + esc(e.text) + '</span>' }).join('\\n')
    } else { errCard.style.display = 'none' }
    if (s.phase === 'ready'){
      hint.textContent = '新进程已就绪，正在跳转…'
      if (!opened){ opened = true; setTimeout(function(){ location.href = dshUrl }, 800) }
    } else if (s.phase === 'failed'){
      hint.textContent = '启动失败：请根据上方报错修复后点「重试启动」。'
    } else {
      hint.textContent = '重启进行中，本页每 1.5 秒自动刷新。'
    }
  }
  function poll(){
    fetch('/status', { cache:'no-store' }).then(function(r){ return r.json() }).then(render)
      .catch(function(){ badge.textContent='控制台已退出'; badge.className='badge b-ok' })
  }
  $('open').onclick = function(){ location.href = dshUrl }
  $('retry').onclick = function(){ fetch('/retry', { method:'POST' }).then(function(){ lastLog=''; opened=false; poll() }) }
  $('recheck').onclick = function(){ fetch('/recheck', { method:'POST' }).then(poll) }
  $('copyAll').onclick = function(){
    fetch('/report').then(function(r){ return r.text() }).then(function(t){
      if (navigator.clipboard) navigator.clipboard.writeText(t).then(function(){ hint.textContent = '完整报告已复制，可直接粘贴给 AI 定位' })
      else { var w = window.open('', '_blank'); if (w) w.document.write('<pre>' + esc(t) + '</pre>') }
    })
  }
  $('copy').onclick = function(){
    var text = [badge.textContent, errPre.textContent || '', lastLog].join('\\n\\n')
    if (navigator.clipboard) navigator.clipboard.writeText(text).then(function(){ hint.textContent='已复制' })
  }
  poll(); setInterval(poll, 1500)
</script></body></html>`

/** Start the recovery console; tries FALLBACK_PORT..+9 for a free seat. */
function startConsole() {
  return new Promise((resolve) => {
    let candidate = FALLBACK_PORT
    const server = createServer(handleConsoleRequest)
    const tryListen = () => {
      server.once('error', () => {
        candidate += 1
        if (candidate > FALLBACK_PORT + 9) {
          record('[dsh-restart] no free fallback port; recovery console disabled', 'sys')
          resolve(null)
          return
        }
        tryListen()
      })
      server.listen(candidate, HOST, () => {
        activeFallbackPort = server.address()?.port ?? candidate
        record(`[dsh-restart] recovery console: http://${HOST}:${activeFallbackPort}`, 'sys')
        resolve(server)
      })
    }
    tryListen()
  })
}

/**
 * Follow the log the owning launcher writes (observe mode).
 *
 * launchd writes the restarted host's stdout/stderr to the plist's
 * StandardOutPath / StandardErrorPath, so that file — not a pipe — is where the
 * boot output lands. Offsets are tracked so each poll only reads what is new,
 * and a truncation (log rotation) resets to the beginning.
 */
function makeLogFollower(file) {
  let offset = 0
  let remainder = ''
  return () => {
    if (file === '') return
    let info
    try {
      info = statSync(file)
    } catch {
      return
    }
    if (info.size < offset) {
      offset = 0
      remainder = ''
    }
    if (info.size === offset) return
    let text
    try {
      const handle = openSync(file, 'r')
      const length = info.size - offset
      const buffer = Buffer.allocUnsafe(length)
      readSync(handle, buffer, 0, length, offset)
      closeSync(handle)
      text = buffer.toString('utf8')
    } catch {
      return
    }
    offset = info.size
    remainder += text
    const parts = remainder.split(/\r?\n/)
    remainder = parts.pop() ?? ''
    for (const part of parts) if (part !== '') record(part, 'out')
  }
}

/** Set by POST /retry — honoured after a failure. */
let requestRetry = false
/** Set by POST /recheck — re-probe the main port without relaunching. */
let requestRecheck = false

/** Console routes: page, /status, /log, /retry, /recheck (CORS-open for the panel). */
function handleConsoleRequest(req, res) {
  const cors = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Cache-Control': 'no-store',
  }
  if (req.method === 'OPTIONS') {
    res.writeHead(204, cors)
    res.end()
    return
  }
  const url = new URL(req.url ?? '/', `http://${HOST}`)
  if (url.pathname === '/status') {
    res.writeHead(200, { ...cors, 'Content-Type': 'application/json; charset=utf-8' })
    res.end(JSON.stringify(snapshot()))
    return
  }
  if (url.pathname === '/report') {
    // One copy-ready document for "hand this to an AI and diagnose it".
    res.writeHead(200, { ...cors, 'Content-Type': 'text/markdown; charset=utf-8' })
    res.end(buildFailureReport())
    return
  }
  if (url.pathname === '/log') {
    const lines = Math.max(1, Math.min(2000, Number(url.searchParams.get('lines')) || 300))
    res.writeHead(200, { ...cors, 'Content-Type': 'text/plain; charset=utf-8' })
    res.end(ring.slice(-lines).map((entry) => entry.text).join('\n'))
    return
  }
  if (url.pathname === '/retry' && req.method === 'POST') {
    requestRetry = true
    res.writeHead(200, { ...cors, 'Content-Type': 'application/json; charset=utf-8' })
    res.end('{"ok":true}')
    return
  }
  if (url.pathname === '/recheck' && req.method === 'POST') {
    requestRecheck = true
    res.writeHead(200, { ...cors, 'Content-Type': 'application/json; charset=utf-8' })
    res.end('{"ok":true}')
    return
  }
  res.writeHead(200, { ...cors, 'Content-Type': 'text/html; charset=utf-8' })
  res.end(HTML)
}

// --------------------------------------------------------------------- main

/** Re-run the owning launcher's kick command (observe mode, manual retry). */
function runKick() {
  const command = Array.isArray(spec.kickCommand) ? spec.kickCommand : null
  if (command === null || command.length === 0) {
    record('[dsh-restart] no kick command available for this host', 'sys')
    return false
  }
  record(`[dsh-restart] re-running launcher: ${command.join(' ')}`, 'sys')
  try {
    const child = spawn(command[0], command.slice(1), { stdio: 'ignore' })
    child.on('error', (error) => record(`[dsh-restart] kick failed: ${String(error?.message ?? error)}`, 'sys'))
    return true
  } catch (error) {
    record(`[dsh-restart] kick threw: ${String(error?.message ?? error)}`, 'sys')
    return false
  }
}

/**
 * Watch a host that someone else owns (launchd / a supervisor) come back.
 *
 * Deliberately never spawns: the owner is already restarting it, and a second
 * process would race for the port. The owner's log file is followed instead so
 * the console still shows the boot output.
 */
async function observeBoot() {
  setPhase(
    attempt === 1 ? 'starting' : 'retrying',
    `watching for the managed host to come back (owner: ${spec.owner ?? 'external'})`,
  )
  const follow = makeLogFollower(OBSERVE_LOG)
  const deadline = Date.now() + BOOT_TIMEOUT_MS
  for (;;) {
    follow()
    if (await portOpen(PORT, HOST)) {
      readyAt = Date.now()
      setPhase('ready', `ready after ${((readyAt - startedAt) / 1000).toFixed(1)}s`)
      return 'ready'
    }
    if (Date.now() >= deadline) {
      failure = {
        kind: 'timeout',
        message: `启动超时：${Math.round(BOOT_TIMEOUT_MS / 1000)} 秒内 ${URL_BASE} 没有响应（由 ${spec.owner ?? '外部托管方'} 负责拉起）`,
      }
      record(`[dsh-restart] ${failure.message}`, 'sys')
      persist()
      return 'failed'
    }
    await sleep(400)
  }
}

/** One launch attempt; resolves 'ready' | 'failed'. */
async function attemptBoot() {
  if (MODE === 'observe') return observeBoot()
  setPhase(attempt === 1 ? 'starting' : 'retrying', `launching attempt ${attempt}`)
  const child = launch()
  if (child === null) {
    failure = failure ?? { kind: 'spawn', message: 'spawn returned no process' }
    return 'failed'
  }
  setPhase('waiting-ready', `waiting for ${URL_BASE} to answer (up to ${Math.round(BOOT_TIMEOUT_MS / 1000)}s)`)
  if (await waitPortReady(PORT, HOST, BOOT_TIMEOUT_MS, child)) {
    readyAt = Date.now()
    setPhase('ready', `ready after ${((readyAt - startedAt) / 1000).toFixed(1)}s`)
    return 'ready'
  }
  const code = child.exitCode
  const tail = errors.slice(-3).map((entry) => entry.text).join(' | ')
  failure = {
    kind: code === null ? 'timeout' : 'exit',
    message: code === null
      ? `启动超时：${Math.round(BOOT_TIMEOUT_MS / 1000)} 秒内 ${URL_BASE} 没有响应`
      : `新进程退出（code=${code}）${tail === '' ? '' : '：' + tail}`,
    exitCode: code,
  }
  record(`[dsh-restart] attempt ${attempt} failed: ${failure.message}`, 'sys')
  persist()
  return 'failed'
}

async function main() {
  record('='.repeat(72), 'sys')
  record(`[dsh-restart] restart requested at ${new Date(startedAt).toISOString()}`, 'sys')
  record(`[dsh-restart] old pid ${spec.oldPid ?? '?'}, target ${URL_BASE}`, 'sys')
  record(`[dsh-restart] mode: ${MODE}${MODE === 'observe' ? ` (owner: ${spec.owner ?? 'external'})` : ''}`, 'sys')
  // A stale report from an earlier restart would point at the wrong failure.
  if (FAILURE_REPORT !== '') {
    try {
      unlinkSync(FAILURE_REPORT)
    } catch {
      /* nothing to clear */
    }
  }
  persist()
  await startConsole()

  if (OBSERVE_LOG !== '') {
    // Keep following the owner's log for the helper's whole life, so the console
    // stays live after readiness instead of freezing at boot.
    const follow = makeLogFollower(OBSERVE_LOG)
    setInterval(follow, 1_000)
    record(`[dsh-restart] following ${OBSERVE_LOG}`, 'sys')
  }

  if (MODE === 'observe') {
    // The owner will terminate this host; give the reply time to land first.
    if (KICK_DELAY_MS > 0) await sleep(KICK_DELAY_MS)
    runKick()
  }

  setPhase('waiting-port-free', `waiting for ${HOST}:${PORT} to free up`)
  // In observe mode the owner is restarting the host right now: the port will
  // be free for the length of one process boot. Never kill a pid we do not own.
  const freeBudget = MODE === 'observe' ? Math.min(PORT_FREE_TIMEOUT_MS, 15_000) : PORT_FREE_TIMEOUT_MS
  if (!(await waitPortFree(PORT, HOST, freeBudget))) {
    record('[dsh-restart] port still busy after the wait', 'sys')
    if (MODE === 'spawn') {
      reapOldHost()
      await waitPortFree(PORT, HOST, KILL_GRACE_MS)
    }
  }
  // A supervisor (or a manual start) may have relaunched already: do not double-boot.
  if (await portOpen(PORT, HOST)) {
    readyAt = Date.now()
    setPhase('ready', 'the port is already answering — another launcher won the race')
    return finish()
  }

  for (;;) {
    const outcome = await attemptBoot()
    if (outcome === 'ready') return finish()
    if (attempt < MAX_ATTEMPTS) {
      attempt++
      await sleep(1500)
      continue
    }
    setPhase('failed', 'all attempts exhausted — the recovery console stays up for inspection')
    if ((await waitForManualRetry()) === 'ready') return finish()
  }
}

/**
 * Sit on a failed restart until someone acts on the console.
 *
 * @returns 'ready' when the port came back on its own, 'retry' when the operator
 *   asked for another attempt (the caller then re-enters the boot loop).
 */
async function waitForManualRetry() {
  for (;;) {
    await sleep(500)
    if (requestRecheck) {
      requestRecheck = false
      if (await portOpen(PORT, HOST)) {
        readyAt = Date.now()
        setPhase('ready', 'the port is answering again')
        return 'ready'
      }
    }
    if (requestRetry) {
      requestRetry = false
      attempt = 1
      failure = null
      childExit = null
      errors.length = 0
      record('[dsh-restart] manual retry requested', 'sys')
      if (MODE === 'observe') runKick()
      return 'retry'
    }
  }
}

/** Linger briefly, then exit — the new host owns the browser from here. */
async function finish() {
  await sleep(LINGER_MS)
  process.exit(0)
}

process.on('uncaughtException', (error) => {
  record(`[dsh-restart] uncaught: ${String(error?.stack ?? error)}`, 'sys')
  failure = { kind: 'helper', message: String(error?.message ?? error) }
  persist()
})
process.on('unhandledRejection', (reason) => {
  record(`[dsh-restart] unhandled rejection: ${String(reason)}`, 'sys')
  persist()
})

main().catch((error) => {
  record(`[dsh-restart] fatal: ${String(error?.stack ?? error)}`, 'sys')
  failure = { kind: 'helper', message: String(error?.message ?? error) }
  setPhase('failed', 'helper crashed')
  process.exitCode = 1
})
