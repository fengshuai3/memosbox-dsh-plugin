import { mkdtemp, mkdir, readFile, readdir, rename, rm, symlink, truncate, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { WikiAdapter } from '../../src/wiki/adapter.js'
import { WikiFileStore } from '../../src/wiki/file-store.js'

const temporary: string[] = []
const body = 'Reference [[memos]] and [[wiki]].'
async function setup() {
  const parent = await mkdtemp(join(tmpdir(), 'memosbox-store-'))
  temporary.push(parent)
  const root = join(parent, 'wiki')
  const adapter = new WikiAdapter({ root, autoInitialize: true, maxPageBytes: 4096, maxSourceBytes: 8192 })
  await adapter.initialize()
  return { parent, root, adapter, store: new WikiFileStore(root, 4096) }
}
afterEach(async () => { await Promise.all(temporary.splice(0).map(path => rm(path, { recursive: true, force: true }))) })

describe('bounded Wiki file access', () => {
  it.each(['SCHEMA.md', 'index.md', 'log.md'])('rejects oversized, directory and dangling %s navigation files', async name => {
    const { root, adapter } = await setup()
    await writeFile(join(root, name), 'OVERSIZED_CANARY\n')
    await truncate(join(root, name), 64 * 1024 * 1024)
    expect(await adapter.page(name)).toBeNull()
    expect(JSON.stringify(await adapter.query('OVERSIZED_CANARY'))).not.toContain('OVERSIZED_CANARY')
    await rename(join(root, name), join(root, `${name}.oversized`))
    await mkdir(join(root, name))
    expect(await adapter.page(name)).toBeNull()
    expect(await adapter.query('NO_MATCH')).toEqual([])
    await rename(join(root, name), join(root, `${name}.directory`))
    await symlink(join(root, 'missing'), join(root, name))
    expect(await adapter.page(name)).toBeNull()
    expect(await adapter.query('NO_MATCH')).toEqual([])
  })

  it('rejects interior directory links for reads, enumeration, raw references and writes', async () => {
    const { parent, root, adapter } = await setup()
    const outside = join(parent, 'outside')
    await mkdir(outside)
    await writeFile(join(outside, 'secret.md'), 'OUTSIDE_DIRECTORY_CANARY')
    await rename(join(root, 'concepts'), join(root, 'concepts.original'))
    await symlink(outside, join(root, 'concepts'), 'dir')
    expect(await adapter.page('concepts/secret.md')).toBeNull()
    expect(await adapter.query('OUTSIDE_DIRECTORY_CANARY')).toEqual([])
    await expect(adapter.writePage({ path: 'concepts/new.md', body })).rejects.toThrow('unsafe-path')
    expect(await readdir(outside)).toEqual(['secret.md'])
  })

  it('rejects leaf links even when the target is inside the same Wiki', async () => {
    const { root, adapter } = await setup()
    await writeFile(join(root, 'raw/files/source.txt'), 'safe content')
    await symlink(join(root, 'raw/files/source.txt'), join(root, 'raw/files/alias.txt'))
    expect(await adapter.page('raw/files/alias.txt')).toBeNull()
    expect((await adapter.writePage({ path: 'concepts/evidence.md', body, confidence: 'high', sources: ['raw/files/alias.txt'] })).ok).toBe(false)
  })

  it('keeps journals private and rejects invalid UTF-8 without replacement decoding', async () => {
    const { root, adapter, store } = await setup()
    await writeFile(join(root, 'concepts/invalid.md'), Buffer.from([0xff, 0xfe, 0x61]))
    expect(await adapter.page('concepts/invalid.md')).toBeNull()
    await store.ensureDirectory('.memosbox-journal')
    await store.write('.memosbox-journal/private.md', 'PRIVATE_JOURNAL_CANARY')
    expect(await adapter.page('.memosbox-journal/private.md')).toBeNull()
  })

  it('pins the root directory identity and refuses a replacement root', async () => {
    const { parent, root, store } = await setup()
    await store.initialize(false)
    await rename(root, join(parent, 'old-root'))
    await mkdir(root)
    await writeFile(join(root, 'index.md'), 'ROOT_REPLACEMENT_CANARY')
    await expect(store.read('index.md')).rejects.toThrow('root identity changed')
  })

  it('adds binary sources atomically, retries equal bytes, and never overwrites different bytes', async () => {
    const { root, adapter } = await setup()
    const bytes = Buffer.alloc(6000, 0x81)
    const first = await adapter.addRawSource('raw/files/document.pdf', bytes)
    expect(first).toMatchObject({ path: 'raw/files/document.pdf', bytes: 6000, unchanged: false })
    expect((await adapter.addRawSource(first.path, bytes)).unchanged).toBe(true)
    await expect(adapter.addRawSource(first.path, 'replacement')).rejects.toThrow('already-exists')
    expect(await readFile(join(root, first.path))).toEqual(bytes)
    expect((await adapter.writePage({ path: 'concepts/evidence.md', body, confidence: 'high', sources: [first.path] })).ok).toBe(true)
    await expect(adapter.addRawSource('raw/files/too-large.bin', Buffer.alloc(8193))).rejects.toThrow('too-large')
    expect((await readdir(join(root, 'raw/files'))).filter(name => name.endsWith('.tmp'))).toEqual([])
  })

  it('does not publish a partially written raw source when a duplicate races', async () => {
    const { adapter } = await setup()
    const results = await Promise.all([adapter.addRawSource('raw/files/shared.txt', 'identical'), adapter.addRawSource('raw/files/shared.txt', 'identical')])
    expect(results.filter(value => value.unchanged)).toHaveLength(1)
    expect(results[0]?.sha256).toBe(results[1]?.sha256)
  })
})
