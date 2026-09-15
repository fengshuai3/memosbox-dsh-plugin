import type { Context } from '@deepseek-ai/cordis'
import { defineTool, type ToolDefinition, type ToolRunContext } from '@deepseek-ai/dsh-tools'
import type { WikiAdapter } from './adapter.js'
import type { WikiConfidence, WikiPageType, WikiWriteResult } from './types.js'
import { renderWikiResult } from './result-renderer.js'

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
        const hits = await adapter.query(query, limit, args.includeOrientation === true, options.maxResultChars)
        exec.signal.throwIfAborted()
        return toolResult(
          hits.length === 0
            ? 'No matching project Wiki pages found.'
            : `${hits.length} matching Wiki results.`,
          { ok: true, hits, truncated: false, scopeNote: 'Matches are limited to this workspace and query. Empty results do not prove global absence. Confirm page identity before reading; never repeat unrelated values.' },
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
