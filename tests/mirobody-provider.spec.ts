import { PassThrough } from 'node:stream'
import { mkdtemp, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import type { SubprocessSpawnSpec } from '@deepseek-ai/dsh-subprocess'
import { workerEnvironment } from '../src/runtime/environment.js'
import { MirobodyProvider } from '../src/mirobody/provider.js'

vi.mock('../src/runtime/paths.js', async importOriginal => ({
  ...await importOriginal<typeof import('../src/runtime/paths.js')>(),
  readRuntimeManifest: async () => ({ pythonPath: '/reviewed/venv/bin/python3.12', pythonVersion: '3.12.13', pythonBasePrefix: '/reviewed/python', bundleSha256: 'a'.repeat(64), deviceCatalogSha256: 'b'.repeat(64) }),
}))
// These fault tests emulate the capability. Real kernel/library assertions live
// in tests/python/run-real-provider.mjs and must be executed separately.
vi.mock('../src/runtime/confinement.js', () => ({ seatbeltArgv: (_runtime: unknown, _worker: unknown, _job: unknown, argv: string[]) => argv, tightenHostSeatbelt: (_host: unknown, _raw: unknown, strict: string[]) => strict }))

const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))) })

async function fixture(mode: 'ok' | 'overflow' | 'hang' | 'invalid' | 'bad-probe' | 'bad-env' | 'stuck-tree' = 'ok', extra = {}) {
  const root = await mkdtemp(join(tmpdir(), 'memosbox-provider-unit-'))
  roots.push(root)
  const specs: SubprocessSpawnSpec[] = []
  const finished: boolean[] = []
  const treeStuck = { value: mode === 'stuck-tree' }
  const ctx = {
    subprocess: {
      resolveExecutable: vi.fn(async (path: string) => path),
      spawn(spec: SubprocessSpawnSpec) {
        specs.push(spec)
        const index = finished.push(false) - 1
        const stdout = new PassThrough()
        const stderr = new PassThrough()
        let end!: (result: { exitCode: number; signal: null }) => void
        const done = new Promise<{ exitCode: number; signal: null }>(resolve => { end = resolve })
        const terminate = vi.fn(() => { if (finished[index]) return; finished[index] = true; stdout.end(); stderr.end(); end({ exitCode: 0, signal: null }) })
        const handle = { pid: index + 1000, stdout, stderr, done, terminate, waitForExit: vi.fn(async () => !treeStuck.value && finished[index]), collected: {} }
        spec.signal?.addEventListener('abort', terminate, { once: true })
        queueMicrotask(() => {
          const request = JSON.parse((spec.stdio.stdin as { data: string }).data)
          if (request.operation === '_probe') {
            const names = Object.entries(spec.env ?? {}).filter(([, value]) => value !== undefined).map(([name]) => name)
            if (mode === 'bad-env') names.push('UNEXPECTED_PARENT_ENV')
            stdout.write(JSON.stringify({ probe: { allowedRead: true, deniedRead: mode !== 'bad-probe', networkDenied: true, environmentNames: names.sort() } }))
          } else if (mode === 'hang') return
          else if (mode === 'overflow') stdout.write('x'.repeat(10_000))
          else if (mode === 'invalid') stdout.write('{invalid')
          else stdout.write(JSON.stringify({ schemaVersion: 1, operationId: request.operationId, operation: request.operation, status: 'ready', bundleVersion: 'loinc-2.82+2026.08.28-af2524b7a285', warnings: [], truncated: false,
            runtime: { mirobodyVersion: '1.4.2', pythonVersion: '3.12.13', deviceCatalogVersion: '1.4.0', bundleSha256: 'a'.repeat(64), deviceCatalogSha256: 'b'.repeat(64), network: 'blocked', isolation: 'unverified', supportedOperations: ['status', 'resolve', 'normalize_readings', 'metric_info', 'extract_document'] } }))
          terminate()
        })
        return handle
      },
    },
    sandboxPolicy: { resolve: vi.fn(() => ({ mode: 'read-only', workspaceRoot: root })) },
    sandbox: { confine: vi.fn((argv: string[]) => ({ argv, enforcement: 'full' })) },
  }
  const provider = new MirobodyProvider(ctx as unknown as Context, { runtimeRoot: root, workRoot: root, ...extra })
  return { provider, root, specs, finished, ctx, treeStuck }
}

describe('Mirobody managed provider boundaries (fault emulation)', () => {
  it('tombstones ambient config, credentials, Python paths and proxies', () => {
    const env = workerEnvironment('/private/job', { HOME: '/private/user', MIROBODY_SEMANTIC_INDEX: '/private/index', HTTPS_PROXY: 'http://proxy.invalid', PYTHONPATH: '/arbitrary', MODEL_KEY: 'synthetic-not-a-key' })
    for (const name of ['HOME', 'MIROBODY_SEMANTIC_INDEX', 'HTTPS_PROXY', 'PYTHONPATH', 'MODEL_KEY', 'http_proxy', 'NODE_USE_ENV_PROXY']) expect(env[name]).toBeUndefined()
    expect(env.PATH).toBe('/usr/bin:/bin')
    expect(env.OPENBLAS_NUM_THREADS).toBe('1')
  })

  it('uses fixed argv, propagates session, verifies OS probe and cleans every job', async () => {
    const f = await fixture()
    const session = {} as never
    expect((await f.provider.execute('status', {}, { session })).status).toBe('ready')
    expect(f.ctx.sandboxPolicy.resolve).toHaveBeenCalledWith({ session })
    expect(f.specs).toHaveLength(2)
    expect(f.specs[1]?.argv.slice(0, 5)).toEqual(['/reviewed/venv/bin/python3.12', '-I', '-B', '-X', 'utf8'])
    expect(f.specs[1]?.stdio.stdout).toBe('pipe')
    expect(f.finished.every(Boolean)).toBe(true)
    expect(await readdir(f.root)).toEqual([])
    await f.provider.dispose()
  })

  it('refuses a failed read isolation probe before the real operation', async () => {
    const f = await fixture('bad-probe')
    await expect(f.provider.execute('status', {})).rejects.toThrow('OS_CONFINEMENT_UNVERIFIED')
    expect(f.specs).toHaveLength(1)
    await f.provider.dispose()
  })

  it('fails closed when the actual child environment includes extra names', async () => {
    const f = await fixture('bad-env')
    await expect(f.provider.execute('status', {})).rejects.toThrow('WORKER_ENVIRONMENT_UNVERIFIED')
    expect(f.specs).toHaveLength(1)
    await f.provider.dispose()
  })

  it('retains private inputs until whole-tree cleanup is actually confirmed', async () => {
    const f = await fixture('stuck-tree')
    await expect(f.provider.execute('status', {})).rejects.toThrow('WORKER_TREE_NOT_QUIESCENT')
    expect((await readdir(f.root)).some(name => name.startsWith('job-'))).toBe(true)
    await expect(f.provider.execute('status', {})).rejects.toThrow('WORKER_CLEANUP_PENDING')
    f.treeStuck.value = false
    await f.provider.dispose()
    expect(await readdir(f.root)).toEqual([])
  })

  it('kills output over the hard byte cap instead of parsing a retained tail', async () => {
    const f = await fixture('overflow', { maxOutputBytes: 1024 })
    await expect(f.provider.execute('status', {})).rejects.toThrow('WORKER_OUTPUT_LIMIT')
    expect(f.finished.every(Boolean)).toBe(true)
    expect(await readdir(f.root)).toEqual([])
    await f.provider.dispose()
  })

  it('rejects invalid JSON without echoing worker text', async () => {
    const f = await fixture('invalid')
    await expect(f.provider.execute('status', {})).rejects.toThrow('WORKER_PROTOCOL_INVALID')
    await f.provider.dispose()
  })

  it('timeout and dispose join their managed processes', async () => {
    const f = await fixture('hang', { localTimeoutMs: 30 })
    await expect(f.provider.execute('status', {})).rejects.toThrow('WORKER_TIMEOUT')
    expect(f.finished.every(Boolean)).toBe(true)
    await f.provider.dispose()
    await expect(f.provider.execute('status', {})).rejects.toThrow('PROVIDER_DISPOSED')
    const second = await fixture('hang')
    const job = second.provider.execute('status', {})
    const rejected = expect(job).rejects.toThrow('WORKER_CANCELED')
    await second.provider.dispose()
    await rejected
    expect(second.finished.every(Boolean)).toBe(true)
  })

  it('allows one worker and refuses inflated resource limits', async () => {
    const f = await fixture('hang')
    const running = f.provider.execute('status', {})
    const rejected = expect(running).rejects.toThrow('WORKER_CANCELED')
    await expect(f.provider.execute('status', {})).rejects.toThrow('WORKER_BUSY')
    await f.provider.dispose()
    await rejected
    expect(() => new MirobodyProvider({} as Context, { runtimeRoot: f.root, workRoot: f.root, maxBatch: 257 })).toThrow('INVALID_WORKER_LIMIT')
  })
})
