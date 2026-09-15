import type { Context } from '@deepseek-ai/cordis'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { join } from 'node:path'
import { createDeepSeekHarnessBridge, type DeepSeekHarnessBridge, type DshPreStepPayloadLike, type DshSessionLike } from '../../vendor/memos-core/index.js'
import type { MemoryCore } from '../../vendor/memos-core/index.js'
import { sessionScope, type SessionScope } from '../privacy/scope.js'
import type { PrivacyPolicy } from '../privacy/policy.js'
import { openScopedMemory } from './core.js'
import { requireAgent, requireWorkspace, type JsonValue } from '../privacy/execution.js'

interface Entry { core: MemoryCore; bridge: DeepSeekHarnessBridge; scope: SessionScope }
export interface MemoryManagerOptions {
  root: string
  profileId: string
  policy: PrivacyPolicy
  recallTimeoutMs: number
  contextMaxChars: number
}

export class MemoryManager {
  private entries = new Map<string, Promise<Entry>>()
  private active = new Set<Promise<unknown>>()
  private disposed = false
  private disposal?: Promise<void>
  constructor(private readonly options: MemoryManagerOptions) {}
  async get(workspace: string): Promise<Entry> {
    if (this.disposed || this.options.policy.sensitiveMode) throw new Error('MEMORY_UNAVAILABLE')
    const scope = sessionScope(this.options.profileId, workspace)
    let pending = this.entries.get(scope.key)
    if (!pending) {
      if (this.entries.size >= 32) throw new Error('MEMORY_SCOPE_LIMIT')
      pending = this.open(scope)
      this.entries.set(scope.key, pending)
      void pending.catch(() => this.entries.delete(scope.key))
    }
    return pending
  }
  /** Register work before yielding so shutdown cannot close an accepted job's DB. */
  run<T>(workspace: string, operation: (entry: Entry) => T | Promise<T>): Promise<T> {
    if (this.disposed) return Promise.reject(new Error('MEMORY_UNAVAILABLE'))
    const running = this.get(workspace).then(operation)
    this.active.add(running)
    void running.then(() => this.active.delete(running), () => this.active.delete(running))
    return running
  }
  private async open(scope: SessionScope): Promise<Entry> {
    const core = await openScopedMemory(join(this.options.root, scope.key), scope, this.options.policy.queryLogEnabled)
    const bridge = createDeepSeekHarnessBridge({
      core, profileId: scope.key,
      recallEnabled: this.options.policy.recallEnabled,
      captureEnabled: this.options.policy.captureEnabled,
      recallTimeoutMs: this.options.recallTimeoutMs, contextMaxChars: this.options.contextMaxChars,
      createRecallMessage: text => createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'plugin', plugin: 'memosbox-native', form: 'recall' } }),
    })
    // Override the documented bridge seam: a session's agentPreset may not
    // replace this profile+workspace's physical and logical namespace.
    bridge.namespaceFor = session => ({ agentKind: 'deepseek-harness', profileId: scope.key, workspaceId: scope.workspaceId, sessionKey: session.id })
    return { core, bridge, scope }
  }
  dispose(): Promise<void> {
    if (this.disposal) return this.disposal
    this.disposed = true
    return this.disposal = this.close()
  }
  private async close(): Promise<void> {
    await Promise.allSettled(this.active)
    const entries = await Promise.allSettled(this.entries.values())
    this.entries.clear()
    const closed = await Promise.allSettled(entries.filter((x): x is PromiseFulfilledResult<Entry> => x.status === 'fulfilled').map(x => x.value.bridge.dispose()))
    if (closed.some(x => x.status === 'rejected')) throw new Error('MEMORY_SHUTDOWN_FAILED')
  }
}

export const MEMORY_OUTPUT = {
  schema: { type: 'object' as const, additionalProperties: true as const, properties: { text: { type: 'string' as const, required: true as const } } },
  render: (_args: unknown, value: unknown) => [{ type: 'text' as const, text: JSON.stringify(value) }],
}
function result(text: string, data: unknown): { text: string; data: JsonValue } {
  return { text, data: JSON.parse(JSON.stringify(data)) as JsonValue }
}

/** Reuses the official lifecycle bridge, with per-workspace databases and no
 * capture/event subscription until the corresponding policy is explicitly on.
 */
export function registerMemory(ctx: Context, manager: MemoryManager, policy: PrivacyPolicy, maxChars: number): () => void {
  const off: Array<() => void> = []
  if (policy.sensitiveMode) return () => undefined
  if (policy.recallEnabled) off.push(ctx.on('agent/pre-step', async (payload, next) => {
    // Preserve the waterfall's exactly-once decision even when recall fails.
    let downstream: ReturnType<typeof next> | undefined
    const once = () => downstream ??= next()
    try {
      // Upstream uses structural, unbranded mirror types; the actual objects
      // and returned messages remain the original DSH instances.
      return await manager.run(requireWorkspace(payload.agent.session.header.cwd), entry => entry.bridge.beforeStep(payload as unknown as DshPreStepPayloadLike, once as unknown as Parameters<DeepSeekHarnessBridge['beforeStep']>[1])) as Awaited<ReturnType<typeof next>>
    } catch {
      ctx.logger.warn('memosbox: memory recall unavailable (details omitted)')
      return once()
    }
  }))
  if (policy.captureEnabled) {
    off.push(ctx.on('session/event', (session, event) => {
      if (!session.header.cwd) return
      void manager.run(session.header.cwd, entry => entry.bridge.onSessionEvent(session as unknown as DshSessionLike, event)).catch(() => ctx.logger.warn('memosbox: capture unavailable (details omitted)'))
    }))
    off.push(ctx.on('session/disposed', session => {
      if (!session.header.cwd) return
      void manager.run(session.header.cwd, entry => entry.bridge.closeSession(session as unknown as DshSessionLike)).catch(() => ctx.logger.warn('memosbox: session cleanup failed'))
    }))
  }
  if (policy.memoryToolsEnabled) {
    off.push(ctx.tools.register(defineTool({
      name: 'memos_search', description: 'Search this profile/workspace by original literal terms, not semantic translation. Empty translated searches do not prove absence. If the corresponding verified Wiki page has a MemOS lookup ID, use memos_get on that ID; otherwise retry its original name/code without changing entity scope.',
      parameters: { query: { type: 'string', required: true }, maxResults: { type: 'integer' } }, output: MEMORY_OUTPUT,
      isConcurrencySafe: () => true,
      async execute(args, exec) {
        requireAgent(exec)
        exec.signal.throwIfAborted()
        if (!args.query.trim() || args.query.length > 4000) throw new TypeError('Invalid memory query')
        const limit = Math.min(50, Math.max(1, args.maxResults ?? 5))
        const found = await manager.run(requireWorkspace(exec.agent.session.header.cwd), ({ core, scope }) => core.searchMemory({ agent: 'deepseek-harness', namespace: { agentKind: 'deepseek-harness', profileId: scope.key }, query: args.query, reason: 'tool_driven', topK: { tier1: limit, tier2: limit, tier3: limit } }, { signal: exec.signal, foreground: true }))
        exec.signal.throwIfAborted()
        return result(found.hits.length ? '在当前作用域的持久化 MemOS 数据库中找到记忆。历史回答中的保存承诺不是当前存储状态证据。' : '当前词法查询未命中，不代表没有保存。查询不自动翻译；如对应 Wiki 页有 MemOS lookup ID，请用 memos_get 实际核对；否则使用该页证实的原始指标名/代码重试，保持工作区和项目范围。', { mode: 'lexical', automaticTranslation: false, captureEnabled: policy.captureEnabled, persistence: 'stored-memory', hits: found.hits.slice(0, limit).map(hit => ({ ...hit, snippet: hit.snippet.slice(0, maxChars), truncated: hit.snippet.length > maxChars })) })
      },
    })))
    off.push(ctx.tools.register(defineTool({
      name: 'memos_get', description: 'Read one memory trace from the current profile and workspace.',
      parameters: { id: { type: 'string', required: true } }, output: MEMORY_OUTPUT, isConcurrencySafe: () => true,
      async execute(args, exec) {
        requireAgent(exec)
        exec.signal.throwIfAborted()
        if (!args.id.trim() || args.id.length > 128) throw new TypeError('Invalid memory ID')
        const row = await manager.run(requireWorkspace(exec.agent.session.header.cwd), ({ core, scope }) => core.getTrace(args.id, { agentKind: 'deepseek-harness', profileId: scope.key }))
        exec.signal.throwIfAborted()
        return result(row ? '已读到当前作用域的持久化 MemOS 记录；对话记忆不等于人工批准的正式知识，历史“没保存”的说法不能推翻此读取证据。' : '当前作用域未找到此记忆。', row ? { id: row.id, text: row.agentText.slice(0, maxChars), truncated: row.agentText.length > maxChars, tags: row.tags ?? [], persistence: 'stored-memory-trace', captureEnabled: policy.captureEnabled } : { found: false })
      },
    })))
  }
  return () => {
    const errors: unknown[] = []
    for (const dispose of off.splice(0).reverse()) { try { dispose() } catch (error) { errors.push(error) } }
    if (errors.length) throw new AggregateError(errors, 'MEMORY_UNREGISTER_FAILED')
  }
}
