/** Detect reproduced answer defects; never rewrite answers or replace review. */
export function answerQualityIssues(answer, { domain = 'general', imported = false, maxChars = 300 } = {}) {
  const issues = []
  if ([...answer].length > maxChars) issues.push('answer-exceeds-character-budget')
  const asserted = answer.split(/[。；\n]/u).map(part => part.replace(/(?:不能|不可|不应|不代表|不等于|无法)(?:声称|说成|断言|保证)?[^。；\n]*/gu, '')
    // A scoped hypothesis about an absent record is not a no-retention promise.
    .replace(/可能[^。；\n]*未保存(?:在|于)(?:当前|本)工作区[^，。；\n]*/gu, '')).join('\n')
  if (/(?:未(?:做(?:任何)?|执行(?:任何)?|进行(?:任何)?)?保存|没有(?:做)?(?:任何)?保存|没有任何文件(?:修改|改动)|本会话未做其他改动|只(?:存在|保留|存放)?(?:于|在)内存)/u.test(asserted)) issues.push('unscoped-persistence-claim')
  if (domain === 'project' && /临床|标本|量纲|其他标准|标准词典|词典/u.test(answer)) issues.push('clinical-boilerplate-in-project-answer')
  if (/单候选不等于正确/u.test(answer) && /多候选|\d{2,}\s*个(?:词法)?候选/u.test(answer)) issues.push('single-candidate-boilerplate-with-multiple-results')
  if (imported && /(?:这是|来源是|属于|为)对话记忆|自然对话自动捕获/u.test(asserted)) issues.push('import-misdescribed-as-capture')
  if (domain === 'clinical' && /未识别为任何标准指标|没有任何标准映射/u.test(asserted)) issues.push('global-absence-instead-of-local-evidence')
  return issues
}
