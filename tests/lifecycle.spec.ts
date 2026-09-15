import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import { describe, expect, it, vi } from 'vitest'
import { apply, Config } from '../src/index.js'
import { MemoryManager } from '../src/memory/manager.js'
import { MirobodyProvider } from '../src/mirobody/provider.js'

describe('native plugin lifecycle', () => {
  it('continues cleanup when one unregister fails and makes disposal idempotent', async () => {
    const root = await mkdtemp(join(tmpdir(), 'memosbox-lifecycle-'))
    const ctx = new Context()
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)
    const original = ctx.tools.register.bind(ctx.tools)
    const memoryClosed = vi.spyOn(MemoryManager.prototype, 'dispose')
    const providerClosed = vi.spyOn(MirobodyProvider.prototype, 'dispose')
    vi.spyOn(ctx.tools, 'register').mockImplementation(definition => {
      const unregister = original(definition)
      return () => { unregister(); if (definition.name === 'memosbox_status') throw new Error('SYNTHETIC_UNREGISTER_FAILURE') }
    })
    try {
      const dispose = await apply(ctx, Config({ dataHome: root, profileId: 'lifecycle-fixture' }))
      expect(ctx.tools.get('memos_search')).toBeDefined()
      expect(ctx.tools.get('mirobody_resolve')).toBeDefined()
      const stopped = dispose()
      expect(dispose()).toBe(stopped)
      await expect(stopped).rejects.toThrow('MEMOSBOX_CLEANUP_FAILED')
      for (const name of ['memos_search', 'memos_get', 'wiki_get', 'mirobody_resolve', 'memosbox_status']) expect(ctx.tools.get(name)).toBeUndefined()
      expect(memoryClosed).toHaveBeenCalledOnce()
      expect(providerClosed).toHaveBeenCalledOnce()
    } finally { vi.restoreAllMocks(); await ctx.fiber.dispose(); await rm(root, { recursive: true, force: true }) }
  })
})
