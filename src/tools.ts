/**
 * dsh-restart — model-facing tools.
 *
 *   dsh_restart_status  read-only: host identity, live helper state, and the
 *                       lines of the last boot log that look like errors.
 *   dsh_restart         restart the host through the detached helper.
 *
 * The write tool demands `confirm: true`, because restarting DSH ends the
 * current turn and the current session's connection: an agent must have asked
 * the user first (the local standing rule is that DSH is never restarted
 * without explicit consent).
 */

import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import { defineTool, type ToolDefinition } from '@deepseek-ai/dsh-tools'

import { loadConfig, readHistory } from './config.ts'
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
      const logFile = await newestLogFile()
      const tail = logFile === null
        ? { file: '', exists: false, errorLines: [] as string[], lines: [] as string[], text: '', mtime: '' }
        : await tailFile(logFile, lines)
      const history = await readHistory(5)
      const failure = helper.status?.failure?.message ?? ''
      const parts = [
        `宿主：pid ${host.pid}，${host.url}，DSH ${host.dshVersion || '未知版本'}，Node ${host.nodeVersion}`,
        `已运行 ${(host.uptimeMs / 1000).toFixed(0)}s`,
        helper.alive ? phaseLine(helper.status) : '当前没有重启助手在运行',
        failure === '' ? '' : `上次重启失败：${failure}`,
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
      }
    },
  })
}

/** Tool: restart the host. */
export function restartTool(ctx: ToolContext): ToolDefinition {
  return defineTool({
    name: 'dsh_restart',
    description:
      '重启 DSH 宿主（网页端会自动重连并刷新）：把重启交给一个分离的重启助手，它等端口释放后用完全相同的命令重新拉起 DSH，并在此期间提供一个恢复控制台（默认 http://127.0.0.1:3099）显示启动进度与报错。**重启会立即中断当前回合与当前会话的连接**，因此必须先获得用户明确同意再调用，并设置 confirm: true；未确认时本工具只返回提示不执行。安装/更新插件后需要让新代码生效时用本工具。',
    parameters: {
      confirm: { type: 'boolean', description: '必须为 true 才真正执行（表示已获得用户同意）' },
      reason: { type: 'string', description: '重启原因（会记录进重启历史）' },
      delayMs: { type: 'number', description: '回包后多少毫秒再退出本进程（默认 1500，给当前回合留出落盘时间）' },
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
        },
      },
      render: renderMessage,
    },
    async execute(args: unknown) {
      const input = (args ?? {}) as { confirm?: unknown; reason?: unknown; delayMs?: unknown }
      if (input.confirm !== true) {
        return {
          ok: false,
          scheduled: false,
          message:
            '未执行重启：dsh_restart 需要 confirm: true。请先用 ask_user_question（或口头）征得用户明确同意——本机铁律规定未经同意不得重启 DSH。',
          helperPid: 0,
          logFile: '',
          consoleUrl: '',
          exitInMs: 0,
        }
      }
      const { config } = await loadConfig()
      const reason = typeof input.reason === 'string' && input.reason !== '' ? input.reason : 'agent tool'
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
