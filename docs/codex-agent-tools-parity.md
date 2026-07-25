# Codex agent-tool parity — giving Codex the `mcp__allmyagents__*` surface

Build + scoping doc, 2026-07-25. **Implemented** (unlike the sibling scoping docs, this one ships code):
the shared tool core, a real stdio MCP server, the Codex config-writer, and the hub attribution path
are built and tested; §6 names the one residual **owner decision** for the fully-robust attribution.

Goal: give **Codex** agents the same inter-agent comms + shared memory + practices tools Claude agents
have (`mcp__allmyagents__*`), so Codex can **send/list/read** on the fleet bus and read/write scoped
memory + practices — not just *receive* bus messages. Before this, `buildAgentMcpServer` was a
Claude-Agent-SDK in-process server (`createSdkMcpServer`) wired only into the Claude driver; the Codex
adapter registered no MCP server, so `list_mcp_resources{server:'allmyagents'}` returned "unknown MCP
server" for Codex.

---

## 1. What Codex actually gives an MCP server (verified against the installed binary)

All of the following was verified live against **codex-cli 0.145.0-alpha.30** (`C:\Users\Admin\.codex\
.sandbox-bin\codex.exe`) by driving a real `codex app-server` with a logging stub MCP server — not
inferred from docs.

- **Transport.** `config.toml [mcp_servers.<name>]` under `CODEX_HOME` supports **both**:
  - **stdio** — `command` + `args` + `[mcp_servers.<name>.env]` (a table of env vars).
  - **streamable HTTP** — `url` + optional `bearer_token_env_var` (+ OAuth fields).
  (`codex mcp add <name> -- <cmd>` / `codex mcp add <name> --url <url>` write exactly these.)
- **Config scope is per-profile, static.** One `codex app-server` per profile (the hub keys
  `codexClientFor` by `profile.id`), reading that profile's `CODEX_HOME/config.toml`. The same server
  declaration is shared by **every thread on that profile**.
- **The MCP server is spawned per THREAD.** Each `thread/start` spins up a **fresh** MCP server
  connection (a new stdio child for stdio; a new MCP session for HTTP), and the hub receives a
  `mcpServer/startupStatus/updated { threadId, name, status }` notification for it. So there is a
  1:1 (thread ↔ MCP connection) mapping.
- **But Codex passes NO thread/session identifier to the server.** The stdio child launches with the
  *identical static* `command`/`args`/`env` for every thread; the `initialize` `clientInfo` is the
  generic `codex-mcp-client`; over HTTP the bearer token is the *profile-level* one and there is no
  thread id in any header or param. **The one per-session signal Codex does give a stdio child is its
  `cwd`: the child inherits the thread's cwd** (its session worktree/dir), verified by starting the
  app-server in one dir and a thread in another — the child got the *thread's* dir.

**Consequence (the crux):** a hub-run MCP server shared across a profile's Codex sessions cannot learn
*which session* is calling from the transport alone. The only hub-observable per-session signal for a
stdio server is the child's **cwd**.

---

## 2. The mechanism chosen — stdio bridge, cwd attribution, hub-executed bodies

```
codex app-server (per profile)
  └─ thread/start  ──spawns──►  agentBridge.js  (stdio MCP server, cwd = the session's dir)
        tools/list ◄────────────  exposes the 10 mcp__allmyagents__ tools (from the shared core)
        tools/call ──forwards──►  POST http://127.0.0.1:<hub>/internal/agent-tool
                                   { profileId, cwd: process.cwd(), tool, args }  + Bearer <secret>
                                        │
                                   HUB (SessionManager.execAgentTool)
                                     resolve (profileId, cwd) → Codex SessionIdentity
                                     run the SAME provider-agnostic tool body via agentServices()
                                     → identical ACL + practice gate as the Claude path
```

Why this shape:

- **The tool bodies run IN the hub**, not in the bridge. The bodies need live hub state (the approval
  service, bus delivery nudges, `isBusTurn`, the journal), so the bridge is a thin transport shim that
  forwards each call; the hub is the single source of truth and executes the real body. This keeps
  Claude and Codex running the *exact same code path* into `AgentServices`.
- **stdio over HTTP** because stdio is the only transport that carries a per-session signal (cwd).
  Over HTTP the bearer is profile-level and no thread id is sent, so HTTP alone cannot attribute a
  session without the §6 owner decision.
- **cwd is a hub-derived attribution, not agent-asserted.** `process.cwd()` is the bridge child's own
  working directory, set by Codex when it spawned the child — an agent cannot change its process's cwd
  via a tool argument. This is the same posture as `checkWriteScope` deriving the allowed worktree from
  the record, never from agent input.

---

## 3. What was built (all in `apps/hub/src`)

| File | Role |
|---|---|
| **`agentToolCore.ts`** (new) | The **provider-agnostic core**: the `AgentServices` interface + all 10 tool bodies (`list_agents`/`send_message`/`read_messages`/`memory_*`/`practice_*`) as `AgentToolSpec`s that return plain text, plus `runAgentTool(name, args, ctx)`. This is the single definition both providers share. |
| **`agentTools.ts`** (refactored) | `buildAgentMcpServer` (Claude) now just maps the core specs into the Claude SDK `tool()` shape + binds the fixed identity. **Behavior identical** — it re-exports `AgentServices` so `sessions.ts` needed no import change. |
| **`agentMcpServer.ts`** (new) | A dependency-free **stdio MCP server** (JSON-RPC 2.0, protocol `2025-06-18`) exposing the core tools — the Codex counterpart of the in-process Claude server. Converts each tool's zod shape to JSON Schema via `z.toJSONSchema`. Parameterized by an injected `execute(name,args)` so it is testable without codex/hub. |
| **`agentBridge.ts`** (new) | The thin entry Codex spawns per thread; reads `AMA_HUB_URL`/`AMA_HUB_SECRET`/`AMA_PROFILE_ID` + its cwd and forwards each call to the hub. Auto-runs only when executed directly. |
| **`codexMcpConfig.ts`** (new) | Writes/idempotently refreshes `[mcp_servers.allmyagents]` (+ `.env`) into a profile's `config.toml`, **owning only our table** and preserving all other operator config / MCP servers. |
| **`sessions.ts`** (edited) | `setCodexBridge()` + `ensureCodexMcpConfig()` (writes the config before the app-server starts, on first use of a Codex profile); `resolveCodexIdentity(profileId, cwd)` (the attribution); `execAgentTool(profileId, cwd, tool, args)` (resolve identity → run the shared body via `agentServices()`). |
| **`server.ts`** (edited) | `POST /internal/agent-tool`, gated by the bridge secret (timing-safe `tokenMatches`), origin/host-guarded to loopback, → `sessions.execAgentTool`. |
| **`index.ts`** (edited) | Generates the bridge secret, computes the bridge path (`dist/agentBridge.js`), and wires `setCodexBridge` + passes the secret to the server — only when the built bridge exists, so a dev hub run from `.ts` degrades gracefully (Codex keeps receiving bus messages, just without the tools). |
| **`instructions.ts`** (edited) | The materialized agent contract now says both providers hold the tools (was "Codex has no MCP wiring yet"). |

Tests (36 new; suite 124 → 165, all green): `agentToolCore.test.ts` (the shared bodies + ACL + the
practice gate incl. bus-turn hard-deny), `agentMcpServer.test.ts` (the MCP protocol + JSON-Schema),
`codexMcpConfig.test.ts` (render/strip/upsert idempotency, preserving other config), `agentBridge.test.ts`
(the hub-forward + failure handling), and `codexAgentTools.test.ts` (the real `SessionManager.execAgentTool`
attribution + the same-project bus ACL, driven through actual hub plumbing on an in-memory DB — no live
hub, no codex).

---

## 4. How the Claude path stays unchanged

The Claude driver still calls `buildAgentMcpServer(identityOf(record), agentServices())` and passes the
in-process server via `options.mcpServers` exactly as before. The only change is that
`buildAgentMcpServer` now sources its tool list from `AGENT_TOOLS` instead of inlining them — same names,
descriptions, schemas, bodies, `instructions` string, and `mcp__allmyagents__*` namespace. The
`AUTO_ALLOW_TOOLS` / `SELF_GATING_TOOLS` sets and the `canUseTool` wiring are untouched.

## 5. How identity + ACL are enforced for Codex (same guarantees as Claude)

- **Identity** is resolved hub-side from `(profileId, cwd)` → the Codex `SessionIdentity`. The bridge
  cannot forge it (cwd is its own process's dir; the profile id + secret come from the hub-written
  config, not the agent).
- **Same-project bus ACL**: `send_message` runs the same `busSend`, which denies cross-project /
  self / stopped-recipient exactly as for Claude (tested: cross-project send → "cross-project messaging
  is not allowed").
- **Scoped memory/practices**: the bodies use `readableScopes`/`writableScopes(identity)`, so a Codex
  session sees only global + its vendor + its project + its own account (tested).
- **The practice gate**, including the **bus-turn hard-deny**, is enforced *inside the shared body*
  (`decidePracticeGate` reading `services.isBusTurn(sessionId)`), and `runCodexTurn` already tags
  bus-caused turns in `busTurnSessions`. So a teammate-message-caused Codex turn cannot write a
  practice — the same invariant Claude has — with no extra wiring. (Codex MCP tool calls do not pass
  through the Codex `onApproval` gate at all, so the body self-gate is exactly the right — and
  sufficient — place, mirroring the Claude self-gate that also fires under `full`.)

---

## 6. The residual OWNER DECISION — robust attribution for shared-cwd sessions

**cwd uniquely identifies a session for the common case** — hub-created worktree sessions each get their
own dir under `data/worktrees/<sessionId>`. It is **ambiguous only** when two Codex sessions **on the
same profile** share a cwd, which happens for **non-worktree** (`useWorktree:false`) or **imported**
(resume-in-place) sessions in the same directory. Today `resolveCodexIdentity` handles this by
tiebreaking on the lone `active` session (a tool call happens mid-turn) and **refusing rather than
mis-attributing** when still ambiguous (the tool returns "Not attributed…"). That is safe (never wrong)
but means a small class of concurrent same-profile+same-dir Codex sessions can't use the tools.

The fully-robust fix needs a per-session key Codex will carry to the server. Codex 0.145 provides none,
so this is a genuine fork the owner should pick:

- **(A) Ship as-is (recommended default).** cwd attribution + refuse-on-ambiguity. Correct for every
  worktree session (the default for git projects) and single-session-per-dir setups; the ambiguous
  case is rare and fails safe. **Zero new process/auth risk.** This is what's built.
- **(B) Per-session `CODEX_HOME`** (the "clean" answer, but a real architecture change). Give each
  Codex *session* its own config dir with a **session-tokened** MCP server, so identity is unambiguous
  and concurrent. This requires **one app-server per session** (CODEX_HOME is per-app-server) and
  sharing the profile's `auth.json` **without copying it** (symlink/point — copying rotates the
  single-use ChatGPT OAuth refresh token → `refresh_token_reused` loops, a hard project rule). The
  auth-share-without-copy is **unverified** and the per-session app-server multiplies process count.
  Worth a spike **only if** concurrent same-dir Codex sessions become a real need.
- **(C) Wait for Codex to pass a thread id to MCP servers.** Then the hub maps threadId→session
  trivially (it already tracks `codexThreads`) with no cwd heuristic — the cleanest of all, but
  **requires codex-side support that does not exist today** (tracked at the MCP-identity level; cf.
  `openai/codex` MCP work). Re-evaluate on a codex upgrade.

**Recommendation: (A) now, (C) when codex supports it; (B) only on a concrete need for concurrent
same-directory Codex sessions.** (A) is not a compromise for the dominant worktree workflow — it is
exact there.

---

## 7. End-to-end validation (against the real codex binary)

Two live checks beyond the unit suite (both PASS):

- **Bridge ↔ hub roundtrip** — drove the **built** `dist/agentBridge.js` as a child over stdio (as codex
  does) with a stub hub: it completed `initialize` (serverInfo `allmyagents`), listed **all 10 tools**,
  and forwarded a `tools/call` to the hub carrying `Bearer <secret>`, `profileId`, `tool`, `args`, and
  **the child's cwd** (= the session dir — the attribution signal), returning the hub's text.
- **Real codex loads the config** — the hub-written `config.toml` is accepted by real codex 0.145
  (`codex mcp get allmyagents` shows it as an enabled stdio server), and a real `codex app-server`,
  on `thread/start`, spawned the built bridge and reported `mcpServer/startupStatus/updated
  { name:'allmyagents', status:'ready' }` (no error). A model actually *invoking* a tool needs a
  ChatGPT-authenticated turn (the sandbox returned 401 for the model websocket), so that leg is covered
  by the bridge-roundtrip check + unit tests rather than a live model turn.

---

## 8. Notes / smaller follow-ups (not blockers)

- **Bridge path / dev runs.** The config points at `dist/agentBridge.js`; the wiring only activates when
  that file exists (bundled/compiled hub) or `AMA_BRIDGE_PATH` is set. A hub run straight from `.ts` via
  tsx therefore won't hand Codex the tools until built — Codex still receives bus messages meanwhile.
- **Bridge secret + blue-green.** The secret is generated per boot and the bridge posts to the public
  port. A blue-green handoff briefly has blue's in-flight bridges holding the old secret; they'd get a
  403 from a promoted green, but those sessions are retiring anyway. Persisting the secret (like the
  device token) would remove even that transient — a small future hardening.
- **Long-held approvals.** A project/global practice write from Codex blocks the `/internal/agent-tool`
  request while `requireApproval` awaits the operator (up to the 10-min fail-closed timeout). The route
  has no shorter server timeout, but very long-lived requests over a restart are a known edge worth a
  keep-alive/poll design if it ever bites.
```
