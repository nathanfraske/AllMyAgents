# Vendor app-level tooling — what the host apps give agents beyond the bare CLI/SDK harness

Design scope, drafted 2026-07-24. **Scoping only — no code changed; read-only on `apps/hub/src` and
`profiles/`.** Web research used to pin the vendors' *current* (mid-2026) product state, because app-level
tooling changes fast and training data goes stale. **Secondary to a parallel T3Code study; this doc focuses
on the two vendors** (Claude/Anthropic, Codex/OpenAI). It asks a broader question than the sibling docs: not
"can our agents use one specific native harness" but **"what tools / MCP servers / skills / slash commands /
capabilities does the vendor *application* inject that a bare `claude` (Agent SDK `query()`) or `codex`
(`codex app-server`) invocation — the two drivers our hub actually runs — does NOT get automatically, and
what should AllMyAgents do to close the gap."**

It builds on and cross-references, rather than repeats: `docs/agent-native-tools.md` + `docs/emulated-agent-tools.md`
(computer/browser control + native visualization), `docs/vendor-remote-control.md` (phone→session, the
SDK-vs-CLI / managed-vs-unmanaged surface-mismatch pattern this doc re-encounters), `docs/agent-visualization.md`
(the hub's own render surfaces), `docs/codex-workflows.md` (Codex Skills as recipes), and the built
in-process tool server `apps/hub/src/agentTools.ts`. It composes with the **self-gate / bus-hard-deny /
operator-approval** security model from `docs/practices-hooks-gating.md` and the **data-not-instructions**
trust model from `docs/inter-agent-comms.md`.

**Methodology / confidence.** A rare, strong evidence source anchors the Claude side: **this research session
is itself running inside a live instance of the Claude host application**, so its injected tool / skill / MCP
manifest is *first-hand, confirmed* ground truth for what the app layers on top of the CLI. That is combined
with the authoritative Agent SDK docs, current web research, and **direct inspection of this repo's own
`profiles/` and adapters**. Every claim below is tagged **[confirmed]** (first-hand or official docs or repo
code), **[web]** (secondary/product write-ups, moves fast), or **[inferred / spike]**.

---

## 0. Verdict (read this first)

**The hub deliberately drives the *leanest* tier of each vendor, and each vendor stacks substantial
app-level value above that tier — but the two gaps are lopsided, and that asymmetry is the headline.**

| | Hub's driver | How far below the full vendor app it sits | Biggest missing value |
|---|---|---|---|
| **Codex** | `codex app-server` (`adapters/codex.ts`), `CODEX_HOME`=profile | **Close.** The app-server **auto-loads the bundled skills the profile ships** — `imagegen` (native `image_gen`/`view_image` tools), the `artifact-template-*` document set, `review-agent`, `skill-creator`/`skill-installer`, `openai-docs`, and the `github` recipes — plus a native `memories` store. Our Codex agents are already fairly rich. | Computer use, browser, Codex-cloud tasks, the plugin **marketplace/connectors** — all app-only (per `agent-native-tools.md`). |
| **Claude** | Agent SDK `query()` (`adapters/claude.ts`) | **Far.** `query()` gives the core tool loop (Read/Write/Edit/Bash/Glob/Grep/WebSearch/WebFetch/Monitor/Task) but the profiles **ship no skills and enable no plugins**, so our Claude agents get **no skill library at all**. Meanwhile the desktop/Cowork app injects a large MCP suite none of our sessions see. | The **curated skill library** (pdf/docx/xlsx/pptx/dataviz/deep-research), **Artifacts** publish + inline **visualize** widget, **scheduled tasks**, **session-management** tools, **connectors registry**, **file connectors**, **spawn-task/chapters**. |

So **our Codex agents are close to their vendor's floor; our Claude agents are far below theirs.** The
single highest-leverage gap is therefore **Claude skills** — bringing our Claude sessions to the parity our
Codex sessions already enjoy from bundled skills.

**Two findings that are true *today*, silently, and un-surfaced (both [confirmed] against repo config):**
1. **claude.ai MCP connectors are NOT suppressed for our Claude sessions.** They load whenever the session
   authenticates with a claude.ai login (which our profiles do), *regardless of `settingSources`*, and
   `profiles/claude-a/.claude.json` has `"tengu_claudeai_mcp_connectors": true`. The hub sets none of the
   three kill-switches (`strictMcpConfig` / `disableClaudeAiConnectors` / `ENABLE_CLAUDEAI_MCP_SERVERS=false`),
   and passing `mcpServers` (which we do at `claude.ts:69`) explicitly does **not** suppress them. So the
   operator's Google Drive / Gmail / Slack connectors *may already be reachable* by hub Claude agents,
   unrecognized by our code and routed to the **vendor cloud** — the exact relay the mesh premise distrusts.
2. **Vendor auto-memory is on by default** for both drivers (Claude writes to `CLAUDE_CONFIG_DIR/projects/*/memory/`;
   Codex has `profiles/codex-a/memories_1.sqlite`), **separate from** the hub's own memory (`memory.ts` +
   `mcp__allmyagents__memory_*` + `autoMemoryRecall`). Two memory systems run in parallel, uncoordinated.

**Recommended priorities** (detail in §5): **P0** verify the three live-today behaviours on the installed
versions. **P1** provision a **hub-curated, scope-governed skill set for Claude** (close the asymmetry) and
make a **deliberate decision on connectors + vendor auto-memory** (embrace-and-surface, or disable-for-isolation
behind a Danger-Zone toggle — never silent). **P2** a **hub-owned scheduler** (self-hosted automations, no
vendor cloud) and folding **document-skill artifacts** into the render tiers `agent-native-tools.md §6`
already designs. **P3** native/app-only escape hatches (image-gen, computer/browser, connector marketplace) —
defer or gate.

---

## 1. The tier model — where the hub sits, and why the gap is uneven

Each vendor ships the same agent in **three tiers**, and value accretes at each step. The hub attaches at
the *lowest programmable* tier on purpose (principle 2 — own the process; principle 5 — no vendor relay), so
everything above that tier is a candidate gap.

| Tier | **Claude** | **Codex** | Hub attaches here? |
|---|---|---|---|
| **A — programmable driver** | Agent SDK `query()` (`@anthropic-ai/claude-agent-sdk`) | `codex app-server` (JSON-RPC over stdio) | **Yes, both.** `adapters/claude.ts`, `adapters/codex.ts` |
| **B — full CLI** | `claude` interactive CLI | `codex` CLI | No (but shares tier-A internals + filesystem config) |
| **C — desktop / web app** | Claude Desktop / **Cowork** / claude.ai | Codex desktop app / Codex web (cloud) | No |

**The crucial nuance that makes the two gaps different sizes:**

- **Codex's tier A is close to tier B.** Skills, AGENTS.md, MCP servers, hooks, and the native tool built-ins
  (shell exec, `image_gen`, `view_image`) are all read from `CODEX_HOME` / the plugin cache — files that ship
  *in the profile* — so the **app-server auto-loads them**. Our Codex sessions inherit most of tier B for
  free. Codex's tier C adds mainly *surfaces that are not tools*: computer use, the built-in browser, cloud
  delegation, the GUI marketplace (all established app-only in `agent-native-tools.md`).
- **Claude's tier A is far below tier B/C for us — not because the SDK is weak, but because our profiles are
  bare.** `query()` *would* discover skills/CLAUDE.md/hooks by default (see §2.1), but
  `profiles/claude-*/settings.json` is literally `{"theme":"dark"}`, no `skills/` dir exists, and no plugins
  are enabled — so **nothing loads**. And tier C's injected MCP suite (which this session sees first-hand,
  §2.4) never touches the SDK.

So the same architectural choice (drive the lean tier) costs us far more on the Claude side than the Codex
side, purely because Codex packs value into profile files the app-server reads and Claude packs it into
app-layer MCP the SDK doesn't.

---

## 2. Claude — what the app provides beyond the Agent SDK

### 2.1 Tier-A baseline: what a hub Claude session actually gets today [confirmed]

`adapters/claude.ts` calls `query({ prompt, options })` with only: `env` (`CLAUDE_CONFIG_DIR`=profile), `cwd`,
`resume`, `model`, `permissionMode`, `canUseTool`, and `mcpServers` (the in-process `allmyagents` server).
It sets **no** `settingSources`, `skills`, `plugins`, `agents`, `hooks`, `strictMcpConfig`, or
`disableClaudeAiConnectors`. Consequences, each grounded in the official *"Use Claude Code features in the
SDK"* doc:

- **Core tools are present:** Read, Write, Edit, Bash, Glob, Grep, **WebSearch**, **WebFetch**, **Monitor**
  (background process obs.), **Task** (subagents), AskUserQuestion. So web search/fetch and native subagents
  are **not** gaps — the hub already has them. `[confirmed]`
- **`settingSources` omitted ⇒ equals `["user","project","local"]`** — the SDK *does* load CLAUDE.md, rules,
  filesystem skills, hooks, and slash commands **by default**, from `CLAUDE_CONFIG_DIR` (user) and `cwd/.claude`
  (project). The catch: our profiles ship none of these, so discovery finds nothing. **The lever is
  provisioning, not a flag.** `[confirmed]` *(Flag: some ecosystem write-ups claim the Agent-SDK default was
  changed to `[]`; the current official doc says user+project+local — verify on the installed SDK version, §6.)*
- **Loaded regardless of `settingSources` (the silent-today surfaces):**
  - **Auto-memory** at `CLAUDE_CONFIG_DIR/projects/<project>/memory/`, injected into the system prompt at
    session start, written with ordinary Write/Edit. On unless `autoMemoryEnabled:false` /
    `CLAUDE_CODE_DISABLE_AUTO_MEMORY=1`. The hub disables neither. `[confirmed]`
  - **claude.ai MCP connectors** under a claude.ai login (see §0 finding 1). `[confirmed: gate on;
    inferred: whether accounts have connectors configured]`
  - Managed policy settings + global `~/.claude.json` (relocated via `CLAUDE_CONFIG_DIR`). `[confirmed]`

### 2.2 Tier-B additions (full CLI) not wired for us

| Capability | What it is | In SDK `query()`? | Hub today | Confidence |
|---|---|---|---|---|
| **Skill discovery + the Anthropic skill library** | `SKILL.md` recipes, model-invoked; the official marketplace is enabled by default in the CLI | **Discovery yes (default); library no** | Profiles ship no skills, enable no plugins → **zero skills active** | `[confirmed]` |
| **Plugins / marketplaces** | Bundle skills + hooks + MCP + commands; `~/.claude/skills`, `.claude/skills`, or plugin install | Via `plugins` option or filesystem | Marketplace **cache** exists under `profiles/claude-*/plugins/marketplaces/…staging/` (asana, context7, github, gitlab, linear, playwright, serena, discord/telegram/imessage, security, plugin-dev…) but **none enabled** | `[confirmed]` |
| **Slash commands** | `/…` user-invocable prompts; custom commands in `.claude/commands` | Yes if settingSources loads them | None provisioned; hub has its own composer, not agent-invocable commands | `[confirmed]` |
| **Agent teams** | One CLI session as "team lead" coordinating independent teammates with a shared task list + direct messaging | **No — CLI-only, not SDK-configurable** | Hub built its **own** equivalent: `agentTools.ts` bus (`list_agents`/`send_message`/`read_messages`) + `inter-agent-comms.md` | `[confirmed]` |
| **Native computer use** (`computer-use` MCP) | Control native macOS apps | **No — interactive-only, excludes `-p`/SDK; macOS-only** | Covered/deferred in `agent-native-tools.md §3.1` | `[confirmed]` |
| **Claude in Chrome** (`claude-in-chrome` MCP) | Browser control; subscription-auth only | Wireable via `mcpServers` (spike) | Covered in `agent-native-tools.md §3.2`, `emulated-agent-tools.md` | `[confirmed]` |
| **Hooks** (filesystem) | `command`/`http`/`mcp_tool`/`prompt`/`agent` on lifecycle events; SDK adds `SessionStart/End`, `TeammateIdle`, `TaskCompleted` | Yes (filesystem via settingSources, or programmatic) | Not wired; `practices-hooks-gating.md` designs the hub's own gating instead | `[confirmed]` |

### 2.3 Tier-C additions (desktop / Cowork / claude.ai) — observed first-hand in this session [confirmed]

The app injects a large suite of MCP servers, built-in tools, and skills **on top of** the SDK. This
research session's own manifest is the enumeration (server namespaces verbatim):

| App-injected surface | Namespace / name (observed) | What it gives the agent | Hub analog / gap |
|---|---|---|---|
| **Artifacts (publish)** | `Artifact` tool | Render HTML/Markdown to a **default-private, shareable hosted web page** on claude.ai, with declared **runtime capabilities** (live data, shared state, self-update) | Hub renders its **own** transcript (`agent-visualization.md`); **no hosted/shareable publish, no runtime-capable artifact**. Gap. |
| **Inline visualization** | `mcp__visualize__show_widget` / `read_me` | Emit SVG/HTML widgets that render **inline in the chat** (charts, diagrams, mockups, interactive tools) | `agent-native-tools.md §6` designs inline Mermaid/SVG render; **the vendor's is a richer, first-class widget tool**. Partial gap. |
| **Scheduled tasks** | `mcp__scheduled-tasks__{create,list,update,delete}` | Cron-style recurring agent runs | No hub scheduler today (`codex-workflows.md` designs a sequential runner, not a cron). **Gap (P2).** |
| **Session management** | `mcp__ccd_session_mgmt__{list_sessions,get_session,list_events,search_session_transcripts,send_message,set_session_title,archive_session}` | Agent-invocable tools to **list / read / search / archive / title / message other sessions** | Hub owns the session graph (`sessions.ts`) + bus, but **exposes no session-management tools to agents**. Gap (cautious). |
| **Background task chips** | `mcp__ccd_session__{spawn_task,dismiss_task,mark_chapter,read_widget_context}` | Flag out-of-scope work as spin-off tasks; chapter the transcript; read embedded widgets | No hub equivalent. Minor/UX gap. |
| **Directory access** | `mcp__ccd_directory__request_directory` | Request access to a filesystem directory | Hub scopes worktrees itself (`checkWriteScope`). Covered differently. |
| **Connector registry** | `mcp__mcp-registry__{search_mcp_registry,suggest_connectors,list_connectors}` | Discover + suggest installable MCP connectors from Anthropic's directory (**369+ entries, mid-2026**) | Hub has no connector registry. Gap (P3, large). |
| **File connector (Drive-class)** | `mcp__<connector-id>__{search_files,read_file_content,download_file_content,create_file,copy_file,get_file_metadata,get_file_permissions,list_recent_files}` | Read/search/create files in a hosted store (Google-Drive-shaped) | The **claude.ai-connector surface** §0 finding 1 warns about — vendor-cloud file access. Gap + governance. |
| **Built-in extras** | `NotebookEdit`, `SendMessage`, `EnterWorktree`/`ExitWorktree`, `TaskStop`, `Monitor` | Jupyter edits; teammate messaging; git-worktree management; task control; bg-process monitoring | Hub has worktrees (`workspace`) + bus + interrupt; `NotebookEdit` is a genuine small gap. Mostly covered. |
| **Curated skill library** | Skills: `pdf`, `docx`, `xlsx`, `pptx`, `dataviz`, `deep-research`, `artifact-design`, `artifact-capabilities`, `skill-creator`, `consolidate-memory`, `claude-api`, `update-config`, `run`, `init`, `review`, `security-review`, `simplify`, `loop`, `schedule`, `morning`, `keybindings-help`, `setup-cowork`, `fewer-permission-prompts` | Document creation/editing (Office + PDF), data-viz systems, multi-source verified research, memory consolidation, etc. | **The single biggest Claude gap** — our Claude sessions have **none** of these (§2.2). P1. |
| **Memory** | `MEMORY.md` auto-memory (visible in this session's context) + `consolidate-memory` skill | Persistent cross-conversation memory with a reflective consolidation pass | Hub has its own memory (`memory.ts`); vendor auto-memory also on (§0 finding 2). Dedupe needed. |

**Net for Claude:** the SDK gives a strong tool loop and native subagents/web tools, but the app's *durable
value* — the document/research **skills**, hosted **artifacts**, **scheduled** runs, **connectors**, and
**session-management** tools — lives at tiers B/C and reaches none of our sessions. The lowest-effort,
highest-value slice is **skills**, because discovery is already on by default — it is a provisioning +
governance task, not a protocol problem.

---

## 3. Codex — what the app provides beyond the app-server

### 3.1 Tier-A baseline the hub drives [confirmed]

`adapters/codex.ts` spawns `codex app-server` with `CODEX_HOME`=profile and drives `thread/*` + `turn/*`
(full lifecycle in `codex-workflows.md §2`). Because skills, AGENTS.md, MCP, hooks, and the native built-in
tools all resolve from `CODEX_HOME` / the plugin cache, **the app-server auto-loads what the profile ships**
— so tier A is unusually close to tier B for Codex.

### 3.2 Bundled skills + native tools the hub's Codex agents ALREADY get [confirmed, repo-inspected]

`profiles/codex-a/` ships (and the app-server should load):

- **System skills** (`skills/.system/`): **`imagegen`** — generate/edit raster images (photos, illustrations,
  mockups, sprites, transparent cutouts) via a **built-in `image_gen` tool** (no API key) with a `gpt-image-2`
  CLI fallback and a `remove_chroma_key.py` helper; it also uses a built-in **`view_image`** tool. Plus
  `review-agent`, `skill-creator`, `skill-installer`, `plugin-creator`, `openai-docs`. **This is a genuine
  app-level capability our Claude agents have no equivalent for** (Claude Code has no native image-gen).
- **GitHub recipe skills** (plugin cache): `github`, `gh-fix-ci`, `gh-address-comments`, `yeet` (documented in
  `codex-workflows.md`).
- **Artifact-template skills** (plugin cache, `openai-templates`): ~20 `artifact-template-*` recipes
  (analytics-dashboard, three-statement-forecast, investment-committee-memo, legal-memorandum, sales-pipeline,
  operating-review, project-tracker, design-report, …). Each clones a retained reference and drives a
  **"preinstalled spreadsheet capability"** — Codex's analog to Claude's `xlsx`/`pptx`/`docx` skills, i.e.
  **document generation is a bundled Codex skill our Codex agents already have** while our Claude agents do not.
- **Native memory:** `profiles/codex-a/memories_1.sqlite` (+ `goals_1.sqlite`) — a Codex-side memory store,
  separate from the hub's.

*Flag [inferred / spike]:* the skills are present and loadable, but whether the **unmanaged app-server**
exposes the built-in `image_gen` / `view_image` tools to *our* client (vs the interactive CLI / desktop app)
is unverified — `agent-native-tools.md` found other native surfaces (computer/browser) app-only. Confirm the
`image_gen` tool actually fires through `turn/*` before treating it as a shipped capability.

### 3.3 App-only additions (tier C) — established or app-bound

| Capability | Status for our app-server driver | Where covered |
|---|---|---|
| **Computer use** | App-only, not a callable app-server tool (`openai/codex#20851`) | `agent-native-tools.md §2.1` |
| **Built-in browser / Codex-for-Chrome** | App-only, "not available in Codex CLI… not accessible via app-server JSON-RPC" | `agent-native-tools.md §2.2` |
| **Codex web / cloud tasks** | Server-side; not our local process | `vendor-remote-control.md §1` |
| **Plugin marketplace + app connectors** | Plugins bundle skills+MCP+connectors; desktop/web share MCP config; marketplace is GUI. MCP servers themselves *are* wireable via `config.toml [mcp_servers]` | `agent-native-tools.md §4`; `emulated-agent-tools.md §2.4` |
| **Interactive MCP auth** (July 2026: MCP tools can request auth without an experimental opt-in) | Relevant if the hub wires authenticated MCP for Codex | `[web]` — re-verify |
| **`remote-control` / ChatGPT-app** | Managed-daemon only; won't adopt our unmanaged app-server | `vendor-remote-control.md §3` |
| **Custom prompts** (`$CODEX_HOME/prompts/*.md`) | **Deprecated** in favor of skills | `codex-workflows.md §1` |

**Net for Codex:** the app-server driver already inherits most of tier B (skills incl. image-gen + document
templates, memory, MCP wiring, hooks-in-runtime). The true app-only gaps are the *non-tool surfaces* —
computer use, browser, cloud — already scoped as deferred/emulated elsewhere. **Codex needs far less
catch-up than Claude.**

---

## 4. What AllMyAgents already covers (cross-reference map)

| Vendor app capability | Covered by (repo) | State |
|---|---|---|
| Inter-agent messaging (vs Claude "agent teams") | `agentTools.ts` (`list_agents`/`send_message`/`read_messages`), `inter-agent-comms.md` | **Built** |
| Shared memory + durable practices (vs vendor memory/skills-as-conventions) | `agentTools.ts` (`memory_*`, `practice_*`), `memory.ts`, `practices.ts` | **Built** |
| Computer control / browser control | `agent-native-tools.md`, `emulated-agent-tools.md` | Scoped (neutral MCP recommended; native as escape hatch) |
| Native visualization / artifacts render | `agent-native-tools.md §6`, `agent-visualization.md` | Scoped (own-transcript render; img-ban-safe) |
| Codex Skills as reusable recipes + host-sequenced workflows | `codex-workflows.md` | Scoped (`WorkflowStore`/`WorkflowRunner`) |
| Phone remote control | `vendor-remote-control.md` | Rejected → mesh device token instead |
| Multi-agent workflow/run/fleet visualization | `agent-visualization.md` | Scoped |
| **Claude skills provisioning** | — | **Not covered (P1 gap)** |
| **claude.ai connectors + vendor auto-memory governance** | — | **Not covered (P1 gap — live today, un-surfaced)** |
| **Scheduled tasks / automations (cron)** | partial — `codex-workflows.md` is sequential, not scheduled | **Not covered (P2 gap)** |
| **Document skills (pdf/docx/xlsx/pptx/dataviz) for Claude** | — | **Not covered (P1/P2 gap)** |
| **Hosted/shareable artifacts + runtime capabilities** | — render only, not publish | **Not covered (P3 gap)** |
| **Connector registry / marketplace** | — | **Not covered (P3 gap, large)** |
| **Native image generation for Claude** | Codex has `imagegen`; Claude has none | **Not covered (P3 gap)** |

---

## 5. Prioritized gap list with implementation sketches

Every item composes with the existing security model: **off-by-default, scope-gated, bus-hard-denied,
operator-approved**, Danger-Zone-toggleable (per the permissive-danger-zone memory: safe default + a Settings
toggle, never an un-disable-able rule).

### P0 — Verify the live-today behaviours (cheap; de-risks everything) `[spike]`
- **What actually loads in a hub Claude session now?** With the installed SDK version, confirm whether omitting
  `settingSources` really loads user+project skills (vs `[]`), and *from where* under `CLAUDE_CONFIG_DIR`
  relocation. Ask a live session "what skills/tools/connectors do you have?" and read the `system/init` event.
- **Are claude.ai connectors reaching sessions?** (`tengu_claudeai_mcp_connectors:true`.) If yes, enumerate
  which, and confirm their tool calls hit `canUseTool` (they should — only `mcp__allmyagents__*` is auto-allowed
  at `sessions.ts:187`; connector tools fall through to `approvals.request`).
- **Is Codex's `image_gen` / `view_image` built-in exposed** to our app-server client (§3.2 flag)?
- **Vendor auto-memory:** confirm Claude writes `CLAUDE_CONFIG_DIR/projects/*/memory/` and whether Codex
  `memories_1.sqlite` grows during hub runs — to size the dedupe (§P1b).

### P1a — Provision a hub-curated, scope-governed skill set for Claude (**the headline gap**) `[confirmed lever]`
- **Why:** closes the Claude-vs-Codex asymmetry (§0). Our Codex agents already have image-gen + document
  templates + review recipes from bundled skills; our Claude agents have nothing. Discovery is already on by
  default (§2.1), so this is provisioning + curation + governance, not protocol work.
- **Sketch:** the hub materializes a **curated `skills/` set into each Claude profile dir** (the `user` source
  under `CLAUDE_CONFIG_DIR`), or passes the SDK **`plugins`** option pointing at a hub-owned skills path, plus
  an explicit `skills: [...]` allow-list on `query()` (`adapters/claude.ts` options block, alongside
  `mcpServers` at line 69). Mirror the existing **`instructions.ts` materialization pattern** (SQLite source of
  truth → written into the profile), and reuse the **scope scheme** (`global | vendor:claude | project | account`)
  so a skill set is reusable and operator-editable in Settings, exactly like practices/memory.
- **Curate, don't dump.** Start with high-value, low-risk, self-contained skills: **document generation**
  (pdf/docx/xlsx/pptx analogs), **dataviz**, **deep-research**. Skills that *act* (send/publish/external) must
  carry the practice/workflow gating: **never author/enable a project/global skill from a bus turn**
  (`decidePracticeGate`-style deny-bus), operator-approval for shared scopes.
- **Provider-symmetric bonus:** the same `WorkflowStore`/skill-scope machinery `codex-workflows.md` proposes
  can drive Codex `$skill-name` steps *and* Claude skills — one hub concept, both providers.

### P1b — Make a deliberate decision on connectors + vendor auto-memory (**live today, un-surfaced**) `[confirmed]`
- **Why:** §0 findings. Both are on now, unrecognized by hub code. Connectors route to the vendor cloud (the
  relay the mesh premise distrusts); two memory systems run uncoordinated.
- **Connectors sketch (recommend disable-by-default for the self-hosted posture, toggle to opt in):** set
  `disableClaudeAiConnectors:true` (or `strictMcpConfig:true`) in the Claude options **by default**, exposing a
  per-profile **Danger-Zone toggle** "allow this account's claude.ai connectors (routes tool calls to
  Anthropic's cloud)". When on, surface the connector tool names in the UI and label their approvals as
  vendor-cloud (provenance, like `inter-agent-comms.md §6.4`). This is the safe-default-plus-toggle shape the
  permissive-danger-zone memory calls for.
- **Auto-memory sketch:** either disable vendor auto-memory (`CLAUDE_CODE_DISABLE_AUTO_MEMORY=1` in the Claude
  `env`; Codex equivalent TBD) so the **hub's** memory is the single system, **or** deliberately keep it and
  surface/ingest it. Pick one; don't run two silent memories. Ties to `memory-system.md`.

### P2a — Hub-owned scheduler (self-hosted automations) `[web-confirmed vendor feature]`
- **Why:** the vendor's `scheduled-tasks` MCP / Claude "routines" / Cowork scheduled tasks run recurring agent
  work — but on the **vendor cloud**. A self-hosted equivalent fits principle 5.
- **Sketch:** a `ScheduleStore` (SQLite, scoped) + a hub cron loop that, on schedule, drives an
  operator-authored prompt/skill/workflow as a normal turn through `runClaudeTurn`/`runCodexTurn`. Reuse the
  `WorkflowRunner` engine (`codex-workflows.md §3.3`) as the per-fire executor. **Off by default, operator-authored
  only, bus-hard-denied to create, journaled** (`schedule/*` events). No vendor relay.

### P2b — Fold document-skill artifacts into the render tiers `[extends existing scope]`
- **Why:** once Claude has xlsx/pptx/pdf/docx skills (P1a) and Codex has artifact-templates (§3.2), agents will
  write real Office/PDF artifacts to the worktree. `agent-native-tools.md §6` already designs Tier-2 (worktree
  files) capture + a sandboxed render/serve path — extend its renderable-type set to Office/PDF (download +
  optional preview), reusing the origin+token-guarded, worktree-fenced artifact endpoint. Also evaluate a hub
  **`show_widget`-style inline viz tool** as the first-class analog to `mcp__visualize__`.

### P3 — Native / app-only escape hatches (defer or gate)
- **Image generation for Claude:** no native equivalent; would need an image-gen MCP or the API (auth/metering
  fragmentation, like the computer-use API tool). Codex's `imagegen` may serve fleet-wide via a shared skill.
  Defer.
- **Computer/browser control:** already scoped in `agent-native-tools.md` / `emulated-agent-tools.md`.
- **Connector registry / marketplace + session-management tools for agents:** large; the hub already owns the
  session graph, so *read-only* session tools (list/search transcripts) could be a scoped `agentTools.ts`
  addition later — but exposing cross-session control to agents needs the full deny-bus/approval treatment and
  is not near-term.
- **Hosted/shareable artifacts:** the vendor `Artifact` publish + runtime capabilities are a claude.ai cloud
  service; a self-hosted analog is the hub's own render surface (`agent-visualization.md`) — not a vendor
  integration.

---

## 6. What I could not verify (flags)

- **SDK `settingSources` default drift.** Official current doc: omitting = `["user","project","local"]`
  (skills/CLAUDE.md/hooks load). Some 2026 write-ups claim the Agent-SDK default became `[]`. **Verify on the
  installed `@anthropic-ai/claude-agent-sdk` version** — it changes whether P1a is "provision files" or
  "provision files + set `settingSources`". Either way the profiles ship no skills, so *today* nothing loads.
- **claude.ai connectors actually configured.** The gate is on (`tengu_claudeai_mcp_connectors:true`) and not
  suppressed, but whether each profile's claude.ai account *has* connectors enabled is account-state I can't see.
- **Codex `image_gen`/`view_image` exposure via the unmanaged app-server** (§3.2) — present as a skill, but the
  built-in tool surface to our client is unverified; other Codex native surfaces are app-only.
- **Vendor auto-memory under `CLAUDE_CONFIG_DIR` relocation** — exact on-disk path and whether it activates in
  our non-interactive runs (P0).
- **Codex bundled-skill auto-load by the app-server** — `codex-workflows.md` asserts the github skills load;
  the `.system` + artifact-template skills are assumed to load the same way but not directly confirmed on our
  driver.
- **Source-fetch gaps** (carried from sibling docs): `openai.com` 403s; `developers.openai.com` redirects to
  `learn.chatgpt.com`. Codex product claims lean on `learn.chatgpt.com` + GitHub + secondary write-ups and move
  fast — re-verify before building.
- **First-hand manifest scope.** This session's injected-tool list is confirmed for *this* Claude host
  instance (Cowork-class); exact availability differs by plan/surface (Pro/Max/Team/Enterprise; desktop vs web).

---

## Sources

Claude — SDK vs app, skills, connectors, memory, automations:
- Use Claude Code features in the SDK (settingSources default = user+project+local; auto-memory + claude.ai
  connectors load regardless; connector kill-switches): https://code.claude.com/docs/en/agent-sdk/claude-code-features
- Agent Skills in the SDK (`settingSources` + `skills` option; SDK ships no skills, discovers from filesystem;
  no programmatic registration): https://code.claude.com/docs/en/agent-sdk/skills
- Claude Code plugins/marketplace + `~/.claude/skills` install: https://code.claude.com/docs/en/plugins-reference ·
  https://www.agensi.io/learn/how-to-install-skills-claude-code
- Agent Skills overview (platform): https://platform.claude.com/docs/en/agents-and-tools/agent-skills/overview
- Claude connectors directory (369+ entries mid-2026; Google Workspace GA ~Feb 2026; hosted MCP):
  https://www.dirjournal.com/blogs/claude-connectors-list · https://support.claude.com/en/articles/10166901-use-google-workspace-connectors
- Google Drive connector connected in claude.ai but not in Claude Code (surface-mismatch):
  https://github.com/anthropics/claude-code/issues/41660
- Memory tool + context editing (platform): https://platform.claude.com/docs/en/agents-and-tools/tool-use/memory-tool
- Claude scheduled tasks / Cowork tasks (Apr 9 2026) / Claude Code routines (Apr 14 2026) / Managed Agents
  scheduling (Jun 9 2026): https://claudefa.st/blog/guide/development/scheduled-tasks ·
  https://www.mindstudio.ai/blog/claude-routines-schedule-autonomous-ai-workflows
- Agent SDK default toolset (Read/Write/Edit/Bash/Glob/Grep/WebSearch/WebFetch/Monitor/…):
  https://www.kdnuggets.com/getting-started-with-the-claude-agent-sdk · https://fast.io/resources/claude-code-api-sdk-guide/

Codex — bundled skills, plugins, app-server, app-only surfaces:
- Codex plugin system (skills + MCP + connectors; v0.117.0, Mar 2026): https://codex.danielvaughan.com/2026/03/30/codex-cli-plugin-system/
- Codex skills (`.agents/skills`, `~/.codex/skills`, `SKILL.md`): https://learn.chatgpt.com/docs/build-skills
- Codex desktop: computer use + 90+ app plugins; multi-surface MCP share: https://www.digitalapplied.com/blog/openai-codex-desktop-computer-use-plugins-guide ·
  https://learn.chatgpt.com/docs/extend/mcp
- Codex app-server reference: https://learn.chatgpt.com/docs/app-server · https://codex.danielvaughan.com/2026/04/15/codex-app-server-complete-guide/

Internal (grounding, this repo — inspected):
- `apps/hub/src/adapters/claude.ts` (query() options block: env/cwd/resume/model/permissionMode/canUseTool/
  mcpServers at lines 58-69; **no** settingSources/skills/plugins/connectors flags)
- `apps/hub/src/adapters/codex.ts` (`spawn('codex app-server')`, `CODEX_HOME`=profile; thread/turn lifecycle)
- `apps/hub/src/agentTools.ts` (in-process `allmyagents` server: bus + memory + practices)
- `apps/hub/src/sessions.ts` (`mcp__allmyagents__*` auto-allow `:187`; `autoMemoryRecall`), `apps/hub/src/index.ts`
  (`autoMemoryRecall` wiring)
- `profiles/claude-a/settings.json` (`{"theme":"dark"}` — nothing enabled), `profiles/claude-a/.claude.json`
  (`"tengu_claudeai_mcp_connectors": true`; per-project `mcpServers:{}` / `enabledMcpjsonServers:[]`),
  `profiles/claude-*/plugins/marketplaces/…staging/` (marketplace **cache**, not enabled)
- `profiles/codex-a/skills/.system/{imagegen,review-agent,skill-creator,skill-installer,plugin-creator,openai-docs}/SKILL.md`,
  `profiles/codex-a/plugins/cache/openai-curated-remote/{github,openai-templates}/…/skills/*/SKILL.md`
  (bundled skills the app-server loads), `profiles/codex-a/memories_1.sqlite` (native memory)
- This research session's own injected manifest (first-hand Claude host-app tool/skill/MCP enumeration, §2.3)
- Sibling scopes: `agent-native-tools.md`, `emulated-agent-tools.md`, `vendor-remote-control.md`,
  `agent-visualization.md`, `codex-workflows.md`, `practices-hooks-gating.md`, `inter-agent-comms.md`
