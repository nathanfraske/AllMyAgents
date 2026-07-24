# Practices, hooks, and the `full`-mode gate-live fix — build & integration design

Build design, drafted 2026-07-24. **Implementation plan only — no code changed; one markdown file.** This doc
designs three tightly-coupled additions to AllMyAgents (Node/TS hub + Svelte frontend), in dependency order:

1. **The `full`-mode gate-live fix** — a security hardening that makes the operator-approval gate reachable even
   when a session runs with `full` permissions. **Everything else depends on it.**
2. **An agent-writable practices layer** — a scoped store (like `InstructionStore`) that agents write to, whose
   entries materialize into future agents' `CLAUDE.md`/`AGENTS.md` as behavior-shaping context.
3. **A hook registry** — a per-account/project store of **executable** hooks an agent can *propose*, gated behind
   an always-required per-hook operator approval.

It is grounded in the current code — `apps/hub/src/agentTools.ts` (in-process MCP tools + `AgentServices`),
`sessions.ts` (`canUseTool`/`onApproval` wiring, the `deliverBus` clamp, `runClaudeTurn`/`runCodexTurn`, the
`mcp__allmyagents__*` auto-allow), `approvals.ts` (`ApprovalService.request` — the operator gate), `instructions.ts`
(scoped store + materialize into the native instruction file), `memory.ts` (already agent-writable + scoped),
`identity.ts` (readable/writable scopes) — and builds on the trust model in `docs/inter-agent-comms.md`, the scoped
store in `docs/memory-system.md`, the affordance strategy in `docs/tool-affordance.md`, and the native-tools invariant
+ the **gate-disabling finding** already recorded in `docs/agent-native-tools.md` / `docs/emulated-agent-tools.md`
(§0/§5.3 of the latter). It **changes no code.**

---

## 0. Verdict (read this first)

- **Build order (hard dependency):** **gate-live fix → practices → hooks.** The practices layer's project/global
  writes and the hook registry's proposals both route through the operator-approval gate; that gate is *not reachable*
  from a `full` session today (see below), so the fix lands first or the two features ship with a hole.

- **The gate-live fix, in one paragraph.** A `full` session runs Claude with `permissionMode:'bypassPermissions'`
  (`adapters/claude.ts:65`) and Codex with `approvalPolicy:'never'` (`sessions.ts:419`). Both **skip the approval
  callback entirely** — Claude never calls `canUseTool` (`sessions.ts:185-198`), Codex never fires `onApproval`
  (`sessions.ts:156-161`). So any tool that *should* be gated would run ungated in `full`. **The fix exploits that our
  agent tools are in-process** (`buildAgentMcpServer`, `agentTools.ts:39`, wired at `sessions.ts:201`): a risky tool
  handler runs *inside the hub*, so it can **self-gate** by calling `ApprovalService.request(...)` from within its own
  handler — a gate that is independent of the SDK's permission mode and therefore fires even under `full`/bypass.
  Three parts: (a) a `requireApproval` helper the risky handlers call; (b) a **bus-turn tag** so risky handlers
  **hard-deny** when the turn was caused by a (semi-trusted) teammate message; (c) a standing rule for *out-of-process*
  native tools (browser/computer) that cannot self-gate — enabling them must **force the turn into a gate-live mode**
  (never `bypass`/`never`).

- **The practices permission gradient:** writing to your **own `account`** scope is low-risk → **auto-allow** (matches
  `memory_write`); writing to **`project`** (affects teammates) or **`global`/`vendor`** (affects everyone) must pass
  the **operator-approval gate** from part (1). Provenance (author session/profile + timestamp) rides every practice,
  and materialization keeps agent-authored practices in a **separate, clearly-labeled block** from operator
  instructions — auditable and revocable, never confused with operator intent.

- **The single biggest risk in letting agents write hooks:** a hook is **executable code that runs automatically on
  future events, outside the per-tool approval loop.** One approval is a *one-time* gate that, once passed, grants
  **persistent, unattended code execution** for every future matching event and future session — the exact opposite of
  the per-action gating the rest of the system relies on. It is a self-propagation / persistence vector that can
  re-enable capabilities, rewrite other hooks/practices, or exfiltrate, with no further prompt. Hence hooks are the
  **highest tier**: `hook_propose` is **always** per-hook operator-approved, **never** auto-approved, **never** from a
  bus turn, and (recommended) executed **hub-mediated** so the hub stays in the loop with a kill switch.

Security gradient this doc establishes (full table in §6):

| Layer | Write cost | Why |
|---|---|---|
| **Memory** (exists) | **free write** within your readable/writable scopes | recalled knowledge; inert until recalled |
| **Practices** (new) | **scope-gated** — account free, project/global/vendor operator-approved | behavior-shaping; materialized into every future prompt |
| **Hooks** (new) | **operator-approved always**, per hook, never from a bus turn | executable; runs unattended on future events |

---

## 1. The `full`-mode gate-live fix (do this first)

### 1.1 The bug, grounded

The hub maps its three permission modes onto the vendors like this:

- **Claude** (`adapters/claude.ts:64-65`): `edits → acceptEdits`, **`full → bypassPermissions`**. When
  `bypassPermissions` is set, the SDK **does not invoke `options.canUseTool` at all** — every tool runs without asking.
  Our whole gate lives in `canUseTool` (`sessions.ts:185-198`): the `mcp__allmyagents__*` auto-allow (`:188`),
  `checkWriteScope` (`:189-193`), and `approvals.request(record.id, 'claude/tool', …)` (`:194`). Under `full`, **none
  of it runs.**
- **Codex** (`sessions.ts:419`): `approvalPolicy: permissionMode === 'full' ? 'never' : permissionMode ? 'onRequest' : undefined`.
  With `'never'`, the app-server **never emits an approval request**, so `onApproval` (`sessions.ts:156-161` →
  `approvals.request(record?.id, 'codex/${method}', …)`) **never fires.**

So `full` is not "approve everything automatically" — it is "**the approval code path is gone.**" That is fine for the
tools `full` is meant for (file edits in a throwaway worktree). It is **not** fine for a tool that must *always* ask —
which is exactly what practice-writes-to-project and hook-proposals are. This is the finding already recorded as the
"second, load-bearing finding" in `docs/emulated-agent-tools.md §0/§5.3`; this doc makes it the **first** thing we fix,
because practices and hooks depend on it.

### 1.2 The insight: in-process tools can self-gate

`buildAgentMcpServer` (`agentTools.ts:39-149`) builds an **in-process** `createSdkMcpServer`; its tool handlers execute
**inside the hub process**, holding a reference to `AgentServices` (`agentTools.ts:14-22`, supplied by
`SessionManager.agentServices()`, `sessions.ts:64-71`). A handler is ordinary hub code. It can therefore **call
`ApprovalService.request(...)` itself, before it acts** — and *await* the operator's decision — completely
independently of whatever `permissionMode` the turn runs under. The SDK's bypass only removes the SDK's *own* callback;
it cannot remove a gate the handler invokes from within its own body.

This is the load-bearing asymmetry between our two tool classes:

| Tool class | Where the handler runs | Can it self-gate? | Gate mechanism |
|---|---|---|---|
| **In-process hub tools** (`mcp__allmyagents__*`, and the new `practice_*` / `hook_*`) | inside the hub | ✅ yes | **self-gate**: call `requireApproval` in the handler — mode-independent, fires under `full` |
| **Out-of-process native tools** (`mcp__amabrowser__*`, `mcp__claude-in-chrome__*`) | separate process; hub sees them only via `canUseTool`/`onApproval` | ❌ no | **force gate-live mode** (never emit `bypass`/`never` when capability on) — §1.5 |

### 1.3 Part (a) — the `requireApproval` helper

Extend `AgentServices` (`agentTools.ts:14-22`) with two capabilities the hub already owns:

```ts
export interface AgentServices {
  // …existing send/inbox/roster/memory…
  /** Block until the operator approves this action (self-gate). Journaled via ApprovalService. */
  requireApproval(id: SessionIdentity, kind: string, payload: unknown): Promise<boolean>
  /** True if the CURRENT in-flight turn for this session was caused by a bus (teammate) message. */
  isBusTurn(sessionId: string): boolean
}
```

`SessionManager.agentServices()` (`sessions.ts:64-71`) implements them against machinery it already holds:

```ts
requireApproval: (id, kind, payload) => this.approvals.request(id.sessionId, kind, payload),
isBusTurn: (sessionId) => this.busTurnSessions.has(sessionId),
```

`ApprovalService.request` (`approvals.ts:22-38`) already returns `Promise<boolean>`, journals `approval/requested`,
and **defaults to deny on its 10-minute timeout** (`approvals.ts:5,33-35`) — fail-closed, exactly what a self-gate
wants. The operator resolves it over the existing `/api/approvals/:id` route (`server.ts:487-493`) → `resolve()`
(`approvals.ts:40-42`); no new approval plumbing is needed. A convenience wrapper the risky handlers call:

```ts
// in agentTools.ts
async function selfGate(services: AgentServices, id: SessionIdentity, kind: string, payload: unknown): Promise<boolean> {
  if (services.isBusTurn(id.sessionId)) return false      // (b): hard-deny bus-caused turns, unconditionally
  return services.requireApproval(id, kind, payload)       // else: block on the operator
}
```

A denied/timed-out gate returns a plain `textResult('Not applied — the operator declined (or the request timed out).')`
so the agent gets a clean, non-fatal signal (mirrors the existing tool-result convention at `agentTools.ts:24-26`).

### 1.4 Part (b) — tag bus-caused turns

Today **nothing tells a tool handler (or `canUseTool`) that a turn is bus-caused.** `deliverBus`
(`sessions.ts:551-571`) injects queued teammate messages as one turn wrapped in `frameBusMessages`
(`sessions.ts:672-688`) with `clampMode` (`sessions.ts:666-668`, `full → edits`). The clamp keeps a bus turn out of
`bypass`, but that is a *permission-mode* signal, not a *provenance* signal a handler can read.

Add a provenance tag scoped to the in-flight turn:

- `private readonly busTurnSessions = new Set<string>()` on `SessionManager`.
- Thread an `origin: 'operator' | 'bus'` parameter (default `'operator'`) into `runClaudeTurn` (`sessions.ts:372`) and
  `runCodexTurn` (`sessions.ts:407`). On entry, `if (origin === 'bus') this.busTurnSessions.add(record.id)`; in the
  `finally`, `this.busTurnSessions.delete(record.id)`. Because a Claude turn is single-flight per session
  (`driver.busy`, `adapters/claude.ts:49-51`) and a Codex turn is one-per-thread, the set is an accurate "this
  session's current turn is bus-caused" flag for the whole duration tool handlers can run.
- `deliverBus` calls `runClaudeTurn(record, framed, clamped, 'bus')` / `runCodexTurn(..., 'bus')` (`sessions.ts:569-570`).
  Every operator-originated path — `create()` (`sessions.ts:270,278`), `send()` (`sessions.ts:444,446`) — keeps the
  `'operator'` default.

The self-gate then **hard-denies** any risky in-process tool call on a bus turn (§1.3, `selfGate`): a teammate message
— semi-trusted per the agent contract (`instructions.ts:68-88`) and the bus frame's own caveat
(`sessions.ts:679-687`) — can *never* drive a practice/hook write or (once wired) a native-tool call. This is the same
hard invariant `docs/agent-native-tools.md §5.2` states for browser/computer tools, now applied to persistence-class
tools too. Journal a `approval/auto-denied-bus` event (mirrors the existing `approval/auto-denied-scope`,
`sessions.ts:191`, which the store already renders at `store.svelte.ts:783-789`).

### 1.5 Part (c) — the standing rule for out-of-process native tools

In-process tools self-gate; **out-of-process native tools (Playwright/`amabrowser`, `claude-in-chrome`, `amacomputer`)
cannot** — their handlers run in another process and the hub only sees them at `canUseTool`/`onApproval`, which `full`
skips. For that class the rule is the one `docs/emulated-agent-tools.md §5.3` already states, restated here as the
general principle:

> **Enabling any capability whose tools cannot self-gate must force the turn out of `full`/bypass into a gate-live
> mode.** For Claude: never emit `permissionMode:'bypassPermissions'` when a `nativeTools` capability is on — clamp to
> `default`/`acceptEdits` so `canUseTool` still runs (fix in `runClaudeTurn`, `sessions.ts:372`, and the mapping at
> `adapters/claude.ts:64-65`). For Codex: never emit `approvalPolicy:'never'` for a capability-on turn — force
> `'onRequest'` (`sessions.ts:419`).

So the two mechanisms are **complementary, chosen by where the handler runs**:

- **In-process, risky** (`practice_*`, `hook_*`) → **self-gate** (works in *all* modes, including `full`). Preferred
  when we own the handler, because it needs no mode clamp and cannot be defeated by a future mode.
- **Out-of-process, risky** (browser/computer) → **force gate-live mode** (the only option; the hub can't intercept the
  handler body).

A future native tool that is neither must not ship until one of the two applies to it.

### 1.6 Reconciling with the `:188` auto-allow and the `clampMode` clamp

`canUseTool` auto-allows the whole `mcp__allmyagents__*` namespace (`sessions.ts:188`) because today every tool there
is safe and ACL-enforced in-tool (bus + memory). The new tools live in the **same in-process server** (so they inherit
its identity binding and affordance), but they are **not all safe** — so the blanket prefix allow must be narrowed.

**Change `:188` from a namespace prefix test to an explicit SAFE allowlist:**

```ts
const AUTO_ALLOW = new Set([
  'mcp__allmyagents__list_agents', 'mcp__allmyagents__send_message', 'mcp__allmyagents__read_messages',
  'mcp__allmyagents__memory_write', 'mcp__allmyagents__memory_search', 'mcp__allmyagents__memory_read',
  'mcp__allmyagents__practice_read', 'mcp__allmyagents__practice_list',   // reads are safe
])
const SELF_GATING = new Set([
  'mcp__allmyagents__practice_write', 'mcp__allmyagents__practice_edit', 'mcp__allmyagents__hook_propose',
])
// in canUseTool, replacing the startsWith at :188:
if (AUTO_ALLOW.has(toolName)) return { behavior: 'allow', updatedInput: input }
if (SELF_GATING.has(toolName)) {
  if (this.busTurnSessions.has(record.id)) {                    // belt: also hard-deny at the SDK layer
    this.journal.append(record.id, 'approval/auto-denied-bus', { toolName })
    return { behavior: 'deny', message: 'a teammate (bus) turn may not write practices or propose hooks' }
  }
  return { behavior: 'allow', updatedInput: input }            // defer to the handler's own self-gate — no double prompt
}
// …existing checkWriteScope + approvals.request fall-through for everything else…
```

Why this shape:

- **The SAFE tools stay auto-allowed** — no behavior change for bus/memory reads (and `memory_write`, which is
  scope-checked in-tool by `resolveWriteScope`, `agentTools.ts:28-32`, staying a free write).
- **The risky tools are not auto-allowed** in the meaningful sense: they hit a dedicated branch that (i) **hard-denies
  bus turns** even at the `canUseTool` layer (defense in depth — the handler *also* denies via `selfGate`), and (ii)
  returns `allow` *only to avoid a double prompt*, deferring the real decision to the handler's in-process
  `requireApproval`. The handler's self-gate is the **authoritative** gate; the `canUseTool` branch is a second,
  independent barrier for the non-`full` modes.
- **Under `full`/bypass**, `canUseTool` is skipped entirely — but the handler's `selfGate` still runs (bus hard-deny +
  operator approval), so the tool is gated regardless. This is the whole point of §1.2.
- The existing **`clampMode` bus clamp** (`sessions.ts:666-668`) is unchanged and now redundant-but-harmless for these
  tools (the bus-turn tag hard-denies them before the mode matters); it stays because it still governs *file-edit*
  tools on bus turns.

**Net:** one code path, two barriers, no double prompt, and correctness under `full`.

---

## 2. Agent-writable practices layer

### 2.1 What it is — and how it differs from memory and instructions

| Layer | Who writes | What it is | When it reaches the model |
|---|---|---|---|
| **Operator instructions** (`instructions.ts`) | operator (via Settings/API) | authoritative operator intent | materialized into `CLAUDE.md`/`AGENTS.md` at spawn (`sessions.ts:239-242`) |
| **Memory** (`memory.ts`) | agents (+ operator) | **recalled knowledge** — "we decided X", "the build cmd is Y" | **pull** (agent calls `memory_search`) or hub-side recall (`tool-affordance.md §4`) — inert until recalled |
| **Practices** (new) | **agents** (+ operator) | **behavior-shaping conventions** — "always run `pnpm typecheck` before claiming done", "prefer Vitest, never Jest here" | **materialized into every future agent's prompt**, like instructions — always on |

Practices are structurally an `InstructionStore` (scoped text that materializes into the native instruction file) but
with `MemoryStore`'s **provenance + agent-writability**. They are *not* memory: memory is knowledge an agent chooses to
recall; a practice **changes how future agents behave whether or not anyone recalls it**, because it is baked into the
system context at spawn. That "always-on, self-applied" property is precisely why practices are **higher-risk than
memory** (§2.6) and why writes above account scope are gated.

### 2.2 `PracticeStore` (new file `apps/hub/src/practices.ts`)

Model it on `MemoryStore` (`memory.ts`) for provenance + scope-agnostic persistence, and on `InstructionStore`
(`instructions.ts`) for the materialize step. Scope keys are the **shared scheme** used by instructions/memory/identity:
`global | vendor:<provider> | project:<projectId> | account:<profileId>`.

```ts
export interface Practice {
  id: string
  scope: string
  title: string
  body: string
  fromSession: string | null      // provenance: authoring session
  fromProfile: string | null      // provenance: authoring account/profile
  createdAt: string
  updatedAt: string
  revokedAt?: string | null        // soft-revoke (operator) — kept for audit, excluded from materialize
}
```

- Table `practices (id PK, scope, title, body, fromSession, fromProfile, createdAt, updatedAt, revokedAt)`, index on
  `(scope, updatedAt DESC)` — identical shape to `memories` (`memory.ts:46-52`) plus `revokedAt`.
- `write({ scope, title, body, fromSession, fromProfile })`, `edit(id, patch)`, `get(id, scopes?)`,
  `list({ scopes?, includeRevoked? })`, `revoke(id)` (operator), `remove(id)` (operator). The `scopes?` filter on
  reads mirrors `MemoryStore.get`/`query` (`memory.ts:86-122`) so agent reads are ACL-constrained.
- Constructed in `index.ts` next to the others (`index.ts:41-43`): `const practices = new PracticeStore(journal.db)`,
  passed into `SessionManager` (`index.ts:44`) and `startServer` (`index.ts:83`).

### 2.3 MCP tools — `practice_write` / `practice_edit` / `practice_read` / `practice_list`

Added to `buildAgentMcpServer` (`agentTools.ts:47-147`), alongside the memory tools, so they inherit the identity
binding (`identityOf(record)`, `sessions.ts:201`) — every write is attributed to the real caller, never agent-supplied.
`AgentServices` gains a `practices: PracticeStore` field (like `memory`, `agentTools.ts:21`).

- **`practice_write`** — `{ title, body, scope?: 'account'|'project'|'global'|'vendor', tags? }`. Description phrased
  as the *need* (per `tool-affordance.md §1`): *"Record a durable working convention so future agents on this
  {account|project} follow it automatically — e.g. a build/test command, a house style, a 'always do X before Y' rule.
  Account scope applies to your own future sessions; project/global scope affects teammates and needs operator
  approval."* Scope resolution reuses/extends `resolveWriteScope` (`agentTools.ts:28-32`) to also accept `global` /
  `vendor:<provider>`.
- **`practice_edit`** — `{ id, title?, body? }`. Same gate as write (editing a project/global practice is as impactful
  as writing one).
- **`practice_read`** — `{ id }` — read one, ACL-scoped to `readableScopes(identity)` (`identity.ts:35-39`). **Safe →
  auto-allowed** (§1.6).
- **`practice_list`** — `{ scope? }` — list the practices this identity can see. **Safe → auto-allowed.**

### 2.4 Materialization — a separate, labeled, revocable block

Today `create()` materializes exactly one managed region (`sessions.ts:239-242` → `writeManagedInstructions`,
`instructions.ts:106-135`), containing `agentContract(provider)` + the operator instruction union
(`instructions.materialize`, `instructions.ts:46-57`). Practices must appear **in their own clearly-delimited block**,
never intermixed with operator text, so an operator (or an auditing agent) can always tell operator intent from
agent-authored convention — and revoke the latter without touching the former.

- Add `PracticeStore.materialize({ provider, projectId, profileId })` mirroring `InstructionStore.materialize`
  (`instructions.ts:46-57`): union the applicable scopes general→specific (`global`, `vendor:<provider>`,
  `project:<id>`, `account:<profileId>`), excluding `revokedAt != null`. Render **each practice with its provenance**:

  ```
  <!-- AllMyAgents AGENT-AUTHORED practices (written by agents, not the operator — auditable & revocable in Settings) -->

  ### [project] Always run `pnpm -w typecheck` before reporting done
  _authored by session 3f9c… (profile codex-b) · 2026-07-22 · scope project:ams_
  <body…>

  <!-- /AllMyAgents AGENT-AUTHORED practices -->
  ```

- Keep this block **distinct from** the operator block (`instructions.ts:90-91` `BEGIN`/`END`). The cleanest edit is to
  generalize `writeManagedInstructions` (`instructions.ts:106`) to write **two labeled regions** — an operator region
  and a practices region — each independently strip-and-replaced (the existing idempotent regex strip at
  `instructions.ts:115-117` becomes two strips). `sessions.ts:239-242` composes both:
  `const practiceText = this.practices.materialize({ … })` then hand both texts to the writer.
- The provenance line is what makes practices **auditable** (who taught this?) and the labeled fence is what makes them
  **revocable** (operator deletes the practice → next spawn's block no longer contains it; a running session is
  unaffected until re-spawn, same lifecycle as instructions today).

### 2.5 Permission gradient

Scope determines blast radius, so scope determines the gate. Implement inside each `practice_write`/`practice_edit`
handler using the §1 self-gate:

| Target scope | Blast radius | Gate | Rationale |
|---|---|---|---|
| **`account:<own profileId>`** | your own future sessions | **auto-allow** (record provenance; light) | symmetric with `memory_write` to your account (`identity.ts:45-49`); self-affecting, low-risk |
| **`project:<id>`** | every teammate on the project | **operator approval** (`selfGate`, §1.3) | changes how *other* agents behave |
| **`global` / `vendor:<provider>`** | the entire fleet | **operator approval** (`selfGate`) + treat as operator-curated by default | fleet-wide; today `global`/`vendor` are operator-only for memory (`identity.ts:45-48`) — practices keep that bar, but *allow* an agent to *propose* via the gate |

- Account writes: the handler writes directly, journaling `practice/wrote` with provenance. No prompt.
- Project/global/vendor writes: the handler calls `selfGate(services, identity, 'practice/write', { scope, title, body })`
  → blocks on the operator → writes only on approval. Because it self-gates, this holds **even in `full`** and is
  **hard-denied on bus turns** (§1.3-1.4). The approval payload carries the concrete `{ scope, title, body }` so the
  operator judges the actual convention, not just "a practice write" (same provenance-on-the-prompt principle as
  `inter-agent-comms.md §6.4`).
- Writing above your own account is *proposing*, not *doing*: an agent can never unilaterally change teammates' or the
  fleet's behavior.

### 2.6 Why practices are higher-risk than memory

Memory is **recalled** — a memory sits in SQLite doing nothing until an agent calls `memory_search` (`memory.ts:97`)
or a future hub-side recall step surfaces it (`tool-affordance.md §4`); its influence is opt-in, per-turn, and
bounded. A practice is **materialized into the system context of every future agent** — its influence is automatic,
standing, and fleet-scoped. That makes practices a **persistence / self-propagation vector**: an agent that writes a
project practice has changed the durable behavior of all future agents on that project, and (unlike a memory) nobody
has to choose to recall it for it to take effect. That is desirable (durable conventions are the point) *and* dangerous
(a poisoned or over-broad practice quietly steers the fleet). The three mitigations — **provenance on every entry, a
separate labeled/revocable block, and the scope-gradient gate** — are what keep the upside without the ambient risk.
It is strictly a rung below hooks (§3): a practice shapes *what the model is told*; a hook *runs code*.

---

## 3. Hook registry

### 3.1 What it is, and why it is the top tier

A **hook** is a command wired to fire on an event in the agent runtime (e.g. Claude Code's `PreToolUse` /
`PostToolUse` / `Stop` hooks, or a subagent lifecycle hook). Unlike a practice (text) or a memory (data), a hook is
**executable** — approving one grants the agent a way to run code **automatically, unattended, on future events**,
outside the per-tool approval loop. This is the highest blast radius in the whole design, so:

- **`hook_propose` ALWAYS requires explicit per-hook operator approval** via the §1 self-gate — **never** auto-approved
  regardless of scope, **never** from a bus turn (hard-deny), **never** silently applied.
- Hooks are the **clearest case of the native-tools invariant** (`agent-native-tools.md §5.2`,
  `emulated-agent-tools.md §5.2`): an executable capability that must be impossible to trigger from an untrusted turn
  and impossible to run without the operator.

### 3.2 `HookStore` (new file `apps/hub/src/hooks.ts`)

Per-account/project store of hook definitions and their approval state:

```ts
export interface Hook {
  id: string
  scope: string                     // account:<profileId> | project:<projectId>  (no global/vendor for executables)
  event: string                     // e.g. 'PreToolUse' | 'PostToolUse' | 'Stop' | 'SubagentStop'
  matcher?: string                  // tool/name/glob the hook fires on (event-specific)
  command: string                   // the executable + args (the dangerous part)
  status: 'proposed' | 'approved' | 'rejected' | 'disabled'
  fromSession: string | null        // provenance
  fromProfile: string | null
  createdAt: string
  approvedAt?: string | null
  approvedBy?: 'operator'
}
```

- Table `hooks (id PK, scope, event, matcher, command, status, fromSession, fromProfile, createdAt, approvedAt)`.
- Deliberately **narrower scope set than practices**: `account` and `project` only. There is no `global`/`vendor` hook
  — a fleet-wide auto-running command is too much standing power to expose even behind a gate.
- Constructed and threaded exactly like `PracticeStore` (`index.ts:41-44,83`).

### 3.3 `hook_propose` / `hook_list`

Added to `buildAgentMcpServer`; **not** in the auto-allow set (they are in `SELF_GATING`, §1.6).

- **`hook_propose`** — `{ event, matcher?, command, scope?: 'account'|'project' }`. The handler **always**
  `selfGate(services, identity, 'hook/propose', { event, matcher, command, scope })` — no scope is exempt, unlike
  practices. Description (affordance) is honest about the ceremony: *"Propose a hook — a command that runs
  automatically on an event (e.g. before every file edit). Every proposal needs explicit operator approval before it
  can ever run; describe exactly what the command does."* On approval, the store records `status:'approved'` and the
  hub applies it (§3.4); on denial, nothing is written to any settings file.
- **`hook_list`** — `{ scope? }` — list hooks + their status this identity can see. **Safe (read) → auto-allowed.**
- Because `hook_propose` self-gates, it is gated **even under `full`** and **hard-denied on bus turns** — a poisoned
  repo file or teammate message can never get a hook proposed, let alone approved.

### 3.4 Applying an approved Claude hook — mechanism + the recommended safer path

Two mechanisms exist; the second is safer and recommended.

**(A) settings.json hooks (the mechanism the task names — confirm via spike).** Claude Code reads hook definitions from
`settings.json`: **user-level** in `CLAUDE_CONFIG_DIR` (which the hub already sets to the profile dir,
`adapters/claude.ts:55`) and **project-level** in `.claude/settings.json` in the cwd (our agents run in the session
worktree/cwd, `record.cwd`). So an approved hook written by the hub into a hub-managed `settings.json` **should** fire
on the next turn. **Two things to confirm on a real machine (spike):**

1. **Which settings file the SDK `query()` actually honors, and whether `settingSources` must be set.** The Agent SDK
   `query()` exposes `settingSources: ['user','project','local']` (noted in `agent-native-tools.md §3.2`); today
   `adapters/claude.ts` does **not** set it, so the SDK default applies. Confirm whether user-level
   (`CLAUDE_CONFIG_DIR/settings.json`) hooks are read by default, or whether the hub must pass `settingSources`
   including the source it wrote to. **Prefer writing to the user-level (profile-dir) settings** the hub already owns
   over the project `.claude/settings.json`, because enabling `settingSources:['project']` would *also* pull in any
   repo-committed `.claude/settings.json` — an **injection surface** (a hostile repo could ship its own hooks). If we
   must use project settings, the hub should write to a hub-owned location and keep project settings off unless
   explicitly intended.
2. **That a hook written mid-session takes effect** (next turn vs. next spawn) — Claude reads settings at session
   start; a hook may only fire after the driver re-initializes. Acceptable (mirrors instruction/practice materialize,
   which also applies at spawn), but confirm the timing so the UI sets the right expectation.

**(B) hub-mediated `options.hooks` (recommended primary).** The SDK also accepts **programmatic hooks** via
`options.hooks` (documented as currently unset in `docs/agent-visualization.md:283-284`, where the visualization design
plans to register `SubagentStart/Stop` hooks through it). This is the **safer** execution path for approved hooks: the
hub registers a *single* in-process dispatcher as `options.hooks` (in `adapters/claude.ts` alongside `mcpServers` at
`:69`), and when an event fires, the dispatcher looks up the session's **approved** hooks in `HookStore` and executes
the approved command **itself** — so the hub stays in the loop on every invocation. That buys, for free, the things
raw settings.json hooks cannot give us: a **live kill switch** (§3.6), **per-invocation journaling/audit**, **sandbox
control**, and **no arbitrary shell string handed to the vendor runtime to run unmediated**. Recommendation: **applying
an approved hook = registering it in `HookStore`; execution = the hub's `options.hooks` dispatcher**, with the raw
settings.json path (A) kept only if a spike shows an event we need is unreachable via `options.hooks`.

### 3.5 Codex hooks — investigate, likely a follow-up

Codex's programmatic surface is the `app-server` JSON-RPC our `CodexClient` drives (`adapters/codex.ts`). Its
config lives in `config.toml` under `CODEX_HOME` (`adapters/codex.ts:112`). Codex exposes a **`notify`** program in
`config.toml` (a command run on certain notifications, e.g. turn completion / approval prompts) — but that is a
coarse notification sink, **not** a general pre/post-tool hook system, and nothing in the app-server vocabulary we use
(`thread/*`, `turn/*`, `account/*`) registers event hooks. **Verdict: no general Codex hook mechanism is cleanly
reachable from our driver today** — scope Codex hooks as a **follow-up / spike** (does `notify` suffice for any hook we
actually want? is there an app-server hook-registration method? — unverified). Until then: Codex agents can **receive**
practices materialized into `AGENTS.md` (§2.4) but cannot author hooks, and the hub does not write Codex hooks. This
mirrors how Codex already *receives* bus messages but has no MCP tools yet (`tool-affordance.md §6`,
`instructions.ts:83-86`).

### 3.6 Sandboxing, audit, kill switch

- **Sandbox / least privilege.** An approved hook runs with the hub's privileges in the session cwd. Constrain it:
  run via the hub-mediated dispatcher (§3.4B) with a restricted env, a timeout, output captured (not streamed to a
  shell), and — for the computer/browser era — on the same sandbox substrate the emulated-tools doc recommends
  (`emulated-agent-tools.md §3.3`), never the operator's host by default. Never expand the hook's reach beyond the
  event payload it needs.
- **Audit.** Every lifecycle transition journals through the single `journal.append` choke point (with `redact()`):
  `hook/proposed`, `approval/requested` (via the self-gate), `hook/approved` | `hook/rejected`, `hook/fired`
  (per invocation, with exit code + captured output size), `hook/disabled`. Replay + the operator transcript come for
  free (same as every event; `store.svelte.ts` `apply()`).
- **Kill switch.** Two levels, both hub routes (origin+token guarded like every `/api`, `server.ts:184-200,264`):
  a **per-hook disable** (`status:'disabled'` → dispatcher skips it; if path (A) is ever used, the hub also strips it
  from the managed `settings.json`) and a **global "disable all hooks"** panic that flips every hook to disabled and
  clears any managed settings block. Because approved hooks execute through the hub's dispatcher (§3.4B), the kill
  switch is **immediate** — the next event simply finds nothing approved to run. (This is the decisive advantage over
  raw settings.json hooks, which keep firing until the file is rewritten and the session re-reads it.)

### 3.7 The single biggest risk

**One approval buys standing, unattended code execution.** Every other gate in the system is *per-action*: each file
edit, each bus-driven turn, each browser click is judged on its own. A hook inverts that — the operator approves
**once**, and thereafter the command runs **automatically on every matching future event, across future sessions, with
no further prompt.** That makes a single approved hook a **bootstrap out of the entire gating model**: it can re-enable
a disabled capability, rewrite other hooks or practices, exfiltrate on a `PostToolUse`, or simply persist the agent's
influence indefinitely. The whole of §3's ceremony — always-approve, never-auto, never-bus, hub-mediated execution,
per-invocation audit, immediate kill switch, and showing the operator the **exact command** at approval time — exists
to compensate for the fact that with hooks, the approval is not a gate on an action but a gate on a **capability that
then acts on its own.**

---

## 4. Cross-cutting: the per-project / per-account config store

Instructions, memory, practices, hooks, and (future) per-scope MCP config are five facets of **one concept: a
per-project/per-account configuration store** — the central, scoped home for everything that shapes an agent spun up
under that project or account. They already share the **scope-key scheme**
(`global | vendor:<provider> | project:<id> | account:<profileId>`) across `instructions.ts`, `memory.ts`, and
`identity.ts`; practices and hooks adopt it unchanged (hooks minus `global`/`vendor`, §3.2). Framing them as one store
pays off concretely:

- **One materialize pass.** At spawn (`sessions.ts:239-242`) the hub already composes `agentContract` + operator
  instructions; it now composes **operator instructions + agent practices** into the two labeled regions (§2.4). Memory
  joins via hub-side recall (`tool-affordance.md §4`); hooks join via the settings/`options.hooks` application (§3.4).
- **One operator surface.** A single "Config" area in Settings (extending today's instructions editor,
  `SettingsModal.svelte:26-42,316-328`) with a **scope selector** and tabs for Instructions / Memory / Practices /
  Hooks — each showing entries at that scope, with provenance, and revoke/approve controls. This is where an operator
  audits what the fleet has taught itself.
- **One ACL.** `readableScopes`/`writableScopes` (`identity.ts:35-49`) already express who-sees-what; practices reuse
  the readable set and the writable set + the §2.5 gate gradient; hooks reuse the readable set for `hook_list` and the
  always-gate for propose.

This doc does **not** build a unified store object — it adds `PracticeStore` and `HookStore` as siblings of the
existing stores (matching the codebase's one-store-per-concern shape) — but it aligns them so a later consolidation
(and the "config store" mental model in the operator UI) is a refactor, not a redesign.

### Tool-affordance treatment (per `docs/tool-affordance.md`)

- **Descriptions phrased as the need**, not mechanics (§2.3, §3.3) — the affordance *is* the description
  (`tool-affordance.md §0-1`). The risky tools' descriptions state the ceremony plainly ("needs operator approval",
  "every proposal is reviewed") so the model's expectation matches reality.
- **`alwaysLoad` vs `searchHint`.** `practice_read`/`practice_list`/`hook_list` are tiny and occasionally relevant →
  load with the core (`tool-affordance.md §3`). `practice_write` is tiny and need-matched → load. **`hook_propose` is
  rare and heavy-consequence → defer behind tool search with a strong `searchHint`** ("propose an automated hook that
  runs on an event"), so it costs zero context until a task actually calls for it and is not dangled in every turn's
  manifest. The **risky tools are discoverable but self-gating** — discovery (a good description/searchHint) and
  authority (the operator gate) are independent axes, exactly as `tool-affordance.md §5` frames for the native tools.

---

## 5. Security gradient (the whole model on one page)

| Capability | Store | Agent write | Gate | Bus turn | Under `full` | Blast radius | Reversible |
|---|---|---|---|---|---|---|---|
| **Memory** (exists) | `memory.ts` | ✅ free, within writable scopes (`identity.ts:45-49`) | none (ACL only) | allowed (data, not action) | writes freely | inert until recalled | delete note |
| **Practice — account** | `practices.ts` | ✅ auto-allow | none (provenance recorded) | **hard-deny** | self-gates n/a (auto) | your future sessions | revoke (labeled block) |
| **Practice — project/global/vendor** | `practices.ts` | propose only | **operator approval** (self-gate §1) | **hard-deny** | **still gated** (in-process self-gate) | teammates / fleet | revoke (labeled block) |
| **Hook (propose)** | `hooks.ts` | propose only | **operator approval, ALWAYS, per hook** | **hard-deny** | **still gated** | unattended code execution | disable / kill switch |
| **Native browser/computer** (future) | out-of-process MCP | call only | approval + **force gate-live mode** (§1.5) | **hard-deny** | **must clamp out of bypass** | highest | per-call + capability off |

The single rule underneath the table: **the more durable and the more executable a write is, the higher the gate — and
nothing that persists or executes may ever originate from a bus turn.** Memory is free because it is neither durable-in-
prompt nor executable; practices are scope-gated because they are durable-in-prompt; hooks are always-approved because
they are executable; native tools force gate-live mode because their handlers are out of process and cannot self-gate.

---

## 6. Ordered implementation plan

**Phase 1 — gate-live fix (prerequisite; small, high-value, ship alone).**
1. Extend `AgentServices` with `requireApproval` + `isBusTurn` (`agentTools.ts:14-22`); implement in
   `agentServices()` (`sessions.ts:64-71`).
2. Add `busTurnSessions: Set<string>` + the `origin` param on `runClaudeTurn`/`runCodexTurn`
   (`sessions.ts:372,407`); set `'bus'` in `deliverBus` (`sessions.ts:569-570`).
3. Narrow the `:188` auto-allow to `AUTO_ALLOW` + add the `SELF_GATING` branch with the bus hard-deny (§1.6); journal
   `approval/auto-denied-bus` (render it in `store.svelte.ts` next to `approval/auto-denied-scope`, `:783-789`).
4. State + enforce the out-of-process rule (§1.5) as the guard the native-tools work (already scoped in
   `emulated-agent-tools.md`) will consume: never emit `bypassPermissions`/`'never'` for a capability-on turn.
5. **Spike:** confirm on the installed SDK/app-server that `bypassPermissions` really skips `canUseTool` and
   `approvalPolicy:'never'` really fires no `onApproval` (if either still calls back, the self-gate is
   belt-and-suspenders; if not — as expected — it is load-bearing).

**Phase 2 — practices.**
6. `practices.ts` (`PracticeStore`), constructed + threaded (`index.ts:41-44,83`).
7. `practice_write/edit/read/list` in `agentTools.ts` with the §2.5 gradient (account auto, project/global/vendor
   `selfGate`).
8. `PracticeStore.materialize` + generalize `writeManagedInstructions` to two labeled regions (`instructions.ts:106`);
   compose in `create()` (`sessions.ts:239-242`).
9. Server routes (`/api/practices` GET/POST, revoke) mirroring the instruction/memory routes (`server.ts:387-422`);
   `api.ts` client methods (mirror `instructions`/`memory`, `api.ts:274-281`).
10. Operator surface: Practices tab in Settings with provenance + revoke (`SettingsModal.svelte`).

**Phase 3 — hooks.**
11. `hooks.ts` (`HookStore`), constructed + threaded.
12. `hook_propose` (always `selfGate`) + `hook_list` in `agentTools.ts`; `hook_propose` deferred behind `searchHint`.
13. Application: register the hub-mediated `options.hooks` dispatcher in `adapters/claude.ts` (`:69`) reading approved
    `HookStore` entries; **spike** the settings.json path (A) only if an event is unreachable via `options.hooks`.
14. Kill switch routes (per-hook disable + global panic) + audit events; approval UI shows the exact command.
15. Codex hooks: investigate `notify`; scope as follow-up if no general mechanism is reachable.

Ship Phase 1 independently — it closes a real hole (any current `full` session with the coming risky tools) and is
prerequisite to 2 and 3.

---

## 7. File-by-file change list

**New files:**

| File | Purpose |
|---|---|
| `apps/hub/src/practices.ts` | `PracticeStore` — scoped, provenance-carrying, agent-writable; `materialize()` for the labeled block |
| `apps/hub/src/hooks.ts` | `HookStore` — per-account/project executable hooks + approval state |

**Edits:**

| File | Change |
|---|---|
| `apps/hub/src/agentTools.ts` | Extend `AgentServices` (`:14-22`) with `requireApproval` + `isBusTurn` (+ `practices`/`hooks` refs). Add `selfGate` helper (§1.3). Add `practice_write/edit/read/list` and `hook_propose/hook_list` tools (§2.3, §3.3) with need-phrased descriptions; extend `resolveWriteScope` (`:28-32`) for `global`/`vendor`. `hook_propose` gets `alwaysLoad:false` + `searchHint`. |
| `apps/hub/src/sessions.ts` | Implement `requireApproval`/`isBusTurn` in `agentServices()` (`:64-71`). Add `busTurnSessions` + `origin` param on `runClaudeTurn`/`runCodexTurn` (`:372,407`), set `'bus'` in `deliverBus` (`:569-570`). Narrow the `:188` auto-allow → `AUTO_ALLOW`/`SELF_GATING` (§1.6). Compose practices in `create()` materialize (`:239-242`). Enforce the §1.5 gate-live clamp for capability-on turns. Journal `approval/auto-denied-bus`, `practice/*`, `hook/*`. |
| `apps/hub/src/adapters/claude.ts` | Register the hub-mediated `options.hooks` dispatcher (`:69`, alongside `mcpServers`) for approved hooks (§3.4B). Ensure a capability-on turn never sets `bypassPermissions` (`:64-65`). |
| `apps/hub/src/adapters/codex.ts` | Ensure `approvalPolicy` never `'never'` for a capability-on turn (`sendTurn`, `:191-198`). Codex hooks: follow-up (§3.5). |
| `apps/hub/src/instructions.ts` | Generalize `writeManagedInstructions` (`:106-135`) to write **two** independently-stripped labeled regions (operator + agent-practices), each idempotent. |
| `apps/hub/src/identity.ts` | (If practice/hook write-scope validation is centralized) extend `writableScopes` semantics for the practice gradient; add a `hookScopes` helper (`account`/`project` only). Reads reuse `readableScopes`. |
| `apps/hub/src/server.ts` | Routes mirroring instructions/memory (`:387-422`): `/api/practices` (GET/POST/revoke), `/api/hooks` (GET/propose-list/approve/disable), kill-switch routes — all under the existing origin+host+token guards (`:184-200,264`). |
| `apps/hub/src/index.ts` | Construct `PracticeStore`/`HookStore` (`:41-43`); pass into `SessionManager` (`:44`) and `startServer` (`:83`). |
| `apps/hub/src/types.ts` | `Practice` / `Hook` interfaces (or in their own files); if native-tools land in parallel, the `nativeTools` capability + gate-live plumbing referenced by §1.5 (already scoped in `emulated-agent-tools.md`). |
| `apps/web/src/lib/api.ts` | Client methods for practices + hooks (mirror `instructions`/`memory`/`decide`, `:266,274-281`); `Practice`/`Hook` types. |
| `apps/web/src/lib/SettingsModal.svelte` | Practices tab (list by scope + provenance + revoke) and Hooks tab (list + status + approve/disable/kill), extending the instructions editor (`:26-42,316-328`). |
| `apps/web/src/lib/store.svelte.ts` | Render `approval/auto-denied-bus`, `practice/*`, `hook/*` events (next to `approval/auto-denied-scope`, `:783-789`); surface hook-proposal approvals in the existing approval flow (`:699-701`). The approval card must show the concrete practice/command payload. |

---

## 8. Unverified / needs a real-machine spike

- **The gate-disabling behavior (§1.1, Phase 1 step 5).** That Claude `bypassPermissions` skips `canUseTool` and Codex
  `approvalPolicy:'never'` fires no `onApproval` is the documented/expected behavior; **confirm on the installed
  versions** before relying on the self-gate as load-bearing. (Carried from `emulated-agent-tools.md §8`.)
- **Claude hook activation from `query()` (§3.4).** Whether user-level (`CLAUDE_CONFIG_DIR/settings.json`) hooks are
  honored by the SDK by default or require `settingSources`, and whether `options.hooks` reaches the events we want
  (`PreToolUse`/`PostToolUse`/`Stop`/subagent). The visualization design already assumes `options.hooks` works for
  `SubagentStart/Stop` (`agent-visualization.md:283-284`) but it is **currently unset** — verify end-to-end. **Prefer
  the hub-mediated `options.hooks` path**; treat writing raw shell into `settings.json` as the fallback, and never
  enable `settingSources:['project']` casually (it ingests repo-committed hooks — an injection surface).
- **Mid-session hook application timing (§3.4).** Does an approved hook fire on the next turn, or only after driver
  re-init / re-spawn? Sets the UI expectation.
- **Codex hook mechanism (§3.5).** Whether `config.toml notify` (or any app-server method) can carry a hook we'd
  actually want; today no general pre/post-tool hook is reachable from the app-server driver — treated as a follow-up.
- **`settingSources` interaction with the managed instruction/practice files.** We write `CLAUDE.md`/`AGENTS.md`
  directly (not via settings), so this is orthogonal — but confirm no `settingSources` change needed for hooks also
  perturbs how the SDK reads `CLAUDE.md`.

---

## Sources

Internal (grounding, current code):
- `apps/hub/src/agentTools.ts` — `AgentServices` (`:14-22`), `resolveWriteScope` (`:28-32`), `buildAgentMcpServer` +
  the six existing tools, `textResult` convention (`:24-26`)
- `apps/hub/src/sessions.ts` — `agentServices()` (`:64-71`), `checkWriteScope` (`:111-122`), Codex `onApproval`
  (`:156-161`), Claude `canUseTool` + the `mcp__allmyagents__*` auto-allow (`:185-198`, `:188`), MCP wiring (`:201`),
  spawn materialize (`:239-242`), `runClaudeTurn`/`runCodexTurn` + Codex `approvalPolicy` (`:372-427`, `:419`),
  `deliverBus` (`:551-571`), `clampMode` (`:666-668`), `frameBusMessages` (`:672-688`)
- `apps/hub/src/approvals.ts` — `ApprovalService.request` (`:22-38`, fail-closed timeout `:5,33-35`), `resolve` (`:40-42`)
- `apps/hub/src/instructions.ts` — `InstructionStore.materialize` (`:46-57`), `agentContract` (`:68-88`),
  `writeManagedInstructions` + `BEGIN`/`END` (`:90-91`, `:106-135`)
- `apps/hub/src/memory.ts` — `MemoryStore` schema + provenance (`fromSession`/`fromProfile`, `:61-83`), scope-filtered
  reads (`:86-122`)
- `apps/hub/src/identity.ts` — `readableScopes` (`:35-39`), `writableScopes` (`:45-49`)
- `apps/hub/src/adapters/claude.ts` — permission-mode mapping / `bypassPermissions` (`:64-65`), `canUseTool`/`mcpServers`
  forwarding (`:66-69`), `CLAUDE_CONFIG_DIR` (`:55`)
- `apps/hub/src/adapters/codex.ts` — `onApproval` dispatch (`:157-160`), `sendTurn` `approvalPolicy` (`:191-198`),
  `CODEX_HOME` (`:112`)
- `apps/hub/src/server.ts` — instruction/memory routes (`:387-422`), approval routes (`:432-434`, `:487-493`),
  origin/host/token guards (`:184-200`, `:264`)
- `apps/hub/src/index.ts` — store construction + wiring (`:41-44`, `:83`)
- `apps/web/src/lib/{api.ts,SettingsModal.svelte,store.svelte.ts}` — the operator surfaces the new tabs extend
  (`api.ts:266,274-281`; `SettingsModal.svelte:26-42,316-328`; `store.svelte.ts:699-701,783-789`)
- `docs/tool-affordance.md` — descriptions-as-affordance, `alwaysLoad`/`searchHint`, discovery⊥authority
- `docs/agent-native-tools.md` / `docs/emulated-agent-tools.md` — the native-tools hard invariant (bus-hard-deny,
  never-auto-approve) and the `full`-mode gate-disabling finding this doc fixes first (`emulated §0/§5.2/§5.3`)
- `docs/inter-agent-comms.md` — the semi-trusted-teammate trust model + provenance-on-the-prompt; `docs/memory-system.md`
  — the scoped store; `docs/agent-visualization.md` — SDK `options.hooks` currently unset (`:283-284`)
