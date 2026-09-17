import { describe, expect, it } from 'vitest'
import { answerGuidance, defaultWikiPath, wikiGuidance } from '../src/index.js'
import { join, resolve } from 'node:path'

describe('plugin configuration', () => {
  it('places default Wiki state under DSH_HOME', () => {
    expect(defaultWikiPath('', { DSH_HOME: '/tmp/dsh-home' }, '/tmp/user')).toBe(join('/tmp/dsh-home', 'memosbox', 'wiki'))
  })

  it('expands a tilde only at the beginning of an explicit path', () => {
    const userHome = resolve('/tmp/user')
    expect(defaultWikiPath('~/knowledge/wiki', {}, userHome)).toBe(join(userHome, 'knowledge', 'wiki'))
  })

  it('states memory, Wiki, and runtime boundaries in the model guidance', () => {
    const guidance = wikiGuidance(false)
    expect(guidance).toContain('stable, source-backed project knowledge')
    expect(guidance).toContain('MemOS')
    expect(guidance).toContain('runtime tools')
    expect(guidance).toContain('mutation is disabled')
  })
  it('separates evidence, entity relevance, language and host persistence', () => {
    expect(wikiGuidance(false)).toContain('exact project/entity ID')
    expect(wikiGuidance(false)).toContain('Never disclose an unrelated')
    expect(answerGuidance()).toContain('中文提问时用简洁中文')
    expect(answerGuidance()).toContain('不要先用全局否定再补救')
    expect(answerGuidance()).toContain('DSH 会话历史')
    expect(answerGuidance()).toContain('单候选不等于正确')
    expect(answerGuidance()).toContain('先区分指标查询与文档导入')
    expect(answerGuidance()).toContain('不能杜撰已经调用检索/读取工具')
  })
  it('accurately describes enabled and disabled automatic capture', () => {
    expect(answerGuidance(true)).toContain('当前自动 capture 已启用')
    expect(answerGuidance(true)).not.toContain('当前自动 capture 已关闭')
    expect(answerGuidance(false)).toContain('当前自动 capture 已关闭')
    expect(answerGuidance()).toContain('只读沙箱约束通用工具')
    expect(answerGuidance(true)).toContain('不能推翻当前工具已读到记录')
  })
})
