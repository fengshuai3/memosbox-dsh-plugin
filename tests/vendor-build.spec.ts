import { execFileSync } from 'node:child_process'
import { readFileSync, statSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

describe('deterministic selected MemOS build', () => {
  it('preserves locked bytes even when Git enables Windows CRLF conversion', () => {
    const root = fileURLToPath(new URL('../', import.meta.url))
    mkdirSync(join(root, '.test-runtime'), { recursive: true })
    const fixture = mkdtempSync(join(root, '.test-runtime', 'checkout-bytes-'))
    const git = (...args: string[]) => execFileSync('git', args, { cwd: fixture, encoding: 'utf8' })
    const files = ['.gitattributes', 'runtime-locks/memos-repository-LICENSE', 'vendor/memos-core/index.js', 'vendor/memos-core/provenance.json']
    try {
      mkdirSync(join(fixture, 'runtime-locks'), { recursive: true })
      mkdirSync(join(fixture, 'vendor/memos-core'), { recursive: true })
      for (const file of files) writeFileSync(join(fixture, file), readFileSync(join(root, file)))
      git('init', '-q')
      git('config', 'core.autocrlf', 'true')
      git('add', '--', ...files)
      git('checkout-index', '--all', '--prefix=checked-out/')
      for (const file of files) {
        expect(readFileSync(join(fixture, 'checked-out', file))).toEqual(readFileSync(join(root, file)))
      }
    } finally {
      rmSync(fixture, { recursive: true, force: true })
    }
  })
  it('reproduces all locked outputs without rewriting existing files', () => {
    const root = fileURLToPath(new URL('../', import.meta.url))
    const code = new URL('../vendor/memos-core/index.js', import.meta.url)
    const provenance = new URL('../vendor/memos-core/provenance.json', import.meta.url)
    const before = { code: readFileSync(code), provenance: readFileSync(provenance), mtime: statSync(code).mtimeMs }
    const output = execFileSync(process.execPath, ['scripts/build-memos-core.mjs', '--check'], { cwd: root, encoding: 'utf8', timeout: 15_000 })
    expect(output).toContain('Verified deterministic MemOS 2.0.19')
    expect(readFileSync(code)).toEqual(before.code)
    expect(readFileSync(provenance)).toEqual(before.provenance)
    expect(statSync(code).mtimeMs).toBe(before.mtime)
  })
})
