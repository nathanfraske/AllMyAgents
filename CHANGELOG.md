# AllMyAgents release history

All notable operator-facing changes are recorded here. The linked release notes contain the complete
feature and fix log used on the corresponding GitHub release.

## Unreleased

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
