import type { Context } from '@deepseek-ai/cordis'
import { defineTool, type ToolRunContext, type ToolDefinition } from '@deepseek-ai/dsh-tools'
import { join } from 'node:path'
import type {} from '@deepseek-ai/dsh-user-approval'
import type { MirobodyExecutor } from './types.js'
import { JobStore } from './job-store.js'
import { makeCandidate, verifyCandidate, candidateMarkdown, type ImportCandidate } from './candidates.js'
import { requestApproval, type ApprovalOutcome } from './approval.js'
import { commitCandidate } from './commit.js'
import { authorizedSource } from './documents.js'
import { extractWithDsh } from './extraction.js'
import { assertNonSensitiveMode } from '../privacy/policy.js'
import type { SessionScope } from '../privacy/scope.js'
import type { WikiAdapter } from '../wiki/adapter.js'
import type { MemoryManager } from '../memory/manager.js'
import { writeApprovedMemory } from '../memory/approved-writer.js'
import { requireAgent, requireWorkspace, type JsonValue } from '../privacy/execution.js'

export interface MirobodyToolOptions {
  provider: MirobodyExecutor
  dataRoot: string
  sourceRoot: string
  sensitiveMode: boolean
  syntheticDocumentsEnabled: boolean
  modelExtractionEnabled: boolean
  wikiWriteEnabled: boolean
  explicitMemoryWriteEnabled: boolean
  scope: (exec: ToolRunContext) => SessionScope
  wiki: (exec: ToolRunContext) => Promise<WikiAdapter>
  memory?: MemoryManager
}
const OUTPUT = {
  schema: { type: 'object' as const, additionalProperties: true as const, properties: { text: { type: 'string' as const, required: true as const } } },
  render: (_args: unknown, value: unknown) => [{ type: 'text' as const, text: JSON.stringify(value) }],
}
function output(text: string, data: unknown): { text: string; data: JsonValue } {
  return { text: `${text} 本回执仅描述指定业务步骤；DSH 会话历史、工具结果及日志仍可能持久化，不能据此声称没有任何存储或文件改动。`, data: JSON.parse(JSON.stringify(data)) as JsonValue }
}
export function approvalSummary(decisions: Array<{ stage: string; outcome: ApprovalOutcome }>): string {
  const labels: Record<string, string> = { sourceRead: '本地源文件读取', modelTransmission: '向提取模型外发', wikiWrite: '本地 Wiki 写入', memoryWrite: '本地 MemOS 写入' }
  const outcomes: Record<ApprovalOutcome, string> = { 'allowed-once': '单独获批一次', rejected: '被拒绝', cancelled: '被取消（不是拒绝）', unavailable: '审批不可用，未获批' }
  return decisions.length ? decisions.map(d => `${labels[d.stage] ?? d.stage}：${outcomes[d.outcome]}`).join('；') + '。以上每项是独立审批，仅涵盖本工具调用。批准不等于已经写入。' : '本工具调用没有请求审批。'
}
function candidateInputHint(value: string) {
  if (/^[a-f0-9-]{36}$/.test(value)) return undefined
  return output('预览/提交需要解析成功后返回的 candidateId，不是源文件 sourceId。先解析源文件，获得候选再预览，不要猜测候选编号。', { status: 'invalid_input', error: 'INVALID_CANDIDATE_ID', nextTool: 'mirobody_parse_document', ...( /^[a-f0-9-]{32,64}\.(txt|pdf|xlsx)$/.test(value) ? { sourceId: value } : {}), performed: false })
}
function id(value: string): string {
  if (!/^[a-f0-9-]{36}$/.test(value)) throw new Error('INVALID_CANDIDATE_ID')
  return value
}

export function registerMirobodyTools(ctx: Context, options: MirobodyToolOptions): () => Promise<void> {
  const off: Array<() => void> = []
  const closing = new AbortController()
  const active = new Set<Promise<unknown>>()
  let disposal: Promise<void> | undefined
  const durableOutcomes = new WeakMap<object, ReturnType<typeof output>>()
  const executionSignals = new WeakMap<object, AbortSignal>()
  const finalizeDurable: NonNullable<ToolDefinition['finalizeContent']> = (exec, finalResult) => {
    const durable = durableOutcomes.get(exec)
    durableOutcomes.delete(exec)
    const signal = executionSignals.get(exec)
    executionSignals.delete(exec)
    if (!durable || !finalResult.isError || !signal?.aborted) return undefined
    return [{ type: 'text', text: JSON.stringify({ ...durable, transportCanceled: exec.signal.aborted, pluginClosing: closing.signal.aborted }) }]
  }
  const register = (tool: ToolDefinition) => {
    off.push(ctx.tools.register({ ...tool, async execute(args, exec) {
      if (closing.signal.aborted) throw new Error('MIROBODY_PLUGIN_CLOSED')
      const signal = AbortSignal.any([exec.signal, closing.signal])
      signal.throwIfAborted()
      // DSH finalizes with its original execution object. Only the tool body
      // receives the combined signal; transfer durable outcomes back to that
      // original identity before the runtime renders cancellation.
      const scopedExec: ToolRunContext = { ...exec, signal }
      executionSignals.set(exec, signal)
      const task = (async () => {
        try {
          const value = await tool.execute(args, scopedExec)
          if (!durableOutcomes.has(scopedExec)) signal.throwIfAborted()
          return value
        } finally {
          const durable = durableOutcomes.get(scopedExec)
          if (durable) durableOutcomes.set(exec, durable)
          durableOutcomes.delete(scopedExec)
        }
      })()
      active.add(task)
      try { return await task } finally { active.delete(task) }
    } }))
  }
  const storeFor = (exec: ToolRunContext) => new JobStore(join(options.dataRoot, 'scopes', options.scope(exec).key, 'imports'), undefined, options.dataRoot)
  const load = async (exec: ToolRunContext, candidateId: string) => {
    exec.signal.throwIfAborted()
    const store = storeFor(exec)
    const candidate = await store.read<ImportCandidate>(`candidates/${id(candidateId)}.json`)
    if (!candidate) throw new Error('CANDIDATE_NOT_FOUND')
    verifyCandidate(candidate, options.scope(exec))
    exec.signal.throwIfAborted()
    return { candidate, store }
  }
  try {
    register(defineTool({
      name: 'mirobody_status', description: 'Inspect the pinned local Python/Mirobody runtime, offline resources and supported isolation. Does not install or start an HTTP service.',
      parameters: {}, output: OUTPUT, isConcurrencySafe: () => true,
      async execute(_args, exec) {
        requireAgent(exec)
        const status = await options.provider.status({ signal: exec.signal, session: exec.agent.session })
        return output('Mirobody runtime status.', { ...status, realHealthDataReady: false, documentMode: options.syntheticDocumentsEnabled ? 'synthetic-only' : 'disabled' })
      },
    }))
    register(defineTool({
      name: 'mirobody_resolve', description: 'Resolve a public indicator name locally to LOINC, or inspect device metric metadata. Not a diagnosis or validated clinical mapping.',
      parameters: { name: { type: 'string', required: true }, value: { type: 'string' }, unit: { type: 'string' }, metricInfo: { type: 'boolean', description: 'Default false. Keep false for clinical indicator names or LOINC lookup. True ONLY inspects the separate device-metric metadata catalog and cannot resolve a clinical LOINC name.' } },
      output: OUTPUT, isConcurrencySafe: () => false,
      async execute(args, exec) {
        requireAgent(exec)
        assertNonSensitiveMode(options.sensitiveMode)
        const result = await options.provider.execute(args.metricInfo ? 'metric_info' : 'resolve', args.metricInfo ? { name: args.name } : { rawName: args.name, ...(args.value === undefined ? {} : { rawValue: args.value }), ...(args.unit === undefined ? {} : { rawUnit: args.unit }) }, { signal: exec.signal, session: exec.agent.session })
        if (args.metricInfo) return output('本次只查询设备指标元数据目录，并未执行临床 LOINC 编码匹配。metric=null 不能解释为没有 LOINC 映射；如问题是临床指标编号，请用同一名称、metricInfo=false 再调用本工具。', { ...result, queryDomain: 'device-metadata-only', loincMappingAttempted: false, clinicalLookup: { name: args.name, metricInfo: false } })
        return output('当前本地词典解析结果，非临床验证。未匹配不代表所有标准均不存在；单候选仍需与名称/标本/量纲核对。本工具不执行显式 Wiki/MemOS 提交；自动捕获取决于配置，DSH 会话记录仍可能持久化。', result)
      },
    }))
    register(defineTool({
      name: 'mirobody_normalize_readings', description: 'Normalize a bounded batch of non-sensitive readings using the real local Mirobody library. Raw values and units are retained; no automatic save.',
      parameters: { readings: { type: 'array', required: true, items: { type: 'object', additionalProperties: false, properties: { rawName: { type: 'string', required: true }, rawValue: { type: 'string' }, rawUnit: { type: 'string' } } } } },
      output: OUTPUT, isConcurrencySafe: () => false,
      async execute(args, exec) {
        requireAgent(exec)
        assertNonSensitiveMode(options.sensitiveMode)
        return output('本地规范化结果：保留原始读数，不作算术换算或显式业务提交；自动捕获取决于配置，宿主仍可能记录会话与工具结果。', await options.provider.execute('normalize_readings', { readings: args.readings }, { signal: exec.signal, session: exec.agent.session }))
      },
    }))
    register(defineTool({
      name: 'mirobody_parse_document', description: 'FIRST step for a staged synthetic sourceId (hash plus .txt/.pdf/.xlsx). Set useModel=true to extract readings with the current model. Returns candidateId for subsequent preview, then commit. Requests source reading and model transmission independently. Not for real health data.',
      finalizeContent: finalizeDurable,
      parameters: { sourceId: { type: 'string', required: true }, useModel: { type: 'boolean' } }, output: OUTPUT, isConcurrencySafe: () => false,
      async execute(args, exec) {
        requireAgent(exec)
        assertNonSensitiveMode(options.sensitiveMode)
        const approvalDecisions: Array<{ stage: string; outcome: ApprovalOutcome }> = []
        const effects = { sourceRead: false, modelDispatched: false, candidateStored: false, wikiCommitted: false, memoryCommitted: false }
        const finish = (text: string, data: Record<string, unknown>) => output(text, { ...data, approvalDecisions, approvalSummary: approvalSummary(approvalDecisions), effects })
        if (!options.syntheticDocumentsEnabled) return finish('文档处理未启用。', { status: 'unavailable' })
        const readOutcome = ctx.approval ? await ctx.approval.request({ agent: exec.agent, toolName: 'mirobody_parse_document', reason: `Read staged synthetic source ${args.sourceId} into private local candidate storage? This does not authorize a model request or Wiki/Memory import.`, signal: exec.signal }) : 'unavailable'
        approvalDecisions.push({ stage: 'sourceRead', outcome: readOutcome })
        if (readOutcome !== 'allowed-once') return finish('读取授权未通过，未读取源文件，也未进入模型外发或业务提交。', { status: 'refused' })
        exec.signal.throwIfAborted()
        const source = await authorizedSource(options.sourceRoot, args.sourceId)
        effects.sourceRead = true
        const extracted = await options.provider.execute('extract_document', { sourcePath: source.path, sourceDigest: source.digest, format: source.format }, { signal: exec.signal, session: exec.agent.session })
        if (!extracted.segments || extracted.sourceDigest !== source.digest) return finish('Document extraction did not produce verified segments.', { status: extracted.status, warnings: extracted.warnings, error: extracted.error })
        let readings = [] as NonNullable<ImportCandidate['readings']>
        const warnings = [...extracted.warnings]
        let normalizationPartial = false
        if (args.useModel) {
          if (!options.modelExtractionEnabled) return finish('Model extraction disabled.', { status: 'needs_model' })
          const modelOutcome = await ctx.approval.request({ agent: exec.agent, toolName: 'mirobody_parse_document', reason: `Send extracted text from source digest ${source.digest} to this DSH session's selected model? Provider handling and host logging may persist this synthetic content. No Wiki/Memory write is authorized.`, signal: exec.signal })
          approvalDecisions.push({ stage: 'modelTransmission', outcome: modelOutcome })
          if (modelOutcome !== 'allowed-once') return finish('源文件读取已经单独获批并完成；随后模型外发授权未通过，未向提取模型发送源文本，未创建候选，也未提交 Wiki/MemOS。', { status: 'refused' })
          exec.signal.throwIfAborted()
          effects.modelDispatched = true
          const raw = await extractWithDsh(ctx, exec, extracted.segments)
          exec.signal.throwIfAborted()
          if (raw.length) {
            const normalized = await options.provider.execute('normalize_readings', { readings: raw }, { signal: exec.signal, session: exec.agent.session })
            if (!normalized.readings || normalized.readings.length !== raw.length) return finish('Normalization incomplete.', { status: 'failed' })
            // Normalization may enrich a row, never change its literal source
            // fields or drop/reorder its evidence references.
            if (normalized.readings.some((reading, index) => {
              const original = raw[index]!
              return reading.rawName !== original.rawName || reading.rawValue !== original.rawValue || reading.rawUnit !== original.rawUnit
                || JSON.stringify(reading.evidenceRefs) !== JSON.stringify(original.evidenceRefs)
            })) return finish('Normalization provenance did not match the reviewed extraction.', { status: 'failed', error: 'NORMALIZATION_PROVENANCE_MISMATCH' })
            readings = normalized.readings
            warnings.push(...normalized.warnings, ...readings.flatMap(reading => reading.warnings))
            normalizationPartial = normalized.truncated || normalized.status !== 'ready' || readings.some(reading => reading.status !== 'ready')
          }
        } else warnings.push('needs_model: text extraction alone does not assert clinical readings')
        const candidate = makeCandidate({ scope: options.scope(exec), sourceDigest: source.digest, sourceId: args.sourceId, readings, segments: extracted.segments, warnings: [...new Set(warnings)], partial: extracted.truncated || extracted.status !== 'ready' || !args.useModel || normalizationPartial || warnings.length > 0 || !readings.length })
        exec.signal.throwIfAborted()
        await storeFor(exec).write(`candidates/${candidate.id}.json`, candidate)
        effects.candidateStored = true
        const result = finish('源文件已解析，候选已在插件私有目录持久化。读取与模型外发各自的审批见 approvalDecisions；尚未请求 Wiki/MemOS 写入审批。下一步用返回的 candidateId 预览。', { status: candidate.partial ? 'partial' : 'ready', candidateId: candidate.id, candidateDigest: candidate.digest, readingCount: readings.length, segmentCount: candidate.segments.length, warnings, truncated: extracted.truncated })
        durableOutcomes.set(exec, result)
        return result
      },
    }))
    register(defineTool({
      name: 'mirobody_preview_import', description: 'SECOND step: requires candidateId returned by mirobody_parse_document, NEVER a sourceId or filename. Locate the immutable local review artifact; does not emit source text or approve a write.',
      parameters: { candidateId: { type: 'string', required: true } }, output: OUTPUT, isConcurrencySafe: () => true,
      async execute(args, exec) {
        requireAgent(exec)
        const hint = candidateInputHint(args.candidateId)
        if (hint) return hint
        const { candidate, store } = await load(exec, args.candidateId)
        return output('Open the local JSON artifact to compare original evidence, normalized readings and destination.', { candidateId: candidate.id, candidateDigest: candidate.digest, reviewFile: await store.path(`candidates/${candidate.id}.json`), target: candidate.targetPath, expectedVersion: candidate.expectedVersion, partial: candidate.partial, readingCount: candidate.readings.length })
      },
    }))
    register(defineTool({
      name: 'mirobody_commit_import', description: 'Ask the user to approve an immutable reviewed candidate for Wiki and optionally MemOS, separately. Checks digest and scope; partial commits recover forward. Model-supplied approval flags are not accepted.',
      finalizeContent: finalizeDurable,
      parameters: { candidateId: { type: 'string', required: true }, includeMemory: { type: 'boolean' } }, output: OUTPUT, isConcurrencySafe: () => false,
      async execute(args, exec) {
        requireAgent(exec)
        assertNonSensitiveMode(options.sensitiveMode)
        const approvalDecisions: Array<{ stage: string; outcome: ApprovalOutcome }> = []
        const finish = (text: string, data: Record<string, unknown>) => output(text, { ...data, approvalDecisions, approvalSummary: approvalSummary(approvalDecisions), approvalScope: '本次提交只审批本地 Wiki/MemOS 写入，没有审批模型外发。不能把本地写入被拒说成模型外发被拒。读取与模型外发以此前解析回执为准。' })
        const hint = candidateInputHint(args.candidateId)
        if (hint) return hint
        if (!options.wikiWriteEnabled) return output('Wiki writes disabled.', { status: 'refused' })
        const { candidate, store } = await load(exec, args.candidateId)
        if (!candidate.readings.length || candidate.partial || candidate.readings.some(r => r.status !== 'ready')) return output('Candidate requires resolution and a new review before import.', { status: 'unresolved' })
        const wikiApproval = await requestApproval(ctx, exec, candidate, 'wiki', outcome => approvalDecisions.push({ stage: 'wikiWrite', outcome }))
        if (!wikiApproval) return finish('Wiki 写入审批未通过，本次未写入 Wiki/MemOS；之前的读取/外发审批以解析回执为准。', { status: 'refused', destinationsChanged: false })
        const includeMemory = args.includeMemory === true
        if (includeMemory && (!options.explicitMemoryWriteEnabled || !options.memory)) return finish('Explicit MemOS writes unavailable.', { status: 'unavailable', destinationsChanged: false })
        const memoryApproval = includeMemory ? await requestApproval(ctx, exec, candidate, 'memory', outcome => approvalDecisions.push({ stage: 'memoryWrite', outcome })) : undefined
        if (includeMemory && !memoryApproval) return finish('Wiki 审批已单独通过，但 MemOS 审批未通过，因此本次两个目的地均未写入。批准不等于已经执行写入。', { status: 'refused', destinationsChanged: false })
        const receipt = await commitCandidate({ candidate, store, wiki: await options.wiki(exec), sessionId: exec.agent.session.id, wikiApproval,
          ...(memoryApproval ? { memoryApproval } : {}), includeMemory, signal: exec.signal,
          ...(includeMemory && options.memory ? { writeMemory: async () => {
            return options.memory!.run(requireWorkspace(exec.agent.session.header.cwd), async ({ core, scope }) =>
              writeApprovedMemory(core, { operationId: candidate.operationId, candidateDigest: candidate.digest, scope, text: candidateMarkdown(candidate, true) }))
          } } : {}),
        })
        // Approval internals stay private; receipts contain only identifiers.
        const result = finish(receipt.state === 'complete' ? '业务提交已完成；Wiki 和 MemOS（如请求）分别经过独立审批，不是同一次批准。按各目的地回执报告实际持久化状态。' : 'Import requires verification/recovery.', { status: receipt.state, operationId: receipt.operationId, candidateDigest: receipt.candidateDigest, wiki: receipt.wiki, memory: receipt.memory, error: receipt.error })
        durableOutcomes.set(exec, result)
        return result
      },
    }))
  } catch (error) { closing.abort(new Error('MIROBODY_PLUGIN_CLOSED')); try { disposeAll(off) } catch { /* Preserve the registration failure. */ } throw error }
  return () => {
    if (disposal) return disposal
    // Close admission synchronously, then cancel and drain accepted jobs.
    closing.abort(new Error('MIROBODY_PLUGIN_CLOSED'))
    disposal = (async () => {
      let error: unknown
      try { disposeAll(off) } catch (caught) { error = caught }
      await Promise.allSettled(active)
      if (error !== undefined) throw error
    })()
    return disposal
  }
}

function disposeAll(off: Array<() => void>): void {
  let first: unknown
  for (const dispose of off.splice(0).reverse()) {
    try { dispose() } catch (error) { first ??= error }
  }
  if (first !== undefined) throw first
}
