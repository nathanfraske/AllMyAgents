# AiAgentApp — design and central roadmap

Working title. A self-hosted hub + GUI that manages any number of Claude Code and OpenAI Codex agents across any number of accounts, on Windows and WSL, with any linked agent promotable to orchestrator ("brains"), hub-routed agent-to-agent messaging, shared per-project memory, and phone remote access over our own mesh (AllMyStuff / MyOwnMesh) instead of vendor relays.

Drafted 2026-07-23 from a five-track research pass (Claude Agent SDK docs, Codex app-server/SDK docs, AllMyStuff/MyOwnMesh source, prior art survey, t3code deep-dive). Source links at the bottom.

---

## 1. Non-negotiable principles

1. **Official programmatic surfaces only.** Claude via the Claude Agent SDK; Codex via `codex app-server` JSON-RPC. Never wrap interactive CLIs, never scrape PTYs. Evidence: Omnara v1 deprecated itself because CLI-wrapping "became unfeasible to maintain"; Zed's Codex adapter was rebuilt on app-server; t3code uses exactly these two surfaces.
2. **The hub owns every agent process.** UIs (desktop, laptop, phone) are stateless viewers over an event-sourced journal. A dropped viewer connection loses nothing; reconnect = replay from sequence number. This is the structural fix for flaky vendor remote control.
3. **Accounts are profiles; profiles are config dirs.** One `CLAUDE_CONFIG_DIR` or `CODEX_HOME` per account. Move, never copy (see D4).
4. **Privilege is an ACL grant, not an architecture.** The brains role, spawn rights, cross-project messaging, node access — all scopes on ordinary sessions, all hot-swappable, all audited.
5. **Self-hosted transport.** Both vendors' remote channels relay through their clouds, require a healthy host session, and are closed to third parties. Our remote leg is MyOwnMesh (E2E, self-hostable), with Tailscale as the day-one stopgap.

## 2. System architecture

```
phone (AllMyStuff mobile / PWA)   laptop (PWA)        desktop GUI (Svelte)
        \                             |                     |
         \--- mesh sidecar stack -----+              localhost WS
          (myownmesh + allmystuff-serve)\                   |
                                        v                   v
  +---------------------- hub daemon (Node/TS, Windows service) ----------------------+
  |  WS API + device auth   | event journal (SQLite, event-sourced, replayable)       |
  |  approval router        | message bus (envelopes + ACLs + audit)                  |
  |  orchestration MCP srv  | profile registry (config dirs)  | fleet hooks engine    |
  |  memory service         | project commons                 | task boards           |
  +------------+-------------------------------------------------+-------------------+
               | stdio (Agent SDK / app-server JSON-RPC)          | WS (outbound dial)
               v                                                  v
      Windows node runner                                 WSL node runner (Ubuntu-24.04)
      claude/codex sessions, worktrees,                   claude/codex sessions, worktrees,
      PTY for login flows                                 PTY for login flows
```

Components:

- **Hub daemon** (`apps/hub`, Node/TS): profile registry, session manager, adapters, journal, bus, MCP orchestration server, memory service, commons, hooks engine, approval router, WS API.
- **Node runners**: Windows runner runs in-process with the hub; the WSL runner is a small daemon inside the distro that dials out to the hub over WS (outbound dial avoids inbound firewall pain; Win11 mirrored networking makes localhost bidirectional, NAT-mode gateway IP is the fallback). Runners own process spawning, worktrees, PTYs for interactive logins, and path mapping. Any other PC on the mesh can host a node runner too — same daemon, dialing the hub over MyOwnMesh instead of localhost; remote machines are just more nodes under the same ACLs. Agent relocation (P4): `relocate_session(target)` — interrupt, transfer the worktree (git bundle or mesh file transfer), move the profile (move-never-copy) or use one already resident on the target, vendor-native resume there, continue working. Agents can request their own relocation (or spawn siblings on other PCs) via MCP, gated by node ACLs and approval policy.
- **Adapters** (`packages/adapter-*`): translate vendor protocols to one normalized event model. Contract (mirrors t3code's proven SPI): `startSession / sendTurn / interruptTurn / respondToApproval / setOptions / stopSession / events()`.
- **Mesh sidecar stack**: the hub bundles prebuilt `myownmesh` and `allmystuff-serve` binaries as sidecars (CECSupport pattern, see D13) and talks to the AllMyStuff node over its local control socket (named pipe `allmystuff-node` on Windows, socket file under `$MYOWNMESH_HOME` elsewhere) — length-prefixed JSON, one connection per request, plus one long-lived event-subscription connection. Upstream target: a `CHANNEL_AGENTS` definition + `agents_*` node commands + Agents pane in AllMyStuff, which its mobile apps inherit verbatim (they render the desktop Svelte UI). A custom Rust bridge embedding `myownmesh-core` remains the fallback only if upstreaming stalls.
- **UI** (`apps/web`, Svelte): fleet grid, transcripts with tool-call/approval cards, subagent trees, commons view, profile manager, permission editor. Served by the hub; desktop shell later (Tauri); phone = same app over mesh/Tailscale.

## 3. Design decisions

**D1 — Official surfaces only.** See principle 1.

**D2 — TypeScript hub; Rust only for the mesh bridge.** The Claude Agent SDK is TS/Python only and is the most load-bearing dependency; reimplementing its permission/hook/session protocol in Rust is CLI-wrapping with extra steps. Codex app-server is language-neutral with first-party TS codegen (`codex app-server generate-ts`). All harvestable prior art is TS. The hub is an I/O broker — agents burn the CPU, not the hub. Process separation (WS/stdio/journal contracts) means any component can be rewritten in Rust later without touching the rest. The mesh layer is consumed as prebuilt Rust sidecars (D13), so the hub itself stays pure TS; Rust code only enters if we later need a custom bridge. UI is Svelte to keep the AllMyStuff upstream path open.

**D3 — Event-sourced journal.** Every adapter event (session/turn/item/approval/tokens), bus envelope, hook firing, and audit entry is an ordered row in SQLite. UIs and the brains read projections; reconnect = replay since cursor. t3code's decider/projector design independently validates this; harvest its schema shapes.

**D4 — Profiles: add unlimited, move never copy.** "Add account" = create fresh config dir → run that CLI's login in a PTY under that env → register row. Works for N accounts per vendor. Moving a profile between nodes relocates the whole dir and atomically updates the registry — never duplicate it: Codex ChatGPT-OAuth refresh tokens are single-use/rotating; two live copies of one `auth.json` destroy each other (`refresh_token_reused` loops, documented in openai/codex issues). Same account in two profiles is fine only via two independent logins (independent token chains). **Never point tooling at `~/.codex` — the Codex desktop app owns that token chain.** Claude on Windows stores `.credentials.json` in the config dir (no keychain), so dirs are cleanly movable; the `~/.claude.json` global-file gotcha means per-profile smoke tests on first spawn.

**D5 — Brains = orchestration MCP scope.** The hub runs an MCP server exposing: `list_agents, agent_status, read_output, spawn_agent(profile, node, project, prompt, policy), send_to_agent, interrupt, stop, create_task/claim/complete, memory_*, commons_*, hook_register/list/remove, ask_user`. Claude attaches it natively per session (SDK `mcpServers`); Codex via per-profile `config.toml` `[mcp_servers]`; local LLMs via the broker's tool loop. The brains is whichever session holds the `orchestrator` scope — any vendor, hot-swappable, cannot self-elevate. Workers get narrower grants (default: spawn subagents, message own project, read own project commons).

**D6 — Projects are first-class.** A project = repo(s) + members + memory scopes + commons + task board + bus channel. Every session runs in its own git worktree (workspace manager in the node runner creates/cleans them — the Claude Squad / Crystal / Vibe Kanban pattern). Fleet view groups by project.

**D7 — Bus: hub-routed envelopes with ACLs.** "Every agent can talk to every agent" = bus semantics, not N² links: envelopes `{from, to|channel, project, kind, payload, causality}` routed by the hub, delivered as injected user-turn messages with a standard header. Default policy: intra-project allowed, cross-project deny until granted, everything journaled. Delivery to a busy session queues until turn end (or interrupts, per policy).

**D8 — Fleet hooks (cross-agent-type).** A rules engine over the journal, distinct from Claude's in-session hooks. Any agent (or the user) registers: `{selector: event pattern + filters, scope: project|global, actions: [notify-sessions | notify-user | spawn-agent | create-task], throttle, cascade: false}`. Example: a Codex agent registers a stop-hook; when any session in the project stops with an error, all members get the failure context injected and can troubleshoot. Guards: no-cascade by default (hook-triggered injections are tagged and don't re-fire hooks), per-scope rate caps, full audit.

**D9 — Memory: hub-owned, scope-selected.** Vendor memory is siloed per config dir by construction; only the hub sees all accounts. Memories are rows `{scope: {project? vendor? profile?}, content, provenance, pinned}`. At spawn the hub materializes the scoped union into the session's worktree — `CLAUDE.md` for Claude, `AGENTS.md` for Codex (each vendor's native instruction file) — and exposes `memory_search/read/write` MCP tools with scope enforced from session identity. Examples that must work: "Codex cross-account memories for project X", "Claude cross-account for project Y", "all agents in project Z".

**D10 — Project Commons.** The shared space that survives divergent worktrees. Typed surfaces, not one mutable blob:
- **Feed** — append-only typed posts (`finding | decision | blocker | handoff | question | status`). Append-only = no write conflicts, natural audit.
- **Pins** — durable entries promoted from the feed (by any agent, brains, or user); pins bridge into the D9 memory layer as project-scope memories.
- **Artifacts** — a real shared directory per project outside all worktrees (`commons_put/get/list`); mesh file transfer syncs or proxies it across nodes.
- **Status board** — derived, read-only: current task claims + latest per-session summaries, so "what is everyone doing?" costs a query, not N transcripts.
Injection: spawn-time digest (all pins + recent relevant feed) inside the D9 materialization; afterwards pull via MCP or push via fleet hooks. Compaction: a scheduled summarizer (or the brains) folds stale feed into pins. The commons is also the brains' primary situational-awareness source — protects its context window.

**D11 — Reasoning visibility and control.** Per-session toggles normalized by adapters: Claude `thinking` config; Codex per-turn `effort` + reasoning deltas (`item/reasoning/*`). Subagent trees: Claude events carry `parent_tool_use_id` (+ SubagentStart/Stop hooks); Codex nests items in turns. The journal stores lineage so the UI renders session → subagent hierarchies with expandable transcripts. Forensics requirement (from a hallucinated-home-path incident during testing): the journal must capture the full reasoning path. Thinking arrives redacted (signature-only) unless explicitly enabled — so sessions default to thinking-enabled once the toggle ships, the journal stores thinking blocks verbatim, and the UI renders per-turn reasoning trails. Bonus watchdog heuristic: flag "reflex tool calls" — side-effectful tool use with zero preceding reasoning tokens — since that was the exact signature of the hallucinated-path write. Context management: per-session context gauges (Claude: per-turn usage in `result` messages; Codex: `thread/tokenUsage/updated`) plus a configurable auto-compaction threshold per session/profile — vendor-native auto-compact where offered, otherwise hub-triggered compaction (Claude `/compact`, Codex `thread/compact/start`) when the gauge crosses the configured percent.

**D12 — Security model.** Paired-device auth via mesh identity (Ed25519) or QR one-time token (harvest t3code/claude-app-server UX); scopes: `view, input, approve, spawn, orchestrator, cross-project, node:<name>, profile:<id>`; per-profile budgets (tokens/day, concurrent sessions, spawn depth ≤ 2 default); approval router with per-device targeting and timeout policies (escalate → auto-deny); global kill switch (SIGTERM all agent processes); append-only audit of every envelope, approval, spawn, hook, and profile move. Brains cannot grant itself scopes; only the user can.

**D13 — Sidecar loading and updates (the CECSupport pattern).** Adopted wholesale from github.com/mrjeeves/CECSupport, which ships AllMyStuff + MyOwnMesh as sidecars in production:
- **Pin files**: `.myownmesh-rev` and `.allmystuff-rev` at repo root — one line, an exact release tag each. The same file drives build-time fetch and the runtime version check. Bumps are explicit commits, coordinated with the upstream release order (MyOwnMesh tag → AllMyStuff rev bump + tag → our rev bumps).
- **Fetch script** (`scripts/fetch-sidecars.ts`, run at build/postinstall): per sidecar, resolution order is (1) env override (`MYOWNMESH_BIN` / `ALLMYSTUFF_SERVE_BIN` — pre-signed binaries), (2) sibling dev checkout (`../MyOwnMesh`, `../AllMyStuff/node`) only if its `--version` ≥ the pin, (3) pinned GitHub release asset `{base}-{platform}.{zip|tar.gz}`. Every candidate must answer `--version` within 5s and pass a magic-byte check; downloads are **sha256-sidecar fail-closed** (missing checksum = refuse to stage), minisign-verified when a pubkey is configured. A sentinel file skips repeat work. Two modes: `HUB_SKIP_SIDECARS=1` (offline dev, zero-byte stub) and `HUB_REQUIRE_SIDECARS=1` (release CI: only the pinned verified asset may fill the slot, else fail loud — a green build without a mesh inside can never ship).
- **Runtime bring-up (probe → reuse → spawn)**: probe the node control socket first; if anything answers, **reuse it and own nothing** (`ownedChild = null`). One stack per machine — never fork `MYOWNMESH_HOME` or mesh identity; the user's existing AllMyStuff/AMS node *is* our transport when present. Only if nothing answers: find the binary (override → beside our app → PATH), classify `override | installed | devbuild`, spawn it as a plain child (`windowsHide`, stdio teed into our logs).
- **Delegated self-update**: we never implement update logic for binaries we don't own. If an `installed` binary is behind the pin, run its own `update` verb (`allmystuff-serve update` / `myownmesh update`, 180s timeout) — before spawning if we're about to start it, or on-disk-for-next-start if a node we don't own is already running. `override`/`devbuild` sources are never touched. Update failure never blocks startup: an old node still beats no node.
- **Wedge-vs-gone respawn policy**: if the socket dies but our own child is still alive, that's *wedged*, not gone — do not respawn (you'd spawn a bind-loser and kill the live node). Only after 3 consecutive wedged probe windows kill and respawn; a child confirmed dead respawns immediately. The control-socket bind is the machine-wide singleton lock; connect-probe is the health check.
- **Lifetime + cleanup (Node adaptations)**: Rust's Job-Object/PDEATHSIG kill-on-parent-death doesn't exist in Node — compensate with explicit TERM→KILL on shutdown for owned children only, a PID file, and an orphan sweep at startup. Compile-time pin stamping becomes reading the rev file at runtime.

**D14 — Usage telemetry and work handoff (continuity engine).** Per-profile usage health is first-class state:
- **Sources.** Claude: the Agent SDK streams `rate_limit_event` (`status`, `rateLimitType` e.g. `five_hour`, `resetsAt`, overage fields — confirmed live in P0) and per-turn token/cost usage in `result` messages; windows are wall-clock, so the last-seen `resetsAt` stays valid between sessions, and journal aggregation covers consumption in the gaps. Codex: app-server exposes `account/rateLimits/read` for true polling without running a turn — probed live 2026-07-23: returns the weekly window (`windowDurationMins: 10080`) with `usedPercent` and `resetsAt`, plus `credits {hasCredits, unlimited, balance}`, `spendControlReached`, and `rateLimitReachedType` — and `account/usage/read` (the probe's method-list error revealed `account/tokenUsage/read` does not exist in 0.145; codegen per installed version). `thread/tokenUsage/updated` notifications cover per-thread context tracking. Both adapters also record hard rate-limit errors as health signals.
- **UsageMonitor** (P1): maintains per-profile snapshots `{window, status: fresh|warm|near-limit|exhausted, resetsAt, consumedInWindow, overage, lastLimitError}`; rendered as gauges in the fleet grid; exposed to agents via `agent_status`/`list_profiles` MCP tools so a brains can schedule around quota.
- **Overage guard** (P1, default ON): per-profile setting `allowOverage: block | warn | allow` (default `block`). Claude's `rate_limit_event` reports `overageStatus` and `isUsingOverage` in real time — when a window exhausts and the account would start burning paid usage credits, the hub pauses the session (or fires the continuity handoff) instead of silently spending money; `warn` notifies and continues; `allow` opts that profile in. Codex signals confirmed by live probe: `credits.hasCredits/balance`, `spendControlReached`, `rateLimitReachedType` from `account/rateLimits/read`. Hub-side budgets stay layered on top: vendor plan limits are read-only, but the hub can enforce stricter soft caps and "reserve floors" per profile (e.g. stop background agents at 80% of the weekly window to keep headroom for interactive use).
- **Continuity engine** (P2): per-project/per-session policy `{mode: off|ask|auto, triggers: [status ≥ near-limit | N% window | hard error], targets: ordered profile list (e.g. claude-a → claude-b → codex-a → local), sameVendorFirst?: bool}`. Handoff protocol: (1) while the outgoing agent still has budget, it writes a handoff brief (Commons post, `type: handoff`: state, done, next, gotchas) — prompted by an injected instruction; if the account is hard-dead the hub synthesizes the brief from the journal tail + task board. (2) The successor spawns from the target profile **into the same worktree** — uncommitted state travels for free; cross-vendor works because memory/Commons/tasks are vendor-neutral (D9/D10). (3) Task claims transfer; the origin session is marked `paused-for-quota` with its `resetsAt` ETA. (4) On window reset, optionally auto-resume the original session (vendor-native resume restores its full context) to review, integrate, or reclaim the work. Budget-aware spawning uses the same data: an unpinned `spawn_agent` picks the healthiest eligible profile.
- **Account swap = port** (built v1 2026-07-23): auth is per-account and can't change mid-conversation, so "swap account" on a chat with history PORTS it — spawns a new session under the target account reusing the same working directory (files travel) and seeds the target agent with the transcript; the original is left as a snapshot, with a confirm warning. Empty chats swap seamlessly (re-create). This is the interactive, single-chat face of the continuity engine. v1 limits to fold in: worktree OWNERSHIP transfer (currently the ported session shares the source's worktree dir but doesn't own it — stopping the source would delete it; needs a lease transfer), a summarizer instead of raw-transcript seeding (cheap/local model), and carrying model/effort/memory scope. Cross-node ports use the mesh file transfer (P4).

## 4. Requirement → mechanism map

| Requirement | Mechanism |
|---|---|
| N accounts per vendor, add anytime | Profile registry + per-profile login flow (D4) |
| Move accounts across Windows/WSL | Node runners relocate config dir; move-never-copy (D4) |
| See what all agents are doing | Journal projections → fleet grid; status board (D3, D10) |
| Any agent as brains | Orchestration MCP scope, hot-swap (D5) |
| Agents spawn agents / workflows | Native subagents (depth-capped) + hub `spawn_agent` with ACL/budget (D5) |
| Agent ↔ agent talk, mainly intra-project | Bus envelopes; default intra-project allow (D7) |
| Cross-agent-type hooks | Fleet hooks engine (D8) |
| Cross-account / per-vendor / per-project memory | Scoped memory + CLAUDE.md/AGENTS.md materialization (D9) |
| Shared per-project space | Project Commons (D10) |
| Thinking toggle, subagent visibility | D11 |
| Worktree per session | Workspace manager (D6) |
| Phone remote, reliable | Hub-owned processes + journal replay + mesh bridge; Tailscale stopgap (principles 2/5) |
| Poll per-account usage and limit windows | Claude: SDK `rate_limit_event` + per-turn usage in results; Codex: `account/rateLimits/read` + `account/usage/read` (D14) |
| Block accidental usage-credit (overage) spending | Overage guard, default block: Claude `isUsingOverage`/`overageStatus`; Codex `credits`/`rateLimitReachedType` (D14) |
| Hand off work to accounts with more usage left | Continuity engine: usage-triggered handoff via shared worktree + Commons brief + resume round-trip (D14) |
| Agent relocates itself / spawns onto another PC | Mesh-connected node runners + `relocate_session` protocol (P4) |
| Local LLMs join | Broker: OpenAI-compatible endpoint + tool loop over the same MCP tools (P5) |
| Other vendors (Gemini, Copilot, …) | ACP adapter (P5) — t3code proves ACP drivers work |

## 5. Risks and watchlist

- **ToS/billing**: automating your own subscription accounts on your own hardware is the blessed pattern (Claude: `claude setup-token` for owned infra; don't resell access). Watch Anthropic's deferred Agent SDK billing change; re-check before P2.
- **Protocol churn**: app-server has experimental surfaces and one breaking generation already (v1→v2). Mitigation: `codex app-server generate-ts` per pinned version + conformance smoke test in CI; pin SDK versions; adapters are the only vendor-touching code.
- **AllMyStuff gaps**: no stable external API, no push notifications, mobile foreground-only, not in stores, WSL unaddressed. Mitigation: bridge owns a *stable contract we define*; upstream `CHANNEL_AGENTS` + Agents pane + (later) push-wake; PWA + web push as interim; Tailscale from day one.
- **Same-account concurrency**: two logins of one Codex account = independent token chains (safe); never share one `auth.json`. Never touch `~/.codex` (desktop app owns it).
- **Brains context bloat**: brains consumes status board + digests, not raw transcripts; `read_output` is paginated and explicit.
- **Category churn**: Vibe Kanban (27k stars) is sunsetting; differentiate on what nobody ships — multi-account, brains, mesh, memory — not on kanban chrome.

## 6. Harvest list (designs to port, not code to fork)

From t3code (MIT): `ProviderDriver`/`ProviderAdapter` SPI shape; `ClaudeHome.ts` (config-dir isolation; macOS keychain trap: never override HOME); `CodexHomeLayout.ts` (shadow-home pattern); ClaudeAdapter resume-cursors + deferred-approval map; `orchestration/decider.ts` + `projector.ts` event schema; MCP toolkit registration; QR/one-time-token pairing. From CECSupport (MIT): `gui/src-tauri/build.rs` (`SIDECARS` table, `bundle_sidecar`, `verify_slot`, `release_platform_name`); AllMyStuff `node/src/node_control.rs` (`ensure_node_running_pinned`, `find_node_binary`, `NodeClient` probe/request/subscribe); `allmystuff-updater` (`stage_release`, `atomic_replace`, Windows side-swap rename with rollback); `main.rs` event-pump wedge/respawn policy; `cec-support-service` (sc.exe/systemd/launchd installer with auto-restart). From claude-app-server (MIT): thread/turn/item mapping table; `--session-id/--resume/--fork-session` semantics. From Happy: E2E relay + push-approval UX (reference for mesh phase). From VibeTunnel: bring-your-own-tunnel posture.

## 7. Roadmap

**P0 — Spike. ✅ Completed 2026-07-23.**
- [x] Drive one Claude session via Agent SDK from Node (`spikes/src/claude-min.ts`) — passed against `profiles/claude-a`
- [x] Drive one Codex session via `codex app-server` JSON-RPC (`spikes/src/codex-min.ts`) — passed against `profiles/codex-a`; full item/delta stream observed
- [x] Two Claude accounts concurrently from separate `CLAUDE_CONFIG_DIR` profiles (`spikes/src/two-claude-accounts.ts`) — interleaved events from both sessions
- [x] All events journaled to JSONL (SQLite comes in P1)
- Bonus finding: the Agent SDK streams `rate_limit_event` per session — `{status, rateLimitType: "five_hour", resetsAt, overageStatus, overageResetsAt, isUsingOverage}` — the foundation for D14 usage tracking.

**P1 — Hub + adapters + minimal UI.** Adapter SPI; Claude + Codex adapters (codegen'd app-server types); profile registry with in-app add/login/move; worktree workspace manager; SQLite journal (`node:sqlite` or better-sqlite3); WS API with replay; UsageMonitor (rate-limit events + Codex usage polls) with per-profile gauges; Svelte fleet grid + transcript + approval cards + thinking toggle. Exit: manage 4+ sessions across 3+ profiles from the browser with live usage gauges, kill/resume surviving hub restart.

**P2 — Orchestration + memory + commons.** Orchestration MCP server + scopes/ACLs; bus + envelopes; fleet hooks engine; task boards; memory service + materialization; commons (feed/pins/artifacts/status); continuity/handoff engine (D14, ask/auto modes); budgets; audit; brains hot-swap; subagent trees in UI. Exit: a Claude brains spawns a Codex worker in a worktree, they exchange messages, share a commons post, a stop-hook notifies the project — and a near-limit Claude session hands its worktree to a Codex profile, then resumes and reviews after its window resets.

**P3 — WSL node.** Runner daemon in Ubuntu-24.04 (outbound dial); cross-node spawn; profile moves; per-node ACLs; path mapping. Exit: brains on Windows spawns a worker in WSL; a profile moves Windows→WSL and back.

**P4 — Remote + phone.** Sidecar stack per D13 (`fetch-sidecars.ts`, pins, probe/reuse/spawn, delegated updates, wedge policy); TS `NodeClient` for the allmystuff-node control socket (request + event subscription); upstream `CHANNEL_AGENTS` + `agents_*` commands + Agents pane to AllMyStuff; device pairing; reconnect/replay hardening; approval push (PWA + web push until AllMyStuff grows push-wake); Tailscale documented as supported alternative. Exit: approve a tool call from the phone on cellular with the laptop lid closed. *(Swap P3/P4 if phone access matters more first.)*

**P5 — Breadth.** Local LLM broker (Ollama/LM Studio, tool loop, brains-capable if the model can call tools); ACP adapter (Gemini CLI, Copilot, OpenCode, Cursor…); Tauri desktop shell; packaging (Windows service + systemd unit); workflow runner (scripted multi-agent pipelines).

## 8. P0 quickstart

```
pnpm install
pnpm login:claude profiles/claude-a        # interactive: /login in the session, then /exit
pnpm login:claude profiles/claude-b        # second account (or same account, fresh chain)
pnpm login:codex  profiles/codex-a         # codex login browser flow
# note: plain `pnpm login` is pnpm's own npm-registry login — always use the login:* forms
pnpm spike:claude                          # one Claude session, default config
pnpm spike:claude profiles/claude-a        # same, pinned to a profile
pnpm spike:codex  profiles/codex-a         # app-server handshake + one turn
pnpm spike:two-accounts                    # concurrent A+B, interleaved output
```
Events land in `journal/*.jsonl`. Safety rule: spikes refuse the default `~/.codex` (the desktop app owns that token chain).

## 9. References

Claude Agent SDK: code.claude.com/docs/en/agent-sdk/overview.md (typescript.md, sessions.md, permissions.md, hooks.md, mcp.md, hosting.md) · Codex: learn.chatgpt.com/docs/app-server, /docs/codex-sdk, /docs/auth, /docs/non-interactive-mode, /docs/sandboxing, /docs/windows/wsl, github.com/openai/codex (codex-rs/app-server-protocol) · AllMyStuff/MyOwnMesh: github.com/mrjeeves/AllMyStuff (ARCHITECTURE.md, docs/MOBILE.md), github.com/mrjeeves/MyOwnMesh, github.com/mrjeeves/CECSupport (sidecar/update pattern) · Prior art: github.com/pingdotgg/t3code, github.com/slopus/happy, github.com/omnara-ai/omnara (deprecation note), github.com/zed-industries/claude-code-acp, agentclientprotocol.com, github.com/sumansid/claude-app-server, github.com/amantus-ai/vibetunnel, github.com/siteboon/claudecodeui, github.com/andyrewlee/awesome-agent-orchestrators

## 11. UI: t3code-derived decisions and refinement backlog (2026-07-23)

From a source-level map of t3code's `apps/web` + `packages/client-runtime`. Their timeline is one big dispatcher (`MessagesTimeline.tsx`) over a generic activity envelope `{tone, kind, summary, payload}` with the card derived client-side from `kind` — so new tool/provider types need zero schema changes. We adopt that envelope shape for our ThreadItem model.

Validated (we already do it): event-sourced journal with monotonic sequence + replay; usage/cost modeled OUTSIDE the journal (their `OrchestrationSession` has no token/cost fields — confirms our separate UsageMonitor is necessary, not redundant); client-side item rendering. Our sequence-dedup in the store (`seq <= lastSeq`) is actually more robust than their reducer, which dedups by id and assumes ordered delivery.

Adopted now (cheap, high value): user-message auto-collapse at 600 chars / 8 lines; morphing primary button (Send ⇆ Stop while a turn runs); status-pill pulse for active/starting.

Refinement backlog (port as we grow):
- **Turn-folding** — once a turn settles, collapse it to just its terminal assistant message with a fold toggle hiding the work entries. Biggest scannability win for long threads. (their `deriveTurnFolds`)
- **Approval decisions beyond allow/deny** — add `acceptForSession` ("always allow this session") and `cancel turn`. Needs hub support: a per-session auto-allow rule set the approval service consults before queueing. Ties into the §10 "approval policy learner."
- **Context-window ring gauge** — small SVG ring, reddens >90%, tooltip shows used/max + auto-compaction note. Wire to D11 context data (Claude per-turn usage, Codex `thread/tokenUsage/updated`).
- **New-turn scroll anchoring** — pin a new turn to the top of the viewport instead of naive stick-to-bottom; three explicit modes (following-end / anchoring-new-turn / free-scrolling).
- **Structural row sharing during streaming** (`isRowUnchanged`) — reuse prior row objects to kill re-render jank at scale. Svelte keyed-each already helps; revisit if profiling shows jank.
- **Fast-reconnect guard** — cached projections must never overwrite newer live data. Our replay-from-lastSeq is close; add an explicit snapshot-sequence check when we add a REST snapshot endpoint.
- **Multi-server "environments"** — state atoms keyed by environmentId; the model for our future multi-node/multi-hub switching (P3/P4).
- **Sidebar bulk ops** — multi-select archive/delete/mark-unread, disabled-if-running guard.
- **PR / terminal / worktree row indicators** — sidebar glyphs for git PR state, running terminal, worktree.

Their gaps we must solve ourselves (they don't): no global cross-session approvals inbox (we already built one — a differentiator); no reasoning/thinking UI (we have collapsible thinking + the reflex flag, both novel here); no usage/cost in-journal (we have UsageMonitor); no approval keyboard shortcuts (easy win for us later).

## 12. Near-term build queue (2026-07-23)

Live status of the incremental UI/feature polish. Done items verified in-browser.

Done: projects/folders (create + spawn-into, worktree auto, sidebar grouped, collapsible with collapsed summary = provider logos + done/review/stalled/working counts); Claude thinking wiring (effort→keyword injection); richer status (working/completed/needs-approval/awaiting-answer/error/stopped/ready + dots + header chip); platform logos (Anthropic burst / OpenAI blossom); real Codex model catalog from live `model/list` (5.6 Sol/Terra/Luna, 5.5, 5.4, 5.4 Mini, 5.3 Codex Spark) with Effort (low→max→ultra, per-model) + Speed (serviceTier Standard/Fast) as two `·`-joined axes, wired end-to-end; settings modal (Claude-Code style: centered, blurred translucent backdrop) housing usage settings + accounts list + add-account; native folder picker (Windows FolderBrowserDialog via hub `/api/pick-folder`); profile rescan endpoint; stop/interrupt moved to composer footer; MIT license.

Also done: Inter + JetBrains Mono fonts; subtle animations (thread fade-in, modal/menu pop-in, reduced-motion respected); settings "Defaults for new chats" (account, permission mode, per-provider model); resizable sidebar (drag handle, persisted). Repo published: github.com/nathanfraske/CEC-AiMesh (public, MIT).

Queue (next):
- **Cleaner logins at scale**: (a) one-click in-app add-account — hub spawns the vendor login in a PTY and streams status back, no terminal typing; (b) import existing logins — detect Claude config dirs already logged in elsewhere and copy `.credentials.json` into a new profile (Claude dirs are copyable); Codex must re-auth per profile (single-use rotating refresh tokens — never copy auth.json); (c) guided multi-add for several accounts in a row. Usage at scale is already cheap (free `/usage` + `account/rateLimits/read`); the work is UI: a dedicated, scrollable, sortable-by-headroom usage dashboard (move out of the sidebar footer) + staggered polls + on-demand refresh, feeding the continuity engine's "which account has headroom."
- **Multi-window split view + configurable layout** (the big UI piece): a pane layout manager so 2–4 sessions render side by side, each pane bound to its own session (ThreadView must take a sessionId prop instead of reading `store.selected`); drag-to-split, resizable + closable panes, saved layouts, panel-visibility toggles. Resizable sidebar is the first step (done). This is a focused build of its own.
- **Add-account, full in-app**: current flow shows the `pnpm login:<vendor> profiles/<name>` command + a Rescan button (rescan works live, no restart). Upgrade to launch the login in a spawned terminal/PTY from the hub and stream status back, so it's one-click. Needs: resolve the bundled CLI path, spawn a visible terminal, detect completion.
- **Codex steer/queue** (params confirmed): `turn/steer { threadId, input: UserInput[], expectedTurnId, clientUserMessageId? }` → `{ turnId }` appends input to the ACTIVE turn; `expectedTurnId` must match the running turn (capture it from `turn/started`), empty input errors, cannot steer review/compact turns. `turn/interrupt { threadId, turnId }` for stop. There is NO separate "queue next message" RPC — post-turn queuing is a client concern (hold text, send on `turn/completed`). t3code wires only interrupt, not steer — so a steer affordance would be ahead of them. Claude has no steer; queue client-side. Expose a "steer" send-mode while a Codex turn runs + a queued-input chip.
- **Draggable/resizable panels**: sidebar width drag-handle (persist to localStorage); collapsible sidebar; later a resizable right inspector panel.
- **Folder picker cross-platform**: Windows dialog done; add a hub directory-browse API (list dirs) as the WSL/mac fallback, and a recent-folders list.
- **Directory-browse for projects on remote nodes** (P3): when a project lives on a WSL/remote node, browse that node's FS.
- **Model list from live `model/list`** rather than the static catalog.ts, per provider instance (so new Codex models appear automatically); keep catalog.ts as the offline fallback. Research confirms slugs/efforts/tiers are NOT hardcoded upstream — the runtime response is the source of truth. Paginate on `nextCursor`; use `model.model` as the slug; render Effort from `supportedReasoningEfforts`, Speed from `serviceTiers`, each only when non-empty (data-driven auto-hide, which our TraitsControl already does).
- **Thinking visible-by-default** + reasoning trails in the UI (from the forensics requirement). NOTE (verified 2026-07-23): Claude Code withholds reasoning TEXT on subscription accounts — thinking blocks/deltas arrive with a signature but empty content, even with `includePartialMessages` + ultrathink. So we can only show that reasoning happened ("✦ reasoned"), not the text. Codex reasoning IS exposed (we render it). Revisit if API-key auth exposes Claude thinking text.
- **Folder onboarding scan (import existing chats + MCPs)** — when a folder is chosen for a project, scan it and offer to import: (a) existing agent transcripts for that path — Claude `~/.claude/projects/<encoded-cwd>/*.jsonl` and Codex `$CODEX_HOME/sessions/**` filtered to that cwd, across all profiles — surfaced as read-only imported sessions the user can tag/keep; (b) MCP servers declared in the folder — `.mcp.json` (Claude), `.codex/config.toml` `[mcp_servers]`, `.claude/settings.json` — offer to register them for sessions in that project; (c) `CLAUDE.md`/`AGENTS.md`/`.cursorrules` present → offer to fold into the project's memory scope. Flow: on project create (or folder pick), hub scans → returns a manifest → UI shows "found N chats, M MCP servers — import?" with per-item checkboxes. Ties into the §10 repo-onboarding-scanner and the memory layer.

**Diff viewer + file features (t3code parity) — scoped 2026-07-23.** t3code's file surface, to mirror:
- **Changed-files tree** in the thread (per turn / per session): file paths grouped by folder with per-file +adds / −dels stats and a total (`ChangedFilesTree.tsx`, `DiffStatLabel.tsx`). Source data: for our worktree sessions, `git -C <worktree> diff --numstat` against the branch base; live-updated on tool events. Adapters can also surface vendor file-change items (Claude Edit/Write tool results; Codex `fileChange` items — we already normalize these).
- **Diff panel**: unified + split toggle, per-file collapse, syntax highlight, large-diff virtualization. t3code uses the external `@pierre/diffs` engine + a worker pool. For us: a self-contained Svelte diff view (unified first) fed by `git diff` patches from a hub `/api/sessions/:id/diff` endpoint; split-view + highlight later. No external diff engine dependency (keeps it lean).
- **File explorer** for the session's worktree: tree browse + read-only file view (hub `/api/fs/read` + `/api/fs/tree`, scoped to the worktree — reuse the write-scope guard). Later: open-in-editor.
- **Checkpoints + rollback**: snapshot the worktree per turn (git stash/commit or tag) so a turn's changes can be reviewed and reverted (t3code `checkpoints[]` + `thread/rollback`; Codex app-server has `thread/rollback`). Ties into the "ready for review" status.
- **Merge gate** (from §10 safety): integrating a worktree branch back to the main branch runs secret-scan + large-deletion/binary checks + optional reviewer-agent sign-off. This is the bridge between agent output and the real repo.
- **Review flow**: the "ready for review" status + a review view (diff + approve/request-changes) so a human (or a reviewer agent) signs off before merge. Pairs with the cross-vendor review pipeline in §10.

## 10. Ideas backlog and open questions (brainstorm 2026-07-23)

Generated by a dedicated brainstorm pass; triage into phases as they come up. Items already influencing P1: journal secret redaction (schema-level, hard to retrofit), session-stamped commits, journal growth/fan-out design, worktree ownership leases.

### Ideas backlog

**Fleet UX**

- **Attention inbox** — single cross-session queue of everything needing a human (approvals, agent questions, failures, expiring handoffs) sorted by urgency×age with keyboard-first triage; the fleet grid is ambient awareness, this is the actual working surface for 20 agents (P1–P2).
- **Diff-first session cards** — fleet-grid cards show files touched, +/- lines, last test result, and current tool call instead of last message text, so "what did it actually do" never requires opening a transcript (P1).
- **Session presets + bulk ops** — saved spawn templates (profile, node, project, policy, prompt scaffold) plus multi-select pause/kill/re-prompt across the fleet; 20 agents are unmanageable one right-click at a time (P1).
- **Fleet digest / standup** — scheduled brains- or summarizer-generated report (shipped, blocked, cost, pending approvals) posted to the Commons and pushed to the phone as one notification instead of forty (P2).

**Orchestration patterns**

- **Tournament spawns** — `spawn_agent(n=K)` runs the same task in K isolated worktrees across different profiles/vendors, a judge step (agent or human) picks the winner, losers auto-clean; turns surplus quota into output quality (P2–P3).
- **Cross-vendor review pipeline** — first-class author→reviewer pattern where the reviewer is deliberately a different vendor/account for decorrelated blind spots, wired to the merge gate; cheaper than tournaments, catches more than self-review (P2).
- **Hub scheduler** — cron-spawned preset agents (nightly dep bump, morning issue triage) plus a deferrable-work queue timed against known `resetsAt` windows, so overnight quota windows get harvested instead of wasted (P2).
- **Watchdog tier** — deterministic stuck heuristics over the journal (N turns with zero file edits, error loops, token burn without task progress) that auto-pause + notify, with an optional local-LLM anomaly reviewer holding a read-only journal scope (P2, local model P5).
- **Plan-then-execute gate** — adapter-normalized two-phase mode (Claude plan mode / Codex review) where the plan lands as a Commons artifact and approval unlocks execution; makes expensive work reviewable before tokens are spent (P2).
- **Follow-the-sun session relocation** — checkpoint a session (journal cursor + worktree pushed via mesh + synthesized brief) and resume it on another node or hub when a machine sleeps; the mesh + profile-move + handoff pieces combine into "work follows whichever PC is on" (P4–P5).

**Memory and knowledge**

- **Memory decay + reinforcement** — track last-referenced per memory (citation by a session counts, materialization alone doesn't), unpinned memories age toward archive; prevents CLAUDE.md bloat from ratcheting forever (P2).
- **Memory write quarantine** — session memory writes land as proposals reviewed by brains/user before entering scope, with one-click "purge everything from session S" rollback by provenance; the single cheapest defense against fleet-wide poisoning (P2).
- **Failure memories** — first-class `failed-approach` records (what was tried, why it died) auto-drafted from abandoned tasks and reverted worktrees, so five agents don't re-attempt the same dead end (P2).
- **Cross-project promotion** — memories repeatedly cited across projects get proposed for global scope with user approval; the mechanism by which the fleet actually accumulates general knowledge (P2–P3).
- **Repo onboarding scanner** — on project registration, a cheap agent scans the repo and drafts the initial memory pack (build/test commands, layout, conventions) as quarantined proposals; cold-start quality for every future session (P2).

**Usage economics**

- **Per-task cost attribution** — join journal token/cost events to task claims and sessions; dashboards for $/task, $/project, $/profile, and "this refactor cost $11.40" — the data already exists, only the join is missing (P1–P2).
- **Cost-aware routing ladder** — extend budget-aware spawning from "healthiest profile" to cheap-first escalation: route to cheapest capable tier, auto-retry one rung up with failure context attached on failure (P2).
- **Private model bench** — periodically replay a fixed personal task suite across all profiles/vendors/models and score results; produces your own eval data for routing decisions and "is account B worth renewing" (P3).
- **Cache-aware context assembly** — order materialized memory/Commons digests so the stable prefix stays byte-identical across turns and sibling spawns, maximizing vendor prompt-cache hits; a measurable double-digit cost lever (P2).

**Safety and trust**

- **Canary tasks** — scheduled known-answer probes per profile detect auth breakage, silent model swaps, and degradation before real work fails; also the natural early-warning for vendor-side changes (P2).
- **Tripwire rules** — hub-enforced content triggers (touching `.env`/credentials, force-push, mass deletion, CI-config edits) that pause the session and escalate regardless of its permission policy; catches what per-tool approval granularity misses (P2).
- **Bus injection firewall** — agent-to-agent envelopes rendered with explicit untrusted-content framing, imperative-instruction detection flags, and a rule that nothing in a bus message can satisfy an approval; D7 defines routing but not this defense (P2).
- **Merge gate with diff scan** — worktree→shared-branch integration requires a gate: secret scan, large-deletion and binary-blob checks, optional reviewer-agent sign-off; the last line between agent output and the real repo (P2).
- **Journal secret redaction** — pattern + entropy scrubbing before events persist, so transcripts are exportable/shareable and a journal leak isn't a credential leak; nearly impossible to retrofit after P1 fixes the schema (P1).
- **Approval policy learner** — mine the approval audit trail and propose narrow auto-allow rules ("you approved `pnpm test` 40 times in project X"); converts approval fatigue into vetted policy instead of rubber-stamping (P3).

**Developer workflow**

- **PR round-trip** — agents open PRs; review comments and CI failures flow back as bus messages to the authoring session (or spawn a fixer preset); closes the loop between fleet and forge (P3).
- **Issue-tracker sync** — GitHub Issues/Linear ↔ task board, bidirectional status, so the fleet works the same backlog humans do (P3).
- **Session-stamped commits** — enforce commit trailers carrying session/profile IDs so `git blame` deep-links to the exact transcript turn that wrote the line; trivial in P1, priceless forensics forever (P1).

**Mesh and remote**

- **Wake-on-mesh** — phone asks any awake mesh peer to send WoL to the sleeping desktop, then the hub starts the fleet; removes the always-on-PC requirement for remote use (P4).
- **Offline intent queue** — phone queues approvals/messages/spawns while off-mesh; hub applies on reconnect with staleness checks (expired approvals re-prompt rather than auto-fire) (P4).
- **Multi-user fleets** — per-person device identities, scopes, and approval routing over shared projects (family or small team on one hub); attribution in Commons/audit per person; approvals go to whoever owns the decision (P5).

**Local LLM tier**

- **Local utility services** — pull the P5 local-model idea forward as non-agent services: zero-cost summarizer (Commons compaction, status blurbs, handoff-brief synthesis), embedder (semantic search over memory/transcripts), and classifier (task routing, bus-message triage) (P2–P3 as services, P5 as agents).

**Observability**

- **Time-travel fleet debugger** — scrub the journal to reconstruct full fleet state at any instant, with a causality-graph view (spawn/envelope/hook edges) answering "what did the brains know when it decided X" (P3).
- **Context accounting** — pre-spawn preview of the exact materialized CLAUDE.md/AGENTS.md + digest with token counts, plus per-turn breakdown of where context tokens go (system vs memory vs digest vs history); the tool for fighting context bloat empirically (P2).
- **Fleet-wide transcript search** — SQLite FTS5 plus local-embedding semantic search across all sessions/projects/time; "which agent solved this error before" becomes a query (P2).

### Unknown unknowns / open questions

- **Split-brain brains** — hot-swap race or a resumed old orchestrator session can yield two holders of the `orchestrator` scope; needs a hub-enforced single-holder invariant with a fencing token on every orchestration MCP call.
- **Handoff mid-tool-call** — a continuity trigger firing during a side-effectful tool call (git push, file write) means the brief can't capture in-flight effects; handoff likely must be turn-boundary-only, which changes D14's trigger semantics.
- **Interrupt semantics divergence** — what exactly happens to an in-flight turn on Claude interrupt vs Codex abort (partial file writes? tool results dropped?) is undefined in the adapter contract, and handoff/resume correctness depends on the answer.
- **Worktrees vs submodules/LFS** — `git worktree` support for submodules is notoriously broken and LFS hooks may not fire per-worktree; a monorepo with either could silently corrupt; needs a repo-capability preflight probe before D6 assumes worktrees always work.
- **Windows file locks on worktree cleanup** — running node processes, esbuild.exe, and watchers hold locks that make `git worktree remove` fail; needs kill-processes-first ordering, retry with handle-owner detection, and an orphan-worktree sweep.
- **MAX_PATH overflow** — worktree root + node_modules + long branch names exceeds 260 chars fast; requires verified long-path enablement (registry + `git config core.longpaths`) at install or short worktree roots like `C:\wt\<id>`.
- **Defender scan amplification** — 20 sessions each churning node_modules makes Real-time Protection a CPU and file-lock adversary; exclusions are a real security tradeoff the installer must surface honestly rather than silently apply.
- **9p filesystem boundary** — worktrees on `/mnt/c` accessed from WSL (or `\\wsl$` from Windows) are 10–50× slower with broken file watching; needs an explicit policy that projects live native to one node and cross-node work clones rather than shares — which changes what "move project to WSL" means.
- **WSL clock drift** — the distro clock skews after host sleep/hibernate, corrupting `resetsAt` comparisons and token-expiry math; hub must be the clock authority or the runner must resync-check on wake.
- **Mirrored networking vs VPNs** — Win11 mirrored mode conflicts with some VPNs and Tailscale, and the WSL runner's outbound dial can silently die; needs a connectivity watchdog and runtime-switchable NAT fallback, not just a documented alternative.
- **Memory poisoning blast radius** — one hallucinated memory materializes into every in-scope future session; without write quarantine plus provenance-keyed purge, a single bad session degrades the whole fleet invisibly.
- **Commons digest as injection vector** — spawn-time digests inject other agents' prose into every session's context with instruction-file authority; a looping or manipulated agent can steer the project unless digests get the same untrusted framing as bus messages.
- **Persuasion-based ACL escalation** — brains can't self-elevate but can `ask_user` with a compelling justification; the grant UI must render the exact scope diff being approved, never the agent's own description of it.
- **Confused-deputy spawns** — a worker asks brains to spawn a helper with scopes the worker lacks; whether spawn policy checks the requester's or the spawner's scopes is undefined, and the wrong answer is a laundering path.
- **Codex auth rug-pull** — app-server already broke compatibility once (v1→v2); a change to ChatGPT-OAuth token rotation timing would break all Codex profiles simultaneously mid-flight; needs a version canary plus a "pause all Codex spawns" switch.
- **Agent SDK billing change** — the deferred Anthropic billing change is an existential dependency: if SDK use moves to API-key-only billing, the multi-subscription-account premise collapses; what is the fallback economic model?
- **Vendor abuse heuristics** — N accounts from one IP, synchronized bursts, identical repeated prompts (the canary tasks!), and 24/7 usage are plausible ban triggers; needs jitter, canary diversity, per-account behavioral separation, and an actual reading of both vendors' multi-account terms.
- **Journal growth and WS fan-out** — full delta streams × 20 sessions × weeks: unmeasured SQLite row volume, single-writer contention, and 50-subscriber fan-out; needs delta coalescing, per-viewer rate limits, and segment/archive design before P1 freezes the schema.
- **Crash-recovery commit points** — hub death between "successor spawned" and "origin marked paused" (or mid profile-move) leaves ambiguous state; every multi-step operation needs saga-style journal commit points with idempotent replay and a written recovery decision table.
- **Runner autonomy during hub outage** — if the hub dies while WSL-runner sessions run, do agents continue blind or pause, and does event buffering on reconnect risk duplicate side effects? The at-least-once vs exactly-once delivery choice is unmade.
- **Stolen paired device** — a phone holding mesh identity plus `approve` scope is a remote-control credential; needs a revocation path that propagates even while the device is off-mesh and a second factor (short-lived key or biometric gate) on high-risk approvals.
- **Worktree disk explosion** — 20 sessions × large repo × per-worktree node_modules (tournaments multiply further) exhausts disk; pnpm hardlinks help JS but not Python/Rust caches; needs quotas and eager reclamation policy.
- **Worktree ownership lease** — same-worktree handoff plus auto-resume-on-reset can put two live sessions in one working directory; worktree ownership must be an exclusive hub-managed lease with explicit transfer, or D14 corrupts state.
- **Injected-turn authority laundering** — bus messages delivered as user-turn text make vendor-side permission models treat agent instructions as the user; an approval triggered by an injected message may look user-authorized to the vendor; needs a hub-side rule that injected turns can never raise trust.
- **Server-side identity influence on "clean" profiles** — during testing, a fresh profile with zero identity in visible context emitted a filesystem path matching a home directory from a *different* machine the operator uses. Every local channel was clean (no email in context, empty memory paths, no MCP); explanation is either convergent name-truncation coincidence or account-side signals at the vendor (the request runs under the account's OAuth identity regardless of local isolation). Testable: N repeated sessions on a fresh profile — recurrence of the same name implies server-side influence. Implication either way: config-dir isolation isolates credentials and local state, NOT whatever the vendor associates with the account.
- **`~/.claude.json` concurrent writes** — D4 flags the shared-global-file gotcha but not which fields (project trust prompts, onboarding state, update flags) are written at runtime and whether one profile's write can corrupt another profile's concurrent session; needs enumeration and a contention test.
