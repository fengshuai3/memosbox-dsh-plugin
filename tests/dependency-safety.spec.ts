import { cpSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import {
  assertSafeMemOSRuntimeDependencies, assertVerifiedMemOSBundle,
  MEMOS_RUNTIME_DEPENDENCY_CHAINS, MINIMUM_SAFE_RUNTIME_DEPENDENCIES,
  resolvedMemOSRuntimeDependencies, resolvedMemOSRuntimeVersions,
} from '../src/dependency-safety.js'

const cleanups: string[] = []
afterEach(() => { for (const path of cleanups.splice(0)) rmSync(path, { recursive: true, force: true }) })
function temporaryRoot() { const root = mkdtempSync(join(tmpdir(), 'memosbox-dependency-gate-')); cleanups.push(root); return root }
function packageAt(consumer: string, name: string, version: string, hideManifest = false): string {
  const root = join(consumer, 'node_modules', name)
  mkdirSync(root, { recursive: true })
  writeFileSync(join(root, 'package.json'), JSON.stringify({ name, version, main: 'index.js', ...(hideManifest ? { exports: './index.js' } : {}) }))
  writeFileSync(join(root, 'index.js'), 'module.exports = {}\n')
  return root
}
function copiedBundle() {
  const root = temporaryRoot(), bundle = join(root, 'bundle')
  cpSync(fileURLToPath(new URL('../vendor/memos-core/', import.meta.url)), bundle, { recursive: true })
  return bundle
}

describe('selected MemOS runtime dependency gate', () => {
  it('accepts only the real audited selected-runtime closure', () => {
    expect(resolvedMemOSRuntimeVersions()).toEqual(MINIMUM_SAFE_RUNTIME_DEPENDENCIES)
    expect(() => assertSafeMemOSRuntimeDependencies()).not.toThrow()
    expect(Object.keys(resolvedMemOSRuntimeVersions())).not.toEqual(expect.arrayContaining(['adm-zip', 'sharp']))
  })

  it('preserves upstream UUID-v7 behavior after the uuid override', async () => {
    const manifest = createRequire(import.meta.url).resolve('@memtensor/memos-local-plugin/package.json')
    const helper = await import(pathToFileURL(join(dirname(manifest), 'dist/core/id.js')).href)
    const values = new Set(Array.from({ length: 128 }, () => helper.newUuid() as string))
    expect(values.size).toBe(128)
    for (const value of values) expect(value).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
  })

  it('does not let a safe hoisted ini conceal the real nested SQLite consumer', () => {
    const root = temporaryRoot(), pluginManifest = join(root, 'package.json')
    writeFileSync(pluginManifest, JSON.stringify({ name: 'consumer-fixture' }))
    const versions = { ...MINIMUM_SAFE_RUNTIME_DEPENDENCIES, ini: '1.3.0', uuid: '10.0.0' }
    for (const [name, chain] of Object.entries(MEMOS_RUNTIME_DEPENDENCY_CHAINS)) {
      packageAt(root, name, '99.0.0')
      let consumer = root
      for (const [index, dependency] of chain.entries()) consumer = packageAt(consumer, dependency,
        index === chain.length - 1 ? versions[name as keyof typeof versions] : (versions[dependency as keyof typeof versions] ?? '1.0.0'), true)
    }
    const resolutions = resolvedMemOSRuntimeDependencies(pluginManifest)
    expect(Object.fromEntries(Object.entries(resolutions).map(([name, entry]) => [name, entry.version]))).toEqual(versions)
    expect(resolutions.ini!.chain).toEqual(['memosbox-dsh-plugin/vendor/memos-core', 'better-sqlite3', 'prebuild-install', 'rc', 'ini'])
    expect(resolutions.ini!.manifest).toContain(join('prebuild-install', 'node_modules', 'rc', 'node_modules', 'ini'))
    expect(() => assertSafeMemOSRuntimeDependencies(versions)).toThrow(/ini=1\.3\.0.*uuid=10\.0\.0/)
  })

  it.each(['14.0.2-rc.0', '14.0.2garbage', '14.0.2.1', ''])('rejects non-stable or malformed uuid version %j', (uuid) => {
    expect(() => assertSafeMemOSRuntimeDependencies({ ...MINIMUM_SAFE_RUNTIME_DEPENDENCIES, uuid })).toThrow(/uuid=/)
  })

  it('rejects missing actual runtime dependencies', () => {
    expect(() => assertSafeMemOSRuntimeDependencies({ ini: '1.3.8' })).toThrow(/better-sqlite3=missing/)
  })

  it('detects tampered generated code', () => {
    const bundle = copiedBundle()
    writeFileSync(join(bundle, 'index.js'), readFileSync(join(bundle, 'index.js'), 'utf8') + '\n// unauthorized mutation\n')
    expect(() => assertVerifiedMemOSBundle(bundle)).toThrow(/integrity mismatch for index.js/)
  })

  it('detects missing SQL resources even if removed from the output inventory', () => {
    const bundle = copiedBundle(), file = join(bundle, 'provenance.json')
    const provenance = JSON.parse(readFileSync(file, 'utf8'))
    const migration = Object.keys(provenance.files).find(name => name.startsWith('migrations/'))!
    delete provenance.files[migration]
    rmSync(join(bundle, migration))
    writeFileSync(file, JSON.stringify(provenance))
    expect(() => assertVerifiedMemOSBundle(bundle)).toThrow(/incomplete official migration/)
  })

  it('rejects a fabricated upstream source and a reintroduced model/archive dependency', () => {
    const bundle = copiedBundle(), file = join(bundle, 'provenance.json')
    const original = JSON.parse(readFileSync(file, 'utf8'))
    writeFileSync(file, JSON.stringify({ ...original, sources: { ...original.sources, 'dist/unknown.js': 'abc' } }))
    expect(() => assertVerifiedMemOSBundle(bundle)).toThrow(/unapproved upstream source/)
    writeFileSync(file, JSON.stringify({ ...original, runtimeImports: [...original.runtimeImports, 'adm-zip'] }))
    expect(() => assertVerifiedMemOSBundle(bundle)).toThrow(/unapproved dynamic\/model dependency/)
  })
})
