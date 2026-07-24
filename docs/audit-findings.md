# AllMyAgents — correctness, security & consistency audit

Audit date: 2026-07-23. Scope: `apps/hub/src/**`, `apps/web/src/lib/**` + `App.svelte`, `apps/desktop/src-tauri/**`, cross-referenced against `DESIGN.md`. Read-only review; no source was modified, no servers/builds run.

Verdict: the architecture is sound and the event-sourcing/tombstone/replay discipline is mostly right. The dominant risk is the **complete absence of authentication combined with `Access-Control-Allow-Origin: *`**, which is exploitable from an ordinary web page the user visits — not only over the mesh. There is also one concrete **event-replay integrity bug** (2000-row cap) that silently drops journal history.

## Severity counts

| Severity | Count |
|---|---|
| Critical | 1 |
| High | 3 |
| Medium | 6 |
| Low | 9 |

Some items are partially acknowledged in `DESIGN.md` (D12/D13.1); those are marked **[known]** but still listed because the code as written is exploitable/incorrect today.

---

## CRITICAL

### C1 — No auth + `Access-Control-Allow-Origin: *` = drive-by full control of the hub (loopback, no mesh needed)
**Severity:** Critical **Files:** `apps/hub/src/server.ts:202-204` (ACAO), `server.ts:191-399` (no auth on any route), `server.ts:401-412` (WS: no `Origin`/token check), `apps/hub/src/adapters/claude.ts:61-62` (`full` → `bypassPermissions`), `sessions.ts:328-343` (`/api/sessions` accepts `permissionMode`).

Every HTTP route and the `/ws` endpoint are unauthenticated, and the server sets `Access-Control-Allow-Origin: *` plus `Access-Control-Allow-Headers: content-type` and answers the preflight (`server.ts:205-209`). The code comment claims loopback binding means "this doesn't widen exposure beyond what's already reachable" — that reasoning is wrong for browser-originated requests.

**Failure scenario (no mesh, default config):** the user, while the hub runs, visits any web page in a normal browser. That page runs:
```js
fetch('http://127.0.0.1:7777/api/sessions', {method:'POST',
  headers:{'content-type':'application/json'},
  body: JSON.stringify({ profileId:'claude-a', permissionMode:'full',
    prompt:'run: <attacker command>' })})
```
The preflight passes (ACAO `*`, `content-type` allowed), the POST is delivered, a Claude/Codex session spawns in `bypassPermissions`/`approvalPolicy:never` mode, and the agent executes the attacker's shell command on the user's machine. Because ACAO is `*`, the page can also **read** every response. Separately, the page can open `ws://127.0.0.1:7777/ws?since=0` (WebSocket is not gated by CORS and the server checks no `Origin`) and exfiltrate the **entire journal** — all transcripts, prompts, cwd/worktree paths, tool I/O. `GET /api/events?since=0` leaks the same over HTTP.

This is arbitrary code execution + full transcript exfiltration triggered by visiting a page. Browser Private-Network-Access rollout mitigates it only partially and unreliably.

**Fix:** (1) Require a bearer/device token on all `/api` + `/ws` (the token DESIGN D13.1 already plans) — generate on first run, hand it to the web UI/desktop shell, reject requests without it. (2) Replace ACAO `*` with an explicit allowlist (echo only `http://localhost:5273`, `https://tauri.localhost`, and the desktop origin) and validate the WS `Origin` header. (3) Reject cross-site requests lacking the token even on loopback. Until a token exists, an `Origin`/`Host` allowlist is the minimum stop-gap against drive-by.

---

## HIGH

### H1 — Journal replay is capped at 2000 rows → silent event loss on connect/reconnect
**Severity:** High **Files:** `apps/hub/src/journal.ts:22-24,42` (`LIMIT` default 2000), `server.ts:404` (WS replay), `server.ts:325` (`/api/events`). Consumer: `apps/web/src/lib/store.svelte.ts:332-363`.

`journal.since(seq, limit = 2000)` returns at most 2000 rows. The WS connection handler replays exactly one `journal.since(since)` call, then attaches the live listener — there is no pagination loop. Live events resume from *now*.

**Failure scenario:** the journal has 5000 rows when a viewer connects with `?since=0`. It receives seq 1..2000, sets `lastSeq = 2000`, then live events stream from seq ~5001. Events **2001..5000 are never delivered** and cannot be recovered: the client rebuilds transcripts purely from replayed events, there is no REST snapshot of thread items (`/api/sessions` returns records only), and reconnect uses `?since=lastSeq`, which is already past the gap. Any `session/created` or transcript event in the lost range is gone — busy sessions render permanently truncated, and a session whose `session/created` fell in the gap only recovers its *record* via the `api.sessions()` fallback (`store.svelte.ts:384-389`), never its history. This directly violates principle 2 ("reconnect = replay from sequence number") and DESIGN's own "journal growth × 20 sessions × weeks" concern.

**Fix:** have the WS handler drain in a loop until `since()` returns fewer than `limit` rows before attaching the live listener (guarding the join so no live event is missed/duplicated — the existing `seq <= lastSeq` client dedup covers overlap). Keep the SQL `LIMIT` for backpressure but page through it.

### H2 — Mesh exposure grants full hub control to every fleet device (device-token gap) **[known]**
**Severity:** High **Files:** `apps/hub/src/meshSite.ts` (whole module), `index.ts:53-71`, `server.ts:306-318`; DESIGN D13.1 ("STILL PENDING… the hub grants full control and today has NO auth").

When `MESH_EXPOSE=1`/`config.mesh.enable`, `meshSite.register()` advertises loopback `tcp:7777` as an AllMyStuff site. AllMyStuff same-owner devices need no grant (`authz.rs`: "your own devices need no grant"), so **every device on the fleet key** reaches the unauthenticated hub and inherits C1's full control (spawn `full`-mode agents, read all transcripts). This is the same root cause as C1 but across the mesh; DESIGN correctly defaults exposure OFF and flags the missing token. Listed separately because it is the deployment path DESIGN intends to eventually leave ON.

**Fix:** gate exposure behind the C1 device token; refuse to `register()` unless a token is configured (fail closed, not silently exposed).

### H3 — `POST /api/mesh {enable:true}` can flip mesh exposure ON with no auth
**Severity:** High **File:** `apps/hub/src/server.ts:312-318`.

The runtime mesh toggle is an unauthenticated route. Combined with C1, a drive-by page (or any fleet peer once briefly exposed) can `POST /api/mesh {"enable":true}` and turn the "opt-in, off by default" fleet exposure ON, then reach the hub from other devices. The one safety gate DESIGN relies on (exposure is a deliberate operator toggle) is itself unprotected.

**Fix:** require the device token (C1); treat enabling exposure as a privileged action.

---

## MEDIUM

### M1 — Codex `app-server` children are orphaned on standalone hub shutdown; no global kill-switch
**Severity:** Medium **Files:** `apps/hub/src/index.ts:76-88` (shutdown deregisters mesh, then `process.exit`), `apps/hub/src/adapters/codex.ts:221-223` (`stop()` exists but is never called), `sessions.ts` (no teardown-all).

`CodexClient` spawns one long-lived `codex app-server` child per profile. On `SIGINT`/`SIGTERM` the hub deregisters the mesh site and exits without killing those children. On Windows there is no job-object kill-on-parent-death (DESIGN D13 calls this out), so `codex app-server` processes linger as orphans after every standalone `pnpm hub:dev` stop/restart, accumulating. DESIGN D12's "global kill switch (SIGTERM all agent processes)" is not implemented. (Note: the Tauri desktop path is safe here — `kill_hub` uses `taskkill /T` on the whole tree, `lib.rs:87-99`. The leak is for the standalone/service hub.)

**Fix:** on shutdown, iterate all `CodexClient`s and call `stop()` (and interrupt/terminate Claude queries), then exit; add a PID file + startup orphan sweep as D13 specifies.

### M2 — Codex `app-server` crash mid-turn leaves sessions stuck `active` forever
**Severity:** Medium **Files:** `apps/hub/src/sessions.ts:106-118` (`onEvent` handles `codex/turn/completed` but not `codex/exited`), `adapters/codex.ts:120-127` (`exit` rejects pending + clears child).

If the app-server dies **after** `turn/start` has been acked (so there is no pending request to reject) but before `turn/completed`, nothing flips the session out of `active`. `codex/exited` is emitted but no handler maps it to a session status. The session shows "working" indefinitely; the UI thinking-timer runs forever. (Claude's equivalent is safe — a subprocess crash throws out of the `for await` loop and is caught in `runClaudeTurn`, `sessions.ts:233-238`.)

**Fix:** in the Codex event sink, on `codex/exited` mark every session mapped to that client `error` (or `idle`) and clear its `turnStartedAt`.

### M3 — Uncaught error in Codex `create()` leaves a zombie `starting` session
**Severity:** Medium **File:** `apps/hub/src/sessions.ts:207-219`.

The Codex branch of `create()` awaits `client.startThread(cwd)` with no try/catch. If it throws (app-server fails to spawn, `codex` not on PATH, handshake error), the record is already in the map + persisted as `starting` and `session/created` is already journaled. The exception propagates to a 500, but the session remains `starting` forever (only a hub reboot resets it via `boot()`), and it reappears in `/api/sessions`. The Claude branch does not have this problem because its turn runs fire-and-forget with internal catch.

**Fix:** wrap the Codex startup in try/catch; on failure set status `error`, journal `session/error`, and either remove the half-created session or leave it clearly errored.

### M4 — Worktree/branch naming uses an 8-char UUID prefix → collisions abort session creation
**Severity:** Medium **File:** `apps/hub/src/workspace.ts:22-28`.

`create()` derives both the worktree dir (`worktreesRoot/<short>`) and branch (`agent/<short>`) from `sessionId.slice(0, 8)`. Two sessions sharing an 8-hex-char prefix (birthday bound: ~50% collision near ~600 sessions over the hub's lifetime, and branches are never deleted on stop — only `worktree remove` + `prune`, so a stale `agent/<short>` branch collides even after its worktree is gone) make `git worktree add -b agent/<short> <target>` fail; the error propagates and session creation dies.

**Fix:** use the full session id (or a longer, collision-checked slice) for both the directory and branch; delete the branch on `stop()`/`delete()`.

### M5 — Worktree write-confinement is a soft guard, bypassed by Bash and by `full` mode
**Severity:** Medium **Files:** `apps/hub/src/sessions.ts:82-93` (`checkWriteScope`), `sessions.ts:148-158` (only path that calls it), `adapters/claude.ts:61-65` (`bypassPermissions`).

`checkWriteScope` only inspects `Write`/`Edit`/`NotebookEdit` tool names, so a Claude agent writing via `Bash` (`echo > ../outside`, `cp`, `git`, a script) escapes the worktree entirely. Worse, the guard lives inside the `canUseTool` callback, which the SDK does not invoke under `permissionMode: bypassPermissions` (the `full` mode this same code accepts) — so in `full` mode there is *no* confinement at all. The guard is useful defense-in-depth but should not be mistaken for a boundary. Codex sessions have no equivalent path check.

**Fix:** document it as advisory; for a real boundary, enforce at the OS/worktree level (sandbox cwd, restrict the agent's filesystem scope) rather than by tool-name string matching, and cover Bash/command tools.

### M6 — Journal redaction is best-effort with real gaps
**Severity:** Medium **File:** `apps/hub/src/redact.ts:1-15`.

Redaction is the single choke point for both storage and WS emit (good), but the patterns only catch fixed prefixes (`sk-`, `ghp_`, `AKIA`, JWTs) or secrets **immediately adjacent** to a known keyword. Opaque values slip through: a ChatGPT/Codex OAuth **refresh token** (not a JWT, no `sk-` prefix) pasted or echoed into a transcript, a secret separated from its label by a newline, base64 blobs, or `.env` contents surfaced by a tool result. The keyword lookbehind also stops at the first quote/space, so multiline or JSON-nested secrets are only partially masked. Given transcripts flow to every viewer over WS, gaps here are a disclosure risk.

**Fix:** add entropy-based scrubbing (flag long high-entropy tokens regardless of prefix), broaden keyword proximity across whitespace, and add explicit patterns for the vendor refresh-token shapes actually seen in `auth.json`/`.credentials.json`. DESIGN itself flags this as "nearly impossible to retrofit" — worth hardening now.

---

## LOW

### L1 — Codex has no concurrency guard on turns (Claude does)
`sessions.ts:282-287`: the Claude branch of `send()` throws if `driver.busy`, but the Codex branch calls `runCodexTurn` unconditionally. Two rapid `POST /api/sessions/:id/input` calls both hit `turn/start`; the app-server rejects the second, flipping the session to `error`. The UI hides this by routing Codex-while-active to `steer`, but the hub API is unguarded. Fix: track an active-turn flag per Codex thread and reject overlap with a clear error.

### L2 — Codex live-token indicator likely never fires (event-shape divergence)
`adapters/codex.ts:35-70` (`mapCodexTokenUsage`) and `store.svelte.ts:457-462` encode **different** assumptions about the same `codex/thread/tokenUsage/updated` payload. The store reads `payload.tokenUsage.last.inputTokens` / `.modelContextWindow`; `mapCodexTokenUsage` looks for numeric `inputTokens`/`input_tokens` directly under `payload.tokenUsage` (where `last` is an object, not a number), so it returns `undefined` and no normalized `session/tokens` is emitted for Codex — the "thinking · N tokens" counter stays blank for Codex turns while `contextUsed` still populates from the raw event. At most one assumption matches the real wire shape. Fix: verify against a journaled live payload (DESIGN says the raw event is kept for exactly this) and unify the two readers.

### L3 — Duplicate session across panes on drag / dropdown
`store.svelte.ts:645-664` (`dropAt`) and `:678-685` (`setPaneSession`) insert an id without removing its prior occurrence, and `Sidebar.svelte:178` lets you drag an already-open session. Result: the same session renders in two panes bound to one `SessionView` (harmless render-wise — keys differ — but not the intended one-session-per-pane model, and `closePane` then only removes one copy). Fix: dedupe on insert (remove the id from its old cell first), or explicitly allow-and-document mirroring.

### L4 — Every Claude `/usage` poll spends real tokens
`claudeUsage.ts:48-57` runs a full `query({prompt:'/usage'})` turn per Claude profile every 20 min (`usage.ts:13,176`). Each is a metered turn against the account (and runs with default cwd/permissions, no `canUseTool`). Low cost, but it is real spend + a real agent invocation purely for telemetry, multiplied by profile count. Fix: prefer a non-turn usage source if one exists, or lengthen the interval / make it on-demand.

### L5 — `usage.evaluate` journals an alert on every event under non-`block` policy
`usage.ts:107`: the alert condition `(!wasBlocked || policy !== 'block')` fires on *every* limited evaluation when policy is `warn`/`allow`, so a rate-limited profile under `warn` spams `usage/alert` on each incoming `rate_limit_event`. Also, recovery (limited→false) emits no journal event, so the UI only clears `blocked` on the next poll snapshot, not immediately. Fix: log the alert only on state transitions, and emit an explicit unblock event.

### L6 — Predictable temp script path + `-ExecutionPolicy Bypass` (local TOCTOU)
`native.ts:59-68` writes the folder-picker script to a **fixed** path `os.tmpdir()/aiagentapp-folderpick.ps1` and runs it with `-ExecutionPolicy Bypass`. (The login launcher `loginLauncher.ts:98` at least randomizes with `Date.now()`.) On a shared/multi-user host another local user could pre-create or swap that file between write and spawn. Single-user Windows risk is low, but the fixed name + Bypass is needless. Fix: use `fs.mkdtempSync` with a random dir (0700), or the Tauri native dialog already added in the desktop shell.

### L7 — Hub dependencies float on `latest`, contradicting DESIGN's pin-versions mitigation
`apps/hub/package.json:11-13` pins `@anthropic-ai/claude-agent-sdk`, `@anthropic-ai/claude-code`, and `@openai/codex` to `"latest"`. DESIGN §5 explicitly calls the app-server v1→v2 break an existing hazard and prescribes pinned versions + a conformance smoke test. `latest` means a reinstall can silently pull a breaking adapter protocol. Fix: pin exact versions and bump deliberately.

### L8 — `computeStats` full-scans the events table per dashboard load
`stats.ts:37-39` runs `SELECT … FROM events WHERE kind IN (…)` with no index on `kind` (the table only has the `seq` PK, `journal.ts:19`). Every `/api/stats` call (each Dashboard mount) scans the whole journal. Fine now, linear with journal growth. Fix: add an index on `kind` (or `(kind, ts)`), or maintain a rollup.

### L9 — `readBody` has no size limit
`server.ts:161-167` buffers the entire request body into memory before `JSON.parse`. Combined with the no-auth surface (C1), a local page could POST a huge body to exhaust memory. Low impact, easy cap. Fix: enforce a max body size and reject oversized requests.

---

## Looks correct / notable strengths

- **Event-sourcing core is disciplined.** `seq` is a SQLite `AUTOINCREMENT` PK (monotonic), `redact()` is applied once at the single `append()` choke point so **both** the persisted row and the WS-emitted event are scrubbed (`journal.ts:27-40`), and the replay/live join in the WS handler is synchronous with no `await` between `since()` and `on()`, so there is no boundary gap or duplicate (`server.ts:404-411`). The client's `seq <= lastSeq` dedup (`store.svelte.ts:361-363`) is genuinely more robust than id-based dedup and correctly handles reconnect overlap. (The only defect is the 2000-row cap, H1.)
- **Tombstone/delete consistency is right.** `delete()` stops the turn, writes a `session/deleted` tombstone (append-only preserved), drops in-memory maps, and removes the persisted snapshot so `boot()` won't resurrect it (`sessions.ts:334-349`, `store.ts:28-30`). The `persist()` guard (`sessions.ts:62-68`) correctly prevents a late-unwinding interrupted turn from resurrecting a deleted session.
- **`boot()` staleness reset** flips `active`/`starting` → `idle` on restart with a journaled `session/restored-stale` note (`sessions.ts:47-56`) — correct, since a mid-turn cannot be resumed.
- **meshSite is defensive by construction:** read-merge-write never clobbers other exposed ports, `deregister()` re-reads before deleting, it never spawns/forks a node, and an absent socket cleanly yields `nodePresent:false` without throwing (`meshSite.ts:161-198`). Framing matches the documented AllMyStuff wire protocol.
- **Desktop teardown** kills the whole hub process tree via `taskkill /T` on Windows, avoiding orphaned node/pnpm (`lib.rs:87-99`), and the Tauri capability allowlist is appropriately narrow (`capabilities/default.json`).
- **No `{@html}` anywhere in the web UI** — all transcript/tool content is auto-escaped by Svelte, so agent output cannot inject script even with the desktop shell's `csp: null`. (Enabling a CSP would still be good defense-in-depth.)
- **`EADDRINUSE` is handled** with a clear operator message and clean exit (`server.ts:414-420`), and the desktop shell probes the port before spawning a second hub (`lib.rs:25-30,43-45`).
- **Secrets hygiene in git:** `data/`, `profiles/`, `*.log`, and `.env` are all git-ignored (`.gitignore`), so the journal DB and vendor credential dirs stay out of the repo.
- **`checkWriteScope` path resolution** is correct where it applies — it resolves against `record.cwd`, lower-cases, and requires an exact match or a `root + sep` prefix, avoiding the `/root` vs `/rootother` prefix pitfall (`sessions.ts:87-92`). (Its limitation is coverage, M5, not correctness.)

## Known / intended items called out

- **C1/H2/H3 (no auth, ACAO `*`, mesh token gap):** DESIGN D12/D13.1 acknowledge the missing device token and default mesh exposure OFF. What is **not** acknowledged — and is the reason C1 is Critical rather than "known" — is that ACAO `*` + no auth is exploitable from an ordinary browser page against the loopback hub, independent of the mesh. The `server.ts:200-201` comment dismissing this is incorrect.
- **Account "port" seeds a full transcript across account boundaries** (`store.svelte.ts:222-240`) — intended per D14; note it means one account's conversation text is sent to another vendor/account as a prompt. Working as designed; flagged for awareness.
- **Same-worktree handoff ownership** (stopping a source session deletes a worktree a ported session may still share) is a documented v1 limitation (D14, "worktree OWNERSHIP transfer") — not re-counted above.
- **Windows worktree-cleanup file locks** (`workspace.ts:30-41` swallows `worktree remove` failures) is a DESIGN open question; the code degrades to `prune` best-effort, which is the reasonable interim.
