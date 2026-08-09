# Hardware hub and fleet ideas

Idea log, 2026-08-08. This document preserves product exploration; it is not a claim that the features
below are implemented. Concrete remote-testbed behavior lives in `docs/remote-device-testbeds.md` and
mesh behavior in `docs/mesh-unified-fleet.md`.

## Product thesis

An always-on AllMyAgents hub should be useful even when it cannot run a frontier model locally. Its main
job is a durable, vendor-neutral control plane: keep the journal and project graph available, coordinate
agents running on other machines, route work to the best environment, enforce authority, retain evidence,
and let an Overseer diagnose the fleet while an execution workstation is asleep or broken.

The local model is an optional control-plane coprocessor, not the product boundary. Small models are best
used for cheap classification, retrieval, summarization, failure triage, scheduling proposals, and privacy-
sensitive preprocessing. Claude/Codex or a large local workstation model remains responsible for difficult
reasoning and code changes.

## Hardware tiers

### 8 GB accelerator board (Jetson Orin Nano Super class)

Best when the hub also needs vision or low-latency local inference: screenshot/OCR triage, camera or KVM
inspection, embedding, reranking, compact classifiers, and a small quantized model. It is a poor place for
large builds, many containers, or a large database page cache. Favor NVMe, bounded services, and remote
execution placement. GPU ecosystem maturity is its differentiator, not RAM capacity.

### 16 GB general-purpose board or mini-PC

The practical default control-plane tier. An Intel N100-class x64 mini-PC offers conventional Linux/Windows
tooling, NVMe, inexpensive RAM/storage, GitHub Actions compatibility, and fewer packaging surprises. An ARM64
or RISC-V board can be attractive for power, form factor, or architecture testing, but requires stronger
release discipline and more remote build capacity. Sixteen gigabytes supports the hub, database, search,
several services, and a modest local model if concurrency stays bounded.

### 32 GB board or mini-PC

Useful when one appliance must simultaneously host a larger index/page cache, several containers, more
parallel coordinators, heavier local inference, or multiple test VMs. The extra memory buys concurrency and
cache residency more than fundamentally different hub features. If a specialized 32 GB SBC costs as much as
a serviceable x64 mini-PC, choose the mini-PC unless its accelerator, I/O, power envelope, or target
architecture is itself part of the testbed.

### Very small RISC-V control box

Treat this as a vendor-free run-box: journal/control state, web/API, policy, durable message broker, mesh,
and placement. It should route Claude/Codex execution to authenticated x64/ARM64 workers rather than pretend
vendor CLIs run locally. It is valuable as a portability and recovery target even without local inference.

## High-value control-plane services

- Durable project, team, task, approval, provenance, and journal ownership.
- Placement broker based on OS, architecture, GPU, WSL/container/VM availability, latency, load, battery,
  account quota, and the permissions a task actually needs.
- Context refinery: bounded transcript compaction, semantic retrieval, project status snapshots, dependency
  maps, and vendor-neutral handoff packets.
- Fleet health: hub/process/account/session status, stalled-work detection based on progress rather than
  elapsed time, workspace/storage pressure, route quality, and failure escalation to the local Overseer.
- Artifact broker: content-addressed build outputs, resumable device transfers, cache manifests, checksums,
  and attribution to agent/session/commit.
- Policy authority: project and device grants, blast-radius analysis, elevated-command brokering, GitHub
  automation policy, audit records, and revocation.
- Work scheduler: keep managers using their requested parallelism, recognize idle loops, stop quota-exhausted
  assignments, compact or succeed long-running chats, and create bounded successor agents when necessary.
- Offline service: queue work and messages while workers sleep; restore the exact project/team topology when
  they return; keep a local read-only diagnostic path when the main journal or account cache is unavailable.
- Cross-vendor evaluation: dispatch the same bounded review to different vendors/models, normalize evidence,
  compare findings, and escalate disagreements instead of silently voting.
- Device lab coordination: reserve physical or virtual testbeds, snapshot their capabilities, run matrices,
  collect logs/artifacts, and return measured latency/transfer/failure feedback.

## Local-model jobs beyond chat

- Classify failures and select a diagnostic playbook.
- Summarize noisy logs before sending only relevant evidence to a paid model.
- Maintain embeddings and rerank project memories locally.
- Detect secrets/PII and propose redaction before external model calls.
- Estimate task size, likely context pressure, and useful parallel slices.
- OCR/vision for remote KVM, mobile simulator, or embedded-device screens.
- Generate health explanations when the network or vendor account is offline.
- Watch for repetitive/no-progress behavior and alert rather than autonomously widening permissions.

All local-model decisions that affect authority, deletion, publication, or elevated execution remain
proposals until a deterministic policy or operator approval admits them.

## Automatic GitHub Actions runners

The hub can offer an operator-owned runner enrollment workflow for each capable device:

1. Discover OS/architecture, toolchain, isolation support, free disk, and whether the device is an appliance
   that should never execute repository code.
2. Ask for repository/organization scope and acquire a short-lived registration or just-in-time runner
   configuration through GitHub's supported API/CLI flow. Never persist the one-hour registration token.
3. Install the official runner for supported x64/ARM64/ARM32 targets, verify its checksum, create a dedicated
   OS identity and work directory, and register explicit labels such as `allmyagents`, device id, OS,
   architecture, GPU, WSL, and lab capabilities.
4. Prefer ephemeral/JIT runners for untrusted or heterogeneous jobs. A persistent runner is opt-in and
   receives health, update, disk-pressure, and stale-registration monitoring.
5. Expose runner groups and repository allow-lists in the app. Private-repository jobs must never spill onto
   an unintended shared machine.
6. Journal enrollment, labels, job identity, agent/session/project attribution, artifacts, and teardown
   without storing GitHub secrets in transcripts.

If GitHub's official runner does not support a target architecture, that hub should dispatch Actions
jobs to a supported worker or use a deliberately maintained compatibility bridge, never report native runner
support it does not have. The Overseer may recommend and configure this flow only on a direct operator turn.

## Fleet trust and data movement

- Same-fleet convenience must rest on the signed AllMyStuff owned-device roster, like the KVM privileged
  planes. Presence, a sighted peer, or an arbitrary shared mesh is reachability—not authorization.
- A signed-roster peer can exchange hub capabilities reciprocally in one authenticated RPC operation. An
  outside peer uses a short-lived code. Neither path should require a second reverse ceremony.
- Keep hub identity local: every Overseer governs only its minting hub. Cross-hub Overseers communicate over
  an authenticated peer channel but cannot usurp one another.
- Remote file operations preserve directories, empty directories, checksums, byte counts, throughput,
  resumability, and explicit source/destination roots. Symlinks and junctions fail closed at containment
  boundaries.
- Conversation mutations carry stable request ids, journal sequence identity, and source-hub provenance so
  retries are idempotent and transcript order is journal order rather than wall-clock order.

## Unified projects across devices

A project should be one fleet-global logical identity with zero or more device-local replicas, not a path
owned by whichever hub first created it. Paths and display names are mutable presentation/placement facts;
they must never merge two projects or transfer authority.

```text
Project  { projectId, name, repositoryOrigin, defaultRef, policy }
Replica  { replicaId, projectId, siteId, environmentId, path, head, syncState }
Run      { runId, projectId, replicaId, agentId, sessionId, baseCommit, grantId }
```

Implementation status (2026-08-08): the first execution-control slices now exist. Each legacy/current project
has a deterministic primary local replica, operators can attach paired target roots as explicit remote
replicas, inspect their bounded Git readiness, and see attributed terminal runs. Runs carry durable expiring
source leases, while the target independently fences each physical root across source hubs. Project Overview
exposes Locations, readiness, active reservations, recent runs, and bounded preparation of an existing clean
checkout at the primary's exact published revision. Registration does not yet provision an absent checkout,
transfer dirty state, stream logs, schedule from resource pressure, or admit results; those remain the next
slices below.

- The control hub owns the project/team/task/policy graph. Git remains the normal source of truth for code.
- Every execution device keeps its own native clone and per-run worktree. Do not put an active Git worktree
  on SMB, Syncthing, or another multi-writer shared filesystem; network latency, file locking, WSL path
  translation, and partial synchronization make that an avoidable corruption boundary.
- Placement selects a compatible replica or prepares one at an exact commit. A run produces an attributed
  branch, signed change bundle, and artifact manifest. Integration updates the logical project only through
  an explicit merge/admission result.
- Dirty or uncommitted work moves as a content-addressed, checksummed change bundle with a declared base,
  never by pretending two live directories are one. Large build outputs live in the artifact broker rather
  than Git or the event journal.
- The UI presents one project row with expandable **Locations**: device/environment, online state, head,
  ahead/behind/dirty state, active agents, current reservations, and last successful synchronization.
- A single-machine compatibility mode maps an existing local project to one local replica automatically.
  Later federation can reconcile duplicate imports by repository identity plus an explicit operator merge;
  it must not guess from equal names or paths.

The useful delivery order is Git-backed replicas first, resumable dirty-state bundles second, and optional
artifact/cache replication third. A permanently shared filesystem is not a recommended project-unification
mechanism.

## Remote testbed platform plan

The current bounded remote file/terminal/WSL actions are the bootstrap, not the final runner protocol.

1. **Durable node runner.** Add capability inventory, target reservation, idempotent job ids, queued starts,
   progress heartbeats, cancellation, reconnect/resume, deadlines, and durable result manifests. The runner
   makes an outbound authenticated fleet connection; it does not expose a general inbound admin shell.
2. **Transfer and artifact plane.** Promote individual file operations into checksummed, chunked, resumable
   directory and artifact transfer with deduplication, progress/ETA, bandwidth limits, and explicit partial-
   failure reporting. Store blobs outside the journal; journal references and bounded summaries only.
3. **Measured resource envelopes.** Attribute CPU, memory, disk I/O, network I/O, process trees, and supported
   GPU metrics to each run. Use Windows Job Objects/ETW/PDH and Linux/WSL cgroups plus `/proc`; clearly label
   host-wide measurements when process attribution is unavailable. Raw high-frequency telemetry belongs in a
   rotating time-series store, not the event journal.
4. **Privilege and isolation.** Run the ordinary worker unprivileged. Put elevation behind a small local
   broker that accepts short-lived signed grants containing exact command/action, project, device, expiry,
   expected blast radius, and rollback evidence. Prefer disposable VM/container snapshots for destructive or
   untrusted tests; never equate Full Access with an unbounded fleet-wide administrator credential.
5. **Interactive desktop lane.** Add a session helper for screenshots, accessibility/UI trees, bounded input,
   and PTY/ConPTY streaming. Windows UAC/secure desktop, macOS Accessibility/Screen Recording consent, and
   Wayland compositor restrictions remain explicit platform boundaries rather than hidden fallbacks.
6. **Scheduler and lab UX.** Match jobs to OS/architecture/GPU/toolchain/WSL/load/latency/grants, reserve a
   target, show the live run and utilization in the project, collect evidence, then release or restore it.
   Test matrices fan out from one logical project and report results against the exact replica and commit.
7. **CEC Support convergence.** Reuse the same installed device runtime and AllMyStuff transport for a later
   client-support profile. Its diagnostic/repair engine remains a loopback sidecar with signed plans and
   consent gates. Testbed mode can be unattended only inside an operator-owned policy; client-support mode
   adds client-visible consent, privacy/redaction, session recording, and stricter revocation. They share
   transport, inventory, telemetry, evidence, and elevation primitives—not authority defaults.

This architecture works with today’s PCs and an N100-class coordinator. An always-on hardware hub improves
availability, scheduling, artifact caching, and recovery, but is not a prerequisite for distributed testing.

## Small delight: deterministic pixel pets

Give each agent a tiny seed-derived pixel companion shown beside its sidebar row and chat header. The seed
keeps its species/colors stable without storing an image per chat. Animation maps only from real lifecycle
state: small idle motion, sleeping after a long idle, working animation during a turn, attention/error cues,
and a brief completion reaction. Use CSS or a tiny sprite sheet, honor reduced-motion, pause offscreen
animation, and never let the pet replace the textual status indicator. This belongs in the visualization
system described by `docs/agent-visualization.md`.

## Candidate delivery slices

1. Device inventory and placement facts, with honest unsupported-platform reporting.
2. Artifact broker and resumable directory transfer with hashes and agent attribution.
3. Opt-in GitHub runner enrollment for x64/ARM64, starting with repository-scoped ephemeral runners.
4. Small-model log triage/retrieval service behind deterministic budgets and audit records.
5. Lab reservation/test-matrix scheduler and KVM/mobile preview hooks.
6. Pixel-pet UI as an isolated, low-risk visual slice.
