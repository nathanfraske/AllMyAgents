# WSL support

AllMyAgents treats a WSL distro as a filesystem boundary, not as a flag on a
Windows path. A WSL project is identified by both its concrete distro name and
its case-sensitive Linux path:

```text
wsl:<lowercase distro name>:<case-sensitive absolute Linux path>
```

For example, `Ubuntu:/home/me/api` and `Debian:/home/me/api` are different
projects and cannot collide. `\\wsl$\Ubuntu\home\me\api`,
`\\wsl.localhost\Ubuntu\home\me\api`, and `/home/me/api` with an explicit
`Ubuntu` selection identify the same project.

## Supported boundary

The first supported release targets WSL 2 distributions on Windows:

- Existing projects can be selected through either WSL UNC spelling or through
  an absolute Linux path after choosing a distro.
- New managed projects are created natively below
  `~/.local/share/allmyagents/projects` in the selected distro.
- GitHub repositories can be cloned to the local Windows filesystem or
  natively into a selected distro. Installed distributions are enumerated;
  the current default is never persisted as an alias.
- The project list and project view show `WSL · <distro>`. A missing, renamed,
  stopped, or WSL 1 distro produces a specific availability message.
- Git operations, worktree creation/removal, and vendor processes run inside
  the owning distro. WSL worktrees remain in that same distro below a sibling
  `.allmyagents-worktrees` directory.
- Collision identity includes the distro and preserves Linux case. Host-side
  bounded file reads use the equivalent `\\wsl.localhost` path; attachment
  references given to an agent use the native Linux path.

Passive project listing does not start stopped distributions. Explicit
creation/reopen actions may start the selected distro. A stopped distro is not
treated as a deleted project.

## Native tooling requirement

Running a Windows vendor executable through `/mnt/c` would put Node, file
watching, Git, hooks, and tool subprocesses back across the slow interop
boundary. AllMyAgents therefore requires the selected distro to contain native
Linux installations of the chosen vendor CLI and its required runtime:

- `claude` for Claude sessions
- `codex` and `node` for Codex sessions and the managed MCP bridge
- `git` for every WSL project
- `gh` as well as `git` for GitHub cloning

Session and clone preflight reports a direct setup error when a command resolves
only to a Windows interop shim under `/mnt/<drive>`. Managed Codex profile files
are mirrored into a distro-specific directory, and generated MCP command paths
are translated to their native Linux equivalents.

## Deliberate limitations

- WSL 1 is detected and rejected. Its filesystem and interop behavior are not
  silently treated as WSL 2.
- Docker Desktop is detected separately from user distributions. A
  Docker/WSL clone target is shown as deferred and disabled; the UI reports
  when Docker is absent or its daemon is unavailable. Container lifecycle,
  credentials, and durable volume ownership need a separate design.
- WSL is absent without error on macOS, Linux, and Windows installations where
  `wsl.exe` is unavailable. Those systems do not run WSL probes.

## Verification

The pure classifier tests cover UNC aliases, multiple distros, case-sensitive
identity, stopped/missing distributions, WSL versions, and Windows-to-WSL path
translation. The integration test creates, inspects, and removes a real Git
worktree inside an installed WSL 2 distro, and skips with an explicit reason
when WSL 2 is unavailable.

The primary implementation seams are:

- `apps/hub/src/workspaceLocation.ts` — classification and identity
- `apps/hub/src/wsl.ts` — capability and distro enumeration
- `apps/hub/src/wslProcess.ts` — native command resolution and process launch
- `apps/hub/src/workspace.ts` — native projects and worktrees
- `apps/hub/src/sessions.ts` — persisted execution identity and preflight
- `apps/hub/src/worktreeCollisionDetector.ts` — distro-aware collision keys
- `apps/hub/src/githubImport.ts` — native WSL clone flow
