import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { lstat, mkdtemp, mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve, sep } from 'node:path'
import { pathToFileURL } from 'node:url'
import { assertPackageFiles, assertPackageManifest, runNpm } from './package-tools.mjs'
import { createConsumerSbom, createPythonLockInventory } from './sbom.mjs'

// A real tarball + fresh npm consumer deliberately has no source pnpm overrides.
// No install scripts are run: this verifies the published dependency closure.
// Native execution is a separate acceptance test, not implied by this check.
const root = resolve(import.meta.dirname, '..')
const args = process.argv.slice(2)
if (args.length && (args.length !== 2 || args[0] !== '--output-dir')) throw new Error('Usage: verify-consumer.mjs [--output-dir artifacts/0.2.0-beta.1]')
const outputDirectory = args.length ? resolve(root, args[1]) : undefined
if (outputDirectory && !outputDirectory.startsWith(join(root, 'artifacts') + sep)) throw new Error('Consumer evidence must remain under this project artifacts directory')
const temporaryRoot = await mkdtemp(join(tmpdir(), 'memosbox-consumer-'))
try {
  // Never certify stale checked-out dist merely because its files still exist.
  runNpm(['run', 'build'], root)
  runNpm(['run', 'verify:package'], root)
  const [artifact] = JSON.parse(runNpm(['pack', '--ignore-scripts', '--json', '--pack-destination', temporaryRoot], root).stdout)
  assertPackageFiles(artifact.files.map(file => file.path))
  const tarball = join(temporaryRoot, artifact.filename)
  const sha256 = createHash('sha256').update(await readFile(tarball)).digest('hex')
  const consumer = join(temporaryRoot, 'consumer')
  await mkdir(consumer)
  await writeFile(join(consumer, 'package.json'), JSON.stringify({ name: 'memosbox-clean-consumer-check', private: true, version: '1.0.0' }))
  runNpm(['install', tarball, '--registry=https://registry.npmjs.org', '--ignore-scripts', '--omit=dev', '--no-audit', '--no-fund', '--package-lock=true'], consumer)
  const installed = join(consumer, 'node_modules', 'memosbox-dsh-plugin')
  assertPackageManifest(JSON.parse(await readFile(join(installed, 'package.json'), 'utf8')))
  for (const file of artifact.files) {
    const actual = await readFile(join(installed, file.path))
    const source = await readFile(join(root, file.path))
    assert.deepEqual(actual, source, `Installed artifact differs from source: ${file.path}`)
  }
  const safety = await import(pathToFileURL(join(installed, 'dist', 'dependency-safety.js')).href)
  const versions = safety.resolvedMemOSRuntimeVersions()
  safety.assertSafeMemOSRuntimeDependencies()
  const lock = JSON.parse(await readFile(join(consumer, 'package-lock.json'), 'utf8'))
  const forbidden = /(?:^|\/)node_modules\/(?:@memtensor\/memos-local-plugin|@huggingface\/transformers|onnxruntime-node|adm-zip|sharp)$/
  for (const dependency of Object.keys(lock.packages)) assert.ok(!forbidden.test(dependency), `Forbidden runtime closure: ${dependency}`)
  const auditResult = runNpm(['audit', '--registry=https://registry.npmjs.org', '--omit=dev', '--json'], consumer, { allowFailure: true })
  const audit = JSON.parse(auditResult.stdout)
  if (!audit.metadata?.vulnerabilities) throw new Error('npm audit did not return a valid audit result')
  assert.equal(audit.metadata.vulnerabilities.total, 0, 'Clean-consumer production audit must have zero advisories')
  const report = {
    verifiedAt: new Date().toISOString(),
    artifact: artifact.filename, sha256, filesVerified: artifact.files.length,
    consumerVersions: versions, audit: audit.metadata.vulnerabilities,
    memoryStatus: 'approved-selected-runtime-closure',
    nativeExecutionVerified: false, publicReleaseApproved: false,
    licenseStatus: 'upstream-MIT-metadata-versus-repository-Apache-2.0-needs-clarification',
    note: 'Artifact equality, source provenance, safe consumer resolution and zero production advisories verified. Native execution and license clearance are separate gates.',
  }
  if (outputDirectory) {
    // Preserve prior candidates: each exact artifact gets its own hash directory.
    await mkdir(outputDirectory, { recursive: true })
    if ((await lstat(outputDirectory)).isSymbolicLink() || await realpath(outputDirectory) !== outputDirectory) throw new Error('Evidence destination must be canonical, without symlinks')
    const snapshot = join(outputDirectory, sha256)
    await mkdir(snapshot, { recursive: true })
    if ((await lstat(snapshot)).isSymbolicLink()) throw new Error('Evidence snapshot must not be a symlink')
    const artifactPath = join(snapshot, artifact.filename)
    const bytes = await readFile(tarball)
    try { await writeFile(artifactPath, bytes, { flag: 'wx' }) } catch (error) {
      if (error.code !== 'EEXIST') throw error
      assert.deepEqual(await readFile(artifactPath), bytes, 'Existing candidate archive must not be overwritten')
    }
    const stamp = report.verifiedAt.replaceAll(/[^0-9]/g, '')
    await writeFile(join(snapshot, `${stamp}-consumer-verification.json`), JSON.stringify(report, null, 2) + '\n', { flag: 'wx' })
    const installedManifest = JSON.parse(await readFile(join(installed, 'package.json'), 'utf8'))
    const vendoredProvenance = JSON.parse(await readFile(join(installed, 'vendor/memos-core/provenance.json'), 'utf8'))
    await writeFile(join(snapshot, `${stamp}-node-production.cdx.json`), JSON.stringify(createConsumerSbom(lock, installedManifest, sha256, report.verifiedAt, vendoredProvenance), null, 2) + '\n', { flag: 'wx' })
    const pythonLock = JSON.parse(await readFile(join(installed, 'runtime-locks/darwin-arm64-cp312.json'), 'utf8'))
    await writeFile(join(snapshot, `${stamp}-python-lock-inventory.json`), JSON.stringify(createPythonLockInventory(pythonLock), null, 2) + '\n', { flag: 'wx' })
    try { await writeFile(join(snapshot, 'SHA256SUMS'), `${sha256}  ${artifact.filename}\n`, { flag: 'wx' }) } catch (error) { if (error.code !== 'EEXIST') throw error }
    process.stdout.write(`Saved candidate and verification evidence: ${snapshot}\n`)
  }
  process.stdout.write(JSON.stringify(report, null, 2) + '\n')
} finally {
  await rm(temporaryRoot, { recursive: true, force: true })
}
