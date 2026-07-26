# AllMyAgents

Self-hosted hub + GUI for managing Claude Code and OpenAI Codex agents — many accounts per vendor, Windows + WSL nodes, any agent promotable to orchestrator, shared per-project memory, phone remote over a self-hosted mesh.

**Alpha.** It works and is used daily, but expect rough edges — read the release notes.

## Install

### macOS

One command. Paste it into Terminal:

```bash
curl -fsSL https://raw.githubusercontent.com/nathanfraske/AllMyAgents/main/scripts/install-macos.sh | bash
```

It picks the right build for your Mac (Apple Silicon or Intel), installs to `/Applications`, and the app then opens normally — no Gatekeeper dialog and no extra steps.

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

Download the `.msi` (or `-setup.exe`) from [Releases](https://github.com/nathanfraske/AllMyAgents/releases) and run it. SmartScreen warns on first launch — there is no Authenticode certificate yet. Choose **More info → Run anyway**.

### Linux

Build from source (below). No packaged build yet.

### First launch

Needs an internet connection: the app fetches the hub's dependencies and the vendor CLIs from npm, which takes a couple of minutes. The window says so while it works.

You then sign in to whichever vendors you use, under **Settings → Accounts**. The app never asks for API keys — it drives the vendors' own CLI logins, and the credentials stay on your machine.

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

## Documentation

Start with [DESIGN.md](DESIGN.md) — architecture, decisions, and the phased roadmap. Phase 0 spike instructions are in DESIGN.md §8.

## License

MIT.
