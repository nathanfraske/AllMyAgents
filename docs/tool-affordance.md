# Tool affordance — getting fleet agents to use our MCP tools organically, without nagging or context rot

Design scope, drafted 2026-07-24. **No code changed — read-only on `apps/hub/src` and the Agent SDK type defs.**
This doc answers one question: how do the hub-managed agents (Claude via `@anthropic-ai/claude-agent-sdk`, Codex via
`codex app-server`) come to **use** our MCP tools — the inter-agent bus, shared memory, and the future
browser/computer/visualization tools — **when they actually need them**, *without* (a) a system-prompt directive that
forces use, and (b) standing "reminders" that rot the context window. It builds directly on the mechanisms in
`agentTools.ts` (`tool()` + `createSdkMcpServer`), `instructions.ts` (`agentContract`), and `sessions.ts` (per-session
tool wiring + push bus delivery), and it composes with the trust model in `docs/inter-agent-comms.md`, the scoped
store in `docs/memory-system.md`, and the capability gate proposed in `docs/agent-native-tools.md`.

---

## 0. Verdict (read this first)

**A well-named tool with a good `description` is the affordance. That is the whole mechanism.** Models reach for a
tool when its description matches the need in front of them — the same way this very session reached for `Read` and
`Grep`. That is *stronger* than a system prompt that says "you must use X," and it does not decay over a long session.
So the investment is in **tool names, descriptions, and (for deferred tools) `searchHint`** — not in prose that tells
the agent to use them.

Five concrete recommendations for this codebase:

1. **Descriptions do the discovery.** Keep the tool `description` fields phrased as *the need* ("search shared memory
   for a past decision or fact you or a teammate recorded"), not as mechanics. That is what makes the model pick them
   up unprompted.
2. **Slim the contract to trust-only.** `agentContract('claude')` currently enumerates the tools in prose
   (`instructions.ts:87-91`). **Drop that list.** It duplicates the schemas the model already sees, and the
   "search before re-deriving" line is a behavioral nudge that biases toward spurious calls. **Keep** the
   trust/security paragraph — that is *not* discoverable from any tool description and genuinely needs to be stated
   once.
3. **Core tools `alwaysLoad`, heavy tools tool-searched.** Our six coordination tools are tiny and always relevant —
   load them. The future browser/computer/viz tools are large and rarely relevant — defer them behind tool search
   (`alwaysLoad:false` + `searchHint`) so they cost **zero** context tokens until the model searches for them.
4. **Automatic memory recall is the single biggest lever.** The bus is already **push** (messages arrive as injected
   turns → the agent just responds). Memory is still **pull** (the agent must think to call `memory_search`). Move it
   to **push too**: a hub-side recall step that surfaces relevant memories into the turn when they are relevant,
   mirroring the SDK's own `SDKMemoryRecallMessage` supervisor. This is what makes an agent "use memory when it needs
   it" without ever being told to.
5. **Never re-nag per turn.** The contract is written **once** into `CLAUDE.md`/`AGENTS.md` and read as cached system
   context — it is *not* re-sent each turn. Do not add per-turn reminders, and do not re-list tools inside the
   bus-delivery frame. The two justified standing costs are the one-time trust contract and the bus frame's trust
   caveat (load-bearing at the moment untrusted content arrives) — nothing else.

**Do we need to remind them at all?** For well-described tools, **no.** Discovery is a property of the tool schema,
not the prompt. The only thing the one-time contract must carry is what a description *can't* express: that teammate
messages are semi-trusted and confer no authority.

---

## 1. How a model actually decides to use a tool

When a tool is loaded, the model sees its **name + `description` + input schema** as part of the turn's tool
manifest. It selects a tool the same way it selects a word: the description that best matches the current need wins.
There is no separate "should I use tools" step to prod. This is why:

- **A good description beats a system-prompt directive.** "You must use `send_message` to coordinate" fires
  *regardless* of need (spurious calls) and fades as the conversation grows (a directive 40 turns back is weak
  context). A description that says *when* the tool applies fires *because* the need is present, every turn, with no
  decay. The directive pushes; the description pulls. Pull is what we want — organic use is exactly "the model reached
  for it when the description matched."
- **The lever is wording, not repetition.** Our current descriptions are already close. The upgrade is to phrase each
  around the *situation that should trigger it*, so a match is obvious:
  - `memory_search` (`agentTools.ts:123-137`): *"Search shared memory for a decision, fact, or convention you or a
    teammate recorded earlier — check here before re-deriving something that may already be known."* (The "before
    re-deriving" hint belongs **in the description**, attached to the tool that acts on it — not free-floating in the
    contract where it reads as a standing order.)
  - `send_message` (`agentTools.ts:62-80`): already good — it names the situation ("reach one agent… or broadcast").
  - `memory_write` (`agentTools.ts:98-122`): *"Save a durable decision or fact so you and your teammates can recall it
    in later turns and sessions."* — names *when* (a durable decision), not just *what*.
- **The MCP server `instructions` field is a second, cheap affordance.** `createSdkMcpServer({ instructions })`
  (`agentTools.ts:43-46`) is surfaced to the model as a one-line "what this server is for." Keep it to a terse purpose
  line. **Do not** put the trust paragraph here too — see §2 on avoiding triplication.
- **For deferred tools, `searchHint` is the description.** A tool behind tool search is not in the manifest; the model
  sees only a searchable index entry. `tool(name, desc, schema, handler, { searchHint })` (`sdk.d.ts:6895-6899`) is
  the text the model matches against when it searches. So heavy tools still get discovered *by need* — the affordance
  just moves from `description` (always present) to `searchHint` (matched on search). Invest there identically.

**Implication:** budget effort into names/descriptions/`searchHint`. Budget **zero** effort into prose that says "use
your tools." The models already want to; our job is to make the match legible.

---

## 2. Do we need to remind them? Mostly no — and the contract is not a "reminder" anyway

There is a persistent confusion worth killing: the `agentContract` block is **not re-sent every turn.** It is
materialized **once** into the session's `CLAUDE.md`/`AGENTS.md` at spawn (`writeManagedInstructions`,
`instructions.ts:112-141`; called at `sessions.ts:240`) and thereafter read as **cached system context**. So "are we
reminding them too much?" is really "what should that one-time block contain?" — a content question, not a frequency
question.

The answer splits cleanly by *discoverability*:

| Content | Discoverable from a tool description / schema? | Keep in the one-time contract? |
|---|---|---|
| *That* the tools exist and what each does | ✅ yes — that's literally the schema | ❌ **drop** (redundant; biases use) |
| *When* to use a tool | ✅ yes — put it in the description (§1) | ❌ drop from prose |
| Teammate messages are **semi-trusted**, reach ≠ authority | ❌ **no** — nothing in a `send_message` schema says this | ✅ **keep** |
| Only the **operator** authorizes permission/destructive changes | ❌ no | ✅ keep |
| The `<<ALLMYAGENTS-BUS>>` frame is the hub's un-forgeable provenance mark | ❌ no | ✅ keep |

So: **keep the trust/collaboration framing, drop the tool cheerleading.**

### Concrete change to `instructions.ts`

`agentContract('claude')` (`instructions.ts:85-93`) today emits a bulleted tool catalogue **and** the trust
paragraph. Cut it to the trust paragraph — which makes the Claude and Codex branches nearly identical (both are now
trust-only), a simplification in its own right:

- **Remove** the `- list_agents … - send_message … - memory_write / memory_search / memory_read …` bullets
  (`instructions.ts:87-91`), including "Save durable decisions; search before re-deriving" (that hint now lives on the
  tool descriptions, §1).
- **Keep** the `trust` string verbatim (`instructions.ts:69-76`).
- **Optional, defensible:** retain a *single* neutral capability-existence sentence — "You have a teammate bus and a
  shared team memory available as tools" — for the one case it helps: **deferred** tools whose schemas are *not* in
  the manifest, so the model needs a hint they exist to search for them. This is one sentence of existence, not a
  how-to list, and it never says "use them." Once memory recall is automatic (§4) and the bus is push, even this is
  marginal; treat it as the maximum, not a floor.

### Avoid triplicating the trust rule

The trust rule currently appears in **three** places: the contract (`instructions.ts:69-76`), the server
`instructions` field (`agentTools.ts:43-46`), and the bus-delivery frame (`sessions.ts:590-593`). Two are justified,
one is redundant:

- **Contract** — keep. Durable, provider-symmetric, covers Codex (which has no MCP server to carry an `instructions`
  field).
- **Bus frame** — keep. It is load-bearing *at the moment untrusted content arrives* (`docs/inter-agent-comms.md`
  §6.5). But it should **not** enumerate tools; the trailing "reply with the `send_message` tool" line
  (`sessions.ts:593`) is a borderline tool-mention — acceptable as an action pointer for *this* message, trimmable if
  we want purity (the model already has `send_message` loaded).
- **Server `instructions` field** — **trim** to a bare purpose line ("Tools to coordinate with teammate agents and a
  shared memory"). Drop the trust half; it triplicates the contract.

---

## 3. Context rot — the two sources and the SDK levers that fix them

Context rot here has exactly two sources:

1. **Tool schemas consuming the window every turn.** Every *loaded* tool's name + description + JSON schema sits in
   the prompt on every turn. Six tiny tools is cheap; a browser server (15+ tools, large schemas) or a computer/viz
   server is not. Left unmanaged, an "off" capability would still tax every turn.
2. **Repeated in-band reminders.** Anything injected into the turn stream every time — a re-stated tool list, a
   standing "remember to use memory" — is pure recurring cost and (worse) trains the model to tune it out.

The SDK gives us precise levers for (1), and discipline handles (2).

### Lever: `alwaysLoad` vs tool search

- `createSdkMcpServer({ alwaysLoad })` (`sdk.d.ts:493-500`) and per-tool `tool(…, { alwaysLoad })`
  (`sdk.d.ts:6898`) control whether a server's tools are **always in the prompt** or **deferred behind tool search**.
  Server-level and per-tool are OR'd. Default when tool search is enabled: **deferred**.
- Deferred tools cost ~nothing up front; the model pulls a schema in only when a search matches its `searchHint`.

**Recommendation for the current `allmyagents` server: load it (`alwaysLoad: true`).** It is small, its tools are the
organic-coordination core, and — importantly — deferring tiny tools buys almost no tokens while adding a real risk if
tool-search is not active under our subscription auth (§8, flagged). The rot problem is **not** our six tools; it is
the *future* heavy servers. Split the decision by weight:

| Tool / server | Weight | Recommendation | Why |
|---|---|---|---|
| `send_message` | tiny | **`alwaysLoad`** | The reply affordance; the bus is push, replies must be frictionless |
| `memory_search` | tiny | **`alwaysLoad`** | The primary organic pull (until recall is automatic, §4) |
| `memory_write` | tiny | **`alwaysLoad`** | Reached for when a decision is made — need-matched, cheap |
| `list_agents` | tiny | `alwaysLoad` | Prerequisite for a *directed* `send_message`; small |
| `read_messages` | tiny | load, but **reconsider** | Delivery is already push (`deliverBus`), so pulling the inbox is largely redundant; a candidate to defer or retire |
| `memory_read` | tiny | load or defer | Follow-up to `memory_search` (which already returns 300-char bodies); safe to defer behind a `searchHint` |
| **browser server** (`docs/agent-native-tools.md`) | heavy | **`alwaysLoad:false` + `searchHint`** | 15+ tools; relevant only for web tasks |
| **computer server** | heavy | **`alwaysLoad:false` + `searchHint`** | Highest-risk, rarely needed |
| **visualization server** | medium | **`alwaysLoad:false` + `searchHint`** | Only when the agent is producing a chart/diagram |

**A free win for us:** the `alwaysLoad` docs warn it "blocks startup until the server is connected (capped at 5s)"
(`sdk.d.ts:1027`). That penalty is for *external* MCP servers. Our `allmyagents` server is **in-process**
(`createSdkMcpServer`, wired at `adapters/claude.ts:69` / `sessions.ts:200`) — connection is synchronous, so
`alwaysLoad` on it costs no startup time. Loading the core is genuinely free.

### Discipline: no per-turn re-listing

For source (2): **do not** re-list tools in the bus frame (`frameBusMessages`, `sessions.ts:579-595`) or in any
per-turn injection. The bus frame keeps its trust caveat (justified) and nothing else. The memory-recall block (§4)
carries *recalled content*, never a "you have a memory tool" reminder. The rule: an injected turn may carry **data**
(a message, a recalled fact) but never a **tool advertisement**.

### Measuring the rot itself

The SDK's usage report exposes per-tool token accounting: `mcpTools: [{ name, serverName, tokens, isLoaded? }]` and
`deferredBuiltinTools: [{ name, tokens, isLoaded }]` (`sdk.d.ts:3067-3077`). We can read exactly how many tokens each
tool costs and whether it was loaded or deferred — so "did deferring the heavy servers actually shrink the prompt" is
directly measurable, not a guess (§7).

---

## 4. Push vs pull — automatic recall is the biggest single lever

The two subsystems sit on opposite sides of the push/pull line, and that difference *is* the whole "organic use"
story:

- **Bus = push (already organic).** `deliverBus` (`sessions.ts:461-481`) injects queued teammate messages as **one
  turn**, wrapped in the trust frame, permissions clamped. The agent doesn't need to *remember* to check for messages
  — the message *is* the turn, and it responds naturally, the way it responds to a user. **No reminder is possible or
  needed.** This is the model to copy.
- **Memory = pull (not yet organic).** Nothing surfaces a relevant memory; the agent must *think* to call
  `memory_search`. A good description (§1) helps at the margin, but "remembering to search" is exactly the fragile,
  easily-forgotten behavior we don't want to depend on. This is the gap.

**Close it by making memory push, like the bus: automatic recall.** The SDK already models this. `SDKMemoryRecallMessage`
(`sdk.d.ts:3964-3987`) is *"emitted when the memory recall supervisor surfaces relevant memories into the turn"* —
`type:'system'`, `subtype:'memory_recall'`, with a `mode`:

- **`'select'`** — full memory bodies chosen by a parallel selector (returns the file bodies),
- **`'synthesize'`** — a Sonnet-authored paragraph distilled from many tiny memories.

That is precisely the "surface it when relevant instead of relying on the agent to search" behavior we want.

### Build it hub-side (recommended)

Our scoped store (`MemoryStore`, `memory.ts`) and identity ACL (`readableScopes`, `identity.ts:35-39`) already have
everything a recall step needs. **Emulate the supervisor in the hub**, at the start of each turn:

1. Take the incoming turn text — the user's prompt (`runClaudeTurn`/`runCodexTurn`, `sessions.ts:282-337`) or the bus
   frame — as the recall query.
2. Run `memory.search(query, { scopes: readableScopes(identity), limit: k })` (`memory.ts:97-99`) — already
   ACL-scoped to what this session may read.
3. If hits, prepend a compact **`Recalled from memory`** block to the turn (mirroring `mode:'select'` — titles +
   short bodies, exactly what `memory_search` already formats at `agentTools.ts:133-135`). Cap it hard (top-k, byte
   budget) so it never dominates the window.
4. Journal it as a first-class event so the UI can render a "Recalled from memory" card (the SDK renderer's own
   convention), and so recall quality is auditable.

Why hub-side rather than the SDK's own supervisor:

- **Provider-symmetric.** Codex has *no* SDK recall at all (§6). A hub-side step serves both providers from one code
  path — the same reason the bus and memory already live hub-side (`docs/memory-system.md`).
- **It reads *our* store.** The SDK supervisor recalls from on-disk **auto-memory** files
  (`autoMemoryDirectory`, default `~/.claude/projects/<sanitized-cwd>/memory/`; `sdk.d.ts:6414-6417`), with scopes
  `personal | team | organization` (`sdk.d.ts:3979`). That is **not** our SQLite store and **not** our
  `global|vendor|project|account` scopes. The SDK's recall would simply not see anything we curated.
- **Full control** over frequency, budget, and shape — and it can be gated/skciped on cheap turns.

A later refinement mirrors `mode:'synthesize'`: when there are many small memories, a cheap model pass distills them
to a paragraph rather than dumping k rows — this is the same "cheap reminders" idea already in
`docs/memory-system.md` §8, now applied to *recall* instead of *capture*.

### How the SDK's own recall interacts with ours

They are **parallel, not competing** — different stores, different scopes. If we ever want the SDK's supervisor as an
*additive* Claude-only layer, the only bridge is to **materialize this session's readable scopes into
`autoMemoryDirectory`** at spawn (a per-session view the supervisor can select from) and set `autoMemoryEnabled: true`
(`sdk.d.ts:6410-6413`) in the `query()` options. That is awkward — the SDK also *writes* to that directory
(auto-capture) and would interleave its notes with our curated ones — so treat the SDK-native path as an optional
experiment, not the plan. **Flag:** whether the supervisor even engages under our subscription auth is unverified
(§8). Our hub-side recall does not depend on that answer.

**Net:** bus is push (done); make memory push too (hub-side recall). After that, the agent "uses memory when it needs
it" with **zero** instruction to do so — the single highest-leverage change in this doc.

---

## 5. How this scales to browser / computer / visualization tools

The heavy tools from `docs/agent-native-tools.md` are where the affordance strategy and the context-budget strategy
converge. Two orthogonal gates, and an "off" capability must cost nothing:

1. **Tool-search deferral (context cost).** Each heavy server is its own `alwaysLoad:false` MCP server with a strong
   per-tool `searchHint`. When idle it contributes **zero** prompt tokens; when the task matches ("open the page and
   read the console"), the model's tool search surfaces it. Discovery stays *by need* — the same pull mechanism as a
   loaded description, just indexed.
2. **Per-session capability gate (permission cost).** `docs/agent-native-tools.md` §5 already specifies a
   `SessionRecord.nativeTools` toggle (off by default) enforced in `canUseTool`/`onApproval` and **hard-denied inside
   bus-caused turns**. That gate composes cleanly with deferral:

| Capability state | Up-front context | Discoverable via tool search? | If called |
|---|---|---|---|
| **off** (default) | zero (deferred) | withhold from the search index → **not discoverable** | n/a |
| **on** | zero until searched | yes, via `searchHint` | routes through the approval gate |

The important property: an **off** capability is not merely unapproved, it is **invisible** — deferral means its
schemas aren't in the prompt, and gating the search index means the model isn't even told it *could* search for them.
An **on** capability is discoverable exactly when relevant and still fully approval-gated. This is the clean answer to
"how do we add powerful tools without either taxing every turn or dangling them where a poisoned turn could reach
them": defer for cost, gate for safety, and the two combine to make off-cost-zero / on-when-relevant.

Visualization is the mildest case (medium schema, low risk) and a good first mover to validate the deferral +
`searchHint` path end-to-end before wiring the high-risk browser/computer servers.

---

## 6. Codex — same principles, fewer knobs

The affordance principle is identical on the Codex side — a Codex MCP tool is chosen by its **description** just like a
Claude one — but the delivery mechanics and the levers differ:

- **No in-process SDK server.** Codex tools must be a **real MCP process** referenced in the profile's
  `config.toml [mcp_servers]` under `CODEX_HOME` (`docs/inter-agent-comms.md` §4.1, `docs/agent-native-tools.md` §7),
  not an in-process `createSdkMcpServer`. **This wiring does not exist yet** — today Codex only *receives* bus
  messages, via injected turns, and has no `memory_*`/`send_message` tools (`instructions.ts:66`, the `agentContract`
  Codex branch is trust-only by necessity). Building that MCP bridge is prerequisite to any of this applying to Codex.
- **AGENTS.md gets the same slim trust contract.** Already true (`instructions.ts:77-83`) — and after §2's cut, the
  Claude and Codex contracts converge on the same trust-only shape.
- **Tool-selection is the same; the deferral knob may not be.** We can invest in descriptions/`searchHint` in the
  MCP server we run, but `alwaysLoad`/tool-search are **Agent-SDK** concepts. Whether `codex app-server` exposes any
  `defer_loading` equivalent is **unverified** (§8) — it may load all configured MCP tools unconditionally. If so, the
  discipline for Codex is simply to **run fewer, leaner MCP servers** and lean harder on descriptions, since we can't
  defer.
- **Recall must be hub-side for Codex.** There is no `SDKMemoryRecallMessage` on the Codex path at all. The §4
  hub-side recall step (injected as a turn prefix) is the *only* way Codex gets automatic recall — another reason to
  build recall hub-side rather than lean on the SDK supervisor.

**What we can't control on Codex:** its internal tool-selection policy and any built-in deferral. **What we can:** the
tool descriptions, how many servers we mount, the AGENTS.md trust contract, and the hub-side recall + push-bus turns.
That is enough for organic use; it just has fewer efficiency knobs than the Claude path.

---

## 7. What to measure

The hypothesis is falsifiable, so measure it. All of this is available from the journal + the SDK usage report; note
the honest observability limit first.

- **Observability limit.** Claude withholds thinking text on subscription accounts (established during P1 — the
  adapter only ever sees a signature, `adapters/claude.ts` token path). So we **cannot** read the model's stated
  reason for choosing a tool. We measure **behavior** (call counts, tokens, outcomes), not intent. Design the metrics
  around that.
- **Prompt/tool token cost, before vs after deferral.** Read `mcpTools[].tokens` / `deferredBuiltinTools[].tokens` +
  `isLoaded` from the usage report (`sdk.d.ts:3067-3077`). Expectation: deferring the heavy servers drops per-turn
  tool tokens toward the `allmyagents`-only floor; an "off" capability shows `tokens: 0` / not loaded.
- **Spurious calls, before vs after slimming the contract.** Count tool calls that don't advance the task — chiefly
  gratuitous `memory_search`/`list_agents` at turn start — from the journal (`bus/*`, tool-use events). Hypothesis:
  dropping the "search before re-deriving" prose and the tool-list bullets **reduces** reflexive calls (the directive
  was manufacturing them). This is the core claim: *does dropping the nag reduce spurious calls and tokens?*
- **Recall displacing manual search.** After hub-side recall ships: does `memory_search` call volume fall (recall now
  supplies the context the agent used to fetch by hand) while memory-informed answers hold or rise? Track
  `memory_search` invocations/turn and whether a recalled memory was referenced in the response.
- **Discovery under deferral.** For a task that *should* use a deferred tool, does the model actually surface it via
  tool search? If deferred tools are never pulled in when relevant, `searchHint` wording is wrong — or tool-search
  isn't active under our auth (§8), which is a correctness failure, not a tuning issue.
- **A/B the contract.** Spawn matched sessions with the current (tool-listing) contract vs the trust-only contract on
  the same task set; compare spurious calls, tokens, and task success. Cheap to run with the existing spawn path.

---

## 8. What I could not verify (needs a spike)

- **Tool search under subscription auth.** The `alwaysLoad` docs describe deferral as active "when tool search is
  enabled" (`sdk.d.ts:1027`) but don't say whether tool search is on for **claude.ai `/login` subscription** accounts
  via the SDK, or whether it's an API-key/enterprise feature. **This gates everything in §3 and §5** — if tool search
  is *off* under our auth, deferred (`alwaysLoad:false`) tools would never be loadable and would silently vanish. Spike
  first: mount a trivial deferred tool, confirm the model can search it up, before deferring anything load-bearing.
- **Is the SDK memory-recall supervisor drivable from our `query()` usage?** Whether setting `autoMemoryEnabled` +
  `autoMemoryDirectory` (`sdk.d.ts:6410-6417`) actually causes `SDKMemoryRecallMessage` to be emitted under our auth,
  and whether `autoDreamEnabled` (`sdk.d.ts:6418-6421`) consolidation runs, is unconfirmed — these read as possibly
  server-gated. Our §4 hub-side recall **does not depend** on this, but if we want the SDK layer as an additive
  Claude-only path, verify it emits, and that `SDKMemoryRecallMessage` surfaces through our `for await` loop
  (`adapters/claude.ts:73-87`) as a `type:'system' / subtype:'memory_recall'` message we can journal.
- **`alwaysLoad` OR-semantics + the 5s connect-block on an in-process server.** Confirm server-level +
  per-tool `alwaysLoad` OR as documented (`sdk.d.ts:497-499`), and confirm the "blocks startup until connected"
  caveat (`sdk.d.ts:1027`) truly doesn't bite our in-process `createSdkMcpServer` (expected: instant connect, no
  penalty — but verify before relying on it).
- **Codex deferral.** Whether `codex app-server` has any `defer_loading` / tool-search equivalent, or loads all
  configured MCP tools unconditionally (§6). Determines whether Codex context management is "defer" or "mount fewer
  servers."
- **Withholding a deferred tool from the search index when a capability is off.** §5 assumes we can keep an
  off-capability tool *out of the searchable index* (not just deny it on call). Confirm the mechanism — it may require
  simply not mounting the server for that session (cleanest), rather than a per-tool index flag.

---

## 9. Concrete changes this doc implies

| File | Change |
|---|---|
| `apps/hub/src/instructions.ts` | `agentContract('claude')` (85-93): **remove** the tool-list bullets + "search before re-deriving" (87-91); **keep** the `trust` paragraph (69-76). Optionally keep one neutral "you have a teammate bus + shared memory as tools" existence line (for deferred-tool discovery only). Claude/Codex branches converge on trust-only. |
| `apps/hub/src/agentTools.ts` | Set the `allmyagents` server `alwaysLoad: true` (small, in-process, free to load). Reword `description`s around *the triggering need* (§1), esp. `memory_search`/`memory_write`. Trim the server `instructions` field (43-46) to a bare purpose line — drop the trust half (triplication). When heavy servers are added, give them their own `alwaysLoad:false` server + per-tool `searchHint`. Consider deferring/retiring `read_messages` (push makes it redundant) and `memory_read` (follow-up to search). |
| `apps/hub/src/sessions.ts` | **Add a hub-side recall step** (§4): before `runClaudeTurn`/`runCodexTurn` (282-337), `memory.search(turnText, { scopes: readableScopes(identity) })`, prepend a capped `Recalled from memory` block, journal it. Keep `frameBusMessages` (579-595) free of tool lists; the trust caveat stays, the "reply with send_message" line (593) is trimmable. |
| `apps/hub/src/adapters/claude.ts` | If pursuing the SDK-native recall experiment: pass `autoMemoryEnabled`/`autoMemoryDirectory` in `options` (58-69) and handle `type:'system' subtype:'memory_recall'` in the message loop (73-87). Otherwise unchanged. |
| `apps/hub/src/adapters/codex.ts` / `config.toml` | Prerequisite for any Codex tool use: mount the coordination MCP via `config.toml [mcp_servers]` under `CODEX_HOME` (§6); hub-side recall (in `sessions.ts`) covers Codex automatically since it's injected as a turn prefix. |
| Journal / usage plumbing | Emit a `session/memory-recall` event for the recall block; read `mcpTools[].tokens`/`isLoaded` from the usage report for the §7 measurements. |

---

## Sources

Internal:
- `apps/hub/src/agentTools.ts` — `createSdkMcpServer` + `tool()` definitions, server `instructions` field, the six coordination tools
- `apps/hub/src/instructions.ts` — `agentContract(provider)` (the one-time contract), `writeManagedInstructions` (materialize-once)
- `apps/hub/src/sessions.ts` — per-session MCP wiring (200), `mcp__allmyagents__` auto-allow (187), push delivery `deliverBus` (461-481), `frameBusMessages` (579-595), `clampMode` (573)
- `apps/hub/src/adapters/claude.ts` — `options.mcpServers` forwarding (69), the `query()` message loop (73-87)
- `apps/hub/src/memory.ts` — `MemoryStore.search` (the recall query); `apps/hub/src/identity.ts` — `readableScopes` (recall ACL)
- `docs/inter-agent-comms.md` — bus push delivery, the trust frame and why its caveat is load-bearing (§6.5)
- `docs/memory-system.md` — the scoped store, auto-capture, and "cheap reminders" (§8, which §4 mirrors for recall)
- `docs/agent-native-tools.md` — the browser/computer/viz servers and the per-session capability gate this doc defers behind tool search

Agent SDK (`@anthropic-ai/claude-agent-sdk/sdk.d.ts`):
- `alwaysLoad` — `createSdkMcpServer` option (493-500), per-tool `tool()` extra (6895-6899), server-connect caveat (1027)
- `searchHint` — per-tool `tool()` extra (6897)
- `SDKMemoryRecallMessage` — the recall supervisor's output shape, `mode:'select'|'synthesize'`, scopes `personal|team|organization` (3964-3987)
- `autoMemoryEnabled` / `autoMemoryDirectory` / `autoDreamEnabled` — SDK-native auto-memory config (6410-6421)
- usage-report `mcpTools` / `deferredBuiltinTools` — per-tool token + `isLoaded` accounting for the §7 measurements (3067-3077)
