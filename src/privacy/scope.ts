import { createHash } from 'node:crypto'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

export interface SessionScope {
  readonly key: string
  readonly profileId: string
  readonly workspaceId: string
}

/** Bind the configured label to the Loader's profile directory. Two profiles
 * both shipping the bundle's default label must not silently share databases.
 * Agent presets and model-supplied arguments never participate in this binding.
 */
export function bindProfileId(configured: string, loaderBaseUrl?: string): string {
  const label = configured.trim()
  if (!label || label.length > 128) throw new TypeError('Invalid profileId')
  if (loaderBaseUrl) {
    const url = new URL(loaderBaseUrl)
    if (url.protocol !== 'file:') throw new Error('PROFILE_SCOPE_UNAVAILABLE')
    return createHash('sha256').update(JSON.stringify([label, resolve(fileURLToPath(url))])).digest('hex')
  }
  // Directly embedded hosts may supply a unique explicit profile identifier;
  // missing Loader identity plus the generic default fails closed.
  if (label === 'default') throw new Error('PROFILE_SCOPE_UNAVAILABLE')
  return label
}

/** Presets are model choices, not authority to change memory ownership. */
export function sessionScope(profileId: string, workspace: string): SessionScope {
  if (!profileId.trim() || profileId.length > 128) throw new TypeError('Invalid profileId')
  if (!workspace.trim()) throw new TypeError('A workspace is required for scoped persistence')
  const workspaceId = createHash('sha256').update(resolve(workspace)).digest('hex')
  const key = createHash('sha256').update(JSON.stringify([profileId, workspaceId])).digest('hex')
  return Object.freeze({ key, profileId, workspaceId })
}
