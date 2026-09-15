import { createHash } from 'node:crypto'
import { constants } from 'node:fs'
import { access, lstat, readFile, realpath } from 'node:fs/promises'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

export const MIROBODY_VERSION = '1.4.2'
export const MIROBODY_CATALOG_VERSION = '1.4.0'
export const MIROBODY_BUNDLE_VERSION = 'loinc-2.82+2026.08.28-af2524b7a285'
// Independently hashed from the exact official, SHA-verified 1.4.2 wheel.
export const MIROBODY_BUNDLE_SHA256 = '2dcdb684d7687ff2e620a2729a9eb0dc0138da48f09caa83962680abe7d13bd0'
export const MIROBODY_CATALOG_SHA256 = '6c1a783fc0e22515953ab774665c9322cd0433562318155e6071706008336ad0'
export const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
export const defaultWorkerPath = join(packageRoot, 'python', 'memosbox_mirobody_worker.py')

export interface RuntimeManifest {
  schemaVersion: 1
  platform: 'darwin'
  arch: 'arm64'
  generation: string
  pythonVersion: string
  pythonPath: string
  pythonExecutable: string
  pythonBasePrefix: string
  lockDigest: string
  mirobodyVersion: string
  bundleVersion: string
  bundlePath: string
  bundleSha256: string
  deviceCatalogPath: string
  deviceCatalogSha256: string
}

export function sha256(bytes: Uint8Array | string): string {
  return createHash('sha256').update(bytes).digest('hex')
}

export function isWithin(root: string, target: string): boolean {
  const rel = relative(root, target)
  return rel === '' || (!isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..${sep}`))
}

/** Only a prepared, hash-matched local beta runtime; never search ambient PATH. */
export async function readRuntimeManifest(configuredRoot: string): Promise<RuntimeManifest> {
  if (process.platform !== 'darwin' || process.arch !== 'arm64') throw new Error('UNSUPPORTED_PLATFORM')
  const root = resolve(configuredRoot)
  if (await realpath(root) !== root) throw new Error('RUNTIME_ROOT_SYMLINK')
  const manifestPath = join(root, 'active-runtime.json')
  const manifestStat = await lstat(manifestPath)
  if (!manifestStat.isFile()) throw new Error('RUNTIME_MANIFEST_TYPE')
  if (manifestStat.size > 2 * 1024 * 1024) throw new Error('RUNTIME_MANIFEST_LIMIT')
  const bytes = await readFile(manifestPath)
  if (bytes.byteLength > 2 * 1024 * 1024) throw new Error('RUNTIME_MANIFEST_LIMIT')
  const data = JSON.parse(bytes.toString()) as RuntimeManifest
  const lockBytes = await readFile(join(packageRoot, 'runtime-locks', 'darwin-arm64-cp312.json'))
  if (data.schemaVersion !== 1 || data.platform !== 'darwin' || data.arch !== 'arm64'
      || data.mirobodyVersion !== MIROBODY_VERSION || data.bundleVersion !== MIROBODY_BUNDLE_VERSION
      || data.bundleSha256 !== MIROBODY_BUNDLE_SHA256 || data.deviceCatalogSha256 !== MIROBODY_CATALOG_SHA256
      || !data.pythonVersion?.startsWith('3.12.') || data.lockDigest !== sha256(lockBytes)
      || !data.generation.startsWith(`mirobody-${MIROBODY_VERSION}-`)
      || !/^mirobody-\d+\.\d+\.\d+-[a-f0-9]{16}-[a-f0-9-]{36}$/.test(data.generation)) throw new Error('RUNTIME_MANIFEST_MISMATCH')
  const generationRoot = join(root, 'runtimes', data.generation)
  if (data.pythonPath !== join(generationRoot, '.venv', 'bin', 'python3.12')) throw new Error('RUNTIME_PYTHON_PATH')
  if (await realpath(generationRoot) !== generationRoot || !isAbsolute(data.pythonBasePrefix)
      || !isWithin(await realpath(data.pythonBasePrefix), await realpath(data.pythonPath))
      || await realpath(data.pythonPath) !== data.pythonExecutable) throw new Error('RUNTIME_EXECUTABLE_MISMATCH')
  await access(data.pythonPath, constants.X_OK)
  for (const [path, hash, size] of [[data.bundlePath, data.bundleSha256, 24_914_996], [data.deviceCatalogPath, data.deviceCatalogSha256, 53_042]] as const) {
    if (!isWithin(generationRoot, path) || await realpath(path) !== path || !/^[a-f0-9]{64}$/.test(hash)
        || (await lstat(path)).size !== size
        || sha256(await readFile(path)) !== hash) throw new Error('RUNTIME_RESOURCE_INTEGRITY')
  }
  return data
}
