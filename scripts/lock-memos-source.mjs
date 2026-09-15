/** Explicit maintainer-only refresh of a fixed official source lock; never an install hook. */
import { createHash } from 'node:crypto'
import { gunzipSync } from 'node:zlib'
import { writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'

const root = resolve(import.meta.dirname, '..')
const url = 'https://registry.npmjs.org/@memtensor/memos-local-plugin/-/memos-local-plugin-2.0.19.tgz'
const sha256 = '0c44905fe54a9b7d66a1d5a372b021f2654d2918f9ade1b6e95a69b176dacc2d'
const sha512 = 'iPrbwKkcp+VKxD6p6cDNqlwdoG7Senj63U7m8ObAZ/NasP8HNe0g6yTMMgIQyfYywKQHG80v+5xnH5mWTjiBdQ=='
const response = await fetch(url, { redirect: 'error', signal: AbortSignal.timeout(60_000) })
if (!response.ok) throw new Error('Official source download failed')
const archive = Buffer.from(await response.arrayBuffer())
if (createHash('sha256').update(archive).digest('hex') !== sha256
  || createHash('sha512').update(archive).digest('base64') !== sha512) throw new Error('Pinned upstream tarball hash mismatch')

// Parse only a cryptographically pinned archive, in memory. Never extract paths
// to disk and never read/persist credential files that upstream also distributes.
const tar = gunzipSync(archive)
const files = {}
for (let offset = 0; offset + 512 <= tar.length;) {
  const header = tar.subarray(offset, offset + 512)
  if (header.every(value => value === 0)) break
  const field = (start, length) => header.subarray(start, start + length).toString().split('\0', 1)[0]
  const name = [field(345, 155), field(0, 100)].filter(Boolean).join('/')
  const size = Number.parseInt(field(124, 12).trim(), 8)
  if (!Number.isSafeInteger(size) || size < 0 || offset + 512 + size > tar.length) throw new Error('Invalid pinned tar header')
  const type = field(156, 1)
  if ((type === '0' || type === '') && name.startsWith('package/')
    && (name === 'package/package.json' || /^package\/dist\/.*\.(?:js|d\.ts|sql)$/.test(name))) {
    const path = name.slice('package/'.length)
    if (path.split('/').some(component => component === '..' || component === '')) throw new Error('Unsafe upstream path')
    files[path] = createHash('sha256').update(tar.subarray(offset + 512, offset + 512 + size)).digest('hex')
  }
  offset += 512 + Math.ceil(size / 512) * 512
}
if (!files['dist/core/index.js'] || !files['dist/adapters/deepseek-harness/bridge.js']) throw new Error('Pinned archive lacks expected regular files')
const lock = {
  schemaVersion: 1,
  package: '@memtensor/memos-local-plugin', version: '2.0.19',
  tarball: url, tarballSha256: sha256, tarballIntegrity: `sha512-${sha512}`,
  repositoryTag: 'memos-local-plugin-v2.0.19', repositoryCommit: 'ec8b7d956ccf3fc29345fdb3d82b5f3817578d62',
  provenanceNote: 'npm metadata has no gitHead; repository tag is recorded separately, not asserted byte-identical to npm build output.',
  packageLicenseDeclaration: 'MIT',
  licenseCaution: 'npm tarball and apps/memos-local-plugin at this tag contain no LICENSE file; repository root has Apache-2.0. Public redistribution needs upstream license clarification.',
  files: Object.fromEntries(Object.entries(files).sort(([left], [right]) => left.localeCompare(right, 'en'))),
}
await writeFile(resolve(root, 'runtime-locks/memos-core-source.json'), JSON.stringify(lock, null, 2) + '\n')
process.stdout.write(`Locked ${Object.keys(files).length} code/type/SQL files from the exact official tarball; no credentials extracted\n`)
