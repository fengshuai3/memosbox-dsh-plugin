/** Isolated synthetic migration rehearsal. Never opens formal user databases. */
import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import { mkdir, readFile, writeFile, readdir, cp, rename, symlink, realpath } from 'node:fs/promises'
import { join, resolve, dirname } from 'node:path'
import { pathToFileURL } from 'node:url'
import { run, verifyInstalledArtifact } from './run-real-dialogue.mjs'
const root = resolve(import.meta.dirname, '..')
const arg = key => process.argv[process.argv.indexOf(key) + 1]
assert(process.argv.includes('--artifact') && process.argv.includes('--runtime'))
const artifact = await realpath(resolve(arg('--artifact')))
const runtime = await realpath(resolve(arg('--runtime')))
const oldArtifact = join(root, 'artifacts/memosbox-dsh-plugin-0.1.0-beta.2.tgz')
const dshRoot = resolve(root, '../deepseek-harness')
const formal = join(dshRoot, '.local/dsh-home/profiles/headless/node_modules')
const oldPackage = join(formal, 'memosbox-dsh-plugin')
const oldCorePath = join(formal, '@memtensor/memos-local-plugin')
assert.equal(JSON.parse(await readFile(join(oldCorePath, 'package.json'))).version, '2.0.18')
const oldFiles = await verifyInstalledArtifact(oldArtifact, oldPackage)
const hash = bytes => createHash('sha256').update(bytes).digest('hex')
process.umask(0o077)
const testRoot = join(root, '.test-runtime', `migration-${randomUUID()}`)
const home = join(testRoot, 'home'), workspace = join(testRoot, 'synthetic-workspace')
const legacy = join(testRoot, 'legacy'), backup = join(testRoot, 'backup')
await mkdir(workspace, { recursive: true }); await mkdir(backup)
process.env.DSH_HOME = home
process.env.DSH_TELEMETRY_DISABLED = '1'
const boot = await import(pathToFileURL(join(dshRoot, 'packages/boot/app-boot/lib/index.js')))
const profileName = 'memosbox-synthetic', profileDir = boot.resolveProfileDir(profileName)
boot.initProfile(profileDir, [], 'startup')
const manifest = JSON.parse(await readFile(join(profileDir, 'package.json')))
manifest.packageManager = 'pnpm@11.7.0'
manifest.dependencies = { 'memosbox-dsh-plugin': `file:${oldArtifact}` }
manifest.dsh.profile.bundles = ['memosbox-dsh-plugin']
await writeFile(join(profileDir, 'package.json'), JSON.stringify(manifest))
await writeFile(join(profileDir, 'pnpm-workspace.yaml'), 'packages: []\nautoInstallPeers: false\nallowBuilds:\n  better-sqlite3: true\n  "@memtensor/memos-local-plugin": false\n')
const newWorkspaceConfig = await readFile(join(profileDir, 'pnpm-workspace.yaml'))
// Preserve the old installed dependency layout and exact resolution graph.
// Rebase only the known old archive reference into this synthetic profile.
const { parse, stringify } = await import('yaml')
const oldLock = parse(await readFile(join(dirname(formal), 'pnpm-lock.yaml'), 'utf8'))
const rebase = value => {
  if (typeof value === 'string') return value.startsWith('file:') && value.endsWith('/memosbox-dsh-plugin-0.1.0-beta.2.tgz') ? `file:${oldArtifact}` : value
  if (Array.isArray(value)) return value.map(rebase)
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [rebase(key), rebase(item)]))
  return value
}
await writeFile(join(profileDir, 'pnpm-lock.yaml'), stringify(rebase(oldLock)))
await cp(join(dirname(formal), 'pnpm-workspace.yaml'), join(profileDir, 'pnpm-workspace.yaml'))
const bin = join(testRoot, 'bin'); await mkdir(bin)
await symlink(join(dirname(process.execPath), '../lib/node_modules/corepack/dist/pnpm.js'), join(bin, 'pnpm'))
const env = { ...process.env, PATH: `${bin}:${dirname(process.execPath)}:${process.env.PATH}` }
const child = async (id, args) => {
  const outcome = await run(process.execPath, args, { cwd: testRoot, env, timeoutMs: 180_000, outputPrefix: join(testRoot, id) })
  assert.equal(outcome.code, 0, `${id} failed; inspect private logs in ${testRoot}`)
  return outcome
}
const cli = join(dshRoot, 'apps/cli/lib/bin.js')
const install = async (id, archive) => child(id, [cli, 'plugin', '--profile', profileName, 'add', '-w', archive, '--offline', '--registry=https://registry.npmjs.org'])
console.log(JSON.stringify({ testRoot, oldFiles, stage: 'copy-verified-old-installation-offline' }))
// Clone only installed dependencies, never formal config, histories or credentials.
// Avoid resolving the old broad dependency ranges against today's registry.
await cp(formal, join(profileDir, 'node_modules'), { recursive: true, errorOnExist: true, force: false })
await verifyInstalledArtifact(oldArtifact, join(profileDir, 'node_modules/memosbox-dsh-plugin'))
const profileFiles = (await readdir(profileDir)).filter(name => /^(package\.json|pnpm-lock\.yaml|pnpm-workspace\.yaml|cordis\.patch\.yml)$/.test(name))
for (const name of profileFiles) await cp(join(profileDir, name), join(backup, name))
const oldApi = await import(pathToFileURL(join(oldCorePath, 'dist/core/index.js')))
const { createPipeline, createMemoryCore } = await import(pathToFileURL(join(oldCorePath, 'dist/core/pipeline/index.js')))
const quiet = { channel: 'migration-fixture', child: () => quiet, trace() {}, debug() {}, info() {}, warn() {}, error() {}, fatal() {}, audit() {}, llm() {}, forward() {}, timer: () => ({ end() {}, [Symbol.dispose]() {} }), flush: async () => {}, close: async () => {} }
async function openOld() {
  const coreRoot = join(legacy, 'memory')
  const h = { root: coreRoot, configFile: join(coreRoot, 'config.yaml'), dataDir: join(coreRoot, 'data'), dbFile: join(coreRoot, 'data/memos.db'), skillsDir: join(coreRoot, 'skills'), logsDir: join(coreRoot, 'logs'), daemonDir: join(coreRoot, 'daemon') }
  for (const dir of [h.dataDir, h.skillsDir, h.logsDir, h.daemonDir]) await mkdir(dir, { recursive: true })
  const config = structuredClone(oldApi.DEFAULT_CONFIG)
  config.llm = { ...config.llm, provider: 'local_only', fallbackToHost: false, apiKey: '' }
  config.telemetry = { enabled: false }; config.hub.enabled = false
  config.algorithm.lightweightMemory.enabled = true
  config.algorithm.retrieval.llmFilterEnabled = false
  const db = oldApi.openDb({ filepath: h.dbFile, agent: 'deepseek-harness' }); oldApi.runMigrations(db)
  const pipeline = createPipeline({ agent: 'deepseek-harness', home: h, config, db, repos: oldApi.makeRepos(db), llm: null, reflectLlm: null, l3Llm: null, embedder: null, log: quiet, namespace: { agentKind: 'deepseek-harness', profileId: 'legacy-owner' } })
  const core = createMemoryCore(pipeline, h, '2.0.18', { autoRecovery: false, telemetry: null, onShutdown: () => db.close() })
  await core.init(); return core
}
const marker = hash(randomUUID()), memoryId = 'migration-synthetic-' + randomUUID()
const text = `SYNTHETIC Hemoglobin migration canary ${marker}`
let old = await openOld()
let exported
try {
  await old.importBundle({ version: 1, traces: [{ id: memoryId, sessionId: 'fixture-session', episodeId: 'fixture-episode', ownerAgentKind: 'deepseek-harness', ownerProfileId: 'legacy-owner', ts: Date.now(), userText: '', agentText: text, summary: text, tags: ['testing'], toolCalls: [], share: null, value: 0, alpha: 0, priority: 1 }] })
  assert.equal((await old.getTrace(memoryId)).agentText, text)
  exported = await old.exportBundle()
  assert.equal(exported.traces.length, 1)
  assert.deepEqual([exported.policies.length, exported.worldModels.length, exported.skills.length], [0, 0, 0], 'This rehearsal does not cover complex legacy records')
} finally { await old.shutdown() }
const { WikiAdapter: OldWiki } = await import(pathToFileURL(join(oldPackage, 'dist/wiki/adapter.js')))
const oldWiki = new OldWiki({ root: join(legacy, 'wiki'), autoInitialize: true, maxPageBytes: 1024 * 1024 })
await oldWiki.initialize()
await writeFile(join(legacy, 'wiki/raw/files/fixture.txt'), text)
const targetPath = 'entities/migration-fixture.md'
assert.equal((await oldWiki.writePage({ path: targetPath, title: 'Migration fixture', type: 'entity', tags: ['testing'], sources: ['raw/files/fixture.txt'], confidence: 'high', body: `# Migration fixture\n\n${text}\n\n[[SCHEMA]] [[index]]`, expectedVersion: 'absent' })).ok, true)
const pageBefore = await oldWiki.page(targetPath)
const snapshot = async base => {
  const rows = []
  const walk = async (dir, prefix = '') => {
    for (const item of await readdir(dir, { withFileTypes: true })) {
      const relative = join(prefix, item.name), path = join(dir, item.name)
      if (item.isDirectory()) await walk(path, relative)
      else { assert(item.isFile(), 'Backup rejects symlinks'); rows.push([relative, hash(await readFile(path))]) }
    }
  }
  await walk(base); return rows.sort((a, b) => a[0].localeCompare(b[0]))
}
const baseline = await snapshot(legacy)
await cp(legacy, join(backup, 'legacy'), { recursive: true, errorOnExist: true, force: false })
assert.deepEqual(await snapshot(join(backup, 'legacy')), baseline)
console.log(JSON.stringify({ stage: 'upgrade-and-map-one-explicit-owner', legacyFiles: baseline.length }))
await rename(join(profileDir, 'node_modules'), join(backup, 'old-node-modules'))
await rename(join(profileDir, 'pnpm-lock.yaml'), join(testRoot, 'preserved-old-lock.yaml'))
await writeFile(join(profileDir, 'pnpm-workspace.yaml'), newWorkspaceConfig)
// Set the reviewed target before dependency resolution: otherwise pnpm first
// resolves the old broad ranges even when asked to replace the same package.
const targetManifest = JSON.parse(await readFile(join(profileDir, 'package.json')))
targetManifest.dependencies['memosbox-dsh-plugin'] = `file:${artifact}`
await writeFile(join(profileDir, 'package.json'), JSON.stringify(targetManifest))
await install('upgrade', artifact)
await verifyInstalledArtifact(artifact, join(profileDir, 'node_modules/memosbox-dsh-plugin'))
const candidateVersion = JSON.parse(await readFile(join(profileDir, 'node_modules/memosbox-dsh-plugin/package.json'))).version
const stage = phase => child(`native-${phase}`, [join(root, 'tests/run-dsh-loader.mjs'), '--stage', phase, '--test-root', testRoot, '--dsh-root', dshRoot, '--runtime-root', runtime])
await stage('scope')
const { scope: key, dataRoot } = JSON.parse(await readFile(join(testRoot, 'native-scope.json')))
const scope = { key, profileId: profileName, workspaceId: hash(workspace) }
const installed = join(profileDir, 'node_modules/memosbox-dsh-plugin/dist')
const { openScopedMemory } = await import(pathToFileURL(join(installed, 'memory/core.js')))
let fresh = await openScopedMemory(join(dataRoot, 'memory', key), scope)
try {
  const mapped = { ...exported, traces: exported.traces.map(row => ({ ...row, ownerProfileId: key, ownerWorkspaceId: scope.workspaceId })) }
  await fresh.importBundle(mapped)
  assert.equal((await fresh.getTrace(memoryId)).agentText, text)
  await fresh.importBundle(mapped)
  assert.equal((await fresh.exportBundle()).traces.length, 1, 'Rerun must not duplicate records')
} finally { await fresh.shutdown() }
await mkdir(join(dataRoot, 'scopes', key), { recursive: true })
await cp(join(legacy, 'wiki'), join(dataRoot, 'scopes', key, 'wiki'), { recursive: true, errorOnExist: true, force: false })
await writeFile(join(testRoot, 'fixture-receipt.json'), JSON.stringify({ memoryId, targetPath, candidateDigest: marker }))
await stage('read') // New process: real DSH native wiki_get / memos_get / memos_search.
const other = { key: hash('unrelated-synthetic-workspace'), profileId: profileName, workspaceId: hash('unrelated') }
fresh = await openScopedMemory(join(dataRoot, 'memory', other.key), other)
try { assert.equal(await fresh.getTrace(memoryId), null) } finally { await fresh.shutdown() }
fresh = await openScopedMemory(join(dataRoot, 'memory', key), scope)
try {
  const { writeApprovedMemory } = await import(pathToFileURL(join(installed, 'memory/approved-writer.js')))
  await writeApprovedMemory(fresh, { operationId: 'post-upgrade-synthetic-write', candidateDigest: marker, scope, text: 'SYNTHETIC NEW DATA RETAINED ON ROLLBACK' })
} finally { await fresh.shutdown() }
const upgradedSnapshot = await snapshot(dataRoot)
await rename(dataRoot, join(testRoot, 'preserved-upgraded-data'))
assert.deepEqual(await snapshot(join(testRoot, 'preserved-upgraded-data')), upgradedSnapshot)
console.log(JSON.stringify({ stage: 'rollback-offline-snapshot-without-reresolving-dependencies' }))
await rename(join(profileDir, 'node_modules'), join(testRoot, 'preserved-upgraded-node-modules'))
await rename(join(profileDir, 'pnpm-lock.yaml'), join(testRoot, 'preserved-upgraded-lock.yaml'))
await cp(join(backup, 'old-node-modules'), join(profileDir, 'node_modules'), { recursive: true, errorOnExist: true, force: false })
await verifyInstalledArtifact(oldArtifact, join(profileDir, 'node_modules/memosbox-dsh-plugin'))
for (const name of profileFiles) await cp(join(backup, name), join(profileDir, name))
await rename(legacy, join(testRoot, 'preserved-pre-rollback-legacy'))
await cp(join(backup, 'legacy'), legacy, { recursive: true, errorOnExist: true, force: false })
assert.deepEqual(await snapshot(legacy), baseline)
for (const name of profileFiles) assert.equal(hash(await readFile(join(profileDir, name))), hash(await readFile(join(backup, name))))
old = await openOld()
try { assert.equal((await old.getTrace(memoryId)).agentText, text) } finally { await old.shutdown() }
assert.equal((await oldWiki.page(targetPath)).text, pageBefore.text)
assert.deepEqual(await snapshot(join(backup, 'legacy')), baseline, 'Backup must remain untouched')
const report = { schemaVersion: 1, kind: 'migrationRollback', version: candidateVersion, artifactSha256: hash(await readFile(artifact)), oldArtifactSha256: hash(await readFile(oldArtifact)), verifiedAt: new Date().toISOString(), passed: true, scope: 'One explicitly owned synthetic trace and Wiki page; no production migration or complex policy/skill mapping', oldVersion: '0.1.0-beta.2', newVersion: candidateVersion, memosVersions: ['2.0.18', '2.0.19'], checks: { cliUpgrade: true, offlineSnapshotRollback: true, exactInstalledFilesVerified: true, stoppedBackupHashVerified: true, explicitOwnershipRemap: true, duplicateImportIdempotent: true, nativeDshFreshProcessReadback: true, otherWorkspaceAbsent: true, postUpgradeDataPreserved: true, oldProfileFilesRestoredExactly: true, oldCoreAndWikiReadback: true, oldDatabaseNeverOpenedByNewCode: true, formalProfilesUnmodified: true }, limitations: ['Old plugin full boot/embedding path not exercised; old public core/wiki interfaces used offline', 'Old fresh registry install timed out; rollback deliberately restores installed dependency snapshot offline', 'Legacy policies, world models, skills, large datasets and real data require separate migration review', 'Formal profile switch still requires explicit historical-data ownership and a maintenance window'] }
await mkdir(join(root, 'release/evidence'), { recursive: true })
const reportPath = join(root, 'release/evidence', `migration-rollback-${candidateVersion}-${report.verifiedAt.replaceAll(/[^0-9]/g, '')}.json`)
await writeFile(reportPath, JSON.stringify(report, null, 2) + '\n', { flag: 'wx' })
await writeFile(join(testRoot, 'rehearsal.json'), JSON.stringify({ ...report, baseline, upgradedSnapshot, testRoot }, null, 2))
console.log(JSON.stringify({ passed: true, testRoot, reportPath, checks: report.checks, limitations: report.limitations }))
