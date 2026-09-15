import { mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { mkdtemp } from 'node:fs/promises'
import { afterEach, describe, expect, it } from 'vitest'
import { WikiAdapter } from '../src/wiki/adapter.js'

const temporary: string[] = []
afterEach(async () => { await Promise.all(temporary.splice(0).map(path => rm(path, { recursive: true, force: true }))) })

async function setup(writeDate = new Date('2026-09-04T08:00:00Z')) {
  const parent = await mkdtemp(join(tmpdir(), 'memosbox-wiki-'))
  temporary.push(parent)
  const root = join(parent, 'wiki')
  const adapter = new WikiAdapter({
    root,
    autoInitialize: true,
    maxPageBytes: 1_048_576,
    now: () => writeDate,
  })
  await adapter.initialize()
  return { parent, root, adapter }
}

describe('WikiAdapter', () => {
  it('initializes a governed Wiki without overwriting existing files', async () => {
    const { root, adapter } = await setup()
    await writeFile(join(root, 'SCHEMA.md'), '# Custom schema\n', 'utf8')
    await adapter.initialize()

    expect(await readFile(join(root, 'SCHEMA.md'), 'utf8')).toBe('# Custom schema\n')
    await expect(readFile(join(root, 'index.md'), 'utf8')).resolves.toContain('Wiki Index')
    await expect(readFile(join(root, 'log.md'), 'utf8')).resolves.toContain('Wiki Log')
  })

  it('writes, indexes, logs, reads, and searches a valid page', async () => {
    const { root, adapter } = await setup()
    const created = await adapter.writePage({
      path: 'concepts/memory-boundary.md',
      title: 'Memory Boundary',
      type: 'concept',
      tags: ['memory', 'wiki', 'memos'],
      confidence: 'medium',
      body: '# Memory Boundary\n\nMemOS stores experience. Wiki stores stable project knowledge. Related: [[memos]] and [[project-wiki]].',
      expectedVersion: 'absent',
    })

    expect(created.ok).toBe(true)
    expect(created.version).toMatch(/^[0-9a-f]{64}$/)
    const page = await adapter.page('concepts/memory-boundary.md')
    expect(page?.body).toContain('stable project knowledge')
    expect(page?.version).toBe(created.version)
    expect(await readFile(join(root, 'index.md'), 'utf8')).toContain('[[concepts/memory-boundary]]')
    expect(await readFile(join(root, 'log.md'), 'utf8')).toContain('create | concepts/memory-boundary.md')

    const hits = await adapter.query('记忆 项目知识 memory', 8, true, 1_800)
    expect(hits.some(hit => hit.id === 'memory-boundary')).toBe(true)
  })

  it('rejects traversal, symlink escapes, invalid governance, and type-directory mismatch', async () => {
    const { parent, root, adapter } = await setup()
    await writeFile(join(parent, 'outside.md'), 'secret', 'utf8')
    await symlink(join(parent, 'outside.md'), join(root, 'concepts', 'escape.md'))

    await expect(adapter.page('../outside.md')).resolves.toBeNull()
    await expect(adapter.page('concepts/escape.md')).resolves.toBeNull()
    await expect(adapter.writePage({
      path: 'concepts/no-links.md',
      body: 'Only one [[memos]] link.',
    })).resolves.toMatchObject({ ok: false, error: expect.stringContaining('two outbound') })
    await expect(adapter.writePage({
      path: 'concepts/bad-tag.md',
      tags: ['unknown'],
      body: 'Related [[memos]] and [[project-wiki]].',
    })).resolves.toMatchObject({ ok: false, error: expect.stringContaining('outside SCHEMA') })
    await expect(adapter.writePage({
      path: 'concepts/wrong-type.md',
      type: 'entity',
      body: 'Related [[memos]] and [[project-wiki]].',
    })).resolves.toMatchObject({ ok: false, error: expect.stringContaining('does not match') })
  })

  it('requires an existing raw source for high-confidence pages', async () => {
    const { root, adapter } = await setup()
    const missing = await adapter.writePage({
      path: 'queries/evidence.md',
      confidence: 'high',
      body: 'Evidence relates to [[memos]] and [[project-wiki]].',
    })
    expect(missing.error).toContain('raw source')

    await mkdir(join(root, 'raw', 'articles'), { recursive: true })
    await writeFile(join(root, 'raw', 'articles', 'evidence.md'), 'captured source', 'utf8')
    const written = await adapter.writePage({
      path: 'queries/evidence.md',
      confidence: 'high',
      sources: ['raw/articles/evidence.md'],
      body: 'Evidence relates to [[memos]] and [[project-wiki]].',
      expectedVersion: 'absent',
    })
    expect(written.ok).toBe(true)
  })

  it('allows exactly one concurrent optimistic update', async () => {
    const { adapter } = await setup()
    const created = await adapter.writePage({
      path: 'queries/concurrent.md',
      body: 'Initial [[memos]] and [[project-wiki]].',
      expectedVersion: 'absent',
    })
    expect(created.version).toBeDefined()

    const results = await Promise.all([
      adapter.writePage({
        path: 'queries/concurrent.md',
        body: 'Writer A [[memos]] and [[project-wiki]].',
        expectedVersion: created.version,
      }),
      adapter.writePage({
        path: 'queries/concurrent.md',
        body: 'Writer B [[memos]] and [[project-wiki]].',
        expectedVersion: created.version,
      }),
    ])
    expect(results.filter(result => result.ok)).toHaveLength(1)
    expect(results.filter(result => result.status === 409)).toHaveLength(1)
  })

  it('summarizes locally without a model or network service', async () => {
    const { adapter } = await setup()
    const result = await adapter.summarize({ content: '# Heading\n\nFirst paragraph.\n\nSecond paragraph.' })
    expect(result).toMatchObject({
      ok: true,
      source: 'inline',
      headings: ['Heading'],
      paragraphCount: 3,
    })
    expect(result.text).toContain('First paragraph')
  })
})
