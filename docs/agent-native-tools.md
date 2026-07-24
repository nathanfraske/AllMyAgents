# Agent native tools — computer control, browser control, and native visualization

Design scope, drafted 2026-07-24. **Scoping only — no code changed; read-only on `apps/hub/src` and `apps/web/src`.**
Web research used to pin the vendors' *current* (mid-2026) product state, because tool availability changes fast
and training data goes stale. This doc answers a different question than `docs/vendor-remote-control.md`: that doc
asked "can the phone drive *our* hub sessions through the vendor's app" (answer: no, not cleanly). **This doc asks the
inverse: can *our* agents use the vendors' computer-use / browser-control harnesses, and how should we give them
those powers safely.** It builds on **DESIGN principle 2 (the hub owns every process)**, **principle 5 / D13 / D13.1
(self-hosted mesh transport)**, **D12 (scopes + approval router + audit)**, and reuses the **injected-turn permission
clamp** and **data-not-instructions trust model** finalized in `docs/inter-agent-comms.md`. It also extends the
**exfil-beacon defense** in `apps/web/src/lib/markdown.ts` to a new (visualization) surface.

---

## 0. Verdict (read this first)

**What is reachable from the programmatic drivers we actually use** — Claude via `@anthropic-ai/claude-agent-sdk`
`query()` under subscription auth (`adapters/claude.ts`), Codex via a hub-spawned `codex app-server` over JSON-RPC
(`adapters/codex.ts`):

| Capability | **Codex** (via `codex app-server` JSON-RPC) | **Claude** (via Agent SDK `query()`, subscription auth) |
|---|---|---|
| **Computer control** (OS/desktop) | ❌ **App-only.** Desktop app (macOS + Windows), UI-driven (`@Computer`/`@AppName`); *"not exposed as a callable tool through the Codex CLI or app-server."* Open CLI feature request `openai/codex#20851`. **Not reachable from our driver.** | ⚠️ **Not from our driver.** A built-in `computer-use` MCP server exists, but it is **macOS-only, research-preview, and explicitly "not available in non-interactive mode with the `-p` flag"** — i.e. the programmatic/SDK path is exactly what it excludes. Interactive-CLI-only. |
| **Browser control** | ❌ **App-only.** *"Browser isn't available in Codex CLI or the Codex IDE extension… not accessible via app-server JSON-RPC."* The "Codex for Chrome" extension is bound to the ChatGPT/Codex desktop app. **Not reachable from our driver.** | ✅ **Reachable via MCP (with a caveat).** "Claude in Chrome" ships as the **`claude-in-chrome` MCP server** + extension, and is **subscription-auth ONLY** (it rejects API keys / `setup-token` — which *matches* our `/login` auth). BUT its documented activation is the CLI `--chrome`/`/chrome`; the Agent SDK `query()` options have **no `chrome` flag**. Wireable only by pointing `options.mcpServers` at a browser MCP. |
| **Vendor-neutral browser MCP** (hub-run, e.g. Playwright/CDP) | ✅ **Yes** — `config.toml [mcp_servers]` per `CODEX_HOME` / `codex mcp add`. | ✅ **Yes** — `options.mcpServers`, the **exact insertion point** `agentTools.ts` already uses for the inter-agent tools. |

**Recommended near-term path:** a **hub-run, vendor-neutral browser-automation MCP** (Microsoft's `@playwright/mcp`
or the Chrome team's `chrome-devtools-mcp`), wired into **both** providers through the MCP mechanisms the hub already
owns, behind a **per-session capability toggle (off by default)** that composes with the existing `permissionMode` +
`canUseTool`/`onApproval` gate. This is the only option that (a) works for *both* providers, (b) needs no vendor app,
CLI-mode, or macOS host, (c) runs headless (works in WSL / on a mesh node), and (d) keeps the hub as sole process
owner. Enable the **native** harnesses only where reachable and only as labeled opt-in escape hatches: **Claude in
Chrome** (via `mcpServers`, for authenticated-browser workflows) is worth a spike; **Codex computer/browser control**
is app-only and should be deferred.

**Top security consideration:** computer/browser control is the most powerful capability we would ever hand an agent,
and the fleet already delivers **semi-trusted teammate messages as injected turns** (`docs/inter-agent-comms.md`).
The hard invariant is therefore: **a native tool call must be impossible to trigger from a bus-caused (untrusted)
turn, and must never be auto-approved** — it is a distinct, higher-risk tool class that is *hard-denied* inside
injected turns and *always* passes the human approval gate outside them, regardless of `permissionMode`.

---

## 1. Scope, terms, and how this relates to `vendor-remote-control.md`

Four distinct things get muddled in casual conversation; keep them apart:

| Thing | Who acts | Where it runs | This doc? |
|---|---|---|---|
| **Vendor remote control** (`docs/vendor-remote-control.md`) | a human on a phone | steers our hub session via the vendor cloud | No — that doc, rejected |
| **Computer control** (this doc) | the *agent* | sees/clicks/types on a real desktop | **Yes** |
| **Browser control** (this doc) | the *agent* | drives web pages in a real browser | **Yes** |
| **Native visualization** (this doc, §6) | the *agent* | emits rich visual output (artifacts, charts, screenshots) | **Yes** |

**The overlap with `vendor-remote-control.md` is a recurring root cause, not a coincidence.** That doc found the
vendors' polished remote-control features bolted to the *vendor's own surface* (Claude's `claude` **CLI**, Codex's
**managed app-server daemon**), unreachable from the **SDK / unmanaged app-server** the hub drives. The exact same
surface-mismatch recurs here for the native harnesses: **Codex computer/browser control lives in the desktop app**,
and **Claude's native computer-use is CLI-interactive-only**. Where this doc diverges is that **one** native harness —
**Claude in Chrome — is packaged as an MCP server**, and MCP is the one extension point the hub already speaks on both
sides. That is what makes a vendor-neutral *and* a native path converge on the same integration point (`mcpServers` /
`config.toml [mcp_servers]`), differing only in *which server binary* we point at.

---

## 2. Codex — computer control and browser control

### 2.1 Computer control ("Computer Use") — app-only

OpenAI shipped Codex "Computer Use" to the **desktop app** (macOS first, then **Windows on 2026-05-29** in app
v26.527), letting eligible ChatGPT users have Codex *"see, click, and type inside any app with its own cursor"* while
it tests and debugs. But it is a **desktop-app capability, not a driver-reachable tool**:

- The `learn.chatgpt.com` computer-use docs (the redirect target of `developers.openai.com/codex/app/computer-use`)
  state it is **UI-driven** — the user invokes it by mentioning **`@Computer`** or **`@AppName`** in a prompt — and
  is **"not exposed as a callable tool through the Codex CLI or app-server."** On Windows it *"runs on the active
  desktop… can't operate in the background while you keep using the same Windows session."*
- The community feature request **`openai/codex#20851` ("first-class Computer Use support from the Codex CLI") is
  open with no maintainer commitment.** It describes today's state precisely: Computer Use is *"exposed as a Codex
  desktop/app plugin, but it is not presented as a first-class, supported CLI capability."*
- The app-server protocol guide's full API surface (Thread / Turn / Command execution / Filesystem / Configuration /
  Discovery / MCP / Realtime / Review) lists **no** computer-use methods; its sandbox policies (`dangerFullAccess`,
  `readOnly`, `workspaceWrite`, `externalSandbox`) govern **shell command execution only**.

**Verdict:** unreachable from `codex app-server`. Nothing in `adapters/codex.ts`'s JSON-RPC vocabulary can enable it.

### 2.2 Browser control — app-only

Two Codex browser surfaces exist, and **neither is reachable from the app-server**:

- **Desktop-app built-in browser.** The `learn.chatgpt.com/docs/browser` page is explicit: *"Browser isn't available
  in Codex CLI or the Codex IDE extension. Open the ChatGPT desktop app to use the built-in browser."* It is **"not a
  tool the agent calls"** — it is a capability the app accesses directly (URL clicks, `Cmd/Ctrl+Shift+B`, `@Browser`).
  Config lives under `[features]` `browser_use_full_cdp_access` in `requirements.toml`; the domain allow/block list is
  a **Settings > Browser** GUI control. Confirmed **"not accessible via app-server JSON-RPC."**
- **"Codex for Chrome" extension** (released 2026-05-07 alongside CLI v0.129.01; per-domain allowlist, default no
  access, `browser_use_full_cdp_access = false` admin flag). Secondary write-ups tie it to the **Codex desktop app's
  plugin system** ("Open Plugins in the Codex sidebar"), not the CLI/app-server. I could not find any app-server
  method or config key that lets an *unmanaged* app-server client (ours) drive the extension. **Flag (unverified):**
  whether a future app-server hook exposes the Chrome extension; today it reads as desktop-app-bound.

**Verdict:** unreachable from `codex app-server`. For Codex, browser automation must come from a **hub-provided MCP
server** (§4).

---

## 3. Claude — computer control and browser control

### 3.1 Native computer use — exists, but excludes our path

Claude Code has a **native computer-use** feature (control native macOS apps), delivered as a **built-in MCP server
named `computer-use`**, off by default, enabled via `/mcp`. It is genuinely capable (screen control, per-app
approval, machine-wide lock, `Esc` to abort). **But three limits rule it out for our hub driver:**

1. **"Not available in non-interactive mode with the `-p` flag."** The Agent SDK `query()` is the programmatic,
   non-interactive path — the same category `-p` names. The `computer-use` server *"only appears on eligible
   setups… in an interactive session."*
2. **macOS-only in the CLI** (Desktop app adds Windows). Our hub host is Windows (`win32`); Claude in WSL is also out.
3. **Pro/Max only, claude.ai auth only** (not Team/Enterprise, not third-party providers).

**Verdict:** not reachable from `query()` today. (If we ever needed native desktop control, the realistic route is a
dedicated **macOS mesh node** running the *interactive* CLI — a separate integration, not an enhancement of the SDK
adapter, exactly like the vendor-remote-control finding.)

### 3.2 Claude in Chrome — an MCP server, subscription-auth, our best native lever

This is the one native harness that plausibly fits. **"Claude in Chrome" is delivered as the `claude-in-chrome` MCP
server** plus a Chrome extension and a native-messaging host (`com.anthropic.claude_code_browser_extension.json`).
Key facts from `code.claude.com/docs/en/chrome`:

- **Subscription-auth ONLY, and it *rejects* the alternatives.** It requires *"a direct Anthropic plan (Pro, Max,
  Team, or Enterprise)"* and signing in with `/login`. *"If you authenticate with an API key or a long-lived token
  from `claude setup-token`… Claude Code keeps Chrome integration off."* **This is the opposite constraint from the
  computer-use *API* tool (§3.3), and it lines up exactly with our profiles' `/login` + `.credentials.json` auth.**
- **It is an MCP server** — the docs say so repeatedly: the first browser action *"asks for permission to use the
  `claude-in-chrome` skill"*; *"Run `/mcp`, select `claude-in-chrome`, then View tools"*; orgs can block it via the
  `deniedMcpServers` managed setting.
- **Tools** (the same set surfaced to this very session as `mcp__claude-in-chrome__*`): `navigate`, `computer`
  (click/type/screenshot), `read_page`, `get_page_text`, `find`, `form_input`, `tabs_context_mcp`/`tabs_create_mcp`/
  `tabs_close_mcp`, `read_console_messages`, `read_network_requests`, `javascript_tool`, `gif_creator`,
  `file_upload`, `resize_window`.
- **Permission model** we can lean on: read-only calls (`read_page`, `get_page_text`, `find`, screenshot) vs
  state-changing calls (click/type/navigate/tabs/GIF); site-level permissions inherited from the extension.
- **Limits:** **not supported in WSL** (relevant — the user runs AMS-Node-B in WSL); shares the user's logged-in
  browser by default; needs a visible Chromium (Chrome/Edge/Brave/Arc/…).

**The caveat that decides the design.** The authoritative Agent SDK **TypeScript reference lists no `chrome` /
browser / computer-use option** on `query()`. Its relevant options are `mcpServers` (`Record<string,
McpServerConfig>` — stdio, in-process SDK, or referenced servers), `allowedTools` / `disallowedTools`,
`permissionMode` (`default`/`plan`/`dontAsk`/`bypassPermissions`), `canUseTool`, `settingSources`
(`['user','project','local']`), and `strictMcpConfig`. So the bundled `--chrome` bootstrap (native-host install +
extension handshake) is a **CLI-layer** action with no documented `query()` equivalent. **Two wireable routes remain,
both through `options.mcpServers`:**

- **(a) Reference the browser MCP directly.** Point `mcpServers` at an MCP server that speaks to the Claude Chrome
  extension (the bundled one after a one-time CLI `--chrome` setup per profile that installs the native host, or a
  community `claude-chrome-mcp` bridge). **Flag (unverified):** whether the *bundled* `claude-in-chrome` server can be
  activated purely through `query()` (via `settingSources: ['project']` after CLI setup, or by name) — **needs a
  spike**; docs frame it as CLI-only.
- **(b) Skip it and use a vendor-neutral browser MCP** (§4) — no extension, no native host, works headless/WSL.

**Verdict:** Claude browser control *is* reachable through the same `mcpServers` seam the hub already uses — but the
clean, documented, provider-symmetric path is a neutral browser MCP (route b). Treat native Claude-in-Chrome as a
Claude-only opt-in for *authenticated* browser workflows (its real advantage: your logged-in sessions), pending the
route-(a) spike.

### 3.3 Aside: the computer-use *API* tool is a different animal

Anthropic's `computer_20241022`/`bash`/`text-editor` **computer-use tool** (the `anthropic-beta:
computer-use-*` Messages-API feature) is **API-key territory** — you implement the execution loop and screenshot
plumbing yourself against a direct Messages API. Our hub runs **subscription auth through the Agent SDK**, not the raw
Messages API, so this tool is **out of scope** (and would fragment auth/metering). Noted only to prevent conflating
it with §3.1/§3.2.

---

## 4. The hub-provided (vendor-neutral) path — recommended near-term

Because the hub already hands each Claude session an in-process MCP server (`agentTools.ts` →
`options.mcpServers = { allmyagents: … }`, wired at `adapters/claude.ts:69` and `sessions.ts:200`) and can declare
MCP servers for Codex via the profile `config.toml [mcp_servers]`, **a hub-run browser-automation MCP is wireable to
both providers with the mechanisms already in the codebase.** This is the vendor-neutral answer to Q3, and it beats
the native harnesses on *reachability today*.

**Candidate servers (both mature, MCP-standard, 2026):**

- **`@playwright/mcp` (Microsoft).** Browser automation over Playwright; drives Chromium/Firefox/WebKit; returns
  **structured accessibility snapshots** (no vision model required) and can screenshot. Documented for **both** hosts:
  Codex via `[mcp_servers.playwright] command="npx" args=["@playwright/mcp@latest"]` (or `codex mcp add playwright …`)
  and any MCP client including the Claude SDK.
- **`chrome-devtools-mcp` (Chrome team).** CDP/Puppeteer under the hood; DevTools-grade (console, network, traces,
  Lighthouse, device emulation) — better for *debugging* real pages.

**Vendor-neutral vs native — the honest trade:**

| Dimension | Hub-run neutral MCP (Playwright/CDP) | Native Claude-in-Chrome | Native Codex computer/browser |
|---|---|---|---|
| Reachable from our driver **today** | ✅ both providers | ⚠️ Claude only, via `mcpServers` (spike) | ❌ app-only |
| Auth | none extra (hub-launched process) | claude.ai `/login` (matches ours) | ChatGPT desktop app |
| Headless / WSL / mesh-node | ✅ yes | ❌ needs visible Chrome, no WSL | ❌ desktop-bound |
| Authenticated ("my logins") workflows | ⚠️ only with a provisioned profile | ✅ shares your signed-in browser | ✅ (app) |
| Process ownership (principle 2) | ✅ hub owns it | ⚠️ extension + native host outside hub | ❌ vendor app owns it |
| Isolation control | ✅ full (dedicated/disposable profile, VM) | ⚠️ user's real browser by default | ❌ user's desktop |
| Uniform audit/journal | ✅ one path, both providers | ✅ (MCP tool calls journaled) | ❌ app-side |

**Recommendation:** default to the neutral MCP for capability parity, isolation, and headless operation; keep
Claude-in-Chrome as a Claude-only escape hatch for tasks that genuinely need the operator's live browser sessions.

---

## 5. Security + capability model

Computer/browser control is the highest-blast-radius capability in the fleet. The model below composes with the
*existing* gates rather than inventing a parallel one.

### 5.1 A per-session opt-in capability, off by default

- Add a `SessionRecord` capability field (e.g. `nativeTools?: { browser?: boolean; computer?: boolean }`,
  default all-off), persisted like `permissionMode`, threaded through `CreateOptions`/`TurnOverride`, and surfaced as
  a clearly-labeled per-session toggle beside the mode pill. **Never a fleet default, never a global setting.**
- Gate the *ability to enable it* behind a D12-style user-granted scope (analogous to the `vendor-remote` scope the
  remote-control doc proposed) so only an explicitly-authorized operator/device flips it on.

### 5.2 Composition with `permissionMode` + the approval gate (the crux)

The browser/computer MCP tools must ride the **existing** approval path, and must be a **distinct, higher-risk class**:

- **They are NOT the `allmyagents` server.** `sessions.ts:187` auto-allows `mcp__allmyagents__*` (safe, ACL-enforced
  in-tool). Browser/computer tools live under a **different** server namespace (`mcp__playwright__*` /
  `mcp__claude-in-chrome__*`), so they **do not** inherit that auto-allow and fall through to
  `approvals.request(...)` (Claude `canUseTool` at `sessions.ts:184-197`; Codex `onApproval` at
  `sessions.ts:155-160`). Do **not** fold them into the in-process server.
- **Two hard rules** added in `canUseTool` / `onApproval`, structurally mirroring `checkWriteScope`
  (`sessions.ts:110-121`):
  1. **Capability check:** if the session's `nativeTools` capability for that class is **off**, `deny` before any
     approval prompt (journaled `approval/auto-denied-capability`).
  2. **Bus-turn hard-deny (the load-bearing invariant):** if the current turn is **bus-caused**, native tool calls
     are **denied unconditionally, regardless of `permissionMode`.** `deliverBus` (`sessions.ts:461-481`) already
     runs injected turns with a clamped mode (`clampMode`, `sessions.ts:573`, `full → edits`); extend that by
     **tagging bus-caused turns** so the approval callback can refuse the native-tool class outright. This directly
     satisfies the requirement that **"computer control must never be triggerable by an untrusted bus message"** — a
     poisoned repo file or teammate message can never move a mouse or open a page.
- **Never auto-approved by `edits`.** `edits` (acceptEdits) is for worktree file edits; a browser click or `type` is
  not an "edit." Native-tool calls should require **explicit human approval** unless the operator has deliberately put
  the session in `full` **and** the turn is operator-originated (never bus). Read-only browser calls (`read_page`,
  screenshot) may be offered a lower-friction tier, mirroring Claude-in-Chrome's own read/write split — but that is a
  UX refinement, not a bypass.
- **Provenance on the prompt.** The approval record should carry the concrete target (URL / app / action: "click on
  `evil.example.com`") so the operator judges the *action*, not just "browser tool" — the same provenance principle
  `inter-agent-comms.md` §6.4 applies to bus-caused approvals.

### 5.3 Sandboxing / isolation

- **Dedicated, disposable browser profile by default.** For autonomous fleet agents, default the neutral MCP to a
  **clean, throwaway Chromium profile** — *not* the operator's daily browser with every login. This is the opposite
  of Claude-in-Chrome's "share your signed-in browser" default; require an explicit, separately-scoped opt-in for a
  provisioned/authenticated profile. (Screenshots of authenticated pages are secret-bearing — see §5.4.)
- **VM / remote host over the mesh for computer-use.** If full desktop control is ever needed, the safe substrate is
  a **dedicated VM or remote desktop reached over MyOwnMesh (D13.1)** — the agent controls a throwaway machine, not
  the user's daily driver. This also routes around the native harnesses' macOS-only / interactive-only / Windows
  "active-desktop-only" limits: a headless browser MCP on a Linux mesh node is far more automatable than any native
  desktop harness, and keeps the trust boundary off the operator's host. Cross-reference `meshSite.ts` (D13.1).
- **Windows host reality.** The hub host is Windows; Claude native computer-use CLI is macOS-only and Codex Windows
  computer-use "can't operate in the background." Another reason the neutral, headless browser MCP (optionally on a
  mesh node) is the pragmatic default rather than any native desktop harness.

### 5.4 Audit / journaling

- Every native tool call + result already flows through `approvals` and is journaled as `claude/*` / `codex/*` events
  at the single `journal.append` choke point (with `redact()`), so **audit and replay come for free** — same as any
  other tool.
- **Screenshots and DOM/network dumps are secret-bearing** (logged-in pages, tokens in network traffic). Extend
  `redact()` coverage to artifact metadata and treat captured images as sensitive for retention (ties to
  `memory-system.md` M6 redaction gaps). Prefer accessibility snapshots (Playwright's structured mode) over pixel
  screenshots when the task doesn't need pixels — less to leak.

---

## 6. Native visualization output

*How each vendor emits rich visual output, how much crosses the programmatic boundary, and how AllMyAgents should
capture and render it safely in its own transcript.*

### 6.1 What actually crosses the driver boundary

**Claude via Agent SDK `query()`:**

| Visual form | Crosses the SDK stream? | Notes |
|---|---|---|
| **Artifacts** (claude.ai HTML/React/SVG/Mermaid live-preview pane) | ❌ **App-only.** | Artifacts are a **claude.ai** feature. *"Claude Code… doesn't render the split-pane artifact preview. You can ask it to produce an HTML file, but it won't appear in the artifact viewer."* There is **no distinct "artifact" message type** in the SDK stream. |
| **Inline text visuals** (markdown, code fences, tables, **Mermaid** fences, inline **SVG** as code) | ✅ Yes | Ordinary `text` blocks in `claude/assistant` — *already in our journal and transcript*. |
| **Files the agent writes** (HTML/React/SVG/PNG charts) | ✅ As tool events + bytes on disk | A `Write`/`Edit` `tool_use` appears in the stream; the actual bytes land in the **session worktree** (a trusted local origin). This is the real "artifact" under the SDK. |
| **Image generation** | ❌ | No native image-gen tool in Claude Code; charts come from code the agent runs (e.g. matplotlib via `Bash`) → a file on disk, or inline SVG/Mermaid. |
| **Screenshots** (computer-use / claude-in-chrome) | ✅ *If those tools are wired* | A screenshot is an **image content block inside a `tool_result`** (`claude/user`). It crosses the stream **only** when a browser/computer MCP is enabled (§3.2/§4). **Today our store flattens tool_results to text** (`store.svelte.ts` `asText`, lines 73-81 / 776-784), so image blocks are currently dropped. |

**Codex via `codex app-server`:**

| Visual form | Crosses the app-server events? | Notes |
|---|---|---|
| **Canvas / "control room" / workflow canvas** | ❌ App/GUI-only | These are SwiftUI desktop-app surfaces, not app-server payloads. No claude.ai-artifacts equivalent streams through the app-server. |
| **Inline text visuals** (markdown/code/Mermaid) | ✅ Yes | `agentMessage` items (`codex/item/*`, `store.svelte.ts:786-806`). |
| **Files the agent writes** | ✅ As `fileChange` items + bytes on disk | Same worktree-file story as Claude. |
| **Image generation / computer-use screenshots** | ❌ App-only | Desktop-app capabilities (§2), not app-server events. |
| **"Inline visualization links" in the terminal UI** | ⚠️ **Unverified** | A 2026 changelog mentions clickable inline visualization links in the CLI TUI; whether they surface as app-server events or are terminal-only I could not confirm. **Flag.** |

**Net:** the *rich native live-preview surfaces* (Claude Artifacts pane, Codex canvas, in-app image-gen) are
**app-only and do not cross the programmatic boundary.** What *does* cross, on both sides, is three tiers: **(1)
inline text visuals** (already streamed), **(2) files written to the worktree**, and **(3) tool-result screenshots**
(only when browser/computer tools are wired). AllMyAgents renders its *own* transcript, so it should capture these
three tiers itself — it does not, and cannot, embed the vendors' proprietary preview panes.

### 6.2 The tension: images are (deliberately) forbidden in rendered markdown

`apps/web/src/lib/markdown.ts` is the single place model text becomes HTML, and it **forbids `img`** in
`FORBID_TAGS` (line 59) with an explicit rationale: *"message text is model-generated, so a remote image src would be
a zero-click exfil beacon / prompt-injection channel (auto-fetched on render)."* That defense is correct and **must
stay**. So visualization cannot be delivered by loosening the prose renderer — it needs a **separate, structured,
hub-mediated path** whose trust origin is controlled.

The key distinction the design rests on: the img ban targets **arbitrary remote `<img src>` that a model wrote into
prose.** A **hub-captured byte-stream from the session's own worktree, or a tool-result image the vendor runtime
produced, served by the hub over loopback** is a *different origin class* — local, attributable, and never a
model-chosen URL. That difference is what lets us render visuals without reopening the beacon hole.

### 6.3 Capture + render — three tiers, each with a safe path

**Tier 1 — Inline text visuals (cheapest, near-zero new trust surface).**
- **Mermaid:** add a ` ```mermaid ` branch to `renderMarkdown` (`markdown.ts`) that renders the diagram to an inert
  SVG (Mermaid is self-contained, no network) and runs it through DOMPurify's SVG profile. Mirrors the existing
  fence-segmentation that routes ` ``` ` blocks to `CodeBlock.svelte`.
- **Inline SVG in assistant text:** today `sanitizeProse` strips `<svg>` (not in the allowlist; and SVG can carry
  `<image href>`, `<foreignObject>`, scripts). If we want to render agent SVG, add a **dedicated sanitized-SVG
  segment** (DOMPurify SVG profile, **forbid external refs / `<image>` / `<use href=http…>` / scripts**) — never by
  relaxing the prose img ban.
- Tables and code already render (`CodeBlock.svelte`, `DiffView.svelte`).

**Tier 2 — Agent-written files (the real "artifact": HTML/React/SVG/PNG).**
- **Capture:** the hub already sees the producing event — Claude `Write`/`Edit` `tool_use`, Codex `fileChange`. When
  it targets a renderable type, emit a new **`session/artifact`** journal event `{ sessionId, kind:
  'html'|'svg'|'image', path (worktree-relative), mime, size, sha }` (opt-in / on-demand, size-capped). Rides the
  existing append-only journal + WS replay like every other event.
- **Serve:** add a hub route (`server.ts`) e.g. `GET /api/sessions/:id/artifact?path=…`, **gated by the existing
  origin + device-token guard** (`tokenMatches`, `deviceToken.ts`) and **path-fenced to the session worktree** —
  reuse `checkWriteScope`'s containment check (`sessions.ts:110-121`) to reject traversal — then stream bytes from
  disk with a strict `Content-Security-Policy`. **The web UI references hub-origin bytes, never the model's string.**
- **Render** (new `ItemKind: 'artifact'` in `store.svelte.ts:10-19` + a dedicated component, bypassing the prose
  pipeline so the img ban stays intact):
  - **Raster (PNG/JPG chart):** an `<img>` whose `src` is the hub artifact endpoint (same-origin loopback), type/size
    capped, ideally re-encoded server-side.
  - **HTML/React artifact:** a **sandboxed `<iframe sandbox="allow-scripts">` (no `allow-same-origin`)** with a
    **no-network CSP** (`default-src 'none'; img-src data:; style-src 'unsafe-inline'`) so the artifact can
    render/animate but **cannot beacon out or read the app** — the isolation model claude.ai itself uses for
    artifacts.
  - **SVG file:** sanitize (SVG profile, external refs stripped) then inline, or serve as an image.

**Tier 3 — Tool-result screenshots (only when browser/computer tools are on).**
- When a browser/computer MCP is wired (§4), screenshot `tool_result`s carry image blocks. The hub captures the bytes
  from the event stream, stores them hub-side, and emits `session/artifact { kind:'image', source:'tool-result', … }`
  served from the same endpoint. Update the store's tool_result handling (which currently `asText`-flattens) to
  detect image blocks and attach an artifact ref instead of stringifying.

### 6.4 Security model for visualization (four invariants)

1. **Trusted origin only.** Bytes come from (a) a file in the session's **own worktree**, or (b) a **tool-result
   image** the vendor runtime produced — **never** a URL the model wrote into prose. The markdown img ban stays; model
   prose can never introduce a beacon.
2. **Hub-served, same-origin.** All visual payloads are served by the hub over loopback, under the existing origin +
   device-token guard, with worktree-fenced path resolution. No third-party origin is contacted on render.
3. **Sandboxed + network-denied render.** HTML artifacts run in a `sandbox` iframe with a no-network CSP; SVG is
   sanitized (no external refs); raster is type/size-capped and re-encoded. Even a **hostile artifact the agent was
   induced to write** (via a poisoned file or bus message) can't exfil, script the app shell, or auto-fetch.
4. **Journaled + attributed + capability-gated.** Every `session/artifact` rides the journal + `redact()` choke point;
   the card is clearly attributed to the producing agent/tool (like the bus "from" attribution); and screenshots
   exist only when the browser/computer capability is on (off by default, bus-hard-denied per §5.2). Visualization
   therefore **adds no new injection or exfil surface** beyond what the capability toggle already governs.

---

## 7. Concrete integration points in this codebase

| File | Change (browser/computer tools) | Change (visualization) |
|---|---|---|
| `apps/hub/src/adapters/claude.ts` | No new SDK option exists (no `chrome` flag). Add the chosen browser MCP to the `mcpServers` map (already forwarded at line 69) **when the session capability is on**. | — |
| `apps/hub/src/adapters/codex.ts` | MCP servers are declared per-profile in `config.toml [mcp_servers]` under `CODEX_HOME` (not per-turn) — the hub writes the browser MCP into the profile config, as `inter-agent-comms.md` §4.1 already anticipates for the `allmyagents` server. `turn/start` already carries `approvalPolicy`. | — |
| `apps/hub/src/sessions.ts` | In `claudeDriverFor` `canUseTool` (184-197) and `codexClientFor` `onApproval` (155-160): add the **native-tool class check** (deny if capability off; **hard-deny if turn is bus-caused**), mirroring `checkWriteScope`. **Tag bus-caused turns** in `deliverBus` (461-481) so the callback can detect them. Keep native tools **out of** the `mcp__allmyagents__` auto-allow (187). | Emit `session/artifact` when a `Write`/`Edit`/`fileChange` targets a renderable type; capture tool-result image blocks. |
| `apps/hub/src/agentTools.ts` | **Do NOT add browser/computer tools here** — this in-process server is auto-allowed; a separate namespace keeps them approval-gated. | — |
| `apps/hub/src/types.ts` | `SessionRecord.nativeTools` capability + `CreateOptions`/`TurnOverride`; new scope for enabling it. | `ItemKind`/event typing for `session/artifact`. |
| `apps/hub/src/server.ts` | Capability-toggle route (origin+token guarded). | **Artifact-serving route**, origin+token guarded, worktree-path-fenced, strict CSP. |
| `apps/hub/src/journal.ts` / `redact` | New `session/artifact` kind; redact artifact metadata; treat screenshots as sensitive. | Same. |
| `apps/web/src/lib/store.svelte.ts` | New capability state; approval UI shows the concrete target (URL/app/action). | New `ItemKind: 'artifact'`; `apply()` case for `session/artifact`; detect image blocks in tool_results (today `asText` flattens, 73-81 / 776-784). |
| `apps/web/src/lib/markdown.ts` | — | Add **Mermaid** + **sanitized-SVG** segments; **keep the `img` ban** (line 59). New sandboxed **artifact** render component (iframe/img/SVG), separate from the prose pipeline. |
| UI (mode pill area) | Per-session native-tools toggle, clearly labeled, off by default. | Artifact cards render inline in the transcript. |

---

## 8. Phased plan

- **P0 — Spike / verify (no capability shipped).**
  - Wire `@playwright/mcp` to **one Claude** session (`options.mcpServers`) and **one Codex** session
    (`config.toml [mcp_servers]`); confirm the tools appear and every call routes through `canUseTool` / `onApproval`.
  - Confirm Claude **tool-result image blocks** arrive verbatim in the `query()` stream under subscription auth
    (§6.1 Tier 3 depends on this — currently inferred, not confirmed).
  - Spike whether the **bundled `claude-in-chrome`** server can be activated via `query()` (route a, §3.2) or whether
    only a neutral/bridge MCP works.
- **P1 — Recommended near-term: neutral browser MCP, text/DOM only.**
  - Per-session `browser` capability (off by default, scope-gated); approval-gated; **bus-hard-denied**; dedicated
    disposable Chromium profile. Ship **Mermaid rendering** (cheapest viz win). No screenshots rendered yet
    (accessibility snapshots / text only) — lowest risk, immediately useful for web testing/debugging.
- **P2 — Artifact capture + safe render.**
  - `session/artifact` event, hub artifact endpoint (origin+token guarded, worktree-fenced, strict CSP), sandboxed
    iframe/img/SVG render, `ItemKind: 'artifact'`. Enables worktree HTML/SVG/PNG artifacts **and** Tier-3 screenshots.
- **P3 — Native-harness escape hatches, where reachable.**
  - **Claude in Chrome** via `mcpServers` for *authenticated* browser workflows (Claude-only, opt-in, labeled, its own
    scope, its own profile). **Computer control** only on a **dedicated mesh VM/remote desktop** (never the operator's
    host). **Codex** native computer/browser control: **defer** (app-only; track `openai/codex#20851`, `#26151`).
- **Non-goals (explicit):** never a fleet default; never auto-approved; never triggerable from a bus turn; never the
  user's primary browser profile by default; never render model-prose images; never adopt the raw computer-use *API*
  tool (auth/metering fragmentation).

---

## 9. What I could not verify (flags)

- **Claude-in-Chrome activation from `query()`.** Docs frame `--chrome`/`/chrome` as CLI actions and the SDK TS
  reference has **no** `chrome` option; whether the *bundled* `claude-in-chrome` MCP server can be reached purely
  through `query()` (e.g. `settingSources` after a one-time CLI setup, or by name) is **unconfirmed** — needs the P0
  spike. The neutral browser-MCP path sidesteps this.
- **Claude tool-result image blocks over the SDK.** That screenshots arrive as image content blocks in the `query()`
  stream under subscription auth is **inferred** (Messages-API shape + `claude-in-chrome` being an MCP tool), not
  directly documented for the SDK.
- **Codex "inline visualization links."** Whether these surface via app-server events or are terminal-TUI-only is
  unverified.
- **Codex-for-Chrome app-server hook.** No evidence of any app-server/CLI path to drive the extension;
  `learn.chatgpt.com` says browser is "not available in Codex CLI." Treated as desktop-app-bound; a future hook is
  possible but unconfirmed.
- **Source-fetch gap.** `openai.com` 403s the fetch tool (as noted in `vendor-remote-control.md`); Codex claims lean
  on `learn.chatgpt.com` (the `developers.openai.com/codex/app/*` redirect target), the GitHub repo/issues, and
  secondary write-ups. Product availability and version numbers move fast; re-verify before building.
- **WSL.** Claude in Chrome is unsupported in WSL — relevant since AMS-Node-B runs in WSL. A headless Playwright MCP
  works there; the native Chrome-extension harness does not.

---

## Sources

Codex — computer/browser control:
- Computer Use (app, redirect target of `developers.openai.com/codex/app/computer-use`): https://learn.chatgpt.com/docs/computer-use
- Browser (app, redirect target of `developers.openai.com/codex/app/browser`): https://learn.chatgpt.com/docs/browser
- First-class CLI Computer Use feature request (open): https://github.com/openai/codex/issues/20851
- Desktop Windows Browser/Computer Control bug (confirms app-surface): https://github.com/openai/codex/issues/26151
- App-server protocol guide (full API surface — no computer/browser tools): https://codex.danielvaughan.com/2026/04/15/codex-app-server-complete-guide/
- Codex for Chrome extension (desktop-app plugin): https://codex.danielvaughan.com/2026/05/11/codex-chrome-extension-parallel-browser-workflows-devtools-tab-groups/ · https://codex.danielvaughan.com/2026/05/07/codex-for-chrome-extension-browser-integration-authenticated-workflows/
- Work with Codex from anywhere (Windows computer use + phone control, 2026-05-29): https://openai.com/index/work-with-codex-from-anywhere/

Claude — computer/browser control:
- Use Claude Code with Chrome (`claude-in-chrome` MCP server, subscription-auth only, `--chrome`): https://code.claude.com/docs/en/chrome
- Native computer use in the CLI (`computer-use` MCP server, macOS-only, not in `-p` mode): https://code.claude.com/docs/en/computer-use
- Agent SDK TypeScript reference (query() options; no chrome/computer-use flag): https://code.claude.com/docs/en/agent-sdk/typescript
- Computer use *API* tool (API-key beta, for contrast): https://platform.claude.com/docs/en/agents-and-tools/tool-use/computer-use-tool
- Claude in Chrome help / getting started: https://support.claude.com/en/articles/12012173-get-started-with-claude-in-chrome
- Community MCP bridge to the Claude Chrome extension (for contrast): https://github.com/nonsleepr/claude-chrome-mcp

Vendor-neutral browser MCP:
- Playwright MCP (Microsoft): https://github.com/microsoft/playwright-mcp · https://playwright.dev/docs/getting-started-mcp
- Playwright MCP + Codex `config.toml [mcp_servers]`: https://www.simplified.guide/codex/playwright-mcp-server-add
- Chrome DevTools MCP (official, Chrome team; CDP/Puppeteer) — via directory listing: https://glama.ai/mcp/servers/@benjaminr/chrome-devtools-mcp (verify the canonical repo before wiring)

Internal:
- `docs/vendor-remote-control.md` — the inverse question (phone→our sessions), and the SDK-vs-CLI surface mismatch this doc re-encounters
- `docs/inter-agent-comms.md` — injected-turn permission clamp, data-not-instructions trust model, MCP tooling model
- `apps/hub/src/adapters/claude.ts` (`mcpServers`/`canUseTool`/`permissionMode`), `apps/hub/src/adapters/codex.ts` (`spawn('codex app-server')`, `onApproval`, `approvalPolicy`), `apps/hub/src/agentTools.ts` (in-process MCP server), `apps/hub/src/sessions.ts` (`canUseTool` auto-allow, `checkWriteScope`, `clampMode`, `deliverBus`), `apps/hub/src/server.ts` (`tokenMatches` device-token guard), `apps/web/src/lib/markdown.ts` (the `img` ban / exfil defense), `apps/web/src/lib/store.svelte.ts` (`ItemKind`, tool-result flattening), `apps/web/src/lib/{CodeBlock,DiffView}.svelte` (existing rich-render components)
