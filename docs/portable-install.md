# Portable install — shipping the desktop app with a self-contained hub

Implementation notes, 2026-07-24. Makes the **AllMyAgents** Tauri desktop app run on a machine that
has **no repo, no pnpm, and no dev environment**. Before this change the shell only worked from the
source tree: `apps/desktop/src-tauri/src/lib.rs` spawned `pnpm hub:dev` from a compile-time repo path
(the old `TODO(prod)`). Now the release build ships a runnable hub and a Node runtime, and installs the
hub's dependencies on the user's machine on first launch.

Touched only: `apps/desktop/**`, `scripts/bundle-hub.mjs` (new), `apps/hub/package.json` (+ new
`apps/hub/tsconfig.build.json`), and root `package.json`. **No hub runtime logic changed.**

---

## 1. Approach — light installer + first-run dependency install

The installer contains **only our own code plus a Node runtime**. The hub's real dependencies — the
native `better-sqlite3` addon and the vendor CLIs (`@anthropic-ai/claude-code`, `@openai/codex`,
`@anthropic-ai/claude-agent-sdk`) — are **fetched from the npm registry by `npm install` on the user's
machine, once, on first launch.** They are never in the installer.

Why this shape, and not an offline all-in-one bundle:

- **Licensing / redistribution.** Bundling the vendor CLI binaries into a public installer would mean
  *we* redistribute Anthropic's and OpenAI's binaries. Fetching them from npm at runtime means the
  **user's** machine pulls them from the official registry — exactly like a normal `npm install` — so
  we redistribute nothing vendor-specific. (See §6.)
- **Size.** The offline bundle was measured at **~1.28 GB** (the vendor CLIs alone: two `claude.exe`
  copies + the Rust `codex.exe` toolset). The light payload is **~93 MB**, almost entirely Node itself.
- **Native module correctness.** `npm install` on the target machine resolves the platform-matching
  prebuilt `better-sqlite3` `.node` and the correct-arch vendor binaries for *that* machine.

Node is bundled (rather than requiring system Node) so the app is self-contained; Node is **MIT** and
freely redistributable. If the bundled Node is ever missing, the release path falls back to a system
`node` on `PATH`.

### Why a copied `dist` + `npm install`, not an esbuild single-file bundle

The hub compiles with `tsc` to `apps/hub/dist` preserving its module structure (a build tsconfig,
`apps/hub/tsconfig.build.json`, adds `outDir`/`rootDir`; `pnpm hub:build` runs it). A single esbuild
bundle was rejected because the hub's runtime path math is **`import.meta.dirname`-relative** and must
keep resolving after bundling:

| Source | Derives | Used for |
|---|---|---|
| `apps/hub/src/index.ts` | `repoRoot = import.meta.dirname/../../..` | `data/` (SQLite db, device token), `profiles/` |
| `apps/hub/src/loginLauncher.ts` | `binDir = import.meta.dirname/../node_modules/.bin`; `repoRoot = ../../..` | login console `PATH` + cwd |

Keeping the compiled files at `…/apps/hub/dist/*.js` (with `node_modules` one level up at
`…/apps/hub/node_modules`) makes those derivations resolve exactly as in dev. That layout, plus the fact
that the native addon and the separately-spawned vendor CLIs **cannot** be inlined by any bundler
anyway, makes "ship `dist` + do a normal flat `npm install`" the reliable choice.

**Why `npm`, not a copy of the pnpm store:** pnpm's `node_modules` is a symlink farm and its `.bin`
shims bake **absolute dev-machine paths** into `NODE_PATH` (verified: they point at
`C:\Users\…\node_modules\.pnpm\…`). A fresh `npm install` produces a flat, relocatable tree with
relative `.bin` shims and pulls the host platform's `optionalDependencies` (the native `.node` and the
vendor binaries). That is what the first-run install does on the user's machine.

---

## 2. What ships in the installer

`scripts/bundle-hub.mjs` (Node built-ins only) stages the payload to
`apps/desktop/src-tauri/hub-runtime/`, declared as a Tauri **resource** (`bundle.resources:
["hub-runtime/**/*"]`). It contains **no `node_modules` and no vendor binaries** (the script asserts
this):

```
hub-runtime/
  apps/hub/
    dist/            index.js, adapters/…, server.js, …   (tsc output — OUR code, ~0.1 MB)
    package.json                                          (prod-only, versions PINNED)
  node/
    node.exe                                              (Node v22.18.0, MIT — ~81 MB)
    node_modules/npm/…                                    (npm, so first-run install needs nothing)
```

The shipped `package.json` pins the prod deps to the versions the workspace currently resolves
(`@anthropic-ai/claude-agent-sdk@0.3.218`, `@anthropic-ai/claude-code@2.1.218`, `@openai/codex@0.145.0`,
`better-sqlite3@12.11.1`, `ws@8.21.1`), so the first-run install reproduces the validated set instead of
drifting to `latest`.

**Payload:** 2269 files, **92.6 MB** (Node runtime + npm 92.5 MB; our code 0.1 MB).
**Resulting installers (`tauri build`, targets `all`, Windows x64):**

| Installer | File | Size |
|---|---|---|
| NSIS | `target/release/bundle/nsis/AllMyAgents_0.0.1_x64-setup.exe` | **26.3 MB** |
| MSI  | `target/release/bundle/msi/AllMyAgents_0.0.1_x64_en-US.msi`  | **39.6 MB** |

Both embed the ~93 MB payload, compressed (LZMA/cab). For comparison, the rejected offline bundle
(vendor CLIs included) was **~1.28 GB** of payload.

Node is shipped as a **resource** (not a `bundle.externalBin` sidecar) because the release path spawns
it from Rust with `std::process::Command` and an explicit script path; the sidecar naming convention
(`$TRIPLE` suffix) and its shell-plugin spawn API buy nothing here.

---

## 3. Dev vs. release — how the spawn branches (`lib.rs`)

`spawn` branches on `cfg!(debug_assertions)`:

- **Dev (debug build, `pnpm desktop`)** — **unchanged.** `spawn_hub_dev()` runs `cmd /C pnpm hub:dev`
  from the compile-time repo root, stores the `Child`, and tree-kills it on exit. The reachability guard
  ("already listening on `127.0.0.1:7777` → don't spawn") is preserved.

- **Release (bundled app)** — `release_boot()` runs on a background thread (so `setup()` returns and the
  window renders immediately):
  1. Reachability guard (same as dev).
  2. Resolve the read-only payload + Node via `app.path().resource_dir()`, and a **writable hub home**
     via `app.path().app_local_data_dir()` → `…/AllMyAgents/hub`. This is the hub's runtime `repoRoot`,
     so the entry must sit at `…/hub/apps/hub/dist/index.js` (three levels below home → `data/` +
     `profiles/` land under `…/hub`, which is user-writable regardless of where the app is installed).
  3. Copy `apps/hub/{dist,package.json}` out of resources into the hub home.
  4. **Deps check:** a marker file `…/apps/hub/node_modules/.ama-deps-ok` holds the last-installed
     manifest. If it is missing or differs from the shipped `package.json` (first run, or an app update
     changed deps), run the bundled npm:
     `node node_modules/npm/bin/npm-cli.js install --omit=dev` in `…/apps/hub`, then write the marker.
  5. Spawn `node …/apps/hub/dist/index.js` with `cwd = hub home` and
     `PATH = <hub node_modules/.bin> ; <bundled node dir> ; <inherited PATH>`.
     The `PATH` additions are load-bearing: the codex adapter spawns `codex app-server` through a shell
     (`shell:true`), so `codex` must resolve from the hub's `.bin`, and the npm-generated `codex.cmd`
     shim falls back to `node` on `PATH`. (Claude needs no `PATH` help — the Agent SDK resolves
     `claude.exe` via `createRequire(import.meta.url).resolve(...)`, i.e. module resolution.)
  6. Store the `Child` in managed state and tree-kill it on exit, exactly as dev.

`app_local_data_dir` (not `app_data_dir`) is used so the ~100 MB of installed deps and the SQLite db do
**not** roam, and don't sit in the (possibly read-only, e.g. Program Files) install directory.

---

## 4. First-run UX + failure handling

When an install is pending, `setup()` opens a small always-on-top **setup window** (a self-contained
`data:` HTML page built in `lib.rs` — no web-app changes) reading *"First-run setup — installing
dependencies…"* with a spinner. It closes automatically once the hub is listening (polled, 60 s cap).

If the install fails (the common cause is **no internet on first run**), the window flips to an error
state — *"Could not download dependencies… an internet connection is required the first time"* — and
stays open and closeable so the user can read it; the hub is not spawned. Re-opening the app once online
retries (the marker was never written). The setup window is best-effort: if it can't be created the
install/spawn still proceed, and the web UI shows its normal "connecting" state.

Subsequent launches: the marker matches → no window, straight to spawn (the hub is up in well under a
second, same as dev).

---

## 5. Build + commands

- `pnpm hub:build` — `tsc -p apps/hub/tsconfig.build.json` → `apps/hub/dist` (added to
  `apps/hub/package.json`).
- `pnpm hub:bundle` — `node scripts/bundle-hub.mjs`; stages the light payload.
- `pnpm desktop:build` — `tauri build`. Its `beforeBuildCommand` is
  `pnpm --filter web build && pnpm -w run hub:bundle`, so a single command builds the web UI, stages the
  hub payload, compiles the shell, and produces the installers. (`pnpm -w run` targets the workspace
  root regardless of `beforeBuildCommand`'s working directory.)
- `pnpm desktop` (tauri dev) is untouched — `beforeDevCommand` does **not** run the bundle step.

The generated `apps/desktop/src-tauri/hub-runtime/` is git-ignored (never commit the Node/npm binaries).

---

## 6. Licensing — the redistribution question, flagged

- **Node** — MIT. Bundling `node.exe` + `npm` in the installer is fine.
- **Our code** — the repo is MIT; the compiled `dist` is ours.
- **Vendor CLIs** (`@anthropic-ai/claude-code`, `@anthropic-ai/claude-agent-sdk`, `@openai/codex`) — **not
  bundled.** The user's machine downloads them from npm at first run, so this app does not redistribute
  them. That is the deliberate reason for the first-run-install design.
  - For the **owner's personal fleet**, bundling them would also have been fine.
  - For **public MIT distribution**, redistributing the vendor binaries would be a real licensing
    question (their terms are not the app's MIT licence); the runtime-install approach sidesteps it.
- **Accounts stay the user's.** The installer ships **no** credentials, `data/`, `profiles/`, or `.env`.
  Every user still logs into their own Claude / Codex accounts at runtime (the login flow in
  `loginLauncher.ts` opens each vendor's own OAuth in a console window). The bundle is code + Node only.

---

## 7. Validation + caveats

**Validated on this machine (Windows 11, x64):**

- `pnpm hub:build` compiles clean; `dist/index.js` keeps its `import.meta.dirname` derivations.
- `better-sqlite3` loads under the bundled plain Node (`require` smoke test passed).
- The vendor resolution model was confirmed by inspecting the packages: the Agent SDK resolves
  `claude.exe` via module resolution; the codex launcher resolves `@openai/codex-win32-x64/…/codex.exe`
  via `require.resolve`; both work from a flat npm tree. An earlier full flat `npm install --omit=dev`
  produced all of them (`claude.exe`, `codex.exe`, prebuilt `.node`) — that is exactly what the
  first-run install now does on the user's machine.
- `cargo check` passes.
- `pnpm desktop:build` (headless) **succeeded, exit 0.** `beforeBuildCommand` built the web UI and
  regenerated the payload; the release shell compiled; both installers were produced (sizes in §2). The
  installer size jump vs. the pre-change shell (2.5 MB → 26.3 MB NSIS) confirms the payload is embedded.

**Could not be validated here:** a true clean-machine launch (no Node, no repo) — the first-run
`npm install` + hub spawn was not exercised end-to-end inside this dev environment; it is reasoned from
the confirmed resolution model and the successful flat-install test. A real smoke test is: install the
`.exe`/`.msi` on a fresh Windows VM with no Node, launch once online, confirm the setup window appears
and the hub reaches `127.0.0.1:7777`.

**Caveats / gotchas:**

- **First run needs the internet.** The one-time dep download is ~200 MB from npm. Offline first-run
  fails gracefully (§4) and retries when online.
- **`better-sqlite3` prebuild.** The install relies on a prebuilt `.node` for the bundled Node's ABI
  (Node 22 / win-x64 — available). If a prebuild is ever unavailable it would fall back to a node-gyp
  compile needing MSVC build tools, which a clean machine lacks. Keep the bundled Node on a version with
  published `better-sqlite3` prebuilds.
- **Build on the target platform.** `bundle-hub.mjs` ships the Node that runs it, and the first-run
  install resolves host-platform binaries. Build the Windows installer on Windows, macOS on macOS, etc.
  (cross-building would need `--os/--cpu` install flags and a matching Node — not wired up).
- **`spawnSync … .cmd EINVAL`.** Node ≥18.20/20.12/22 refuses to spawn `.cmd` files without a shell
  (CVE-2024-27980); the bundle script invokes `npm` with `shell:true` for this reason, and the release
  path invokes npm as `node npm-cli.js` (not `npm.cmd`) to avoid it entirely.
- **Data lives in `app_local_data_dir`.** Uninstalling won't necessarily remove `…/AllMyAgents/hub`
  (installed deps + db + profiles); that's intentional (keeps accounts across reinstalls) but worth a
  note for a future "reset" affordance.
- **`node_modules` counts as bundled resources.** Only the payload's ~2269 files are resources; npm's
  many small files inflate the file count but not much size.
