/** Narrow known-regression checks, not a general natural-language judge. */
export function reportsIndependentApprovals(answer) {
  return /独立|分别.{0,8}(获批|批准|审批)|各自.{0,8}(获批|批准|审批)/.test(answer) && !/均由同一次审批|未分别得到独立/.test(answer)
}
export function acknowledgesPriorRead(answer) {
  return /读取[\s\S]*(获批|批准|完成|allowed-once)|(?:已|已经)[^。\n]{0,8}(?:获批|批准)[^。\n]{0,8}读取/.test(answer)
    && !/读取[^。\n]*未被单独请求/.test(answer)
}
export function inventsTransmissionRefusal(answer) {
  return answer.split(/[，。；\n]/u).some(clause => {
    // A disclaimer such as “不代表读取或模型外发被拒” denies the claim.
    const asserted = clause.replace(/(?:不代表|不等于|并非|不是)[^，。；\n]*/gu, '')
    return /被拒的外发|外发[^。\n]{0,16}(被拒|遭拒)|外发\s*Wiki/u.test(asserted)
  })
}
