import { createHash, randomUUID } from 'node:crypto'
import type { NormalizedReading, DocumentSegment } from './types.js'
import type { SessionScope } from '../privacy/scope.js'
import { approvedMemoryId } from '../memory/approved-writer.js'

export interface ImportCandidate {
  schemaVersion: 1
  id: string
  operationId: string
  digest: string
  scopeKey: string
  sourceDigest: string
  sourceId: string
  createdAt: number
  targetPath: string
  expectedVersion: string
  readings: NormalizedReading[]
  segments: DocumentSegment[]
  warnings: string[]
  partial: boolean
}

export function candidateDigest(value: Omit<ImportCandidate, 'digest'>): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex')
}

export function makeCandidate(input: {
  scope: SessionScope; sourceDigest: string; sourceId: string; readings: NormalizedReading[];
  segments: DocumentSegment[]; warnings: string[]; partial: boolean;
}): ImportCandidate {
  const id = randomUUID()
  const base = {
    schemaVersion: 1 as const, id, operationId: randomUUID(), scopeKey: input.scope.key,
    sourceDigest: input.sourceDigest, sourceId: input.sourceId, createdAt: Date.now(),
    targetPath: `concepts/mirobody-${id}.md`, expectedVersion: 'absent',
    readings: input.readings, segments: input.segments, warnings: input.warnings, partial: input.partial,
  }
  return { ...base, digest: candidateDigest(base) }
}

export function verifyCandidate(candidate: ImportCandidate, scope: SessionScope): void {
  const { digest, ...body } = candidate
  if (candidate.schemaVersion !== 1 || candidate.scopeKey !== scope.key || digest !== candidateDigest(body)) throw new Error('CANDIDATE_INTEGRITY_OR_SCOPE')
  if (!/^[a-f0-9]{64}$/.test(candidate.sourceDigest) || !/^concepts\/mirobody-[a-f0-9-]{36}\.md$/.test(candidate.targetPath)) throw new Error('INVALID_CANDIDATE')
}

export function candidateMarkdown(candidate: ImportCandidate, includeMemory = false): string {
  // JSON code fence prevents raw text from becoming additional frontmatter.
  const readings = JSON.stringify(candidate.readings, null, 2).replace(/`/g, '\\u0060')
  const lookup = includeMemory ? `\nMemOS lookup ID: ${approvedMemoryId(candidate.scopeKey, candidate.operationId, candidate.digest)}\nThis is a lookup reference, NOT proof of a successful memory write. Verify with memos_get in this workspace; an empty translated lexical search cannot disprove storage.\n` : ''
  return `# Reviewed Mirobody import\n\nSource SHA256: ${candidate.sourceDigest}\nCandidate: ${candidate.digest}\n${lookup}\nThis is extracted and normalized reference data, not a diagnosis.\n\n\`\`\`json\n${readings}\n\`\`\`\n\nSources and governance: [[SCHEMA]] [[index]]\n`
}
