import { describe, expect, it } from 'vitest'
import { answerQualityIssues } from './answer-quality.mjs'

describe('known answer-quality regression detection', () => {
  it('catches broad storage promises even if a later disclaimer is appended', () => {
    for (const answer of ['结果未保存。', '未做任何保存。DSH 日志仍可能留存。', '内容只在内存。']) expect(answerQualityIssues(answer)).toContain('unscoped-persistence-claim')
    expect(answerQualityIssues('本工具未向 Wiki/MemOS 提交；DSH 会话历史与日志仍可能留存。')).toEqual([])
    expect(answerQualityIssues('不能声称未保存。')).toEqual([])
    expect(answerQualityIssues('可能是尚未记录，或未保存在当前工作区范围内。')).toEqual([])
    expect(answerQualityIssues('本次未保存。可能未保存在当前工作区。')).toContain('unscoped-persistence-claim')
  })
  it('checks domain, provenance, global claims and length independently', () => {
    expect(answerQualityIssues('不代表其他标准中不存在。', { domain: 'project' })).toContain('clinical-boilerplate-in-project-answer')
    expect(answerQualityIssues('这是对话记忆。', { imported: true })).toContain('import-misdescribed-as-capture')
    expect(answerQualityIssues('记录标记为批准导入。', { imported: true })).toEqual([])
    expect(answerQualityIssues('未识别为任何标准指标。', { domain: 'clinical' })).toContain('global-absence-instead-of-local-evidence')
    expect(answerQualityIssues('字'.repeat(301))).toContain('answer-exceeds-character-budget')
    expect(answerQualityIssues('共 72 个候选；单候选不等于正确。')).toContain('single-candidate-boilerplate-with-multiple-results')
  })
})
