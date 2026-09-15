import lockfile from 'proper-lockfile'
import { WikiFileStore } from './file-store.js'
import { sha256, WikiWriteJournal, type WikiWriteIntent } from './write-journal.js'
import type { WikiWriteResult } from './types.js'

/** Serialize writers, allow cancellation while waiting, and detect lost ownership between commits. */
export async function withWikiLock<T>(store: WikiFileStore, signal: AbortSignal | undefined, run: (assertOwned: () => void) => Promise<T>): Promise<T> {
  signal?.throwIfAborted()
  const root = await store.rootPath()
  let release: (() => Promise<void>) | undefined
  let compromised: Error | undefined
  const deadline = Date.now() + 5000
  while (release === undefined) {
    signal?.throwIfAborted()
    try {
      release = await lockfile.lock(root, {
        realpath: false, stale: 30_000, update: 10_000, retries: 0,
        onCompromised(error) { compromised = error },
      })
    } catch (error) {
      if (!(error instanceof Error && 'code' in error && error.code === 'ELOCKED') || Date.now() >= deadline) throw error
      await waitForLock(40, signal)
    }
  }
  const assertOwned = () => { if (compromised) throw compromised }
  try {
    signal?.throwIfAborted()
    assertOwned()
    return await run(assertOwned)
  } finally { await release() }
}

/** Finish a prepared write without overwriting an independently changed page. */
export async function recoverWikiWrite(options: {
  store: WikiFileStore
  journal: WikiWriteJournal
  intent: WikiWriteIntent
  assertOwned: () => void
  rebuildIndex: (date: string) => Promise<void>
  appendLog: (intent: WikiWriteIntent) => Promise<void>
}): Promise<WikiWriteResult> {
  const { store, journal, intent, assertOwned } = options
  try {
    assertOwned()
    const current = await store.read(intent.path)
    const currentVersion = current === null ? 'absent' : sha256(current)
    if (currentVersion !== intent.previousVersion && currentVersion !== intent.version) {
      return {
        ok: false, status: 409, state: 'conflict', recoveryRequired: true, operationId: intent.operationId,
        path: intent.path, wikiRelativePath: intent.path, version: intent.version,
        expectedVersion: intent.previousVersion, currentVersion,
        text: 'Wiki recovery found an independently changed page; no page was overwritten.',
        error: 'wiki recovery version conflict',
      }
    }
    if (currentVersion !== intent.version) {
      assertOwned()
      await store.write(intent.path, intent.text)
    }
    assertOwned()
    await options.rebuildIndex(intent.date)
    assertOwned()
    await options.appendLog(intent)
    assertOwned()
    await journal.complete(intent)
    return {
      ok: true, committed: true, state: 'committed', operationId: intent.operationId,
      path: intent.path, wikiRelativePath: intent.path, version: intent.version,
      text: `Wiki page ${intent.action === 'create' ? 'created' : 'updated'}: ${intent.path}`,
    }
  } catch (error) {
    // The synced intent remains available even when a page/index/log/receipt step fails.
    const observed = await store.read(intent.path).catch(() => undefined)
    const committed = observed === undefined ? undefined : observed !== null && sha256(observed) === intent.version
    return {
      ok: false, status: 503, state: 'recovery_required', recoveryRequired: true,
      ...(committed === undefined ? {} : { committed }),
      operationId: intent.operationId, path: intent.path, wikiRelativePath: intent.path, version: intent.version,
      text: 'Wiki write requires recovery; retry the same operationId after resolving the storage failure.',
      error: error instanceof Error ? error.name : 'WikiStorageError',
    }
  }
}

function waitForLock(milliseconds: number, signal: AbortSignal | undefined): Promise<void> {
  return new Promise((resolve, reject) => {
    const finish = () => { signal?.removeEventListener('abort', abort); resolve() }
    const timer = setTimeout(finish, milliseconds)
    const abort = () => { clearTimeout(timer); signal?.removeEventListener('abort', abort); reject(signal?.reason) }
    signal?.addEventListener('abort', abort, { once: true })
    if (signal?.aborted) abort()
  })
}
