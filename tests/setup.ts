import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { resolve, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll } from 'vitest'

// Every suite owns one bounded temporary directory, even if a test forgets its
// local finally. Never change HOME or erase another run's evidence.
const parent = fileURLToPath(new URL('../.test-runtime/vitest/', import.meta.url))
mkdirSync(parent, { recursive: true, mode: 0o700 })
const root = mkdtempSync(join(resolve(parent), 'suite-'))
const before = { TMPDIR: process.env.TMPDIR, TMP: process.env.TMP, TEMP: process.env.TEMP }
process.env.TMPDIR = root
process.env.TMP = root
process.env.TEMP = root
afterAll(() => {
  rmSync(root, { recursive: true, force: true })
  for (const [key, value] of Object.entries(before)) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
})
