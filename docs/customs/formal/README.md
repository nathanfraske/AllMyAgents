# Portable Agentic Customs formal research gate

This directory contains three bounded, executable TLA+ research models. They are a
pre-implementation gate: they make the proposed authority, runtime, and lifecycle
rules precise enough for counterexample search, but they do not ratify an open
Customs design choice and do not change product behavior.

The finite configurations deliberately use small sets. A successful finite TLC run
would establish only that TLC found no counterexample within those configurations;
it would not prove the unbounded design.

## Model map

| Module | State-machine boundary | Principal safety checks |
|---|---|---|
| `AuthorityCarrier` | Project identity, authority terms and root rotation, linear releases, local trust/pins, imports, quarantine, rollback attempts, copies, and intentional forks | active heads were authenticated, high-water is monotone, accepted chains are linear, reviewed competing heads are quarantined, and forks mint a new `(ProjectId, GenesisDigest)` identity |
| `RuntimeAuthorization` | Durable unauthorizing intent, exact policy/grant projection, session and enforcer epochs, one logical gateway dequeue/CAS/audit/local-send transition, crashes/retries/clones, and remote effect reconciliation | no guarded admission/send/effect/output release lacks a current matching decision, an exact request is consumed at most once, stale epochs cannot act, downstream work cannot use stale inference, and Customs never creates positive authority |
| `AgentLifecyclePrivacy` | Stable agent identity, local names, private scoped-principal mapping, immutable drafts, self-adoption, shadow/trial, project promotion/import, retirement, and capsule projection | authorship never activates, overlays have one mapped owner, project promotion uses project authority rather than agent authority, retirement erases mappings, and capsules contain no `AgentId` |

The models use `ProjectIdentity == <<ProjectId, GenesisDigest>>`. Fleet-local
`FleetTrustAnchor` state and per-project `ProjectTrustPin` state have different
types and independent transitions. An intentional fork selects a previously unused
project identity; there is intentionally no `forkId`.

Every persisted queue or outbox entry is represented by `intentQueued` and grants
no authority. `GatewayDequeueExecute` re-evaluates the then-current policy,
`SessionGrant`, `SessionIncarnation`, authority-owned `EnforcerGeneration`, and
source-inference stamp. It then CAS-consumes the exact request, writes its
non-authorizing `DecisionRecord` and audit, and enters the gateway-owned local
send-start transition as one logical linearization point.

The alternative branch represents a crash after CAS but before transport
invocation: the attempt is consumed, zero remote call is recorded, and recovery
cannot blind-retry that request ID. After a local send transition, remote receipt,
computation, and effect completion are separate; an effect outcome may be
`UnknownOutcome` and require reconciliation. The model invariant named
`AtMostOneAuthoritativeEnqueue` counts the single guarded admission/handoff, not a
persisted pre-authorized outbox. A `DecisionRecord`, audit entry, rendered
manifest, cached receipt, or cloned worker cache is never a bearer capability.

## Abstraction assumptions

The following are explicit assumptions of the models rather than conclusions
established by TLC:

- **Cryptography.** Digest equality stands for equality under a fixed,
  domain-separated canonical representation and a collision-resistant digest.
  Membership in an authority-issued set stands for successful signature,
  threshold, scope, and authority-term verification. Root rotation adoption stands
  for verification of an authenticated successor chain. The models do not select a
  carrier encoding, digest suite, signature suite, threshold, or trusted-time
  mechanism.
- **Linearizability and durability.** Each authoritative gateway transition is
  serialized against one linearizable policy/grant snapshot and request-ID CAS.
  Its decision/audit and consumption marker commit together; no persisted queue
  state carries the allow. Physical provider/effect/output operations are not
  transactional with that store, so the model includes both crash-before-transport
  with zero remote call and send-start followed by an unknown effect outcome.
- **Non-clone authority.** Bytes and local worker caches may be copied, but copying
  does not clone the linearizable gateway, an authority key, a `SessionGrant`, a
  project authority, or a private identity-map decision. A copied release retains
  its original project identity. A deliberate project fork must mint a new
  `(ProjectId, GenesisDigest)`. A stable `AgentId` is a logical identity under its
  fleet authority; copying a capsule or draft does not mint or transfer it.
  `CloneSiteState` and `CloneWorkerState` make local clones reachable, and no local
  high-water mark, fence, receipt, or cache is claimed to resist an exact clone.
- **Finite universes.** Model values in each `.cfg` are distinct unless an explicit
  equality says otherwise. Numeric term, version, epoch, and retry sets are finite,
  so liveness claims are conditional on a needed successor/resource remaining
  available.

Safety is checked independently of availability. Liveness formulas are conditional
on the relevant authority, gateway, provider, or transport eventually remaining
available, on a finite successor/resource remaining, and on the weak-fairness
clauses in each `Spec`.

The gate covers more than runtime authorization: conformance evidence must also
name portability/closed-graph behavior, governance lifecycle behavior, and
identity/privacy binding. A malicious or test-aware implementation is an explicit
conformance threat: passing known vectors alone cannot establish an `Enforced` or
`Detected` capability for an open implementation. Independent observation,
containment/bypass analysis, retained artifacts, and implementation-specific scope
remain necessary.

## Run TLC

From this directory, with a compatible Java runtime and `tla2tools.jar` present:

```text
java -cp tla2tools.jar tlc2.TLC -config AuthorityCarrier.cfg AuthorityCarrier.tla
java -cp tla2tools.jar tlc2.TLC -config RuntimeAuthorization.cfg RuntimeAuthorization.tla
java -cp tla2tools.jar tlc2.TLC -config AgentLifecyclePrivacy.cfg AgentLifecyclePrivacy.tla
```

At authoring time this worktree had neither `java` nor `tla2tools.jar`, so these
models were not parsed or model-checked here. Do not treat their presence as a
model-check result; run the exact commands above in a TLA+ environment and retain
the TLC version, configuration, state counts, and output.

## Negative trace guidance

Useful counterexample and simulation traces include:

- `AuthorityCarrier`: issue a release, rotate the root, issue again, update only one
  site's project pin, then import in different orders; stage both a lower-version
  rollback and a same-version competing head; copy a carrier and verify its identity
  is unchanged; clone a site's complete local state and let the two copies diverge;
  intentionally fork and verify the new genesis is a new identity.
- `RuntimeAuthorization`: queue intent, change the policy head or grant, then
  dequeue and observe a fresh denial; take the crash-before-transport branch and
  observe zero local send plus duplicate rejection on retry; start a local effect
  send, crash before its result is known, retry the same request ID, and reconcile
  without a second send; clone a worker receipt and attempt to use it.
- `AgentLifecyclePrivacy`: author a draft and try to activate it without the
  explicit self-adopt capability; import a conflicting scoped-principal mapping and
  attempt an overlay; try to import a project Custom signed with agent authority;
  retire an agent and inspect mapping erasure; project a capsule and inspect every
  projected value for `AgentId`.

For adversarial exploration, temporarily negate one named invariant at a time or
weaken the corresponding action guard, then require TLC to produce the shortest
trace. Restore the invariant and guard before recording a passing gate result.
