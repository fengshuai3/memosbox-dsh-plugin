/** Explicit macOS integration: real CLI install/remove, Loader, native tools,
 * user-approval service and a fresh process reading committed synthetic data.
 * No remote model, credentials, web server, or pre-existing profile is used.
 */
import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { mkdir, readFile, readdir, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const root = resolve(import.meta.dirname, '..')
const flag = name => { const index = process.argv.indexOf(name); return index < 0 ? undefined : process.argv[index + 1] }
const dshRoot = await realpath(resolve(flag('--dsh-root') ?? '../deepseek-harness'))
const runtimeRoot = await realpath(resolve(flag('--runtime-root') ?? join(root, '.runtime')))
const load = path => import(pathToFileURL(join(dshRoot, path, 'lib/index.js')).href)
const bootApi = await load('packages/boot/app-boot')
const profileName = 'memosbox-synthetic'
const stage = flag('--stage')
const testRoot = stage ? resolve(flag('--test-root')) : join(root, '.test-runtime', `dsh-loader-${randomUUID()}`)
const home = join(testRoot, 'home')
const workspace = join(testRoot, 'synthetic-workspace')
process.env.DSH_HOME = home
process.env.DSH_TELEMETRY_DISABLED = '1'
const profileDir = bootApi.resolveProfileDir(profileName)
const dataRoot = join(home, 'memosbox')
const artifactFlag = flag('--artifact')
const run = (args, options = {}) => {
  const result = spawnSync(process.execPath, args, { cwd: testRoot, env: process.env, encoding: 'utf8', timeout: 180_000, maxBuffer: 8 * 1024 * 1024, ...options })
  if (result.error || result.status !== 0) throw new Error(`Integration child failed: ${result.error?.message ?? result.status}\n${result.stdout}\n${result.stderr}`)
  return result.stdout
}

if (!stage) {
  assert.equal(process.platform, 'darwin', 'This installed-runtime acceptance currently targets macOS only')
  assert(artifactFlag, 'Pass the exact --artifact tarball already checked by verify:consumer')
  const artifact = await realpath(resolve(artifactFlag))
  const sha256 = createHash('sha256').update(await readFile(artifact)).digest('hex')
  await mkdir(workspace, { recursive: true, mode: 0o700 })
  const bin = join(testRoot, 'bin')
  await mkdir(bin)
  const corepack = join(dirname(process.execPath), '..', 'lib/node_modules/corepack/dist/pnpm.js')
  await symlink(corepack, join(bin, 'pnpm'))
  process.env.PATH = `${bin}:${dirname(process.execPath)}:${process.env.PATH}`
  bootApi.initProfile(profileDir, [], 'startup')
  const profile = JSON.parse(await readFile(join(profileDir, 'package.json'), 'utf8'))
  profile.packageManager = 'pnpm@11.7.0'
  await writeFile(join(profileDir, 'package.json'), JSON.stringify(profile, null, 2))
  // Explicitly permit only the reviewed SQLite native build, never all scripts.
  await writeFile(join(profileDir, 'pnpm-workspace.yaml'), 'packages: []\nallowBuilds:\n  better-sqlite3: true\nautoInstallPeers: false\n')
  const cli = join(dshRoot, 'apps/cli/lib/bin.js')
  let passed = false
  try {
    process.stdout.write(run([cli, 'plugin', '--profile', profileName, 'add', '-w', artifact, '--registry=https://registry.npmjs.org']))
    const installed = JSON.parse(await readFile(join(profileDir, 'package.json'), 'utf8'))
    assert(installed.dsh.profile.bundles.includes('memosbox-dsh-plugin'), 'CLI must activate the installed bundle')
    const outputs = []
    for (const phase of ['write', 'read']) outputs.push(run([import.meta.filename, '--dsh-root', dshRoot, '--runtime-root', runtimeRoot, '--test-root', testRoot, '--stage', phase]))
    for (const output of outputs) process.stdout.write(output)
    process.stdout.write(run([cli, 'plugin', '--profile', profileName, 'remove', '-w', 'memosbox-dsh-plugin']))
    const removed = JSON.parse(await readFile(join(profileDir, 'package.json'), 'utf8'))
    assert(!removed.dsh.profile.bundles.includes('memosbox-dsh-plugin'))
    assert(!removed.dependencies?.['memosbox-dsh-plugin'])
    const receipt = JSON.parse(await readFile(join(testRoot, 'fixture-receipt.json'), 'utf8'))
    const report = { verifiedAt: new Date().toISOString(), sha256, artifact, cliAddRemove: true, loaderBoot: true, nativeToolExecuteRender: true, realApprovalService: true, separateProcessReadback: true, nativeSqliteConsumer: true, documentToWikiAndMemory: true, fixtureModelRouteTested: true, memoryId: receipt.memoryId, remoteModelTested: false, healthPrivacyQualified: false, scope: 'Synthetic fixture, real host services and installed tarball. Approval answerer and LLM adapter are test fixtures; no remote LLM, full agent loop or interactive UI qualification.' }
    report.approvalSimulation = receipt.approvalSimulation
    const output = flag('--report')
    if (output) {
      const target = resolve(output)
      assert(target.startsWith(join(root, 'artifacts') + '/'), 'Persist evidence only within project artifacts')
      await writeFile(target, JSON.stringify(report, null, 2) + '\n', { flag: 'wx' })
    }
    process.stdout.write(JSON.stringify(report, null, 2) + '\n')
    passed = true
  } finally {
    if (passed) await rm(testRoot, { recursive: true, force: true })
    else process.stderr.write(`Synthetic failure evidence retained at ${testRoot}\n`)
  }
} else {
  const profile = bootApi.loadProfile('memosbox-test', profileName, join(dshRoot, 'apps/cli/package.json'))
  await bootApi.healProfilesModuleFallback({ installAnchor: join(dshRoot, 'apps/cli/package.json'), profile })
  const installed = await realpath(join(profileDir, 'node_modules/memosbox-dsh-plugin'))
  const plugin = path => import(pathToFileURL(join(installed, 'dist', path)).href)
  const { JobStore } = await plugin('mirobody/job-store.js')
  const modules = [
    ['system-prompt', 'packages/core/system-prompt'], ['tools', 'packages/core/tools'],
    ['llm', 'packages/llm/llm'], ['sessions', 'packages/core/session'],
    ['approval', 'packages/interaction/user-approval'],
    ['session-projection', 'packages/session/session-projection'],
    ['sandbox-policy', 'packages/sandbox/sandbox-policy', { mode: 'read-only', workspaceRoot: workspace }],
    ['subprocess', 'packages/subprocess/subprocess-local'], ['sandbox', 'packages/sandbox/sandbox-local'],
  ]
  const rows = modules.map(([id, path, config]) => ({ id, name: pathToFileURL(join(dshRoot, path, 'lib/index.js')).href, ...(config ? { config } : {}) }))
  const configPath = join(profileDir, 'synthetic-cordis.yml')
  await writeFile(configPath, JSON.stringify(rows))
  const patches = profile.layers.flatMap(layer => layer.patches)
  const pluginRow = patches.flatMap(patch => patch.insert ?? []).find(row => row.id === 'memosbox-native')
  assert(pluginRow, 'Use the actual installed bundle patch')
  pluginRow.config = { ...pluginRow.config, profileId: profileName, dataHome: dataRoot, wikiWriteEnabled: true, explicitMemoryWriteEnabled: true, mirobodyRuntimePath: runtimeRoot, mirobodySyntheticDocumentsEnabled: true, mirobodyModelExtractionEnabled: true, mirobodySourcePath: join(testRoot, 'inbox') }
  const ctx = await bootApi.boot('memosbox-test', configPath, patches)
  const handles = []
  const actualSpawn = ctx.subprocess.spawn.bind(ctx.subprocess)
  ctx.subprocess.spawn = spec => { const handle = actualSpawn(spec); handles.push(handle); return handle }
  const { SessionId } = await load('packages/core/session')
  const session = ctx.sessions.create(SessionId(`synthetic-${stage}`), { meta: { cwd: workspace } })
  const agent = { session, id: session.id, options: { provider: 'memosbox-fixture', model: 'synthetic-json' } }
  const { LlmAdapter } = await load('packages/llm/llm')
  const exactName = 'Hemoglobin [Mass/volume] in Blood'
  let modelCalls = 0
  class FixtureAdapter extends LlmAdapter {
    async resolveModel(provider, model) { return { provider, id: model, name: model } }
    async * stream(options) {
      modelCalls++
      const segments = JSON.parse(options.messages.at(-1).content.find(block => block.type === 'text').text)
      const source = segments.find(segment => ['Hemoglobin', exactName].some(name => segment.text === `${name} 130 g/L`))
      assert(source, 'Actual extracted text must reach the selected DSH model route')
      const rawName = source.text.slice(0, -' 130 g/L'.length)
      const text = JSON.stringify([{ rawName, rawValue: '130', rawUnit: 'g/L', evidenceRefs: [source.id] }])
      yield { type: 'block-start', index: 0, blockType: 'text' }
      yield { type: 'text-delta', index: 0, text }
      yield { type: 'block-end', index: 0, block: { type: 'text', text } }
      yield { type: 'finish', reason: { kind: 'stop' } }
    }
  }
  const modelOff = ctx.llm.registerAdapter(['memosbox-fixture'], new FixtureAdapter())
  let calls = 0
  const execute = async (name, args) => {
    const result = await ctx.tools.execute({ name, arguments: args, callId: `synthetic-${++calls}`, agent, signal: new AbortController().signal })
    assert.equal(result.isError, false, JSON.stringify(result))
    const block = result.content.find(block => block.type === 'text')
    return JSON.parse(block.text)
  }
  try {
    const status = await execute('memosbox_status', {})
    assert.equal(status.data.memory, 'available-lexical-lazy')
    assert.equal(status.data.publicationReady, false)
    if (stage === 'write') {
      const normalized = await execute('mirobody_normalize_readings', { readings: [{ rawName: 'Hemoglobin', rawValue: '130', rawUnit: 'g/L' }] })
      assert.equal(normalized.data.readings[0].code, '718-7')
      assert(normalized.data.readings[0].candidates > 1)
      const text = `SYNTHETIC FIXTURE ONLY\n${exactName} 130 g/L\n`
      const sourceDigest = createHash('sha256').update(text).digest('hex')
      const sourceId = `${sourceDigest}.txt`
      const ambiguousText = 'SYNTHETIC FIXTURE ONLY\nHemoglobin 130 g/L\n'
      const ambiguousId = `${createHash('sha256').update(ambiguousText).digest('hex')}.txt`
      await mkdir(join(testRoot, 'inbox'), { recursive: true, mode: 0o700 })
      await writeFile(join(testRoot, 'inbox', sourceId), text, { mode: 0o600 })
      await writeFile(join(testRoot, 'inbox', ambiguousId), ambiguousText, { mode: 0o600 })
      const store = new JobStore(join(dataRoot, 'scopes', status.data.scope, 'imports'), undefined, dataRoot)
      session.append('turn/start', { turn: 1 })
      const refused = await execute('mirobody_parse_document', { sourceId, useModel: true })
      assert.equal(refused.data.status, 'refused', 'No answerer must fail closed')
      assert.equal(modelCalls, 0)
      const grants = []
      let denyBoundary, denyOutcome
      const decisions = []
      const answer = ctx.on('approval/request', async request => {
        grants.push(request.reason)
        const boundary = request.reason.includes('Read staged synthetic') ? 'read' : request.reason.includes('selected model') ? 'transmit' : request.reason.includes('Approve wiki') ? 'wiki' : request.reason.includes('Approve memory') ? 'memory' : 'unknown'
        assert.notEqual(boundary, 'unknown', 'Unexpected approval must not be silently granted')
        const outcome = boundary === denyBoundary ? denyOutcome : 'allowed-once'
        decisions.push({ boundary, outcome })
        return outcome
      })
      const negativeCases = []
      // Exercise the real host approval service, not a mocked plugin context.
      for (const boundary of ['read', 'transmit']) {
        for (const outcome of ['rejected', 'cancelled']) {
          denyBoundary = boundary; denyOutcome = outcome
          const before = modelCalls
          const result = await execute('mirobody_parse_document', { sourceId, useModel: true })
          assert.equal(result.data.status, 'refused')
          assert.equal(result.data.approvalDecisions.at(-1).outcome, outcome)
          assert.equal(result.data.effects.sourceRead, boundary === 'transmit')
          assert.equal(result.data.effects.modelDispatched, false)
          assert.equal(modelCalls, before, 'Refusal/cancellation must prevent model dispatch')
          negativeCases.push(`${boundary}:${outcome}`)
        }
      }
      denyBoundary = undefined
      const ambiguous = await execute('mirobody_parse_document', { sourceId: ambiguousId, useModel: true })
      assert.equal(ambiguous.data.status, 'partial')
      assert(ambiguous.data.warnings.includes('MULTIPLE_LEXICAL_CANDIDATES_REVIEW_REQUIRED'))
      const blocked = await execute('mirobody_commit_import', { candidateId: ambiguous.data.candidateId, includeMemory: true })
      assert.equal(blocked.data.status, 'unresolved', 'Ambiguous terminology must remain blocked, never force-approved')
      const parsed = await execute('mirobody_parse_document', { sourceId, useModel: true })
      assert.equal(parsed.data.status, 'ready', JSON.stringify(parsed))
      assert.equal(modelCalls, 2)
      const candidate = await store.read(`candidates/${parsed.data.candidateId}.json`)
      assert.equal(candidate.sourceDigest, sourceDigest)
      assert.equal(candidate.readings[0].code, '718-7')
      assert.equal(candidate.readings[0].candidates, 1)
      assert.deepEqual(candidate.readings[0].warnings, [])
      assert.equal(candidate.segments.find(segment => segment.text === `${exactName} 130 g/L`).location.line, 2)
      const preview = await execute('mirobody_preview_import', { candidateId: candidate.id })
      assert.equal(preview.data.candidateDigest, candidate.digest)
      assert(!JSON.stringify(preview).includes('Hemoglobin'))
      const snapshot = async () => {
        const entries = []
        const walk = async (path, relative = '') => {
          for (const entry of await readdir(path, { withFileTypes: true })) {
            const child = join(path, entry.name), key = join(relative, entry.name)
            if (entry.isDirectory()) await walk(child, key)
            else if (entry.isFile()) entries.push([key, createHash('sha256').update(await readFile(child)).digest('hex')])
            else assert.fail('Unexpected symlink in synthetic data')
          }
        }
        await walk(dataRoot)
        return entries.sort((a, b) => a[0].localeCompare(b[0]))
      }
      for (const boundary of ['wiki', 'memory']) {
        for (const outcome of ['rejected', 'cancelled']) {
          denyBoundary = boundary; denyOutcome = outcome
          const before = await snapshot()
          const refusedWrite = await execute('mirobody_commit_import', { candidateId: candidate.id, includeMemory: true })
          assert.equal(refusedWrite.data.status, 'refused')
          assert.equal(refusedWrite.data.approvalDecisions.at(-1).outcome, outcome)
          assert.equal(refusedWrite.data.destinationsChanged, false)
          assert.deepEqual(await snapshot(), before, 'Rejected/cancelled write must leave all plugin data bytes unchanged')
          negativeCases.push(`${boundary}:${outcome}`)
        }
      }
      denyBoundary = undefined
      const result = await execute('mirobody_commit_import', { candidateId: candidate.id, includeMemory: true })
      assert.equal(result.data.status, 'complete', JSON.stringify(result))
      assert.equal(result.data.memory.verified, true)
      assert.deepEqual(result.data.approvalDecisions, [{ stage: 'wikiWrite', outcome: 'allowed-once' }, { stage: 'memoryWrite', outcome: 'allowed-once' }])
      assert.equal(grants.length, 18)
      assert(grants.at(-2).includes('Approve wiki') && grants.at(-1).includes('Approve memory'))
      assert(grants.slice(-2).every(reason => reason.includes(candidate.digest)))
      answer()
      session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
      const audit = Array.from({ length: session.seq }, (_, index) => session.eventAt(index)).filter(event => event.type.startsWith('approval/'))
      assert.equal(audit.filter(event => event.type === 'approval/asked').length, 19)
      assert.equal(audit.filter(event => event.type === 'approval/decided').length, 19)
      assert(!JSON.stringify(audit).includes('Hemoglobin'), 'Approval metadata must not duplicate source text')
      await writeFile(join(testRoot, 'fixture-receipt.json'), JSON.stringify({ memoryId: result.data.memory.id, targetPath: candidate.targetPath, candidateDigest: candidate.digest, approvalSimulation: { humanPerformed: false, uiTested: false, mode: 'scripted-answerer-real-dsh-approval-service', negativeCases, decisions, unavailableFailsClosed: true, ambiguousCandidateBlocked: true, previewDigestReviewed: true, rejectedWritesByteIdentical: true, modelTransmissionPreventedWhenDenied: true } }))
    } else if (stage === 'scope') {
      await writeFile(join(testRoot, 'native-scope.json'), JSON.stringify({ scope: status.data.scope, dataRoot }))
    } else {
      const receipt = JSON.parse(await readFile(join(testRoot, 'fixture-receipt.json'), 'utf8'))
      const page = await execute('wiki_get', { path: receipt.targetPath })
      assert(JSON.stringify(page).includes(receipt.candidateDigest))
      // Old migration pages legitimately have no link; new dual-write pages do.
      if (receipt.approvalSimulation) assert(JSON.stringify(page).includes(`MemOS lookup ID: ${receipt.memoryId}`))
      const memory = await execute('memos_get', { id: receipt.memoryId })
      assert(memory.data.text.includes(receipt.candidateDigest))
      const search = await execute('memos_search', { query: 'Hemoglobin' })
      assert(search.data.hits.some(hit => hit.refId === receipt.memoryId))
    }
    const entry = [...ctx.loader.entries()].find(entry => entry.options.id === 'memosbox-native')
    assert(entry)
    await ctx.loader.update(entry.id, { disabled: true })
    await ctx.loader.await()
    for (const name of ['memos_search', 'mirobody_resolve', 'wiki_get']) assert.equal(ctx.tools.get(name), undefined)
    await ctx.loader.update(entry.id, { disabled: false })
    await ctx.loader.await()
    assert(ctx.tools.get('mirobody_resolve'))
    const data = await execute('memosbox_status', {})
    assert.equal(data.data.memory, 'available-lexical-lazy')
  } finally { modelOff(); await ctx.fiber.dispose() }
  for (const handle of handles) assert.equal(await handle.waitForExit(AbortSignal.timeout(1000)), true)
  process.stdout.write(JSON.stringify({ stage, nativeToolCalls: calls, managedProcesses: handles.length, fixtureModelCalls: modelCalls, allExited: true, loaderDisableEnable: true }) + '\n')
}
