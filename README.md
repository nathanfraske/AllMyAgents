# AllMyAgents

**Run a whole fleet of coding agents from one window — and let them talk to each other.**

A self-hosted hub and desktop app for [Claude Code](https://claude.com/claude-code) and [OpenAI Codex](https://developers.openai.com/codex). Several accounts per vendor, side by side, on your own machine. Your agents can message each other, look in on each other's work, and share what they learn.

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Platform](https://img.shields.io/badge/platform-macOS%20%7C%20Windows-lightgrey.svg)](#install)
[![Release](https://img.shields.io/github/v/release/nathanfraske/AllMyAgents?include_prereleases&label=release)](https://github.com/nathanfraske/AllMyAgents/releases)

> **Alpha.** It works, and it is used daily to build itself. Expect rough edges — read the release notes.

---

## Why this exists

One agent in one terminal is easy. The trouble starts at five: which of them is still working, which quietly failed an hour ago, which two are about to edit the same file, and what did the one you closed yesterday actually learn?

AllMyAgents is the answer to that — a hub that owns the agents, keeps their history, and gives them a way to reach each other.

## What it does

### 🤝 Agents that work together

A real intercom, not a metaphor. Any agent can message any other, and the hub delivers it into their next turn — or steers it into a turn already running, so a correction lands while it can still change the outcome.

- **`send_message`** — direct or broadcast to the fleet
- **`peek_agent`** — see what a teammate is doing *without* interrupting them
- **Shared memory** — scoped notes that outlive the chat that wrote them
- **Practices** — conventions the fleet reads and revises together

Mixed fleets are the point: a Claude agent and a Codex agent talk to each other the same way, and the transcript shows you which is which.

### 🪟 A window built for many agents at once

- **Split any way you like** — drag a chat out and drop it into any row or column layout
- **Folders, search, and status at a glance** — working, done, needs review, stalled
- **Live token and context meters**, so you see a chat approaching its limit before it gets there
- **Auto-named chats** after scientists, so "Bose" and "Ramanujan" beat `session-4f2a`

### 🧷 It does not lose your work

- **Chats in a git project get their own worktree** by default, so parallel agents never fight over your files
- **Stop preserves everything** — tracked, untracked, and in-flight
- **A live turn survives a hub restart.** The hub can update itself underneath a running agent and the turn keeps going
- **A durable journal** of everything that happened, condensed for size without destroying detail

### 📎 Give agents real files

Attach images, PDFs, spreadsheets, Word documents, code and logs — and they reach **both** vendors, whatever each one natively accepts. Paste a huge log and it becomes a tidy attachment instead of burying the chat.

### 🔐 You decide what runs

- **Safe / Edits / Full** permission modes, per chat, changeable mid-conversation
- **A project's MCP servers and hooks require your approval** before they execute — opening a folder is not consent to run the code inside it. Config the app cannot fully verify stays disabled. *(Claude today; Codex project config is not yet gated.)*
- **A Danger Zone** with a toggle for every guardrail, because it is your machine

---

## Install

### macOS

One command. Paste it into Terminal:

```bash
curl -fsSL https://raw.githubusercontent.com/nathanfraske/AllMyAgents/main/scripts/install-macos.sh | bash
```

It picks the right build for your Mac (Apple Silicon or Intel), installs to `/Applications`, opens it through macOS LaunchServices, and waits until the hub answers its health check — no Gatekeeper dialog and no extra steps. First launch can take several minutes while dependencies and vendor CLIs install, and the installer prints progress while it waits. A timeout keeps the installed app and prints the desktop log path rather than rolling the install back. It also puts an `allmyagents` command on your PATH; if the directory it chose is not already on your PATH it prints the exact line to add and offers to add it for you.

For an offline or metered install that should only place the files, append `--no-verify`:

```bash
curl -fsSL https://raw.githubusercontent.com/nathanfraske/AllMyAgents/main/scripts/install-macos.sh | bash -s -- --no-verify
```

### Uninstalling

Dragging **AllMyAgents** from Applications to the Trash removes the app, which is what most Mac apps mean by uninstalling. It leaves three things behind, because they are yours rather than the app's:

```bash
rm -rf ~/Library/Application\ Support/AllMyAgents              # chats, config, worktrees, and your vendor logins
rm -rf ~/Library/Application\ Support/direct.cec.allmyagents   # the hub's own code and logs (regenerable)
rm -f  /usr/local/bin/allmyagents ~/.local/bin/allmyagents     # the `allmyagents` command, if it was installed
```

The first path is the one that matters: it holds `profiles/`, and that is where your Claude and Codex logins live. Deleting the app alone leaves them on disk.

To remove the app, launcher, PATH line, and regenerable hub files while keeping chats and logins, run it the same way you installed it:

```bash
curl -fsSL https://raw.githubusercontent.com/nathanfraske/AllMyAgents/main/scripts/install-macos.sh | bash -s -- --uninstall
```

`bash -s --` is what forwards the flag to a script arriving on a pipe. The install command above leaves no file on your disk, so there is no local `install-macos.sh` to invoke — earlier versions of this README told you to run one, which never worked for anyone who installed the documented way.

To also permanently delete chats, settings, worktrees, and saved Claude/Codex logins, explicitly add `--purge-data`:

```bash
curl -fsSL https://raw.githubusercontent.com/nathanfraske/AllMyAgents/main/scripts/install-macos.sh | bash -s -- --uninstall --purge-data
```

<details>
<summary>Why a command instead of just the .dmg</summary>

The app is signed only ad-hoc, not notarized — notarization requires a paid Apple Developer ID.

Gatekeeper does not check every app; it checks *quarantined* apps. The `com.apple.quarantine` flag is written by whatever program downloaded the file — browsers write it, `curl` does not. So a browser download of the `.dmg` is refused with *"AllMyAgents is damaged and can't be opened"*, while the identical file fetched by the installer is never flagged and never checked.

Nothing is disabled and no signature is faked. What it does mean is that macOS is not vouching for this binary — you are, because you know where it came from. The script is deliberately short; read it first if you prefer:

```bash
curl -fsSLO https://raw.githubusercontent.com/nathanfraske/AllMyAgents/main/scripts/install-macos.sh
less install-macos.sh && bash install-macos.sh
```

Rather use the `.dmg` from [Releases](https://github.com/nathanfraske/AllMyAgents/releases)? Drag it to Applications, then run:

```bash
xattr -dr com.apple.quarantine /Applications/AllMyAgents.app
```

Don't bother right-clicking and choosing **Open** — Apple removed that override in macOS 15 Sequoia, so older instructions saying to do that no longer do anything.
</details>

### Windows

One command. Paste it into PowerShell — no administrator rights needed:

```powershell
irm https://raw.githubusercontent.com/nathanfraske/AllMyAgents/main/scripts/install-windows.ps1 | iex
```

It installs to `%LOCALAPPDATA%\AllMyAgents`, puts an `allmyagents` command on your **user** PATH, and verifies the download's size and file type before running it. Open a *new* terminal afterwards — a PATH change never reaches terminals that are already open.

<details>
<summary>Options, and why the default is not the .msi</summary>

`iex` evaluates a string and has nowhere to put arguments, so to pass options either save the file first or build a scriptblock:

```powershell
& ([scriptblock]::Create((irm https://raw.githubusercontent.com/nathanfraske/AllMyAgents/main/scripts/install-windows.ps1))) -Uninstall
```

`-Uninstall` removes the app, the command and the PATH entry (add `-KeepApp` for just the command). `-NoPath` installs the app only. `-PathOnly` repairs the `allmyagents` command against an app that is already installed. `-Tag` installs a specific release. `-Force` reinstalls the version you already have. Re-running the installer is safe: it skips the download when the same version is present and never adds a second PATH entry.

The `.msi` is a **per-machine** package — `ALLUSERS=1`, installing into `Program Files` — so it needs an elevated shell, and `msiexec /qn` cannot show a UAC prompt. The `-setup.exe` the default uses is per-user and needs nothing. `-Msi` opts into the MSI if you want a machine-wide install; run it from an administrator PowerShell.

There is no Authenticode certificate yet, so SmartScreen warns on first launch — choose **More info → Run anyway**. The installer prints the download's SHA-256 so you can compare it against the [release page](https://github.com/nathanfraske/AllMyAgents/releases).
</details>

Prefer to click things? Download the `.msi` or `-setup.exe` from [Releases](https://github.com/nathanfraske/AllMyAgents/releases) and run it.

### Linux

Build from source (below). No packaged build yet.

---

## Getting started

**1. Launch it.** From your Applications folder or Start menu — or from any terminal:

```bash
allmyagents
```

**2. Wait out the first launch.** It fetches the hub's dependencies and the vendor CLIs from npm, which takes a couple of minutes and needs an internet connection. The window tells you what it is doing.

**3. Sign in.** **Settings → Accounts**, then add the vendors you use. You can add the same vendor more than once — that is how you run several accounts side by side.

> AllMyAgents never asks for API keys. It drives the vendors' own CLI logins and the credentials stay on your machine.

**4. Add a project.** Click **+** next to *Projects* and point it at a folder on disk.

**5. Start a chat.** Press the new-chat button, pick an account and model, and send your first message. The chat names itself.

**6. Try the fleet.** Start a second chat on a different account, then ask one agent to `send_message` to the other. Watch it arrive in their transcript.

### From the command line

```bash
allmyagents              # launch the app
allmyagents --version    # print the installed version
allmyagents --help       # usage
```

---

## Updating

The app checks on launch and shows a notification when a new version exists. It never installs silently. If any chats are mid-turn it says so and offers **Update when idle**, which applies the update once the last turn finishes instead of killing work in progress.

## Build from source

Requires Node 22+, pnpm, and a Rust toolchain.

```bash
pnpm install
pnpm desktop
```

`pnpm hub:dev` runs just the hub, headless. Building a desktop bundle without the updater signing key needs the updater artifacts turned off:

```bash
pnpm --filter desktop exec tauri build --config '{"bundle":{"createUpdaterArtifacts":false}}'
```

Running the tests:

```bash
pnpm --filter hub test      # hub suite
pnpm --filter web test      # UI suite
pnpm --filter hub typecheck
pnpm --filter web check
```

## Documentation

Start with [DESIGN.md](DESIGN.md) — architecture, decisions, and the phased roadmap.

## License

MIT.
