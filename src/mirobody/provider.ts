import type { Context } from '@deepseek-ai/cordis'
import type { SubprocessHandle } from '@deepseek-ai/dsh-subprocess'
import type {} from '@deepseek-ai/dsh-sandbox'
import type {} from '@deepseek-ai/dsh-sandbox-policy'
import { randomUUID } from 'node:crypto'
import { constants } from 'node:fs'
import { chmod, lstat, mkdir, mkdtemp, open, realpath, rm, writeFile } from 'node:fs/promises'
import { isAbsolute, join, resolve } from 'node:path'
import { homedir } from 'node:os'
import { TextDecoder } from 'node:util'
import type { Readable } from 'node:stream'
import { seatbeltArgv, tightenHostSeatbelt } from '../runtime/confinement.js'
import { workerEnvironment } from '../runtime/environment.js'
import { defaultWorkerPath, MIROBODY_VERSION, MIROBODY_CATALOG_VERSION, MIROBODY_BUNDLE_VERSION, readRuntimeManifest, sha256, type RuntimeManifest } from '../runtime/paths.js'
import type { MirobodyExecuteOptions, MirobodyExecutor, MirobodyOperation, MirobodyProviderConfig, MirobodyResponse } from './types.js'

const OPERATIONS: ReadonlySet<string> = new Set(['status', 'resolve', 'normalize_readings', 'metric_info', 'extract_document'])
const STATES: ReadonlySet<string> = new Set(['ready', 'needs_ocr', 'partial', 'unresolved', 'refused', 'failed'])

function bounded(value: number | undefined, fallback: number, maximum: number): number {
  const result = value ?? fallback
  if (!Number.isSafeInteger(result) || result < 1 || result > maximum) throw new Error('INVALID_WORKER_LIMIT')
  return result
}

/** A managed one-shot local Python library, not an API bridge or a daemon.
 * Permission to read a source belongs to the calling tool; this layer only
 * accepts its already registered copy and verifies the digest before use.
 */
export class MirobodyProvider implements MirobodyExecutor {
  private readonly lifetime = new AbortController()
  private readonly handles = new Set<SubprocessHandle>()
  private readonly jobs = new Set<Promise<unknown>>()
  private readonly retainedDirectories = new Set<string>()
  private readonly retainedCanaries = new Set<string>()
  private busy = false
  private readonly limits: { maxFileBytes: number; maxPdfPages: number; maxRows: number; maxBatch: number }
  private readonly inputLimit: number
  private readonly outputLimit: number
  private readonly localTimeout: number
  private readonly documentTimeout: number

  constructor(private readonly ctx: Context, private readonly config: MirobodyProviderConfig) {
    if ([resolve('/'), homedir()].includes(resolve(config.workRoot))) throw new Error('UNSAFE_WORK_ROOT')
    this.limits = {
      maxFileBytes: bounded(config.maxFileBytes, 20 * 1024 * 1024, 20 * 1024 * 1024),
      maxPdfPages: bounded(config.maxPdfPages, 100, 100), maxRows: bounded(config.maxRows, 5000, 5000),
      maxBatch: bounded(config.maxBatch, 256, 256),
    }
    this.inputLimit = bounded(config.maxInputBytes, 2 * 1024 * 1024, 2 * 1024 * 1024)
    this.outputLimit = bounded(config.maxOutputBytes, 4 * 1024 * 1024, 8 * 1024 * 1024)
    this.localTimeout = bounded(config.localTimeoutMs, 15_000, 180_000)
    this.documentTimeout = bounded(config.documentTimeoutMs, 180_000, 180_000)
  }

  async status(options: MirobodyExecuteOptions = {}): Promise<MirobodyResponse> {
    try { return await this.execute('status', {}, options) } catch (error) {
      return { schemaVersion: 1, operationId: randomUUID(), operation: 'status', status: options.signal?.aborted || this.lifetime.signal.aborted ? 'canceled' : 'unavailable', bundleVersion: MIROBODY_BUNDLE_VERSION, warnings: [], truncated: false,
        error: { code: safeErrorCode(error), message: 'Runtime unavailable; explicit preparation and a passing confinement probe are required.' } }
    }
  }

  execute(operation: MirobodyOperation, payload: Record<string, unknown>, options: MirobodyExecuteOptions = {}): Promise<MirobodyResponse> {
    if (this.lifetime.signal.aborted) return Promise.reject(new Error('PROVIDER_DISPOSED'))
    if (this.handles.size && !this.busy) return Promise.reject(new Error('WORKER_CLEANUP_PENDING'))
    if (this.busy) return Promise.reject(new Error('WORKER_BUSY'))
    if (!OPERATIONS.has(operation)) return Promise.reject(new Error('UNSUPPORTED_OPERATION'))
    this.busy = true
    const job = this.executeJob(operation, payload, options)
    this.jobs.add(job)
    void job.finally(() => { this.jobs.delete(job); this.busy = false }).catch(() => undefined)
    return job
  }

  async dispose(): Promise<void> {
    this.lifetime.abort(new Error('PROVIDER_DISPOSED'))
    for (const handle of this.handles) handle.terminate()
    await Promise.allSettled([...this.jobs])
    for (const handle of this.handles) {
      handle.terminate()
      if (!await handle.waitForExit(AbortSignal.timeout(5000))) throw new Error('WORKER_TREE_NOT_QUIESCENT')
      this.handles.delete(handle)
    }
    for (const path of this.retainedDirectories) await rm(path, { recursive: true, force: true })
    for (const path of this.retainedCanaries) await rm(path, { force: true })
    this.retainedDirectories.clear()
    this.retainedCanaries.clear()
  }

  private async executeJob(operation: MirobodyOperation, payload: Record<string, unknown>, options: MirobodyExecuteOptions): Promise<MirobodyResponse> {
    const deadline = new AbortController()
    const timer = setTimeout(() => deadline.abort(new Error('WORKER_TIMEOUT')), operation === 'extract_document' ? this.documentTimeout : this.localTimeout)
    const signal = AbortSignal.any([this.lifetime.signal, deadline.signal, ...(options.signal ? [options.signal] : [])])
    const operationId = randomUUID()
    let jobDirectory: string | undefined
    let deniedPath: string | undefined
    try {
      signal.throwIfAborted()
      const runtime = await readRuntimeManifest(this.config.runtimeRoot)
      const workerPath = resolve(this.config.workerPath ?? defaultWorkerPath)
      if (await realpath(workerPath) !== workerPath || !(await lstat(workerPath)).isFile()) throw new Error('WORKER_PATH_INVALID')
      await mkdir(resolve(this.config.workRoot), { recursive: true, mode: 0o700 })
      const workRoot = await realpath(resolve(this.config.workRoot))
      jobDirectory = await mkdtemp(join(workRoot, 'job-'))
      await chmod(jobDirectory, 0o700)
      const env = workerEnvironment(jobDirectory)
      // Resolve verifies executable availability. Keep the venv spelling when
      // invoking Python: replacing it with its realpath loses venv identity.
      await this.ctx.subprocess.resolveExecutable(runtime.pythonPath, { PATH: '/usr/bin:/bin' }, signal)
      const policy = this.ctx.sandboxPolicy.resolve(options.session === undefined ? {} : { session: options.session })
      const rawArgv = [runtime.pythonPath, '-I', '-B', '-X', 'utf8', workerPath]
      // Every library operation is read-only even when the session grants
      // writes. Narrow the standing policy; never request escalation.
      const confined = this.ctx.sandbox.confine(rawArgv, { ...policy, mode: 'read-only' })
      if (confined.enforcement !== 'full') throw new Error('DSH_SANDBOX_PARTIAL')
      const argv = tightenHostSeatbelt(confined.argv, rawArgv, seatbeltArgv(runtime, workerPath, jobDirectory, rawArgv))
      const allowedPath = join(jobDirectory, 'allowed-probe')
      deniedPath = join(workRoot, `denied-probe-${operationId}`)
      await writeFile(allowedPath, 'allowed-synthetic-probe', { flag: 'wx', mode: 0o600 })
      await writeFile(deniedPath, 'denied-synthetic-probe', { flag: 'wx', mode: 0o600 })
      const probe = await this.run(argv, jobDirectory, env, { schemaVersion: 1, operation: '_probe', payload: { allowedPath, deniedPath } }, signal) as { probe?: { allowedRead?: boolean; deniedRead?: boolean; networkDenied?: boolean; environmentNames?: unknown } }
      if (probe.probe?.allowedRead !== true || probe.probe.deniedRead !== true || probe.probe.networkDenied !== true) throw new Error('OS_CONFINEMENT_UNVERIFIED')
      const expectedEnvironment = Object.entries(env).filter(([, value]) => value !== undefined).map(([name]) => name).sort()
      if (JSON.stringify(probe.probe.environmentNames) !== JSON.stringify(expectedEnvironment)) throw new Error('WORKER_ENVIRONMENT_UNVERIFIED')
      let workerPayload = payload
      if (operation === 'extract_document') workerPayload = await this.copySource(payload, jobDirectory, signal)
      const result = await this.run(argv, jobDirectory, env, { schemaVersion: 1, operationId, operation, payload: workerPayload, limits: this.limits }, signal) as MirobodyResponse
      validateResponse(result, operation, operationId)
      if (operation === 'extract_document' && result.status !== 'failed' && result.sourceDigest !== workerPayload.sourceDigest) throw new Error('WORKER_SOURCE_DIGEST_MISMATCH')
      if (result.runtime) {
        if (result.runtime.pythonVersion !== runtime.pythonVersion || result.runtime.deviceCatalogVersion !== MIROBODY_CATALOG_VERSION
            || result.runtime.bundleSha256 !== runtime.bundleSha256 || result.runtime.deviceCatalogSha256 !== runtime.deviceCatalogSha256) throw new Error('RUNTIME_RESOURCE_INTEGRITY')
        result.runtime.isolation = 'macos-seatbelt-probed'
        result.runtime.limitations = ['file-metadata-visible', 'rss-cpu-hard-limits-not-validated', 'development-interpreter-not-bundled', 'health-data-mode-not-validated']
      }
      signal.throwIfAborted()
      return result
    } catch (error) {
      if (deadline.signal.aborted) throw new Error('WORKER_TIMEOUT')
      if (signal.aborted) throw new Error('WORKER_CANCELED')
      throw new Error(safeErrorCode(error))
    } finally {
      clearTimeout(timer)
      // run() awaits whole-tree quiescence before any source copy is removed.
      if (this.handles.size) {
        if (jobDirectory) this.retainedDirectories.add(jobDirectory)
        if (deniedPath) this.retainedCanaries.add(deniedPath)
      } else {
        if (jobDirectory) await rm(jobDirectory, { recursive: true, force: true })
        if (deniedPath) await rm(deniedPath, { force: true })
      }
    }
  }

  private async copySource(payload: Record<string, unknown>, jobDirectory: string, signal: AbortSignal): Promise<Record<string, unknown>> {
    if (typeof payload.sourcePath !== 'string' || !isAbsolute(payload.sourcePath) || typeof payload.sourceDigest !== 'string'
        || !/^[a-f0-9]{64}$/.test(payload.sourceDigest) || !['text', 'pdf', 'xlsx'].includes(String(payload.format))) throw new Error('INVALID_REGISTERED_SOURCE')
    if (await realpath(payload.sourcePath) !== payload.sourcePath) throw new Error('SOURCE_SYMLINK')
    const handle = await open(payload.sourcePath, constants.O_RDONLY | constants.O_NOFOLLOW)
    try {
      const before = await handle.stat()
      if (!before.isFile() || before.size > this.limits.maxFileBytes) throw new Error('SOURCE_TYPE_OR_SIZE')
      const bytes = Buffer.alloc(Math.min(before.size + 1, this.limits.maxFileBytes + 1))
      let total = 0
      while (total < bytes.length) {
        signal.throwIfAborted()
        const read = await handle.read(bytes, total, bytes.length - total, total)
        if (!read.bytesRead) break
        total += read.bytesRead
      }
      const after = await handle.stat()
      const content = bytes.subarray(0, total)
      if (after.size !== before.size || after.mtimeMs !== before.mtimeMs || total !== before.size || sha256(content) !== payload.sourceDigest) throw new Error('SOURCE_CHANGED_OR_DIGEST_MISMATCH')
      const sourcePath = join(jobDirectory, 'input.document')
      await writeFile(sourcePath, content, { flag: 'wx', mode: 0o600 })
      return { sourcePath, sourceDigest: payload.sourceDigest, format: payload.format }
    } finally { await handle.close() }
  }

  private async run(argv: string[], cwd: string, env: NodeJS.ProcessEnv, request: unknown, signal: AbortSignal): Promise<unknown> {
    const input = JSON.stringify(request)
    if (Buffer.byteLength(input) > this.inputLimit) throw new Error('WORKER_INPUT_LIMIT')
    signal.throwIfAborted()
    const handle = this.ctx.subprocess.spawn({ argv, cwd, env, signal, graceMs: 200, stdio: { stdin: { data: input }, stdout: 'pipe', stderr: 'pipe' } })
    this.handles.add(handle)
    let failure: string | undefined
    const chunks: Buffer[] = []
    const collect = (stream: Readable | undefined, limit: number, retain: boolean): void => {
      if (!stream) { failure = 'WORKER_STDIO_UNAVAILABLE'; handle.terminate(); return }
      let total = 0
      stream.on('data', (chunk: Buffer | string) => {
        const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
        total += bytes.byteLength
        if (total > limit) { failure = 'WORKER_OUTPUT_LIMIT'; handle.terminate(); return }
        if (retain && !failure) chunks.push(bytes)
      })
      stream.on('error', () => { failure = 'WORKER_STDIO_FAILED'; handle.terminate() })
    }
    collect(handle.stdout, this.outputLimit, true)
    collect(handle.stderr, Math.min(this.outputLimit, 16_384), false)
    try {
      const outcome = await handle.done
      // Success of the leader is not whole-tree success. Always terminate any
      // survivors before waiting, including when the leader exits with zero.
      handle.terminate()
      if (!await handle.waitForExit(AbortSignal.timeout(5000))) throw new Error('WORKER_TREE_NOT_QUIESCENT')
      if (failure) throw new Error(failure)
      signal.throwIfAborted()
      if (outcome.signal !== null) throw new Error('WORKER_EXECUTION_FAILED')
      const text = new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks))
      let result: unknown
      try { result = JSON.parse(text) } catch { throw new Error('WORKER_PROTOCOL_INVALID') }
      if (outcome.exitCode !== 0 && !(isRecord(result) && result.status === 'failed')) throw new Error('WORKER_EXECUTION_FAILED')
      return result
    } finally {
      handle.terminate()
      if (!await handle.waitForExit(AbortSignal.timeout(5000))) {
        // Keep it registered for dispose retry; never claim successful cleanup.
        throw new Error('WORKER_TREE_NOT_QUIESCENT')
      }
      this.handles.delete(handle)
    }
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function validateResponse(result: MirobodyResponse, operation: MirobodyOperation, operationId: string): void {
  if (!isRecord(result) || result.schemaVersion !== 1 || result.operation !== operation || result.operationId !== operationId
      || result.bundleVersion !== MIROBODY_BUNDLE_VERSION || !STATES.has(result.status) || !Array.isArray(result.warnings)
      || result.warnings.some(w => typeof w !== 'string') || typeof result.truncated !== 'boolean') throw new Error('WORKER_PROTOCOL_INVALID')
  if (result.status === 'failed') return
  if (operation === 'status' && (!isRecord(result.runtime) || result.runtime.mirobodyVersion !== MIROBODY_VERSION
      || typeof result.runtime.pythonVersion !== 'string' || !result.runtime.pythonVersion.startsWith('3.12.')
      || result.runtime.network !== 'blocked' || result.runtime.isolation !== 'unverified'
      || !Array.isArray(result.runtime.supportedOperations)
      || JSON.stringify(result.runtime.supportedOperations) !== JSON.stringify([...OPERATIONS]))) throw new Error('WORKER_PROTOCOL_INVALID')
  if ((operation === 'resolve' || operation === 'normalize_readings') && (!Array.isArray(result.readings) || !result.readings.length
      || result.readings.some(r => !isRecord(r) || typeof r.rawName !== 'string' || typeof r.rawValue !== 'string' || typeof r.rawUnit !== 'string'
        || typeof r.normalizedValue !== 'string' || typeof r.normalizedUnit !== 'string' || typeof r.code !== 'string' || typeof r.canonical !== 'string'
        || !['ready', 'unresolved', 'refused'].includes(r.status) || !['', 'lexical', 'refused'].includes(r.resolutionMethod)
        || r.bundleVersion !== MIROBODY_BUNDLE_VERSION || !Number.isSafeInteger(r.candidates) || r.candidates < 0
        || !Array.isArray(r.evidenceRefs) || r.evidenceRefs.some(ref => typeof ref !== 'string')
        || !Array.isArray(r.warnings) || r.warnings.some(w => typeof w !== 'string')
        || (r.status === 'ready' && (r.codeSystem !== 'loinc' || !/^[0-9]+-[0-9]$/.test(r.code)))
      ))) throw new Error('WORKER_PROTOCOL_INVALID')
  if (operation === 'metric_info' && !(result.metric === null || isRecord(result.metric))) throw new Error('WORKER_PROTOCOL_INVALID')
  if (operation === 'extract_document' && (!Array.isArray(result.segments) || !/^[a-f0-9]{64}$/.test(result.sourceDigest ?? '')
      || result.segments.some(s => !isRecord(s) || typeof s.id !== 'string' || typeof s.text !== 'string' || !isRecord(s.location)
        || sha256(s.text) !== s.digest || !['ready', 'needs_ocr', 'failed'].includes(s.status)))) throw new Error('WORKER_PROTOCOL_INVALID')
}

function safeErrorCode(error: unknown): string {
  const message = error instanceof Error ? error.message : ''
  if (/^[A-Z][A-Z0-9_]{2,80}$/.test(message)) return message
  if (isRecord(error) && error.code === 'ENOENT') return 'RUNTIME_NOT_PREPARED'
  return 'WORKER_UNAVAILABLE'
}
