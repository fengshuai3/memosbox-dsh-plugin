import { describe, expect, it } from 'vitest'
import { clinicalEvidenceNote, LOOKUP_EFFECTS, LOOKUP_STORAGE_NOTE, memoryOrigin } from '../src/answer-evidence.js'
import type { MirobodyResponse } from '../src/mirobody/types.js'
import { answerGuidance } from '../src/index.js'

const response = (count: number, resolved = true): MirobodyResponse => ({
  schemaVersion: 1, operationId: 'fixture', operation: 'resolve', status: resolved ? 'ready' : 'unresolved', bundleVersion: 'fixture', warnings: [], truncated: false,
  readings: [{ rawName: 'Synthetic', rawValue: '<5.60', rawUnit: 'mg/dL', normalizedValue: '<5.60', normalizedUnit: 'mg/dL', status: resolved ? 'ready' : 'unresolved', resolutionMethod: 'lexical', codeSystem: resolved ? 'loinc' : '', code: resolved ? 'fixture-code' : '', canonical: 'Synthetic', candidates: count, bundleVersion: 'fixture', evidenceRefs: [], warnings: [] }],
})

describe('evidence-specific answer notes', () => {
  it('limits write effects to the current business call', () => {
    expect(LOOKUP_EFFECTS).toEqual({ businessCommitByThisCall: false, hostPersistence: 'not-assessed' })
    expect(LOOKUP_STORAGE_NOTE).toContain('本工具未向 Wiki/MemOS 提交')
    expect(LOOKUP_STORAGE_NOTE).toContain('仍可能留存')
    expect(LOOKUP_STORAGE_NOTE).not.toContain('未保存')
  })
  it('does not attach missing-match or multiple-match disclaimers to a single match', () => {
    const result = response(1), before = JSON.stringify(result)
    const note = clinicalEvidenceNote(result)
    expect(note).toContain('不是临床验证')
    expect(note).not.toMatch(/未确定|多候选|未匹配/)
    expect(JSON.stringify(result)).toBe(before)
  })
  it('reports multiple candidates without contradictory single-candidate boilerplate', () => {
    expect(clinicalEvidenceNote(response(72))).toContain('存在多候选')
    expect(clinicalEvidenceNote(response(72))).not.toContain('单候选')
  })
  it('keeps unresolved and unavailable results within available evidence', () => {
    expect(clinicalEvidenceNote(response(0, false))).toContain('当前本地词典中未确定映射')
    expect(clinicalEvidenceNote({ ...response(0), readings: [], status: 'unavailable' })).toContain('没有返回可核验')
  })
  it('distinguishes tagged import, capture, mixed tags and unknown origin', () => {
    expect(memoryOrigin(['approved-import']).kind).toBe('approved-import')
    expect(memoryOrigin(['approved-import']).note).toContain('不证明真人审批')
    expect(memoryOrigin(['lightweight_memory']).kind).toBe('lightweight-memory')
    expect(memoryOrigin(['lightweight_memory', 'approved-import']).kind).toBe('mixed-tags')
    expect(memoryOrigin([]).kind).toBe('unverified')
    expect(memoryOrigin(['other']).kind).toBe('unverified')
  })
  it('asks for concise answers without mandatory headings or a repeated disclaimer list', () => {
    const guidance = answerGuidance()
    expect(guidance).toContain('总长不超过 300 字符')
    expect(guidance).toContain('不必写“结论/依据/限制”标题')
    expect(guidance).toContain('不要求每个回答重复说明所有限制')
    expect(guidance).toContain('项目 Wiki/记忆只谈当前工作区')
    expect(guidance).toContain('\n')
    expect(guidance).not.toContain('\\n')
  })
})
