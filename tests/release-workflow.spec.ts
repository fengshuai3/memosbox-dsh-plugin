import { describe, it, expect } from 'vitest'
import { parse } from 'yaml'
import { readFileSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
// @ts-expect-error Plain JS release tooling.
import { checkRelease, REQUIRED_EVIDENCE } from '../scripts/release-check.mjs'

describe('release workflow and end-to-end gates', () => {
  it('defaults to verification and separates the privileged publication job', () => {
    const workflow = parse(readFileSync(new URL('../.github/workflows/release.yml', import.meta.url), 'utf8'))
    expect(workflow.on.workflow_dispatch.inputs.publish.default).toBe(false)
    expect(workflow.permissions).toEqual({ contents: 'read' })
    expect(workflow.jobs.candidate.permissions).toBeUndefined()
    expect(workflow.jobs.publish.environment).toBe('release')
    expect(workflow.jobs.publish.needs).toBe('candidate')
    expect(workflow.jobs.publish.if).toContain("outputs.approved == 'true'")
    expect(workflow.jobs.publish.if).toContain('inputs.publish')
    expect(workflow.jobs.publish.if).toContain('refs/tags/v')
    const commands = workflow.jobs.publish.steps.map((step: { run?: string }) => step.run ?? '').join('\n')
    expect(commands).toContain('sha256sum --check')
    expect(commands).toContain('release-check.mjs --artifact')
    expect(commands.indexOf('release-check.mjs')).toBeLessThan(commands.indexOf('npm publish'))
    expect(commands).toContain('--tag beta')
    expect(commands).not.toContain('npm pack')
    if (process.platform !== 'win32') {
      for (const job of Object.values(workflow.jobs) as Array<{ steps: Array<{ run?: string }> }>) {
        for (const step of job.steps) {
          if (step.run) expect(spawnSync('bash', ['-n', '-c', step.run], { encoding: 'utf8' }).status).toBe(0)
        }
      }
    }
  })
  it('accepts a fully bound fixture and rejects tampering, wrong tags and dirty source', () => {
    const root = mkdtempSync(join(tmpdir(), 'memosbox-release-gate-'))
    const hash = (data: string) => createHash('sha256').update(data).digest('hex')
    const put = (path: string, value: unknown) => writeFileSync(join(root, path), JSON.stringify(value, null, 2))
    const git = (...args: string[]) => {
      const result = spawnSync('git', args, { cwd: root, encoding: 'utf8' })
      expect(result.status, result.stderr).toBe(0)
    }
    try {
      mkdirSync(join(root, 'release/evidence'), { recursive: true })
      mkdirSync(join(root, 'artifacts'))
      writeFileSync(join(root, '.gitignore'), 'artifacts/\n')
      writeFileSync(join(root, 'artifacts/candidate.tgz'), 'fixture artifact, not a real package')
      const artifactHash = hash('fixture artifact, not a real package')
      put('package.json', { version: '9.9.9-beta.1', author: { name: 'Fixture only', email: 'fixture@invalid.test' }, repository: { url: 'https://invalid.test/repo' }, bugs: { url: 'https://invalid.test/issues' } })
      const evidence: Record<string, unknown> = {}
      for (const kind of REQUIRED_EVIDENCE) {
        const receipt = { schemaVersion: 1, kind, version: '9.9.9-beta.1', artifactSha256: artifactHash, verifiedAt: '2026-09-15T00:00:00Z', passed: true, scope: 'Synthetic release-validator fixture; never real approval', humanPerformed: true, uiTested: true, reviewer: 'Fixture', legalClearance: true, rightsReviewer: 'Fixture', officialSources: ['https://invalid.test/license'], checks: { fixture: true } }
        const path = `release/evidence/${kind}.json`
        put(path, receipt)
        evidence[kind] = { path, passed: true, sha256: hash(readFileSync(join(root, path), 'utf8')) }
      }
      put('release/approval.json', { schemaVersion: 1, version: '9.9.9-beta.1', publicationReady: true, artifactSha256: artifactHash, reviewer: 'Fixture only', evidence })
      git('init', '-q'); git('config', 'user.name', 'Release gate fixture'); git('config', 'user.email', 'fixture@invalid.test')
      git('add', '.'); git('-c', 'commit.gpgSign=false', 'commit', '-qm', 'Synthetic validator fixture'); git('-c', 'tag.gpgSign=false', 'tag', 'v9.9.9-beta.1')
      expect(checkRelease(root, 'artifacts/candidate.tgz')).toEqual([])
      writeFileSync(join(root, 'artifacts/candidate.tgz'), 'tampered')
      expect(checkRelease(root, 'artifacts/candidate.tgz')).toContain('Exact candidate SHA-256 approval required')
      writeFileSync(join(root, 'artifacts/candidate.tgz'), 'fixture artifact, not a real package')
      writeFileSync(join(root, 'release/evidence/security.json'), '{}')
      expect(checkRelease(root, 'artifacts/candidate.tgz')).toContain('Invalid evidence integrity: security')
      expect(checkRelease(root, 'artifacts/candidate.tgz')).toContain('Clean, reviewed source tree required')
      git('tag', '-d', 'v9.9.9-beta.1')
      expect(checkRelease(root, 'artifacts/candidate.tgz')).toContain('Release tag must resolve to HEAD')
    } finally { rmSync(root, { recursive: true, force: true }) }
  }, 30_000)
})
