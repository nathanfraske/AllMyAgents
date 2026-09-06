# Scroll and activity fix pass — 2026-09-05

Operator's active requests (additive; old K3/release work must not displace this slice):

1. Diagnose/fix wheel/touchpad scrolling lag; dragging the scrollbar is responsive.
2. Deliver durable run outcomes during an active manager/worker turn, without losing or duplicating
   completion notices at the turn boundary or blasting a completed batch into a new turn unnecessarily.
3. Show web browsing/research operations and destinations in the activity log.
4. Handle current Codex questions using its actual protocol; compare Claude rather than merging schemas.
5. Investigate remaining journal history/status/size problems. Simplify only with evidence and preserve
   durable state, history and recovery guarantees. No destructive live cleanup or service restart.
6. Browser/GitHub/Runs tabs: expose the working diff/GitHub view even when a project chat only has cwd;
   compact Runs icon with active count and hover label; no vacant hardcoded tab slots; dock closed tabs
   to the conversation's new edge when a panel opens. Runs need project grouping and agent attribution.

## Current verified state

- Branch `fix/scroll-run-activity`, based on `22dec8a` (v0.1.41-alpha.45 release branch).
- Unrelated untracked `.allmyagents/`, `.probe-codex-home/`, AGENTS.md, CLAUDE.md and culture spec preserved.
- ThreadView's Svelte `onwheel` compiled to a non-passive handler. Actual Chromium inspection confirms
   `passive:false`. Switched to lifecycle-owned `svelte/events.on(..., {passive:true})`; real browser
   confirms `passive:true`. Once detached, wheel intent no longer synchronously reads layout on each sample.
- Focused interaction + scroll suite: 32/32 pass. Includes passive listener/cleanup and 100 wheel samples
   without repeated layout reads; existing follow-tail, delayed intent, jump and remount tests retained.
- `scripts/check-transcript-scroll.mjs` is an isolated real-component browser harness with 1,200 synthetic
   history rows, no live hub/browser/session access. Browser startup must use the fixture URL as initial
   argument (early Page.navigate can be aborted by initial page startup). Synthetic main-thread stress
   still shows ~350ms presentation delays even with passive handlers: it does NOT prove all UI stalls
   are fixed. Do not claim live wheel latency measured or a numeric before/after speedup. User's latest
   physical scroll actions were NOT recorded; told them explicitly.
- Prior catalog-refresh change replaces profile arrays every 5s; not proven as scroll root cause yet.

## Implemented fixes

- `sessions.ts:reportDurableRunTerminal` now attempts ordinary `deliverBus` immediately for active and
  idle owners. The durable receipt key `durable-run-terminal:<run.id>` is unchanged. Existing provider
  ACK, authority, steering preferences and queue-on-rejection rules remain authoritative. Regression:
  successful active steer delivers once with no idle duplicate; rejected steer retains one idle follow-up.
- `ThreadView.svelte` owns one adjacent tab rail inside the conversation. It exposes Browser, GitHub/Diff
  even for cwd-only checkouts, and icon-only Runs with active count and hover label. Opening a panel moves
  the entire rail to the conversation's new edge. Native agent tabs join the same rail when present.
  The existing panel/commit-link implementation is reused, not a second GitHub browser.
- `RunsPanel.svelte` groups active runs by project and labels their agent; completed runs remain collapsed.
  Separate bounded active/completed queries stop a long run disappearing behind 50 newer completions.
  Visibility still comes from the existing authorized run API. Stale cross-session responses are discarded.
- `store.svelte.ts` now renders native Codex `webSearch` starts and upserts completion into that exact row,
  including sub-agent attribution. `toolBlurb.ts` shows queries and open/find destinations. Claude's existing
  WebFetch/WebSearch rendering is retained; MCP navigation gets a useful URL tooltip.
- `codexQuestions.ts` is a small provider adapter onto the EXISTING QuestionService, not a second question
  lifecycle. Both worker and in-process executors use it before the approval path. Stable native RPC
  correlation includes process generation and id type (number versus string), root session and item id.
  Questions cannot become boolean permission grants. Vendor cleanup aborts only the matching thread/request;
  late answers are suppressed, duplicate RPC ids cannot orphan cards, missing/invalid ownership fails closed.
- Codex cards support id-keyed answers, free text, offered-choice-only prompts, secret input masking, and
  blocking/nonblocking state. A nonblocking question is not killed just because the turn completes.
  Question-service audit remains metadata-only; the raw Codex request is not copied into journal events or
  notifications. Cancellation/interruption does not manufacture an operator choice. Claude keeps its strict
  1–4 question schema, implicit Other, question-text keys and comma-joined multi-select answers.
- `journal.ts` uses SQLite's `journal_size_limit` (64 MiB retained spare WAL by default, injectable bound)
  instead of retaining the all-time-high WAL allocation indefinitely. SQLite trims only when a reset is
  safe. There is no forced TRUNCATE checkpoint, reader eviction, live cleanup or reduced durability.
  Regression holds a read snapshot while WAL grows past the bound, then proves ordinary checkpoint/write
  resets reclaim spare space without changing that snapshot or losing any of 130 durable events.

## Provider evidence

The OpenAI Docs skill was used for the protocol comparison. Official app-server documentation:
https://learn.chatgpt.com/docs/app-server (redirect of developers.openai.com/codex/app-server).
The installed package, `@openai/codex` 0.153.3, is the exact implementation authority. Its generated
`ToolRequestUserInputParams.json` requires `isBlocking` and marks `autoResolutionMs` deprecated. Answers
are `{answers:{<questionId>:{answers:string[]}}}`. `serverRequest/resolved` identifies thread + RPC request.
The installed Claude SDK is 0.3.220 / CLI 2.1.220 and retains the separate AskUserQuestion format.
Local generated schema evidence is under `.allmyagents/codex-schema-0.153.3` (not committed as product code).
Bounded host admission is 1–8 Codex questions, at most 12 options each, with text/answer size limits;
those bounds do not purport to be vendor schema limits.

## Journal measurements and truth boundary

`scripts/inspect-journal-reads.mjs` opens ONLY a read-only better-sqlite3 connection in a separate diagnostic
child with a 45-second hard parent deadline (including native-addon stalls). It never instantiates Journal,
migrates, checkpoints or outputs payloads.
Measured against the live database on 2026-09-05 around 22:14 UTC:

- ~4.27 GB SQLite, incremental vacuum enabled, **zero freelist pages**. A VACUUM alone cannot solve that
  footprint: it is not just abandoned free pages. Do not promise a smaller database by deleting history.
- History and session index frontiers were current at event 10,330,029. The five sampled indexed history
  pages took 0.38–0.69 ms, returning 41 candidate rows / 60–164 KB stored bytes. EXPLAIN confirmed primary-key
  lookup by session/sequence, not a full journal scan. This is a warm/local SQL sample, NOT end-to-end or
  cold-blob latency and does NOT reproduce the user's intermittent eight-second timeout.
- Recent maintenance cycles completed: 286 rows / ~1.05 MB payload removed with 281 pages reclaimed; prior
  cycle 2,616 rows / ~1.51 MB with 678 pages reclaimed. The old snapshot-frontier deadlock was not present
  in those cycles. Current Sidebar already distinguishes deferred snapshot work from unavailable status.
- Of a bounded 20,000-row sample (not whole-database totals), large contributors were diff snapshots
  9.27 MB, completed items 9.03 MB, command-output deltas 5.56 MB and item starts 2.25 MB. Lossless superseded
  row cleanup already targets these; exact history retention is intentionally not blanket-truncated.
- Source still validates all event JSON during each out-of-process maintenance cycle. Replacing that
  with incremental validation requires an explicit corruption/invalidation proof; it has NOT been changed
  on speculation. No claim that every history/renderer stall is fixed.

SQLite's built-in WAL retention semantics: https://www.sqlite.org/pragma.html#pragma_journal_size_limit.
An active reader can legitimately retain more WAL than the spare-space target until its snapshot ends.

## Verification

- Full web suite: **747/747**, 79 files, followed by the final provider-announcement/id-answer
  regression: ThreadView question file **6/6**. `pnpm web:check`: zero errors/warnings.
- Hub question lifecycle/API/worker/in-process/sub-agent suites: **56/56**; new id-type regression later
  raises the Codex question file to seven tests. Agent-tool/worker/mid-turn suites: **63/63** before the
  additional nonblocking-notification regression. Final worker + Codex question rerun: **27/27**.
- Journal/read/blob/maintenance + complete project-manager suite: **86/86**.
- Hub TypeScript check and hub/web production builds passed. Web build retains its existing >500 KB
  chunk warning; not represented as a clean bundle-size gate.
- Real Chromium harness: 1,200 synthetic history rows, passive wheel listener verified; detach/jump/live
  append behavior passes. Browser/GitHub/Runs rail docking passes at 1200, 800 and 560 CSS px. Screenshot:
  `%TEMP%/ama-scroll-panels.png`. No personal browser, live session or provider was used.
- A contended browser run (in parallel with test suites) measured p95 wheel-to-frame ~9 ms and one
  ~344 ms outlier. Controlled 350 ms renderer stress still delays frame presentation with passive input.
  This is why we do not claim all main-thread lag is eliminated by the wheel fix.

## Remaining / handoff

Source/test changes are checkpointed on `fix/scroll-run-activity`. No release, live install, service
restart or OS reboot has happened in this pass. The latest source fixes need a release before the operator
can qualify them in their running desktop. Intermittent history timeouts still require a captured failed
request and renderer/hub trace; the sampled SQL timings do not establish their cause. Preserve this
distinction instead of retroactively describing the WAL allocation fix as a proven timeout cure.
