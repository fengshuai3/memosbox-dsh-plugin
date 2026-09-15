import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { WikiAdapter } from '../../src/wiki/adapter.js'
import { WikiFileStore } from '../../src/wiki/file-store.js'
import { registerWikiTools } from '../../src/wiki/tools.js'

const temporary: string[] = []
const contexts: Context[] = []
async function setup() {
  const root = await mkdtemp(join(tmpdir(), 'memosbox-native-wiki-'))
  temporary.push(root)
  const adapter = new WikiAdapter({ root, autoInitialize: true, maxPageBytes: 8192 })
  await adapter.initialize()
  const ctx = new Context()
  contexts.push(ctx)
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  registerWikiTools(ctx, { adapter, writeEnabled: true, defaultLimit: 8, maxResultChars: 1800 })
  return { adapter, ctx }
}
afterEach(async () => {
  vi.restoreAllMocks()
  await Promise.all(contexts.splice(0).map(ctx => ctx.fiber.dispose()))
  await Promise.all(temporary.splice(0).map(path => rm(path, { recursive: true, force: true })))
})

describe('DSH native Wiki result finalization', () => {
  it('retains actual committed state when the host marks the transport canceled', async () => {
    const { adapter, ctx } = await setup()
    const controller = new AbortController()
    const original = WikiFileStore.prototype.write
    vi.spyOn(WikiFileStore.prototype, 'write').mockImplementation(async function (path, text, maximum) {
      await original.call(this, path, text, maximum)
      if (path.includes('/pending/')) controller.abort()
    })
    let observed: unknown
    ctx.on('tools/result', (_exec, result) => { observed = result })
    const result = await ctx.tools.execute({ name: 'wiki_write', callId: ToolCallId('cancel-after-intent'), signal: controller.signal,
      arguments: { operationId: 'native-canceled-commit', path: 'concepts/canceled.md', body: 'Native [[memos]] [[wiki]].', expectedVersion: 'absent' } })
    expect(result.isError).toBe(true)
    const first = result.content[0]!
    if (first.type !== 'text') throw new Error('Expected text')
    expect(JSON.parse(first.text)).toMatchObject({ ok: true, committed: true, state: 'committed', operationId: 'native-canceled-commit', transportCanceled: true })
    expect(observed).toEqual(result)
    expect(await adapter.operation('native-canceled-commit')).toMatchObject({ ok: true, state: 'committed' })
  })

  it('keeps the native success value and rendered evidence consistent', async () => {
    const { ctx } = await setup()
    const signal = new AbortController().signal
    const written = await ctx.tools.execute({ name: 'wiki_write', callId: ToolCallId('native-write'), signal,
      arguments: { path: 'concepts/native.md', body: 'Native [[memos]] [[wiki]].', expectedVersion: 'absent' } })
    expect(written.isError).toBe(false)
    const result = await ctx.tools.execute({ name: 'wiki_get', callId: ToolCallId('native-get'), signal, arguments: { path: 'concepts/native.md' } })
    expect(result.isError).toBe(false)
    if (result.isError || result.content[0]?.type !== 'text') throw new Error('Expected native success')
    const rendered = JSON.parse(result.content[0].text)
    expect(rendered.version).toMatch(/^[a-f0-9]{64}$/)
    expect(result.value).toMatchObject({ version: rendered.version, path: rendered.path })
  })
})
