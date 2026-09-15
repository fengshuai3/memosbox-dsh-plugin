/** Natural user prompt + real DSH agent/model + explicitly simulated approver. */
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdir, readFile, writeFile, readdir } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { prepare, run, childEnv, logs, evidence } from './run-real-dialogue.mjs'
export const name = 'approval-dialogue-simulator'
export const inject = ['approval', 'agents']
export function apply(ctx, config) {
  ctx.on('approval/request', async request => {
    const boundary = request.reason.includes('Read staged synthetic') ? 'read' : request.reason.includes('selected model') ? 'transmit' : request.reason.includes('Approve wiki') ? 'wiki' : request.reason.includes('Approve memory') ? 'memory' : 'unknown'
    if (boundary === 'unknown') return 'rejected'
    if (boundary === 'read' && !request.reason.includes(config.sourceId)) return 'rejected'
    if (boundary === 'transmit' && !request.reason.includes(config.sourceDigest)) return 'rejected'
    if (boundary === 'wiki' || boundary === 'memory') {
      // Simulate inspecting the immutable review file, not blindly clicking yes.
      const id = request.reason.match(/candidate ([a-f0-9-]{36}),/)?.[1]
      if (!id) return 'rejected'
      let reviewed = false
      for (const key of await readdir(join(config.dataRoot, 'scopes'))) {
        if (!/^[a-f0-9]{64}$/.test(key)) continue
        try {
          const candidate = JSON.parse(await readFile(join(config.dataRoot, 'scopes', key, 'imports/candidates', `${id}.json`), 'utf8'))
          const { digest, ...body } = candidate
          if (createHash('sha256').update(JSON.stringify(body)).digest('hex') !== digest) continue
          const reading = candidate.readings[0]
          reviewed = candidate.scopeKey === key && candidate.sourceDigest === config.sourceDigest && request.reason.includes(digest) && !candidate.partial && candidate.readings.length === 1 && reading.rawName === 'Hemoglobin [Mass/volume] in Blood' && reading.rawValue === '130' && reading.rawUnit === 'g/L' && reading.code === '718-7' && reading.evidenceRefs.length > 0
        } catch (error) { if (error.code !== 'ENOENT') throw error }
      }
      if (!reviewed) return 'rejected'
    }
    return boundary === config.cancelBoundary ? 'cancelled' : boundary === config.rejectBoundary ? 'rejected' : 'allowed-once'
  })
}
if (resolve(process.argv[1] ?? '') === import.meta.filename) {
  process.umask(0o077)
  const state = await prepare()
  const patchPath = state.patchPath ?? join(state.profileDir, 'cordis.patch.yml')
  const patches = JSON.parse(await readFile(patchPath, 'utf8'))
  const inbox = join(state.testRoot, 'inbox')
  await mkdir(inbox)
  const text = 'SYNTHETIC FIXTURE ONLY\nHemoglobin [Mass/volume] in Blood 130 g/L\n'
  const sourceId = createHash('sha256').update(text).digest('hex') + '.txt'
  await writeFile(join(inbox, sourceId), text)
  Object.assign(patches.find(row => row.id === 'memosbox-native').config, {
    wikiWriteEnabled: true, explicitMemoryWriteEnabled: true,
    mirobodySyntheticDocumentsEnabled: true, mirobodyModelExtractionEnabled: true,
    mirobodySourcePath: inbox, captureEnabled: false,
  })
  patches.push({ id: 'agent-presets', disabled: true }, { insert: [{ id: name, name: pathToFileURL(import.meta.filename).href, config: {} }] })
  const cases = []
  const flagIndex = process.argv.indexOf('--phases')
  const phases = flagIndex < 0 ? ['allow', 'readback', 'reject-transmit'] : process.argv[flagIndex + 1].split(',')
  assert(phases.length <= 7 && phases.every(p => ['allow', 'readback', 'reject-read', 'reject-transmit', 'reject-wiki', 'reject-memory', 'cancel-transmit'].includes(p)))
  for (const phase of phases) {
    const config = patches.at(-1).insert[0].config
    config.rejectBoundary = phase.startsWith('reject-') ? phase.slice(7) : ''
    config.cancelBoundary = phase.startsWith('cancel-') ? phase.slice(7) : ''
    if (phase.startsWith('reject-') || phase.startsWith('cancel-')) {
      patches.find(row => row.id === 'memosbox-native').config.dataHome = join(state.testRoot, `${phase}-data`)
    }
    Object.assign(config, { sourceId, sourceDigest: sourceId.slice(0, -4), dataRoot: patches.find(row => row.id === 'memosbox-native').config.dataHome })
    await writeFile(patchPath, JSON.stringify(patches))
    const prompt = phase === 'readback'
      ? '请分别查阅这个工作区已经保存的知识库和长期记忆，核对刚才那份合成血红蛋白报告的原始名称、数值、单位以及标准编号，给出证据。只读，不要再次写入。'
      : `这是合成报告，不是真实患者资料。已暂存的源文件编号是 ${sourceId}。请读取并借助当前模型提取原始指标，预览候选；符合要求后分别保存到知识库和长期记忆。读取、模型外发、知识库写入和记忆写入的授权须分别请求，模拟操作员会在审批服务中答复。被拒绝就停止，不要重试或绕过。完成后简洁说明实际结果和保存范围。`
    const before = new Set(await logs(state.sessionsRoot))
    const outcome = await run(process.execPath, [state.cli, '--profile', state.profileName, ...(state.patchPath ? ['--patch', patchPath] : []), prompt], { cwd: state.workspace, env: childEnv(state.home, state.bin), timeoutMs: state.timeoutMs, outputPrefix: join(state.testRoot, phase) })
    const sessions = await Promise.all((await logs(state.sessionsRoot)).filter(p => !before.has(p)).map(evidence))
    const approvals = []
    for (const session of sessions) {
      const rows = (await readFile(session.privateSessionPath, 'utf8')).split('\n').filter(Boolean).map(JSON.parse)
      approvals.push(...rows.filter(r => r.type.startsWith('approval/')).map(r => ({ type: r.type, data: r.data })))
    }
    cases.push({ phase, outcome, sessions, approvals })
    await writeFile(join(state.testRoot, 'approval-dialogue.private.json'), JSON.stringify({ ...state, cases }, null, 2))
    console.log(JSON.stringify({ phase, outcome, tools: sessions.flatMap(s => s.toolCalls.map(c => c.name)), final: sessions.map(s => s.finalAnswer), approvalEvents: approvals.length }))
    assert.equal(outcome.code, 0)
    assert(sessions.some(s => s.messages.length), 'No actual model response')
  }
  console.log(JSON.stringify({ privateEvidence: join(state.testRoot, 'approval-dialogue.private.json'), humanPerformed: false, semanticReviewRequired: true }))
}
