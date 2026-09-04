# Remote device testbeds

Remote testbeds let an agent on one AllMyAgents hub use explicitly approved files or a terminal on another
authorized fleet machine. Execution stays on the target machine. The preferred transport is AllMyStuff's
authenticated application RPC lane, which needs no exposed TCP Site or second hub port; upgraded hubs retain
the mapped Site/HTTP route only as a compatibility fallback.

## Operator flow

1. Open **Settings / Devices & remote** for the consolidated inventory. Each machine appears once and is
   explicitly badged as a **Hub**, **Testbed**, or both. Reachability, route latency when available,
   platform/architecture, logical CPU count, memory, host/WSL environments, and authorized-root count are
   reported from live target capabilities. Pairing and executor policy live in separate expandable setup
   panels beneath the inventory.
2. On each full-hub target machine, expand **Local testbed policy**, enable it, and add one or more local
   folders. Enable `read`, `write`, and/or `terminal` separately for each folder and save. The safe default
   is disabled with no roots.
3. Expand **Connection & pairing** only when exposing this Hub or linking a peer. Devices already admitted
   to the same signed AllMyStuff fleet link automatically over their authenticated
   mesh identities; a sighted peer or a machine that merely shares some other mesh does not qualify. For a
   peer outside that fleet, create one short-lived one-use pairing code on either hub and enter its eight
   characters under **Connection & pairing** on the other Hub. Either path exchanges the two hub capabilities
   reciprocally, so there is no second reverse-pairing ceremony. Long device tokens remain available only for
   compatibility with an older peer and are never returned by a connection-list API or agent tool.
4. In a chat, open **Devices**, select the exact target roots and operations, and save. This is a durable
   per-chat operator grant. Fleet pairing and the chat's Safe/Edits/Full mode do not imply it.
5. In **Project Overview / Locations**, attach an advertised root when it represents a checkout or test
   environment for that logical project. This is project topology, not an authority grant: the session still
   needs the per-chat grant from step 4 before it can use the root.
6. The agent can discover only its granted device/root labels and opaque IDs, then use:
   `remote_ping`, `remote_inspect_environment`, `remote_inspect_git`, `remote_prepare_project_location`,
   `remote_list_files`, `remote_read_file`, `remote_create_directory`, `remote_write_file`, and `remote_exec`.
   Project preparation is available only when the root is attached to the chat's project. A folder transfer mirrors its
   directory tree with `remote_create_directory` before writing the contained files; empty directories
   are therefore preserved too.
7. Project managers and the Overseer use `start_run` for important remote builds, tests, lints, benchmarks,
   deploys, or other long-running commands. It uses the same explicit device/root grant but adds a generic
   durable run id, source/environment provenance, retained cursor-paged logs, exact terminal state, and
   resource leases. Independent roots or named resources can run concurrently; a shared root/GPU/port queues.
   Declare common prerequisites with `required_tools`. If inspection finds any missing, provide the project's
   exact reviewed bootstrap or setup recipe as `setup_command`; the hub runs it as a separate durable
   prerequisite, then rechecks the target before starting the requested command. A setup failure or a still-
   missing tool fails closed without starting the build. The hub never guesses packages or invents a parallel
   dependency manifest.
   See [durable runs and scoped team queries](durable-runs-and-team-query.md).

Revoking a chat grant takes effect on its next tool call. Disabling the target policy, deleting a root, or
removing a root capability also fails closed immediately, even if a source chat still has an older grant.

## Lightweight headless node

The automatic bootstrap below currently depends on AllMyStuff's authenticated file and terminal planes.
A peer that runs only MyOwnMesh is a distinct, fail-closed product seam; its required upstream protocol and
no-reboot qualification plan are captured in
[the MyOwnMesh-native testbed contract](myownmesh-native-testbed-contract.md). LAN discovery is never
bootstrap authority, and manual SSH copy is not substituted for that missing product contract.

A target does not need the full AllMyAgents desktop app, a local hub journal, an Overseer, or any Claude or
Codex account. If it already runs AllMyStuff/MyOwnMesh and belongs to the same signed owned-device fleet, the
source Overseer can bootstrap the release's vendor-free testbed payload through the remote planes AllMyStuff
already exposes:

1. The Overseer calls `list_testbed_targets` to discover signed-fleet AllMyStuff peers and
   `inspect_testbed_target` for the chosen peer's observed OS and architecture. These are diagnostic reads
   and do not require the target to be paired as an AllMyAgents hub. On a direct operator turn, it explains
   the requested privilege profile and blast radius.
2. `overseer_control` operation `deploy_testbed_node` names the exact `site_id`, a `testbed_profile`, and a
   human-readable `reason`. Automatic deployment supports `elevated-machine` on Windows or Linux and
   `linux-sudo-machine` on Linux.
3. The source opens the target's existing AllMyStuff `files` and `terminal` routes. It transfers a bundled
   Node runtime plus five compiled, dependency-free AllMyAgents modules in bounded chunks, preserving the
   directory tree and reporting files, bytes, elapsed time, and throughput.
4. The target verifies every transferred file against `SHA256SUMS` before executing the installer. The
   payload is the platform/architecture-matched artifact carried by the installed release; a mismatch is
   refused rather than downloading or executing an unpinned runtime.
5. Windows installs a highest-privilege LocalSystem startup task. Linux `elevated-machine` installs a root
   systemd service. Linux `linux-sudo-machine` creates a dedicated system account, validates a narrowly named
   sudoers file with `visudo`, and grants that account `NOPASSWD: ALL` so agent terminal requests can cross
   the elevation boundary. The latter is deliberately machine-admin authority, not a sandbox.
6. The source waits for the new node to register, completes the one-use pairing exchange, probes its
   live capabilities, removes the unique bootstrap directory after verified success, and records a bounded
   deployment lifecycle. It never retries an ambiguously completed install command. A cleanup failure is
   reported as pending without falsely failing the already verified installation; an ambiguous installer
   outcome retains its staging directory so recovery evidence and a possibly running installer are not erased.

The lightweight node accepts only pairing and the existing remote-device capability/action protocol. It has
no project/chat/account APIs and cannot host or inherit an Overseer. Same-fleet trust admits the source hub to
the node, but does not grant any worker: every agent still needs an explicit durable device/root/capability
grant from its own hub. A full hub already answering the application route is detected and never displaced.

The portable bundle can also be configured locally with `testbedNode configure --profile scoped` for an
unprivileged, explicit-root node. Automatic cross-OS deployment currently requires a matching release payload;
a Windows/x64 desktop release cannot pretend its bundled Node executable is a Linux/ARM64 artifact. Release
matrix assets or a target-native package repository are the next step for cross-architecture bootstrap.

### Updating an installed node

`overseer_control` operation `sync_testbed_node` is the idempotent update path for an already-paired Linux
systemd node. It works with nodes that predate the updater because it uses the existing authenticated
device read/write/terminal protocol rather than a new bootstrap RPC:

1. Read the live build identity and service layout over the authenticated lane. The node reports both its
   architecture-specific full-payload checksum and its architecture-independent code checksum, along with
   the route that actually answered (`myownmesh-rpc` or `site`).
2. Compare the five dependency-free JavaScript modules plus `build.json`; a Windows/x64 hub may therefore
   update the application code on a Linux/riscv64 node without pretending its Node executable is portable.
   A runtime replacement still requires a matching full bootstrap artifact.
3. Stage only differing files beneath the existing install root, verify every staged SHA-256, retain one
   bounded rollback generation, and apply via same-filesystem atomic renames.
4. Repair the unit with `After=myownmesh.service` (not `Requires=`) and an explicit, detected
   `MYOWNMESH_CONTROL_SOCKET`, then ask systemd to restart the service from a detached timer after the
   caller has received the commit response.
5. Never replay an ambiguous commit/restart. Resolve it with read-only capability probes and report success
   only when the new code checksum is observed. Results include changed files, bytes, transfer/restart time,
   active transport, and the rollback path.

The authenticated capability response also includes the target's public SSH host-key fingerprints. If SSH
is used for an out-of-band bootstrap, pin a fingerprint obtained through this mesh-authenticated channel;
never use blind host-key acceptance or trust-on-first-use when an independent authenticated path exists.

## Project locations and attributed runs

Every existing project is upgraded in place with one deterministic primary local location. WSL projects keep
their distro-native path and concrete distro as part of that identity. Attaching a remote location accepts only
a paired `siteId` and a stable root id; the hub resolves the label, path, and environment from the target's live
capability response, so a browser cannot manufacture a remote path or claim capabilities the target did not
advertise. Removing a project also removes its location registry, while removing the primary local location is
refused.

A `remote_exec` call receives a durable run id only when all three facts agree: the chat belongs to a project,
the target site/root is explicitly attached to that project, and the same chat separately has a terminal grant
for that root. The source hub records the project, replica, immutable agent/session id, account id, command hash,
bounded command summary, base commit when known, result, failure stage, exit code, and telemetry. The target hub
records the authenticated source hub and source-supplied correlation ids; those fields are audit metadata and do
not grant target-side authority. Project Overview polls the durable registry and run ledger, so topology changes
made outside that browser and completed remote runs converge without a reload.

If the source hub restarts before it observes a remote result, the active hub owner closes that run as
`cancelled` at the `source-restart` stage instead of inventing a success or failure. A standby hub never
reconciles those rows while the active owner may still be running them.

An exact device/root grant is standing operator authority for the named read, write, or terminal capabilities.
It remains valid on direct and teammate-triggered turns; the hub does not ask for a second per-command approval.
Remote terminal commands and file mutations use the target account's normal concurrency. Generic durable remote
runs therefore start concurrently unless callers name the same explicit resource (for example a package manager,
GPU, port, or deployment lane) to serialize them. Project preparation retains its narrow transaction boundary
because it deliberately changes a checkout to a published commit. The durable-run coordinator owns stable handles,
retained logs, explicit resource scheduling, and stale-owner reconciliation. Its process tree is still hub-owned
rather than detached: a run whose owner disappears is reported as `outcome_unknown`, never assumed stopped or
blindly retried.

The ordinary authorization path is one action: **Authorize this testbed**. On the target it enables the
advertised Windows drives, WSL distributions, or Linux root with their usable read/write/terminal capabilities;
on the selected manager or chat it grants those capabilities together. The per-root checkboxes remain an
advanced narrowing surface, not a required setup ceremony.

For a project chat, authorization immediately attempts to prepare the preferred build environment. If the
granted root is already the project's clean matching checkout, the hub attaches it. Otherwise the hub creates a
deterministic `.allmyagents/projects/<project>-<id>` checkout beneath that broad machine root. Before every
important remote project run it reconciles that checkout to the primary location's credential-free repository,
named branch, and exact published commit. It never overwrites a dirty or different repository. A broad `/home`,
drive, or WSL root remains usable machine authority even when preparation fails; the failure is reported as
project-source readiness rather than falsely revoking the device grant.

Project Overview can run a fixed-argument Git readiness probe against local or remote locations. Agents with
an explicit read grant can use the same probe through `remote_inspect_git`. It records HEAD/ref and a bounded
clean/dirty count plus a credential-free origin identity without granting terminal access, taking a Git lock,
fetching, checking out, resetting, or copying files. Raw remote URLs are never stored or returned. A timed-out
or truncated inspection is reported as incomplete and is never treated as clean.

For an existing attached remote checkout, **Prepare** selects the primary location's current clean HEAD, proves
that both locations have the same sanitized origin identity, fetches only the primary's named branch, proves
that branch advertises the exact selected commit, and checks the target out detached at that commit. Preparation
holds the same durable location lease as an attributed run and is idempotent when the target already matches.
It refuses dirty/incomplete trees, detached primaries, missing or unsafe origins, mismatched repositories,
unpublished commits, active runs, and failed post-checkout verification. It never resets, cleans, stashes,
updates submodules, or accepts caller-supplied Git arguments.

Preparation requires the target root's **terminal** capability. Git checkout can invoke configured credential
helpers or content filters even when AllMyAgents supplies only fixed argv; classifying it as a mere file write
would create an authority escalation. Repository hooks and external remote helpers are explicitly disabled as
additional defense. The operator can prepare from Project Overview; a project agent with the same explicit
terminal grant can call `remote_prepare_project_location`. The tool accepts only device/root identity and the
hub derives the immutable repository/ref/commit request from current project topology.

This runner slice still does not clone an absent checkout, transmit uncommitted work, stream command output,
isolate CPU/GPU/memory, or accept results back into the primary. Those remain later protocol layers; a
registered location is an honest placement fact, not a claim that its checkout is current.

## Security boundary

- Every direct request is bound to the cryptographically authenticated MyOwnMesh peer and HMAC-authenticated
  again with the paired source hub's device capability. Envelopes include a protocol version, random message
  id, and a five-minute timestamp window.
- Source credentials live in `fleet-connections.json` under the hub data directory with private file mode;
  public APIs expose only site label, id, and pairing time.
- The target policy stores canonical real paths. File paths must be relative, lexical escapes are refused,
  and existing symlinks are resolved and checked against the approved root.
- Reads and writes are limited to 1 MiB. Writes use a same-directory temporary file and atomic rename.
  Directory creation requires the same explicit write grant and checks every existing component without
  following a link or junction outside the root.
- Directory listings, JSON bodies, remote responses, command text, command output, and command duration are
  bounded. Timed-out command process trees are terminated.
- Remote access is denied on teammate/bus-caused turns by default. The existing explicit risky-bus operator
  switch is required to change that behavior.
- Environment inspection is a bounded inventory, not an arbitrary read: it reports OS, architecture,
  release, CPU/memory summary, shell, and availability of a fixed list of common development tools. It
  does not return environment variables or credentials.
- Source and target hubs journal requests and outcomes without journaling file contents or full command
  output. The source journal is authoritative for chat/profile attribution; the target records the caller's
  supplied attribution as part of its device-token-authenticated request.
- The headless node keeps a bounded rotating local audit of operation type, authenticated source, opaque
  message id, root id, result/failure stage, timing, and byte count. It never records file contents, command
  text, full output, a pairing code, or the peer device token.
- The long-lived local hub/worker socket now uses a supervisor-minted, mutually authenticated HMAC
  handshake with a fresh replay-checked nonce. The secret is deleted from the hub and worker environment
  before either process can launch a vendor child. An unauthenticated process cannot replace the hub with a
  forged higher attach epoch or inject remote-device relays.

## Terminal semantics

The selected root is the command's starting directory, not an OS filesystem sandbox. A terminal process
runs as the target hub's operating-system account and therefore retains that account's normal access. This
is stated in both operator and agent UI. Use read/write-only roots when directory containment is required;
grant `terminal` only when whole-account shell authority is intended.

Windows targets use non-interactive PowerShell. macOS and Linux targets use non-login `/bin/sh -c`; WSL
does the same inside the selected distribution. The control channel, browser bridge, agent-tool credentials,
and login-profile side effects are removed from the command environment. Elevated Linux testbed commands run
in a bounded transient systemd unit with their own cgroup/journal identity, so a child shell cannot bury the
testbed service's own logs. Timeout handling stops that unit rather than merely abandoning its client process.

An `elevated-machine` node intentionally changes the terminal semantics: its process account is LocalSystem
or root, so a terminal-capable root is effectively machine-administrator command access. A
`linux-sudo-machine` node performs ordinary file-plane operations as its dedicated account but allows terminal
commands to invoke passwordless sudo. These profiles are opt-in installation choices and remain separate from
chat Full Access; a chat without the explicit device/root terminal grant cannot reach them.

### Windows Subsystem for Linux

On a Windows target, an operator can add an approved root from a named WSL distribution instead of the
Windows host. The target canonicalizes the Linux root inside that distribution, projects contained file
operations through the distribution's WSL filesystem, and executes terminal commands with `wsl.exe` in
the selected Linux working directory. Distribution and root are part of the grant identity, so `/home/lab`
in two distributions is never treated as the same authority.

Agents see host and WSL environments as separate execution targets. Inspection runs inside the selected
environment, allowing the agent to learn that environment's distribution release, architecture, shell,
resources, and installed toolchain before choosing a command. Lightweight Linux nodes report the resolved
path and source of each developer tool as well as its availability. System-installed testbeds reserve
`/opt/allmyagents-toolchains` for shared, world-readable compiler payloads and expose it to ordinary logins;
Rust uses a shared `RUSTUP_HOME`, while `CARGO_HOME`, registries, package caches, and other writable state
remain per-user. Runner-owned `cargo install` recipes publish reusable CLI binaries through the separate
shared `CARGO_INSTALL_ROOT`. Service repair recognizes the earlier `/opt/rust` layout so an update cannot hide an
already-verified RISC-V compiler. WSL terminal grants carry the same warning
as host terminal grants: the child process has the target operating-system account's normal authority and
is not confined to the selected starting directory.

Use a host root for files already on a Windows drive. WSL roots are intended for the distribution-native
Linux filesystem; Windows may refuse to project a drive remounted under `/mnt/<drive>` back through the WSL
filesystem provider even though commands inside WSL can see it.

## Telemetry and failure feedback

Every operation returns the active transport, route lookup, network, full round-trip, and—when observable—target execution time,
plus request/response byte counts. File transfers additionally report transferred bytes, elapsed transfer
time, and measured throughput. `remote_ping` provides a lightweight round-trip probe before expensive work.

Failures are classified as pairing, route, transport, timeout, protocol, or target failures. This lets an
agent distinguish an unpaired device or offline route from a slow target, rejected path, command failure,
or malformed response. Target timing is retained even when the target rejects an action. These are
application-level measurements through the paired hub route, not ICMP measurements.

Once an action has selected the direct lane, an ambiguous transport failure is returned to the caller and is
not repeated over the HTTP compatibility route. This prevents a write or shell command that may already have
run on the target from being executed twice.

## Platform and topology

The full-hub executor is platform-neutral across Windows, macOS, and Linux. The first automatic headless
installer supports Windows and Linux, with a release artifact matching the target OS and architecture. A phone
or appliance without an AllMyStuff transport and usable local shell cannot itself be a terminal target. An off-machine browser still requires
the local-hub gateway described in `cross-machine-bridges.md`, because AllMyStuff mappings are loopback
ports on the hub machine.
