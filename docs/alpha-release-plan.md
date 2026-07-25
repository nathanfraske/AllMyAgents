# Alpha release plan — AllMyAgents (initial public GitHub alpha)

**Goal.** Once the always-on worker (Phase 2) is landed + audited, ship an initial **alpha** GitHub
release: the *full installable bundle exactly as a real user would install it*, but with our dev
harnesses enabled so we (the alpha testers) can debug. Repo is public + MIT
(github.com/nathanfraske/AllMyAgents). Gated on the worker — do NOT start release work before it lands.

> **Status.** Packaging work is landed (see the ✅ markers below). What is left is not code: it is the
> **signing keypair**, the **clean-profile smoke test of the installed app**, and the **updater
> round-trip**. The ordered steps for all of it live in **`docs/alpha-cut-checklist.md`** — this
> document is the *why*, that one is the *how*.

## ⚠️ The landmine — ship TEMPLATE profiles, never the operator's authed ones

`profiles/*/` today hold **real credentials** — `.claude.json`, Codex `auth.json`/rollout history,
tokens, session state, and machine-specific paths. A "full bundle installed as on a real system" that
carries these would **leak the operator's Anthropic/OpenAI auth into a public artifact.** So the bundle
must ship **empty/template profiles + a first-run auth flow**, and the release audit must prove no real
credential, token, session, journal row, memory file, or absolute dev path made it into either the repo
or the installer. This composes with the existing pre-push audit rules + noreply commit email.

✅ **DONE — and the strongest available form of it: the bundle ships ZERO profiles.** There is no
template file for a secret to hide in.

- `scripts/bundle-hub.mjs` copies from an **explicit allowlist** (`apps/hub/dist/**/*.js` +
  `apps/hub/package.json` + the vendored Node/npm) instead of sweeping trees. Compiled unit tests are
  dropped too, so a `tsconfig` change can't quietly widen the payload.
- A **credential firewall** then walks the finished payload and **throws, failing the build**, on:
  denied file names (`.credentials.json`, `auth.json`, `.claude.json`, `hub.db`, `device-token.txt`,
  `.env*`, `.netrc`, ssh keys), denied extensions (`.pem/.key/.p12/.jsonl/.db/.sqlite`), denied path
  segments (`profiles`, `worktrees`, `.claude`, `.codex`, `.git`, `.ssh`, `.aws`), an `.npmrc`
  carrying a registry auth token, and — content-scanned across our own shipped code — inline
  `sk-ant-…`/`sk-proj-…`/GitHub tokens, PEM private keys, minisign secret keys, OAuth token literals,
  and baked-in `C:\Users\…` / `/Users/…` / `/home/…` operator paths.
- `pnpm run bundle:audit` (`--self-test`) proves the firewall fires, by running the real audit against
  a synthetic payload seeded with one of each leak class. CI runs it before every release build.
- The operator's profiles are created **on their own machine**, by their own login, into
  `%APPDATA%\AllMyAgents\profiles` (below).

## Definition of "parity" for alpha

- ✅ **DONE** — Always-on worker landed + audited: live turns + their sub-agents + running tasks survive a
  hub restart. Acceptance-PROVEN end-to-end (`docs/agent-worker-impl.md` §12, `pnpm accept:restart`).
- Core UX coherent: import viewer (real last-turn times, working/errored states), restart survival,
  Danger-Zone toggles, settings, resizable panes.
- ✅ **DONE** — **P0 connector default resolved** (#8): the hub writes `disableClaudeAiConnectors:true` into
  managed claude profiles by default (no cloud-connector egress), flippable via the Danger-Zone
  `enableClaudeConnectors` toggle. No artifact ships egressing to vendor connectors by default.
- Known-broken paths closed (e.g. the `/api/health` `port: 0` cosmetic bug from the blue-green promotion).
- Feature flags that ship **ON** for alpha: `HUB_SUPERVISED=1`, `HUB_WORKER_SOCKET` set. Dev harness
  kept: tsx-based hub spawn, verbose logging, feature flags visible.

## "Full bundle installed as on a real system" — what a real install exercises that a dev checkout doesn't

- ✅ **Installer.** Tauri bundler → Windows `.msi` + NSIS `-setup.exe`. `tauri.conf.json` now carries the
  full bundle config: `productName` `AllMyAgents`, identifier `direct.cec.allmyagents` (pre-existing —
  not invented), numeric `version`, explicit `targets` (`msi`, `nsis`, `app`, `dmg`), icons, publisher,
  license/copyright, description, and NSIS **per-user** install mode (no admin prompt, which matters
  because first run writes to the user's own app-data).
- ✅ **Hub runtime inside the bundle.** The installer ships our compiled hub (`dist/`) plus a Node
  runtime + npm; the runtime deps and vendor CLIs are fetched by npm on the user's machine at first
  launch, so nothing vendor is redistributed. A production single-binary hub compile is **post-alpha**.
- ✅ **App-data layout.** RELEASE builds now materialize and pass explicit roots to the hub:
  - `HUB_DATA_DIR` → `%APPDATA%\AllMyAgents\data` — journal, config, worktrees, device token.
  - `HUB_PROFILES_DIR` → `%APPDATA%\AllMyAgents\profiles` — the managed vendor logins (created EMPTY).
  - The app's own regenerable code (staged `dist/` + the fetched `node_modules`) stays in
    `%LOCALAPPDATA%\direct.cec.allmyagents\hub`, deliberately separate so wiping/reinstalling it can
    never take the operator's chats and logins with it.
  - `hubctl` forwards its whole env to every hub it supervises, so both roots survive a blue-green
    restart. Nothing is resolved off the process cwd, the repo, or the read-only install dir.
  - **The DEV path is untouched**: `tauri dev` still spawns `pnpm hubctl:dev` with neither env var set,
    so a checkout keeps using the repo's `data/` + `profiles/` byte-identically.
  - Fixed along the way: the device token was hardcoded to `repoRoot/data` and so would have split
    away from the rest of an installed build's state; it now follows `HUB_DATA_DIR` like everything
    else (identical path when the var is unset).
- ✅ **Bundled web assets.** The built Vite viewer is embedded via `frontendDist`; `beforeBuildCommand`
  builds it and re-stages the hub payload, so `pnpm desktop:build` is self-contained.
- **External prereqs.** The hub spawns `codex app-server` (needs the Codex CLI) and uses the Claude Agent
  SDK — both fetched from npm at first launch, so the only hard prerequisite is **a working network on
  first run**. Document it in the README.

## GitHub release mechanics

- ✅ `.github/workflows/release.yml` builds on `windows-latest` + `macos-latest` on a `v*` tag, runs the
  credential-firewall self-test first, and publishes a **pre-release** with the installers.
- Tag `vX.Y.Z-alpha.1`; GitHub Release marked **pre-release**.
- Release notes / CHANGELOG; README install section with alpha caveats + prereqs + the dev-harness note.
- ⚠️ **Versioning gotcha:** MSI/WiX rejects semver pre-release suffixes, so `tauri.conf.json`'s `version`
  stays numeric (`0.1.0`) and the alpha marker lives only in the tag. **Every alpha after the first must
  bump the numeric version**, or installed builds will not see the new one as newer.

## Auto-updater (must ship IN alpha.1)

Updating a fleet of boxes by hand is the exact pain to avoid, so the updater ships in the **first** alpha —
then alpha.2+ update themselves. Tauri v2 updater, pulling straight from the **GitHub release page** (the
clean, no-extra-infra path — a dedicated update server or hosted service would be *more* infra, not less):
- **Endpoint = GitHub's stable latest-release URL**: `.../releases/latest/download/latest.json`, which always
  resolves to the newest release's manifest (version + per-platform signed installer URLs, themselves
  `releases/latest/download/<installer>`). No separate update server, no gh-pages — GitHub hosts the manifest
  and the binaries. ✅ configured in `plugins.updater.endpoints`.
- **Signing keypair** — the only piece beyond GitHub, and it's just a key, not a server: public key in
  `tauri.conf.json`, private key a CI/release secret (never in the repo). The updater verifies the signature
  before installing (it is a code-exec path, so this is load-bearing).
  ⚠️ **NOT DONE — operator action required, and no key of any kind is in this repo.**
  `plugins.updater.pubkey` holds the literal placeholder `PASTE_TAURI_MINISIGN_PUBLIC_KEY_HERE`, and
  `bundle.createUpdaterArtifacts` is **`false`** so that a keyless checkout still builds. Exact commands:
  `docs/alpha-cut-checklist.md` step 1.
- **CI does the work**: `tauri-action` builds + signs the bundles, generates `latest.json`, and attaches
  everything to the GitHub release on tag — so cutting a release *is* publishing an update. ✅ wired.
- **One updater updates everything**: the hub ships inside the app bundle, so a single app update carries the
  new hub too — no separate hub-update path.
- ✅ **UX + consent** (safe-default philosophy): the desktop shell exposes two Rust commands —
  `updater_check` (read-only; downloads and installs nothing) and `updater_install` (download → verify
  signature → install → relaunch), reachable from the UI only through an explicit click. The web side
  (`apps/web/src/lib/updater.svelte.ts`) reaches them through the existing `window.__TAURI__` global
  bridge, so apps/web gains **no new npm dependency**. Check-on-launch raises a
  notification banner (`UpdateBanner.svelte`) with **Update now / Later**; Settings → Updates has a
  "Check for updates" button, the available-version state, and an auto-check toggle (default on).
  There is no code path that installs without consent. A "push to the whole fleet over the mesh"
  convenience is a nice post-alpha follow-up.
- ⚠️ **Unproven.** The full round-trip (alpha.1 installed → alpha.2 published → banner → consent →
  relaunch on the new version) has never been observed, and `/releases/latest` 404s while every release
  is a pre-release. See `docs/alpha-cut-checklist.md` step 9. Until that round-trip runs once, treat the
  updater as scaffolding, not a shipped feature.

## Sequence

1. ✅ Land + audit the always-on worker. *(Acceptance-PROVEN end-to-end: a live Claude turn survives a
   real mid-turn hubctl blue-green restart. See `docs/agent-worker-impl.md` §12; reproduce with
   `pnpm accept:restart`. Flag-off stays byte-identical.)*
2. Close known-broken paths (health `port`, etc.); flip alpha feature flags on by default. *(Worker mode
   ships ON by default — `hub_worker_flag()` in `apps/desktop/src-tauri/src/lib.rs`.)*
3. ✅ First-run app-data materialization + **template** (zero) profiles + path resolution off the dev cwd.
4. ✅ Tauri bundle config → produces `.msi` + NSIS `-setup.exe`.
   ⬜ **Smoke-test the *installed* app on a clean Windows profile** — `docs/alpha-cut-checklist.md`
   step 7. This is the one that catches "works in dev, breaks installed" and it cannot be faked from a
   source checkout.
5. ✅ Wire the Tauri v2 auto-updater — endpoint, `tauri-action` publish, check-on-launch + Settings
   button, notify-then-consent. ⬜ **Signing keypair + the flip of `createUpdaterArtifacts`** (operator),
   ⬜ the endpoint decision for pre-releases, ⬜ the observed round-trip.
6. ✅ Security/credential scrub automated in the bundler + CI (the landmine section) + P0 connector
   default resolved. ⬜ The manual repo-side scrub commands at cut time
   (`docs/alpha-cut-checklist.md` step 5).
7. ⬜ Tag + pre-release + notes — which also publishes the updater manifest, so alpha.2+ auto-update.

## Still open, and honest about it

- **No code signing.** Neither Windows Authenticode nor macOS notarization. SmartScreen and Gatekeeper
  will both warn. An operator purchase decision, orthogonal to the updater key. `release.yml` already
  reads every `APPLE_*` / `WINDOWS_CERTIFICATE*` secret and skips signing while they are empty, so
  turning it on is "add the secrets", not "change the workflow" — see its `OPERATOR SETUP #2` header.
- **macOS is built and CI-verified but unproven on hardware** — `macos-latest` compiles the shell,
  runs the hub + web suites, and stages the real installer payload, but nobody has installed and run
  the `.app`. `macos-latest` is Apple Silicon only, so there is no Intel build (deliberate: the
  bundler ships the runner's own Node, so a universal app would still carry an arm64-only runtime).
- **`defaultCwd`.** With no project selected, the hub's fallback working directory is its own staged
  hub dir under `%LOCALAPPDATA%` — a strange place to point an agent. Harmless if a project is picked
  first; worth changing to the user's home before a non-alpha release.
