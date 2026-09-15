/** Render structured tool evidence with a bounded narrative budget and fixed metadata allowance. */
export function renderWikiResult(value: unknown, maxResultChars: number): string {
  const result = JSON.parse(JSON.stringify(value)) as Record<string, unknown>
  const maximum = Math.max(256, maxResultChars) + 4096
  if ('body' in result || 'hits' in result || 'summary' in result) delete result.text
  if (result.path === result.wikiRelativePath) delete result.wikiRelativePath
  let encoded = JSON.stringify(result)
  if (encoded.length <= maximum) return encoded
  result.truncated = true
  let narrativeLimit = Math.max(0, maxResultChars)
  while (encoded.length > maximum && narrativeLimit > 0) {
    narrativeLimit = Math.floor(narrativeLimit / 2)
    trimNarratives(result, narrativeLimit)
    encoded = JSON.stringify(result)
  }
  if (Array.isArray(result.hits)) {
    result.totalHits = result.hits.length
    while (encoded.length > maximum && result.hits.length > 1) {
      result.hits.pop()
      encoded = JSON.stringify(result)
    }
  }
  if (encoded.length <= maximum) return encoded
  // Never silently erase provenance: a compact result explicitly requests a narrower read.
  const compact: Record<string, unknown> = { truncated: true, metadataOmitted: true,
    text: 'Result metadata exceeds the output budget. Narrow the query or inspect the source document.' }
  for (const key of ['ok', 'found', 'status', 'state', 'path', 'version', 'currentVersion', 'expectedVersion', 'operationId', 'committed', 'recoveryRequired', 'nextOffset', 'totalChars']) {
    if (key in result) compact[key] = result[key]
  }
  return JSON.stringify(compact)
}

function trimNarratives(value: unknown, maximum: number): void {
  if (value === null || typeof value !== 'object') return
  for (const [key, item] of Object.entries(value)) {
    if (['body', 'content', 'summary', 'text'].includes(key) && typeof item === 'string') {
      if (item.length > maximum) (value as Record<string, unknown>)[key] = item.slice(0, maximum)
    } else if (typeof item === 'object') trimNarratives(item, maximum)
  }
}
