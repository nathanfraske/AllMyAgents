# Durable runs and scoped team queries

AllMyAgents exposes two provider-neutral coordination primitives to project managers and the application
Overseer. Claude and Codex receive the same schemas and the same hub-side authorization checks.

## Durable runs

`start_run` owns an important build, test, lint, benchmark, deploy, or custom command as an app record rather
than as an ad-hoc model shell sequence. It returns a stable run id immediately. `inspect_runs` reads lifecycle
state and at most 64 KiB per output stream from explicit byte cursors. `control_run` cancels a queued or local
running command; the hub refuses to claim live remote cancellation until the target protocol can prove it.

Each run records:

- immutable actor and target session ids, scope, kind, local/remote execution target, bounded command
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

Resources are durable string leases. The target checkout, application working directory, or remote device/root
is always included. Callers may also name scope-owned resources such as `gpu-0`, `port-8080`, or a hardware fixture. Runs with disjoint
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
requires the target session's exact device/root terminal grant. That grant is standing operator authority for
the remote capability, including on a teammate-triggered turn, so `start_run` does not ask for another execution
approval. Local host runs keep their normal execution-approval and bus-turn boundaries.

Remote callers can declare the command's common prerequisites with `required_tools`. The hub inspects the
selected environment before admitting the run. When tools are missing, it returns the exact missing set and an
actionable request for the project's reviewed setup recipe instead of letting a manager turn inventory into a
terminal blocker. Supplying that exact recipe as `setup_command` creates a separate durable provisioning run,
queues the requested run behind it, and records both ids. The dependent command starts only after provisioning
succeeds and a second target-side inspection proves every declared tool is available. Failed provisioning or a
failed postcondition terminates the dependent run without executing its command.

This is intentionally not an implicit package installer. Projects remain the authority for versions and setup
semantics through their checked-in bootstrap script, Justfile, or equivalent reviewed recipe; AllMyAgents owns
the lease, logs, ordering, timeout, and evidence. `setup_timeout_ms` controls that prerequisite independently,
and the reserved `dependency-provisioning` resource prevents package-manager races on the same remote root.

A project manager always runs against a visible project checkout. The application Overseer may additionally
start local ad-hoc work by supplying an explicit absolute `working_directory`, or use a granted remote root
without inventing a project association. The hub resolves and records the canonical local directory, leases it
under a reserved application scope, and exposes those runs only through the Overseer's normal managed-scope
query. Relative or missing directories fail before a process starts.

The older project-replica testbed run ledger remains active for attributed callers still using `remote_exec`
during the compatibility period, but it is observational rather than an exclusive lock. A generic remote run
does not manufacture a duplicate legacy run: its generic id is forwarded as the target correlation id. Remote
commands run concurrently by default and serialize only on an explicitly shared durable resource. Migrating the
remaining legacy ledger and GitHub-import jobs onto the generic scheduler can now be mechanical rather than
creating a third job system.

## Scoped team query

`query_team` returns one bounded operational response across any selection of:

- bus messages addressed to sessions in the caller's live managed hierarchy;
- current provider/manager task boards;
- pending approvals plus recent durable decisions (status, decider, resolution time, and explicit vendor persistence); and
- durable runs.

The hub derives visible session ids from authenticated hierarchy. Project managers see themselves and their
managed descendants; the Overseer sees non-retired local records, and must provide explicit session ids when a
fleet-wide request would exceed 64 records. A caller cannot widen scope by supplying ids.

Message filtering happens in SQLite before results are returned. Pages are ordered by append-only row id,
return a stable `next` cursor and `hasMore`, and never mark messages delivered or read. Pending approvals remain
in `approvals`; bounded resolved dispositions remain separately available in `approvalDecisions`, including after
hub restart, without scanning the event journal. Task, approval, and run facets are current projections rather
than consumable inbox entries. `session_ids`, `from_session_ids`,
`statuses`, `kinds`, `unread_only`, and `limit` keep a manager from reconstructing state by polling every child
or loading an unbounded transcript.

At a new operator task or material slice, managers are instructed to query current state, create/update their
own provider-native plan, assign every worker through `assign_child_task`, dispatch useful parallel lanes up to
the configured target, and run important verification through the durable scheduler. Existing manager and
Overseer sessions receive this contract through versioned, idempotent instruction rematerialization on the next
public-owner boot; it does not wake idle sessions or append recurring reminder mail.

## GitHub connector approval policy

The operator-owned GitHub automation policy is also the authority source for Codex GitHub connector
elicitations. The hub accepts only the exact `codex_apps` GitHub approval envelope, an explicit unambiguous
`owner/repository`, and a closed operation-to-capability mapping. `pull_requests`, `pull_request_merges`,
`workflow_runs`, and `repository_pushes` remain independent grants; one never implies another. Unknown tools,
schemas, repositories, connectors, and operation names fail closed and continue to prompt. Each policy-driven
decision journals the operation, repository, granting scope, and a bounded parameter summary; free-form bodies
are represented by character count and SHA-256 rather than duplicated into the journal.

The same exact `workflow_runs` grant authorizes the hub-owned [`monitor_ci`](github-ci-monitor.md) watch.
Unlike `gh run watch`, it does not occupy a model turn or shell: it persists across hub restarts and wakes the
watching chat once on the requested terminal failure and/or success through the permission-clamped bus.

An Overseer `approve` response remains one-shot unless the operator explicitly supplies `persist=session` or
`persist=always` on a direct operator turn. Persistence is accepted only when that exact Codex elicitation
advertised the requested option and is returned using the vendor protocol's response metadata. Standing
alert-turn approval authority can never persist a vendor decision.
