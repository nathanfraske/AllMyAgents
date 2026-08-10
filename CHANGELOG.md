# AllMyAgents release history

All notable operator-facing changes are recorded here. The linked release notes contain the complete
feature and fix log used on the corresponding GitHub release.

## Unreleased

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
