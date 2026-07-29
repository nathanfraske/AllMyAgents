# Portable Agentic Customs formal research gate

This directory contains three executable, bounded TLA+ research models for the
Candidate Portable Agentic Customs architecture. They are a pre-implementation
counterexample-search gate. They do not ratify an open design choice, change
product behavior, or lift the project HOLD.

The recorded TLC runs exhaust the reachable states of the exact finite
configurations named below, subject to TLC fingerprinting. They are evidence
within those closed models only—not an unbounded proof, a cryptographic proof,
cross-implementation conformance, continuous independent observation, or evidence
about hidden vendor behavior.

## Selecting authority and terminology

`HeadReceipt` is the sole normal project-governance selector for an ordinary
release. A distinct externally accepted `RecoveryTransition` is the recovery
plane checkpoint and can select only its exact `SafeRecoveryRelease` at a
strictly higher term and sequence zero. “Witness” describes the assumed external
trust/process and possible non-authorizing observation evidence; it is not a
second Customs wire receipt.

For finite-state tractability, the TLA+ constant `ReceiptIds` is a shared
identifier carrier. Membership in the disjoint `headReceipts` and
`recoveryTransitions` sets determines the wire-object kind; the shared ID domain
does not treat a RecoveryTransition as a HeadReceipt.

A HeadReceipt binds:

- `ProjectIdentity = <<ProjectId, GenesisDigest>>`;
- authority term and sequence;
- parent and release;
- the release's complete closure.

Carrier/Git manifests, copied bytes, `GovernanceProposal`s, offline proposals,
local observations, and local high-water values are candidates or evidence only.
They cannot select or roll back the accepted external checkpoint. Two different
HeadReceipts for one identity/term/sequence freeze use and quarantine both
releases. A fixed governance-only recovery plane may prepare
`SafeRecoveryRelease`; only an independently authorized and externally accepted
`RecoveryTransition` to a higher term, sequence zero, clears the current-term
freeze and selects that safe release. The next normal `HeadReceipt` must parent
the transition at sequence one. Recovery actions are limited to
fetch/inspect/verify/restore/rotate and exclude inference, tools, secrets, and
normal effects.

Applicability is modeled at one-Custom/one-NormBody granularity. Definite `False`
is a resolved determination of non-applicability and creates no authority.
`Unknown`, missing closure material, or decrypt failure prevents use. Every
normative overlay and authenticated locator is in the selected release closure.
There is no atom identifier or atom-local applicability transition: `False`
applies to the entire modeled normative item. This states model granularity; it
does not prove an implementation rejects atom-local skipping.

## Model map

| Module | Boundary |
|---|---|
| `AuthorityCarrier` | Candidate carriers/proposals, one logical sequencer, normal HeadReceipt selection, distinct RecoveryTransition/SafeRecoveryRelease selection, closure completeness, offline proposal-only behavior, local rollback/copy, HeadReceipt equivocation freeze, and intentional new-identity fork |
| `RuntimeAuthorization` | Unauthorizing queue intent, deviation-free PolicyBasis, exact DeviationGrants, SemanticCharter/render separation, SessionGrant authority, SessionIncarnation/EnforcerGeneration fencing, and the gateway-owned current-check/CAS/audit/immediate-transport transition |
| `AgentLifecyclePrivacy` | Stable AgentId and non-authoritative name, private project-principal bijection, immutable one-NormBody drafts, explicit non-widening adoption, trials, project-authority promotion, quarantine, retirement/erasure, and AgentId-free capsules |

`RuntimeAuthorization` has no preauthorized outbox. `intentQueued` grants no
authority. `GatewayDequeueExecute` reads current policy/grant/source state,
CAS-consumes the exact request ID, writes a non-authorizing DecisionRecord/audit,
and either begins immediate gateway-owned transport or records the modeled
crash-before-transport branch in the same logical transition. A DecisionRecord,
audit entry, render manifest, cached receipt, or cloned worker cache is never a
bearer allow. Remote completion and unknown effect reconciliation occur later.

## Assumptions, not conclusions

- **Canonicalization and cryptography:** equality and authenticated-set membership
  abstract a fixed domain-separated canonical representation, collision-resistant
  digest, signature/threshold/scope checks, and authenticated successor rules.
  No encoding, digest/signature suite, threshold, or trusted-time profile is
  selected here.
- **External authority:** the accepted checkpoint term/sequence store—normal
  `HeadReceipt` or recovery-plane `RecoveryTransition`—is monotonic and outside
  the modeled local rollback/clone boundary. The one logical sequencer, external
  head-trust service, and independent recovery plane serialize their guarded
  transitions. Local state cannot supply this resistance.
- **Gateway:** current policy/grant read, exact-ID CAS, DecisionRecord/audit, and
  transition to immediate gateway-owned transport are one linearizable durable
  operation. The gateway owns/proxies the only modeled provider/effect/output
  transport. Remote systems are not transactional with it.
- **Closed inventories:** configured closure items, runtime target kinds, and
  permission atoms are complete only inside each finite model. Real closure,
  protected-effect, canonicalizer, adapter, and output-release registries remain
  Open.
- **Identity privacy:** AgentIds, names, scoped principals, projects, drafts,
  bodies, Customs, capsules, and authority values are distinct model values.
  Private-map authenticity and storage are assumed.
- **Availability/fairness:** liveness is conditional on the named authority,
  gateway, transport, or review service eventually remaining available, on a
  finite successor/resource remaining, and on the weak-fairness clauses stated
  below. Safety does not assume availability.

## Toolchain and parser result

Recorded on 2026-07-29:

- Microsoft OpenJDK `21.0.12+8-LTS`;
- `tla2tools-v1.7.4.jar`;
- jar SHA-256
  `936A262061C914694DFD669A543BE24573C45D5AA0FF20A8B96B23D01E050E88`;
- jar SHA-1
  `BEE4A54F3EE3D4AFC347C3240EC2D9E93B075104`;
- SANY2 `2.1` (banner date 24 February 2014);
- TLC2 `2.19` of 08 August 2024, revision `5a47802`.

The jar and JDK were the locally preserved tools under
`%TEMP%\ama-customs-tlc`; no download was performed. SANY parsed and semantically
processed all three final modules with no reported error:

```text
java -cp %TEMP%\ama-customs-tlc\tla2tools-v1.7.4.jar tla2sany.SANY AuthorityCarrier.tla
java -cp %TEMP%\ama-customs-tlc\tla2tools-v1.7.4.jar tla2sany.SANY RuntimeAuthorization.tla
java -cp %TEMP%\ama-customs-tlc\tla2tools-v1.7.4.jar tla2sany.SANY AgentLifecyclePrivacy.tla
```

## Passing finite TLC runs

All passing runs ended with `Model checking completed. No error has been found.`
and zero states left on the queue.

| Configuration | Exact finite scope | Generated | Distinct | Depth |
|---|---|---:|---:|---:|
| `AuthorityCarrier.cfg` (`Spec`) | 1 project × 1 genesis identity; 1 proposal/release/checkpoint ID/site/root/fleet anchor; `{norm0, locator0}` closure; term `{1}`; sequence `{0,1}` | 289,465 | 15,792 | 20 |
| `AuthorityCarrier.adversarial.cfg` (`AdversarialSpec`) | Same identity/closure; 3 releases and 3 checkpoint IDs (2 HeadReceipts plus 1 RecoveryTransition); roots/terms each 2; sequence `{0,1}`; targeted normal selection → same-slot conflict/freeze → higher-term recovery | 410 | 257 | 8 |
| `AuthorityCarrier.fork.cfg` (`ForkHarnessSpec`) | 2 project IDs × 1 genesis; one intentional-fork step; one proposal | 5 | 5 | 2 |
| `RuntimeAuthorization.cfg` (`FiniteSpec`) | 1 request/session; 2 SessionIncarnations, EnforcerGenerations, and policies; 1 grant/deviation; 2 workers; epochs/retries `{0,1}`; 3 target kinds | 22,102 | 4,206 | 15 |
| `RuntimeAuthorization.targeted.cfg` (`TargetedSpec`) | 2 requests, 1 worker, otherwise the same small runtime domains; inference → effect/output, policy-source staleness, crash, and reconciliation actions | 616,169 | 141,366 | 19 |
| `AgentLifecyclePrivacy.cfg` (`Spec`) | One value in each configured AgentId/name/project/principal/draft/body/permission/Custom/capsule/project-authority/agent-authority set; 4 NormKinds and 3 modes | 2,029,281 | 321,904 | 21 |
| `AgentLifecyclePrivacy.mapping.cfg` (`MappingHarnessSpec`) | 2 AgentIds, names, principals, and agent authorities; one value in other configured domains | 1,044,801 | 114,880 | 22 |

Commands:

```text
java -XX:+UseParallelGC -cp %TEMP%\ama-customs-tlc\tla2tools-v1.7.4.jar tlc2.TLC -config AuthorityCarrier.cfg -workers 4 AuthorityCarrier.tla
java -XX:+UseParallelGC -cp %TEMP%\ama-customs-tlc\tla2tools-v1.7.4.jar tlc2.TLC -config AuthorityCarrier.adversarial.cfg -workers 1 AuthorityCarrier.tla
java -XX:+UseParallelGC -cp %TEMP%\ama-customs-tlc\tla2tools-v1.7.4.jar tlc2.TLC -config AuthorityCarrier.fork.cfg -workers 1 AuthorityCarrier.tla
java -XX:+UseParallelGC -cp %TEMP%\ama-customs-tlc\tla2tools-v1.7.4.jar tlc2.TLC -config RuntimeAuthorization.cfg -workers 4 RuntimeAuthorization.tla
java -XX:+UseParallelGC -cp %TEMP%\ama-customs-tlc\tla2tools-v1.7.4.jar tlc2.TLC -config RuntimeAuthorization.targeted.cfg -workers 4 RuntimeAuthorization.tla
java -XX:+UseParallelGC -cp %TEMP%\ama-customs-tlc\tla2tools-v1.7.4.jar tlc2.TLC -config AgentLifecyclePrivacy.cfg -workers 4 AgentLifecyclePrivacy.tla
java -XX:+UseParallelGC -cp %TEMP%\ama-customs-tlc\tla2tools-v1.7.4.jar tlc2.TLC -config AgentLifecyclePrivacy.mapping.cfg -workers 4 AgentLifecyclePrivacy.tla
```

## Checked invariants and temporal properties

### Authority/carrier

The base configuration checks `TypeOK`, `OneLogicalSequencer`,
`AcceptedCheckpointSelectsActiveRelease`,
`NormalHeadReceiptSelectsOrdinaryRelease`,
`RecoveryTransitionSelectsSafeRecoveryRelease`,
`FirstNormalHeadAfterRecoveryParentsTransition`,
`CandidateCarriersAreNonAuthorizing`, `ActiveClosureIsComplete`,
`HeadReceiptEquivocationFreezes`, `GovernanceOnlyRecovery`,
`ForksMintNewIdentity`, and `DefiniteFalseIsResolvedButNeverAuthority`.

It also checks release-metadata immutability, external checkpoint term/sequence
non-rollback, offline proposal-only authority behavior, accepted-checkpoint
complete-closure use, definite-False step semantics, and conditional
sequencer/HeadReceipt/recovery liveness. `Spec` applies weak fairness to
`SequenceFor(i)`, `HeadReceiptFor(i)`, and `RecoveryFor(i)`. The adversarial,
post-recovery, and fork harnesses are safety/reachability harnesses and add no
liveness claim.

### Runtime authorization

Both passing configurations check matching admission for every modeled
send/effect/output release, atomic admit-or-abandon outcome, at-most-one gateway
send/admission, non-authorizing DecisionRecords, deviation-free PolicyBasis,
exact DeviationGrants, separate semantic/render artifacts, SessionGrant as sole
positive authority, and typed targets.

They check admission against the then-current policy/grant/fences, stale-source
blocking, no delayed cached allow, and non-widening lower layers. `FiniteSpec`
uses weak fairness for per-request processing and inference completion;
`TargetedSpec` additionally uses weak fairness for effect resolution. Liveness is
conditional on eventual stable gateway/authority/target transport availability.

### Agent lifecycle/privacy

The full configuration checks type safety, unique readable names, project-local
private-map bijection, immutable exactly-one NormBody metadata, explicit
non-widening self-adoption, mapped-owner-only overlays, no authorship activation,
project-authority promotion, inactive imports before review, fail-closed
missing/ambiguous/erased mapping, retirement erasure, and AgentId-free capsules.

It checks immutable drafts, fail-closed attempts, non-reuse of retired AgentIds,
and conditional promotion/mapping/draft review liveness. `Spec` uses weak
fairness for mapping, draft, and Custom review and for promotion. The mapping
harness uses weak fairness for mapping review.

It does **not** model immutable Custom revision/supersession evolution. There is
no overlay-series identifier, Custom revision/predecessor/current pointer,
successor transition, competing-successor selection, superseded/retired
revision state, or successor re-review rule. The checked promotion binds a new
Custom ID to one exact source draft/body, but this is not evidence for
one-active-revision-per-series, exact revision lineage across later revisions,
no inherited `PersonalActive`, or provenance-only old revisions. Those semantics
remain HOLD for a separately reviewed formal extension.

## Expected-failure mutation and reachability runs

These configurations intentionally ask TLC to falsify a mutation invariant or a
“not reached” sentinel. The reported violation is the expected result. Counts are
the states seen when TLC stopped at its first counterexample, not complete-search
counts. The retained Authority expected-failure counts below use one TLC worker
so their counterexample search order is reproducible within this tool version.
`AuthorityCarrier.post-recovery-reach.cfg` closes one identity/site and the
two-item required closure over 2 proposals, 4 releases, 4 shared checkpoint IDs,
2 root keys, terms `{1,2}`, and sequences `{0,1}`. Other reach/mutation bounds
are explicit in their named configurations.

| Configuration | Expected counterexample | State | Generated / distinct | Depth |
|---|---|---:|---:|---:|
| `AuthorityCarrier.mutation.cfg` | local candidate used without an accepted checkpoint violates `CandidateCarriersAreNonAuthorizing` | 4 | 975 / 285 | 4 |
| `AuthorityCarrier.equivocation-reach.cfg` | conflicting same-slot HeadReceipt freezes | 6 | 34 / 34 | 6 |
| `AuthorityCarrier.recovery-reach.cfg` | `SafeRecoveryRelease` then distinct `RecoveryTransition` reaches the higher term at sequence zero | 8 | 242 / 173 | 8 |
| `AuthorityCarrier.post-recovery-reach.cfg` | next normal HeadReceipt reaches higher-term sequence one and parents the RecoveryTransition | 11 | 96,472 / 41,320 | 11 |
| `AuthorityCarrier.false-applicability-reach.cfg` | complete release remains usable with a definite-False Custom excluded | 10 | 82,415 / 5,640 | 10 |
| `AuthorityCarrier.fork-reach.cfg` | intentional fork mints a different ProjectIdentity | 2 | 2 / 2 | 2 |
| `AuthorityCarrier.offline-reach.cfg` | witness unavailable, then offline GovernanceProposal authored with no authority advance | 3 | 281 / 114 | 3 |
| `RuntimeAuthorization.mutation.cfg` | cached denied DecisionRecord used as bearer send violates matching admission | 5 | 111 / 73 | 5 |
| `RuntimeAuthorization.crash-reach.cfg` | CAS/admit/audit followed by crash-before-transport is reachable | 4 | 26 / 18 | 4 |
| `RuntimeAuthorization.reconciliation-reach.cfg` | sent effect becomes unknown and enters reconciliation after crash | 8 | 1,344 / 600 | 8 |
| `RuntimeAuthorization.stale-reach.cfg` | policy changes after inference; later downstream request is denied | 8 | 2,690 / 1,192 | 8 |
| `AgentLifecyclePrivacy.mutation.cfg` | name/self-claim activates overlay after map erasure; mapped-owner invariant fails | 4 | 99 / 58 | 4 |
| `AgentLifecyclePrivacy.promotion-reach.cfg` | explicit adoption/trial/request creates a new project-authority Custom | 7 | 304 / 123 | 7 |
| `AgentLifecyclePrivacy.capsule-reach.cfg` | active project Custom projects to an AgentId-free capsule | 10 | 660 / 272 | 10 |
| `AgentLifecyclePrivacy.ambiguity-reach.cfg` | conflicting project-principal mapping enters ambiguity quarantine | 3 | 47 / 34 | 3 |
| `AgentLifecyclePrivacy.failclosed-reach.cfg` | erased map followed by overlay attempt records fail-closed denial | 3 | 56 / 38 | 3 |

Unsafe mutation actions are isolated in mutation-only specification operators
and are never members of a passing specification. Reachability configurations
use production actions and intentionally falsify only their “not reached”
sentinels.

## Evidence boundary and HOLD

The following remain outside these bounded results:

- canonical object/release/HeadReceipt/RecoveryTransition/SafeRecoveryRelease
  schemas, carrier encoding, signed-byte domain, signature/threshold suite, and
  real external-head/recovery protocol;
- proof or implementation evidence that the external accepted-checkpoint store
  cannot be rolled back, cloned, partitioned into undetected views, or bypassed;
- physical project-root/bootstrap discovery, deterministic root-relative
  resolution, traversal/symlink/junction/reparse-point confinement, explicit
  missing-versus-malformed outcomes, resolver traces, and carrier inclusion in
  portability export. `carrierAt` and `CopyCarrier` are logical abstractions
  only. External negative tests must cover absolute/UNC/drive and dot-segment
  escapes, encoded separators, link/reparse escapes, root or mirror byte
  substitution, visible Unsupported for missing bootstrap, quarantine for
  malformed material, and export round-trip inclusion;
- a closed real normative closure, protected-effect/output-release inventory,
  request/envelope canonicalizers, and adapter contract;
- implementation rejection of atom-local applicability/skipping. The formal
  model has whole-Custom/NormBody applicability only and no atom dimension;
- immutable Custom revision/supersession, exact predecessor/current-series
  selection, concurrent-successor quarantine, successor re-review, exact
  revision promotion lineage, and provenance-only superseded revisions;
- OS/container containment and proof that the gateway owns every relevant
  provider/effect/output path;
- cross-implementation vectors, continuous independent observation, malicious
  implementation resistance, and vendor-hidden inference/compaction coverage;
- unbounded safety or liveness proofs and any availability claim during
  authority partition.

Finite TLC is evidence, never universal proof. Implementation remains **HOLD**.
TLC-generated states, checkpoints, and captured output are temporary validation
artifacts and are not committed.
