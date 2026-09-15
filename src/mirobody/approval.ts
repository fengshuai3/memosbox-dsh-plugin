import type { Context } from '@deepseek-ai/cordis'
import type { ToolRunContext } from '@deepseek-ai/dsh-tools'
import type {} from '@deepseek-ai/dsh-user-approval'
import type { ImportCandidate } from './candidates.js'
import { requireAgent } from '../privacy/execution.js'

export interface CandidateApproval {
  digest: string
  scopeKey: string
  sessionId: string
  target: 'wiki' | 'memory'
  targetPath: string
  expectedVersion: string
  grantedAt: number
  expiresAt: number
}

export type ApprovalOutcome = 'allowed-once' | 'rejected' | 'cancelled' | 'unavailable'
export async function requestApproval(ctx: Context, exec: ToolRunContext, candidate: ImportCandidate, target: 'wiki' | 'memory', record?: (outcome: ApprovalOutcome) => void): Promise<CandidateApproval | null> {
  requireAgent(exec)
  exec.signal.throwIfAborted()
  if (!ctx.approval) { record?.('unavailable'); return null }
  const outcome = await ctx.approval.request({
    agent: exec.agent, toolName: 'mirobody_commit_import', signal: exec.signal,
    reason: `Approve ${target} persistence of reviewed candidate ${candidate.id}, digest ${candidate.digest}, scope ${candidate.scopeKey}, destination ${candidate.targetPath}, expected version ${candidate.expectedVersion}. This does not authorize the other destination or model transmission.`,
  })
  record?.(outcome)
  exec.signal.throwIfAborted()
  if (outcome !== 'allowed-once') return null
  return {
    digest: candidate.digest, scopeKey: candidate.scopeKey, sessionId: exec.agent.session.id,
    target, targetPath: candidate.targetPath, expectedVersion: candidate.expectedVersion,
    grantedAt: Date.now(), expiresAt: Date.now() + 5 * 60_000,
  }
}

export function checkApproval(approval: CandidateApproval | undefined, candidate: ImportCandidate, target: 'wiki' | 'memory', sessionId: string, now = Date.now()): void {
  if (!approval || approval.target !== target || approval.digest !== candidate.digest || approval.scopeKey !== candidate.scopeKey || approval.sessionId !== sessionId || approval.targetPath !== candidate.targetPath || approval.expectedVersion !== candidate.expectedVersion || approval.expiresAt <= now) throw new Error('APPROVAL_REQUIRED')
}
