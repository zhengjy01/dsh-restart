/**
 * dsh-restart — the human approval gate for agent-requested restarts.
 *
 * Restarting DSH ends the current turn and the session's connection, and the
 * standing local rule is that the host is never restarted without the user's
 * own, current consent. A tool cannot verify consent: `confirm: true` is the
 * caller describing itself, and nothing stops a different session from passing
 * it. So `dsh_restart` no longer restarts anything — it files a request here,
 * and only the user can turn that request into a restart, by clicking
 * 「批准并重启」 in the web panel:
 *
 *   agent tool ──files request──▶ pending-approval.json
 *   user clicks 批准 ──POST /approval {decision:'approve'}──▶ host
 *   host ──requestRestart(source='user-approved')──▶ the normal restart path
 *
 * A request is single-use: approving consumes it (the file is removed before
 * the restart starts), so a replayed or duplicated approval cannot restart the
 * host twice. An expired request does nothing at all — a stale click three
 * hours later must never kill a working session.
 *
 * The panel's own button needs no approval: a human click *is* the approval,
 * and asking for a second click would only train people to click through.
 */

import { randomUUID } from 'node:crypto'
import { spawn } from 'node:child_process'
import { chmod, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'

import { restartHome } from './config.ts'

/** One restart request waiting for a human decision. */
export interface PendingApproval {
  /** Opaque id; an approval must quote it so a stale click cannot land elsewhere. */
  id: string
  /** When the request was filed (ISO). */
  at: string
  /** When it stops being actionable (ISO). */
  expiresAt: string
  /** Lifetime the request was filed with. */
  ttlMs: number
  /** Who filed it (`agent` for the tool path). */
  source: string
  /** Why the requester wants a restart. */
  reason: string
  /**
   * The requester claimed the user already agreed (the tool's `confirm: true`).
   *
   * Kept for context only — it is **not** the approval and unlocks nothing; it
   * is shown in the panel so the user knows what the agent believes.
   */
  claimedConsent: boolean
  /** Pid of the process that filed the request (the host being asked to restart). */
  pid: number
  /** Extra caller context (session / workspace) when the caller knows it. */
  origin?: string
}

/** Where the pending request lives (0600, inside the plugin home). */
export function approvalPath(): string {
  return join(restartHome(), 'pending-approval.json')
}

/** True when a parsed JSON value has the shape of a pending request. */
function isPendingApproval(value: unknown): value is PendingApproval {
  if (typeof value !== 'object' || value === null) return false
  const record = value as Record<string, unknown>
  return (
    typeof record.id === 'string' &&
    record.id !== '' &&
    typeof record.at === 'string' &&
    typeof record.expiresAt === 'string' &&
    typeof record.reason === 'string' &&
    typeof record.pid === 'number'
  )
}

/** True when the request's deadline has passed. */
function hasExpired(approval: PendingApproval, now = Date.now()): boolean {
  const deadline = Date.parse(approval.expiresAt)
  return !Number.isFinite(deadline) || now >= deadline
}

/** Atomic JSON write (same discipline as the plugin config: never a torn file). */
async function writeJsonAtomic(file: string, value: unknown): Promise<void> {
  await mkdir(dirname(file), { recursive: true })
  const tmp = `${file}.tmp-${process.pid}`
  await writeFile(tmp, JSON.stringify(value, null, 2), { mode: 0o600 })
  await chmod(tmp, 0o600).catch(() => undefined)
  await rename(tmp, file)
}

/**
 * The current pending request, if any.
 *
 * An expired request is reported as absent *and* flagged, so the panel can say
 * "the last request timed out" instead of silently showing nothing.
 */
export async function readApproval(): Promise<{ approval: PendingApproval | null; expired: boolean; file: string }> {
  const file = approvalPath()
  try {
    const text = await readFile(file, 'utf8')
    const parsed: unknown = JSON.parse(text)
    if (!isPendingApproval(parsed)) return { approval: null, expired: false, file }
    if (hasExpired(parsed)) return { approval: null, expired: true, file }
    return { approval: parsed, expired: false, file }
  } catch {
    return { approval: null, expired: false, file }
  }
}

/**
 * File a restart request for the user to decide on.
 *
 * A newer request replaces an older, still-pending one (the requester that just
 * failed should not be shadowed by a request nobody acted on); the replaced
 * record is returned so the caller can mention it.
 *
 * @param input.reason - why a restart is wanted (shown to the user).
 * @param input.ttlMs - how long the request stays actionable.
 * @param input.claimedConsent - the caller says the user already agreed.
 * @param input.origin - optional caller context (session / workspace).
 */
export async function createApproval(input: {
  reason: string
  ttlMs: number
  claimedConsent: boolean
  source?: string
  origin?: string
}): Promise<{ approval: PendingApproval; replaced: PendingApproval | null }> {
  const previous = await readApproval()
  const now = Date.now()
  const ttlMs = Math.max(1_000, Math.floor(input.ttlMs))
  const approval: PendingApproval = {
    id: randomUUID(),
    at: new Date(now).toISOString(),
    expiresAt: new Date(now + ttlMs).toISOString(),
    ttlMs,
    source: input.source ?? 'agent',
    reason: input.reason,
    claimedConsent: input.claimedConsent,
    pid: process.pid,
  }
  if (typeof input.origin === 'string' && input.origin !== '') approval.origin = input.origin
  await writeJsonAtomic(approvalPath(), approval)
  return { approval, replaced: previous.approval }
}

/** Drop the pending request (also used to clear an expired leftover). */
export async function clearApproval(): Promise<boolean> {
  try {
    await rm(approvalPath(), { force: true })
    return true
  } catch {
    return false
  }
}

/** Outcome of a user decision coming from the panel. */
export interface ApprovalDecision {
  ok: boolean
  /** The request that was decided (present on approve and deny). */
  approval?: PendingApproval
  /** True when the user refused. */
  denied?: boolean
  /** Why the decision could not be applied. */
  error?: string
}

/**
 * Apply the user's decision.
 *
 * Approving **consumes** the request: the pending file is removed before this
 * returns, so the restart that follows can never be triggered twice by a replay.
 * Denying simply removes it. Anything else (unknown id, expired, nothing
 * pending) changes nothing.
 *
 * @param id - the request id the user was shown.
 * @param decision - `approve` to restart, `deny` to refuse.
 */
export async function decideApproval(id: string, decision: 'approve' | 'deny'): Promise<ApprovalDecision> {
  const current = await readApproval()
  if (current.approval === null) {
    if (current.expired) await clearApproval()
    return {
      ok: false,
      error: current.expired
        ? '该重启请求已过期（超时未确认），没有执行重启；请让发起方重新提交。'
        : '当前没有待批准的重启请求（可能已被处理）。',
    }
  }
  if (current.approval.id !== id) {
    return { ok: false, error: '请求 id 不匹配（可能是一个已被替换的旧请求），没有执行任何操作。' }
  }
  await clearApproval()
  if (decision === 'deny') return { ok: true, approval: current.approval, denied: true }
  return { ok: true, approval: current.approval }
}

/** Escape a string for an AppleScript double-quoted literal. */
function appleScriptString(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')
}

/**
 * Put a desktop notification on screen when a request is filed.
 *
 * The user may not be looking at the panel when an agent asks to restart, so
 * the request also has to reach them where they are. Best effort by design: a
 * machine without `osascript` (or with notifications muted) loses nothing but
 * the nudge — the request itself is already durable on disk.
 */
export function notifyApproval(approval: PendingApproval): void {
  if (process.platform !== 'darwin') return
  const title = 'DSH：有一个重启请求，等你确认'
  const detail = approval.reason === '' ? '（未填写原因）' : approval.reason
  const body = `原因：${detail}　→　打开「设置 → 重启」点「批准并重启」；不点就不会重启。`
  const script =
    `display notification "${appleScriptString(body)}" ` +
    `with title "${appleScriptString(title)}" sound name "Ping"`
  try {
    const child = spawn('osascript', ['-e', script], { detached: true, stdio: 'ignore' })
    child.on('error', () => undefined)
    child.unref()
  } catch {
    /* notification is a nudge, never a failure */
  }
}
