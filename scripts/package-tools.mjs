import { accessSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { spawnSync } from 'node:child_process'

/** Use npm's JS entry point, including Windows, without shell interpolation. */
export function runNpm(args, cwd, { allowFailure = false } = {}) {
  const nodeDirectory = dirname(process.execPath)
  const candidates = [
    process.env.npm_execpath?.endsWith('npm-cli.js') ? process.env.npm_execpath : undefined,
    join(nodeDirectory, 'node_modules', 'npm', 'bin', 'npm-cli.js'),
    join(nodeDirectory, '..', 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js'),
  ].filter(Boolean)
  const npmCli = candidates.find(candidate => { try { accessSync(candidate); return true } catch { return false } })
  if (!npmCli) throw new Error('Cannot locate npm-cli.js beside Node; install a supported official Node distribution')
  const result = spawnSync(process.execPath, [npmCli, ...args], {
    cwd, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024,
    env: { ...process.env, npm_config_update_notifier: 'false' },
  })
  if (result.error) throw result.error
  if (result.status !== 0 && !allowFailure) throw new Error(`npm ${args[0]} failed (${result.status}): ${result.stderr}\n${result.stdout}`)
  return result
}

export const REQUIRED_PACKAGE_FILES = Object.freeze([
  'package.json', 'dist/index.js', 'dist/index.d.ts', 'dist/dependency-safety.js',
  'cordis.patch.yml', 'LICENSE', 'NOTICE', 'README.md', 'SECURITY.md',
  'CONTRIBUTING.md', 'CHANGELOG.md', 'scripts/provision-runtime.mjs',
  'python/memosbox_mirobody_worker.py', 'python/inspect_runtime.py',
  'runtime-locks/darwin-arm64-cp312.json',
  'runtime-locks/memos-core-source.json', 'runtime-locks/memos-repository-LICENSE',
  'vendor/memos-core/index.js', 'vendor/memos-core/index.d.ts',
  'vendor/memos-core/provenance.json', 'vendor/memos-core/metafile.json',
  'vendor/memos-core/NOTICE', 'vendor/memos-core/REPOSITORY-LICENSE',
])

export function assertPackageManifest(manifest) {
  if (manifest.name !== 'memosbox-dsh-plugin' || !/^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-(?:alpha|beta|rc)\.(?:0|[1-9]\d*))?$/.test(manifest.version ?? '')) throw new Error('Unexpected package identity/version')
  if (manifest.dsh?.bundle?.patch !== './cordis.patch.yml') throw new Error('dsh.bundle.patch is missing')
  if (manifest.dependencies?.['@memtensor/memos-local-plugin'] || manifest.devDependencies?.['@memtensor/memos-local-plugin'] !== '2.0.19') {
    throw new Error('The full MemOS package must be build-only at exactly 2.0.19, never a runtime dependency')
  }
  for (const name of ['@huggingface/transformers', 'onnxruntime-node', 'adm-zip', 'sharp']) {
    if (manifest.dependencies?.[name] || manifest.optionalDependencies?.[name]) throw new Error(`Unused model/archive dependency in runtime manifest: ${name}`)
  }
  for (const name of ['agent', 'llm', 'session', 'system-prompt', 'timeout', 'tools', 'subprocess', 'sandbox', 'sandbox-policy', 'user-approval']) {
    const dependency = `@deepseek-ai/dsh-${name}`
    if (manifest.peerDependencies?.[dependency] !== '0.1.2-rc.1') throw new Error(`${dependency} must target verified host 0.1.2-rc.1, not an alpha/range`)
    if (manifest.devDependencies?.[dependency] !== '0.1.2-rc.1') throw new Error(`${dependency} test host differs from peer contract`)
  }
  if (manifest.scripts?.postinstall || manifest.scripts?.install || manifest.scripts?.preinstall) throw new Error('Runtime provisioning must be explicit, not an install lifecycle hook')
}

export function assertPackageFiles(paths) {
  const files = new Set(paths)
  for (const required of REQUIRED_PACKAGE_FILES) {
    if (!files.has(required)) throw new Error(`Package is missing ${required}`)
  }
  for (const path of paths) {
    if (/^(?:src|tests|reports|artifacts|node_modules|\.runtime|\.test-runtime|\.git|\.github)\//.test(path)
      || /(?:^|\/)(?:\.env(?:\..*)?|__pycache__|\.DS_Store)(?:\/|$)/.test(path)
      || /\.(?:pyc|tgz|whl|sqlite|db|log|pem|key)$/.test(path)) {
      throw new Error(`Unexpected development, private, or cache artifact in package: ${path}`)
    }
  }
}
