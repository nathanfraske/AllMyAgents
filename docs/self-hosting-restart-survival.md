# Self-hosting & restart survival — letting AllMyAgents safely repair itself while in use

Design plan, drafted 2026-07-24. Goal: make it safe to develop AllMyAgents **from inside AllMyAgents** —
an agent (or the operator) can edit the hub's own code, restart it, and migrate its schema **without
killing the session doing the work or the sessions the operator is using.**

## The paradox this solves

> "I want to use it, but if I use it and run into issues I have to wait for the fix, which makes me not
> want to use it, which makes me not run into issues from using it in the first place." — the operator

Dogfooding is how the product gets good, but a self-hosted tool that goes dark every time it's repaired
punishes the exact usage that surfaces its bugs. The deadlock only breaks if the hub can be **fixed while
live** — restarted, hot-patched, and migrated underneath running sessions that survive the seam. This doc
is the architecture for that.

Grounded in the code as it exists today:

- **`apps/hub/src/sessions.ts`** — the hub process **owns agent execution in-process**: Claude runs via the
  Agent SDK `query()` with an in-process MCP server; Codex runs in a `codex app-server` child the hub spawns
  (`codexClientFor`). So killing the hub kills the agent. `boot()` restores every persisted session on start;
  `shutdown()` tears down vendor children.
- **`apps/hub/src/journal.ts` + `store.js`** — append-only SQLite journal + a persisted `SessionStore`
  snapshot. **This is the durable state that already outlives any process.**
- **`apps/web/src/lib/store.svelte.ts`** — the client **already auto-reconnects** (`ws.onclose → reconnect()`
  every 1.5s) and **replays from `lastSeq`**, so a dropped hub is a transient blip, not a data loss.
- **`apps/hub/src/workspace.ts`** — worktree isolation already exists (per-session worktrees under
  `data/worktrees`), the sandbox primitive for editing safely.
- **Vendor resume** — imported/persisted sessions resume the real vendor transcript (`thread/resume`,
  Claude `--resume`), so the *conversation* continues across restarts.

We are ~70% there. What's missing is (1) decoupling agent **lifetime** from the hub process and (2) a
**graceful, brokered restart** instead of `taskkill`.

---

## TL;DR

Move the agent **off the thing being restarted**, then let durable state + auto-reconnect hide the seam —
the way a `tmux` session survives its client, or a Kubernetes pod survives the API server bouncing. Concretely:

1. **Split control plane from workers.** A tiny near-immutable **supervisor** (`hubctl`) owns process lifetime.
   The hub becomes a restartable API/control layer; agent workers are separate processes it supervises, so a
   hub bounce doesn't kill them.
2. **Restart broker, not `taskkill`.** An agent calls a `restart_hub` tool → the supervisor does a **blue-green**
   swap (spawn successor, health-check, hand off, retire predecessor). Clients reconnect + replay.
3. **Additive-only migrations while live** — expand → migrate → contract. Event-sourcing makes this natural.
4. **Hot-reload the non-structural 90%** so most edits never need a restart at all.
5. **Turn-boundary handoff** — structural changes happen between turns; the agent is re-invoked to continue,
   with the journal as its memory across the gap (like context compaction).

The one hard limit: there is always **a seam** (a turn/checkpoint boundary). You cannot `exec`-replace a process
mid-tool-call with zero coordination. The goal is to make the seam as cheap as a page reload, not to abolish it.

---

## 1. Control plane vs. workers (the key move)

Today: `hub process = HTTP/WS + journal + agent execution`, all one lifetime. Editing or restarting the hub
kills the agents.

Target: three tiers with independent lifetimes.

```
hubctl (supervisor)         # tiny, ~never changes; owns process lifetime + restarts
  ├── hub (control plane)   # HTTP/WS/journal API; RESTARTABLE, blue-green
  └── worker(s)             # agent execution (Agent SDK query / codex app-server), LONG-LIVED
```

- Workers connect to the hub over a stable local socket/IPC rather than living *inside* it. When the hub
  restarts, a worker's control connection drops and re-attaches to the successor — the vendor process and its
  in-flight reasoning keep running.
- This is the systemd/kubelet pattern: the supervisor is the stable thing; everything above it is replaceable.
- Migration path: extract `codexClientFor` / the Claude `query()` runner behind an IPC boundary so the executor
  is a child of `hubctl`, adoptable by a fresh hub via the journal (`boot()` already rebuilds session state; it
  needs to also *re-attach* to a still-running worker instead of assuming it must respawn).

## 2. The restart broker + blue-green

An agent **never** nukes its own host. It requests a restart; the supervisor performs it gracefully.

```
agent → restart_hub tool → hubctl:
  1. spawn hub' (green) on an ephemeral port, same data/ (journal + store)
  2. health-check hub' (boot() complete, /api/auth 200, sessions restored == expected)
  3. flip: point the fixed public port / reverse-attach workers to hub'
  4. drain + retire hub (blue): finish in-flight HTTP, close WS (clients already auto-reconnect)
  5. journal a hub/restarted event so the transcript shows the seam explicitly
```

- Clients (operator's browser panes) experience the existing 1.5s reconnect + replay — no code change needed on
  the web side.
- Shared `data/` means no state handoff for the journal/store; the only handoff is the **worker attachment**
  (§1) and the **listening port**.
- Failure is safe: if `hub'` fails its health-check, `hubctl` keeps blue and reports the error — you never lose
  the running hub to a bad edit. This is the property that makes editing-while-live non-scary.

## 3. Migrations that don't break a live session

The scary case is changing `SessionRecord`, the event schema, or the WS protocol while sessions are live.
Event-sourcing + a discipline makes it safe:

- **Append-only journal**: new event *kinds* are additive; replayers hit unknown kinds via a `default: ignore`
  case (audit the web `apply()` switch to guarantee this — an unknown kind must never throw).
- **Optional fields only** on `SessionRecord` for online changes; never rename/drop in one step.
- **Expand → migrate → contract**: ship the reader that tolerates both shapes, backfill, *then* remove the old
  shape in a later release when no live session depends on it.
- A **migration runner** in `hubctl` runs before booting `hub'` (green), so a schema bump is part of the
  blue-green, not a separate manual step. Version the store with a `schema_version` row; refuse to boot a hub
  older than the on-disk schema (prevents a rolled-back hub corrupting a migrated journal — see the
  default-home resume spike caveat).

## 4. Hot-reload for the non-structural 90%

Most edits — a handler tweak, the import parser fix, a gating rule — are pure logic and don't need a restart.

- Run the hub under `tsx watch` (or a small module-reload shim) so those apply live. **Caveat, learned the hard
  way** (see [[reference-codex-rollout-dedup]] and the vite HMR corruption this session): hot-reloading
  *stateful singletons* desyncs them. Restrict hot-reload to **stateless handlers/pure functions**; anything
  holding live state (SessionManager, Journal, the WS registry) goes through the §2 restart instead.

## 5. Turn-boundary handoff

The seam is invisible if it lands between turns:

- A structural `restart_hub` is deferred to the current turn's completion (or run immediately if the agent is
  idle). The supervisor restarts; the agent's session is re-invoked with a "continue" prompt and the journal as
  durable memory — the same shape as this CLI's context-compaction handoff.
- For the *operator's* own sessions, no action needed: they're idle between messages and just reconnect.

---

## Phasing (each phase is independently useful)

- **Phase 0 (today):** coding agent runs **standalone/outside** the hub (as in this session); a `restart_hub`
  tool that shells a graceful restart from outside. Zero self-kill risk; unblocks live iteration immediately.
- **Phase 1:** `hubctl` supervisor owns hub lifetime + does blue-green restart with health-check + rollback.
  Operator sessions already survive it via reconnect.
- **Phase 2:** move agent execution to supervised workers (§1) so *agent* sessions survive a hub restart, not
  just operator browser panes.
- **Phase 3:** online additive migrations wired into the blue-green; `schema_version` guard.

## Danger-zone integration

Per the project's permissive philosophy ([[feedback-permissive-danger-zone]]), `restart_hub` /
`self_migrate` are **operator-gated by default** with Settings toggles to auto-approve for a fully autonomous
self-hosting loop. Never an un-disable-able block; safe default is "ask."

## The honest limit

You cannot atomically replace a process mid-tool-call. There is always a checkpoint. Everything above is about
making that checkpoint **cheap, safe, and reconnect-hidden** — a page-reload-sized blip backed by durable
state — not about pretending the seam doesn't exist.
