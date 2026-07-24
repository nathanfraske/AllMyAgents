# Agent visualization — showing multi-agent activity in the UI

Design scope, drafted 2026-07-24. This is the **how-we-show layer** for multi-agent work: workflows,
sub-agent spawning, sub-agent transcripts, and inter-agent messages. It extends **DESIGN.md D11
(reasoning visibility + subagent trees)**, **D7 (bus / agent-to-agent)**, **D8 (fleet hooks)**, **D10
(Project Commons)**, and **D5 (orchestration MCP / `spawn_agent`)**, and picks up the DESIGN §10 ideas
(**attention inbox**, **diff-first cards**, **time-travel fleet debugger / causality graph**).

Routing, ACLs, delivery semantics, and the injection firewall for the bus are the **comms layer**,
specified separately in `docs/inter-agent-comms.md` (**[comms doc]**, written concurrently). This doc
depends on none of its internals — it defines only what the frontend renders and the journal events it
reads. Where a payload field originates in routing, it is cross-referenced as **[comms doc]**.

Nothing here is built yet. Today `apps/hub/src` emits per-session vendor events into one append-only
`events` table (`journal.ts`), and `apps/web` is a **stateless event-replay viewer** (`store.svelte.ts`)
that routes each event by `event.sessionId` into a flat `SessionView.items[]` and renders a 2D pane grid
(`App.svelte`) of `ThreadView`s. There is **no lineage on items, no cross-session edge, no run/plan
concept, and no fleet surface**. This doc specifies those additions and reuses the existing shapes: the
one replayable sequence, `store.status()` + status dots, the `ContextMeter` ring gauge, `ItemCard` kind
dispatch, the `PaneTarget` (today just a session id), and `Dashboard` as the home surface.

---

## 1. The core model — lanes, runs, fleet

Everything reduces to one primitive plus two groupings.

**A lane is a transcript** — one ordered stream of `ThreadItem`s. This is exactly what `ThreadView`
already renders from `SessionView.items`. Every visualization in this doc is *lanes plus edges between
lanes*. There are three lane origins:

| Lane origin | What it is | Has own `SessionRecord`? | Today |
|---|---|---|---|
| **Root lane** | a top-level session (`SessionManager.create`) | yes | rendered |
| **Spawned lane** | a full session the brains created via `spawn_agent` (D5) | yes — linked by `parentSessionId` | not linked |
| **Subagent lane** | a *native in-session* child: Claude `Task` tool (`parent_tool_use_id` + SubagentStart/Stop), or a Codex nested item group | **no** — a sub-stream inside its parent session's transcript | not captured |

This split is the crux of items 2 and 3, so state it plainly: **"sub-agent" means two different
things.** A `spawn_agent` worker is a whole session (own worktree, profile, process) that already fits a
pane; a native subagent is a lane *inside* one session's `query()`/turn. The unifying abstraction is the
**lane**, and the **spawn tree** is the edge set that connects lanes across both mechanisms.

**A run is a tree of lanes** — one orchestration rooted at a lane (usually the brains), joined by
lineage edges (session spawns + native subagents). A run optionally carries a **plan** (ordered/DAG of
phases) laid over the tree; that overlay is the *workflow* view.

**The fleet is a forest of runs + roots** — every lane in the hub, clustered by project, with bus
messages as cross-lane edges.

These are three **zoom levels** of the same graph, and they compose:

```
FLEET  (widest)      all lanes, clustered by project, bus + spawn edges     → Dashboard "Fleet" mode
  │  click an agent
RUN    (mid)         one orchestration: plan phases + spawn tree + progress → a surface, also a pane target
  │  click a node
LANE   (closest)     one transcript                                         → ThreadView in a pane (unchanged)
```

Bus messages thread through all three: a card in each participant lane (closest), an edge on the run
timeline (mid), a link in the fleet graph (widest). The chat-centric split view is **never replaced** —
fleet and run are *navigation and awareness* surfaces that always drill back down into panes (echoing
§10: "the fleet grid is ambient awareness; the chat is the working surface").

---

## 2. Data-model additions (one place)

All additions are additive and backward-compatible with replay (unknown `kind`s already fall through
`apply()`'s `default: break`, and unknown item fields are ignored by `ItemCard`).

### 2.1 `ThreadItem` (`store.svelte.ts`)

```ts
export type ItemKind =
  | 'user' | 'assistant' | 'thinking' | 'tool' | 'reasoning' | 'status' | 'error' | 'note'
  | 'agent-message'      // NEW — a bus envelope in/out (item 4)
  | 'subagent'           // NEW — a native subagent lane header under its Task card (items 2/3)
  | 'spawn'              // NEW — "spawned worker <id>" edge to a full child session (item 2)

export interface ThreadItem {
  key: string
  kind: ItemKind
  ts: string
  text?: string
  toolName?: string; toolInput?: unknown; toolResult?: string; toolError?: boolean
  reflex?: boolean
  status?: string
  // --- lineage (NEW) ---
  laneId?: string        // native-subagent lane this item belongs to (= parentToolUseId); undefined = main lane
  // --- agent-message (NEW) ---
  from?: string          // sender label (profileId/agent name)
  to?: string            // recipient label, or channel name
  channel?: string
  direction?: 'sent' | 'received'
  envelopeId?: string
  untrusted?: boolean    // always true for bus payloads → drives the firewall framing ([comms doc])
  // --- subagent / spawn (NEW) ---
  subagentId?: string    // for kind:'subagent'
  childSessionId?: string// for kind:'spawn'
  ok?: boolean           // subagent/child terminal result
}
```

### 2.2 `SessionView` + `SessionRecord`

```ts
// SessionRecord (apps/hub/src/types.ts AND apps/web/src/lib/api.ts) — persisted lineage:
parentSessionId?: string          // set when created via spawn_agent
spawnToolUseId?: string           // the orchestrator tool call that requested the spawn (causality)
role?: 'orchestrator' | 'worker'  // brains vs worker (from the D5/D12 orchestrator scope)
runId?: string                    // groups every lane of one orchestration

// SessionView (store.svelte.ts) — derived render state:
subagents?: Record<string, SubagentLane>   // native lanes keyed by subagentId (see §5)
```

```ts
interface SubagentLane {
  id: string; name?: string; parentToolUseId: string
  status: 'active' | 'done' | 'error'
  startedAt: string; endedAt?: string; ok?: boolean
  // transcript is a PROJECTION of the parent's items where item.laneId === parentToolUseId
  // (kept as a filter, not a copy — replay + seq-dedup stay single-source; see §5)
}
```

### 2.3 Store-level fleet state

```ts
class HubStore {
  busMessages = $state<BusMessage[]>([])          // fleet timeline + graph edges (§7)
  runs = $state<Record<string, RunView>>({})      // plans + phase status, keyed by runId (§4)
}
interface BusMessage {
  id: string; ts: string; from: string; to?: string; channel?: string
  project?: string; kind: string; fromSessionId?: string; toSessionIds?: string[]; summary: string
}
interface RunView {
  runId: string; title?: string; rootSessionId?: string
  phases: Phase[]; source: 'plan-mode' | 'orchestrator' | 'runner'
}
interface Phase { id: string; title: string; dependsOn?: string[]
  status: 'pending' | 'active' | 'done' | 'failed' | 'skipped'; sessionIds: string[] }
```

### 2.4 `PaneTarget` — generalize the pane cell

`splitPanes` is `string[][]` (session ids). To let a pane host a run tree, a projected lane, or the
fleet graph without abandoning the existing 2D layout math, evolve the cell from `string` to a tagged
target (Slice 2):

```ts
export type PaneTarget =
  | { kind: 'session'; id: string }              // today's behavior
  | { kind: 'lane'; sessionId: string; laneId: string }  // a native subagent lane in its own pane
  | { kind: 'run'; runId: string }               // the run tree / phase timeline
  | { kind: 'fleet' }                            // the fleet graph as a pane
```

`coord()`, `commit()`, `dropAt()`, `closePane()` in `store.svelte.ts` are index math over the outer
array and are unaffected; only the leaf type and `ThreadView`'s prop change. `selectedId` stays a session
id (drives the sidebar) — a `run`/`fleet` pane simply doesn't sync it.

### 2.5 New journal events (named; full spec in §8)

| Event `kind` | `sessionId` | Fires when |
|---|---|---|
| `session/spawned` | parent | hub `spawn_agent` mints a child session |
| `subagent/start` | owner | Claude SubagentStart hook / first Codex nested item |
| `subagent/stop` | owner | Claude SubagentStop hook / nested group closes |
| `bus/message` | `null` | hub routes an envelope ([comms doc]) |
| `workflow/plan` | orchestrator | a plan is set (plan-mode approval, orchestrator, or runner) |
| `workflow/phase` | orchestrator | a phase changes status |
| `run/started` / `run/finished` | root | a run opens / closes (optional; else derived from first spawn) |

Plus the additive field `parentToolUseId` on `claude/assistant` and `claude/user` payloads (the adapter
copies `message.parent_tool_use_id`), and the lineage fields on the `session/created` record.

---

## 3. Item 1 — Workflows (the Run view)

**Goal:** when an agent runs a multi-step workflow, show the plan, the phases, progress, and which steps
fan out.

**Where a plan comes from** (in priority of what's grounded today):
1. **Plan-then-execute gate** (§10): Claude plan mode / Codex review produces a plan that lands as a
   Commons artifact; approving it unlocks execution. The approved plan's steps *are* the phases.
2. **Orchestrator-authored**: the brains posts a plan via an MCP tool (`workflow/plan`) as it decomposes
   work — the common P2 case.
3. **Workflow runner** (P5, "scripted multi-agent pipelines"): a static pipeline definition.
4. **Derived fallback** (cheapest, ship-first): if no explicit plan exists, synthesize phases from the
   **task board** (`task/created|claimed|completed`, D5/D6) — one phase per task, status from claim state.
   This means the Run view works the moment the task board exists, before any `workflow/*` event.

**Surface: the Run view.** A mid-zoom surface, reachable from (a) the fleet graph, (b) an orchestrator
session's header — a **"view run"** button shown when `record.role === 'orchestrator'` or `record.runId`
is set — and (c) as a `PaneTarget {kind:'run'}` so you can watch the run tree in one pane and a child
transcript in the pane beside it (the killer orchestration layout). Composition:

```
┌ Run: "Migrate auth to OAuth"          orchestrator claude-a · 3/5 phases · $2.14 · 6m ───────┐
│ PHASE TIMELINE (vertical stepper)      │  SPAWN TREE (git-branch glyphs)                     │
│  ✓ 1 Survey codebase          done     │  ◐ claude-a (brains)                                │
│  ✓ 2 Draft plan               done     │   ├─ ✓ codex-a  worker · "endpoints"   done         │
│  ◐ 3 Implement endpoints  ⑂×2 active   │   ├─ ◐ codex-b  worker · Edit auth.ts   working ↳   │
│  ○ 4 Wire frontend            pending  │   └─ ◐ claude-b worker · Task ▸ 2 subagents         │
│  ○ 5 Review + merge           pending  │        ├─ ◐ reviewer  active                        │
│                                        │        └─ ✓ tester   done                           │
└ recent bus ▸ codex-a→claude-a "endpoints done" · claude-a→codex-b "take frontend" ──────────┘
```

- **Phase timeline** — a vertical stepper; each phase reuses `store.status()` keys + the existing status
  dots, shows a **fan-out badge** `⑂×K` when `phase.sessionIds.length > 1`, and a per-phase progress read
  (done children / total). Clicking a phase filters the tree + bus strip to that phase's `sessionIds`.
- **Spawn tree** — §5; the run's tree rooted at `rootSessionId`. Each node is a compact card (provider
  logo, label, `store.status()` dot, current tool or last assistant line, `ContextMeter` ring, cost).
  Native subagents nest under their `Task ▸` node (item 3). Clicking a node opens it — `↳` = "open in a
  pane beside this run."
- **Bus strip** — the run's `bus/message`s in time order (§7), each a from→to chip; hovering highlights
  the two tree nodes it connects.
- **Run header** — aggregate roll-up: phase progress, summed cost (`Σ view.costUsd` over the tree),
  elapsed, worst-status chip (any `error` → run reads "attention"). This is the per-run analog of the
  sidebar's collapsed-project summary in `Sidebar.svelte`.

**Store mapping.** `apply()` gains `workflow/plan` → upsert `store.runs[runId]`, and `workflow/phase` →
patch `phases[phaseId].status/sessionIds`. `RunView.rootSessionId` + the tree come from the `runId` +
`parentSessionId` links already on the session records; no per-phase transcript is stored — phases just
*reference* session ids, so the Run view is a thin projection over existing `SessionView`s.

---

## 4. Item 2 — Sub-agent spawning (the spawn tree)

**Goal:** render parent → children, each child's status, and let the user drill into a child.

**Lineage sources (both feed one tree):**
- **Spawned sessions** — `spawn_agent` (D5) calls `SessionManager.create` with `parentSessionId`,
  `runId`, `role`, `spawnToolUseId`. The hub also appends **`session/spawned`** on the *parent* so the
  edge renders immediately (before correlating two `session/created`s) and the parent transcript shows a
  `kind:'spawn'` card. The child is a full `SessionView` already in `store.sessions`.
- **Native subagents** — `subagent/start` / `subagent/stop` on the owning session (§5); these are lanes,
  not sessions, and hang under the spawning `Task` tool card.

**The tree, three places (one builder).** A pure `store` selector `treeFor(rootId)` walks
`parentSessionId` (sessions) + `subagents` (lanes) into a `TreeNode[]`; it renders in:

1. **Run view** (§3) — the primary spawn-tree surface.
2. **Sidebar** (`Sidebar.svelte`) — child sessions render **indented under their parent** within the
   project group, with a `git-branch` glyph (already in `Icon.svelte`) and the same status dot; a
   collapse toggle on the parent hides the subtree. Orchestrators get a small `⑂N` count. This makes the
   existing roster tree-aware with no new surface.
3. **A `{kind:'run'}` pane** — the tree standalone when you want it beside a transcript.

**Each node** shows: provider logo, label (`profileId` + worktree basename, as `ThreadView`'s pane
`<select>` already builds), `store.status()` dot + label, live one-liner (current `tool` name or last
`assistant` text), `ContextMeter` ring, and cost. Reuses `summarize()` from `Sidebar.svelte` for subtree
roll-ups.

**Drill into a child.**
- *Spawned session* → it's a real session: `store.select(childId)` (sidebar), or drop/open it in a pane
  via the existing split (`setPaneSession` / `dropAt`) — **zero new transcript machinery**.
- *Native subagent* → open its lane: inline-expand under the Task card (default), or promote to a
  `PaneTarget {kind:'lane', sessionId, laneId}` (§5).

**Node status** comes straight from `store.status(view)` for sessions and from `SubagentLane.status` for
lanes — the same six keys the sidebar and header chips already use, so color/dot semantics are uniform
fleet-wide.

---

## 5. Item 3 — Sub-agent transcripts (surfacing a lane)

**Goal:** surface a sub-agent's own messages/tools/reasoning. How it fits the 2D pane model + the
event-replay store.

**The rule:** a **spawned session** already has a first-class transcript — render it in a `ThreadView`
pane, done. The design work is only the **native subagent lane**, which lives inside one session's
`items[]`.

**Capture (hub).** Claude assistant/user SDK messages carry `parent_tool_use_id`; `adapters/claude.ts`
copies it onto the `claude/assistant` / `claude/user` payload, and registers **SubagentStart/Stop hooks**
(SDK `options.hooks`, currently unset) that emit `subagent/start` / `subagent/stop`. Codex nested items
carry a parent item id; the adapter maps the same way. (D11 names these lineage signals; this is the
event surface for them.)

**Store mapping (minimal, replay-safe).** In `apply()`:
- `applyClaudeAssistant` / `applyCodexItem` read the parent id and set **`item.laneId = parentToolUseId`**
  on every pushed item. Items still land in the **flat `view.items[]`** in sequence order — replay,
  `seq`-dedup, and the optimistic-echo logic are all untouched (this preserves the store's stated
  robustness). Lane membership is a *tag*, not a separate buffer.
- `subagent/start` → create `view.subagents[subagentId]` and push a `kind:'subagent'` header item with
  `laneId` = its `parentToolUseId` so it renders in place; `subagent/stop` → set `status`/`ok`/`endedAt`.
- A **lane transcript is a derived projection**: `view.items.filter(i => i.laneId === laneId)`. One source
  of truth, no duplication, correct under replay.

**Three render modes (progressive):**

1. **Inline-expandable (default, Slice 1).** The spawning `Task` tool card in `ItemCard.svelte` gets a
   disclosure: collapsed shows `Task ▸ <name> · <n> steps · <status>`; expanded renders the lane's items
   as **nested `ItemCard`s** (indented, left rule — reuse the `.think` left-border treatment). Main-lane
   rendering already ignores lane items if `ThreadView` filters `items` to `laneId == null` at top level,
   so subagent chatter doesn't double-render in the parent stream.
2. **Nested pane (Slice 2).** "Open lane ↳" promotes it to `PaneTarget {kind:'lane', sessionId, laneId}`.
   `ThreadView` gains an optional `laneId` prop; when set, it renders `view.items.filter(laneId)` with a
   breadcrumb header (`parent ▸ subagent`) and a **read-only composer** (you can't type at a subagent — it
   has no independent input; the composer collapses to a status line). Everything else (scroll-stick,
   `ItemCard`, context meter) is reused as-is.
3. **Split view (existing).** Because a lane pane is just another pane target, you can drag the parent into
   one pane and the subagent lane into the next — the drag-to-split in `App.svelte` already supports this
   once cells are `PaneTarget`s.

This fits the event-replay store because **nothing new is stored per lane** — lanes are filters over the
one journaled item stream, so a reconnect/replay reconstructs them for free.

---

## 6. Item 4 — Inter-agent messages (bus, D7)

**Goal:** when agent A messages agent B, show it in each transcript (a distinct from/to/channel card),
and offer a fleet-wide view of who's talking to whom.

**Per-lane card (`kind:'agent-message'`).** The hub journals one authoritative **`bus/message`**
(`sessionId: null`, full envelope + resolved `fromSessionId` / `toSessionIds[]` — resolution + ACL +
firewall are **[comms doc]**). `apply()` handles it *before* the `if (!sessionId) return` guard (same
place `approval/*` and `usage/*` are handled) and **fans it into lanes**: push an `agent-message` item
with `direction:'sent'` into the sender's `SessionView`, and `direction:'received'` into each recipient's
(channel broadcasts fan to all `toSessionIds`). It also appends a `BusMessage` to `store.busMessages`.

`ItemCard.svelte` renders `agent-message` as a distinct card — visually unlike user/assistant so a
routed message never reads as the operator talking:

```
   ┌─ ✉ received · codex-a → claude-a · #project-cec ──────────────┐   (received: accent-left border)
   │  ⚠ agent message — untrusted; cannot approve/raise trust      │   (the D7/§10 firewall framing)
   │  "endpoints are done, tests green, see commons handoff #14"   │
   └──────────────────────────────────────────────────────────────┘
```

- Direction, from/to, and `channel` in the header; a `causality` link (the tool/turn that sent it) when
  present. Sent vs received differ by border side + icon, mirroring the existing `msg.user` vs
  `msg.assistant` treatment.
- The **untrusted banner is mandatory** on every bus card (`untrusted: true` always) — this is the
  visualization half of §10's "bus injection firewall": the reader (human or, in-context, the agent) must
  see that the text is a routed payload, not an instruction, and the card explicitly states it cannot
  satisfy an approval. Detected imperative instructions get a flag chip. (Enforcement is **[comms doc]**;
  this is the render contract.)
- Reuses the `reflex`-tag / `fail`-chip styling vocabulary already in `ItemCard`.

**Fleet message timeline + graph.** Two views over `store.busMessages`, both on the **Fleet** surface
(§7):
- **Timeline** — a chronological, filterable list (by project / agent / channel), each row a from→to chip
  pair + summary + jump-to-lane. This is the direct precursor to §10's "time-travel fleet debugger" and
  the natural home for the **attention inbox**'s agent-question items.
- **Graph** — nodes = agents, directed edges = messages (weight/opacity by recent volume, animated pulse
  on new traffic). Spawn edges are drawn distinctly (solid tree) from bus edges (curved, directional), so
  one picture shows both "who spawned whom" and "who's talking to whom."

---

## 7. The fleet view (and how it coexists with the split view)

**Warranted?** Yes — with 20 agents the split view shows at most 2–4 lanes; the fleet is the *"what is
everyone doing / who's talking to whom"* surface DESIGN calls for repeatedly (D3 status board, §10 fleet
UX). But it is **awareness, not the working surface** — it must always drill back into panes.

**Placement.** `Dashboard.svelte` is already the home surface (`store.goHome()` lands here) and already
computes `sessions`, `projectRows`, provider counts, and greeting. Add a **mode toggle** at the top —
`Overview | Fleet` — so Fleet reuses the home slot with zero new routing. Also expose it as a
`PaneTarget {kind:'fleet'}` so it can live in a pane next to a transcript.

**Fleet layout (SVG, no external graph lib — consistent with the hand-rolled `ContextMeter`/Dashboard SVG
and the "no external diff engine" leanness call in §12).** Deterministic project-clustered layout computed
in the store:
- **Cluster per project** (reuse the `Sidebar` grouping). Within a cluster, a root/orchestrator sits at
  center with its spawn tree radiating out — the spawn tree *is* the intra-cluster layout.
- **Node** = agent: provider-colored, ringed by `store.status()` color, sized by activity; the same dot
  semantics as everywhere else. Pending approvals/questions get the sidebar's `pbadge`.
- **Edges** = bus messages (curved, directional, recent-weighted) + spawn edges (solid tree).
- **Click a node → `store.select(id)`** → opens that session in the panes (leaving Fleet), or shift-click
  → drop into a new pane. This is the drill-down that keeps Fleet subordinate to the chat view.

**Coexistence contract.** Fleet/Run/Overview are **home-slot or pane-slot surfaces**; the moment you act
on an agent you're back in the split-pane chat view. No surface owns global state; all read the same
`store` projections. This mirrors the existing `goHome()` / `goBack()` dance (`lastLayout` already
remembers the pane layout when you visit home).

---

## 8. New hub events & fields (consolidated spec)

Names follow the existing `domain/name` convention. All payloads pass `redact()` (journal) and are
additive.

```
session/spawned            sessionId = PARENT
  { childSessionId, runId, profileId, provider, role, reason?, prompt?, spawnToolUseId? }
  → store: push kind:'spawn' card on parent; ensures the tree edge before child's session/created

session/created            (existing) — record now also carries:
  parentSessionId?, spawnToolUseId?, role?, runId?

subagent/start             sessionId = OWNER
  { subagentId, parentToolUseId, name?, prompt?, source: 'claude-hook' | 'codex-nested' }
subagent/stop              sessionId = OWNER
  { subagentId, ok, summary?, error? }
  → store: create/close view.subagents[subagentId]; items self-associate via item.laneId

claude/assistant, claude/user   (existing) — payload now includes:
  parent_tool_use_id?        // adapter copies message.parent_tool_use_id → store sets item.laneId

bus/message                sessionId = null                                    ([comms doc] owns routing)
  { id, ts, from, to?, channel?, project?, kind, payload, causality?,
    fromSessionId?, toSessionIds?: string[] }
  → store: fan into sender (sent) + recipients (received) as kind:'agent-message'; append busMessages[]

workflow/plan              sessionId = orchestrator (or null + runId)
  { runId, title?, source: 'plan-mode'|'orchestrator'|'runner',
    phases: [{ id, title, dependsOn?, status }] }
workflow/phase             sessionId = orchestrator
  { runId, phaseId, status: 'pending'|'active'|'done'|'failed'|'skipped', sessionIds?, note? }

run/started / run/finished sessionId = root        (optional; else derive run from first session/spawned)
  { runId, rootSessionId, title }  /  { runId, ok, summary }
```

Frontend `SessionRecord` (`apps/web/src/lib/api.ts`) mirrors the four new record fields. No change to the
WS protocol, replay, or `seq`-dedup — these are just new `kind`s and fields on the existing stream.

---

## 9. Phasing (smallest useful first → full)

**Slice 1 — Lineage in the transcript (no new surfaces, no pane-model change).**
The highest multi-agent value for the least surface area — everything renders in the existing
`ThreadView`/`ItemCard`:
- Add the `ThreadItem` lineage/message fields (§2.1) and the record lineage fields (§2.2).
- `apply()` cases: `bus/message` → `agent-message` cards (item 4) + `busMessages[]`; `session/spawned` →
  `spawn` edge card (item 2); `subagent/start|stop` + `parent_tool_use_id` tagging → inline-expandable
  native subagent lane under the `Task` card (item 3, mode 1).
- Hub: adapters surface `parent_tool_use_id` + SubagentStart/Stop; `spawn_agent` sets lineage + emits
  `session/spawned`; the bus router emits `bus/message` (**[comms doc]**).
- **Exit:** in one transcript you see A↔B messages (with the untrusted framing), a "spawned worker" edge,
  and can expand a native subagent's steps inline. *This is the smallest slice that makes multi-agent work
  legible.*

**Slice 2 — Run view + spawn tree + `PaneTarget`.**
- Generalize pane cells to `PaneTarget` (§2.4); `ThreadView` gains the `laneId` prop (lane panes, §5 mode
  2); sidebar renders child sessions indented (§4).
- Build the Run view (§3): phase timeline (derived from the **task board** first, then `workflow/*`) +
  spawn tree + bus strip + roll-up header; "view run" button on orchestrator headers; `{kind:'run'}` pane.
- **Exit:** watch an orchestration as a plan + live tree, drill any node into a pane beside it.

**Slice 3 — Fleet surface.**
- Dashboard `Overview | Fleet` toggle; SVG project-clustered graph (nodes + spawn/bus edges), click-to-open
  (§7); fleet **message timeline** (§6).
- **Exit:** "what is everyone doing / who's talking to whom" at a glance, one click back into any chat.

**Slice 4 — Depth (ties into §10 backlog).**
- Attention-inbox integration (agent questions + expiring handoffs surface from `busMessages`/approvals);
  causality overlay on the fleet graph (spawn/envelope/hook edges) → the "time-travel fleet debugger"
  precursor; imperative-instruction flagging on bus cards; per-run cost/`$-per-phase` attribution
  (join journal token/cost to `runId`/`phaseId`).

---

## 10. Open questions for the user

1. **Native-subagent transcript depth.** DESIGN §12 notes Claude Code withholds *reasoning text* on
   subscription accounts (signature only). Subagent **messages + tool calls** stream fine, but a
   subagent's *thinking* will show as `✦ reasoned` markers only (same as top-level today). Acceptable, or
   should lane panes hide the reasoning row entirely to reduce noise?
2. **Run identity source.** Prefer explicit `run/started` from the orchestrator, or **derive** `runId`
   from the first `session/spawned` (lighter, but a run has no title until the brains names it)? Slice 2
   can ship on the derived form and adopt explicit envelopes when the orchestration MCP lands.
3. **Bus fan-out storms.** A channel broadcast to N agents = N `agent-message` cards + N edges. Cap
   per-lane bus cards (collapse "+K more from #channel") and coalesce fleet edges by (from,to) with a
   count, as DESIGN §10 ("delta coalescing / per-viewer rate limits") warns for 20-agent fan-out?
4. **Sidebar tree vs flat.** Indenting child sessions under parents (§4) changes the roster's mental model
   (currently flat, project-grouped, newest-first). Tree-by-default, or a per-project "group spawns" toggle
   so the flat sort stays available?
5. **Where the Run view primarily lives.** Full home-slot surface, dedicated pane, or a right **inspector**
   panel (the §12 "resizable right inspector" that's already queued)? The inspector reading of "run
   context for the selected chat" may fit the working flow better than a separate surface.
