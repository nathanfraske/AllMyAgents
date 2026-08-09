# Remote device testbeds

Remote testbeds let an agent on one AllMyAgents hub use explicitly approved files or a terminal on another
authorized fleet machine. Execution stays on the target machine. The preferred transport is AllMyStuff's
authenticated application RPC lane, which needs no exposed TCP Site or second hub port; upgraded hubs retain
the mapped Site/HTTP route only as a compatibility fallback.

## Operator flow

1. On each target machine, open **Settings / Remote access** and enable **Authorize this machine as a
   testbed**.
2. Add one or more local folders. Enable `read`, `write`, and/or `terminal` separately for each folder and
   save. The safe default is disabled with no roots.
3. Devices already admitted to the same signed AllMyStuff fleet link automatically over their authenticated
   mesh identities; a sighted peer or a machine that merely shares some other mesh does not qualify. For a
   peer outside that fleet, create one short-lived one-use pairing code on either hub and enter its eight
   characters in the other hub's Remote access settings. Either path exchanges the two hub capabilities
   reciprocally, so there is no second reverse-pairing ceremony. Long device tokens remain available only for
   compatibility with an older peer and are never returned by a connection-list API or agent tool.
4. In a chat, open **Devices**, select the exact target roots and operations, and save. This is a durable
   per-chat operator grant. Fleet pairing and the chat's Safe/Edits/Full mode do not imply it.
5. In **Project Overview / Locations**, attach an advertised root when it represents a checkout or test
   environment for that logical project. This is project topology, not an authority grant: the session still
   needs the per-chat grant from step 4 before it can use the root.
6. The agent can discover only its granted device/root labels and opaque IDs, then use:
   `remote_ping`, `remote_inspect_environment`, `remote_inspect_git`, `remote_list_files`, `remote_read_file`,
   `remote_create_directory`, `remote_write_file`, and `remote_exec`. A folder transfer mirrors its
   directory tree with `remote_create_directory` before writing the contained files; empty directories
   are therefore preserved too.

Revoking a chat grant takes effect on its next tool call. Disabling the target policy, deleting a root, or
removing a root capability also fails closed immediately, even if a source chat still has an older grant.

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

Attributed terminal runs acquire a durable, expiring source-hub lease before the command is sent. A second
agent on that hub is rejected at admission while the location is leased. Writes and directory mutations are
also refused during that lease. The target executor independently allows only one terminal command per
physical root and refuses mutations while it runs, so a second paired hub cannot bypass the live-process
fence. Both fences are released on a normally observed result; owner restart reconciliation records
interrupted leases. A crash-surviving process tree requires the later durable runner/job-object layer and is
reported as an unknown outcome rather than assumed stopped.

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
additional defense. The operator-facing Project Overview is the only preparation caller in this slice; a later
agent tool will derive the same immutable preparation request from project topology rather than accepting a
model-selected repository/ref/commit.

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
- The long-lived local hub/worker socket now uses a supervisor-minted, mutually authenticated HMAC
  handshake with a fresh replay-checked nonce. The secret is deleted from the hub and worker environment
  before either process can launch a vendor child. An unauthenticated process cannot replace the hub with a
  forged higher attach epoch or inject remote-device relays.

## Terminal semantics

The selected root is the command's starting directory, not an OS filesystem sandbox. A terminal process
runs as the target hub's operating-system account and therefore retains that account's normal access. This
is stated in both operator and agent UI. Use read/write-only roots when directory containment is required;
grant `terminal` only when whole-account shell authority is intended.

Windows targets use non-interactive PowerShell. macOS and Linux targets use `/bin/sh -lc`. The control
channel, browser bridge, and agent-tool credentials are removed from the command environment.

### Windows Subsystem for Linux

On a Windows target, an operator can add an approved root from a named WSL distribution instead of the
Windows host. The target canonicalizes the Linux root inside that distribution, projects contained file
operations through the distribution's WSL filesystem, and executes terminal commands with `wsl.exe` in
the selected Linux working directory. Distribution and root are part of the grant identity, so `/home/lab`
in two distributions is never treated as the same authority.

Agents see host and WSL environments as separate execution targets. Inspection runs inside the selected
environment, allowing the agent to learn that environment's distribution release, architecture, shell,
resources, and installed toolchain before choosing a command. WSL terminal grants carry the same warning
as host terminal grants: the child process has the target operating-system account's normal authority and
is not confined to the selected starting directory.

Use a host root for files already on a Windows drive. WSL roots are intended for the distribution-native
Linux filesystem; Windows may refuse to project a drive remounted under `/mnt/<drive>` back through the WSL
filesystem provider even though commands inside WSL can see it.

## Telemetry and failure feedback

Every operation returns route lookup, network, full round-trip, and—when observable—target execution time,
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

The executor is platform-neutral across Windows, macOS, and Linux hubs. A phone or appliance without a
local AllMyAgents hub and shell cannot itself be a terminal target. An off-machine browser still requires
the local-hub gateway described in `cross-machine-bridges.md`, because AllMyStuff mappings are loopback
ports on the hub machine.
