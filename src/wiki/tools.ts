import type { Context } from '@deepseek-ai/cordis'
import { defineTool, type ToolDefinition, type ToolRunContext } from '@deepseek-ai/dsh-tools'
import type { WikiAdapter } from './adapter.js'
import { explicitEntities } from './adapter.js'
import type { WikiConfidence, WikiPageType, WikiWriteResult } from './types.js'
import { renderWikiResult } from './result-renderer.js'
import { READBACK_ANSWER_STYLE } from '../answer-evidence.js'

type JsonValue = Parameters<ToolDefinition['output']['render']>[1]

const JSON_OUTPUT = {
  schema: {
    type: 'object' as const,
    additionalProperties: true as const,
    properties: {
      text: { type: 'string' as const, required: true as const },
    },
  },
}

/** Register the read-only Wiki tools and the opt-in governed writer. */
export function registerWikiTools(ctx: Context, options: {
  adapter: WikiAdapter
  adapterForExecution?: (exec: ToolRunContext) => Promise<WikiAdapter>
  writeEnabled: boolean
  defaultLimit: number
  maxResultChars: number
}): () => void {
  const disposers: Array<() => void> = []
  const writeOutcomes = new WeakMap<object, WikiWriteResult>()
  const output = { ...JSON_OUTPUT, render: (_args: unknown, value: unknown) => [{ type: 'text' as const, text: renderWikiResult(value, options.maxResultChars) }] }
  const resolveAdapter = async (exec: ToolRunContext): Promise<WikiAdapter> => {
    exec.signal.throwIfAborted()
    const adapter = options.adapterForExecution ? await options.adapterForExecution(exec) : options.adapter
    exec.signal.throwIfAborted()
    return adapter
  }
  try {
    disposers.push(ctx.tools.register(defineTool({
      name: 'wiki_status',
      description: 'Inspect the local project Wiki path, availability, navigation files, and page count.',
      parameters: {},
      output,
      isConcurrencySafe: () => true,
      async execute(_args, exec) {
        const adapter = await resolveAdapter(exec)
        exec.signal.throwIfAborted()
        const status = await adapter.status()
        exec.signal.throwIfAborted()
        return toolResult(
          status.available
            ? `Project Wiki is available at ${String(status.root)} with ${String(status.pageCount)} governed pages.`
            : `Project Wiki is not initialized at ${String(status.root)}.`,
          { ...status, writeEnabled: options.writeEnabled },
        )
      },
    })))

    disposers.push(ctx.tools.register(defineTool({
      name: 'wiki_search',
      description: 'Search stable project knowledge. Include the exact project/entity ID from the user. Unscoped lexical matches contain metadata only, not verified answers. Never substitute another project or disclose its contents. Use MemOS for prior experience.',
      parameters: {
        query: { type: 'string', required: true, description: 'A concise project-knowledge query.' },
        limit: { type: 'integer', description: 'Maximum results (1-50).' },
        includeOrientation: { type: 'boolean', description: 'Opt in to navigation only when the user asks about Wiki structure. Default false; ignored for explicit entity queries.' },
      },
      output,
      isConcurrencySafe: () => true,
      async execute(args, exec) {
        const adapter = await resolveAdapter(exec)
        const query = requireText(args.query, 'query')
        const limit = boundedInteger(args.limit, options.defaultLimit, 1, 50)
        exec.signal.throwIfAborted()
        let hits = await adapter.query(query, limit, args.includeOrientation === true, options.maxResultChars)
        let importDiscovery = false
        // Untranslated report wording may miss every English import heading.
        // Offer only candidate metadata, only for document discovery without a
        // named entity. Never broaden a named project's failed query.
        if (!hits.length && canDiscoverImports(query)) {
          hits = (await adapter.query('Reviewed Mirobody import', limit, false, options.maxResultChars))
            .filter(hit => /^concepts\/mirobody-[a-f0-9-]{36}\.md$/.test(hit.path) && hit.title === 'Reviewed Mirobody import')
            .map(hit => ({ ...hit, content: '', requiresPageRead: true }))
          importDiscovery = hits.length > 0
        }
        exec.signal.throwIfAborted()
        return toolResult(
          hits.length === 0
            ? '当前工作区未检索到对应 Wiki 页面。'
            : importDiscovery ? '发现本工作区的导入页候选，仅有元数据，不代表已匹配报告。单页可读取核对原文和 lookup ID；多页不能猜是哪份，应请用户明确。' : `当前工作区找到 ${hits.length} 个 Wiki 结果，请确认项目身份后读取。`,
          { ok: true, hits, truncated: false, importDiscovery, evidenceDomain: 'workspace-wiki', answerStyle: '用一两句中文回答，不超过300字符；只说实际查到的项目证据，不列状态和哈希，也不添加词典/临床提示。', scopeNote: '仅描述当前工作区和查询。先确认页面身份；不扩大实体范围，不复述无关值。' },
        )
      },
    })))

    disposers.push(ctx.tools.register(defineTool({
      name: 'wiki_get',
      description: 'Read one Markdown page inside the configured project Wiki and return its SHA256 version.',
      parameters: {
        path: { type: 'string', required: true, description: 'Wiki-relative path such as concepts/memory-boundary.md.' },
        offset: { type: 'integer', description: 'Character offset from a prior nextOffset; defaults to zero.' },
      },
      output,
      isConcurrencySafe: () => true,
      async execute(args, exec) {
        const adapter = await resolveAdapter(exec)
        const path = requireText(args.path, 'path')
        exec.signal.throwIfAborted()
        const page = await adapter.page(path)
        exec.signal.throwIfAborted()
        if (page === null) return toolResult(`Wiki page not found or not readable: ${path}`, { ok: false, found: false, path })
        const offset = unicodeBoundary(page.body, boundedInteger(args.offset, 0, 0, page.body.length))
        const end = unicodeBoundary(page.body, Math.min(page.body.length, offset + Math.max(2, options.maxResultChars)))
        const body = page.body.slice(offset, end)
        const nextOffset = offset + body.length < page.body.length ? offset + body.length : null
        return toolResult(body || `Wiki page found: ${page.wikiRelativePath}`, {
          found: true,
          ok: true,
          path: page.path,
          wikiRelativePath: page.wikiRelativePath,
          version: page.version,
          metadata: page.metadata,
          body,
          offset,
          nextOffset,
          totalChars: page.body.length,
          truncated: nextOffset !== null,
          answerStyle: READBACK_ANSWER_STYLE,
        })
      },
    })))

    disposers.push(ctx.tools.register(defineTool({
      name: 'wiki_summarize',
      description: 'Create a deterministic extractive summary of one Wiki page or supplied Markdown without an external model call.',
      parameters: {
        path: { type: 'string', description: 'Wiki-relative page path.' },
        content: { type: 'string', description: 'Inline Markdown when no path is supplied.' },
      },
      output,
      isConcurrencySafe: () => true,
      async execute(args, exec) {
        const adapter = await resolveAdapter(exec)
        if (!args.path?.trim() && !args.content?.trim()) throw new TypeError('path or content is required')
        exec.signal.throwIfAborted()
        const result = await adapter.summarize({
          ...(args.path?.trim() ? { path: args.path.trim() } : {}),
          ...(args.content?.trim() ? { content: args.content } : {}),
        })
        exec.signal.throwIfAborted()
        return toolResult(hasText(result) ? result.text : 'Wiki summary completed.', result)
      },
    })))

    if (options.writeEnabled) {
      disposers.push(ctx.tools.register(defineTool({
        name: 'wiki_write',
        description: 'Create or update one governed project Wiki page. Use only for durable, source-reviewed knowledge requested by the user.',
        parameters: {
          path: { type: 'string', description: 'Direct child under entities/, concepts/, comparisons/, or queries/.' },
          title: { type: 'string', description: 'Human-readable page title.' },
          type: { type: 'string', enum: ['entity', 'concept', 'comparison', 'query', 'summary'] },
          tags: { type: 'array', items: { type: 'string' }, description: 'Tags from SCHEMA.md taxonomy.' },
          sources: { type: 'array', items: { type: 'string' }, description: 'Existing source paths below raw/.' },
          confidence: { type: 'string', enum: ['high', 'medium', 'low'] },
          contested: { type: 'boolean' },
          body: { type: 'string', required: true, description: 'Markdown body containing at least two outbound wikilinks.' },
          expectedVersion: { type: 'string', description: "Current page SHA256 or 'absent' for optimistic concurrency." },
          operationId: { type: 'string', description: 'Stable idempotency key. Reuse the same key and identical input after an uncertain write.' },
        },
        output,
        isConcurrencySafe: () => true,
        finalizeContent(exec, finalResult) {
          const outcome = writeOutcomes.get(exec)
          writeOutcomes.delete(exec)
          if (!outcome || !finalResult.isError || !exec.signal.aborted) return undefined
          return [{ type: 'text', text: renderWikiResult({ ...outcome, transportCanceled: true }, options.maxResultChars) }]
        },
        async execute(args, exec) {
          const adapter = await resolveAdapter(exec)
          exec.signal.throwIfAborted()
          const result = await adapter.writePage({
            ...(args.path?.trim() ? { path: args.path.trim() } : {}),
            ...(args.title?.trim() ? { title: args.title.trim() } : {}),
            ...(args.type ? { type: args.type as WikiPageType } : {}),
            ...(args.tags ? { tags: args.tags } : {}),
            ...(args.sources ? { sources: args.sources } : {}),
            ...(args.confidence ? { confidence: args.confidence as WikiConfidence } : {}),
            ...(args.contested !== undefined ? { contested: args.contested } : {}),
            body: args.body,
            ...(args.expectedVersion?.trim() ? { expectedVersion: args.expectedVersion.trim() } : {}),
            ...(args.operationId?.trim() ? { operationId: args.operationId.trim() } : {}),
          }, { signal: exec.signal })
          writeOutcomes.set(exec, result)
          return toolResult(result.text, result)
        },
      })))
    }
  } catch (error) {
    disposeAll(disposers)
    throw error
  }
  return () => disposeAll(disposers)
}

export function canDiscoverImports(query: string): boolean {
  return explicitEntities(query).length === 0 && !/(?:项目|project|客户|customer|患者|patient)/i.test(query)
    && /(?:合成|导入|保存|import|saved|synthetic).*(?:报告|文档|report|document)|(?:报告|文档|report|document).*(?:导入|保存|import|saved)/i.test(query)
}

function requireText(value: string, name: string): string {
  const text = value.trim()
  if (!text) throw new TypeError(`${name} is required`)
  return text
}

function boundedInteger(value: number | undefined, fallback: number, minimum: number, maximum: number): number {
  if (value === undefined || !Number.isInteger(value)) return fallback
  return Math.max(minimum, Math.min(maximum, value))
}

/** Offsets use UTF-16 units, but a page fragment must not split a surrogate pair. */
function unicodeBoundary(text: string, offset: number): number {
  const before = text.charCodeAt(offset - 1)
  const after = text.charCodeAt(offset)
  return before >= 0xd800 && before <= 0xdbff && after >= 0xdc00 && after <= 0xdfff ? offset - 1 : offset
}

function disposeAll(disposers: Array<() => void>): void {
  for (const dispose of disposers.splice(0).reverse()) dispose()
}

function hasText(value: unknown): value is { text: string } {
  return value !== null && typeof value === 'object' && 'text' in value && typeof value.text === 'string'
}

function toolResult(text: string, value: unknown): { text: string } & Record<string, JsonValue> {
  return { text, ...jsonObject(value) }
}

function jsonObject(value: unknown): Record<string, JsonValue> {
  const normalized = normalizeJson(value)
  return normalized !== null && typeof normalized === 'object' && !Array.isArray(normalized) ? normalized : {}
}

function normalizeJson(value: unknown): JsonValue {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value
  if (typeof value === 'number') return Number.isFinite(value) ? value : null
  if (Array.isArray(value)) return value.map(normalizeJson)
  if (value !== null && typeof value === 'object') {
    const result: Record<string, JsonValue> = {}
    for (const [key, item] of Object.entries(value)) {
      if (item !== undefined) result[key] = normalizeJson(item)
    }
    return result
  }
  return String(value)
}
