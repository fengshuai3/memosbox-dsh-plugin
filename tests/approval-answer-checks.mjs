/** Narrow known-regression checks, not a general natural-language judge. */
export function inventsTransmissionRefusal(answer) {
  return answer.split(/[，。；\n]/u).some(clause => {
    // A disclaimer such as “不代表读取或模型外发被拒” denies the claim.
    const asserted = clause.replace(/(?:不代表|不等于|并非|不是)[^，。；\n]*/gu, '')
    return /被拒的外发|外发[^。\n]{0,16}(被拒|遭拒)|外发\s*Wiki/u.test(asserted)
  })
}
