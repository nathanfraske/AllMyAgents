# Emulated agent tools — build & integration design

Build design, drafted 2026-07-24. **Implementation plan only — no code changed; one markdown file.** This is
the buildable follow-through for the recommendation **already accepted in `docs/agent-native-tools.md`**
(read that first). That doc established the findings this one builds on and does not re-argue:

- **Codex** computer + browser control are **app-only** — unreachable from `codex app-server` (our driver).
- **Claude** native `computer-use` is **macOS + interactive-only** (excluded in the `-p` / SDK path);
  **Claude-in-Chrome** is an MCP server but its activation is CLI-framed (a spike, not a clean SDK path).
- The **accepted direction**: a **hub-run, vendor-neutral MCP** wired into **both** providers through the
  MCP seams the hub already owns (Claude `options.mcpServers`; Codex profile `config.toml [mcp_servers]`),
  behind a **per-session capability toggle, off by default**, that composes with the existing
  `permissionMode` + `canUseTool`/`onApproval` gate. Native harnesses stay as labeled escape hatches where
  reachable.
- The **hard security invariant**: a powerful native/emulated tool call must be **impossible to trigger from
  a bus-caused (untrusted) turn** and **never auto-approved** — a distinct, higher-risk tool class.

This doc answers the "how do we actually build it" question for **three** emulated capabilities —
**browser control, computer/desktop control, and native visualization** — for **both** Codex and Claude,
grounded in the current code. It uses web research (mid-2026) to pin concrete tool flags/APIs the scoping
doc left abstract. **It changes no code.**

---

## 0. Verdict — build order, risk, target (read this first)

- **Recommended build order:** **P0** spike (prove the seam + the gate holds) → **P1** hub-run **browser
  MCP** for both providers (the one capability reachable today on both, headless, isolable) → **P2**
  **native visualization** capture + safe render (also unlocks rendering the browser's screenshots) → **P3**
  **sandboxed computer control** last (highest blast radius) + native escape hatches where reachable.
- **Single biggest technical risk:** **Codex identity binding.** The hub runs **one `codex app-server` per
  profile, multiplexing threads** (`sessions.ts:130` `codexClientFor` keyed by `profile.id`), and a Codex
  MCP server is declared in that profile's **shared** `config.toml [mcp_servers]` — so a browser/computer
  tool call from a Codex thread **cannot be natively attributed to a specific session / browser context /
  pane.** The clean fix (a per-session `CODEX_HOME`) collides head-on with the project's own hard rule
  **"NEVER copy a Codex `auth.json` between homes"** (ChatGPT OAuth refresh tokens are single-use/rotating).
  §5.6 gives a pragmatic **lease** answer and flags the clean answer as a spike.
- **Second, load-bearing finding (new here, not in the scoping doc):** the existing **`full` permission mode
  disables the very approval callback the native-tool gate depends on — for *both* providers.** Claude
  `full → bypassPermissions` (`claude.ts:65`) skips `canUseTool`; Codex `full → approvalPolicy:'never'`
  (`sessions.ts:329`) means no approval request ever fires. So **enabling a native capability must force the
  turn into a mode where the gate is live** (§5.3). Without this, a `full` session runs browser/computer
  tools ungated.
- **Sandbox target for computer control (recommended):** **not** the operator's live desktop. A **dedicated
  headless Linux node with a virtual display (Xvfb + a lightweight DE) reached over MyOwnMesh** — a
  self-hosted equivalent of E2B's desktop sandbox — with a throwaway local **VM** as the offline fallback.
  This matches the project's self-hosted-mesh posture and keeps the trust boundary off the user's host.

---

## 1. The seam we build on (grounded)

Everything here hangs off machinery the hub **already has**. The three capabilities are three payloads on
one shared spine.

**MCP insertion points (both already used):**

- **Claude** — `agentTools.ts` `buildAgentMcpServer(identityOf(record), services)` builds an **in-process
  SDK MCP server** bound to one session's identity; `sessions.ts:200` passes it as
  `{ allmyagents: … }`; `claude.ts:69` forwards it to `query()` as `options.mcpServers`. Tools surface as
  `mcp__allmyagents__*`. **This is the exact seam a browser/computer server plugs into**, per session,
  identity-bound.
- **Codex** — MCP servers are **not** per-turn; they live in the profile's `config.toml [mcp_servers]` under
  `CODEX_HOME`, read by the long-lived `codex app-server` (`codex.ts:110` `spawn('codex app-server', { env:{
  CODEX_HOME }})`). One server declaration is **shared by every thread on that profile** — the identity
  problem of §0/§5.6.

**The approval gate (both already used):**

- **Claude** `canUseTool` (`sessions.ts:184-197`): line **187** auto-allows `mcp__allmyagents__*`; everything
  else runs `checkWriteScope` then `approvals.request(record.id, 'claude/tool', …)`.
- **Codex** `onApproval` (`sessions.ts:155-160`): server-requests resolve to `approvals.request(record?.id,
  'codex/${method}', params)`, attributed by `threadId → sessionForThread`.
- **Worktree fence** `checkWriteScope` (`sessions.ts:110-121`): `path.resolve` + `startsWith(root+sep)`
  containment, journaled `approval/auto-denied-scope`. **We reuse this exact containment for viz path
  fencing (§4).**

**The untrusted-turn clamp (the invariant lives here):** `deliverBus` (`sessions.ts:461-481`) injects
teammate messages as one turn with `clampMode` (`sessions.ts:573`, `full → edits`) and the sentinel frame.
There is currently **no signal reaching `canUseTool`/`onApproval` that a turn is bus-caused** — §5.2 adds
one.

**Event spine:** every event flows through `journal.append` (`journal.ts:27`) → `redact()` → SQLite →
WS replay (`server.ts:539`), consumed by the stateless store `apply()` (`store.svelte.ts:588`). Audit and
replay are free for anything we journal. The web renders model text through the **single** sanitizer
`markdown.ts` (the `img` ban lives at line **59**).

**Shared architecture (all three capabilities):**

```
                          ┌───────────────────────────── HUB (Node, owned by the Rust host) ──────────────┐
   Claude query()         │  Capability broker (per session: nativeTools{browser,computer} + scope)        │
   options.mcpServers ───►│    ├─ Browser broker  → owns a Chromium via CDP (remote-debugging-port)        │
                          │    │                     one browser CONTEXT per session (isolation + identity) │
   Codex app-server       │    ├─ Computer broker → drives a SANDBOX target (mesh-node/VM, not the desktop) │
   config.toml            │    └─ Viz capturer    → observes worktree writes + tool-result images          │
   [mcp_servers] ────────►│  Gate: canUseTool / onApproval  (capability-off deny · bus-turn hard-deny)     │
                          │  Live view: CDP screencast / VNC frames → WS (ephemeral, NOT journaled)         │
                          │  Kill switch: close contexts · abort executor · revoke caps  (per-session+all)  │
                          └──────────────────────────────────────────────────────────────────────────────┘
                                        │ journal (session/artifact, native/*) + ephemeral frame channel
                                        ▼
        apps/web (stateless replay)  →  transcript cards · Artifacts pane · "Agent view" live pane · KILL
```

The hub is a **child of the Rust host, not gated by Tauri capabilities** (`capabilities/default.json` note:
the Node hub is spawned by Rust `std::process`, outside the capability system). So the hub can own browsers
and executors freely; **Tauri capability changes are minimal** and only matter if the *frontend* needs a new
privileged API (§2.3, §6 table).

---

## 2. Capability 1 — Browser control

### 2.1 Mechanism (hub-run MCP, one browser the hub owns)

The hub **launches and owns a Chromium** (`--remote-debugging-port`), and exposes browser tools
(`navigate`, `click`, `type`, `read_page`/snapshot, `screenshot`) to agents over MCP. Owning the browser
process (not letting the SDK/app-server spawn a hidden one) is what makes the **live view**, **kill switch**,
and **per-session isolation** wireable, and keeps DESIGN principle 2 ("the hub owns every process") intact —
the Chromium is a hub child, torn down by the same `taskkill /T /F` tree-kill the hub already uses
(`codex.ts:229`, `lib.rs kill_hub`).

### 2.2 Recommended tech (mid-2026)

- **`@playwright/mcp` (Microsoft)** — the default. Cross-engine (Chromium/Firefox/WebKit); returns
  **accessibility-tree snapshots by default** (no vision model needed — cheaper + less to leak than pixels);
  screenshots via `--caps=vision`. The flags that make this design work:
  - **`--cdp-endpoint http://127.0.0.1:9222`** — point the MCP at a browser **the hub already launched**, so
    the hub owns the process and can attach its **own** CDP client for screencast (§2.3) and teardown.
  - **`--isolated`** — in-memory throwaway profile (nothing persisted) — the default isolation posture.
  - **`--headless`** — runs with no visible window; required on a WSL/mesh node, fine locally since our live
    view is a screencast, not the OS window.
- **`chrome-devtools-mcp` (Google Chrome team)** — keep as an alternate/added server for **debugging** tasks
  (console, network, performance, Lighthouse); it attaches to a live Chrome and is DevTools-grade. Offer it
  as a second, separately-toggled server for "inspect this page," not the default driver.

Both are MCP-standard and wire through the same seams. We register the hub's chosen server under a
**hub-owned name** so the namespace is unambiguous and never collides with the auto-allow: **`amabrowser`**
(tools → `mcp__amabrowser__*`).

### 2.3 Live "watch the agent" view — screencast, not an embedded mirror

The controlled browser is a **separate Chromium process**, so you cannot simply `<iframe>`/`<webview>` it
(no same-origin handle, and headless has no window). The right surface is a **screencast stream in a pane**:

- The hub attaches a CDP client to its Chromium and calls **`Page.startScreencast`** (JPEG frames w/ ack).
  Frames are relayed to the web over an **ephemeral channel** (a dedicated WS topic or
  `GET /api/sessions/:id/agentview` SSE) and painted to a `<canvas>`/`<img>` in an **"Agent view" pane** —
  a new `PaneTarget` (consistent with the `PaneTarget` generalization already proposed in
  `docs/agent-visualization.md §2.4`).
- **Operator takeover (optional):** the pane can forward pointer/key events back via CDP
  `Input.dispatchMouseEvent`/`dispatchKeyEvent`, letting the human grab the wheel mid-task (solve a login,
  dismiss a dialog). Takeover is operator-initiated only; it is **never** a path the agent can request.
- **Frames are secret-bearing** (they show whatever page is open) and **must NOT be journaled** — the
  append-only journal would bloat and persist pixels of logged-in pages. Only **lifecycle** events
  (`native/agentview/started|stopped`) are journaled; frames live on the ephemeral channel, gated by the
  capability + the existing origin/host/token guards (`server.ts:184-200,264`), shown only while the
  capability is on.

**No new Tauri capability is needed** for this: frames are WS/HTTP data painted into the *existing* webview.
(A native second `WebviewWindow` mirror — `WebviewWindowBuilder`, already used for the splash in `lib.rs` —
is possible but not recommended; the in-app canvas pane composes with the split-view model.)

### 2.4 Per-provider wiring

- **Claude (clean, per-session identity).** When a session has `nativeTools.browser` on, add a **per-session
  `amabrowser` server** to `options.mcpServers` alongside `allmyagents` (`claude.ts:69` already forwards the
  whole map). Each Claude session gets its **own Playwright browser context** in the shared hub Chromium →
  isolated cookie jar + unambiguous identity + its own screencast. Because the namespace is `amabrowser`, it
  **does not** hit the `mcp__allmyagents__` auto-allow (`sessions.ts:187`) and falls through to `canUseTool`.
- **Codex (shared server + lease — see §5.6).** Declare `[mcp_servers.amabrowser]` in the profile
  `config.toml` (as `inter-agent-comms.md §4.1` already anticipates for the `allmyagents` server), pointing
  at the hub's `@playwright/mcp --cdp-endpoint …`. Because that server is **shared across the profile's
  threads**, the hub binds the **target** via a **single-active-browser lease per profile** and binds
  **identity** at the approval boundary (`onApproval` carries `threadId`). Force `approvalPolicy` off
  `'never'` for capability-on turns (§5.3).

### 2.5 Isolation + where it runs

- **Dedicated, disposable profile by default** (`--isolated`, or a throwaway dir under the hub data dir) —
  **never** the operator's daily browser with every login. An **authenticated** profile (the operator's real
  logins, for "do X on my account" tasks) is a **separate, higher scope** the operator opts into explicitly,
  per session — the opposite default from native Claude-in-Chrome's "share your signed-in browser."
- **Headless on a WSL/mesh node vs local — yes, and this is the neutral MCP's decisive edge.** The hub can
  launch the Chromium **on any node it reaches** — locally, in WSL (where native Claude-in-Chrome is
  unsupported — relevant: the user runs AMS-Node-B in WSL), or on a Linux **mesh node over MyOwnMesh** — and
  point `--cdp-endpoint` at that node's browser. Snapshots/screenshots/frames are node-agnostic data, so the
  Agent-view pane looks identical wherever the browser actually runs. Node selection is a per-session setting
  (default: local, headless).

### 2.6 Kill switch (browser)

Per-session **"stop browser"** (close the session's context, revoke `nativeTools.browser`, stop its
screencast) and a global **panic** (close every context, kill the Chromium via the tree-kill, revoke all
browser caps), both surfaced as an always-visible control in the Agent-view pane and wired to a hub route
(§5.5). Closing the context also cancels any in-flight tool call.

---

## 3. Capability 2 — Computer / desktop control (hardest, most dangerous)

This is the biggest "emulate what the vendor app does natively" gap and the highest blast radius. The design
is deliberately conservative: **a computer-use loop that targets a sandbox, never the operator's live
desktop.**

### 3.1 The loop (exposed as one MCP tool surface)

Standard computer-use loop, driven by the model, executed by a hub-owned **computer broker**:

```
screenshot(target) → model picks an action → execute(mouse/keyboard/scroll/key) → screenshot → …
```

Exposed under a hub-owned namespace **`amacomputer`** (`mcp__amacomputer__screenshot`,
`…__mouse_move`/`__click`/`__type`/`__key`/`__scroll`). Each action is **individually approval-gated** and
**bus-hard-denied** (§5) — there is no "auto-run the loop" mode. The broker checks an **abort flag between
every action** so the kill switch (§3.5) lands mid-loop.

### 3.2 Tech — weighed

| Option | What it is | Verdict for us |
|---|---|---|
| **nut.js** | Actively maintained N-API Node desktop-automation lib (mouse/keyboard/screen, region capture) | **Preferred executor when the target is a Node-reachable machine** (mesh node / VM with a Node agent). Actively maintained; check the current license before shipping (it has moved toward a dual/commercial model). |
| **robotjs** | Older Node automation lib | Avoid — stale, "work in progress," no stable 1.0; nut.js began as a fork of it and moved on. |
| **Rust/Tauri OS input** (e.g. `enigo` + a screen-capture crate) | Native input in the desktop host | Only relevant if you drive the **local** desktop — which we are recommending **against**. Would also need a new Tauri command + capability entry (§6). Keep as a non-default, explicitly-scoped "control THIS machine" mode. |
| **Sandbox-native (Xvfb + VNC)** | A virtual X display on a headless Linux target; input + capture via the display server / VNC | **The recommended substrate.** Self-hostable on a mesh node; the live view is just VNC; no local-desktop risk. |
| **E2B Desktop / Scrapybara** (cloud) | Firecracker microVM desktops (Ubuntu+XFCE, Xvfb, VNC) purpose-built for computer-use | Excellent reference architecture and a fine **optional** backend, but **cloud/paid + off-mesh** — against the project's self-hosted, no-vendor-relay posture. Use as the model to self-host, not the default. |

### 3.3 The TARGET — recommend the sandbox, forbid the desktop by default

Driving the operator's own live desktop is dangerous (a mis-click or an injected instruction moves the real
mouse, reads the real screen). **Strongly prefer a sandboxed/dedicated target:**

1. **Dedicated headless Linux mesh node with a virtual display (recommended).** Xvfb + a light DE + a Node
   agent (nut.js) **or** a VNC server, reached over **MyOwnMesh (D13.1)**. This is a self-hosted E2B-Desktop
   equivalent: the agent controls a **throwaway machine the fleet already reaches**, the trust boundary
   stays off the operator's host, and it routes around every native-harness limit (macOS-only /
   interactive-only / Windows "active-desktop-only").
2. **Local throwaway VM** (offline fallback) — a disposable guest with a virtual display; snapshot/rollback
   between tasks.
3. **The operator's primary desktop — explicitly discouraged.** Only reachable behind a distinct, loudly
   labeled "control THIS machine" scope that is **off by default and never the fleet default**; it exists so
   the capability isn't a lie, not because it's advisable.

### 3.4 Live view + per-provider wiring + isolation

- **Live view:** for a VNC-backed target, embed **noVNC** (self-contained JS) in the Agent-view pane, or
  reuse the §2.3 screenshot-frame channel (the loop already captures frames — stream them). Same ephemeral,
  non-journaled, capability-gated channel as the browser.
- **Wiring:** identical seam to §2.4 — Claude gets a per-session `amacomputer` in-process server; Codex gets
  a `config.toml [mcp_servers.amacomputer]` + the lease. The **executor target** (which sandbox) is a
  per-session setting; the tool calls carry only the *action*, and the broker routes them to that session's
  target.
- **Isolation:** one target per session; snapshot/reset the sandbox between sessions; the target has **no
  path back** to the hub host or the operator's data beyond what the task explicitly needs.

### 3.5 Kill switch (computer) — hard requirement

A prominently placed **kill** in the Agent-view pane and a global panic: set the broker's **abort flag**
(checked between every action), tear down the sandbox connection, revoke `nativeTools.computer`. Mirrors the
native harnesses' own "Esc to abort / machine-wide lock." Because the target is a sandbox, a stuck loop is
contained even before the kill lands.

---

## 4. Capability 3 — Native visualization (AllMyAgents renders its own)

Artifacts (claude.ai) and Codex canvas are **app-only** and do not cross the driver boundary (established in
`agent-native-tools.md §6.1`). What *does* cross, on both providers, is three tiers — and AllMyAgents renders
them itself.

### 4.1 Capture — three tiers

| Tier | Source (both providers) | How the hub captures it |
|---|---|---|
| **1. Inline text visuals** | ` ```mermaid `, inline `<svg>`, a chart-spec fence (e.g. ` ```chart ` / vega-lite JSON) in assistant text | Already in the stream (Claude `text` blocks; Codex `agentMessage`). Detected at render time in `markdown.ts` (§4.3). |
| **2. Worktree files** (the real "artifact": HTML/SVG/PNG/JPG/chart-JSON) | Claude `Write`/`Edit` `tool_use` (`store` `applyClaudeAssistant:759`); Codex `fileChange` (`applyCodexItem:801`) | Hub sees the producing event; when the path is a renderable type, emit **`session/artifact`** (§4.4). Bytes stay on disk, served on demand. |
| **3. Tool-result screenshots** | Browser/computer `tool_result` image blocks (only when Cap 1/2 is on) | The store currently **flattens tool_results to text** (`asText`, `store.svelte.ts:73-81`, `applyClaudeUser:772-784`) → image blocks are dropped today. Detect image blocks, stash bytes hub-side, emit `session/artifact {source:'tool-result'}`. |

### 4.2 The tension with the `img` ban — and how it resolves

`markdown.ts:59` forbids `<img>` in model prose with a correct rationale: a model-written remote `src` is a
**zero-click exfil beacon**. **That ban stays.** Visualization is **not** delivered by loosening the prose
renderer; it is a **separate, structured, hub-mediated path** whose origin the hub controls. The distinction
the whole design rests on:

> The ban targets **an arbitrary remote URL a model wrote into prose.** An artifact is bytes from **(a) the
> session's own worktree** or **(b) a tool-result image the vendor runtime produced**, **served by the hub
> over loopback** — a *different origin class*: local, attributable, never a model-chosen URL.

### 4.3 Safe render surface

- **New `ItemKind: 'artifact'`** in `store.svelte.ts:10-19` + a dedicated component (a **bypass** of the
  prose pipeline, so the `img` ban is untouched). Renders inline as a card **and** is promotable to an
  **"Artifacts" pane** (`PaneTarget`, per `agent-visualization.md §2.4`) — the app's own answer to the
  vendors' preview panes.
- **Per type:**
  - **HTML artifact** → **sandboxed `<iframe sandbox="allow-scripts">` (NO `allow-same-origin`)** with a
    **no-network CSP** (`default-src 'none'; img-src data:; style-src 'unsafe-inline'; script-src
    'unsafe-inline'`), body served by the hub (§4.5) or injected via `srcdoc`. It can render/animate but
    **cannot beacon out or script the app shell** — the isolation model claude.ai itself uses for artifacts.
    Even a **hostile** artifact (an agent induced to write one via a poisoned file/bus message) is inert.
  - **Raster (PNG/JPG/screenshot)** → `<img>` whose `src` is the hub artifact endpoint (same-origin
    loopback), type/size-capped, **re-encoded server-side** to strip anything active.
  - **SVG** → DOMPurify **SVG profile**, external refs / `<image href=http…>` / scripts stripped, then
    inlined.
  - **Mermaid / chart-spec (Tier 1)** → a new segment branch in `markdown.ts` (mirroring the existing code
    fence → `CodeBlock.svelte` split): render with a **bundled, self-contained** lib (mermaid.js; a chart
    lib for chart-specs) to an **inert SVG**, then DOMPurify SVG-profile. Self-contained = no network. Never
    via the prose `img` path.

### 4.4 Hub events that carry viz payloads

- **`session/artifact`** `{ sessionId, kind:'html'|'svg'|'image'|'chart', source:'worktree'|'tool-result'|
  'inline', path?(worktree-relative), blobId?, mime, size, sha, dims? }` — rides the journal + WS replay like
  every other event; **metadata only, bytes served separately** (keeps the journal small and lets `redact()`
  run on the metadata). `store.apply()` gains a `session/artifact` case → pushes an `artifact` item.
- Tier-1 inline visuals need **no** new event — they are already in the assistant text; the store/markdown
  detects the fence at render time.

### 4.5 Serving + the four invariants

- **New hub route** `GET /api/sessions/:id/artifact?path=…` (worktree file) and
  `…/artifact/blob/:blobId` (tool-result image), **origin+host+token guarded** (reuse
  `originAllowed`/`hostAllowed`/`tokenMatches`, `server.ts:184-200,264`), **worktree-path-fenced** (reuse the
  `checkWriteScope` containment, `sessions.ts:110-121`, to reject traversal), size-capped, correct
  `Content-Type`, **`X-Content-Type-Options: nosniff`** + strict `Content-Security-Policy`. Today `server.ts`
  serves only JSON + the legacy `PAGE`; this is the first binary/streaming route.
- **Four invariants** (carried over from `agent-native-tools.md §6.4`, now with build hooks): **(1) trusted
  origin only** (worktree file or tool-result image — never model-prose URL); **(2) hub-served, same-origin**
  (loopback, guarded, fenced); **(3) sandboxed + network-denied render** (iframe no-network CSP; SVG
  sanitized; raster re-encoded); **(4) journaled + attributed + capability-gated** (every `session/artifact`
  rides `redact()`; the card is attributed to the producing agent/tool; Tier-3 screenshots exist only when
  Cap 1/2 is on).

Note: capability 3's Tier-1/Tier-2 (worktree files, inline diagrams) are **low-risk and can be on by
default** — they add no agent *power*, only rendering of things the agent already produced. Only **Tier-3
screenshots** are gated, and they are gated by **Cap 1/2**, not a separate viz capability.

---

## 5. Cross-cutting — the capability model

### 5.1 Per-session opt-in, off by default, scope-gated

- Add `SessionRecord.nativeTools?: { browser?: boolean; computer?: boolean }` (`types.ts:18`), default
  **all-off**, persisted like `permissionMode`, threaded through `CreateOptions` (`sessions.ts:20`) /
  `TurnOverride` (`sessions.ts:34`), mirrored in `apps/web/src/lib/api.ts`, and surfaced as a **clearly
  labeled per-session toggle beside the mode pill** (the composer footer the UI-target memory calls for).
  **Never a fleet default, never a global setting.**
- Gate the *ability to enable it* behind a **D12-style user-granted scope** (analogous to the `vendor-remote`
  scope) so only an explicitly-authorized operator/device can flip it on.

### 5.2 The hard invariant — bus-turn hard-deny (build hook)

A native-tool call must be **impossible from a bus-caused turn**. Today nothing tells the approval callbacks
a turn is bus-caused. Add a **turn-provenance tag**:

- Before `deliverBus` dispatches its clamped turn (`sessions.ts:479-480`), mark the session's in-flight turn
  bus-caused — e.g. `this.busTurnInFlight.add(sessionId)` set before `runClaudeTurn`/`runCodexTurn` and
  cleared in `finally`. (Operator-originated turns via `send()`/`create()` never set it.)
- In `canUseTool` (Claude) and `onApproval` (Codex), for any tool in the **native class** (namespace
  `mcp__amabrowser__*` / `mcp__amacomputer__*`, and the Codex equivalents): **deny unconditionally if the
  turn is bus-caused**, regardless of `permissionMode`; journal `approval/auto-denied-bus`. This structurally
  mirrors `checkWriteScope` and guarantees a poisoned repo file or teammate message **can never move a mouse
  or open a page.**

### 5.3 Composition with `permissionMode` — and the gate-disabling trap

- **Native tools are NOT the `allmyagents` server.** They live under a **different namespace**, so they do
  **not** inherit the `sessions.ts:187` auto-allow and fall through to the human approval gate. **Do not**
  add them to `agentTools.ts` (that server is auto-allowed) and **do not** add any new auto-allow for them.
- **The trap (must fix):** `full` disables the gate on both providers. Claude `full → bypassPermissions`
  (`claude.ts:65`) skips `canUseTool` entirely; Codex `full → approvalPolicy:'never'` (`sessions.ts:329`)
  fires no approval request. So **when a session has any `nativeTools` capability on, the hub must force the
  turn into a gate-live mode**: for Claude, never emit `bypassPermissions` (clamp to `default`/`acceptEdits`
  so `canUseTool` still runs); for Codex, never emit `approvalPolicy:'never'` (force `onRequest`). Implement
  this clamp in `runClaudeTurn` (`sessions.ts:282`) / `runCodexTurn` (`sessions.ts:317`).
- **Never auto-approved by `edits`.** A browser click or a keystroke is not a worktree "edit." Native calls
  require **explicit human approval** unless the operator has deliberately put the session in a live-gate
  mode **and** the turn is operator-originated (never bus). Read-only browser calls (`read_page`, snapshot,
  screenshot) may get a lower-friction tier, mirroring Claude-in-Chrome's read/write split — a UX refinement,
  not a bypass.

### 5.4 Provenance on the approval prompt

The approval record must carry the **concrete target** — `navigate → evil.example.com`, `click @ (x,y)`,
`type "…"`, `computer:key ⌘Q` — so the operator judges the **action**, not just "browser tool." Same
provenance principle `inter-agent-comms.md §6.4` applies to bus approvals; the web approval UI
(`store.svelte.ts` approvals + the composer approval card) shows it.

### 5.5 Journal / audit + the kill switch

- **Audit is free** for anything journaled: every native tool call + result already flows through
  `approvals` → `journal.append` → `redact()` (`journal.ts:29`). Add native lifecycle events
  (`native/enabled`, `native/killed`, `native/agentview/started|stopped`).
- **Screenshots / DOM / network dumps are secret-bearing.** Extend `redact.ts` coverage to artifact
  **metadata**; treat captured images as sensitive for retention; prefer **accessibility snapshots** over
  pixels when the task doesn't need pixels (Playwright's default). **Live frames are never journaled**
  (§2.3).
- **Kill switch** (hub routes, origin+token guarded): `POST /api/native/kill` (global panic) and
  `POST /api/sessions/:id/native/kill` (per-session). The global panic **closes every browser context, kills
  the Chromium via the tree-kill, aborts every computer-use executor, and revokes all `nativeTools`
  capabilities**, journaling `native/killed`. Reuse the teardown discipline already in `shutdown()`
  (`sessions.ts:541`) and `interrupt()` (`sessions.ts:483`). The web surfaces it as an always-visible control
  in the Agent-view pane, plus a global panic in the titlebar.

### 5.6 The Codex shared-app-server identity binding (the hard part)

**Problem (restated):** one `app-server` per profile, threads multiplexed (`codexClientFor` keyed by
`profile.id`); `config.toml [mcp_servers]` is per-`CODEX_HOME`, **shared by all that profile's threads**. A
browser/computer tool call carries only the model's args — nothing that says *which thread*. So the hub
cannot natively map the call to a session / browser context / pane / live-view.

**Pragmatic answer (P1 — recommended):**

- **Bind identity at the approval boundary.** `onApproval` **does** carry `threadId → sessionForThread`
  (`sessions.ts:156-157`), so the *decision* is correctly attributed per session. Force capability-on Codex
  turns to `approvalPolicy:'onRequest'` (§5.3) so this boundary always fires.
- **Bind the target with a single-active-browser lease per profile.** Because every native action needs
  human approval (no auto-run) and the hub knows which session on the profile currently holds the
  capability + an in-flight turn, restrict to **one capability-engaged Codex session per profile at a time**
  (a lease). The shared `config.toml` server then unambiguously maps to the leased session's context + pane.
  Simple, safe, ships on the existing architecture; the cost is no *concurrent* Codex browser sessions on the
  same profile.

**Clean answer (spike — deferred):** a **per-session `CODEX_HOME`** (its own `config.toml` declaring a
session-tokened `amabrowser` server) gives per-session binding and concurrency — **but** it collides with the
project's hard rule *"NEVER copy a Codex `auth.json` between homes"* (single-use/rotating OAuth refresh
tokens → `refresh_token_reused` loops). A safe version would share auth **without copying** (symlink/point to
the profile's credential, overlay only `config.toml`) or use a **dynamic per-thread MCP registration** method
if the app-server exposes one (`codex mcp add` / an `mcp/*` app-server method — **unverified**, §8). Do not
attempt the naive copy. Claude has **none** of this problem — its server is per-session in-process
(`buildAgentMcpServer(identityOf(record), …)`), so identity + context + pane are unambiguous per session.

---

## 6. Phased plan

- **P0 — Spike / verify (no capability shipped).**
  - Wire `@playwright/mcp --cdp-endpoint` to **one Claude** session (`options.mcpServers`) and **one Codex**
    session (`config.toml [mcp_servers]`); confirm tools appear and **every call routes through
    `canUseTool` / `onApproval`.**
  - **Prove the gate-disabling trap (§5.3):** confirm `full` (`bypassPermissions` / `approvalPolicy:'never'`)
    skips the callback, and that forcing a gate-live mode restores it.
  - **Codex identity spike (§5.6):** does `onApproval` reliably carry `threadId` for MCP tool calls? Is there
    a dynamic per-thread MCP-registration method?
  - Confirm **Claude tool-result image blocks** arrive verbatim in the `query()` stream under subscription
    auth (Tier-3 depends on it — currently inferred).
  - Prototype the **CDP `Page.startScreencast` → WS → canvas** relay.
- **P1 — Browser MCP for both providers (first shipped capability).**
  - Per-session `browser` capability (off, scope-gated); approval-gated; **bus-hard-denied**; gate-live-mode
    forced; dedicated **`--isolated`** Chromium; Codex **lease**. **Agent-view screencast pane + kill
    switch.** Accessibility-snapshot / text first (screenshots render in P2). Node selection (local / WSL /
    mesh) as a per-session setting. Immediately useful for web testing/debugging; lowest risk.
- **P2 — Native visualization capture + safe render.**
  - `session/artifact` event; hub artifact endpoint (guarded, worktree-fenced, strict CSP); sandboxed
    iframe/img/SVG render + `ItemKind:'artifact'` + **Artifacts pane**; **Mermaid + sanitized-SVG + chart
    fences** in `markdown.ts` (img ban untouched). Unlocks worktree HTML/SVG/PNG artifacts **and** Tier-3
    browser screenshots (now renderable).
- **P3 — Sandboxed computer control + native escape hatches (last, highest risk).**
  - Computer-use loop under `amacomputer`, targeting a **dedicated mesh-node/VM with a virtual display**
    (never the operator's desktop); noVNC/screenshot live view; hard kill switch; tightest scope; Codex
    lease. **Native escape hatches where reachable:** **Claude-in-Chrome** via `mcpServers` for
    *authenticated* browser workflows (Claude-only, opt-in, its own scope + profile) pending the
    `agent-native-tools.md §9` activation spike. **Codex** native computer/browser: **defer** (app-only;
    track `openai/codex#20851`).
- **Non-goals (explicit):** never a fleet default; never auto-approved; never triggerable from a bus turn;
  never the operator's primary browser/desktop by default; never render model-prose images; never journal
  live frames; never copy a Codex `auth.json` between homes.

---

## 7. File-by-file integration (this repo)

| File | P1 — Browser | P2 — Visualization | P3 — Computer / escape hatches |
|---|---|---|---|
| `apps/hub/src/types.ts` | `SessionRecord.nativeTools{browser}`; new enabling **scope**; native-tool namespaces | `session/artifact` event/`ItemKind` typing | `nativeTools.computer`; sandbox-target field |
| `apps/hub/src/sessions.ts` | `canUseTool`/`onApproval`: native-class **capability-off deny** + **bus-turn hard-deny**; **tag bus turns** in `deliverBus` (461-481); **force gate-live mode** in `runClaudeTurn`/`runCodexTurn` (never `bypass`/`never`); Codex **lease**; keep native tools **out of** the `:187` auto-allow | emit `session/artifact` on renderable `Write`/`Edit`/`fileChange`; capture tool-result image blocks | computer broker wiring; per-session sandbox target routing |
| `apps/hub/src/adapters/claude.ts` | add per-session `amabrowser` to the `mcpServers` map (69) when cap on; ensure `full` doesn't strip `canUseTool` (64-67) | — | add `amacomputer` server when cap on |
| `apps/hub/src/adapters/codex.ts` | write `[mcp_servers.amabrowser]` into profile `config.toml`; ensure `approvalPolicy` never `'never'` for cap-on turns | — | `[mcp_servers.amacomputer]`; lease enforcement |
| `apps/hub/src/agentTools.ts` | **do NOT add browser/computer tools here** (this server is auto-allowed) — note only | optional low-risk `mcp__amaviz__show` (safe tier) | **do NOT add here** |
| `apps/hub/src/server.ts` | capability-toggle route; **kill routes** `/api/native/kill` (+per-session); ephemeral **screencast** channel (`/api/sessions/:id/agentview`), guarded | **artifact-serving route** (origin+token guarded, worktree-fenced, strict CSP, `nosniff`, size-capped) | VNC/frame relay route for the sandbox |
| `apps/hub/src/journal.ts` / `redact.ts` | `native/*` lifecycle events; redact approval provenance | `session/artifact` metadata; treat screenshots sensitive | `native/killed`; sandbox-target redaction |
| `apps/web/src/lib/store.svelte.ts` | `nativeTools` state; approval UI shows concrete target (5.4); `PaneTarget:'agentview'`; kill action | `ItemKind:'artifact'` + `apply()` case; detect image blocks in tool_results (today `asText` flattens, 73-81 / 776-784) | `PaneTarget` for computer view; sandbox picker |
| `apps/web/src/lib/markdown.ts` | — | **Mermaid + sanitized-SVG + chart** segments; **keep the `img` ban (59)**; artifacts render **outside** this pipeline | — |
| `apps/web/src/lib/ItemCard.svelte` (+ new `ArtifactCard`, `AgentView` pane) | Agent-view pane (canvas/screencast) + kill button | artifact card: sandboxed iframe / re-encoded `<img>` / inlined SVG | noVNC/screenshot pane + kill |
| composer footer (mode-pill area) | labeled **native-tools toggle**, off by default | Artifacts-pane affordance | computer toggle + sandbox-target select |
| `apps/desktop/src-tauri/tauri.conf.json` | none required for screencast/canvas; if `security.csp` is later set (it's `null`, 27-29), allow the artifact iframe + agentview channel | same CSP note | **only if** driving the *local* desktop via the Rust host: add an `enigo`-style command |
| `apps/desktop/src-tauri/capabilities/default.json` | none (hub owns the browser, outside the capability system) | none | **only** for the Rust-host local-desktop path: a new `shell`/custom-command permission (non-default, discouraged) |

---

## 8. Unverified / needs a spike

- **The gate-disabling trap** (§5.3) — that Claude `bypassPermissions` skips `canUseTool` and Codex
  `approvalPolicy:'never'` fires no request is the documented behavior, but **confirm** on the installed SDK /
  app-server versions before relying on the forced gate-live clamp. If either still invokes the callback, the
  clamp is belt-and-suspenders; if (as expected) they don't, the clamp is **load-bearing**.
- **Codex per-thread MCP identity** (§5.6) — whether `onApproval` reliably carries `threadId` for MCP tool
  calls, and whether any **dynamic per-thread MCP registration** exists (`codex mcp add` / an app-server
  `mcp/*` method). Determines whether we can ever move off the single-active lease to concurrency. **Do not**
  solve it by copying `auth.json`.
- **Claude tool-result image blocks over the SDK** (Tier-3, §4.1) — that screenshots arrive as image content
  blocks in the `query()` stream under subscription auth is **inferred**, not confirmed. If they arrive as
  file refs or are stripped, Tier-3 capture changes shape.
- **CDP screencast throughput** (§2.3) — frame rate / CPU / relay bandwidth over the WS (and over MyOwnMesh
  for a remote node) at a usable resolution; may need frame throttling / JPEG quality tuning / a WebRTC path.
- **nut.js license** (§3.2) — verify the current license terms before shipping it in a distributed build; if
  incompatible, prefer the VNC/Xvfb-native path (no Node automation lib in our tree) or a Rust executor on
  the sandbox.
- **`@playwright/mcp --cdp-endpoint` gating granularity** (§2.2) — that per-tool calls surface to
  `canUseTool`/`onApproval` at the granularity we need (per navigate/click, with the concrete target for
  §5.4). If not, fall back to a hub **in-process** browser server (custom tools calling the hub's Playwright
  context) — more code, maximal control.
- **Claude-in-Chrome activation from `query()`** (P3 escape hatch) — carried over unresolved from
  `agent-native-tools.md §9`; the neutral MCP path sidesteps it.
- **Mesh-node computer target over MyOwnMesh** (§3.3) — latency/reliability of a screenshot→action→screenshot
  loop across the mesh; may want the sandbox co-located with a node that has a fast path to the hub.

---

## Sources

Browser MCP (current, mid-2026):
- Playwright MCP (Microsoft) — repo + options (`--cdp-endpoint`, `--isolated`, `--headless`, `--caps`):
  https://github.com/microsoft/playwright-mcp · https://playwright.dev/docs/getting-started-mcp ·
  https://playwright.dev/mcp/configuration/options
- Playwright MCP profile modes (persistent / isolated / extension): https://qaskills.sh/blog/playwright-mcp-profile-modes-guide-2026
- Chrome DevTools MCP vs Playwright MCP (driving vs debugging; accessibility-tree snapshots; attach to live
  Chrome): https://stevekinney.com/writing/driving-vs-debugging-the-browser · https://mcp.directory/blog/chrome-devtools-mcp-vs-playwright-mcp-2026

Computer control (current, mid-2026):
- nut.js (maintained N-API desktop automation): https://nutjs.dev/ · robotjs (stale, pre-1.0): https://www.npmjs.com/package/robotjs · https://github.com/octalmage/robotjs
- E2B Desktop (Firecracker microVM, Ubuntu+XFCE, Xvfb virtual display, VNC streaming — the sandbox reference
  architecture): https://github.com/e2b-dev/desktop · https://e2b.dev/docs/use-cases/computer-use · Scrapybara
  (browser-only alt): https://e2b.dev/docs/use-cases/computer-use

Internal (grounding):
- `docs/agent-native-tools.md` — the accepted recommendation this doc implements (verdict, per-provider
  reachability, security invariant, §6 visualization tiers)
- `docs/agent-visualization.md` — the `PaneTarget` generalization + lane/run/fleet model the Artifacts/Agent-
  view panes reuse
- `docs/inter-agent-comms.md` — injected-turn clamp, data-not-instructions trust model, MCP tooling model
- `apps/hub/src/agentTools.ts` (in-process MCP server, identity-bound), `apps/hub/src/sessions.ts`
  (`canUseTool` auto-allow `:187`, `checkWriteScope` `:110-121`, `onApproval` `:155-160`, `deliverBus`/
  `clampMode` `:461-481,573`, `runClaudeTurn`/`runCodexTurn` mode mapping), `apps/hub/src/adapters/claude.ts`
  (`options.mcpServers` `:69`, `bypassPermissions` `:65`), `apps/hub/src/adapters/codex.ts` (one app-server
  per profile, `approvalPolicy` path), `apps/hub/src/server.ts` (origin/host/token guards `:184-200,264`),
  `apps/hub/src/journal.ts` + `redact.ts` (append + redaction choke point), `apps/web/src/lib/markdown.ts`
  (the `img` ban `:59`), `apps/web/src/lib/store.svelte.ts` (`ItemKind` `:10-19`, `asText` tool-result
  flattening `:73-81`), `apps/desktop/src-tauri/{tauri.conf.json,capabilities/default.json,src/lib.rs}`
  (Tauri v2 window/capability model; hub spawned outside the capability system; `WebviewWindowBuilder`;
  tree-kill teardown)
```
