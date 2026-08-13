/**
 * Provider-neutral capabilities that a project manager may grant to workers.
 *
 * Vendor APIs use different names for the same operation (Claude `Bash`, Codex
 * `commandExecution`). Persisting those names as policy made the effective grant depend on the
 * worker's provider. These canonical names are the durable policy vocabulary. Unknown names remain
 * exact grants so installed MCP/plugin tools can still be delegated without an application release.
 */
export const MANAGER_CAPABILITIES = [
  'shell',
  'file_write',
  'file_read',
  'web',
  'browser',
  'runs',
] as const

export type ManagerCapability = (typeof MANAGER_CAPABILITIES)[number]

const CAPABILITY_SET = new Set<string>(MANAGER_CAPABILITIES)

const TOOL_CAPABILITIES = new Map<string, ManagerCapability>([
  ['Bash', 'shell'],
  ['PowerShell', 'shell'],
  ['commandExecution', 'shell'],
  ['execCommandApproval', 'shell'],
  ['shell', 'shell'],

  ['Edit', 'file_write'],
  ['Write', 'file_write'],
  ['NotebookEdit', 'file_write'],
  ['fileChange', 'file_write'],
  ['file_write', 'file_write'],

  ['Read', 'file_read'],
  ['Glob', 'file_read'],
  ['Grep', 'file_read'],
  ['file_read', 'file_read'],

  ['WebFetch', 'web'],
  ['WebSearch', 'web'],
  ['web', 'web'],

  ['browser', 'browser'],
  ['runs', 'runs'],
])

function simpleToolName(value: string): string {
  const trimmed = value.trim()
  const mcp = /^mcp__[^_]+__(.+)$/.exec(trimmed)
  return mcp?.[1] ?? trimmed
}

/** Resolve a concrete provider/MCP tool name to its semantic capability when one is known. */
export function managerCapabilityForTool(value: string): ManagerCapability | undefined {
  const name = simpleToolName(value)
  const direct = TOOL_CAPABILITIES.get(name)
  if (direct) return direct
  if (/^browser(?:_|$)/i.test(name)) return 'browser'
  if (/^(?:start_run|inspect_runs|control_run)$/.test(name)) return 'runs'
  return undefined
}

/**
 * Canonicalize persisted/input grants. Known legacy provider names migrate to a capability; unknown
 * names retain exact-match semantics. Order is stable so journal/config diffs remain readable.
 */
export function normalizeManagerToolGrants(values: readonly string[]): string[] {
  const result: string[] = []
  const seen = new Set<string>()
  for (const value of values) {
    if (typeof value !== 'string') continue
    const trimmed = value.trim()
    if (!trimmed) continue
    const normalized = managerCapabilityForTool(trimmed) ?? trimmed
    if (seen.has(normalized)) continue
    seen.add(normalized)
    result.push(normalized)
  }
  return result
}

/** True when a capability/exact grant permits one concrete tool call. */
export function managerToolGrantCovers(grants: readonly string[] | undefined, toolName: string): boolean {
  if (!grants?.length) return false
  const concrete = toolName.trim()
  if (!concrete) return false
  const capability = managerCapabilityForTool(concrete)
  return grants.some((grant) => {
    const normalized = grant.trim()
    if (!normalized) return false
    if (normalized === concrete) return true
    if (capability && normalized === capability) return true
    // Read legacy records without requiring a boot-time database rewrite.
    return capability !== undefined && managerCapabilityForTool(normalized) === capability
  })
}

/** True when a requested capability/exact grant is contained by a manager or parent ceiling. */
export function managerGrantWithinCeiling(requested: string, ceiling: readonly string[] | undefined): boolean {
  const normalized = normalizeManagerToolGrants([requested])[0]
  if (!normalized) return false
  if (CAPABILITY_SET.has(normalized)) {
    return normalizeManagerToolGrants(ceiling ?? []).includes(normalized)
  }
  return managerToolGrantCovers(ceiling, normalized)
}

/** Intersect child grants with a newly narrowed semantic ceiling. */
export function narrowManagerToolGrants(
  grants: readonly string[] | undefined,
  ceiling: readonly string[] | undefined,
): { kept: string[]; revoked: string[] } {
  const normalized = normalizeManagerToolGrants(grants ?? [])
  return {
    kept: normalized.filter((grant) => managerGrantWithinCeiling(grant, ceiling)),
    revoked: normalized.filter((grant) => !managerGrantWithinCeiling(grant, ceiling)),
  }
}
