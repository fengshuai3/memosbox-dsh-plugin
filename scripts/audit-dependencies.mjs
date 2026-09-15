import { spawnSync } from 'node:child_process'
import { resolve } from 'node:path'

// Calling a bare `pnpm` in a lifecycle script can accidentally select an older
// global binary. Reuse and verify the exact package manager that started us.
const entry = process.env.npm_execpath
if (!entry || !process.env.npm_config_user_agent?.startsWith('pnpm/11.7.0 ')) {
  throw new Error('Use the pinned manager: corepack pnpm run audit:release (or audit:development)')
}
const cwd = resolve(import.meta.dirname, '..')
const version = spawnSync(process.execPath, [entry, '--version'], { cwd, encoding: 'utf8' })
if (version.error || version.status !== 0 || version.stdout.trim() !== '11.7.0') throw new Error('Refusing unverified pnpm audit binary')
const args = process.argv.slice(2)
if (args.length && !(args.length === 1 && args[0] === '--prod')) throw new Error('Unsupported audit scope')
const result = spawnSync(process.execPath, [entry, 'audit', ...args, '--registry=https://registry.npmjs.org', '--audit-level=moderate'], { cwd, stdio: 'inherit' })
if (result.error) throw result.error
process.exitCode = result.status ?? 1
