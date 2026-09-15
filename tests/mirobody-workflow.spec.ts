import { mkdtemp, rm, symlink, readFile, writeFile, mkdir, rename, readdir } from 'node:fs/promises'
import { spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it, expect, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import ToolRuntime, { type ToolRunContext, type ToolDefinition } from '@deepseek-ai/dsh-tools'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import { makeCandidate, verifyCandidate, candidateDigest, candidateMarkdown } from '../src/mirobody/candidates.js'
import { checkApproval, requestApproval, type CandidateApproval } from '../src/mirobody/approval.js'
import { commitCandidate } from '../src/mirobody/commit.js'
import { JobStore } from '../src/mirobody/job-store.js'
import { validateExtraction } from '../src/mirobody/extraction.js'
import * as extraction from '../src/mirobody/extraction.js'
import { registerMirobodyTools, approvalSummary, type MirobodyToolOptions } from '../src/mirobody/tools.js'
import type { MirobodyExecutor, MirobodyResponse } from '../src/mirobody/types.js'
import { sessionScope } from '../src/privacy/scope.js'
import { WikiAdapter } from '../src/wiki/adapter.js'
import { openScopedMemory } from '../src/memory/core.js'
import { writeApprovedMemory, approvedMemoryId } from '../src/memory/approved-writer.js'
import { authorizedSource } from '../src/mirobody/documents.js'

function fixture(root: string) {
  const scope = sessionScope('test', root)
  const candidate = makeCandidate({ scope, sourceDigest: 'a'.repeat(64), sourceId: `${'a'.repeat(64)}.txt`,
    readings: [{ rawName: 'Glucose', rawValue: '5.6', rawUnit: 'mmol/L', status: 'ready', normalizedValue: '5.6', normalizedUnit: 'mmol/L', codeSystem: 'loinc', code: '2345-7', canonical: 'Synthetic fixture', candidates: 1, bundleVersion: 'test', resolutionMethod: 'fixture', evidenceRefs: ['seg-one'], warnings: [] }],
    segments: [{ id: 'seg-one', text: 'Glucose 5.6 mmol/L', status: 'ready', digest: 'test', location: { line: 1 } }], warnings: [], partial: false })
  const approval = (target: 'wiki' | 'memory'): CandidateApproval => ({ digest: candidate.digest, scopeKey: scope.key, sessionId: 'test-session', target, targetPath: candidate.targetPath, expectedVersion: candidate.expectedVersion, grantedAt: Date.now(), expiresAt: Date.now() + 60_000 })
  return { candidate, scope, approval }
}

describe('candidate, evidence and approval boundary', () => {
  it.each(['rejected', 'cancelled', 'unavailable'] as const)('blocks destination downgrade and reparse after memory %s, then requires fresh approval next turn', async outcome => {
    const root = await mkdtemp(join(tmpdir(), 'memosbox-refusal-stop-'))
    const { candidate, scope } = fixture(root)
    const wiki = new WikiAdapter({ root: join(root, 'wiki'), autoInitialize: true, maxPageBytes: 1024 * 1024 })
    const store = new JobStore(join(root, 'data/scopes', scope.key, 'imports'), undefined, join(root, 'data'))
    const definitions = new Map<string, ToolDefinition>()
    const request = vi.fn().mockResolvedValueOnce('allowed-once').mockResolvedValueOnce(outcome).mockResolvedValue('allowed-once')
    const ctx = { approval: { request }, tools: { register(tool: ToolDefinition) { definitions.set(tool.name, tool); return () => definitions.delete(tool.name) } } } as unknown as Context
    const dispose = registerMirobodyTools(ctx, { provider: {} as MirobodyExecutor, dataRoot: join(root, 'data'), sourceRoot: root, sensitiveMode: false, syntheticDocumentsEnabled: true, modelExtractionEnabled: true, wikiWriteEnabled: true, explicitMemoryWriteEnabled: true, memory: {} as MirobodyToolOptions['memory'], scope: () => scope, wiki: async () => wiki })
    const session = Session.create(SessionId('test-session'))
    const exec = { signal: new AbortController().signal, agent: { session } } as ToolRunContext
    const call = async (name: string, args: Record<string, unknown>) => await definitions.get(name)!.execute(args, { ...exec }) as { data: Record<string, unknown> }
    try {
      await wiki.initialize()
      await store.write(`candidates/${candidate.id}.json`, candidate)
      session.append('turn/start', { turn: 1 })
      expect((await call('mirobody_commit_import', { candidateId: candidate.id, includeMemory: true })).data.status).toBe('refused')
      for (const candidateId of [candidate.id, 'b'.repeat(36)]) {
        expect((await call('mirobody_commit_import', { candidateId, includeMemory: false })).data.error).toBe('APPROVAL_REFUSAL_LATCHED')
      }
      expect((await call('mirobody_parse_document', { sourceId: candidate.sourceId, useModel: false })).data.error).toBe('APPROVAL_REFUSAL_LATCHED')
      expect(request).toHaveBeenCalledTimes(2)
      expect(await wiki.page(candidate.targetPath)).toBeNull()
      session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
      session.append('turn/start', { turn: 2 })
      expect((await call('mirobody_commit_import', { candidateId: candidate.id, includeMemory: false })).data.status).toBe('complete')
      expect(request).toHaveBeenCalledTimes(3)
      expect(await wiki.page(candidate.targetPath)).not.toBeNull()
    } finally { await dispose(); await rm(root, { recursive: true, force: true }) }
  })
  it('does not present a device metadata miss as a clinical LOINC miss', async () => {
    const definitions = new Map<string, ToolDefinition>()
    const execute = vi.fn(async () => ({ status: 'unresolved', metric: null, operation: 'metric_info' }))
    const ctx = { tools: { register(tool: ToolDefinition) { definitions.set(tool.name, tool); return () => definitions.delete(tool.name) } } } as unknown as Context
    const dispose = registerMirobodyTools(ctx, { provider: { execute }, sensitiveMode: false } as unknown as MirobodyToolOptions)
    try {
      const result = await definitions.get('mirobody_resolve')!.execute({ name: 'Synthetic clinical name', metricInfo: true }, { signal: new AbortController().signal, agent: { session: { id: 'test' } } } as ToolRunContext) as { data: unknown }
      expect(result.data).toMatchObject({ queryDomain: 'device-metadata-only', loincMappingAttempted: false, clinicalLookup: { name: 'Synthetic clinical name', metricInfo: false } })
      expect(execute).toHaveBeenCalledTimes(1)
    } finally { await dispose() }
  })
  it('renders cancellation separately from rejection and local writes separately from transmission', () => {
    expect(approvalSummary([{ stage: 'modelTransmission', outcome: 'cancelled' }])).toContain('被取消（不是拒绝）')
    const summary = approvalSummary([{ stage: 'wikiWrite', outcome: 'allowed-once' }, { stage: 'memoryWrite', outcome: 'rejected' }])
    expect(summary).toContain('本地 MemOS 写入：被拒绝')
    expect(summary).not.toContain('外发')
    expect(summary).toContain('批准不等于已经写入')
  })
  it('returns a safe source/candidate correction without reading, approving or committing', async () => {
    const definitions = new Map<string, ToolDefinition>()
    const request = vi.fn(), execute = vi.fn()
    const ctx = { approval: { request }, tools: { register(tool: ToolDefinition) { definitions.set(tool.name, tool); return () => definitions.delete(tool.name) } } } as unknown as Context
    const dispose = registerMirobodyTools(ctx, { provider: { execute }, sensitiveMode: false } as unknown as MirobodyToolOptions)
    try {
      for (const name of ['mirobody_preview_import', 'mirobody_commit_import']) {
        const result = await definitions.get(name)!.execute({ candidateId: `${'a'.repeat(64)}.txt` }, { signal: new AbortController().signal, agent: { session: { id: 'test' } } } as ToolRunContext) as { data: unknown; text: string }
        expect(result.data).toMatchObject({ status: 'invalid_input', nextTool: 'mirobody_parse_document', sourceId: `${'a'.repeat(64)}.txt`, performed: false })
        expect(result.text).toContain('DSH 会话历史')
      }
      expect(request).not.toHaveBeenCalled(); expect(execute).not.toHaveBeenCalled()
    } finally { await dispose() }
  })
  it('derives scoped lookup references without certifying memory existence', () => {
    const { candidate } = fixture(process.cwd())
    const id = approvedMemoryId(candidate.scopeKey, candidate.operationId, candidate.digest)
    expect(candidateMarkdown(candidate, true)).toContain(`MemOS lookup ID: ${id}`)
    expect(candidateMarkdown(candidate, true)).toContain('NOT proof')
    expect(candidateMarkdown(candidate, false)).not.toContain('MemOS lookup ID')
    expect(approvedMemoryId('different-scope', candidate.operationId, candidate.digest)).not.toBe(id)
  })
  it('rejects changed content, cross-scope replay, expired and wrong-destination approvals', () => {
    const { candidate, scope, approval } = fixture(process.cwd())
    verifyCandidate(candidate, scope)
    expect(() => verifyCandidate({ ...candidate, partial: true }, scope)).toThrow('INTEGRITY')
    expect(() => verifyCandidate(candidate, sessionScope('other', process.cwd()))).toThrow('SCOPE')
    expect(() => checkApproval(approval('wiki'), candidate, 'memory', 'test-session')).toThrow('APPROVAL_REQUIRED')
    expect(() => checkApproval(approval('wiki'), candidate, 'wiki', 'another-session')).toThrow('APPROVAL_REQUIRED')
    expect(() => checkApproval(approval('wiki'), candidate, 'wiki', 'test-session', Date.now() + 120_000)).toThrow('APPROVAL_REQUIRED')
  })
  it('only creates an internal grant after the real approval service outcome', async () => {
    const { candidate } = fixture(process.cwd())
    const request = vi.fn(async () => 'rejected')
    const ctx = { approval: { request } } as unknown as Context
    const exec = { agent: { session: { id: 'test-session' } }, signal: new AbortController().signal, approved: true } as unknown as ToolRunContext
    expect(await requestApproval(ctx, exec, candidate, 'wiki')).toBeNull()
    const record = vi.fn()
    await requestApproval(ctx, exec, candidate, 'wiki', record)
    expect(record).toHaveBeenCalledWith('rejected')
    request.mockResolvedValue('allowed-once')
    expect((await requestApproval(ctx, exec, candidate, 'wiki'))?.digest).toBe(candidate.digest)
  })
  it('rejects invented model values, source IDs and excessive batches', () => {
    const { candidate } = fixture(process.cwd())
    const reading = { rawName: 'Glucose', rawValue: '5.6', rawUnit: 'mmol/L', evidenceRefs: ['seg-one'] }
    expect(validateExtraction([reading], candidate.segments)).toEqual([reading])
    expect(() => validateExtraction([{ ...reading, rawValue: '999' }], candidate.segments)).toThrow('UNSUPPORTED_EVIDENCE')
    expect(() => validateExtraction([{ ...reading, evidenceRefs: ['invented'] }], candidate.segments)).toThrow('UNSUPPORTED_EVIDENCE')
    expect(() => validateExtraction(Array(257).fill(reading), candidate.segments)).toThrow('INVALID_EXTRACTION')
  })
  it('rejects numeric substrings and readings assembled from different evidence rows', () => {
    const segment = (id: string, text: string, line: number) => ({ id, text, status: 'ready' as const, digest: 'test', location: { line } })
    const segments = [segment('glucose', 'Glucose 15.60 mmol/L', 1), segment('potassium', 'Potassium 4.2 mmol/L', 2)]
    for (const rawValue of ['5.6', '15.6', '4.2']) {
      expect(() => validateExtraction([{ rawName: 'Glucose', rawValue, rawUnit: 'mmol/L', evidenceRefs: ['glucose', 'potassium'] }], segments)).toThrow('UNSUPPORTED_EVIDENCE')
    }
    expect(validateExtraction([{ rawName: 'Glucose', rawValue: '15.60', rawUnit: 'mmol/L', evidenceRefs: ['glucose'] }], segments)[0]?.rawValue).toBe('15.60')
    expect(() => validateExtraction([{ rawName: 'Glucose', rawValue: '4.2', rawUnit: 'mmol/L', evidenceRefs: ['mixed'] }], [segment('mixed', 'Glucose 15.60 mmol/L; Potassium 4.2 mmol/L', 1)])).toThrow('UNSUPPORTED_EVIDENCE')
    expect(() => validateExtraction([{ rawName: 'Glucose', rawValue: '15.6', evidenceRefs: ['mixed'] }], [segment('mixed', 'Glucose 15.60; Note 15.6', 1)])).toThrow('UNSUPPORTED_EVIDENCE')
  })
  it('allows same-row literal spreadsheet evidence but refuses cross-row and lossy numeric-display cells', () => {
    const cells = ['Glucose', '5.60', 'mmol/L'].map((text, index) => ({ id: `cell-${index}`, text, digest: 'test', status: 'ready' as const, location: { sheet: 'Review', row: 2, column: index + 1 } }))
    const reading = { rawName: 'Glucose', rawValue: '5.60', rawUnit: 'mmol/L', evidenceRefs: cells.map(cell => cell.id) }
    expect(validateExtraction([reading], cells)).toEqual([reading])
    expect(() => validateExtraction([reading], cells.map((cell, i) => i === 1 ? { ...cell, location: { ...cell.location, row: 3 } } : cell))).toThrow('UNSUPPORTED_EVIDENCE')
    expect(() => validateExtraction([reading], cells.map((cell, i) => i === 1 ? { ...cell, provenance: { cellDataType: 'n', numberFormat: '0.00', originalDisplayAvailable: false as const } } : cell))).toThrow('UNSUPPORTED_EVIDENCE')
    const ambiguous = [cells[0]!, { ...cells[1]!, id: 'potassium-name', text: 'Potassium', location: { ...cells[1]!.location, column: 2 } }, { ...cells[1]!, location: { ...cells[1]!.location, column: 3 } }, { ...cells[2]!, location: { ...cells[2]!.location, column: 4 } }]
    expect(() => validateExtraction([reading], ambiguous)).toThrow('UNSUPPORTED_EVIDENCE')
  })
})

describe('persistent governed import', () => {
  it('commits real Wiki and MemOS, survives reopen, and retries without duplicates', async () => {
    const root = await mkdtemp(join(tmpdir(), 'memosbox-import-'))
    const { candidate, scope, approval } = fixture(root)
    const store = new JobStore(join(root, 'jobs'))
    const wiki = new WikiAdapter({ root: join(root, 'wiki'), autoInitialize: true, maxPageBytes: 1024 * 1024 })
    const core = await openScopedMemory(join(root, 'memory'), scope)
    try {
      await wiki.initialize()
      const memoryWrite = vi.fn(() => writeApprovedMemory(core, { operationId: candidate.operationId, candidateDigest: candidate.digest, scope, text: 'Approved synthetic Glucose fixture' }))
      const options = { candidate, store, wiki, sessionId: 'test-session', wikiApproval: approval('wiki'), memoryApproval: approval('memory'), includeMemory: true, writeMemory: memoryWrite }
      const result = await commitCandidate(options)
      expect(result.state).toBe('complete')
      expect(result.memory?.verified).toBe(true)
      expect((await wiki.page(candidate.targetPath))?.body).toContain(candidate.digest)
      expect((await wiki.page(candidate.targetPath))?.body).toContain(`MemOS lookup ID: ${result.memory?.id}`)
      const logBefore = await readFile(join(root, 'wiki', 'log.md'), 'utf8')
      const restarted = await commitCandidate({ ...options, store: new JobStore(join(root, 'jobs')) })
      expect(restarted.state).toBe('complete')
      expect(memoryWrite).toHaveBeenCalledTimes(1)
      expect(await readFile(join(root, 'wiki', 'log.md'), 'utf8')).toBe(logBefore)
    } finally { await core.shutdown(); await rm(root, { recursive: true, force: true }) }
  })
  it('keeps Wiki-only imports discoverable after a later approved memory extension without rewriting the page', async () => {
    const root = await mkdtemp(join(tmpdir(), 'memosbox-memory-extension-'))
    const { candidate, approval } = fixture(root)
    const wiki = new WikiAdapter({ root: join(root, 'wiki'), autoInitialize: true, maxPageBytes: 1024 * 1024 })
    const store = new JobStore(join(root, 'jobs'))
    const memoryId = approvedMemoryId(candidate.scopeKey, candidate.operationId, candidate.digest)
    const writeMemory = vi.fn(async () => ({ id: memoryId, verified: true as const, existing: false }))
    try {
      await wiki.initialize()
      const base = { candidate, store, wiki, sessionId: 'test-session', wikiApproval: approval('wiki') }
      const first = await commitCandidate({ ...base, includeMemory: false })
      expect(first.memory).toBeUndefined()
      const page = await wiki.page(candidate.targetPath)
      expect(page?.body).toContain(`MemOS lookup ID: ${memoryId}`)
      expect(page?.body).toContain('NOT proof')
      await expect(commitCandidate({ ...base, includeMemory: true, writeMemory })).rejects.toThrow('APPROVAL_REQUIRED')
      expect(writeMemory).not.toHaveBeenCalled()
      const extended = await commitCandidate({ ...base, includeMemory: true, memoryApproval: approval('memory'), writeMemory })
      expect(extended.memory?.id).toBe(memoryId)
      expect(writeMemory).toHaveBeenCalledTimes(1)
      expect((await wiki.page(candidate.targetPath))?.version).toBe(page?.version)
    } finally { await rm(root, { recursive: true, force: true }) }
  })
  it('retains approved Wiki after MemOS failure, then recovers only the missing destination', async () => {
    const root = await mkdtemp(join(tmpdir(), 'memosbox-partial-'))
    const { candidate, approval } = fixture(root)
    const store = new JobStore(join(root, 'jobs'))
    const wiki = new WikiAdapter({ root: join(root, 'wiki'), autoInitialize: true, maxPageBytes: 1024 * 1024 })
    try {
      await wiki.initialize()
      const options = { candidate, store, wiki, sessionId: 'test-session', wikiApproval: approval('wiki'), memoryApproval: approval('memory'), includeMemory: true }
      expect((await commitCandidate({ ...options, writeMemory: async () => { throw new Error('injected') } })).state).toBe('recovery_required')
      const page = await wiki.page(candidate.targetPath)
      expect(page).not.toBeNull()
      expect((await commitCandidate({ ...options, writeMemory: async () => ({ id: 'verified-test-id', verified: true, existing: false }) })).state).toBe('complete')
      expect((await wiki.page(candidate.targetPath))?.version).toBe(page?.version)
    } finally { await rm(root, { recursive: true, force: true }) }
  })
  it('returns a known Wiki commit even when both receipt-save attempts fail', async () => {
    const root = await mkdtemp(join(tmpdir(), 'memosbox-receipt-fault-'))
    const { candidate, approval } = fixture(root)
    const store = new JobStore(join(root, 'jobs'))
    const wiki = new WikiAdapter({ root: join(root, 'wiki'), autoInitialize: true, maxPageBytes: 1024 * 1024 })
    try {
      await wiki.initialize()
      const original = store.write.bind(store)
      vi.spyOn(store, 'write').mockImplementation(async (name, value) => {
        if ((value as { wiki?: { ok: boolean } }).wiki?.ok) throw new Error('SYNTHETIC_RECEIPT_DISK_FAILURE')
        return original(name, value)
      })
      const result = await commitCandidate({ candidate, store, wiki, sessionId: 'test-session', wikiApproval: approval('wiki'), includeMemory: false })
      expect(result).toMatchObject({ state: 'recovery_required', wiki: { ok: true, committed: true }, error: 'VERIFY_RECEIPTS_BEFORE_RETRY' })
      expect(await wiki.page(candidate.targetPath)).not.toBeNull()
    } finally { await rm(root, { recursive: true, force: true }) }
  })
  it('keeps append-only evidence for distinct candidates extracted from the same source', async () => {
    const root = await mkdtemp(join(tmpdir(), 'memosbox-multi-candidate-'))
    const first = fixture(root)
    const second = fixture(root)
    second.candidate.segments[0]!.location = { line: 2 }
    // New extraction/candidate identity must not collide with a previous
    // source-digest-only filename, even when page grouping has changed.
    const { digest: _digest, ...body } = second.candidate
    second.candidate.digest = candidateDigest(body)
    const store = new JobStore(join(root, 'jobs'))
    const wiki = new WikiAdapter({ root: join(root, 'wiki'), autoInitialize: true, maxPageBytes: 1024 * 1024 })
    try {
      await wiki.initialize()
      for (const f of [first, second]) expect((await commitCandidate({ candidate: f.candidate, store, wiki, sessionId: 'test-session', wikiApproval: f.approval('wiki'), includeMemory: false })).state).toBe('complete')
      expect(await readdir(join(root, 'wiki/raw/files'))).toHaveLength(2)
    } finally { await rm(root, { recursive: true, force: true }) }
  })
  it('writes nothing when canceled before admission or when approval is absent', async () => {
    const root = await mkdtemp(join(tmpdir(), 'memosbox-refuse-'))
    const { candidate, approval } = fixture(root)
    const store = new JobStore(join(root, 'jobs'))
    const wiki = new WikiAdapter({ root: join(root, 'wiki'), autoInitialize: true, maxPageBytes: 1024 * 1024 })
    try {
      await wiki.initialize()
      const base = { candidate, store, wiki, sessionId: 'test-session', includeMemory: false }
      await expect(commitCandidate(base)).rejects.toThrow('APPROVAL_REQUIRED')
      await expect(commitCandidate({ ...base, wikiApproval: approval('wiki'), signal: AbortSignal.abort() })).rejects.toThrow()
      expect(await wiki.page(candidate.targetPath)).toBeNull()
    } finally { await rm(root, { recursive: true, force: true }) }
  })
  it('refuses arbitrary source paths and source/store symlinks', async () => {
    const root = await mkdtemp(join(tmpdir(), 'memosbox-store-'))
    try {
      const secret = join(root, 'original.txt')
      await writeFile(secret, 'SYNTHETIC_SOURCE')
      const sourceId = `${'a'.repeat(64)}.txt`
      await symlink(secret, join(root, sourceId))
      await expect(authorizedSource(root, sourceId)).rejects.toThrow('UNSAFE_SOURCE')
      await expect(authorizedSource(root, '../original.txt')).rejects.toThrow('SOURCE_NOT_REGISTERED')
      const store = new JobStore(join(root, 'jobs'))
      const target = await store.path('candidate.json')
      await symlink(secret, target)
      await expect(store.read('candidate.json')).rejects.toThrow('UNSAFE_STORAGE')
      await expect(store.write('candidate.json', {})).rejects.toThrow('UNSAFE_STORAGE')
      expect(await readFile(secret, 'utf8')).toBe('SYNTHETIC_SOURCE')
    } finally { await rm(root, { recursive: true, force: true }) }
  })
  it('rejects symlinked job roots and interior scope directories under a configured boundary', async () => {
    const root = await mkdtemp(join(tmpdir(), 'memosbox-job-root-'))
    try {
      const outside = join(root, 'outside')
      const data = join(root, 'data')
      await mkdir(outside)
      await mkdir(data)
      await symlink(outside, join(data, 'jobs'))
      await expect(new JobStore(join(data, 'jobs')).write('candidate.json', {})).rejects.toThrow('UNSAFE_STORAGE')
      await symlink(outside, join(data, 'scopes'))
      await expect(new JobStore(join(data, 'scopes/profile/imports'), undefined, data).write('candidate.json', {})).rejects.toThrow('UNSAFE_STORAGE')
    } finally { await rm(root, { recursive: true, force: true }) }
  })
  it('pins a job root and refuses replacement after initialization', async () => {
    const root = await mkdtemp(join(tmpdir(), 'memosbox-job-replacement-'))
    try {
      const path = join(root, 'jobs')
      const store = new JobStore(path)
      await store.write('candidate.json', { original: true })
      await rename(path, join(root, 'original-jobs'))
      await mkdir(path)
      await writeFile(join(path, 'candidate.json'), '{"substituted":true}')
      await expect(store.read('candidate.json')).rejects.toThrow('UNSAFE_STORAGE')
    } finally { await rm(root, { recursive: true, force: true }) }
  })
  it('rejects a FIFO, invalid UTF-8 and oversized job files without reading indefinitely', async () => {
    const root = await mkdtemp(join(tmpdir(), 'memosbox-job-bounds-'))
    const store = new JobStore(root, 32)
    try {
      if (process.platform !== 'win32') {
        const fifo = await store.path('pipe.json')
        expect(spawnSync('mkfifo', [fifo]).status).toBe(0)
        await expect(store.read('pipe.json')).rejects.toThrow('UNSAFE_STORAGE')
      }
      await writeFile(await store.path('bad.json'), Buffer.from([0xff]))
      await expect(store.read('bad.json')).rejects.toThrow('UNSAFE_STORAGE')
      await writeFile(await store.path('large.json'), 'x'.repeat(33))
      await expect(store.read('large.json')).rejects.toThrow('UNSAFE_STORAGE')
      await expect(store.write('large.json', 'x'.repeat(33))).rejects.toThrow('UNSAFE_STORAGE')
    } finally { await rm(root, { recursive: true, force: true }) }
  })
})

describe('document tool integrity and lifecycle', () => {
  it.each(['ready', 'warning', 'truncated', 'partial-status', 'row-warning', 'row-status', 'changed-refs', 'changed-value'] as const)('preserves normalization provenance and %s status in admission', async mode => {
    const root = await mkdtemp(join(tmpdir(), 'memosbox-parse-contract-'))
    const { candidate, scope } = fixture(root)
    const raw = { rawName: 'Glucose', rawValue: '5.6', rawUnit: 'mmol/L', evidenceRefs: ['seg-one'] }
    const extract = vi.spyOn(extraction, 'extractWithDsh').mockResolvedValue([raw])
    const definitions = new Map<string, ToolDefinition>()
    const ctx = { approval: { request: async () => 'allowed-once' }, tools: { register(tool: ToolDefinition) { definitions.set(tool.name, tool); return () => definitions.delete(tool.name) } } } as unknown as Context
    const provider: MirobodyExecutor = {
      execute: async (operation, payload) => {
        const base = { schemaVersion: 1, operationId: 'fixture', operation, status: 'ready', bundleVersion: 'test', warnings: [], truncated: false } as MirobodyResponse
        if (operation === 'extract_document') return { ...base, sourceDigest: String(payload.sourceDigest), segments: candidate.segments }
        expect(operation).toBe('normalize_readings')
        expect(payload.readings).toEqual([raw])
        return { ...base, status: mode === 'partial-status' ? 'partial' : 'ready', truncated: mode === 'truncated', warnings: mode === 'warning' ? ['SYNTHETIC_WARNING'] : [],
          readings: [{ ...candidate.readings[0]!, evidenceRefs: mode === 'changed-refs' ? [] : ['seg-one'], rawValue: mode === 'changed-value' ? '999' : '5.6',
            status: mode === 'row-status' ? 'unresolved' : 'ready', warnings: mode === 'row-warning' ? ['SYNTHETIC_ROW_WARNING'] : [] }] }
      },
      status: async () => { throw new Error('Unused synthetic fixture') }, dispose: async () => undefined,
    }
    const dispose = registerMirobodyTools(ctx, { provider, dataRoot: join(root, 'data'), sourceRoot: root, sensitiveMode: false, syntheticDocumentsEnabled: true, modelExtractionEnabled: true, wikiWriteEnabled: false, explicitMemoryWriteEnabled: false,
      scope: () => scope, wiki: async () => { throw new Error('No commit in parse fixture') } })
    try {
      await writeFile(join(root, candidate.sourceId), 'Glucose 5.6 mmol/L')
      const value = await definitions.get('mirobody_parse_document')!.execute({ sourceId: candidate.sourceId, useModel: true }, { signal: new AbortController().signal, agent: { session: { id: 'test-session', header: { cwd: root } } } } as ToolRunContext) as { data: { status: string; candidateId?: string; error?: string } }
      if (mode === 'changed-refs' || mode === 'changed-value') {
        expect(value.data).toMatchObject({ status: 'failed', error: 'NORMALIZATION_PROVENANCE_MISMATCH' })
      } else {
        expect(value.data.status).toBe(mode === 'ready' ? 'ready' : 'partial')
        const store = new JobStore(join(root, 'data/scopes', scope.key, 'imports'), undefined, join(root, 'data'))
        const saved = await store.read<{ partial: boolean; readings: Array<{ evidenceRefs: string[] }>; warnings: string[] }>(`candidates/${value.data.candidateId!}.json`)
        expect(saved?.partial).toBe(mode !== 'ready')
        expect(saved?.readings[0]?.evidenceRefs).toEqual(['seg-one'])
        if (mode === 'warning' || mode === 'row-warning') expect(saved?.warnings).toHaveLength(1)
      }
    } finally { extract.mockRestore(); await dispose(); await rm(root, { recursive: true, force: true }) }
  })

  it('attempts every unregister even after one fails, and repeats await the same disposal', async () => {
    let disposed = 0
    const ctx = { tools: { register() { return () => { disposed++; if (disposed === 1) throw new Error('SYNTHETIC_UNREGISTER_FAILURE') } } } } as unknown as Context
    const dispose = registerMirobodyTools(ctx, {} as MirobodyToolOptions)
    const first = dispose()
    await expect(first).rejects.toThrow('SYNTHETIC_UNREGISTER_FAILURE')
    expect(disposed).toBe(6)
    expect(dispose()).toBe(first)
    await expect(dispose()).rejects.toThrow('SYNTHETIC_UNREGISTER_FAILURE')
    expect(disposed).toBe(6)
  })

  it('closes admission, cancels model work and awaits its settlement without storing a candidate', async () => {
    const root = await mkdtemp(join(tmpdir(), 'memosbox-model-shutdown-'))
    const { candidate, scope } = fixture(root)
    const entered = Promise.withResolvers<AbortSignal>()
    const release = Promise.withResolvers<void>()
    const extract = vi.spyOn(extraction, 'extractWithDsh').mockImplementation(async (_ctx, exec) => {
      entered.resolve(exec.signal)
      await release.promise // Simulate an outbound model that needs time to stop.
      return [{ rawName: 'Glucose', rawValue: '5.6', rawUnit: 'mmol/L', evidenceRefs: ['seg-one'] }]
    })
    const definitions = new Map<string, ToolDefinition>()
    const ctx = { approval: { request: async () => 'allowed-once' }, tools: { register(tool: ToolDefinition) { definitions.set(tool.name, tool); return () => definitions.delete(tool.name) } } } as unknown as Context
    const provider = { execute: vi.fn(async (operation, payload) => ({ schemaVersion: 1, operationId: 'fixture', operation, status: 'ready', bundleVersion: 'test', warnings: [], truncated: false, sourceDigest: payload.sourceDigest, segments: candidate.segments })), dispose: async () => undefined } as unknown as MirobodyExecutor
    const dispose = registerMirobodyTools(ctx, { provider, dataRoot: join(root, 'data'), sourceRoot: root, sensitiveMode: false, syntheticDocumentsEnabled: true, modelExtractionEnabled: true, wikiWriteEnabled: false, explicitMemoryWriteEnabled: false, scope: () => scope, wiki: async () => { throw new Error('Unused') } })
    try {
      await writeFile(join(root, candidate.sourceId), 'Glucose 5.6 mmol/L')
      const original = { signal: new AbortController().signal, agent: { session: { id: 'test-session', header: { cwd: root } } } } as ToolRunContext
      const tool = definitions.get('mirobody_parse_document')!
      const outcome = tool.execute({ sourceId: candidate.sourceId, useModel: true }, original).then(value => ({ value }), error => ({ error }))
      const signal = await entered.promise
      let finished = false
      const draining = dispose().then(() => { finished = true })
      expect(signal.aborted).toBe(true)
      expect(original.signal.aborted).toBe(false)
      await expect(tool.execute({ sourceId: candidate.sourceId, useModel: true }, original)).rejects.toThrow('MIROBODY_PLUGIN_CLOSED')
      await Promise.resolve()
      expect(finished).toBe(false)
      release.resolve()
      expect(await outcome).toHaveProperty('error')
      await draining
      expect(provider.execute).toHaveBeenCalledTimes(1)
      expect(await readdir(join(root, 'data')).catch(error => { if (error.code === 'ENOENT') return []; throw error })).toEqual([])
    } finally { release.resolve(); extract.mockRestore(); await dispose(); await rm(root, { recursive: true, force: true }) }
  })

  it.each(['host', 'plugin'] as const)('drains a durable Wiki commit on %s cancellation and finalizes against the original execution', async cancel => {
    const root = await mkdtemp(join(tmpdir(), 'memosbox-commit-shutdown-'))
    const { candidate, scope } = fixture(root)
    const wiki = new WikiAdapter({ root: join(root, 'wiki'), autoInitialize: true, maxPageBytes: 1024 * 1024 })
    const store = new JobStore(join(root, 'data/scopes', scope.key, 'imports'), undefined, join(root, 'data'))
    const entered = Promise.withResolvers<void>()
    const release = Promise.withResolvers<void>()
    const originalWrite = wiki.writePage.bind(wiki)
    vi.spyOn(wiki, 'writePage').mockImplementation(async (...args) => {
      const result = await originalWrite(...args)
      entered.resolve()
      await release.promise
      return result
    })
    const definitions = new Map<string, ToolDefinition>()
    const ctx = { approval: { request: async () => 'allowed-once' }, tools: { register(tool: ToolDefinition) { definitions.set(tool.name, tool); return () => definitions.delete(tool.name) } } } as unknown as Context
    const dispose = registerMirobodyTools(ctx, { provider: {} as MirobodyExecutor, dataRoot: join(root, 'data'), sourceRoot: root, sensitiveMode: false, syntheticDocumentsEnabled: true, modelExtractionEnabled: false, wikiWriteEnabled: true, explicitMemoryWriteEnabled: false, scope: () => scope, wiki: async () => wiki })
    try {
      await wiki.initialize()
      await store.write(`candidates/${candidate.id}.json`, candidate)
      const host = new AbortController()
      const original = { signal: host.signal, agent: { session: { id: 'test-session', header: { cwd: root } } } } as ToolRunContext
      const tool = definitions.get('mirobody_commit_import')!
      const outcome = tool.execute({ candidateId: candidate.id }, original)
      await entered.promise
      if (cancel === 'host') host.abort()
      let finished = false
      const draining = dispose().then(() => { finished = true })
      await Promise.resolve()
      expect(finished).toBe(false)
      release.resolve()
      const result = await outcome as { data: { status: string; wiki: { committed: boolean } } }
      await draining
      expect(result.data).toMatchObject({ status: 'complete', wiki: { committed: true } })
      const rendered = await tool.finalizeContent!(original, { isError: true } as Parameters<NonNullable<ToolDefinition['finalizeContent']>>[1])
      expect(rendered?.[0]?.type).toBe('text')
      if (rendered?.[0]?.type !== 'text') throw new Error('Missing durable finalization')
      expect(JSON.parse(rendered[0].text)).toMatchObject({ transportCanceled: cancel === 'host', pluginClosing: true, data: { status: 'complete', wiki: { committed: true } } })
      expect(await tool.finalizeContent!(original, { isError: true } as Parameters<NonNullable<ToolDefinition['finalizeContent']>>[1])).toBeUndefined()
      expect(await wiki.page(candidate.targetPath)).not.toBeNull()
    } finally { release.resolve(); await dispose(); await rm(root, { recursive: true, force: true }) }
  })

  it('preserves a wrapped-execution commit receipt through real DSH runtime cancellation rendering', async () => {
    const root = await mkdtemp(join(tmpdir(), 'memosbox-native-commit-cancel-'))
    const { candidate, scope } = fixture(root)
    const wiki = new WikiAdapter({ root: join(root, 'wiki'), autoInitialize: true, maxPageBytes: 1024 * 1024 })
    const store = new JobStore(join(root, 'data/scopes', scope.key, 'imports'), undefined, join(root, 'data'))
    const ctx = new Context()
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)
    const controller = new AbortController()
    const originalWrite = wiki.writePage.bind(wiki)
    vi.spyOn(wiki, 'writePage').mockImplementation(async (...args) => { const result = await originalWrite(...args); controller.abort(); return result })
    // The registry/runtime are real; the explicit synthetic approval outcome
    // is isolated here (full ApprovalService coverage lives in loader tests).
    const toolCtx = { tools: ctx.tools, approval: { request: async () => 'allowed-once' } } as unknown as Context
    const dispose = registerMirobodyTools(toolCtx, { provider: {} as MirobodyExecutor, dataRoot: join(root, 'data'), sourceRoot: root, sensitiveMode: false, syntheticDocumentsEnabled: true, modelExtractionEnabled: false, wikiWriteEnabled: true, explicitMemoryWriteEnabled: false, scope: () => scope, wiki: async () => wiki })
    try {
      await wiki.initialize()
      await store.write(`candidates/${candidate.id}.json`, candidate)
      let observed: unknown
      ctx.on('tools/result', (_exec, result) => { observed = result })
      const agent = { id: 'test-session', session: { id: 'test-session', header: { cwd: root } } } as NonNullable<ToolRunContext['agent']>
      const result = await ctx.tools.execute({ name: 'mirobody_commit_import', arguments: { candidateId: candidate.id }, callId: ToolCallId('mirobody-cancel-after-write'), signal: controller.signal, agent })
      expect(result.isError).toBe(true)
      expect(observed).toEqual(result)
      if (result.content[0]?.type !== 'text') throw new Error('Missing native content')
      expect(JSON.parse(result.content[0].text)).toMatchObject({ transportCanceled: true, pluginClosing: false, data: { status: 'complete', wiki: { committed: true } } })
    } finally { await dispose(); await ctx.fiber.dispose(); await rm(root, { recursive: true, force: true }) }
  })
})
