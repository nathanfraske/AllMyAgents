# Project-owned fleet CI and release routing

The normal `CI` workflow uses the qualified local fleet for trusted, same-repository
Windows x64, Linux x64 and Intel Mac jobs. It no longer depends on an unset
`TEST_FLEET_CI` repository variable or the obsolete `test-fleet` runner labels.
Fork pull requests stay on GitHub-hosted runners. The manual `runner_mode=hosted`
input is an explicit diagnostic comparison; it runs every check. The legacy
`qualify_local` input remains accepted but cannot override that choice or admit forks.

## Exact routing contract

| Work | Runner |
| --- | --- |
| CI Windows JS and Rust | `self-hosted, Windows, X64, fleet-general-windows` |
| CI Linux JS | `self-hosted, Linux, X64, fleet-general-linux` |
| CI Intel Mac JS and Rust | `self-hosted, macOS, X64, fleet-general-macos` |
| CI Apple Silicon JS and Rust | GitHub-hosted `macos-latest` |
| Release Windows installers | `self-hosted, Windows, X64, fleet-general-windows` |
| Release Linux amd64 node | `self-hosted, Linux, X64, fleet-general-linux` |
| Release Linux arm64 node | GitHub-hosted `ubuntu-24.04-arm` |
| Release both Mac architectures, installed-app and launch/repair verification | Existing GitHub-hosted jobs |

Intel Mac CI is additive: no existing matrix entry, test, architecture, timeout or
signing/publication gate was removed. The successful fleet full-build comparison is
not evidence of installed-app, Gatekeeper or updater-signing qualification on local
Macs. Those release gates therefore remain hosted. The Linux amd64 release still
uses its Ubuntu 22.04 compatibility container and requires Docker on the runner.

The adapter contract comes from commit
`303f79d4719ea39088cedf1f00a64ff321ed8bad`, branch
`fleet/lan-cached-full-build-20260928-v1`. Its five full-check/full-build jobs passed
in [qualification run 36379322016](https://github.com/nathanfraske/AllMyAgents/actions/runs/36379322016).
This is source/runner contract evidence, not a promise of current spare capacity.
The fleet controller must admit the normal CI/release workflow and provision the
exact labels above. Zero runners between jobs is not itself a failed qualification.
No controller, resource grant, machine or credential setting is changed by these scripts.

## Persistent cache and tool setup

`node scripts/fleet-build-cache.cjs` runs after Node setup and before the unchanged
`pnpm install --frozen-lockfile`. It checks the exact repository, x64 architecture,
pinned pnpm version and `RUNNER_TOOL_CACHE` location before using:

| Platform | Existing mount root | Writable root |
| --- | --- | --- |
| Windows | `D:\TestFleetCache` | Same |
| Linux | `/var/cache/test-fleet` | `/var/cache/test-fleet/user` |
| Intel Mac | `/Volumes/TestFleetCache` | Same |

The tool cache must be `<mount>/toolcache`. Build caches live beneath
`<writable>/build-cache-v1/nathanfraske--AllMyAgents/<platform>-x64`, with separate
`pnpm-store` and `cargo-target` directories. pnpm integrity checking remains enabled;
at least 8 GiB must be free. Missing mounts and linked path ancestors fail closed.
No token-bearing LAN proxy configuration is copied into the project: this change
uses the qualified persistent disk cache, not the separate LAN proxy wrapper.
Hosted jobs retain the existing Actions pnpm/Rust caches.

Windows retains the fleet's reviewed `setup_windows_release.ps1` and
`resources_job.mjs` resource-budget contract. Cargo's JSON compiler artifact selects
the exact Windows test executable, including when `CARGO_TARGET_DIR` is external.
Before a local release build, `node scripts/fleet-build-cache.cjs --prepare-release`
removes only the checked generated `cargo-target/release/bundle` directory. Compiled
dependencies stay cached; stale installers cannot enter the new upload.

## Verification and rollout

`node --test scripts/fleet-runner-contract.test.mjs` checks routing for trusted/fork
events and hosted diagnostics, the original matrices and gate bodies/order, cache
confinement and safe generated-output cleanup. The baseline fixture pins the prior
release candidate `4040a0589d3adee13e9d34f6967e09453d8ae128`; do not regenerate it
merely to silence an unexpected gate change.

Push one reviewed PR head and inspect its natural CI jobs, including actual runner
names/labels and full step results. Do not create a second manual qualification run
for the same work. Merge only after that head is green; then verify main and normal
release preflight before tagging. A queued job is an admission/capacity diagnostic,
not authority to change the fleet controller or silently fall back to hosted work.
The tag's existing launch-and-repair gate owns its child verification dispatches.

The hosted Windows run on the prior head failed two recovery tests at their original
5/30-second deadlines and reported a late manager timer reading a closed database
([job 109053459447](https://github.com/nathanfraske/AllMyAgents/actions/runs/36459280501/job/109053459447)).
The timer has a deterministic shutdown regression and explicit lifecycle cleanup.
Both recovery tests passed unchanged in focused local run
`60a850c0-26c8-4af9-bee6-3aa2542e3b87` (1.865 s and 2.506 s respectively).
Their hosted timeout cause remains unproven; their complete tests and deadlines
remain required on the new CI head, without skips or blanket timeout increases.

Local evidence: runner/cache plus release-policy tests passed 14/14 in durable run
`6ca7ba68-55b6-49dc-a434-90668d076850`. Shutdown tests failed before the repair in
`751c4677-44d8-43e2-beef-928b8d5c0f76`; afterward all 297 tests across five complete
manager/recovery/Overseer/worker suites passed in `4b29a953-cc8f-46e5-a95b-f62e1daafd89`,
and typechecking passed in `a505f967-e4bf-41f4-b60f-03f3c481bcaa`.
