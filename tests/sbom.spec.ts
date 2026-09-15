import { describe, expect, it } from 'vitest'
import { createConsumerSbom, createPythonLockInventory } from '../scripts/sbom.mjs'

describe('honest supply-chain inventories', () => {
  it('records the actual nested package graph, artifact hashes and unknown licenses', () => {
    const sbom = createConsumerSbom({ packages: {
      '': { name: 'test', version: '1.0.0' },
      'node_modules/memosbox-dsh-plugin': { version: '0.2.0-beta.1', dependencies: { example: '1.0.0' } },
      'node_modules/example': { version: '1.0.0', license: 'MIT', dependencies: { nested: '2.0.0' } },
      'node_modules/example/node_modules/nested': { version: '2.0.0' },
    } }, { name: 'memosbox-dsh-plugin', version: '0.2.0-beta.1' }, 'a'.repeat(64), '2026-09-09T00:00:00.000Z')
    expect(sbom.components).toHaveLength(3)
    expect(sbom.dependencies.find(item => item.ref.includes('example@1.0.0'))!.dependsOn[0]).toContain('nested@2.0.0')
    expect(sbom.components.find(item => item.name === 'nested')!.licenses[0].license.name).toBe('UNKNOWN')
  })
  it('does not turn a Python lock or a declared license into a scan/clearance claim', () => {
    const inventory = createPythonLockInventory({ platform: 'darwin', arch: 'arm64', python: '3.12', packages: [{ name: 'example', version: '1.0', sha256: 'abc' }] })
    expect(inventory.vulnerabilityScan).toMatchObject({ performed: false, status: 'NOT_RUN' })
    expect(inventory.packages[0].licenseStatus).toBe('unknown')
  })
})
