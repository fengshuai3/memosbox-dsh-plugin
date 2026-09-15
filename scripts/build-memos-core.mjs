/** Deterministic selected-export bundle of unmodified, hash-locked MemOS code. */
import { createHash, randomUUID } from 'node:crypto'
import { createRequire } from 'node:module'
import { lstat, mkdir, readFile, readdir, realpath, rename, rm, writeFile } from 'node:fs/promises'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { build, version as esbuildVersion } from 'esbuild'
import ts from 'typescript'

const root = resolve(import.meta.dirname, '..')
const checkOnly = process.argv.length === 3 && process.argv[2] === '--check'
if (process.argv.length > 2 && !checkOnly) throw new Error('Usage: build-memos-core.mjs [--check]')
const lock = JSON.parse(await readFile(join(root, 'runtime-locks/memos-core-source.json'), 'utf8'))
const require = createRequire(import.meta.url)
const upstream = await realpath(dirname(require.resolve('@memtensor/memos-local-plugin/package.json')))
const output = join(root, 'vendor/memos-core')
const digest = bytes => createHash('sha256').update(bytes).digest('hex')
const normalize = path => path.replaceAll('\\', '/')
if (esbuildVersion !== '0.28.2' || lock.version !== '2.0.19'
  || lock.tarballSha256 !== '0c44905fe54a9b7d66a1d5a372b021f2654d2918f9ade1b6e95a69b176dacc2d') throw new Error('Unreviewed build input')
const sourceHashes = {}
async function verifiedSource(path) {
  const absolute = await realpath(join(upstream, path))
  if (!absolute.startsWith(upstream + sep)) throw new Error(`Upstream source escaped package: ${path}`)
  const bytes = await readFile(absolute)
  if (!lock.files[path] || digest(bytes) !== lock.files[path]) throw new Error(`Official source hash mismatch: ${path}`)
  sourceHashes[path] = lock.files[path]
  return bytes
}
const metadata = JSON.parse((await verifiedSource('package.json')).toString())
if (metadata.name !== lock.package || metadata.version !== lock.version || metadata.license !== 'MIT') throw new Error('Upstream identity/license declaration mismatch')

const runtimeExports = [
  ['core/pipeline/orchestrator', ['createPipeline']],
  ['core/pipeline/memory-core', ['createMemoryCore']],
  ['core/llm/client', ['createLlmClient']],
  ['core/config/defaults', ['DEFAULT_CONFIG']],
  ['core/storage/connection', ['openDb']],
  ['core/storage/migrator', ['runMigrations']],
  ['core/storage/repos/index', ['makeRepos']],
  ['adapters/deepseek-harness/bridge', ['createDeepSeekHarnessBridge', 'extractDeepSeekHarnessLlmRoute']],
  ['adapters/deepseek-harness/host-llm', ['createDeepSeekHarnessHostLlmBridge', 'DeepSeekHarnessLlmRouteContext']],
]
const typeExports = [
  ['core/logger/types', ['Logger']], ['core/config/schema', ['ResolvedConfig']],
  ['core/config/paths', ['ResolvedHome']], ['agent-contract/memory-core', ['MemoryCore']],
  ['adapters/deepseek-harness/bridge', ['DeepSeekHarnessBridge', 'DshPreStepPayloadLike', 'DshSessionLike', 'DshAgentLike']],
]
const entry = runtimeExports.map(([path, names]) => `export { ${names.join(', ')} } from "@memtensor/memos-local-plugin/dist/${path}.js";`).join('\n')
const externalPackages = ['better-sqlite3', 'uuid', 'yaml', '@sinclair/typebox', '@sinclair/typebox/value', '@deepseek-ai/dsh-llm', '@deepseek-ai/dsh-timeout']
const result = await build({
  absWorkingDir: root, stdin: { contents: entry, resolveDir: root, sourcefile: 'memosbox-selected-upstream.mjs' },
  bundle: true, platform: 'node', target: 'node22.19', format: 'esm', treeShaking: true,
  write: false, metafile: true, outfile: join(output, 'index.js'), legalComments: 'inline',
  external: [...externalPackages, '@huggingface/transformers'],
})
const code = result.outputFiles[0].contents
const js = result.outputFiles[0].text
const emitted = Object.values(result.metafile.outputs)[0]
for (const imported of emitted.imports) {
  if (!imported.external || imported.kind !== 'import-statement'
    || !(imported.path.startsWith('node:') || externalPackages.includes(imported.path))) {
    throw new Error(`Unapproved runtime import: ${JSON.stringify(imported)}`)
  }
}
if (/transformers|onnxruntime|adm-zip|\bsharp\b/.test(js)) throw new Error('Unused model/archive closure survived tree-shaking')
const syntax = ts.createSourceFile('index.js', js, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS)
function checkCalls(node) {
  if (ts.isCallExpression(node) && (node.expression.kind === ts.SyntaxKind.ImportKeyword
    || (ts.isIdentifier(node.expression) && /^(?:__)?require$|^eval$/.test(node.expression.text)))) {
    throw new Error('Unexpected dynamic import/require/eval in selected runtime')
  }
  ts.forEachChild(node, checkCalls)
}
checkCalls(syntax)
const metafileInputs = {}
for (const [input, info] of Object.entries(result.metafile.inputs)) {
  if (input === 'memosbox-selected-upstream.mjs') continue
  const absolute = await realpath(resolve(root, input))
  const path = normalize(relative(upstream, absolute))
  if (path.startsWith('../') || !path.startsWith('dist/')) throw new Error(`Unexpected bundled third-party source: ${input}`)
  await verifiedSource(path)
  metafileInputs[path] = { bytes: info.bytes, bytesInOutput: emitted.inputs[input]?.bytesInOutput ?? 0 }
}

const declarations = runtimeExports.map(([path, names]) => `export { ${names.join(', ')} } from './types/${path}.js';`)
  .concat(typeExports.map(([path, names]) => `export type { ${names.join(', ')} } from './types/${path}.js';`)).join('\n') + '\n'
const pending = [...runtimeExports, ...typeExports].map(([path]) => `dist/${path}.d.ts`)
const types = new Map()
while (pending.length) {
  const path = pending.pop()
  if (types.has(path)) continue
  const bytes = await verifiedSource(path)
  types.set(path, bytes)
  for (const dependency of ts.preProcessFile(bytes.toString(), true, true).importedFiles) {
    if (!dependency.fileName.startsWith('.')) continue
    const next = normalize(relative(upstream, resolve(upstream, dirname(path), dependency.fileName))).replace(/\.js$/, '.d.ts')
    if (!next.startsWith('dist/') || !next.endsWith('.d.ts')) throw new Error(`Unresolved upstream declaration: ${next}`)
    pending.push(next)
  }
}
const migrations = new Map()
for (const file of (await readdir(join(upstream, 'dist/core/storage/migrations'))).sort()) {
  if (!/^\d{3}-[a-z0-9-]+\.sql$/i.test(file)) throw new Error(`Unexpected migration resource: ${file}`)
  migrations.set(file, await verifiedSource(`dist/core/storage/migrations/${file}`))
}
if (!migrations.size) throw new Error('No SQL migrations found')

// Prepare every byte and validate all inputs before changing the generated tree.
// Unchanged builds perform no writes, so concurrent readers cannot observe a
// transiently deleted vendor directory. Changed files are atomically replaced.
const prepared = new Map()
const outputs = {}
async function emit(path, bytes) {
  prepared.set(path, Buffer.from(bytes))
  outputs[path] = digest(bytes)
}
await emit('index.js', code)
await emit('index.d.ts', declarations)
await emit('UPSTREAM_PACKAGE.json', JSON.stringify({ name: metadata.name, version: metadata.version, license: metadata.license }, null, 2) + '\n')
for (const [path, bytes] of types) await emit(`types/${path.slice('dist/'.length)}`, bytes)
for (const [path, bytes] of migrations) await emit(`migrations/${path}`, bytes)
const license = await readFile(join(root, 'runtime-locks/memos-repository-LICENSE'))
if (digest(license) !== '154f9be8df2d55ceddcd4646c8d8d4206d48867ae1da2b81ce2ab86b51a5f075') throw new Error('Pinned repository LICENSE mismatch')
await emit('REPOSITORY-LICENSE', license)
await emit('NOTICE', `Selected, tree-shaken build of @memtensor/memos-local-plugin 2.0.19 by MemTensor.\nOriginal algorithms are unchanged. Models, installers, viewer, and unused exports are not distributed.\nThe npm package metadata declares MIT but the npm archive contains no LICENSE file.\nThe exact repository tag has only the repository-root Apache-2.0 license, preserved separately.\nPublic redistribution requires upstream clarification; do not represent the declaration as a verified MIT grant.\nSource: ${lock.tarball}\nSHA256: ${lock.tarballSha256}\nRepository tag: ${lock.repositoryTag} (${lock.repositoryCommit}; recorded independently of npm output)\n`)
await emit('metafile.json', JSON.stringify({
  entry, inputs: Object.fromEntries(Object.entries(metafileInputs).sort()),
  output: { bytes: code.length, imports: emitted.imports, exports: emitted.exports },
}, null, 2) + '\n')
const provenance = {
  schemaVersion: 1, package: lock.package, version: lock.version,
  tarball: lock.tarball, tarballSha256: lock.tarballSha256, tarballIntegrity: lock.tarballIntegrity,
  repositoryTag: lock.repositoryTag, repositoryCommit: lock.repositoryCommit,
  provenanceNote: lock.provenanceNote, licenseCaution: lock.licenseCaution,
  builder: { esbuild: esbuildVersion, target: 'node22.19', format: 'esm', treeShaking: true },
  runtimeImports: [...new Set(emitted.imports.map(item => item.path))].sort(),
  sources: Object.fromEntries(Object.entries(sourceHashes).sort()),
  files: Object.fromEntries(Object.entries(outputs).sort()),
}
prepared.set('provenance.json', Buffer.from(JSON.stringify(provenance, null, 2) + '\n'))
async function ensureSafeParents(path) {
  let cursor = root
  for (const part of ['vendor', 'memos-core', ...normalize(dirname(path)).split('/').filter(part => part !== '.')]) {
    cursor = join(cursor, part)
    try {
      const stat = await lstat(cursor)
      if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error(`Generated output parent must not be a symlink/non-directory: ${cursor}`)
    } catch (error) {
      if (error.code !== 'ENOENT' || checkOnly) throw error
      await mkdir(cursor)
    }
  }
}
await ensureSafeParents('index.js')
let previous = {}
try { previous = JSON.parse(await readFile(join(output, 'provenance.json'), 'utf8')).files ?? {} } catch (error) {
  if (error.code !== 'ENOENT') throw error
}
for (const [path, bytes] of prepared) {
  const file = join(output, path)
  await ensureSafeParents(path)
  try { if ((await lstat(file)).isSymbolicLink()) throw new Error(`Generated output must not be a symlink: ${path}`) } catch (error) { if (error.code !== 'ENOENT') throw error }
  let current
  try { current = await readFile(file) } catch (error) { if (error.code !== 'ENOENT') throw error }
  if (current?.equals(bytes)) continue
  if (checkOnly) throw new Error(`Generated MemOS output is stale: ${path}`)
  const temporary = `${file}.build-${randomUUID()}.tmp`
  let created = false
  try {
    await writeFile(temporary, bytes, { flag: 'wx' })
    created = true
    await rename(temporary, file)
  } finally { if (created) await rm(temporary, { force: true }) }
}
// Only files recorded by the previous generated manifest may be removed.
for (const path of Object.keys(previous)) {
  if (prepared.has(path)) continue
  if (checkOnly) throw new Error(`Stale generated MemOS file: ${path}`)
  if (path.includes('\\') || path.split('/').some(part => !part || part === '..' || part === '.')) throw new Error('Unsafe previous generated path')
  await ensureSafeParents(path)
  await rm(join(output, path), { force: true })
}
process.stdout.write(`${checkOnly ? 'Verified deterministic' : 'Built selected'} MemOS ${lock.version}: ${code.length} bytes, ${Object.keys(metafileInputs).length} inputs, ${types.size} type files, ${migrations.size} migrations; no model/archive runtime imports\n`)
