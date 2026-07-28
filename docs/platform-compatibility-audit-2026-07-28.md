# macOS and Linux compatibility audit — 2026-07-28

Audited commit: `f1fc776` (current `main` when the audit began).

## Executive result

- **macOS: substantially working, with important executable-config gaps.** The native app, bundled hub,
  dependency repair, and uninstall all ran successfully on both Apple Silicon and Intel. A portable Claude
  hook and stdio MCP server also worked in a real app session on Windows, but no runner currently exercises
  project hooks, project MCP, or an authenticated vendor turn on macOS.
- **Linux: the hub/web payload is portable, but the desktop app is not currently a Linux product.** CI
  tests the JavaScript half on Ubuntu, but the release matrix, native-shell CI, installers, and smoke tests
  omit Linux. There is no shipped Linux desktop artifact.
- **The highest-risk code defect is in executable-config trust.** The project scanner fingerprints a hook's
  command and arguments, but not its `shell` or Windows command override. A project can therefore change
  what executable runs on one platform without invalidating an existing approval.
- **The most visible product defect is that the executable-config gate has no current UI.** The API can
  inspect/approve/revoke project config, but the web app has no caller for approve or revoke. The safe
  default works, but an operator cannot review and approve a legitimate project from the app.
- **Codex project config is outside the AllMyAgents trust model.** `.codex/config.toml` and
  `.codex/hooks.json` are neither displayed nor fingerprinted. AllMyAgents can say a project config is
  approved while Codex's project MCP and hooks remain unavailable. This is safe-inert today, but misleading
  and not vendor parity.

## Evidence gathered

- Current-main CI run
  [30373387262](https://github.com/nathanfraske/AllMyAgents/actions/runs/30373387262) passed on
  `windows-latest`, `macos-latest`, and `ubuntu-latest`: hub tests/typecheck, web tests/check/build,
  credential firewall, real payload bundling, staged npm graph installation, and payload imports.
- Current-main macOS P0 run
  [30373666412](https://github.com/nathanfraske/AllMyAgents/actions/runs/30373666412) passed all four
  jobs: native app launch/repair and CLI install on Apple Silicon and Intel.
- In the real web app and isolated hub on port 7805, a project containing an exec-form Claude hook
  (`node` plus a script argument) and a stdio MCP server was tested:
  - Unapproved Claude session `e39a88fb…` replied `CLAUDE_UNTRUSTED_OK`; neither marker was created, and
    only the built-in `allmyagents` MCP server was present.
  - After approval through the API, Claude session `3579319b…` replied `CLAUDE_TRUSTED_OK`; both marker
    files were created and the test MCP server connected.
  - Codex session `382b4548…` replied `CODEX_CONFIG_PROBE_OK`, but neither `.codex` hook nor MCP marker
    appeared; only the built-in AllMyAgents/Codex-app MCP servers started.
  - The project config response displayed the hook only as `node`, hiding its `compat-hook.mjs` argument.
- Source inventory covered all product `spawn`, `kill`, path-comparison, executable-bit, bundling, and
  release-workflow call sites. The repository contains no production `fs.watch`/chokidar use; collision
  detection polls Git instead.

## Ranked findings

### P0 product gap — Linux desktop is not built, tested, or shipped

**Status: broken as a product; hub/web only works in CI.**

The release workflow targets Windows plus macOS arm64/Intel. Native-shell CI also targets Windows and
macOS only, and its own comment describes Ubuntu as a cheap JavaScript POSIX canary. There is no Linux
Tauri build, installer/package, desktop smoke test, or published artifact. The bundled hub's dependency
graph does install and import successfully on Ubuntu, which is useful evidence for a future Linux target,
but it is not evidence that the app launches or integrates with a Linux desktop.

### P1 security/portability — hook approval omits platform execution fields

**Status: broken.**

`readProjectConfig()` fingerprints hook event, matcher, command, and arguments. It does not fingerprint or
display `shell`, `commandWindows`/`command_windows`, or reject malformed arguments. Changing a hook from a
portable exec form to a platform-specific shell/override can therefore preserve the approved fingerprint.
The consent surface also omits arguments, as the real API exercise demonstrated.

The correct portable form is an interpreter executable plus explicit arguments (for example `node` and a
script path). Shell-form commands are inherently platform-specific: Claude uses `sh` on macOS/Linux and
Git Bash or PowerShell fallback on Windows; Codex additionally exposes a Windows command override. A
`.cmd` shim is not a portable exec-form executable.

### P1 authority/path correctness — case handling is hard-coded incorrectly

**Status: broken on Linux and on case-sensitive macOS volumes; default macOS behavior is partly untested.**

- `importScan.normPath()` lowercases paths on every OS. On Linux, `/Repo` and `/repo` are distinct, so an
  import can accept or exclude the wrong transcript/worktree.
- `sessions.resolveCodexIdentity()` lowercases the requested and recorded cwd on every OS. On a
  case-sensitive filesystem this can attribute a Codex MCP call to the wrong session, an authority-bearing
  decision.
- `writeScope.ts` assumes every macOS filesystem is case-insensitive. On a case-sensitive APFS volume, a
  case-only prefix can be treated as inside the allowed worktree when it is outside it.
- The collision detector is correct for Linux/case-sensitive macOS (case-sensitive keys) and Windows
  (case-folded keys), but can miss a case-only collision on the usual case-insensitive macOS volume.
  Tracked Git paths reduce the likelihood; untracked paths and symlink aliases remain untested.

The WSL/workspace owner should own the shared execution/authority abstraction. The import scanner's local
normalization is separable and can be fixed without introducing WSL translation.

### P1 UX/vendor parity — no approval UI; Codex executable config is invisible

**Status: broken but safely inert.**

The hub exposes inspect, approve, and revoke routes. The web app calls inspect while scanning/importing, but
has no approve/revoke caller or executable-config review surface after the stepped project-launch changes.
An untrusted Claude project is correctly denied; a legitimate project cannot be enabled by an operator in
the app.

AllMyAgents scans Claude `.mcp.json` and `.claude/settings*.json` only. Codex's project
`.codex/config.toml` and `.codex/hooks.json` are not shown, fingerprinted, approved, or explicitly rejected.
Codex itself loads project config only for trusted projects, but AllMyAgents exposes no corresponding trust
decision. Until full support exists, detecting these files and keeping the project gate unverifiable is
more honest than reporting approval.

### P2 lifecycle — principal hub trees are portable; several leaf cancellations are not

**Status: core works; leaf paths broken/untested.**

- **Works:** the desktop shell starts the hub in a POSIX process group and kills the group on macOS/Linux;
  Windows uses `taskkill /T /F`. `hubctl` gives hubs and workers their own POSIX groups and mirrors the same
  tree-kill behavior. Rust shell tests pass on macOS, and real macOS launch/uninstall exercises passed.
- **Gap:** `loginLauncher` uses `taskkill` for a Windows login tree but only `child.kill()` on POSIX.
  Cancelling or timing out a Codex/Claude login can orphan wrappers, browser-callback helpers, or polling
  descendants on macOS/Linux. No macOS login-cancel runner exists.
- **Gap:** `CodexClient.stop()` tree-kills on Windows but kills only the direct child on POSIX, relying on
  later hub-group teardown for descendants. This is adequate for full hub shutdown but not a deterministic
  standalone client stop.
- **Lower risk:** GitHub clone cancellation kills only the direct `gh` process, not a possible `git`
  descendant. The current UI/API exposes no active clone-cancel path, so this is presently dormant.

### P2 vendor CLI launch — package resolution is portable; installed execution is incompletely tested

**Status: implementation looks correct; macOS/Linux authenticated launch is untested.**

- Codex normal turns resolve `@openai/codex/bin/codex.js` and run it with the bundled/current Node instead
  of relying on a `.cmd`/shell shim.
- Claude normal turns use the SDK, and the lock contains the relevant native optional packages.
- Login uses explicit Windows entry points, but POSIX uses `node_modules/.bin/claude` and `codex`,
  relying on npm symlinks, shebangs, and executable bits.
- The staged-payload CI installs the exact npm graph and imports the SDK/sqlite, but does not execute both
  vendor CLIs. macOS P0 proves first-run dependency installation, not an authenticated vendor turn or login.
- Linux has no authenticated CLI or desktop exercise.

### P2 executable bits, file watching, and permissions

**Status: shipped-node handling works; project-authored executables are portability-sensitive.**

- `bundle-hub.mjs` applies mode `0755` to the staged Node binary on POSIX. The macOS installer verifies that
  binary is executable; the P0 workflow removes its execute bit and proves the app repairs it on both
  architectures.
- Credentials/device tokens are chmod `0600` on POSIX.
- There are no tracked `100755` files in this repository. macOS installation scripts are intentionally
  invoked through `/bin/bash`, so their `100644` mode is not itself a failure.
- A project hook that directly names a script still depends on its executable bit and shebang on POSIX.
  Windows cannot validate/preserve that behavior. Interpreter-plus-arguments is the portable authoring
  form; AllMyAgents does not and should not silently chmod user hooks.
- Production collision monitoring polls Git every two seconds; there is no cross-platform file-watcher
  backend to audit.

### Payload normalization

**Status: works on current runners, with one test gap.**

`bundle-hub.mjs` accounts for Windows and POSIX npm layouts, stages one uniform `node/node_modules/npm`
layout, dereferences POSIX npm symlinks, preserves a locked registry/integrity graph, includes the native
Claude/Codex packages for supported host architectures, and rejects credential-shaped payload content.
That real staged graph installed and imported on all three CI operating systems. The remaining gap is
post-install execution of both vendor CLI entry points, especially the POSIX `.bin` login path.

## Small, separable fixes recommended

1. Fingerprint and display hook arguments, shell, and Windows override; fail closed on malformed execution
   fields.
2. Detect `.codex/config.toml` and `.codex/hooks.json` and mark them unverifiable until the product has an
   explicit Codex trust/launch contract.
3. Make transcript-import path normalization platform-aware. Route session identity and write-scope case
   semantics through the workspace abstraction rather than duplicating a second cross-platform policy.
4. Add staged-payload CLI execution gates on Windows, macOS, and Ubuntu.
5. Give POSIX login children their own process group and test cancel/timeout tree teardown.
6. Treat Linux desktop support as a product lane: build, package, native smoke, updater/uninstall, picker,
   authenticated vendor turns, and release artifacts. Do not label the existing Ubuntu JS canary as Linux
   desktop support.
