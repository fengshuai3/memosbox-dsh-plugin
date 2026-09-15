/** Explicit integration runner; uses real Cordis-mounted DSH services and
 * Mirobody wheels. This is not a full profile Loader/model/network E2E test.
 * node --experimental-transform-types tests/python/run-real-provider.mjs --dsh-root /path/to/deepseek-harness
 */
import assert from 'node:assert/strict'
import { mkdir, readFile, readdir, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { createHash, randomUUID } from 'node:crypto'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { MirobodyProvider } from '../../dist/mirobody/provider.js'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const index = process.argv.indexOf('--dsh-root')
assert(index >= 0, 'Provide the explicitly reviewed DSH source checkout')
const dshRoot = await realpath(resolve(process.argv[index + 1]))
const runtimeIndex = process.argv.indexOf('--runtime-root')
const runtimeRoot = await realpath(resolve(runtimeIndex < 0 ? join(root, '.runtime') : process.argv[runtimeIndex + 1]))
const testRoot = join(root, '.test-runtime', `native-provider-${randomUUID()}`)
const workRoot = join(testRoot, 'jobs')
await mkdir(workRoot, { recursive: true, mode: 0o700 })
process.env.DSH_HOME = join(testRoot, 'dsh-home')
// Synthetic inherited values must be absent in every real worker. The OS
// probe returns names only and the provider compares the exact allowlist.
process.env.MIROBODY_SEMANTIC_INDEX = '/synthetic-forbidden-index'
process.env.PYTHONPATH = '/synthetic-forbidden-python-path'
process.env.MEMOSBOX_TEST_SECRET = 'synthetic-not-a-real-credential'
process.env.HTTPS_PROXY = 'http://127.0.0.1:9'
const dshRequire = createRequire(join(dshRoot, 'packages/subprocess/subprocess-local/package.json'))
const { Context } = await import(pathToFileURL(dshRequire.resolve('@deepseek-ai/cordis')))
const load = relative => import(pathToFileURL(join(dshRoot, relative, 'lib/index.js')))
const { default: LocalSubprocessRuntime } = await load('packages/subprocess/subprocess-local')
const { default: LocalSandboxProvider } = await load('packages/sandbox/sandbox-local')
const { default: SandboxPolicyService } = await load('packages/sandbox/sandbox-policy')
const { default: SessionProjectionRegistry } = await load('packages/session/session-projection')
const { Session, SessionId } = await load('packages/core/session')
const ctx = new Context()
const fibers = []
fibers.push(await ctx.plugin(SessionProjectionRegistry))
fibers.push(await ctx.plugin(SandboxPolicyService, { mode: 'read-only', workspaceRoot: testRoot }))
fibers.push(await ctx.plugin(LocalSubprocessRuntime))
fibers.push(await ctx.plugin(LocalSandboxProvider))
const handles = []
const actualSpawn = ctx.subprocess.spawn.bind(ctx.subprocess)
ctx.subprocess.spawn = spec => {
  const handle = actualSpawn(spec)
  handles.push(handle)
  if (process.argv.includes('--debug-synthetic')) {
    handle.stderr?.on('data', data => process.stderr.write(data))
    handle.stdout?.on('data', data => process.stderr.write(data))
    void handle.done.then(outcome => console.error('synthetic child outcome', outcome))
  }
  return handle
}
const provider = new MirobodyProvider(ctx, { runtimeRoot, workRoot })
let assertions = 0
try {
  const status = await provider.status()
  assert.equal(status.status, 'ready', JSON.stringify(status))
  assert.equal(status.runtime.isolation, 'macos-seatbelt-probed')
  assert.equal(status.runtime.mirobodyVersion, '1.4.2')
  assertions += 3
  const originalManifest = JSON.parse(await readFile(join(runtimeRoot, 'active-runtime.json')))
  const badRoot = join(testRoot, 'synthetic-corrupt-runtime')
  const badVenv = join(badRoot, 'runtimes', originalManifest.generation, '.venv')
  await mkdir(join(badVenv, 'bin'), { recursive: true, mode: 0o700 })
  await symlink(originalManifest.pythonExecutable, join(badVenv, 'bin', 'python3.12'))
  const badManifest = { ...originalManifest, pythonPath: join(badVenv, 'bin', 'python3.12'), bundlePath: join(badVenv, 'synthetic-corrupt-bundle'), bundleSha256: '0'.repeat(64) }
  await writeFile(join(badRoot, 'active-runtime.json'), JSON.stringify(badManifest), { mode: 0o600 })
  const corruptProvider = new MirobodyProvider(ctx, { runtimeRoot: badRoot, workRoot })
  assert.equal((await corruptProvider.status()).error.code, 'RUNTIME_MANIFEST_MISMATCH')
  badManifest.bundleSha256 = originalManifest.bundleSha256
  await writeFile(badManifest.bundlePath, 'synthetic-corrupt-bundle', { mode: 0o600 })
  await writeFile(join(badRoot, 'active-runtime.json'), JSON.stringify(badManifest), { mode: 0o600 })
  assert.equal((await corruptProvider.status()).error.code, 'RUNTIME_RESOURCE_INTEGRITY')
  await corruptProvider.dispose()
  assertions += 2
  const sessionId = SessionId('synthetic-mirobody-native')
  const session = Session.create(sessionId, undefined, { version: 0, id: sessionId, createdAt: 0, isSeeded: false, cwd: testRoot })
  const resolved = await provider.execute('resolve', { rawName: '血红蛋白' }, { session })
  assert.equal(resolved.readings[0].code, '718-7')
  assert.equal(ctx.sandboxPolicy.resolve({ session }).sessionId, session.id)
  assertions += 2
  const normalized = await provider.execute('normalize_readings', { readings: [{ rawName: 'total cholesterol', rawValue: '5.0', rawUnit: 'mmol/L' }, { rawName: '血脂' }] })
  assert.equal(normalized.readings[0].code, '14647-2')
  assert.equal(normalized.readings[1].status, 'refused')
  assertions += 2
  const metric = await provider.execute('metric_info', { name: 'heartRates' })
  assert.equal(metric.metric.state_class, 'instant')
  assertions++
  const source = join(workRoot, 'synthetic-source.txt')
  const bytes = Buffer.from('SYNTHETIC INPUT ONLY\n\nHemoglobin 130 g/L\n')
  await writeFile(source, bytes, { mode: 0o600 })
  try {
    const document = await provider.execute('extract_document', { sourcePath: source, sourceDigest: createHash('sha256').update(bytes).digest('hex'), format: 'text' })
    assert.equal(document.status, 'ready')
    assert.equal(document.segments[1].location.line, 3)
    assert.equal(document.segments[1].text, 'Hemoglobin 130 g/L')
    assertions += 3
  } finally { await rm(source) }
  const aborted = new AbortController()
  aborted.abort()
  await assert.rejects(provider.execute('resolve', { rawName: 'hemoglobin' }, { signal: aborted.signal }), /WORKER_CANCELED/)
  assertions++
  // Real DSH process termination under synthetic fault injection, not mocked
  // handle completion. The fixture is never part of the shipped runtime.
  for (const fault of ['overflow', 'timeout', 'cancel', 'dispose']) {
    const faultProvider = new MirobodyProvider(ctx, { runtimeRoot, workRoot,
      workerPath: join(root, 'tests', 'python', 'fault_worker.py'), maxOutputBytes: 1024,
      localTimeoutMs: fault === 'timeout' ? 400 : 5000 })
    const cancel = new AbortController()
    const before = handles.length
    const running = faultProvider.execute('status', { fault }, { signal: cancel.signal })
    const expected = fault === 'overflow' ? /WORKER_OUTPUT_LIMIT/ : fault === 'timeout' ? /WORKER_TIMEOUT/ : /WORKER_CANCELED/
    const rejected = assert.rejects(running, expected)
    if (fault === 'cancel' || fault === 'dispose') {
      const until = Date.now() + 3000
      while (handles.length < before + 2 && Date.now() < until) await new Promise(resolve => setTimeout(resolve, 10))
      assert.equal(handles.length, before + 2, 'fault must reach the real worker, not cancel before spawn')
      if (fault === 'cancel') cancel.abort()
      else await faultProvider.dispose()
      assertions++
    }
    await rejected
    await faultProvider.dispose()
    for (const handle of handles.slice(before)) assert.equal(await handle.waitForExit(AbortSignal.timeout(1000)), true)
    assertions++
  }
  if (process.argv.includes('--native-tools')) {
    const { default: SystemPrompt } = await load('packages/core/system-prompt')
    const { default: ToolRuntime } = await load('packages/core/tools')
    const { registerMirobodyTools } = await import('../../dist/mirobody/tools.js')
    const { sessionScope } = await import('../../dist/privacy/scope.js')
    fibers.push(await ctx.plugin(SystemPrompt))
    fibers.push(await ctx.plugin(ToolRuntime, { mode: 'native' }))
    const off = registerMirobodyTools(ctx, { provider, dataRoot: testRoot, sourceRoot: testRoot, sensitiveMode: false, syntheticDocumentsEnabled: false, modelExtractionEnabled: false, wikiWriteEnabled: false, explicitMemoryWriteEnabled: false, scope: () => sessionScope('synthetic', testRoot), wiki: () => { throw new Error('NOT_USED_IN_READ_ONLY_NATIVE_TEST') } })
    try {
      for (const [name, args, check] of [
        ['mirobody_status', {}, data => data.runtime.mirobodyVersion === '1.4.2' && data.realHealthDataReady === false],
        ['mirobody_resolve', { name: '血红蛋白' }, data => data.readings[0].code === '718-7'],
        ['mirobody_normalize_readings', { readings: [{ rawName: 'total cholesterol', rawValue: '5', rawUnit: 'mmol/L' }] }, data => data.readings[0].code === '14647-2'],
      ]) {
        const result = await ctx.tools.execute({ callId: `synthetic-${name}`, name, arguments: args, agent: { session }, signal: new AbortController().signal })
        assert.equal(result.isError, false, JSON.stringify(result))
        const rendered = JSON.parse(result.content.find(block => block.type === 'text').text)
        assert(check(rendered.data), `Native tool execute/render assertion failed: ${name}`)
        assertions += 2
      }
    } finally { off() }
    assert.equal(ctx.tools.get('mirobody_resolve'), undefined)
    assertions++
  }
} finally {
  await provider.dispose()
  for (const fiber of fibers.reverse()) await fiber.dispose()
}
for (const handle of handles) assert.equal(await handle.waitForExit(AbortSignal.timeout(1000)), true)
assert.deepEqual(await readdir(workRoot), [])
await assert.rejects(provider.execute('status', {}), /PROVIDER_DISPOSED/)
assertions += handles.length + 2
const manifest = JSON.parse(await readFile(join(runtimeRoot, 'active-runtime.json')))
await rm(testRoot, { recursive: true, force: true })
console.log(JSON.stringify({ result: 'passed', assertions, managedProcesses: handles.length, wholeTreeExited: true, temporarySourcesRemoved: true, officialMirobody: manifest.mirobodyVersion, lockDigest: manifest.lockDigest, nativeTools: process.argv.includes('--native-tools'), scope: 'synthetic only; real Cordis-mounted DSH services and optional tool execute/render, not full profile Loader/model/session persistence E2E' }, null, 2))
