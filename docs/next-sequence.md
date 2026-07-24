# Phase 2 — the next build sequence for AllMyAgents

Design scope, drafted 2026-07-24. **Scoping only — no code changed.** This doc picks and orders the
**next** builds *after* the four foundational features now in flight, and says which of them need their
own deep-scoping doc before they can be built. It cross-references the existing scoping set
(`docs/memory-system.md`, `docs/inter-agent-comms.md`, `docs/agent-visualization.md`,
`docs/project-import.md`, `docs/vendor-remote-control.md`, `docs/audit-findings.md`) and **DESIGN.md**
(D1–D14, §10 backlog, §12 queue) rather than repeating them.

---

## 0. Where we are — the starting line for phase 2

**Built and verified (P1 + polish):** the hub daemon (event-sourced SQLite journal with **gap-free
paged replay** — audit H1 fixed; `SessionManager` create/send/steer/interrupt/stop/delete; Claude SDK +
Codex app-server adapters; `ApprovalService`; `UsageMonitor` with Claude `rate_limit_event` + Codex
`account/rateLimits/read` polling + overage guard; `WorkspaceManager` worktrees; `ProjectStore`;
`meshSite` register/deregister/toggle; profile scan + one-click login launcher; **global kill-switch on
shutdown** — audit M1 fixed; Codex mid-turn crash recovery — audit M2 fixed). The Svelte UI (event-replay
store, split-pane grid, resizable sidebar, ThreadView/ItemCard, Dashboard, Usage gauges, ContextMeter,
inline `DiffView`, settings/model/traits pickers). The **account "port"** (D14 v1 interactive handoff).

**The four foundational features now in flight** (phase 2 begins where these land):

| # | Feature | What it establishes that phase 2 builds on |
|---|---|---|
| 1 | **Mesh device token** | `deviceToken.ts` + `SecurityConfig.requireToken` exist; **enforcement on `/api` + `/ws` is not yet wired**. Closes audit C1/H2/H3 → makes mesh/phone exposure *safe*. |
| 2 | **Operator profile + scoped instruction layer** | The **materialization pipeline** — the owner/global tier of `memory-system.md` written into `CLAUDE.md`/`AGENTS.md` at spawn. Every later injected context (memory, commons digest, bus contract) rides this path. |
| 3 | **Inter-agent comms bus (first slice)** | `inter-agent-comms.md` P2.0: `BusRouter`, the **per-session capability token + MCP-server-per-session root**, sentinel frame + permission clamp, `send_message` (direct/channel), intra-project allow / cross-project deny. |
| 4 | **Agent-visualization (first slice)** | `agent-visualization.md` Slice 1: lineage/message fields, `bus/message` + `session/spawned` + `subagent/*` events, inline-expandable subagent lanes. Transcript-level multi-agent legibility. |

So at the phase-2 start line we have: **auth**, **instruction materialization**, a **capability-token +
MCP root with 1:1 messaging**, and **transcript-level lineage** — but no orchestration/scope model, no
shared spaces (memory beyond the operator tier, no commons), no continuity engine, no fleet hooks, and no
reach beyond the one host that the device token just made safe to expose. **Phase 2 is: complete the
orchestrated fleet, give it shared memory and a shared space, make it self-sustaining under quota, and
cash in the device token for remote + cross-node reach.** This is the completion of DESIGN's **P2**, then
the first reach into **P3**.

Still-open hygiene the sequence accounts for (audit): **M6** redaction is best-effort (retrofit-hostile —
matters *before* memory/commons/bus persist agent content at volume); **M3** Codex `create()` zombie,
**M4** 8-char worktree-id collisions, **M5** advisory-only write confinement; **L7** hub deps float on
`latest` against a protocol that already broke once.

---

## 1. The dependency spine

One linchpin, two shared-space layers on top of it, a capstone, and two parallel reach/UX tracks.

```
   [foundational 4: token · materialization · bus root · lineage]
                              │
        ┌─────────────────────┴───────── retrofit-hostile hardening (P2-pre) ─────────┐
        │                     (M6 redaction · pin deps L7 · session-stamped commits)   │
        ▼                                                                              │
  ① ORCHESTRATION MCP + scopes/ACL + brains  ◄── the spine everything below consumes   │
        │        (spawn_agent · task board · budgets · orchestrator hot-swap)          │
        ├──────────────┬───────────────┬──────────────────────────────┐               │
        ▼              ▼               ▼                              ▼               │
  ② COMMONS (D10)   ⑤ FLEET HOOKS   viz Slice 2/3                Attention inbox        │
        │              (D8)          (Run view, fleet)          (bus + ask_user)        │
        ▼              │                                                                │
  ③ MEMORY full (D9)   │                                                                │
        │              │                                                                │
        ▼              ▼                                                                │
  ④ WORKTREE LEASE ─► ⑥ CONTINUITY ENGINE (D14) + budget-aware spawning  ◄── capstone   │
     (+M4/M5)                                                                           │
                                                                                        │
  ── parallel tracks (depend only on the device token / git, not on ①) ────────────────┘
  ⑦ MESH-NATIVE MOBILE UI   ⑧ DIFF/FILE VIEWER + PR/merge-gate      →  ⑨ CROSS-NODE WORKER (P3)
```

**Why ① is the linchpin:** the foundational bus slice deliberately shipped only a *minimal* ACL
(project-membership: intra allow / cross deny). The **full hub-owned scope/ACL store** (D12) and the
**orchestration toolset** (D5: `spawn_agent`, `list_agents`, `agent_status`, `ask_user`,
`create_task/claim/complete`) are what memory's write-clamp, commons grants, the bus's cross-project /
orchestrator reach, the fleet-hook `spawn-agent`/`create-task` actions, the Run view's spawn tree, and
the continuity engine's budget-aware spawning **all** consume. Nothing substantial in phase 2 is reachable
without it.

---

## 2. The recommended sequence at a glance

| # | Build | Effort | Own doc? | Gated by |
|---|---|---|---|---|
| **0** | **Retrofit-hostile hardening** (M6 redaction, pin deps L7, session-stamped commits, M3) | S | No | — (do first, cheap) |
| **1** | **Orchestration MCP server + scope/ACL model + brains hot-swap** (D5+D12) | L | **Yes** | foundational bus root |
| **2** | **Project Commons** (D10: feed/pins/artifacts/status board) | M–L | **Yes** | ① |
| **3** | **Memory system — full** (D9 project/account/vendor tiers + MCP tools + Tier-0 capture) | M–L | No (memory-system.md) | ①, ② |
| **4** | **Worktree ownership lease** (+ M4 collision fix, M5 confinement) | S–M | No (audit + open Qs) | — (before ⑥) |
| **5** | **Fleet hooks engine** (D8) | M | Section, not full doc | ①, bus |
| **6** | **Continuity engine + budget-aware spawning** (D14 full) | L | **Yes** | ①②③④⑤ |
| **7** | **Mesh-native mobile / responsive UI** (parallel) | M | No | device token |
| **8** | **Full diff/file viewer + PR/branch + merge gate** (parallel) | L | **Yes** (merge-gate/review half) | worktrees (built) |
| **9** | **Cross-node remote worker — WSL + remote node runner** (P3) | XL | **Yes** | ①④, device token, mesh site |

Items **7** and **8** run in parallel with **1–6** (frontend / git, independent of the orchestration
spine). **9** is the largest build and lands last / opens P3.

---

## 3. Per-item detail

### 0. Retrofit-hostile hardening (pre-flight)
**Scope.** A one-pass hygiene chore before the shared-space layers start persisting agent content at
volume: harden `redact.ts` with entropy-based scrubbing + vendor refresh-token shapes + cross-whitespace
keyword proximity (**audit M6** — DESIGN itself calls this "nearly impossible to retrofit"); pin
`@anthropic-ai/claude-agent-sdk` / `@openai/codex` / `@anthropic-ai/claude-code` to exact versions +
add the app-server conformance smoke test DESIGN §5 prescribes (**audit L7**); enforce session/profile
**commit trailers** so `git blame` deep-links to the transcript turn (**DESIGN §10 / P1 "session-stamped
commits"** — trivial now, priceless forensics forever); wrap the Codex `create()` startup in try/catch
(**audit M3** zombie `starting` session). Optionally batch the cheap Lows (L1 Codex turn-concurrency
guard, L2 token-usage reader unification, L8 `events.kind` index, L9 body-size cap).
**Placement/deps.** First, and cheap. M6 in particular must precede ②/③ — the bus, commons, and memory
all flow agent text through `redact()` at the single `append()` choke point; a gap there becomes a fleet
-wide disclosure surface the moment 20 agents are posting. None of it blocks on the foundational four.
**Effort:** S. **Own doc:** No — `audit-findings.md` already specifies each item.

### 1. Orchestration MCP server + scope/ACL model + brains hot-swap (D5 + D12)
**Scope.** Extend the foundational bus's capability-token/MCP-server root into the full **orchestration
MCP server**: `list_agents`, `agent_status`, `read_output` (paginated), `spawn_agent(profile, node,
project, prompt, policy)`, `interrupt`, `stop`, `create_task/claim/complete` (the **task board**),
`ask_user`, `hook_register/list/remove` (surface for ⑤). Add the **hub-owned scope/ACL store** (D12:
`view/input/approve/spawn/orchestrator/cross-project/node:<name>/profile:<id>`), **per-profile budgets**
(tokens/day, concurrent sessions, spawn-depth ≤ 2), the **approval-router integration** for scoped
grants, and the append-only **audit** of every spawn/grant/scope change. The **brains** is whichever
session holds the `orchestrator` scope — hot-swappable, **cannot self-elevate**, and guarded by a
**single-holder fencing token** on every orchestration call (closes the §10 "split-brain brains" race)
plus the **confused-deputy rule** (spawn checks the *requester's* scopes, not just the spawner's).
Lineage fields (`parentSessionId`, `runId`, `role`, `spawnToolUseId`) + `session/spawned` are already
defined by the foundational viz slice; `spawn_agent` is what emits them.
**Placement/deps.** First real build of phase 2 — it is the spine of ②③⑤⑥ and the viz Run view, and the
bus's cross-project/orchestrator reach (comms doc §5.2) and memory's write-clamp (memory doc §6) both
read this scope store. Builds directly on the foundational capability-token root.
**Effort:** L. **Own doc:** **Yes.** The scope/ACL model, budget enforcement, brains single-holder
invariant, and confused-deputy/persuasion-escalation defenses are only *sketched* across D5/D12 and
referenced (not defined) by the memory and comms docs. This is the security spine of the whole fleet and
carries live §10 open questions (split-brain fencing, confused-deputy spawn checks, ACL-escalation UI
that renders the exact scope diff) — it needs one consolidated `docs/orchestration.md` before code.

### 2. Project Commons (D10)
**Scope.** The shared space that survives divergent worktrees, as four typed surfaces (not one blob):
**feed** (append-only typed posts `finding|decision|blocker|handoff|question|status` — append-only ⇒ no
write conflicts, natural audit); **pins** (durable promotions that **bridge into the D9 memory layer** as
project-scope memories — the memory doc's §1 graduation path); **artifacts** (a real shared dir per
project outside all worktrees, `commons_put/get/list`); **status board** (derived, read-only: task claims
+ latest per-session summaries, so "what is everyone doing?" is a query, not N transcripts). MCP tools
`commons_*` gated by ①'s ACLs; spawn-time digest injection via the foundational materialization path
(with the data-not-instructions framing from the comms/memory docs); a Commons UI surface.
**Placement/deps.** Right after ①, and slightly before / concurrent with ③: it is the substrate the
memory Tier-0 capture path (decision/handoff posts + pins → memories), the continuity **handoff brief**
(a `type:handoff` Commons post, D14), the status board (brains situational awareness — protects its
context window), and the fleet digest all build on. Needs ①'s MCP tooling + grants.
**Effort:** M–L. **Own doc:** **Yes.** memory-system.md, inter-agent-comms.md, and D14 all *reference*
Commons repeatedly but none define its feed/pin/artifact/status **schemas**, the pin→memory bridge
mechanics, cross-node artifact sync, or the compaction cadence. A schema-first `docs/project-commons.md`
is the missing keystone.

### 3. Memory system — full (D9)
**Scope.** Everything in `memory-system.md` beyond the foundational operator/materialization slice: the
`memories` projection + `memory_events` (reuse the journal) + FTS5 mirror; the project/account/vendor
scope **tiers** and the §4.3 applicability union; `memory_write/search/read` MCP tools with the
**capability-token write-clamp**; **Tier-0 deterministic capture** from Commons `decision`/`handoff`
posts and pins (built alongside ②); then **P2.1** quarantine + dedup-fold + provenance-keyed purge + the
Tier-3 session-stop nudge.
**Placement/deps.** After ① (MCP capability-token + scope model → the write-clamp) and ② (Commons →
Tier-0 capture + the pin bridge). The materialization *pipeline* is already foundational; this fills in
the non-owner tiers and the capture/curation loop.
**Effort:** M–L. **Own doc:** **No** — `memory-system.md` already deep-scopes schema, clamp, tiers,
auto-capture, and phasing end-to-end; it is buildable as written (the open questions in its §12 are
product calls, not missing design).

### 4. Worktree ownership lease (+ M4 collision fix, M5 confinement note)
**Scope.** Make worktree ownership an **explicit hub-managed exclusive lease** with an explicit transfer
operation (so a ported/handed-off session *owns* the dir and stopping the source can't delete a worktree
a successor still uses); switch the worktree dir + branch from `sessionId.slice(0,8)` to the full id and
delete branches on stop/delete (**audit M4** — ~50% birthday collision near ~600 lifetime sessions);
document/upgrade `checkWriteScope` from advisory string-match to an OS/cwd-level boundary that also covers
Bash (**audit M5**).
**Placement/deps.** Before ⑥. It is the hard prerequisite for D14 correctness: same-worktree handoff +
auto-resume-on-reset otherwise puts two live sessions in one dir and corrupts state (flagged by the audit,
D14's own v1 limitations, *and* `project-import.md` §7). Independent of ①; can be built any time in the
first half.
**Effort:** S–M. **Own doc:** **No** — audit M4/M5 + the D14/import open questions already specify it;
fold the lease state-machine into ⑥'s doc.

### 5. Fleet hooks engine (D8)
**Scope.** The cross-agent rules engine over the journal: `{selector: event pattern + filters, scope:
project|global, actions: [notify-sessions | notify-user | spawn-agent | create-task], throttle, cascade:
false}`. Guards: **no-cascade by default** (hook-triggered injections tagged, don't re-fire hooks —
reusing the comms doc's `cause.kind`/`rootCauseId` machinery), per-scope rate caps, full audit. Ships the
**watchdog heuristics** it enables (D11 reflex-tool-call flag; §10 stuck-detector: N turns with zero file
edits / error loops / token burn without task progress).
**Placement/deps.** After ①: delivery rides the foundational bus `notify` path, and the `spawn-agent` /
`create-task` actions need ①'s toolset. It is the **trigger surface** the continuity engine (⑥) plugs
into, and the delivery path for memory's Tier-3 nudge.
**Effort:** M. **Own doc:** **Section, not a full doc.** D8 is well-specified in DESIGN and no-cascade is
handled in the comms doc; a short scoping *note* on the selector/pattern language + the watchdog heuristic
thresholds is enough (attach to ①'s doc or a brief `docs/fleet-hooks.md`).

### 6. Continuity engine + budget-aware spawning (D14 full)
**Scope.** The capstone. Per-project/per-session policy `{mode: off|ask|auto, triggers:[status ≥
near-limit | N% window | hard error], targets: ordered profile list, sameVendorFirst?}`. Handoff
protocol: outgoing agent writes a **Commons handoff brief** (or the hub synthesizes it from the journal
tail + task board if the account is hard-dead) → successor **spawns into the same *leased* worktree** →
task claims transfer → origin marked `paused-for-quota` with its `resetsAt` ETA → optional
**auto-resume-on-reset** to review/integrate. Budget-aware `spawn_agent` picks the healthiest eligible
profile from `UsageMonitor`. Folds in the D14-v1 port limitations: worktree-ownership transfer (④), a
summarizer instead of raw-transcript seeding, carrying model/effort/memory scope.
**Placement/deps.** Composes **everything**: `UsageMonitor` (built) + `spawn_agent`/budgets (①) + Commons
handoff (②) + memory handoff materialization (③) + worktree lease (④) + hooks as the trigger surface (⑤).
It is a flagship user priority and DESIGN's P2 exit criterion.
**Effort:** L. **Own doc:** **Yes.** D14 is one paragraph in DESIGN, not a buildable spec, and the
handoff/resume state machine sits on top of unresolved §10 open questions: **handoff mid-tool-call** (must
it be turn-boundary-only? — changes trigger semantics), **interrupt-semantics divergence** (Claude
interrupt vs Codex abort — partial writes?), **crash-recovery commit points** (hub death between "successor
spawned" and "origin paused" needs saga-style idempotent replay). Needs `docs/continuity-engine.md`.

### 7. Mesh-native mobile / responsive UI *(parallel track)*
**Scope.** Cash in the device token: make the split-pane/sidebar/composer/approval surfaces responsive for
phone, add the **D13.1 mesh panel** (show `peerUrl`, the enable toggle, and the token-pairing UX from
Settings), touch-friendly approval cards, and a PWA shell. This is the concrete realization of the
`vendor-remote-control.md` verdict: *the device token + full hub UI over the mesh dominates vendor remote
control on both trust and coverage* (every agent, no vendor relay) — it is "work with agents from my phone
now," done right.
**Placement/deps.** Depends only on the foundational **device token** (#1) — independent of the
orchestration spine, so it runs in **parallel** with 1–6 (pure frontend + the already-built `meshSite`
status route). Tailscale remains the day-one stopgap if mesh pairing to the phone isn't ready.
**Effort:** M. **Own doc:** **No** — D13.1 + vendor-remote-control.md already frame it; a short
responsive-layout checklist suffices.

### 8. Full diff/file viewer + PR/branch integration + merge gate *(parallel track)*
**Scope.** The DESIGN §12 file surface: **changed-files tree** (`git -C <worktree> diff --numstat` vs
branch base, live on tool events); **diff panel** extending the built `DiffView` to unified+split + per
-file collapse + large-diff virtualization (self-contained, no external engine); read-only **worktree file
explorer** (`/api/fs/tree` + `/api/fs/read`, reusing the write-scope guard); **checkpoints + rollback**
(git tag/`thread/rollback`); the **merge gate** (secret-scan + large-deletion/binary checks + optional
reviewer-agent sign-off — the bridge from agent output to the real repo); the **review flow** ("ready for
review" status + approve/request-changes); and **PR round-trip** via `gh` (agents open PRs; review
comments + CI failures flow back as bus messages, §10).
**Placement/deps.** Mostly git + worktrees (both built) + frontend, so it runs in **parallel** with the
backend spine. Its merge-gate/reviewer-agent/PR-as-bus-message pieces tie back into ① and ⑤ once those
exist, but the diff/file/checkpoint half needs neither.
**Effort:** L. **Own doc:** **Yes for the merge-gate + cross-vendor review pipeline + PR round-trip
half** (safety-critical: it's the last line between agent output and the real repo, and the cross-vendor
author→reviewer pattern from §10 needs specifying). The diff-viewer/file-explorer half is already scoped
in DESIGN §12 and can build against that directly.

### 9. Cross-node remote worker — WSL + remote node runner (P3)
**Scope.** The "start a project on any PC" piece. The **node-runner daemon** (runs inside Ubuntu-24.04 /
any fleet PC, **outbound-dials** the hub over WS — mirrored-networking-friendly), **cross-node
`spawn_agent`**, **profile moves** (move-never-copy relocated over mesh file transfer), **per-node ACLs**,
path mapping, and the **D13 sidecar bring-up** (`fetch-sidecars.ts` pins + probe/reuse/spawn +
delegated-update + wedge/respawn policy) for the absent-node branch of D13.1. Agent relocation
(`relocate_session`) rides the same rails.
**Placement/deps.** Last / opens P3. It is the largest greenfield build, depends on the **orchestration/
ACL spine (①)** for cross-node spawn + per-node scopes and on the **leased-worktree/relocation model
(④)**, and builds on the already-shipped **device token + mesh site**. It carries the thorniest §10 open
questions: **9p filesystem boundary** (projects must live native to one node; cross-node clones, not
shares), **WSL clock drift** (hub as clock authority for `resetsAt` math), **mirrored-networking vs VPN**
connectivity watchdog, and **runner autonomy during hub outage** (at-least-once vs exactly-once delivery).
**Effort:** XL. **Own doc:** **Yes** — it is DESIGN P3 in full; needs a `docs/node-runner.md` covering the
daemon protocol, relocation saga, sidecar bring-up, and the filesystem/clock/network hazards.

---

## 4. Smaller items to fold in opportunistically

Not their own phase steps — ship inside the nearest relevant item:

- **Attention inbox** (§10) — single cross-session queue of everything needing a human (approvals, agent
  questions, failures, expiring handoffs), keyboard-first. High value at 20 agents; unlocked once ① adds
  `ask_user` + the bus is live. Ship as part of the viz Slice 4 / a focused UI build (M).
- **Visualization Slice 2/3** (Run view + spawn tree + fleet surface) — already scoped in
  `agent-visualization.md`; unlocked by ①'s spawn lineage + the task board; ship incrementally alongside
  ① rather than as a separate phase step.
- **Saved layouts + multi-window split polish** (§12 "big UI piece"; resizable sidebar already done) —
  ships with track ⑦.
- **Subagent reasoning visibility** — constrained: Claude withholds reasoning *text* on subscription
  accounts (only "✦ reasoned" markers), Codex exposes it. Low priority; ships with the viz slices.
- **Diff-first session cards / session presets / bulk ops** (§10 Fleet UX) — cheap wins alongside ⑦/⑧.
- **Cost-per-task attribution** (§10; the join already-possible from journal token events) — small, ships
  with the Usage dashboard / ⑥'s budget work.
- **Project import** (`project-import.md`) — an independent, already-scoped feature; slot it whenever
  convenient (its Slice 1 is read-only and risk-free), but its MCP-wiring slice benefits from ①'s grant
  model, so land that half after ①.

---

## 5. Recommended ordering + what to build first

**Single recommended ordering** (⑦ and ⑧ run in parallel with the critical path; ⑨ last):

0. **Retrofit-hostile hardening** — cheap, and M6/redaction + deps-pin *must* precede the shared-space
   layers or become near-impossible to retrofit.
1. **Orchestration MCP + scope/ACL + brains** — the spine every shared space, hook, and the continuity
   engine consumes; the foundational bus shipped only a minimal ACL, this is the real one.
2. **Project Commons** — the shared space that memory Tier-0 capture, the continuity handoff brief, and
   the status board all build on; append-only, low-risk, high-leverage.
3. **Memory system (full)** — non-owner tiers + MCP tools + capture loop, on top of ①'s clamp and ②'s
   Tier-0 source; already fully scoped, so fast to build.
4. **Worktree ownership lease (+M4/M5)** — small but load-bearing; must land before continuity or the
   handoff/resume path corrupts shared working trees.
5. **Fleet hooks** — the trigger surface continuity plugs into and the delivery path for watchdogs +
   memory nudges; contained once the bus + spawn exist.
6. **Continuity engine + budget-aware spawning** — the capstone that composes ①–⑤ + UsageMonitor into
   DESIGN's P2 exit; a flagship user priority.
7. **Mesh-native mobile UI** *(parallel from the start)* — realizes the device token's payoff: the full
   fleet on the phone over the mesh, no vendor relay.
8. **Full diff/file viewer + PR + merge gate** *(parallel from the start)* — high dev-workflow value, git
   -based, independent of the spine; the merge gate is the bridge to the real repo.
9. **Cross-node remote worker (P3)** — the largest build; "start a project on any PC," on top of ①/④ +
   the device token + mesh site.

**What to build first in phase 2: item ① — the Orchestration MCP server + scope/ACL model + brains
hot-swap**, immediately preceded by the cheap item-0 hardening chore (hours, not a build). Everything
substantial downstream — commons grants, memory's write-clamp, the bus's cross-project/orchestrator reach,
fleet-hook spawn actions, the Run view's spawn tree, and the continuity engine's budget-aware spawning —
consumes ①, and the foundational bus slice intentionally deferred the full scope model to exactly this
step. Start the **mobile UI (⑦)** in parallel on day one, since it depends only on the device token and
delivers the user's "work from my phone now" goal while the spine is under construction.

**Needs its own deep-scoping doc before building:** ① (`docs/orchestration.md` — the security spine),
② (`docs/project-commons.md` — the missing schema keystone), ⑥ (`docs/continuity-engine.md` — the handoff
state machine + its open questions), ⑧'s merge-gate/review half, and ⑨ (`docs/node-runner.md` — P3 in
full). ③ (memory) and ④ (worktree lease) are already covered by `memory-system.md` and the audit; ⑤
(hooks) needs only a short section; ⑦ (mobile) needs only a checklist.
