# Manager usage and journal refresh investigation

Source pass on `fix/journal-status-manager-usage`, based on `dfeb5a3`. No live service restart,
deployment, journal repair, deletion, or account/policy change was performed.

## Measured manager usage

The current MyOwnMesh V4 Transition manager is `ee63e095-2400-4081-bf43-49a6a251fe46`, on
`codex-a` (not the historical Codex B manager). Read-only, indexed journal inspection was bounded
to 20,000 session events at or below sequence 10871328. No blob hydration or full-database scan
was needed. Token endpoints: 2026-09-08 22:06:29.574Z to 2026-09-09 03:42:23.348Z.

| Counter difference | Tokens |
| --- | ---: |
| Input, including cached input | 63,955,927 |
| Cached input | 62,123,008 (97.13% of input) |
| Uncached input | 1,832,919 |
| Output, including reasoning output | 218,672 |
| Reasoning output subset | 89,316 |

These are differences between provider-thread cumulative counters, **not sums of usage notifications**.
The sample contains 382 notifications / 373 distinct cumulative totals. The latest total of
110,050,856 is a thread-lifetime counter, not the size of one prompt. Cached input is not a claim
about free tokens, subscription quota accounting, or billed dollars. Exact causal attribution of
tokens to app features versus project work is not available from this ledger.

One concrete inefficiency is measurable: 1,201 of 1,609 completed MCP calls were `inspect_runs`.
844 returned no new output while a run was still queued/running; one identical request, including
unchanged cursors, occurred 287 times. Immutable command/provenance metadata was repeated each time.
The same sample also contains real build/test work and coordination; this is not evidence that all
input tokens were wasted, or that every poll caused its own model request.

Re-serializing the 1,187 parseable recorded inspection responses through the revised tool reduced
response bytes from 6,239,332 to 3,117,690 (~50%). Fourteen non-JSON/error responses were excluded.
This measures serialized response reduction, not future total-token savings. `inspect_runs` now
defaults to compact state/cursors, gives explicit no-output/completion guidance, and keeps exact
retained command, provenance and result available via `detail: "full"`. Log contents, byte cursors,
terminal states, failures and project scope checks are preserved. The shared tool definition serves
both providers. Existing manager instructions already prohibit unchanged polling; the immediate
tool result now reinforces that instruction where the observed loop occurs.

## Journal evidence and repairs

The live database measured 4,902,379,520 bytes. Twelve consecutive recent maintenance records each
deleted zero rows and deferred behind recovery generation 534, at a five-minute cadence. Observed
cycles took roughly 8–33 seconds. This diagnostic means cleanup is current through the published
snapshot, not that the journal is corrupt or unavailable.

1. **Redundant validation I/O:** maintenance re-ran `json_valid` across the entire events table on
   every cycle. The new validator maintains one resumable sequence cursor and validates batches of
   500 rows by default. Database triggers rewind the cursor for inserts/rewrites behind it, including
   writes from a different connection. Read/advance is atomic; unchanged cycles read zero payloads.
   Initial work remains post-ready, yields between batches, and respects the maintenance work budget.
   This cursor is not deletion authority: independently verified snapshot coverage still gates all
   pruning. Full snapshot verification remains unchanged. This is not a physical-integrity scrub;
   SQLite/snapshot integrity checks still handle physical damage.
2. **Postponement mistaken for success:** when maintenance owned storage, the snapshot wrapper returned
   successful `skipped`, and the supervisor delayed retry by the ordinary six-hour large-DB interval.
   It now returns a distinct `deferred` result, retries in 60 seconds by default (bounded/configurable),
   does not clear an existing degraded state, and still permits only one in-flight snapshot.
3. **Misleading yellow icon:** the known “cleanup is current through recovery generation” wait is
   neutral. Missing/invalid snapshot coverage and unobservable/failed maintenance remain warnings/errors.
   Generic deferrals are no longer all mislabeled “waiting for snapshot.”
4. **Transcript disappearing during refresh:** `installReplayBaseline` discarded displayed native
   history before its asynchronous replacement succeeded. Same-generation forward catch-up now
   preserves loaded views, with authoritative records refreshed. Generation changes retain a
   presentation-only last frame until a successful history read replaces it; old status/permissions
   are not reused. Failures retain that display plus the retry error. Superseded history failures
   cannot clear the replacement request's loading marker. Live tail and recovered latest history are
   ordered together. Reconnect diagnostics now include the actual close code/reason.

The fourth defect was reproduced at the store and rendered-component boundaries. It explains the
visible disappearance on baseline refresh, but the exact transport event triggering the operator's
live flicker was not captured. This does not certify every live disconnect as resolved. The isolated
browser reached the hub's diagnostic root, not the operator's desktop renderer.

## Verification

- Hub: `journalBackup.test.ts`, `journalMaintenance.test.ts`, `journalPayloadValidation.test.ts`,
  `agentToolCore.test.ts` — 84 tests.
- Web: `store.test.ts`, `Sidebar.status.test.ts`, `ThreadView.interaction.test.ts` — 184 tests.
- Hub `npx tsc --noEmit`; web `npm run check`.
- Synthetic multi-GB benchmark (operator data untouched): from `apps/hub`, run
  `node --import tsx ../../scripts/benchmark-journal-payload-validation.mjs 2`.
  Fixture: 65,515 rows / 2,180,435,968 bytes. Prior full scan: 2,993 ms. Initial bounded validation:
  3,293 ms across 132 batches; largest batch 39 ms. Next unchanged cycle: zero payload rows / 0.315 ms.
  After one insert: exactly one row validated. Generated fixture was removed by the benchmark.
  OS cache was not purged; these are work-shape measurements, not a cold-render latency guarantee.

Live qualification after an explicitly approved update: observe completion of a fresh backup rather
than another six-hour postponement; inspect maintenance duration; leave a loaded conversation visible
during a reconnect and verify that history remains visible with truthful loading/error state. No OS
reboot is required. Manager polling frequency and token savings need measurement after the new tool
contract reaches its provider session; do not present the response-size comparison as that measurement.
