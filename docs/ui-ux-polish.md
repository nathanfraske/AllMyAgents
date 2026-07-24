# AllMyAgents — Interaction & UX Polish Backlog

A prioritized, concrete audit of the **interaction design & UX** of the `apps/web` frontend (Svelte 5 + Vite). Scope is the *how it feels to use* lane — flows, feedback, states, discoverability, keyboard, IA, consistency, a11y, onboarding. Pure visual aesthetics (palette, spacing, type) are covered by a separate pass and only touched here where they cross into usability (contrast, focus rings, motion).

Audited files: `App.svelte`, `app.css`, and everything in `apps/web/src/lib/` — `Sidebar`, `ThreadView`, `Dashboard`, `SettingsModal`, `ItemCard`, `AccountPicker`, `ModelPicker`, `PermissionPicker`, `TraitsControl`, `Usage`, `ContextMeter`, `ProviderLogo`, `Icon`, plus `store.svelte.ts`, `api.ts`, `settings.svelte.ts`, `catalog.ts`, `time.ts`. Benchmarked against the stated UI targets (t3code, ChatGPT Codex app) and Claude Code / Linear / VS Code conventions.

**Legend** — Impact: How much it moves the "polished & nice to use" needle. Effort: **S** ≈ hours, **M** ≈ a day, **L** ≈ multi-day. Each item cites the surface + file so it can be picked up cold.

---

## Priority snapshot (do these first)

| # | Item | Surface | Impact | Effort |
|---|------|---------|--------|--------|
| 1 | Optimistically echo the user's message on send; never clear the draft until it's safely rendered | Composer / thread | **High** | S–M |
| 2 | Render assistant markdown + code blocks (mono, wrapping, copy button) instead of raw text | Transcript | **High** | M–L |
| 3 | Chat titles + rename; stop showing N identical folder-name rows | Sidebar / IA | **High** | M |
| 4 | Global "attention" inbox — approvals/questions/errors across the whole fleet in one place | Approvals | **High** | M |
| 5 | Defuse the delete/stop/interrupt hover cluster (the flagged mis-click) | Sidebar rows | **High** | S |
| 6 | First-run guidance + a real "New chat"/"Add account" CTA on the dashboard | Onboarding | **High** | S–M |
| 7 | Offline/reconnect banner; disable send + preserve draft when the hub is unreachable | Connection state | **High** | S–M |
| 8 | ⌘K quick-switcher/command palette; autofocus composer on chat open | Keyboard | **High** | M |
| 9 | Accessibility floor: `:focus-visible` rings, `aria-live` on the stream + thinking, reduced-motion for status dots | A11y | **High** | M |
| 10 | Approval keyboard shortcuts (A/D), human-readable approval body, "always allow this session" | Approvals | **Med–High** | M |
| 11 | Live-ticking relative times + show *what* each agent is doing in the row (not just a dot) | Sidebar | **Med** | S–M |
| 12 | Composer auto-grow, IME-safe Enter, Escape closes pill menus | Composer | **Med** | S |

---

## A. First-run & onboarding

**A1 — Dashboard is a dead end with zero chats. [High / S–M]**
`Dashboard.svelte` hero says *"Drag a chat from the sidebar into this space to open it"* — but a brand-new user has **no chats to drag** and no button here to make one. The only entry points are the small `+` icons in the sidebar section header (`Sidebar.svelte` L134) and per-project. Add a primary action block on the dashboard: **New chat**, **Add account**, **Create project** — shown prominently when `sessionList.length === 0`. Why: the home screen should always offer the next step; today the first-run home actively misleads.

**A2 — "No accounts" opens Settings silently. [High / S]**
`store.newSession()` (`store.svelte.ts` L159-165): when there's no profile it flips `settingsOpen = true` with no explanation. The user clicks "new chat" and a Settings modal appears with no context. Add a one-line reason ("Add an account to start your first chat") and deep-link/scroll to the Accounts section. Why: silent context switches feel broken.

**A3 — No getting-started checklist / progress. [Med / M]**
There's no guided path (set name → add account → create project → first chat). Name capture exists (`Dashboard.svelte` L100-108) but is disconnected from the account/project steps. A dismissible checklist on the empty dashboard would turn a cold start into a guided one. Why: this is a multi-account/multi-project tool; the setup surface area is large and currently undocumented in-app.

**A4 — No in-app help or shortcut reference. [Med / S]**
Nothing surfaces keyboard shortcuts, the meaning of status colors, or steer-vs-queue. A `?` affordance (or a "Shortcuts" panel) would help. Why: the app has many novel concepts (reflex flag, ✦ reasoned, steer ⤵ vs queue ⏲, port-on-swap) that currently rely on hover tooltips only.

---

## B. Sidebar — fleet roster & information architecture

**B1 — Rows don't say what the agent is doing. [Med–High / M]**
Each row (`Sidebar.svelte` L173-192) shows: status dot, provider logo, **folder basename**, pending badge, relative time. For "what is every agent doing at a glance," that's state without substance. Add a second line or a truncated tail: last assistant snippet, current tool call, or +/- files touched (the "diff-first card" idea in DESIGN §10). Why: the roster is the fleet's situational-awareness surface; a dot + folder name doesn't answer "what did it just do?"

**B2 — Relative timestamps are frozen until an unrelated re-render. [Med / S]**
`relativeTime()` (`time.ts`) is computed at render; idle sessions never re-render, so "2m ago" can read "just now" long after. Add a shared 30–60s ticking `$state` clock the labels depend on. Why: stale times quietly erode trust in the whole status display.

**B3 — Can't tell which chats are on-screen in split view. [Med / S]**
`.row.sel` highlights only `selectedId` (pane 0,0). In a 3-pane layout the other two visible sessions get no sidebar indication. Mark every session currently mounted in a pane (a dot, an outline, or "on screen" chip). Why: VS Code/Linear always show which items are open; without it the sidebar and the workspace feel disconnected.

**B4 — No sort / no "needs me first". [Med / S–M]**
The list is always `lastActivity` desc (`store.sessionList`). You can't pull approvals/errors to the top. Add a sort control (activity / status / project) or at least float sessions needing attention. Why: with 20 agents, "who needs me" shouldn't require scanning every dot.

**B5 — Search is narrow and has no ⌘K / clear / count. [Med / S]**
Filter matches only `profileId cwd model` (`Sidebar.svelte` L71-72) — not titles (none exist) or transcript text. No keyboard shortcut to focus it, no clear button, no result count. Wire ⌘K/Ctrl-K to focus, add a clear affordance. Why: the UI target explicitly calls for a ⌘K search.

**B6 — Usage footer competes with the roster. [Med / M]**
The footer (`Sidebar.svelte` L202-208) can eat 42vh and scroll independently. With several accounts it crowds the session list. Per DESIGN §12, move usage to a dedicated sortable-by-headroom dashboard and keep only a compact summary in the footer. Why: two scrolling lists in one column is hard to scan.

**B7 — Collapsed-group summary glyphs are cryptic. [Low / S]**
The summary uses `▶ ⚑ ✓ ✕` (`Sidebar.svelte` L166-169) with `title`s. They read as noise until hovered. Use the same colored dots as the rows + a number, so the visual language is consistent between collapsed and expanded states. Why: consistency lowers the decode cost.

---

## C. Creating, switching & naming chats

**C1 — No chat names; every row in a project looks identical. [High / M]**
Labels are derived folder basenames (`Sidebar.svelte` L58-61). Five chats in one repo render five identical rows differentiated only by dot + time. Add auto-titles (first user message, summarized) with inline rename (double-click / right-click). Persist to the hub if possible. Why: this is the single biggest IA problem — you cannot tell your own chats apart.

**C2 — Spawn has no in-flight feedback. [Med / S]**
`newSession` guards double-spawn with `creating` (`store.svelte.ts` L155-166) but the `+` buttons show no disabled/spinner state, so a slow hub feels dead. Disable the trigger + show a spinner while `creating`. Why: a silent 1–2s gap after clicking "+" reads as a broken button.

**C3 — Selecting a sidebar chat silently replaces your primary pane. [Med / M]**
In split mode, `select()` (`store.svelte.ts` L564-573) overwrites pane (0,0). Clicking a chat to "peek" evicts whatever was there. Options: open into the *focused* pane, or offer "open here / open in new pane." Why: destructive-feeling navigation; the user loses their arrangement without intending to.

**C4 — Composer isn't focused when a chat opens. [Med / S]**
No `autofocus`/`focus()` anywhere (confirmed: zero matches). After select/new-chat the user must click the textarea. Focus it on mount/selection. Why: every chat UI (Claude, ChatGPT, Linear) puts the cursor in the input immediately.

**C5 — No restart/resume for a stopped session. [Med / M]**
A `stopped`/`error` session can only be deleted + re-created from the UI. Add "resume"/"restart" on stopped sessions. Why: stopping is easy to do (see I1); recovering from it shouldn't require rebuilding the chat.

---

## D. Composer — sending, steering, queueing

**D1 — The draft is destroyed on any send/steer error. [High / S]** *(also a bug — see Bugs)*
`send()` (`ThreadView.svelte` L86-108) does `text = ''` *before* awaiting `api.send`/`api.steer`, then only `alert()`s on failure. A network blip or a steer-after-turn-completed race silently eats the user's typed message. Keep the draft until success; restore it on error. Why: losing typed input is the most frustrating failure a chat box can have.

**D2 — No optimistic echo of the user's message. [High / S–M]** *(Claude side is a bug — see Bugs)*
`send()` performs no `store.push` of a `user` item, and `applyClaudeUser` (`store.svelte.ts` L516-528) only consumes `tool_result` — so **Claude prompts never appear as bubbles** (only Codex `userMessage` renders, L541). Push an optimistic `user` item on send (keyed so the vendor echo dedupes). Why: fixes the invisible-Claude-prompt bug, gives instant feedback, and makes D1 trivial (the message already lives in the thread).

**D3 — Composer is a fixed 2-row box, no auto-grow. [Med / S]**
`textarea rows="2"` (`ThreadView.svelte` L194) — long drafts scroll inside two lines. Auto-grow to a max height. Why: standard composer behavior; typing a paragraph in a 2-line peephole feels cramped.

**D4 — Enter sends during IME composition. [Med / S]** *(bug)*
`onKey` (L119-124) sends on `Enter && !shiftKey` without checking `e.isComposing` (confirmed: zero `isComposing` in the codebase). CJK/complex-script users lose the composition confirm to a premature send. Guard on `e.isComposing`/`keyCode 229`. Why: silently breaks input for a whole class of users.

**D5 — Steer vs queue vs send is only taught by one glyph. [Med / S]**
The button morphs ↑ / ⏲ / ⤵ and the placeholder changes (L194, L204). Good instinct, but a first-timer can't decode ⤵ vs ⏲. Add a tiny inline caption ("Codex will fold this into the running turn" / "Queues until this turn ends") near the composer when active. Why: two genuinely different behaviors hang off a single icon.

**D6 — Queue editing flattens multi-line messages. [Med / S]**
Queued rows use a single-line `<input>` (`ThreadView.svelte` L186). A queued multi-paragraph message becomes an un-editable one-liner. Use a small auto-grow textarea, or a "click to expand." Why: the queue is a real editing surface (edit/recall/auto-combine) but can't hold the content it queues.

**D7 — Model/effort pending-vs-active is invisible; permission is inconsistent. [Med / M]**
`ModelPicker`/`TraitsControl` write per-session local state applied *on next send* (`ThreadView.svelte` L79-84), while `PermissionPicker` calls `api.setMode` **immediately** (`PermissionPicker.svelte` L14-17). Meanwhile the header `.sub` still shows the *record's* old model (L148) while the pill shows the pending one. Unify the mental model: either all pending-until-send or all live, and reflect the pending choice in one place. Why: right now the header and the pill can disagree, and one pill changes things instantly while the others don't.

**D8 — No token/character ceiling cue. [Low / S]**
The estimate ("~Nk tokens next call") is nice but there's no signal when a draft is getting huge relative to the context window. Tint the estimate as it approaches the window. Why: cheap guard against blowing context in one message.

---

## E. Thread / transcript rendering

**E1 — Assistant text is raw, no markdown or code blocks. [High / M–L]**
`ItemCard.svelte` L22 renders `item.text` as `white-space: pre-wrap` plain text. For coding agents this is the core artifact — code arrives as unstyled prose with no mono, no fenced-block treatment, no copy button, no syntax highlight. Add a markdown renderer with fenced code blocks + per-block copy. Why: this is the biggest single gap versus Claude Code / ChatGPT / t3code; it's where the actual work lives.

**E2 — No copy anywhere. [Med–High / S]**
No copy on messages, code, or tool output. Add copy-on-hover for assistant messages and code blocks. Why: table-stakes for a coding tool.

**E3 — Long assistant messages never fold; no turn-folding. [Med / M]**
The clamp (`ItemCard.svelte` L8-10, L23-25) applies to **user** messages only; a 4,000-word assistant reply floods the thread. And a settled turn keeps all its tool spam expanded (DESIGN §11 "turn-folding" backlog). Add assistant "show more" and collapse-settled-turn-to-terminal-message. Why: long threads become unscannable walls.

**E4 — Tool I/O is raw JSON, truncated with no "more". [Med / M]**
Tool cards dump `JSON.stringify(input, null, 2)` and slice results at 2000 chars (`ItemCard.svelte` L44-45) with no expand. Format common tools (bash → the command; edit → file + diff), and add "show full output." Why: "what did it do" currently means reading pretty-printed JSON.

**E5 — No per-message timestamps. [Low / S]**
Items carry `ts` but ItemCard never shows it. Add a hover/subtle timestamp per message. Why: in long or resumed sessions, "when did this happen" matters.

**E6 — Stick-to-bottom has no "jump to latest" / new-message cue. [Med / S]**
`onScroll` unsticks past 60px (`ThreadView.svelte` L74-77); when you scroll up during streaming there's no indicator that content is arriving or a button to return. Add a "↓ new messages" pill when unstuck and streaming. Why: prevents "did it stop?" confusion while reading history.

**E7 — Reasoning/turn "anchor to top" mode missing. [Low / M]**
DESIGN §11 notes three scroll modes (follow-end / anchor-new-turn / free). Today it's naive stick-to-bottom. Anchoring a new turn to the top is a big readability win for long turns. Why: matches the target apps' reading ergonomics.

---

## F. Approvals & attention

**F1 — No global attention inbox. [High / M]**
Approvals render only inside the owning session's composer (`ThreadView.svelte` L170-179). A background session needing approval shows a sidebar badge + dot, but there's no aggregated "3 things need you" surface to triage from. DESIGN §10 calls this the actual working surface for a fleet. Build a header/inbox that lists pending approvals + questions + errors across all sessions with jump-to. Why: for many agents, hunting per-session for the amber dot doesn't scale.

**F2 — No approval keyboard shortcuts. [Med–High / S]**
Approve/Decline are click-only (L175-176). Add A = approve, D = decline (scoped to the focused/top approval), plus Enter on the primary. Why: DESIGN itself flags this as an easy win; approval triage is the highest-frequency fleet action.

**F3 — Approval body is unreadable JSON. [Med–High / S]**
`summarizeApproval` (`ThreadView.svelte` L126-130) shows `toolName + JSON.stringify(input).slice(0,200)` with `word-break: break-all`. The command/path you're approving is buried. Render tool name + key args as labeled fields (command, path, url). Why: you're being asked to authorize an action you can barely read.

**F4 — Only "Approve once" / "Decline". [Med / M]**
No "always allow this tool for this session" or "cancel the turn" (DESIGN §11 backlog). Needs hub support, but the UI affordance is the point — it converts approval fatigue into a rule. Why: repeatedly approving `pnpm test` is the top annoyance in agent tools.

**F5 — Auto-deny timeout is invisible. [Med / S]**
Approvals auto-deny after ~10 min (hub side); the UI shows no countdown, so a pending approval can silently vanish. Show a countdown/expiry on the card. Why: an approval disappearing with no trace looks like a bug.

**F6 — No system notification when a background agent needs you or finishes. [Med–High / M]**
Nothing pushes to the OS. For the "20 agents / phone" vision, completion + approval events should be able to raise a Web Notification (with permission). Why: ambient dots require you to be looking; a fleet tool needs to be able to tap you on the shoulder.

---

## G. Split view & multi-pane

**G1 — Resize handles are tiny and keyboard-inert. [Med / S–M]**
Handles are 5px (`App.svelte` styles L252-253) and `tabindex="-1"`. Widen the hit area (transparent padding around a thin visual line), add double-click-to-reset, and consider arrow-key resize when focused. Why: 5px targets are fiddly with a mouse and unusable without one.

**G2 — No max pane count / min size can make panes unusable. [Med / S]**
Drag enough chats in and each column shrinks toward the 0.25 flex floor (`App.svelte` L72-74) — headers overflow, composers wrap. Cap panes (e.g. 4) or enforce a pixel min with horizontal scroll. Why: it's easy to shatter the layout into unusable slivers.

**G3 — Panes can only be filled by sidebar drag or the `<select>`; you can't rearrange them. [Med / M]**
No drag between panes, no drag of a pane header. Add pane-to-pane drag + a "maximize/focus this pane" toggle. Why: once split, you're stuck with the arrangement you dropped.

**G4 — Narrow-pane header/footer overflow. [Med / S]**
The pane header (`ThreadView.svelte` L136-153) crams logo + session `<select>` + status chip + model + worktree + split + close; the composer `.cfoot` (L196-205) packs 4 pills + interrupt + stop + send with no `flex-wrap`. In a narrow pane these overflow/clip. Add wrapping/overflow menus for secondary controls. Why: split view's whole point is narrower panes — the chrome has to survive it.

**G5 — Touch has no split at all. [Med / M]**
Drag-to-split uses HTML5 DnD (`Sidebar.svelte` L177-179; `App.svelte` L142-177), which doesn't fire on touch. Given the mesh/phone ambition, provide a non-drag path (a "split with…" menu) even if phone is mostly view-only. Why: the primary layout mechanism is entirely mouse-only.

**G6 — `startSplit()` on a single session duplicates it. [Low / S]** *(edge bug)*
With one session, `startSplit` (`store.svelte.ts` L667-676) falls back to `flat[last]`, showing the same chat in both panes. Disable the split button (or show a picker) when there's nothing else to show. Why: splitting a chat against itself is confusing.

---

## H. Account swap / port

**H1 — Port uses native `confirm()`; no in-flight or result feedback. [Med / M]**
`AccountPicker.pick` (`AccountPicker.svelte` L12-22) fires a native `confirm()`, then `useAccount`/`portTo` (`store.svelte.ts` L191-240) spawns a new session with no "porting…" state and `alert()` on error. Replace with the app's own modal, show progress (transcript is being seeded), and land the user in the new chat with a confirmation. Why: porting is a heavy, multi-second operation dressed up as an instant menu pick.

**H2 — The ported-from chat becomes an unlabeled twin. [Med–High / M]**
After a port the original stays in the sidebar with the **same folder-name label**, now a "snapshot" — indistinguishable from its child. Mark ported/snapshot sessions (a badge, a link to the successor). Why: compounds C1 — you end up with two identical rows and no idea which is live.

**H3 — Swapping the model isn't the same gesture as swapping the account. [Low / S]**
Account swap ports/re-creates; model/effort swap is per-send; permission swap is live. Three different mental models for three adjacent pills. Document/align (see D7). Why: adjacent controls behaving differently is a consistency tax.

---

## I. Destructive actions & safety (the flagged mis-click)

**I1 — Delete sits in a 3-icon hover cluster that replaces the timestamp. [High / S]**
On row hover, `◼ interrupt`, `✕ stop`, `🗑 delete` appear exactly where the timestamp was (`Sidebar.svelte` L187-191; CSS L267-273 hides `.rtime`, shows `.ractions`). Three ~18px targets, two of them destructive, materializing under the cursor — this is the accidental-delete the user flagged. Fixes: (a) move **delete** out of the inline row into an overflow `⋯` menu; (b) keep run-controls (interrupt/stop) separate from lifecycle (delete); (c) enlarge hit targets and add spacing; (d) don't reflow the timestamp out from under the pointer. Why: the most dangerous action is currently the easiest to hit by accident.

**I2 — Interrupt and Stop have no confirmation and cryptic glyphs. [Med–High / S]**
`act()` (`Sidebar.svelte` L105-109) fires immediately; `◼` (interrupt) and `✕` (stop) are one pixel apart and easily confused, and `stop` ends the session + removes its worktree. Add a confirm (or an undo window) to `stop`, and label the actions with words/clear icons. Why: silently killing a running agent (and its worktree) on a mis-click is worse than the delete case, and it has *no* guard today.

**I3 — Destructive confirms use native `confirm()`/`alert()`. [Med / S]**
Delete (`Sidebar.svelte` L111-115) and port use `confirm()`; errors use `alert()`. These are unstyled, block the thread, and clash with the polished custom `SettingsModal`. Route them through one in-app confirm/toast component. Why: consistency + the ability to offer Undo instead of a blocking yes/no.

**I4 — No undo for delete. [Med / M]**
`deleteSession` is immediate and irreversible from the UI. Offer an "undo" toast (soft-delete window) for delete and stop. Why: the safety net best-in-class tools provide for exactly these actions.

---

## J. Settings & accounts

**J1 — Modal has no focus trap, focus-in, or focus-return. [Med / M]** *(a11y)*
`SettingsModal.svelte` has `role="dialog"`/`aria-modal` (L132) and Escape-to-close (L73-75), but focus isn't moved into the modal on open, Tab can leave it, and focus isn't returned to the gear on close. Add a focus trap + restore. Why: keyboard/SR users get lost behind the modal.

**J2 — Login long-poll has thin feedback and no cancel. [Med / M]**
`login()` (`SettingsModal.svelte` L44-71) can wait up to ~270s showing only "waiting…". No spinner, elapsed, or cancel. Add progress + a cancel, and surface the "terminal opened, finish sign-in there" step more clearly. Why: a 4.5-minute silent wait feels hung.

**J3 — Can't remove / log out an account. [Med / M]**
You can add + rescan (L36-40, L157-166) but there's no in-UI way to remove a mistaken or dead profile. Add a remove/log-out per account (with the move-never-copy caveats respected). Why: add-only account management strands mistakes.

**J4 — One long scroll, no section nav. [Low–Med / S]**
Accounts / Defaults / Composer / Usage / Mesh all stack in a 560px modal. Add a left rail or sticky section tabs. Why: findability as settings grow.

**J5 — Silent saves with no confirmation. [Low / S]**
Toggles save on change (`settings.svelte.ts`) with no acknowledgement. A subtle "saved" flick would reassure. Why: cheap confidence, especially for the budget/mesh toggles.

---

## K. Dashboard & usage

**K1 — Calendar + usage are hover-only (no keyboard/focus tooltip). [Med / S]** *(a11y)*
Day cells are `<button>`s (`Dashboard.svelte` L131-135) but the detail tooltip is driven by `onmouseenter/move/leave` only — keyboard focus shows nothing. Drive the day-detail panel from focus/selection too (it already pins on click — good). Why: the richest data view is mouse-gated.

**K2 — Dashboard is view-only; no actions. [Med / S]**
It reports (tiles, calendar, project bars) but you can't act — no "new chat in this project," no jump-to-session from a project row. Make project rows and tiles actionable. Why: a home screen should launch work, not just describe it.

**K3 — Usage bars lack headroom sorting / at-a-glance worst-case. [Med / M]**
`Usage.svelte` lists profile cards in store order. For "which account can take more work" you must eyeball every bar. Sort by headroom and highlight near-limit (DESIGN §12). Why: this data directly feeds the "where do I spawn next" decision.

**K4 — `resetIn` countdowns don't tick. [Low / S]**
Like B2, reset countdowns (`time.ts resetIn`) are render-time only. Tie to the shared clock. Why: "resets in 3h 55m" should count down.

---

## L. Feedback, loading, offline & errors

**L1 — Offline state is a single 8px dot. [High / S–M]**
`store.connected` drives one tiny dot in the brand bar (`Sidebar.svelte` L125; CSS L219-220). When the WS drops, the app shows stale data, the composer stays enabled, and a send while the hub is down rejects unhandled (draft already cleared — see D1). Add a visible "Reconnecting…" banner, disable/queue sends while down, and confirm on reconnect. Why: the entire UI is a live view over the hub; losing that connection must be loud, not an 8px hue change.

**L2 — Errors are native `alert()`s. [Med / S]**
`newSession`, `portTo`, `send`, `steer` all `alert()` on error (`store.svelte.ts` L182/239; `ThreadView.svelte` L96/107). Blocking, unstyled, and easy to miss twice. Replace with a toast system. Why: consistent, non-blocking error surface (and enables Undo/retry affordances).

**L3 — `api` never checks `res.ok`; non-JSON errors throw unhandled. [Med / S]** *(robustness)*
`jget`/`jpost` (`api.ts` L84-96) call `res.json()` regardless of status; a 500/HTML response throws a raw parse error with no user feedback. Check `res.ok`, surface a typed error. Why: turns silent failures into visible, recoverable ones.

**L4 — No initial load skeletons. [Low–Med / S]**
`store.init()` populates async; until then the sidebar is empty and the dashboard shows "loading…"/"—". A brief skeleton for the roster + tiles would smooth first paint. Why: empty-then-pop feels janky; skeletons read as "working."

**L5 — Completion is ambient-only and easy to miss. [Med / S]**
A finished turn just flips the status chip to green "completed" (`ThreadView.svelte` L147; `store.status`). For an off-screen session, combined with identical labels (C1), you can't tell *which* agent finished. Pair with F6 (notifications) and B1 (row substance). Why: "it's done" is a top-3 thing users look for and it's currently the quietest state.

---

## M. Keyboard & power-user

**M1 — No command palette / quick-switcher. [High / M]**
No ⌘K to jump between chats, run actions (new chat, split, settings), or search. The UI target explicitly wants ⌘K. Why: the fastest path through a many-session tool; also the natural home for actions that are otherwise buried.

**M2 — No global shortcuts. [Med / M]**
Nothing for new chat, next/prev chat, focus composer, toggle sidebar, open settings, close pane. Add a small set (and list them in A4). Why: power users live on the keyboard; agent-fleet operators doubly so.

**M3 — Sidebar list isn't arrow-navigable. [Med / M]** *(a11y + power)*
Rows are `role="button" tabindex="0"` (Enter selects) but no ↑/↓ to move between chats, and drag is mouse-only. Add roving-tabindex arrow navigation + a keyboard "open in pane" path. Why: Tab-through-every-row doesn't scale and DnD excludes keyboard users entirely.

**M4 — Escape doesn't close pill menus. [Med / S]**
`ModelPicker`/`AccountPicker`/`PermissionPicker`/`TraitsControl` close on scrim-click or re-click but ignore Escape (only `SettingsModal` handles it). Add Escape (and focus-return to the pill). Why: Escape-closes-the-thing-I-opened is a universal expectation.

**M5 — Menus aren't arrow/type-ahead navigable. [Med / M]** *(a11y)*
Pill menus are lists of `<button>`s with no arrow-key movement or type-ahead, and the model search only appears when >5 items (`ModelPicker.svelte` L31-33). Implement a menu/listbox pattern (roving focus, type-ahead). Why: picking a model/account should be keyboard-drivable.

---

## N. Accessibility

**N1 — Inconsistent, partly-removed focus indicators. [High / M]**
`app.css` L72 sets `outline: none` on inputs and only changes border-color on focus; buttons/rows rely on the default outline. There's no unified `:focus-visible` ring. Add a consistent, high-contrast `:focus-visible` outline across buttons, rows, pills, cells, and inputs. Why: keyboard users currently can't reliably see where they are.

**N2 — No live regions for streaming/thinking/status. [High / M]**
Confirmed zero `aria-live` in the app. Screen-reader users get no announcement when the agent starts thinking (`ThinkingView` dots, `ThreadView.svelte` L160-166), when responses stream in, or when status changes. Add `aria-live="polite"` to the stream + an SR-only "working / done" announcement. Why: without this the app is effectively opaque to SR users during the exact moments that matter.

**N3 — Status is color-only; dots carry only a `title`. [Med–High / S]**
Row status is a colored `.dot` with a `title` (`Sidebar.svelte` L182); titles aren't reliably announced and color alone fails colorblind users. Add SR-only text ("working", "needs approval") and a non-color cue. Why: state is the primary information in the roster and it's currently color-coded only.

**N4 — Status-dot pulse ignores reduced-motion. [Med / S]** *(bug)*
`.dot.working/.approval/.question { animation: pulse 1.8s infinite }` (`app.css` L81-84) sits **outside** any `prefers-reduced-motion` guard (the thinking dots in ThreadView are guarded; these aren't). Wrap them. Why: reduced-motion users still get perpetual pulsing — the setting is half-honored.

**N5 — Icon-only buttons rely on `title` for their name. [Med / S]**
Many buttons wrap an `aria-hidden` SVG and provide only `title` (e.g. sidebar mini actions, header split/close, brand). `title` is a weak, last-resort accessible name. Add explicit `aria-label`s. Why: several controls may expose an empty/ederived name to assistive tech.

**N6 — Low-contrast `--dim` text. [Med / S]** *(overlaps aesthetics)*
`--dim: #797987` on `--bg: #070711` is used for timestamps, counts, hints, and much secondary text; it likely falls below WCAG AA 4.5:1 for body-size text. Verify and lift where it fails. Why: a lot of genuinely useful metadata is hard to read.

**N7 — Drag-and-drop has no keyboard equivalent. [Med / M]**
The core split gesture is DnD-only (see G5/M3). Provide a keyboard/menu path to move a chat into a pane. Why: a primary workflow shouldn't be inaccessible.

---

## O. Consistency & misc affordances

**O1 — Mixed icon languages. [Med / M]**
Lucide icons (`Icon.svelte`) coexist with raw unicode glyphs everywhere: `◼ ✕ ▾ ▸ ⤵ ⏲ ↑ ⑂ ▣ ✦ ⚑ ▶ ×`. Unicode glyphs align/scale inconsistently and read as cryptic. Migrate the meaningful ones to the icon set. Why: a single icon vocabulary is a big, cheap polish win and improves scannability.

**O2 — Three+ "stop-like" concepts, four controls. [Med / S]**
`interrupt` and `stop` appear both in the sidebar (`◼`/`✕`) and the composer footer ("interrupt"/"stop") with no explanation of the difference (interrupt = current turn; stop = end session). Consolidate and label. Why: users can't predict which button kills what.

**O3 — Native `confirm/alert` vs custom modal (repeat of I3/H1/L2). [Med / S]**
One decision — adopt a single in-app confirm + toast layer — resolves the delete confirm, port confirm, and every `alert()`. Why: it's the same root inconsistency showing up in five places.

**O4 — Cryptic inline markers need consistent, discoverable explanation. [Low / S]**
`⑂ worktree`, `▣ worktree · id`, `✦ reasoned`, `reflex` tag — all novel, all explained only via `title`. Give them a consistent treatment (icon + tooltip, and a one-time legend via A4). Why: these are genuine differentiators; make them legible instead of mysterious.

**O5 — Menus open upward and can clip in a short pane. [Low / S]**
Pill menus anchor `bottom: 100%` (upward, correct for a bottom composer) but in a short/top pane can overflow above the viewport. Add basic flip/clamp. Why: an off-screen menu is an unusable menu.

---

## Bugs spotted

1. **Draft lost on send/steer error.** `ThreadView.send()` clears `text` before awaiting the request and only `alert()`s on failure — the message is gone (`ThreadView.svelte` L88-108). Also loses steer text on the common "turn already completed" race. → D1.
2. **Claude user prompts never render.** The only `user` item pushed is for Codex `userMessage` (`store.svelte.ts` L541); `applyClaudeUser` (L516-528) handles only `tool_result`, and `send()` does no optimistic insert. Confirmed by grep. So a Claude session shows the assistant reply with no visible record of what you asked. → D2. *(Verify against a live Claude turn; the optimistic-echo fix resolves it regardless.)*
3. **Reduced-motion not honored for status dots.** `.dot.working/.approval/.question` pulse animations are outside the `prefers-reduced-motion` guard (`app.css` L81-84). → N4.
4. **Enter sends mid-IME-composition.** `onKey` doesn't check `e.isComposing` (`ThreadView.svelte` L119-124). → D4.
5. **Relative times & reset countdowns are frozen.** `relativeTime`/`resetIn` are render-time pure functions with no ticking source (`time.ts`), so idle rows show stale ages. → B2/K4.
6. **`res.ok` never checked.** `api.jget/jpost` parse JSON on any status; a non-JSON error response throws unhandled (`api.ts` L84-96). → L3.
7. **Unhandled rejections on network failure.** `newSession`/`portTo`/`send`/`steer` assume `{error}` shapes; a thrown fetch (hub down) rejects with no user feedback (and, per bug 1, after clearing the draft). → L1/L2.
8. **`startSplit()` duplicates the sole session** into two panes when there's nothing else to show (`store.svelte.ts` L667-676). → G6.
9. **Split-mode select silently evicts pane (0,0)** (`store.svelte.ts` L564-573) — data isn't lost but the user's layout is, with no cue. → C3.
10. **Settings modal focus not trapped/returned** (`SettingsModal.svelte`) — Tab escapes behind the modal; focus never enters or returns. → J1.
11. **Empty-sidebar copy references a stale glyph.** "create a project (⊞)" (`Sidebar.svelte` L198) — the button is now a lucide `folder-plus`, not `⊞`. Cosmetic drift. 
12. **Dead CSS.** `.hbtn` and `.mode` rules in `ThreadView.svelte` (L234-236, L274) have no matching markup — harmless, worth a sweep.

---

## Quick wins (high value / low effort)

- Optimistic user echo + keep the draft on error (D1/D2) — fixes the invisible-Claude-prompt bug *and* the lost-draft bug in one change.
- Move **delete** into an overflow menu and add a `stop` confirm (I1/I2) — directly addresses the flagged mis-click.
- Autofocus the composer on chat open (C4).
- Escape closes pill menus (M4); guard Enter on `isComposing` (D4).
- Wrap the status-dot pulse in `prefers-reduced-motion` (N4).
- A shared ticking clock for relative times / reset countdowns (B2/K4).
- A `:focus-visible` ring in `app.css` (N1) and `aria-label`s on icon-only buttons (N5).
- Reconnect banner + disable-send-while-offline (L1).
- Dashboard "New chat / Add account" CTA when the fleet is empty (A1).

---

## What's already strong (keep it)

Worth preserving as the polish continues — these already meet or beat the target apps:

- **Thinking indicator** with live elapsed timer + streaming token count (`ThreadView.svelte` L160-166) — genuinely best-in-class.
- **Drag-to-split with frozen geometry** to kill jitter (`App.svelte` L110-169) — a thoughtful fix most implementations get wrong.
- **Inline approvals in the composer** (t3code-style) rather than a modal.
- **Message queue** with edit / recall / auto-combine and clear "sends when the turn finishes" copy.
- **Steer (⤵) vs queue (⏲)** as distinct, provider-aware send modes — ahead of the reference apps.
- **Collapsed-group summaries**, **context-window ring**, **reflex flag**, and **✦ reasoned** marker — real differentiators.
- **Optimistic new-session nav** and `noteSent` immediate feedback.
- **Reduced-motion coverage** across most components (just close the status-dot gap).
- **Event-replay reconnect** (`since=lastSeq`) — the reliability backbone; the UI just needs to *show* the connection state (L1).
