import crypto from 'node:crypto'
import { z } from 'zod'

/** Exact operator-reviewed content, never a tool-name or path-prefix allow rule. */
export const approvalFileReviewSchema = z.object({
  requesterSessionId: z.string().min(1).max(128),
  projectId: z.string().min(1).max(128),
  repository: z.string().regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u),
  branch: z.string().min(1).max(256),
  path: z.string().min(1).max(1024),
  operation: z.enum(['create_file', 'update_file']),
  expectedBlobSha: z.string().regex(/^[a-f0-9]{40}$/u).nullable(),
  contentSha256: z.string().regex(/^[a-f0-9]{64}$/u),
  parametersSha256: z.string().regex(/^[a-f0-9]{64}$/u),
  // These are operator attestations about EXACT bytes and their repository context, not model claims.
  execution: z.literal('none'),
  credentials: z.literal('none'),
  publication: z.literal('repository-only'),
  destructive: z.literal(false),
  reviewReason: z.string().min(20).max(2000),
  expiresAt: z.string().datetime(),
}).strict()
export type ApprovalFileReview = z.infer<typeof approvalFileReviewSchema>

/** JSON request data only; stable across object-key ordering, exact for all values. */
export function reviewDigest(value: unknown): string {
  const canonical = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(canonical)
    if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).sort(([a], [b]) =>
      a < b ? -1 : a > b ? 1 : 0).map(([k, x]) => [k, canonical(x)]))
    return v
  }
  return crypto.createHash('sha256').update(JSON.stringify(canonical(value)) ?? 'undefined').digest('hex')
}

export interface FileReviewAssessment {
  status: 'eligible' | 'unsupported' | 'high-risk'
  reason: string
  repository?: string
  target?: { operation: string; branch: string; path: string; expectedBlobSha: string | null; contentSha256: string; parametersSha256: string }
}

const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)

/** Kept separate from the auto-approval classifier: this can ONLY feed an individual reviewer. */
export function assessGitHubFileReview(
  kind: string, payload: unknown, requesterSessionId: string, projectId: string | undefined,
  reviews: readonly ApprovalFileReview[] = [], now = Date.now(),
): FileReviewAssessment | undefined {
  if (kind !== 'codex/mcpServer/elicitation/request' || !object(payload)) return undefined
  const meta = payload._meta
  if (!object(meta) || meta.source !== 'connector' || meta.connector_name !== 'GitHub') return undefined
  const names = [meta.tool_name, meta.tool_title].filter(v => v !== undefined)
  if (!names.some(v => v === 'create_file' || v === 'update_file')) return undefined
  const unsupported = (reason: string): FileReviewAssessment => ({ status: 'unsupported', reason })
  if (payload.matchedAskRule) return unsupported('An explicit ask rule requires the operator.')
  if (payload.serverName !== 'codex_apps' || payload.mode !== 'form' ||
    meta.codex_approval_kind !== 'mcp_tool_call' || (meta.request_type !== undefined && meta.request_type !== 'approval_request') ||
    !object(payload.requestedSchema) || payload.requestedSchema.type !== 'object' ||
    !object(payload.requestedSchema.properties) || Object.keys(payload.requestedSchema.properties).length ||
    new Set(names).size !== 1 || !object(meta.tool_params)) return unsupported('Unsupported or ambiguous connector envelope.')
  const p = meta.tool_params
  // Unknown aliases/encodings/options cannot borrow the meaning of this reviewed grammar.
  const allowed = new Set(['repository_full_name', 'branch', 'path', 'content', 'sha', 'message'])
  if (Object.keys(p).some(k => !allowed.has(k))) return unsupported('Unsupported file parameters; exact connector semantics need review.')
  if (typeof p.repository_full_name !== 'string' || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u.test(p.repository_full_name) ||
    typeof p.branch !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_./-]{0,255}$/u.test(p.branch) || p.branch.includes('..') ||
    typeof p.path !== 'string' || !/^[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)*$/u.test(p.path) || p.path.split('/').some(x => x === '.' || x === '..') ||
    typeof p.content !== 'string' || Buffer.byteLength(p.content) > 64 * 1024 ||
    typeof p.message !== 'string' || !p.message.trim()) return unsupported('Missing exact repository, branch, path, bounded UTF-8 content or commit message.')
  const operation = names[0] as 'create_file' | 'update_file'
  const repository = p.repository_full_name.toLowerCase()
  if ((operation === 'update_file' && (typeof p.sha !== 'string' || !/^[a-f0-9]{40}$/u.test(p.sha))) ||
    (operation === 'create_file' && p.sha !== undefined)) return unsupported('Missing or ambiguous expected old-blob precondition.')
  const target = { operation, branch: p.branch, path: p.path, expectedBlobSha: (p.sha as string | undefined) ?? null,
    contentSha256: crypto.createHash('sha256').update(p.content, 'utf8').digest('hex'), parametersSha256: reviewDigest(p) }
  // These are blocking evidence, not a sufficient safe classifier. Even text that passes requires
  // operator-reviewed exact content + effects. Do not infer safety from the absence of these strings.
  if (/secrets\s*[.\[]|id-token\s*:\s*write|write-all|self-hosted|pull_request_target|\bsudo\b|\brm\s+-|\b(?:force|delete)[_-]?(?:push|repository)\b/iu.test(p.content)) {
    return { status: 'high-risk', reason: 'Credential, privileged-execution or destructive indicators require operator review.', repository, target }
  }
  // Executable workflow bodies, action references and expressions need a richer execution/context
  // contract. An operator content entry does not override this unsupported boundary.
  if (/\$\{\{|\b(?:run|uses|environment)\s*:/iu.test(p.content)) {
    return { status: 'unsupported', reason: 'Executable workflow/actions/expressions need pinned execution and credential/publication context; not supported by the no-execution contract.', repository, target }
  }
  const workflow = /^\.github\/workflows\/[A-Za-z0-9_.-]+\.ya?ml$/u.test(p.path)
  // No YAML interpretation or denylist-as-proof: only blank/comment-only workflow placeholders.
  // Quoted/escaped keys, anchors, tags and flow mappings cannot smuggle execution through a regex.
  if ((workflow && !p.content.split(/\r?\n/u).every(line => /^[ \t]*(?:#.*)?$/u.test(line))) ||
    (!workflow && !/^(?:docs\/)?[A-Za-z0-9_.\/-]+\.(?:md|txt)$/u.test(p.path))) {
    return { status: 'unsupported', reason: 'Only inert workflow placeholders or reviewed documentation text are supported; arbitrary YAML/config/code requires operator review.', repository, target }
  }
  const matched = reviews.some(raw => {
    const parsed = approvalFileReviewSchema.safeParse(raw)
    if (!parsed.success) return false
    const r = parsed.data
    return r.requesterSessionId === requesterSessionId && r.projectId === projectId &&
      r.repository.toLowerCase() === repository && r.operation === operation && r.branch === target.branch && r.path === target.path &&
      r.expectedBlobSha === target.expectedBlobSha && r.contentSha256 === target.contentSha256 &&
      r.parametersSha256 === target.parametersSha256 && Date.parse(r.expiresAt) > now
  })
  return { status: matched ? 'eligible' : 'unsupported', repository, target,
    reason: matched ? 'Exact operator-reviewed no-execution/no-credential/repository-only content contract; individual medium-risk review required.'
      : 'No current exact operator-reviewed content/effects contract. This is unsupported, not proof of high risk.' }
}
