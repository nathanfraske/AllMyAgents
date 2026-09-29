import fs from 'node:fs'
import { describe, expect, it, vi } from 'vitest'
import { reviewDigest } from './approvalReview.js'
import { classifyGitHubAutomationApproval } from './githubAutomationPolicy.js'
import { approvalDelegationSchema, assessGitHubReview, collectGitHubReviewEvidence, contentHash, gitBlobHash,
  parseGitHubReviewRequest, parseWorkflow, reviewEffects, structuralDiff, workflowEffects,
  type GitHubReviewApi, type GitHubReviewEvidence, type ApprovalDelegation } from './githubApprovalReview.js'
import { applyOverseerApprovalPolicyUpdate } from './overseerApprovalPolicy.js'

export const kind = 'codex/mcpServer/elicitation/request'
export const commitSha = 'e3ccac47d74128d06e4c4d671fc896e3c29938c9'
export const workflow = 'on: workflow_dispatch\npermissions: {}\njobs:\n  test:\n    runs-on: ubuntu-latest\n    timeout-minutes: 5\n    steps:\n      - run: |\n          echo qualified\n'
export function envelope<T>(operation: string, params: T) {
  return { serverName: 'codex_apps', mode: 'form', requestedSchema: { type: 'object', properties: {} },
    _meta: { source: 'connector', connector_name: 'GitHub', codex_approval_kind: 'mcp_tool_call', tool_title: operation, tool_params: params } }
}
export function rule(overrides: Partial<ApprovalDelegation> = {}): ApprovalDelegation {
  return { id: 'operator-delegation', requesterSessionId: 'arnold', projectId: 'project', repository: 'acme/widget',
    categories: ['github.branch.create', 'github.job.rerun', 'github.workflow.edit'], branches: ['fleet/test'],
    workflowPaths: ['.github/workflows/ci.yml'], headShas: [commitSha], jobIds: [108563413279],
    maxRisk: 'high', allowedEffects: [...reviewEffects], expiresAt: new Date(Date.now() + 3600_000).toISOString(),
    disclosure: 'Individual review only; effects may execute code, spend resources or publish data. Resource grants and platform limits still apply.', ...overrides }
}
export function source(text = workflow): GitHubReviewEvidence {
  return { repository: 'acme/widget', private: true, defaultBranch: 'main', defaultHead: commitSha, branch: 'fleet/test',
    headSha: commitSha, branchExists: true, workflows: [{ path: '.github/workflows/ci.yml', blobSha: gitBlobHash(text), text }], defaultWorkflows: [] }
}
export function fakeApi(options: { exists?: boolean; text?: string; repository?: string; branch?: string } = {}): GitHubReviewApi {
  const text = options.text ?? workflow, blob = gitBlobHash(text), repository = options.repository ?? 'acme/widget', name = options.branch ?? 'fleet/test'
  return vi.fn(async (_repo, endpoint) => {
    if (endpoint === '') return { full_name: repository, private: true, default_branch: 'main' }
    if (endpoint.startsWith('git/matching-refs/heads/')) {
      const ref = decodeURIComponent(endpoint.split('/').at(-1)!)
      return ref === 'main' || ref === name && options.exists !== false ? [{ ref: `refs/heads/${ref}`, object: { type: 'commit', sha: commitSha } }] : []
    }
    if (endpoint === `git/commits/${commitSha}`) return { sha: commitSha, tree: { sha: '1'.repeat(40) } }
    if (endpoint === `git/trees/${'1'.repeat(40)}`) return { truncated: false, tree: [{ path: '.github', type: 'tree', sha: '2'.repeat(40) }] }
    if (endpoint === `git/trees/${'2'.repeat(40)}`) return { truncated: false, tree: [{ path: 'workflows', type: 'tree', sha: '3'.repeat(40) }] }
    if (endpoint === `git/trees/${'3'.repeat(40)}`) return { truncated: false, tree: [{ path: 'ci.yml', mode: '100644', type: 'blob', sha: blob }] }
    if (endpoint === `git/blobs/${blob}`) return { sha: blob, size: Buffer.byteLength(text), encoding: 'base64', content: Buffer.from(text).toString('base64') }
    if (endpoint === 'actions/jobs/108563413279') return { id: 108563413279, run_id: 36299140037, run_attempt: 1, status: 'completed', conclusion: 'failure', name: 'test' }
    if (endpoint === 'actions/runs/36299140037') return { id: 36299140037, run_attempt: 1, status: 'completed', repository: { full_name: repository }, head_repository: { full_name: repository }, head_sha: commitSha,
      head_branch: name, actor: { login: 'original' }, triggering_actor: { login: 'retry' }, path: '.github/workflows/ci.yml', event: 'workflow_dispatch' }
    throw new Error(`Unexpected GET ${endpoint}`)
  })
}

describe('configurable individual GitHub review (offline, no approvals or GitHub writes)', () => {
  it('permits bounded branch creation at medium when complete source inventories contain no execution', () => {
    const p = envelope('create_branch', { repository_full_name: 'acme/widget', branch_name: 'fleet/test', sha: commitSha })
    const r = parseGitHubReviewRequest(kind, p)!
    const s = { ...source(), branchExists: false, workflows: [], defaultWorkflows: [] }
    expect(assessGitHubReview(r, s, p, 'arnold', 'project', [rule({ maxRisk: 'medium', allowedEffects: ['repository-write'] })]))
      .toMatchObject({ eligible: true, risk: 'medium', effects: ['repository-write'] })
  })
  it('qualifies actual connector aliases/shapes without widening auto-approval', () => {
    const fixtures = [envelope('create_branch', { repository_full_name: 'nathanfraske/AllMyAgents', branch_name: 'fleet/qualify-atc-pool-v2', sha: commitSha }),
      envelope('rerun_workflow_job', { repo_full_name: 'nathanfraske/AllMyAgents', job_id: 108563413279 })]
    for (const p of fixtures) { expect(parseGitHubReviewRequest(kind, p)).toBeDefined(); expect(classifyGitHubAutomationApproval(kind, p)).toBeUndefined() }
    for (const params of [{ repository_full_name: 'acme/widget', branch_name: 'fleet/test', base_ref: 'main' },
      { repository_full_name: 'acme/widget', branch_name: 'fleet/test', sha: commitSha, force: true }]) {
      expect(() => parseGitHubReviewRequest(kind, envelope('create_branch', params))).toThrow()
    }
    expect(() => parseGitHubReviewRequest(kind, envelope('rerun_workflow_job', { repository_full_name: 'acme/widget', job_id: 108563413279 }))).toThrow()
    expect(() => parseGitHubReviewRequest(kind, envelope('rerun_workflow_job', { repo_full_name: 'acme/widget', job_id: 1, enable_debug_logging: true }))).toThrow()
  })
  it('requires separate explicit category/risk/effects and preserves source/request hashes', () => {
    const p = envelope('update_file', { repository_full_name: 'acme/widget', branch: 'fleet/test', path: '.github/workflows/ci.yml', sha: gitBlobHash(workflow), content: workflow.replace('echo qualified', 'echo changed'), message: 'review' })
    const r = parseGitHubReviewRequest(kind, p)!
    const assess = (rules: ApprovalDelegation[]) => assessGitHubReview(r, source(), p, 'arnold', 'project', rules)
    expect(assess([rule({ maxRisk: 'medium' })])).toMatchObject({ eligible: false, risk: 'high' })
    expect(assess([rule({ allowedEffects: ['repository-write'] })]).eligible).toBe(false)
    expect(assess([rule({ allowedEffects: reviewEffects.filter(e => e !== 'destructive') })]).eligible).toBe(false)
    expect(assess([rule()])).toMatchObject({ eligible: true, risk: 'high', effects: expect.arrayContaining(['execution', 'unrestricted-code']) })
    expect(assess([]).eligible).toBe(false)
    expect(assess([rule({ requesterSessionId: 'other' })]).eligible).toBe(false)
    expect(assess([rule({ repository: 'acme/other' })]).eligible).toBe(false)
    expect(assess([rule({ expiresAt: new Date(0).toISOString() })]).eligible).toBe(false)
    const changed = structuredClone(p); changed._meta.tool_params.content += '# changed\n'
    expect(assessGitHubReview(parseGitHubReviewRequest(kind, changed)!, source(), changed, 'arnold', 'project', [rule()]).evidenceDigest).not.toBe(assess([rule()]).evidenceDigest)
  })
  it('treats custom runner labels as privileged and catches permissions introduced inside an entire new job', () => {
    expect(workflowEffects(parseWorkflow(workflow.replace('ubuntu-latest', 'production-pool'))).effects).toContain('privileged-runner')
    const after = workflow + '  new:\n    permissions: write-all\n    runs-on: ubuntu-latest\n    steps: []\n'
    const p = envelope('update_file', { repository_full_name: 'acme/widget', branch: 'fleet/test', path: '.github/workflows/ci.yml', sha: gitBlobHash(workflow), content: after, message: 'new job' })
    expect(assessGitHubReview(parseGitHubReviewRequest(kind, p)!, source(), p, 'arnold', 'project', [rule({ allowedEffects: reviewEffects.filter(e => e !== 'permission-change') })]))
      .toMatchObject({ eligible: false, effects: expect.arrayContaining(['permission-change']) })
  })
  it.each(['secrets.TOKEN', 'self-hosted', 'permissions: write-all', 'rm -rf /tmp/test', 'environment: production'])(
    'never admits new hazardous effects under non-destructive low/medium policy: %s', fragment => {
      const effects = workflowEffects(parseWorkflow(workflow.replace('echo qualified', `echo '${fragment}'`))).effects
      expect(effects).toContain('unrestricted-code')
      const p = envelope('create_file', { repository_full_name: 'acme/widget', branch: 'fleet/test', path: '.github/workflows/new.yml', content: workflow.replace('echo qualified', `echo '${fragment}'`), message: 'new' })
      expect(assessGitHubReview(parseGitHubReviewRequest(kind, p)!, source(), p, 'arnold', 'project', [rule({ maxRisk: 'medium', workflowPaths: ['.github/workflows/new.yml'] })]).eligible).toBe(false)
    })
  it.each(['jobs: {x: {}, x: {}}', 'jobs: &x {a: {}}\nextra: *x', 'jobs: !!map {}', 'jobs: {}\n---\njobs: {}', '%YAML 1.1\n---\njobs: {}'])(
    'rejects ambiguous YAML rather than relying on keyword absence: %s', text => expect(() => parseWorkflow(text)).toThrow())
  it('verifies the exact exported workflow and shows executable diff without laundering it to medium', () => {
    const fixture = JSON.parse(fs.readFileSync(new URL('./fixtures/github-workflow-review.json', import.meta.url), 'utf8'))
    const before = Buffer.from(fixture.before.content, 'base64').toString('utf8')
    const p = fixture.request.payload, r = parseGitHubReviewRequest(kind, p)!
    expect(gitBlobHash(before)).toBe('05209a6a500cafdaccee8653971779523d21b466')
    expect(contentHash(r.content!)).toBe('70e055c92ceed8b448606a3e245a57bbeb7c6591ef2b95892de1344fc430b92f')
    expect(r.parametersSha256).toBe('595ab30e3fa7bacf66a7012f76d1125aa25e1a2b417a79462c42c336b508229b')
    const diff = structuralDiff(parseWorkflow(before), parseWorkflow(r.content!))
    expect(diff.map(d => d.path)).toEqual(['/jobs/gates/strategy/matrix/repeat', '/jobs/rust/strategy/matrix/repeat', '/on/workflow_dispatch/inputs/stress_copies'])
    const s = { ...source(before), repository: r.repository, branch: r.branch! }
    const rules = [rule({ requesterSessionId: fixture.request.sessionId, repository: r.repository, branches: [r.branch!] })]
    const assessed = assessGitHubReview(r, s, p, fixture.request.sessionId, 'project', rules)
    expect(assessed).toMatchObject({ eligible: true, risk: 'high', effects: expect.arrayContaining(['privileged-runner', 'credentials', 'dynamic-cost', 'cancellation', 'mutable-dependencies']) })
    expect(reviewDigest(assessed.evidence)).toBe(assessed.evidenceDigest)
  })
  it('collects and brackets source read-only; new branch and job rerun cannot borrow another target', async () => {
    const p = envelope('create_branch', { repository_full_name: 'acme/widget', branch_name: 'fleet/test', sha: commitSha })
    const r = parseGitHubReviewRequest(kind, p)!
    await expect(collectGitHubReviewEvidence(r, fakeApi())).rejects.toThrow('already exists')
    expect(await collectGitHubReviewEvidence(r, fakeApi({ exists: false }))).toMatchObject({ branchExists: false, headSha: commitSha })
    const j = envelope('rerun_workflow_job', { repo_full_name: 'acme/widget', job_id: 108563413279 }), jr = parseGitHubReviewRequest(kind, j)!
    const evidence = await collectGitHubReviewEvidence(jr, fakeApi())
    expect(evidence.job).toMatchObject({ attempt: 1, actor: 'original', triggeringActor: 'retry' })
    expect(assessGitHubReview(jr, evidence, j, 'arnold', 'project', [rule()]).eligible).toBe(true)
    expect(assessGitHubReview(jr, evidence, j, 'arnold', 'project', [rule({ jobIds: [2] })]).eligible).toBe(false)
  })
  it.each(['truncated', 'integrity', 'stale-attempt', 'fork', 'source-change', 'api-failure'])(
    'fails closed with missing/concurrent evidence: %s', async failure => {
      const base = fakeApi(); let refs = 0
      const api: GitHubReviewApi = async (repo, endpoint) => {
        const v = await base(repo, endpoint) as any
        if (failure === 'api-failure') throw new Error('no access')
        if (failure === 'truncated' && endpoint.startsWith('git/trees/')) v.truncated = true
        if (failure === 'integrity' && endpoint.startsWith('git/blobs/')) v.content = Buffer.from('wrong').toString('base64')
        if (failure === 'stale-attempt' && endpoint.startsWith('actions/runs/')) v.run_attempt = 2
        if (failure === 'fork' && endpoint.startsWith('actions/runs/')) v.head_repository.full_name = 'other/fork'
        if (failure === 'source-change' && endpoint.startsWith('git/matching-refs/heads/')) { if (++refs > 2) v[0].object.sha = 'a'.repeat(40) }
        return v
      }
      await expect(collectGitHubReviewEvidence(parseGitHubReviewRequest(kind, envelope('rerun_workflow_job', { repo_full_name: 'acme/widget', job_id: 108563413279 }))!, api)).rejects.toThrow()
    })
  it('operator settings validate and revoke independently; guidance cannot stand in for delegation', () => {
    const config = applyOverseerApprovalPolicyUpdate({}, { enabled: true, maxRisk: 'high', requesterSessionIds: ['arnold'], delegations: [rule()] })
    expect(config.approvalPolicy?.delegations).toHaveLength(1)
    expect(applyOverseerApprovalPolicyUpdate(config, { enabled: true, maxRisk: 'high', requesterSessionIds: [] }).approvalPolicy?.delegations).toEqual([])
    expect(() => approvalDelegationSchema.parse({ ...rule(), categories: ['anything'] })).toThrow()
    expect(() => applyOverseerApprovalPolicyUpdate({}, { enabled: true, maxRisk: 'high', requesterSessionIds: ['other'], delegations: [rule()] })).toThrow('requester')
  })
})
