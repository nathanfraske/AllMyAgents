# Vendor remote control from the phone — interim feasibility scope

Design scope, drafted 2026-07-24. **Scoping only — no code changed; read-only on `apps/hub/src`.**
Web research used to pin the vendors' *current* (mid-2026) product features. Extends and stress-tests
**DESIGN.md principle 5 (self-hosted transport)**, **principle 2 (the hub owns every process)**,
**D12 (security/device auth)**, **D13 (sidecars)**, and especially **D13.1 (mesh remote access via
AllMyStuff "sites")**, which is the already-built alternative this doc measures against.

The ask (from the user): *"Make the agents automatically (if toggled on) have remote-control ability
for now through their respective apps — like ChatGPT's remote control from the phone for Codex, and
Claude's remote control — so I can work with one or two agents directly before we have our mobile app
stood up."* i.e. a per-session opt-in toggle that surfaces a **hub-run** agent to the **vendor's own**
phone app, as an interim before the mesh mobile story is finished.

---

## Verdict (read this first)

Both vendors **did** ship phone remote-control of *local* sessions in 2026 — this is newer and more
capable than the "cloud-only" picture principle 5 was written against. Claude **Remote Control** (GA-ish
research preview, launched 2026-02-25) and Codex's `remote-control` / ChatGPT-app panel (experimental,
CLI v0.130, ~2026-05) both keep code execution and the filesystem on your machine and let the phone
steer, approve, and read.

**But neither is a clean "toggle" on the sessions our hub actually runs**, for the same underlying
reason on each side — a *surface mismatch*:

| | Hub drives it via | Vendor remote-control is bolted to | Can the hub flip it on in-place? |
|---|---|---|---|
| **Claude** | Agent SDK `query()` (`adapters/claude.ts:66`) | the `claude` **CLI** / VS Code extension only | **No** — the SDK cannot activate Remote Control (open feature request, `anthropics/claude-code#29006`) |
| **Codex** | a hub-spawned `codex app-server` over stdio (`adapters/codex.ts:110`) | a **managed app-server daemon** that launches its *own* standalone binary; refuses to adopt an "unmanaged" app-server and can't share an existing session | **No** — ownership collision (`openai/codex#24542`), exclusive-session limit (`openai/codex#9200`) |

And both route the session's **transcript + control plane through the vendor's cloud** — the exact
thing principle 5 / D13 exist to avoid. Files stay local; the *conversation* does not.

**Recommendation:** don't build a deep vendor-remote integration now. It can only be done by
**abandoning our adapter contract and journal ownership for that session** (Claude) or **inverting
process ownership to an experimental, buggy daemon** (Codex) — both against principle 2. Instead, finish
the **one blocker** on the path we already built: the **device token for the mesh site (D13.1)**. That
already lets the phone browser reach the *full* hub UI over MyOwnMesh — every session, no vendor relay —
which is strictly better on both trust and coverage than "one or two agents through the vendor app."
Keep vendor remote control as an explicitly-labeled, off-by-default, per-session **escape hatch**, not a
core feature. Details, mechanism sketch, and a phased plan below.

---

## 1. What "vendor remote control" means in mid-2026 (the landscape shifted)

Principle 5 says *"Both vendors' remote channels relay through their clouds, require a healthy host
session, and are closed to third parties."* All three clauses are still true, but the capability grew:
in 2025 the phone could only reach **cloud** sessions; in 2026 both vendors added phone control of a
**local** session while keeping execution + filesystem on the host. That is precisely the shape the user
is asking for, so the question is no longer "does it exist" but "can *our* hub-owned processes plug into
it." There are now four distinct things to keep straight:

| Product | Where the agent runs | Reaches our hub sessions? |
|---|---|---|
| **Claude Remote Control** | your machine (local `claude` CLI) | only if we run the `claude` CLI instead of the SDK |
| **Claude Code on the web** / **Dispatch** | Anthropic cloud / a paired **Desktop app** | no — different host, not our process |
| **Codex `remote-control`** (local) | your machine (managed app-server daemon) | only if we hand ownership to the daemon |
| **Codex Cloud** (`codex cloud exec`, Local↔Cloud handoff) | OpenAI cloud container | no — fully server-side |

This doc is about rows 1 and 3 (local remote control). Rows 2 and 4 are cloud sessions and are a
non-starter for a hub whose premise is local ownership; they're noted only to bound the question.

---

## 2. Claude — Remote Control

### 2.1 How it actually works (verified, official docs)

`claude remote-control` (server mode), `claude --remote-control`, the in-session `/remote-control`
command, or the VS Code extension's `/rc` start it. The local process **"makes outbound HTTPS requests
only and never opens inbound ports… registers with the Anthropic API and polls for work,"** and when a
phone/browser connects, **"the server routes messages between the web or mobile client and your local
session over a streaming connection."** Execution and filesystem stay on the machine; the phone/browser
is *"a window into that local session."* The phone can send messages (steer), answer permission prompts
(approve tool calls), read output, and run a subset of slash commands (`/model`, `/effort`, `/compact`,
…). Availability: **research preview on Pro, Max, Team, Enterprise** (off-by-default admin toggle on
Team/Enterprise). Source: code.claude.com/docs/en/remote-control.

### 2.2 The blocker: it's a CLI feature, and the hub uses the SDK

Our Claude adapter is `query()` from `@anthropic-ai/claude-agent-sdk` (`adapters/claude.ts:66`), with a
`canUseTool` permission callback, token metering, and every message re-emitted as a normalized
`claude/<type>` event into the journal. **Remote Control is not reachable from that surface.** Per the
docs it is only startable from the `claude` CLI or the VS Code extension, and the community/issue record
is explicit: *"When running Claude Code through the Claude Desktop app (Agent SDK / MCP integrations),
there is no way to activate Remote Control"* — tracked as the open request
`anthropics/claude-code#29006`. The Agent SDK's `query()` is *"fundamentally different… designed for
programmatic iteration over messages rather than remote session management."*

So making a hub Claude session appear in the Claude phone app is **not a toggle on our session**. It
would require the hub to spawn the *real* `claude remote-control` process for that session and give up
the SDK adapter for it — losing the `canUseTool` router (D12 approvals), the normalized event stream and
journal replay (D3, principle 2), token/usage metering (D14), and our steer/interrupt hooks. It is a
second, parallel integration path, not an enhancement of the existing one.

### 2.3 Auth compatibility (a narrower gap, but a real one)

Remote Control **requires a full-scope claude.ai OAuth login** and **explicitly rejects API keys and
long-lived tokens**: *"You're authenticated with a long-lived token from `claude setup-token` or the
`CLAUDE_CODE_OAUTH_TOKEN`… These tokens can only make model requests, so they can't establish Remote
Control sessions."* It is also disabled when `ANTHROPIC_BASE_URL` points anywhere other than
`api.anthropic.com`. Our profiles log in via `/login` and store `.credentials.json` in the config dir
(D4), which *should* be a full-scope session token — so auth is *plausibly* compatible today, but it is
fragile: the moment any profile is switched to `setup-token`/token auth or a gateway base-URL (both
things a self-hosted fleet might reasonably do), Remote Control breaks. **Flag:** I did not verify the
on-disk token scope of our profiles' `.credentials.json`.

### 2.4 Trust cost (Claude)

*"While Remote Control is connected, the session transcript, including your messages, Claude's
responses, and tool activity, is stored on Anthropic servers."* Organizations under Zero Data Retention
can't use it at all. So the leak is the **entire conversation and tool-activity stream**, persisted at
the vendor — not the filesystem, but everything said and done in the session.

---

## 3. Codex — `remote-control` / ChatGPT app

### 3.1 How it actually works (verified against the app-server-daemon README)

Two host routes exist:

- **Codex desktop App (GUI)** as the "Codex App host" — the consumer path. It owns `~/.codex`, which
  **D4 forbids us from touching** (*"Never point tooling at `~/.codex` — the Codex desktop app owns that
  token chain"*). Non-starter for the hub.
- **CLI / daemon (headless)** — `codex remote-control` (CLI **v0.130**, listed **experimental**) whose
  job is *"to ensure that the local app-server daemon is running with remote-control support enabled."*
  It is *"a convenience wrapper around the app-server layer… it does not introduce a new process or
  protocol — it configures the existing one for headless use."* The underlying daemon subcommands
  (`codex-rs/app-server-daemon/README.md`) are `daemon start | restart | enable-remote-control |
  disable-remote-control | stop | version | bootstrap --remote-control`. Daemon state lives under
  **`CODEX_HOME/app-server-daemon/`** (good — it respects our per-profile `CODEX_HOME`). Pairing:
  `codex remote-control pair` prints a short-lived code (`pairingCode`, `manualPairingCode`,
  `environmentId`, `expiresAt`); completing it needs *"a phone already signed into the same ChatGPT
  account and workspace."* The March-2026 app-server added WebSocket transport, bearer-token auth
  (`capability-token` local / `signed-bearer-token` HMAC), and health endpoints. The relay *"carries
  only text-based messages: session output, approval requests for file changes, and your responses"* —
  files/credentials/execution stay local. The phone can start, steer, approve, review diffs/tests,
  inspect terminal output, and switch model/host.

### 3.2 The blocker: managed daemon vs our unmanaged app-server

Our Codex adapter does `spawn('codex app-server', { env: { CODEX_HOME }})` and owns that process
directly over stdio (`adapters/codex.ts:110-113`) — an **unmanaged** app-server, in OpenAI's
terminology. Remote control refuses to adopt it: the daemon README states *"bootstrap requires the
standalone managed install"* and the lifecycle commands *"always launch the standalone managed binary"*
under `CODEX_HOME`, with **no path to attach to an externally-spawned app-server.** This collision is a
filed bug, not a theory: `openai/codex#24542` — *"Codex Desktop remote proxy respawns unmanaged
app-server and blocks daemon bootstrap."* And even the managed path is exclusive: the original
remote-control request thread (`openai/codex#9200`) records *"you can't start remote-control and share an
existing session."*

So, as with Claude, the hub **cannot flip remote control on for the thread it is already running.** The
only route is to **invert ownership**: stop spawning our own app-server for that profile and instead let
`codex app-server daemon` (managed, remote-control-enabled) be the process, then rewrite our Codex
adapter to be a **WebSocket + bearer-token client of that daemon** rather than a stdio owner. That is a
real adapter rework against a surface that is (a) experimental, (b) already carrying pairing/headless
bugs (`openai/codex#22851` mobile pairing stuck; `openai/codex#23200` headless-Linux hosts), and (c)
possibly still unable to surface the *specific* in-flight thread we care about (the exclusive-session
limit). **Flag:** whether two per-profile managed daemons can coexist on one machine (socket/singleton
contention) is untested and, given `#24542`, looks risky.

### 3.3 Trust cost (Codex)

Same shape as Claude: the control channel and text stream (output, approvals, your replies) relay
through **OpenAI's cloud relay**; files and execution stay local. Pairing binds the session to a ChatGPT
account+workspace identity — which, notably, is the *same account-side identity* the DESIGN open
question "server-side identity influence on 'clean' profiles" already worries about (§10).

---

## 4. If we built it anyway — the toggle + mechanism (design sketch)

Recorded for completeness; **not recommended now** (see §6). A per-session opt-in, consistent with D12
scoping:

- **Toggle:** a new session field `vendorRemote: 'off' | 'on'` (default `off`), gated behind a D12
  scope (e.g. `vendor-remote`) so only an explicitly-granted device/user can enable it, and surfaced as
  a clearly-labeled *"route this session through the vendor's cloud"* switch — never a silent default.
- **What the hub does on enable — and it is not uniform:**
  - *Claude:* the hub cannot upgrade the running SDK session. It would **spawn a separate `claude
    remote-control` process** (or `claude --remote-control`) in the session's worktree, babysit it, and
    surface the session URL/QR. This session is effectively **outside** our adapter — the hub becomes a
    launcher/supervisor, not the owner.
  - *Codex:* the hub would need to **hand the profile to a managed `codex app-server daemon
    enable-remote-control`** and re-attach as a daemon client (see §3.2), then run `codex remote-control
    pair` and relay the pairing code to the user. Blocked today by the unmanaged-collision and
    exclusive-session limits.
- **What the phone can then do:** steer (send follow-up turns), approve tool calls, read output/diffs,
  switch model/effort — the vendor's full remote surface.
- **What breaks (the honest limitations):**
  - **The hub loses exclusive ownership** — directly violates principle 2 ("the hub owns every agent
    process… the structural fix for flaky vendor remote control"). We'd be re-introducing the flaky
    vendor remote control the whole architecture was built to replace.
  - **Two controllers, one session.** The vendor relay and our hub can both drive it. Our approval
    router (D12) and the vendor's approval prompt can now *both* fire; an approval taken on the phone is
    invisible to our audit unless we tee it. This is the "injected-turn / laundered authority" family of
    risks (§10 open questions) with a second front door.
  - **Journal blind spots.** Phone-side messages/approvals travel to the *vendor relay*, not to
    `127.0.0.1:7777` — so they do **not** land in our event-sourced journal (D3) unless the vendor also
    streams them back through the surface we're attached to. For Claude-via-CLI we've left the SDK event
    stream entirely; for Codex-via-daemon-client we might recover some events, unverified. Replay,
    forensics (D11), and usage metering (D14) all degrade for that session.
  - **Auth fragility** (Claude §2.3) and **experimental instability** (Codex §3.2).

---

## 5. Trust / privacy tradeoff (the D13 / principle-5 collision, made explicit)

The mesh premise (principle 5, D13, D13.1) is a deliberate choice to **not** route sessions through
vendor relays because the user distrusts them. Vendor remote control is the direct opposite of that
choice. Being concrete about what each vendor *gains* when the toggle is on:

| | Stays on your machine | Goes to / is stored by the vendor cloud |
|---|---|---|
| **Claude Remote Control** | code execution, filesystem, MCP servers, tools | **the full session transcript — your messages, Claude's responses, and all tool activity — stored on Anthropic servers** |
| **Codex remote-control** | source files, credentials, SSH keys, env, execution | **session output, file-change approval requests, and your responses, relayed through OpenAI's cloud** |

The right framing is: this is a **deliberate, per-session, off-by-default interim convenience** that
trades the conversation + control plane to one vendor for the ability to use *that one vendor's* polished
phone app on *one or two* agents. It does **not** leak the filesystem. It **does** defeat the reason the
mesh exists, for whichever sessions it's enabled on. If we ship it at all, it must be labeled in the UI
as exactly that trade, and it must never be the default or a fleet-wide setting.

---

## 6. Recommendation + phased plan

**Is Codex-via-ChatGPT-app feasible for our local sessions? Not as a toggle** — it needs process-ownership
inversion to an experimental managed daemon that won't adopt our app-server. **Is Claude-via-Claude-app
feasible? Not as a toggle** — Remote Control is CLI-only and unreachable from the Agent SDK we drive with.
Both are individually *possible* only by giving up the adapter/ownership model for the affected session,
and both leak the transcript to the vendor. So:

**Prefer the path we already built.** D13.1's mesh site (`apps/hub/src/meshSite.ts`, BUILT 2026-07-23)
already tunnels the hub's loopback WS over MyOwnMesh as an AllMyStuff *site*, so the phone browser gets
the **full hub UI over the mesh — every session, no vendor relay, E2E.** That dominates vendor remote
control on both trust *and* coverage (all agents, not one or two). Its **only** blocker for
phone-from-anywhere is the **device token** (D13.1 "STILL PENDING" item #1; also the audit's Critical
C1: the hub has no auth today, so exposure is correctly off-by-default). **The single highest-leverage
move for the user's actual goal — "work with agents from my phone now" — is to land the device token,
not to integrate a vendor relay.**

Phased:

- **P-now (recommended): ship the mesh device token.** Bearer/device token required on all `/api` +
  `/ws` when exposure is on (closes C1 + D13.1 #1), wire the web UI + desktop app to present it, add the
  D13.1 mesh panel showing `peerUrl` + the enable toggle. Outcome: phone → full fleet over the mesh, no
  vendor cloud. This is the real interim mobile story.
- **P-now fallback (already contemplated):** if the mesh identity isn't paired to the phone yet,
  Tailscale is the day-one stopgap already blessed in principle 5 / D13.1 — same "phone browser reaches
  the loopback hub UI" shape, still no vendor transcript relay.
- **P-later (optional escape hatch, off by default): a single-vendor "hand this one session to the
  vendor app" mode.** For **Claude**, spawn a raw `claude remote-control` session (accept it's a vanilla
  Claude Code session outside our adapter, with the journal blind spot and the Anthropic transcript
  store). Practical for *one* Claude agent today; label the trade. For **Codex**, defer until the
  `remote-control` daemon surface stabilizes (track `#24542`, `#22851`, `#23200`) — the ownership
  inversion isn't worth it against an experimental target while the mesh site exists.
- **Do not** wire vendor remote control into the normal spawn path, make it a default, or allow it
  fleet-wide.

**If the user still wants one Claude agent on the phone this week** without waiting for the device token:
`claude remote-control` in that project's directory works today (it needs a claude.ai OAuth login, which
the profile already has). It just won't be a *hub-managed* session and its transcript lives at Anthropic
— a conscious, temporary trade for one agent.

---

## 7. What I could not verify (flags)

- **Claude profile token scope.** Remote Control needs a *full-scope* claude.ai session token and
  rejects `setup-token`/`CLAUDE_CODE_OAUTH_TOKEN`. Our profiles log in via `/login` so this should hold,
  but I did not inspect the on-disk `.credentials.json` scope.
- **Codex two-daemon coexistence.** Whether two per-profile managed daemons (two `CODEX_HOME`s) can run
  remote-control on one machine without socket/singleton contention is untested; `#24542` suggests the
  managed/unmanaged split is already fragile.
- **Codex thread sharing.** All evidence (`#9200`) says remote-control uses an *exclusive* session and
  cannot surface a thread another controller started — but I could not find an authoritative statement
  that this is permanent vs a current limitation.
- **Codex control-socket path** under `CODEX_HOME` and its exact framing were not pinned; the README
  documents the daemon subcommands and `CODEX_HOME/app-server-daemon/` state dir but not the socket
  wire protocol.
- **Source-fetch gap.** `openai.com` returns HTTP 403 to the fetch tool, so Codex claims lean on the
  official GitHub repo (`codex-rs/app-server-daemon/README.md`, discussions/issues) plus secondary write-
  ups. One secondary source (laozhang.ai) claims mobile setup is *"not available from Codex CLI or the
  IDE extension"*, which conflicts with the v0.130 `codex remote-control` CLI command; I treated the
  GitHub README + v0.130 as authoritative (newer, first-party) and read the laozhang claim as describing
  the desktop-App consumer route.

---

## Sources

Claude:
- Remote Control — official docs: https://code.claude.com/docs/en/remote-control
- SDK-can't-do-Remote-Control feature request: https://github.com/anthropics/claude-code/issues/29006
- Launch coverage (2026-02-25): https://venturebeat.com/orchestration/anthropic-just-released-a-mobile-version-of-claude-code-called-remote · https://www.helpnetsecurity.com/2026/02/25/anthropic-remote-control-claude-code-feature/

Codex:
- app-server daemon README (subcommands, managed-only, `CODEX_HOME` state): https://github.com/openai/codex/blob/main/codex-rs/app-server-daemon/README.md
- "Remote control codex from ChatGPT app" discussion (shipped ~2026-05-18; exclusive session): https://github.com/openai/codex/discussions/9200
- Unmanaged app-server / daemon-bootstrap collision: https://github.com/openai/codex/issues/24542
- Headless-Linux host + mobile pairing bugs: https://github.com/openai/codex/issues/23200 · https://github.com/openai/codex/issues/22851
- v0.130 remote-control writeup (wrapper around app-server, auth modes): https://codex.danielvaughan.com/2026/05/09/codex-cli-v0130-remote-control-headless-agent-services-thread-pagination/
- App-server WebSocket/bearer transport: https://codex.danielvaughan.com/2026/03/31/codex-cli-app-server-remote-websocket/
- Codex Cloud (server-side path, for contrast): https://developers.openai.com/codex/cloud
- ChatGPT-app host model (secondary): https://blog.laozhang.ai/en/posts/openai-codex-mobile-app

Internal:
- `DESIGN.md` — principle 2, principle 5, D4, D12, D13, **D13.1**, §10 open questions
- `docs/audit-findings.md` — C1 (no-auth) which D13.1's device token closes
- `apps/hub/src/adapters/claude.ts` (SDK `query()`), `apps/hub/src/adapters/codex.ts` (spawns `codex app-server`), `apps/hub/src/meshSite.ts` (the built mesh-site alternative)
