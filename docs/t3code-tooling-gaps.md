# T3Code agent-facing tooling — what it injects, and the AllMyAgents gap list

Research + gap analysis, drafted 2026-07-24. **Analysis only — no code changed; one markdown file.** This
answers the operator's standing rule ("pull from t3code first," see the memory index) for **one specific axis**:
what *tooling* T3Code (`github.com/pingdotgg/t3code`, by Theo/ping.gg) hands the coding agents it hosts — tools,
MCP servers, skills, prompt templates, workflows, slash commands, automation harnesses, protocols — that those
agents would **not** get automatically from their own vendor CLI/SDK harness (Claude Code SDK / `codex
app-server`). Then it maps those against what AllMyAgents already has (built or designed) and produces a
**prioritized gap list with implementation sketches**.

It is grounded in the current code — `apps/hub/src/agentTools.ts` (the in-process MCP toolkit via
`buildAgentMcpServer`), `sessions.ts` (create/materialize/`canUseTool`/`deliverBus`/worktree wiring),
`workspace.ts` (`WorkspaceManager` — worktree only), `instructions.ts` / `practices.ts` / `memory.ts` (the
scoped, agent-writable stores), `approvals.ts` (`ApprovalService.request` — the operator gate),
`apps/web/src/lib/{DiffView.svelte,diff.ts,store.svelte.ts}` — and it builds on the direction already set in
`docs/inter-agent-comms.md`, `docs/memory-system.md`, `docs/tool-affordance.md`,
`docs/agent-native-tools.md` / `docs/emulated-agent-tools.md`, `docs/practices-hooks-gating.md`, and
`docs/agent-visualization.md`.

---

## 0. Verdict (read this first)

**The honest headline: T3Code's *agent-facing* surface is narrower than its reputation suggests, and AllMyAgents
already leads it on "agent superpowers."** T3Code is, at its core, a **GUI + git-workflow orchestrator** around
the *same* two programmatic surfaces AllMyAgents drives (Claude Agent SDK, `codex app-server`). Almost everything
it "provides" falls into three buckets:

1. **Vendor-native features it surfaces in a nice UI** (skills, slash commands, plan mode, MCP config, reasoning
   effort) — the agent already gets these from its CLI/SDK; T3Code adds discovery/ergonomics, not new agent
   powers.
2. **Hub-level git-lifecycle automation** the vendor CLI does *not* do for you — git-worktree-per-thread,
   per-turn diff review, checkpoint/rollback, one-click commit→push→PR — but these are *operator* affordances
   around the agent, not tools injected *into* the agent's tool namespace.
3. **One genuinely novel agent-facing loop: the review-comment → agent feedback cycle** — the operator leaves
   GitHub-PR-style inline comments on the agent's per-turn diff, they feed back into the thread, and open/resolved
   state is tracked. This is the single most "pull-worthy" agent-facing idea in T3Code. Notably, T3Code's plan to
   expose it to *external* agents **as an MCP server** (issue #345) was **closed as *not planned*** — so even
   T3Code never shipped the MCP-tool form. **AllMyAgents can leapfrog here.**

**What T3Code does NOT give its agents (and AllMyAgents already has, built or designed):** an inter-agent message
bus, scoped cross-vendor/cross-account memory, agent-writable practices, a hooks registry, browser/computer
control, native-visualization capture, automatic memory recall, the semi-trusted-teammate trust model. On these,
AllMyAgents is **ahead** — do not spend effort chasing parity that already exists.

**So the real gaps cluster in exactly one place: the git-lifecycle + review workflow.** The prioritized list (§3)
is dominated by it: **review-comment loop (P0)**, **per-turn changed-files diff + checkpoint/rollback (P0/P1)**,
**hub-owned commit/PR workflow (P1)**, **plan-then-execute gate (P1)**, **quick-actions/project-scripts (P1)**,
then the lower-value **skills/slash-command curation (P2)** and **outward-facing hub MCP server (P2)**.

---

## 1. Confirmed T3Code tooling (found in docs / site / repo / changelog)

Each row: what it is, whether it is *agent-facing* (a tool/context the model consumes) vs *operator-facing* (a UI
affordance around the agent), and whether the agent already gets the equivalent from its vendor harness.

| # | Feature | Agent- or operator-facing? | Already in the vendor CLI/SDK? | Confidence |
|---|---|---|---|---|
| C1 | **Review-comment → agent feedback loop.** Operator reviews the local diff in a Git UI, leaves targeted inline comments (GitHub-PR style) *or* thread-level comments with **open/resolved** status; comments are **sent into the active agent thread**; the agent responds + makes follow-up edits; the operator resolves (or the system auto-suggests resolution when the relevant code changed). Persisted as **`feedback.json`** (machine), **`feedback.md`** (human), **`resolved.json`** (progress). | **Agent-facing** (feedback becomes turn input / worktree files) | ❌ No — neither CLI has a structured diff-comment loop | **Confirmed** |
| C2 | **Review-as-MCP-server (external agent access).** A lightweight MCP server exposing *reviews, thread context, diffs, file paths* as tools so any MCP-compatible agent can "see open review comments, read surrounding context, fix the code, mark reviews resolved." | Agent-facing (protocol) | ❌ No | **Confirmed *designed*, `#345` closed as NOT PLANNED** — never shipped |
| C3 | **Per-turn diff viewer.** Review the agent's changes turn-by-turn; **unified + split** views; **collapse-all** for large diffs (large diffs collapse by default). | Operator-facing | ⚠️ Partial (CLI shows diffs inline; no per-turn tree) | **Confirmed** |
| C4 | **Git-worktree-per-thread.** Each thread maps to its own worktree + branch; T3Code runs the underlying git. | Operator-facing (isolation) | ❌ No (CLI runs in cwd) | **Confirmed** |
| C5 | **Checkpointing + rollback.** "Built-in checkpointing and worktree support"; restore prior states. | Operator-facing | ❌ No | **Confirmed** |
| C6 | **One-click Git/PR workflow.** "Commit, Push, & Create PR" chains **auto-generated commit message** → push → open PR with **pre-filled title/body**. | Operator-facing | ❌ No (agent can `git`/`gh` via shell, but no chained button) | **Confirmed** |
| C7 | **Runtime modes: Full Access vs Supervised.** Approval policies + sandbox modes + security controls. | Both | ✅ Yes (maps to permission/approval modes) | **Confirmed** |
| C8 | **Chat vs Plan mode + reasoning level.** Plan mode makes the agent inspect the codebase and produce a full step-by-step plan before coding; adjustable reasoning depth. | Agent-facing (prompt/mode) | ✅ Yes (Claude `plan` permissionMode; Codex review; effort) — surfaced | **Confirmed** |
| C9 | **Quick Actions / Project Scripts.** Project-scoped shell-command buttons, run on demand, **optional keybindings**, **optional auto-run on worktree creation**. | Both (operator button; can seed the worktree) | ❌ No | **Confirmed** |
| C10 | **Integrated terminal.** Built-in shell for linters/formatters/build alongside the agent. | Operator-facing | n/a | **Confirmed** |
| C11 | **Skills discoverable via the composer `$` picker** + T3Code ships its own skills (e.g. `test-t3-app`, `test-t3-mobile` verification skills in its repo AGENTS.md). | Agent-facing (skills) | ✅ Yes — Claude Code skills are a CLI/SDK feature; `$` picker just surfaces them | **Confirmed** (surfacing) |
| C12 | **Slash commands / custom commands** (markdown → command; frontmatter for model/allowed-tools), surfaced in the composer. | Agent-facing | ✅ Yes — vendor feature; SDK reports available slash commands in the init message | **Confirmed** (surfacing) |
| C13 | **Multi-provider breadth.** Codex, Claude Code, Cursor, OpenCode, Gemini behind one provider-adapter SPI + model selector. | Both | n/a | **Confirmed** |
| C14 | **Event-sourced orchestration + WebSocket protocol.** Effect-schema events/commands/domain models; orchestration API for projects/threads/sessions; persistent thread state, snoozing, settled-state restore. | Infra | n/a (AllMyAgents has its own event-sourced journal) | **Confirmed** |

**Reading of the table.** Only **C1, C2, C8, C11, C12** are *agent-facing*, and of those, **C8/C11/C12 are
vendor-native** (T3Code surfaces, doesn't inject). That leaves exactly **two** agent-facing things T3Code adds on
top of the vendor harness: **the review-feedback loop (C1)** and **its unshipped MCP form (C2)**. Everything else
worth copying (C3–C6, C9) is **operator-facing git-lifecycle tooling** — valuable, but a hub/UI concern, not a
tool in the model's namespace.

---

## 2. Inferred / plausible (not directly confirmed in public docs)

Labeled clearly as inference — reason-from-first-principles about what a T3-style hub plausibly does, or what the
project memory hints at but I could not confirm on the site.

- **I1 — MCP passthrough / "MCP toolkit registration" for hosted agents.** The project memory's harvest list names
  *"MCP toolkit registration"* as a T3Code pattern. It is plausible T3Code lets a user attach MCP servers to a
  hosted Claude/Codex session (Claude `options.mcpServers`; Codex `config.toml [mcp_servers]`) and registers them
  per provider. **I could not confirm a dedicated MCP-management UI on the site.** *Inference: likely inherits
  whatever MCP servers the user configured in their vendor setup, possibly with light registration glue.*
- **I2 — Prompt/system-context injection into hosted sessions.** Any hub that owns the process can prepend context
  (repo facts, house rules) the way T3Code's own `AGENTS.md` shapes its contributor agents. Whether T3Code
  *materializes* hub-managed context into hosted sessions' `CLAUDE.md`/`AGENTS.md` (the way AllMyAgents does with
  instructions/practices/memory) is **not documented**. *Inference: minimal — T3Code leans on the repo's own
  `AGENTS.md`/`CLAUDE.md` rather than injecting a hub-managed block.*
- **I3 — Auto-resolution intelligence in the review loop.** The confirmed behavior ("system suggests resolution
  when the relevant code changed") implies a **diff-diff matcher** (did the follow-up edit touch the commented
  span?). *Inference: a hunk-overlap heuristic, not a model call.*
- **I4 — No inter-agent collaboration surface.** Nothing in T3Code's docs describes agent-to-agent messaging, a
  shared task board, or an orchestrator/brains role across *sessions*. Its "orchestration" is the hub managing
  threads, not agents coordinating. *Inference (high confidence): T3Code has no bus/commons equivalent — this is
  an AllMyAgents differentiator, not a gap.*
- **I5 — No native computer/browser/visualization tooling for agents.** Absent from all docs/changelog. *Inference
  (high confidence): T3Code does not emulate the vendors' app-only computer/browser/artifact features — the exact
  space `docs/agent-native-tools.md` / `docs/emulated-agent-tools.md` already stake out. Not a gap; a lead.*

---

## 3. Prioritized gap list for AllMyAgents (with implementation sketches)

Scope: **only what AllMyAgents is genuinely missing that T3Code demonstrates the value of.** Each gap names the
mechanism per the operator's menu — *in-process MCP tool via `buildAgentMcpServer`? a worker→hub relay? a skill? a
hub-owned workflow? a protocol?* — and grounds it in real files. Ordered by value × confidence × leverage.

| Rank | Gap | T3Code source | Mechanism | Confidence | Effort |
|---|---|---|---|---|---|
| **G1** | **Review-comment → agent feedback loop** | C1 (shipped) | Hub-owned workflow **+** in-process MCP tools **+** worktree files | Confirmed | M |
| **G2** | **Per-turn changed-files diff + checkpoint/rollback** | C3, C5 | Hub-owned workflow (git) + UI; optional agent tools | Confirmed | M |
| **G3** | **Hub-owned commit / push / PR workflow** | C6 | Hub-owned workflow + UI; optional in-process tools | Confirmed | S–M |
| **G4** | **Plan-then-execute gate (workflow)** | C8 | Hub-owned workflow over vendor-native plan mode | Confirmed | S–M |
| **G5** | **Quick actions / project scripts** | C9 | Per-project store + UI; optional in-process tool; ties to hooks | Confirmed | S |
| **G6** | **Skill / slash-command / prompt-template curation + `$` discovery** | C11, C12 | Skills-on-disk + composer picker (SDK init message) | Confirmed | S–M |
| **G7** | **Outward-facing hub MCP server** (expose sessions/threads/diffs/reviews to external agents) | C2 (unshipped) | Protocol (a real MCP server process) | Confirmed-as-concept | M |
| **G8** | **Per-session MCP-server management UI (passthrough)** | I1 | Config surface + capability gate | Inferred | S |

Below, each in detail.

### G1 — Review-comment → agent feedback loop  *(P0 — the headline gap; AllMyAgents can leapfrog)*

**What it is.** The operator reviews a session's diff, drops **inline comments anchored to file+line-range** (and
thread-level comments), each with **open/resolved** status; the hub **delivers the open comments into the session
as an injected turn** and **materializes them into the worktree** as `feedback.md` (human) / `feedback.json`
(machine); the agent edits; the hub **auto-suggests resolution** when the follow-up diff touched the commented
span; the operator confirms resolve. This is a *structured, addressable, stateful* review channel — strictly
richer than today's binary approve/deny.

**Why valuable.** It is the tightest human-in-the-loop refinement loop in the whole space and the one thing
T3Code does that the vendor CLIs don't. It converts "review friction" into a first-class, auditable, resumable
artifact. And because T3Code's *MCP* form (C2/#345) was never shipped, doing it well puts AllMyAgents ahead of the
reference.

**Confidence:** Confirmed (the loop is shipped in T3Code; the file names `feedback.json`/`feedback.md`/
`resolved.json` and the "sent into the active thread" behavior are documented).

**Mechanism — a hub-owned workflow + in-process MCP tools + worktree files** (all three, composed):

1. **`ReviewStore` (new `apps/hub/src/reviews.ts`),** modeled on `PracticeStore`/`MemoryStore` (scoped rows,
   journal-backed provenance). A `ReviewComment { id, sessionId, turnSeq, filePath, lineStart, lineEnd,
   anchorHunkSha, body, author:'operator'|'agent', status:'open'|'resolved', createdAt, resolvedAt }`. Table +
   `review/*` journal kinds (`review/commented`, `review/delivered`, `review/resolved`, `review/reopened`) so it
   rides the one replayable `seq` and `redact()` choke point like every other event.
2. **Delivery = a hub-injected turn, reusing the bus plumbing.** `deliverBus` (`sessions.ts`) already knows how to
   frame text, clamp permission mode, and inject a turn on idle. Add a sibling `deliverReview(record,
   openComments)` that frames the open comments (path+line+body) and injects them — **exactly the same clamp +
   provenance discipline** as bus messages (`docs/inter-agent-comms.md` §3.3). Operator-authored, so it is *not* a
   bus turn (no hard-deny), but it still runs at a live approval gate.
3. **Worktree materialization** for agents that read files rather than turn text: write `feedback.md` /
   `feedback.json` into the session worktree on each new/changed comment (path-fenced by the existing
   `checkWriteScope` containment). This mirrors T3Code's own storage and gives the agent a durable, re-readable
   surface.
4. **In-process MCP tools** in `buildAgentMcpServer` (`agentTools.ts`), so the agent can *pull* and *close the
   loop* itself — the affordance T3Code's #345 wanted but never shipped:
   - `review_list()` → open comments for this session (path, line, body, id). Safe → auto-allow.
   - `review_read({ id })` → one comment + surrounding diff context. Safe → auto-allow.
   - `review_resolve({ id, note? })` → mark resolved after addressing it. Low-risk (operator can reopen); record
     provenance, journal `review/resolved`. Optionally self-gated behind the operator per §G-note below.
   Descriptions phrased as the *need*, per `docs/tool-affordance.md` (e.g. *"List the open review comments the
   operator left on your changes — address each, then mark it resolved."*).
5. **Auto-suggest resolution (I3).** On the next turn's diff, compare changed hunks against each open comment's
   `anchorHunkSha`/line-range; overlapping → surface a one-click "resolve?" to the operator (no model call).
6. **UI.** Reuse `DiffView.svelte` + `diff.ts` (already present) for the per-turn diff; add a comment gutter and
   an "open reviews" rail; render `review/*` in `store.svelte.ts` as a distinct `ItemKind:'review'` card
   (mirroring the planned `agent-message` card in `docs/agent-visualization.md` §6).

**Grounding:** `agentTools.ts` (tool shape + identity binding + self-gate), `sessions.ts`
(`deliverBus`/`checkWriteScope`/materialize), `approvals.ts` (the gate), `apps/web/src/lib/DiffView.svelte` +
`diff.ts` (diff render), `store.svelte.ts` (`ItemKind`, `apply()`).

**Note on trust:** operator review comments are *operator authority* (unlike semi-trusted bus messages), so
`review_*` need no bus-hard-deny — but `review_resolve` should still be honest that the operator can reopen, and
the injected review turn keeps the standard clamp so an *embedded* instruction in a comment body can't escalate
permissions.

### G2 — Per-turn changed-files diff + checkpoint / rollback  *(P0/P1)*

**What it is.** (a) A per-turn **changed-files tree** with unified/split diff + collapse-all (C3), and (b) a
**checkpoint per turn** with **one-click rollback** (C5). AllMyAgents has the diff *primitives* (`DiffView.svelte`,
`diff.ts`) and **worktree isolation** (`workspace.ts`), but `workspace.ts` does **no commits** — there is no
per-turn snapshot, no changed-files projection, no rollback.

**Why valuable.** Checkpoints are the safety net that makes *autonomous* / `full`-mode runs sane: a bad turn is
one click to undo. The changed-files tree is the review surface G1's comments anchor to. This is also already on
the roadmap (project memory: *"session-stamped commits," "checkpoints/rollback SCOPED in DESIGN.md §12"*).

**Confidence:** Confirmed.

**Mechanism — hub-owned git workflow + UI (optionally a thin agent tool):**

1. **Checkpoint = an auto-commit in the session worktree at each turn boundary.** Extend `WorkspaceManager`
   (`workspace.ts`) with `checkpoint(worktree, label)` → `git add -A && git commit -m "<session> turn <seq>"` (or
   `git stash create` for a non-branch-polluting snapshot). Call it from `runClaudeTurn`/`runCodexTurn`
   (`sessions.ts`) on turn completion; journal `session/checkpoint { seq, sha }`. "Session-stamped commits" from
   the memory backlog lands here.
2. **Changed-files projection.** `WorkspaceManager.changedFiles(worktree, sinceSha)` → `git diff --numstat` →
   `[{ path, added, removed }]`; emit `session/diff { turnSeq, files }`. The web store gains a changed-files rail
   built from it (reusing `DiffView`/`diff.ts` per file), with collapse-all (T3Code's own recent changelog item).
3. **Rollback.** A hub route `POST /api/sessions/:id/rollback { toSha }` (origin+token guarded like every route,
   `server.ts`) → `git reset --hard <sha>` in the worktree; journal `session/rolled-back`. Surface as a per-turn
   "revert to here" control. *Optionally* expose `checkpoint()` / `revert_to_checkpoint()` as in-process tools so
   an agent can snapshot before a risky refactor — but rollback is destructive, so gate it (self-gate via
   `requireApproval`, and hard-deny on bus turns) exactly like the practices/hooks tiers in
   `docs/practices-hooks-gating.md`.

**Grounding:** `workspace.ts` (add commit/diff/reset), `sessions.ts` (turn boundaries), `server.ts` (routes),
`DiffView.svelte`/`diff.ts` + `store.svelte.ts` (UI).

### G3 — Hub-owned commit / push / PR workflow  *(P1)*

**What it is.** T3Code's "Commit, Push, & Create PR" button: **auto-generated commit message**, push the session
branch, open a PR with **pre-filled title/body** (C6). Today AllMyAgents agents do git via `Bash`; there is no
hub-owned lifecycle and no PR affordance.

**Why valuable.** Closes the loop from "agent worked in a worktree/branch" to "merged change" without the operator
dropping to a terminal — the payoff of the per-session branch `workspace.ts` already creates (`agent/<short>`).

**Confidence:** Confirmed (T3Code). *Partially redundant* with agent shell access, hence P1 not P0.

**Mechanism — hub-owned workflow + UI; optional in-process tools:**

1. **Hub git service** on `WorkspaceManager`: `commit(worktree, msg)`, `push(worktree)`, `openPr(worktree, {title,
   body})` via `gh pr create` (the `gh` CLI is the sanctioned GitHub path in this environment). Chain them behind
   one route `POST /api/sessions/:id/ship`.
2. **Auto commit message + PR body** = one *cheap-model* call over the turn's diff/journal tail — the same
   "small-model, off the main agent's dime" pattern `docs/memory-system.md` §8 uses for capture. Keeps the
   expensive session out of the loop.
3. **Composer button** (matches the UI-target memory's "checkout strip"): a ship control on the worktree strip;
   confirm-before-push. Because opening a PR is *publishing*, treat it as an explicit operator action (a button),
   **not** an auto-approved agent tool. If exposed to the agent at all, `open_pr` self-gates via `requireApproval`
   and is bus-hard-denied.

**Grounding:** `workspace.ts` (git ops), `server.ts` (route), composer/`ThreadView.svelte` (button); cheap-model
call pattern from `memory-system.md` §8.

### G4 — Plan-then-execute gate  *(P1)*

**What it is.** T3Code's Plan mode: the agent inspects the codebase and emits a **step-by-step plan before
coding**, with a reasoning-level control (C8). AllMyAgents wires effort/thinking already, but has **no
plan-approval gate** — the plan-then-execute workflow lives only in the *design* (`docs/agent-visualization.md`
§3/§10 "plan-then-execute gate").

**Why valuable.** For big/dangerous changes, a reviewed plan is the cheapest way to catch a wrong approach before
edits happen. It also *feeds the Run view* already designed in `agent-visualization.md` (the approved plan's steps
become phases).

**Confidence:** Confirmed concept; **mostly vendor-native** (Claude `permissionMode:'plan'`, Codex review), so
this is a *thin hub workflow over an existing capability*, not new agent power.

**Mechanism — hub-owned workflow over vendor-native plan mode:**

1. Add a `plan` session mode (Claude → `permissionMode:'plan'` in `adapters/claude.ts`; Codex → review/no-write).
   The plan comes back as assistant text (or an `ExitPlanMode`-style tool call).
2. **Gate execution on operator approval of the plan**: on plan completion, journal `workflow/plan { phases }`
   (the exact event `agent-visualization.md` §8 defines), hold the session, and require an operator "approve plan"
   (reuse `ApprovalService.request`) before switching to `edits`/`full` and running.
3. Render the plan + phase progress via the **Run view** already specified in `docs/agent-visualization.md` §3 —
   this gap and that doc are the same workflow from two ends.

**Grounding:** `adapters/claude.ts` (mode mapping), `sessions.ts` (gate + mode switch), `approvals.ts`,
`agent-visualization.md` §3/§8 (Run view + `workflow/plan`).

### G5 — Quick actions / project scripts  *(P1)*

**What it is.** Project-scoped shell-command buttons (lint/format/build/test), runnable on demand, with optional
keybindings and **optional auto-run on worktree creation** (C9). AllMyAgents has none; the closest is the *hooks
registry* designed in `docs/practices-hooks-gating.md` (not built).

**Why valuable.** One-click repeatable project ops next to the agent, and "auto-run on worktree creation" is a
clean seed step (e.g. `pnpm install`) — the low-risk, high-utility slice of the hooks idea.

**Confidence:** Confirmed.

**Mechanism — per-project store + UI; optional in-process tool; convergent with hooks:**

1. **`ProjectScript { id, projectId, label, command, runOnSpawn?, keybinding? }`** — a small per-project store
   (sibling of `ProjectStore` in `projects.ts`), operator-authored (no agent-write — these are executable, so they
   sit at the hooks tier of `practices-hooks-gating.md` §5). Routes under `/api/projects/:id/scripts`.
2. **`runOnSpawn`** hooks into `SessionManager.create()` right after `WorkspaceManager.create()` — run the seed
   command in the fresh worktree (hub-mediated, output journaled, timeout) — the safe subset of the hooks design's
   "execute via the hub's dispatcher," per `practices-hooks-gating.md` §3.4/§3.6.
3. **UI:** buttons on the project/worktree strip; keybindings.
4. **Optional agent tool** `run_project_script({ id })` in `buildAgentMcpServer` so the agent can invoke the
   *pre-approved* project scripts (but not arbitrary shell) — a nice constrained-execution affordance; since it
   runs code, it self-gates / is bus-hard-denied like the other executable tools.

**Grounding:** `projects.ts` (sibling store), `sessions.ts`/`workspace.ts` (create hook), `agentTools.ts`
(optional tool); converges with `practices-hooks-gating.md`.

### G6 — Skill / slash-command / prompt-template curation + `$` discovery  *(P2)*

**What it is.** T3Code surfaces the vendor's skills/slash-commands in a composer **`$` picker** and ships its own
skills (C11/C12). AllMyAgents materializes *instructions/practices/memory* into `CLAUDE.md`/`AGENTS.md` but has
**no invokable-skill/slash-command surface** and no discovery picker.

**Why valuable.** Skills/slash-commands are how an operator packages a repeatable prompt ("/code-review",
"/write-tests") — discovery + hub-curated skills lower friction. But note: **skills are a vendor-native
capability** (Claude Code reads `.claude/skills/**/SKILL.md`; the SDK reports available slash commands in its init
message), so this is mostly *surfacing + curation*, not injection of new agent power.

**Confidence:** Confirmed (as a surfacing feature). Lower priority — high overlap with the already-built practices
layer and with vendor-native behavior.

**Mechanism — skills-on-disk + a composer picker fed by the SDK init message:**

1. **Discovery:** the Claude Agent SDK surfaces available slash commands in the **system init message**
   (`adapters/claude.ts` message loop); capture them into `SessionView` and render a `$`/`/` picker in the
   composer (mirrors T3Code). Zero new agent tooling — just plumb what the SDK already reports.
2. **Hub-curated skills:** let the operator define skills once (a `SkillStore`) and **materialize** them into each
   session's `.claude/skills/<name>/SKILL.md` at spawn — reusing the exact `writeManagedInstructions`
   materialize-into-worktree machinery (`instructions.ts`) that practices/memory already use. This is the
   "T3Code ships test-t3-app/test-t3-mobile skills" pattern, hub-owned and scoped.
3. Codex parity is thinner (no skills system); fall back to prompt-template snippets inserted into the composer.

**Grounding:** `adapters/claude.ts` (init-message slash commands), `instructions.ts` (materialize-into-worktree),
composer components; `docs/tool-affordance.md` (descriptions-as-affordance still applies to skill blurbs).

### G7 — Outward-facing hub MCP server  *(P2)*

**What it is.** T3Code #345's idea (C2): a **real MCP server** exposing the hub's own state — sessions, threads,
diffs, reviews — as tools so an *external* MCP-compatible agent (a user's editor, a CI bot, another Claude) can
query the fleet and act on reviews. **Never shipped by T3Code.** AllMyAgents has a rich *in-process* server
(`agentTools.ts`) for its *own* agents but nothing *outward-facing*.

**Why valuable.** Turns AllMyAgents into a queryable control plane ("what's blocked?", "read the open reviews on
session X") from outside — and is the natural home for G1's review tools in their *external* form. Niche until
there's an external consumer, hence P2.

**Confidence:** Confirmed-as-concept (documented in #345), not-shipped-anywhere.

**Mechanism — a protocol: a standalone MCP server process the hub hosts:**

1. A small **stdio/HTTP MCP server** (its own entrypoint, or a mode of `server.ts`) exposing **read-mostly** tools:
   `list_sessions`, `read_thread`, `read_diff`, `list_reviews`, `resolve_review` — backed by the journal + the G1
   `ReviewStore`. Reuse the existing origin/host/**device-token** guard (`deviceToken.ts`, `server.ts`) as the
   auth boundary; external ≠ unauthenticated.
2. Keep it **distinct from the in-process `allmyagents` server** (which is auto-allowed and identity-bound to one
   session) — this one is cross-session and must be token-gated, exactly the namespace-separation rule
   `docs/agent-native-tools.md` §5.2 establishes for higher-risk tool classes.

**Grounding:** `journal.ts` (read model), `reviews.ts` (G1), `deviceToken.ts`/`server.ts` (auth), `agentTools.ts`
(tool-definition style to mirror).

### G8 — Per-session MCP-server management UI (passthrough)  *(P2 — inferred need)*

**What it is.** A Settings surface to attach arbitrary MCP servers to a hosted session/profile (Claude
`options.mcpServers`; Codex `config.toml [mcp_servers]`). AllMyAgents wires its *own* server but exposes no UI to
add others; the memory's harvest list hints T3Code has "MCP toolkit registration" (I1).

**Why valuable.** Lets the operator give agents third-party MCP tools (Playwright, a database MCP, etc.) without
hand-editing config — and it is the same insertion point `docs/emulated-agent-tools.md` uses for the
browser/computer servers, so building the management surface now pays that work forward.

**Confidence:** Inferred (T3Code's exact UI unconfirmed; the *mechanism* is well-understood in this codebase).

**Mechanism — config surface + the existing capability gate:**

1. A `mcpServers` list per profile/session in Settings → writes Codex `config.toml [mcp_servers]` (the
   `adapters/codex.ts` config path) and augments the Claude `options.mcpServers` map (`adapters/claude.ts`).
2. **Reuse the native-tools capability gate** from `docs/agent-native-tools.md` / `docs/emulated-agent-tools.md`:
   any non-`allmyagents` server is **not** auto-allowed, falls through to `canUseTool`/`onApproval`, and is
   bus-hard-denied — so operator-added MCP tools inherit the safety model for free.

**Grounding:** `adapters/claude.ts` / `adapters/codex.ts` (insertion points), `sessions.ts` (`canUseTool`
auto-allow boundary), `docs/emulated-agent-tools.md` (the gate this reuses).

---

## 4. What is NOT a gap (AllMyAgents already leads T3Code here)

State this so effort isn't misdirected chasing parity that already exists — several categories the task asked
about are **AllMyAgents strengths**, not T3Code imports:

| Capability | AllMyAgents | T3Code |
|---|---|---|
| **Inter-agent bus** (semi-trusted teammate messaging, ACLs, trust frame) | Built (`bus.ts`, `agentTools.ts`; `docs/inter-agent-comms.md`) | **Absent** |
| **Scoped cross-vendor/cross-account memory** | Built (`memory.ts`; `docs/memory-system.md`) | **Absent** |
| **Agent-writable practices** (materialized conventions, scope-gated) | Built (`practices.ts`, `agentTools.ts`; `docs/practices-hooks-gating.md`) | **Absent** |
| **Hooks registry** (agent-proposed, operator-gated executable hooks) | Designed (`docs/practices-hooks-gating.md`) | **Absent** |
| **Browser / computer / visualization tooling** for agents | Designed (`docs/agent-native-tools.md`, `docs/emulated-agent-tools.md`) | **Absent** |
| **Automatic memory recall** (push, not pull) | Designed (`docs/tool-affordance.md` §4) | **Absent** |
| **Self-gating in-process tools under `full`** (approval reachable even in bypass) | Built (`agentTools.ts` `requireApproval`; `docs/practices-hooks-gating.md` §1) | n/a |
| **Multi-agent visualization** (lanes/runs/fleet, spawn trees) | Designed (`docs/agent-visualization.md`) | **Absent** |

The corollary: **do not fork or deep-port T3Code for agent tooling.** The reference is worth mining for exactly
one cluster — the **git-lifecycle + review workflow** (G1–G5) — and one unshipped idea worth *beating* (G7). On
everything else, AllMyAgents is the more advanced design and should keep leading.

---

## 5. Recommended order

1. **G1 (review loop)** — highest value, uniquely agent-facing, and a leapfrog over the reference. Build the
   `ReviewStore` + `deliverReview` + `review_*` tools + worktree `feedback.*` + the diff-comment UI.
2. **G2 (checkpoints + changed-files diff)** — the safety net and the surface G1's comments anchor to; also
   already backlogged ("session-stamped commits").
3. **G3 (commit/push/PR)** — completes worktree→merged; small once G2's git service exists.
4. **G4 (plan gate)** and **G5 (project scripts)** — thin workflows over capabilities that already exist
   (vendor plan mode; the hooks dispatcher).
5. **G6 (skills/`$` picker)**, **G7 (outward MCP)**, **G8 (MCP passthrough UI)** — P2 polish / reach.

Fold G1–G3 into a new **"git & review" DESIGN section** (they share the `WorkspaceManager` git service and the
diff surface); G4 folds into `docs/agent-visualization.md` (Run view); G5 folds into
`docs/practices-hooks-gating.md` (executable-tier tools); G8 folds into `docs/emulated-agent-tools.md` (same
capability gate).

---

## Sources

T3Code (external — confirmed):
- Repo: https://github.com/pingdotgg/t3code · Docs: https://pingdotgg-t3code.mintlify.app/
- **Review MCP server (issue #345, "closed as not planned")**: https://github.com/pingdotgg/t3code/issues/345
- AGENTS.md (repo conventions, `test-t3-app`/`test-t3-mobile` skills, `vp`/`vpr` toolchain): https://github.com/pingdotgg/t3code/blob/main/AGENTS.md
- Feature walkthrough (runtime modes, per-turn diff, worktree, one-click PR, quick actions, plan mode, terminal): https://betterstack.com/community/guides/ai/t3-code/
- Releases / changelog (collapse-all diff, `$` skill picker, Opus 5, thread snoozing): https://github.com/pingdotgg/t3code/releases
- Review-loop mechanics (inline+thread comments, open/resolved, `feedback.json`/`feedback.md`/`resolved.json`, feeds into thread, auto-suggest resolution): search corpus around issue #345 and local-diff-review tools
- Claude Code skills/slash-commands + `$` picker + `mcp_servers` in SDK options (confirms C8/C11/C12 are vendor-native): Claude Code guides (e.g. https://blakecrosley.com/guides/claude-code)

Internal (grounding — current code + prior designs):
- `apps/hub/src/agentTools.ts` — `buildAgentMcpServer`, in-process tool shape, identity binding, `requireApproval` self-gate, `isBusTurn`, `journal`, `danger()`
- `apps/hub/src/sessions.ts` — `create()` + spawn materialize, `canUseTool`/`onApproval` gate + `allmyagents` auto-allow, `deliverBus` + clamp, `checkWriteScope`, `runClaudeTurn`/`runCodexTurn`
- `apps/hub/src/workspace.ts` — `WorkspaceManager` (worktree + `agent/<short>` branch; **no commit/checkpoint/PR today** — the G2/G3 extension point)
- `apps/hub/src/{instructions,practices,memory,approvals,projects,journal,deviceToken,server}.ts`, `adapters/{claude,codex}.ts` — materialize-into-worktree, scoped stores, the operator gate, project store, routes + auth guards, adapter MCP insertion points
- `apps/web/src/lib/{DiffView.svelte,diff.ts,store.svelte.ts}` — existing diff-render primitives + the event-replay store (`ItemKind`, `apply()`, `PaneTarget`)
- `docs/inter-agent-comms.md` (bus/clamp/trust — reused by G1), `docs/memory-system.md` (scoped store + cheap-model pattern — G3), `docs/tool-affordance.md` (descriptions-as-affordance — G1/G6), `docs/agent-native-tools.md` + `docs/emulated-agent-tools.md` (capability gate — G8; the browser/computer lead), `docs/practices-hooks-gating.md` (executable-tier gating — G2/G5), `docs/agent-visualization.md` (Run view / plan phases — G4)
