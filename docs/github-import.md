# Optional GitHub import

## Shipped slice

The project form has an optional **Clone from GitHub** branch. Nothing GitHub-related runs during startup
or first-run setup; capability detection begins only after that button is clicked. The existing local
folder flow is unchanged.

This first slice supports:

- GitHub CLI (`gh`) and Git already installed on the device
- an existing `gh` sign-in for `github.com`
- HTTPS Git operations
- up to 100 repositories owned by the signed-in account
- public and private repositories with a default branch
- clone progress, validation, project creation, then a selected project-scoped chat draft

It deliberately does not support:

- signing in to GitHub (there is no registered OAuth app/client ID yet)
- asking for or accepting a personal access token
- SSH-configured GitHub CLI sessions
- organization-owned repository listing
- repositories with no default branch
- choosing a custom clone destination or overwriting an existing destination

Each unsupported state is reported in the picker. None blocks adding a local project.

## Credential boundary

The hub executes `gh` as an argument-vector child process (never through a shell). Authentication stays in
GitHub CLI's own credential store/keychain. AllMyAgents never receives `gh auth token` output, adds a
credential helper, writes an auth file, or places credential material in the repository, runtime payload,
journal, or managed profiles.

Runtime clones live at:

```
<HUB_DATA_DIR>/repositories/<owner>/<repository>
```

In an installed desktop build that is under the operator-data root, outside the shipped hub payload.
Development uses the already-ignored repo `data/` directory. `scripts/bundle-hub.mjs` continues to ship
only its explicit allowlist and its credential firewall continues to scan the finished payload for
GitHub token shapes.

## Clone transaction

1. The UI starts an in-memory clone job and polls its status.
2. `gh repo clone` writes only to `<repositories>/.ama-partials/<job-id>`.
   The clone receives repository-local `core.longpaths=true`, required when the installed app or sandbox
   sits below a long Windows per-user path; no global Git setting is changed.
3. Known Git progress lines are reduced to a stage and percentage for display.
4. On a non-zero exit, the partial directory is removed and no project row is created.
5. On success, the hub requires a Git work tree, a valid `HEAD`, and `.git` metadata.
6. The hub atomically renames the partial directory to its final owner/repository path.
7. Only then does `ProjectStore.create` persist the project.

The app-owned partials directory is cleared on hub startup, recovering clones interrupted by an app or
machine shutdown. Completed repository directories are never part of that cleanup.

If the final project insert fails after the atomic rename, the result is a complete local clone with no
project row, never a project pointing at invalid content. The error directs the user back to the existing
local-folder flow.

## Follow-up for full authentication

A terminal-free sign-in needs a registered GitHub OAuth app and product-owned client ID. The appropriate
follow-up is GitHub's device authorization flow:

1. request a device/user code from GitHub using the public OAuth client ID;
2. open the verification URL in the system browser and show the code in-app;
3. poll until authorized or expired;
4. store the resulting credential only in an OS credential store owned by the installed app;
5. keep the token out of HTTP responses, logs, config, journal events, repo files, and bundle inputs;
6. add revocation/sign-out and explicit organization scope handling.

That work should not be approximated with a token text box or an interactive terminal launch.
