# Durable runs and scoped team queries

AllMyAgents exposes two provider-neutral coordination primitives to project managers and the application
Overseer. Claude and Codex receive the same schemas and the same hub-side authorization checks.

## Durable runs

`start_run` owns an important build, test, lint, benchmark, deploy, or custom command as an app record rather
than as an ad-hoc model shell sequence. It returns a stable run id immediately. `inspect_runs` reads lifecycle
state and at most 64 KiB per output stream from explicit byte cursors. `control_run` cancels a queued or local
running command; the hub refuses to claim live remote cancellation until the target protocol can prove it.

Each run records:

- immutable actor and target session ids, project, kind, local/remote execution target, bounded command
  summary, command digest, creation/start/heartbeat/completion times, exact exit code or signal, and terminal
  state;
- the local source checkout's Git HEAD/ref plus exact content hashes for changed and untracked inputs, with an
  explicit `complete:false` boundary when the scan exceeds its limit;
- lockfile hashes and a digest of the effective allowlisted environment (only environment key names and the
  digest are exposed in provenance; values are not copied into journal events). The record labels this as the
  execution environment for a local run and source-hub context for a remote run; it never pretends that the
  remote shell's environment was captured when the target protocol did not return it;
- bounded stdout/stderr files outside the journal, byte counts, truncation state, and cursor-paged reads; and
- remote route/network/target timing, transfer counts, failure stage, and target correlation id when present.

Resources are durable string leases. The target checkout or remote device/root is always included. Callers may
also name project-scoped resources such as `gpu-0`, `port-8080`, or a hardware fixture. Runs with disjoint
resources can execute concurrently on different local checkouts or remote devices; a shared resource queues
instead of requiring agents to invent lockfiles. Terminal outcomes release their claims.

A hub-owner transition does not assume a command stopped or succeeded. The current owner heartbeats its local
and remote requests. A promoted owner leaves fresh predecessor leases alone; only a stale owner is reconciled
to `outcome_unknown`. That releases the abandoned scheduling claim but is deliberately not permission to retry:
the operator or manager must inspect the target and decide whether repeating the command is safe. The process
tree itself is not yet detached from the hub, so this is durable observation and recovery, not a false promise
that every command survives process replacement.

Local commands use an executable plus argv with `shell:false`; shell composition belongs only in the explicit
remote command field because the remote root advertises its shell environment. Important remote work still
requires the target session's exact device/root terminal grant. `start_run` is an ordinary execution approval
class: direct Full Access and an exact operator "always allow start_run" grant can approve it, while a
teammate-caused turn remains denied by default.

The older project-replica testbed run/reservation ledger remains active for callers still using `remote_exec`
during the compatibility period. A generic remote run does not manufacture a duplicate legacy run: its generic
id is forwarded as the target correlation id, while the target's independent physical-root fence remains the
second admission boundary. Migrating the remaining legacy ledger and GitHub-import jobs onto the generic
scheduler can now be mechanical rather than creating a third job system.

## Scoped team query

`query_team` returns one bounded operational response across any selection of:

- bus messages addressed to sessions in the caller's live managed hierarchy;
- current provider/manager task boards;
- pending approvals; and
- durable runs.

The hub derives visible session ids from authenticated hierarchy. Project managers see themselves and their
managed descendants; the Overseer sees non-retired local records, and must provide explicit session ids when a
fleet-wide request would exceed 64 records. A caller cannot widen scope by supplying ids.

Message filtering happens in SQLite before results are returned. Pages are ordered by append-only row id,
return a stable `next` cursor and `hasMore`, and never mark messages delivered or read. Task, approval, and run
facets are current projections rather than consumable inbox entries. `session_ids`, `from_session_ids`,
`statuses`, `kinds`, `unread_only`, and `limit` keep a manager from reconstructing state by polling every child
or loading an unbounded transcript.

At a new operator task or material slice, managers are instructed to query current state, create/update their
own provider-native plan, assign every worker through `assign_child_task`, dispatch useful parallel lanes up to
the configured target, and run important verification through the durable scheduler. Existing manager and
Overseer sessions receive this contract through versioned, idempotent instruction rematerialization on the next
public-owner boot; it does not wake idle sessions or append recurring reminder mail.
