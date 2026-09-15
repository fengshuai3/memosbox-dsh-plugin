import { dirname, join } from 'node:path'
import type { RuntimeManifest } from './paths.js'

function quote(value: string): string {
  if (/[\x00-\x1f\x7f]/.test(value)) throw new Error('INVALID_SANDBOX_PATH')
  return JSON.stringify(value)
}

/** Additional read/network confinement, separate from DSH's file-write policy.
 * No filesystem writes, child process forks or network operations are allowed.
 * Exposed as a pure function for profile audits. Functional probe is mandatory.
 */
export function seatbeltArgv(runtime: RuntimeManifest, workerPath: string, jobDirectory: string, argv: readonly string[]): string[] {
  if (process.platform !== 'darwin' || process.arch !== 'arm64') throw new Error('UNSUPPORTED_PLATFORM')
  // Do not grant all of sys.base_prefix: an operator's Homebrew/system prefix
  // may contain unrelated content. Grant only the interpreter's library tree.
  const readableDirectories = [join(runtime.pythonBasePrefix, 'lib'), dirname(dirname(runtime.pythonPath)), jobDirectory, '/System/Library', '/usr/lib']
  const profile = [
    '(version 1)', '(deny default)',
    '(allow process-exec)', '(allow sysctl-read)', '(allow signal (target self))',
    '(allow file-read-metadata)',
    // dyld/CPython needs to inspect the root directory itself; literal is NOT
    // recursive and does not expose the contents of unrelated files.
    '(allow file-read* (literal "/"))',
    ...readableDirectories.map(path => `(allow file-read-data (subpath ${quote(path)}))`),
    `(allow file-read-data (literal ${quote(workerPath)}))`,
    `(allow file-read-data (literal ${quote(runtime.pythonExecutable)}))`,
    '(allow file-read-data (literal "/dev/null") (literal "/dev/urandom") (literal "/dev/random") (literal "/private/etc/localtime"))',
    '(allow file-write-data (literal "/dev/null"))',
    '(deny network*)',
  ].join('\n')
  return ['/usr/bin/sandbox-exec', '-p', profile, ...argv]
}

/** macOS refuses nested sandbox_init. Accept ONLY the exact DSH 0.1.2-rc.1
 * native read-only profile, then replace it with the strictly narrower profile
 * above on the same runner. Custom/remote runners are not silently bypassed.
 * The result permits fewer reads and network operations, and no extra writes.
 */
export function tightenHostSeatbelt(hostArgv: readonly string[], rawArgv: readonly string[], strictArgv: string[]): string[] {
  const expected = '(version 1) (allow default) (deny file-write*) (allow file-write* (literal "/dev/null"))'
  if (!['sandbox-exec', '/usr/bin/sandbox-exec'].includes(hostArgv[0] ?? '') || hostArgv[1] !== '-p'
      || hostArgv[2] !== expected || hostArgv[3] !== '--'
      || JSON.stringify(hostArgv.slice(4)) !== JSON.stringify(rawArgv)) throw new Error('UNSUPPORTED_DSH_SANDBOX_RUNNER')
  return strictArgv
}
