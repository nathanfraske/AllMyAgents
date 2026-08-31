# MyOwnMesh-native testbed contract

This note defines the blocked product seam for a headless testbed that runs MyOwnMesh but not AllMyStuff.
It is a design boundary, not an SSH exception or authorization to mutate a live device. The existing
AllMyStuff bootstrap described in [remote-device-testbeds.md](remote-device-testbeds.md) remains the only
implemented automatic bootstrap path.

## Current boundary

The relevant AllMyAgents call chain is deliberately fail-closed:

- `meshSite.ownedRosterRequired()` supplies the signed AllMyStuff owned-device roster. It throws an
  actionable control-transport error rather than translating a degraded control pipe into an empty fleet.
- `TestbedDeploymentService.targets()` intersects that signed roster with authenticated MyOwnMesh peers.
  LAN or mDNS visibility alone never makes a target deployable.
- `inspect()` opens the AllMyStuff file and terminal planes to attest the target home, platform, and
  architecture. `deploy()` uses the same authenticated planes for bounded transfer and command execution.
- `authorize_remote_testbed` operates only after pairing and grants the node's real advertised roots and
  capabilities; it does not relabel a generic machine root as project source.

A MyOwnMesh-only peer therefore cannot currently pass inspection or bootstrap, even if its DeviceId and
`riscv64` metadata are visible. That is intentional until MyOwnMesh exposes a reviewed authority-bearing
bootstrap transport. Manual copy or raw SSH may be useful for engineering qualification, but must not be
hidden behind `deploy_testbed_node` as the supported product path.

## Minimal upstream contract

AllMyAgents can add the native path once MyOwnMesh supplies all of the following as typed, versioned
protocol surfaces:

1. **Control status with cause.** Distinguish daemon absent, permission denied, no network, offline peer,
   and empty authorized roster. On Windows service installs, the control endpoint must accept a configured
   interactive client SID while the client verifies the expected service SID; the server must verify the
   caller SID and publish an exact DACL. Unix sockets need equivalent owner/mode and peer-credential checks.
2. **Authenticated peer identity.** Every operation binds the exact DeviceId, MeshContext/network,
   authenticated endpoint, and a signed semantic policy. mDNS and LAN discovery remain locator-only.
3. **One-use enrollment authority.** A short-lived signed claim binds source hub, target DeviceId,
   operation, expiry, nonce, and explicit privilege profile. It is consumed durably before execution and
   cannot be replayed after an ambiguous response.
4. **Attested capabilities.** The target signs platform, architecture, build/protocol version, and available
   bootstrap capabilities. A K3 must report canonical `linux/riscv64`; ambiguous or conflicting identity or
   architecture fails closed.
5. **Bounded transfer and terminal bootstrap.** The protocol supports checksum-addressed transfer,
   atomic staging, bounded logs/timeouts, cancellation where truthful, exact exit state, and an
   `outcome_unknown` terminal state. The chosen scoped/elevated profile is explicit and journaled.
6. **Host-key binding if SSH is the carrier.** MyOwnMesh must provide a domain-separated signature over
   DeviceId, MeshContext, host-key fingerprint, expiry, and nonce, or the operator must pin the fingerprint
   out of band. Trust-on-first-use is not sufficient.

Until that contract exists, native targets should appear as **discovered but bootstrap unavailable**, with
the precise missing capability or local ACL remediation. They must not disappear as an empty list and must
not inherit authority from fleet membership alone.

## AllMyAgents integration after the contract lands

- `list_testbed_targets` returns a typed source (`allmystuff` or `myownmesh-native`), discovery health, exact
  identity, enrollment state, and bootstrap-capability status.
- `inspect_testbed_target` verifies the upstream attestation and reports platform/architecture without
  executing an unauthenticated probe.
- `deploy_testbed_node` selects the reviewed carrier, records the signed enrollment and privilege profile,
  and preserves checksum, provenance, replay, and `outcome_unknown` guarantees already used by the
  AllMyStuff path.
- `authorize_remote_testbed` remains a separate post-pairing grant. It exposes the node's advertised roots
  unchanged and may prepare project parity beneath a granted broad machine root only through the existing
  project-location transaction.

## No-reboot qualification sequence

The qualification must use isolated homes and exact build identities before touching a production service:

1. Run protocol/unit tests for service-before-hub, hub-before-service, offline/return, multiple peers,
   denied caller SID, wrong service SID, ambiguous identity, replay, and canonical `riscv64` metadata.
2. Run mixed-version gates between the deployed K3 v0.3.5 daemon and the proposed current protocol. A
   compatibility refusal must name the exact unsupported seam.
3. On Windows, install the reviewed daemon build and perform one separately authorized, bounded MyOwnMesh
   daemon/service restart to apply the DACL and protocol change. No OS reboot is required.
4. On the K3, perform any daemon or testbed service restart as a separate operator-authorized action; verify
   signed identity/capabilities, enrollment, transfer checksums, registration, offline/return, and a harmless
   scoped command before considering elevated profiles.
5. Verify revocation and an ambiguous-response case without retrying a write. Confirm all provenance and
   terminal outcomes from the hub journal. No AllMyStuff installation is required on the K3.
