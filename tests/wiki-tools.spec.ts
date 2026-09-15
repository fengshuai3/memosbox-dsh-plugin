import type { Context } from '@deepseek-ai/cordis'
import { describe, expect, it } from 'vitest'
import type { WikiAdapter } from '../src/wiki/adapter.js'
import { registerWikiTools } from '../src/wiki/tools.js'

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
