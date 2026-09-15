import { describe, expect, it } from 'vitest'
// @ts-expect-error Build tooling is intentionally plain JavaScript.
import { REQUIRED_EVIDENCE, validateApproval, validateEvidence } from '../scripts/release-check.mjs'
// @ts-expect-error Build tooling is intentionally plain JavaScript.
import { sourceFileProblems } from '../scripts/source-release-check.mjs'
// @ts-expect-error Build tooling is intentionally plain JavaScript.
import { assertPackageManifest } from '../scripts/package-tools.mjs'
import { readFileSync } from 'node:fs'

describe('publication gates', () => {
  const hash = 'a'.repeat(64)
  const manifest = { version: '2.3.4', author: { name: 'Test Reviewer', email: 'test@invalid.test' }, repository: { url: 'https://invalid.test/source' }, bugs: { url: 'https://invalid.test/issues' } }
  const approval = () => ({ schemaVersion: 1, version: manifest.version, publicationReady: true, artifactSha256: hash, reviewer: 'Test Reviewer', evidence: Object.fromEntries(REQUIRED_EVIDENCE.map((key: string) => [key, { passed: true, path: `release/evidence/${key}.md`, sha256: hash }])) })
  it('rejects an unpublished candidate and absent maintainer', () => {
    expect(validateApproval({ version: '2.3.4' }, { publicationReady: false }, undefined).length).toBeGreaterThan(6)
  })
  it('requires all evidence and the exact artifact', () => {
    expect(validateApproval(manifest, approval(), hash)).toEqual([])
    expect(validateApproval(manifest, approval(), 'b'.repeat(64))).toContain('Exact candidate SHA-256 approval required')
    const incomplete = approval(); incomplete.evidence.humanApproval.passed = false
    expect(validateApproval(manifest, incomplete, hash)).toContain('Missing approved evidence: humanApproval')
  })
  it('binds evidence contents to the candidate and rejects fabricated clearance', () => {
    const receipt = { schemaVersion: 1, kind: 'security', version: manifest.version, artifactSha256: hash, passed: true, verifiedAt: '2026-09-15T00:00:00Z', scope: 'Fixture only', checks: { checked: true } }
    expect(validateEvidence('security', receipt, manifest, hash)).toEqual([])
    expect(validateEvidence('security', { ...receipt, artifactSha256: 'b'.repeat(64) }, manifest, hash)).toContain('Evidence candidate mismatch: security')
    expect(validateEvidence('security', { ...receipt, kind: 'realDialogue' }, manifest, hash)).toContain('Evidence type/schema/version mismatch: security')
    expect(validateEvidence('security', { ...receipt, passed: false }, manifest, hash)).toContain('Evidence did not pass: security')
    expect(validateEvidence('security', { ...receipt, checks: { checked: false } }, manifest, hash)).toContain('All scoped evidence checks must pass: security')
    expect(validateEvidence('humanApproval', { ...receipt, kind: 'humanApproval', humanPerformed: false, uiTested: false }, manifest, hash)).toContain('Simulation cannot substitute for human UI acceptance')
    expect(validateEvidence('licenses', { ...receipt, kind: 'licenses', legalClearance: false, blockers: ['unresolved'] }, manifest, hash)).toContain('License clearance and named rights review required')
  })
  it('detects private files and user-specific paths without returning contents', () => {
    expect(sourceFileProblems('reports/test.json', '{}')).toContain('private/generated file')
    expect(sourceFileProblems('README.md', ['/', 'Users', '/', 'synthetic', '/', 'file'].join(''))).toContain('local user path')
    expect(sourceFileProblems('src/example.ts', 'export const n = 1')).toEqual([])
  })
  it('accepts later versions without a hard-coded beta version', () => {
    const original = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
    expect(() => assertPackageManifest({ ...original, version: '0.3.0-beta.1' })).not.toThrow()
    expect(() => assertPackageManifest({ ...original, version: '1.0.0' })).not.toThrow()
    expect(() => assertPackageManifest({ ...original, version: 'garbage' })).toThrow()
  })
})
