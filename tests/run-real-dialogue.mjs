/** Real-model implicit dialogue acceptance through the shipped DSH CLI.
 * This file also mounts a budget-only Cordis observer; it never selects tools,
 * supplies model responses, answers approvals, or changes prompt content.
 */
import assert from 'node:assert/strict'
import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { spawn } from 'node:child_process'
import { chmod, mkdir, readFile, readdir, realpath, stat, symlink, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { gunzipSync } from 'node:zlib'

export const name = 'real-dialogue-budget'
export const inject = ['agents']
export function apply(ctx, config) {
  ctx.on('agent/pre-step', async (payload, next) => {
    if (payload.step > config.maxSteps) {
      payload.agent.cancel({ kind: 'hook', reason: 'REAL_DIALOGUE_STEP_BUDGET' })
      return { kind: 'reject' }
    }
    return next()
  })
}

const root = resolve(import.meta.dirname, '..')
const arg = name => { const n = process.argv.indexOf(name); return n < 0 ? undefined : process.argv[n + 1] }
const has = name => process.argv.includes(name)
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex')
const json = async path => JSON.parse(await readFile(path, 'utf8'))
const put = async (path, value) => writeFile(path, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 })
const inside = (parent, path) => path.startsWith(parent + '/')

/** Compare every regular shipped file before reusing an installed test profile. */
export async function verifyInstalledArtifact(artifact, installedRoot) {
  const tar = gunzipSync(await readFile(artifact))
  let checked = 0
  for (let offset = 0; offset + 512 <= tar.length;) {
    const header = tar.subarray(offset, offset + 512)
    if (header.every(byte => byte === 0)) break
    const field = (start, length) => header.subarray(start, start + length).toString().split('\0')[0]
    const name = field(0, 100), prefix = field(345, 155)
    const entry = prefix ? `${prefix}/${name}` : name
    const size = Number.parseInt(field(124, 12).trim(), 8) || 0
    const type = field(156, 1)
    assert(type === '0' || type === '' || type === '5', `Unsupported archive entry type: ${type}`)
    if (type !== '5') {
      assert(entry.startsWith('package/'), 'Require npm archive package prefix')
      const destination = resolve(installedRoot, entry.slice('package/'.length))
      assert(inside(installedRoot, destination), 'Archive path must stay inside installed package')
      assert.equal(sha256(await readFile(destination)), sha256(tar.subarray(offset + 512, offset + 512 + size)), `Installed artifact mismatch: ${entry}`)
      checked++
    }
    offset += 512 + Math.ceil(size / 512) * 512
  }
  assert(checked > 0, 'No installed files checked')
  return checked
}

/** Capture child output privately; only project-safe summaries reach stdout. */
export async function run(executable, args, { cwd, env, timeoutMs = 90_000, outputPrefix }) {
  const child = spawn(executable, args, { cwd, env, detached: true, stdio: ['ignore', 'pipe', 'pipe'] })
  let stdout = '', stderr = '', timedOut = false, outputExceeded = false, escalation
  const terminate = () => {
    try { process.kill(-child.pid, 'SIGTERM') } catch {}
    escalation ??= setTimeout(() => { try { process.kill(-child.pid, 'SIGKILL') } catch {} }, 5_000)
  }
  const collect = target => chunk => {
    if (Buffer.byteLength(stdout) + Buffer.byteLength(stderr) + chunk.length > 8 * 1024 * 1024) {
      outputExceeded = true; terminate(); return
    }
    if (target === 'out') stdout += chunk.toString('utf8')
    else stderr += chunk.toString('utf8')
  }
  child.stdout.on('data', collect('out')); child.stderr.on('data', collect('err'))
  const timeout = setTimeout(() => { timedOut = true; terminate() }, timeoutMs)
  let failure
  child.on('error', error => { failure = error.code ?? error.name })
  const outcome = await new Promise(done => child.on('close', (code, signal) => done({ code, signal })))
  clearTimeout(timeout); if (escalation) clearTimeout(escalation)
  if (outputPrefix) {
    await writeFile(outputPrefix + '.stdout.private.txt', stdout, { mode: 0o600 })
    await writeFile(outputPrefix + '.stderr.private.txt', stderr, { mode: 0o600 })
  }
  return { ...outcome, timedOut, outputExceeded, failure }
}

const disabled = [
  'session-title-llm', 'session-telemetry-otel', 'agent-instructions', 'tool-bash', 'tool-pwsh',
  'tool-jobs', 'tool-fs', 'tool-fs-search', 'tool-skill', 'tool-subagent-control',
  'tool-subagent-list-agents', 'tool-subagent', 'tool-subagent-fork', 'tool-workflow',
  'tool-todo', 'tool-goal', 'tool-ralph', 'tool-str-replace-editor', 'tool-web',
  'code-runtime', 'llm-pi-ai', 'goal-round-driver', 'command-goal', 'command-feedback',
  'command-compact', 'plan-mode', 'web-search-deepseek', 'web-fetch-http',
]

export async function prepare() {
  assert.equal(process.platform, 'darwin', 'The locked Mirobody runtime is macOS arm64 only')
  const dshRoot = await realpath(resolve(arg('--dsh-root') ?? join(root, '../deepseek-harness')))
  const artifact = await realpath(resolve(required('--artifact')))
  const provider = required('--provider'), model = required('--model'), baseURL = required('--base-url')
  assert.equal(new URL(baseURL).protocol, 'https:', 'Real-model endpoint must use HTTPS')
  const credentialsPath = arg('--credentials-path') ? await realpath(resolve(arg('--credentials-path'))) : undefined
  if (credentialsPath) assert((await stat(credentialsPath)).isFile()) // Never read or copy credentials.
  const runtime = await realpath(resolve(arg('--runtime') ?? join(root, '.runtime')))
  const suite = arg('--suite') ?? 'regression'
  assert(['regression', 'capture'].includes(suite), 'Unknown dialogue suite')
  const testRoot = join(root, '.test-runtime', `real-dialogue-${randomUUID()}`)
  const privateHome = join(testRoot, 'home'), workspace = join(testRoot, 'synthetic-workspace')
  let home = privateHome
  const profileName = 'memosbox-real-dialogue', bin = join(testRoot, 'bin')
  await mkdir(workspace, { recursive: true, mode: 0o700 }); await mkdir(bin, { mode: 0o700 })
  await chmod(testRoot, 0o700)
  const corepack = join(dirname(process.execPath), '..', 'lib/node_modules/corepack/dist/pnpm.js')
  await symlink(corepack, join(bin, 'pnpm'))
  const cli = join(dshRoot, 'apps/cli/lib/bin.js')
  let profileDir, installation, patchPath
  if (arg('--reuse-profile-from')) {
    const previousRoot = await realpath(resolve(arg('--reuse-profile-from')))
    assert(inside(join(root, '.test-runtime'), previousRoot), 'Only reuse plugin-local test profiles')
    const previous = await json(join(previousRoot, 'acceptance-state.json'))
    assert.equal(previous.artifactSha256, sha256(await readFile(artifact)), 'Reused profile must contain this exact artifact')
    assert.equal(previous.profileName, profileName)
    assert.equal(previous.dshRoot, dshRoot)
    home = await realpath(previous.home)
    profileDir = await realpath(previous.profileDir)
    assert(inside(previousRoot, home) && inside(home, profileDir))
    const checkedFiles = await verifyInstalledArtifact(artifact, join(profileDir, 'node_modules/memosbox-dsh-plugin'))
    installation = { mode: 'reuse-previous-cli-install', sourceTestRoot: previousRoot, checkedFiles, newInstallTested: false }
    patchPath = join(testRoot, 'verification.patch.yml')
  } else {
    const env = childEnv(home, bin)
    process.env.DSH_HOME = home
    const boot = await import(pathToFileURL(join(dshRoot, 'packages/boot/app-boot/lib/index.js')).href)
    profileDir = boot.resolveProfileDir(profileName)
    boot.initProfile(profileDir, ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-headless'], 'startup')
    const manifest = await json(join(profileDir, 'package.json'))
    manifest.packageManager = 'pnpm@11.7.0'
    await put(join(profileDir, 'package.json'), manifest)
    await writeFile(join(profileDir, 'pnpm-workspace.yaml'), 'packages: []\nallowBuilds:\n  better-sqlite3: true\nautoInstallPeers: false\n', { mode: 0o600 })
    installation = await run(process.execPath, [cli, 'plugin', '--profile', profileName, 'add', '-w', artifact, '--registry=https://registry.npmjs.org'], { cwd: workspace, env, timeoutMs: 180_000, outputPrefix: join(testRoot, 'installation') })
    assert.equal(installation.code, 0, `CLI install failed; private logs: ${testRoot}`)
  }
  const dataRoot = join(privateHome, 'memosbox'), sessionsRoot = join(privateHome, 'sessions')
  const maxSteps = Number(arg('--max-steps') ?? 6), timeoutMs = Number(arg('--timeout-ms') ?? 90_000), maxTokens = Number(arg('--max-tokens') ?? 2048)
  assert(Number.isInteger(maxSteps) && maxSteps > 0 && maxSteps <= 10)
  assert(Number.isInteger(timeoutMs) && timeoutMs >= 5_000 && timeoutMs <= 180_000)
  assert(Number.isInteger(maxTokens) && maxTokens >= 128 && maxTokens <= 4096)
  const patches = [
    ...disabled.map(id => ({ id, disabled: true })),
    { id: 'agent-default-model', config: { provider, model } },
    { id: 'credentials', config: { ...(credentialsPath ? { path: credentialsPath } : {}), watch: false } },
    { id: 'settings', config: { path: join(privateHome, 'settings.yaml'), watch: false } },
    { id: 'llm-deepseek', config: { baseURL, apiKeyEnv: arg('--credential-ref') ?? 'DEEPSEEK_API_KEY', thinking: 'disabled', reasoningEffort: 'off', maxTokens, streamIdleTimeoutMs: 45_000, retryPolicy: { mode: 'normal', maxRetries: 0 } } },
    { id: 'session-persistence-jsonl', config: { root: sessionsRoot, compression: 'none', packChunks: false } },
    { id: 'tools', config: { mode: 'native' } },
    { id: 'sandbox-policy', config: { mode: 'read-only', workspaceRoot: workspace } },
    { id: 'approval', config: { policy: 'ask' } },
    { id: 'memosbox-native', config: { enabled: true, profileId: profileName, dataHome: dataRoot, mirobodyRuntimePath: runtime, captureEnabled: suite === 'capture', queryLogEnabled: false, wikiWriteEnabled: false, explicitMemoryWriteEnabled: false, mirobodySyntheticDocumentsEnabled: false, mirobodyModelExtractionEnabled: false } },
    patchPath
      ? { id: 'real-dialogue-budget', config: { maxSteps } }
      : { insert: [{ id: 'real-dialogue-budget', name: pathToFileURL(import.meta.filename).href, config: { maxSteps } }] },
  ]
  await put(patchPath ?? join(profileDir, 'cordis.patch.yml'), patches)
  const state = { schemaVersion: 1, suite, captureEnabled: suite === 'capture', preparedAt: new Date().toISOString(), testRoot, home, workspace, profileDir, profileName, dshRoot, cli, bin, patchPath, artifact, artifactSha256: sha256(await readFile(artifact)), provider, model, baseURL, credentialReferenceOnly: true, credentialsPath, runtime, dataRoot, sessionsRoot, maxSteps, timeoutMs, maxTokens, installation, disabled, cases: [] }
  if (suite === 'capture') state.captureFixture = { projectId: 'PROJECT-' + randomBytes(6).toString('hex').toUpperCase(), phrase: 'PREF-' + randomBytes(12).toString('hex').toUpperCase(), kind: 'natural-dialogue-only-no-database-preseed' }
  await put(join(testRoot, 'acceptance-state.json'), state)
  process.stdout.write(JSON.stringify({ prepared: true, testRoot, profileName, model, artifactSha256: state.artifactSha256 }) + '\n')
  return state
}

function required(flag) { const value = arg(flag); assert(value, `Missing ${flag}`); return value }

export function childEnv(home, bin) {
  const env = { ...process.env, DSH_HOME: home, DSH_TELEMETRY_DISABLED: '1', DSH_PERMISSION_MODE: 'read-only', DSH_TOOLS_MODE: 'native', PATH: `${bin}:${dirname(process.execPath)}:${process.env.PATH}` }
  // The explicitly referenced managed provider must win over inherited keys.
  delete env.DEEPSEEK_API_KEY; delete env.DEEPSEEK_BASE_URL
  return env
}

export async function logs(rootPath) {
  try { return (await readdir(rootPath, { recursive: true })).filter(path => path.endsWith('.jsonl')).map(path => join(rootPath, path)) }
  catch (error) { if (error.code === 'ENOENT') return []; throw error }
}

/** Only publish final visible text, tool exchanges and turn boundaries. */
export async function evidence(path) {
  const bytes = await readFile(path)
  const rows = bytes.toString('utf8').split('\n').filter(Boolean).map(line => JSON.parse(line))
  const messages = rows.filter(row => row.type === 'assistant/message').map(row => ({ seq: row.seq, step: row.data.step, model: row.data.message.source?.model, text: row.data.message.content.filter(block => block.type === 'text').map(block => block.text).join(''), usage: row.data.usage }))
  const finalAnswer = messages.filter(message => message.text.trim()).at(-1)?.text ?? ''
  const toolCalls = rows.filter(row => row.type === 'tool/call').map(row => ({ seq: row.seq, ...row.data }))
  const toolResults = rows.filter(row => row.type === 'tool/result').map(row => ({ seq: row.seq, ...row.data }))
  const turns = rows.filter(row => row.type === 'turn/end').map(row => row.data)
  return { sessionId: rows[0]?.id, privateSessionPath: path, privateSessionSha256: sha256(bytes), finalAnswer, messages, toolCalls, toolResults, turns, stepCount: rows.filter(row => row.type === 'step/start').length, eventCount: rows.length - 1, omittedFromReport: ['reasoning', 'assistant chunks', 'request headers', 'provider transport records'] }
}

async function seedWiki(state) {
  // The ordinary pre-step recall initializes the actual memory scope even if
  // the first four dialogues never ask for Wiki. Both share this scope key.
  const scopes = (await readdir(join(state.dataRoot, 'memory'))).filter(name => /^[a-f0-9]{64}$/.test(name))
  assert.equal(scopes.length, 1, 'Require exactly one actual scoped directory before seeding')
  const wikiRoot = join(state.dataRoot, 'scopes', scopes[0], 'wiki')
  const { WikiAdapter } = await import(pathToFileURL(join(state.profileDir, 'node_modules/memosbox-dsh-plugin/dist/wiki/adapter.js')).href)
  const adapter = new WikiAdapter({ root: wikiRoot, autoInitialize: true, maxPageBytes: 1024 * 1024 })
  const projectId = 'PROJECT-' + randomBytes(6).toString('hex').toUpperCase()
  const passphrase = 'MBX-' + randomBytes(12).toString('hex').toUpperCase()
  const path = 'entities/' + projectId.toLowerCase() + '.md'
  const source = await adapter.addRawSource(`raw/files/${projectId.toLowerCase()}-seed.txt`, `Synthetic test fixture only. ${projectId} acceptance passphrase: ${passphrase}.`)
  const receipt = await adapter.writePage({ path, title: `${projectId} 验收约定`, body: `# ${projectId} 验收约定\n\n这是测试程序预置的合成知识，不是对话自动生成的记忆。\n\n项目 ${projectId} 的验收口令是 ${passphrase}。\n\n关联：[[SCHEMA]]、[[index]]。`, type: 'entity', tags: ['testing', 'configuration'], sources: [source.path], confidence: 'high', expectedVersion: 'absent', operationId: `seed-page-${projectId}` })
  assert(receipt.ok, JSON.stringify(receipt))
  const seed = { kind: 'explicit-test-preseed-not-dialogue-write', projectId, passphrase, path, source, receipt, wikiRoot, unknownProjectId: 'PROJECT-' + randomBytes(8).toString('hex').toUpperCase() }
  await put(join(state.testRoot, 'wiki-seed.private.json'), seed)
  return seed
}

async function seedMemory(state) {
  const scopeKeys = (await readdir(join(state.dataRoot, 'memory'))).filter(name => /^[a-f0-9]{64}$/.test(name))
  assert.equal(scopeKeys.length, 1, 'Seed only the actual initialized dialogue scope')
  const scope = { key: scopeKeys[0], profileId: 'explicit-synthetic-test-preseed', workspaceId: sha256(state.workspace) }
  const installed = join(state.profileDir, 'node_modules/memosbox-dsh-plugin/dist')
  const { openScopedMemory } = await import(pathToFileURL(join(installed, 'memory/core.js')).href)
  const { writeApprovedMemory } = await import(pathToFileURL(join(installed, 'memory/approved-writer.js')).href)
  const projectId = 'MEMORY-' + randomBytes(6).toString('hex').toUpperCase()
  const phrase = 'PREF-' + randomBytes(12).toString('hex').toUpperCase()
  const text = `SYNTHETIC TEST PRESEED ONLY, not captured from dialogue. 项目 ${projectId} 的输出约定标记为 ${phrase}，偏好先给结论，再列依据。`
  const core = await openScopedMemory(join(state.dataRoot, 'memory', scope.key), scope, false)
  let receipt
  try {
    receipt = await writeApprovedMemory(core, { operationId: `test-preseed-${projectId}`, candidateDigest: sha256(text), text, scope })
  } finally { await core.shutdown() }
  const seed = { kind: 'explicit-public-facade-test-preseed-not-dialogue-write', projectId, expectedPhrase: phrase, receipt, scopeKey: scope.key }
  await put(join(state.testRoot, 'memory-seed.private.json'), seed)
  return seed
}

async function execute(state) {
  const capture = state.suite === 'capture'
  const prompts = [
    ['canonical-term', '这是合成测试。请确认 Hemoglobin [Mass/volume] in Blood 的标准指标编号，说明依据和局限，不要保存。'],
    ['ambiguous-term', '另一份合成数据只写了 Hemoglobin 130 g/L，这够不够直接作为唯一标准指标保存？只核对，不要保存。'],
    ['raw-value-preservation', '合成读数 Glucose [Mass/volume] in Serum or Plasma 的原文是 <5.60 mg/dL。请整理原值和单位，不做换算，也不要保存。'],
    ['unknown-term', '合成表格里有一项 TEST-UNKNOWN-MBX-20260909，值是 7 quux。这是什么标准指标？不确定就保留待核对，不要保存。'],
  ]
  const caseLimit = Number(arg('--limit') ?? (capture ? 3 : 6))
  assert(Number.isInteger(caseLimit) && caseLimit >= 1 && caseLimit <= (capture ? 3 : 10))
  const capturePrompts = capture ? [
    ['capture-natural-conversation', `这是合成测试项目 ${state.captureFixture.projectId}。我们团队的输出约定标记是 ${state.captureFixture.phrase}。我平时喜欢先看简短结论，再看依据，讨论文档时也一直采用这个格式。今天想先跟你聊聊，怎样让项目沟通更清楚？请简单回答。`],
    ['capture-cross-session-recall', `项目 ${state.captureFixture.projectId} 之前的输出约定标记和回答格式偏好是什么？请依据已有记录回答，不知道就明确说明。`],
    ['capture-other-workspace', `项目 ${state.captureFixture.projectId} 之前的输出约定标记和回答格式偏好是什么？请依据已有记录回答，不知道就明确说明。`],
  ] : []
  const env = childEnv(state.home, state.bin)
  for (let i = state.cases.length; i < caseLimit; i++) {
    if (!capture && i >= 4 && !state.seed) { state.seed = await seedWiki(state); await put(join(state.testRoot, 'acceptance-state.json'), state) }
    if (!capture && i >= 6 && !state.memorySeed) { state.memorySeed = await seedMemory(state); await put(join(state.testRoot, 'acceptance-state.json'), state) }
    const [id, prompt] = capture ? capturePrompts[i] : i < 4 ? prompts[i] : i === 4
      ? ['wiki-new-session', `我们给项目 ${state.seed.projectId} 约定的验收口令是什么？请注明依据。`]
      : i === 5 ? ['unknown-project', `我们上次给项目 ${state.seed.unknownProjectId} 约定了什么验收口令？请注明依据。`]
      : i === 6 ? ['memory-new-session', `项目 ${state.memorySeed.projectId} 之前定下的输出约定标记和回答偏好是什么？请注明依据。只查询，不要保存。`]
      : i === 7 ? ['memory-other-workspace', `项目 ${state.memorySeed.projectId} 之前定下的输出约定标记和回答偏好是什么？请注明依据。只查询，不要保存。`]
      : i === 8 ? ['creatinine-alias', '这是合成测试。Serum Creatinine 的标准指标编号是什么？请核对当前本地解析，说明依据和局限，不要保存，不做诊断。']
      : ['bilirubin-alias', '这是合成测试。Serum Total Bilirubin 的标准指标编号是什么？请核对当前本地解析，说明依据和局限，不要保存，不做诊断。']
    const workspace = (capture ? i === 2 : i === 7) ? join(state.testRoot, 'other-synthetic-workspace') : state.workspace
    await mkdir(workspace, { recursive: true, mode: 0o700 })
    const before = new Set(await logs(state.sessionsRoot))
    const startedAt = new Date().toISOString()
    const outcome = await run(process.execPath, [state.cli, '--profile', state.profileName, ...(state.patchPath ? ['--patch', state.patchPath] : []), prompt], { cwd: workspace, env, timeoutMs: state.timeoutMs, outputPrefix: join(state.testRoot, id) })
    const added = (await logs(state.sessionsRoot)).filter(path => !before.has(path))
    const sessions = await Promise.all(added.map(evidence))
    const result = { id, prompt, workspace, startedAt, completedAt: new Date().toISOString(), outcome, sessions, evaluation: 'PENDING_HUMAN_SOURCE_TO_ANSWER_REVIEW', remoteModelUsed: sessions.some(session => session.messages.length > 0), pluginToolNames: [...new Set(sessions.flatMap(session => session.toolCalls.map(call => call.name)).filter(name => /^(memos_|memosbox_|mirobody_|wiki_)/.test(name)))] }
    state.cases.push(result)
    if (capture && i === 0 && outcome.code === 0) {
      // Observe persisted capture after the DSH process exits, before recall.
      // No synthetic rows are inserted; automatic pre-step recall need not call
      // a visible search tool, so tool-only evidence would miss a valid path.
      const keys = (await readdir(join(state.dataRoot, 'memory'))).filter(key => /^[a-f0-9]{64}$/.test(key))
      assert.equal(keys.length, 1)
      const scope = { key: keys[0], profileId: state.profileName, workspaceId: sha256(state.workspace) }
      const { openScopedMemory } = await import(pathToFileURL(join(state.profileDir, 'node_modules/memosbox-dsh-plugin/dist/memory/core.js')).href)
      const core = await openScopedMemory(join(state.dataRoot, 'memory', scope.key), scope)
      try {
        const bundle = await core.exportBundle()
        const rows = bundle.traces.filter(row => `${row.userText}\n${row.agentText}`.includes(state.captureFixture.phrase))
        state.captureStorageProof = { method: 'public-core-export-after-first-process-exit-before-recall', observedAt: new Date().toISOString(), markerPersisted: rows.length > 0, lightweightTrace: rows.some(row => row.tags.includes('lightweight_memory')), ownerMatches: rows.length > 0 && rows.every(row => row.ownerProfileId === scope.key), noRowsInsertedByObserver: true }
      } finally { await core.shutdown() }
    }
    await put(join(state.testRoot, `${id}.evidence.json`), result)
    await put(join(state.testRoot, 'acceptance-state.json'), state)
    process.stdout.write(JSON.stringify({ id, code: outcome.code, timedOut: outcome.timedOut, sessionCount: sessions.length, pluginToolNames: result.pluginToolNames, finalAnswerPresent: sessions.some(session => session.finalAnswer.trim()) }) + '\n')
    // Do not repeatedly spend on a transport/auth/startup failure.
    if (!sessions.some(session => session.messages.length > 0)) break
  }
  const reportDir = join(root, 'reports', 'real-dialogue', state.testRoot.split('/').at(-1))
  await mkdir(reportDir, { recursive: true, mode: 0o700 })
  await chmod(reportDir, 0o700)
  const report = { schemaVersion: 1, verifiedAt: new Date().toISOString(), artifact: state.artifact, artifactSha256: state.artifactSha256, provider: state.provider, model: state.model, baseURL: state.baseURL, testRoot: state.testRoot, profileName: state.profileName, installation: state.installation, limits: { maxSteps: state.maxSteps, timeoutMs: state.timeoutMs, maxTokens: state.maxTokens }, noFixtureModel: true, noDirectToolExecution: true, noAutomaticApproval: true, shippedPluginPromptUnmodified: true, formalProfilesModified: false, syntheticOnly: true, disabledGeneralCapabilities: state.disabled, seed: state.seed ? { kind: state.seed.kind, projectId: state.seed.projectId, path: state.seed.path, unknownProjectId: state.seed.unknownProjectId, expectedPassphrase: state.seed.passphrase, receipt: state.seed.receipt } : undefined, cases: state.cases, publicationReady: false, healthPrivacyQualified: false }
  report.memorySeed = state.memorySeed
  report.suite = state.suite ?? 'regression'
  report.captureEnabled = !!state.captureEnabled
  report.captureFixture = state.captureFixture
  report.captureStorageProof = state.captureStorageProof
  await put(join(reportDir, 'acceptance.json'), report)
  process.stdout.write(JSON.stringify({ report: join(reportDir, 'acceptance.json'), casesRun: state.cases.length, evaluation: 'PENDING_HUMAN_SOURCE_TO_ANSWER_REVIEW' }) + '\n')
}

async function main() {
  process.umask(0o077)
  if (has('--help')) { process.stdout.write('node tests/run-real-dialogue.mjs --artifact <tgz> --provider <route> --model <id> --base-url <https URL> [--credentials-path <existing managed file>] [--prepare-only] [--reuse-profile-from <previous private test root>]\nReuse verifies every shipped file and creates a new isolated workspace, data home, session log and CLI patch; it does not test a new package installation.\nResume: --test-root <private test root> [--limit 1..10]\nCases 7 and 8 explicitly preseed synthetic MemOS data (not dialogue capture) then test recall and workspace isolation with real model conversations. Cases 9 and 10 probe alias defects identified in the official Mirobody 1.4.2 changelog against the unchanged installed 1.4.0 runtime.\n'); return }
  const existing = arg('--test-root')
  let state
  if (existing) {
    const testRoot = await realpath(resolve(existing))
    assert(inside(join(root, '.test-runtime'), testRoot), 'Resume only a plugin-local private test root')
    state = await json(join(testRoot, 'acceptance-state.json'))
    assert.equal(state.testRoot, testRoot)
    assert.equal(sha256(await readFile(state.artifact)), state.artifactSha256, 'Frozen artifact changed')
  } else state = await prepare()
  if (!has('--prepare-only')) await execute(state)
}

if (process.argv[1] && resolve(process.argv[1]) === import.meta.filename) {
  await main().catch(error => { process.stderr.write(`Real dialogue runner failed: ${error.message}\n`); process.exitCode = 1 })
}
