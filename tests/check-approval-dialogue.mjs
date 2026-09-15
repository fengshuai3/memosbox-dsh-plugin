/** Evidence checks for actual DSH dialogue, not a fake human approval. */
import assert from 'node:assert/strict'
import { readFile, writeFile } from 'node:fs/promises'
import { resolve, join } from 'node:path'
import { createHash } from 'node:crypto'
import { inventsTransmissionRefusal } from './approval-answer-checks.mjs'
const root = resolve(import.meta.dirname, '..')
const option = key => process.argv[process.argv.indexOf(key) + 1]
assert(process.argv.includes('--input') && process.argv.includes('--output'))
const input = resolve(option('--input')), output = resolve(option('--output'))
assert(input.startsWith(join(root, '.test-runtime') + '/') && output.startsWith(join(root, 'reports') + '/'))
const bytes = await readFile(input), report = JSON.parse(bytes)
const sha = value => createHash('sha256').update(value).digest('hex')
assert.equal(sha(await readFile(report.artifact)), report.artifactSha256)
const checks = []
const check = (name, passed) => checks.push({ name, passed: Boolean(passed) })
const final = c => c.sessions.map(s => s.finalAnswer).join('\n')
const tools = c => c.sessions.flatMap(s => s.toolCalls).map(t => t.name)
const observations = c => c.sessions.flatMap(s => s.toolResults).flatMap(r => r.message.content.filter(b => b.type === 'tool-result')).map(block => ({ isError: block.isError, values: block.content.filter(b => b.type === 'text').map(b => { try { return JSON.parse(b.text) } catch { return null } }).filter(Boolean) }))
const values = c => observations(c).flatMap(x => x.values)
const decided = c => c.approvals.filter(a => a.type === 'approval/decided')
for (const c of report.cases) {
  check(`${c.phase}: successful real model turn`, c.outcome.code === 0 && !c.outcome.timedOut && !c.outcome.outputExceeded && c.sessions.length === 1 && c.sessions[0].messages.every(m => m.model === report.model) && final(c).trim())
  check(`${c.phase}: no tool errors`, observations(c).every(r => !r.isError))
  const requests = c.approvals.filter(a => a.type === 'approval/asked')
  check(`${c.phase}: every request has exactly one decision`, requests.length === decided(c).length && requests.every(a => decided(c).filter(d => d.data.id === a.data.id).length === 1))
  if (c.phase === 'allow') {
    check('parse before preview before commit', tools(c).indexOf('mirobody_parse_document') >= 0 && tools(c).indexOf('mirobody_preview_import') > tools(c).indexOf('mirobody_parse_document') && tools(c).indexOf('mirobody_commit_import') > tools(c).indexOf('mirobody_preview_import'))
    check('four independent allowed-once approvals', requests.length === 4 && decided(c).every(d => d.data.outcome === 'allowed-once'))
    check('dual destination persisted and verified', values(c).some(v => v.data?.status === 'complete' && v.data?.wiki?.ok && v.data?.memory?.verified))
    check('answer reports independent approvals', /独立/.test(final(c)) && !/均由同一次审批|未分别得到独立/.test(final(c)))
  } else if (c.phase === 'readback') {
    const allowed = report.cases.find(x => x.phase === 'allow')
    const commit = allowed && values(allowed).find(v => v.data?.status === 'complete')?.data
    const memory = values(c).find(v => v.data?.id === commit?.memory?.id && v.data?.text)?.data
    check('actual wiki_get and memos_get in new session', tools(c).includes('wiki_get') && tools(c).includes('memos_get') && !tools(c).includes('mirobody_commit_import'))
    check('readback matches exact committed identity and candidate', memory && memory.text.includes(commit.candidateDigest) && memory.truncated === false)
    let reading
    try { reading = JSON.parse(memory.text.match(/```json\n([\s\S]*?)\n```/)[1])[0] } catch {}
    check('raw name/value/unit and code actually read', reading?.rawName === 'Hemoglobin [Mass/volume] in Blood' && reading.rawValue === '130' && reading.rawUnit === 'g/L' && reading.code === '718-7')
    check('answer includes observed fields', ['Hemoglobin [Mass/volume] in Blood', '130', 'g/L', '718-7'].every(term => final(c).includes(term)))
  } else {
    const boundary = c.phase.split('-')[1], expected = c.phase.startsWith('cancel-') ? 'cancelled' : 'rejected'
    const refused = values(c).find(v => v.data?.status === 'refused')?.data
    check(`${c.phase}: actual requested refusal`, decided(c).at(-1)?.data.outcome === expected && refused?.approvalDecisions.at(-1)?.outcome === expected)
    check(`${c.phase}: no completed business writes`, !values(c).some(v => v.data?.status === 'complete') && (refused?.destinationsChanged === false || refused?.effects?.wikiCommitted === false && refused?.effects?.memoryCommitted === false))
    if (boundary === 'read' || boundary === 'transmit') check(`${c.phase}: model not dispatched`, refused?.effects?.modelDispatched === false && refused.effects.sourceRead === (boundary === 'transmit'))
    if (boundary === 'transmit') check(`${c.phase}: answer acknowledges prior read`, /读取[\s\S]*(获批|批准|完成|allowed-once)/.test(final(c)) && !/读取[^。\n]*未被单独请求/.test(final(c)))
    if (expected === 'cancelled') check(`${c.phase}: answer distinguishes cancellation`, /取消/.test(final(c)) && !/取消\s*[\/／或]\s*拒绝|被拒绝|遭拒绝/.test(final(c)))
    if (boundary === 'memory' || boundary === 'wiki') check(`${c.phase}: no invented model refusal or remote Wiki write`, !inventsTransmissionRefusal(final(c)))
  }
}
const result = { schemaVersion: 1, version: JSON.parse(await readFile(join(root, 'package.json'))).version, verifiedAt: new Date().toISOString(), artifactSha256: report.artifactSha256, sourceEvidenceSha256: sha(bytes), input, checks, machineChecksPassed: checks.every(c => c.passed), humanPerformed: false, uiTested: false, semanticReviewRequired: true, cases: report.cases.length, steps: report.cases.flatMap(c => c.sessions).reduce((n, s) => n + s.stepCount, 0), toolCalls: report.cases.reduce((n, c) => n + tools(c).length, 0) }
await writeFile(output, JSON.stringify(result, null, 2) + '\n', { flag: 'wx', mode: 0o600 })
console.log(JSON.stringify(result, null, 2))
if (!result.machineChecksPassed) process.exitCode = 1
