# Auto mode — an isolated AI safety cross-checker (roadmap, not implemented)

**Idea (requested 2026-07-25).** A new permission tier **`auto`**, sitting between `edits` and `full`, where a
dedicated, **user-chosen, ISOLATED cross-checker agent** evaluates each of the working agent's risky actions
and decides allow / deny **by risk level** and **by whether the action is within what the user actually
requested** — replacing per-action human approval without going fully ungated. Scoped here for the roadmap;
**not built.**

## The gap it fills

Today's `permissionMode` is `safe | edits | full`:
- **safe / edits** — every risky tool call blocks on **operator** approval (`canUseTool` → `approvals.request`).
  Safe but high-friction: the human is the per-action bottleneck.
- **full** — `bypassPermissions`: `canUseTool` is skipped **entirely**, no checks. Fast but ungated.

**`auto` is the missing middle:** autonomous like `full`, but every action passes an **automated** safety
gate — an AI reviewer standing in for the human, escalating only the genuinely risky or off-task.

## The cross-checker agent

- **User-chosen + hub-attached.** The operator designates one of their agents/profiles (ideally a strong
  model) as the checker; it runs **on the hub** as a dedicated isolated agent — local to the fleet, no vendor
  relay. Configurable per-project or globally.
- **Isolated by construction — the security crux.** The checker has **NO bus tools** (cannot message or be
  messaged), **no shared-memory / practice writes**, and a **clean context per evaluation**. It cannot be
  influenced by — or influence — the working agents or the fleet: a neutral arbiter. The working agent's
  request + output are **DATA** to the checker, never instructions. Prompt-injection resistance is
  load-bearing — the entire value is a reviewer that **can't be talked out of a deny**.
- **Input per evaluation:** the requesting agent's identity + the tool call (name + input / the diff / the
  Bash command) + the **session goal** (the user's original prompt, so it can judge "was this requested?") +
  the worktree/scope.
- **Output (structured verdict):** `{ riskLevel: none|low|medium|high|critical, requested: yes|inferred|no,
  decision: allow|deny|escalate, reason }`, journaled as `auto/verdict` for operator review + tuning.

## The policy — risk × requested

Operator-configurable thresholds; a sane default:

| | **requested** | **unrequested / tangential** |
|---|---|---|
| **low** | allow | allow |
| **medium** | allow | escalate |
| **high** | escalate | deny |
| **critical** | deny | deny |

- **"requested"** = the action plausibly serves the user's stated task (the checker infers alignment from the
  session goal). Unrequested/tangential actions are held to a higher bar — the "did the user actually ask for
  this?" axis the idea calls for.
- **`escalate`** falls back to the existing **operator** approval (the safe/edits path). So `auto` degrades to
  human-in-the-loop for the ambiguous middle — **strictly safer than `full`**, never fail-open.

## Where it plugs in (concrete against today's code)

- New `permissionMode: 'auto'` alongside `safe|edits|full` (`types.ts` `SessionRecord.permissionMode`, the
  composer mode pills, `clampMode`).
- The gate: `executor.ts` `claudeDriverFor`'s `canUseTool` (and the codex `onApproval`) — when mode is `auto`,
  route the request to the **checker** instead of straight to `approvals.request`. **Fast-path** the obviously
  safe (reads, `AUTO_ALLOW_TOOLS`) with no checker call; only Write/Edit/NotebookEdit/Bash/destructive +
  unclassified tools invoke it (latency + cost control).
- In **worker mode**, the checker call is another **relay** (like the step-4 approval relay): the worker asks
  the hub, the hub drives the checker agent, returns the verdict. Composes with the built relay lane.
- Checker **unavailable / errors → escalate to operator** (fail-safe; a checker fault denies-or-escalates,
  never allows).

## Open questions / decisions

- **Latency + cost.** Every gated action is a checker LLM call. Fast-path aggressively; consider a cheap-model
  first pass that escalates to a strong model only on ambiguity; batch a turn's actions where feasible.
- **"requested"-signal quality.** Inferring alignment from the session goal is fuzzy — over/under-flagging is
  the main risk. Tune via the risk table + operator-adjustable thresholds (Danger-Zone-style).
- **Which checker model/profile.** The operator designates it; a strong model is worth the cost for the
  arbiter role. (A mesh/remote-hub checker is a possible later option; the default is local + hub-hosted.)
- **Isolation enforcement.** Guarantee the checker session spawns with bus/memory/practice tools DISABLED (a
  profile flag or spawn option) and no shared context; audit that no injection path exists.
- **Enablement gate.** `auto` delegates approval to an AI — a deliberate capability. Gate turning it on behind
  an explicit toggle + the checker-agent choice (safe-default OFF, per the danger-zone philosophy).

## Why it's compelling

It turns the operator from a per-action bottleneck into a **policy-setter**: pick a trusted checker, set the
risk thresholds, and let agents run near-`full` speed while an isolated, uninfluenceable reviewer catches the
dangerous and the off-task. It's the natural autonomy tier for the "I want to dogfood, not babysit" workflow —
and the isolation + risk×requested framing is what makes it more than a second rubber-stamp.
