import type { SandboxPolicyRequest } from '@deepseek-ai/dsh-sandbox-policy'

/** Versioned, one-request/one-response protocol; raw measurements stay strings. */
export type MirobodyOperation = 'status' | 'resolve' | 'normalize_readings' | 'metric_info' | 'extract_document'
export type MirobodyStatus = 'ready' | 'needs_ocr' | 'partial' | 'unresolved' | 'refused' | 'failed' | 'unavailable' | 'canceled'

export interface EvidenceLocation {
  page?: number
  sheet?: string
  row?: number
  column?: number
  line?: number
  endLine?: number
  bbox?: 'unavailable'
}

export interface DocumentSegment {
  id: string
  text: string
  location: EvidenceLocation
  status: 'ready' | 'needs_ocr' | 'failed'
  digest: string
  provenance?: { cellDataType: string; numberFormat: string; originalDisplayAvailable: false }
}

export interface RawReading {
  rawName: string
  rawValue?: string
  rawUnit?: string
  evidenceRefs?: string[]
}

export interface NormalizedReading extends RawReading {
  status: 'ready' | 'unresolved' | 'refused'
  normalizedValue: string
  normalizedUnit: string
  resolutionMethod: string
  codeSystem: string
  code: string
  canonical: string
  candidates: number
  bundleVersion: string
  evidenceRefs: string[]
  warnings: string[]
}

export interface MirobodyResponse {
  schemaVersion: 1
  operationId: string
  operation: MirobodyOperation
  status: MirobodyStatus
  bundleVersion: string
  warnings: string[]
  truncated: boolean
  sourceDigest?: string
  readings?: NormalizedReading[]
  segments?: DocumentSegment[]
  metric?: Record<string, unknown> | null
  runtime?: {
    pythonVersion: string
    mirobodyVersion: string
    bundleSha256: string
    deviceCatalogVersion: string
    deviceCatalogSha256: string
    network: 'blocked'
    isolation: 'macos-seatbelt-probed' | 'unverified'
    supportedOperations: MirobodyOperation[]
    limitations?: string[]
  }
  error?: { code: string; message: string }
}

export interface MirobodyExecuteOptions {
  signal?: AbortSignal
  session?: SandboxPolicyRequest['session']
}

export interface MirobodyProviderConfig {
  /** Explicitly provisioned runtime root, containing active-runtime.json. Never installed during execute. */
  runtimeRoot: string
  /** Private, non-business work directory; each job is removed after whole-tree exit. */
  workRoot: string
  /** Defaults to the worker shipped beside dist, not a model-selectable program. */
  workerPath?: string
  localTimeoutMs?: number
  documentTimeoutMs?: number
  maxInputBytes?: number
  maxOutputBytes?: number
  maxFileBytes?: number
  maxPdfPages?: number
  maxRows?: number
  maxBatch?: number
}

export interface MirobodyExecutor {
  execute(operation: MirobodyOperation, payload: Record<string, unknown>, options?: MirobodyExecuteOptions): Promise<MirobodyResponse>
  status(options?: MirobodyExecuteOptions): Promise<MirobodyResponse>
  dispose(): Promise<void>
}
