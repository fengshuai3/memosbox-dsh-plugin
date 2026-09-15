import { constants } from 'node:fs'
import { lstat, open, realpath } from 'node:fs/promises'
import { extname, join } from 'node:path'
import { createHash } from 'node:crypto'

/** IDs refer to operator-staged synthetic fixtures, never arbitrary paths.
 * The private document pipeline is not yet cleared for real health data.
 */
export async function authorizedSource(root: string, id: string, maxBytes = 20 * 1024 * 1024): Promise<{ path: string; digest: string; format: 'text' | 'pdf' | 'xlsx' }> {
  if (!root || !/^[a-f0-9-]{32,64}\.(txt|pdf|xlsx)$/.test(id)) throw new Error('SOURCE_NOT_REGISTERED')
  const base = await realpath(root)
  const path = join(base, id)
  const info = await lstat(path)
  if (!info.isFile() || info.isSymbolicLink() || info.size > maxBytes) throw new Error('UNSAFE_SOURCE')
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    const opened = await handle.stat()
    if (!opened.isFile() || opened.size > maxBytes) throw new Error('UNSAFE_SOURCE')
    const hash = createHash('sha256')
    const buffer = Buffer.alloc(64 * 1024)
    let size = 0
    for (;;) {
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, null)
      if (!bytesRead) break
      size += bytesRead
      if (size > maxBytes) throw new Error('SOURCE_LIMIT')
      hash.update(buffer.subarray(0, bytesRead))
    }
    return { path, digest: hash.digest('hex'), format: extname(id) === '.pdf' ? 'pdf' : extname(id) === '.xlsx' ? 'xlsx' : 'text' }
  } finally { await handle.close() }
}
