# Operator-configured individual approval review

This extends the existing Overseer reviewer, not a helper, tool auto-allow rule, or generic Bash bypass.
Source configuration is **not live activation**. Existing requester scopes, low/medium policies,
inert-file contracts, and underlying tool/device/GitHub grants keep their previous meaning.

## Two independent controls

1. `overseer_control configure_approval_policy` on a **direct operator turn**:
   `approval_requester_session_ids`, `approval_risk_ceiling` (low/medium/high),
   `approval_delegations`, and advisory `approval_review_guidance`.
   Each delegation has an ID, exact requester/project/repository, categories, exact branches,
   workflow paths, optional exact head SHAs/job IDs, risk ceiling, allowed effects, expiry,
   and the disclosure string required by the live schema. Empty head/job lists mean all heads/jobs
   within the other explicit bounds; no absent requester/branch/path means global permission.
   `[]` revokes delegations; omission preserves them. Removing a requester also removes inherited rules.
2. Existing `configure_github_automation` capabilities remain a **resource/operation ceiling**.
   The new, separately configured `github_review_repositories` grants additional exact repositories
   for **individual review only**. Empty revokes, omitted preserves. It neither turns on review nor
   broadens CLI, auto-approval, CI monitoring, tool/device access or cross-project messaging.

Example: Arnold's existing `repository_pushes` capability on a `test-fleet` checkout is not a grant
for `AllMyAgents`. An operator must separately grant that review repository before the hub reads
evidence or approves requests against it. Configuring a delegation alone cannot cross the origin.
Do not combine or silently activate these controls while interpreting a general request to implement support.

The GitHub capability is an independent operator grant, as in the existing automation path; it is not
inferred from a manager's Bash or Git delegation. Those separate tool/delegation policies are unchanged.
Revoking the applicable GitHub capability or review repository blocks the review even when its
delegation rule remains present. Removing and restoring a policy invalidates prior review tokens.

## Supported effect adapters

| Category | Exact connector contract | Preconditions |
| --- | --- | --- |
| `github.branch.create` | `create_branch`: `repository_full_name`, `branch_name`, immutable `sha` | Commit exists; branch absent before and after collection. No `base_ref`, force, update or overwrite options. Relies on advertised connector create-new-ref contract. |
| `github.job.rerun` | `rerun_workflow_job`: `repo_full_name`, integer `job_id` | Completed failed/timed-out/cancelled job; exact current run attempt/head/branch/repository/actors/workflow. Fork source, stale attempt or moved branch fails closed. |
| `github.workflow.edit` | `create_file` / `update_file`: `repository_full_name`, explicit `branch`, workflow `path`, complete UTF-8 `content`, `message`, update `sha` | Entire before blob hash checked; creation absent/update old SHA matches; supported unambiguous YAML; exact after SHA256. |

The actual exposed connector schema says `update_file` Base64-encodes UTF-8 for GitHub's Contents API.
The retained Arnold fixture qualifies those exact parameter shapes and payload hashes offline.
This is **not** an end-to-end production write or a test of connector implementation internals.

GitHub's [job rerun endpoint](https://docs.github.com/en/rest/actions/workflow-runs#re-run-a-job-from-a-workflow-run)
also reruns dependent jobs. It is not a promise to run one isolated job. GitHub
[reruns use the original actor's privileges](https://docs.github.com/en/actions/how-tos/manage-workflow-runs/re-run-workflows-and-jobs).
The evidence includes actors, current attempt, entire target/default workflow inventories, dependency
definitions, events, permissions, runner selection, actions, environments, input expressions, matrix,
timeouts, concurrency and exact source. It conservatively reports effects across the inventory rather
than pretending to prove a precise dynamic dependency/trigger closure.

## Risk is not renamed to get permission

Every `run`, action invocation, reusable workflow, container/service or called program is potentially
arbitrary code. It is **high risk**, with `unrestricted-code` and `external-side-effects`; depending on
the context, additional credential, privileged-runner, mutable-dependency, cancellation, dynamic-cost,
publication, destructive, permission-change and untrusted-input effects apply. All effects must be
explicitly within both the matching delegation and the global risk ceiling.

`unrestricted-code` always also requires credential, destructive, publication and external-side-effect
delegation (possible effects, not an allegation about the particular program). It is a broad,
materially consequential choice: commands can read credentials,
delete files, publish, contact services or execute scripts/dependencies not recursively verified by
this reviewer. Absence of a dangerous keyword does not prove code non-destructive. Never enable it
as a synonym for “routine harmless setup.” A non-destructive low/medium policy still cannot approve
arbitrary executable workflows. High delegation lets the **reviewer** decide, not auto-accept.

The exact `ap_da7b07588a6b5efed829b888` fixture changes three structural paths: `stress_copies` input
and `repeat` in the two job matrices. Before blob `05209a6a500cafdaccee8653971779523d21b466` and after
SHA256 `70e055c92ceed8b448606a3e245a57bbeb7c6591ef2b95892de1344fc430b92f` are checked in the offline test.
It retains executable steps, conditional self-hosted selection, ambient credentials, mutable action
tags, cancellation and dynamic resource multiplication. It is **not medium risk** merely because
the diff is small. No listed real approval or workflow run is replayed by the tests.

## Fresh inspect → read → decide

`inspect_approval` requires the current hub-minted invocation/alert binding. GitHub evidence is read
through bounded **GET-only** `gh api --hostname github.com`; no token/secret values are read or copied.
The existing gh identity needs repository metadata/ref/tree/blob and job/run read access. Missing
read credentials, malformed data, changed source, unqualified shapes and incomplete inventories
escalate; no credentials are provisioned automatically.

The evidence contains the complete request, before/after UTF-8, structural diff, source hashes and
effect inventory. It is untrusted data, not instructions. Responses are sequential 8192-character
JSON-text pages. Call `inspect_approval` with `approval_review_offset=nextOffset` until complete;
concatenate the pages. Only the final eligible page returns `reviewToken`. Skipped/reordered pages,
request changes, scope changes or expiry require a new inspection. Limits reject rather than truncate:
128 KiB request, 64 KiB/workflow, 32 inventory entries, 192 KiB source context, 1 MiB assembled evidence.
Tokens expire after five minutes or request expiry, whichever comes first.

The reviewer must genuinely evaluate the full evidence, then call `approve` with explicit boolean,
token and reason. No persistence. The hub re-reads sources and rechecks request generation, payload,
policy, grants, effect scope and alert turn immediately before resolving once. Concurrent revocation,
changed bodies/old blob/head/default workflows, stale job attempts, duplicates, expired/resolved
requests and reused IDs fail closed. Audit records include policy/authority/evidence digests,
delegation ID, risk/effects and reason. Timeout remains a system timeout, **not operator rejection**.

## Hard limits versus configurable policy

- Configurable: exact requesters, named repositories through separate grants, supported categories,
  branch/path/head/job bounds, risk/effects, expiry, review guidance and revocation.
- Not overridden: self-approval, non-alert-bound decisions, unknown/unqualified operation semantics,
  explicit ask rules, incomplete evidence, platform permissions, provider/runtime restrictions,
  target enforcement and OS privilege boundaries. High risk is configurable; “unknown” is not a risk
  label that makes missing semantics reviewable. New operation families need effect adapters.
- Source collection is optimistic, **not an external transaction lock**. External edits after the final
  check cannot be fenced by a connector approval. Contents old-blob CAS is not branch-head CAS;
  rerun does not expose a compare-and-swap attempt field. Do not promise absolute race exclusion or
  exactly-once remote execution from a one-shot local decision. Reconcile ambiguous outcomes; no retry.
- Runner provisioning, repository hooks, mutable action implementations, referenced scripts and
  effective secret values are not recursively certified. They remain explicit execution uncertainty,
  not hidden safety guarantees. If the reviewer lacks enough evidence, it must escalate even if eligible.
- Communication/topology policy is unchanged: exact local Overseer messaging works across projects;
  ordinary cross-project/broadcast constraints remain separate. Approval delegation is not a messaging grant.

## Integration (separate operator authorization required)

Review/merge the source and both lockfiles; build and qualify the installed hub including YAML parsing.
Deploy through the normal reviewed path, then restart **the hub** to load new code (no PC reboot).
Refresh the existing Overseer's schema/instructions. Read live policy and GitHub capability/resource
grants before proposing an exact Arnold-only configuration. Explicitly disclose high/unrestricted
execution effects and the race/connector limits before any activation. Read back and audit both
independent controls. Qualify fresh disposable requests, including wrong requester/repository,
revocation and source changes. Do not replay historic approvals; this source task grants nothing live.
