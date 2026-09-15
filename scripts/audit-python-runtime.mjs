#!/usr/bin/env node
/** Read-only public vulnerability metadata audit. No package installation or
 * runtime changes. Exit 1 = known advisory; 2 = incomplete query/inventory.
 * Empty vulnerability arrays are NOT a full runtime security attestation.
 */
import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const args = process.argv.slice(2)
const option = (name, fallback) => { const i = args.indexOf(name); return i < 0 ? fallback : args[i + 1] }
const runtimeRoot = resolve(option('--runtime-root', join(root, '.runtime')))
const output = resolve(option('--output', join(root, 'reports', 'PYTHON_DEPENDENCY_AUDIT_2026-09-09.json')))
const startedAt = new Date().toISOString()
const sha256 = value => createHash('sha256').update(value).digest('hex')
const canonical = name => name.toLowerCase().replace(/[-_.]+/g, '-')
const lockBytes = await readFile(join(root, 'runtime-locks', 'darwin-arm64-cp312.json'))
const lock = JSON.parse(lockBytes)
const manifest = JSON.parse(await readFile(join(runtimeRoot, 'active-runtime.json')))
const inventoryStartedAt = new Date().toISOString()
const inventoryProcess = spawnSync(manifest.pythonPath, ['-I', '-B', '-c', 'import importlib.metadata,json,platform;print(json.dumps({"pythonVersion":platform.python_version(),"distributions":[{"name":d.metadata["Name"],"version":d.version} for d in importlib.metadata.distributions()]}))'],
  { cwd: root, env: { PATH: '/usr/bin:/bin' }, encoding: 'utf8', timeout: 10_000, maxBuffer: 512 * 1024 })
const inventory = inventoryProcess.status === 0 ? JSON.parse(inventoryProcess.stdout) : null
const installed = new Map((inventory?.distributions ?? []).map(p => [canonical(p.name), p.version]))
const packages = lock.packages.map(p => ({ name: canonical(p.name), version: p.version, origin: p.role === 'provisioning-installer' ? 'locked-provisioning-installer' : 'locked-wheel', installedVersion: installed.get(canonical(p.name)) ?? null,
  artifact: { filename: p.filename, sha256: p.sha256, size: p.size, lockedUrl: p.url } }))
const bootstrapVersion = installed.get('pip')
if (bootstrapVersion && !packages.some(pkg => pkg.name === 'pip')) packages.push({ name: 'pip', version: bootstrapVersion, installedVersion: bootstrapVersion, origin: 'external-cpython-ensurepip-bootstrap-not-in-lock', artifact: null })

const requests = []
async function requestJson(url, body) {
  const record = { url, method: body === undefined ? 'GET' : 'POST', startedAt: new Date().toISOString(), ...(body === undefined ? {} : { publicRequestBody: body }), status: 'failed' }
  requests.push(record)
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(15_000), redirect: 'error', headers: { Accept: 'application/json', ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) }, ...(body === undefined ? {} : { body: JSON.stringify(body), method: 'POST' }) })
    record.httpStatus = response.status
    record.serverDate = response.headers.get('date')
    if (!response.ok || !response.body) throw new Error(`HTTP_${response.status}`)
    const chunks = []
    let bytes = 0
    for await (const chunk of response.body) {
      bytes += chunk.byteLength
      if (bytes > 16 * 1024 * 1024) throw new Error('RESPONSE_SIZE_LIMIT')
      chunks.push(Buffer.from(chunk))
    }
    const raw = Buffer.concat(chunks)
    record.responseBytes = raw.byteLength
    record.responseSha256 = sha256(raw)
    const data = JSON.parse(raw)
    record.status = 'success'
    return { record, data }
  } catch (error) {
    record.error = { name: error?.name ?? 'Error', code: error?.cause?.code ?? error?.code ?? null, message: /^(HTTP_\d+|RESPONSE_SIZE_LIMIT)$/.test(error?.message ?? '') ? error.message : 'Public endpoint request failed or timed out; no empty result is inferred.' }
    return { record, data: null }
  } finally { record.completedAt = new Date().toISOString() }
}

function schemaFailure(record, code) {
  record.status = 'failed'
  record.error = { name: 'SchemaError', code, message: 'Public response did not contain the expected documented fields.' }
}

const pypiTask = Promise.all(packages.map(async pkg => {
  const base = `https://pypi.org/pypi/${encodeURIComponent(pkg.name)}`
  const [release, latest] = await Promise.all([requestJson(`${base}/${encodeURIComponent(pkg.version)}/json`), requestJson(`${base}/json`)])
  if (release.data && (!Array.isArray(release.data.vulnerabilities) || release.data.info?.version !== pkg.version)) schemaFailure(release.record, 'INVALID_RELEASE_METADATA')
  if (latest.data && typeof latest.data.info?.version !== 'string') schemaFailure(latest.record, 'INVALID_LATEST_METADATA')
  const vulnerabilities = release.record.status === 'success' ? release.data.vulnerabilities.map(v => ({ id: v.id, aliases: v.aliases ?? [], link: v.link ?? null, summary: v.summary ?? null, fixedIn: v.fixed_in ?? [], withdrawn: v.withdrawn ?? null })) : null
  const official = release.data?.urls?.find(file => file.filename === pkg.artifact?.filename)
  pkg.pypi = {
    releaseQuery: release.record,
    latestQuery: latest.record,
    knownVulnerabilities: vulnerabilities,
    latestVersion: latest.record.status === 'success' ? latest.data.info.version : null,
    releaseRequiresPython: release.record.status === 'success' ? release.data.info.requires_python ?? null : null,
    isPypiLatest: latest.record.status === 'success' ? latest.data.info.version === pkg.version : null,
    releaseYanked: release.record.status === 'success' ? release.data.info.yanked === true : null,
    officialLockedArtifact: pkg.artifact ? (official ? { sha256: official.digests?.sha256, size: official.size, requiresPython: official.requires_python ?? null, yanked: official.yanked === true,
      matchesLock: official.digests?.sha256 === pkg.artifact.sha256 && official.size === pkg.artifact.size } : { status: 'not_found_or_query_failed' }) : null,
  }
}))

const osvTask = (async () => {
  let pending = packages.map((pkg, index) => ({ index, query: { package: { name: pkg.name, ecosystem: 'PyPI' }, version: pkg.version } }))
  for (const pkg of packages) pkg.osv = { status: 'not_queried', vulnerabilityIds: [], queryRecords: [], complete: false }
  for (let page = 0; pending.length && page < 10; page++) {
    const answer = await requestJson('https://api.osv.dev/v1/querybatch', { queries: pending.map(item => item.query) })
    if (answer.data && (!Array.isArray(answer.data.results) || answer.data.results.length !== pending.length)) schemaFailure(answer.record, 'INVALID_OSV_BATCH_RESULT')
    const next = []
    for (const [position, item] of pending.entries()) {
      const target = packages[item.index].osv
      target.queryRecords.push(answer.record)
      if (answer.record.status !== 'success') { target.status = 'failed'; continue }
      const result = answer.data.results[position]
      if (result === null || typeof result !== 'object' || (result.vulns !== undefined && (!Array.isArray(result.vulns) || result.vulns.some(v => typeof v?.id !== 'string')))) { target.status = 'failed'; target.schemaError = 'INVALID_OSV_PACKAGE_RESULT'; continue }
      target.vulnerabilityIds.push(...(result.vulns ?? []).map(v => v.id))
      if (result.next_page_token) {
        target.status = 'partial'
        next.push({ index: item.index, query: { ...item.query, page_token: result.next_page_token } })
      } else { target.status = 'success'; target.complete = true }
    }
    pending = next
  }
  for (const pkg of packages) pkg.osv.vulnerabilityIds = [...new Set(pkg.osv.vulnerabilityIds)].sort()
})()
await Promise.all([pypiTask, osvTask])
console.log('Version-specific PyPI queries and OSV batch attempt completed; fetching identified advisory records.')

const advisoryIds = [...new Set(packages.flatMap(pkg => [...pkg.osv.vulnerabilityIds, ...(pkg.pypi.knownVulnerabilities ?? []).map(v => v.id)]))].filter(id => typeof id === 'string').sort()
const advisories = await Promise.all(advisoryIds.map(async id => {
  const answer = await requestJson(`https://api.osv.dev/v1/vulns/${encodeURIComponent(id)}`)
  if (answer.data && answer.data.id !== id) schemaFailure(answer.record, 'ADVISORY_ID_MISMATCH')
  const v = answer.record.status === 'success' ? answer.data : null
  return { id, query: answer.record, packages: packages.filter(pkg => pkg.osv.vulnerabilityIds.includes(id) || pkg.pypi.knownVulnerabilities?.some(v => v.id === id)).map(pkg => `${pkg.name}@${pkg.version}`),
    record: v ? { id: v.id, aliases: v.aliases ?? [], summary: v.summary ?? null, published: v.published, modified: v.modified, withdrawn: v.withdrawn ?? null,
      severity: v.severity ?? [], affected: v.affected ?? [], references: v.references ?? [], databaseSpecific: v.database_specific ?? null } : null }
}))

const queryFailures = requests.filter(record => record.status !== 'success').length
const inventoryMismatches = packages.filter(pkg => pkg.artifact && pkg.version !== pkg.installedVersion).map(pkg => pkg.name)
const artifactMismatches = packages.filter(pkg => pkg.artifact && pkg.pypi.officialLockedArtifact?.matchesLock !== true).map(pkg => pkg.name)
const unauditedInstalledDistributions = (inventory?.distributions ?? []).filter(pkg => !packages.some(p => p.name === canonical(pkg.name)))
const packagesWithAdvisories = packages.filter(pkg => pkg.osv.vulnerabilityIds.length || pkg.pypi.knownVulnerabilities?.length).map(pkg => `${pkg.name}@${pkg.version}`)
const uniqueCveIds = [...new Set(advisories.flatMap(a => a.record?.aliases ?? []).filter(id => id.startsWith('CVE-')))].sort()
const coverageComplete = queryFailures === 0 && packages.every(pkg => pkg.osv.complete && pkg.pypi.knownVulnerabilities !== null) && inventory !== null && bootstrapVersion !== undefined && !inventoryMismatches.length && !artifactMismatches.length && !unauditedInstalledDistributions.length && manifest.lockDigest === sha256(lockBytes)
const previousPath = option('--previous-report', undefined)
const previousBytes = previousPath ? await readFile(resolve(previousPath)) : null
const report = {
  schemaVersion: 1, auditStartedAt: startedAt, auditCompletedAt: new Date().toISOString(),
  task: 'Read-only public advisory metadata audit of pinned application wheels and the actual provisioning pip; no installs or runtime changes by this audit script.',
  previousAudit: previousBytes ? { path: resolve(previousPath), sha256: sha256(previousBytes), auditCompletedAt: JSON.parse(previousBytes).auditCompletedAt } : null,
  methods: { pypi: 'Release-specific vulnerabilities field; project endpoint only supplies latest-version comparison.', osv: 'Version/package querybatch, bounded pagination, then advisory lookup by returned ID.',
    documentation: ['https://docs.pypi.org/api/json/', 'https://google.github.io/osv.dev/post-v1-querybatch/', 'https://google.github.io/osv.dev/get-v1-vulns/'], requestTimeoutMs: 15000 },
  inventory: { status: inventory ? 'success' : 'failed', queriedAt: inventoryStartedAt, method: 'Dedicated venv Python -I -B importlib.metadata; explicit minimal environment; does not import application/model libraries.',
    pythonVersion: inventory?.pythonVersion ?? null, runtimeGeneration: manifest.generation, manifestLockDigest: manifest.lockDigest, actualLockDigest: sha256(lockBytes),
    lockedVersionMismatches: inventoryMismatches, actualDistributions: inventory?.distributions ?? null, unauditedInstalledDistributions,
    installerBootstrap: manifest.installerBootstrap ?? { method: 'legacy-external-interpreter-ensurepip', ensurepipUsed: true } },
  packages, advisories,
  summary: { coverageComplete, requestCount: requests.length, failedRequestCount: queryFailures, packageCount: packages.length, lockedWheelCount: lock.packages.length,
    advisoryRecordCount: advisoryIds.length, uniqueCveIds, uniqueCveCount: uniqueCveIds.length, packagesWithAdvisories, officialArtifactMismatches: artifactMismatches,
    coverageScope: 'Only the explicitly listed package-version metadata queries, inventory comparison and locked artifact metadata; not complete runtime security coverage.',
    result: packagesWithAdvisories.length ? 'known_advisories_found' : coverageComplete ? 'no_known_advisories_in_queried_sources' : 'incomplete_not_a_clean_audit',
    aliasNote: 'Advisory record count is not a deduplicated CVE count; consult aliases to avoid counting the same issue twice.' },
  limitations: [
    'An empty PyPI or OSV response is only absence of listed package-version advisories at query time, not proof of system safety.',
    'PyPI and OSV may share advisory sources; they are not necessarily two independent security reviews. Reporting can lag upstream disclosures.',
    'Package-name/version queries do not inspect the installed wheel native binaries, embedded libraries, code signatures, exploitability or reachable application paths.',
    'CPython 3.12.13 itself, its stdlib/ensurepip bundle and native dependencies have NOT been comprehensively audited by this report.',
    'Installer pip is identified separately from business dependencies; inspect installerBootstrap for whether ensurepip was used. External-interpreter provenance and full offline runtime delivery remain unverified.',
    'NumPy BLAS, PDFium, Pillow image codecs and other vendored native components need separate binary/SBOM and upstream-advisory review.',
    'License compatibility, LOINC redistribution and third-party notices are NOT approved by vulnerability metadata checks.',
    'No advisory is automatically waived, no installed package is upgraded, and no runtime is modified by this script.',
    'Public requests contain only package names, versions and advisory identifiers; no credentials, clinical files or session contents are submitted.'
  ],
}
await mkdir(dirname(output), { recursive: true })
await writeFile(output, JSON.stringify(report, null, 2) + '\n')
console.log(JSON.stringify({ report: output, ...report.summary }, null, 2))
process.exitCode = coverageComplete ? (packagesWithAdvisories.length ? 1 : 0) : 2
