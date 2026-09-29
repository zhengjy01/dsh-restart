/**
 * dsh-restart — model-facing tools.
 *
 *   dsh_restart_status  read-only: host identity, live helper state, the lines
 *                       of the last boot log that look like errors, and any
 *                       restart request still waiting for the user.
 *   dsh_restart         file (or, with the gate off, perform) a restart.
 *
 * The write tool demands `confirm: true` because restarting DSH ends the current
 * turn and the session's connection — but that flag is only the caller
 * describing itself; it proves nothing and unlocks nothing. So by default the
 * tool does not restart anything: it files a request (see ./approval.ts) that
 * only the user can turn into a restart, by clicking 「批准并重启」 in the web
 * panel. The click is the consent; the claim is not.
 */

import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import { defineTool, type ToolDefinition } from '@deepseek-ai/dsh-tools'

import { loadConfig, readHistory } from './config.ts'
import { createApproval, notifyApproval, readApproval } from './approval.ts'
import {
  hostInfo,
  newestLogFile,
  readHelperStatus,
  requestRestart,
  scheduleSelfExit,
  tailFile,
} from './restart.ts'
import type { RouteContext } from './routes.ts'

/** One text content block (the only render shape these tools emit). */
function text(value: string): ContentBlock[] {
  return [{ type: 'text', text: value }]
}

/** Render the tool's `message` field. */
function renderMessage(_args: unknown, value: Record<string, unknown>): ContentBlock[] {
  return text(String(value.message ?? ''))
}

/** Clamp a model-supplied integer. */
function clampInt(value: unknown, fallback: number, min: number, max: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback
  return Math.max(min, Math.min(max, Math.floor(value)))
}

/** Shared tool dependencies. */
export interface ToolContext {
  /** Where this host listens. */
  endpoint: RouteContext
}

/** One-line description of a helper phase. */
function phaseLine(status: { phase?: string; attempt?: number; maxAttempts?: number; elapsedMs?: number } | null): string {
  if (status === null) return ''
  const label = status.phase ?? 'unknown'
  const attempt = status.attempt ?? 1
  const max = status.maxAttempts ?? 1
  const elapsed = typeof status.elapsedMs === 'number' ? `，已 ${(status.elapsedMs / 1000).toFixed(1)}s` : ''
  return `重启助手：${label}（第 ${attempt}/${max} 次尝试${elapsed}）`
}

/** Tool: restart status, live helper state, last boot errors. */
export function restartStatusTool(ctx: ToolContext): ToolDefinition {
  return defineTool({
    name: 'dsh_restart_status',
    description:
      '查看 DSH 宿主与 dsh-restart 插件的重启状态：宿主 pid/端口/版本/启动时长/启动命令、是否有重启助手在运行（以及它当前处于哪个阶段、上次尝试的失败原因）、最近几次重启记录、以及最近一次启动日志里疑似报错的行。不会重启任何东西。',
    parameters: {
      lines: { type: 'number', description: '启动日志返回的行数（默认 40，范围 10-400）' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true },
          message: { type: 'string', required: true },
          pid: { type: 'number' },
          port: { type: 'number' },
          url: { type: 'string' },
          dshVersion: { type: 'string' },
          nodeVersion: { type: 'string' },
          uptimeMs: { type: 'number' },
          command: { type: 'string' },
          helperAlive: { type: 'boolean' },
          helperPhase: { type: 'string' },
          helperFailure: { type: 'string' },
          consoleUrl: { type: 'string' },
          logFile: { type: 'string' },
          errorLines: { type: 'array' },
          history: { type: 'array' },
          /** True while an agent's restart request is waiting for the user. */
          pendingApproval: { type: 'boolean' },
          approvalId: { type: 'string' },
          approvalReason: { type: 'string' },
          approvalExpiresAt: { type: 'string' },
          requireApproval: { type: 'boolean' },
        },
      },
      render: renderMessage,
    },
    async execute(args: unknown) {
      const input = (args ?? {}) as { lines?: unknown }
      const lines = clampInt(input.lines, 40, 10, 400)
      const { config } = await loadConfig()
      const host = await hostInfo(ctx.endpoint)
      const helper = await readHelperStatus()
      const approval = await readApproval()
      const logFile = await newestLogFile()
      const tail = logFile === null
        ? { file: '', exists: false, errorLines: [] as string[], lines: [] as string[], text: '', mtime: '' }
        : await tailFile(logFile, lines)
      const history = await readHistory(5)
      const failure = helper.status?.failure?.message ?? ''
      const pending = approval.approval
      const parts = [
        `宿主：pid ${host.pid}，${host.url}，DSH ${host.dshVersion || '未知版本'}，Node ${host.nodeVersion}`,
        `已运行 ${(host.uptimeMs / 1000).toFixed(0)}s`,
        helper.alive ? phaseLine(helper.status) : '当前没有重启助手在运行',
        failure === '' ? '' : `上次重启失败：${failure}`,
        pending === null
          ? approval.expired
            ? '上一个重启请求已过期（未被批准）'
            : config.requireApproval
              ? '当前没有待批准的重启请求'
              : '注意：重启闸门已关闭（requireApproval=false），agent 可要求直接重启'
          : `有 1 个待批准的重启请求（原因：${pending.reason || '未填写'}，提交于 ${pending.at}，` +
            `有效期至 ${pending.expiresAt}）— 需用户在网页面板点「批准并重启」`,
        tail.exists && tail.errorLines.length > 0
          ? `上次启动日志有 ${tail.errorLines.length} 行疑似报错（${tail.file}）`
          : tail.exists
            ? '上次启动日志未发现明显报错'
            : '暂无启动日志',
      ].filter((part) => part !== '')
      return {
        ok: true,
        message: 'dsh-restart：' + parts.join('；') + '。',
        pid: host.pid,
        port: host.port,
        url: host.url,
        dshVersion: host.dshVersion,
        nodeVersion: host.nodeVersion,
        uptimeMs: host.uptimeMs,
        command: host.command,
        helperAlive: helper.alive,
        helperPhase: helper.status?.phase ?? '',
        helperFailure: failure,
        consoleUrl: `http://${ctx.endpoint.host}:${config.fallbackPort}`,
        logFile: tail.file,
        errorLines: tail.errorLines.slice(-25),
        history: history.map(
          (record) =>
            `${record.at} · ${record.source}${record.reason === '' ? '' : '（' + record.reason + '）'} · ` +
            `pid ${record.oldPid} → 助手 ${record.helperPid ?? '—'} · ${record.outcome ?? 'unknown'}`,
        ),
        pendingApproval: pending !== null,
        approvalId: pending?.id ?? '',
        approvalReason: pending?.reason ?? '',
        approvalExpiresAt: pending?.expiresAt ?? '',
        requireApproval: config.requireApproval,
      }
    },
  })
}

/** Tool: restart the host. */
export function restartTool(ctx: ToolContext): ToolDefinition {
  return defineTool({
    name: 'dsh_restart',
    description:
      '请求重启 DSH 宿主。**本工具默认不会自己重启**：它只提交一个「待批准请求」，由用户本人在网页面板「设置 → 重启」（或侧边栏「重启」入口）亲手点「批准并重启」之后，才交给分离的重启助手执行（助手会等端口释放后用完全相同的命令拉起新的 DSH，并提供恢复控制台，默认 http://127.0.0.1:3099）。因此：①调用前仍必须先征得用户明确同意，并设 confirm: true（这只是你的声明，不构成许可，工具不会据此直接重启）；②提交后**必须在回复里告诉用户去点确认**，并说明原因；③返回 pendingApproval: true 表示请求已提交、**宿主尚未重启**，不要重复提交。只有在用户把 requireApproval 配置关掉（显式撤销闸门）时，本工具才会直接执行重启。**一旦真重启，当前回合与当前会话的连接会立即中断。**',
    parameters: {
      confirm: { type: 'boolean', description: '必须为 true 才提交请求（表示你已向用户说明并征得其同意）' },
      reason: { type: 'string', description: '重启原因（会展示在待批准卡片与重启历史里，用户据此决定是否批准）' },
      origin: { type: 'string', description: '可选：发起方上下文（会话名/工作区），仅用于在确认卡片上告诉用户是谁在请求' },
      delayMs: { type: 'number', description: '仅闸门关闭、直接执行时有效：回包后多少毫秒再退出本进程（默认 1500）' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true },
          message: { type: 'string', required: true },
          helperPid: { type: 'number' },
          logFile: { type: 'string' },
          consoleUrl: { type: 'string' },
          exitInMs: { type: 'number' },
          scheduled: { type: 'boolean' },
          /** True when the request was filed and now waits for the user's click. */
          pendingApproval: { type: 'boolean' },
          approvalId: { type: 'string' },
          expiresAt: { type: 'string' },
        },
      },
      render: renderMessage,
    },
    async execute(args: unknown) {
      const input = (args ?? {}) as {
        confirm?: unknown
        reason?: unknown
        origin?: unknown
        delayMs?: unknown
      }
      if (input.confirm !== true) {
        return {
          ok: false,
          scheduled: false,
          pendingApproval: false,
          approvalId: '',
          expiresAt: '',
          message:
            '未提交重启请求：dsh_restart 需要 confirm: true。请先征得用户明确同意——本机铁律规定未经同意不得重启 DSH。',
          helperPid: 0,
          logFile: '',
          consoleUrl: '',
          exitInMs: 0,
        }
      }
      const { config } = await loadConfig()
      const reason = typeof input.reason === 'string' && input.reason !== '' ? input.reason : 'agent tool'
      const origin = typeof input.origin === 'string' && input.origin !== '' ? input.origin : ''
      const ttlMs = config.approvalTtlMinutes * 60_000

      // The gate. An agent's `confirm` is a claim about itself; the only
      // consent this plugin can verify is the user's click on the panel, so the
      // request is filed and nothing else happens until that click arrives.
      if (config.requireApproval) {
        const { approval, replaced } = await createApproval({
          reason,
          ttlMs,
          claimedConsent: true,
          source: 'agent',
          ...(origin === '' ? {} : { origin }),
        })
        if (config.notifyOnApproval) notifyApproval(approval)
        const until = new Date(approval.expiresAt).toLocaleString('zh-CN', { hour12: false })
        return {
          ok: true,
          scheduled: false,
          pendingApproval: true,
          approvalId: approval.id,
          expiresAt: approval.expiresAt,
          message:
            `已提交「重启请求」，**尚未重启**（原因：${reason}；${origin === '' ? '' : `发起方：${origin}；`}` +
            `有效期至 ${until}，共 ${config.approvalTtlMinutes} 分钟）` +
            `${replaced === null ? '' : '——已替换上一个未处理的请求'}。` +
            '请现在告诉用户：打开网页面板「设置 → 重启」（或侧边栏「重启」入口），点「批准并重启」；' +
            '在他亲手点之前宿主不会有任何动作，超时未确认则请求自动作废。不要重复提交同一请求。',
          helperPid: 0,
          logFile: '',
          consoleUrl: '',
          exitInMs: 0,
        }
      }

      // The user turned the gate off: the old "confirm and go" path.
      const exitDelayMs = clampInt(input.delayMs, 1500, 200, 30_000)
      const outcome = await requestRestart({
        config,
        port: ctx.endpoint.port,
        host: ctx.endpoint.host,
        url: ctx.endpoint.url,
        source: 'agent',
        reason,
        exitDelayMs,
      })
      if (!outcome.ok) {
        return {
          ok: false,
          scheduled: false,
          pendingApproval: false,
          approvalId: '',
          expiresAt: '',
          message: '重启失败（未执行）：' + outcome.error,
          helperPid: 0,
          logFile: outcome.logFile,
          consoleUrl: outcome.fallbackUrl,
          exitInMs: 0,
        }
      }
      // The tool result has to land before the process goes away.
      void outcome.commit()
      return {
        ok: true,
        scheduled: true,
        pendingApproval: false,
        approvalId: '',
        expiresAt: '',
        message:
          `已安排重启（原因：${reason}；方式：${outcome.mode === 'launchd' ? 'launchd 托管重启' : '分离助手自拉起'}）。重启助手 pid ${outcome.helperPid ?? '?'}` +
          `${outcome.mode === 'launchd' ? '，由助手在回包后 kickstart 托管任务' : `，约 ${outcome.exitInMs}ms 后本进程退出`}；` +
          `新宿主启动日志：${outcome.logFile}；若启动失败，恢复控制台 http://${ctx.endpoint.host}:${outcome.fallbackPort} 会显示报错。` +
          '当前回合将随进程结束而中断，网页端会自动重连刷新。',
        helperPid: outcome.helperPid ?? 0,
        logFile: outcome.logFile,
        consoleUrl: outcome.fallbackUrl,
        exitInMs: outcome.exitInMs,
      }
    },
  })
}

/** Build the tool roster. */
export function buildTools(ctx: ToolContext): ToolDefinition[] {
  return [restartStatusTool(ctx), restartTool(ctx)]
}
