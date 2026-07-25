# Claude multi-agent workflow visualization — the "Agents" panel

Scoping doc, drafted 2026-07-24. This is the **richer workflow view**: a right-side, detachable
**Agents** panel that renders a Claude session's sub-agent *swarm* as a live tree/DAG — parent agent →
sub-agents → their turns — with per-node status, tokens, and duration.

A **v1 of the panel is already being built separately**: a flat list of sub-agent invocations under the
selected session. This doc scopes the layers above that list (tree, drill-in, live), and is written so
the v1 list is its **Slice 1** — nothing here throws the list away; it grows into the tree.

Scope boundary: this is the **Claude** `Task`/`Agent` native-sub-agent case specifically, grounded in
the real on-disk data this machine produces today. It is the concrete, ship-first companion to the
broader multi-surface design in **`docs/agent-visualization.md`** (lanes/runs/fleet, the bus, `spawn_agent`
whole-session workers). Where this doc and that one overlap, that doc owns the general model and the
Fleet/Run surfaces; **this doc owns the Agents panel and the Claude sub-agent reconstruction**. Codex has
no equivalent native-sub-agent mechanism today, so it is out of scope (the panel simply hides for Codex
sessions).

---

## 0. TL;DR

- A Claude multi-agent workflow is **fully reconstructable from files AllMyAgents already reads**, plus
  two file types it does not read yet: the **`subagents/agent-<id>.jsonl`** transcripts and their
  **`.meta.json`** sidecars. The meta sidecar is the authoritative tree source.
- **Nothing in the app parses any of this today.** `grep -r "isSidechain|subagent_type|parentUuid|Task"`
  over `apps/` returns **zero hits**. `transcript.ts` treats a `Task`/`Agent` `tool_use` as a generic
  tool card and never looks at the `subagents/` folder.
- The data model is a **`WorkflowRun` = tree of `AgentNode`s**, reconstructed by joining: root-transcript
  `Agent` tool calls + `subagents/*.meta.json` (`toolUseId` / `parentAgentId` edges) + `queue-operation`
  task-notifications (per-node status/tokens/duration).
- **Detection**: a *single* `Task` call is just a tool card; a *workflow* is ≥2 sub-agents that are
  siblings under one parent (fan-out), or any node with `spawnDepth > 1` (pipeline/nesting). Group and
  name by sibling batch.
- **Build plan**: **v1** flat list (in progress) → **v2** tree + drill-into-a-node's-transcript (reuses
  `readHistoryPage` verbatim on the agent file) → **v3** live (file-watch the `subagents/` dir + stream
  task-notifications).

---

## 1. How a Claude multi-agent workflow surfaces in the data

Everything below was inspected on this machine on 2026-07-24 against **Claude Code `2.1.217`**
(`entrypoint: "claude-desktop"`). Real example used throughout: session
`39334a6b-cb76-4e8c-9bc2-76b188af1a73` under
`C:\Users\Admin\.claude\projects\C--Users-Admin-Documents-CEC-Automation-Suite\`, an orchestration that
scoped a Rust GPU/PCIe stress suite by fanning out **19 top-level sub-agents** plus ~6 nested ones.

### 1.1 Version caveat — the tool is named `Agent`, not `Task`

In `2.1.217` the spawn tool's `tool_use.name` is **`Agent`**, not `Task`. The input shape is otherwise
the classic one. Detection must match **both** names (and be forgiving of future renames — the tell is
the input carrying `subagent_type` + `prompt`):

```jsonc
// assistant record, message.content[] block — a real spawn:
{
  "type": "tool_use",
  "name": "Agent",                       // was "Task" in older builds — match /^(Task|Agent)$/
  "id": "toolu_012sVtuh2oya4LfSwrC3N58F",
  "input": {
    "description": "Scope PCIe saturation data plane",
    "subagent_type": "general-purpose",
    "run_in_background": true,            // NEW: sub-agents can run detached/async
    "prompt": "You are scoping a build for `cec-crucible` …"
  }
}
```

The assistant record's framing (top-level keys, all already present in the JSONL):
`parentUuid`, `isSidechain` (`false` on the main lane), `uuid`, `timestamp`, `sessionId`, `cwd`,
`gitBranch`, `version`, `entrypoint`, `effort`, `requestId`.

### 1.2 The spawn's immediate result — launch ack vs. inline result

The paired `tool_result` (a `user` record, `content[].tool_use_id` = the call id, plus top-level
`toolUseResult` and `sourceToolAssistantUUID` back-pointing to the spawning assistant `uuid`) has **two
shapes**:

- **Background** (`run_in_background: true`) → a launch ack that hands back the child's **agentId**:
  `"Async agent launched successfully. … agentId: a149e9670868bb706 … Use SendMessage with to:
  'a149e9670868bb706' …"`. The real result arrives **later**, out of band (§1.4).
- **Synchronous** (`run_in_background: false`) → the sub-agent's **full final report inline** in the
  `tool_result` content, and there is usually **no** later task-notification.

This `tool_use_id → agentId` handoff is the first edge of the tree, and the reason background agents need
the notification stream to be legible.

### 1.3 The sub-agent's own transcript lives in a separate file (the big one)

The sub-agent's turns are **not inlined** in the main transcript. In `2.1.217`, the main transcript's
`isSidechain:true` count is **0**; the sub-agent's messages/tools/reasoning are written to their own file:

```
projects/<encoded-cwd>/
  39334a6b-….jsonl                         ← the parent (root) session transcript
  39334a6b-…/                              ← a dir named after the session id (no .jsonl)
    subagents/
      agent-a149e9670868bb706.jsonl        ← the sub-agent's FULL transcript
      agent-a149e9670868bb706.meta.json    ← sidecar: the tree edge + labels
      agent-ab009d43d090c74ab.jsonl
      agent-ab009d43d090c74ab.meta.json
      …
```

The **`.meta.json` sidecar is the authoritative tree record.** Two real examples:

```jsonc
// agent-a149e9670868bb706.meta.json  — a depth-1 child of the root session
{ "agentType": "general-purpose",
  "description": "Scope PCIe saturation data plane",
  "toolUseId": "toolu_012sVtuh2oya4LfSwrC3N58F",   // == the root Agent call's id
  "spawnDepth": 1 }

// agent-a6b3c1df5dcd449d4.meta.json  — a depth-2 grandchild
{ "agentType": "general-purpose",
  "description": "Research PCI DEVPKEY link properties",
  "toolUseId": "toolu_011gvRXYdXCHWzYvGMM1eQAi",   // an Agent call INSIDE the parent agent's file
  "parentAgentId": "ab009d43d090c74ab",            // the parent AGENT (not the root session)
  "spawnDepth": 2 }
```

Two facts make reconstruction clean:

1. **The edge is unambiguous.** For `spawnDepth === 1`, `toolUseId` matches an `Agent` `tool_use.id` in
   the **root** transcript. For `spawnDepth > 1`, `parentAgentId` names the parent agent file and
   `toolUseId` matches an `Agent` call **inside that parent's** `agent-<parentAgentId>.jsonl`. Verified:
   `agent-ab009d43d090c74ab.jsonl` is 89 records, **all `isSidechain:true`**, and contains exactly the
   two depth-2 `Agent` calls (`toolu_011gv…`, `toolu_01SMQ…`) that the depth-2 metas point back to.
2. **A sub-agent file is a *normal* Claude transcript.** It is `user`/`assistant` records with
   `message.content` block arrays — the same shape `claudeRecordItems()` in `transcript.ts` already
   parses. Rendering a sub-agent's turns therefore needs **zero new parsing**: point the existing
   `readHistoryPage(file, 'claude', …)` at the agent file. (The files are small — 200–500 KB — so the
   tail-first pager is comfortable.)

### 1.4 Completion, tokens, and duration — the `queue-operation` task-notifications

When a background sub-agent stops, the **root** transcript gets a `queue-operation` record whose `content`
is a `<task-notification>` XML blob. This is where per-node **status, tokens, tool-use count, and
duration** come from — data available nowhere else:

```jsonc
{ "type": "queue-operation", "operation": "enqueue",   // later paired with operation:"remove"
  "sessionId": "39334a6b-…", "timestamp": "2026-07-24T04:55:22.998Z",
  "content": "<task-notification>
    <task-id>a149e9670868bb706</task-id>                 // == agentId
    <tool-use-id>toolu_012sVtuh2oya4LfSwrC3N58F</tool-use-id>
    <output-file>…\\tasks\\a149e9670868bb706.output</output-file>
    <status>completed</status>
    <summary>Agent \"Scope PCIe saturation data plane\" finished</summary>
    <result>… full markdown report …</result>
    <usage><subagent_tokens>158501</subagent_tokens><tool_uses>35</tool_uses><duration_ms>726256</duration_ms></usage>
  </task-notification>" }
```

Three things to get right when harvesting these:

- **Filter out background *commands*.** `run_in_background` Bash commands emit the *same*
  `<task-notification>` shape, but their `task-id` starts with **`b`** (e.g. `bk318nkwz`), carries
  `status=failed … exit code 255` and **no `<usage>`**. Real sub-agent task-ids start with **`a`** and
  carry `<subagent_tokens>`. Discriminate on "has `<subagent_tokens>`" (robust) and/or the `agent-<id>`
  file existing.
- **Dedupe — an agent can notify more than once.** The notification fires "each time this agent stops
  with no live background children of its own", so a parent that pauses to wait on its own children
  notifies again on resume. Real example: `ab009d43d090c74ab` notified at 04:49:02 **and** 04:50:12. Key
  by `task-id`, keep the latest `remove`/highest timestamp.
- **Grandchildren bubble to the root.** Depth-2 completions (e.g. `a6b3c1df5dcd449d4`,
  `ab2872590b9b18428`) appear as `queue-operation` records in the **root** transcript even though their
  *spawns* live in a depth-1 agent file. So status can be filled top-down from the root alone, but the
  **tree shape** for depth ≥ 2 requires reading the agent files' metas. Both sources are needed.

### 1.5 The hub journal — what a *live* orchestration would emit

Today the hub (`apps/hub/src`) journals per-session vendor events (`journal.ts`) and the web store replays
them (`store.svelte.ts`). For **imported/observed** Claude Desktop sessions (the case above), the hub is
**not in the loop** — those turns were produced by Claude Desktop, and AllMyAgents only sees them by
reading the transcript on open (`sessions.readHistory`). So for the near term, **the transcript + sidecar
files are the data source**, and "live" means *tailing those files* (§5, v3), not a journal event.

When the workflow runs **inside a hub-spawned Claude session** (via the SDK adapter, `adapters/`), the hub
*can* emit first-class events. The minimal set the panel would consume — named to match the
`domain/name` convention and the `docs/agent-visualization.md` §8 spec so the two stay compatible:

| Event `kind` | `sessionId` | Fires when | Carries |
|---|---|---|---|
| `subagent/start` | owner (root/parent) | an `Agent`/`Task` call is seen (SDK `tool_use`, or SubagentStart hook) | `agentId, parentToolUseId, parentAgentId?, spawnDepth, agentType, description` |
| `subagent/turn` | owner | a sub-agent produced a turn (optional; else derived from the agent file) | `agentId, kind, textPreview, tokens?` |
| `subagent/stop` | owner | notification `remove`, or SubagentStop hook | `agentId, status, subagentTokens, toolUses, durationMs, resultPreview` |

These are **additive** and replay-safe (the store's `apply()` already `default: break`s unknown kinds).
The panel is built to derive the same tree from *either* source — journal events when hub-native, file
scan when imported — so v2 can ship on the file scan and adopt events later with no UI change.

### 1.6 What the app can see today vs. the gap

| Signal | On disk? | Parsed by app today? |
|---|---|---|
| `Agent`/`Task` `tool_use` in root transcript | yes | rendered as a **generic tool card** (`ItemCard.svelte`); `subagent_type`/`description` ignored |
| `subagents/agent-<id>.jsonl` transcripts | yes | **no** — `locateTranscript` only globs `projects/<dir>/<sessionId>.jsonl` |
| `subagents/*.meta.json` (tree edges) | yes | **no** |
| `queue-operation` task-notifications (status/tokens/duration) | yes | **no** — `claudeRecordItems()` only handles `user`/`assistant` |
| inline `isSidechain:true` sub-agent turns (legacy builds) | version-dependent | **no** (count is 0 in 2.1.217; see §2.4) |

The gap is entirely **additive**: no existing parse changes, we only *read more files* and *recognize
more record types*.

---

## 2. Data model — the workflow run tree/DAG

### 2.1 Shapes

A workflow run is a tree of agent nodes rooted at the session. (It is a tree in practice — every agent has
exactly one parent — but the type carries `parentAgentId`/edges so a future DAG, e.g. shared
sub-agents or the bus, is representable without a rewrite.)

```ts
// apps/hub/src/transcript.ts (new; hub reconstructs, ships JSON to the web app)

export interface AgentNode {
  agentId: string                 // "a149e9670868bb706" (== task-id, == agent-<id>.jsonl stem)
  toolUseId: string               // the Agent/Task call that spawned it (edge to parent's call site)
  parentAgentId: string | null    // null => child of the root session; else another AgentNode
  spawnDepth: number              // 1 = direct child of root; 2 = grandchild; …

  agentType: string               // subagent_type, e.g. "general-purpose"
  description: string             // the Task "description" — the node's short label
  background: boolean             // run_in_background

  status: 'running' | 'completed' | 'failed' | 'unknown'
  phase?: string                  // detection-assigned group tag (§3): "fan-out #2", "verify", …

  // metrics — from the task-notification <usage>, else summed from the agent file (§2.3)
  tokens?: number                 // subagent_tokens
  toolUses?: number
  durationMs?: number
  startedAt?: string              // first ts in agent file / spawn call ts
  endedAt?: string                // notification ts / last ts in agent file

  resultPreview?: string          // first ~280 chars of <result> / final assistant text
  transcriptFile: string          // absolute path to agent-<id>.jsonl (hub-internal; drill-in reads it)
  children: AgentNode[]           // built during reconstruction
}

export interface WorkflowRun {
  sessionId: string               // the root session
  root: { sessionId: string; children: AgentNode[] }   // the root lane is the session itself
  nodes: Record<string, AgentNode>       // flat index by agentId
  totalAgents: number
  maxDepth: number
  groups: WorkflowGroup[]         // detected fan-out/pipeline batches (§3)
  isWorkflow: boolean             // false => a single lone Task; panel shows the plain list only
  // roll-ups for the panel header:
  runningCount: number; failedCount: number
  totalTokens?: number; totalDurationMs?: number
}

export interface WorkflowGroup {   // a named batch of sibling nodes (§3)
  id: string
  kind: 'fan-out' | 'pipeline' | 'verify' | 'single'
  label: string                    // "Research fan-out ×3", "PCIe scoping", …
  parentAgentId: string | null
  agentIds: string[]
}
```

The web app mirrors `AgentNode`/`WorkflowRun` in `apps/web/src/lib/api.ts` (minus `transcriptFile`, which
stays hub-internal), exactly as `HistoryItem` is mirrored there today.

### 2.2 Reconstruction algorithm (imported/observed sessions — the primary path)

Given a root session's `transcriptPath` (already persisted on `SessionRecord`, resolved by
`sessions.readHistory`):

1. **Locate the subagents dir**: `dirname(transcriptPath)/<basename-without-.jsonl>/subagents/`. If
   absent → no workflow; return `{ isWorkflow: false }` (the panel shows the plain list from step 3 only).
2. **Read every `*.meta.json`** (they are tiny). Each yields an `AgentNode` seed: `agentId` (from the
   filename), `toolUseId`, `parentAgentId ?? null`, `spawnDepth`, `agentType`, `description`, and
   `transcriptFile` = the sibling `.jsonl`.
3. **Scan the root transcript once** (bounded, streamed — reuse `readJsonlBounded` from `importScan.ts`):
   - collect every `Agent`/`Task` `tool_use` `{id, input}` → gives `background`, and the depth-1 call
     sites (`toolUseId → node`). *(This same scan is what the v1 list already does — see §5.)*
   - collect every `queue-operation` `<task-notification>` with a `<subagent_tokens>` → a status/metrics
     record keyed by `task-id`; keep the latest per id (dedupe).
   - for **synchronous** agents with no notification, take status=`completed` and `resultPreview` from the
     paired `tool_result` content.
4. **Link edges**: for each node, attach to `parentAgentId`'s `children` if set, else to `root.children`
   (a depth-1 node). Sort children by `startedAt` (spawn-call timestamp) so the tree reads chronologically.
5. **Fill metrics/status** from the notification map (preferred) or the agent file (fallback, §2.3);
   compute roll-ups (`totalTokens`, `runningCount`, `maxDepth`, …).
6. **Detect + group** (§3): set `isWorkflow`, `groups`, and each node's `phase`.

This is **O(one bounded scan of the root file + N tiny meta reads)** — the heavy agent `.jsonl` files are
read only on drill-in (§4), never during reconstruction. Cache the `WorkflowRun` keyed by
`(sessionId, root-file mtime)`; invalidate when the transcript or subagents dir mtime changes (this is also
the cheap "is it still live?" check for v3).

### 2.3 Where per-node metrics come from (precedence)

1. **task-notification `<usage>`** — authoritative for background agents (`subagent_tokens`, `tool_uses`,
   `duration_ms`). Present in the real data for every completed background agent.
2. **Computed from the agent file** — for synchronous agents (no notification) or as a cross-check: sum
   `message.usage` across the agent file's assistant records for tokens; `count(tool_use)` for tool uses;
   `last.timestamp − first.timestamp` for duration. Costs one file read, so do it lazily (on node expand)
   rather than during reconstruction.
3. **Unknown** — a still-running background agent has a file but no terminal notification: status
   `running`, metrics from a partial file-sum or omitted.

### 2.4 Legacy / alternate format: inline sidechain

The classic documented format — and what older Claude builds emit — inlines sub-agent turns into the
**main** transcript as records with `isSidechain: true`, chained by `parentUuid`, with the sub-agent's
first turn linked to the spawning `Task` `tool_use`. On this machine `2.1.217` produces **0** such records
(everything is externalized to `subagents/`), but the reconstructor should handle both, chosen by a cheap
probe:

- **External (2.1.x)**: a `subagents/` dir exists → §2.2.
- **Inline (legacy)**: `isSidechain:true` records exist in the main file → walk `parentUuid` chains to
  group sidechain turns per sub-agent; the `Task` `tool_use.id` that begins each chain is the edge. Metrics
  come from the sidechain records' own `message.usage`; there is no separate meta/notification. The node's
  `transcriptFile` is the main file plus a `laneId` filter (`item.parentUuid ∈ chain`), matching the
  `laneId`-projection approach in `docs/agent-visualization.md` §5.

Both collapse to the same `AgentNode`/`WorkflowRun`, so the panel and detection code are format-agnostic.

---

## 3. Detection — a single `Task` call vs. a real workflow

Not every `Task`/`Agent` call deserves the tree treatment. A lone research sub-agent is best left as the
tool card it already is. The panel escalates to the workflow tree only when the shape is genuinely
multi-agent.

**Classify a run** (set `WorkflowRun.isWorkflow` and each node's `phase`/group):

- **`single`** — exactly one sub-agent, depth 1, no children. `isWorkflow = false`. The Agents panel shows
  it as a one-row list entry (and the inline tool card already covers it). No tree.
- **`fan-out`** — **≥2 sibling nodes under the same parent** (same `parentAgentId`, spawned in the same
  turn or within a short window). This is the dominant real pattern: the example session has fan-out
  batches of 2 (`04:43` PCIe data-plane + error-telemetry) and 3 (`21:41` three path-tracing scopes).
  Group = the sibling set.
- **`pipeline` / nesting** — **any node with `spawnDepth > 1`**, i.e. a sub-agent that itself spawned
  sub-agents (`ab009d43d090c74ab` → DEVPKEY + WHEA research). Multi-level ⇒ workflow, unconditionally.
- **`verify`** — a heuristic refinement of a sibling group: a trailing node whose `description`/`agentType`
  matches `/verif|review|check|audit|test/i` spawned **after** its siblings completed. Tag it `verify` so
  the panel can draw the "produce → check" relationship (the example has "Verify OptiX ship/runtime
  specifics" following the research nodes). Purely cosmetic; never gates `isWorkflow`.

**Decision rule:** `isWorkflow = (totalAgents ≥ 2 && any fan-out group) || maxDepth ≥ 2`.

**Grouping into batches.** Walk each parent's `children` sorted by `startedAt`; start a new group when the
gap to the previous sibling exceeds a threshold (e.g. 90 s) *or* the parent changes. Within the example
this cleanly separates the ten temporal clusters (the 19 root children fall into batches of
1/2/1/2/3/1/2/2/2/3). Background vs. synchronous is *not* a group boundary — a parent can fire several
background agents in one turn and then block on a synchronous one.

**Naming a group.** Priority: (1) longest common prefix / shared keyword of the sibling `description`s
("Research …" ×3 → *"Research fan-out ×3"*); (2) the parent node's `description` as the phase name for a
nested group; (3) fallback `"<agentType> ×N"`. Keep it short — it is a panel header, not a sentence.
Never surface the sub-agent `prompt` text or the `agentId` verbatim in the default view (the launch ack
explicitly marks the agentId as internal); show `description` + metrics.

---

## 4. Display — the right-side "Agents" panel

### 4.1 Placement, coexistence, detachability

- **A right-side panel**, peer to the sidebar (left) and the thread pane grid (center). It is bound to the
  **selected session** (`store.selectedId`) and shows that session's `WorkflowRun`. It is **collapsed by
  default** and opens on a header toggle; its width is persisted under the existing
  `allmyagents.*`-namespaced localStorage convention (mirroring `allmyagents.sidebarWidth`). For a session
  with no sub-agents it stays hidden entirely, so single-agent chats are visually unchanged.
- **Coexistence with the v1 list.** The panel has two modes on one toggle: **List** (the v1 flat roster of
  invocations — always available, the default when `isWorkflow` is false) and **Tree** (this doc, shown
  when `isWorkflow` is true). The list is the tree flattened depth-first; they share one `WorkflowRun`
  source, so there is no duplicate fetch and no divergence. "Tree" simply adds indentation, edges, group
  headers, and roll-ups over the same rows.
- **Poppable / detachable.** Two levels, cheapest first:
  1. **In-app detach (ship in v2):** the panel content is a `PaneTarget {kind:'agents', sessionId}` (the
     generalized pane cell from `docs/agent-visualization.md` §2.4), so it can be dragged into the existing
     `splitPanes` grid and live *beside* a transcript — watch the tree in one pane, a sub-agent's turns in
     the next. No new window machinery; reuses `App.svelte`'s drag-to-split.
  2. **True OS pop-out (later):** a separate Tauri webview window. `apps/web/src/lib/window.ts` currently
     wraps only minimize/maximize/close via the global bridge (`__TAURI__`), so a real pop-out needs a new
     `WebviewWindow` helper there + a route that renders just the panel. Deferred — the in-app detach
     covers the "see it next to the chat" need that motivates "poppable".

### 4.2 The tree (sketch)

```
┌ Agents — "cec-crucible scoping"        24 agents · 2 running · 1.2M tok · 41m ▾ [List|Tree] ⤢ ┐
│                                                                                                │
│ ◐ (this session)  orchestrator                                                                 │
│ │                                                                                              │
│ ├─▸ Research fan-out ×2 · PCIe            ⑂                                                     │
│ │   ├─ ✓ Scope PCIe saturation data plane      158.5k tok · 35 tools · 12m   ↳                │
│ │   └─ ✓ Scope PCIe link health + error telem  120.6k tok · 30 tools ·  7m   ↳                │
│ │        ├─ ✓ Research PCI DEVPKEY link props    99.5k · 24 · 9m     (depth 2)                 │
│ │        └─ ✓ Research WHEA AER on Windows      120.2k · 43 · 9m     (depth 2)                 │
│ │                                                                                              │
│ ├─▸ Path-tracing fan-out ×3              ⑂                                                     │
│ │   ├─ ◐ Scope OptiX path tracing              running · 6m · Read src/optix.rs …             │
│ │   ├─ ◐ Scope Vulkan/DXR RT-pipeline          running · 6m · Grep "rayGen" …                 │
│ │   └─ ○ Scope path-tracing as QC stress       queued                                         │
│ …                                                                                              │
└ recent: ✓ "Design the full-day burn-in gauntlet" finished · 155k tok ───────────────────────┘
```

- **Node row** = status dot + `description` + a compact metrics chip (`tokens · toolUses · duration`) and,
  for a running node, its **live one-liner** (current tool name or last assistant line). Status dot reuses
  `store.status()`'s color/dot vocabulary so it matches the sidebar and header everywhere. Depth is shown
  by indentation + a git-branch glyph (already in `Icon.svelte`).
- **Group header** = the detected batch (`§3`) with a **fan-out badge** `⑂` and `×N`. Collapsible.
- **Panel header roll-up** = `totalAgents`, `runningCount`, summed tokens, elapsed, and a worst-status chip
  (any `failed` → the panel reads "attention"). This is the per-run analog of the sidebar's collapsed
  project summary (`Sidebar.svelte`'s `summarize()`), and should reuse it.
- **`↳` (open lane)** on each node → drill into that sub-agent's transcript (§4.3).

### 4.3 Expand a node → its turns (drill-in) — reuses the history viewer verbatim

This is the highest-value reuse in the whole design. A sub-agent file is a normal Claude transcript
(§1.3), so its turns render through the **exact path the just-added history viewer uses**:

- **Server**: generalize `sessions.readHistory` (today: `sessionId → transcriptPath → readHistoryPage`) to
  accept an optional `agentId`, resolving the file to
  `…/<sessionId>/subagents/agent-<agentId>.jsonl` instead of the root file, then calling the **unchanged**
  `readHistoryPage(file, 'claude', opts)`. Surface it as `GET /api/sessions/:id/history?agent=<agentId>`
  (a one-branch addition next to the existing `/history` route in `server.ts`, lines ~590-601). Same
  tail-first paging, same `before` byte cursor, same `HistoryItem[]` output.
- **Client/store**: add `ensureAgentHistory(sessionId, agentId)` alongside `ensureHistory` in
  `store.svelte.ts` — same `historyPulled`-style guard, same `toThreadItem` mapping, storing the turns on
  the `AgentNode` (or a lightweight per-lane `SessionView`). Reuse `loadOlderHistory`'s cursor logic
  unchanged.
- **Render**: the sub-agent's `HistoryItem`s map 1:1 to `ThreadItem`s and render with the **same
  `ItemCard.svelte`** — user/assistant/reasoning/tool cards, diffs, the works. Two presentation options:
  **(a)** inline-expand under the node row (indented, left rule — reuse the `.think` left-border), or
  **(b)** open in a pane via the `PaneTarget` from §4.1. Ship (a) in v2, (b) with the pane generalization.
  Note the DESIGN §12 caveat: sub-agent *reasoning* text is withheld on subscription accounts, so those
  rows show as `✦ reasoned` markers — same as top-level today; no special handling.

Because drill-in reads the agent file only when a node is expanded, a 24-agent run costs one bounded
root-scan up front and nothing more until the user opens a node.

### 4.4 States

- **No sub-agents** → panel hidden; a session's header shows no Agents affordance.
- **Reconstructing** → skeleton rows (the root scan is fast, but background/observed sessions may be mid-run).
- **Running node** → pulsing dot + elapsed + live one-liner (v3); before v3, a `running` node (file exists,
  no terminal notification) shows an indeterminate state with metrics from the partial file.
- **Failed node** → `failed` chip + the notification's error/`exit code`, styled like `ItemCard`'s existing
  `.fail`.

---

## 5. Build plan (incremental)

Each slice is independently shippable and strictly additive (no existing parse or render path changes).

### v1 — Flat list of sub-agent invocations *(already in progress — this is the foundation)*

- **Hub**: scan the root transcript for `Agent`/`Task` `tool_use` blocks → `{toolUseId, subagent_type,
  description, background, ts}`; expose under the session. (This is step 3a of §2.2.)
- **Web**: the right **Agents** panel in **List** mode — one row per invocation with `description` +
  `subagent_type` + spawn time, bound to `store.selectedId`.
- **Exit:** the operator can see, per session, *that* it spawned sub-agents and what each was for.

### v2 — Tree + metrics + drill-in *(this doc's core)*

- **Hub**: full `WorkflowRun` reconstruction (§2.2) — read `subagents/*.meta.json`, harvest
  `queue-operation` notifications (dedupe; filter `b*` commands), link the tree, compute roll-ups; run
  detection/grouping (§3). New endpoint `GET /api/sessions/:id/workflow`. Extend `readHistory` with
  `?agent=<id>` (§4.3).
- **Web**: **Tree** mode — indented nodes, group headers with fan-out badges, per-node metrics chips,
  header roll-up; **expand-a-node** drill-in via `ensureAgentHistory` + `ItemCard`. Mirror `AgentNode`/
  `WorkflowRun` in `api.ts`. Generalize the pane cell to `PaneTarget` so the panel is in-app detachable.
- **Exit:** the operator sees the whole swarm as a tree, per-node cost/duration, and can read any
  sub-agent's actual turns — beside the parent chat if they detach the panel.

### v3 — Live

- **Hub**: watch the `subagents/` dir (`fs.watch`) + tail the root transcript for new `queue-operation`
  records; push deltas over the existing WS as `subagent/start|turn|stop` events (§1.5). For hub-native
  Claude SDK sessions, emit the same events directly from `adapters/` on `tool_use`/SubagentStart/Stop
  instead of file-watching.
- **Web**: `store.apply()` gains the three `subagent/*` cases → patch the `WorkflowRun` in place (running
  dots, live one-liners, metrics filling in as agents finish). Because the model is identical to the
  file-scan output, the tree UI is unchanged.
- **Exit:** the tree animates as the orchestration runs — the "watch the swarm work" surface.

### v4 — Depth (ties into `docs/agent-visualization.md`)

- Per-node **cost** attribution (join tokens → the pricing already surfaced by `ContextMeter`/usage);
  the **bus** (`SendMessage`, referenced in the launch ack) as cross-node edges → the DAG view; promote a
  detached panel to a true Tauri pop-out window (§4.1); fold the tree into the broader **Run/Fleet**
  surfaces of the sibling doc.

---

## 6. Reuse map (what each slice touches)

| Concern | Existing thing to reuse | File |
|---|---|---|
| Parse a sub-agent transcript | `claudeRecordItems`, `readHistoryPage` (unchanged) | `apps/hub/src/transcript.ts` |
| Bounded root scan for Agent calls + notifications | `readJsonlBounded`, `parseClaudeRecords` pattern | `apps/hub/src/importScan.ts` |
| Resolve a session's file, page history | `sessions.readHistory` (+ `?agent=` branch) | `apps/hub/src/sessions.ts`, `server.ts` |
| Lazy-load + cache history, prepend turns | `ensureHistory` / `loadOlderHistory` / `historyPulled` / `toThreadItem` | `apps/web/src/lib/store.svelte.ts` |
| Render a turn (user/assistant/tool/diff/reasoning) | `ItemCard.svelte`, `DiffView.svelte` | `apps/web/src/lib` |
| Status dot vocabulary + subtree roll-up | `store.status()`, `summarize()` | `store.svelte.ts`, `Sidebar.svelte` |
| Depth glyph, provider ring, context gauge | `Icon.svelte` (git-branch), `ContextMeter.svelte` | `apps/web/src/lib` |
| Detachable panel as a pane | `splitPanes` + `PaneTarget` generalization (§2.4 of sibling doc) | `store.svelte.ts`, `App.svelte` |
| OS window controls (future pop-out) | `window.ts` Tauri bridge | `apps/web/src/lib/window.ts` |

---

## 7. Open questions

1. **Reconstruct in the hub or the browser?** The hub already has file access and the parsers; a
   `/workflow` endpoint keeps heavy JSONL off the wire and matches how `/history` works. Recommended:
   hub-side, browser mirrors the result. (Any objection to another read-only hub endpoint?)
2. **Group threshold + naming.** Is a 90 s sibling-gap the right batch boundary, and is
   longest-common-prefix naming good enough, or should the group name come from the assistant's own text
   around the spawn (a richer but heavier parse)?
3. **Panel vs. Run view overlap.** `docs/agent-visualization.md` proposes a Run view and a right
   *inspector*. Is the Agents panel *the* realization of that inspector for the Claude case (recommended —
   one surface), or a distinct, simpler thing that coexists?
4. **Running-agent metrics before completion.** For a still-running background agent (file, no
   notification), do we pay the file-sum cost to show live tokens, or show only elapsed until it finishes?
5. **Cross-session `spawn_agent` workers.** This doc covers *native* in-session sub-agents. When the hub's
   own `spawn_agent` (whole-session workers, sibling doc §4) lands, should those appear in the *same*
   Agents panel tree (unifying "lane" origins) or stay in the sidebar as full sessions? Recommend showing
   them as tree nodes that link out to their session, so one panel answers "what did this agent farm out?".
