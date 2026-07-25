# Alpha cut checklist — the exact ordered steps to publish a release

Companion to `docs/alpha-release-plan.md` (the *why*). This is the *how*: run it top to bottom.
Anything marked **⚠️ OPERATOR** needs a human decision or a secret and cannot be automated away.

Everything here assumes Windows (the alpha's primary target). The macOS half of the CI matrix builds
too, but has never been smoke-tested on real hardware — see "Known gaps" at the bottom.

---

## 0. Preconditions (once per machine)

```powershell
node --version          # 22.x — this exact Node is what gets vendored into the installer
pnpm --version          # 10.14.0 (packageManager pin)
rustc --version         # stable
pnpm install --frozen-lockfile
```

The bundler ships **the Node binary you build with**, so the release runner's Node version and
architecture are the ones every user gets. Build on the arch you're shipping.

---

## 1. ⚠️ OPERATOR — updater signing keypair (once, ever)

The updater is a code-execution path: the app will only install an update whose minisign signature
verifies against a public key baked into the binary. Until this is done, the app builds and runs fine
but **"Check for updates" reports that the updater is not configured**.

```powershell
# 1a. Generate the keypair. Choose a password when prompted; store it in your password manager.
pnpm --filter desktop exec tauri signer generate -w ./ama-updater.key

# 1b. Move the private key OUT of the repo immediately. Nothing named *.key belongs here.
Move-Item .\ama-updater.key $env:USERPROFILE\.secrets\ama-updater.key
Move-Item .\ama-updater.key.pub $env:USERPROFILE\.secrets\ama-updater.key.pub
```

Then:

1. Paste the **public** key (the `.pub` contents, one long base64 line) into
   `apps/desktop/src-tauri/tauri.conf.json` → `plugins.updater.pubkey`, replacing
   `PASTE_TAURI_MINISIGN_PUBLIC_KEY_HERE`. The public key is safe to commit.
2. In the same file flip `bundle.createUpdaterArtifacts` from `false` to **`true`**.
   *(It ships `false` so a keyless checkout can still run `pnpm desktop:build`; with it `true` and no
   private key in the environment, `tauri build` fails by design.)*
3. Add two **GitHub Actions repository secrets** (Settings → Secrets and variables → Actions):
   - `TAURI_SIGNING_PRIVATE_KEY` = the full contents of `ama-updater.key`
   - `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` = the password from step 1a (empty string if you set none)

**Losing the private key means no existing install can ever be updated again** — they'd all have to
reinstall by hand. Back it up somewhere you'd survive a disk failure.

---

## 2. ⚠️ OPERATOR — decide the version

`apps/desktop/src-tauri/tauri.conf.json` → `version` is what the bundler stamps on the installer and
what the updater compares. MSI/WiX rejects semver pre-release suffixes, so the version stays numeric
(`0.1.0`) and the **alpha marker lives only in the git tag** (`v0.1.0-alpha.1`).

Consequence: **every alpha after the first must bump the numeric version** (`0.1.0` → `0.1.1` → …),
or an installed alpha.1 will not see alpha.2 as newer and will never offer the update.

Keep `apps/desktop/src-tauri/Cargo.toml`'s `version` in sync (cosmetic, but they should not diverge).

---

## 3. Green gates

```powershell
cd apps\hub;  npx tsc --noEmit;  npx vitest run;  cd ..\..
pnpm --filter web check
pnpm --filter web test
cd apps\desktop\src-tauri;  cargo check;  cd ..\..\..
```

Expected: hub typecheck silent, hub **265 passing**, web check **0 errors**, web **123 passing**,
`cargo check` clean.

Also run the lint gate CI enforces, so a `-D warnings` failure doesn't surprise you at push time:

```powershell
cd apps\desktop\src-tauri;  cargo clippy --all-targets -- -D warnings;  cd ..\..\..
```

`.github/workflows/ci.yml` runs all of the above on **windows-latest, macos-latest and ubuntu-latest**
(the Rust half on Windows + macOS only — those are the two release targets), plus the credential
self-test and a real `hub:bundle` stage on each. CI is where the macOS half of every platform branch
in this repo is actually exercised; a Windows checkout cannot compile the `#[cfg(unix)]` code at all.

---

## 4. Credential firewall — prove the guard fires BEFORE you trust it

```powershell
pnpm run bundle:audit
```

This runs `scripts/bundle-hub.mjs --self-test`: it builds a synthetic payload seeded with one of each
leak class (`.credentials.json`, `auth.json`, a `.jsonl` rollout, `hub.db`, a `.env`, an inline
`sk-ant-…`, a baked-in `C:\Users\…` path, an authed `.npmrc`, a non-allowlisted file) and asserts the
audit rejects every one of them — and that a clean payload still passes. **All cases must pass.** If
any case reports `SELF-TEST FAILED`, the firewall has a hole; fix it before building.

Then stage the real payload, which runs the same audit for real:

```powershell
pnpm run hub:bundle
```

Look for `credential audit passed: N payload files, M of them content-scanned`. The audit throws and
fails the build on any hit, so "it built" *is* the assertion.

---

## 5. Independent credential scrub (do not rely on one check)

The bundle audit covers the *installer payload*. These cover the *repo* and the *staged tree*.

```powershell
# 5a. Nothing real is tracked by git. All three must print NOTHING.
git ls-files | Select-String -Pattern '^profiles/','^data/','\.credentials\.json$','auth\.json$','\.env$'
git ls-files | Select-String -Pattern '\.key$','\.pem$','\.jsonl$'
git status --porcelain | Select-String -Pattern 'ama-updater'

# 5b. No secret-shaped literal anywhere in tracked source.
git grep -nIE 'sk-ant-[A-Za-z0-9_-]{12,}|sk-proj-[A-Za-z0-9_-]{12,}|github_pat_|gh[pousr]_[A-Za-z0-9]{20,}|BEGIN [A-Z ]*PRIVATE KEY'
#   EXPECTED benign hits (the patterns themselves, not secrets) — anything else is a finding:
#     apps/hub/src/redact.ts        the redaction regexes
#     scripts/bundle-hub.mjs        the firewall's own patterns + its obviously-fake self-test fixture

# 5c. No operator home path baked into anything that ships.
Get-ChildItem -Recurse apps\desktop\src-tauri\hub-runtime\apps -File |
  Select-String -Pattern 'C:\\Users\\|/Users/|/home/' | Select-Object -First 20

# 5d. The staged payload really is our code + Node, nothing else.
Get-ChildItem -Recurse apps\desktop\src-tauri\hub-runtime -Directory -Depth 1 | Select-Object FullName
#   expected: hub-runtime\apps, hub-runtime\apps\hub, hub-runtime\node, hub-runtime\node\node_modules
Test-Path apps\desktop\src-tauri\hub-runtime\profiles   # must be False
Test-Path apps\desktop\src-tauri\hub-runtime\data       # must be False
```

`profiles/` and `data/` are the operator's real credentials and live journal. They are *never* copied
by `scripts/bundle-hub.mjs` (it copies from an explicit allowlist), and the audit fails the build if
they somehow appear. 5a/5d are the belt to that suspenders.

---

## 6. Build the installer locally

```powershell
pnpm desktop:build
```

`beforeBuildCommand` builds the Vite UI and re-runs `hub:bundle`, so this is self-contained.
Artifacts land under `apps/desktop/src-tauri/target/release/bundle/`:

```
bundle\msi\AllMyAgents_<version>_x64_en-US.msi
bundle\nsis\AllMyAgents_<version>_x64-setup.exe
```

First build on a machine downloads the WiX (MSI) and NSIS toolchains — that needs network and adds a
few minutes.

---

## 7. Smoke-test the INSTALLED app on a clean profile

This is the step that catches "works in dev, breaks installed", and it cannot be skipped or faked
from a source checkout. Use a **fresh Windows user account** (or a VM/sandbox) that has never run this
repo — a second account on the same box is enough, and is much closer to a real user than deleting
directories under your own.

```powershell
# On the clean account, BEFORE installing — all three must be False.
Test-Path "$env:APPDATA\AllMyAgents"
Test-Path "$env:LOCALAPPDATA\direct.cec.allmyagents"
Get-Process node -ErrorAction SilentlyContinue      # no stray hub
```

Install with the NSIS `-setup.exe` (per-user install mode: no admin prompt), launch, and verify:

1. **First-run setup window appears** ("installing dependencies") and finishes. This is the bundled
   npm fetching `better-sqlite3` + the vendor CLIs — it needs internet, once.
2. **The hub comes up** — the UI populates instead of showing a connection error.
   `Get-NetTCPConnection -LocalPort 7777` shows a listener owned by the app's node.
3. **App data landed in the right place, and ONLY there:**
   ```powershell
   Get-ChildItem "$env:APPDATA\AllMyAgents"            # data\  profiles\
   Test-Path "$env:APPDATA\AllMyAgents\data\hub.db"    # True
   Test-Path "$env:APPDATA\AllMyAgents\data\device-token.txt"   # True
   (Get-ChildItem "$env:APPDATA\AllMyAgents\profiles").Count    # 0 — ships with NO profile
   ```
   Nothing may appear under `C:\Program Files*\AllMyAgents` other than the install itself, and
   nothing at all under any repo path.
4. **The bundle shipped no credential:** the `profiles` count above is `0`, and
   `Get-ChildItem "$env:LOCALAPPDATA\direct.cec.allmyagents\hub\apps\hub" -Recurse -Include *.json |
   Select-String 'access_token|refresh_token'` prints nothing.
5. **First-run auth works:** Settings → Accounts → add a Claude account, complete the OAuth console
   flow, confirm a profile directory now exists under `%APPDATA%\AllMyAgents\profiles\` and the
   account shows up in the picker.
6. **A real turn runs end to end** — pick a project folder, send a message, get a reply.
7. **Worker mode is on and restart survival works** — start a long turn, use Settings → restart the
   hub, and confirm the turn keeps going. (Worker mode ships ON: `hub_worker_flag()` defaults to `1`.)
8. **Quit the app and confirm no orphan** — `Get-Process node` is empty afterwards.

Record anything that failed here. A failure at step 1, 2, or 3 blocks the release.

---

## 8. Tag and publish

```powershell
git switch -c release/v0.1.0-alpha.1     # never tag straight off a dirty main
git add -A
git commit -m "release: v0.1.0-alpha.1"
git push -u origin release/v0.1.0-alpha.1
# open + merge the PR, then from the merged main:
git switch main; git pull
git tag v0.1.0-alpha.1
git push origin v0.1.0-alpha.1
```

The tag push triggers `.github/workflows/release.yml`, which on each of `windows-latest` and
`macos-latest`: installs, runs the credential-firewall self-test, builds + signs the bundles,
generates `latest.json`, and attaches everything to a GitHub **pre-release**.

Then verify the release page has:

- `AllMyAgents_<version>_x64_en-US.msi` and `AllMyAgents_<version>_x64-setup.exe`
- the matching `.sig` files (only present once step 1 is done)
- `latest.json`
- the pre-release flag set

---

## 9. ⚠️ OPERATOR — the "latest" endpoint gotcha

`plugins.updater.endpoints` points at:

```
https://github.com/nathanfraske/AllMyAgents/releases/latest/download/latest.json
```

GitHub's `/releases/latest` resolves to the newest **non-prerelease**. While *every* release is an
alpha pre-release, that URL 404s and the updater will report "could not check for updates" forever.
Pick one:

- **(a)** promote one release out of pre-release so `latest` has something to resolve to, or
- **(b)** temporarily point the endpoint at the per-tag URL
  `https://github.com/nathanfraske/AllMyAgents/releases/download/<tag>/latest.json` until a stable
  release exists.

Either way, prove it before declaring the updater done: install alpha.1 on the clean profile, publish
alpha.2 with a bumped version, and confirm alpha.1 raises the update banner, installs on consent, and
relaunches on the new version. **Until that round-trip has been observed once, the updater is
scaffolding, not a feature.**

---

## 10. Release notes

- README install section: the installers, the alpha caveats, and the prerequisites
  (`docs/alpha-release-plan.md` — the Codex CLI is fetched from npm at first run, but a working
  network is required for that first run).
- Say plainly that this is a pre-release that runs agents with real credentials on the user's own
  machine, and that the Danger Zone toggles are theirs to own.

---

## 7b. macOS — the same smoke test, and what it can/can't reuse

Everything in step 7 applies, with these substitutions. It has **never been run** — see Known gaps.

```bash
# Before installing — all must be absent.
ls ~/Library/Application\ Support/AllMyAgents      # should not exist
ls ~/Library/Application\ Support/direct.cec.allmyagents
pgrep -fl node                                     # no stray hub
```

Open the `.dmg`, drag to Applications, then **right-click → Open** the first time: the build is not
notarized, so a normal double-click is refused by Gatekeeper (`xattr -dr com.apple.quarantine
/Applications/AllMyAgents.app` is the scriptable equivalent). Then verify the step-7 list, reading:

- `~/Library/Application Support/AllMyAgents/{data,profiles}` for the app-data roots (`profiles`
  must be empty — the bundle ships none).
- `lsof -nP -iTCP:7777 -sTCP:LISTEN` instead of `Get-NetTCPConnection`.
- The worker endpoint is a **unix socket**, `…/AllMyAgents/data/worker.sock`, not a named pipe.
- Adding an account opens **Terminal.app** (a generated `.command` script) rather than a cmd window.
- On quit, `pgrep -fl node` must be empty: the shell SIGTERMs the hub's process group and hubctl
  group-kills each hub + the worker (`kill_hub` in `lib.rs`, `killTree` in `hubctl.ts`).

---

## Known gaps (be honest in the notes)

- **macOS is unproven on real hardware.** CI now compiles the shell (`cargo check` + `cargo clippy`),
  runs the full hub/web suites, and stages the real installer payload on `macos-latest` — so the
  platform branches are known to *build and pass tests*. Nobody has installed and run the `.app`:
  the Finder folder picker, the Terminal.app login flow, the first-run `npm install` under the app
  bundle, and the process-group teardown have not been observed on a Mac.
- **macOS is unsigned and unnotarized**, so Gatekeeper blocks the first launch without a
  right-click → Open. The secrets and exact steps are in the `OPERATOR SETUP #2` header of
  `.github/workflows/release.yml`; it needs a paid Apple Developer membership. Note also that the
  installer embeds a **Node binary**, and a signed `.app` must have every embedded Mach-O signed —
  notarization of this bundle has never been attempted and may need an entitlements plist.
- **No Intel Mac build.** `macos-latest` is Apple Silicon only, and we deliberately do not build a
  universal binary because `scripts/bundle-hub.mjs` ships the *runner's* Node, which would stay
  arm64-only. Adding `macos-13` to the release matrix is the one-line fix (noted in `release.yml`).
- **`scripts/relaunch-worker.mjs` is Windows-only** (it finds hub processes via PowerShell/WMI). It
  is an operator repair tool, not part of the app or any gate; a macOS operator would kill and
  relaunch `hubctl` by hand.
- **Windows code signing.** The installers are not Authenticode-signed, so SmartScreen will warn on
  first run. Separate from the updater key; a real cert is an operator purchase decision.
- **Default working directory.** With no project selected, the hub's `defaultCwd` is its own staged
  hub directory under `%LOCALAPPDATA%`, which is a strange place to point an agent. Pick a project
  folder before the first turn.
- **The updater round-trip has never run** (see step 9).
