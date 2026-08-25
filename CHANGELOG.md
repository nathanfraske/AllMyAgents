# AllMyAgents release history

All notable operator-facing changes are recorded here. The linked release notes contain the complete
feature and fix log used on the corresponding GitHub release.

## Unreleased

## v0.1.34-alpha.38 — 2026-08-24

This release turns the dormant Manager Helper into a default-on Manager Assistant for approval-capable project
managers and removes several measured sources of coordination-token growth.

[Full v0.1.34-alpha.38 release notes](docs/releases/v0.1.34-alpha.38.md)

- Legacy managers that already have child-approval authority receive a low-risk, inexpensive assistant
  automatically. A saved explicit opt-out remains off, and uncertain or broader-risk decisions still escalate.
- Simultaneous worker lifecycle changes are retained individually for audit but delivered to the manager as one
  actionable pulse. Routine starts and stops no longer interrupt an expensive active manager turn.
- Manager guidance now requires cursor-based inspection and yielding when no action is available instead of
  provider wait loops, repeated child polling, or duplicate assistant decisions.
- Team projections and transcript peeks use smaller bounded pages, and the shared MCP instruction header is no
  longer repeated at full methodology length across every exposed tool.
- Modern Codex cumulative token counters, including cached input, are preserved separately from request-context
  occupancy and shown by `/usage` without mislabeling thread-lifetime totals as one model request.

## v0.1.33-alpha.37 — 2026-08-21

This release keeps long conversations responsive and turns the Accounts tab into a fleet-wide identity catalog
without moving or sharing provider credentials between machines.

[Full v0.1.33-alpha.37 release notes](docs/releases/v0.1.33-alpha.37.md)

- High-rate Codex command/reasoning fragments that have no visible presentation no longer invalidate the entire
  app, live transcript work is bounded to the visible tail, older reached history uses offscreen rendering
  containment, and the seconds-only activity clock updates once per second.
- Claude and Codex profiles project only their provider-confirmed email and opaque account id. The Accounts tab
  consolidates that identity across paired hubs and shows each device's online and local login state.
- A fleet account that is not present locally offers **Log in here**, safely reusing an available local profile id
  or deriving a collision-free one. The browser flow names the expected email and verifies the account the
  provider actually returned rather than attaching the wrong identity silently.

## v0.1.32-alpha.36 — 2026-08-20

This release removes a false Codex manager-attribution block, adds a hidden risk-bounded Manager Helper for
routine child approvals, and discovers preview/Cyber models from each exact Codex account instead of assuming
that every signed-in account has the same catalog.

[Full v0.1.32-alpha.36 release notes](docs/releases/v0.1.32-alpha.36.md)

- `decide_child_approval` can now attribute the one manager that owns an exact pending request even when a Codex
  manager and child intentionally share an account and checkout. Every unrelated ambiguous tool call remains
  fail-closed.
- Managers can optionally use a hidden, stateless fast-model helper for low- or medium-risk approvals. A
  deterministic risk floor, the live manager hierarchy, and the operator's exact capability ceiling are checked
  before and after evaluation; uncertainty, provider failure, entitlement loss, or broader risk wakes the manager.
- Helper decisions are fully journaled and shown as compact expandable cards in the requesting agent's timeline.
  The helper has no chat, project tools, MCP servers, hooks, plugins, memories, or writable workspace.
- Codex model choices now come from the provider-maintained catalog for the selected account. Preview/Cyber access
  such as Daybreak Blue appears only on accounts that advertise it, with the provider's supported effort and speed
  options, and never leaks into another account's picker or the global default.

## v0.1.31-alpha.35 — 2026-08-20

This release repairs asymmetric fleet discovery and pairing when the direct MyOwnMesh control pipe is unavailable
but the authenticated AllMyStuff Site tunnel is healthy.

[Full v0.1.31-alpha.35 release notes](docs/releases/v0.1.31-alpha.35.md)

- Same-fleet hubs now establish reciprocal credentials in one action over either the direct RPC lane or a healthy
  Site route. The Site fallback requires signed-roster membership and proves the claimed source capability by
  calling back to that exact fleet member before saving anything.
- Automatic trust no longer equates a denied direct-pipe ACL with an offline fleet. One-use codes retain
  rolling-upgrade compatibility with older peers.
- An explicit **Refresh** may probe the conventional hub port for signed-roster peers that lost their presence
  advert. Background polling stays advert-only, so the repair does not reintroduce route churn or idle bandwidth.
- Reciprocal connections use the stable mesh public identity rather than an ephemeral session-suffixed id, and
  fall back to the machine hostname when the mesh daemon has no display label.

## v0.1.30-alpha.34 — 2026-08-20

This release turns an explicit device authorization into usable manager authority, keeps remote routes stable and
quiet while chats are open, prepares project checkouts automatically, and makes broad GitHub automation grants
durable across both Claude and Codex managers.

[Full v0.1.30-alpha.34 release notes](docs/releases/v0.1.30-alpha.34.md)

- **Authorize testbed** grants every capability and Windows, WSL2, Linux, or macOS root the target advertises in
  one operator action. The exact chat/device grant is standing authority: managers no longer need a second project
  attachment, per-command approval, or single-terminal-command lease.
- Project chats automatically reuse a clean matching checkout or create an app-owned checkout beneath a broad
  machine root. Durable remote runs re-establish the exact published primary revision before building or testing.
- Fleet polling no longer remaps a byte-healthy route after HTTP 503 or a timeout, and a live authenticated remote
  WebSocket remains stronger evidence than a transient health probe. Transcript streaming is limited to visible
  remote panes instead of relaying every agent's full output while the UI is idle.
- A failed mid-turn steer that confirms the provider is already idle starts exactly one fresh queued turn, closing
  the stale-active window that could leave manager and worker messages waiting indefinitely.
- Project and chat settings expose one-click **Allow all GitHub automation** controls. The same scoped policy covers
  Claude GitHub commands and strictly classified Codex GitHub connector elicitations while keeping merge, push,
  workflow, and pull-request capabilities independently revocable.

## v0.1.29-alpha.33 — 2026-08-20

This release keeps long-lived Codex managers from crashing the shared worker, makes granted remote checkouts usable
without a second hidden project mutation, restores healthy paired Site routes, and makes testbed toolchains visible
to both the service and ordinary device logins.

[Full v0.1.29-alpha.33 release notes](docs/releases/v0.1.29-alpha.33.md)

- Codex resumes no longer serialize the provider's duplicate full turn history into one unbounded line. A bounded
  byte-framed reader contains malformed or oversized provider output to that provider process instead of killing
  the shared worker and interrupting unrelated turns.
- An exact manager/device grant can automatically register an already-clean matching project checkout on first
  preparation. Generic roots such as WSL `/home` remain immediately valid run targets and are no longer described
  as missing grants, but they are never mislabeled as source checkouts.
- Signed-fleet Site discovery probes the mapped `/api/health` route, repairs a stale mapping once, and preserves
  distinct roster, mapping, listener, unhealthy-hub, timeout, and control-plane diagnostics.
- Linux testbeds expose shared compiler payloads under a stable system prefix while retaining writable user caches
  per account; environment inspection reports each tool's resolved path and source, including the node's own runtime
  when a service launcher intentionally omits Node from `PATH`.

## v0.1.28-alpha.32 — 2026-08-15

This release makes cold conversation history responsive and truthful, keeps long remote durable jobs alive for
their declared budget, preserves operator authority across mid-turn guidance, and connects narrow GitHub grants to
the Codex connector approval path that previously ignored them.

[Full v0.1.28-alpha.32 release notes](docs/releases/v0.1.28-alpha.32.md)

- Journal history plans a bounded page before hydrating blobs, reads immutable blobs asynchronously with shared
  bounded concurrency, and shows load errors with retry instead of impersonating an empty conversation.
- Remote durable runs honor their recorded timeout up to six hours and record the target platform, architecture,
  checkout, transport, and telemetry rather than the source hub's environment.
- Authenticated operator input arriving during a bus turn is durably queued exactly once as a new operator-origin
  turn. The running bus turn remains permission-clamped and gains no retroactive authority.
- Exact project/session GitHub automation grants satisfy only matching Codex GitHub connector elicitations. Merge,
  push, workflow, repository, and unknown operations remain distinct; resolved decisions stay queryable.
- Existing Linux lightweight testbeds can synchronize only changed portable modules, verify hashes, schedule a
  detached restart, retain rollback files, and report explicit build identity and transport.
- The desktop renders live startup phase/elapsed telemetry while the hub starts; exhaustive payload validation is
  post-ready, orphaned backup sidecars self-heal, and stale worktree probes no longer spam every boot.
- Overseer contract v21 adds risk-bounded standing approvals, connector persistence only on direct operator turns,
  current methodology, and automatic in-place upgrade for existing Overseer conversations.

## v0.1.27-alpha.31 — 2026-08-14

This release fixes the multi-gigabyte journal startup and backup failure at its storage boundary, restores
direct-only MyOwnMesh testbeds, and makes application-scoped Overseer runs, elevation, and actionable handoffs
usable without inventing a project association.

[Full v0.1.27-alpha.31 release notes](docs/releases/v0.1.27-alpha.31.md)

- Large event strings move losslessly into crash-safe, content-addressed blobs. Ordinary bounded maintenance
  projects existing rows, enforces a configurable resident SQLite target, and is a no-op once compliant.
- A hot backup pins one immutable WAL generation and is bounded by restart, physical-page-work, child wall-clock,
  and parent-process deadlines. Backup and exclusive maintenance cannot overlap.
- Boot uses `quick_check`, reuses one exact journal-identity proof across supervisor respawns, and moves heavy
  capability rematerialization post-ready without delaying replica attribution required for durable runs.
- Recursive canonical JSON fixes direct-lane signatures across MyOwnMesh map reserialization. Lightweight nodes
  retain their event loop, advertise the correct capabilities, and complete reciprocal one-use pairing.
- The Overseer can own durable runs from an explicit absolute directory and use a separate audited machine-level
  elevation policy; actionable manager/Overseer mail wakes the intended recipient without changing authority.
- Existing Overseers upgrade in place to capability contract v17 with explicit delegation, messaging-path,
  evidence-strength, task-accountability, and compaction-continuity methodology.

## v0.1.26-alpha.30 — 2026-08-13

This release consolidates settings, project management, and remote-device visibility; replaces provider-shaped
manager permissions with semantic capabilities; makes approvals and account capacity durable and actionable; and
regenerates live manager truth after compaction instead of trusting stale prose.

[Full v0.1.26-alpha.30 release notes](docs/releases/v0.1.26-alpha.30.md)

- Settings and project controls are task-oriented, persist visibly, and include one hub/testbed device overview.
- Manager `shell`, `file_write`, `file_read`, `web`, `browser`, and `runs` grants work consistently across Claude and
  Codex, migrate legacy grants, and revoke immediately when narrowed.
- Approvals last long enough for a human, distinguish expiry from denial, re-evaluate deterministically after grant
  changes, and stop delivering stale already-resolved alerts.
- Persistent entitlement, rate-limit, reset, and headroom state drives fail-fast team preflight and usage-aware,
  independence-constrained account selection.
- Managers receive bounded live generated grants and rosters on every turn and after compaction; existing sessions
  upgrade in place to capability manifest v5 without losing identity, culture, teams, or transcripts.
- Operator mid-turn authority loss and unconfirmed worker handoffs are visible and truthful rather than silent denials
  or fabricated agent failures.
- Direct MyOwnMesh RPC now reports daemon, ACL, network-discovery, and control failures explicitly. The separate daemon
  still owns the underlying Windows pipe ACL repair.
- Versioned notes now populate the GitHub Release body directly, so the feature/fix log is no longer only a repository
  document behind a generic release description.

## v0.1.25-alpha.29 — 2026-08-11

This release makes every AllMyAgents tool call readable in the chat timeline, wakes project managers when a worker
finishes, and reinforces live Claude/Codex instructions without allowing saved rules or large team rosters to poison
the model context.

[Full v0.1.25-alpha.29 release notes](docs/releases/v0.1.25-alpha.29.md)

- All current AllMyAgents coordination, memory, browser, remote-device, run, and Overseer tools have concise
  argument-aware timeline labels. The exact protocol name, inputs, result, and error remain available on expansion.
- Collapsed remote-command rows deliberately omit command arguments so secrets and one-use codes do not leak into
  the ordinary transcript surface.
- A worker entering idle now wakes its project manager exactly once for result collection or reassignment, including
  above the normal high-context FYI guard.
- Scoped operator instructions are reasserted on every Claude and Codex turn in general-to-specific order, including
  after compaction, rather than depending on a provider to rediscover a changed native instruction file.
- Operator instructions and live topology each have an independent 8,000-character automatic-context ceiling.
  Oversized content is explicitly hashed and pruned without invalid JSON, silent semantic summaries, or fabricated
  completeness; the full operator record remains editable in AllMyAgents Settings.

## v0.1.24-alpha.28 — 2026-08-10

This release adds a provider-neutral durable job control plane for local and remote builds, tests, and other
long-running work; one bounded manager/Overseer query across operational state; and the corresponding Claude and
Codex operating contracts. It also includes every fix landed on `main` since alpha.27.

[Full v0.1.24-alpha.28 release notes](docs/releases/v0.1.24-alpha.28.md)

- `start_run`, `inspect_runs`, and `control_run` give managers and the Overseer stable run IDs, resource leases,
  bounded cursor-paged logs, exact terminal state, source/environment provenance, remote telemetry, and explicit
  `outcome_unknown` recovery instead of unsafe blind retries.
- Independent checkouts, device roots, GPUs, ports, or fixtures can run concurrently; shared resource names
  serialize work. The same scheduler can therefore portion a build/test matrix across granted remote devices.
- `query_team` returns scoped, cursor-bounded messages, task boards, approvals, and durable runs without consuming
  mail or reconstructing the entire journal. Managers remain limited to their hierarchy; the Overseer must select
  sessions explicitly when the active catalog is large.
- Existing Claude and Codex managers/Overseers receive the new methodology through versioned, idempotent
  rematerialization without being woken into a reminder loop.
- Manager task accounting now requires provider-native planning plus exact `assign_child_task` ownership and
  reconciliation. Retired records remain archived instead of reappearing in the active catalog or counts.
- Hub connection state now tolerates brief health/reconnect gaps without flickering every agent into error, and
  periodic mesh upkeep no longer rewrites an already-correct exposure map every 30 seconds.

## v0.1.23-alpha.27 — 2026-08-09

This release supersedes the gate-failed `v0.1.23-alpha.26` tag. It contains the complete alpha.26 feature set,
prevents action-required approval/stall/failure mail from being stranded behind the high-context wake guard,
and closes two Windows-only release-path races found by the exact-tag durability gate.

[Full v0.1.23-alpha.27 release notes](docs/releases/v0.1.23-alpha.27.md)

- Journal backup workers now use an explicit terminal-result acknowledgement. A verified snapshot and published
  recovery generation can no longer be falsely reported as failed because Windows delivered child exit before
  the final IPC message.
- The Windows installed-launch gate retries an accepted-but-unexecuted Start Menu ShellExecute once only when no
  AllMyAgents process and no desktop log exist. A real application/bootstrap failure is never retried or masked.
- Windows P0 artifacts now retain shortcut resolution, installed-process/port state, and the current desktop log
  even when health never arrives, so a failed clean-install launch remains diagnosable.
- Windows remote-device tests now terminate the exact Git child tree they spawn. They no longer leak
  `git-daemon.exe` listeners or leave an otherwise green release preflight waiting forever on an inherited pipe.

## v0.1.23-alpha.26 — 2026-08-09

This release makes remote devices first-class project testbeds, adds deployable vendor-free fleet nodes, preserves
durable manager teams with bounded parallel staffing, lets managers remember exact in-ceiling child approvals,
and fixes blank transcripts caused by large-journal maintenance pauses.

[Full v0.1.23-alpha.26 release notes](docs/releases/v0.1.23-alpha.26.md)

- Projects now have canonical local/remote locations, bounded Git readiness, exact published-revision
  preparation, exclusive reservations, and immutable agent/session attribution for remote terminal runs.
- The Overseer can deploy a checksum-verified lightweight testbed node over existing signed-fleet AllMyStuff file
  and terminal planes. Explicit Windows LocalSystem, Linux root, and Linux passwordless-sudo profiles are
  available without installing vendor accounts, a journal, or a target Overseer.
- Every agent role receives the exact remote-testbed workflow after compaction, including environment discovery,
  WSL-aware operation, transfer telemetry, and ambiguous-failure handling.
- Managers retain role-bearing workers and stash/activate durable teams instead of cycling through retired
  identities. A bounded parallel staffing target encourages useful independent lanes without invented work.
- Managers can approve once or remember the exact ordinary tool/Git action class for a direct worker. Remembered
  grants survive restart, remain bounded by the live operator ceiling, are fully audited, and revoke immediately.
- Hub-minted approval, stall/error, fleet-failure, and worktree-risk notices now bypass the high-context FYI
  guard, waking an idle manager or Overseer exactly once without letting agents self-assign message priority.
- Condensation shortens its writer transaction, full snapshot/verification runs outside the hub event loop, and
  transient history timeouts retry recoverably with an explicit manual retry path.
- Dashboard heatmap intensity is relative, costs are labeled as Claude API-equivalent estimates, usage reset
  labels switch between absolute date/time and under-24-hour countdowns, and archived agents do not inflate caps.

## v0.1.22-alpha.25 — 2026-08-08

This release prevents healthy direct mesh routes from flickering offline, makes remote sends/steers idempotent
and ordered, transfers directory trees to remote testbeds, restores interrupted Claude context after hub restart,
bounds project-deletion inspection, reduces journal write amplification, and separates retired agent records from
the active working catalog.

[Full v0.1.22-alpha.25 release notes](docs/releases/v0.1.22-alpha.25.md)

- A live direct remote stream now remains authoritative through transient fleet-refresh or Site-health failures.
  Passive polling no longer destroys and recreates a working route, while explicit Refresh still performs recovery.
- Remote operator messages and steers carry stable request identities through direct and Site-compatible paths, so
  retries cannot double-send or reorder a steer above older durable messages. Attachments retain the same identity.
- Remote testbeds can create nested destination directories and transfer complete folder trees, including into a
  granted WSL root, with bounded progress, latency, byte counts, and exact failure reporting.
- Same signed-fleet peers establish reciprocal trust in one operation; direct peers can still enter an optional
  pairing code when automatic fleet trust is unavailable, avoiding a no-code dead end.
- Claude persists a vendor session as soon as the first authoritative session id arrives. A bounded continuity
  capsule recovers the interrupted objective, recent conversation, and unanswered question after a hub restart
  without injecting raw tool output or protocol envelopes.
- Project deletion inspection and removal are asynchronous, abortable, time-bounded, and capped for display so a
  large or slow checkout cannot freeze the renderer. The hub returns a precise timeout/failure instead of hanging.
- Journal maintenance skips an expensive recovery-generation verification pass when no row is eligible for
  condensation, and high-volume Codex command deltas are losslessly coalesced before journaling.
- Retired manager children now leave the sidebar and `list_agents` active catalog. Their immutable ID, transcript,
  workspace, attribution, retirement reason, and reversible reactivation path remain in a project archive and
  `child_status`; manager guidance now reuses ordinary idle workers and retires only at a real replacement boundary.
- Remote account/profile selectors use a compact human label instead of exposing mesh-qualified internal IDs, and
  the local Overseer remains hub-local rather than being replaced by a remote hub's Overseer record.

## v0.1.21-alpha.24 — 2026-08-07

This release closes the high-context manager dead end, adds bounded worker-owned one-shot agents and
reversible child retirement, gives the Overseer durable Tokenmaxxing/Eco policies, introduces a bounded
notification center and journal-pressure diagnostics, and makes mesh discovery and maintenance contention
truthful under the operator's live workload.

[Full v0.1.21-alpha.24 release notes](docs/releases/v0.1.21-alpha.24.md)

- Claude enables its supported automatic compaction window on every resumed query; Codex context occupancy is
  normalized into the same provider-neutral telemetry. Background mail no longer launches another enormous
  idle turn above the bounded context threshold, while active turns still accept steering and queued mail is
  folded into the next operator-started turn.
- Managers can non-destructively retire an idle, failed, or stopped child, free its live slot, spawn a successor,
  and reactivate the preserved child later when team and capacity bounds allow. Enabled workers can create
  tightly bounded same-account one-shot descendants rendered beneath them as Name II, III, and so on.
- An idle project manager can move to another logged-in Claude or Codex account from Edit Project & Managers or
  through a direct-operator Overseer turn. The hub creates a fresh vendor thread, atomically transfers teams,
  descendants, grants, pending mail, and narrow session policy, and retains the previous chat as a stopped
  least-authority transcript snapshot.
- Overseer project setup now requires an explicit choice about whether the manager may decide descendant
  approvals inside its exact Git/tool ceiling. Disabled, unavailable, and out-of-ceiling requests escalate with
  their exact action and reason for Overseer blast-radius review and a direct operator decision.
- Tokenmaxxing and Eco mode are durable, direct-operator Overseer policies with reusable guidance/idea pools,
  explicit concurrency bounds, live quota/reset inspection, and provider-native reinjection after compaction.
- A durable 30-day/1,000-row notification inbox covers manager/Overseer completions by default plus errors,
  approvals, stalls, and journal pressure; desktop notifications are separately opt-in. Full Access still does
  not imply Administrator/root, and the UI reports the existing one-shot audited elevation broker honestly.
- Journal maintenance now compacts completed-item starts, retains recovery generations by bytes as well as
  count, exposes `pnpm journal:audit`, and warns on allocated/retained storage without rescanning the event table.
  Its isolated writer waits longer under live traffic and records residual SQLite contention as a deferred retry
  instead of a false terminal failure.
- MyOwnMesh now discovers every eligible owned network, selects the route where the requested peer is actually
  active, registers inbound Hub RPC on each shared mesh, and automatically warms presence-advertised Hub ports.
- Reloaded transcript attachments use a narrowly scoped read-only capability URL for the exact attachment GET;
  query authentication remains rejected for every other API route and every mutation.

## v0.1.20-alpha.23 — 2026-08-05

This release adds durable, operator-owned GitHub automation grants for managers, managed workers,
scratchpads, and the Overseer without turning Full Access or a broad shell allow-list into implicit
GitHub authority. The policy is available at project or exact-chat scope, enforced through the shared
Claude/Codex approval chokepoint, and fully journaled for later audit.

[Full v0.1.20-alpha.23 release notes](docs/releases/v0.1.20-alpha.23.md)

- Added durable, operator-owned GitHub automation policies at both project and exact-chat scope. Project
  grants follow manager/team rotations; exact-chat grants cover one manager, worker, scratchpad, or Overseer.
  Both are configurable from the access picker, project settings, authenticated API, or a direct-operator
  Overseer control turn.
- GitHub automation is split into pull-request work, pull-request merges, workflow runs, and repository
  pushes. It applies to manager/teammate-driven turns without widening Full Access or always-allowing Bash,
  while Overseer use remains restricted to a positively identified direct operator turn. Every policy change
  and auto-approved use remains journaled.
- The closed operation classifier fails back to an operator prompt for `gh api`, authentication, secrets,
  repository administration, workflow enable/disable, admin merges, shell chaining/substitution/redirection,
  file-upload/download convenience flags, implicit PR-creation pushes, unknown tools/verbs, cross-project
  repository selectors, local `gh`/`git` lookalikes, force/delete pushes, non-origin or alternate push
  destinations, implicit/multi-ref pushes, repository-controlled Git execution settings, and repositories
  with active/custom Git hooks.
- Existing Overseer conversations migrate in place to capability contract v5 so Claude and Codex discover
  the new `get_github_automation_policy` and `configure_github_automation` operations after restart or
  compaction instead of depending on an old remembered tool inventory.

## v0.1.19-alpha.22 — 2026-08-05

This release keeps Claude and Codex connected to their live AllMyAgents role, tool, permission, and bounded
topology contracts across resumed and compacted conversations, routes otherwise stranded child permission
prompts to the correct upstream authority, and adds an accessible purpose inspector beside every managed child.

[Full v0.1.19-alpha.22 release notes](docs/releases/v0.1.19-alpha.22.md)

- Claude receives a role-specific AllMyAgents system append on every SDK query, including resumed turns after
  vendor context compaction. Overseers are directed to the fleet-wide app tools, managers to the real child/team
  tools, and managed workers to their persisted upstream reporting path.
- Codex receives the equivalent contract through the app-server's supported thread developer-instruction seam.
  Changed topology is refreshed on a loaded thread, and a completed compaction forces reassertion on the next
  turn instead of depending on one-time `AGENTS.md` discovery.
- Compaction now preserves the active objective, project and slice, scope, constraints, acceptance criteria,
  verified progress, current work, blockers, durable artifacts, team assignments, and exact next action. Codex
  receives a complete `compact_prompt`; Claude's compactor receives the same continuity contract through its
  per-query system append. Refreshing the local instruction cache never clears either vendor's thread or summary.
- Existing Overseer conversations migrate in place to capability contract v4, retaining account binding,
  history, and identity while receiving the durable provider-native discovery and permission-routing contract.
- Managers receive exact active/stashed team state plus bounded child ID/name/status mappings. Overseers receive
  a capped seven-day fleet/project index, with active work and explicitly mentioned projects included, and must
  refresh mentioned projects through live status/list/peek tools before reporting or acting.
- Manager guidance pushes independent work across the requested active-team capacity. Claude managers are
  guarded against passive/meandering holding loops; Codex managers are guarded against unbounded investigation,
  benign-noise escalation, scope growth, and consuming the whole context after acceptance criteria pass.
- A child approval first reaches a capable direct manager. If that manager cannot decide or receive it, the
  request is surfaced to the available Overseer with its exact bounded action and reason for escalation; only a
  direct operator turn can approve through the privileged control plane.
- Provider-specific denial feedback prevents prose/user-question permission loops and tells delegated agents to
  report the precise blocked action upstream while continuing unblocked work. Codex `request_permissions` now
  receives the documented granted subset rather than the incompatible command-approval response shape.
- Managed-child rows in both the sidebar and Project Overview now include a compact information control. Hover,
  keyboard focus, or click reveals the full configured purpose without navigating away or opening the chat.
- Release verification also hardens the attachment test harness against WHATWG-forbidden ephemeral ports and
  drains its queued bus callback before teardown, removing a Windows-only false failure without weakening the
  production path or assertions.

## v0.1.18-alpha.21 — 2026-08-05

This release makes journal lineage publication crash-atomic and recoverable, teaches the supervisor to
distinguish slow maintenance from a dead hub, repairs lazy history across generation changes, and removes the
renderer loop that froze the entire app while an otherwise successful account sign-in completed.

[Full v0.1.18-alpha.21 release notes](docs/releases/v0.1.18-alpha.21.md)

- Recovery adopts a fully verified generation interrupted between publication and activation, discards
  incomplete staging, rebuilds derived lineage metadata, and preserves immutable rollback receipts. Kill-point
  tests exercise both sides of the publication boundary with real child processes.
- Maintenance and backup work report instance-bound progress, committed rows, and written bytes out of band.
  The supervisor waits for a true no-progress interval, suspends termination during protected lineage phases,
  and no longer kills a healthy hub merely because one HTTP health request timed out.
- Lazy transcript history retries a stable cursor against the new generation while preserving the already
  reached history, live tail, and scroll anchor. Scrolling no longer strands the current replies behind a
  generation-change error.
- Account sign-in no longer creates a Svelte effect that both reads and writes tutorial login state. The mirror
  uses an untracked read and identity-stable no-op guard, so Claude and Codex logins can settle without pegging
  the renderer even when the credential was already stored successfully.
- Codex browser OAuth is opened by the desktop app, re-authentication resets to that documented default, and
  managed profiles pin CLI credentials to their own `auth.json` rather than depending on an ambient keychain.
- Project deletion now passes the packaged browser's authenticated CORS preflight for `DELETE`; both safe
  detachment and explicitly confirmed file removal reach the existing hub transaction.
- Existing Overseers migrate to capability contract v3 and are directed to the fleet-wide Overseer inspection
  path instead of a project-scoped vendor `peek_agent` tool. Missing worktrees are also detected without
  spawning the same failing Git probe on every poll.
- The dedicated Overseer sidebar entry now shows its truthful live lifecycle—thinking, idle, awaiting input,
  error, stopped, or unavailable—without requiring the operator to open the conversation first.
- Projects created through the Overseer now commit a canonical `project/created` lifecycle event in the same
  transaction as the project row. Every open local or remote project view upserts that event immediately, so a
  successful setup no longer exists only in the hub while the sidebar remains stale.
- Claude's organization-level “subscription access disabled” response is recognized as an account access
  failure. After the first authoritative rejection, central turn admission gates the affected profile with exact
  re-authentication/admin guidance instead of letting every attached Claude agent independently fail its next turn.

## v0.1.17-alpha.20 — 2026-08-04

This release adds durable manager-team generations and exact worktree/commit provenance, removes expensive
historical Git polling, unblocks journal maintenance on large databases, moves recoverable workspace cleanup
out of the hub readiness path, and repairs Codex sign-in so ordinary browser OAuth never requires a terminal
or device-code security setting.

[Full v0.1.17-alpha.20 release notes](docs/releases/v0.1.17-alpha.20.md)

- Managers can create, rename, list, and activate durable teams. Switching preserves the prior team's work,
  independently collapsible active/stashed team folders expose the lineup, and migration gives existing
  children a stable default team without rewriting their identities.
- Project activity attributes dirty files and commits to immutable agent/session, manager, team, branch, and
  worktree identities. Shared-checkout ambiguity is stated explicitly instead of inventing attribution.
- Historical attribution is cached and rate-limited; stashed teams no longer launch an unbounded Git-process
  burst every poll while their last trustworthy snapshot remains visible.
- Lazy composite indexes now let bounded journal condensation advance on the operator-scale journal. Startup
  emits phase timing, begins serving before conservative orphan-worktree cleanup, and gives fresh exits a grace
  period so a just-finished agent is not reclaimed during restart.
- Codex sign-in follows the current official CLI contract: `codex login` browser OAuth is the recommended
  default, while `codex login --device-auth` is an explicit remote/headless option. Device URL/code/copy
  controls live in the app, and every launch, opener, poll, failure, cancel, and post-login refresh is bounded.

## v0.1.16-alpha.19 — 2026-08-04

This release moved pairing, approved remote testbed operations, and Overseer-to-Overseer communication onto an
authenticated Site-free MyOwnMesh RPC lane, while preserving Site HTTP only as a mixed-version compatibility
path for the unified remote chat stream.

[Full v0.1.16-alpha.19 release notes](docs/releases/v0.1.16-alpha.19.md)

- Reciprocal short-code pairing and every subsequent direct request bind to authenticated mesh peer identity,
  HMAC request evidence, replay protection, device policy, and the exact operator-granted chat scope.
- Remote files, terminals, bounded environment discovery, WSL distributions, telemetry, transfer diagnostics,
  and no-duplicate mutating fallback work without a mapped Site.
- Remote access gained forced refresh and truthful Site-versus-direct status. Overseers gained whole-fleet
  inspection, authenticated peer discovery/messaging, exact-source reply authority, and automatic in-place
  capability migration for existing durable sessions.
- Exact-once receipts, blue/green handler ownership, disabled-exposure tests, and full packaged/native/sandbox
  release gates close the transport and lifecycle boundaries documented in the full notes.

## v0.1.15-alpha.18 — 2026-08-04

This patch keeps lazily reached history contiguous with the live end, repairs durable chat activity clocks,
and upgrades existing Application Overseer conversations onto the current app/tool contract without losing
their account binding or history.

[Full v0.1.15-alpha.18 release notes](docs/releases/v0.1.15-alpha.18.md)

- After scrolling upward into lazy history, the transcript now retains one continuous reached window through
  the actual latest reply. The bottom of a historical 120-item slice can no longer masquerade as the live end.
- Hub-native records now persist activity at provider-neutral status boundaries. Legacy records missing that
  field recover it from the newest retained transcript item, and relative labels continue aging while idle.
- Overseer contracts are versioned. The public-owner boot/restart reconciliation upgrades an existing
  Overseer in place, reasserts Full Access plus its explicit operator override, rewrites the current native
  instructions/tool manifest, and journals one idempotent capability-upgrade event.
- The migration remains behind the blue-green ownership fence: a booting green hub only reads the shared
  roster and cannot rewrite Overseer state until it has won the public listener handoff.
- The current Overseer control surface includes application guidance and UI highlighting, fleet diagnostics,
  projects/chats/managers/team presets, approvals and access overrides, model/effort configuration, account
  login, GitHub clone setup, mesh pairing, remote testbeds, audited elevation, and supervised hub restart.

## v0.1.14-alpha.17 — 2026-08-03

This patch repairs a live transcript cutoff that could leave a foreground chat stranded while the agent,
hub, and journal continued normally. Paused renderer queues now drain without discarding events, bounded
reconnects rehydrate every open pane, and journal history pages prioritize durable transcript semantics
over redundant streaming deltas.

[Full v0.1.14-alpha.17 release notes](docs/releases/v0.1.14-alpha.17.md)

- A background or scheduling-paused WebView no longer converts its 1,025th queued event into a cold
  baseline reset. It synchronously drains the finite 1,024-event batch and preserves strict FIFO delivery.
- Required baseline resets now explicitly reload journal history for every selected or split-pane chat,
  including when the session id stays unchanged and `ThreadView` therefore does not remount.
- Per-session history paging now selects user messages, completed provider items, errors, bus messages,
  compaction lifecycle, and other visible semantics before applying the 80-row/512 KiB bounds. Thousands
  of token, reasoning, or command-output deltas can no longer hide completed replies.
- The raw journal remains lossless. Semantic filtering applies only to the bounded renderer projection and
  uses the existing generation-checked SQLite read snapshot and per-session sequence index.
- The Apple Silicon one-command installer gate now authenticates its GitHub release lookup, eliminating
  false release failures when a shared runner IP has exhausted the anonymous API quota.
- Windows backup/recovery tests now wait for force-killed supervisor processes to release their compiled
  fixture before cleanup, and allow measured loaded-machine time for compiled-runtime verification.

## v0.1.13-alpha.16 — 2026-08-03

This release turns the Application Overseer into a practical setup, teaching, and recovery assistant;
adds durable team presets and audited elevation; completes Claude worker questions; aligns Full Access;
and polishes pairing, Browser, and transcript links without weakening operator provenance.

[Full v0.1.13-alpha.16 release notes](docs/releases/v0.1.13-alpha.16.md)

- Claude worker sessions now support the same durable `AskUserQuestion` lifecycle as in-process sessions
  over the mutually authenticated worker channel, including interrupt aborts and restart-safe correlation.
- The Application Overseer can now guide project setup, save and launch durable team presets, configure
  existing managers and per-chat model/effort/access settings, trigger account sign-in, manage remote-device
  grants, drive GitHub imports, and issue short-lived mesh pairing codes through existing audited brokers.
- First-run setup is now the short path from one account to one Overseer. The detailed visual tour remains
  optional, while the Overseer has a provider-neutral guide for explaining every major app concept and can
  open and spotlight allowlisted UI controls with a bounded, dismissible explanation.
- Agent failures now alert the Overseer through a diagnostic-only bus turn with bounded journal evidence.
  Automatic alerts can produce troubleshooting reports but cannot mutate hub state or inherit operator
  authority.
- Added an elevated-command escape hatch with deny-by-default per-project scopes, literal-path and
  blast-radius analysis, a non-auto-approvable operator decision, bounded Windows UAC execution, process-tree
  timeout, and full proposal/decision/execution audit. Full Access alone still cannot self-elevate.
- Direct project-manager assignments now carry a hub-verified, narrowly scoped authority statement, so
  children treat ordinary reversible work inside their existing workspace as in scope without letting an
  ordinary teammate widen permissions or authorize risky actions.
- Codex **Full access** now selects the vendor's unrestricted host sandbox while retaining hub approval
  callbacks, origin clamps, and audit policy. Operating-system elevation (Windows UAC or `sudo`) remains a
  separate host boundary.
- External research links render compact local GitHub, PDF, or website identity badges without fetching
  remote favicons merely because a transcript was displayed.
- Absolute local-file links in transcripts now reveal the existing file in the desktop file manager only
  after an operator click; plain-browser views copy the path, and neither route executes the target.
- The Browser control is icon-only at rest and expands to show Browser on/off on hover, keyboard focus, or
  while its menu is open.
- New mesh devices can pair with a typo-resistant `XXXX-XXXX` code. Codes are cryptographically random,
  one-use, memory-only, valid for ten minutes, and invalidated after ten failed guesses; existing long-lived
  device credentials remain available under an Advanced recovery control.
- Overseer bus messages and automatic failure alerts now wait for a separate diagnostic-only turn instead
  of being steered into a live operator-origin turn, preserving the privilege boundary under concurrency.

## v0.1.12-alpha.15 — 2026-08-02

This release adds authenticated remote device testbeds and an application Overseer, closes workspace and
backup growth leaks, makes context maintenance visible, and fixes startup, composer, login, and OAuth
refresh-state failures.

[Full v0.1.12-alpha.15 release notes](docs/releases/v0.1.12-alpha.15.md)

## v0.1.11-alpha.14 — 2026-08-01

This release fixes a Claude streaming-lifecycle wedge discovered in a live project-manager turn and makes
the operator's per-chat **Always allow** tool grant effective for manager- and teammate-started turns.

[Full v0.1.11-alpha.14 release notes](docs/releases/v0.1.11-alpha.14.md)

## v0.1.10-alpha.13 — 2026-07-31

This release focuses on journal durability, account re-authentication, long-history chat reliability,
project-manager controls, renderer recovery, and day-to-day navigation polish.

[Full v0.1.10-alpha.13 release notes](docs/releases/v0.1.10-alpha.13.md)

## v0.1.9-alpha.12 — 2026-07-31

This release repaired a concurrent journal-recovery metadata publication race and strengthened its
durability stress coverage.

[Full v0.1.9-alpha.12 release notes](docs/releases/v0.1.9-alpha.12.md)
