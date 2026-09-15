import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { WikiAdapter } from '../../src/wiki/adapter.js'
import { WikiFileStore } from '../../src/wiki/file-store.js'
import { JOURNAL_ROOT } from '../../src/wiki/write-journal.js'

const temporary: string[] = []
const input = { operationId: 'fault-injection', path: 'concepts/evidence.md', body: 'Persistent [[memos]] and [[wiki]].', expectedVersion: 'absent' }
async function setup() {
  const root = await mkdtemp(join(tmpdir(), 'memosbox-recovery-'))
  temporary.push(root)
  const options = { root, autoInitialize: true, maxPageBytes: 8192, now: () => new Date('2026-09-09T00:00:00Z') }
  const adapter = new WikiAdapter(options)
  await adapter.initialize()
  return { root, adapter, options }
}
afterEach(async () => { vi.restoreAllMocks(); await Promise.all(temporary.splice(0).map(path => rm(path, { recursive: true, force: true }))) })

function failOnce(stage: 'before-page' | 'after-page' | 'after-index' | 'after-log' | 'after-receipt', after?: () => void) {
  const original = WikiFileStore.prototype.write
  let fired = false
  return vi.spyOn(WikiFileStore.prototype, 'write').mockImplementation(async function (path, text, max) {
    const match = !fired && (stage.includes('page') ? path === input.path : stage === 'after-index' ? path === 'index.md' : stage === 'after-log' ? path === 'log.md' : path.includes('/receipts/'))
    if (match && stage === 'before-page') { fired = true; throw new Error('injected before page commit') }
    await original.call(this, path, text, max)
    if (match) { fired = true; after?.(); throw new Error('injected after synced commit') }
  })
}

describe('Wiki write intent recovery', () => {
  it.each(['before-page', 'after-page', 'after-index', 'after-log', 'after-receipt'] as const)('recovers %s failure exactly once', async stage => {
    const { root, adapter, options } = await setup()
    const fault = failOnce(stage)
    const result = await adapter.writePage(input)
    expect(result).toMatchObject({ ok: false, state: 'recovery_required', recoveryRequired: true, committed: stage !== 'before-page' })
    fault.mockRestore()
    const restarted = new WikiAdapter(options)
    await restarted.initialize()
    const retried = await restarted.writePage(input)
    expect(retried).toMatchObject({ ok: true, committed: true, unchanged: true, operationId: input.operationId })
    expect((await restarted.operation(input.operationId))?.version).toBe(retried.version)
    expect((await readFile(join(root, 'log.md'), 'utf8')).match(/memosbox-operation:fault-injection/g)).toHaveLength(1)
    expect(await readFile(join(root, 'index.md'), 'utf8')).toContain('[[concepts/evidence]]')
    expect(await readdir(join(root, JOURNAL_ROOT, 'pending'))).toEqual([])
  })

  it('never replays a pending write over an independently changed page', async () => {
    const { adapter, root, options } = await setup()
    const fault = failOnce('after-page')
    await adapter.writePage(input)
    fault.mockRestore()
    const external = '# User revision\n\nUSER_EDIT_MUST_SURVIVE [[memos]] [[wiki]].\n'
    await writeFile(join(root, input.path), external)
    const restarted = new WikiAdapter(options)
    await restarted.initialize()
    const recovery = await restarted.recover()
    expect(recovery).toHaveLength(1)
    expect(recovery[0]).toMatchObject({ ok: false, status: 409, state: 'conflict', recoveryRequired: true })
    expect(await readFile(join(root, input.path), 'utf8')).toBe(external)
    expect((await restarted.writePage(input)).ok).toBe(false)
    expect(await readFile(join(root, 'log.md'), 'utf8')).not.toContain('fault-injection')
  })

  it('rejects reusing a completed operation id with changed input or a changed page', async () => {
    const { adapter, root } = await setup()
    const first = await adapter.writePage(input)
    expect(first.ok).toBe(true)
    const modified = await adapter.writePage({ ...input, body: 'DIFFERENT [[memos]] [[wiki]].' })
    expect(modified).toMatchObject({ ok: false, status: 409 })
    const bytes = await readFile(join(root, input.path), 'utf8')
    expect(bytes).not.toContain('DIFFERENT')
    await writeFile(join(root, input.path), 'EXTERNAL [[memos]] [[wiki]].')
    expect(await adapter.operation(input.operationId)).toMatchObject({ ok: false, status: 409 })
    expect(await adapter.writePage(input)).toMatchObject({ ok: false, status: 409 })
  })

  it('reports a committed operation when cancellation arrives after the durable intent', async () => {
    const { adapter, root } = await setup()
    const controller = new AbortController()
    const original = WikiFileStore.prototype.write
    const spy = vi.spyOn(WikiFileStore.prototype, 'write').mockImplementation(async function (path, text, maximum) {
      await original.call(this, path, text, maximum)
      if (path.includes('/pending/')) controller.abort()
    })
    const result = await adapter.writePage(input, { signal: controller.signal })
    spy.mockRestore()
    expect(result).toMatchObject({ ok: true, state: 'committed', committed: true })
    expect(await readFile(join(root, 'log.md'), 'utf8')).toContain(input.operationId)
  })

  it('rejects tampered journal paths before recovery changes any external files', async () => {
    const { adapter, root, options } = await setup()
    const fault = failOnce('before-page')
    await adapter.writePage(input)
    fault.mockRestore()
    const [file] = await readdir(join(root, JOURNAL_ROOT, 'pending'))
    const path = join(root, JOURNAL_ROOT, 'pending', file!)
    const record = JSON.parse(await readFile(path, 'utf8'))
    record.path = '../outside.md'
    await writeFile(path, JSON.stringify(record))
    await expect(new WikiAdapter(options).initialize()).rejects.toThrow('journal fields are invalid')
    expect(await adapter.page(input.path)).toBeNull()
  })

  it('rebuilds managed index entries after manual editing without erasing user prose', async () => {
    const { adapter, root } = await setup()
    await adapter.writePage(input)
    const before = await readFile(join(root, 'index.md'), 'utf8')
    await writeFile(join(root, 'index.md'), `CUSTOM USER PROSE\n${before}`)
    await writeFile(join(root, input.path), '# New User Title\n\n[[memos]] [[wiki]].')
    await adapter.rebuildIndex()
    const index = await readFile(join(root, 'index.md'), 'utf8')
    expect(index).toContain('CUSTOM USER PROSE')
    expect(index).toContain('[[concepts/evidence]] - New User Title.')
  })
})
