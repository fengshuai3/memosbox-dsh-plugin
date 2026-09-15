import { createHash } from 'node:crypto'
import type { MemoryCore } from '../../vendor/memos-core/index.js'
import type { SessionScope } from '../privacy/scope.js'

export interface ApprovedMemoryInput {
  readonly operationId: string
  readonly candidateDigest: string
  readonly text: string
  readonly scope: SessionScope
}

/** Lookup identity only; possessing this ID never grants read/write access. */
export function approvedMemoryId(scopeKey: string, operationId: string, candidateDigest: string): string {
  return `mbx-${createHash('sha256').update(JSON.stringify([scopeKey, operationId, candidateDigest])).digest('hex')}`
}

/** Fixed external IDs plus read-back verification over MemOS's public import
 * facade. A skipped import is never mistaken for success without equality.
 */
export async function writeApprovedMemory(core: MemoryCore, input: ApprovedMemoryInput): Promise<{ id: string; verified: true; existing: boolean }> {
  if (!/^[a-f0-9]{64}$/.test(input.candidateDigest) || !input.operationId || input.text.length > 64_000) throw new TypeError('Invalid approved memory input')
  const id = approvedMemoryId(input.scope.key, input.operationId, input.candidateDigest)
  const namespace = { agentKind: 'deepseek-harness', profileId: input.scope.key, workspaceId: input.scope.workspaceId }
  const check = async () => {
    const row = await core.getTrace(id, namespace)
    if (row && (row.agentText !== input.text || row.userText !== '' || row.ownerProfileId !== input.scope.key)) throw new Error('MEMORY_ID_CONFLICT')
    return row
  }
  if (await check()) return { id, verified: true, existing: true }
  await core.importBundle({ version: 1, traces: [{
    id, sessionId: `${id}-session`, episodeId: `${id}-episode`,
    ownerAgentKind: 'deepseek-harness', ownerProfileId: input.scope.key, ownerWorkspaceId: input.scope.workspaceId,
    ts: Date.now(), userText: '', agentText: input.text, summary: input.text,
    tags: ['approved-import', input.candidateDigest], toolCalls: [], share: null,
    // Admission priority, not a learned reward or medical confidence score.
    value: 0, alpha: 0, priority: 1,
  }] })
  if (!await check()) throw new Error('MEMORY_WRITE_UNVERIFIED')
  return { id, verified: true, existing: false }
}
