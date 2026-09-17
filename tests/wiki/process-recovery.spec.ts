import { mkdtemp, mkdir, readFile, readdir, rm, utimes, writeFile } from 'node:fs/promises'
import { spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath, pathToFileURL } from 'node:url'
import ts from 'typescript'
import { afterEach, describe, expect, it } from 'vitest'

const temporary: string[] = []
const require = createRequire(import.meta.url)
afterEach(async () => { await Promise.all(temporary.splice(0).map(path => rm(path, { recursive: true, force: true }))) })

/** Compile current source into a temporary executable fixture; never consume or rebuild project dist. */
async function runtime() {
  const parent = await mkdtemp(join(tmpdir(), 'memosbox-wiki-process-'))
  temporary.push(parent)
  const compiled = join(parent, 'compiled')
  await mkdir(compiled)
  const source = fileURLToPath(new URL('../../src/wiki/', import.meta.url))
  await writeFile(join(compiled, 'package.json'), '{"type":"module"}')
  for (const name of (await readdir(source)).filter(name => name.endsWith('.ts'))) {
    const input = await readFile(join(source, name), 'utf8')
    const emitted = ts.transpileModule(input, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText
      .replace(/from (['"])([^'"]+)\1/g, (whole, quote: string, specifier: string) => {
        if (specifier.startsWith('.') || specifier.startsWith('node:')) return whole
        return `from ${quote}${pathToFileURL(require.resolve(specifier)).href}${quote}`
      })
    await writeFile(join(compiled, name.replace(/\.ts$/, '.js')), emitted)
  }
  return { parent, compiled, root: join(parent, 'wiki') }
}

describe('new-process crash recovery', () => {
  it.each(['intent', 'page', 'index', 'log', 'receipt'])('recovers a process that exited immediately after %s fsync', async stage => {
    const { parent, compiled, root } = await runtime()
    const crashMarker = join(parent, 'crash-marker')
    const adapterUrl = pathToFileURL(join(compiled, 'adapter.js')).href
    const storeUrl = pathToFileURL(join(compiled, 'file-store.js')).href
    const options = { root, autoInitialize: true, maxPageBytes: 8192 }
    const input = { operationId: 'process-crash', path: 'concepts/crash.md', body: 'PROCESS_RESTART_CANARY [[memos]] [[wiki]].', expectedVersion: 'absent' }
    const producer = `
      import {writeFileSync} from 'node:fs';
      import {WikiAdapter} from ${JSON.stringify(adapterUrl)};
      import {WikiFileStore} from ${JSON.stringify(storeUrl)};
      const original = WikiFileStore.prototype.write;
      WikiFileStore.prototype.write = async function(path, ...args) {
        await original.call(this, path, ...args);
        const stage = ${JSON.stringify(stage)};
        if ((stage === 'intent' && path.includes('/pending/')) || (stage === 'page' && path === 'concepts/crash.md') ||
            (stage === 'index' && path === 'index.md') || (stage === 'log' && path === 'log.md') ||
            (stage === 'receipt' && path.includes('/receipts/'))) {
          writeFileSync(${JSON.stringify(crashMarker)}, stage);
          process.kill(process.pid, 'SIGKILL');
          process.exit(99); // Fail the parent assertion if forced termination ever returns.
        }
      };
      const adapter = new WikiAdapter(${JSON.stringify(options)});
      await adapter.initialize();
      await adapter.writePage(${JSON.stringify(input)});
    `
    const crashed = spawnSync(process.execPath, ['--input-type=module', '-e', producer], { encoding: 'utf8', timeout: 10_000 })
    expect(crashed.error).toBeUndefined()
    expect(crashed.stderr).toBe('')
    expect(await readFile(crashMarker, 'utf8')).toBe(stage)
    if (process.platform === 'win32') {
      // Windows reports forced termination as a nonzero exit, not a POSIX signal.
      expect(crashed.signal).toBeNull()
      expect(crashed.status).toBeTypeOf('number')
      expect(crashed.status).toBeGreaterThan(0)
      expect(crashed.status).not.toBe(99)
    } else expect(crashed.signal).toBe('SIGKILL')
    // Simulate expiration rather than waiting thirty seconds for the dead process's lease.
    const expired = new Date(Date.now() - 60_000)
    await utimes(`${root}.lock`, expired, expired)
    const consumer = `
      import {WikiAdapter} from ${JSON.stringify(adapterUrl)};
      const adapter = new WikiAdapter(${JSON.stringify(options)});
      await adapter.initialize();
      const result = await adapter.writePage(${JSON.stringify(input)});
      console.log(JSON.stringify({result, page: await adapter.page('concepts/crash.md')}));
    `
    const recovered = spawnSync(process.execPath, ['--input-type=module', '-e', consumer], { encoding: 'utf8', timeout: 10_000 })
    expect(recovered.stderr).toBe('')
    expect(recovered.status).toBe(0)
    const value = JSON.parse(recovered.stdout)
    expect(value.result).toMatchObject({ ok: true, committed: true, unchanged: true, operationId: 'process-crash' })
    expect(value.page.body).toContain('PROCESS_RESTART_CANARY')
    expect((await readFile(join(root, 'log.md'), 'utf8')).match(/memosbox-operation:process-crash/g)).toHaveLength(1)
    expect(await readdir(join(root, '.memosbox-journal/pending'))).toEqual([])
  })
})
