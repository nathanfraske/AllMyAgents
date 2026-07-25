# Agent worker process — Phase 2 file-by-file implementation plan

Build plan, drafted 2026-07-24. **Implementation plan only — this doc changes no code.** It turns the
Phase-2 preview of `docs/agent-detachment-impl.md` §2 into a concrete, build-ready, file-by-file plan
grounded in the code as it exists today, and assumes Phase 1 has shipped (the `hubctl` supervisor,
`restartController.ts`, `restartHandshake.ts`, the `loadRecords()`/`reconcileStale()` split, the
`shutdown({graceful})` flag, and `busy_timeout=5000` are all in tree — verified below).

**Goal.** An agent's **in-flight turn** (and its Claude sub-agents / Codex sub-tasks / running tool
calls) survives a hub restart. We move agent *execution* out of the restartable hub into a long-lived
**worker** process that `hubctl` supervises as a **sibling** of the hub, and make `boot()` **re-attach**
to the still-running worker instead of respawning it. Durable state (journal + stores) + the operator's
existing WS auto-reconnect then hide the seam exactly as they already do for operator panes.

**Two foundations are being built in parallel and are assumed to exist** (this plan is the consumer,
not the builder, of both):

1. **Idempotent, re-issuable approvals** — `ApprovalService.request` (`approvals.ts:22`) accepts a
   caller-supplied stable id and `resolve` is idempotent on an already-resolved id (§7).
2. **A per-session `wseq` buffer** — a new `wseqBuffer.ts`: a per-session monotonic sequence counter
   plus a bounded ring buffer of recent events, with `append(sessionId, event) → wseq` and
   `since(sessionId, afterWseq) → events[]` (§7). It lives **in the worker**.

---

## 0. What Phase 1 already gives us (the seams this plan builds on)

Every row is load-bearing and verified against the current tree.

| Fact | Where | Consequence for Phase 2 |
|---|---|---|
| `hubctl` is the supervisor and tree root; the desktop shell already spawns `pnpm hubctl:dev` (dev) / `dist/hubctl.js` (release) | `hubctl.ts`, `desktop/src-tauri/src/lib.rs:72,325` | The worker is a **new sibling child of hubctl**, added next to the hub — no desktop change. |
| `hubctl` spawns hubs with `stdio:['ignore','inherit','inherit','ipc']` + env, tracks them in a `children` Set, `killTree`s on teardown | `hubctl.ts:78-99,229-235` | Reuse verbatim to spawn + supervise + reap the worker. |
| The hub already detects supervision (`HUB_SUPERVISED==='1' && process.send`), reads `HUB_PORT`, and green defers work until `promote` | `index.ts:65-72` | `HUB_WORKER_SOCKET` is a **second** env var hubctl injects into every hub; its **presence is the Phase-2 feature flag**. |
| `boot()` is already split into `loadRecords()` (read-only) + `reconcileStale()` (flips `active|starting → idle`, journals `session/restored-stale`), and green passes `reconcile:false` | `sessions.ts:119-150`, `index.ts:71`, `restartController.ts:75` | `attachWorker()` slots in **between** `loadRecords()` and `reconcileStale()` — the re-attach hook already exists. |
| The journal is append-only, `replay()` is a synchronous gap-free generator, the WS handler drains replay then attaches the live listener in one tick, the web client auto-reconnects + dedups `seq <= lastSeq` | `journal.ts:74-83`, `server.ts:684-698` | Worker events the new hub journals get **fresh hub `seq`s** and reach reconnected panes automatically — **no web change**, the turn "finishes across the seam." |
| `journal.ts` sets `busy_timeout=5000`; two hubs already share `data/hub.db` safely during a flip | `journal.ts:21` | The worker **never opens the DB** — it relays every DB write to the hub, so there is still exactly one durable-write owner per store (the hub). |
| The mesh layer speaks a length-prefixed frame protocol over a local pipe: `[u32 BE len][1 tag byte][payload]`, `len` counts the tag, `TAG_JSON=0`, drain whole frames from a growing buffer | `meshSite.ts:64-125` | **Reuse this exact framing** for the worker transport (§2). |
| Codex runs as a hub-spawned `codex app-server` child (`shell:true`, `CODEX_HOME=profile.dir`); Claude runs in-process via the SDK `query()` async-gen with an in-process MCP server | `adapters/codex.ts:109-132`, `adapters/claude.ts:53-91`, `sessions.ts:265-318` | These are **exactly** what moves into the worker (§3). Relocating them relocates their whole child-process subtree — sub-agents/sub-tasks included (§3.4). |
| The self-gating tool handlers live in `buildAgentMcpServer` and call an `AgentServices` capability object the hub implements | `agentTools.ts:17-40,57-251`, `sessions.ts:105-117` | The handlers move to the worker; `AgentServices` becomes a set of **RPC proxies back to the hub** (§3.3). |
| The danger gate for restart is pure + tested: `decideRestartGate({isBusTurn,danger})`; `autoApproveRestart` exists on `DangerFlags` | `restartGate.ts`, `restartGate.test.ts`, `types.ts:165,173` | The restart tool's gate can be evaluated **in the worker** using worker-local `isBusTurn` + hub-pushed `danger` (§3.3). |

**Net:** Phase 1 already saved operator panes and idle agents. Everything below keeps the *live turn*
alive across a hub bounce by moving only the executor — and nothing else — out of the hub.

---

## 1. `workerProtocol.ts` — the typed worker RPC protocol

A new `apps/hub/src/workerProtocol.ts` holding **only types + a couple of pure helpers** (no I/O), the
single place hub and worker agree on message shapes — the exact role `restartHandshake.ts` plays for the
supervisor IPC. Three logical sub-channels multiplexed over one socket:

- **Commands** — hub → worker, request/reply correlated by `reqId`.
- **Event stream** — worker → hub, tagged `sessionId` + `wseq`, journaled by the hub.
- **Relays** — worker → hub, the in-process tool handlers reaching back into hub-owned services,
  correlated by `callId` / `approvalId`; plus one hub → worker push (`dangerUpdate`).

### 1.1 The session spec the worker needs

The worker holds no `SessionRecord` and never opens the store. The hub sends the subset the driver needs
on every command that can construct/resume a driver, so the worker's per-session state is just
`{ driver | codexThread, wseqBuffer, busTurn:boolean }`. Model/effort/mode changes ride along for free.

```ts
export interface WorkerSessionSpec {
  sessionId: string
  provider: 'claude' | 'codex'
  profileId: string
  profileDir: string            // → CLAUDE_CONFIG_DIR / CODEX_HOME (adapters read these)
  cwd: string
  worktree?: string             // for checkWriteScope in canUseTool
  projectId?: string            // identity → MCP attribution + same-project ACL
  label: string                 // identity label (identityOf output)
  model?: string
  effort?: string
  serviceTier?: string
  permissionMode?: 'safe' | 'edits' | 'full'
  vendorSessionId?: string      // claude `--resume` id / codex threadId to resume
}
```

The hub builds this from `SessionRecord` + the resolved `Profile` (`sessions.ts:199-203` `profileOf`) in
one private `specOf(record)` helper. The worker reconstructs `SessionIdentity` directly from the spec
(no `identityOf` needed; the fields line up 1:1 with `identity.ts:8-15`).

### 1.2 Hub → worker (commands)

```ts
export type HubToWorker =
  // Codex only: start a fresh app-server thread; the hub needs the threadId back to persist it
  // (mirrors sessions.ts:388-391) BEFORE it issues the first runTurn.
  | { t: 'startThread'; reqId: string; spec: WorkerSessionSpec }
  // Run one turn. Fire-and-progress: the worker acks acceptance, then streams events + a turn-lifecycle
  // message. `prompt` is ALREADY recall-augmented by the hub (withRecall stays hub-side, §4.2).
  | { t: 'runTurn'; reqId: string; spec: WorkerSessionSpec; prompt: string; origin: 'operator' | 'bus' }
  | { t: 'steer'; reqId: string; sessionId: string; text: string }          // codex turn/steer
  | { t: 'interrupt'; reqId: string; sessionId: string }
  | { t: 'stopSession'; reqId: string; sessionId: string }                  // drop the driver/thread (stop/delete)
  | { t: 'listLive'; reqId: string }                                        // hub boot: who is the worker still holding?
  | { t: 'attach'; reqId: string; since: Record<string, number> }           // replay per-session events with wseq > since[sid]
  | { t: 'readCodexLimits'; reqId: string; profileId: string; profileDir: string }
  // Pushes (no reqId, fire-and-forget):
  | { t: 'dangerUpdate'; danger: DangerFlags }                              // live Danger Zone flags (on connect + on change)
  | { t: 'draining' }                                                       // pre-flip: worker holds new relays before the socket drops (§8.4)
  | { t: 'approvalResolved'; approvalId: string; approved: boolean }         // reply to a worker approvalRequest
  | { t: 'rpcResult'; callId: string; ok: boolean; value?: unknown; error?: string } // reply to a worker relay call
```

### 1.3 Worker → hub

```ts
export type WorkerToHub =
  // --- vendor event stream: the SAME kinds the hub journals today (claude/*, codex/*, session/tokens,
  //     codex/stderr, codex/raw, …), each tagged sessionId + a per-session monotonic wseq (§7). ---
  | { t: 'event'; sessionId: string; wseq: number; kind: string; payload: unknown }
  // --- turn lifecycle: drives the hub's setStatus + vendorSessionId persistence + deliverBus. ---
  | { t: 'turnStarted'; sessionId: string; wseq: number }
  | { t: 'turnCompleted'; sessionId: string; wseq: number; vendorSessionId?: string }
  | { t: 'turnError'; sessionId: string; wseq: number; message: string }
  // --- self-gating tool-handler relays (the worker's MCP handlers reaching hub-owned services) ---
  | { t: 'approvalRequest'; approvalId: string; sessionId: string; kind: string; payload: unknown }
  | { t: 'rpc'; callId: string; method: RelayMethod; args: unknown }        // bus.* / memory.* / practices.*; callId STABLE across re-flush → hub dedups writes (§8.2)
  // NB: a tool handler's audit `journal(sessionId, kind, payload)` is emitted as an `event` above (it is
  //     always sessionId-attributed) so it is wseq-tagged + deduped identically — there is NO separate,
  //     un-deduped journal channel that a re-flush could double-write (§8.2).
  | { t: 'restartRequest'; reason: string; bySession?: string }            // restart_hub tool → hub → hubctl
  // --- command acks/replies ---
  | { t: 'ack'; reqId: string; ok: boolean; error?: string }               // reply to runTurn/steer/interrupt/stopSession/attach
  | { t: 'threadStarted'; reqId: string; threadId: string }                // reply to startThread
  | { t: 'codexLimits'; reqId: string; ok: boolean; value?: unknown; error?: string } // reply to readCodexLimits
  | { t: 'live'; reqId: string; sessions: LiveSession[] }                   // reply to listLive

export interface LiveSession { sessionId: string; status: 'active' | 'idle'; lastWseq: number }

export type RelayMethod =
  | 'bus.send' | 'bus.inbox' | 'bus.roster'
  | 'memory.write' | 'memory.search' | 'memory.get'
  | 'practices.write' | 'practices.edit' | 'practices.get' | 'practices.list'
```

**Why these exact relay methods:** they are precisely the `AgentServices` surface the MCP tools call
(`agentTools.ts:17-40`) minus the three the worker handles locally — `isBusTurn` (worker-local, §3.3),
`danger` (hub-pushed cache), and `requireApproval` (its own `approvalRequest` channel). `memory.recall`
is **not** in the list because auto-recall stays hub-side (§4.2).

### 1.4 Correlation + helpers

`workerProtocol.ts` also exports tiny pure helpers so both sides stay honest:

- `nextReqId()` — a fresh monotonic counter for hub→worker commands.
- `stableApprovalId(sessionId, kind, payloadHash)` — **deterministic** from `(sessionId, kind, payload)`
  so a re-issue after a hub restart collides on the same id (§7.2, §8.2).
- `callId` for a relay `rpc` — minted **once per logical call** and **reused** on re-flush (not a fresh
  counter), so the successor hub can dedup a re-sent write by callId (§8.2).
- No `waitFor`-style helpers here (unlike `restartHandshake.ts`): correlation lives in the transport's
  pending-map (§2), because the worker socket carries *many* concurrent in-flight calls, not the
  supervisor's one-at-a-time flip handshake.

### 1.5 Transient-gap constants + result shapes (shared, single source of truth)

The bounds and the retryable shape live here so hub and worker agree exactly (consumed by
`workerTransport.ts` §2 and `agentWorker.ts` §3, and specced against a flip in §8):

```ts
export const HUB_RECONNECT_INTERVAL_MS = 1_000   // hub WorkerClient reconnect cadence (matches the web WS)
export const HUB_RELAY_TIMEOUT_MS      = 45_000  // transient→terminal bound; covers a restart AND a rollback (§8.3)
export const RELAY_QUEUE_MAX           = 1_000   // worker relay-lane bound; overflow = terminal for that call (§8.1)

// The ONE retryable shape a tool returns when a relay exceeds the transient bound — never a permanent
// "denied"/"disabled"/"gone" shape, which an agent reads as a broken system (§8.3).
export const HUB_UNAVAILABLE_TEXT =
  'The hub is briefly unavailable (it is restarting). Nothing was lost — retry this tool call in a moment.'
export class HubUnavailableError extends Error { readonly retryable = true }
```

---

## 2. `workerTransport.ts` — length-prefixed frames over a durable local socket

A new `apps/hub/src/workerTransport.ts`: the wire. It reuses meshSite's frame codec (`meshSite.ts:88-115`)
— `[u32 BE length][1 tag byte][payload]`, `length` counts the tag byte, `TAG_JSON=0`, drain whole frames
from a growing `Buffer` — but wraps it in a **long-lived, bidirectional, multiplexed, auto-reconnecting**
channel instead of meshSite's one-shot `roundTrip`.

### 2.1 The endpoint (`HUB_WORKER_SOCKET`)

A fixed path under `data/`, computed by `hubctl` and injected into **both** the worker (to listen) and
every hub (to connect) via the `HUB_WORKER_SOCKET` env var. Mirrors `meshSite.defaultSocketPath()`
(`meshSite.ts:51-57`):

```ts
export function defaultWorkerSocket(dataDir: string): string {
  if (process.env.HUB_WORKER_SOCKET) return process.env.HUB_WORKER_SOCKET
  return process.platform === 'win32'
    ? '\\\\.\\pipe\\allmyagents-worker'          // Windows named pipe (no filesystem cleanup needed)
    : path.join(dataDir, 'worker.sock')          // unix domain socket under data/
}
```

The **presence** of `HUB_WORKER_SOCKET` in the hub's env is the Phase-2 feature flag (§4.1): set →
worker mode; absent → today's in-process executor.

### 2.2 `WorkerFrameChannel` (shared)

One class both sides use over a connected `net.Socket`: `send(obj)` (JSON → frame → `socket.write`) and
an `'message'` event (drain frames → `JSON.parse` → emit). Identical byte layout to `meshSite.ts:88-115`;
factor the encode/decode into two functions (`encodeFrame(obj): Buffer`, a stateful `FrameDecoder` that
buffers partial reads) so the codec is unit-testable in isolation. Non-JSON/oversize frames are dropped
with a logged warning (never throw out of the data path).

### 2.3 `WorkerServer` (the worker side)

```ts
export class WorkerServer {   // agentWorker.ts constructs one
  constructor(socketPath: string, handlers: WorkerHandlers)
  // net.createServer; on unix, unlink a stale socket file first (Windows pipes need no cleanup).
  // Accepts ONE hub connection at a time (the live hub). A new connection REPLACES the old channel
  // (a fresh hub re-attaching after its predecessor died) — the worker keeps running throughout.
  // Outbound messages address "the current hub channel". If none is attached (or the channel is marked
  // draining, §8.4) they QUEUE in two lanes and flush on the next attach — this is what carries a turn's
  // events + tool RPCs across a flip (§8.1):
  //   • event lane   → the per-session wseqBuffer: bounded, DROP-OLDEST, gap marked worker/attach-gap (§7.1)
  //   • relay lane   → a pending-relay map (approvalRequest/rpc/journal): bounded RELAY_QUEUE_MAX=1000,
  //                    NEVER drop-oldest (each has an awaiting caller); overflow → HubUnavailableError (§8.3)
  send(msg: WorkerToHub): void
  onHub(msg: HubToWorker): void          // includes { t:'draining' } → mark channel draining, hold new relays (§8.4)
}
```

Only one hub is ever live (blue *or* green owns 7777, never both — Phase 1 §1.2), so single-connection
is correct; a green that connects during a flip's overlap is the *successor* and should replace blue's
channel. Guard with a monotonic `attachEpoch` the hub sends in a `hello`, so a late frame from the
retiring blue's channel can't clobber green's. A relay whose Promise is still pending when
`HUB_RELAY_TIMEOUT_MS` (45s) elapses with no attach resolves by throwing `HubUnavailableError` — the only
terminal path for the relay lane, and the worker keeps running regardless (§8.3).

### 2.4 `WorkerClient` (the hub side, auto-reconnecting)

```ts
export class WorkerClient extends EventEmitter {   // sessions.ts / WorkerExecutor holds one
  constructor(socketPath: string)
  connect(): void          // net.connect; on 'connect' → emit 'attached'; on 'close'/'error' → schedule reconnect
  call<T>(msg: HubToWorker & { reqId }): Promise<T>   // register reqId in a pending Map, resolve on the matching reply
  send(msg: HubToWorker): void                         // fire-and-forget (dangerUpdate/approvalResolved/rpcResult)
  signalDraining(): void                               // blue calls this in drain() → send { t:'draining' } (§8.4)
  onEvent(cb), onTurnLifecycle(cb), onRelay(cb), onRestartRequest(cb)  // worker→hub streams
}
```

**Auto-reconnect is the crux of re-attach.** On `'close'`/`'error'` the client retries `net.connect` every
`HUB_RECONNECT_INTERVAL_MS` (~1s, the web WS cadence, `store.svelte.ts`), unbounded, and on each successful
`'attached'` re-runs the hub's `attachWorker()` sequence (§6) — which is also what prompts the worker to
**flush its queued relay + event lanes** to this fresh channel (§8.1). So a **fresh hub** started by hubctl
connects to the **same still-listening worker**, re-subscribes to live turns, and drains everything the
worker buffered during the gap — the whole Phase-2 win rides on this loop.

Direction matters for the failure shape. A hub→worker `call()` only rejects when the **worker** is
unreachable (a worker crash — rare, §9.2), surfaced retryably. The **flip** case is the opposite direction:
the worker→hub relays a live turn depends on are held worker-side and flushed here (§8), so a flip is a
~1s pause, never a rejected tool call.

---

## 3. `agentWorker.ts` — the long-lived executor

A new `apps/hub/src/agentWorker.ts`, spawned by hubctl (§5), launched exactly like the hub (`node
dist/agentWorker.js` in prod, `node --import tsx/esm agentWorker.ts` in dev — hubctl's existing
`hubLaunchCommand` pattern, `hubctl.ts:63-71`). It hosts **everything execution** and **nothing durable**.

### 3.1 What it owns (moved verbatim from `sessions.ts`)

- `claudeDrivers: Map<string, ClaudeDriver>` and `claudeDriverFor(spec)` — the driver construction +
  `onEvent`/`canUseTool`/`mcpServers` wiring (`sessions.ts:265-318`).
- `codexClients: Map<string, CodexClient>` + `codexThreads: Map<string, string>` +
  `codexClientFor(profileDir)` (`sessions.ts:225-263`).
- `busTurnSessions: Set<string>` (`sessions.ts:80`) — set from `runTurn.origin`, cleared in the turn's
  `finally`; the worker-local source of truth for `isBusTurn`.
- The turn loops `runClaudeTurn` / `runCodexTurn` / `ensureCodexThread` **stripped to their driver half**
  (`sessions.ts:542-609`): they call `driver.send` / `client.sendTurn` / `client.resumeThread` and emit
  `turnStarted`/`turnCompleted`/`turnError` + events; they no longer touch store/journal/status/withRecall
  (those stayed on the hub).
- `checkWriteScope` (`sessions.ts:205-216`) — used inside `canUseTool`; needs `spec.worktree`/`spec.cwd`.
- `buildAgentMcpServer(identity, services)` — **unchanged** (`agentTools.ts`); only the `services` object
  it receives changes shape (§3.3).
- A `wseqBuffer` per session (the parallel foundation) — every outbound event/lifecycle message is
  `append`ed here (assigning `wseq`) as it is sent, so `attach(since)` can replay the gap (§7).

### 3.2 The driver `onEvent` → hub event stream

Today `claudeDriverFor`'s `onEvent` both journals **and** runs side effects (`usage.noteClaude`, codex
`setStatus` on `turn/completed`, `session/tokens` mapping — `sessions.ts:272-281,232-251`). Split them:

- **In the worker:** `onEvent(kind, payload)` → `const wseq = buf.append(sessionId, {kind, payload})` →
  `server.send({ t:'event', sessionId, wseq, kind, payload })`. For codex the worker resolves `sessionId`
  from its own `codexThreads` (its private `sessionForThread`); for claude the driver is per-session so
  `sessionId` is known at construction.
- **On the hub:** a new `ingestWorkerEvent(sessionId, wseq, kind, payload)` re-homes the side effects it
  read from the raw kind — `journal.append` + `usage.noteClaude`/`noteClaudeCost` (it has the record →
  `profileId`) + the `mapCodexTokenUsage` → `session/tokens` derivation. **Status/`vendorSessionId`/
  `deliverBus` are driven by the explicit lifecycle messages, not sniffed from kinds** (cleaner than
  today's `codex/turn/completed` sniff): `turnCompleted → setStatus(idle) + persist vendorSessionId`,
  `turnError → journal session/error + setStatus(error)`, `turnStarted → setStatus(active)`.

Because the hub's `journal.append` + WS emit path is **unchanged**, every worker event reaches
reconnected operator panes exactly as a native event does — this is the property that makes the whole
migration invisible to the web tier.

### 3.3 The MCP handlers RPC back to the hub

`buildAgentMcpServer` runs **inside** the SDK `query()` process (the SDK invokes the tool callbacks), so
the handler bodies **must** live in the worker. The `AgentServices` object they receive becomes a set of
RPC proxies:

| `AgentServices` member | Worker implementation |
|---|---|
| `send / inbox / roster` (`agentTools.ts:19-23`) | `client.rpc('bus.send'|'bus.inbox'|'bus.roster', args)` → hub runs `busSend`/`busInbox`/`busRoster` (`sessions.ts:679-725`) against the DB, replies `rpcResult`. |
| `memory` (write/search/get) | a thin proxy object whose 3 methods are `client.rpc('memory.*', args)` → hub runs the real `MemoryStore`. |
| `practices` (write/edit/get/list) | same, `client.rpc('practices.*', args)` → hub `PracticeStore`. |
| `requireApproval(id, kind, payload)` | generate `stableApprovalId`, `server.send({t:'approvalRequest',…})`, return a Promise resolved when the matching `approvalResolved` arrives. **The re-issue path (§7) hangs off this.** |
| `isBusTurn(sessionId)` | **worker-local**: `busTurnSessions.has(sessionId)`. |
| `danger()` | **worker-cached**: returns the last `dangerUpdate` push (defaults to all-OFF/safe until the first push, which the hub sends immediately on connect — fail-safe). |
| `journal(sessionId, kind, payload)` | emitted into the wseq'd **event** stream (§7.1) so a re-flush dedups it exactly like a vendor event — no separate un-deduped journal channel (§8.2). |

`decidePracticeGate` / `decideRestartGate` are **pure** and run in the worker on worker-local `isBusTurn`
+ cached `danger` — no round-trip to decide the gate, only to *act* (approval/write). When `restart_hub`
lands in `agentTools.ts`, its `services.requestRestart(reason)` becomes `server.send({t:'restartRequest',
reason, bySession})` → the hub calls its existing `requestRestart` (`sessions.ts:158-162`) → hubctl.

Every tool body from `buildAgentMcpServer` is wrapped, at build time in the worker, in
`withRetryableHubErrors(fn)` — a one-line adapter that catches a `HubUnavailableError` bubbling up from any
of these RPC proxies (a hub gone past the transient bound) and returns `textResult(HUB_UNAVAILABLE_TEXT)`,
so a mid-flip gap always surfaces as a **retryable** result and never a permanent one (§8.3). The proxies
therefore propagate `HubUnavailableError` rather than swallowing it into a falsy/denied value — critically,
`requireApproval` throws it rather than returning `false`.

### 3.4 Sub-agents and sub-tasks survive **for free** — call this out

Claude's `Agent` tool spawns sub-agents **inside the same `query()`** the `ClaudeDriver` is consuming;
Codex sub-tasks run **inside the `codex app-server` child**. Both are descendants of the *driver's* process
subtree. Once that subtree lives in the worker, a hub restart — which touches only the hub process —
leaves the entire subtree (parent turn, sub-agents, running Bash/tool calls, the app-server and its
grandchildren) **completely undisturbed**. There is **no sub-agent-specific code** in this plan: relocating
the executor relocates the whole tree, and re-attach (§6) simply re-subscribes to the events it keeps
emitting. This is the single most valuable structural consequence of the move.

### 3.5 What the worker deliberately does NOT do

No `Journal`, no `SessionStore`/`ProjectStore`/`AgentBus`/`MemoryStore`/`PracticeStore`/`InstructionStore`,
no `ApprovalService`, no `UsageMonitor`, no HTTP/WS, no mesh, no `better-sqlite3` handle. It never opens
`data/hub.db`. Its only durable side effects are the vendor processes' own on-disk transcripts
(`~/.claude`, `CODEX_HOME`), which already survive independently and are the basis of lazy resume.

---

## 4. `sessions.ts` — the proxy refactor (feature-flagged, incremental)

The whole point of the flag is that **the hub is runnable and shippable at every step**. We introduce an
`Executor` seam so today's in-process code and the worker-proxy code are two implementations of one
interface, chosen at construction by the presence of `HUB_WORKER_SOCKET`.

### 4.1 The `Executor` interface

```ts
export interface Executor {
  startThread(spec: WorkerSessionSpec): Promise<string>            // codex threadId
  runTurn(spec: WorkerSessionSpec, prompt: string, origin: 'operator'|'bus'): Promise<void>  // resolves on ACCEPT, not completion
  steer(sessionId: string, text: string): Promise<void>
  interrupt(sessionId: string): Promise<void>
  stopSession(sessionId: string): Promise<void>
  readCodexLimits(profileId: string, profileDir: string): Promise<unknown>
  listLive(): Promise<LiveSession[]>
  attach(since: Record<string, number>): Promise<void>
  isBusy(sessionId: string): boolean            // for the "a turn is already in progress" guard
}
```

- **`InProcessExecutor`** — a straight lift of today's `claudeDriverFor`/`codexClientFor`/`runClaudeTurn`/
  `runCodexTurn`/`ensureCodexThread`/`readCodexLimits` bodies. `runTurn` still does the side effects
  inline (it *is* the hub). `listLive`/`attach` are no-ops (`attach` resolves immediately; `listLive`
  returns the driver map's live entries). This is a **behavior-preserving refactor** — step 1 of the
  build ships it with zero functional change and the existing tests still pass.
- **`WorkerExecutor`** — holds a `WorkerClient` (§2.4). Each method is a `call()`/`send()`. The turn side
  effects (status, journal, usage, deliverBus, vendorSessionId) do **not** happen here — they are driven
  by the worker→hub event + lifecycle streams, handled by hub callbacks the executor wires on construction
  (`onEvent → ingestWorkerEvent`, `onTurnLifecycle → applyLifecycle`, `onRelay → runRelay`,
  `onRestartRequest → requestRestart`). `isBusy` is tracked from lifecycle (`turnStarted`/`turnCompleted`).

### 4.2 What stays on the hub (unchanged), what moves

**Stays on the hub** (all durable-state + policy that isn't the driver): `create` (record + worktree +
`writeManagedInstructions` + persist), `send`/`steer`/`interrupt`/`stop`/`delete` **shells** (they now
call `this.executor.*` instead of touching drivers directly), `setStatus`/`persist`/`autoTitle`,
`withRecall` (auto-recall reads `MemoryStore` + journals `memory/recalled` — the augmented prompt is what
`runTurn` carries), `deliverBus`/`busSend`/`busInbox`/`busRoster`, `reconcileStale`/`loadRecords`/`boot`,
`requestRestart`, import/history, the `bus/memory/practice` **relay executors** (they run the same store
methods the in-process `agentServices()` did, just invoked over RPC).

**Moves to the worker:** the maps `claudeDrivers`/`codexClients`/`codexThreads`, `busTurnSessions`, the
driver halves of `runClaudeTurn`/`runCodexTurn`/`ensureCodexThread`, `claudeDriverFor`/`codexClientFor`,
`checkWriteScope`, and the `buildAgentMcpServer` wiring.

### 4.3 Concrete per-method mapping

| `SessionManager` method | In-process today | Worker mode |
|---|---|---|
| `create` (claude, `sessions.ts:382-385`) | `claudeDriverFor(record)` + `setStatus(idle)` + `void runClaudeTurn` | build record/worktree/instructions (unchanged); `setStatus(idle)`; if prompt → `executor.runTurn(specOf(record), withRecall(...), 'operator')`. The worker builds the driver lazily on that first `runTurn`. |
| `create` (codex, `sessions.ts:386-393`) | `client.startThread(cwd)` → persist threadId → `runCodexTurn` | `executor.startThread(spec)` → persist `vendorSessionId` (unchanged persistence) → `setStatus(idle)` → `executor.runTurn(...)`. |
| `send` (`sessions.ts:611-630`) | busy-check on `claudeDrivers.get(id)?.busy`; run turn | busy-check via `executor.isBusy(id)` **or** `record.status==='active'`; `executor.runTurn(specOf(record), withRecall(record,text), 'operator')`. |
| `steer` (`sessions.ts:632-639`) | `ensureCodexThread` + `client.steer` | `executor.steer(id, text)` + journal `session/steered` (journal stays hub-side). |
| `interrupt` (`sessions.ts:757-767`) | `driver.interrupt()` / `client.interrupt(threadId)` | `executor.interrupt(id)` + journal `session/interrupted`. |
| `stop` (`sessions.ts:769-778`) | `interrupt` + worktree remove + `setStatus(stopped)` | `executor.stopSession(id)` (interrupt + drop driver) + worktree remove + `setStatus(stopped)` — worktree/status stay hub-side. |
| `delete` (`sessions.ts:784-802`) | `stop` + tombstone + map deletes + `store.remove` | same, but the "drop driver" is `executor.stopSession(id)`; the hub's `claudeDrivers`/`codexThreads` deletes become no-ops in worker mode (the worker owns those). |
| `readCodexLimits` (`sessions.ts:804-808`) | `codexClientFor(profile).readRateLimits()` | `executor.readCodexLimits(profileId, profile.dir)`. |
| `deliverBus` (`sessions.ts:733-755`) | reads bus DB, frames, `runClaudeTurn(...,'bus')` | **unchanged hub logic**; the final call is `executor.runTurn(specOf(record), framed, 'bus')`. The worker tags `busTurnSessions` from `origin:'bus'`. |
| `shutdown` (`sessions.ts:821-831`) | taskkills codex children + interrupts claude | in worker mode a hub `shutdown` **must not** kill the worker's children (that would defeat Phase 2) — it becomes a no-op for vendor teardown; only a *worker* shutdown (hubctl-driven, rare) tears the children down. |

### 4.4 Wiring in `index.ts`

```ts
const workerSocket = process.env.HUB_WORKER_SOCKET            // presence = worker mode
const executor: Executor = workerSocket
  ? new WorkerExecutor(new WorkerClient(workerSocket), { ingestWorkerEvent, applyLifecycle, runRelay, requestRestart, pushDanger })
  : new InProcessExecutor(/* journal, approvals, usage, buildAgentMcpServer, … as today */)
const sessions = new SessionManager(/* …existing deps…, */ executor)
```

`SessionManager` takes the `Executor` as a constructor dep. On `POST /api/config/danger`
(`server.ts:472-481`) the hub additionally calls `executor.pushDanger?.(danger)` (a no-op in-process) so
the worker's cached `danger()` stays live. Everything else in `index.ts`/`server.ts` is untouched → the
unsupervised/standalone hub and the flag-off hub behave **exactly** as today.

---

## 5. `hubctl.ts` — spawn the worker as a supervised sibling

The worker joins hubctl's `children` set as a **peer of the hub**, born before blue and **outliving every
blue↔green flip** (that persistence across the flip is the entire reason it exists).

### 5.1 Changes

- **Compute the socket path once** at startup (`defaultWorkerSocket(dataDir)`), export it into the
  environment for every child.
- **`spawnWorker()`** — near-identical to `spawnHub` (`hubctl.ts:78-99`): `spawn(cmd, args,
  { stdio:['ignore','inherit','inherit','ipc'], env:{ ...process.env, HUB_WORKER_SOCKET } })`, add to
  `children`, log, and on unexpected `exit` **respawn it** (the worker is meant to be always-up; a fresh
  worker + the hubs' auto-reconnect clients recover — degraded to Phase-1 semantics for any turn that was
  live, §8). The worker launch command is `workerLaunchCommand()` — a copy of `hubLaunchCommand`
  resolving `agentWorker.js`/`agentWorker.ts`.
- **`spawnHub`** gains `HUB_WORKER_SOCKET` in the env it passes to each hub (blue **and** green), so both
  connect to the same worker. One-line change to the existing `env` object (`hubctl.ts:82`).
- **`boot()`** (`hubctl.ts:157-165`): `spawnWorker()` **first**, then `spawnHub(FIXED_PORT,'blue')` as
  today. No health-check gate on the worker at boot (a hub with no worker yet simply retries its connect
  loop until the worker is up — the reconnect handles ordering; blue's `ready` doesn't depend on the
  worker).
- **`teardown`** (`hubctl.ts:229-233`) already `killTree`s every child in the set — the worker is torn
  down with the rest, no change. A worker `killTree` uses the same `taskkill /T /F` tree-kill that already
  reaps the codex app-server grandchildren.
- **Flip unchanged.** `restart()` (`hubctl.ts:173-226`) never touches the worker: green boots, connects to
  the running worker, re-attaches; blue retires. The worker sees green replace blue's channel (§2.3). No
  new flip logic — the worker is simply not part of the port dance.

### 5.2 Optional: worker health signal

If a hub's `WorkerClient` exhausts a long reconnect budget (worker present but wedged), the hub can
`process.send({type:'worker-unreachable'})` to hubctl (a new `HubMsg` in `restartHandshake.ts`) and
hubctl `killTree`s + respawns the worker. Keep this **out of the first cut** (adds a failure-amplification
path); the plain respawn-on-exit above covers the common case.

### 5.3 Build/bundle

`tsc -p tsconfig.build.json` already compiles all of `src` → `dist`, so `dist/agentWorker.js`,
`dist/workerProtocol.js`, `dist/workerTransport.js` emit automatically (same as `dist/hubctl.js`).
`scripts/bundle-hub.mjs` copies the whole `dist/` (`bundle-hub.mjs:85`) so they ship with no change;
add a `must(dist/agentWorker.js)` assertion next to the existing `must(dist/index.js)`
(`bundle-hub.mjs:124`) as a guardrail. No new `package.json` script is required (hubctl spawns the worker
directly), though a `"worker:dev": "tsx src/agentWorker.ts"` is handy for isolated testing.

---

## 6. `boot()` → `attachWorker()` — re-attach, don't respawn

The Phase-1 `boot()` already reads `loadRecords()` (read-only) then `reconcileStale()`. Phase 2 inserts
`attachWorker()` **between** them, so re-attach decides each session's fate *before* the blunt stale sweep
runs:

```ts
boot(opts?) {
  this.registerDefaultHomes()
  this.loadRecords()                         // read-only; marks nothing (sessions.ts:136-138)
  // (attachWorker runs asynchronously off the executor's first 'attached' event — see below)
  if (opts?.reconcile !== false) this.reconcileStale()   // now: only for sessions the worker doesn't claim
}
```

Because the worker connection is async and auto-reconnecting, `attachWorker()` is driven by the
`WorkerClient`'s `'attached'` event, **not** called inline in `boot()`. On every (re)attach:

```ts
async attachWorker() {
  const live = await this.executor.listLive()               // LiveSession[] the worker still holds
  const liveIds = new Set(live.map(s => s.sessionId))
  const since: Record<string, number> = {}
  for (const s of live) {
    const rec = this.sessions.get(s.sessionId)
    if (!rec) continue                                       // worker holds a session we deleted → ignore
    if (s.status === 'active') {
      rec.status = 'active'                                  // keep it active across the seam
      since[s.sessionId] = this.lastJournaledWseq(s.sessionId)   // the durable replay cursor (§7)
    } else {
      this.setStatus(rec, 'idle')                            // driver alive but idle
    }
  }
  if (Object.keys(since).length) await this.executor.attach(since)   // replay gap events with wseq > cursor
  // Sessions the worker does NOT claim are truly stale → the normal Phase-1 path:
  for (const rec of this.sessions.values()) {
    if ((rec.status === 'active' || rec.status === 'starting') && !liveIds.has(rec.id)) {
      rec.status = 'idle'
      this.journal.append(rec.id, 'session/restored-stale', { note: 'worker had no live driver' })
      this.store.upsert(rec)
    }
  }
}
```

The three outcomes from `docs/agent-detachment-impl.md` §2.4, made concrete:

- **mid-turn (worker says `active`)** → stay `active`, `attach({sid:lastWseq})`; the worker replays every
  event it emitted during the hub gap, then live events flow; when the turn's `turnCompleted` lands, the
  new hub journals it and the operator's reconnected pane watches it finish — **the Phase-2 win**.
- **idle (worker holds the driver, no live turn)** → `setStatus(idle)` (identical to today).
- **unknown (worker never heard of it, or worker was respawned fresh)** → truly stale → the existing
  `session/restored-stale` + lazy vendor resume on next send.

For the **cold-start** case (hubctl just booted both; worker is empty) `listLive()` returns `[]`, `attach`
is skipped, and every restored `active` record falls into the stale branch — i.e. `attachWorker()`
gracefully **is** `reconcileStale()` when there's nothing to re-attach to. So the `reconcile:!isGreen`
gating in `index.ts:71` still holds: green defers the sweep to `promote`, and by then its `attachWorker()`
has run against the live worker.

---

## 7. Approval reconciliation + the wseq gap — how the two foundations plug in

These are the two hardest correctness items (`docs/agent-detachment-impl.md` §2.5) and the two parallel
foundations exist precisely to make them tractable.

### 7.1 Gap-free, exactly-once event replay (the `wseq` foundation)

**Worker side** (`wseqBuffer.ts`, assumed): every outbound `event`/`turn*` message is `append`ed to the
per-session buffer, which assigns a strictly monotonic `wseq` and retains the last *N* (bounded ring). The
message carries that `wseq`. `attach(since)` replays `buf.since(sid, since[sid])` in order, then resumes
live emission. If the requested `since[sid]` is **older than the buffer's oldest retained wseq** (the hub
was gone long enough that the ring wrapped), the worker first emits a synthetic
`{ kind:'worker/attach-gap', payload:{ sessionId, droppedThrough } }` event so the hub records that some
vendor events were lost, then replays what remains. `worker/attach-gap` is an **additive** kind — the web
`apply()` switch already `default: break`s unknown kinds (`docs/agent-detachment-impl.md` §4.3), so no web
change is needed for correctness (a friendly renderer is a nice-to-have later).

**Hub side (the durable replay cursor)** — the new hub, after a crash, has **no in-memory memory** of what
it already journaled, so it must derive `since[sid]` durably. The cleanest source is the journal itself:
tag each journaled worker event with its `wseq`. Add a nullable `wseq` column to the `events` table
(`journal.ts:22-24`) — additive, back-compat (`ALTER TABLE events ADD COLUMN wseq INTEGER`, guarded; old
rows are `NULL`), written in the existing single `INSERT` (`journal.ts:25`) via a new
`journal.appendWorker(sessionId, kind, payload, wseq)` variant. Then:

```ts
lastJournaledWseq(sessionId) = SELECT MAX(wseq) FROM events WHERE session = ? AND wseq IS NOT NULL   // or 0
```

One indexed query per live session at attach time. **Dedup is automatic:** the worker only replays
`wseq > since`, and `since` *is* the max already durably journaled, so no event is journaled twice and none
is skipped — the same exactly-once invariant `journal.replay()` already guarantees for the WS
(`journal.ts:74-83`), extended across the worker boundary. (Steady-state, the hub also keeps an in-memory
`lastWseq` per session so it never re-queries mid-turn; the query is only the boot/re-attach seed.)

### 7.2 Approval reconciliation across a hub restart (the idempotent-approvals foundation)

The failure: a worker MCP handler is `await`ing `requireApproval` → an `approvalRequest` is outstanding at
the hub, whose `ApprovalService` pending map is **in-memory** (`approvals.ts:14`). The hub restarts; that
pending Promise and its resolver are gone; the worker's await would hang forever.

The fix, using the foundation:

1. The worker generates a **stable** `approvalId = stableApprovalId(sessionId, kind, payloadHash)` (§1.4)
   and keeps every outstanding `approvalRequest` in a small pending set.
2. On each `'attached'` (i.e. after any hub restart), the worker **re-sends** all outstanding
   `approvalRequest`s.
3. The new hub calls `approvals.request(sessionId, kind, payload, { id: approvalId })` — the extended,
   **idempotent** signature: if an entry with that id already exists (e.g. it was journaled by the dead
   hub and the operator hasn't decided yet) it re-creates the pending entry and re-journals
   `approval/requested` **deduped on the id** rather than minting a new one; if it was *already resolved*
   before the crash, `request` returns the resolved value immediately.
4. The operator resolves against the **new** hub via the existing `POST /api/approvals/:id`
   (`server.ts:586-591`) — same id, so the button the reconnected pane shows still works.
5. The hub sends `approvalResolved{approvalId, approved}` to the worker; the worker's pending Promise
   resolves; the handler continues.

Net: an approval in flight across a restart is **re-offered**, not lost, and resolving it once — before or
after the restart — is honored exactly once. Timeouts still fail-closed at 10 min (`approvals.ts:5`),
measured from the *latest* re-issue (a restart resets the operator's clock, which is the humane choice).

---

## 8. Transient hub-unavailability during a blue-green flip (the operator's key concern)

A flip (or a crash+respawn) leaves a **window of seconds** with no hub listening. The worker keeps
executing the turn the whole time (that is the entire point), but the turn's **tool handlers** may try to
reach the hub mid-gap — a `memory_write`, a `send_message`, an approval, an audit `journal`. The
requirement: **a transient gap must never surface to the agent as a broken tool.** An agent that sees
*"temporarily unavailable, retry"* retries gracefully; an agent that sees *"denied"* / *"tool disabled"* /
a thrown *"gone"* gives up or hallucinates a broken system and derails the turn. So we **queue-and-wait**
across the gap and, only past a generous bound, return a **retryable** shape — never a terminal one.

Note the two directions have different exposure. **Hub → worker commands** (`runTurn`/`interrupt`/…) face
*worker* unavailability, which only happens on a worker crash (rare; §9.2); those `call()`s reject
retryably. **Worker → hub relays** (the tool handlers) face *hub* unavailability, which happens on **every
flip** — that is the case this section governs.

### 8.1 Queue-and-flush (worker-side, survives the gap)

The **worker owns the outbound queue** — it is the survivor; the hub is the reconnecting client (§2). Two
lanes, because events and RPCs have different loss semantics:

- **Event lane** = the `wseqBuffer` (§7.1): bounded, **drop-oldest**, any drop marked with
  `worker/attach-gap`. Losing the tail of a huge transcript stream under a pathological outage is
  acceptable and made visible.
- **Relay lane** = a bounded **pending-relay map** for `approvalRequest` / `rpc(bus|memory|practice)` /
  journal emissions: **never drop-oldest** (each relay has an awaiting caller), bound
  `RELAY_QUEUE_MAX = 1000` (a turn issues a handful of concurrent relays; 1000 spans every session at
  once). Overflow is the only in-turn path to the terminal shape (§8.3).

When no hub channel is attached, a relay call **enqueues and its Promise stays pending**; the turn/query
keeps running in the worker. On the next `attach` (a fresh hub connected), the worker **flushes the whole
relay lane in order** — in-flight *and* newly-queued — to the successor and awaits its replies. Typical
resolve latency is one reconnect cadence, `HUB_RECONNECT_INTERVAL_MS = 1000` (~1s): a tool call "blocks
~1s" across a flip and then returns its **real** result.

### 8.2 Idempotent flush (re-sending is safe)

Flush re-sends messages the dead hub may have partially processed, so every relay is idempotent:

- **journal + `event`** — folded into one wseq'd stream (§7.1). The successor dedups on
  `wseq > lastJournaledWseq(sid)`, so a re-flushed journal append is journaled **exactly once**.
- **`approvalRequest`** — carries a **stable `approvalId`** (`stableApprovalId(sessionId, kind,
  payloadHash)`). The successor's `approvals.request(…, { id })` (the just-built idempotent signature)
  **returns the existing pending Promise** if the id is already pending, or **re-creates** the pending
  entry under the same id on a fresh hub, re-journaling `approval/requested` deduped (§7.2). Re-issue is a
  no-op once resolved.
- **`rpc(memory|bus|practice)` writes** — carry a **stable `callId`**, minted once per logical call and
  **reused** on re-flush. The successor keeps a short-lived served-`callId` → result cache; a re-flushed
  write returns the cached result instead of inserting a second row. So `memory.write` / `practice.write` /
  `bus.send` execute **once** even if the socket dropped between the hub's write and its reply.

### 8.3 The failure taxonomy — transient vs terminal (getting the shape right is the point)

| Class | Trigger | Behavior | Shape the agent sees |
|---|---|---|---|
| **Transient** | socket dropped / mid-flip / hub restarting, and a hub returns within the bound | queue + wait; flush on reconnect; ~1s typical | **the real result** — the tool just succeeds a beat late |
| **Terminal** | no hub reconnects within `HUB_RELAY_TIMEOUT_MS = 45000` (worker orphaned), or the relay lane overflows `RELAY_QUEUE_MAX` | resolve the awaiting call by throwing `HubUnavailableError` | **`textResult(HUB_UNAVAILABLE_TEXT)`** — *"briefly unavailable, nothing was lost, retry in a moment"* — **retryable, never permanent** |

`HUB_RELAY_TIMEOUT_MS = 45000` is chosen to **cover both a restart and a rollback**: green boot is budgeted
15s (`hubctl.ts:188`) + health-check + the port hand-off, and a *failed* green rolls back to blue which
re-listens (`restartController.ts:113-121`). 45s comfortably spans the worst planned case plus a
crash+respawn, with margin. It is deliberately **decoupled from** the approval **decision** timeout
(`APPROVAL_TIMEOUT_MS = 600000`, `approvals.ts:5`): the 45s bound governs *reaching a hub*; the 10-min
timer governs the *operator deciding* once reached. An `approvalRequest` that takes 3s to reach the
successor then still waits up to 10 min for the human — the two never conflict.

**The critical rule, enforced in one place.** The worker's `AgentServices` proxies **never** collapse
unavailability into a success-shaped falsy value. In particular `requireApproval` must **not** return
`false` on a gap (that reads as *"operator denied"* — a terminal shape); past the bound it **throws
`HubUnavailableError`**. `agentWorker.ts` wraps every tool body from `buildAgentMcpServer` in a tiny
`withRetryableHubErrors(fn)` that catches `HubUnavailableError` and returns `textResult(HUB_UNAVAILABLE_TEXT)`,
so the retryable shape is produced **uniformly for every tool** and no handler special-cases it. This is the
only change to the `agentTools.ts` handlers' effective behavior, applied as a build-time wrapper in the
worker — the handler bodies themselves are unchanged.

### 8.4 Refinements that shrink the window toward zero

- **Drain pre-signal (zero *failed* in-flight).** `RestartController.drain()` (`restartController.ts:41-55`)
  runs on blue *before* it closes anything. Add a first step: `executor.signalDraining?.()` →
  `WorkerClient` sends `{ t: 'draining' }` (a new `HubToWorker` push, §1.2). The worker marks its channel
  draining and **proactively holds** new relays (queues them without attempting a send on the about-to-die
  socket) and stops expecting replies on it — so there are **zero failed in-flight sends**, not merely
  recovered ones. Green's `attach` clears the hold and flushes. This turns the ordinary planned flip into a
  pure queue-then-flush that touches no error path at all.
- **Prefer a turn-boundary flip.** A restart while a session is mid-turn is *survivable* (the whole design),
  but a flip that lands between turns touches no live relay. So on a restart request (`requestRestart`, the
  `/api/restart` route, or the `restart_hub` tool) the hub checks `executor.isBusy(*)` across the roster: if
  **all idle**, signal hubctl immediately; if any **busy**, defer the signal to the next `turnCompleted`,
  bounded by a max-defer (≈ one turn / ~2 min) after which it flips anyway (the turn survives regardless).
  This is an **optimization, not a correctness gate** — it makes the *ordinary* restart seamless and
  reserves the mid-turn re-attach path (§6) for genuine crashes and impatient restarts.

---

## 9. Hardest parts, failure modes, and the build order

### 9.1 Ranked hardest problems

1. **Gap-free, exactly-once re-attach replay (the riskiest — see below).** The `wseq` durable cursor +
   dedup (§7.1). An off-by-one duplicates or drops transcript events for a live turn across the exact seam
   the feature exists to protect, and it is only exercised in the rare hub-restart-during-active-turn
   window — the least-covered path with the highest blast radius (a visibly corrupted transcript).
2. **Approval reconciliation (§7.2).** Meatiest *correctness* item after replay; the idempotent-id
   foundation is what makes it a bounded change rather than a redesign.
3. **Relocating the codex app-server child + the MCP handlers with zero behavior change.** The handlers now
   do async RPC round-trips mid-turn; a hub that is *mid-restart* makes those RPCs block. This is the
   operator's key concern and is fully specced in **§8**: the worker holds the relays and flushes them to
   the successor (queue-and-wait, ~1s typical), the flush is idempotent (wseq / stable ids), and only past
   `HUB_RELAY_TIMEOUT_MS` (45s) does a call resolve — as a **retryable** `HUB_UNAVAILABLE_TEXT`, never a
   permanent shape. The SDK already tolerates long tool calls (approvals block up to 10 min), so the ~1s
   pause is invisible to the turn.
4. **The single-connection worker during a flip overlap (§2.3).** Green connects while blue is retiring;
   the `attachEpoch` guard ensures the worker addresses the successor and a late blue frame can't clobber
   green's channel.
5. **Two-writer discipline preserved.** The worker never opens the DB, so all store/journal writes stay
   single-owner on the hub — but that means a burst of worker events during a long turn is a burst of hub
   `INSERT`s; the existing `busy_timeout=5000` + the sub-second flip window keep this safe (the worker's
   buffer absorbs the flip gap, so writes don't pile up on a dead hub).

### 9.2 Failure modes — worker crash vs hub crash

| Event | What happens | Recovery | Net severity |
|---|---|---|---|
| **Hub crash / planned restart** (the target case) | worker keeps running the turn + sub-agents; events **and tool relays** buffer worker-side during the gap (§8) | fresh hub boots, `WorkerClient` reconnects, `attachWorker()` → `listLive` + `attach(since)` replays the gap + flushes queued relays; pane watches the turn finish | **None** — the Phase-2 win. A mid-flip tool call pauses ~1s, then succeeds. |
| **Worker crash** (the new hazard) | the live turn + its driver/child die (they were in the worker) | hubctl respawns the worker; hubs reconnect; `listLive()` is empty → every `active` session marked stale → **lazy vendor resume on next send** (Claude `--resume` / codex `thread/resume`, on-disk transcript survives) | **Degrades to Phase-1** — the turn is lost, the *conversation* resumes. No worse than today; the worker is near-immutable so this is rare. |
| **Both crash** | same as worker crash | same | Phase-1 semantics. |
| **Worker up but unreachable** (wedged pipe) | hub's reconnect loop spins; turns can't be driven | bounded budget → optional `worker-unreachable` signal → hubctl kills+respawns the worker (§5.2) | Degrades to worker-crash after the budget. |
| **`wseqBuffer` overflow** (hub gone too long) | ring wraps, some gap events dropped | worker emits `worker/attach-gap`; hub journals the marker; transcript shows an explicit gap rather than silently losing events | Visible, bounded, honest. |
| **Approval in flight at restart** | pending Promise lost on the dead hub | worker re-issues on re-attach with the stable id; operator resolves on the new hub (§7.2) | **None** — re-offered, resolved exactly once. |

The honest limit is unchanged from the design (`self-hosting-restart-survival.md` "The honest limit"):
you cannot atomically replace a process mid-tool-call. Phase 2 moves that irreducible seam onto the
**worker** — which is near-immutable and rarely restarts — instead of the hub, which is edited constantly.

### 9.3 Incremental, testable build order (the hub works at every step)

Each step is independently shippable; the flag is **off by default** through step 3, and off-flag behavior
is byte-for-byte today's.

1. **Pure refactor — extract `Executor` + `InProcessExecutor`.** Move today's driver/turn bodies behind
   the interface; `SessionManager` delegates. **No worker, no flag, no behavior change.** Gate on:
   `pnpm --filter hub typecheck` + the existing `*.test.ts` suite green. *Hub identical.*
2. **`workerProtocol.ts` (types) + `workerTransport.ts` (codec + client/server).** No hub wiring. Unit-test
   the frame codec (partial reads, oversize, non-JSON), the reconnect loop, and reqId correlation in
   isolation (a `WorkerServer` echo harness). *Hub untouched.*
3. **`agentWorker.ts` + `WorkerExecutor` + hubctl spawns the worker.** Feature flag lit by
   `HUB_WORKER_SOCKET`. Event stream → `ingestWorkerEvent`; lifecycle → status. **Flag off = today; flag on
   = turns run in the worker** (but no re-attach yet — a hub restart still loses the turn, i.e. Phase-1
   parity). Ship. Test a full spawn→turn→idle cycle with the flag on, both providers.
4. **Move the MCP handlers + `AgentServices` relays into the worker.** `dangerUpdate` push;
   `approvalRequest`/`rpc`/`journal` relays; worker-local `isBusTurn`. Test `practice_write` approve **and**
   deny across the socket, `memory_write`/`search`, `send_message` between two worker sessions, and the
   bus-turn hard-deny — the existing gate tests (`restartGate.test.ts`, `practices.test.ts`) constrain the
   pure decisions; new tests assert the round-trips.
5. **`attachWorker()` re-attach + `wseqBuffer` + the journal `wseq` cursor.** Now a mid-turn survives a hub
   restart. Test the blue-green flip **with a live turn**: start a long turn, trigger `restart_hub`/`POST
   /api/restart`, assert the successor hub re-attaches and the same turn's `turnCompleted` is journaled once
   and reaches a reconnected WS client.
6. **Approval reconciliation + gap handling.** Idempotent re-issue on reconnect; `worker/attach-gap` on
   overflow. Test: (a) hub restart while a `practice/write` approval is pending → operator resolves on the
   successor → handler completes once; (b) force a buffer overflow → assert the `worker/attach-gap` marker
   and no duplicate/silent-loss.
7. **Transient-gap handling (§8) — the operator's key concern.** The two-lane worker queue + bounds
   (`RELAY_QUEUE_MAX`, `HUB_RELAY_TIMEOUT_MS`), the `{ t:'draining' }` pre-signal from `RestartController.drain`,
   the stable-`callId` write dedup, and the `withRetryableHubErrors` wrapper. Test: (a) `memory_write`
   issued **during** a flip → the call pauses ~1s and returns the real id **once** (no double row); (b) a
   flip with the drain pre-signal → **zero** failed in-flight sends; (c) simulate a >45s orphan → the tool
   returns `HUB_UNAVAILABLE_TEXT` (retryable), asserted to **not** be a denied/disabled shape; (d) a
   mid-turn restart request defers to the turn boundary when busy, flips immediately when idle.

---

## 10. File-by-file change summary

**New files**

| File | Purpose |
|---|---|
| `apps/hub/src/workerProtocol.ts` | Typed hub↔worker messages (commands / event stream / relays; incl. the `{t:'draining'}` push) + `WorkerSessionSpec` + id helpers + the transient-gap constants & shapes (`HUB_RELAY_TIMEOUT_MS=45000`, `RELAY_QUEUE_MAX=1000`, `HUB_RECONNECT_INTERVAL_MS=1000`, `HubUnavailableError`, `HUB_UNAVAILABLE_TEXT`). The single shape contract (the worker's `restartHandshake.ts`). |
| `apps/hub/src/workerTransport.ts` | Length-prefixed frame codec (reused from `meshSite.ts:88-115`) + `WorkerServer` (worker; two-lane queue: wseqBuffer events + bounded pending-relay map, draining-hold) + auto-reconnecting `WorkerClient` (hub; `signalDraining`) over `HUB_WORKER_SOCKET`. |
| `apps/hub/src/agentWorker.ts` | The long-lived executor: `ClaudeDriver`s + `CodexClient`(+app-server child) + the driver-half turn loops + `buildAgentMcpServer` (each tool wrapped in `withRetryableHubErrors`) with RPC-proxy `AgentServices` + the `wseqBuffer`. hubctl-spawned sibling. |
| `apps/hub/src/wseqBuffer.ts` | *(parallel foundation)* per-session monotonic `wseq` + bounded replay ring; `append`/`since`. Lives in the worker. |

**Edits**

| File | Change |
|---|---|
| `apps/hub/src/sessions.ts` | Extract the `Executor` seam; `create`/`send`/`steer`/`interrupt`/`stop`/`delete`/`readCodexLimits`/`deliverBus` call `this.executor.*`; `withRecall`/`setStatus`/`autoTitle`/bus stay hub-side; add `attachWorker()` (runs between `loadRecords()` and `reconcileStale()`, driven by the client's `'attached'`); `shutdown` stops killing vendor children in worker mode; `requestRestart` defers to a turn boundary when any session `isBusy` (§8.4); add `ingestWorkerEvent`/`applyLifecycle`/`runRelay`/`lastJournaledWseq`. |
| `apps/hub/src/index.ts` | Choose `InProcessExecutor` vs `WorkerExecutor` by `HUB_WORKER_SOCKET` presence; pass it into `SessionManager`; call `executor.pushDanger` from the danger-config path. Unsupervised/flag-off is unchanged. |
| `apps/hub/src/hubctl.ts` | `defaultWorkerSocket()`; `spawnWorker()` (+ respawn-on-exit); pass `HUB_WORKER_SOCKET` into every `spawnHub` env; `boot()` spawns the worker before blue. Flip logic untouched. |
| `apps/hub/src/approvals.ts` | *(parallel foundation)* `request` accepts a caller-supplied stable `id`; `request`/`resolve` idempotent on a known id (re-issue-safe). |
| `apps/hub/src/journal.ts` | Additive nullable `wseq` column on `events`; `appendWorker(sessionId, kind, payload, wseq)`; the `MAX(wseq)` cursor query behind `lastJournaledWseq`. |
| `apps/hub/src/server.ts` | On `POST /api/config/danger`, also `executor.pushDanger(danger)` (no-op in-process). No route changes. |
| `apps/hub/src/restartController.ts` | `drain()` first calls `executor.signalDraining?.()` so the worker holds relays before blue's socket drops — zero failed in-flight (§8.4). No-op in-process. |
| `apps/hub/src/agentTools.ts` | **Handler bodies unchanged.** In worker mode `agentWorker.ts` wraps each tool in `withRetryableHubErrors` at build time (§8.3), so a mid-flip gap returns the retryable `HUB_UNAVAILABLE_TEXT`. When `restart_hub` lands, its `requestRestart` is the same `AgentServices` member, relayed worker→hub. |
| `scripts/bundle-hub.mjs` | Add a `must(dist/agentWorker.js)` assertion (the whole `dist/` already ships). |

**No web changes.** Additive event kinds (`worker/attach-gap`) hit the client's `default: break`; the WS
replay contract is served by the unchanged journal, so reconnected panes see the surviving turn finish
with zero front-end work.

---

## 11. Open questions / spikes

- **Windows named-pipe reconnect semantics** — confirm a fresh hub `net.connect`s cleanly to a
  `\\.\pipe\allmyagents-worker` the worker created before the previous hub died, and that replacing the
  server-side connection object doesn't drop the pipe (expected: the pipe is the *server's*; each client
  connection is independent — spike the blue→green handoff locally).
- **`wseqBuffer` sizing** — pick the ring bound so a realistic worst-case hub restart (blue-green flip:
  sub-second; a crash+respawn: a few seconds) never overflows during a normal turn's event rate; only a
  pathological multi-minute hub outage should trip `worker/attach-gap`.
- **Relay timeout tuning** — the soft-error timeout on `bus.*`/`memory.*`/`practices.*` relays must exceed
  a flip window (so a tool call that spans a restart resolves against the successor) but stay well under
  the SDK's patience — and never below the 10-min approval timeout for the `approvalRequest` path.
- **`journal.ts` `wseq` column migration** — additive `ALTER TABLE`; confirm it composes with the Phase-3
  `schema_version` guard (`restartHandshake.ts:15`) so an older hub rolled back onto a `wseq`-bearing DB
  still boots (nullable column → old code ignores it).
- **Codex `thread/resume` after a *worker* crash mid-turn** — the one path that still kills a turn; confirm
  the resumed thread continues cleanly (idle resume is exercised by import; mid-turn-kill + resume is the
  new case, shared with the Phase-1 spike in `agent-detachment-impl.md` §7).

## 12. Acceptance — PROVEN ✅

The headline claim ("a live agent turn survives a hub restart") is proven **end-to-end and full-stack** —
a real `hubctl` blue-green flip with a real Claude turn running in a real supervised worker, not a unit
simulation. Reproduce with:

```
pnpm accept:restart            # scripts/acceptance-restart-survival.mjs
```

It launches an **isolated** worker-mode `hubctl` (its own temp `HUB_DATA_DIR` + `HUB_FIXED_PORT=7799`, so it
never touches a live hub on 7777), starts a ~1000-word Claude turn, then POSTs `/api/restart` **while the
turn is in flight**. A shrunk `HUB_RESTART_MAX_DEFER_MS=3000` forces the flip squarely mid-turn (the real
production path when a restart can't wait for a turn boundary). It then asserts survival from the journal —
all eight checks must pass:

| Check | Meaning |
| --- | --- |
| `twoHubEras` | two `hub/started` rows — blue and green both booted |
| `pidChanged` | the live `/api/health` pid changed (a real process restart, not a no-op) |
| `liveAtFlip` | the session was `active` at the moment the pid flipped |
| `turnStraddledFlip` | the SAME turn's events span the flip — blue journaled the start, green the rest |
| `sentinelPresent` | the end-of-turn sentinel reached the journal (full output, not truncated) |
| `sentinelAfterGreenBoot` | the sentinel was journaled AFTER green booted — the turn's *end* landed on the successor |
| `completedCleanly` | final status `idle` (a clean `turnCompleted`, not `error`) |
| `resultOnGreen` | `claude/result` journaled by green |

**Result:** two independent PASS runs — pid `5260→42468` and `42300→12864`; 10 blue-side + 6 green-side
session events each; all eight green. The turn ran to completion on the successor hub with its full output
intact, having started on the predecessor. Flag-off (in-process) remains byte-identical (195 hub tests).

### Testing it on the desktop app

The harness above IS the real supervisor+worker+hub stack; the desktop app only adds the Tauri UI shell on
top and runs on the fixed port 7777 against the real data dir. `desktop/src-tauri/src/lib.rs` spawns hubctl
via `pnpm hubctl:dev` (dev) / bundled `dist/hubctl.js` (release), and Rust's `Command` inherits the parent
environment — so worker mode is enabled by launching the app with **`HUB_WORKER=1`** set (no code change).
To watch survival live in the app:

1. Launch the desktop app with `HUB_WORKER=1` in its environment (the hubctl it spawns picks it up; the log
   line `spawning agent worker` confirms worker mode).
2. Start a long turn in any chat (ask for a long essay, or a task with several tool steps).
3. While it's streaming, trigger a restart (Settings → restart, or `POST /api/restart`).
4. The chat keeps streaming across the ~sub-second flip and finishes normally — the turn survived.

Flipping `HUB_WORKER` **on by default** in the desktop spawn is the alpha step (it ships ON for alpha per
`docs/alpha-release-plan.md`); until then it's opt-in via the env so flag-off stays the safe, proven default.
