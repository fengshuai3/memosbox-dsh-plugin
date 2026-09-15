import { describe, it, expect } from 'vitest'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import { ApprovalRequestId } from '@deepseek-ai/dsh-user-approval'
import { ApprovalStopGuard } from '../src/mirobody/approval-stop.js'

describe('host-turn approval stop', () => {
  it.each(['rejected', 'cancelled', 'unavailable'] as const)('survives reload for %s and resets only at a new host turn', outcome => {
    const session = Session.create(SessionId('stop-test'))
    session.append('turn/start', { turn: 1 })
    const id = ApprovalRequestId('refused')
    session.append('approval/asked', { id, toolName: 'mirobody_commit_import' })
    session.append('approval/decided', { id, outcome })
    const guard = new ApprovalStopGuard()
    expect(guard.blocked(session)).toEqual({ outcome, toolName: 'mirobody_commit_import' })
    session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
    expect(new ApprovalStopGuard().blocked(session)?.outcome).toBe(outcome)
    session.append('turn/start', { turn: 2 })
    expect(guard.blocked(session)).toBeUndefined()
  })
  it('does not treat unrelated denials or grants as an import refusal', () => {
    const session = Session.create(SessionId('unrelated'))
    session.append('turn/start', { turn: 1 })
    for (const [toolName, outcome] of [['other_tool', 'rejected'], ['mirobody_parse_document', 'allowed-once']] as const) {
      const id = ApprovalRequestId(toolName)
      session.append('approval/asked', { id, toolName })
      session.append('approval/decided', { id, outcome })
    }
    expect(new ApprovalStopGuard().blocked(session)).toBeUndefined()
  })
})
