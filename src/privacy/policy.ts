export interface PrivacyPolicy {
  readonly sensitiveMode: boolean
  readonly recallEnabled: boolean
  readonly captureEnabled: boolean
  readonly memoryToolsEnabled: boolean
  readonly queryLogEnabled: boolean
  readonly explicitMemoryWriteEnabled: boolean
}

/** A sensitive profile must never initialize an ordinary memory pipeline. */
export function effectiveMemoryPolicy(policy: PrivacyPolicy): PrivacyPolicy {
  return Object.freeze(policy.sensitiveMode ? {
    ...policy, recallEnabled: false, captureEnabled: false, memoryToolsEnabled: false,
    queryLogEnabled: false, explicitMemoryWriteEnabled: false,
  } : { ...policy })
}

export function assertNonSensitiveMode(sensitive: boolean): void {
  if (sensitive) throw new Error('SENSITIVE_MODE_UNAVAILABLE: host history and general-tool isolation have not passed release validation')
}

/** No query fragments, result fragments, exception text or user-supplied keys. */
export function metadataOnlyApiLog<T extends { input: unknown; output: unknown }>(row: T): T {
  return { ...row, input: { redacted: true }, output: { redacted: true } }
}
