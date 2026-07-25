# Agent detachment & restart survival — file-by-file implementation plan

Build plan, drafted 2026-07-24. **Implementation plan only — this doc changes no other code.** It turns
Phase 1 (and previews Phase 2) of `docs/self-hosting-restart-survival.md` into a concrete, build-ready,
file-by-file plan grounded in the code as it exists today.

- **Phase 1** — a tiny `hubctl` supervisor that owns hub process lifetime and performs a graceful
  **blue-green restart** (spawn successor on an ephemeral port sharing the same `data/`, health-check,
  flip the fixed public port, drain + retire the predecessor, rollback on failure). Operator browser
  panes survive via the existing WS auto-reconnect + journal replay — **no web change needed.**
- **Phase 2 (preview)** — move agent execution out of the hub into a **supervised worker** the hub
  re-attaches to, so *agent* sessions (not just operator panes) survive a hub restart.
- **Danger-zone gating** for `restart_hub` / `self_migrate`, mirroring the existing practice gate.
- **The hardest parts + the code that currently assumes a single in-process hub.**

---

## 0. What the code does today (the seams we build on)

Every claim below is load-bearing for the plan.

| Fact | Where | Consequence for the plan |
|---|---|---|
| Hub = HTTP/WS + journal + **agent execution**, all one process/lifetime | `apps/hub/src/index.ts`, `sessions.ts` | Restarting the hub kills agents. Phase 1 makes the restart graceful; Phase 2 moves execution out. |
| Single `better-sqlite3` connection, **WAL** mode, shared by every store | `journal.ts:17` (`journal_mode = WAL`); `index.ts:30-45` passes `journal.db` into `SessionStore`/`ProjectStore`/`InstructionStore`/`AgentBus`/`MemoryStore`/`PracticeStore` | Two hub processes on the same `data/hub.db` is safe *at the SQLite level* (WAL = many readers + one writer, coordinated by `-wal`/`-shm` + file locks on a local FS). But **there is no `busy_timeout`** — a concurrent writer throws `SQLITE_BUSY` immediately (see §4). |
| Durable state already outlives any process: append-only journal + persisted `SessionStore` snapshot | `journal.ts`, `store.ts` | The blue-green flip needs **no state handoff** for journal/store — both hubs open the same file. The only handoffs are the **listening port** and (Phase 2) the **worker attachment**. |
| Client **auto-reconnects every 1.5s** and **replays from `lastSeq`**; dedups on `seq <= lastSeq`; unknown event kinds hit `default: break` (never throw) | `store.svelte.ts:788-808`, `:828`, `:1015-1016` | Operator panes survive a hub bounce with zero web changes. Additive new event kinds are safe. |
| Journal `replay()` is a **synchronous** generator; the WS handler drains it and attaches the live listener in the same tick (no gap, no dupes) | `journal.ts:70-79`, `server.ts:647-661` | Green serves the identical replay contract the moment it owns the port. |
| Fixed port **7777**, bound `127.0.0.1`; `EADDRINUSE → process.exit(1)` | `index.ts:72`, `server.ts:670`, `:663-668` | The public port is a hard singleton. A second hub told to bind 7777 while the first holds it **exits today** — the flip must sequence the port release (§1.4). |
| **Web client hardcodes `127.0.0.1:7777`** in the desktop app; dev proxies to it | `api.ts:145-146`, `web/vite.config.ts:4` | The client cannot be redirected to another port. Either the supervisor owns 7777 and proxies, or blue-green does a **fast handoff of 7777** (chosen — §1.3). |
| Claude runs **in-process**: `query()` async-generator consumed in the hub loop; interrupt handle held in `ClaudeDriver.active` | `adapters/claude.ts:53-91`, `sessions.ts:236-289` | A hub restart kills the live Claude turn. Vendor transcript resumes via `options.resume` (`claude.ts:62`). |
| Codex runs as a **hub-spawned child** `codex app-server` (per profile, `shell:true`) | `adapters/codex.ts:109-132`; `sessions.ts:199-234` | The child dies/ orphans with the hub (`sessions.shutdown()` taskkills the tree, `sessions.ts:775-784`). Thread state is on disk in `CODEX_HOME`; `thread/resume` re-attaches (`codex.ts:186-189`). |
| `boot()` restores records, flips `active|starting → idle`, journals `session/restored-stale`; does **not** spawn vendor children (lazy) | `sessions.ts:119-136` | Green can restore the roster cheaply. But eager stale-marking races blue's in-flight turn (§4). |
| A dead codex child flips in-flight sessions to `error` via `failInFlightCodexSessions` | `sessions.ts:199-234`, `:792-802` | A **planned** retire that kills blue's codex child would emit spurious `session/error` — needs a `graceful` flag (§4). |
| `ApprovalService` pending set is **in-memory** (Promise + timer), fail-closed at 10 min | `approvals.ts:14`, `:22-38` | In-flight approvals die on restart. Fine for Phase 1 (agent dies too); a real problem for Phase 2 (§2.5). |
| Danger flags are a **shared-by-reference** object, mutated in place on `POST /api/config/danger`, persisted to `data/config.json`; gate decided by a pure `decidePracticeGate({ownAccount,isBusTurn,danger})` | `index.ts:51-55`, `server.ts:455-463`, `practices.ts:206-215` | The exact pattern to mirror for a restart gate (§3). |
| Desktop shell **owns the hub as a managed child** (`pnpm hub:dev` in dev, bundled `node dist/index.js` in release), taskkills its tree on exit, refuses to spawn a second if 7777 answers | `desktop/src-tauri/src/lib.rs:32,41-46,56-97,326-344,361-374,377-421` | `hubctl` slots in here: the desktop spawns **hubctl**, hubctl owns the hub(s). |

**Net:** operator panes already survive a restart; idle agent sessions already resume their vendor
transcript on next send. Phase 1 turns `taskkill` into a graceful, rollback-safe flip. Phase 2 keeps the
*live turn* alive across it.

---

## 1. PHASE 1 — the `hubctl` supervisor + blue-green restart broker

### 1.1 Process model

```
Tauri desktop shell (lib.rs)            # unchanged role: owns ONE managed child, taskkills its tree on exit
  └── hubctl  (supervisor, near-immutable)   # NEW — owns hub lifetime + the blue-green flip; holds no agent state
        ├── hub "blue"  (node dist/index.js on 7777)     # the live control plane
        └── hub "green" (node dist/index.js on :ephemeral → promoted to 7777)   # spawned only during a restart
```

- `hubctl` is a tiny Node process that ships in the same bundle (`dist/hubctl.js`). It holds **no journal,
  no sockets on the data path, no agent state** — only child handles + the flip state machine. It is the
  stable thing (systemd/kubelet analogy); everything above it is replaceable.
- The desktop shell's managed child becomes **hubctl** instead of the hub. `kill_hub` (`lib.rs:361-374`)
  already taskkills the whole tree, so killing hubctl tears down its hubs. No new teardown logic.
- In **steady state** there is exactly one hub (blue) listening on 7777. Green exists only for the
  seconds of a restart.

### 1.2 Who owns the fixed port — decision: **fast handoff, supervisor-sequenced** (not a proxy)

The client hardcodes `127.0.0.1:7777` and relies on WS reconnect+replay (`api.ts:145-146`,
`store.svelte.ts:795-808`). Two ways to keep 7777 stable:

- **(A) Supervisor owns 7777 and reverse-proxies** to whichever hub is live. Zero-drop, but it puts a
  permanent WS-proxying data-path component *inside the near-immutable supervisor* — it must forward the
  `Upgrade`, preserve `Origin`/`Host` (the hub's guards check them, `server.ts:186-202`) and the
  `?token=` query, and it becomes a SPOF that itself can't be restarted without dropping every socket.
- **(B) Fast handoff (chosen).** Green boots + is fully health-checked on an **ephemeral** port; only then
  does blue release 7777 and green bind it, sequenced by the supervisor so **the two never contend for
  7777 at the same instant.** The gap between blue's `close` and green's `listen` is tens of ms; clients
  hit one refused connection and the existing 1.5s reconnect + replay hides it — exactly the
  "page-reload-sized blip" the design targets. Keeps the supervisor off the data path and near-immutable.

Handoff avoids the Windows two-binders-one-port hazard by **never overlapping**: blue fully
`server.close()`s before green `listen`s. (A) is kept as a documented fallback if we later want strictly
zero-drop.

### 1.3 New files

**`apps/hub/src/hubctl.ts`** — the supervisor. Sketch:

```ts
// Launched by the desktop shell (replacing the direct hub spawn) or `pnpm hubctl:dev`.
// Owns hub children over an IPC channel; runs the blue-green flip on request.
interface HubHandle {
  child: ChildProcess          // spawned with stdio: ['ignore','inherit','inherit','ipc']
  color: 'blue' | 'green'
  port: number                 // 7777 for the live hub; ephemeral for a booting green
  restored?: number            // sessions restored, from its 'ready' message
  state: 'booting' | 'live' | 'draining' | 'retired'
}

let live: HubHandle | null = null           // the hub currently on 7777
let flipInFlight = false

function spawnHub(port: number, color: 'blue'|'green'): HubHandle { /* spawn node dist/index.js
  with env HUB_PORT=port, HUB_SUPERVISED=1; wire child.on('message', onHubMessage) */ }

async function boot() {
  live = spawnHub(7777, 'blue')
  await waitReady(live)                      // 'ready' IPC msg after sessions.boot()+listen
}

// Triggered by the live hub forwarding a restart request (operator button or MCP tool).
async function restart(reason: string): Promise<void> {
  if (flipInFlight) return
  flipInFlight = true
  const green = spawnHub(ephemeralPort(), 'green')
  try {
    await waitReady(green, 15_000)                       // boot() complete
    await healthCheck(green, { expectRestored: live!.restored })   // §1.5
    live!.child.send({ type: 'drain' })                 // blue: stop accepting new sessions (503), close listener
    await waitFor(live!, 'released')
    green.child.send({ type: 'promote', port: 7777 })   // green: close ephemeral, listen(7777)
    await waitFor(green, 'promoted')
    const old = live!; live = green; live.state = 'live'
    old.child.send({ type: 'retire' })                  // blue: finish in-flight, close WS, sessions.shutdown(), exit
    reap(old, 3000)                                      // taskkill tree if it doesn't exit
  } catch (err) {
    killTree(green)                                      // ROLLBACK: green never took 7777; blue untouched
    live!.child.send({ type: 'restart-aborted', error: String(err) })  // blue journals hub/restart-aborted
  } finally { flipInFlight = false }
}
```

**`apps/hub/src/restartHandshake.ts`** (optional, ~40 lines) — shared message types + `waitReady`/
`waitFor`/`healthCheck` helpers, imported by both `hubctl.ts` and `index.ts`, so the IPC contract lives in
one typed place:

```ts
type SupervisorMsg = { type:'drain' } | { type:'promote'; port:number } | { type:'retire' } | { type:'restart-aborted'; error:string }
type HubMsg = { type:'ready'; port:number; restored:number; schemaVersion:number }
            | { type:'released' } | { type:'promoted' } | { type:'restart-request'; reason:string; bySession?:string }
```

### 1.4 IPC (supervisor ↔ hub)

Use `child_process.spawn(cmd, args, { stdio: ['ignore','inherit','inherit','ipc'] })` — the 4th `ipc`
slot gives a structured `child.send()` / `process.on('message')` channel **even for a spawned (non-fork)
plain-node child**, so the hub still runs standalone (`tsx src/index.ts`, `node dist/index.js`) *and*, when
launched by hubctl (detected via `HUB_SUPERVISED=1` / `process.send`), speaks the handshake. `stdout`/
`stderr` stay inherited so hub logs surface exactly as today. No new ports, no sockets on the data path.

### 1.5 The blue-green sequence + health-check details

Health-check runs against **green's ephemeral HTTP port**, before any port handoff (so a failure is a pure
rollback):

1. **`ready` IPC** — green sends `{type:'ready', restored, ...}` after `sessions.boot()` + `startServer`
   is listening (a new emit at the end of `index.ts`). Timeout 15s → rollback.
2. **`GET /api/health` → 200** with `{ boot:'complete', restoredSessions, schemaVersion, pid, port }` (new
   route, §1.6). Proves routing + guards + DB are live.
3. **`GET /api/auth` → 200** (existing route `server.ts:291`) — proves the origin/host/token middleware
   works end to end.
4. **Restored count matches**: `green.restored === live.restored` (the count blue last reported). To keep
   the count stable during the check, blue enters **`draining`** first only *after* green is otherwise
   healthy — but to prevent a create landing on blue mid-check, the supervisor caches blue's count at
   green-spawn time and green reads the same shared store, so equality holds unless a session was created
   in the window; the `drain` step (which makes `POST /api/sessions` return 503) closes that window.
5. **(optional) WS smoke** — open `ws://127.0.0.1:<ephemeral>/ws?since=<huge>`; expect accept + clean
   close (proves `verifyClient`, `server.ts:639-645`).

Only after 1-5 pass does the flip proceed: `drain(blue) → released → promote(green,7777) → promoted →
retire(blue)`. Clients reconnect to 7777 (now green) and replay from `lastSeq` — the seam is invisible.

### 1.6 Edits to existing hub files (Phase 1)

**`apps/hub/src/index.ts`**
- Read the port from `HUB_PORT` as today (`:72`); the supervisor injects an ephemeral port for green.
- Detect supervision: `const supervised = process.env.HUB_SUPERVISED === '1' && !!process.send`.
- After `startServer(...)` returns and is listening (`:94`), if supervised, `process.send({type:'ready',
  port, restored: sessions.list().length, schemaVersion})`. Keep the existing `journal.append(null,
  'hub/started', …)` (`:95-99`).
- Add a `process.on('message', …)` handler implementing `drain` / `promote` / `retire` /
  `restart-aborted` by delegating to a new `RestartController` (below). Wire the hub's `restart-request`
  emitter into `SessionManager` (a callback that does `process.send({type:'restart-request', …})`), so the
  MCP tool + HTTP route can ask the supervisor to flip.
- **Do not** call `usage.startPolling()` (`:58`) unconditionally when supervised-and-not-yet-live. Gate it:
  green starts polling only on `promote` (§4 blocker #5).
- **Mesh**: move `mesh.register()` / `deregister()` ownership so a green boot doesn't fight blue over the
  `tcp:7777` advert (§4 blocker #4). Minimal Phase-1 fix: green does **not** register until `promote`, and
  blue **suppresses `deregister()` on a `retire`** (green now owns the advert). Cleanest fix (recommended):
  hubctl owns the single mesh registration for its lifetime; the hub stops calling mesh at all when
  supervised.

**`apps/hub/src/server.ts`**
- New `GET /api/health` (public, like `/api/auth`) returning boot/restored/schema/pid/port. Add a
  module-level `booted` flag set true after `sessions.boot()` so health reports `boot:'complete'` only when
  true.
- New `POST /api/restart` (operator path): origin+host+token-guarded like every `/api`. Body `{reason?}`.
  It **does not restart the hub itself**; it invokes the injected `requestRestart(reason, {origin:'operator'})`
  callback (→ `process.send({type:'restart-request', …})`) and returns `202 {accepted:true}`. The operator
  clicking this *is* the approval, so no gate here (the gate is on the **agent** path, §3).
- New `POST /api/sessions` guard: when the hub is in `draining` state, return `503 {error:'restarting'}`
  (prevents a create landing on a retiring hub during the flip).
- Support **graceful re-listen for `promote`**: factor the `server.listen(port)` so a `RestartController`
  can `server.close()` the ephemeral listener and `server.listen(7777,'127.0.0.1')` on `promote`. The WS
  server is attached to the `http.Server` instance, so it follows the re-listen automatically.
- Make `EADDRINUSE` non-fatal **when supervised**: today it `process.exit(1)` (`:663-668`). Under a
  managed flip that must instead reject the `promote` (send `{type:'promote-failed'}` so the supervisor
  rolls back and keeps blue) rather than kill the process.

**New `apps/hub/src/restartController.ts`** (small) — encapsulates the hub-side of the handshake so
`index.ts` stays thin: `drain()` (set `draining`, `server.close()` listener for new conns but keep process
alive, `send('released')`), `promote(port)` (re-listen on `port`, start usage polling + mesh, `send
('promoted')`), `retire()` (journal `hub/retiring`, finish in-flight, close WS, `sessions.shutdown({graceful:true})`,
`process.exit(0)`), `abort(error)` (journal `hub/restart-aborted`; this runs on **blue** when green failed,
so the operator sees the failure in the transcript).

**`apps/hub/src/sessions.ts`**
- `shutdown(opts?: { graceful?: boolean })` — when `graceful`, set a flag so the codex `codex/exited`
  handler **skips `failInFlightCodexSessions`** (`:208-212`, `:792-802`): a planned retire must not emit
  spurious `session/error`. (Phase 1: retiring blue still kills its live turns; we just don't mislabel them
  as crashes. Phase 2 removes the kill entirely.)

**`apps/hub/src/journal.ts`**
- Add `this.db.pragma('busy_timeout = 5000')` in the constructor (next to the WAL pragma, `:17`). This is
  the single most important one-line change for two-hub safety (§4).

**`apps/hub/src/adapters/codex.ts`** — no change for Phase 1 (thread state already resumes via
`thread/resume`).

### 1.7 Desktop + scripts

**`apps/desktop/src-tauri/src/lib.rs`**
- Dev path (`spawn_hub_dev`, `:56-97`): spawn `pnpm hubctl:dev` instead of `pnpm hub:dev`.
- Release path (`release_boot`, `:326-344`): spawn `node dist/hubctl.js` instead of `node dist/index.js`.
- Everything else (reachability probe on 7777 `:41-46`, `kill_hub` tree-kill `:361-374`, `RunEvent::Exit`
  `:411-419`) is unchanged — hubctl is just the new tree root.

**`package.json`** (root, `:8`) — add `"hubctl:dev": "pnpm --filter hub hubctl:dev"`;
**`apps/hub/package.json`** (`:6-11`) — add `"hubctl:dev": "tsx src/hubctl.ts"` and ensure the build emits
`dist/hubctl.js` (it will, `tsc -p tsconfig.build.json` compiles the whole `src`).

**`scripts/bundle-hub.mjs`** — confirm `dist/hubctl.js` is included in the shipped payload (it lives under
the same `dist/`, so this should be automatic; verify).

### 1.8 The `restart_hub` control path

- **Now (HTTP):** `POST /api/restart` (§1.6) — the operator UI (a "Restart hub" button in Settings →
  Danger/Maintenance) hits it; hub forwards to the supervisor. No approval gate (operator-authenticated).
- **Later (MCP tool):** `restart_hub` in `agentTools.ts`, deferred behind a `searchHint` (rare, heavy —
  per `tool-affordance.md`). It calls a new `AgentServices.requestRestart(reason)` that resolves to the
  hub's supervisor-signal callback. It **self-gates** (§3) so it works even under `full` and is hard-denied
  on bus turns. Agent-initiated restart is the fully-autonomous self-hosting loop the design targets.

### 1.9 What Phase 1 delivers (and doesn't)

- **Delivers:** operator browser panes survive a restart with zero UI change; **idle** agent sessions
  survive (green restored the record; the vendor transcript resumes on next send); a bad green **never**
  takes down blue (rollback); restart is a first-class, journaled, gated action instead of `taskkill`.
- **Doesn't (yet):** a **mid-turn** agent turn is still lost when blue retires (its in-process Claude
  query / Codex child dies). That is precisely Phase 2.

---

## 2. PHASE 2 (preview) — supervised agent workers

Goal: an agent's **in-flight turn** survives a hub restart. Move agent execution off the thing being
restarted, and make `boot()` **re-attach** to a still-running worker instead of respawning it.

### 2.1 Topology

```
hubctl (supervisor)
  ├── hub (blue/green)      # control plane: journal, all SQLite stores, ApprovalService, UsageMonitor, WS, HTTP
  └── worker (long-lived)   # agent execution: Claude query() drivers + Codex app-server child(ren) + MCP tool handlers
```

The **worker is a sibling of the hub, supervised by hubctl** — it is *not* a child of the hub, so a hub
restart does not touch it (the tmux-server/tmux-client split). The worker outlives every hub bounce.

### 2.2 What moves into the worker vs stays in the hub

| Concern | Today | Phase 2 home | Why |
|---|---|---|---|
| Claude `ClaudeDriver` (query async-gen + interrupt) | hub (`sessions.ts:69`, `adapters/claude.ts`) | **worker** | the live turn must not die with the hub |
| Codex `CodexClient` + `codex app-server` child + `codexThreads`/`activeTurns` | hub (`sessions.ts:70-71`, `adapters/codex.ts`) | **worker** | same |
| `runClaudeTurn` / `runCodexTurn` / `ensureCodexThread` / `busTurnSessions` | hub (`sessions.ts:499-566`) | **worker** | turn execution + provenance tag live with the driver |
| In-process MCP server `buildAgentMcpServer` + `AgentServices` handlers | hub (`sessions.ts:283`, `agentTools.ts`) | **worker** (handlers RPC the hub for DB/approvals) | the self-gating handlers run in the SDK process; keep them with the driver |
| Journal + `SessionStore`/bus/memory/practices/projects/instructions | hub | **hub** | single durable writer; the worker never opens the DB |
| `ApprovalService`, `UsageMonitor`, WS registry, HTTP routing | hub | **hub** | control plane |

The hub's `SessionManager` becomes a **thin proxy**: `create/send/steer/interrupt/stop` RPC the worker;
vendor events flow worker → hub, and the hub journals them + emits over WS **exactly as today** (the
journal/store code is unchanged, which is what keeps the operator-pane replay contract intact).

### 2.3 Worker ↔ hub IPC (a durable, re-attachable socket)

Because the worker is a supervisor sibling (not a hub child), fork-IPC between hub and worker isn't
available. The worker **listens on a stable local endpoint** — a Windows named pipe / unix socket at a
fixed path under `data/` (e.g. `\\.\pipe\allmyagents-worker` / `data/worker.sock`), whose path hubctl
passes to each hub via env (`HUB_WORKER_SOCKET`). A fresh hub connects to the *same* endpoint → re-attach.
This mirrors how the mesh layer already speaks a length-prefixed frame protocol over a local pipe
(`meshSite.ts:64-125`) — reuse that framing.

Messages:
- hub → worker: `runTurn(sessionId, prompt, opts, origin)`, `interrupt(sessionId)`, `steer(...)`,
  `startThread(...)`, `attach(sinceBySession)` (on hub boot), `listLive()`.
- worker → hub: the vendor event stream (`claude/*`, `codex/*`, `session/tokens`, …) — the same kinds the
  hub journals today — each tagged with `sessionId` and a **per-session monotonic `wseq`**; plus
  `approvalRequest(...)` and `journal(...)` relays for the in-process tool handlers.

### 2.4 How `boot()` must change — re-attach, don't respawn

Today `boot()` (`sessions.ts:119-136`) loads records and marks `active|starting → idle`, assuming the hub
*is* the executor. Phase 2 splits it:

1. **`loadRecords()`** — read `store.all()` into the map, **read-only**, marking nothing stale. (This is
   also the Phase-1-friendly split that fixes the green-marks-blue's-live-session race, §4 blocker #6.)
2. **`attachWorker()`** — connect to `HUB_WORKER_SOCKET`; call `worker.listLive()`. For each session the
   worker still holds:
   - **mid-turn** → keep `status:'active'`, re-subscribe to its event stream with `attach({[sid]:lastWseq})`
     so events emitted **during the hub gap** are replayed (same "since cursor" idea as the journal's own
     replay). When the worker later emits `turn/completed`, the new hub journals it → the operator's
     reconnected browser watches the turn finish **across the restart seam.** This is the Phase 2 win.
   - **idle** → `status:'idle'` (as today).
   - Records the worker does **not** know about → truly idle; mark stale only here (the old
     `restored-stale` path), lazy-resume on next send.

The worker survived, so there is nothing to respawn; the hub just re-binds to live turns.

### 2.5 The two hardest Phase-2 sub-problems

- **Approval reconciliation across a hub restart.** A self-gating tool handler in the worker is `await`ing
  `requireApproval`, which RPCs the hub's **in-memory** `ApprovalService` (`approvals.ts:14`). If the hub
  restarts mid-await, that pending Promise is gone and the worker's RPC is dead. Fix: make approvals
  **idempotent + re-issuable** — the worker generates a stable approval id and, on hub reconnect,
  **re-sends** any outstanding requests; the new hub re-creates the pending entry (re-journaling
  `approval/requested` with the *same* id, deduped) and the operator resolves against the new hub via the
  existing `/api/approvals/:id`. Concrete change: `ApprovalService.request` accepts a caller-supplied id
  (`approvals.ts:22`), and `resolve` is idempotent on an already-resolved id.
- **Gap-free event replay across re-attach.** The worker must buffer per-session events with `wseq` and
  honor an `attach(since)` cursor, so no vendor event emitted during the hub gap is dropped or doubled —
  the same invariant the journal replay already guarantees for the WS (`journal.ts:70-79`). Bound the
  buffer (drop-oldest with a `worker/attach-gap` marker if a hub is gone too long).

### 2.6 Phasing note

Phase 2 is large; ship Phase 1 first (it already saves operator panes + idle agents and is prerequisite
infra). The `loadRecords()` / `attachWorker()` split can land in Phase 1 as `loadRecords()` +
`reconcileStale()` (no worker yet), which *also* removes the Phase-1 double-write race (§4 #6) — so the
boot refactor pays off immediately and grows a worker attach path in Phase 2.

---

## 3. Danger-zone gating for `restart_hub` / `self_migrate`

Mirror the existing practice gate exactly (safe default = operator approval; a Settings toggle
auto-approves for a fully-autonomous loop; a bus turn is hard-denied unless the owner opts in). Never an
un-disable-able block — per `docs/practices-hooks-gating.md` and the permissive philosophy.

**`apps/hub/src/types.ts`** — extend `DangerConfig` (`:148-161`) + `DangerFlags` (`:164-167`):
```ts
// DangerConfig (optional, on-disk/API) and DangerFlags (resolved runtime):
autoApproveRestart?: boolean   // default OFF → restart_hub / self_migrate wait on operator approval
// (bus-turn hard-deny reuses the existing busCanUseRiskyTools flag)
```

**`apps/hub/src/restartGate.ts`** (new, pure, tested — the twin of `decidePracticeGate`,
`practices.ts:206-215`):
```ts
export type RestartGate = { action: 'allow' } | { action: 'approve' } | { action: 'deny-bus' }
export function decideRestartGate(opts: { isBusTurn: boolean; danger: DangerFlags }): RestartGate {
  if (opts.isBusTurn && !opts.danger.busCanUseRiskyTools) return { action: 'deny-bus' } // never from a teammate message
  if (opts.danger.autoApproveRestart) return { action: 'allow' }                         // fully-permissive opt-in
  return { action: 'approve' }                                                            // safe default: ask the operator
}
```

**`apps/hub/src/agentTools.ts`** — add `restart_hub` (and later `self_migrate`) next to the practice tools,
self-gating via `services.requireApproval` so it fires **even under `full`** (the in-process self-gate
insight, `practices-hooks-gating.md §1.2`) and is **hard-denied on bus turns**:
```ts
const gate = decideRestartGate({ isBusTurn: services.isBusTurn(identity.sessionId), danger: services.danger() })
if (gate.action === 'deny-bus') { services.journal(sid,'approval/auto-denied-bus',{toolName:'restart_hub'}); return textResult('Not restarted — a teammate-message turn cannot restart the hub.') }
if (gate.action === 'approve') { if (!await services.requireApproval(identity,'hub/restart',{reason})) return textResult('Not restarted — the operator declined (or it timed out).') }
services.requestRestart(reason)   // → SessionManager → process.send({type:'restart-request'}) → hubctl
return textResult('Restart requested — the hub will bounce; your session will re-attach.')
```
Add `requestRestart(reason)` to the `AgentServices` interface (`agentTools.ts:17-40`) and implement it in
`SessionManager.agentServices()` (`sessions.ts:105-117`) against a supervisor-signal callback injected from
`index.ts`.

**`apps/hub/src/server.ts`** — extend the `POST /api/config/danger` handler (`:455-463`) and `persistDanger`
(`:236-251`) to include `autoApproveRestart` (both currently hardcode only the two existing keys). The
**operator** `POST /api/restart` path (§1.6) needs **no** gate — the authenticated operator action is the
approval; the gate is only on the agent (MCP) path.

**Settings UI** — a toggle in the Danger Zone (`SettingsModal.svelte`) for `autoApproveRestart`, alongside
the existing `busCanUseRiskyTools` / `autoApprovePractices` toggles, and the "Restart hub" maintenance
button that POSTs `/api/restart`.

**`self_migrate` (Phase 3 preview):** same gate, but recommend **no** auto-approve initially (a schema
change is higher-stakes than a restart) — keep it operator-approval-always until the additive-migration
runner + `schema_version` guard (`self-hosting-restart-survival.md §3`) are proven. hubctl runs the
migration **before** booting green, so a bad migration fails the health-check and rolls back to blue.

---

## 4. The hardest parts, the risks, and the code that blocks this

### 4.1 Ranked hardest problems + mitigations

1. **Mid-turn kill (the honest limit).** You cannot atomically replace a process mid-tool-call. *Phase 1:*
   accept it — a retiring blue kills its live turn; mitigate only the **mislabeling** (graceful flag, §1.6)
   and defer the flip to a turn boundary when possible (`self-hosting-restart-survival.md §5`: run the
   restart immediately if idle, else after the current turn completes — the hub knows via `driver.busy`
   `adapters/claude.ts:49-51` and the codex `activeTurns` map). *Phase 2:* the worker survives, so only the
   worker (not the hub) is a mid-turn hazard, and the worker is near-immutable so it rarely restarts.
2. **Port-handoff race on 7777.** Mitigated structurally: green is health-checked on an **ephemeral** port
   and blue **fully `server.close()`s before** green `listen`s (§1.2) — the two never hold 7777 at once, so
   there is no `SO_REUSEADDR` hijack window. Residual risk: green's `listen(7777)` fails (a stray process
   grabbed it in the gap) → green replies `promote-failed`, supervisor rolls back to blue (which hasn't
   exited yet — order `retire` **after** `promoted`). Make `EADDRINUSE` non-fatal when supervised
   (§4.2 #1).
3. **WAL writer contention during the flip.** Two hubs writing the shared `data/hub.db` can hit
   `SQLITE_BUSY` because **no `busy_timeout` is set** (`journal.ts:17`). Mitigations: (a) add
   `busy_timeout = 5000` (§1.6) — mandatory; (b) minimize the two-writer window by having green
   `loadRecords()` **read-only** and defer any stale-reconcile writes until `promote` (§2.4 / §4.2 #6); (c)
   never put the DB on a network share (WAL needs real shared memory — local FS only; the data dir is
   local by construction).
4. **Approval loss / reconciliation** (Phase 2) — the meatiest correctness item; idempotent re-issuable
   approvals (§2.5).
5. **Gap-free re-attach event replay** (Phase 2) — per-session `wseq` + `attach(since)` buffer (§2.5).

### 4.2 Code that assumes a single in-process hub (must-fix list)

1. **`server.ts:663-668` `EADDRINUSE → process.exit(1)`** — a supervised green must turn a bind failure
   into a `promote-failed` signal (rollback), not kill itself.
2. **`api.ts:145-146` hardcoded `127.0.0.1:7777`** (+ `vite.config.ts:4`) — the port is immutable; forces
   the fast-handoff/proxy decision (§1.2). No client change; that's the point.
3. **`journal.ts:17` no `busy_timeout`** — concurrent writers throw `SQLITE_BUSY`. Add the pragma.
4. **`meshSite.ts` register/deregister keyed on `tcp:<port>` (7777)** — blue's `deregister()` on retire
   deletes green's advert (same siteId). Move mesh ownership to hubctl, or gate green-register-on-promote +
   suppress blue-deregister-on-retire (§1.6).
5. **`index.ts:58` `usage.startPolling()` + codex `/usage` probes** — two hubs polling double-spend and
   race the shared `CODEX_HOME` token refresh. Green defers polling until `promote`.
6. **`sessions.ts:119-136` `boot()` eagerly marks `active|starting → idle`** — green marking a session
   blue is still running produces a spurious `session/restored-stale` + a store double-write (last-writer-
   wins on the `sessions` row; benign but messy). Split into `loadRecords()` (read-only) + a
   `reconcileStale()` that runs only on ownership (§2.4). Also gives Phase 2 its re-attach hook for free.
7. **`sessions.ts:792-802` `failInFlightCodexSessions`** on codex child exit — a **planned** retire kills
   blue's codex child and would emit `session/error "codex app-server exited mid-turn"`. Add the `graceful`
   flag to `shutdown()` (§1.6) to suppress it.
8. **`approvals.ts:14` in-memory `pendingMap`** — in-flight approvals die on restart. Phase 1: acceptable
   (agent dies too). Phase 2: idempotent re-issue (§2.5).
9. **`sessions.ts` in-process execution (the whole `SessionManager` executor half)** — the Phase-2
   blocker; extract `claudeDrivers`/`codexClients`/`codexThreads` + `runClaudeTurn`/`runCodexTurn`/
   `ensureCodexThread` + the MCP handlers behind the worker IPC boundary (§2.2).

### 4.3 Non-blockers (verified safe)

- **`deviceToken`** (`getOrCreateDeviceToken`, `index.ts:76`) — both hubs read the same persisted token
  file; idempotent, no conflict.
- **Unknown event kinds** — the web `apply()` switch already has `default: break` (`store.svelte.ts:1015`),
  so additive new kinds (`hub/retiring`, `hub/restart-aborted`, `worker/attach-gap`) are safe without a web
  change. (Add friendly renderers later; not required for correctness.)
- **Journal append-only + replay generator** — green serves the identical replay contract; the client's
  `seq <= lastSeq` dedup (`:828`) covers reconnect overlap.

---

## 5. File-by-file change summary

**New files**

| File | Purpose |
|---|---|
| `apps/hub/src/hubctl.ts` | The supervisor: owns hub lifetime; runs the blue-green flip; rollback (Phase 1). |
| `apps/hub/src/restartHandshake.ts` | Typed supervisor↔hub IPC messages + `waitReady`/`healthCheck` helpers. |
| `apps/hub/src/restartController.ts` | Hub-side `drain`/`promote`/`retire`/`abort` handlers (keeps `index.ts` thin). |
| `apps/hub/src/restartGate.ts` | Pure `decideRestartGate(...)` — the twin of `decidePracticeGate`. |
| `apps/hub/src/worker/agentWorker.ts` *(Phase 2)* | Long-lived agent executor (Claude drivers + Codex child + MCP handlers). |

**Edits**

| File | Change |
|---|---|
| `apps/hub/src/index.ts` | Detect `HUB_SUPERVISED`; emit `ready`; wire `process.on('message')` → `RestartController`; inject a `requestRestart` callback into `SessionManager`; defer `usage.startPolling()` + mesh to `promote`. |
| `apps/hub/src/server.ts` | `GET /api/health`; `POST /api/restart` (operator, forwards to supervisor, no gate); `503` on `POST /api/sessions` while `draining`; factor listen for `promote` re-listen; `EADDRINUSE` non-fatal when supervised; extend `/api/config/danger` + `persistDanger` with `autoApproveRestart`. |
| `apps/hub/src/sessions.ts` | `shutdown({graceful})` suppresses `failInFlightCodexSessions`; split `boot()` → `loadRecords()` + `reconcileStale()`; add `requestRestart`/`restart_hub` self-gate wiring; *(Phase 2)* proxy execution to the worker + `attachWorker()`. |
| `apps/hub/src/journal.ts` | `pragma('busy_timeout = 5000')` — two-hub write safety. |
| `apps/hub/src/agentTools.ts` | `restart_hub` tool (self-gating, bus-hard-deny, `searchHint`-deferred); add `requestRestart` to `AgentServices`. |
| `apps/hub/src/types.ts` | `autoApproveRestart` on `DangerConfig` + `DangerFlags`. |
| `apps/hub/src/meshSite.ts` | Move advert ownership to hubctl (or gate register/deregister across the flip). |
| `apps/desktop/src-tauri/src/lib.rs` | Spawn `hubctl` instead of the hub (dev `pnpm hubctl:dev`, release `node dist/hubctl.js`); everything else unchanged. |
| `package.json` / `apps/hub/package.json` | `hubctl:dev` scripts; ensure `dist/hubctl.js` builds + bundles. |
| `apps/web/src/lib/SettingsModal.svelte` | `autoApproveRestart` toggle + "Restart hub" button (`POST /api/restart`). |
| `apps/web/src/lib/store.svelte.ts` | *(optional)* friendly renderers for `hub/retiring` / `hub/restart-aborted` (unknown kinds are already safe). |

---

## 6. Build order

1. `busy_timeout` pragma + `shutdown({graceful})` + `boot()` → `loadRecords()`/`reconcileStale()` split
   (small, independently valuable — removes the two-writer + mislabel hazards even before hubctl).
2. `GET /api/health`, `POST /api/restart`, the `draining` 503 guard, supervised-mode detection + `ready`
   emit + `RestartController` (hub speaks the handshake but nothing drives it yet).
3. `hubctl.ts` + `restartHandshake.ts`: boot one hub, then the full blue-green flip with health-check +
   rollback. Wire the desktop shell + `hubctl:dev` scripts.
4. Mesh + usage-polling ownership fixes (§4.2 #4/#5).
5. Danger gate: `restartGate.ts`, `types.ts`, `agentTools.ts` `restart_hub`, Settings toggle.
6. **Phase 2:** worker process + IPC socket + `attachWorker()` re-attach + idempotent approvals + gap-free
   replay.

---

## 7. Open questions / spikes

- **Windows named-pipe vs unix-socket** for the Phase-2 worker endpoint — reuse the mesh framing
  (`meshSite.ts:64-125`); confirm pipe survives a hub reconnect cleanly.
- **`server.close()` + `listen(7777)` re-listen** on the same `http.Server` with an attached `ws` server —
  confirm the `WebSocketServer({server})` follows the re-listen (expected: yes, it binds to the server's
  `upgrade` event, not the port). Spike a local flip.
- **better-sqlite3 two-process WAL under load** — confirm `busy_timeout=5000` fully absorbs the flip-window
  contention (expected: yes; the window is sub-second and writes are tiny).
- **Codex `thread/resume` after a worker-less Phase 1 retire** — confirm a resumed thread continues cleanly
  after its app-server was taskkilled mid-turn (idle resume is already exercised by import; mid-turn kill +
  resume is the new case).
- **`schema_version` guard + additive migration runner** (Phase 3) — refuse to boot a hub older than the
  on-disk schema; run migrations in hubctl before green boots so a bad migration rolls back to blue.
