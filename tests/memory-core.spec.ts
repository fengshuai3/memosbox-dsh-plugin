import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it, expect } from 'vitest'
import { openScopedMemory } from '../src/memory/core.js'
import { writeApprovedMemory } from '../src/memory/approved-writer.js'
import { sessionScope } from '../src/privacy/scope.js'
import { MemoryManager } from '../src/memory/manager.js'

describe('real MemOS local core', () => {
  it('rejects database and private-directory symlinks without touching their targets', async () => {
    const root = await mkdtemp(join(tmpdir(), 'memosbox-memory-links-'))
    const outside = join(root, 'outside')
    await mkdir(outside)
    const canary = join(outside, 'canary.db')
    await writeFile(canary, 'SYNTHETIC_SYMLINK_CANARY')
    try {
      const linkedDirectory = join(root, 'directory-case')
      await mkdir(linkedDirectory)
      await symlink(outside, join(linkedDirectory, 'data'), process.platform === 'win32' ? 'junction' : 'dir')
      await expect(openScopedMemory(linkedDirectory, sessionScope('test', root))).rejects.toThrow('MEMORY_DIRECTORY_UNSAFE')
      if (process.platform !== 'win32') {
        const linkedDatabase = join(root, 'database-case')
        await mkdir(join(linkedDatabase, 'data'), { recursive: true })
        await symlink(canary, join(linkedDatabase, 'data', 'memos.db'))
        await expect(openScopedMemory(linkedDatabase, sessionScope('test', root))).rejects.toThrow('MEMORY_DATABASE_UNSAFE')
      }
      expect(await readFile(canary, 'utf8')).toBe('SYNTHETIC_SYMLINK_CANARY')
    } finally { await rm(root, { recursive: true, force: true }) }
  })
  it('drains accepted work before shutdown and rejects new work during disposal', async () => {
    const root = await mkdtemp(join(tmpdir(), 'memosbox-drain-'))
    const manager = new MemoryManager({ root, profileId: 'drain-test', policy: { sensitiveMode: false, recallEnabled: false, captureEnabled: false, memoryToolsEnabled: true, queryLogEnabled: false, explicitMemoryWriteEnabled: true }, recallTimeoutMs: 3000, contextMaxChars: 3000 })
    let release!: () => void
    const gate = new Promise<void>(resolve => { release = resolve })
    let entered!: () => void
    const started = new Promise<void>(resolve => { entered = resolve })
    const operation = manager.run(root, async ({ core, scope }) => {
      entered()
      await gate
      return writeApprovedMemory(core, { operationId: 'shutdown-drain', candidateDigest: 'c'.repeat(64), scope, text: 'SYNTHETIC_DRAIN_CANARY' })
    })
    try {
      await started
      let completed = false
      const disposal = manager.dispose()
      void disposal.then(() => { completed = true })
      expect(manager.dispose()).toBe(disposal)
      await expect(manager.run(root, () => undefined)).rejects.toThrow('MEMORY_UNAVAILABLE')
      expect(completed).toBe(false)
      release()
      expect((await operation).existing).toBe(false)
      await disposal
      expect(completed).toBe(true)
    } finally { release(); await manager.dispose(); await rm(root, { recursive: true, force: true }) }
  })
  it('persists local-only capture without a model or automatic embedding download', async () => {
    const root = await mkdtemp(join(tmpdir(), 'memosbox-capture-'))
    const scope = sessionScope('capture-test', root)
    const core = await openScopedMemory(root, scope)
    try {
      const sessionId = await core.openSession({ agent: 'deepseek-harness', sessionId: 'synthetic-session' })
      const prepared = await core.prepareTurn!({ agent: 'deepseek-harness', sessionId, userText: 'Remember SYNTHETIC capture preference: short replies', ts: Date.now() })
      const captured = await core.onTurnEnd({ agent: 'deepseek-harness', sessionId, episodeId: prepared.episodeId, agentText: 'SYNTHETIC preference noted: short replies', toolCalls: [], ts: Date.now() })
      expect(captured.traceId).toBeTruthy()
      expect((await core.getTrace(captured.traceId))?.agentText).toContain('SYNTHETIC')
      expect((await core.health()).embedder.available).toBe(false)
    } finally { await core.shutdown(); await rm(root, { recursive: true, force: true }) }
  })
  it('physically isolates same-profile workspaces and ignores agent presets', async () => {
    const root = await mkdtemp(join(tmpdir(), 'memosbox-scopes-'))
    const manager = new MemoryManager({ root, profileId: 'same-profile', policy: { sensitiveMode: false, recallEnabled: true, captureEnabled: false, memoryToolsEnabled: true, queryLogEnabled: false, explicitMemoryWriteEnabled: true }, recallTimeoutMs: 3000, contextMaxChars: 3000 })
    try {
      const one = await manager.get(join(root, 'workspace-one'))
      const two = await manager.get(join(root, 'workspace-two'))
      const written = await writeApprovedMemory(one.core, { operationId: 'scope-test', candidateDigest: 'b'.repeat(64), scope: one.scope, text: 'WORKSPACE_ONE_CANARY' })
      expect(await two.core.getTrace(written.id)).toBeNull()
      expect(one.bridge.namespaceFor({ id: 'session', header: { agentPreset: 'unexpected-owner' } }).profileId).toBe(one.scope.key)
      expect((await one.core.health()).paths.db).not.toBe((await two.core.health()).paths.db)
    } finally { await manager.dispose(); await rm(root, { recursive: true, force: true }) }
  })
  it('imports once, persists across reopen, recalls, and redacts query logs', async () => {
    const root = await mkdtemp(join(tmpdir(), 'memosbox-core-'))
    const scope = sessionScope('test', root)
    let core = await openScopedMemory(root, scope)
    try {
      const input = { operationId: 'synthetic-test', candidateDigest: 'a'.repeat(64), text: 'SYNTHETIC glucose example 5.6 mmol/L', scope }
      const first = await writeApprovedMemory(core, input)
      expect(first.existing).toBe(false)
      expect((await writeApprovedMemory(core, input)).existing).toBe(true)
      await expect(writeApprovedMemory(core, { ...input, text: 'changed' })).rejects.toThrow('MEMORY_ID_CONFLICT')
      await core.shutdown()
      core = await openScopedMemory(root, scope)
      expect((await core.getTrace(first.id))?.agentText).toBe(input.text)
      const found = await core.searchMemory({ agent: 'deepseek-harness', query: 'glucose', reason: 'tool_driven', namespace: { agentKind: 'deepseek-harness', profileId: scope.key } })
      expect(found.hits.some(hit => hit.refId === first.id)).toBe(true)
      await core.searchMemory({ agent: 'deepseek-harness', query: 'QUERY_BODY_CANARY_742', reason: 'tool_driven' })
      const logs = await core.listApiLogs({ limit: 100 })
      expect(JSON.stringify(logs)).not.toContain('QUERY_BODY_CANARY_742')
    } finally {
      await core.shutdown()
      await rm(root, { recursive: true, force: true })
    }
  }, 30_000)
})
