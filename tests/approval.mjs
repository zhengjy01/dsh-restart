/**
 * dsh-restart approval-gate tests.
 *
 * The gate is the one place where a mistake is expensive: too weak and an agent
 * restarts the host on its own say-so; too eager and a user's click kills a
 * working session twice, or a stale click hours later does it at all. These
 * tests pin the four properties that make it trustworthy:
 *
 *   1. filing is durable (0600 on disk, newest request wins),
 *   2. a decision must quote the exact id it was shown,
 *   3. approving consumes the request — a replay cannot restart twice,
 *   4. an expired request does nothing, ever.
 *
 * Everything runs against a temp DSH_RESTART_HOME, so the real
 * ~/.dsh/dsh-restart is never touched. Nothing here restarts anything.
 */

import { mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

const HOME = await mkdtemp(path.join(tmpdir(), 'dsh-restart-approval-'))
process.env.DSH_RESTART_HOME = HOME

const {
  approvalPath,
  clearApproval,
  createApproval,
  decideApproval,
  readApproval,
} = await import('../lib/index.js')

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

console.log('dsh-restart approval gate')

// 1. Nothing pending to begin with.
{
  const current = await readApproval()
  check('空状态：没有待批准请求', current.approval === null && current.expired === false, JSON.stringify(current))
  check('路径落在插件 home 内', current.file === approvalPath() && current.file.startsWith(HOME), current.file)
}

// 2. Filing is durable, private, and shows what the requester claimed.
let first = null
{
  const { approval, replaced } = await createApproval({
    reason: '让 usage-hud 的改动生效',
    ttlMs: 60_000,
    claimedConsent: true,
    source: 'agent',
    origin: '会话：usage-hud 开发',
  })
  first = approval
  check('创建返回请求且未被替换', replaced === null && typeof approval.id === 'string' && approval.id.length > 10)
  check('有效期在将来', Date.parse(approval.expiresAt) > Date.now())
  check('来源与声明被记录', approval.source === 'agent' && approval.claimedConsent === true)
  check('发起方上下文被记录', approval.origin === '会话：usage-hud 开发')

  const info = await stat(approvalPath())
  check('落盘权限 0600', (info.mode & 0o777) === 0o600, (info.mode & 0o777).toString(8))

  const onDisk = JSON.parse(await readFile(approvalPath(), 'utf8'))
  check('落盘内容与返回值一致', onDisk.id === approval.id && onDisk.reason === '让 usage-hud 的改动生效')

  const current = await readApproval()
  check('可读回同一请求', current.approval?.id === approval.id && current.expired === false)
}

// 3. A newer request replaces the older one (a requester that just failed must
//    not be shadowed by a request nobody acted on).
{
  const { approval, replaced } = await createApproval({
    reason: '第二个请求',
    ttlMs: 60_000,
    claimedConsent: true,
    source: 'agent',
  })
  check('新请求替换旧请求', replaced?.id === first.id && approval.id !== first.id)
  const current = await readApproval()
  check('读回的是最新请求', current.approval?.id === approval.id)
  first = approval
}

// 4. A decision must quote the id the user was actually shown.
{
  const verdict = await decideApproval('00000000-0000-0000-0000-000000000000', 'approve')
  check('id 不匹配时拒绝执行', verdict.ok === false && String(verdict.error).includes('id 不匹配'), JSON.stringify(verdict))
  const current = await readApproval()
  check('id 不匹配不会消费请求', current.approval?.id === first.id)
}

// 5. Approving consumes the request: the click is single-use.
{
  const verdict = await decideApproval(first.id, 'approve')
  check('批准成功并返回原请求', verdict.ok === true && verdict.approval?.id === first.id && verdict.denied !== true)
  const current = await readApproval()
  check('批准后请求已被消费', current.approval === null)
  const replay = await decideApproval(first.id, 'approve')
  check('重放同一批准不会再次执行', replay.ok === false && String(replay.error).includes('没有待批准'), JSON.stringify(replay))
  let exists = true
  try {
    await stat(approvalPath())
  } catch {
    exists = false
  }
  check('消费后落盘文件已删除', exists === false)
}

// 6. Denying drops the request and restarts nothing.
{
  const { approval } = await createApproval({ reason: '会被拒绝', ttlMs: 60_000, claimedConsent: true, source: 'agent' })
  const verdict = await decideApproval(approval.id, 'deny')
  check('拒绝成功且被标记为拒绝', verdict.ok === true && verdict.denied === true)
  const current = await readApproval()
  check('拒绝后没有残留请求', current.approval === null && current.expired === false)
}

// 7. An expired request is inert — three hours later a stale click must not kill
//    a healthy session.
{
  const { approval } = await createApproval({ reason: '会过期的请求', ttlMs: 1_000, claimedConsent: true, source: 'agent' })
  await sleep(1_200)
  const current = await readApproval()
  check('过期请求不再可执行', current.approval === null && current.expired === true, JSON.stringify(current))
  const verdict = await decideApproval(approval.id, 'approve')
  check('过期后批准被拒绝', verdict.ok === false && String(verdict.error).includes('过期'), JSON.stringify(verdict))
  const after = await readApproval()
  check('过期请求被清理', after.approval === null && after.expired === false)
}

// 8. Empty state is a no-op, not an error to act on.
{
  const verdict = await decideApproval('whatever', 'approve')
  check('无请求时决定被拒绝', verdict.ok === false && verdict.approval === undefined)
  await clearApproval()
  const current = await readApproval()
  check('清理后仍为空', current.approval === null)
}

await rm(HOME, { recursive: true, force: true })

console.log(`\n${passed} passed, ${failed} failed`)
process.exit(failed > 0 ? 1 : 0)
