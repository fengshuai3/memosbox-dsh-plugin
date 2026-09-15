/** Sanitize exact-candidate evidence without promoting simulations to approval. */
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFile, writeFile, mkdir, realpath } from 'node:fs/promises'
import { resolve, join } from 'node:path'
const root = resolve(import.meta.dirname, '..')
const arg = name => process.argv[process.argv.indexOf(name) + 1]
assert(process.argv.includes('--dialogue') && process.argv.includes('--service'))
const read = async path => JSON.parse(await readFile(path, 'utf8'))
const dialoguePath = await realpath(resolve(arg('--dialogue')))
const servicePath = await realpath(resolve(arg('--service')))
assert(dialoguePath.startsWith(join(root, '.test-runtime') + '/') && servicePath.startsWith(join(root, 'artifacts') + '/'))
const dialogue = await read(dialoguePath), service = await read(servicePath)
assert.equal(dialogue.artifactSha256, service.sha256)
const hash = data => createHash('sha256').update(data).digest('hex')
assert.equal(hash(await readFile(dialogue.artifact)), service.sha256)
const dir = join(root, 'release/evidence'); await mkdir(dir, { recursive: true })
const common = { schemaVersion: 1, version: '0.2.0-beta.2', artifactSha256: service.sha256, verifiedAt: new Date().toISOString() }
const simulation = { ...common, kind: 'approvalSimulation', passed: true, humanPerformed: false, uiTested: false, scope: service.scope,
  checks: { nativeApprovalService: service.realApprovalService, allEightNegativeCases: service.approvalSimulation.negativeCases.length === 8, noWritesWhenRejected: service.approvalSimulation.rejectedWritesByteIdentical, noModelDispatchWhenRejected: service.approvalSimulation.modelTransmissionPreventedWhenDenied, separateProcessReadback: service.separateProcessReadback, ambiguousCandidateBlocked: service.approvalSimulation.ambiguousCandidateBlocked }, negativeCases: service.approvalSimulation.negativeCases, sourceEvidenceSha256: hash(await readFile(servicePath)) }
assert(Object.values(simulation.checks).every(Boolean))
const results = c => c.sessions.flatMap(s => s.toolResults).flatMap(r => r.message.content).flatMap(block => block.content ?? []).filter(b => b.type === 'text').map(b => { try { return JSON.parse(b.text) } catch { return { error: 'NON_JSON_TOOL_RESULT' } } })
const allow = dialogue.cases.find(c => c.phase === 'allow'), readback = dialogue.cases.find(c => c.phase === 'readback'), denied = dialogue.cases.find(c => c.phase === 'reject-transmit')
assert(allow && readback && denied)
const asked = c => c.approvals.filter(a => a.type === 'approval/asked')
const cases = dialogue.cases.map(c => ({ phase: c.phase, exitCode: c.outcome.code, timedOut: c.outcome.timedOut, tools: c.sessions.flatMap(s => s.toolCalls.map(t => t.name)), approvalRequests: asked(c).length, stepCount: c.sessions.reduce((n, s) => n + s.stepCount, 0) }))
const checks = { actualModelDialogues: dialogue.cases.every(c => c.sessions.some(s => s.messages.length)), fourIndependentApprovals: asked(allow).length === 4, dualDestinationCommitted: results(allow).some(r => r.data?.status === 'complete' && r.data?.memory?.verified), deniedTransmissionStopped: results(denied).some(r => r.data?.status === 'refused') && !denied.sessions.some(s => s.toolCalls.some(t => t.name === 'mirobody_commit_import')), memorySearchReadback: results(readback).some(r => r.data?.hits?.length > 0), approvalExplanationCorrect: !dialogue.cases.some(c => c.sessions.some(s => /同一次审批|读取.*未被单独请求/.test(s.finalAnswer))) }
const report = { ...common, kind: 'realDialogue', passed: false, scope: 'Three real-model synthetic document conversations with scripted approval operator; not a human UI test', humanPerformed: false, provider: dialogue.provider, model: dialogue.model, cases, checks,
  findings: ['MODEL_MISSTATES_SEPARATE_APPROVALS', 'CROSS_SESSION_MEMORY_QUERY_MISSES_COMMITTED_RECORD', 'OVERBROAD_NO_STORAGE_WORDING'], sourceEvidenceSha256: hash(await readFile(dialoguePath)) }
for (const [name, data] of [['approval-simulation-2026-09-15.json', simulation], ['approval-real-dialogue-2026-09-15.json', report]]) await writeFile(join(dir, name), JSON.stringify(data, null, 2) + '\n')
if (process.argv.includes('--capture')) {
  const path = await realpath(resolve(arg('--capture')))
  assert(path.startsWith(join(root, 'reports') + '/'))
  const bytes = await readFile(path), capture = JSON.parse(bytes)
  assert.equal(capture.artifactSha256, service.sha256)
  const original = await realpath(capture.input)
  assert(original.startsWith(join(root, 'reports') + '/'))
  assert.equal(hash(await readFile(original)), capture.inputSha256)
  assert.equal(JSON.parse(await readFile(original)).artifactSha256, service.sha256)
  assert(capture.machineChecksPassed && capture.checks.every(c => c.passed === true))
  const receipt = { ...common, verifiedAt: capture.checkedAt, kind: 'automaticCapture', passed: true,
    scope: 'Previously executed exact-candidate synthetic natural capture, fresh-process recall and other-workspace negative; machine checks only, not full semantic or health privacy approval. Evidence rehashed, conversations not rerun today.',
    checks: Object.fromEntries(capture.checks.map(c => [c.name, c.passed])), sessions: capture.sessions, model: capture.model, sourceEvidenceSha256: hash(bytes), originalRunSha256: capture.inputSha256 }
  await writeFile(join(dir, 'automatic-capture-2026-09-14.json'), JSON.stringify(receipt, null, 2) + '\n')
}
const approval = await read(join(root, 'release/approval.json'))
approval.publicationReady = false
approval.artifactSha256 = service.sha256
for (const [key, filename] of [['licenses', 'licenses-2026-09-15.json'], ['realDialogue', 'approval-real-dialogue-2026-09-15.json'], ['approvalSimulation', 'approval-simulation-2026-09-15.json'], ['migrationRollback', 'migration-rollback-2026-09-15.json'], ['automaticCapture', 'automatic-capture-2026-09-14.json']]) {
  try {
    const bytes = await readFile(join(dir, filename)), data = JSON.parse(bytes)
    assert.equal(data.artifactSha256, service.sha256)
    approval.evidence[key] = { passed: data.passed, path: `release/evidence/${filename}`, sha256: hash(bytes) }
  } catch (e) { if (e.code !== 'ENOENT') throw e }
}
await writeFile(join(root, 'release/approval.json'), JSON.stringify(approval, null, 2) + '\n')
console.log(JSON.stringify({ approvalSimulation: simulation.passed, realDialogue: report.passed, checks, publicationReady: false }))
