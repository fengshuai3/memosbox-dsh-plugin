/** Launch a prepared private Web test profile; keep authentication URLs out of stdout. */
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { open, readFile, realpath, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { createHash } from 'node:crypto'
import { createConnection } from 'node:net'

process.umask(0o077)
const root = resolve(import.meta.dirname, '..')
const receiptPath = await realpath(resolve(process.argv[2] ?? ''))
assert(receiptPath.startsWith(join(root, '.test-runtime') + '/'))
const receipt = JSON.parse(await readFile(receiptPath, 'utf8'))
assert.equal(receiptPath, join(receipt.testRoot, 'web-dialogue-preparation.json'))
assert.equal(createHash('sha256').update(await readFile(receipt.artifact)).digest('hex'), receipt.artifactSha256)
const url = new URL(receipt.launch.url)
assert.equal(url.hostname, '127.0.0.1')
const occupied = await new Promise(done => {
  const socket = createConnection({ host: url.hostname, port: Number(url.port) })
  socket.once('connect', () => { socket.destroy(); done(true) })
  socket.once('error', () => done(false))
  socket.setTimeout(1000, () => { socket.destroy(); done(true) })
})
assert(!occupied, 'Port is already in use; do not overwrite or stop another server')
const env = { ...process.env, ...receipt.launch.environment }
for (const key of receipt.launch.unsetEnvironment) delete env[key]
const stdout = await open(join(receipt.testRoot, 'server.stdout.private.log'), 'a', 0o600)
const stderr = await open(join(receipt.testRoot, 'server.stderr.private.log'), 'a', 0o600)
// Let DSH hand its one-time authenticated URL directly to the default browser.
const argv = receipt.launch.argv.filter(arg => arg !== '--no-open')
const child = spawn(receipt.launch.executable, argv, { cwd: receipt.launch.cwd, env, detached: true, stdio: ['ignore', stdout.fd, stderr.fd] })
await new Promise((done, reject) => { child.once('spawn', done); child.once('error', reject) })
child.unref()
await stdout.close(); await stderr.close()
const launch = { startedAt: new Date().toISOString(), pid: child.pid, url: receipt.launch.url, receipt: receiptPath, browserAutoOpenRequested: true, artifactSha256: receipt.artifactSha256, captureEnabled: receipt.captureEnabled }
await writeFile(join(receipt.testRoot, 'server-launch.json'), JSON.stringify(launch, null, 2) + '\n', { mode: 0o600, flag: 'wx' })
console.log(JSON.stringify(launch, null, 2))
