import { describe, expect, it } from 'vitest'
import { acknowledgesPriorRead, inventsTransmissionRefusal, reportsIndependentApprovals } from './approval-answer-checks.mjs'

describe('approval answer regression checker', () => {
  it('recognizes read approval in either word order', () => {
    expect(acknowledgesPriorRead('源文件已单独获批读取，但模型外发被取消。')).toBe(true)
    expect(acknowledgesPriorRead('源文件读取已经获批完成。')).toBe(true)
    expect(acknowledgesPriorRead('读取未被单独请求，模型外发获批。')).toBe(false)
    expect(acknowledgesPriorRead('源文件未获批读取。')).toBe(false)
  })
  it('accepts equivalent independent approval wording, not a same-grant claim', () => {
    expect(reportsIndependentApprovals('四项授权各自获批一次。')).toBe(true)
    expect(reportsIndependentApprovals('Wiki 与记忆分别批准。')).toBe(true)
    expect(reportsIndependentApprovals('Wiki 与记忆均由同一次审批完成。')).toBe(false)
  })
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
