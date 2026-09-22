# September 22 hub responsiveness incident

## Verified evidence (read-only live diagnosis)

The operator reported that several turns took minutes to begin without useful feedback, and the
Overseer could not inspect teammates within the five-minute MCP deadline.

- At approximately 16:45 UTC, `/api/health` did not respond within a four-second local deadline.
  By 16:50:37 UTC it answered HTTP 200 in 0.812 seconds. PID 14048 remained the same; no restart was
  performed. A concurrent `list_agents` eventually returned successfully.
- The live journal was 5,730,414,592 bytes. Its session side-index frontier equalled the maximum
  event sequence (11,944,347 in the diagnostic snapshot).
- Overseer events 11942971 and 11942980 retain failed `overseer_control(operation=status)` and
  `peek_agent(view=activity)` calls with durations 300,014 and 300,017 ms and the exact error
  `timed out awaiting tools/call after 300s`.
- Jackson's input 11941431 at 16:24:08.343 UTC preceded instructions 11941433 at 16:31:00.277
  and journaled turn-start 11941449 at 16:34:05.548. The instruction boundary alone took 411.934 s.
  These are journal-observed times, not independent provider-arrival timestamps: a blocked hub can
  also record worker events late.
- Installed `recentEventsForSession` uses `WHERE session = ? ORDER BY seq DESC LIMIT ?` directly
  against `events`. SQLite reports `SCAN events`; there is no corresponding session index on that
  table. `overseer_control(status)` calls `operatorInterventions` for every session (77 in this
  incident), and each invocation requests 100 recent rows through that method.
- A separate read-only connection, guarded by a 15-second process deadline, measured one old idle
  session's query at **7,038.06 ms**. The existing `journal_session_event_index` join returned the same
  100 rows in **2.71 ms**, with identical SHA-256 over the serialized rows. This is a single warm/cold
  mixed diagnostic comparison, not a fleet-wide or end-to-end post-fix benchmark.
- Installed `taskBoardForSession` still replays up to 20 x 500 raw events. Those forward pages also
  bypass the index. Manager instruction materialization occurs synchronously after `session/input`
  and before dispatch. The complete task-only replay repair in local commit `2cb38fe` is not installed.

The expensive queries run synchronously on the hub event loop. A row limit caps results, not the
work needed to locate them. The per-agent repetition explains why a nominally bounded status query
can block health, input delivery, and tool responses for minutes. The exact contribution of each
call during the incident was not CPU-profiled. Concurrent backup/maintenance is not established as
the cause: the inspected progress receipt reported completion, and the process never restarted.
Likewise, process cumulative read bytes are not a measurement of physical disk throughput.

## Source repair

`journalSessionReads.ts` centralizes indexed reads for `recentEventsForSession`, `eventsForSession`,
and `lastTurnOrigin`. The index frontier and selected rows are read in one SQLite transaction. An
incomplete legacy backfill uses the exact original table, not incomplete projected state. This
fallback can still be slower until ordinary backfill completes; it must never revive stale operator
authority or silently omit transcript rows. No schema migration, boot-time index creation, permission
change, timeout increase, payload truncation, or new cache is introduced.

The existing task-only replay repair complements this change by avoiding unrelated transcript/blob
hydration while building task boards. This incident's repair does not add a new queued/starting UI
state: long-running admission outside these repaired reads remains a separate feedback concern.

Regression coverage is in `journalSessionReads.test.ts`: structural query-plan checks (not flaky
timing assertions), 10,100 unrelated newer events, exact pages/cursors, missing sessions, backfill
gaps with new indexed appends, restart, deletion, authority, payload hydration, malformed JSON and
row ceilings. Run alongside journal, journalTasks, projectManager, overseer and midTurnSteer tests,
then hub typecheck/build. Also qualify cold manager admission and fleet status against a multi-GB
copy before release. Do not create assignments or replay operator inputs on live workers as a test.

## Verification and deployment boundary

The first verification attempt was denied by the chat's **Allow durable runs** gate. That grant was
subsequently enabled by the operator; no alternate unmanaged test process was launched.

- Durable run `66f92381-a4e2-4cd6-bac5-00d279a12d32`: **156 tests / 6 files passed**, exit 0.
  Includes journalSessionReads, journal, journalTasks, projectManager, overseer and midTurnSteer.
  Retained stdout/stderr complete (28,321 / 7,932 bytes); stderr includes expected negative-fixture
  errors and Git line-ending warnings, not a failed test run.
- Durable run `d99f4416-5886-4ce5-9427-ecfd059a2c55`: hub TypeScript `--noEmit` passed, exit 0,
  no stdout/stderr. Both runs verified the source worktree at parent `fbc187d` plus this patch.
- The single live-database read-only comparison above ran. End-to-end cold fleet-status and manager
  admission qualification on an isolated multi-GB copy is still required; these unit tests are not
  a claim that the installed application has been fixed.

## Evening recurrence (22:44–23:02 UTC)

The operator clarified that the symptom is a 5–7-minute pause after work starts, followed by recovery.
Bounded, metadata-only journal reads found:

- 22:47:17.314 to 22:49:55.386: **158.072 seconds** between events 11999557 and 11999558;
  the latter is `manager/team-queried`.
- 22:49:56.935 to 22:52:42.717: **165.782 seconds** between events 11999784 and 11999785;
  the latter is another `manager/team-queried`. A remote-device request immediately precedes this gap.
- At 22:53, a tasks-only `peek_agent` took **42,612 ms** (completed event 12000119).
- At 22:58, another `query_team` took **75,965 ms**, with synchronous query completion journaled at
  22:59:57.908 (12012122). The provider result was journaled later (12015896).
- At 23:01:20 the same hub PID 14048 returned health HTTP 200 in **1.12 ms**.

These are strong correlations with the independently measured unindexed read path, not a sampled
CPU stack proving every millisecond's attribution. In particular, a background maintenance worker
can write an event while the hub thread is blocked. An isolated healthy endpoint sample does not
disprove intermittent main-thread starvation.

Separate diagnostic findings: the currently granted K3 lookup reports denied MyOwnMesh pipe access
and no signed AllMyStuff roster route; this is not an explanation for a temporary local hub stall.
Jackson-to-Overseer addressed messages succeeded; two older pending FYIs explicitly used `wake=false`.
The installed `peek_agent(all/changes)` has no aggregate diff-byte budget; `limit` only affects its
transcript page. Its `main...HEAD` diff can include inherited committed vendor history (B1 HEAD
ce1452fa, local main b15aa1a). B2's concurrent fetch failure is retained, but causation by B1's large
result is not established. This source patch does not repair diff bounding or worktree-alert flooding.

No installed code, existing transcript data, grants, other agents, services or machines were changed.
The normal durable-run records/logs for the two verification commands were created by the app.
The repair remains source-only and has not been released or deployed.
