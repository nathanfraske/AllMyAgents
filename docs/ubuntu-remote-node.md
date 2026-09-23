# Ubuntu as a remote machine

The lightweight testbed node gives agents on another AllMyAgents PC access to an Ubuntu machine's
files and terminal. The agents and their Codex/Claude accounts stay on the controlling PC. The target
does **not** need an AI login, npm, a GUI, a source checkout, or AllMyStuff.

The Linux release job builds `allmyagents-testbed_<version>_amd64.deb` and `_arm64.deb`, with checksums.
This packaging is new; releases before this change do not have these assets. Linux desktop/full-hub
packaging is a separate follow-up, not something the testbed package pretends to provide. RISC-V is
still an architecture-native source-bundle qualification path, not an amd64/arm64 package.

## Install and link

1. Install MyOwnMesh on the Ubuntu target and join the same authenticated network as the controlling
   PC. Confirm the service account can access the daemon's Unix control socket. Discovery alone is
   not authorization. This installer does not install MyOwnMesh or alter its socket permissions.
2. Download the installer from the release's source tag, inspect it, and run it as your ordinary user:

   ```bash
   tag='v<release>' # Replace with the published release tag containing the Linux packages.
   curl --proto '=https' --tlsv1.2 -fsSL \
     "https://raw.githubusercontent.com/nathanfraske/AllMyAgents/$tag/scripts/install-linux.sh" \
     -o install-linux.sh
   # Inspect install-linux.sh, then:
   bash install-linux.sh --tag "$tag" --profile full-machine
   ```

   It downloads the official GitHub release `.deb`, verifies its SHA-256, and uses `sudo apt-get install`
   for the package. Node is bundled; no npm install or compilation happens on the target. The checksum
   detects corruption; its trust anchor is the official HTTPS release, not a separate signing key.
3. `full-machine` creates a **user** systemd service. It exposes `/` and runs commands with that OS user's
   permissions, without a checkout-only restriction or extra root-level command serialization. To keep
   it running after logout, explicitly enable lingering for that user (`loginctl enable-linger USER`).
4. Run `allmyagents-testbed pair-code`. On the controlling PC open **Settings → Connection & pairing**,
   choose the exact MyOwnMesh peer, and enter the code. The code expires in ten minutes and is one-use.
   Then authorize the testbed for the intended chat/manager. That grant covers its advertised files and
   terminal; agents do not need another prompt for each command.

For a daemon using a nondefault socket, supply `--mesh-socket /path/to/daemon.sock` to the installer.
The service retains that path. A socket ACL failure is a MyOwnMesh service configuration issue, not a
reason to switch to unauthenticated LAN access, open permissions globally, or fall back to hidden SSH.

### Machine-admin access

Choose explicitly, only on a machine you intend agents to administer:

```bash
bash install-linux.sh --profile elevated-machine
# Or a dedicated account whose terminal may sudo without a password:
bash install-linux.sh --profile linux-sudo-machine
sudo allmyagents-testbed pair-code --data-dir /var/lib/allmyagents-testbed
```

`elevated-machine` runs as root. `linux-sudo-machine` creates a dedicated account and an explicit
`NOPASSWD: ALL` sudo rule; it is machine-admin access, **not a sandbox**. Normal-user full-machine access
does not grant root. Nothing bypasses kernel permissions, Kubernetes RBAC, provider policies, or the
operator's device grants. Do not install both user and system instances for the same peer.

For a narrower target, install the package without `--profile`, then use
`allmyagents-testbed install-user --profile scoped --root /path --read --write --terminal`.
Package installation by itself does not start services, grant remote access, or create a sudo rule.

## Commands do not need Git

Use `start_run` with `remote_workspace: "machine"` for Kubernetes administration, host services,
non-Git work, or work you intentionally want to perform in an existing dirty checkout:

```json
{
  "kind": "custom",
  "remote_device_id": "<granted-device>",
  "remote_root_id": "<granted-root>",
  "remote_workspace": "machine",
  "remote_cwd": "home/operator",
  "remote_command": "kubectl get pods --all-namespaces",
  "timeout_ms": 0
}
```

The command runs directly under the granted root; `remote_cwd` is relative to it. There is no clone,
checkout preparation, Git cleanliness test, or requirement that the source PC's checkout exists.
The retained record says **machine**, not a verified project build. Kubernetes credentials/context
must already belong to the target OS account; the installer never copies cluster or AI credentials.
Default `~/.kube/config` works normally; an explicitly configured service `KUBECONFIG` is preserved.

Omit `remote_workspace` (or choose `project`) for reproducible builds: existing exact-commit checkout
preparation still applies. Project setup recipes and required-tool checks remain available in either
mode; no dependency manifest is inferred from arbitrary errors.

## Command lifetime and connection loss

- `timeout_ms: 0` means **no execution deadline**. A positive value is an explicit deadline (up to the
  Node timer range, about 24 days); omitted means 30 minutes. `setup_timeout_ms` accepts the same values.
- Current targets admit a durable command once and return immediately. The hub makes short status
  requests in the background, without spending agent turns. An RPC timeout does not kill the command.
- Cancellation is a single request followed by observation. Only a confirmed target cancellation is
  reported as cancelled. A lost acknowledgement is never retried as another command start.
- After a sustained observation failure, the source records `outcome_unknown`: the command may still be
  running. Target restart without a saved terminal result also reports unknown. This is not resumable
  execution across a target reboot or source-hub replacement; never automatically resubmit it.
- Older targets support only the legacy six-hour RPC path. Unlimited/longer requests fail **before
  execution**, asking for a target update; they are never silently shortened.
- `remote_exec` is still the short interactive tool (120 seconds). Use durable `start_run` for long jobs.
  Output remains bounded (512 KiB on the target), retained at completion; this is not an interactive PTY
  or an unlimited live log stream.
- Target receipts live under `remote-command-results` in the node data directory. They are not
  automatically deleted: retained admission IDs prevent a repeated start from executing twice.
  Include them in data-directory backups; do not remove receipts for unresolved or running commands.

## Diagnostics, upgrades, and no-reboot qualification

Use `allmyagents-testbed status` (with the system data directory under sudo for elevated installs) to
inspect identity, build, selected profile and MyOwnMesh control discovery. Inspect service liveness with
`systemctl --user status allmyagents-testbed` or `sudo systemctl status allmyagents-testbed`; logs use
`journalctl --user -u allmyagents-testbed` or `sudo journalctl -u allmyagents-testbed`.

Re-running package installation preserves data, reciprocal pairing, and grants. It does **not**
restart an active service. Drain runs, reinstall with the same profile if using the copied elevated
runtime, then explicitly restart only that testbed service. No OS reboot is needed. Profile changes
require an explicit `configure`; reinstall does not silently broaden an existing scoped setup.

Qualification order: isolated package extraction/checksums and >120-second unlimited command;
then separately authorized target install; inspect the exact peer identity, pair once, grant the
intended scope; run harmless filesystem and machine-mode commands in a non-Git directory; prove a
second command can run concurrently; test cancel, temporary disconnection, and root revocation.
The automated package smoke does not claim a live two-machine MyOwnMesh or machine-admin qualification.

This is an operator-local CLI installation product path. Automatic remote bootstrap onto a bare
MyOwnMesh-only machine is still blocked on the authenticated upstream transfer/bootstrap contract in
[myownmesh-native-testbed-contract.md](myownmesh-native-testbed-contract.md). It is not implemented by
silently copying files over SSH.
