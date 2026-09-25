# Application Overseer

The Application Overseer is a designated, projectless agent conversation for operating AllMyAgents itself.
It is not a project manager and it does not inherit authority merely because an account or ordinary chat is
set to Full access.

## Setup and entry point

First-run onboarding deliberately has only two required steps: connect one account, then choose it as the
Overseer. Choose any available managed Claude or Codex account under **Settings / System / Application Overseer**.
Internal default vendor-home bindings used for history import cannot be selected. The hub creates the role,
forces Full access with an explicit operator override, persists the designated account in supervisor-readable
configuration, and exposes one persistent **Overseer** entry in the sidebar.

The new chat offers two plain-language entry points: **set it up for me** and **show me around**. The former
runs the guided project/team flow below. The latter uses a hub-owned, provider-neutral application guide so
the answer reflects the controls that exist in this build rather than a model's general product recollection.
The longer visual app tour and New Project dry-run remain optional and replayable from Settings.

Changing the account creates a new role before revoking the old role so a failed transition cannot silently
remove the working Overseer. The role cannot be created through the ordinary session API.

## Control authority

The Overseer control tool can:

- explain accounts, projects, chats, managers, worktrees, presets, access, approvals, elevation, Browser,
  remote testbeds, history, hub status, journal maintenance, recovery, and its own authority boundary;
- inspect projects, chats, profiles, pending approvals, saved team presets, and bounded failure evidence;
- query bounded current messages, task boards, approvals, and durable runs across selected local agents without
  consuming mail or scanning the full journal;
- schedule resource-leased local or granted-remote builds/tests with stable ids, provenance, cursor-paged logs,
  exact terminal state, and parallel placement across independent checkouts, explicit application working
  directories, device roots, GPUs, or fixtures;
- create host or WSL projects, import GitHub repositories, and create projectless or project-bound chats;
- run an interactive project-team setup, save the result as a durable preset, and materialize that preset
  as a real project manager plus visible direct-child chats with live ceilings;
- send messages to, stop, reopen, rename, or reconfigure another chat, including its model, effort, service
  tier, role, and explicit operator permission-mode override;
- configure an existing project manager, its reusable child roles, and its delegation/approval ceilings;
- trigger a new account sign-in or reauthentication through the existing freeze-and-settle coordinator;
- inspect and grant remote testbed roots, list and start GitHub clone jobs, and issue a short-lived mesh
  pairing code without exposing the long device credential;
- approve or decline another chat's pending request; and
- request restart through the normal restart supervisor.

Every mutation is journaled. The hub checks the live role on every call and permits mutations only from a
direct operator-originated turn. Teammate/bus turns can read status and bounded failure context so an
automatic fleet-failure alert can produce a report. The narrow standing-approval exception below applies
only to an exact hub-minted approval alert, not arbitrary teammate instructions. An Overseer cannot approve
its own request, and it cannot stop or message itself through the control tool.

## Requester-scoped standing approvals

On a direct operator turn, `overseer_control` can configure the fallback reviewer policy using
`configure_approval_policy`, `approval_policy_enabled`, `approval_risk_ceiling` (`low` or `medium`),
and `approval_requester_session_ids` (at most 32 exact local session IDs). It does not auto-click a tool:
the Overseer must review and decide the exact pending request which caused the hub-authenticated alert.
It cannot decide unrelated approvals, its own requests, or make persistent connector grants on that turn.
This is the existing Overseer reviewing one request, not a new helper or a tool auto-approval policy.

### Inspect, review, decide

For each fresh hub-minted alert, call `inspect_approval` with its `approval_id`. The result includes the
exact bounded pending payload (untrusted data), requester, invocation/payload binding, expiry, eligibility,
risk and reason code. An eligible scoped request also returns a `reviewToken`. The Overseer reviews that
payload and calls `approve` with `approval_id`, `approval_review_token`, an explicit `approve` boolean,
and a nonempty `reason`. It does **not** ask the operator again for an eligible delegated decision.
There is no `persist` on a delegated decision. An ineligible result must be escalated with its reason.

Tokens expire after five minutes (or earlier request expiry) and bind the requester invocation, complete
payload and policy. The decision rechecks live scope, risk, project origin and existing capabilities.
Resolution, replacement, policy changes, revocation, turn end and expired tokens cannot reuse a review.
Unrelated mailbox text cannot mint a hub alert binding. Duplicate pending IDs with different request
bytes or requester are refused. Repeated decisions are no-ops. Wall-clock deadlines are enforced even
if a stalled timer has not run. After hub restart, scoped-review decisions cannot take the old
content-ID recovery shortcut: recovery is refused and audited, not blindly executed again. Do not retry
an operation whose external outcome is ambiguous; reconcile it with the operator first.

`unsupported` means evidence or an adapter/semantic classifier is missing; it does not assert that the
operation is destructive. `high-risk` identifies blocking evidence such as credential/privileged-runner
or destructive indicators. `requester-scope`, `authority-ceiling`, `risk-ceiling`, `disabled`,
`not-alert-bound` and `not-pending` identify distinct reasons. Payloads over 128 KiB are omitted from this
review surface and cannot receive a token. No truncated payload can be approved through it.

The requester list is required on first enable; names, wildcards, unknown sessions and Overseer sessions
are rejected. Omission preserves an existing scoped list. `[]` delegates nobody; setting enabled to false
disables the policy while retaining its scope for a later explicit enable. The list is rechecked when a
decision is made, so revocation after delivery takes effect immediately. A malformed stored list fails
closed rather than reverting to global access. Old unscoped policies are left unchanged on load for
compatibility; the new control cannot create or re-enable an unscoped policy. Unrelated GitHub policies,
tool grants, device grants and permission modes are not rewritten.

Supported scoped decisions are recognized read-only tool requests within live manager/delegated-tool
and remote device/root/read ceilings, plus already-classified low/medium GitHub collaboration requests
within the requester's existing automation capability and the exact GitHub origin of its project checkout.
A request against another repository (including AllMyAgents from a test-fleet checkout), an ambiguous
origin, or a projectless GitHub request remains operator-only. Target-side filesystem and device policy
checks still apply at execution; this policy cannot grant a root or bypass an ask rule.

Shell execution, elevation, destructive/unknown/high-risk operations, merges, arbitrary pushes, workflow execution,
and arbitrary file mutations are not supported by this scoped fallback. In particular GitHub connector
`create_file`/`update_file` are deliberately **not** added to the automatic repository-push matcher:
even an exact repository and `.github/workflows/` path do not prove a body is non-destructive. YAML may
execute commands, publish artifacts, use secrets or elevated workflow permissions. `Write`, `Edit` and
pathless Codex file-change approvals also cannot use this new scope to bypass content review. Existing
separate explicit GitHub automation grants retain their prior behavior; this is not a revocation or a
replacement of those grants.

### Arnold setup integration (not a live grant)

After this source is reviewed and deployed through a separately authorized integration, refresh the
Overseer's tool schema, read `get_approval_policy`, and on a direct operator turn configure only:

```json
{
  "operation": "configure_approval_policy",
  "approval_policy_enabled": true,
  "approval_risk_ceiling": "medium",
  "approval_requester_session_ids": ["05ff2b80-21e6-4ca4-bdba-acc1786d99cd"]
}
```

Verify the returned/persisted requester list and `overseer/approval-policy-changed` event, then qualify
fresh low-risk Arnold and unrelated-agent requests in a disposable environment. Do not replay resolved
approvals such as `ap_622c69361e397e6fc0382975`. Read the current policy before editing: the list is an
explicit replacement, not an append operation. Do not silently drop another existing scoped requester.

### Optional exact file-content review contract

`approval_file_reviews` configures up to 16 **operator-reviewed** entries, separately from the requester
list. Omission retains matching entries; `[]` revokes them; requester removal also removes inherited
entries for that requester. Each entry names requesterSessionId, projectId, repository, branch, path,
operation (`create_file` or `update_file`), expectedBlobSha (null for creation), contentSha256,
parametersSha256, expiresAt (at most 24 hours out), and reviewReason. It must explicitly attest
execution=`none`, credentials=`none`, publication=`repository-only`, destructive=`false` for the exact
bytes **and their repository/branch context**, including push-triggered workflows, hooks and publication
effects. These are trusted operator review statements, not statements the requesting agent can supply
inside its payload. A matching entry never auto-approves: the existing Overseer still inspects and decides
each fresh alert, under a medium ceiling and existing `repository_pushes` capability and origin boundary.

The implemented connector grammar is deliberately closed: `codex_apps` GitHub empty-form elicitation,
one unambiguous create_file/update_file name, with repository_full_name, explicit branch, path, UTF-8
content, message, and (for update) exact `sha`; unknown aliases/extra parameters/encodings are unsupported.
`parametersSha256` is SHA-256 of recursively key-sorted JSON; contentSha256 hashes the exact UTF-8
content without newline normalization. Inspect returns the computed target/digests even when an entry
is missing. New entries require a direct operator configuration turn; none are automatically generated.

The no-execution contract covers exact reviewed `.md`/`.txt` documentation or blank/comment-only
workflow placeholders, **not executable CI workflows**. Workflow YAML must be entirely blank/comment
lines; quoted/escaped keys, anchors, tags and flow syntax do not pass through a denylist shortcut.
`run`, `uses`, expressions and deployment environments remain unsupported even with an entry. Known
credential/privileged/destructive indicators remain high-risk even with an entry. Absence of these
indicators is not a safety proof: the exact prior operator content/context review is still mandatory.
Encoded or missing bodies, missing old blobs, and unreviewed updates cannot borrow another entry.

GitHub's [Contents API documentation](https://docs.github.com/en/rest/repos/contents#create-or-update-file-contents)
requires an old blob SHA for updates and accepts Base64 content. That REST contract alone does **not**
prove the Codex connector's plaintext adaptation or preservation of old-blob/creation preconditions.
Before enabling file entries, qualify the exact connector schema/version and these semantics in a
disposable repository. No live Arnold workflow payloads or connector writes were replayed in this source
pass. If that adapter evidence is absent, keep file entries empty and use one-shot operator review.
Executable workflows need a richer pinned execution/credential/publication contract and qualification;
this implementation deliberately cannot enable them by relabeling arbitrary bodies low/medium.

### Deployment boundary

The installed disabled/low policy and missing requester fields are an installed/source mismatch, not
evidence this source policy is enabled. Integrate this commit on top of `812cc84`, run the focused and
release gates, then separately authorize deployment. Loading the new hub code requires a bounded hub
process restart; refresh/reconnect the Overseer's provider tool schema afterward. No PC/OS reboot is
required. Installation, restart and live policy changes are **not** part of this source handoff.
After deployment, confirm `inspect_approval`, `approval_review_token` and requester fields exist in the
live schema, configure only Arnold on a direct operator turn, and read back/audit the exact scope.
Keep file reviews empty until their separate exact-content and adapter qualification is complete.
Qualify new disposable eligible/denied requests, duplicate/expiry/revocation races and audit rows; do
not replay previously resolved approvals (including e7cb... / decision 5858).

## UI teaching and navigation

The Overseer can read a catalog of named app-owned destinations and, on a direct operator turn, request a
short explanation to be attached to one of them. The renderer opens the known screen when necessary,
scrolls the control into view, and draws a dismissible spotlight. Current targets cover Home, New Project,
project overview, Overseer, Accounts, chat defaults, remote access, Safety, hub status, Managers, Browser,
the composer, permissions, and older history.

This is not arbitrary renderer or DOM control. Target names are a closed hub schema, the client accepts only
the same allowlist, explanation text is bounded and rendered as text, and journal replay never reopens a
screen or resurrects a stale spotlight. Reading the catalog is diagnostic; driving the UI requires the same
positive direct-operator provenance as every other Overseer mutation.

Claude worker sessions now relay `AskUserQuestion` over the mutually authenticated local worker channel.
The hub still owns validation, durable correlation, rendering, cancellation, restart interruption, and the
answer. This lets a Claude Overseer ask the setup questions without weakening the trust boundary.

## Project setup and team presets

For a new repository, the Overseer is instructed to recommend defaults and ask a small set of grouped
questions covering:

- host versus WSL environment and storage location;
- project name;
- account, model, and effort choices;
- worker roles and starting briefs; and
- manager/child access topology and approval ceilings.

The operator can save the result as a team preset. A preset stores manager identity/settings, fixed worker
types, prompts, isolation choices, permission modes, exact Git authorities, and exact tool ceilings. Launch
validates every referenced live profile before creating anything. It creates and configures all records
before starting child work, then sends each startup brief through the direct operator-origin path. A preset
therefore describes an operator grant; it cannot turn a manager-authored or teammate-authored message into
operator authority.

## Failure escalation

When a non-Overseer session enters the error state, the hub posts a fixed, system-authored alert to the
Overseer. Raw vendor/model error text is not copied into the alert. The diagnostic turn may inspect a
bounded reverse-chronological event window and is instructed to produce a structured report with session,
time, symptoms, evidence, likely cause, safe reproduction, recommendation, and owner. It remains a bus turn,
so it cannot approve, reconfigure, restart, or elevate anything unless the operator starts a direct turn.

## Elevated-shell escape hatch

Full access removes ordinary per-tool prompts within the hub policy; it does not create administrator/root
rights. Elevation has two separate deny-by-default policy subjects: one policy per project, and one application
machine policy owned by the operator. The application policy exists for services, processes, the registry, and
other host maintenance that would be falsely attributed if it were attached to an arbitrary project.

Project policies support:

- `disabled`: no elevated command may be proposed;
- `project`: the working directory and detected literal paths must remain within operator-configured roots;
- `machine`: machine-wide effects may be proposed, but still require per-command approval.

The application policy supports only `disabled` and `machine`; it has no implicit repository root. The Overseer
omits `project_id` to inspect, configure, analyze, or run against that policy. Analysis explicitly distinguishes
project-root paths, machine-wide filesystem effects, and commands such as service control that contain no
detected filesystem path. This classification is descriptive, never an operating-system sandbox.

The Overseer first produces a blast-radius report covering destructive filesystem operations, services and
persistence, networking/availability, identities/permissions, network transfer, nested shells, dynamic
paths, and obvious scope escapes. This analysis is deliberately honest: an arbitrary administrator shell is
not an OS sandbox, so literal-path checks cannot prove containment against a command that constructs paths
dynamically.

Execution requires all of the following: a direct operator Overseer turn, an enabled policy for the exact
project or application subject, a
successful preflight, a dedicated `overseer/elevated-command` approval that Full access cannot auto-approve,
and the host elevation mechanism. The Windows implementation launches a one-shot UAC PowerShell child,
bounds runtime and returned output, terminates the child process tree on timeout, removes its temporary
request files, and journals proposal/decision/start/completion or failure without journaling output. Linux
and macOS currently have no interactive root broker in this build and fail closed; no password or resident
root helper is stored by AllMyAgents.

## Actionable teammate mail

Routine checkpoints and FYIs use `send_message` with `wake:false` and wait for an existing or operator-started
turn. An operator-requested handoff, actionable blocker/failure, approval, or question can be marked
`attention_required:true` by a manager or the application Overseer; a worker may use it only to reach its own
manager. A normal `wake:true` direct message from an operator-origin Overseer turn is classified this way
automatically, so the operator's delegated handoff cannot be silently downgraded by the context-cost guard.
This audited intent bypasses the high-context wake hold for one direct recipient, but changes no trust
property: the resulting turn is still bus-originated, permission-clamped, and unable to exercise direct-operator
Overseer mutations. Broadcast urgency and `attention_required:true` combined with `wake:false` are rejected.

## Database-offline boundary

The conversation, model execution, projects, approvals, and audit trail are journal-backed. If the journal
cannot open, no vendor agent—including the Overseer—can honestly reason or mutate that state.

To make that failure diagnosable, the desktop supervisor writes a separate bounded, token-free status file
covering startup, boot, live, restart, retry, recovery, offline, and stopping phases. It contains only coarse
health metadata, the designated profile ID, process/port facts, retry count, and a bounded error summary—no
credentials, prompts, session IDs, paths, commands, or journal contents. When the hub disconnects, the
desktop sidebar reads this status and a bounded desktop-log tail through a native command that does not
depend on the hub or its database.

This split gives the operator a dependable recovery view while keeping privileged model action fail-closed.
A future continuously reasoning Overseer during total journal failure would require a separately packaged,
authenticated vendor sidecar with its own minimal durable audit store; it must not be simulated by bypassing
journal preflight or by putting credentials in the supervisor status channel.
