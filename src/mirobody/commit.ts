import type { WikiAdapter } from '../wiki/adapter.js'
import type { WikiWriteResult } from '../wiki/types.js'
import type { ImportCandidate } from './candidates.js'
import { candidateMarkdown } from './candidates.js'
import { checkApproval, type CandidateApproval } from './approval.js'
import { JobStore } from './job-store.js'

export interface CommitReceipt {
  candidateDigest: string
  operationId: string
  state: 'approved' | 'wiki_pending' | 'wiki_committed' | 'memory_pending' | 'complete' | 'conflict' | 'recovery_required'
  wiki?: WikiWriteResult
  memory?: { id: string; verified: true; existing: boolean }
  wikiApproval?: CandidateApproval
  memoryApproval?: CandidateApproval
  error?: string
}

/** Recover forward, never delete approved Wiki state to simulate a distributed
 * rollback. A public MemOS writer must use deterministic IDs and read-back.
 */
export async function commitCandidate(options: {
  candidate: ImportCandidate; store: JobStore; wiki: WikiAdapter; sessionId: string;
  wikiApproval?: CandidateApproval; memoryApproval?: CandidateApproval; includeMemory: boolean;
  writeMemory?: () => Promise<{ id: string; verified: true; existing: boolean }>;
  signal?: AbortSignal;
}): Promise<CommitReceipt> {
  const { candidate, store, wiki, signal } = options
  return store.withLock(async assertOwned => {
    const name = `receipts/${candidate.id}.json`
    let receipt = await store.read<CommitReceipt>(name) ?? { candidateDigest: candidate.digest, operationId: candidate.operationId, state: 'approved' }
    if (receipt.candidateDigest !== candidate.digest || receipt.operationId !== candidate.operationId) throw new Error('RECEIPT_INTEGRITY')
    if (receipt.state === 'complete' && (!options.includeMemory || receipt.memory)) return receipt
    // New approvals replace expired records, never a model-supplied token.
    if (options.wikiApproval) receipt.wikiApproval = options.wikiApproval
    if (options.memoryApproval) receipt.memoryApproval = options.memoryApproval
    if (!receipt.wiki?.ok) checkApproval(receipt.wikiApproval, candidate, 'wiki', options.sessionId)
    if (options.includeMemory && !receipt.memory) checkApproval(receipt.memoryApproval, candidate, 'memory', options.sessionId)
    signal?.throwIfAborted()
    await store.write(name, receipt)
    try {
      if (!receipt.wiki?.ok) {
        receipt.state = 'wiki_pending'
        await store.write(name, receipt)
        assertOwned()
        const rawPath = `raw/files/mirobody-${candidate.sourceDigest}-${candidate.digest}.json`
        await wiki.addRawSource(rawPath, JSON.stringify({ sourceDigest: candidate.sourceDigest, segments: candidate.segments }), signal ? { signal } : {})
        assertOwned()
        const result = await wiki.writePage({
          path: candidate.targetPath, title: 'Reviewed Mirobody import', type: 'concept',
          tags: ['wiki', 'memory'], sources: [rawPath], confidence: 'low', contested: candidate.partial,
          body: candidateMarkdown(candidate, options.includeMemory), expectedVersion: candidate.expectedVersion, operationId: candidate.operationId,
        }, signal ? { signal } : {})
        receipt.wiki = result
        receipt.state = result.ok ? 'wiki_committed' : result.status === 409 ? 'conflict' : 'recovery_required'
        assertOwned()
        await store.write(name, receipt)
        if (!result.ok) return receipt
      }
      if (options.includeMemory && !receipt.memory) {
        if (signal?.aborted) { receipt.state = 'wiki_committed'; receipt.error = 'CANCELED_AFTER_WIKI_COMMIT'; await store.write(name, receipt); return receipt }
        if (!options.writeMemory) throw new Error('MEMORY_WRITER_UNAVAILABLE')
        checkApproval(receipt.memoryApproval, candidate, 'memory', options.sessionId)
        assertOwned()
        receipt.state = 'memory_pending'
        await store.write(name, receipt)
        receipt.memory = await options.writeMemory()
      }
      receipt.state = 'complete'
      delete receipt.error
      assertOwned()
      await store.write(name, receipt)
      return receipt
    } catch {
      receipt.state = 'recovery_required'
      receipt.error = 'VERIFY_RECEIPTS_BEFORE_RETRY'
      // Disk failure while saving this last receipt must not hide known
      // commits; the destination's own durable receipts support recovery.
      await store.write(name, receipt).catch(() => undefined)
      return receipt
    }
  }, signal)
}
