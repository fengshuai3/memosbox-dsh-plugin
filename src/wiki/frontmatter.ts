import { parse } from 'yaml'
import type { WikiMetadata } from './types.js'

/** Split one Markdown document into YAML frontmatter and body. */
export function splitFrontmatter(text: string): { metadata: WikiMetadata; body: string } {
  const opening = /^---\r?\n/.exec(text)
  if (!opening) return { metadata: {}, body: text }
  const closing = /\r?\n---(?:\r?\n|$)/g
  closing.lastIndex = opening[0].length
  const end = closing.exec(text)
  if (!end) return { metadata: {}, body: text }

  let value: unknown
  try {
    value = parse(text.slice(opening[0].length, end.index))
  } catch {
    return { metadata: {}, body: text }
  }
  const metadata = isRecord(value) ? normalizeMetadata(value) : {}
  return { metadata, body: text.slice(end.index + end[0].length) }
}

/** Render deterministic YAML frontmatter followed by the normalized body. */
export function renderPage(input: {
  title: string
  created: string
  updated: string
  pageType: string
  tags: readonly string[]
  sources: readonly string[]
  confidence: string
  contested: boolean
  body: string
}): string {
  const frontmatter = [
    '---',
    `title: ${yamlString(input.title)}`,
    `created: ${yamlString(input.created)}`,
    `updated: ${yamlString(input.updated)}`,
    `type: ${yamlString(input.pageType)}`,
    `tags: [${input.tags.map(yamlString).join(', ')}]`,
    `sources: [${input.sources.map(yamlString).join(', ')}]`,
    `confidence: ${yamlString(input.confidence)}`,
    `contested: ${String(input.contested)}`,
    '---',
    '',
    input.body.trim(),
    '',
  ]
  return frontmatter.join('\n')
}

function yamlString(value: string): string {
  return JSON.stringify(value)
}

function normalizeMetadata(value: Record<string, unknown>): WikiMetadata {
  const result: Record<string, unknown> = {}
  for (const [key, item] of Object.entries(value)) {
    if (item instanceof Date) result[key] = item.toISOString().slice(0, 10)
    else if (Array.isArray(item)) result[key] = item.map(entry => String(entry))
    else if (item === null || ['string', 'number', 'boolean'].includes(typeof item)) result[key] = item
  }
  return result as WikiMetadata
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}
