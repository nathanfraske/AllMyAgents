# Alpha release plan — AllMyAgents (initial public GitHub alpha)

**Goal.** Once the always-on worker (Phase 2) is landed + audited, ship an initial **alpha** GitHub
release: the *full installable bundle exactly as a real user would install it*, but with our dev
harnesses enabled so we (the alpha testers) can debug. Repo is public + MIT
(github.com/nathanfraske/AllMyAgents). Gated on the worker — do NOT start release work before it lands.

## ⚠️ The landmine — ship TEMPLATE profiles, never the operator's authed ones

`profiles/*/` today hold **real credentials** — `.claude.json`, Codex `auth.json`/rollout history,
tokens, session state, and machine-specific paths. A "full bundle installed as on a real system" that
carries these would **leak the operator's Anthropic/OpenAI auth into a public artifact.** So the bundle
must ship **empty/template profiles + a first-run auth flow**, and the release audit must prove no real
credential, token, session, journal row, memory file, or absolute dev path made it into either the repo
or the installer. This composes with the existing pre-push audit rules + noreply commit email.

## Definition of "parity" for alpha

- Always-on worker landed + audited: live turns + their sub-agents + running tasks survive a hub restart.
- Core UX coherent: import viewer (real last-turn times, working/errored states), restart survival,
  Danger-Zone toggles, settings, resizable panes.
- **P0 connector default resolved** (kill-switch defaulted safe + toggle) — don't ship an artifact that
  may egress to vendor cloud connectors by default. See docs/backlog.md + the P0 verify.
- Known-broken paths closed (e.g. the `/api/health` `port: 0` cosmetic bug from the blue-green promotion).
- Feature flags that ship **ON** for alpha: `HUB_SUPERVISED=1`, `HUB_WORKER_SOCKET` set. Dev harness
  kept: tsx-based hub spawn, verbose logging, feature flags visible.

## "Full bundle installed as on a real system" — what a real install exercises that a dev checkout doesn't

- **Installer.** Tauri bundler → Windows `.msi`/NSIS. `tauri.conf.json` bundle config, app identifier,
  icons, version.
- **Hub runtime inside the bundle.** For alpha (dev harness OK) ship Node + tsx + hub sources as Tauri
  sidecar/resources; hubctl spawns via the dev harness (`process.execPath --import tsx/esm`). A
  production single-binary hub compile is **post-alpha**.
- **App-data layout.** First-run materializes profiles + journal + memory into the per-user app-data dir
  (`%APPDATA%/AllMyAgents`), **not** the repo/dev cwd. Needs first-run setup + path resolution that
  doesn't assume the dev working directory. This is the biggest "works in dev, breaks installed" risk
  besides credentials.
- **Bundled web assets.** Ship the built Vite viewer (or keep the dev Vite server behind the dev-harness
  flag).
- **External prereqs.** The hub spawns `codex app-server` (needs the Codex CLI) and uses the Claude Agent
  SDK (bundled npm). For alpha, **assume the dev toolchain is present** (Node + Codex CLI) and document
  it as a prerequisite — bundling/compiling Codex + Node is post-alpha. (This is the one open call; the
  "dev harnesses enabled" framing points at assume-toolchain for alpha.)

## GitHub release mechanics

- Tag `vX.Y.Z-alpha.1`; GitHub Release marked **pre-release**.
- Attach installer artifact(s).
- Release notes / CHANGELOG; README install section with alpha caveats + prereqs + the dev-harness note.
- (Post-first-alpha) a GitHub Action to build the Tauri bundle in CI so releases aren't hand-built.

## Auto-updater (must ship IN alpha.1)

Updating a fleet of boxes by hand is the exact pain to avoid, so the updater ships in the **first** alpha —
then alpha.2+ update themselves. Tauri v2 updater, pulling straight from the **GitHub release page** (the
clean, no-extra-infra path — a dedicated update server or hosted service would be *more* infra, not less):
- **Endpoint = GitHub's stable latest-release URL**: `.../releases/latest/download/latest.json`, which always
  resolves to the newest release's manifest (version + per-platform signed installer URLs, themselves
  `releases/latest/download/<installer>`). No separate update server, no gh-pages — GitHub hosts the manifest
  and the binaries.
- **Signing keypair** — the only piece beyond GitHub, and it's just a key, not a server: public key in
  `tauri.conf.json`, private key a CI/release secret (never in the repo). The updater verifies the signature
  before installing (it is a code-exec path, so this is load-bearing).
- **CI does the work**: `tauri-action` builds + signs the bundles, generates `latest.json`, and attaches
  everything to the GitHub release on tag — so cutting a release *is* publishing an update.
- **One updater updates everything**: the hub ships inside the app bundle, so a single app update carries the
  new hub too — no separate hub-update path.
- **UX + consent** (safe-default philosophy): check on launch + a "Check for updates" button in Settings; on
  an available update, NOTIFY and let the operator click "Update now" (download → verify → install → relaunch)
  — never silent auto-install. Settings toggle for auto-check (default on). A "push to the whole fleet over
  the mesh" convenience is a nice post-alpha follow-up.

## Sequence

1. Land + audit the always-on worker. *(in progress — gates everything below)*
2. Close known-broken paths (health `port`, etc.); flip alpha feature flags on by default.
3. First-run app-data materialization + **template** profiles + path resolution off the dev cwd.
4. Tauri bundle config → produce installer; smoke-test the *installed* app on a clean Windows profile.
5. **Wire the Tauri v2 auto-updater** — signing keypair, GitHub `latest/download/latest.json` endpoint,
   `tauri-action` to build/sign/publish, check-on-launch + a Settings "Check for updates" button. **Must be
   in alpha.1** so alpha.2+ update themselves.
6. Security/credential scrub + pre-push audit (the landmine section) + P0 connector default resolved.
7. Tag + pre-release + notes — which also publishes the updater manifest, so alpha.2+ auto-update.
