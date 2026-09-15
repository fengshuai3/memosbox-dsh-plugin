/** Inventory metadata is evidence, not a license grant or vulnerability attestation. */
const npmPurl = (name, version) => `pkg:npm/${name.split('/').map(encodeURIComponent).join('/')}@${encodeURIComponent(version)}`
const inferName = path => path.split('node_modules/').at(-1)
const licenseDeclaration = value => value ? [{ license: { name: value } }] : [{ license: { name: 'UNKNOWN' } }]

export function createConsumerSbom(lock, manifest, artifactSha256, timestamp, vendoredProvenance) {
  const entries = Object.entries(lock.packages ?? {}).filter(([path, metadata]) => path && metadata.version)
  const references = new Map(entries.map(([path, metadata]) => [path, `${npmPurl(metadata.name ?? inferName(path), metadata.version)}#${encodeURIComponent(path)}`]))
  const locate = (consumer, name) => {
    let cursor = consumer
    while (true) {
      const candidate = `${cursor ? cursor + '/' : ''}node_modules/${name}`
      if (references.has(candidate)) return references.get(candidate)
      if (!cursor) return undefined
      const parent = cursor.lastIndexOf('/node_modules/')
      cursor = parent < 0 ? '' : cursor.slice(0, parent)
    }
  }
  const components = entries.map(([path, metadata]) => {
    const name = metadata.name ?? inferName(path)
    const integrity = /^sha(256|384|512)-([A-Za-z0-9+/=]+)$/.exec(metadata.integrity ?? '')
    return {
      type: 'library', 'bom-ref': references.get(path), name, version: metadata.version,
      purl: npmPurl(name, metadata.version), licenses: licenseDeclaration(metadata.license),
      ...(integrity ? { hashes: [{ alg: `SHA-${integrity[1]}`, content: Buffer.from(integrity[2], 'base64').toString('hex') }] } : {}),
      ...(metadata.resolved?.startsWith('https://') ? { externalReferences: [{ type: 'distribution', url: metadata.resolved }] } : {}),
      properties: [{ name: 'memosbox:license-evidence', value: metadata.license ? 'npm package-lock metadata declaration; not independently cleared' : 'unknown; metadata missing' }],
    }
  })
  const rootRef = npmPurl(manifest.name, manifest.version)
  const installedPlugin = entries.find(([, metadata]) => metadata.name === manifest.name)
    ?? entries.find(([path]) => inferName(path) === manifest.name)
  const rootDependencies = installedPlugin ? [references.get(installedPlugin[0])] : []
  const vendorRef = 'memosbox:vendored-selected-memos-core:2.0.19'
  if (vendoredProvenance) {
    components.push({
      type: 'library', 'bom-ref': vendorRef, name: 'memosbox-selected-memos-core', version: vendoredProvenance.version,
      hashes: [{ alg: 'SHA-256', content: vendoredProvenance.files['index.js'] }],
      licenses: [{ license: { name: 'UNRESOLVED: upstream npm MIT declaration; repository-root Apache-2.0' } }],
      externalReferences: [{ type: 'distribution', url: vendoredProvenance.tarball }, { type: 'vcs', url: `https://github.com/MemTensor/MemOS/tree/${vendoredProvenance.repositoryCommit}/apps/memos-local-plugin` }],
      properties: [{ name: 'memosbox:derivation', value: 'Unmodified original algorithms, selected exports tree-shaken by pinned esbuild; full upstream package is not installed in this consumer' },
        { name: 'memosbox:upstream-tarball-sha256', value: vendoredProvenance.tarballSha256 },
        { name: 'memosbox:license-status', value: 'upstream-clarification-required' }],
    })
    rootDependencies.push(vendorRef)
  }
  return {
    bomFormat: 'CycloneDX', specVersion: '1.6', version: 1,
    metadata: { timestamp, component: { type: 'library', 'bom-ref': rootRef, name: manifest.name, version: manifest.version, hashes: [{ alg: 'SHA-256', content: artifactSha256 }] },
      properties: [{ name: 'memosbox:scope', value: 'Actual fresh npm --omit=dev consumer package-lock plus selected vendored code; host-provided DSH peers are not installed in this snapshot' },
        { name: 'memosbox:required-host-peers', value: JSON.stringify(manifest.peerDependencies ?? {}) },
        { name: 'memosbox:vendored-source-license', value: 'MemOS npm MIT declaration conflicts with repository-root Apache-2.0; upstream clarification pending' }] },
    components,
    dependencies: [{ ref: rootRef, dependsOn: rootDependencies }, ...entries.map(([path, metadata]) => ({
      ref: references.get(path), dependsOn: [...new Set(Object.keys({ ...metadata.dependencies, ...metadata.optionalDependencies }).map(name => locate(path, name)).filter(Boolean))].sort(),
    })), ...(vendoredProvenance ? [{ ref: vendorRef, dependsOn: ['better-sqlite3', '@sinclair/typebox', 'uuid', 'yaml'].map(name => locate(installedPlugin?.[0] ?? '', name)).filter(Boolean).sort() }] : [])],
  }
}

export function createPythonLockInventory(lock) {
  return {
    schemaVersion: 1, source: 'runtime-locks/darwin-arm64-cp312.json',
    scope: 'Locked wheel inventory for macOS arm64 CPython 3.12; not a scan of an installed Python environment',
    platform: lock.platform, arch: lock.arch, python: lock.python,
    interpreterDelivery: lock.runtimeDelivery, bundleVersion: lock.bundleVersion,
    packages: lock.packages.map(pkg => ({ name: pkg.name, version: pkg.version, filename: pkg.filename, sha256: pkg.sha256, sourceUrl: pkg.url,
      licenseDeclaration: pkg.license ?? 'UNKNOWN', licenseStatus: pkg.license ? 'declared-in-lock-not-independently-cleared' : 'unknown', purpose: pkg.purpose,
    })),
    terminologyLicenseStatus: 'Mirobody code license does not grant rights to all bundled terminology; see preserved runtime notices; unknown or restricted resources are not approved for redistribution',
    vulnerabilityScan: { performed: false, status: 'NOT_RUN', note: 'Wheel hashes/version inspection are not a vulnerability scan' },
  }
}
