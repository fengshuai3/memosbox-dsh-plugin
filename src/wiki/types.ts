/** A normalized Wiki page type accepted by the governance layer. */
export type WikiPageType = 'entity' | 'concept' | 'comparison' | 'query' | 'summary'

/** Confidence recorded in a Wiki page's YAML frontmatter. */
export type WikiConfidence = 'high' | 'medium' | 'low'

/** JSON-safe page metadata returned to DSH tools. */
export interface WikiMetadata {
  readonly title?: string
  readonly created?: string
  readonly updated?: string
  readonly type?: string
  readonly tags?: readonly string[]
  readonly sources?: readonly string[]
  readonly confidence?: string
  readonly contested?: boolean
  readonly [key: string]: unknown
}

/** A bounded Wiki search result. */
export interface WikiHit {
  readonly source: 'wiki'
  readonly kind: string
  readonly id: string
  readonly score: number
  readonly title: string
  readonly content: string
  readonly path: string
  readonly metadata: WikiMetadata
  readonly matchKind?: 'entity-exact' | 'lexical-metadata-only'
  readonly requiresPageRead?: boolean
}

/** A complete Wiki page and its optimistic-concurrency version. */
export interface WikiPage {
  readonly path: string
  readonly wikiRelativePath: string
  readonly version: string
  readonly metadata: WikiMetadata
  readonly body: string
  readonly text: string
}

/** Input accepted by the governed Wiki writer. */
export interface WikiWriteInput {
  /** Stable caller-owned idempotency key; reuse exactly after an uncertain result. */
  readonly operationId?: string
  readonly path?: string
  readonly title?: string
  readonly type?: WikiPageType
  readonly tags?: readonly string[]
  readonly sources?: readonly string[]
  readonly confidence?: WikiConfidence
  readonly contested?: boolean
  readonly body: string
  readonly expectedVersion?: string
  readonly created?: string
}

/** Result returned by a governed Wiki write. */
export interface WikiWriteResult {
  readonly ok: boolean
  readonly text: string
  readonly path?: string
  readonly wikiRelativePath?: string
  readonly version?: string
  readonly unchanged?: boolean
  readonly status?: number
  readonly error?: string
  readonly expectedVersion?: string
  readonly currentVersion?: string
  readonly operationId?: string
  readonly state?: 'committed' | 'conflict' | 'recovery_required'
  readonly committed?: boolean
  readonly recoveryRequired?: boolean
}

/** Cancellation is honored before the durable write intent is committed. */
export interface WikiOperationOptions { readonly signal?: AbortSignal }

/** Receipt for an immutable raw source, scoped to the configured Wiki. */
export interface WikiRawSourceResult {
  readonly path: string
  readonly sha256: string
  readonly bytes: number
  readonly unchanged: boolean
}

/** Runtime settings owned by the Wiki adapter. */
export interface WikiAdapterOptions {
  readonly root: string
  readonly autoInitialize: boolean
  readonly maxPageBytes: number
  readonly maxSourceBytes?: number
  readonly now?: () => Date
}
