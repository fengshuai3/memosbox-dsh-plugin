/** Inventory and provenance checks, NOT a grant of legal permission. */
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFile, mkdir, writeFile, realpath } from 'node:fs/promises'
import { resolve, join } from 'node:path'
import { execFileSync } from 'node:child_process'
const root = resolve(import.meta.dirname, '..')
const flag = name => process.argv[process.argv.indexOf(name) + 1]
assert(process.argv.includes('--runtime') && process.argv.includes('--artifact'))
const runtime = await realpath(resolve(flag('--runtime')))
const artifact = await realpath(resolve(flag('--artifact')))
assert(runtime.startsWith(root + '/') && artifact.startsWith(root + '/'))
const manifest = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'))
const packedManifest = JSON.parse(execFileSync('tar', ['-xOf', artifact, 'package/package.json'], { encoding: 'utf8', maxBuffer: 1024 * 1024 }))
assert.equal(packedManifest.name, manifest.name, 'Unexpected candidate package')
assert.equal(packedManifest.version, manifest.version, 'Candidate version differs from source')
const hash = data => createHash('sha256').update(data).digest('hex')
const lockBytes = await readFile(join(root, 'runtime-locks/darwin-arm64-cp312.json'))
const lock = JSON.parse(lockBytes)
const wheelDir = join(runtime, 'wheelhouse', hash(lockBytes))
const wheels = []
for (const pkg of lock.packages) {
  const file = join(wheelDir, pkg.filename)
  assert.equal(hash(await readFile(file)), pkg.sha256, `${pkg.name} integrity mismatch`)
  // Zip metadata/content hashing only; never extract or execute wheel code.
  const inventory = JSON.parse(execFileSync('python3', ['-c', `import zipfile,json,sys,hashlib
with zipfile.ZipFile(sys.argv[1]) as z:
 names=z.namelist()
 notices=[{'path':n,'sha256':hashlib.sha256(z.read(n)).hexdigest()} for n in names if not n.endswith('/') and any(x in n.lower() for x in ['license','licence','notice','copying'])]
 metadata=[{'path':n,'sha256':hashlib.sha256(z.read(n)).hexdigest(),'licenseHeaders':[x for x in z.read(n).decode().splitlines() if x.startswith(('License:','License-Expression:','License-File:','Classifier: License'))]} for n in names if n.endswith('.dist-info/METADATA')]
 resources=[n for n in names if n.startswith('mirobody/res/') and not n.endswith('/')]
 print(json.dumps({'licenseFiles':notices,'metadata':metadata,'terminologyResources':resources}))`, file], { encoding: 'utf8' }))
  wheels.push({ name: pkg.name, version: pkg.version, sha256: pkg.sha256, ...inventory })
}
const commit = 'ec8b7d956ccf3fc29345fdb3d82b5f3817578d62'
const sources = [
  `https://raw.githubusercontent.com/MemTensor/MemOS/${commit}/LICENSE`,
  `https://raw.githubusercontent.com/MemTensor/MemOS/${commit}/apps/memos-local-plugin/package.json`,
  'https://raw.githubusercontent.com/thetahealth/mirobody/1.4.2/LICENSE-3RD-PARTY',
]
const fetched = []
for (const url of sources) {
  try {
    const text = execFileSync('curl', ['--fail', '--silent', '--show-error', '--location', '--max-time', '25', url], { encoding: 'utf8', maxBuffer: 2 * 1024 * 1024 })
    fetched.push({ url, sha256: hash(text), fetched: true,
      declaredLicense: url.endsWith('package.json') ? JSON.parse(text).license : undefined })
  } catch { fetched.push({ url, fetched: false, error: 'OFFICIAL_SOURCE_FETCH_FAILED' }) }
}
const report = { schemaVersion: 1, kind: 'licenses', version: packedManifest.version, verifiedAt: new Date().toISOString(), artifactSha256: hash(await readFile(artifact)), passed: false, legalClearance: false,
  scope: 'Exact plugin tarball plus separately provisioned wheels; interpreter and wheels are not included in the plugin tarball. File presence is not permission clearance.',
  blockers: ['MEMOS_MODULE_MIT_VS_ROOT_APACHE_REQUIRES_RIGHTSHOLDER_CLARIFICATION', 'TERMINOLOGY_LICENSE_CONDITIONS_AND_RECIPIENT_ENTITLEMENT_REVIEW_PENDING', ...wheels.filter(p => !p.licenseFiles.length).map(p => `NO_STANDALONE_LICENSE_IN_WHEEL:${p.name}`)],
  officialSources: fetched, additionalTerms: ['https://loinc.org/license/', 'https://www.nlm.nih.gov/research/umls/license.html', 'https://www.snomed.org/get-snomed'], wheels }
await mkdir(join(root, 'release/evidence'), { recursive: true })
const reportPath = join(root, 'release/evidence', `licenses-${report.version}-${report.verifiedAt.replaceAll(/[^0-9]/g, '')}.json`)
await writeFile(reportPath, JSON.stringify(report, null, 2) + '\n', { flag: 'wx' })
console.log(JSON.stringify({ report: reportPath, passed: false, artifactSha256: report.artifactSha256, wheelsVerified: wheels.length, licenseFiles: wheels.reduce((n, p) => n + p.licenseFiles.length, 0), blockers: report.blockers }))
