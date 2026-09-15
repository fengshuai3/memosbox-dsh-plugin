import { execFileSync } from 'node:child_process'
import { readFileSync, statSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

describe('deterministic selected MemOS build', () => {
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
