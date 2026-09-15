import { mkdtemp, mkdir, readFile, rename, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import type { Context } from '@deepseek-ai/cordis'
import lockfile from 'proper-lockfile'
import { afterEach, describe, expect, it } from 'vitest'
import { WikiAdapter } from '../src/wiki/adapter.js'
import { registerWikiTools } from '../src/wiki/tools.js'
import { splitFrontmatter } from '../src/wiki/frontmatter.js'

const temporary: string[] = []
const body = '# Evidence\n\nCANARY_20260909 records 记忆边界. Related [[memos]] and [[wiki]].'
async function setup(rootName = 'wiki') {
  const parent = await mkdtemp(join(tmpdir(), 'memosbox-wiki-regression-'))
  temporary.push(parent)
  const root = join(parent, rootName)
  const options = { root, autoInitialize: true, maxPageBytes: 4096, now: () => new Date('2026-09-09T00:00:00Z') }
  const adapter = new WikiAdapter(options)
  await adapter.initialize()
  return { parent, root, adapter, options }
}
function mount(adapter: WikiAdapter) {
  const registry = new Map<string, any>()
  // The test calls the actual tool definitions; only the host registry is replaced.
  const ctx = { tools: { register(tool: { name: string }) { registry.set(tool.name, tool); return () => registry.delete(tool.name) } } } as unknown as Context
  registerWikiTools(ctx, { adapter, writeEnabled: true, defaultLimit: 8, maxResultChars: 1800 })
  return registry
}
afterEach(async () => { await Promise.all(temporary.splice(0).map(path => rm(path, { recursive: true, force: true }))) })

describe('published Wiki regression cases', () => {
  it.each(['SCHEMA.md', 'index.md', 'log.md'])('does not expose an outside symlink through %s search', async name => {
    const { parent, root, adapter } = await setup()
    const outside = join(parent, 'outside.txt')
    await writeFile(outside, 'OUTSIDE_CANARY_DO_NOT_READ')
    await rename(join(root, name), join(root, `${name}.original`))
    await symlink(outside, join(root, name))
    expect(await adapter.page(name)).toBeNull()
    expect(JSON.stringify(await adapter.query('OUTSIDE_CANARY_DO_NOT_READ'))).not.toContain('OUTSIDE_CANARY_DO_NOT_READ')
  })

  it('ranks a matching page ahead of navigation and reports no matches', async () => {
    const { adapter } = await setup()
    await adapter.writePage({ path: 'concepts/evidence.md', body, expectedVersion: 'absent' })
    expect((await adapter.query('CANARY_20260909', 1))[0]?.id).toBe('evidence')
    expect(await adapter.query('NO_MATCH_63DC')).toEqual([])
  })

  it('returns paths that can be passed back to get under an arbitrary root', async () => {
    const { adapter } = await setup('知识库 with spaces')
    const created = await adapter.writePage({ path: 'concepts/evidence.md', body, expectedVersion: 'absent' })
    expect(created.path).toBe('concepts/evidence.md')
    expect(await adapter.page(created.path!)).not.toBeNull()
  })

  it('renders versions, source evidence, confidence, contested state, and conflict recovery', async () => {
    const { adapter, root } = await setup()
    await writeFile(join(root, 'raw/articles/source.md'), 'Synthetic source')
    await adapter.writePage({ path: 'concepts/evidence.md', body, sources: ['raw/articles/source.md'], confidence: 'high', contested: true })
    const registry = mount(adapter)
    const tool = registry.get('wiki_get')
    const args = { path: 'concepts/evidence.md' }
    const value = await tool.execute(args, { signal: new AbortController().signal })
    const rendered = tool.output.render(args, value)[0].text
    expect(rendered).toContain(value.version)
    expect(rendered).toContain('raw/articles/source.md')
    expect(rendered).toContain('"confidence":"high"')
    expect(rendered).toContain('"contested":true')
    const writer = registry.get('wiki_write')
    const conflictArgs = { ...args, body, expectedVersion: 'absent' }
    const conflict = await writer.execute(conflictArgs, { signal: new AbortController().signal })
    expect(writer.output.render(conflictArgs, conflict)[0].text).toContain(value.version)
  })

  it('repairs a partial commit on restart and an identical retry', async () => {
    const { adapter, root, options } = await setup()
    await rename(join(root, 'log.md'), join(root, 'log.original'))
    await mkdir(join(root, 'log.md'))
    const input = { path: 'concepts/evidence.md', body, expectedVersion: 'absent' }
    await adapter.writePage(input).catch(() => undefined)
    expect(await adapter.page(input.path)).not.toBeNull()
    await rename(join(root, 'log.md'), join(root, 'log-obstruction'))
    await rename(join(root, 'log.original'), join(root, 'log.md'))
    const restarted = new WikiAdapter(options)
    await restarted.initialize()
    expect((await restarted.writePage(input)).ok).toBe(true)
    const log = await readFile(join(root, 'log.md'), 'utf8')
    expect(log).toContain(input.path)
    expect(log.match(/create \| concepts\/evidence\.md/g)).toHaveLength(1)
  })

  it('cancels a lock waiter without committing a page', async () => {
    const { adapter, root } = await setup()
    const release = await lockfile.lock(root, { realpath: false })
    const controller = new AbortController()
    const writer = mount(adapter).get('wiki_write')
    const pending = writer.execute({ path: 'concepts/canceled.md', body }, { signal: controller.signal }).catch((error: Error) => error)
    await delay(40)
    controller.abort()
    await delay(20)
    await release()
    expect((await pending).name).toBe('AbortError')
    expect(await adapter.page('concepts/canceled.md')).toBeNull()
  })

  it('indexes same-stem pages independently and parses CRLF frontmatter', async () => {
    const { adapter, root } = await setup()
    await adapter.writePage({ path: 'entities/same.md', title: 'Entity Same', body })
    await adapter.writePage({ path: 'concepts/same.md', title: 'Concept Same', body })
    const index = await readFile(join(root, 'index.md'), 'utf8')
    expect(index).toContain('[[entities/same]]')
    expect(index).toContain('[[concepts/same]]')
    expect(splitFrontmatter('---\r\ntitle: Windows\r\nconfidence: high\r\n---\r\n# Body\r\n').metadata).toEqual({ title: 'Windows', confidence: 'high' })
  })
})
