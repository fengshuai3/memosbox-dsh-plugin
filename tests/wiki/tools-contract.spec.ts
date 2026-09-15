import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type { ToolDefinition, ToolRunContext } from '@deepseek-ai/dsh-tools'
import { afterEach, describe, expect, it } from 'vitest'
import { WikiAdapter } from '../../src/wiki/adapter.js'
import { registerWikiTools } from '../../src/wiki/tools.js'
import { renderWikiResult } from '../../src/wiki/result-renderer.js'

const temporary: string[] = []
async function setup() {
  const root = await mkdtemp(join(tmpdir(), 'memosbox-wiki-contract-'))
  temporary.push(root)
  const adapter = new WikiAdapter({ root, autoInitialize: true, maxPageBytes: 16_384 })
  await adapter.initialize()
  return adapter
}
function registry(adapter: WikiAdapter, resolver?: (exec: ToolRunContext) => Promise<WikiAdapter>) {
  const tools = new Map<string, ToolDefinition>()
  const ctx = { tools: { register(tool: ToolDefinition) { tools.set(tool.name, tool); return () => tools.delete(tool.name) } } } as unknown as Context
  registerWikiTools(ctx, { adapter, writeEnabled: true, defaultLimit: 8, maxResultChars: 256, ...(resolver ? { adapterForExecution: resolver } : {}) })
  return tools
}
async function execute(tools: Map<string, ToolDefinition>, name: string, args: unknown, signal = new AbortController().signal) {
  const tool = tools.get(name)!
  const value = await tool.execute(args, { signal } as ToolRunContext)
  const content = tool.output.render(args, value as Parameters<ToolDefinition['output']['render']>[1])
  const first = content[0]!
  if (first.type !== 'text') throw new Error('Expected text rendering')
  return { value: value as Record<string, any>, text: first.text, rendered: JSON.parse(first.text) as Record<string, any> }
}
afterEach(async () => { await Promise.all(temporary.splice(0).map(path => rm(path, { recursive: true, force: true }))) })

describe('Wiki native tool result contract', () => {
  it('supports search→get→versioned update using only rendered fields', async () => {
    const adapter = await setup()
    const tools = registry(adapter)
    await execute(tools, 'wiki_write', { path: 'concepts/workflow.md', body: '# Workflow\n\nCONTRACT_MATCH [[memos]] [[wiki]].', expectedVersion: 'absent' })
    const searched = await execute(tools, 'wiki_search', { query: 'CONTRACT_MATCH', limit: 1 })
    const path = searched.rendered.hits[0].path
    const page = await execute(tools, 'wiki_get', { path })
    const updated = await execute(tools, 'wiki_write', { path, expectedVersion: page.rendered.version, operationId: 'contract-update', body: '# Updated\n\nREVISED_MATCH [[memos]] [[wiki]].' })
    expect(updated.rendered).toMatchObject({ ok: true, state: 'committed', operationId: 'contract-update', path })
    const reread = await execute(tools, 'wiki_get', { path })
    expect(reread.rendered.version).toBe(updated.rendered.version)
    expect(reread.rendered.body).toContain('REVISED_MATCH')
    expect(updated.value.version).toBe(updated.rendered.version)
  })

  it('makes every truncated body retrievable via nextOffset without losing characters', async () => {
    const adapter = await setup()
    const tools = registry(adapter)
    await adapter.writePage({ path: 'concepts/long.md', body: `# Long\n\n${'中文🧬'.repeat(450)}\n\n[[memos]] [[wiki]].` })
    const expected = (await adapter.page('concepts/long.md'))!.body
    let offset = 0
    let reconstructed = ''
    for (let count = 0; count < 30; count++) {
      const response = await execute(tools, 'wiki_get', { path: 'concepts/long.md', offset })
      expect(response.text.length).toBeLessThanOrEqual(256 + 4096)
      expect(response.rendered.body.isWellFormed()).toBe(true)
      reconstructed += response.rendered.body
      if (response.rendered.nextOffset === null) break
      expect(response.rendered.truncated).toBe(true)
      expect(response.rendered.nextOffset).toBeGreaterThan(offset)
      offset = response.rendered.nextOffset
    }
    expect(reconstructed).toBe(expected)
  })

  it('renders not-found, empty search and rejected writes as explicit non-success values', async () => {
    const tools = registry(await setup())
    expect((await execute(tools, 'wiki_get', { path: 'concepts/missing.md' })).rendered).toMatchObject({ ok: false, found: false })
    expect((await execute(tools, 'wiki_search', { query: 'NO_MATCH_6FFE' })).rendered).toMatchObject({ ok: true, hits: [] })
    expect((await execute(tools, 'wiki_write', { path: '../outside.md', body: 'invalid' })).rendered.ok).toBe(false)
    expect((await execute(tools, 'wiki_summarize', { path: 'concepts/missing.md' })).rendered.ok).toBe(false)
  })

  it('resolves the scoped adapter for every tool and never writes the fallback Wiki', async () => {
    const fallback = await setup()
    const scoped = await setup()
    let called = 0
    const tools = registry(fallback, async exec => { expect(exec.signal).toBeInstanceOf(AbortSignal); called++; return scoped })
    await execute(tools, 'wiki_write', { path: 'concepts/scoped.md', body: 'SCOPED_CANARY [[memos]] [[wiki]].' })
    await execute(tools, 'wiki_status', {})
    await execute(tools, 'wiki_get', { path: 'concepts/scoped.md' })
    await execute(tools, 'wiki_search', { query: 'SCOPED_CANARY' })
    await execute(tools, 'wiki_summarize', { path: 'concepts/scoped.md' })
    expect(called).toBe(5)
    expect(await fallback.page('concepts/scoped.md')).toBeNull()
    expect(await scoped.page('concepts/scoped.md')).not.toBeNull()
  })

  it('never emits invalid or unbounded JSON when metadata is enormous', () => {
    const version = 'a'.repeat(64)
    const result = renderWikiResult({ text: 'body', found: true, path: 'concepts/large.md', version,
      metadata: { sources: Array.from({ length: 1000 }, (_, index) => `${index}-${'x'.repeat(2000)}`) }, body: 'b'.repeat(100_000) }, 256)
    expect(result.length).toBeLessThanOrEqual(4352)
    expect(JSON.parse(result)).toMatchObject({ version, path: 'concepts/large.md', truncated: true, metadataOmitted: true })
  })
})
