# Test performance and agent-token sweep — September 28, 2026

Scope: source and local verification on top of `a3f638e7`. No release, installed runtime,
runner reconfiguration, live helper/model selection, permission change, or fleet dispatch.
Existing timing, child-visibility, approval-review, and Daybreak work is preserved.

## Implemented changes

1. **Production compilation excludes `*.test.ts` / `*.spec.ts`.** Packaging already discarded
   their JavaScript. `tsconfig.json` and the full `hub:typecheck` gate still include tests;
   `buildConfig.test.ts` checks that the only removed roots are tests. The real compiled-ESM
   backup/recovery fixtures still compile and launch production code, with no `noCheck` or
   mocked integration boundary. Clean-outdir comparisons verify identical production bytes.
2. **Manager tests copy an immutable seed Git repository.** Each harness still gets separate
   working files, index, refs, config, and objects. No clone hardlinks, shared worktrees, or
   reused databases. A regression mutates one copy and checks the other copy and seed remain
   unchanged. Only the redundant initial Git init/add/commit is amortized.
3. **Maintenance-child tests no longer depend on shell cwd.** The baseline's three failures
   were loader failures hidden as timeouts: `tsx` is a hub dependency, while `vitest --root`
   leaves the process cwd at the monorepo root. The test now resolves the loader from its
   package, drains bounded stderr, reports early exit, and waits for child close before
   touching/deleting its temporary database. A regression uses an unrelated cwd and an
   intentionally missing loader. No production maintenance behavior or test deadline was
   relaxed.
4. **Completion mail is a compact pointer to retained evidence.** Long command previews are
   capped at 180 code points; labels at 96; non-success error text at 500. Visible truncation
   markers and ANSI removal make those bounds honest. Successful stderr is described as
   retained diagnostics instead of a failure. Run ID/state/exit/signal, cancellation, unknown
   outcome/no-replay warning, and log-truncation disclosure remain. `inspect_runs` cursors,
   exact records (`detail=full`), raw logs, audit, receipt deduplication, and wake authority are
   unchanged. No summarizer model or new dependency is involved.

## Measurements and interpretation

Local Windows machine: 20 logical CPUs, 34,160,754,688 bytes RAM, Node 22.23.3.
These are local samples, **not qualification of the newly upgraded fleet runners**.
Runs on this checkout were serialized; no shared CI was dispatched.

### Compile and fixture microbenchmarks

| Same-work comparison | Before | After | Control |
| --- | ---: | ---: | --- |
| Fresh production compile, including vs excluding test roots | 18.070 s | 11.270 s | 125 production JS files byte-identical |
| Compiler memory in that sample | 601,938 K | 381,197 K | Full type checking in both builds |
| Emitted JS files | 280 | 125 | Removed output is test JS only |
| Real Git fixture creation, median of six | 323.4 ms | 33.1 ms | Independent full directory copy, no hardlinks |

The first compilation pair is ordered all-source then production-only; cache/order effects
mean its 37.6% wall-time reduction is an observation, not a universal CI speed claim. Fresh
Journal creation measured a 205.8 ms median; database durability was **not** mocked or relaxed.
The final candidate's reverse-order confirmation also passed: production-only **11.091 s**
first, all-source **16.856 s** second (34.2% lower); 371,978 K vs 603,355 K compiler memory.
All 125 production files were again byte-identical. All-source emitted 282 files after the
two added test files, versus 125 production-only.

Untouched full baseline: 275.86 s, 1,773 passed / 3 failed / 1 skipped. All failures were the
maintenance loader/cwd issue above. The same three unchanged tests passed from `apps/hub`
in 3.17 s. This distinguishes a harness defect from evidence that runner resources were
insufficient. It does not explain the separately reported hosted-Windows transfer/replica
timeouts; those tests passed in this baseline.

The four-worker full candidate passed **1,786 tests / 156 files**, with one existing skipped
test/file, in **229.44 s**. Manager tests were 73.46 s (baseline 117.13 s); the compiled-ESM
backup suite was 32.47 s (baseline 51.73 s). This is an ordered local comparison, and part of
the total improvement removes failed loader waits, so it is not a controlled CI speedup claim.

The same candidate at eight workers passed **1,786 tests / 156 files**, with the same one
existing skip, in **159.33 s**: 30.6% less wall time than the four-worker run. Individual suites
slowed under concurrency (manager 95.41 s; recovery 130.51 s), while total throughput improved.
This is one ordered sample on one 20-CPU Windows machine, not a safety proof for all runners.
Keep the four-worker default until cross-platform runner qualification supports changing it.
The existing Vitest CLI supports `--maxWorkers=8`; no new fleet-only test subset or bypass is
needed. All workflow steps, matrix entries, checks, and timeout regression coverage remain.

Exact comparison command from the repository root (use 4 or 8):

```text
node apps/hub/node_modules/vitest/vitest.mjs run --root apps/hub --maxWorkers=8 --reporter=default --reporter=json --outputFile.json=<absolute-report-path>
```

Run the unchanged type-check and all other project CI gates as well. This command is not a
replacement for the complete workflow. The packager credential-audit self-test also passed;
no new installed payload, live runner build, release, or deployment was qualified here.

### Completion-notice tokenizer proxies

Synthetic credential-free fixtures; `js-tiktoken@1.0.21`. Values are **serialization proxies,
not actual provider billing, cached-input counts, or a fleet-wide savings estimate**.

| Fixture | o200k before → after | cl100k before → after |
| --- | ---: | ---: |
| Short successful command, no stderr | 73 → 79 | 73 → 79 |
| Success, 1,000-character command and noisy stderr | 400 → 129 | 394 → 128 |
| Failure, same long command and stderr | 400 → 217 | 394 → 222 |
| Unknown outcome, long command | 295 → 144 | 295 → 144 |

The noisy-success fixture drops 67.8% by the first proxy. Short notices cost six additional
tokens to disclose the exact-record route. Failures still have a bounded diagnostic preview;
an agent investigating them must fetch actual evidence, not decide from this pointer alone.

## Sweep findings and next priorities

These are source observations, not proof of current fleet usage or permission to change live
settings. No private transcript/credential export or provider inference was used.

| Priority | Finding | Action / boundary |
| --- | --- | --- |
| Implemented | Command and stderr repeated in completion mail; successful stderr called failure | Compact notice above; full retained evidence unchanged |
| Already present | Polling unchanged runs, large run records, generic roster repetition | Keep completion delivery + `control_run wait`, cursor paging, compact default records, grouped roster, and filtered `query_team` |
| Next, measured rollout | Tool catalog is large: 47 non-Overseer tools / 9,270 o200k proxy tokens; 48 Overseer tools / 13,503 | Authenticated role/capability-appropriate discovery could shrink it further; do not remove tools based on agent claims or obscure granted operations. Existing filtering already removes the 4,233-token `overseer_control` declaration for non-Overseers. Qualify catalog refresh and old-hub fallback first. |
| Next, bounded API design | `inspect_runs` can return 64 KiB **per stream** at once | Consider caller-selected page bytes or a metadata-only view, preserving byte cursors, no dropped log bytes, explicit truncation/EOF, and a full-detail path. Do not silently replace logs with model summaries. |
| Next, operator-visible hygiene | `PracticeStore.materialize` can include up to 500 full practice bodies without an aggregate character budget | Add per-scope size visibility, deduplication suggestions, and operator-controlled archival/priority. Never silently drop standing instructions or revoke culture to save tokens. Existing `session/instructions` receipts already record character counts. |
| Next, diagnostic precision | A failure view based only on a recent event tail can miss the actual error after recovery | Return latest indexed error plus bounded recovery/current-state evidence, avoiding repeated transcript archaeology. Preserve historical cause vs current health. |
| Preserve | Native runtime contract and managed instruction file repeat some authority/lifecycle rules intentionally | Measure actual request/cached-token telemetry before attempting deduplication. Do not trim prompt-injection, exact review, grant, or unknown-outcome safeguards. |
| Preserve / observe | Memory recall is capped at five 240-character snippets and deduplicated in process | Prefer concise titled notes with source IDs and explicit supersession; inspect recurrence across real hub restarts before adding persistence or changing recall semantics. |
| Preserve / observe | Quota suppression is deterministic in the completed Daybreak source; approval helper is not general error triage | Avoid adding a paid model pass for known exhausted credits. Unknown/auth/context/security errors still require evidence. Do not silently change saved helper models, account, or risk ceiling. |

The common MCP header alone is 54/53 proxy tokens; some clients repeat it per tool. This is
not proof of a fresh charge on every request. `start_run` and `send_message` are the largest
non-Overseer declarations (912 and 636 o200k proxy tokens including schemas). Their authority,
dependency, unknown-outcome, and wake guidance prevents expensive unsafe/repeated calls;
shortening them is lower priority than reducing avoidable output and wake-ups.

No blanket TOON conversion: the earlier [identical-data study](mcp-toon-evaluation-2026-09-09.md)
already found compact JSON preferable for heterogeneous run records. No alternate serialization
or tokenizer runtime dependency was added.

## Tool-use practices

- Use one addressed `send_message`; `wake=false` for routine FYIs. Do not broadcast to find an
  owner, send acknowledgement loops, or mark ordinary progress urgent.
- Keep stable run/transfer/approval IDs. Inspect terminal mail once, page with returned byte
  cursors, and use `detail=full` when auditing exact invocation/provenance. EOF is not completion.
- For own runs, do useful work or park once and end the turn. For authorized GitHub Actions,
  use the durable CI monitor. Do not hold a model turn open to poll.
- Use bounded `query_team` facets/session filters and `peek_agent`, not whole-journal scans or
  waking a teammate just to ask status. Ask for the precise missing receipt before widening reads.
- Transfer whole files through the authenticated transfer tool; publish artifacts by path.
  Do not ferry base64 through chat or inline megabytes of build output. Preserve unknown-outcome
  receipts; never retry an ambiguous mutation blindly.
- Prefer a checked-in verification script over a long inline `-e` command for recurring gates.
  Keep commands reproducible, environment/setup declared by the project, and all checks owned
  by project source. A faster runner is not justification to omit a check.
- Track task completion, retries, missed failures, latency, input/cached/output token usage,
  and operator interventions together. A shorter payload that causes extra tool turns can cost
  more overall; the goal is complete evidence with less repetition.

## Retained evidence

- Baseline full suite: `4cb8b021-b00e-4197-ba30-d52c4a705bb1`; JSON
  `.allmyagents/test-profile-hub-baseline.json`.
- Original compile comparison: `bdc8a78a-bf9b-42f1-bf98-a81a8690df31`.
- Git/Journal fixture benchmark: `c72aede1-3f64-4cb6-a989-ca998badfd3f`.
- Unchanged maintenance tests from package cwd: `2b540934-1077-4567-a62d-0dafdae21d2a`.
- Focused five-file suite, 106 passed: `1d2a37d5-62ab-4ae7-bd17-41cdfb433e9e`.
- Full type check after correcting the test-only ForkOptions type error:
  `1d0cb0ff-1dbb-4c2c-a2d1-e6cdda65fff2`.
- Production build: `7c11c5a5-1d2f-43fd-961c-c51d7d99fcb7`.
- Synthetic notice/catalog benchmark: `35f72452-5130-4173-b611-4714e04b336b`.
- Full four-worker suite, 1,786 passed / 1 existing skip, 229.44 s:
  `8727e4da-4593-4e74-8dbf-0f528f90cee9`.
- Full eight-worker suite, 1,786 passed / 1 existing skip, 159.33 s:
  `670ff8c6-2c9f-47fd-b759-b67fa3465566`.
- Reverse compile, identical production output: `87b6d073-43c3-44f0-91e3-3f0f599cc07a`.
- Packaging credential-audit self-test: `3ab4b319-29c2-44a8-bcfc-498fe431c601`.

Superseded diagnostics are retained honestly: `cdcb852e` and `6552802f` exposed the test-only
ForkOptions type error; `e2aa8678` exposed a benchmark-only package.json exports mistake. None
is counted as passing evidence. Source changes do not alter already-installed completion mail.
