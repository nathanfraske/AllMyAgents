# Manager Helper — isolated, risk-bounded child approvals

The first production slice of the automated safety-checker idea is implemented as the optional **Manager
Helper**. It removes routine permission micromanagement from large project teams without creating another
chat, worker identity, or broad permission grant.

This is deliberately narrower than a global `auto` permission mode. It decides only a project manager's
already-delegable descendant approvals, inside the exact tool/Git ceiling the operator gave that manager.
Everything outside that ceiling follows the existing escalation path unchanged.

## Operator configuration

Project Manager settings expose:

- enable/disable (default off);
- the exact helper account, model, and effort;
- a maximum automatic risk of `low` or `medium`.

The picker prefers Codex Spark (then a mini/default Codex model) or Claude Sonnet 5 at the lowest supported
effort. The operator can choose another advertised model, including account-specific preview models.
Reusable team presets retain the helper policy.

## Decision flow

1. A child requests permission through the normal provider approval path.
2. The hub proves the child belongs to exactly one configured manager and that the action is inside that
   manager's live operator-owned ceiling.
3. A deterministic classifier establishes a risk floor. Unknown classes, elevation, destructive shell
   primitives, pushes, merges, and other broad effects cannot be talked down by the model.
4. Requests above the configured helper ceiling skip the model and wake the manager.
5. Eligible requests enter one serialized helper queue per manager. The isolated evaluator returns
   `allow`, `deny`, or `escalate`, plus `riskLevel`, `requested`, and a bounded reason.
6. Before resolving, the hub rechecks that the approval is still pending and the hierarchy and ceiling have
   not changed. Any uncertainty, provider failure, timeout, parse failure, or changed grant wakes the manager.

The helper never creates a remembered grant. Managers may still explicitly remember a well-understood
action class through the ordinary audited manager decision path.

## Isolation boundary

Each evaluation uses a fresh temporary workspace and a fresh provider home containing only the credential
material required to authenticate. It receives no AllMyAgents MCP server, bus, memory, practices, project
files, plugins, skills, hooks, browser, shell, sub-agents, or durable transcript. Claude tools are denied;
Codex runs read-only with approvals disabled and its effect-bearing native features disabled. The untrusted
request payload is labelled as data in a fixed system contract.

The temporary evaluator is deleted after the one response. Provider failure is fail-safe: the approval stays
pending and is escalated instead of guessed.

## Audit and UI

Every outcome is journaled on the requesting worker as `manager/approval-helper-decision`, including the
manager, helper account/model/effort, deterministic/effective risk, action summary, decision, and reason.
The worker transcript renders a compact approved/denied/escalated card; expanding it shows the explanation.
There is intentionally no helper tab and no surface for chatting with it directly.

## Account-scoped Codex catalogs

Codex model availability is discovered from each managed profile's provider-maintained model catalog. The
hub projects only bounded picker metadata; provider instructions remain private to the profile. A preview
model is offered only on accounts whose own catalog advertises it. This is how Cyber access such as
`gpt-daybreak-blue-latest` (Daybreak Blue) can appear on one Codex account without being assumed available
on every Codex account.

## Still roadmap

A fleet-wide `auto` permission mode for ordinary operator chats is not part of this slice. It would have a
larger authority boundary than manager-descendant approvals and needs its own explicit policy and UX rather
than silently reusing the Manager Helper grant.
