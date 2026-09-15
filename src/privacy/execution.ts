import type { ToolRunContext } from '@deepseek-ai/dsh-tools'

export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue }
export function requireAgent(exec: ToolRunContext): asserts exec is ToolRunContext & { agent: NonNullable<ToolRunContext['agent']> } {
  if (!exec.agent) throw new Error('AGENT_CONTEXT_REQUIRED')
}
export function requireWorkspace(cwd: string | undefined): string {
  if (!cwd?.trim()) throw new Error('WORKSPACE_CONTEXT_REQUIRED')
  return cwd
}
