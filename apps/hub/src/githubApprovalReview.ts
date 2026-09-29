import crypto from 'node:crypto'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { isAlias, parseDocument, visit } from 'yaml'
import { z } from 'zod'
import { reviewDigest } from './approvalReview.js'

// Individual review adapters, deliberately NOT imported by the auto-approval classifier.
export const reviewCategories = ['github.branch.create', 'github.job.rerun', 'github.workflow.edit'] as const
export const reviewEffects = [
  'repository-write', 'execution', 'unrestricted-code', 'credentials', 'privileged-runner',
  'permission-change', 'publication', 'destructive', 'cancellation', 'dynamic-cost',
  'mutable-dependencies', 'untrusted-input', 'external-side-effects',
] as const
export type ReviewEffect = typeof reviewEffects[number]
export type ReviewRisk = 'low' | 'medium' | 'high'
export const repositorySchema = z.string().max(256).regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u)
  .refine(v => v.split('/').every(part => part !== '.' && part !== '..'))
const sha = z.string().regex(/^[a-f0-9]{40}$/u)
const branch = z.string().min(1).max(256).regex(/^[A-Za-z0-9][A-Za-z0-9_./-]*$/u)
  .refine(v => !v.includes('..') && !v.includes('//') && !v.endsWith('/') && !v.endsWith('.') &&
    v.split('/').every(p => !p.startsWith('.') && !p.endsWith('.lock')))
const workflowPath = z.string().regex(/^\.github\/workflows\/[A-Za-z0-9_.-]+\.ya?ml$/u)

/** Operator-owned review authority, not a resource grant or an automatic allow rule. */
export const approvalDelegationSchema = z.object({
  id: z.string().min(1).max(128), requesterSessionId: z.string().min(1).max(128),
  projectId: z.string().min(1).max(128), repository: repositorySchema,
  categories: z.array(z.enum(reviewCategories)).min(1).max(reviewCategories.length),
  branches: z.array(branch).min(1).max(32),
  workflowPaths: z.array(workflowPath).max(32),
  // Empty means any job within the other explicitly configured bounds, not any repository/run.
  jobIds: z.array(z.number().int().positive().max(Number.MAX_SAFE_INTEGER)).max(64),
  headShas: z.array(sha).max(32),
  maxRisk: z.enum(['low', 'medium', 'high']),
  allowedEffects: z.array(z.enum(reviewEffects)).max(reviewEffects.length),
  expiresAt: z.string().datetime(),
  disclosure: z.literal('Individual review only; effects may execute code, spend resources or publish data. Resource grants and platform limits still apply.'),
}).strict()
export type ApprovalDelegation = z.infer<typeof approvalDelegationSchema>

const common = { repository_full_name: repositorySchema }
const createBranch = z.object({ ...common, branch_name: branch, sha, base_ref: z.null().optional() }).strict()
const rerunJob = z.object({ repo_full_name: repositorySchema, job_id: z.number().int().positive().max(Number.MAX_SAFE_INTEGER) }).strict()
const writeFile = z.object({ ...common, branch, path: workflowPath, content: z.string().max(65536), message: z.string().min(1).max(2000), sha: sha.optional() }).strict()
export interface GitHubReviewRequest {
  operation: 'create_branch' | 'rerun_workflow_job' | 'create_file' | 'update_file'
  category: typeof reviewCategories[number]; repository: string
  branch?: string; path?: string; content?: string; expectedBlobSha?: string; headSha?: string; jobId?: number
  parametersSha256: string
}
const obj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)
export class ReviewEvidenceError extends Error {}
function requireValue(ok: unknown, message: string): asserts ok { if (!ok) throw new ReviewEvidenceError(message) }
export function parseGitHubReviewRequest(kind: string, payload: unknown): GitHubReviewRequest | undefined {
  if (kind !== 'codex/mcpServer/elicitation/request' || !obj(payload) || !obj(payload._meta)) return
  const m = payload._meta
  if (m.source !== 'connector' || m.connector_name !== 'GitHub') return
  const names = [m.tool_title, m.tool_name].filter(x => x !== undefined)
  if (!names.some(n => ['create_branch', 'rerun_workflow_job', 'create_file', 'update_file'].includes(String(n)))) return
  // Documentation text continues through the pre-existing inert-file review adapter.
  if (names.every(n => n === 'create_file' || n === 'update_file') && obj(m.tool_params) &&
      typeof m.tool_params.path === 'string' && !m.tool_params.path.startsWith('.github/workflows/')) return
  requireValue(!payload.matchedAskRule, 'An explicit ask rule requires the operator.')
  requireValue(payload.serverName === 'codex_apps' && payload.mode === 'form' && m.codex_approval_kind === 'mcp_tool_call' &&
    (m.request_type === undefined || m.request_type === 'approval_request') && new Set(names).size === 1 &&
    obj(payload.requestedSchema) && payload.requestedSchema.type === 'object' && obj(payload.requestedSchema.properties) &&
    Object.keys(payload.requestedSchema.properties).length === 0, 'Unsupported or ambiguous connector envelope.')
  const operation = names[0] as GitHubReviewRequest['operation']
  const parametersSha256 = reviewDigest(m.tool_params)
  if (operation === 'create_branch') {
    const p = createBranch.parse(m.tool_params)
    return { operation, category: 'github.branch.create', repository: p.repository_full_name.toLowerCase(), branch: p.branch_name, headSha: p.sha, parametersSha256 }
  }
  if (operation === 'rerun_workflow_job') {
    const p = rerunJob.parse(m.tool_params)
    return { operation, category: 'github.job.rerun', repository: p.repo_full_name.toLowerCase(), jobId: p.job_id, parametersSha256 }
  }
  const p = writeFile.parse(m.tool_params)
  requireValue(Buffer.byteLength(p.content) <= 65536 && (operation === 'update_file' ? !!p.sha : !p.sha), 'Missing old blob or oversized UTF-8 file.')
  return { operation, category: 'github.workflow.edit', repository: p.repository_full_name.toLowerCase(), branch: p.branch,
    path: p.path, content: p.content, expectedBlobSha: p.sha, parametersSha256 }
}

export type GitHubReviewApi = (repository: string, endpoint: string) => Promise<unknown>
const exec = promisify(execFile)
/** GET only, fixed GitHub host, no request-body/URL supplied by the model; uses existing gh auth. */
export const githubReviewApi: GitHubReviewApi = async (repository, endpoint) => {
  repositorySchema.parse(repository)
  const { stdout } = await exec(process.platform === 'win32' ? 'gh.exe' : 'gh',
    ['api', '--hostname', 'github.com', '--method', 'GET', `repos/${repository}/${endpoint}`],
    { encoding: 'utf8', windowsHide: true, timeout: 10_000, maxBuffer: 2 * 1024 * 1024 })
  return JSON.parse(stdout)
}
export const contentHash = (text: string) => crypto.createHash('sha256').update(text).digest('hex')
export const gitBlobHash = (text: string) => crypto.createHash('sha1').update(`blob ${Buffer.byteLength(text)}\0`).update(text).digest('hex')
export interface WorkflowSource { path: string; blobSha: string; text: string }
export interface GitHubReviewEvidence {
  repository: string; private: boolean; defaultBranch: string; defaultHead: string
  branch: string; headSha: string; branchExists: boolean
  workflows: WorkflowSource[]; defaultWorkflows: WorkflowSource[]
  job?: { id: number; name: string; runId: number; attempt: number; conclusion: string; event: string; path: string; actor: string; triggeringActor: string; headRepository: string }
}

/** Every source is immutable-commit addressed, hash checked, bounded and complete or rejected. */
export async function collectGitHubReviewEvidence(r: GitHubReviewRequest, api: GitHubReviewApi = githubReviewApi): Promise<GitHubReviewEvidence> {
  const deadline = Date.now() + 45_000
  const get = async (endpoint: string) => {
    requireValue(Date.now() < deadline, 'Evidence collection deadline; no decision issued.')
    const value = await api(r.repository, endpoint)
    requireValue(Date.now() < deadline, 'Evidence collection deadline; no decision issued.')
    return value
  }
  const repo = await get('')
  requireValue(obj(repo) && String(repo.full_name).toLowerCase() === r.repository && typeof repo.private === 'boolean' && typeof repo.default_branch === 'string', 'Repository evidence missing.')
  const reference = async (name: string) => {
    const refs = await get(`git/matching-refs/heads/${encodeURIComponent(branch.parse(name))}`)
    requireValue(Array.isArray(refs) && refs.length < 100, 'Incomplete branch reference evidence.')
    const exact = refs.filter(v => obj(v) && v.ref === `refs/heads/${name}`)
    requireValue(exact.length <= 1, 'Ambiguous branch reference.')
    if (!exact.length) return undefined
    requireValue(obj(exact[0].object) && exact[0].object.type === 'commit', 'Branch is not a commit.')
    return sha.parse(exact[0].object.sha)
  }
  const defaultHead = await reference(repo.default_branch)
  requireValue(defaultHead, 'Default branch missing.')
  let branchName = r.branch!, headSha = r.headSha!, job: GitHubReviewEvidence['job']
  if (r.jobId) {
    const j = await get(`actions/jobs/${r.jobId}`)
    requireValue(obj(j) && j.id === r.jobId && j.status === 'completed' && ['failure', 'timed_out', 'cancelled'].includes(String(j.conclusion)) &&
      Number.isSafeInteger(j.run_id) && Number(j.run_id) > 0 && Number.isSafeInteger(j.run_attempt) && Number(j.run_attempt) > 0 && typeof j.name === 'string', 'Job is not a completed failed/cancelled job with exact run/attempt identity.')
    const run = await get(`actions/runs/${j.run_id}`)
    requireValue(obj(run) && run.id === j.run_id && run.status === 'completed' && run.run_attempt === j.run_attempt && obj(run.repository) &&
      String(run.repository.full_name).toLowerCase() === r.repository && typeof run.head_branch === 'string' && obj(run.head_repository) &&
      obj(run.actor) && typeof run.actor.login === 'string' && obj(run.triggering_actor) && typeof run.triggering_actor.login === 'string' &&
      typeof run.event === 'string' && typeof run.path === 'string', 'Run identity, latest attempt, source or actor evidence incomplete/stale.')
    headSha = sha.parse(run.head_sha); branchName = branch.parse(run.head_branch)
    job = { id: r.jobId, name: j.name, runId: Number(j.run_id), attempt: Number(run.run_attempt), conclusion: String(j.conclusion),
      event: String(run.event), path: workflowPath.parse(run.path), actor: String(run.actor.login),
      triggeringActor: String(run.triggering_actor.login), headRepository: String(run.head_repository.full_name).toLowerCase() }
    requireValue(job.headRepository === r.repository, 'Fork-source reruns require separate source/authority evidence.')
  }
  const currentHead = await reference(branchName)
  if (r.operation === 'create_branch') requireValue(!currentHead, 'Branch already exists; overwrite is not branch creation.')
  else {
    requireValue(currentHead, 'Target branch disappeared.')
    if (job) requireValue(currentHead === headSha, 'Rerun head differs from current branch; fresh source review required.')
    else headSha = currentHead
  }
  let total = 0
  const sources = async (commit: string): Promise<WorkflowSource[]> => {
    const c = await get(`git/commits/${sha.parse(commit)}`)
    requireValue(obj(c) && c.sha === commit && obj(c.tree), 'Commit identity missing.')
    let treeSha = sha.parse(c.tree.sha)
    for (const dir of ['.github', 'workflows']) {
      const tree = await get(`git/trees/${treeSha}`)
      requireValue(obj(tree) && tree.truncated === false && Array.isArray(tree.tree), 'Incomplete Git tree.')
      const entry = tree.tree.find(e => obj(e) && e.path === dir)
      if (!entry) return []
      requireValue(obj(entry) && entry.type === 'tree', 'Workflow directory is not a tree.')
      treeSha = sha.parse(entry.sha)
    }
    const tree = await get(`git/trees/${treeSha}`)
    requireValue(obj(tree) && tree.truncated === false && Array.isArray(tree.tree) && tree.tree.length <= 32, 'Workflow inventory incomplete or exceeds 32 entries.')
    const result: WorkflowSource[] = []
    for (const e of tree.tree) {
      requireValue(obj(e) && typeof e.path === 'string', 'Invalid workflow tree entry.')
      if (!/\.ya?ml$/u.test(e.path)) continue
      requireValue(e.type === 'blob' && e.mode === '100644', 'Workflow must be a regular non-executable Git blob.')
      const p = workflowPath.parse(`.github/workflows/${e.path}`)
      const b = await get(`git/blobs/${sha.parse(e.sha)}`)
      requireValue(obj(b) && b.sha === e.sha && b.encoding === 'base64' && typeof b.content === 'string' && Number(b.size) <= 65536, 'Workflow blob missing/oversized.')
      const bytes = Buffer.from(b.content, 'base64'), text = bytes.toString('utf8')
      requireValue(bytes.length === b.size && Buffer.from(text).equals(bytes) && gitBlobHash(text) === e.sha, 'Workflow UTF-8/blob integrity failed.')
      total += bytes.length
      requireValue(total <= 192 * 1024, 'Workflow context exceeds complete review evidence limit.')
      result.push({ path: p, blobSha: String(e.sha), text })
    }
    return result.sort((a, b) => a.path.localeCompare(b.path))
  }
  const workflows = await sources(headSha)
  const defaultWorkflows = defaultHead === headSha ? workflows : await sources(defaultHead)
  if (r.operation === 'create_file') requireValue(!workflows.some(w => w.path === r.path), 'Workflow already exists.')
  if (r.operation === 'update_file') requireValue(workflows.find(w => w.path === r.path)?.blobSha === r.expectedBlobSha, 'Expected old blob changed or missing.')
  if (job) requireValue(workflows.some(w => w.path === job.path), 'Run workflow source missing.')
  // Bracket multi-read collection. Decision repeats collection and compares the complete digest.
  requireValue(await reference(repo.default_branch) === defaultHead && await reference(branchName) === currentHead, 'Branch changed during evidence collection.')
  if (job) {
    const run = await get(`actions/runs/${job.runId}`)
    requireValue(obj(run) && run.status === 'completed' && run.run_attempt === job.attempt && run.head_sha === headSha, 'Job run changed during evidence collection.')
  }
  return { repository: r.repository, private: repo.private, defaultBranch: repo.default_branch, defaultHead, branch: branchName,
    headSha, branchExists: !!currentHead, workflows, defaultWorkflows, ...(job ? { job } : {}) }
}

export function parseWorkflow(text: string): Record<string, unknown> {
  requireValue(Buffer.byteLength(text) <= 65536, 'Workflow too large.')
  const doc = parseDocument(text, { version: '1.2', uniqueKeys: true, stringKeys: true, strict: true })
  requireValue(!doc.errors.length && !doc.warnings.length && doc.directives.yaml.version === '1.2', 'Invalid/ambiguous YAML.')
  let count = 0
  visit(doc, (_key, node) => {
    requireValue(++count < 10000 && !isAlias(node) && !(node && typeof node === 'object' && ('anchor' in node && node.anchor || 'tag' in node && node.tag)), 'YAML aliases/tags/anchors or excessive nodes require separate review support.')
  })
  const value: unknown = doc.toJS({ maxAliasCount: 0 })
  requireValue(obj(value) && obj(value.jobs), 'Executable workflow requires a jobs mapping.')
  const keys = (v: Record<string, unknown>, allowed: string[], label: string) => requireValue(Object.keys(v).every(k => allowed.includes(k)), `Unsupported ${label} field; effects are unknown.`)
  keys(value, ['name', 'run-name', 'on', 'permissions', 'env', 'defaults', 'concurrency', 'jobs'], 'workflow')
  for (const raw of Object.values(value.jobs)) {
    requireValue(obj(raw), 'Invalid workflow job.')
    keys(raw, ['name', 'needs', 'if', 'runs-on', 'environment', 'concurrency', 'outputs', 'env', 'defaults', 'steps', 'timeout-minutes',
      'strategy', 'continue-on-error', 'container', 'services', 'uses', 'with', 'secrets', 'permissions'], 'job')
    if (raw.steps !== undefined) {
      requireValue(Array.isArray(raw.steps), 'Invalid workflow steps.')
      for (const step of raw.steps) {
        requireValue(obj(step), 'Invalid workflow step.')
        keys(step, ['name', 'id', 'if', 'uses', 'run', 'working-directory', 'shell', 'with', 'env', 'continue-on-error', 'timeout-minutes'], 'step')
      }
    }
  }
  return value
}
export interface StructuralChange { path: string; before?: unknown; after?: unknown }
export function structuralDiff(a: unknown, b: unknown, path = ''): StructuralChange[] {
  if (reviewDigest(a) === reviewDigest(b)) return []
  if (obj(a) && obj(b)) return [...new Set([...Object.keys(a), ...Object.keys(b)])].sort().flatMap(k =>
    structuralDiff(a[k], b[k], `${path}/${k.replace(/~/gu, '~0').replace(/\//gu, '~1')}`))
  return [{ path: path || '/', ...(a === undefined ? {} : { before: a }), ...(b === undefined ? {} : { after: b }) }]
}

/** Conservative effects, never a denylist-as-proof. Any shell/action execution is high risk:
 * arbitrary programs can access credentials, delete files and publish; reviewer must accept that
 * entire effect category explicitly. We do not pretend to statically prove arbitrary code safe. */
export function workflowEffects(value: Record<string, unknown>): { effects: ReviewEffect[]; surface: unknown } {
  const effects = new Set<ReviewEffect>()
  const rendered = JSON.stringify(value)
  const jobs = value.jobs as Record<string, unknown>
  const surface: Record<string, unknown> = { events: value.on ?? null, permissions: value.permissions ?? 'repository-default (ambient)', concurrency: value.concurrency ?? null, jobs: Object.create(null) }
  if (value.permissions === undefined || /secrets\b|github\.token|id-token|write-all|"write"/iu.test(rendered)) effects.add('credentials')
  if (/pull_request_target|workflow_run/iu.test(JSON.stringify(value.on)) || /\$\{\{/u.test(rendered)) effects.add('untrusted-input')
  if (value.concurrency) effects.add('cancellation')
  for (const [id, raw] of Object.entries(jobs)) {
    requireValue(obj(raw), 'Invalid workflow job.')
    ;(surface.jobs as Record<string, unknown>)[id] = raw
    // Unknown/custom labels and runner groups are NOT proof of hosted isolation. A self-hosted
    // machine need not advertise the literal "self-hosted" label in the workflow selector.
    if (typeof raw['runs-on'] !== 'string' || !['ubuntu-latest', 'windows-latest', 'macos-latest'].includes(raw['runs-on'])) effects.add('privileged-runner')
    if (raw.environment || raw.secrets || raw.permissions) effects.add('credentials')
    if (raw.container || raw.services) { effects.add('execution'); effects.add('unrestricted-code'); effects.add('privileged-runner'); effects.add('mutable-dependencies'); effects.add('external-side-effects') }
    if (raw.concurrency) effects.add('cancellation')
    if (raw.strategy || typeof raw['timeout-minutes'] !== 'number') effects.add('dynamic-cost')
    if (raw.uses || Array.isArray(raw.steps) && raw.steps.some(s => obj(s) && ('run' in s || 'uses' in s))) {
      effects.add('execution'); effects.add('unrestricted-code')
      // This broad effect requires explicit delegation, not just permission to click/rerun.
      effects.add('external-side-effects')
    }
    if (/"uses"\s*:\s*"(?![^"@]+@[a-f0-9]{40}")/u.test(JSON.stringify(raw))) effects.add('mutable-dependencies')
    if (/\bsudo\b|--privileged|privileged\s*:/iu.test(JSON.stringify(raw))) effects.add('privileged-runner')
    if (/\brm\s+-|Remove-Item|\bdelete\b|--force|\breset\s+--hard/iu.test(JSON.stringify(raw))) effects.add('destructive')
    if (/publish|deploy|release|upload|push/iu.test(JSON.stringify(raw))) effects.add('publication')
  }
  if (effects.has('unrestricted-code')) {
    // These are POSSIBLE effects of arbitrary programs, even without a recognizable keyword.
    // A policy excluding destructive/credential/publication effects must not accidentally delegate
    // arbitrary code merely by allowing the execution label.
    effects.add('destructive'); effects.add('credentials'); effects.add('publication'); effects.add('external-side-effects')
  }
  return { effects: [...effects].sort(), surface }
}

export interface GitHubReviewAssessment {
  eligible: boolean; code: string; reason: string; risk?: ReviewRisk; effects?: ReviewEffect[]
  ruleId?: string; evidenceDigest?: string; evidence?: unknown
}
export function assessGitHubReview(r: GitHubReviewRequest, source: GitHubReviewEvidence, payload: unknown,
  requesterSessionId: string, projectId: string | undefined, rules: readonly ApprovalDelegation[], now = Date.now()): GitHubReviewAssessment {
  requireValue(source.repository === r.repository && source.branch === (r.branch ?? source.branch), 'Evidence target mismatch.')
  const effects = new Set<ReviewEffect>(r.category === 'github.job.rerun' ? ['execution'] : ['repository-write'])
  const contexts = [...source.workflows.map(w => ({ ...w, lane: 'target' })), ...source.defaultWorkflows.map(w => ({ ...w, lane: 'default' }))]
  const inventory = contexts.map(w => {
    requireValue(gitBlobHash(w.text) === w.blobSha, 'Source blob integrity failed.')
    const parsed = parseWorkflow(w.text), analysis = workflowEffects(parsed)
    // All workflows are included: branch/contents writes can trigger push/create and reruns can
    // trigger workflow_run workflows/dependent jobs. Never silently analyze only the requested job.
    analysis.effects.forEach(e => effects.add(e))
    return { ...w, sha256: contentHash(w.text), ...analysis }
  })
  let change: unknown
  if (r.content !== undefined) {
    const before = source.workflows.find(w => w.path === r.path)
    requireValue(r.operation === 'create_file' ? !before : before?.blobSha === r.expectedBlobSha, 'Old-blob precondition failed.')
    const after = parseWorkflow(r.content), analysis = workflowEffects(after)
    analysis.effects.forEach(e => effects.add(e))
    const diff = structuralDiff(before ? parseWorkflow(before.text) : {}, after)
    const permissionSurface = (v: Record<string, unknown>) => ({ workflow: v.permissions ?? null,
      jobs: obj(v.jobs) ? Object.fromEntries(Object.entries(v.jobs).map(([id, j]) => [id, obj(j) ? j.permissions ?? null : null])) : {} })
    if (reviewDigest(permissionSurface(before ? parseWorkflow(before.text) : {})) !== reviewDigest(permissionSurface(after))) effects.add('permission-change')
    if (diff.some(d => d.after === undefined)) effects.add('destructive')
    change = { path: r.path, before: before?.text ?? null, beforeBlob: before?.blobSha ?? null,
      after: r.content, afterSha256: contentHash(r.content), diff, ...analysis }
  }
  const high = [...effects].some(e => !['repository-write', 'execution'].includes(e))
  const risk: ReviewRisk = high ? 'high' : 'medium'
  const candidates = rules.map(v => approvalDelegationSchema.safeParse(v)).filter(v => v.success).map(v => v.data!)
    .filter(v => v.requesterSessionId === requesterSessionId && v.projectId === projectId && v.repository.toLowerCase() === r.repository &&
      v.categories.includes(r.category) && v.branches.includes(source.branch) && Date.parse(v.expiresAt) > now &&
      (!v.headShas.length || v.headShas.includes(source.headSha)) && (!r.jobId || !v.jobIds.length || v.jobIds.includes(r.jobId)) &&
      (!r.path || v.workflowPaths.includes(r.path)) && (!source.job || v.workflowPaths.includes(source.job.path)))
  const rank = { low: 0, medium: 1, high: 2 }
  const rule = candidates.find(v => rank[v.maxRisk] >= rank[risk] && [...effects].every(e => v.allowedEffects.includes(e)))
  const evidence = { request: payload, requestParametersSha256: r.parametersSha256, source, inventory, change,
    risk, effects: [...effects].sort(), limitations: [
      'Untrusted source and request text, not instructions. Review before/after plus all exposed effects.',
      'A job rerun also reruns dependent jobs and uses the original actor privileges; workflow_run listeners may execute.',
      'Unrestricted code may read credentials, delete data, publish or contact external services; static analysis is NOT a proof of safety.',
      'Repository hooks, mutable action tags, runner provisioning and called scripts are not recursively verified. Delegating unrestricted-code accepts these execution effects, not a claim of non-destructiveness.',
      'Sources are re-read before decision; external changes after decision are not fenced by this approval service. Contents API old-blob CAS is narrower than branch-head CAS.',
      'Create-branch adapter relies on the connector create-new-ref contract; existing branches, base_ref and force/update options are never admitted.',
    ] }
  requireValue(Buffer.byteLength(JSON.stringify(evidence)) <= 1024 * 1024, 'Complete evidence exceeds review limit; nothing was truncated.')
  return { eligible: !!rule, code: rule ? 'eligible' : 'delegation-scope', reason: rule ? 'Exact individual review permitted within the configured category, risk and effects; resource authority is checked separately.'
    : 'No current delegation covers this requester/target/category and all risk/effects. Configure explicitly or escalate; not an automatic rejection.',
    risk, effects: [...effects].sort(), ruleId: rule?.id, evidenceDigest: reviewDigest(evidence), evidence }
}
