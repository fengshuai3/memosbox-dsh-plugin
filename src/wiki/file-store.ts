import { constants, type Stats } from 'node:fs'
import { link, lstat, mkdir, open, readdir, realpath, rename, rm } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'

/** A rejected durable-file operation; callers may treat missing/unreadable references as absent. */
export class WikiFileError extends Error {
  constructor(readonly reason: 'unsafe-path' | 'not-file' | 'too-large' | 'invalid-text' | 'already-exists', path: string) {
    super(`Wiki file ${reason}: ${path}`)
    this.name = 'WikiFileError'
  }
}

/** Bounded file access with a pinned root, no interior symlinks, and descriptor identity checks. */
export class WikiFileStore {
  readonly configuredRoot: string
  private rootState: Promise<{ path: string; info: Stats }> | undefined

  constructor(root: string, readonly maxBytes: number) {
    this.configuredRoot = resolve(root)
  }

  /** Create the explicitly configured root, then pin its canonical directory identity. */
  async initialize(create: boolean): Promise<void> {
    if (create) await mkdir(this.configuredRoot, { recursive: true, mode: 0o700 })
    await this.root()
  }

  /** Normalize a caller path to an unambiguous root-relative path. */
  normalize(value: string): string {
    const input = value.trim()
    if (!input || input.includes('\0') || input.length > 2048) throw new WikiFileError('unsafe-path', 'invalid input')
    let candidate = input
    if (isAbsolute(input)) {
      candidate = relative(this.configuredRoot, resolve(input))
    }
    candidate = candidate.replace(/\\/g, '/').replace(/^wiki\//, '')
    const parts = candidate.split('/')
    if (isAbsolute(candidate) || parts.some(part => !part || part === '.' || part === '..')) {
      throw new WikiFileError('unsafe-path', input)
    }
    return parts.join('/')
  }

  /** Return the pinned root used for cross-process locking. */
  async rootPath(): Promise<string> { return (await this.root()).path }

  /** Create each interior directory separately and reject symlink or non-directory components. */
  async ensureDirectory(value: string): Promise<void> {
    const path = this.normalize(value)
    const { path: root } = await this.root()
    let current = root
    for (const part of path.split('/')) {
      current = join(current, part)
      await mkdir(current, { mode: 0o700 }).catch(error => { if (!nodeError(error, 'EEXIST')) throw error })
      const info = await lstat(current)
      if (!info.isDirectory() || info.isSymbolicLink()) throw new WikiFileError('unsafe-path', path)
    }
    await this.checkedPath(path, false)
  }

  /** Read at most maxBytes + 1 bytes; oversize inputs are never loaded in full. */
  async read(value: string, maxBytes = this.maxBytes): Promise<string | null> {
    const bytes = await this.readBytes(value, maxBytes)
    if (bytes === null) return null
    try { return new TextDecoder('utf-8', { fatal: true }).decode(bytes) }
    catch { throw new WikiFileError('invalid-text', value) }
  }

  /** Read an authorized source as bytes, with the same descriptor and size checks as Markdown. */
  async readBytes(value: string, maxBytes = this.maxBytes): Promise<Buffer | null> {
    const normalized = this.normalize(value)
    const target = await this.checkedPath(normalized, true)
    if (target === null) return null
    let handle
    try {
      handle = await open(target, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0))
    } catch (error) {
      if (nodeError(error, 'ENOENT')) return null
      if (nodeError(error, 'ELOOP')) throw new WikiFileError('unsafe-path', normalized)
      throw error
    }
    try {
      const info = await handle.stat()
      if (!info.isFile()) throw new WikiFileError('not-file', normalized)
      if (info.size > maxBytes) throw new WikiFileError('too-large', normalized)
      const validated = await this.checkedPath(normalized, false)
      const current = await lstat(validated!)
      if (!sameFile(info, current)) throw new WikiFileError('unsafe-path', normalized)
      const parts: Buffer[] = []
      let size = 0
      while (size <= maxBytes) {
        const buffer = Buffer.alloc(Math.min(64 * 1024, maxBytes + 1 - size))
        const { bytesRead } = await handle.read(buffer, 0, buffer.length, null)
        if (bytesRead === 0) break
        parts.push(buffer.subarray(0, bytesRead))
        size += bytesRead
      }
      if (size > maxBytes) throw new WikiFileError('too-large', normalized)
      return Buffer.concat(parts)
    } finally { await handle.close() }
  }

  /** Check a reference's actual file type and size without reading its contents. */
  async info(value: string, maxBytes = this.maxBytes): Promise<Stats | null> {
    const path = this.normalize(value)
    const target = await this.checkedPath(path, true)
    if (target === null) return null
    const info = await lstat(target)
    if (!info.isFile()) throw new WikiFileError('not-file', path)
    if (info.size > maxBytes) throw new WikiFileError('too-large', path)
    return info
  }

  /** List direct regular files only, after validating the containing directory. */
  async files(value: string): Promise<string[]> {
    const normalized = this.normalize(value)
    const path = await this.checkedPath(normalized, true)
    if (path === null) return []
    const info = await lstat(path)
    if (!info.isDirectory()) throw new WikiFileError('unsafe-path', normalized)
    return (await readdir(path, { withFileTypes: true }))
      .filter(entry => entry.isFile()).map(entry => `${normalized}/${entry.name}`).sort()
  }

  /** Preserve an existing leaf; new files are exclusive, private and synced. */
  async writeIfAbsent(value: string, text: string): Promise<void> {
    const path = this.normalize(value)
    await this.parent(path)
    const target = join(await this.rootPath(), ...path.split('/'))
    let handle
    try { handle = await open(target, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | (constants.O_NOFOLLOW ?? 0), 0o600) }
    catch (error) { if (nodeError(error, 'EEXIST')) return; throw error }
    try { await handle.writeFile(text, 'utf8'); await handle.sync() }
    finally { await handle.close() }
    await syncDirectory(dirname(target))
  }

  /** Atomically replace one checked regular leaf and sync its parent directory. */
  async write(value: string, text: string, maxBytes = this.maxBytes): Promise<void> {
    const path = this.normalize(value)
    if (Buffer.byteLength(text, 'utf8') > maxBytes) throw new WikiFileError('too-large', path)
    await this.parent(path)
    const target = await this.checkedPath(path, true) ?? join(await this.rootPath(), ...path.split('/'))
    const existing = await lstat(target).catch(error => { if (nodeError(error, 'ENOENT')) return null; throw error })
    if (existing && !existing.isFile()) throw new WikiFileError('not-file', path)
    const temporary = join(dirname(target), `.memosbox-${process.pid}-${randomUUID()}.tmp`)
    try {
      const handle = await open(temporary, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | (constants.O_NOFOLLOW ?? 0), 0o600)
      try { await handle.writeFile(text, 'utf8'); await handle.sync() }
      finally { await handle.close() }
      await this.parent(path)
      await this.checkedPath(path, true)
      await rename(temporary, target)
      await syncDirectory(dirname(target))
    } finally { await rm(temporary, { force: true }).catch(() => undefined) }
  }

  /** Remove one checked internal file after its durable replacement has been synced. */
  async remove(value: string): Promise<void> {
    const path = this.normalize(value)
    const target = await this.checkedPath(path, true)
    if (target === null) return
    if (!(await lstat(target)).isFile()) throw new WikiFileError('not-file', path)
    await rm(target)
    await syncDirectory(dirname(target))
  }

  /** Publish a fully synced immutable source without ever replacing an existing leaf. */
  async writeExclusive(value: string, content: Buffer, maxBytes: number): Promise<boolean> {
    const path = this.normalize(value)
    if (content.length > maxBytes) throw new WikiFileError('too-large', path)
    await this.parent(path)
    const current = await this.readBytes(path, maxBytes)
    if (current !== null) {
      if (!current.equals(content)) throw new WikiFileError('already-exists', path)
      return false
    }
    const target = join(await this.rootPath(), ...path.split('/'))
    const temporary = join(dirname(target), `.memosbox-source-${randomUUID()}.tmp`)
    try {
      const handle = await open(temporary, 'wx', 0o600)
      try { await handle.writeFile(content); await handle.sync() } finally { await handle.close() }
      await this.parent(path)
      try { await link(temporary, target) }
      catch (error) {
        if (!nodeError(error, 'EEXIST')) throw error
        const existing = await this.readBytes(path, maxBytes)
        if (existing === null || !existing.equals(content)) throw new WikiFileError('already-exists', path)
        return false
      }
      await syncDirectory(dirname(target))
      return true
    } finally { await rm(temporary, { force: true }).catch(() => undefined) }
  }

  private async parent(path: string): Promise<void> {
    const parent = path.split('/').slice(0, -1).join('/')
    if (parent) await this.checkedPath(parent, false)
    else await this.root()
  }

  private async root(): Promise<{ path: string; info: Stats }> {
    this.rootState ??= realpath(this.configuredRoot).then(async path => ({ path, info: await lstat(path) }))
      .catch(error => { this.rootState = undefined; throw error })
    const root = await this.rootState
    const current = await lstat(root.path)
    if (!current.isDirectory() || current.isSymbolicLink() || !sameFile(current, root.info)) {
      throw new WikiFileError('unsafe-path', 'root identity changed')
    }
    return root
  }

  private async checkedPath(path: string, missingLeaf: boolean): Promise<string | null> {
    const { path: root } = await this.root()
    const parts = path.split('/')
    let target = root
    for (let index = 0; index < parts.length; index += 1) {
      target = join(target, parts[index]!)
      const info = await lstat(target).catch(error => {
        if (nodeError(error, 'ENOENT') && missingLeaf) return null
        throw error
      })
      if (info === null) return null
      if (info.isSymbolicLink() || (index < parts.length - 1 && !info.isDirectory())) throw new WikiFileError('unsafe-path', path)
    }
    const actual = await realpath(target)
    const rel = relative(root, actual)
    if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) throw new WikiFileError('unsafe-path', path)
    return target
  }
}

function sameFile(left: Stats, right: Stats): boolean { return left.dev === right.dev && left.ino === right.ino }
function nodeError(error: unknown, code: string): boolean { return error instanceof Error && 'code' in error && error.code === code }

async function syncDirectory(path: string): Promise<void> {
  let handle
  try { handle = await open(path, 'r') }
  catch (error) {
    if (process.platform === 'win32' && nodeError(error, 'EPERM')) return
    throw error
  }
  try {
    await handle.sync().catch(error => { if (!['EINVAL', 'EPERM', 'EISDIR'].some(code => nodeError(error, code))) throw error })
  } finally { await handle.close() }
}
