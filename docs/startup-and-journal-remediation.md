# Startup storm and journal growth — remediation brief

Owner: Allen (AiAgentApp). Raised by the Overseer from a live incident on 2026-08-14.
Goal: fix all of this permanently, with tests, and ship it in the same release as the
direct-lane signing fix.

---

## 1. What happened

The operator updated to latest. The app took **3m12s** to become usable and showed
`[desktop] boot error: The hub started but did not become ready in time` twice.

The hub started, **passed its own preflight, and was killed — four times**:

```
12:24:51  hubctl starts
          x5:  database-integrity: passed (11.3-12.2s)  ->  preflight complete (12.4-13.6s)
               [hubctl] respawn attempt N failed: Error: timed out waiting for preflight liveness
               [hubctl] hub(blue) exited (code=1 signal=null) - UNEXPECTED
               backoff 1s / 2s / 5s
12:26:35  attempt 5 reaches "listener ready: port 7777"
12:27:08  backups\hub-....db                3047.8 MB
12:27:08  journal-recovery\...\snapshot.db  3047.8 MB
12:27:56  hub.db rewritten                  3047.8 MB
12:28:03  settled
```

~58s of repeated integrity checking, 8s of backoff, then ~9 GB of writes.

Governing constants (`restartHandshake.ts:23-26`):

```
HUB_PREFLIGHT_START_TIMEOUT_MS    = 10_000
HUB_PREFLIGHT_LIVENESS_TIMEOUT_MS = 10_000
HUB_PREFLIGHT_ABSOLUTE_TIMEOUT_MS = 300_000
HUB_PREFLIGHT_STATUS_INTERVAL_MS  = 10_000   // log throttle only, not the heartbeat rate
```

Heartbeat is every 1s (`index.ts:172`), so **ten consecutive beats were missed** — the main
thread stalled for >10s.

---

## 2. Measured state of the journal

```
hub.db            2.98 GB   988,353 rows   2026-07-27 -> now (18 days)
backups           5.91 GB   3 files today, each a FULL copy
journal-recovery  5.90 GB
data dir total   16.3  GB
```

Bytes by kind:

```
1134 MB    27,256 rows   claude/user           ~42 KB/row (tool results journaled as user turns)
 938 MB   160,374 rows   codex/item/completed
 102 MB    49,128 rows   claude/assistant
```

**The decisive number:**

```
rows over 64 KB: 5,453 (0.55% of rows) holding 1.57 GB - 60% of all payload
```

Age-pruning alone does not solve it — growth is recent:

```
keep last  7d -> 1.80 GB    prunes 0.82 GB
keep last  3d -> 0.77 GB    prunes 1.84 GB
keep last  1d -> 0.18 GB    prunes 2.44 GB
```

---

## 3. Work items

### A. Bound journal payload size  *(root cause of BOTH the startup storm and the disk usage)*

0.55% of rows hold 60% of the database. Everything else on this list is a symptom of it:
integrity-check duration, backup size, recovery snapshot size, and the main-thread stalls
all scale with the file.

**Hard constraint: the journal is durable session state.** `sessions restored: 54 session(s)`
and `replayBaselineFrom` reconstruct live sessions from it. Do **not** blanket-truncate
payloads — that silently destroys transcript history and breaks resume/replay.

Candidate approaches, in the order I'd evaluate them:

1. **Spill large payloads to a sidecar blob file, store a pointer.** Preserves every byte,
   keeps the SQLite file small, keeps integrity_check fast. Highest fidelity, most work.
2. **Compact superseded streaming deltas after their terminal event.**
   `codex/item/commandExecution/outputDelta` (35,056 rows) and
   `codex/item/reasoning/summaryTextDelta` (46,993 rows) are streaming fragments that
   `codex/item/completed` supersedes. Once the completed item is durable the deltas are
   redundant and can be collapsed. Verify that claim against the replay path before relying
   on it.
3. **Cap only at ingestion for kinds that are provably not replay-critical**, with the cap
   recorded in the row so it is visible rather than silent.

Pick one and say why in the commit message. Whatever you choose must survive a
kill-9-mid-write and still replay.

**Acceptance:** a synthetic run that writes N MB of oversized payloads leaves the SQLite file
bounded; all 54 sessions still restore; `VACUUM` reclaims the freed pages (a delete without
VACUUM will not shrink the file).

### B. Do not re-run a preflight that already passed

The boot verified the same unchanged database **five times** and discarded four passes —
~47s of pure waste, and the extra processes are the most likely source of the contention in (D).

Cache the pass for the retry loop within one supervisor boot, keyed on journal identity
(path + size + mtime + inode/file-id + recovery generation). Any mismatch re-verifies.

**Acceptance:** a boot in which the hub respawns runs `integrity_check` exactly once.

### C. Get the full integrity check off the boot path

`PRAGMA integrity_check` on 2.98 GB costs 11.3-12.2s. `quick_check` is dramatically cheaper
and the codebase already trusts it for backup verification
(`journalBackup.test.ts:427,487`).

Use `quick_check` at boot; run the full check post-ready, on a schedule, or on suspicion
(unclean shutdown, WAL anomaly, prior corruption). Keep the full check reachable on demand —
do not delete the capability.

**Acceptance:** measured boot preflight time on a multi-GB journal, before and after, in the
commit message.

### D. Find the real >10s main-thread stall  *(do not just raise the timeout)*

**This is the one thing I did not pin down, and it should not be papered over.**

The kill lands *after* preflight passes, during phase `booting`, between
`profiles restored` and `sessions restored` — a step that took **30 ms** in the attempt that
succeeded. Something blocked the main thread for >10s there.

My leading hypothesis, unverified: contention. Up to four hub attempts plus
`journalMaintenance.js` all working the same 3 GB SQLite against a 5s `busy_timeout`
(see the comment at `restartHandshake.ts:20-21`). Fixing (B) may remove it by removing the
concurrent attempts. Reproduce it before deciding.

Separately, `HUB_PREFLIGHT_LIVENESS_TIMEOUT_MS` is a fixed 10s gating work that scales with
database size. Once the true stall is understood, either make the deadline proportional or
guarantee the heartbeat cannot be starved. Raising the constant alone is not a fix.

**Acceptance:** a regression test that boots a supervisor against a synthetic large journal
and asserts zero unexpected exits and zero respawns.

### E. Bound hot-database backups and make them converge  *(corrected 2026-08-14)*

The incident was not merely that a backup is a full snapshot. It was an unbounded restart loop
inside SQLite's online backup API. The live `journalBackupWorker` ran for 25 minutes, read 537 GB,
wrote 268 GB, and produced a zero-byte `.partial`; its progress remained at 31,000 of 782,709 pages
(4%). The 3.19 GB database had been transferred roughly 180 times without completing.

`db.backup()` follows a moving source when it does not own an explicit read transaction. Every hub
write can therefore restart the copy from page zero. The existing choice of the online backup API is
still correct: a plain copy of a live database plus an unrelated WAL is not a backup. The copy must
use a pinned, consistent source generation and remain contained if that invariant regresses.

Required properties:

- open a dedicated read-only source connection and pin one WAL read transaction before the copy;
  writers continue while the backup sees one immutable generation;
- abort on a bounded restart count, cumulative physical page-work ratio, or wall-clock deadline;
- enforce the deadline in the parent process too, so a native addon that stops calling progress cannot
  leave a worker alive forever;
- never overlap attempts, and retry only after the size-aware schedule/backoff;
- retain two verified generations under a 4 GiB budget, with compatibility and strong-recovery copies
  hard-linked when possible rather than stored twice.

Production bounds in this patch are two observed restarts, 3x source page work, and ten minutes for
the copy phase. Verification and lineage publication remain separate, explicit protected phases.

**Acceptance:** under continuous writes, a multi-GB backup completes from one pinned generation or
aborts within the stated bounds; one attempt cannot transfer more than a small multiple of the source;
no worker runs unbounded; no two generations overlap; retained footprint is bounded.

### E2. The footprint bound is a permanent app invariant, not a cleanup for this machine

**Corrected 2026-08-14 by operator direction.** My first version of this section asked for a
one-time idempotent upgrade step. That was wrong, and the operator's words are the spec:

> "Anything we do to the database needs to be bounded in the app because otherwise we're making
> one off patches for just us which doesn't make any sense. We need to kill the root cause of
> *why* it is happening, not chase the issue around."

Do **not** write a migration that fixes this operator's 16.36 GB directory. Write the bound, and
let an over-size data root converge to it through ordinary operation.

The root cause of unbounded growth is that nothing declares a bound. Every limit here is currently
implicit: no payload ceiling, no retention window, no total-footprint budget for `backups` or
`journal-recovery`. That is why the database could quietly reach a size at which the integrity
check outruns the liveness deadline and a hot-database copy can no longer converge — nothing was
ever going to stop it. Item E already moves the right way with its declared "two verified
generations under a 4 GiB budget"; extend that to the journal itself.

Required properties:

- every ceiling is explicit, configurable, and enforced in **one** code path that runs on every
  cycle — not a special upgrade branch that fires once;
- a root that is already over its ceiling is not a distinct case. Ordinary enforcement brings it
  down. The only difference is that early cycles do more work than steady state, and that work
  must obey the same bounds as E (never unbounded, never on the boot path — a multi-GB `VACUUM`
  during startup would recreate exactly the stall this brief exists to fix);
- reclaiming space is therefore a *consequence* of the invariant holding, not an operation with
  its own one-shot code path.

Implemented defaults: 64 KiB inline string ceiling, 2 GiB resident SQLite target, two verified
snapshot generations, and a 4 GiB snapshot/recovery budget. The SQLite and snapshot bounds are
configurable through `AMA_JOURNAL_SQLITE_TARGET_BYTES`, `AMA_JOURNAL_SNAPSHOT_KEEP`, and
`AMA_JOURNAL_SNAPSHOT_MAX_BYTES`.

The content-addressed blob store remains exact and lossless. If retained unique transcript bytes alone
exceed an operator's total storage allowance, enforcement reports that honestly and requires an explicit
history-retention policy; it never deletes the only copy merely to manufacture a finite-footprint claim.

**Acceptance:** point the app at a copy of an over-ceiling ~16 GB data root. With **no** migration
flag, no one-shot command and no operator action, ordinary operation brings the footprint under the
declared ceiling within a stated number of cycles; all 54 sessions still restore; a subsequent boot
runs one preflight with no respawn. Running the same code path against an already-compliant root
does nothing. Report before/after footprint and the number of cycles taken.

### F. The Overseer directs; it does not implement

Operator-raised, and confirmed as a real instruction gap. `sessions.ts:370` tells project
**managers**:

> `- Delegate all bounded project work by default to real AllMyAgents workers through the
>   hub-provided spawn_agent tool; your job is to decompose, coordinate, inspect, and verify.`

The Overseer manifest (same file, the `## Application Overseer` block) has **no equivalent
line**. It describes the control plane, approvals, guiding the operator, elevation and testbed
deployment, but never states that the Overseer routes implementation work to an owning agent
rather than writing it. That omission is not theoretical: it is why the changes described in
section 4 below arrived in your working tree authored by the Overseer instead of as a brief to
you, which is precisely the concurrency hazard the operator objected to.

Add an Overseer-scoped instruction mirroring the manager one — decompose, delegate to the
owning agent, inspect, verify, and report — with the explicit note that shipping code is the
owning agent's job even when the Overseer has already diagnosed the defect and could write the
patch faster. Bump `OVERSEER_CAPABILITY_VERSION` again and update the pinned assertions in
`overseer.test.ts`.

**Acceptance:** a fresh Overseer conversation receives the new contract; `overseer.test.ts`
passes with the bumped version.

---

## 4. Also in this release

Already sent separately, all verified against live hardware (SpaceMIT K3, riscv64):

- **Direct-lane HMAC fix** — `directHubProtocol.ts` canonical-JSON signing, plus its
  regression test. Uncommitted in this working tree on `agent/overseer-application-scope`.
  **Protocol-breaking: both ends must ship together.** The K3 already runs the fixed module.
  Direct-lane device actions are broken fleet-wide today and silently fall back to the
  AllMyStuff Site route, which is why nobody noticed.
- `myOwnMeshRpc.ts:88` — `daemon.sock` appended twice when `MYOWNMESH_HOME` is set.
- `testbedNode.ts:529` — reports `{"status":"running"}` then exits 0 when the bridge opens
  no socket.
- `owned_roster` is not a MyOwnMesh op (confirmed against the 0.3.5 daemon's variant list),
  so `fleet_trust_exchange` cannot succeed against a MyOwnMesh-only node.

**RETRACTED:** I previously reported `testbedNode.ts:366` as emitting `'node\stopped'` ->
`nodestopped`. That was wrong. The source reads `'node/stopped'` with a forward slash; the
backslash was a rendering artifact in grep output that I repeated without opening the file.
There is no bug there — do not "fix" it. The other items above were each proven by running
something, not by reading tool output.

---

## 5. Testing

- Existing suites must stay green: `directHubProtocol`, `remoteDevices`, `testbedDeployment`,
  `myOwnMeshRpc`, `preflight`, `journalBackup`, `restartHandshake`.
- New: preflight runs once across a respawning boot (B).
- New: supervised boot against a large synthetic journal completes with no unexpected exit (D).
- New: journal file size stays bounded under oversized payloads, and sessions still replay (A).
- Report measured before/after boot times on a multi-GB journal.

Do not test only against a small database — every bug here is invisible at small scale.
That is precisely why this shipped.

## 6. Production-scale verification

The release candidate was exercised against a separate copy of the operator's verified 2026-08-14 snapshot,
not the live data root:

- baseline: 3,207,106,560-byte `hub.db`, 994,617 events, 54 sessions, `quick_check: ok`, 782,985 pages,
  no freelist, and legacy `auto_vacuum=NONE`;
- ordinary maintenance cycle 1 externalized 5,241 rows and 1,492,584,196 logical bytes into
  1,375,634,521 unique content-addressed blob bytes;
- ordinary cycle 2 used SQLite's crash-atomic reclaim boundary and reduced the resident database to
  1,509,273,600 bytes with `auto_vacuum=INCREMENTAL` and `quick_check: ok`;
- ordinary cycle 3, against the now-compliant root, completed in 5.5 seconds with identical database bytes,
  page count, freelist, and storage-enforcement event count — no repeat rewrite;
- all 54 sessions remained present after convergence;
- isolated worker preflight completed on the 1.51 GB result in 6.5 seconds while renewing its liveness lease
  seven times; an unchanged same-supervisor retry reused the exact identity receipt and completed in 0.21 seconds
  without another content scan.

The copied test roots were deleted after verification. The operator's live journal, backups, recovery root, and
the deliberately-running reproduction worker were not modified or terminated by this test.
