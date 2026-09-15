import { lstat } from 'node:fs/promises'
import { join, relative, resolve, sep } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import lockfile from 'proper-lockfile'
import { WikiFileStore } from '../wiki/file-store.js'

/** Private jobs reuse the bounded, no-follow descriptor checks used by Wiki.
 * boundaryRoot is operator configuration; all scope directories below it are
 * untrusted interior components, not fresh independently trusted roots.
 */
export class JobStore {
  readonly root: string
  private readonly storage: WikiFileStore
  private readonly prefix: string
  private identity: { dev: number; ino: number } | undefined
  constructor(root: string, maxBytes = 4 * 1024 * 1024, boundaryRoot = root) {
    this.root = resolve(root)
    const boundary = resolve(boundaryRoot)
    const rel = relative(boundary, this.root)
    if (rel === '..' || rel.startsWith(`..${sep}`)) throw new Error('UNSAFE_STORAGE_ROOT')
    this.prefix = rel.split(sep).filter(Boolean).join('/')
    this.storage = new WikiFileStore(boundary, maxBytes)
  }
  private name(name: string): string {
    if (!/^[a-z0-9][a-z0-9./-]*$/.test(name) || name.split('/').some(p => !p || p === '.' || p === '..')) throw new Error('INVALID_STORAGE_ID')
    return this.prefix ? `${this.prefix}/${name}` : name
  }
  private async initialize(): Promise<void> {
    try {
      const existing = await lstat(this.root).catch(error => { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error })
      if (existing && (!existing.isDirectory() || existing.isSymbolicLink())) throw new Error('UNSAFE_STORAGE_ROOT')
      await this.storage.initialize(true)
      if (this.prefix) await this.storage.ensureDirectory(this.prefix)
      const info = await lstat(join(await this.storage.rootPath(), this.prefix))
      if (this.identity && (info.dev !== this.identity.dev || info.ino !== this.identity.ino)) throw new Error('UNSAFE_STORAGE_ROOT')
      this.identity ??= { dev: info.dev, ino: info.ino }
    } catch { throw new Error('UNSAFE_STORAGE_ROOT') }
  }
  async path(name: string): Promise<string> {
    const full = this.name(name)
    await this.initialize()
    const parent = full.split('/').slice(0, -1).join('/')
    try { if (parent) await this.storage.ensureDirectory(parent) }
    catch { throw new Error('UNSAFE_STORAGE_PARENT') }
    return join(await this.storage.rootPath(), full)
  }
  async read<T>(name: string): Promise<T | null> {
    await this.path(name)
    try {
      const text = await this.storage.read(this.name(name))
      return text === null ? null : JSON.parse(text) as T
    } catch { throw new Error('UNSAFE_STORAGE_FILE') }
  }
  async write(name: string, value: unknown): Promise<void> {
    await this.path(name)
    try { await this.storage.write(this.name(name), JSON.stringify(value)) }
    catch { throw new Error('UNSAFE_STORAGE_WRITE') }
  }
  async withLock<T>(action: (assertOwned: () => void) => Promise<T>, signal?: AbortSignal): Promise<T> {
    signal?.throwIfAborted()
    await this.path('lock-anchor')
    const until = Date.now() + 10_000
    let release: (() => Promise<void>) | undefined
    let compromised: Error | undefined
    const assertOwned = () => { if (compromised) throw new Error('JOB_LOCK_COMPROMISED') }
    while (!release) {
      signal?.throwIfAborted()
      try { release = await lockfile.lock(this.root, { realpath: true, retries: 0, stale: 30_000, update: 5_000, onCompromised(error) { compromised = error } }) }
      catch (e) {
        if ((e as NodeJS.ErrnoException).code !== 'ELOCKED' || Date.now() >= until) throw new Error('JOB_BUSY')
        await delay(40, undefined, signal ? { signal } : {})
      }
    }
    try { signal?.throwIfAborted(); assertOwned(); return await action(assertOwned) }
    // Cleanup failure must not erase an already known durable outcome. Lease
    // compromise is checked between commit steps; abandoned locks expire.
    finally { await release().catch(() => undefined) }
  }
}
