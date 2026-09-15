import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { WikiAdapter } from '../src/wiki/adapter.js'

const roots: string[] = []
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'wiki-relevance-')); roots.push(root)
  const adapter = new WikiAdapter({ root, autoInitialize: true, maxPageBytes: 16384 })
  for (const [id, secret] of [['PROJECT-ALPHA', 'SYNTHETIC_SECRET_A'], ['PROJECT-ALPHABET', 'SYNTHETIC_SECRET_B']]) {
    const outcome = await adapter.writePage({ path: `entities/${id!.toLowerCase()}.md`, title: `${id} 验收约定`, expectedVersion: 'absent', body: `# ${id}\n\n验收口令 ${secret}。相关 [[SCHEMA]] [[index]]。` })
    expect(outcome.ok).toBe(true)
  }
  return adapter
}
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))) })
describe('Wiki entity relevance and minimum disclosure', () => {
  it('does not return another entity or navigation on a named-entity miss', async () => {
    const adapter = await fixture()
    expect(await adapter.query('PROJECT-UNKNOWN 验收口令', 20, true)).toEqual([])
    expect(await adapter.query('MEMORY-ABC123 输出约定标记 PREF 项目', 20, true)).toEqual([])
  })
  it('requires exact entity tokens rather than ID substrings', async () => {
    const adapter = await fixture()
    const results = await adapter.query('PROJECT-ALPHA 验收口令', 20, true)
    expect(results).toHaveLength(1)
    expect(results[0]?.content).toContain('SYNTHETIC_SECRET_A')
    expect(JSON.stringify(results)).not.toContain('SYNTHETIC_SECRET_B')
  })
  it('returns discovery metadata but no secret body on broad lexical queries', async () => {
    const adapter = await fixture()
    const results = await adapter.query('验收口令', 20, false)
    expect(results).toHaveLength(2)
    expect(results.every(hit => hit.requiresPageRead && hit.content === '')).toBe(true)
    expect(JSON.stringify(results)).not.toContain('SYNTHETIC_SECRET')
  })
  it('does not treat a body reference as ownership of another project', async () => {
    const adapter = await fixture()
    await adapter.writePage({ path: 'entities/other.md', title: 'PROJECT-OTHER', body: '# PROJECT-OTHER\n\nMentions PROJECT-UNKNOWN. SECRET_UNRELATED [[SCHEMA]] [[index]].' })
    expect(await adapter.query('PROJECT-UNKNOWN 口令')).toEqual([])
  })
})
