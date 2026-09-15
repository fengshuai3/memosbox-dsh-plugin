import { createHash } from 'node:crypto'
import { WikiFileStore } from './file-store.js'

export const JOURNAL_ROOT = '.memosbox-journal'
const HASH = /^[a-f0-9]{64}$/
const OPERATION = /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/
const PAGE = /^(entities|concepts|comparisons|queries)\/[a-z0-9]+(?:-[a-z0-9]+)*\.md$/

/** Durable intent written before any page/index/log mutation. */
export interface WikiWriteIntent {
  readonly schemaVersion: 1
  readonly operationId: string
  readonly requestDigest: string
  readonly path: string
  readonly previousVersion: string
  readonly version: string
  readonly text: string
  readonly title: string
  readonly date: string
  readonly action: 'create' | 'update'
}

/** Compact completed-operation record retained for exact retries and cross-store reconciliation. */
export interface WikiWriteReceipt {
  readonly schemaVersion: 1
  readonly operationId: string
  readonly requestDigest: string
  readonly path: string
  readonly previousVersion: string
  readonly version: string
  readonly date: string
}

/** Persist bounded, validated write intents separately from completed receipts. */
export class WikiWriteJournal {
  private readonly maxIntentBytes: number
  constructor(private readonly store: WikiFileStore, private readonly maxPageBytes: number) {
    this.maxIntentBytes = maxPageBytes * 6 + 16_384
  }

  async initialize(): Promise<void> {
    await this.store.ensureDirectory(`${JOURNAL_ROOT}/pending`)
    await this.store.ensureDirectory(`${JOURNAL_ROOT}/receipts`)
  }

  async pending(): Promise<WikiWriteIntent[]> {
    const paths = await this.store.files(`${JOURNAL_ROOT}/pending`)
    const records: WikiWriteIntent[] = []
    for (const path of paths.filter(path => path.endsWith('.json'))) {
      const text = await this.store.read(path, this.maxIntentBytes)
      if (text === null) continue
      const record = this.parse(text, true) as WikiWriteIntent
      if (path !== this.path('pending', record.operationId)) throw new Error('Wiki journal filename does not match its operation')
      records.push(record)
    }
    return records
  }

  async receipt(operationId: string): Promise<WikiWriteReceipt | null> {
    const text = await this.store.read(this.path('receipts', operationId), 16_384)
    if (text === null) return null
    const receipt = this.parse(text, false) as WikiWriteReceipt
    if (receipt.operationId !== operationId) throw new Error('Wiki receipt operation mismatch')
    return receipt
  }

  async prepare(intent: WikiWriteIntent): Promise<void> {
    await this.initialize()
    await this.store.write(this.path('pending', intent.operationId), JSON.stringify(intent), this.maxIntentBytes)
  }

  async complete(intent: WikiWriteIntent): Promise<void> {
    const { text: _text, title: _title, action: _action, ...receipt } = intent
    await this.store.write(this.path('receipts', intent.operationId), JSON.stringify(receipt), 16_384)
    await this.store.remove(this.path('pending', intent.operationId))
  }

  private path(kind: 'pending' | 'receipts', operationId: string): string {
    if (!OPERATION.test(operationId)) throw new TypeError('operationId must be 1-128 ASCII letters, digits, dot, colon, underscore, or hyphen')
    return `${JOURNAL_ROOT}/${kind}/${sha256(operationId)}.json`
  }

  private parse(text: string, intent: boolean): WikiWriteIntent | WikiWriteReceipt {
    let value: unknown
    try { value = JSON.parse(text) } catch { throw new Error('Wiki journal contains invalid JSON') }
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Wiki journal is not an object')
    const item = value as Record<string, unknown>
    if (item.schemaVersion !== 1 || typeof item.operationId !== 'string' || !OPERATION.test(item.operationId)
      || typeof item.requestDigest !== 'string' || !HASH.test(item.requestDigest)
      || typeof item.path !== 'string' || !PAGE.test(item.path)
      || typeof item.previousVersion !== 'string' || (item.previousVersion !== 'absent' && !HASH.test(item.previousVersion))
      || typeof item.version !== 'string' || !HASH.test(item.version)
      || typeof item.date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(item.date)) {
      throw new Error('Wiki journal fields are invalid')
    }
    if (intent && (typeof item.text !== 'string' || Buffer.byteLength(item.text, 'utf8') > this.maxPageBytes
      || sha256(item.text) !== item.version || typeof item.title !== 'string' || item.title.length > 200
      || !['create', 'update'].includes(String(item.action)))) throw new Error('Wiki journal content is invalid')
    return item as unknown as WikiWriteIntent | WikiWriteReceipt
  }
}

/** Digest exact UTF-8 content without newline or numeric normalization. */
export function sha256(value: string): string { return createHash('sha256').update(value, 'utf8').digest('hex') }
