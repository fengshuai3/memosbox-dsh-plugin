import { describe, expect, it } from 'vitest'
import { inventsTransmissionRefusal } from './approval-answer-checks.mjs'

describe('approval answer regression checker', () => {
  it('detects the reproduced incorrect stage and destination wording', () => {
    expect(inventsTransmissionRefusal('被拒的外发不影响先前已获准的读取')).toBe(true)
    expect(inventsTransmissionRefusal('模型外发被拒绝。')).toBe(true)
    expect(inventsTransmissionRefusal('外发 Wiki 已停止。')).toBe(true)
  })
  it('does not mistake a denied inference for an assertion', () => {
    expect(inventsTransmissionRefusal('写入被拒只针对本次本地提交，不代表读取或模型外发被拒；DSH 日志仍可能持久化。')).toBe(false)
    expect(inventsTransmissionRefusal('本地 Wiki 获批；本地 MemOS 被拒。')).toBe(false)
    expect(inventsTransmissionRefusal('不代表模型外发被拒。另一个结论：模型外发被拒绝。')).toBe(true)
  })
})
