import type { MirobodyResponse } from './mirobody/types.js'

/** Scope is one tool call, never a claim about the host or the whole turn. */
export const LOOKUP_STORAGE_NOTE = '本工具未向 Wiki/MemOS 提交；DSH 会话历史与日志仍可能留存。'
export const LOOKUP_EFFECTS = { businessCommitByThisCall: false, hostPersistence: 'not-assessed' } as const
export const BRIEF_ANSWER_STYLE = '除非用户明确要求详细报告，最终目标80–180字符、上限300字符，用一两句给出结果和必要证据；省略完整版本、哈希、英文警告名、状态字段和重复限制。提到保存时只说本工具是否提交到Wiki/MemOS及DSH仍可能留存，不加“未保存”或“无其他改动”等概括。'
export const READBACK_ANSWER_STYLE = BRIEF_ANSWER_STYLE + '读回核对只列用户所问字段，再用页面名称和记忆来源简短说明是否一致；除非用户索要审计详情，不抄完整路径、lookup ID、候选哈希或中英文字段名。这些标识用于工具核验，不需要全部展示。'

/** Describe only conditions actually present, not a checklist of all caveats. */
export function clinicalEvidenceNote(result: MirobodyResponse): string {
  if (!result.readings?.length) return '本次没有返回可核验的指标读数，请依据状态说明，不能据此断言无标准映射。'
  const unresolved = result.readings.some(row => row.status !== 'ready' || !row.code)
  const multiple = result.readings.some(row => row.candidates > 1 || row.warnings.includes('MULTIPLE_LEXICAL_CANDIDATES_REVIEW_REQUIRED'))
  return [
    unresolved ? '部分或全部读数在当前本地词典中未确定映射，保留原文待核对。' : '当前本地词典的词法匹配见 readings，保留原始数值和单位。',
    multiple ? '存在多候选，需核对名称、标本和量纲，不能作为唯一已确认编码。' : '',
    '不是临床验证。',
  ].filter(Boolean).join('')
}

/** Tags label records; they are not trusted proof of author or human approval. */
export function memoryOrigin(tags: readonly string[]) {
  const imported = tags.includes('approved-import'), captured = tags.includes('lightweight_memory')
  if (imported && captured) return { kind: 'mixed-tags', note: '记录含导入与捕获两类标签，来源需结合正文核对。' }
  if (imported) return { kind: 'approved-import', note: '记录标记为批准导入，不能称为自然对话自动捕获；标签本身不证明真人审批。' }
  if (captured) return { kind: 'lightweight-memory', note: '记录标记为轻量对话捕获，不等于已审批的 Wiki 知识。' }
  return { kind: 'unverified', note: '记录来源类型未确认，不猜测由聊天捕获或人工导入。' }
}
