# Project onboarding / import — adopt a folder's existing chats + MCPs

Design scope, drafted 2026-07-24. Implements the **DESIGN.md §12 queue item "Folder onboarding scan
(import existing chats + MCPs)"** and the **§10 backlog "repo onboarding scanner."** Extends **D4
(profiles = config dirs; move-never-copy)**, **D5 (brains = orchestration MCP scope; privilege is an
ACL grant)**, **D6 (projects are first-class)**, **D9 (memory materialization into CLAUDE.md/AGENTS.md)**,
and the journal-secret-redaction rule from **§10 (P1)**.

**Design only — nothing here is built yet.** The scope is one new hub scanner + endpoint, a thin
`SessionManager.import()` that reuses the *existing* vendor-resume paths, an MCP surfacing/wiring step,
and an onboarding panel bolted onto the existing "new project" flow in `Sidebar.svelte`. This doc
grounds every format claim in the real on-disk data on this machine (inspected read-only 2026-07-24).

---

## 0. What exists today (the substrate we build on)

| Piece | File | Relevant fact |
|---|---|---|
| Project = `{id,name,path}` | `apps/hub/src/projects.ts` | `ProjectStore.create(name, path)` validates the dir exists; no scan on create. |
| Session create | `apps/hub/src/sessions.ts` `create()` | Builds a `SessionRecord`, persists, journals `session/created`, spins a driver/thread. |
| **Claude resume** | `sessions.ts:171` → `adapters/claude.ts:42` | `if (record.vendorSessionId) driver.restore(id)`; `restore()` sets the id that becomes SDK `options.resume`. |
| **Codex resume** | `sessions.ts:258` `ensureCodexThread()` → `adapters/codex.ts:186` | `client.resumeThread(record.vendorSessionId)` issues `thread/resume {threadId}`. |
| Profiles | `apps/hub/src/profiles.ts` | `scanProfiles(dir)` = each subdir of `profiles/` with `auth.json`→codex or `.credentials.json`→claude. Profile `dir` **is** the vendor config dir. |
| Session snapshot | `apps/hub/src/store.ts` | `SessionStore` persists `SessionRecord` rows; `boot()` restores them. |
| Web project create | `apps/web/src/lib/Sidebar.svelte` `createProject()` → `api.createProject(name, path)` | Calls `POST /api/projects`; then `store.refreshProjects()`. Folder chosen via `api.pickFolder()` → hub `native.ts`. |
| Server routes | `apps/hub/src/server.ts` | `POST /api/projects`, `POST /api/pick-folder`, `POST /api/sessions`, origin guard (`originAllowed`). No scan route yet. |
| Secret redaction | `apps/hub/src/redact.ts` | `redact(text)` scrubs known token shapes; used on journal writes. **Not yet applied to config we'd parse.** |

Two gaps this feature exposes, both confirmed on disk:

- **Claude MCP wiring gap** — `adapters/claude.ts` passes **no `mcpServers`** option. A hub-spawned Claude
  session inherits MCP only from what the CLI auto-reads in its `cwd` (`.mcp.json`) and from the *profile's*
  `~/.claude.json` project entry — which is empty for fresh profiles.
- **Codex MCP wiring gap** — `profiles/codex-a/` has **no `config.toml`**. Codex reads MCP servers only from
  `$CODEX_HOME/config.toml [mcp_servers]`. So hub-spawned Codex agents currently get **zero** MCP servers.

---

## 1. On-disk formats (inspected, concrete)

### 1.1 Claude Code transcripts

```
<CLAUDE_CONFIG_DIR>/projects/<encoded-cwd>/<session-uuid>.jsonl
```

- `CLAUDE_CONFIG_DIR` is the user's real `~/.claude` for their own CLI runs, and each `profiles/<name>/`
  for hub-driven sessions (the hub sets `CLAUDE_CONFIG_DIR=profile.dir`, `adapters/claude.ts:52`). So **the
  same cwd can have transcripts under several config dirs** — the real home dir plus every profile that ran
  there. Observed: `profiles/claude-a/projects/C--Users-Admin-AiAgentApp/…` **and**
  `~/.claude/projects/C--Users-Admin-AiAgentApp/…`.
- **Encoding (verified empirically against 4 real dirs):** `encoded = cwd.replace(/[^a-zA-Z0-9]/g, '-')`.
  Every non-alphanumeric char — `:` `\` `/` space `.` and *literal* `-` — collapses to `-`.
  - `C:\Users\Admin\AiAgentApp` → `C--Users-Admin-AiAgentApp`
  - `C:\Users\Admin\Documents\AllMyStuff Encoder Work\AllMyStuffEncoderFraske` →
    `C--Users-Admin-Documents-AllMyStuff-Encoder-Work-AllMyStuffEncoderFraske`
  - **This mapping is deterministic forward but LOSSY reverse** — distinct cwds can collide onto one folder
    (`foo-bar` and `foo bar` and `foo.bar` all encode the same). **Consequence:** generate the folder name
    from the cwd (forward) to *find* candidates, then **confirm** by reading the `cwd` field inside the
    transcript. Never trust the folder name as ground truth.
- **Filename stem = the resume id.** `<session-uuid>.jsonl`; the same uuid is the `sessionId` inside every
  record and is exactly what `driver.restore()` / SDK `options.resume` expects.
- **Record shape** (one JSON object per line). Message records:
  `{ type: "user"|"assistant", cwd, gitBranch, version, sessionId, userType, timestamp, uuid, parentUuid,
  message: { role, content } }`. `content` is a string or block array (`text` / `thinking` / `tool_use` /
  `tool_result`) — the same shapes `store.svelte.ts` already renders for live Claude events.
- **Non-message records** worth harvesting for the card: `{type:"ai-title", aiTitle, sessionId}` (Claude's own
  generated chat title — ideal label), plus `summary`, `custom-title`, `queue-operation`, `attachment`. A scan
  can pull `aiTitle` cheaply without parsing the whole (multi-MB) file.

### 1.2 Codex rollouts

```
<CODEX_HOME>/sessions/YYYY/MM/DD/rollout-<ISO-ts>-<session_id>.jsonl
```

- **Date-partitioned, NOT keyed by cwd.** You cannot glob by project path; you must walk the tree and read
  each rollout's first line. Observed: `profiles/codex-a/sessions/2026/07/23/rollout-2026-07-23T17-45-05-019f9127-4ec1-7763-9756-fb1064aa8658.jsonl`.
- **Line 1 is `session_meta`:** `{type:"session_meta", payload:{ session_id, id, timestamp, cwd, originator,
  cli_version, source, model_provider, … }}`. `payload.cwd` is the real backslash path
  (`C:\Users\Admin\AiAgentApp\spikes`) — **read it to filter by project.** `payload.session_id` (also embedded
  in the filename) is the **resume thread id** for `thread/resume`.
- Subsequent lines: `{type:"event_msg", …}` (e.g. `task_started` with `turn_id`, `model_context_window`) and
  `{type:"response_item", …}` (messages/tool calls). `originator` shows who launched it
  (`aiagentapp-spike` for hub spikes, `vscode` for the desktop app).

### 1.3 MCP configuration sources

| Source | Scope | Path | Shape | Secrets? |
|---|---|---|---|---|
| **`.mcp.json`** | Project (shared, committed) | `<repo>/.mcp.json` | `{ "mcpServers": { "<name>": { "command", "args", "env" } \| { "type":"http"\|"sse", "url", "headers" } } }` | **env / headers can hold tokens** |
| **`.claude/settings.json`** | Project (shared) | `<repo>/.claude/settings.json` | `enableAllProjectMcpServers`, `enabledMcpjsonServers: []`, `disabledMcpjsonServers: []` (the approval gate for `.mcp.json`) | usually not |
| **`.claude/settings.local.json`** | Project (local, gitignored) | `<repo>/.claude/settings.local.json` | same keys, local overrides | maybe |
| **`~/.claude.json` project entry** | User (per config dir) | `<CLAUDE_CONFIG_DIR>/.claude.json` → `projects["<cwd>"]` | `mcpServers` (user-added), `enabledMcpjsonServers`, `disabledMcpjsonServers`, `hasTrustDialogAccepted` | `mcpServers.*.env` can |
| **Codex `config.toml`** | Home (per `CODEX_HOME`) | `<CODEX_HOME>/config.toml` → `[mcp_servers.<name>]` | `command`, `args`, `startup_timeout_sec`, `[mcp_servers.<name>.env]` | **`[…​.env]` holds tokens** |

Grounding notes from the real files:

- The per-profile `.claude.json` `projects` map is keyed by the **exact cwd** (normalized to forward slashes:
  `"C:/Users/Admin/AiAgentApp"`), and every entry carries `mcpServers`, `enabledMcpjsonServers`,
  `disabledMcpjsonServers`, and `hasTrustDialogAccepted`. So this file is a *second* cwd→data index (alongside
  `projects/<encoded>/`), and it holds both the user-scoped MCP servers and the project-trust state.
- Codex `~/.codex/config.toml` had a live `[mcp_servers.node_repl]` with a large `[mcp_servers.node_repl.env]`
  block (executable paths, `\\.\pipe\…` names, SHA-256 trust hashes). MCP env is exactly where third-party
  servers stash `API_KEY=…`. **This block is the secrets hazard.**
- Codex is **home-scoped only** — no per-repo `.mcp.json` equivalent. Its project affinity is trust
  (`[projects.'<lowercased backslash path>']`) + `AGENTS.md` in cwd, not MCP.
- **Never read `auth.json` / `.credentials.json`.** The scanner touches transcripts and MCP config only. D4
  forbids copying Codex `auth.json` (single-use rotating tokens); the scanner has no reason to open either.

### 1.4 Memory / instruction files (adjacent, D9)

`CLAUDE.md`, `AGENTS.md`, `.cursorrules` at the repo root are the D9 materialization targets. The scanner can
list their presence so onboarding offers "fold into this project's memory scope" (per DESIGN §12c), but the
actual folding is owned by `docs/memory-system.md`, not this doc. We surface, we don't ingest.

---

## 2. Detection

### 2.1 Algorithm

Input: a folder `path` + the live profile set (`SessionManager` already holds `profiles: Map<string,Profile>`).

**Chats — Claude** (per profile, per config dir including optionally the real home):
1. `enc = path.replace(/[^a-zA-Z0-9]/g, '-')`.
2. For each config dir `D` in `{ every profiles/<name>/, (opt-in) ~/.claude }`: glob `D/projects/<enc>/*.jsonl`.
3. For each transcript: read the **first** and **last** JSON lines (stream head + tail — files reach multiple
   MB; never `JSON.parse` the whole thing for a scan):
   - **Confirm** `record.cwd === path` (normalize slashes + case) — rejects lossy-encoding collisions.
   - Pull `sessionId` (= filename stem), first user message (preview), any `ai-title.aiTitle`, last record
     `timestamp`, `gitBranch`, cheap line count (message count ≈ `wc -l` minus non-message rows), and model
     (`message.model` on an assistant record if present).
   - Owner = the profile that owns `D` (or `__home__` sentinel for `~/.claude`).

**Chats — Codex** (per profile; Codex home dirs only):
1. Walk `profiles/<name>/sessions/**/rollout-*.jsonl` (bounded: newest N days first, cap results).
2. Read line 1 (`session_meta`); keep those whose `payload.cwd` matches `path`.
3. Card = `payload.session_id`, `timestamp`, `originator`, `cli_version`; last-msg/count from the tail line.

**MCPs:**
- Parse `<path>/.mcp.json` (if present) → project-scoped server list.
- Parse `<path>/.claude/settings.json` + `settings.local.json` → `enabled/disabledMcpjsonServers`,
  `enableAllProjectMcpServers` (which `.mcp.json` servers are already approved).
- Parse each relevant `<CLAUDE_CONFIG_DIR>/.claude.json` → `projects["<path>"].mcpServers` (user-scoped) +
  its `enabled/disabledMcpjsonServers` + `hasTrustDialogAccepted`.
- Parse each `<CODEX_HOME>/config.toml` → `[mcp_servers.*]` (home-scoped; attribute to that profile).
- **De-duplicate by name**, record each server's `scope` (`project-mcp-json | claude-user | codex-home`),
  `sourcePath`, `sourceProfile?`, `transport` (`stdio|http|sse`), and **`hasSecrets` = env/headers non-empty**.
  **Redact values before they leave the hub** (§5.3).

**Memory files:** stat `CLAUDE.md` / `AGENTS.md` / `.cursorrules` → `{ name, bytes }`.

**Dedup against already-imported / hub-owned:** the hub's own sessions write transcripts under their profile
dir too, so a scan re-finds them. Mark any chat whose `sessionId`/`session_id` equals an existing
`SessionRecord.vendorSessionId` as `alreadyImported: true` (and don't offer it again). This one check also
hides hub-native sessions and prevents double-import.

### 2.2 Hub API

Task names it `GET /api/projects/scan?path=…`. Recommended form matches the codebase's existing
`POST /api/pick-folder` + `POST /api/projects` (bodies, not query strings — Windows backslash paths are
awkward to URL-encode and the origin guard already covers loopback):

```
POST /api/projects/scan
  body: { path: string, includeHome?: boolean, projectId?: string }
  → 200 {
      path,
      chats: ImportableChat[],
      mcps: ImportableMcp[],
      memoryFiles: { name: string, bytes: number }[],
      scannedProfiles: string[],
      warnings?: string[]         // e.g. "unreadable transcript X", "malformed .mcp.json"
    }
```

```ts
interface ImportableChat {
  provider: 'claude' | 'codex'
  vendorSessionId: string          // Claude uuid / Codex session_id — the resume id
  ownerProfileId: string | null    // null ⇒ found under ~/.claude (home) ⇒ view-only
  cwd: string
  title?: string                   // ai-title, else first-user-message preview
  firstPrompt?: string
  lastActivity: string             // ISO
  messageCount: number
  model?: string
  gitBranch?: string
  sizeBytes: number
  transcriptPath: string           // absolute; hub-internal, for the view-historical reader
  resumable: boolean               // ownerProfileId != null (see §3.2)
  alreadyImported: boolean
}

interface ImportableMcp {
  name: string
  scope: 'project-mcp-json' | 'claude-user' | 'codex-home'
  transport: 'stdio' | 'http' | 'sse'
  sourcePath: string
  sourceProfile?: string
  hasSecrets: boolean              // env / headers non-empty — VALUES ARE NOT INCLUDED
  approvedForClaude?: boolean      // from enabled/disabledMcpjsonServers / hasTrustDialogAccepted
  redactedPreview: string          // e.g. "npx -y @modelcontextprotocol/server-github (env: 1 var ✱)"
}
```

Scanning is bounded I/O (glob + head/tail reads), so a synchronous response is fine for the first slice. For
large histories, upgrade to an async job that streams `scan/progress` / `scan/complete` events over the
existing `/ws` journal (same pattern as every other hub event) and returns a `scanId` immediately.

Events (journaled, all `redact()`-clean): `project/scan-started`, `project/scan-complete`
`{ chats: n, mcps: m }`, `session/imported`, `project/mcp-imported`.

---

## 3. Import chats → the existing resume path

### 3.1 The mapping (this is the whole trick)

An imported chat is **just a `SessionRecord` with `vendorSessionId` pre-set**, bound to the profile whose
config dir owns the transcript. The hub's *existing* lazy-resume machinery then treats it exactly like a
session that survived a hub restart:

- **Claude:** `claudeDriverFor(record)` runs `if (record.vendorSessionId) driver.restore(id)` (`sessions.ts:171`).
  First `send()` → SDK `query({ options:{ resume: vendorSessionId, cwd, env:{CLAUDE_CONFIG_DIR:profile.dir} } })`.
  Because the transcript lives at `profile.dir/projects/<enc>/<id>.jsonl`, the SDK finds and continues it.
- **Codex:** `ensureCodexThread(record)` sees no live thread, calls `client.resumeThread(vendorSessionId)`
  (`sessions.ts:263`). The per-profile `CodexClient` has `CODEX_HOME=profile.dir`, whose `sessions/` tree
  holds the rollout, so `thread/resume` reattaches.

No new adapter code. We add one method beside `create()`:

```ts
// sessions.ts — sibling to create(); no worktree, no first prompt, status idle.
async import(profileId, { vendorSessionId, provider, cwd, projectId, model }): Promise<SessionRecord> {
  // guard: profile exists & provider matches; reject if a session with this vendorSessionId exists (dedup)
  const record: SessionRecord = {
    id: crypto.randomUUID(), profileId, provider, projectId,
    cwd,                      // the transcript's real cwd — resume must run in-place
    status: 'idle',
    vendorSessionId,          // ← the imported id; drives restore()/resumeThread()
    model, createdAt: new Date().toISOString(),
    imported: true,           // new optional flag on SessionRecord (see §3.4)
  }
  this.sessions.set(record.id, record); this.persist(record)
  this.journal.append(record.id, 'session/imported', { vendorSessionId, provider, cwd, sourceProfile: profileId })
  // For Codex, eagerly bind the thread so it shows resumable immediately; Claude binds lazily on first send.
  return record
}
```

Route: `POST /api/sessions/import { profileId, provider, vendorSessionId, cwd, projectId?, model? }` — or a
batch `POST /api/projects/:id/import { chats: [...], mcps: [...] }` for the "import selected" click.

### 3.2 Which account owns a transcript — and the resumable boundary

Ownership is **positional**: a transcript under `profiles/<name>/…` belongs to profile `<name>`; the import
binds to that profile. This is unambiguous and needs no credential inspection.

**Resumable iff the transcript already lives under a hub profile's config dir.** Resume needs both the
transcript *and* a valid credential chain in the same config dir the hub points the CLI at. Therefore:

- Chats under a **hub profile** → **resumable** (`resumable:true`). Bind + resume as above.
- Chats under the user's **real `~/.claude`** (opt-in `includeHome`) → **view-only** by default
  (`ownerProfileId:null`, `resumable:false`). The hub deliberately never sets `CLAUDE_CONFIG_DIR=~/.claude`
  (isolation) or `CODEX_HOME=~/.codex` (D4: the desktop app owns that token chain; single-use tokens).
  - *Claude* home chats can *become* resumable only via the separate DESIGN §12 "import existing logins"
    feature (Claude `.credentials.json` is copyable, so adopting `~/.claude` as a profile is legal). That is
    out of scope here; until then, home chats import as read-only history.
  - *Codex* home chats are **never** hub-resumable (can't copy `auth.json`), full stop — view-only or ignored.

### 3.3 Import for display vs. resume (two independent things)

Setting `vendorSessionId` makes a chat **continuable**, but the hub's ThreadView is built from the *journal*,
which has **no events** for a session that ran outside the hub — so an imported chat would render blank until
the first new turn. Handle the two needs separately:

1. **Card summary (always, cheap):** the scan's head/tail read already yields title, last message, counts,
   model — enough for the sidebar row and the import preview.
2. **View historical (on demand, read-only):** a new `GET /api/sessions/:id/transcript` streams the parsed
   JSONL from `transcriptPath`, mapped to the same `ThreadItem[]` shapes `store.svelte.ts` already builds
   (reuse `applyClaudeAssistant` / `applyCodexItem` logic against file records instead of live events). The
   web store renders these as a dimmed "imported history" band above the live area. **Do not backfill the
   journal** — keep imported history out of the append-only log so replay/seq stays clean; the journal begins
   at the first *new* hub turn.
3. **Resume (on first send):** unchanged existing path; new turns journal normally and stack under the
   historical band.

So a "view-only" home chat = step 1 + 2 with the composer disabled; a "resumed" profile chat = 1 + 2 + 3.

### 3.4 Dedup, flags, cleanup

- **Dedup:** reject import when `vendorSessionId` already maps to a live `SessionRecord`; the scan pre-marks
  these `alreadyImported`. Idempotent re-scan after import shows them greyed.
- **`SessionRecord.imported?: boolean`** (new optional field in `types.ts` + `api.ts`) drives a sidebar badge
  and the read-only affordance for `resumable:false` chats. Persists via the existing `SessionStore` JSON blob
  (no migration — it's a new optional key).
- **Worktrees:** imports run **in the original cwd** (resume must see the same working tree the transcript
  references), so `import()` creates **no** worktree — unlike `create()`. If the user later wants isolation,
  that's a "port to worktree" action (D14 account-swap already ports into a cwd), not part of import. Note the
  open question in §7 about two live sessions sharing one cwd (worktree-ownership lease).
- **Delete:** existing `SessionManager.delete()` tombstones + drops the snapshot. For imported sessions it must
  **never delete the source transcript** (it's the user's history and may live in the real home dir) — delete
  only removes the hub's record. Add an assert: imported delete skips any file unlink.

---

## 4. Import MCPs

### 4.1 What "import" means (two levels)

1. **Surface** — list the project's MCP servers in the hub UI (from the scan). Pure display; no risk.
2. **Wire** — make hub-spawned agents in this project actually *get* those servers. This is where the two
   gaps from §0 must close:

| Vendor | Does a hub agent already get project MCP? | Gap / fix |
|---|---|---|
| **Claude** | Partially. The Claude CLI auto-reads `<cwd>/.mcp.json`, so a session whose `cwd` is the project root **does** see project `.mcp.json` servers — *if* they're trusted. But trust (`enabledMcpjsonServers` / `hasTrustDialogAccepted`) lives in the **profile's** `.claude.json`, which is empty for fresh profiles, so servers sit un-approved. | On import, write the approval into the profile's `.claude.json` `projects["<cwd>"]` (`enabledMcpjsonServers += names`, `hasTrustDialogAccepted = true`) **for the chosen servers only**. Optionally also pass them explicitly via SDK `options.mcpServers` in `adapters/claude.ts` (closes the "cwd isn't the repo root" worktree case). |
| **Codex** | **No.** Codex reads MCP only from `$CODEX_HOME/config.toml`, and hub Codex profiles have none. | On import, **merge** the selected `[mcp_servers.<name>]` blocks into `profiles/<name>/config.toml` (create if absent). Codex is home-scoped, so this makes the server available to *all* that profile's sessions — acceptable, but see the ACL note below. |

So the honest answer to "do they already get them?": **Claude, mostly (modulo trust); Codex, not at all.**
Import must (a) record trust/approval for Claude and (b) synthesize a `config.toml` for Codex.

### 4.2 Trust / ACL angle — "brains = MCP ACL grant"

DESIGN principle 4 + D5: privilege is an ACL grant on ordinary sessions, and the brains role is exactly an
orchestration-MCP grant. Imported MCPs get the same treatment — **importing a server ≠ granting every agent
the right to call it.** Model it as a hub-owned per-project ACL:

```
project_mcp_grants(project_id, mcp_name, scope: 'all-in-project' | 'brains-only' | 'profile:<id>' | 'session:<id>')
```

- Default grant on import = **`all-in-project`** (matches the user's evident intent — it was configured for
  this repo) but the onboarding panel lets the user downgrade a server to `brains-only` (e.g. a
  deploy/prod-touching MCP) at import time.
- At spawn, the hub composes the effective server set from the grants for that session's project + role, and
  *then* materializes it (Claude `options.mcpServers` / trust keys; Codex `config.toml`). This keeps Codex's
  coarse home-scope honest: even though the file makes a server available profile-wide, the hub only *starts*
  sessions whose grant allows it, and can omit the block for a session that shouldn't have it by writing a
  scoped config (future: per-session `CODEX_HOME` overlay).
- Enforcement reuses the existing approval router (`approvals.ts`) for first-use-of-an-imported-MCP prompts if
  the grant is `ask`, mirroring `canUseTool`.

### 4.3 Secrets (the load-bearing safety section)

MCP config is a **credential-bearing surface** (`.mcp.json` `env`/`headers`, Codex `[mcp_servers.*.env]`,
`~/.claude.json` `mcpServers.*.env`). Rules:

1. **Values never leave the hub.** The scan response and every journal/UI event carry only
   `hasSecrets: boolean`, a var **count**, and a `redactedPreview` (command + `env: N vars ✱`). Actual
   env/header values stay server-side. Run `redact()` over any preview string before it's emitted, as a
   backstop.
2. **Copy hub-internally, never echo.** When wiring (writing profile `config.toml` / `.claude.json`), the hub
   reads source values and writes them to the destination config **directly on disk**; they transit the hub
   process only, never the WS or the journal.
3. **Never write secrets into the repo.** All wiring targets are per-profile config dirs
   (`profiles/<name>/…`), which are outside every worktree and (must be) git-ignored. The scanner must refuse
   to write MCP config into the project folder.
4. **Redaction hygiene extends to transcript import** — imported Claude/Codex transcripts (§3.3) can contain
   tool output with tokens; run them through `redact()` on the way to the ThreadView just like live events.
5. `.env` files, `auth.json`, `.credentials.json` are **out of scope for the scanner** — never opened.

---

## 5. Onboarding UX

### 5.1 Flow (from the existing panel)

Today `Sidebar.svelte` `createProject()` → `api.createProject()` → `store.refreshProjects()`. Insert a scan
step between create and finish:

```
[+ New project]  (existing showCreate panel)
  name: ▢   folder: ▢ [browse]        ← existing inputs (browse = api.pickFolder())
  [Create & scan]                     ← replaces "create project"
        │
        ▼  POST /api/projects  → then POST /api/projects/scan {path, projectId}
  ┌─ Onboarding sheet ─────────────────────────────────────────┐
  │  Found 7 chats across claude-a, codex-a · 3 MCP servers     │
  │                                                             │
  │  CHATS                                                      │
  │   ☑ ✦ "Design multi-agent GUI…"  claude-a · 262 msgs · 2h  │
  │   ☑ ⬡ codex spike               codex-a · 41 msgs · 1d     │
  │   ☐ (home) old CLI run          ~/.claude · view-only      │
  │  MCP SERVERS                                                │
  │   ☑ github   stdio · .mcp.json · env ✱1  [all ▾]           │
  │   ☑ node_repl stdio · codex-home(codex-a) [brains ▾]       │
  │  MEMORY FILES                                               │
  │   ☑ CLAUDE.md (4 KB) → fold into project memory            │
  │                                                             │
  │              [Skip]            [Import 2 chats · 2 MCPs]    │
  └─────────────────────────────────────────────────────────────┘
```

- Group chats by `ownerProfileId`, provider logo via the existing `ProviderLogo.svelte`, relative time via
  `time.ts` `relativeTime()`. `alreadyImported` rows render disabled/checked. `resumable:false` rows show a
  "view-only" tag and, if unchecked-by-default, can still be imported as read-only history.
- "Import" → `POST /api/projects/:id/import { chats:[…selected], mcps:[…selected], grants:{…} }`. The hub calls
  `SessionManager.import()` per chat and the MCP-wiring per server, journaling each; the web store's existing
  `session/created`/`session/imported` handling makes them appear **grouped under the new project** in the
  sidebar (the `groups` derivation in `Sidebar.svelte` already buckets by `record.projectId`).
- **Scan is re-runnable** on an existing project (a "Scan for existing chats" item in the project header
  menu), so onboarding isn't a one-shot — matches how `rescanProfiles` works today.

### 5.2 Store additions (`store.svelte.ts`)

- `scanProject(path, projectId)` → holds the manifest in `$state`; `importSelected(projectId, selection)`
  posts and optimistically `ensure()`s the returned records (same pattern as `newSession`).
- Imported view-only chats: `SessionView` gets an `imported`/`readonly` flag so `ThreadView` disables the
  composer and shows the historical band from `GET /api/sessions/:id/transcript`.

---

## 6. Phased plan

**Slice 1 — Detect + view (smallest useful, read-only, zero write risk).**
`POST /api/projects/scan` returning **Claude** chats only (forward-encode cwd, glob profile dirs, confirm via
`cwd` field, head/tail summary) + MCP **surfacing** (parse `.mcp.json` + profile `.claude.json`, redacted).
Onboarding sheet shows the manifest; import creates **view-only** `SessionRecord`s (no resume yet) +
`GET /api/sessions/:id/transcript`. Proves the mapping and the UX with no config mutation. *Exit:* pick a
folder that has prior Claude chats → see them listed with titles/counts → import → read history in the hub.

**Slice 2 — Resume.** Wire `SessionManager.import()` to the real resume paths for profile-owned chats
(`resumable:true`); first send continues the vendor session. Add dedup vs `vendorSessionId`, the `imported`
flag/badge, and the delete-never-unlinks guard. *Exit:* import a `claude-a` chat, send a message, it continues
with full prior context.

**Slice 3 — Codex chats.** Walk `sessions/**`, filter by `session_meta.cwd`, resume via `resumeThread`. *Exit:*
a prior Codex thread for the folder imports and continues.

**Slice 4 — MCP wiring + ACL.** Write Claude trust into profile `.claude.json`; synthesize/merge Codex
`config.toml`; `project_mcp_grants` table + per-server scope picker; secret-safe copy. Optionally add
`options.mcpServers` to `adapters/claude.ts` for the worktree case. *Exit:* import a `.mcp.json` server, spawn
a new agent in the project, the tool is available and journaled without leaking env values.

**Slice 5 — Polish.** Opt-in `~/.claude` home scanning (view-only), memory-file folding hand-off to
`docs/memory-system.md`, async scan with `scan/progress` for large histories, re-scan menu item.

---

## 7. Open questions & security flags

**Security / secrets**
- **MCP env values are credentials.** The single hard rule: values transit the hub process only; the scan
  response, journal, and UI carry `hasSecrets`+count+redacted preview, never values (§4.3). This must be true
  from Slice 1 or it's near-impossible to retrofit (same reasoning as the P1 journal-redaction item).
- **Reading the user's real `~/.claude`** is privacy-sensitive: it holds *other* projects' history and the
  account's `.claude.json`. Home scanning is **opt-in** (`includeHome`), read-only, and never copies
  credentials. Default off.
- **Never touch `~/.codex` or any `auth.json`/`.credentials.json`** (D4) — the scanner has no code path that
  opens them.
- **Writing into profile config dirs** (MCP wiring) must be a merge, not a clobber (a profile's `.claude.json`
  and `config.toml` may already carry state) — mirror `meshSite.ts`'s read-merge-write discipline.

**Correctness / architecture**
- **Lossy cwd encoding** ⇒ always confirm via the transcript's `cwd` field; never reverse-decode a folder
  name. (Verified: `foo bar`, `foo-bar`, `foo.bar` collide.)
- **Worktree ownership** — imported chats resume in the original cwd. If the same cwd is later imported twice,
  or an imported session runs alongside a hub session in the same dir, two live agents share one working tree
  (the §10 "worktree ownership lease" open question). Import should refuse a second *resumable* import of the
  same `vendorSessionId`, and flag (not block) a second session in the same cwd.
- **Codex home-scope vs per-project intent** — `config.toml` MCP is profile-wide, so "import this MCP for this
  project" leaks the server to the profile's other projects. Acceptable short-term; the clean fix is a
  per-session `CODEX_HOME` overlay or hub-mediated MCP (D5 orchestration server) rather than raw config files.
- **Transcript size** — real transcripts hit 12 MB+. Scan must head/tail-read, never full-parse; view-historical
  must stream/paginate. A naive `JSON.parse(readFileSync)` will stall the hub.
- **Home Claude chats becoming resumable** depends on the separate "import logins" feature (adopt `~/.claude`
  as a profile). Until it ships, decide product-side whether view-only home chats are worth showing or just
  noise.
- **Duplicate transcripts across config dirs** — the same account run under two profiles (independent login
  chains, legal per D4) could produce near-identical transcripts under two profile dirs with *different*
  session ids. Dedup is by `vendorSessionId`, so both would appear; that's correct (they *are* distinct vendor
  sessions) but the UI may want to hint at the near-duplicate.

---

## 8. Summary

Detection is a forward cwd-encode + glob for Claude (confirmed by each transcript's `cwd` field, because the
encoding is lossy) and a `session_meta.cwd` filter over the date-partitioned Codex `sessions/` tree, run across
every hub profile's config dir; MCPs come from `.mcp.json` + `.claude/settings*` + the profile `.claude.json`
project entry (Claude) and `config.toml [mcp_servers]` (Codex). Import is a thin `SessionManager.import()` that
pre-sets `vendorSessionId` on a `SessionRecord` bound to the owning profile, so the hub's **existing**
`driver.restore()` / `resumeThread()` paths make the chat live and continuable — resumable only when the
transcript already lives under a hub profile (home-dir chats are view-only). MCP import surfaces servers, wires
them by recording Claude trust and synthesizing Codex `config.toml`, gated by a per-project MCP ACL ("brains =
MCP ACL grant"), with env values kept strictly hub-internal. The first slice is Claude detect + read-only view;
the load-bearing constraint throughout is that MCP secrets and the user's real home history never reach the
journal, UI, or repo.
