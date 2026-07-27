# First-run tutorial

Status: deferred to the next cut. This document is the implementation contract; this cut intentionally
contains no tutorial code.

## Goal

A new user should get from “just installed” to “using AllMyAgents” without already knowing where accounts,
projects, or agents are configured. The tutorial has two phases, in this order:

1. Add an account.
2. Learn the app and launch work.

The order is functional, not editorial. With no account, AllMyAgents cannot start an agent, so explaining
projects and chats first would lead the user to controls that cannot do anything. Account setup is the only
blocking phase. Once at least one account exists, the rest of the tutorial is explanatory and optional.

The tutorial must be obviously skippable at every step. Skipping is terminal and remembered.

## Eligibility and persisted state

Use one device-local record, available before any account exists:

```ts
type TutorialState = {
  schema: 1
  disposition: 'new' | 'in-progress' | 'completed' | 'skipped'
  phase?: 'accounts' | 'app'
  step?: string
  updatedAt: string
}
```

The suggested storage key is `allmyagents.firstRunTutorial`. The schema belongs in the value, not the key,
so a later app version cannot accidentally resurrect a tutorial merely by changing `v1` to `v2`. A migration
must preserve both `completed` and `skipped` as terminal dispositions. Do not store account names, login
URLs, tokens, or other sign-in data in this record.

Evaluate automatic eligibility only after the initial profiles and sessions load has settled:

- `completed` or `skipped`: never open automatically.
- At least one existing real chat: treat this as an established installation and persist `completed`
  without rendering the tutorial. This is the fail-safe for upgrades and existing users.
- No real chats and no accounts: start the Accounts phase.
- No real chats and at least one account: start the App phase.

“Real chat” excludes a local unsent draft. A transient hub error must not be mistaken for an empty
installation; wait for a successful initial load or show the normal connection recovery UI.

The deliberate completion condition is the user pressing **Finish** on the last App-phase step. Adding an
account advances the tutorial but does not complete it. Pressing **Skip tutorial** at any point persists
`skipped` immediately. These explicit terminal states prevent a repeat of the old “YOUR FIRST CHAT” guide,
which was derived from a frequently recurring UI state and therefore kept returning until commit `096e14a`
fixed it.

Progress within a phase may be saved so a crash resumes at the same useful step. Resumption must still
revalidate the step target; persisted progress is not evidence that an element exists.

## Phase 1: add an account

This phase drives the real terminal-free sign-in flow from Lane T. It must not implement another login
form, open its own vendor URL, poll a second endpoint, or describe a terminal workaround as the primary
path.

Lane T's implementation is commit `1f3f875` (ready for merge when this was written). Its flow is:

- Settings opens to Accounts.
- The user chooses Claude or Codex, gives the account a recognizable local name, and presses **Log in**.
- The app starts the vendor login and opens the required browser page.
- The hub reports `idle`, `waiting`, `done`, `error`, or `cancelled`.
- On success, `store.rescanProfiles()` updates `store.profiles`.

The hub/API source of truth is Lane T's `login`, `loginStatus`, and `cancelLogin` API surface. Tutorial
completion for this phase is observable as `store.profiles.length > 0` after the rescan. The tutorial must
not infer success from button text or a DOM class.

### Account-phase sequence

1. Introduce the need for an account in one sentence: “Connect Claude or Codex so AllMyAgents can start
   agents for you.”
2. Reveal Settings on its Accounts section and spotlight the actual account sign-in control.
3. Let the existing Settings UI collect the provider and local account name.
4. When the user presses **Log in**, remain attached to Lane T's state and explain the browser hand-off.
5. When `store.profiles` gains an account, acknowledge success and advance to the App phase.

The tutorial must not add another blocking “Next” button after successful sign-in; profile detection should
advance it automatically.

### The waiting state

Browser sign-in commonly takes about 30 seconds. During `waiting`, the UI must contain all of the following:

- A visible, non-technical status such as “Waiting for you to finish signing in in your browser.”
- An elapsed-time update or other ongoing textual update, not a spinner alone.
- “This usually takes about 30 seconds. You can keep this window open.”
- The existing Lane T **Cancel** action.
- **Skip tutorial**, still visible and usable.

The provider/name controls remain disabled while the login is in flight, matching Lane T. The tutorial
must follow Lane T's `done`, `error`, and `cancelled` states:

- `done`: rescan profiles and advance when the account appears.
- `error`: show Lane T's safe error/fallback content and offer Retry; do not reset the whole tutorial.
- `cancelled`: return to the sign-in step and say that no account was added.

The next cut should expose Lane T's local login state through a small typed, read-only integration seam
rather than duplicate its logic. A suitable shape is:

```ts
type AccountLoginView = {
  status: 'idle' | 'waiting' | 'done' | 'error' | 'cancelled'
  provider?: 'claude' | 'codex'
  startedAt?: number
  message?: string
}
```

This can be a callback from `SettingsModal` or shared UI state. It is ephemeral and must never include a
token, authorization code, or credential-bearing URL. `store.profiles` remains the authoritative success
condition.

## Phase 2: explain the app

This phase starts only when at least one account exists. Its copy must be checked against the landed UI in
the implementation cut. The expected product model is:

1. **Home** is the launch point. It lists projects with brief overviews and gives the user a way back to
   the overall picture.
2. **New Project** is the primary sidebar action. It opens one stepped flow: choose the project, choose the
   team, then launch.
3. A **project manager** can start and oversee agents for the user. Describe the benefit—coordinating the
   work and showing progress—not its internal process.
4. **Project View** is the per-project overview where the user sees that project's team and activity.
5. **New Scratchpad** is the secondary action for a standalone task that does not belong to a project.

Suggested plain-language steps:

- Home: “Home shows all your projects and what is happening in each one.”
- New Project: “Start here for work you want to organize. Choose the folder, choose who should help, and
  launch.”
- Project manager: “A project manager can coordinate the agents working on this project and keep their
  progress together.”
- Project View: “Open a project to see its team, current work, and recent activity in one place.”
- Scratchpad: “Use a scratchpad for a quick standalone task. It gets its own safe working folder.”

The tour may open Home and Settings because those are reversible navigation actions. It should not create
a project, spawn a manager, start an agent, or send a chat merely to advance a tutorial. Each explanatory
step has **Back**, **Next**, and **Skip tutorial**. The final step has **Finish**.

## Re-running it on purpose

Add **Show getting started tutorial** to a stable Help or Settings area. Settings is currently the safest
location; put it in a plainly named Help/Get started section rather than Maintenance or an account-specific
section.

Manual replay ignores the persisted terminal disposition for that run only. It must not clear `skipped` or
`completed` first, because closing a replay halfway through must not cause an automatic tutorial on the
next launch. If no account exists when replay starts, begin at Phase 1; otherwise begin at Phase 2.

## Stable anchoring contract

The tutorial must never locate a control by CSS class, button text, title text, DOM ancestry, or component
file. Those are presentation details and are already changing across the sidebar, Home, project flow,
Project View, and manager setup lanes.

Controls that can be spotlighted must expose a semantic attribute:

```html
data-tutorial-anchor="new-project"
```

Anchor names are product contracts. Moving or restyling a control must retain its anchor. If the visible
control is replaced, the new visible control inherits the same anchor. There should be at most one visible
element for an anchor in the active surface.

Required anchors:

| Owning area | Anchor | Semantic target |
| --- | --- | --- |
| App/Sidebar | `settings` | The control that opens Settings |
| Settings/Lane T | `account-sign-in` | The real provider/name/login group |
| Lane V | `home` | The control or landmark that returns to Home |
| Lane V | `project-list` | Home's project overview region |
| Lane U | `new-project` | The primary New Project action |
| Lane U | `new-scratchpad` | The secondary standalone-task action |
| Lane O | `new-project-flow` | The single stepped project/team/launch surface |
| Lane P | `project-view` | The per-project overview landmark |
| Lane Q | `project-manager-setup` | The manager/team configuration region embedded in the project flow |

Use a shared `TutorialAnchor` string union or constants module so misspellings fail typecheck. Tests in each
owning component should assert that its semantic control retains the expected anchor.

### Revealing a target

Finding an anchor and navigating to it are separate operations. Tutorial steps need a stable reveal action,
not a chain of synthetic clicks:

```ts
type TutorialStep = {
  id: string
  anchor: TutorialAnchor
  reveal?: () => void | Promise<void>
}
```

Examples:

- The account step's reveal action opens Settings directly on Accounts.
- The Home step closes transient views and selects Home.
- A project-flow explanation may open the modal only after the user explicitly chooses to preview it.

After `reveal`, wait for the anchor with a bounded `MutationObserver`, confirm that it has a non-empty
visible rectangle, then position the callout. Do not poll forever. Recalculate on resize, scroll, sidebar
resize, and modal transitions. The callout must fit inside narrow and split layouts; if it cannot sit beside
the target, place it in a centered or bottom card and draw only the highlight around the target.

The overlay must not trap the actual account controls. Keyboard focus moves into the tutorial card when a
step opens, returns sensibly when it closes, and supports Escape as an explicit skip/close choice rather
than silently changing persisted state. Respect reduced-motion settings.

## Graceful degradation

A missing or hidden target must never leave a dimmed screen pointing at nothing.

For every step:

1. Run its reveal action if available.
2. Wait a short, bounded interval for the anchor.
3. If the anchor is present and visible, spotlight it.
4. Otherwise show the same explanation in an unanchored card with **Continue** and **Skip tutorial**.
5. Record a development warning containing the step and missing anchor, but do not show technical details
   to the user.

Special cases:

- If `account-sign-in` is missing, offer **Open Settings** and **Retry**, plus **Skip tutorial**. Do not
  declare Phase 1 complete.
- If Settings closes during sign-in, keep the tutorial's waiting card visible and allow Settings to be
  reopened; Lane T's hub status remains the source of truth.
- If the hub disconnects, preserve tutorial progress, show the normal reconnection state, and retry target
  discovery only after data is available.
- If Home has no projects, explain the empty state and point to New Project; do not wait for a project card.
- If a project-specific anchor is unavailable because the user has no project, use the unanchored
  explanation and continue.
- If a modal or layout change removes the target mid-step, drop back to the unanchored card immediately.
- On a narrow window, never position the callout outside the viewport or cover the only Skip/Cancel action.

Missing App-phase targets are skippable steps. A missing Accounts target is recoverable but cannot be
treated as successful. The tutorial itself must always remain dismissible.

## Tests for the implementation cut

Write these fail-first before implementation:

- An installation with existing accounts and chats never renders the automatic tutorial.
- Skipping from Phase 1 persists across remount and app restart.
- Skipping from Phase 2 persists across remount and app restart.
- Completing the final step persists and the tutorial does not return.
- An account appearing in `store.profiles` advances Phase 1 automatically.
- A draft chat alone does not classify the installation as established.
- A missing anchor produces an unanchored, usable step instead of blocking.
- The waiting state has useful text, elapsed progress, Cancel, and Skip.
- Manual replay works after both `completed` and `skipped` without clearing either terminal disposition.
- Narrow viewport and reduced-motion cases remain operable.

Exercise the result as a user against a genuinely fresh hub and fresh browser storage:

```powershell
$env:SANDBOX_PORT='7810'
pnpm sandbox:up
```

Use only port 7810 for this tutorial verification. Confirm the actual browser hand-off, wait roughly
30 seconds without interacting with the app, complete sign-in, finish the App phase, restart, and verify
that it stays gone. Repeat from a wiped state and verify Skip. Then use the Settings/Help replay action.

## Deferred implementation note

No tutorial implementation code was written before the scope change, so there is no partial-code branch to
preserve. The next cut should start from this contract and Lane T's `1f3f875`, after rebasing onto the
then-current versions of Lanes U, V, O, P, and Q.
