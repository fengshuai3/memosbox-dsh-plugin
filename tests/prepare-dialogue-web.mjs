/** Prepare, but do not launch, a private DSH Web profile for real-model dialogue.
 * Only the frozen plugin package supplies model-facing tools. Credential bytes
 * are never read or copied; the host provider resolves the authorized reference.
 */
import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import { spawn } from 'node:child_process'
import { chmod, mkdir, readFile, realpath, stat, symlink, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

export const name = 'web-dialogue-step-budget'
export const inject = ['agents']
export function apply(ctx, config) {
  ctx.on('agent/pre-step', async (payload, next) => {
    if (payload.step > config.maxSteps) {
      payload.agent.cancel({ kind: 'hook', reason: 'WEB_DIALOGUE_STEP_BUDGET' })
      return { kind: 'reject' }
    }
    return next()
  })
}

const root = resolve(import.meta.dirname, '..')
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex')
const arg = name => { const index = process.argv.indexOf(name); return index < 0 ? undefined : process.argv[index + 1] }
const put = (path, value) => writeFile(path, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 })

async function prepare() {
  process.umask(0o077)
  assert.equal(process.platform, 'darwin')
  assert.equal(process.arch, 'arm64')
  const mode = arg('--mode') ?? 'approval'
  assert(['chat', 'approval'].includes(mode), 'Use --mode chat or approval')
  const chatMode = mode === 'chat'
  const dshRoot = await realpath(resolve(arg('--dsh-root') ?? join(root, '../deepseek-harness')))
  assert(arg('--artifact'), 'Provide an explicitly selected frozen --artifact')
  const artifact = await realpath(resolve(arg('--artifact')))
  assert(artifact.startsWith(join(root, 'artifacts') + '/'), 'Use a plugin-local frozen artifact')
  const artifactSha256 = sha256(await readFile(artifact))
  const credentialsPath = join(dshRoot, '.local/dsh-home/.credentials.yaml')
  assert((await stat(credentialsPath)).isFile()) // Existence only; never inspect credential bytes.
  assert(arg('--runtime'), 'Provide the matching verified --runtime')
  const runtime = await realpath(resolve(arg('--runtime')))
  const activeRuntime = JSON.parse(await readFile(join(runtime, 'active-runtime.json'), 'utf8'))
  assert((await stat(activeRuntime.pythonPath)).isFile())
  const testRoot = join(root, '.test-runtime', `web-dialogue-${randomUUID()}`)
  const home = join(testRoot, 'home'), workspace = join(testRoot, 'synthetic-workspace')
  const inbox = join(testRoot, 'inbox'), bin = join(testRoot, 'bin')
  const profileName = 'memosbox-web-dialogue'
  for (const directory of [workspace, inbox, bin]) await mkdir(directory, { recursive: true, mode: 0o700 })
  await chmod(testRoot, 0o700)
  await symlink(join(dirname(process.execPath), '../lib/node_modules/corepack/dist/pnpm.js'), join(bin, 'pnpm'))
  const env = { ...process.env, DSH_HOME: home, DSH_TELEMETRY_DISABLED: '1', DSH_PERMISSION_MODE: 'read-only', DSH_TOOLS_MODE: 'native', PATH: `${bin}:${dirname(process.execPath)}:${process.env.PATH}` }
  delete env.DEEPSEEK_API_KEY; delete env.DEEPSEEK_BASE_URL
  process.env.DSH_HOME = home
  const boot = await import(pathToFileURL(join(dshRoot, 'packages/boot/app-boot/lib/index.js')).href)
  const profileDir = boot.resolveProfileDir(profileName)
  boot.initProfile(profileDir, ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app'], 'startup')
  const manifest = JSON.parse(await readFile(join(profileDir, 'package.json'), 'utf8'))
  manifest.packageManager = 'pnpm@11.7.0'
  await put(join(profileDir, 'package.json'), manifest)
  await writeFile(join(profileDir, 'pnpm-workspace.yaml'), 'packages: []\nallowBuilds:\n  better-sqlite3: true\nautoInstallPeers: false\n', { mode: 0o600 })
  const cli = join(dshRoot, 'apps/cli/lib/bin.js')
  const installation = await run([cli, 'plugin', '--profile', profileName, 'add', '-w', artifact, '--registry=https://registry.npmjs.org'], { cwd: workspace, env, outputPrefix: join(testRoot, 'installation') })
  assert.equal(installation.code, 0, `CLI install failed; private logs in ${testRoot}`)
  const installed = JSON.parse(await readFile(join(profileDir, 'package.json'), 'utf8'))
  assert(installed.dsh.profile.bundles.includes('memosbox-dsh-plugin'))
  const disabled = [
    'session-title-llm', 'session-telemetry-otel', 'agent-presets', 'agent-instructions',
    'tool-bash', 'tool-pwsh', 'tool-jobs', 'tool-fs', 'tool-fs-search', 'tool-skill',
    'tool-subagent-control', 'tool-subagent-list-agents', 'tool-subagent', 'tool-subagent-fork',
    'tool-workflow', 'tool-todo', 'tool-goal', 'tool-ralph', 'tool-str-replace-editor', 'tool-web',
    'code-runtime', 'llm-pi-ai', 'goal-round-driver', 'command-goal', 'command-feedback',
    'command-compact', 'plan-mode', 'web-search-deepseek', 'web-fetch-http',
  ]
  const dataRoot = join(home, 'memosbox'), sessionsRoot = join(home, 'sessions')
  const patches = [
    ...disabled.map(id => ({ id, disabled: true })),
    { id: 'agent-default-model', config: { provider: 'deepseek-official', model: 'deepseek-flash', reasoningEffort: 'off' } },
    { id: 'credentials', config: { path: credentialsPath, watch: false } },
    { id: 'settings', config: { path: join(home, 'settings.yaml'), watch: false } },
    { id: 'llm-deepseek', config: { baseURL: 'https://api.deepseek.com', apiKeyEnv: 'DEEPSEEK_API_KEY', thinking: 'disabled', reasoningEffort: 'off', maxTokens: 3072, streamIdleTimeoutMs: 45000, retryPolicy: { mode: 'normal', maxRetries: 0 } } },
    { id: 'session-persistence-jsonl', config: { root: sessionsRoot, compression: 'none', packChunks: false } },
    { id: 'tools', config: { mode: 'native' } },
    { id: 'sandbox-policy', config: { mode: 'read-only', workspaceRoot: workspace } },
    { id: 'approval', config: { policy: 'ask' } },
    { id: 'memosbox-native', config: { enabled: true, profileId: profileName, dataHome: dataRoot, mirobodyRuntimePath: runtime, mirobodySourcePath: chatMode ? '' : inbox, captureEnabled: chatMode, queryLogEnabled: false, wikiWriteEnabled: !chatMode, explicitMemoryWriteEnabled: !chatMode, mirobodySyntheticDocumentsEnabled: !chatMode, mirobodyModelExtractionEnabled: !chatMode } },
    { insert: [{ id: name, name: pathToFileURL(import.meta.filename).href, config: { maxSteps: 10 } }] },
  ]
  await put(join(profileDir, 'cordis.patch.yml'), patches)
  await put(join(home, 'settings.yaml'), {})
  const text = 'SYNTHETIC FIXTURE ONLY\nHemoglobin [Mass/volume] in Blood 130 g/L\n'
  const sourceDigest = sha256(text), sourceId = `${sourceDigest}.txt`
  await writeFile(join(inbox, sourceId), text, { mode: 0o600, flag: 'wx' })
  const port = Number(arg('--port') ?? 18089)
  assert(Number.isInteger(port) && port > 1024 && port < 65536 && port !== 18080)
  const argv = [cli, '--profile', profileName, '--host', '127.0.0.1', '--port', String(port), '--no-open']
  const profile = boot.loadProfile('memosbox-web-preparation', profileName, join(dshRoot, 'apps/cli/package.json'))
  await boot.healProfilesModuleFallback({ installAnchor: join(dshRoot, 'apps/cli/package.json'), profile })
  const receipt = {
    schemaVersion: 1, mode, captureEnabled: chatMode, preparedAt: new Date().toISOString(), testRoot, home, workspace, inbox,
    profileName, profileDir, dataRoot, sessionsRoot, artifact, artifactSha256, installation,
    runtime, pythonPath: activeRuntime.pythonPath, runtimeLockDigest: activeRuntime.lockDigest,
    credentialReferenceOnly: true, credentialsPath, credentialRef: 'DEEPSEEK_API_KEY',
    provider: 'deepseek-official', model: 'deepseek-flash', baseURL: 'https://api.deepseek.com',
    sourceId, sourceDigest, sourceContent: text, syntheticOnly: true,
    launch: { executable: process.execPath, argv, cwd: workspace, unsetEnvironment: ['DEEPSEEK_API_KEY', 'DEEPSEEK_BASE_URL'], environment: { DSH_HOME: home, DSH_TELEMETRY_DISABLED: '1', DSH_PERMISSION_MODE: 'read-only', DSH_TOOLS_MODE: 'native', PATH: env.PATH }, url: `http://127.0.0.1:${port}` },
    disabled, maxSteps: 10, maxTokens: 3072, started: false, noModelCallDuringPreparation: true,
    fixtureModel: false, automaticApprovalAnswerer: false, pluginPromptsUnmodified: true,
    qualification: 'Plugin-only tool catalog. Standard preset and generic tools disabled; this does not qualify normal mixed-tool competition, production health privacy, or public release.',
  }
  await put(join(testRoot, 'web-dialogue-preparation.json'), receipt)
  process.stdout.write(JSON.stringify({ prepared: true, receipt: join(testRoot, 'web-dialogue-preparation.json'), profileDir, sourceId, launch: receipt.launch }, null, 2) + '\n')
}

async function run(args, { cwd, env, outputPrefix }) {
  const child = spawn(process.execPath, args, { cwd, env, detached: true, stdio: ['ignore', 'pipe', 'pipe'] })
  let stdout = '', stderr = '', timedOut = false, outputExceeded = false, escalation
  const terminate = () => {
    try { process.kill(-child.pid, 'SIGTERM') } catch (error) { if (error.code !== 'ESRCH') throw error }
    escalation ??= setTimeout(() => { try { process.kill(-child.pid, 'SIGKILL') } catch (error) { if (error.code !== 'ESRCH') throw error } }, 5000)
  }
  const capture = stream => chunk => {
    if (Buffer.byteLength(stdout) + Buffer.byteLength(stderr) + chunk.length > 8 * 1024 * 1024) { outputExceeded = true; terminate(); return }
    if (stream === 'out') stdout += chunk.toString('utf8'); else stderr += chunk.toString('utf8')
  }
  child.stdout.on('data', capture('out')); child.stderr.on('data', capture('err'))
  const timeout = setTimeout(() => { timedOut = true; terminate() }, 180000)
  let failure
  child.on('error', error => { failure = error.code ?? error.name })
  const outcome = await new Promise(done => child.on('close', (code, signal) => done({ code, signal })))
  clearTimeout(timeout); if (escalation) clearTimeout(escalation)
  await writeFile(outputPrefix + '.stdout.private.txt', stdout, { mode: 0o600 })
  await writeFile(outputPrefix + '.stderr.private.txt', stderr, { mode: 0o600 })
  return { ...outcome, failure, timedOut, outputExceeded }
}

if (process.argv[1] && resolve(process.argv[1]) === import.meta.filename) {
  await prepare().catch(error => { process.stderr.write(`Web dialogue preparation failed: ${error.message}\n`); process.exitCode = 1 })
}
