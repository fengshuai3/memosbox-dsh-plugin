import { createHash } from 'node:crypto'
import { lstatSync, readFileSync, realpathSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

export const MEMOS_SOURCE_TARBALL_SHA256 = '0c44905fe54a9b7d66a1d5a372b021f2654d2918f9ade1b6e95a69b176dacc2d'
export const MINIMUM_SAFE_RUNTIME_DEPENDENCIES = Object.freeze({
  'better-sqlite3': '12.11.1', '@sinclair/typebox': '0.34.52',
  ini: '1.3.8', uuid: '14.0.2', yaml: '2.9.0',
})

// Only the selected vendored runtime is shipped. Resolve each dependency from
// its real consumer, including the SQLite install helper's nested ini copy.
export const MEMOS_RUNTIME_DEPENDENCY_CHAINS = Object.freeze({
  'better-sqlite3': ['better-sqlite3'], '@sinclair/typebox': ['@sinclair/typebox'],
  ini: ['better-sqlite3', 'prebuild-install', 'rc', 'ini'], uuid: ['uuid'], yaml: ['yaml'],
} as const)

export interface RuntimeDependencyResolution {
  version: string
  manifest: string
  chain: readonly string[]
}

export function resolvedMemOSRuntimeDependencies(
  pluginManifest: string | URL = import.meta.url,
): Record<string, RuntimeDependencyResolution> {
  return Object.fromEntries(Object.entries(MEMOS_RUNTIME_DEPENDENCY_CHAINS).map(([name, chain]) => {
    let manifest: string | URL = pluginManifest
    for (const dependency of chain) manifest = resolvedPackageManifest(createRequire(manifest), dependency)
    const metadata = JSON.parse(readFileSync(manifest, 'utf8')) as { version?: unknown }
    if (typeof metadata.version !== 'string') throw new Error(`memosbox-native: missing version for ${name}`)
    return [name, { version: metadata.version, manifest: String(manifest), chain: ['memosbox-dsh-plugin/vendor/memos-core', ...chain] }]
  }))
}

export function resolvedMemOSRuntimeVersions(pluginManifest: string | URL = import.meta.url): Record<string, string> {
  return Object.fromEntries(Object.entries(resolvedMemOSRuntimeDependencies(pluginManifest))
    .map(([name, dependency]) => [name, dependency.version]))
}

/** Hash-check generated code/types/SQL and the exact official-source inventory. */
export function assertVerifiedMemOSBundle(
  bundleDirectory = fileURLToPath(new URL('../vendor/memos-core/', import.meta.url)),
  sourceLockPath = fileURLToPath(new URL('../runtime-locks/memos-core-source.json', import.meta.url)),
): void {
  const source = JSON.parse(readFileSync(sourceLockPath, 'utf8')) as { tarballSha256?: string; files?: Record<string, string> }
  const provenance = JSON.parse(readFileSync(join(bundleDirectory, 'provenance.json'), 'utf8')) as {
    version?: string; tarballSha256?: string; runtimeImports?: string[];
    sources?: Record<string, string>; files?: Record<string, string>;
  }
  if (source.tarballSha256 !== MEMOS_SOURCE_TARBALL_SHA256 || provenance.tarballSha256 !== MEMOS_SOURCE_TARBALL_SHA256
    || provenance.version !== '2.0.19' || !provenance.sources || !provenance.files || !provenance.files['index.js']) {
    throw new Error('memosbox-native: unapproved selected MemOS bundle provenance')
  }
  for (const [path, hash] of Object.entries(provenance.sources)) {
    if (!source.files?.[path] || source.files[path] !== hash) throw new Error(`memosbox-native: unapproved upstream source ${path}`)
  }
  const allowedImports = new Set(['better-sqlite3', 'uuid', 'yaml', '@sinclair/typebox', '@sinclair/typebox/value', '@deepseek-ai/dsh-llm', '@deepseek-ai/dsh-timeout'])
  if (!provenance.runtimeImports?.length || provenance.runtimeImports.some(name => !name.startsWith('node:') && !allowedImports.has(name))) {
    throw new Error('memosbox-native: unapproved dynamic/model dependency in selected MemOS bundle')
  }
  const root = realpathSync(bundleDirectory)
  for (const [path, hash] of Object.entries(provenance.files)) {
    if (path.includes('\\') || path.split('/').some(part => !part || part === '.' || part === '..')) throw new Error('memosbox-native: unsafe bundle path')
    const file = join(root, path)
    if (lstatSync(file).isSymbolicLink() || !lstatSync(file).isFile() || !realpathSync(file).startsWith(root + sep)) throw new Error('memosbox-native: bundle resource escaped package')
    if (createHash('sha256').update(readFileSync(file)).digest('hex') !== hash) throw new Error(`memosbox-native: bundle integrity mismatch for ${path}`)
  }
  const migrations = Object.keys(source.files ?? {}).filter(path => path.startsWith('dist/core/storage/migrations/') && path.endsWith('.sql'))
  if (!migrations.length || migrations.some(path => provenance.files?.[path.replace('dist/core/storage/', '')] !== source.files?.[path])) {
    throw new Error('memosbox-native: incomplete official migration resources')
  }
  if (/transformers|onnxruntime|adm-zip|\bsharp\b/.test(readFileSync(resolve(root, 'index.js'), 'utf8'))) {
    throw new Error('memosbox-native: unapproved model/archive closure present in selected runtime')
  }
}

/** This does not approve the full upstream package: it approves only our checked bundle. */
export function assertSafeMemOSRuntimeDependencies(
  versions: Readonly<Record<string, string>> = resolvedMemOSRuntimeVersions(),
): void {
  assertVerifiedMemOSBundle()
  const unsafe = Object.entries(MINIMUM_SAFE_RUNTIME_DEPENDENCIES)
    .filter(([name, minimum]) => !atLeast(versions[name] ?? '', minimum))
    .map(([name, minimum]) => `${name}=${versions[name] ?? 'missing'} (need stable >=${minimum})`)
  if (unsafe.length) throw new Error(`memosbox-native: refusing unsafe selected MemOS dependency closure: ${unsafe.join(', ')}`)
}

function resolvedPackageManifest(requireFromConsumer: NodeJS.Require, packageName: string): string {
  try {
    const manifest = realpathSync(requireFromConsumer.resolve(`${packageName}/package.json`))
    const metadata = JSON.parse(readFileSync(manifest, 'utf8')) as { name?: unknown }
    if (metadata.name === packageName) return manifest
  } catch { /* Some packages hide their manifest behind exports. */ }
  let directory = dirname(realpathSync(requireFromConsumer.resolve(packageName)))
  while (true) {
    const manifest = join(directory, 'package.json')
    try {
      const metadata = JSON.parse(readFileSync(manifest, 'utf8')) as { name?: unknown }
      if (metadata.name === packageName) return manifest
    } catch { /* Keep walking from the resolved entry to its owning manifest. */ }
    const parent = dirname(directory)
    if (parent === directory) throw new Error(`memosbox-native: cannot locate package manifest for ${packageName}`)
    directory = parent
  }
}

function atLeast(actual: string, minimum: string): boolean {
  const parse = (value: string) => /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:\+[0-9A-Za-z.-]+)?$/.exec(value)?.slice(1).map(Number)
  const left = parse(actual), right = parse(minimum)
  if (!left || !right) return false
  for (let index = 0; index < 3; index++) {
    if (left[index]! > right[index]!) return true
    if (left[index]! < right[index]!) return false
  }
  return true
}
