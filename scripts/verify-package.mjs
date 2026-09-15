import { access, readFile, readdir } from 'node:fs/promises'
import { resolve } from 'node:path'
import { parse } from 'yaml'
import { assertPackageFiles, assertPackageManifest, runNpm } from './package-tools.mjs'

const root = resolve(import.meta.dirname, '..')
const packageJson = JSON.parse(await readFile(resolve(root, 'package.json'), 'utf8'))
const patch = parse(await readFile(resolve(root, 'cordis.patch.yml'), 'utf8'))

assertPackageManifest(packageJson)
if (!Array.isArray(patch) || patch[0]?.insert?.[0]?.name !== 'memosbox-dsh-plugin') throw new Error('Cordis patch does not mount the package')

await Promise.all([
  access(resolve(root, 'dist', 'index.js')),
  access(resolve(root, 'dist', 'index.d.ts')),
  access(resolve(root, 'LICENSE')),
  access(resolve(root, 'NOTICE')),
  access(resolve(root, 'README.md')),
])

const [artifact] = JSON.parse(runNpm(['pack', '--dry-run', '--ignore-scripts', '--json'], root).stdout)
assertPackageFiles(artifact.files.map(file => file.path))
const packed = new Set(artifact.files.map(file => file.path))
for (const source of await readdir(resolve(root, 'src'), { recursive: true })) {
  if (!source.endsWith('.ts') || source.endsWith('.d.ts')) continue
  const relative = source.replaceAll('\\', '/').slice(0, -3)
  for (const extension of ['.js', '.d.ts']) {
    if (!packed.has(`dist/${relative}${extension}`)) throw new Error(`Missing compiled source artifact: dist/${relative}${extension}`)
  }
}
process.stdout.write(`package manifest, exact prerelease peers, Cordis bundle, and ${artifact.files.length} packed files verified (not a release-security approval)\n`)
