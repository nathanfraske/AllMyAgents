# Codex workflows — named skill-sequences for one agent — feasibility & build scope

Design scope, drafted 2026-07-24. **Scoping only — no code changed; read-only on `apps/hub/src`.** Web
research used to pin Codex's *current* (mid-2026) customization surface (skills, prompts, AGENTS.md,
profiles, hooks) because those features move fast and training data goes stale. This doc answers a single
question: **can one Codex agent run a "workflow" in the sense of a KNOWN SKILL SEQUENCE** — a named,
reusable recipe of steps the *same* agent follows for a recurring task (e.g. a "github review" =
fetch PR → read diff → run tests → summarize → post review comment). This is **not** a swarm of parallel
agents (§6 draws that line sharply); it is **one thread, a sequence of steps, possibly with checkpoints.**

It builds on **DESIGN principle 2 (the hub owns every process)**, the app-server integration in
`apps/hub/src/adapters/codex.ts`, the AGENTS.md materialization in `apps/hub/src/instructions.ts`, and —
critically — the **self-gate / bus-hard-deny / operator-approval security model** already designed in
`docs/practices-hooks-gating.md`, which a workflow feature must compose with rather than route around.

---

## 0. Verdict (read this first)

**Partially — and the split is the whole story.** Codex can **author and package** a known skill-sequence
natively; it **cannot deterministically execute** one on its own. Concretely:

| Layer | Native Codex support | Who guarantees the sequence |
|---|---|---|
| **Define/name/version a reusable recipe** | ✅ **Yes — first-class.** Codex **Skills** are, in OpenAI's own words, *"the authoring format for reusable workflows"* that package *"instructions, resources, and optional scripts."* A `SKILL.md` (frontmatter `name`+`description`, body = numbered workflow) is exactly a named skill-chain. The repo **already ships one**: `profiles/codex-a/plugins/cache/openai-curated-remote/github/…/skills/{github,gh-fix-ci,gh-address-comments,yeet}` — an umbrella `github` router that hands off to multi-step specialist recipes. | — |
| **Invoke it by name** | ✅ **Yes.** Explicit (`/skills`, `$skill-name`) or implicit (the model auto-selects by matching the `description`). The installed skills even ship a `default_prompt`, e.g. `agents/openai.yaml` → *"Use $gh-fix-ci to inspect the failing GitHub Actions checks on this PR…"*. | — |
| **Run the steps in a fixed, checkpointed order** | ⚠️ **No — not enforced.** Skills, custom prompts, and AGENTS.md all *"don't enforce fixed steps — the model reads … instructions and may follow them."* Within a single turn the model may reorder, skip, merge, or abandon steps. There is **no native state machine, no per-step gate, no checkpoint primitive** inside one agent. | **the model (advisory)** |

**So the answer to "does Codex have a NATIVE known-skill-sequence mechanism" is: yes for the *recipe*, no
for *deterministic execution of the recipe*.** The recipe is real, named, reusable, and versioned; its
step-by-step fidelity is a matter of model compliance, not runtime enforcement.

**Recommended mechanism for AllMyAgents:** make the **hub the sequencer.** The recipe lives as a hub-owned
**workflow definition** (JSON in a scoped `WorkflowStore`, sibling to `InstructionStore`/`PracticeStore`);
a hub **`WorkflowRunner`** drives it as **one `turn/start` per step on a single Codex thread**, waits for
`turn/completed`, evaluates a **concrete gate** against the emitted items, honors **operator checkpoints**
via the existing `ApprovalService`, then advances or handles failure. Each step's *instruction text* can
itself be a Codex Skill (`$skill-name`) — so the model still gets the native recipe for *how* to do a step,
while the **hub owns the cross-step order, the checkpoints, and the pass/fail decisions the model can't be
trusted to make.** This needs **no new app-server capability** — it reuses `runCodexTurn`
(`sessions.ts:540`) and the `turn/completed` signal (`sessions.ts:216`) the hub already has. Everything
below details this.

---

## 1. Codex's native customization surface, rated for "known skill sequence"

Everything Codex offers a single agent for repeatable tasks, and whether it delivers *ordered, gated
steps* or merely *advisory instructions the model may follow*:

| Mechanism | What it is | Invocation | Enforces a fixed step order? |
|---|---|---|---|
| **Skills** (`SKILL.md`) | A directory: `name`+`description` frontmatter, a markdown body (typically a numbered **Workflow** section + guardrails), and optional `scripts/`. *"The authoring format for reusable workflows."* | `/skills`, `$skill-name`, or implicit by `description` match | **No.** Advisory — *"the model reads SKILL.md instructions and may follow them."* |
| **Custom prompts** (`$CODEX_HOME/prompts/*.md`) | A saved prompt invoked from the slash menu (`/prompts:name`). | `/prompts:<name>` | **No.** Advisory prompt text. **Deprecated** — OpenAI *"now marks custom prompts as deprecated and recommends skills for reusable instructions."* |
| **AGENTS.md** | Standing repo/user instructions auto-loaded every turn (*"rules you want Codex to follow every time in a repo"*). The hub **already writes this** (`instructions.ts:118`, `writeManagedInstructions`). | automatic (always in context) | **No.** Advisory; also always-on, so it can't name/scope a *specific* recipe on demand. |
| **config.toml profiles** | Named config layers (`--profile x` overlays `<x>.config.toml`) setting model, effort, `approval_policy`, sandbox, `[mcp_servers]`. | `--profile` / app-server turn params (`model`, `effort`, `approvalPolicy` — `codex.ts:191-198`) | **No** — it's *configuration*, not sequencing. (The hub doesn't write one today; `profiles/codex-a` has no `config.toml`.) |
| **MCP servers** | External/in-process tools exposed to the model. | model chooses per task | **No** — a tool palette, not a recipe. |
| **Hooks** (`hooks.json` / `[hooks]` in config.toml) | Commands fired on lifecycle events: `SessionStart, UserPromptSubmit, PreToolUse, PostToolUse, PermissionRequest, PreCompact, SubagentStart/Stop, Stop`. Regex `matcher` selects the tool/event. | automatic on the event | **Partly — the wrong "partly".** Deterministically **gates/observes individual tool calls** (e.g. block a `Bash` matching `^rm`), but does **not** define a task recipe or order high-level steps. It's a guardrail rail, not the train. |
| **`exec` / shell sandbox** (`dangerFullAccess`/`readOnly`/`workspaceWrite`) | Governs command execution permission. | per tool call | **No** — permission scope only. |

**Reading of the table.** The one purpose-built primitive for "reusable multi-step recipe" is **Skills**,
and it is genuinely good at *representing* a known skill-sequence (the repo's `gh-fix-ci` is a clean 8-step
CI-repair recipe with guardrails and a bundled `scripts/inspect_pr_checks.py`). What none of these give you
is **execution determinism**: nothing in Codex will *make* the agent do step 3 only after step 2 passed, or
*pause* between steps for a human, or *branch* on a test result. Hooks come closest to "enforcement" but
operate one rung too low (individual tool calls), and — flagged in `practices-hooks-gating.md §3.5` — are
not cleanly observable from an **unmanaged** app-server client like ours anyway. **Determinism, checkpoints,
and branching are the host's job.** That is Q2.

---

## 2. How the app-server lets the HOST drive a deterministic sequence (Q2)

The hub already owns a `codex app-server` child over stdio JSON-RPC and drives the full turn lifecycle
(`adapters/codex.ts`). The methods and notifications that make host-orchestration possible are **already
wired**:

| Primitive | Method / notification | Where in our code | Use for a workflow |
|---|---|---|---|
| Open the thread | `thread/start {cwd}` → `threadId` | `codex.ts:178`, `sessions.ts:359` | one thread = one workflow run (shared context across steps) |
| **Send a step** | `turn/start {threadId, input, model, effort, approvalPolicy}` | `codex.ts:191`, `sessions.ts:552` | **one step = one turn** |
| **Know a step finished** | `turn/completed` / `turn/error` notification | tracked at `codex.ts:171`; drives `setStatus(idle)` at `sessions.ts:216` | the **checkpoint boundary** — host regains control here |
| Read what the step did | item notifications (`agentMessage`, `commandExecution` + exit, `fileChange`) | journaled as `codex/<method>` (`codex.ts:175`) | the **gate input** — inspect results to decide pass/fail |
| Approvals mid-step | server→host request → `{decision}` | `codex.ts:153-164` → `sessions.ts:227` (`approvals.request`) | per-tool gate stays intact inside every step |
| Nudge a running step | `turn/steer {expectedTurnId}` | `codex.ts:206`, `sessions.ts:592` | optional: correct a drifting step without restarting it |
| Abort a step | `turn/interrupt` | `codex.ts:200`, `sessions.ts:720` | `onFail: abort`, or operator cancel |
| Resume after restart | `thread/resume {threadId}` | `codex.ts:186`, `sessions.ts:533` | resume a workflow after an app-server crash |
| Token accounting | `thread/tokenUsage/updated` | `codex.ts:35`, `sessions.ts:219` | watch for context pressure across a long run |

Web-confirmed extras not yet used by the hub but available: `thread/fork` (branch a run), `thread/read` /
`thread/turns/list` / `thread/items/list` (inspect history without resuming), and `instructionSources`
returned by `thread/start` (which AGENTS.md/skills loaded).

**Two host-driven execution models:**

- **(A) Sequential turns — host is the state machine (RECOMMENDED).** The hub sends **step 1 as a turn**,
  awaits `turn/completed`, inspects the emitted items against **step 1's gate**, and only then sends
  **step 2 as the next turn on the same thread** (so the model keeps full context). The **space between
  turns is the checkpoint**: the hub decides pass/fail, optionally blocks on operator approval, optionally
  branches, then advances. This is the only model that delivers the determinism, gating, and checkpoints
  §1 says Codex lacks natively — and it needs **no new protocol**, just a loop around `runCodexTurn` +
  `turn/completed`.
- **(B) One composed prompt — model self-sequences.** Paste the whole recipe (or a single `$skill-name`)
  as one turn and let the model run all steps internally. Simplest; **but** it is exactly the advisory mode
  from §0 — no host checkpoint, no per-step gate, no branch, all-or-nothing, and failure is opaque until
  the single turn ends. Fine for a trusted, short, side-effect-free recipe; wrong for anything with an
  irreversible step (like "post review comment").

Use **(A) as the engine**, and let each step's prompt optionally be a Skill invocation (`$skill-name`) so
the model still gets the native, curated method for *how* to perform that step. Host owns *between-step*;
the skill owns *within-step*.

---

## 3. Recommended mechanism — define + run a named Codex workflow in AllMyAgents (Q3)

### 3.1 Where the recipe lives — hub-owned definition, optional Codex-Skill companion

The recipe must be **hub-owned**, because the hub is what enforces the sequence (§2A) — a Codex Skill file
alone can't be checkpointed. Store it exactly like the other scoped, agent-relevant config the hub already
keeps:

- **Source of truth: a `WorkflowStore` (SQLite), sibling to `InstructionStore` (`instructions.ts`) and the
  planned `PracticeStore` (`practices-hooks-gating.md §2.2`).** Same **scope-key scheme** the whole
  codebase shares — `global | vendor:codex | project:<projectId> | account:<profileId>` — so a workflow is
  reusable across projects/accounts by scope, identical to how instructions/memory/practices already
  generalize. This is the "JSON workflow def" the task asks for, persisted and operator-editable in
  Settings.
- **Optional companion: materialize a per-workflow `SKILL.md`** into the profile's skills (see §3.5) so
  the *same* recipe is available to the model when a session runs the step **and** when the operator runs
  the agent standalone (outside a hub-driven run). This mirrors the existing pattern where instructions
  live in SQLite **and** materialize into `AGENTS.md` (`instructions.ts:46-57` + `:118`). The store is
  authoritative for *order & gates*; the skill is a convenience copy of the *step method*.

Do **not** make a repo-committed skill file the source of truth: repo files are an injection surface
(`practices-hooks-gating.md §3.4` makes the same point about `.claude/settings.json`), and the hub couldn't
gate edits to them.

### 3.2 Data model (minimal)

```ts
// apps/hub/src/workflows.ts  (new — mirrors PracticeStore's shape & provenance)
interface WorkflowDef {
  id: string
  name: string                     // "github-review"
  scope: string                    // global | vendor:codex | project:<id> | account:<profileId>
  description: string              // when to use it (also the skill `description` if materialized)
  provider: 'codex'                // (Claude can reuse the runner later; Codex first)
  steps: WorkflowStep[]
  fromSession?: string | null      // provenance (who authored it) — like memory/practices
  fromProfile?: string | null
  createdAt: string; updatedAt: string
}

interface WorkflowStep {
  id: string
  title: string                    // "Run tests"  (shown in the progress UI)
  prompt: string                   // the turn text; MAY be `$skill-name …` to invoke a Codex skill
  gate: Gate                       // how the hub decides this step passed (see below)
  checkpoint?: boolean             // pause for operator approval BEFORE running this step (default false)
  onFail?: 'abort' | 'retry' | 'steer' | 'ask-operator'   // default 'ask-operator'
  retryLimit?: number              // for onFail:'retry' (default 1)
}

// A gate is a CONCRETE, checkable condition — never "did it work?" (see risk §5.1)
type Gate =
  | { kind: 'marker'; pattern: string }            // agentMessage text matches /pattern/ (e.g. "^REVIEW-DONE")
  | { kind: 'file-exists'; path: string }          // a file the step was told to write appears in the worktree
  | { kind: 'command-exit'; matcher: string; equals: number } // a commandExecution item matching `matcher` exited 0
  | { kind: 'operator' }                           // human confirms pass/fail (an explicit checkpoint gate)
  | { kind: 'none' }                               // advisory step, always "passes" (use sparingly)
```

The **gate is the load-bearing design choice**: because a step is a model turn (non-deterministic inside),
the hub must judge it on an *observable artifact* — a marker string the step is instructed to emit, a file
it must write, or a command exit code — not on vibes. Weak gates make the whole feature a false sense of
determinism (§5.1).

### 3.3 The runner (how the hub executes it against the app-server)

```
// apps/hub/src/workflowRunner.ts (new) — a loop over the EXISTING turn path; no new app-server calls
runWorkflow(sessionId, workflowId, origin='operator'):
  assert origin === 'operator'            // §4: a workflow may NEVER be launched from a bus turn
  wf   = workflows.get(workflowId, scopesFor(session))
  run  = { workflowId, cursor: 0, status: 'running' }   // persisted → resumable (§5.5)
  journal.append(sessionId, 'workflow/started', { name: wf.name, steps: wf.steps.length })
  for (i, step) in wf.steps:
    if step.checkpoint:                   // pre-step human gate
       ok = await approvals.request(sessionId, 'workflow/step', { step: step.title })  // reuses ApprovalService
       if !ok: return finish('cancelled', i)
    journal.append(sessionId, 'workflow/step-started', { i, title: step.title })
    await runCodexTurn(record, resolvePrompt(step.prompt), /*mode*/ undefined, origin)  // sessions.ts:540
    await waitForTurnComplete(threadId)   // resolves on codex/turn/completed  (sessions.ts:216)
    verdict = evaluateGate(step.gate, collectedItemsForThisTurn)   // marker/file/exit/operator
    journal.append(sessionId, verdict.pass ? 'workflow/step-passed' : 'workflow/step-failed', { i })
    if !verdict.pass:
       handled = await handleFail(step, run)     // retry (re-send) | steer | ask-operator | abort
       if handled === 'abort': return finish('failed', i)
    run.cursor = i+1; persist(run)
  journal.append(sessionId, 'workflow/completed', { name: wf.name })
```

Everything reuses machinery that already exists and is already correct:

- **`runCodexTurn` (`sessions.ts:540`)** sends the turn, so per-tool **approvals** (`onApproval` →
  `approvals.request`, `sessions.ts:227`), **token metering** (`sessions.ts:219`), and **journaling**
  (`codex.ts:175`) all keep working per step — a workflow adds sequencing *on top of* the normal turn path,
  it doesn't bypass it.
- **`turn/completed` (`sessions.ts:216`)** is the checkpoint signal; the runner just needs a small
  promise that resolves on that notification for the run's thread (the adapter already tracks active turns
  per thread at `codex.ts:168-174`).
- **`ApprovalService.request`** (fail-closed, 10-min timeout — `practices-hooks-gating.md §1.3`) is the
  checkpoint/`operator`-gate primitive; no new approval plumbing.
- **`thread/resume` (`codex.ts:186`)** + the persisted `run.cursor` make a run **resumable** after an
  app-server crash (which today flips in-flight sessions to `error`, `sessions.ts:792`).

### 3.4 Progress UI

Emit the new journal events (`workflow/started`, `workflow/step-started`, `workflow/step-passed|failed`,
`workflow/completed`, `workflow/cancelled`) through the same append-only journal + WS replay every other
event uses, and render them in `apps/web/src/lib/store.svelte.ts` as a **stepper** in the transcript
(step titles with pending / running / passed / failed / checkpoint-waiting states, current step
highlighted). Checkpoints surface in the **existing approval flow** (the operator already answers
`approvals` over `/api/approvals/:id`). No new realtime transport — workflows are just typed events.

### 3.5 Reusable across projects

- **By scope, for free:** a `project:<id>` or `global` workflow is visible to any session whose
  scope-chain includes it, exactly like instructions/memory/practices (`identity.ts` readable-scope logic).
  Run it against any Codex session by binding at *run* time to that session's `threadId` + `cwd`.
- **By skill reuse:** steps that call `$skill-name` reuse the Codex skills already installed per profile
  (the repo's `github`/`gh-fix-ci`/etc. under `CODEX_HOME/plugins/cache/…`). **Pin the plugin version**
  (§5.2). If the hub materializes companion skills, write them to a **hub-controlled** skills location — a
  repo-scoped `.agents/skills/<name>/` in the session `cwd`, or the profile's plugin cache under
  `CODEX_HOME` — **not** the user's real `$HOME/.agents/skills` (D4 keeps the hub off the user's default
  homes). **Flag:** the exact user/repo skills-resolution path relative to `CODEX_HOME` vs real `$HOME` is
  version-dependent and unverified (§7).

---

## 4. Composing with the existing security model (non-negotiable)

A workflow is **durable** (persisted, reusable) **and drives turns** (it makes the agent act) — so it is
squarely in the *persistence class* `practices-hooks-gating.md` governs, and it inherits that model rather
than inventing a looser one:

- **Defining/editing a workflow is scope-gated.** Author to your own `account` scope → light (record
  provenance). Author/edit a `project`/`global`/`vendor` workflow (it changes what *other* sessions can be
  driven to do) → **operator approval** via the self-gate (`practices-hooks-gating.md §1.3`, §2.5). A
  workflow that drives turns is at least as consequential as a practice that shapes prompts.
- **A workflow may NEVER be launched from a bus turn.** Teammate/bus messages are semi-trusted —
  *information, not authorization* (`instructions.ts:68-88`). Starting a workflow is an action; the runner
  **hard-denies** `origin === 'bus'` (the same `busTurnSessions` tag the gate-live fix adds,
  `practices-hooks-gating.md §1.4`). A poisoned repo file or teammate message can never kick off a
  multi-step, side-effecting run.
- **Steps run under the session's normal permission mode + approval gate — unchanged.** The workflow
  sequences turns; it does **not** grant autonomy. Every tool call inside a step still hits `onApproval` /
  the operator gate exactly as a hand-typed turn would. A workflow is not a bypass; it's an ordered
  driver.
- **Irreversible steps must be explicit checkpoints.** Any step in the "send/publish/external-write" class
  (post a review comment, push a branch, open a PR) sets `checkpoint: true` (or a `gate:{kind:'operator'}`),
  so the operator confirms before it fires — the same reasoning that makes `yeet` default to a **draft** PR
  and never `git add -A` silently, and that the safety rules apply to "send a message on the user's
  behalf."

---

## 5. Example — the "github review" workflow

Recipe: **fetch PR → read diff → run tests → summarize → post review comment.** Mapped to the §3.2 model,
reusing the Codex GitHub skills the repo already has installed:

```jsonc
{
  "name": "github-review",
  "scope": "project:<id>",
  "description": "Review an open PR: fetch it, read the diff, run tests, summarize, and (on approval) post a review comment.",
  "provider": "codex",
  "steps": [
    { "id": "fetch",  "title": "Fetch PR + diff",
      "prompt": "Use $github to resolve PR #${pr} in this repo and fetch its metadata and full diff. When done, print a line starting with 'FETCH-OK' plus the changed-file count.",
      "gate": { "kind": "marker", "pattern": "^FETCH-OK" }, "onFail": "ask-operator" },

    { "id": "review", "title": "Analyze the diff",
      "prompt": "Read the fetched diff. Write your findings (risks, bugs, style) to review.md in the worktree. Do not modify source files.",
      "gate": { "kind": "file-exists", "path": "review.md" }, "onFail": "retry", "retryLimit": 1 },

    { "id": "tests",  "title": "Run tests",
      "prompt": "Run the project's test command (infer it from AGENTS.md / package.json). Report pass/fail.",
      "gate": { "kind": "command-exit", "matcher": "test|vitest|pytest", "equals": 0 },
      "onFail": "ask-operator" },                       // failing tests → human decides: block, or note in the review

    { "id": "summarize", "title": "Summarize",
      "prompt": "Combine review.md and the test result into a concise review summary. Print it starting with 'REVIEW-SUMMARY'.",
      "gate": { "kind": "marker", "pattern": "^REVIEW-SUMMARY" }, "onFail": "retry" },

    { "id": "post",   "title": "Post review comment",
      "prompt": "Use $gh-address-comments conventions to post the summary as a PR review comment on #${pr}.",
      "gate": { "kind": "operator" },                   // gate = human confirms it posted
      "checkpoint": true,                               // PAUSE before this external write (§4)
      "onFail": "abort" }
  ]
}
```

How it runs (host-orchestrated, §2A): the hub sends step `fetch` as one `turn/start`; on `turn/completed`
it checks the `agentMessage` items for `FETCH-OK`; passes → sends `review`; checks `review.md` exists in
the worktree; → `tests`, gated on a `commandExecution` exit 0; → `summarize`; then **pauses** at `post`
(`checkpoint:true`) for operator approval before the irreversible comment, and the operator confirms the
result (`gate:'operator'`). Each arrow is a real checkpoint the model could not have enforced itself; steps
`fetch`/`post` reuse the installed `github`/`gh-address-comments` skills for the *method*, while the hub
owns the *order and the gates*. Failing tests don't silently derail the run — `onFail:'ask-operator'` hands
the decision to a human, and the whole run is journaled step-by-step.

---

## 6. Contrast with the Claude multi-agent model (keep these distinct)

| | **Codex workflow** (this doc) | **Claude multi-agent / swarm** (separate idea) |
|---|---|---|
| Decomposition | **Temporal** — one task split into ordered *steps over time* | **Spatial** — one task split across *many agents at once* |
| Agents | **One** Codex agent, **one** thread, shared context | **Many** agents/subagents, each its own context |
| Concurrency | **Serial** (step N+1 after step N passes) | **Parallel** (fan-out, then join) |
| Who coordinates | the **host** (`WorkflowRunner`), between turns | a **lead/orchestrator** agent + the **bus** + shared memory |
| Determinism | host-checkpointed, gated, branchable | emergent from delegation; less ordered |
| Hub primitives | new `WorkflowStore` + `WorkflowRunner` over `turn/start`/`turn/completed` | existing roster + inter-agent bus + scoped memory (`instructions.ts` contract, `docs/inter-agent-comms.md`) |
| Failure unit | a **step** (retry/steer/abort/ask) | an **agent** (respawn, reassign) |

They are **orthogonal, not competing**, and compose: a swarm member could *run* a workflow, and a workflow
step could *spawn* a swarm. The rule of thumb — **workflow = one agent doing steps in order; swarm = many
agents doing parts in parallel.** This doc is strictly the former; nothing here fans out.

---

## 7. Open risks & what I could not verify

1. **Non-determinism *inside* a step (the core risk).** Host-sequencing fixes *between-step* order, but each
   step is still a model turn that may not do what the prompt says. **Mitigation:** gates must be
   **concrete and observable** (marker string / file / exit code), never "did it succeed?"; instruct each
   step to emit its marker/artifact; keep steps small. A workflow with weak gates gives a *false* sense of
   determinism — worse than none.
2. **Skill/plugin version drift.** `$skill-name` resolves to whatever plugin version is installed in that
   `CODEX_HOME` (`…/github/0.1.8-2841cf9749ae/…` in the repo). Different profiles → different versions →
   different behavior for the "same" workflow. **Pin** the plugin version in the workflow def; verify it at
   run start.
3. **Context growth / mid-run compaction.** A long sequential thread accumulates tokens
   (`thread/tokenUsage/updated`); a `PreCompact` mid-workflow can drop state the next step assumed. **Keep
   durable state in worktree files + the journal, not only in thread context**, so a step can re-read
   `review.md` rather than rely on the model remembering it.
4. **Partial-failure side effects — a workflow is not atomic.** If `github-review` posts nothing but pushes
   a branch in a variant, a failure after the push leaves real external state. Steps with external writes
   need idempotency/rollback thinking and should be **late + checkpointed** (as `post` is). Don't market
   workflows as transactional.
5. **Resumability.** After an app-server crash (`sessions.ts:792` flips the session to `error`), the run
   must resume from `run.cursor` via `thread/resume` — but a step that was *mid-execution* at the crash may
   have partially completed; resume policy (re-run the interrupted step vs. skip) needs per-step
   idempotency, same as (4).
6. **Approval fatigue vs. autonomy.** Checkpoint every step and the operator drowns; checkpoint none and a
   runaway recipe acts unsupervised. The `checkpoint` flag + sensible defaults (checkpoint only
   external-write/irreversible steps) is the balance; expose it in the UI.
7. **Codex hooks as an alternative enforcement path — investigated, not chosen.** Codex *does* now have
   hooks (`SessionStart/PreToolUse/PostToolUse/Stop/…`), which could in principle gate steps. But (a) they
   fire in the Codex runtime and are **not cleanly observable from an unmanaged app-server client**
   (`practices-hooks-gating.md §3.5`), and (b) they gate *tool calls*, not *high-level steps*. Host
   sequencing (§2A) is simpler, observable, and provider-portable. **Flag:** whether any hook event is
   surfaced to our app-server driver is unverified.
8. **Skills-resolution path under `CODEX_HOME`.** Current docs place authored skills at `.agents/skills`
   (repo/user) and `/etc/codex/skills` (admin), while the installed repo skills sit under
   `CODEX_HOME/plugins/cache/…` (the plugin route); older docs said `.codex/skills`. The exact directory
   Codex reads for *user* skills when `CODEX_HOME` is redirected (as the hub does per-profile) vs. real
   `$HOME` was **not verified** — decide the companion-skill write location (§3.5) with a spike before
   materializing.
9. **Source-fetch gap.** `developers.openai.com/codex/*` 308-redirects to `learn.chatgpt.com`; `openai.com`
   403s the fetch tool (same as the sibling docs note). Skill/hook/prompt claims lean on `learn.chatgpt.com`
   + the GitHub repo + secondary write-ups; product surface moves fast — **re-verify before building.**

---

## Sources

Codex customization / skills / prompts / hooks:
- Build skills (skills = *"the authoring format for reusable workflows"*; `SKILL.md` name+description; `/skills` / `$skill-name`; implicit selection; `scripts/`): https://learn.chatgpt.com/docs/build-skills — redirect target of https://developers.openai.com/codex/skills
- Customization overview (AGENTS.md, skills, MCP, hooks/subagents; *"don't enforce fixed steps"*): https://learn.chatgpt.com/docs/customization/overview — redirect target of https://developers.openai.com/codex/concepts/customization
- Slash commands + custom prompts (custom prompts **deprecated** in favor of skills; `/prompts:name`): https://developers.openai.com/codex/guides/slash-commands · https://developers.openai.com/codex/cli/slash-commands
- Advanced configuration (config.toml, **profiles** overlay, `CODEX_HOME`): https://learn.chatgpt.com/docs/config-file/config-advanced · https://developers.openai.com/codex/config-advanced
- Skills catalog / marketplace + community skills: https://github.com/openai/skills · https://github.com/ComposioHQ/awesome-codex-skills
- Codex hooks (events `SessionStart/PreToolUse/PostToolUse/Stop/…`; `hooks.json` / `[hooks]` in config.toml): https://deepwiki.com/openai/codex/3.11-hooks-system · https://codex.danielvaughan.com/2026/04/15/codex-cli-hooks-complete-guide-events-policy-patterns/

Codex app-server protocol (thread/turn/resume/fork; items views; `instructionSources`):
- App-server reference: https://developers.openai.com/codex/app-server · https://github.com/openai/codex/blob/main/codex-rs/app-server/README.md
- Complete protocol guide (full method surface): https://codex.danielvaughan.com/2026/04/15/codex-app-server-complete-guide/
- Session resumption & forking: https://deepwiki.com/openai/codex/4.4-session-resumption-and-forking

Internal (grounding, current code):
- `apps/hub/src/adapters/codex.ts` — `thread/start` (`:178`), `turn/start`/`sendTurn` (`:191`), `turn/completed` tracking (`:168-174`), `turn/steer` (`:206`), `turn/interrupt` (`:200`), `thread/resume` (`:186`), approval dispatch (`:153-164`), token map (`:35`)
- `apps/hub/src/sessions.ts` — `runCodexTurn` (`:540`), `ensureCodexThread` (`:527`), `sendTurn` call (`:552`), `turn/completed`→idle (`:216`), Codex `onApproval`→`approvals.request` (`:227`), `steer` (`:592`), `deliverBus`/bus-origin `runCodexTurn` (`:690`,`:711`), crash→error (`:792`)
- `apps/hub/src/instructions.ts` — `writeManagedInstructions` → **AGENTS.md** (`:107-109`,`:118`), scoped `materialize` (`:46-57`), `agentContract` trust model (`:68-88`)
- `docs/practices-hooks-gating.md` — the self-gate / bus-hard-deny / operator-approval persistence-class model a workflow inherits (§1.3-1.4, §2.5); Codex-hooks caution (§3.5)
- `docs/inter-agent-comms.md` — the swarm/bus model §6 contrasts against; `docs/agent-native-tools.md` — the SDK-vs-CLI / managed-vs-unmanaged surface-mismatch pattern
- Installed Codex skills (proof the recipe format is real & already present): `profiles/codex-a/plugins/cache/openai-curated-remote/github/0.1.8-2841cf9749ae/skills/{github,gh-fix-ci,gh-address-comments,yeet}/SKILL.md` (+ each skill's `agents/openai.yaml` `default_prompt`, e.g. *"Use $gh-fix-ci …"*)
