#!/usr/bin/env node
/** Explicit developer preparation only. No dependency install is invoked by plugin load/query. */
import { createHash, randomUUID } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { constants } from 'node:fs'
import { access, lstat, mkdir, readFile, realpath, rename, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const args = process.argv.slice(2)
const value = (name, fallback) => { const i = args.indexOf(name); return i < 0 ? fallback : args[i + 1] }
const python = value('--python', undefined)
const runtimeRoot = resolve(value('--runtime-root', join(packageRoot, '.runtime')))
const online = args.includes('--download')
const lockPath = join(packageRoot, 'runtime-locks', 'darwin-arm64-cp312.json')
const digest = data => createHash('sha256').update(data).digest('hex')
const fail = code => { throw new Error(code) }

if (!python || !isAbsolute(python)) fail('Provide --python /absolute/path/to/python3.12. System Python will not be modified.')
if (process.platform !== 'darwin' || process.arch !== 'arm64') fail('UNSUPPORTED_PLATFORM: only macOS arm64 CPython 3.12 has a reviewed lock')
if (runtimeRoot === '/' || runtimeRoot === packageRoot || runtimeRoot === process.env.HOME) fail('UNSAFE_RUNTIME_ROOT')
const lockBytes = await readFile(lockPath)
const lock = JSON.parse(lockBytes)
const lockDigest = digest(lockBytes)
const allowedEnv = { PATH: '/usr/bin:/bin', LANG: 'en_US.UTF-8', LC_ALL: 'en_US.UTF-8', PIP_CONFIG_FILE: '/dev/null', PIP_DISABLE_PIP_VERSION_CHECK: '1', PIP_NO_CACHE_DIR: '1', PYTHONDONTWRITEBYTECODE: '1' }
function run(argv, { capture = false } = {}) {
  const r = spawnSync(argv[0], argv.slice(1), { cwd: runtimeRoot, env: allowedEnv, encoding: 'utf8', stdio: capture ? 'pipe' : 'inherit', timeout: 180_000, maxBuffer: 2 * 1024 * 1024 })
  if (r.error || r.status !== 0) fail('RUNTIME_PREPARATION_SUBPROCESS_FAILED')
  return r.stdout
}
await mkdir(runtimeRoot, { recursive: true, mode: 0o700 })
const rootStat = await lstat(runtimeRoot)
if (!rootStat.isDirectory() || rootStat.isSymbolicLink() || await realpath(runtimeRoot) !== runtimeRoot) fail('RUNTIME_ROOT_MUST_BE_CANONICAL_NO_SYMLINK')
// Never chmod an existing user/shared directory as a preparation side effect.
if ((rootStat.mode & 0o077) !== 0) fail('RUNTIME_ROOT_MUST_ALREADY_BE_PRIVATE')
const executable = await realpath(python)
await access(executable, constants.X_OK)
const info = JSON.parse(run([executable, '-I', '-B', '-c', 'import json,sys,platform;print(json.dumps({"version":platform.python_version(),"implementation":platform.python_implementation(),"basePrefix":sys.base_prefix,"arch":platform.machine(),"osVersion":platform.mac_ver()[0]}))'], { capture: true }))
if (!info.version.startsWith('3.12.') || info.implementation !== 'CPython' || info.arch !== 'arm64' || Number(info.osVersion.split('.')[0]) < lock.minimumMacOS) fail('WRONG_PYTHON_ABI_OR_OS')
const wheelhouse = join(runtimeRoot, 'wheelhouse', lockDigest)
await mkdir(wheelhouse, { recursive: true, mode: 0o700 })
if (await realpath(wheelhouse) !== wheelhouse) fail('WHEELHOUSE_SYMLINK')
for (const pkg of lock.packages) {
  if (!/^[a-zA-Z0-9_.-]+\.whl$/.test(pkg.filename) || new URL(pkg.url).hostname !== 'files.pythonhosted.org') fail('INVALID_LOCK_ARTIFACT')
  const target = join(wheelhouse, pkg.filename)
  let bytes
  try { if (!(await lstat(target)).isFile()) fail('INVALID_WHEEL'); bytes = await readFile(target) } catch (error) {
    if (error.code !== 'ENOENT') throw error
    if (!online) fail(`OFFLINE_WHEEL_MISSING:${pkg.filename}; explicit --download is required to populate the locked wheelhouse`)
    const response = await fetch(pkg.url, { signal: AbortSignal.timeout(120_000), redirect: 'error' })
    if (!response.ok) fail('WHEEL_DOWNLOAD_FAILED')
    if (!response.body) fail('WHEEL_DOWNLOAD_FAILED')
    const chunks = []
    let received = 0
    for await (const chunk of response.body) {
      received += chunk.byteLength
      if (received > pkg.size) { await response.body.cancel().catch(() => undefined); fail('WHEEL_SIZE_LIMIT') }
      chunks.push(Buffer.from(chunk))
    }
    bytes = Buffer.concat(chunks)
    if (bytes.length !== pkg.size || digest(bytes) !== pkg.sha256) fail('WHEEL_HASH_MISMATCH')
    await writeFile(target, bytes, { flag: 'wx', mode: 0o600 })
  }
  if (bytes.length !== pkg.size || digest(bytes) !== pkg.sha256) fail('WHEEL_HASH_MISMATCH')
  console.log(`Verified ${pkg.name} ${pkg.version} ${pkg.sha256}`)
}
const requirements = lock.packages.map(p => `${p.name}==${p.version} --hash=sha256:${p.sha256}`).join('\n') + '\n'
const requirementsPath = join(wheelhouse, 'requirements.txt')
try { await writeFile(requirementsPath, requirements, { mode: 0o600, flag: 'wx' }) } catch (error) {
  if (error.code !== 'EEXIST' || !(await lstat(requirementsPath)).isFile() || await readFile(requirementsPath, 'utf8') !== requirements) fail('LOCK_REQUIREMENTS_CHANGED')
}
// Build at the final versioned path. A failed build is not activated or silently reused.
if (!/^\d+\.\d+\.\d+$/.test(lock.mirobodyVersion)) fail('INVALID_RUNTIME_VERSION')
const generation = `mirobody-${lock.mirobodyVersion}-${lockDigest.slice(0, 16)}-${randomUUID()}`
const venv = join(runtimeRoot, 'runtimes', generation, '.venv')
await mkdir(dirname(venv), { recursive: true, mode: 0o700 })
// Do not run the external interpreter's potentially outdated ensurepip. The
// only installer executed below comes from the independently hash-verified
// locked wheel, loaded with stdlib zipimport/runpy into the empty venv.
run([executable, '-I', '-B', '-m', 'venv', '--without-pip', venv])
const venvPython = join(venv, 'bin', 'python3.12')
const installer = lock.packages.find(pkg => pkg.name === 'pip' && pkg.role === 'provisioning-installer')
if (!installer || installer.version !== '26.2.1') fail('LOCKED_PIP_INSTALLER_REQUIRED')
const bootstrap = 'import runpy,sys;sys.path.insert(0,sys.argv.pop(1));runpy.run_module("pip",run_name="__main__")'
run([venvPython, '-I', '-B', '-c', bootstrap, join(wheelhouse, installer.filename), 'install', '--no-index', '--find-links', wheelhouse, '--require-hashes', '--only-binary=:all:', '--no-compile', '-r', requirementsPath])
run([venvPython, '-I', '-B', '-m', 'pip', 'check'])
const inspection = JSON.parse(run([venvPython, '-I', '-B', join(packageRoot, 'python', 'inspect_runtime.py')], { capture: true }))
if (inspection.mirobodyVersion !== lock.mirobodyVersion || inspection.bundleVersion !== lock.bundleVersion) fail('MIROBODY_RESOURCE_VERSION_MISMATCH')
const normalizeName = name => name.toLowerCase().replace(/[-_.]+/g, '-')
const installedVersions = new Map(inspection.installedDistributions.map(pkg => [normalizeName(pkg.name), pkg.version]))
if (lock.packages.some(pkg => installedVersions.get(normalizeName(pkg.name)) !== pkg.version) || installedVersions.size !== lock.packages.length) fail('INSTALLED_DISTRIBUTIONS_MISMATCH')
const manifest = { schemaVersion: 1, platform: process.platform, arch: process.arch, pythonVersion: info.version, pythonPath: venvPython, pythonExecutable: executable, pythonBasePrefix: info.basePrefix, lockDigest, generation, ...inspection, packages: lock.packages.map(({ name, version, filename, sha256, license, role }) => ({ name, version, filename, sha256, license, ...(role ? { role } : {}) })), createdAt: new Date().toISOString(), interpreterDelivery: 'external-checked-cpython-3.12-development-beta', installerBootstrap: { method: 'verified-pip-wheel-via-stdlib-runpy', ensurepipUsed: false, version: installer.version, wheelSha256: installer.sha256 } }
const manifestPath = join(runtimeRoot, `active-runtime.${randomUUID()}.tmp`)
await writeFile(manifestPath, JSON.stringify(manifest, null, 2) + '\n', { flag: 'wx', mode: 0o600 })
await rename(manifestPath, join(runtimeRoot, 'active-runtime.json'))
console.log(`Prepared ${generation}; manifest: ${join(runtimeRoot, 'active-runtime.json')}`)
