# Remote device testbeds

Remote testbeds let an agent on one AllMyAgents hub use explicitly approved files or a terminal on another
authorized fleet machine. Execution stays on the target machine and rides the existing AllMyStuff site
mapping; file contents and command results return through the two hubs.

## Operator flow

1. On each target machine, open **Settings / Remote access** and enable **Authorize this machine as a
   testbed**.
2. Add one or more local folders. Enable `read`, `write`, and/or `terminal` separately for each folder and
   save. The safe default is disabled with no roots.
3. Pair the target hub from the controlling hub's Remote access settings using that target's device token.
   The browser keeps its normal fleet credential, and the controlling hub stores a private copy for
   server-to-server testbed calls. The token is never returned by the connection API or an agent tool.
4. In a chat, open **Devices**, select the exact target roots and operations, and save. This is a durable
   per-chat operator grant. Fleet pairing and the chat's Safe/Edits/Full mode do not imply it.
5. The agent can discover only its granted device/root labels and opaque IDs, then use:
   `remote_ping`, `remote_inspect_environment`, `remote_list_files`, `remote_read_file`,
   `remote_write_file`, and `remote_exec`.

Revoking a chat grant takes effect on its next tool call. Disabling the target policy, deleting a root, or
removing a root capability also fails closed immediately, even if a source chat still has an older grant.

## Security boundary

- Every target route remains protected by the target hub's device token.
- Source credentials live in `fleet-connections.json` under the hub data directory with private file mode;
  public APIs expose only site label, id, and pairing time.
- The target policy stores canonical real paths. File paths must be relative, lexical escapes are refused,
  and existing symlinks are resolved and checked against the approved root.
- Reads and writes are limited to 1 MiB. Writes use a same-directory temporary file and atomic rename.
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

## Platform and topology

The executor is platform-neutral across Windows, macOS, and Linux hubs. A phone or appliance without a
local AllMyAgents hub and shell cannot itself be a terminal target. An off-machine browser still requires
the local-hub gateway described in `cross-machine-bridges.md`, because AllMyStuff mappings are loopback
ports on the hub machine.
