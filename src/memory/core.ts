import { lstat, mkdir, realpath } from 'node:fs/promises'
import { join, sep } from 'node:path'
import {
  createPipeline, createMemoryCore, DEFAULT_CONFIG,
  openDb, runMigrations, makeRepos,
  type Logger, type ResolvedConfig, type ResolvedHome,
} from '../../vendor/memos-core/index.js'
import type { MemoryCore } from '../../vendor/memos-core/index.js'
import type { SessionScope } from '../privacy/scope.js'
import { metadataOnlyApiLog } from '../privacy/policy.js'

const noop = () => undefined
const quietLogger: Logger = {
  channel: 'memosbox.memory', child: () => quietLogger,
  trace: noop, debug: noop, info: noop, warn: noop, error: noop, fatal: noop,
  audit: noop, llm: noop, forward: noop,
  timer: () => ({ end: noop, [Symbol.dispose]: noop }),
  flush: async () => undefined, close: async () => undefined,
}

/** Public MemOS pipeline composition; no direct SQL or global env/logger mutation.
 * Deliberately lexical/local-only: no model download, global host bridge or Hub.
 * Each profile+workspace gets its own database because upstream visibility does
 * not enforce workspace ownership within one profile.
 */
export async function openScopedMemory(root: string, scope: SessionScope, queryLogEnabled = false): Promise<MemoryCore> {
  const home: ResolvedHome = {
    root, configFile: join(root, 'config.yaml'), dataDir: join(root, 'data'),
    dbFile: join(root, 'data', 'memos.db'), skillsDir: join(root, 'skills'),
    logsDir: join(root, 'logs'), daemonDir: join(root, 'daemon'),
  }
  await mkdir(root, { recursive: true, mode: 0o700 })
  if ((await lstat(root)).isSymbolicLink()) throw new Error('MEMORY_ROOT_SYMLINK')
  const canonicalRoot = await realpath(root)
  for (const path of [home.dataDir, home.skillsDir, home.logsDir, home.daemonDir]) {
    await mkdir(path, { recursive: true, mode: 0o700 })
    const info = await lstat(path)
    if (!info.isDirectory() || info.isSymbolicLink() || !(await realpath(path)).startsWith(canonicalRoot + sep)) throw new Error('MEMORY_DIRECTORY_UNSAFE')
  }
  // SQLite creates/opens these companions internally. Refuse pre-existing
  // links/non-files before handing paths to the native driver. This is not
  // an openat sandbox against a hostile concurrent writer under the same UID.
  for (const path of [home.dbFile, `${home.dbFile}-wal`, `${home.dbFile}-shm`, `${home.dbFile}-journal`]) {
    try {
      const info = await lstat(path)
      if (!info.isFile() || info.isSymbolicLink()) throw new Error('MEMORY_DATABASE_UNSAFE')
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
  }
  const config = structuredClone(DEFAULT_CONFIG) as ResolvedConfig
  config.llm = { ...config.llm, provider: 'local_only', fallbackToHost: false, apiKey: '' }
  config.hub = { ...config.hub, enabled: false }
  config.telemetry = { enabled: false }
  config.algorithm.lightweightMemory.enabled = true
  config.algorithm.retrieval.llmFilterEnabled = false
  const db = openDb({ filepath: home.dbFile, agent: 'deepseek-harness' })
  try {
    runMigrations(db)
    const baseRepos = makeRepos(db)
    const repos = {
      ...baseRepos,
      apiLogs: {
        ...baseRepos.apiLogs,
        insert: (row: Parameters<typeof baseRepos.apiLogs.insert>[0]) => baseRepos.apiLogs.insert(queryLogEnabled ? row : metadataOnlyApiLog(row)),
      },
    }
    const pipeline = createPipeline({
      agent: 'deepseek-harness', home, config, db, repos, llm: null,
      reflectLlm: null, l3Llm: null, embedder: null, log: quietLogger,
      namespace: { agentKind: 'deepseek-harness', profileId: scope.key, workspaceId: scope.workspaceId },
    })
    const core = createMemoryCore(pipeline, home, '2.0.19', {
      autoRecovery: false, telemetry: null, onShutdown: () => db.close(),
    })
    await core.init()
    return core
  } catch (error) {
    db.close()
    throw error
  }
}
