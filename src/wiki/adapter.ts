import { createHash } from 'node:crypto'
import { basename, resolve } from 'node:path'
import { renderPage, splitFrontmatter } from './frontmatter.js'
import { WikiFileError, WikiFileStore } from './file-store.js'
import { withWikiLock, recoverWikiWrite } from './recovery.js'
import { sha256, WikiWriteJournal, type WikiWriteIntent } from './write-journal.js'
import { INDEX_TEMPLATE, LOG_TEMPLATE, PAGE_DIRECTORIES, SCHEMA_TEMPLATE } from './templates.js'
import type { WikiAdapterOptions, WikiConfidence, WikiHit, WikiOperationOptions, WikiPage, WikiPageType, WikiRawSourceResult, WikiWriteInput, WikiWriteResult } from './types.js'

const TYPES = { entities: 'entity', concepts: 'concept', comparisons: 'comparison', queries: 'query' } as const
const SECTIONS = { entities: 'Entities', concepts: 'Concepts', comparisons: 'Comparisons', queries: 'Queries' } as const
const TAGS = new Set(['dsh', 'hermes', 'skill', 'wiki', 'memory', 'memos', 'provider', 'context', 'file-management', 'governance', 'comparison', 'architecture', 'testing', 'configuration'])
const PAGE = /^(entities|concepts|comparisons|queries)\/[a-z0-9]+(?:-[a-z0-9]+)*\.md$/
const HASH = /^[0-9a-f]{64}$/

/** Governed Markdown storage with recoverable multi-file writes and explicit operation receipts. */
export class WikiAdapter {
  readonly root: string
  private readonly store: WikiFileStore
  private readonly journal: WikiWriteJournal
  private readonly maxSourceBytes: number
  private readonly now: () => Date

  constructor(private readonly options: WikiAdapterOptions) {
    this.root = resolve(options.root)
    this.store = new WikiFileStore(this.root, options.maxPageBytes)
    this.journal = new WikiWriteJournal(this.store, options.maxPageBytes)
    this.maxSourceBytes = options.maxSourceBytes ?? 20 * 1024 * 1024
    this.now = options.now ?? (() => new Date())
  }

  /** Initialize without replacing existing files; finish pending operations when mutation is enabled. */
  async initialize(): Promise<void> {
    if (!this.options.autoInitialize) return
    await this.skeleton()
    if ((await this.journal.pending()).length) await this.recover()
  }

  /** Report readable page counts and incomplete operations without creating any files. */
  async status(): Promise<Record<string, unknown>> {
    const available = await this.available()
    const pending = available ? await this.journal.pending() : []
    return {
      available, root: this.root, pageCount: available ? (await this.pages()).length : 0,
      schemaPresent: available && await this.page('SCHEMA.md') !== null,
      indexPresent: available && await this.page('index.md') !== null,
      logPresent: available && await this.page('log.md') !== null,
      recoveryRequired: pending.length > 0, pendingOperations: pending.map(item => item.operationId),
    }
  }

  /** Read Markdown/text references, excluding private journals and all symlinks inside the root. */
  async page(value: string): Promise<WikiPage | null> {
    try {
      const path = this.store.normalize(value)
      if (!/\.(?:md|txt)$/i.test(path) || path.split('/').some(part => part.startsWith('.'))) return null
      const text = await this.store.read(path)
      if (text === null) return null
      const { metadata, body } = splitFrontmatter(text)
      return { path, wikiRelativePath: path, version: sha256(text), metadata, body, text }
    } catch (error) {
      if (unreadable(error)) return null
      throw error
    }
  }

  /** Rank knowledge pages first; only matching navigation may fill unused result slots. */
  async query(query: string, limit = 8, includeOrientation = true, maxChars = 1800): Promise<WikiHit[]> {
    if (!await this.available()) return []
    const terms = searchTerms(query)
    const entities = explicitEntities(query)
    const hits: WikiHit[] = []
    for (const page of await this.pages()) {
      // Explicit entity IDs constrain page ownership, not mentions in its body.
      // A shared word such as "口令" must not return another project's secrets.
      const identities = explicitEntities(`${String(page.metadata.title ?? '')}\n${firstHeading(page.body)}\n${page.path.replace(/\.md$/, '')}`)
      if (entities.length && !entities.every(entity => identities.includes(entity))) continue
      const score = scoreText(`${String(page.metadata.title ?? '')}\n${page.body}`, terms)
      if (score <= 0) continue
      hits.push({ source: 'wiki', kind: String(page.metadata.type ?? page.path.split('/')[0]), id: basename(page.path, '.md'),
        score, title: String(page.metadata.title ?? (firstHeading(page.body) || basename(page.path, '.md'))),
        content: entities.length ? snippet(page.body, terms, maxChars) : '', path: page.path,
        metadata: Object.fromEntries(Object.entries(page.metadata).filter(([key]) => ['type', 'confidence', 'contested'].includes(key))),
        matchKind: entities.length ? 'entity-exact' : 'lexical-metadata-only', requiresPageRead: !entities.length })
    }
    hits.sort((a, b) => b.score - a.score || a.path.localeCompare(b.path))
    const count = boundedInteger(limit, 8, 0, 100)
    // Navigation can enumerate unrelated pages. It is not evidence for a named
    // entity and is opt-in at the tool boundary for orientation queries only.
    if (!entities.length && includeOrientation && hits.length < count) {
      for (const name of ['SCHEMA.md', 'index.md', 'log.md']) {
        const page = await this.page(name)
        if (page === null) continue
        const score = scoreText(page.text, terms)
        if (score > 0) hits.push({ source: 'wiki', kind: 'navigation', id: name, score, title: name,
          content: snippet(page.text, terms, maxChars), path: name, metadata: {} })
      }
    }
    return hits.slice(0, count)
  }

  /** Summarize with deterministic extraction and explicit truncation. */
  async summarize(input: { path?: string; content?: string }): Promise<Record<string, unknown>> {
    let content = input.content ?? ''
    let source = 'inline'
    if (input.path?.trim()) {
      const page = await this.page(input.path)
      if (page === null) return { ok: false, text: 'Wiki page not found or unreadable.', error: 'page not found', path: input.path }
      content = page.body
      source = page.path
    }
    if (Buffer.byteLength(content, 'utf8') > this.options.maxPageBytes) return { ok: false, text: 'Summary input exceeds the page byte limit.', error: 'input too large' }
    const headings = content.split(/\r?\n/).filter(line => line.startsWith('#')).map(line => line.replace(/^#+\s*/, '').trim())
    const paragraphs = content.split(/\r?\n\s*\r?\n/).map(value => value.trim()).filter(value => value && !value.startsWith('---'))
    const extracted = paragraphs.slice(0, 3).join(' ')
    const summary = extracted.slice(0, 1200)
    return { ok: true, text: summary || 'No summary content found.', source, headings: headings.slice(0, 12), summary,
      paragraphCount: paragraphs.length, truncated: extracted.length > 1200 || paragraphs.length > 3 || headings.length > 12 }
  }

  /** Create or update a governed page; cancellation ends at the synced write-intent boundary. */
  async writePage(input: WikiWriteInput, execution: WikiOperationOptions = {}): Promise<WikiWriteResult> {
    execution.signal?.throwIfAborted()
    await this.skeleton()
    let path: string
    try { path = this.store.normalize(input.path?.trim() || this.defaultPagePath(input)) }
    catch (error) { if (error instanceof WikiFileError) return failure('invalid wiki path'); throw error }
    if (!PAGE.test(path)) return failure('wiki pages must be direct lowercase ASCII .md children of entities, concepts, comparisons, or queries')
    const directory = path.split('/')[0] as keyof typeof TYPES
    const pageType = input.type ?? TYPES[directory]
    if (pageType !== 'summary' && pageType !== TYPES[directory]) return failure(`wiki page type ${pageType} does not match directory ${directory}`)
    const body = input.body.trim()
    const title = (input.title?.trim() || firstHeading(body) || basename(path, '.md')).slice(0, 200)
    const tags = normalizeStrings(input.tags ?? ['wiki'])
    const sources = normalizeStrings(input.sources ?? [])
    const confidence = input.confidence ?? 'medium'
    const validation = await this.validatePage({ body, tags, sources, confidence })
    if (validation) return failure(validation)
    const expectedVersion = input.expectedVersion?.trim().toLowerCase()
    if (expectedVersion !== undefined && expectedVersion !== 'absent' && !HASH.test(expectedVersion)) return failure("expectedVersion must be a page SHA256 or 'absent'")
    const requestDigest = sha256(JSON.stringify({ path, pageType, body, title, tags, sources, confidence,
      contested: input.contested ?? false, created: input.created ?? null, expectedVersion: expectedVersion ?? null }))
    const operationId = input.operationId ?? requestDigest
    if (!/^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/.test(operationId)) return failure('invalid operationId')
    return withWikiLock(this.store, execution.signal, async assertOwned => {
      const recovered = await this.recoverLocked(assertOwned, execution.signal)
      const blocked = recovered.find(result => !result.ok)
      if (blocked) return blocked
      const receipt = await this.journal.receipt(operationId)
      if (receipt) {
        const current = await this.store.read(path)
        const currentVersion = current === null ? 'absent' : sha256(current)
        if (receipt.requestDigest !== requestDigest || currentVersion !== receipt.version) return conflict(path, receipt.version, currentVersion, operationId)
        return { ok: true, committed: true, unchanged: true, state: 'committed', operationId, path, wikiRelativePath: path,
          version: receipt.version, text: `Wiki operation already committed: ${path}` }
      }
      execution.signal?.throwIfAborted()
      const current = await this.store.read(path)
      const currentVersion = current === null ? 'absent' : sha256(current)
      if (expectedVersion !== undefined && expectedVersion !== currentVersion) return conflict(path, expectedVersion, currentVersion, operationId)
      const today = localDate(this.now())
      const created = input.created?.trim() || String(current === null ? today : splitFrontmatter(current).metadata.created ?? today)
      const text = renderPage({ title, created, updated: today, pageType, tags, sources, confidence, contested: input.contested ?? false, body })
      if (Buffer.byteLength(text, 'utf8') > this.options.maxPageBytes) return failure('wiki page exceeds wikiMaxPageBytes')
      const intent: WikiWriteIntent = { schemaVersion: 1, operationId, requestDigest, path, previousVersion: currentVersion,
        version: sha256(text), text, title, date: today, action: current === null ? 'create' : 'update' }
      execution.signal?.throwIfAborted()
      assertOwned()
      // Once this intent is synced, finish or report recovery_required even if the caller cancels.
      try { await this.journal.prepare(intent) }
      catch {
        return { ok: false, status: 503, state: 'recovery_required', recoveryRequired: true, operationId,
          path, wikiRelativePath: path, version: intent.version,
          text: 'Wiki write intent could not be confirmed. Retry the same operationId to reconcile it.', error: 'WikiJournalError' }
      }
      return this.finish(intent, assertOwned)
    })
  }

  /** Finish pending operations; changed pages remain untouched and return explicit conflicts. */
  async recover(execution: WikiOperationOptions = {}): Promise<WikiWriteResult[]> {
    if (!await this.available()) return []
    return withWikiLock(this.store, execution.signal, assertOwned => this.recoverLocked(assertOwned, execution.signal))
  }

  /** Inspect a completed operation without modifying files; pending operations return recovery_required. */
  async operation(operationId: string): Promise<WikiWriteResult | null> {
    if (!await this.available()) return null
    const receipt = await this.journal.receipt(operationId)
    if (receipt) {
      const current = await this.store.read(receipt.path)
      const currentVersion = current === null ? 'absent' : sha256(current)
      if (currentVersion !== receipt.version) return conflict(receipt.path, receipt.version, currentVersion, operationId)
      return { ok: true, committed: true, state: 'committed', operationId, path: receipt.path, wikiRelativePath: receipt.path,
        version: receipt.version, text: 'Wiki operation committed.' }
    }
    const pending = (await this.journal.pending()).find(item => item.operationId === operationId)
    if (!pending) return null
    return { ok: false, state: 'recovery_required', recoveryRequired: true, operationId, path: pending.path,
      version: pending.version, text: 'Wiki operation awaits recovery.' }
  }

  /** Add an approved immutable raw source; equal bytes are idempotent and different bytes never overwrite. */
  async addRawSource(value: string, content: Buffer | string, execution: WikiOperationOptions = {}): Promise<WikiRawSourceResult> {
    execution.signal?.throwIfAborted()
    await this.skeleton()
    const path = this.store.normalize(value)
    if (!/^raw\/(?:[a-z0-9][a-z0-9._-]*\/)*[a-z0-9][a-z0-9._-]*$/.test(path)) throw new WikiFileError('unsafe-path', path)
    const bytes = typeof content === 'string' ? Buffer.from(content, 'utf8') : Buffer.from(content)
    return withWikiLock(this.store, execution.signal, async assertOwned => {
      await this.store.ensureDirectory(path.split('/').slice(0, -1).join('/'))
      execution.signal?.throwIfAborted()
      assertOwned()
      const created = await this.store.writeExclusive(path, bytes, this.maxSourceBytes)
      return { path, bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex'), unchanged: !created }
    })
  }

  /** Refresh only plugin-managed index blocks while retaining user-authored surrounding content. */
  async rebuildIndex(execution: WikiOperationOptions = {}): Promise<void> {
    await this.skeleton()
    await withWikiLock(this.store, execution.signal, async assertOwned => { execution.signal?.throwIfAborted(); assertOwned(); await this.updateIndex(localDate(this.now())) })
  }

  private async available(): Promise<boolean> {
    try { await this.store.initialize(false); return true }
    catch (error) { if (missing(error)) return false; throw error }
  }

  private async skeleton(): Promise<void> {
    await this.store.initialize(this.options.autoInitialize)
    if (!this.options.autoInitialize) return
    for (const name of [...PAGE_DIRECTORIES, 'raw/articles', 'raw/files']) await this.store.ensureDirectory(name)
    await this.store.writeIfAbsent('SCHEMA.md', `${SCHEMA_TEMPLATE.trimEnd()}\n`)
    await this.store.writeIfAbsent('index.md', `${INDEX_TEMPLATE.trimEnd()}\n`)
    await this.store.writeIfAbsent('log.md', `${LOG_TEMPLATE.trimEnd()}\n`)
  }

  private async pages(): Promise<WikiPage[]> {
    const pages: WikiPage[] = []
    for (const directory of PAGE_DIRECTORIES) {
      let paths: string[]
      try { paths = await this.store.files(directory) } catch (error) { if (unreadable(error)) continue; throw error }
      for (const path of paths.filter(path => path.endsWith('.md'))) {
        const page = await this.page(path)
        if (page) pages.push(page)
      }
    }
    return pages.sort((a, b) => a.path.localeCompare(b.path))
  }

  private async validatePage(input: { body: string; tags: string[]; sources: string[]; confidence: WikiConfidence }): Promise<string> {
    if (!input.tags.length) return 'wiki page requires at least one taxonomy tag'
    const invalid = input.tags.filter(tag => !TAGS.has(tag))
    if (invalid.length) return `wiki tags outside SCHEMA taxonomy: ${invalid.join(', ')}`
    if (!['high', 'medium', 'low'].includes(input.confidence)) return 'wiki confidence must be high, medium, or low'
    if (Buffer.byteLength(input.body, 'utf8') > this.options.maxPageBytes) return 'wiki page exceeds wikiMaxPageBytes'
    const links = new Set([...input.body.matchAll(/\[\[([^\]|#]+)(?:#[^\]|]+)?(?:\|[^\]]+)?\]\]/g)].map(match => match[1]?.trim()).filter(Boolean))
    if (links.size < 2) return 'wiki page body requires at least two outbound [[wikilinks]]'
    if (input.confidence === 'high' && !input.sources.length) return 'high-confidence wiki pages require at least one raw source'
    for (const source of input.sources) {
      try {
        if (!source.startsWith('raw/') || this.store.normalize(source) !== source) return 'wiki source must be relative to raw/'
        if (!await this.store.info(source, this.maxSourceBytes)) return `wiki source does not exist: ${source}`
      } catch (error) { if (unreadable(error)) return `wiki source is not a safe bounded file: ${source}`; throw error }
    }
    return ''
  }

  private async recoverLocked(assertOwned: () => void, signal?: AbortSignal): Promise<WikiWriteResult[]> {
    const results: WikiWriteResult[] = []
    for (const intent of await this.journal.pending()) {
      if (signal?.aborted && results.length) break
      signal?.throwIfAborted()
      results.push(await this.finish(intent, assertOwned))
    }
    return results
  }

  private finish(intent: WikiWriteIntent, assertOwned: () => void): Promise<WikiWriteResult> {
    return recoverWikiWrite({ store: this.store, journal: this.journal, intent, assertOwned,
      rebuildIndex: date => this.updateIndex(date), appendLog: item => this.appendLog(item) })
  }

  private async updateIndex(date: string): Promise<void> {
    let text = await this.store.read('index.md') ?? INDEX_TEMPLATE
    const pages = await this.pages()
    for (const directory of PAGE_DIRECTORIES) {
      const start = `<!-- memosbox:${directory}:start -->`
      const end = `<!-- memosbox:${directory}:end -->`
      const lines = pages.filter(page => page.path.startsWith(`${directory}/`)).map(page => {
        const title = String(page.metadata.title ?? (firstHeading(page.body) || basename(page.path, '.md'))).replace(/[\r\n]/g, ' ').slice(0, 200)
        return `- [[${page.path.slice(0, -3)}]] - ${title}.`
      })
      const block = `${start}\n${lines.join('\n')}\n${end}`
      const startAt = text.indexOf(start)
      const endAt = text.indexOf(end, startAt)
      if (startAt >= 0 && endAt >= 0) text = text.slice(0, startAt) + block + text.slice(endAt + end.length)
      else {
        const heading = `## ${SECTIONS[directory]}`
        const position = text.indexOf(heading)
        if (position < 0) text = `${text.trimEnd()}\n\n${heading}\n\n${block}\n`
        else {
          const next = text.indexOf('\n## ', position + heading.length)
          const insertAt = next < 0 ? text.length : next
          text = `${text.slice(0, insertAt).trimEnd()}\n\n${block}\n${text.slice(insertAt)}`
        }
      }
    }
    const status = `> Last updated: ${date} | Total pages: ${pages.length}`
    const pattern = /^> Last updated: .* \| Total pages: \d+[ \t]*$/m
    text = pattern.test(text) ? text.replace(pattern, status) : `${text.trimEnd()}\n\n${status}\n`
    await this.store.write('index.md', `${text.trimEnd()}\n`)
  }

  private async appendLog(intent: WikiWriteIntent): Promise<void> {
    const current = await this.store.read('log.md') ?? LOG_TEMPLATE
    const marker = `<!-- memosbox-operation:${intent.operationId} -->`
    if (current.includes(marker)) return
    const entry = `\n## [${intent.date}] ${intent.action} | ${intent.path}\n\n${marker}\n- Managed by memosbox-dsh-plugin; page version \`${intent.version}\`.\n`
    await this.store.write('log.md', `${current.trimEnd()}\n${entry}`)
  }

  private defaultPagePath(input: WikiWriteInput): string {
    const directories: Record<WikiPageType, string> = { entity: 'entities', concept: 'concepts', comparison: 'comparisons', query: 'queries', summary: 'queries' }
    const title = input.title?.trim() || firstHeading(input.body) || 'untitled'
    const slug = title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || `page-${sha256(title).slice(0, 12)}`
    return `${directories[input.type ?? 'summary']}/${slug}.md`
  }
}

function failure(error: string): WikiWriteResult { return { ok: false, text: error, error } }
function conflict(path: string, expectedVersion: string, currentVersion: string, operationId: string): WikiWriteResult {
  return { ok: false, status: 409, state: 'conflict', path, wikiRelativePath: path, expectedVersion, currentVersion, operationId,
    text: 'Wiki page version conflict. Read the current page and review changes before retrying.', error: 'wiki page version conflict' }
}
function normalizeStrings(values: readonly string[]): string[] { return [...new Set(values.map(value => value.trim()).filter(Boolean))] }
function firstHeading(body: string): string { return body.split(/\r?\n/).find(line => line.startsWith('# '))?.slice(2).trim() ?? '' }
function searchTerms(query: string): string[] {
  const terms: string[] = []
  for (const term of query.toLowerCase().replace(/[\/|,，。]/g, ' ').split(/\s+/).filter(Boolean)) {
    terms.push(term)
    if (/[\u3400-\u9fff]/u.test(term) && [...term].length > 2) {
      const chars = [...term]
      for (let i = 0; i < chars.length - 1; i++) terms.push(`${chars[i]!}${chars[i + 1]!}`)
    }
  }
  return [...new Set(terms)]
}
/** Structured IDs and explicit project labels; exact tokens, not substrings.
 * Natural-language topics still use lexical discovery without body previews.
 */
export function explicitEntities(query: string): string[] {
  const structured = query.match(/[a-z][a-z0-9]*(?:-[a-z0-9]+)+/gi) ?? []
  const keys = structured.filter(key => /\d/.test(key) || /^(?:project|memory|client|customer|ticket|case|patient)-/i.test(key))
  for (const match of query.matchAll(/(?:项目|project)\s+([a-z][a-z0-9]*(?:[-_][a-z0-9]+)*)/gi)) {
    if (!['knowledge', 'wiki', 'status', 'convention'].includes(match[1]!.toLowerCase())) keys.push(match[1]!)
  }
  return [...new Set(keys.map(key => key.toLowerCase()))]
}
function scoreText(content: string, terms: readonly string[]): number {
  const lower = content.toLowerCase()
  let score = 0
  for (const term of terms) {
    let offset = 0
    while (term && (offset = lower.indexOf(term, offset)) >= 0) { score++; offset += term.length }
  }
  return score
}
function snippet(content: string, terms: readonly string[], size: number): string {
  const positions = terms.map(term => content.toLowerCase().indexOf(term)).filter(index => index >= 0)
  const start = positions.length ? Math.max(0, Math.min(...positions) - 160) : 0
  return content.slice(start, start + Math.max(128, Math.min(size, 20_000))).trim()
}
function boundedInteger(value: number, fallback: number, minimum: number, maximum: number): number { return Number.isInteger(value) ? Math.max(minimum, Math.min(maximum, value)) : fallback }
function localDate(date: Date): string { return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}` }
function missing(error: unknown): boolean { return error instanceof Error && 'code' in error && error.code === 'ENOENT' }
function unreadable(error: unknown): boolean { return error instanceof WikiFileError || missing(error) }
