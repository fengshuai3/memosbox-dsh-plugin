import { describe, it, expect } from 'vitest'
import { bindProfileId, sessionScope } from '../src/privacy/scope.js'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { effectiveMemoryPolicy, metadataOnlyApiLog } from '../src/privacy/policy.js'

describe('privacy boundaries', () => {
  it('isolates Loader profiles even when both use the shipped default label', () => {
    const one = pathToFileURL(resolve('synthetic-profiles/one')).href
    const two = pathToFileURL(resolve('synthetic-profiles/two')).href
    expect(sessionScope(bindProfileId('default', one), process.cwd()).key)
      .not.toBe(sessionScope(bindProfileId('default', two), process.cwd()).key)
    expect(bindProfileId('default', one)).toBe(bindProfileId('default', one + '/'))
    expect(() => bindProfileId('default')).toThrow('PROFILE_SCOPE_UNAVAILABLE')
    expect(() => bindProfileId('default', 'https://example.invalid/profile')).toThrow('PROFILE_SCOPE_UNAVAILABLE')
    expect(bindProfileId('explicit-embedded-profile')).toBe('explicit-embedded-profile')
  })
  it('separates workspaces and profiles without using agent presets', () => {
    expect(sessionScope('a', './one').key).not.toBe(sessionScope('a', './two').key)
    expect(sessionScope('a', './one').key).not.toBe(sessionScope('b', './one').key)
    expect(sessionScope('a', './one')).toEqual(sessionScope('a', './one'))
  })
  it('removes query and output bodies before the api log persistence boundary', () => {
    const value = metadataOnlyApiLog({ input: { query: 'HEALTH_CANARY' }, output: { message: 'HEALTH_CANARY' }, success: true })
    expect(JSON.stringify(value)).not.toContain('HEALTH_CANARY')
    expect(value.success).toBe(true)
  })
  it('closes every ordinary memory path in sensitive mode', () => {
    const policy = effectiveMemoryPolicy({ sensitiveMode: true, recallEnabled: true, captureEnabled: true, memoryToolsEnabled: true, queryLogEnabled: true, explicitMemoryWriteEnabled: true })
    expect(Object.values(policy).filter(Boolean)).toEqual([true])
  })
})
