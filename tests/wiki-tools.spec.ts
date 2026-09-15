import type { Context } from '@deepseek-ai/cordis'
import { describe, expect, it, vi } from 'vitest'
import type { ToolDefinition, ToolRunContext } from '@deepseek-ai/dsh-tools'
import type { WikiAdapter } from '../src/wiki/adapter.js'
import { registerWikiTools, canDiscoverImports } from '../src/wiki/tools.js'

function registry() {
  const names = new Set<string>()
  const ctx = {
    tools: {
      register(tool: { name: string }) {
        names.add(tool.name)
        return () => names.delete(tool.name)
      },
    },
  } as unknown as Context
  return { ctx, names }
}

function mount(ctx: Context, writeEnabled: boolean): () => void {
  return registerWikiTools(ctx, {
    adapter: {} as WikiAdapter,
    writeEnabled,
    defaultLimit: 8,
    maxResultChars: 1_800,
  })
}

describe('Wiki tool registration', () => {
  it('never broadens a named entity or project into import discovery', () => {
    for (const query of ['PROJECT-UNKNOWN 合成报告', '项目甲 保存的报告', 'customer report saved', '患者报告导入', 'MEMORY-123 合成报告', '验收口令']) expect(canDiscoverImports(query)).toBe(false)
    expect(canDiscoverImports('合成血红蛋白报告 原始名称 数值 单位 标准编号')).toBe(true)
    expect(canDiscoverImports('recently imported document')).toBe(true)
  })
  it('returns only metadata for unscoped imported-report discovery', async () => {
    const definitions = new Map<string, ToolDefinition>()
    const ctx = { tools: { register(tool: ToolDefinition) { definitions.set(tool.name, tool); return () => undefined } } } as unknown as Context
    const query = vi.fn().mockResolvedValueOnce([]).mockResolvedValueOnce([
      { path: `concepts/mirobody-${'a'.repeat(36)}.md`, title: 'Reviewed Mirobody import', content: 'SYNTHETIC_HIDDEN_BODY', requiresPageRead: false },
      { path: 'entities/unrelated.md', title: 'Unrelated', content: 'SYNTHETIC_OTHER_BODY' },
    ])
    const dispose = registerWikiTools(ctx, { adapter: { query } as unknown as WikiAdapter, writeEnabled: false, defaultLimit: 8, maxResultChars: 1800 })
    try {
      const result = await definitions.get('wiki_search')!.execute({ query: '合成报告' }, { signal: new AbortController().signal } as ToolRunContext)
      expect(result).toMatchObject({ importDiscovery: true, hits: [{ content: '', requiresPageRead: true }] })
      expect(JSON.stringify(result)).not.toContain('SYNTHETIC_')
      expect(query).toHaveBeenLastCalledWith('Reviewed Mirobody import', 8, false, 1800)
    } finally { dispose() }
  })
  it('registers only the four read tools by default and disposes them', () => {
    const { ctx, names } = registry()
    const dispose = mount(ctx, false)
    expect([...names].sort()).toEqual(['wiki_get', 'wiki_search', 'wiki_status', 'wiki_summarize'])
    dispose()
    expect(names.size).toBe(0)
  })

  it('registers the governed writer only when explicitly enabled', () => {
    const { ctx, names } = registry()
    const dispose = mount(ctx, true)
    expect(names.has('wiki_write')).toBe(true)
    dispose()
    expect(names.size).toBe(0)
  })
})
