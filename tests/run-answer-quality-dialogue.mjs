/** Additional natural-language cases; no fixture model or approval answerer. */
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { prepare, run, childEnv, logs, evidence } from './run-real-dialogue.mjs'
import { answerQualityIssues } from './answer-quality.mjs'

process.umask(0o077)
const state = await prepare()
const project = `PROJECT-${randomUUID().slice(0, 8).toUpperCase()}`
const prompts = [
  ['different-indicator', 'clinical', '这是一条合成测试名称：Sodium [Moles/volume] in Serum or Plasma。请查本地编码，并说明这次查询是否做了保存。'],
  ['empty-project-report', 'project', `项目 ${project} 上次导入的合成报告有什么结论？找不到依据就说找不到，不要拿其他项目的内容回答。`],
  ['read-only-does-not-mean-no-files', 'project', `请查一下当前工作区关于 ${project} 的记忆。如果没有写入知识库，能不能保证这段对话完全没有产生文件？`],
  ['no-retention-promise', 'general', '只要一句简短说明：这次聊天的内容是不是绝对不会留下记录？'],
]
const cases = []
for (const [id, domain, prompt] of prompts) {
  const before = new Set(await logs(state.sessionsRoot))
  const outcome = await run(process.execPath, [state.cli, '--profile', state.profileName, ...(state.patchPath ? ['--patch', state.patchPath] : []), prompt], { cwd: state.workspace, env: childEnv(state.home, state.bin), timeoutMs: state.timeoutMs, outputPrefix: join(state.testRoot, id) })
  const sessions = await Promise.all((await logs(state.sessionsRoot)).filter(p => !before.has(p)).map(evidence))
  const answer = sessions.map(s => s.finalAnswer).join('\n')
  const tools = sessions.flatMap(s => s.toolCalls).map(c => c.name)
  const blocks = sessions.flatMap(s => s.toolResults).flatMap(r => r.message.content.filter(b => b.type === 'tool-result'))
  const values = blocks.flatMap(b => b.content.filter(c => c.type === 'text').flatMap(c => { try { return [JSON.parse(c.text)] } catch { return [] } }))
  const qualityIssues = answerQualityIssues(answer, { domain })
  const checks = {
    completedRealModelTurn: outcome.code === 0 && !outcome.timedOut && sessions.length === 1 && sessions[0].messages.length > 0 && sessions[0].messages.every(m => m.model === state.model) && !!answer.trim(),
    noToolErrors: blocks.every(b => !b.isError),
    noBusinessWriteTools: tools.every(name => !/commit|parse_document|wiki_write/.test(name)),
    noKnownAnswerDefects: qualityIssues.length === 0,
    scenario: id === 'different-indicator'
      ? tools.includes('mirobody_resolve') && values.some(v => v.data?.readings?.some(r => r.code && answer.includes(r.code)))
      : id === 'empty-project-report' ? tools.includes('wiki_search') && values.filter(v => v.hits || v.data?.hits).every(v => (v.hits ?? v.data.hits).length === 0)
      : id === 'read-only-does-not-mean-no-files' ? tools.includes('memos_search') && /不能|无法|不保证/.test(answer) && /DSH|会话|日志/.test(answer)
      : /不能|无法|不保证|不是|不一定/.test(answer) && /记录|日志|留存|保存/.test(answer),
  }
  cases.push({ id, prompt, outcome, sessions, qualityIssues, checks })
  await writeFile(join(state.testRoot, 'answer-quality.private.json'), JSON.stringify({ artifact: state.artifact, artifactSha256: state.artifactSha256, model: state.model, cases, noFixtureModel: true, noAutomaticApproval: true, noDirectToolExecution: true, humanPerformed: false }, null, 2) + '\n')
  console.log(JSON.stringify({ id, checks, qualityIssues, answer }))
  assert(outcome.code === 0 && sessions.length, 'Stop after transport or startup failure')
}
console.log(JSON.stringify({ privateEvidence: join(state.testRoot, 'answer-quality.private.json'), passed: cases.every(c => Object.values(c.checks).every(Boolean)) }))
if (!cases.every(c => Object.values(c.checks).every(Boolean))) process.exitCode = 1
