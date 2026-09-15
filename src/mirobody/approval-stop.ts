import { SessionSeq, type Session } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-user-approval'
import type { ApprovalOutcome } from './approval.js'

type Stop = { outcome: Exclude<ApprovalOutcome, 'allowed-once'>; toolName: string }
const protectedTools = new Set(['mirobody_parse_document', 'mirobody_commit_import'])

/** A denial stops the whole import workflow, not just one destination.
 * Only a new host turn resets it; model arguments, new candidates and new
 * execution objects cannot. Read the audit log too, so plugin reload cannot
 * erase a refusal. This does not police unrelated host tools/plugins.
 */
export class ApprovalStopGuard {
  private readonly stops = new WeakMap<Session, { turn: number | undefined; stop: Stop }>()

  private audit(session: Session): { turn: number | undefined; stop?: Stop } {
    const denied = new Map<string, Stop['outcome']>()
    let stop: Stop | undefined
    // Small direct-tool embedders may not expose the DSH log. In that case
    // the in-process stop is conservative and cannot reset itself.
    if (typeof session.eventAt !== 'function') return { turn: undefined }
    for (let seq = session.seq - 1; seq >= 0; seq--) {
      const event = session.eventAt(SessionSeq(seq))
      if (event?.type === 'turn/start') return { turn: seq, ...(stop ? { stop } : {}) }
      if (event?.type === 'approval/decided' && event.data.outcome !== 'allowed-once') denied.set(event.data.id, event.data.outcome)
      if (event?.type === 'approval/asked' && protectedTools.has(event.data.toolName)) {
        const outcome = denied.get(event.data.id)
        if (outcome) stop = { outcome, toolName: event.data.toolName }
      }
    }
    return { turn: undefined, ...(stop ? { stop } : {}) }
  }

  blocked(session: Session): Stop | undefined {
    const audit = this.audit(session)
    const cached = this.stops.get(session)
    if (cached && cached.turn !== audit.turn) this.stops.delete(session)
    return audit.stop ?? (cached?.turn === audit.turn ? cached?.stop : undefined)
  }

  record(session: Session, toolName: string, outcome: ApprovalOutcome): void {
    if (outcome !== 'allowed-once') this.stops.set(session, { turn: this.audit(session).turn, stop: { toolName, outcome } })
  }
}
