# Application Overseer

The Application Overseer is a designated, projectless agent conversation for operating AllMyAgents itself.
It is not a project manager and it does not inherit authority merely because an account or ordinary chat is
set to Full access.

## Setup and entry point

First-run onboarding deliberately has only two required steps: connect one account, then choose it as the
Overseer. Choose any available managed Claude or Codex account under **Settings / System / Application Overseer**.
Internal default vendor-home bindings used for history import cannot be selected. The hub creates the role,
forces Full access with an explicit operator override, persists the designated account in supervisor-readable
configuration, and exposes one persistent **Overseer** entry in the sidebar.

The new chat offers two plain-language entry points: **set it up for me** and **show me around**. The former
runs the guided project/team flow below. The latter uses a hub-owned, provider-neutral application guide so
the answer reflects the controls that exist in this build rather than a model's general product recollection.
The longer visual app tour and New Project dry-run remain optional and replayable from Settings.

Changing the account creates a new role before revoking the old role so a failed transition cannot silently
remove the working Overseer. The role cannot be created through the ordinary session API.

## Control authority

The Overseer control tool can:

- explain accounts, projects, chats, managers, worktrees, presets, access, approvals, elevation, Browser,
  remote testbeds, history, hub status, journal maintenance, recovery, and its own authority boundary;
- inspect projects, chats, profiles, pending approvals, saved team presets, and bounded failure evidence;
- query bounded current messages, task boards, approvals, and durable runs across selected local agents without
  consuming mail or scanning the full journal;
- schedule resource-leased local or granted-remote builds/tests with stable ids, provenance, cursor-paged logs,
  exact terminal state, and parallel placement across independent checkouts, device roots, GPUs, or fixtures;
- create host or WSL projects, import GitHub repositories, and create projectless or project-bound chats;
- run an interactive project-team setup, save the result as a durable preset, and materialize that preset
  as a real project manager plus visible direct-child chats with live ceilings;
- send messages to, stop, reopen, rename, or reconfigure another chat, including its model, effort, service
  tier, role, and explicit operator permission-mode override;
- configure an existing project manager, its reusable child roles, and its delegation/approval ceilings;
- trigger a new account sign-in or reauthentication through the existing freeze-and-settle coordinator;
- inspect and grant remote testbed roots, list and start GitHub clone jobs, and issue a short-lived mesh
  pairing code without exposing the long device credential;
- approve or decline another chat's pending request; and
- request restart through the normal restart supervisor.

Every mutation is journaled. The hub checks the live role on every call and permits mutations only from a
direct operator-originated turn. Teammate/bus turns can read status and bounded failure context so an
automatic fleet-failure alert can produce a report, but they cannot mutate state. An Overseer cannot approve
its own request, and it cannot stop or message itself through the control tool.

## UI teaching and navigation

The Overseer can read a catalog of named app-owned destinations and, on a direct operator turn, request a
short explanation to be attached to one of them. The renderer opens the known screen when necessary,
scrolls the control into view, and draws a dismissible spotlight. Current targets cover Home, New Project,
project overview, Overseer, Accounts, chat defaults, remote access, Safety, hub status, Managers, Browser,
the composer, permissions, and older history.

This is not arbitrary renderer or DOM control. Target names are a closed hub schema, the client accepts only
the same allowlist, explanation text is bounded and rendered as text, and journal replay never reopens a
screen or resurrects a stale spotlight. Reading the catalog is diagnostic; driving the UI requires the same
positive direct-operator provenance as every other Overseer mutation.

Claude worker sessions now relay `AskUserQuestion` over the mutually authenticated local worker channel.
The hub still owns validation, durable correlation, rendering, cancellation, restart interruption, and the
answer. This lets a Claude Overseer ask the setup questions without weakening the trust boundary.

## Project setup and team presets

For a new repository, the Overseer is instructed to recommend defaults and ask a small set of grouped
questions covering:

- host versus WSL environment and storage location;
- project name;
- account, model, and effort choices;
- worker roles and starting briefs; and
- manager/child access topology and approval ceilings.

The operator can save the result as a team preset. A preset stores manager identity/settings, fixed worker
types, prompts, isolation choices, permission modes, exact Git authorities, and exact tool ceilings. Launch
validates every referenced live profile before creating anything. It creates and configures all records
before starting child work, then sends each startup brief through the direct operator-origin path. A preset
therefore describes an operator grant; it cannot turn a manager-authored or teammate-authored message into
operator authority.

## Failure escalation

When a non-Overseer session enters the error state, the hub posts a fixed, system-authored alert to the
Overseer. Raw vendor/model error text is not copied into the alert. The diagnostic turn may inspect a
bounded reverse-chronological event window and is instructed to produce a structured report with session,
time, symptoms, evidence, likely cause, safe reproduction, recommendation, and owner. It remains a bus turn,
so it cannot approve, reconfigure, restart, or elevate anything unless the operator starts a direct turn.

## Elevated-shell escape hatch

Full access removes ordinary per-tool prompts within the hub policy; it does not create administrator/root
rights. Elevation has a separate, deny-by-default project policy:

- `disabled`: no elevated command may be proposed;
- `project`: the working directory and detected literal paths must remain within operator-configured roots;
- `machine`: machine-wide effects may be proposed, but still require per-command approval.

The Overseer first produces a blast-radius report covering destructive filesystem operations, services and
persistence, networking/availability, identities/permissions, network transfer, nested shells, dynamic
paths, and obvious scope escapes. This analysis is deliberately honest: an arbitrary administrator shell is
not an OS sandbox, so literal-path checks cannot prove containment against a command that constructs paths
dynamically.

Execution requires all of the following: a direct operator Overseer turn, an enabled project policy, a
successful preflight, a dedicated `overseer/elevated-command` approval that Full access cannot auto-approve,
and the host elevation mechanism. The Windows implementation launches a one-shot UAC PowerShell child,
bounds runtime and returned output, terminates the child process tree on timeout, removes its temporary
request files, and journals proposal/decision/start/completion or failure without journaling output. Linux
and macOS currently have no interactive root broker in this build and fail closed; no password or resident
root helper is stored by AllMyAgents.

## Database-offline boundary

The conversation, model execution, projects, approvals, and audit trail are journal-backed. If the journal
cannot open, no vendor agent—including the Overseer—can honestly reason or mutate that state.

To make that failure diagnosable, the desktop supervisor writes a separate bounded, token-free status file
covering startup, boot, live, restart, retry, recovery, offline, and stopping phases. It contains only coarse
health metadata, the designated profile ID, process/port facts, retry count, and a bounded error summary—no
credentials, prompts, session IDs, paths, commands, or journal contents. When the hub disconnects, the
desktop sidebar reads this status and a bounded desktop-log tail through a native command that does not
depend on the hub or its database.

This split gives the operator a dependable recovery view while keeping privileged model action fail-closed.
A future continuously reasoning Overseer during total journal failure would require a separately packaged,
authenticated vendor sidecar with its own minimal durable audit store; it must not be simulated by bypassing
journal preflight or by putting credentials in the supervisor status channel.
