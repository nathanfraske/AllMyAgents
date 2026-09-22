# Complete task boards and quota-failure routing

## Task replay

`SessionManager.taskBoardForSession` previously stopped after 20 pages of 500 **raw** events.
Because replay is oldest-first, a long-lived worker could retain an assignment durably while its
manager could neither see nor update it. Raising the limit or taking a recent tail would still
lose authoritative state.

`Journal.taskBoardEventsForSession` now reads all retained task-relevant records in one read
transaction. It uses the existing session index when complete, falling back to the source table
during legacy backfill rather than trusting a partial index. SQLite selects only manager
assignments, Codex plans, Claude task tool blocks and their matching results. Unrelated blocks
in the same Claude message are removed before blob hydration. Existing reducers and ownership
checks consume that complete stream unchanged. This adds no live migration, replay cap, task
recreation or boot-time index construction; historical assignments already present recover on read.

Coverage: beyond 10,000 unrelated events, old task completion, new task plus immediate update,
mixed vendor plan/manager state, foreign-owner denial, restart, incomplete/backfilled index and
large unrelated blobs omitted before decoding. Tests use disposable journals only.

## Quota alerts

An automatic child/fleet error alert is suppressed when its terminal error is a usage-limit
failure and its manager/Overseer uses the same exhausted provider account. Identity is the same
profile or matching provider account ID (email fallback only without contradictory account IDs),
never an operator alias or matching email across different providers.

Suppression creates `session/usage-failure-alert-suppressed` with source/recipient profile/session,
failure sequence and known reset time. The original session error and operator notification remain;
no bus row is queued to cause an immediate failure cascade or stale post-reset replay. Each new alert
checks current usage evidence: elapsed reset windows, paid overflow or newer healthy evidence remove
the hold. An explicit terminal quota failure is still evidence when the provider omitted a limits event.

Different-account recipients still receive alerts. Cyber-policy refusals, organization entitlement,
expired credentials, context length and ordinary build failures are not classified as usage exhaustion.
No account switching, provider retries, authority changes or operator-error suppression is performed.
