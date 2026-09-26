import crypto from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { assessGitHubFileReview, reviewDigest, type ApprovalFileReview } from './approvalReview.js'
import { applyOverseerApprovalPolicyUpdate } from './overseerApprovalPolicy.js'

export function fileFixture(operation: 'create_file' | 'update_file' = 'create_file') {
  const params = { repository_full_name: 'acme/widget', branch: 'setup', path: '.github/workflows/disabled.yml',
    content: '# Disabled placeholder. No workflow execution.\n', message: 'Add reviewed placeholder',
    ...(operation === 'update_file' ? { sha: 'a'.repeat(40) } : {}) }
  const payload = { serverName: 'codex_apps', mode: 'form', requestedSchema: { type: 'object', properties: {} },
    _meta: { source: 'connector', connector_name: 'GitHub', codex_approval_kind: 'mcp_tool_call', tool_title: operation, tool_params: params } }
  const review: ApprovalFileReview = { requesterSessionId: 'arnold', projectId: 'project', repository: 'acme/widget',
    branch: params.branch, path: params.path, operation, expectedBlobSha: operation === 'update_file' ? 'a'.repeat(40) : null,
    contentSha256: crypto.createHash('sha256').update(params.content).digest('hex'), parametersSha256: reviewDigest(params),
    execution: 'none', credentials: 'none', publication: 'repository-only', destructive: false,
    reviewReason: 'Exact bytes and old blob reviewed; branch has no execution hooks; repository publication authorized.',
    expiresAt: new Date(Date.now() + 60_000).toISOString() }
  return { payload, review, params }
}
const kind = 'codex/mcpServer/elicitation/request'

describe('individual file review contract (never an auto-approval classifier)', () => {
  it.each(['create_file', 'update_file'] as const)('requires exact reviewed bytes/effects for %s', op => {
    const { payload, review } = fileFixture(op)
    expect(assessGitHubFileReview(kind, payload, 'arnold', 'project')?.status).toBe('unsupported')
    expect(assessGitHubFileReview(kind, payload, 'arnold', 'project', [review])?.status).toBe('eligible')
    for (const key of ['repository', 'branch', 'path', 'contentSha256', 'parametersSha256', 'expectedBlobSha', 'requesterSessionId', 'projectId']) {
      expect(assessGitHubFileReview(kind, payload, 'arnold', 'project', [{ ...review, [key]: 'different' }])?.status).toBe('unsupported')
    }
    expect(assessGitHubFileReview(kind, payload, 'arnold', 'project', [review], Date.parse(review.expiresAt))?.status).toBe('unsupported')
  })
  it.each([
    ['run: npm test', 'unsupported'], ['uses: actions/checkout@v4', 'unsupported'], ['environment: prod', 'unsupported'],
    ['"r\\u0075n": echo unsafe', 'unsupported'], ['jobs: {build: {steps: []}}', 'unsupported'],
    ['run: sudo reboot', 'high-risk'], ['token: ${{ secrets.TOKEN }}', 'high-risk'], ['permissions: write-all', 'high-risk'],
    ['runs-on: self-hosted', 'high-risk'],
  ])('does not lower the floor for %s even when a content contract exists', (content, status) => {
    const { payload, review, params } = fileFixture()
    params.content = content
    review.contentSha256 = crypto.createHash('sha256').update(content).digest('hex')
    review.parametersSha256 = reviewDigest(params)
    expect(assessGitHubFileReview(kind, payload, 'arnold', 'project', [review])?.status).toBe(status)
  })
  it('rejects missing old blob, ambiguous targets, encodings and request envelopes', () => {
    const { payload, params } = fileFixture('update_file')
    for (const patch of [{ sha: undefined }, { branch: undefined }, { repo: 'other' }, { encoding: 'base64' }, { path: '../workflow' }]) {
      expect(assessGitHubFileReview(kind, { ...payload, _meta: { ...payload._meta, tool_params: { ...params, ...patch } } }, 'arnold', 'project')?.status).toBe('unsupported')
    }
    expect(assessGitHubFileReview(kind, { ...payload, _meta: { ...payload._meta, tool_name: 'delete_file' } }, 'arnold', 'project')?.status).toBe('unsupported')
  })
  it('validates effect ceilings, finite expiry, and removes inherited file contracts on scope revocation', () => {
    const { review } = fileFixture()
    const current = applyOverseerApprovalPolicyUpdate({}, { enabled: true, maxRisk: 'medium', requesterSessionIds: ['arnold'], fileReviews: [review] })
    expect(applyOverseerApprovalPolicyUpdate(current, { enabled: true, maxRisk: 'medium', requesterSessionIds: [] }).approvalPolicy?.fileReviews).toEqual([])
    expect(() => applyOverseerApprovalPolicyUpdate({}, { enabled: true, maxRisk: 'medium', requesterSessionIds: ['arnold'],
      fileReviews: [{ ...review, credentials: 'unknown' } as never] })).toThrow()
    expect(() => applyOverseerApprovalPolicyUpdate({}, { enabled: true, maxRisk: 'medium', requesterSessionIds: ['arnold'],
      fileReviews: [{ ...review, expiresAt: new Date(Date.now() + 25 * 60 * 60 * 1000).toISOString() }] })).toThrow('24 hours')
  })
})
