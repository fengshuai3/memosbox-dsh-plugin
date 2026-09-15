/** Deterministic checks of real DSH evidence, not a substitute for reading answers. */
import assert from 'node:assert/strict'
import { readFile, writeFile } from 'node:fs/promises'
import { resolve, join } from 'node:path'
import { createHash } from 'node:crypto'
import { answerQualityIssues } from '../tests/answer-quality.mjs'

const root = resolve(import.meta.dirname, '..')
const option = name => { const i = process.argv.indexOf(name); return i < 0 ? undefined : process.argv[i + 1] }
const input = resolve(option('--report') ?? '')
const output = resolve(option('--output') ?? '')
assert(input.startsWith(join(root, 'reports') + '/') && output.startsWith(join(root, 'reports') + '/'), 'Evidence must stay under plugin reports')
const bytes = await readFile(input)
const report = JSON.parse(bytes)
const checks = []
const check = (name, passed) => checks.push({ name, passed: !!passed })
const answer = item => item?.sessions.flatMap(s => s.messages.map(m => m.text)).join('\n') ?? ''
const results = item => item?.sessions.flatMap(s => s.toolResults.flatMap(r => r.message.content.filter(b => b.type === 'tool-result'))) ?? []
const values = item => results(item).flatMap(r => r.content.filter(b => b.type === 'text').flatMap(b => { try { return [JSON.parse(b.text)] } catch { return [] } }))
const caseOf = id => report.cases.find(c => c.id === id)
const json = value => JSON.stringify(value)
const allSessions = report.cases.flatMap(c => c.sessions)
const answerQuality = report.cases.map(c => ({ id: c.id, issues: answerQualityIssues(c.sessions.map(s => s.finalAnswer).join('\n'), { domain: /wiki|project|memory|capture/.test(c.id) ? 'project' : 'clinical', imported: c.id === 'memory-new-session' }) }))
for (const entry of answerQuality) check(`${entry.id}: known answer-quality regressions absent`, entry.issues.length === 0)
check('exact real-model runner scope', report.noFixtureModel && report.noDirectToolExecution && report.noAutomaticApproval && report.shippedPluginPromptUnmodified && report.syntheticOnly)
check('no failed, timed-out, missing or empty model turns', report.cases.every(c => c.outcome.code === 0 && !c.outcome.timedOut && !c.outcome.outputExceeded && c.sessions.length === 1 && answer(c).trim()))
check('every assistant message from selected real model', allSessions.every(s => s.messages.length > 0 && s.messages.every(m => m.model === report.model)))
check('no native tool errors', report.cases.every(c => results(c).every(r => !r.isError)))
check('each native tool call received a result', allSessions.every(s => s.toolCalls.length === s.toolResults.length))

if (report.suite === 'capture') {
  check('three independent capture conversations', report.cases.length === 3 && new Set(allSessions.map(s => s.sessionId)).size === 3)
  check('capture enabled without database preseeding', report.captureEnabled && !report.seed && !report.memorySeed && report.captureFixture?.kind === 'natural-dialogue-only-no-database-preseed')
  const phrase = report.captureFixture?.phrase
  check('recall prompt contains no answer marker', phrase && !caseOf('capture-cross-session-recall')?.prompt.includes(phrase))
  check('new process recalls exact naturally supplied marker', phrase && answer(caseOf('capture-cross-session-recall')).includes(phrase))
  const proof = report.captureStorageProof
  check('recall evidence contains persisted lightweight trace', json(values(caseOf('capture-cross-session-recall'))).includes('lightweight_memory') || (proof?.method === 'public-core-export-after-first-process-exit-before-recall' && proof.markerPersisted && proof.lightweightTrace && proof.ownerMatches && proof.noRowsInsertedByObserver))
  check('other workspace returns no marker in answers or tool results', phrase && !json(caseOf('capture-other-workspace')).includes(phrase))
} else {
  check('ten independent regression conversations', report.cases.length === 10 && new Set(allSessions.map(s => s.sessionId)).size === 10)
  check('canonical hemoglobin code', answer(caseOf('canonical-term')).includes('718-7'))
  for (const id of ['ambiguous-term', 'unknown-term']) check(`${id}: actual local resolver called`, caseOf(id)?.sessions.some(s => s.toolCalls.some(t => t.name === 'mirobody_resolve')))
  check('original glucose value preserved', answer(caseOf('raw-value-preservation')).includes('<5.60') && answer(caseOf('raw-value-preservation')).includes('mg/dL'))
  for (const [id, code] of [['creatinine-alias', '2160-0'], ['bilirubin-alias', '1975-2']]) {
    const data = json(values(caseOf(id)))
    check(`${id}: correct code in tool evidence and answer`, data.includes(`"code":"${code}"`) && answer(caseOf(id)).includes(code) && !data.includes('"code":"44760-7"'))
  }
  check('correct Wiki entity returns exact marker', report.seed?.expectedPassphrase && answer(caseOf('wiki-new-session')).includes(report.seed.expectedPassphrase))
  for (const id of ['unknown-project', 'memory-new-session', 'memory-other-workspace']) check(`${id}: no unrelated Wiki marker in answers or tools`, report.seed?.expectedPassphrase && !json(caseOf(id)).includes(report.seed.expectedPassphrase))
  check('preseed MemOS positive recall', report.memorySeed?.expectedPhrase && answer(caseOf('memory-new-session')).includes(report.memorySeed.expectedPhrase))
  check('MemOS workspace isolation', report.memorySeed?.expectedPhrase && !json(caseOf('memory-other-workspace')).includes(report.memorySeed.expectedPhrase))
}
const result = {
  checkedAt: new Date().toISOString(), input, inputSha256: createHash('sha256').update(bytes).digest('hex'),
  artifactSha256: report.artifactSha256, suite: report.suite, model: report.model, checks,
  machineChecksPassed: checks.every(c => c.passed),
  sessions: allSessions.length, steps: allSessions.reduce((n, s) => n + s.stepCount, 0),
  toolCalls: allSessions.reduce((n, s) => n + s.toolCalls.length, 0),
  answerLengths: report.cases.map(c => ({ id: c.id, chars: answer(c).length })),
  semanticReviewRequired: ['privacy claims', 'evidence boundaries', 'unnecessary inference', 'language and concision'],
  answerQuality,
  publicationReady: false, healthPrivacyQualified: false,
}
await writeFile(output, JSON.stringify(result, null, 2) + '\n', { mode: 0o600, flag: 'wx' })
console.log(JSON.stringify(result, null, 2))
if (!result.machineChecksPassed) process.exitCode = 1
