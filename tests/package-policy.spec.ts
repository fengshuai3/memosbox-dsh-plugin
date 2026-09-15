import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { assertPackageFiles, assertPackageManifest, REQUIRED_PACKAGE_FILES } from '../scripts/package-tools.mjs'

const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))

describe('release artifact policy', () => {
  it('pins the verified prerelease host and ships an explicit offline-runtime provisioner', () => {
    expect(() => assertPackageManifest(manifest)).not.toThrow()
    expect(() => assertPackageFiles(REQUIRED_PACKAGE_FILES)).not.toThrow()
  })
  it('rejects an alpha or misleading prerelease range', () => {
    for (const version of ['0.1.5-alpha.1', '>=0.1.0-rc.5 <0.2.0']) {
      expect(() => assertPackageManifest({ ...manifest, peerDependencies: {
        ...manifest.peerDependencies, '@deepseek-ai/dsh-agent': version,
      } })).toThrow(/verified host/)
    }
  })
  it('rejects missing worker/lock files and accidental local data', () => {
    expect(() => assertPackageFiles(REQUIRED_PACKAGE_FILES.filter(file => !file.startsWith('python/')))).toThrow(/missing python/)
    for (const extra of ['.runtime/venv/bin/python', 'docs/.env.local', 'reports/private.md', 'python/__pycache__/worker.pyc', 'docs/key.pem']) {
      expect(() => assertPackageFiles([...REQUIRED_PACKAGE_FILES, extra])).toThrow(/Unexpected/)
    }
  })
  it('does not provision automatically while npm installs a plugin', () => {
    expect(() => assertPackageManifest({ ...manifest, scripts: { ...manifest.scripts, postinstall: 'node scripts/provision-runtime.mjs' } })).toThrow(/explicit/)
  })
})
