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
