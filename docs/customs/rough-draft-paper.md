# Portable Agentic Customs: A Governance and Portability Substrate for Agent Systems

> **ROUGH DRAFT — academic paper baseline, 2026-07-29.**
>
> This document is non-final research documentation. It neither ratifies the standard nor authorizes an
> implementation. Every substantive claim is keyed to the
> [claim-to-evidence ledger](claim-evidence-ledger.md); governance status is controlled by the
> [decision ledger](decision-ledger.md).

Candidate `PACS-*` clause identifiers cited below refer to the final three-document specification state at
commit `ba74c76cdd90a61ccdb3bda9460f8c4d07af49ee`. Their presence records a formal obligation, not Ratification
or evidence that an implementation satisfies it.

Exact Candidate wire mechanics cited in §§25–26 refer to `docs/customs/wire-format-profile.md` at commit
`beb974c30a922ca47679b1427dd241923a13628d`, which supersedes the earlier recovery-qualified profile. They do
not resolve that profile’s enumerated HOLD items or authorize an implementation.

## Abstract

Agent systems increasingly combine instructions, identities, tools, trust decisions, and vendor-specific
runtime behavior. Moving such a system between hosts or vendors risks either losing its governance or
mistaking advisory text for enforced policy. This draft frames **Portable Agentic Customs** as a governed
set of scoped norms whose effective, request-specific projection is a **Charter**. It separates portable
normative meaning from implementation profiles and empirical vendor adapters. Methodologically, each major
assertion is tied to a governance report, primary source, falsifiable formal obligation, or bounded empirical
test. The Candidate architecture uses immutable content-addressed objects, carrier-independent active-head
authorization, and local trust/mount sidecars, while keeping HeadReceipt authority distinct from
non-authorizing witness transparency. Its guarantee is deliberately narrower than “agent obedience”:
authenticated delivery and completely mediated declared effects are plausible enforcement boundaries;
natural-language compliance and vendor-hidden inference or compaction are not. Identity likewise separates
immutable `AgentId` from names, sessions, providers, models, accounts, and keys. The paper specifies
falsifiers, threat profiles, and evidence modes, and treats RFC 9942/9943 SCITT receipts as
registration/inclusion/consistency evidence rather than project authority. Carrier encoding, authority
recovery, general physical discovery, portable lifecycle evidence, freshness, exact schemas, effect algebra,
accepted formal proofs, and adapter contracts remain unresolved; implementation remains **HOLD**.

## 1. Problem and scope

A portable policy bundle has at least three separate jobs: preserve what was decided, determine which
decisions apply to a request, and constrain effects in an actual runtime. Collapsing these jobs into a
single prompt overstates what a host can guarantee. A vendor may perform hidden inference, summarize or
compact context, and expose only a partial effect surface. Therefore this draft treats natural-language
instructions as inputs to behavior, not as an enforcement mechanism [C-001, C-002].

The standard’s intended subject is governance metadata and its deterministic projection. It does not define
agent cognition, guarantee semantic obedience, prescribe one vendor, or store “culture” as a transferable
object [C-003].

This draft studies four falsifiable research questions:

1. **RQ1 — reproducibility:** can independent implementations compute identical Charters, including identical
   denial and conflict outputs, from a closed verified input tuple?
2. **RQ2 — authority continuity:** can a carrier-independent governance protocol select at most one active
   trusted head under stated crash, rollback/clone, and Byzantine threat profiles?
3. **RQ3 — enforcement boundary:** can an implementation demonstrate that every effect in a declared closed
   protected set crosses a named decision and containment boundary?
4. **RQ4 — evidence calibration:** which formal, exhaustive, sampled, or continuously observed evidence
   justifies each capability claim without generalizing beyond its domain?

The null result for any question is operational: divergent Charter vectors falsify RQ1; two simultaneously
accepted conflicting heads falsify RQ2 under the claimed assumptions; one successful protected-effect bypass
falsifies RQ3; and an unbound or over-general conformance assertion fails RQ4 [C-024, C-025, C-250–C-253].

## 2. Vocabulary

The following semantic core is reported as **Ratified** [C-010–C-014]:

- A **Custom** is one scoped norm.
- **Customs** is a governed set of Customs.
- A **Charter** is the request-specific deterministic effective projection of applicable Customs.
- **Culture** is an emergent social outcome, not a stored object.
- `AgentId` is a stable immutable agent identity, distinct from a human-readable name and from session,
  profile, provider, model, account, and key identifiers. A human-readable name is a fleet-local, one-to-one
  current display binding, not an authenticator.

These definitions do not yet imply a wire schema. Capitalization in this draft marks terms of art, not
types in a ratified data model.

## 3. Assurance boundary

The portable claim is intentionally narrow [C-020–C-023].

1. A verifier may establish that declared objects and releases were authenticated under a selected trust
   policy.
2. A conforming host may establish which declared effects passed through its mediation boundary and whether
   it allowed them under the computed Charter.
3. Neither result proves that a model understood or obeyed natural language.
4. Effects outside the host’s complete mediation are outside the enforcement claim.

This boundary creates two formal obligations. **Projection determinism** requires that the same verified
inputs, request facts, algorithm version, and local mounts produce the same Charter. **Complete mediation**
requires an inventory showing that every protected effect is either intercepted or explicitly declared
uncontained. Both obligations are open pending formalization [C-024, C-025].

## 4. Identity and privacy

Portable capsules must not expose `AgentId` by default. Instead, an export or project derives or allocates a
principal that is scoped to that context; the mapping back to `AgentId` remains private and local
[C-030, C-031]. This prevents a stable fleet identity from becoming an unnecessary cross-context
correlator. W3C DID privacy guidance independently documents correlation risks and recommends pairwise
unique information; it supports the privacy rationale but does not determine this standard’s mechanism
[C-032].

Names are presentation state. Renaming does not rotate identity, transfer authority, or invalidate the
private mapping. Keys authenticate statements or capabilities under a trust policy; they are not identical
to the agent they currently represent [C-033].

## 5. Portable object model

The current **Candidate** architecture is an immutable content-addressed graph [C-040–C-044]:

- immutable objects carry Customs and other declared metadata;
- immutable releases select graph roots and dependency edges;
- signatures authenticate defined bytes and signer statements;
- content identifiers bind to a specified digest domain;
- local sidecars record mutable trust roots, mounts, approvals, private identity mappings, and runtime
  bindings without rewriting portable objects.

This split permits two sites to possess the same portable graph while making different local trust and mount
decisions. Deterministic serialization is a prerequisite for stable byte-level hashes and signatures, but
no carrier encoding has been selected. RFC 8785 provides deterministic JSON; RFC 8949 provides deterministic
CBOR rules; COSE provides CBOR signing structures. These are evidence that suitable building blocks exist,
not a decision to adopt any one of them [C-045–C-047].

Release verification must eventually address rollback, freeze, key compromise, delegation, and threshold
policy. TUF demonstrates role-separated signed metadata, hashes and sizes, thresholds, and freshness
metadata; in-toto demonstrates signed layouts and evidence for authorized steps. They are comparative
precedent, not incorporated specifications [C-048, C-049].

## 6. Charter projection

At a conceptual level, projection consumes:

`verified graph + local mounts/trust + authenticated request facts + algorithm version`

and returns:

`ordered effective Customs + provenance + conflicts/denials + declared assurance limits`.

“Deterministic” does not mean globally context-free. It means that all decision-relevant inputs and the
algorithm are explicit enough for independent implementations to reproduce the result [C-050]. Scope
matching, precedence, conflict resolution, defaults, denial behavior, and obligation composition remain
**Open**. Until those are formalized, no implementation can claim Charter conformance [C-051].

## 7. Three non-interchangeable lanes

### 7.1 Normative standard

This lane will eventually define portable semantics, verification inputs and outputs, conformance classes,
security requirements, and test vectors. Only ratified propositions are binding. Exact schemas are Open.

### 7.2 Implementation profile

A profile may choose JSON/JCS or CBOR, a signature envelope, hash suite, storage layout, resolver protocol,
and effect-mediation architecture. Profiles must state which choices are required for interoperability and
which are local. The content-addressed signed-graph architecture is currently Candidate, not normative.

### 7.3 Vendor adapters

An adapter maps a particular runtime’s identities, context channels, tools, approvals, hooks, and observed
effects onto a profile. Findings must name vendor, version, platform, date, and test method. Hidden
inference and compaction are treated as unobservable unless a vendor supplies an authenticated contract.
No adapter observation can ratify portable semantics [C-060–C-062].

## 8. Security and failure model

The threat model must include malicious or stale carriers, graph substitution, replay/rollback, compromised
signing keys, ambiguous serialization, dependency confusion, privacy correlation, dishonest adapters,
unmediated effects, and policy conflicts [C-070]. A signature proves only what its verification procedure,
trust policy, and signed-byte definition establish; it does not prove truth, safety, freshness, or agent
obedience [C-071].

Offline verification creates a freshness boundary: without a trusted time or reachable authority, a client
may verify integrity and authorization relative to cached state but cannot in general establish that it has
the newest valid release or revocation information [C-072]. The precise offline acceptance rule and
authority-recovery process are Open.

## 9. Research method and conformance evidence

Each major claim must have one of:

- a primary normative or technical source;
- a formal proof obligation with defined inputs and property;
- an empirical test with environment, procedure, expected result, and retained artifact.

Governance reports are recorded separately as G-class evidence: they establish the local status report but
are not mislabeled as retrievable primary sources. Secondary summaries may guide discovery but do not close
a claim. A claim is accepted only at its exact stated scope; absence of a counterexample is not treated as
proof outside the tested or modeled domain. Conformance research should use cross-implementation vectors for
serialization, hashes, signature verification, graph resolution, projection, conflict handling, privacy
defaults, and effect mediation [C-080, C-081].

Evidence artifacts must name the system build and configuration, canonical inputs, oracle, observer,
procedure, threat assumptions, result, and retained trace. Formal results must additionally publish the
model-to-system correspondence and checked bounds. Empirical results must distinguish exhaustive coverage of
a proved finite closed domain from a non-exhaustive sample and from continuous observation of a named
operational interval [C-250–C-253].

## 10. Current result

The vocabulary and identity distinctions listed as Ratified form a useful semantic nucleus. The narrower
assurance boundary avoids promising control over vendor-hidden model behavior. However, the work is not
implementation-ready. Universal carrier encoding and physical carrier, exact schemas, authority recovery,
offline freshness, obligation algebra, protected-effect inventory and containment, vendor adapter
contracts, and complete Charter projection rules remain Open or Candidate. The implementation state is
therefore **HOLD** [C-090].

## 11. Limitations

This baseline was reconstructed from the manager’s authorized brief and primary public specifications. It
does not contain recoverable prose from the prior steward’s blocked worktree, and it does not claim that the
local repository is canonical governance state. Future updates must reconcile forwarded canonical material
claim by claim, retaining superseded states in the ledgers and changelog.

The principal validity threats are construct validity (whether the capability cells measure the intended
security property), internal validity (whether the observer and harness actually cover the claimed boundary),
external validity (whether a result transfers across vendors, versions, platforms, and threat profiles), and
conclusion validity (whether finite evidence is over-generalized). The evidence schema in §27 is designed to
expose rather than erase those limits. No implementation or accepted formal artifact presently supplies the
results needed to lift HOLD [C-061, C-190, C-192, C-250–C-253].

## 12. Reconciled v0 candidate authorization machine

This section records a reconciled architecture as **Candidate**. Four typed decision views bind progressively
more runtime state, but they are not four mandatory persisted objects. No decision for one kind authorizes
another [C-100–C-112].

### 12.1 Policy binding

A deviation-free `PolicyBasis` deterministically compiles active Kernel, Fleet, Project, and optional agent
Customs plus registry/compiler refs. Exact `DeviationGrant`s then bind the PolicyBasis digest, `RuleRef`,
subject/target scope, expiry, authority, and compensation. The Candidate authoritative policy binding is the
canonical PolicyBasis `BlobRef`, exact compiler/canonicalizer `SchemaId`, sorted accepted DeviationGrant
commitments, and a domain-separated `FinalPolicyTupleDigest`; the in-memory tuple is recomputed. A separately
materialized `PolicyImage` remains Open/HOLD and, if emitted diagnostically, is non-authorizing. Admission
must bind the final tuple and request-specific SemanticCharter.

`FleetRef` is irreducible: a project or agent cannot compile away the fleet ceiling. The compiler is a
versioned deterministic component, not a model. A model compiling the policy that governs its own request
would make the trust argument circular. The artifact digest is output/binding, not an input to its own
compilation. A DeviationGrant cannot bind a final tuple commitment that recursively includes itself [C-106].

### 12.2 ActivationTarget

An `ActivationTarget` binds the final policy tuple to stable `AgentId`, provider/adapter, `enforcerId`,
distinct `SessionIncarnation`, and authority-owned live Enforcer/Activation generation (`ActivationFence`).
An enforcer/worker restart rotates the generation but preserves the logical SessionIncarnation. Only logical
session recreation/resurrection mints a new incarnation. A local incarnation/fence does not survive exact
cloning; only external gateway single-live-channel/generation state can fence clones [C-107].

### 12.3 InferenceAdmissionTarget and RequestCharter

An `InferenceAdmissionTarget` binds exact grant/deviations and canonical request; both the vendor-neutral
`SemanticCharter` and adapter-specific `CharterRendering` / `VendorRequestManifest` digests; renderer/adapter
profile; and the complete observable provider envelope. Only its registered provider token is lowercase
ASCII. Model/deployment, account, tenant/project, endpoint, region/routing, context/cache, and
conversation/thread identifiers are length-bounded exact opaque bytes: PACS performs no implicit case
folding, Unicode or URI normalization, or re-encoding. The manifest CID binds the finalized envelope; the
inference target then binds that CID, so the manifest does not embed its own eventual target digest. Tool
definitions and implementation identities, ordered attachments, all instruction channels/roles, generation
parameters, and final exact bytes/length are likewise bound. Rendering finishes before admission; overflow,
silent truncation, or mutation denies [C-108–C-110].

### 12.4 EffectAuthorizationTarget

An `EffectAuthorizationTarget` binds activation, grant, deviations, a fully canonicalized capability target,
adapter, origin inference, and stable operation identifier. `output.release` is a typed Effect. A strong
profile buffers final output and freshly authorizes release; streaming/chunk disclosure is weaker and
irreversible. Scheduled work receives a fresh execution-time decision [C-111].

A `DecisionRequest` and non-authorizing `DecisionRecord` are Candidate only as a closed discriminated union
of `activate | infer | effect`. An audit receipt, if emitted, is explicitly non-authorizing. The signed
domain includes kind and target-specific bindings, making records non-interchangeable across kind, fence,
incarnation, project, adapter, provider, and model [C-112].

## 13. Freshness profiles

**Decision-current admission** requires an authoritative guarded gateway that owns or proxies the actual
provider/effect transport. A durable queue/outbox entry is unauthorizing intent. At dequeue/execution the
gateway re-evaluates, atomically checks current policy and grant, CAS-consumes the exact attempt/request,
writes the DecisionRecord/audit, and transitions the job to immediate gateway-owned send. A delayed or
recovered job re-evaluates; no cached allow survives. The untrusted agent worker receives neither reusable
authorization nor provider/effect transport authority. Currentness exists at this local linearization;
remote completion is only admitted [C-120–C-123].

Other profiles are **bounded-stability** and **snapshot**. Neither claims decision-current admission.
Authority changes cannot retroactively stop accepted remote work, retract disclosed output, or undo effects
[C-124, C-125].

## 14. Candidate v0 precedence and obligation algebra

Validation, freshness, and required-audit failures deny. Kernel and exact `SessionGrant` ceilings are
nonwaivable. Fleet, Project, and agent constraints combine by commutative monotone meet; lower authority
cannot waive a higher rule. Canonical scope order is diagnostics/serialization only. Exact governed
DeviationGrants handle only their named waivable rules [C-130].

| Field | Meet |
|---|---|
| complete `(action, resource, destination, conditions)` capability tuples | relation intersection or membership predicate over fully canonicalized target |
| `maxRisk`, `maxData` | meet in named registered lattices |
| `maxBytes`, `validUntil` | minimum |
| requirements | conjunctive all-of typed evidence |
| `auditTags` | set union |
| `sandbox` | Boolean OR |

Independent action/resource/destination intersections are forbidden because they can synthesize cross-product
authority. Approval is typed evidence for a fresh current decision, never permission by itself. Complex
threshold/quorum logic is one externally attested evidence atom or remains Open. Unknown or invalid meet
denies [C-131, C-132].

## 15. Candidate release and carrier profile

`ProjectIdentity = (random ProjectId, GenesisDigest)`. Two independent local bindings bootstrap it:
`ProjectTrustPin` binds ProjectId/genesis/project root or locator; `FleetTrustAnchor` supplies FleetRef. A
project never selects its fleet ceiling or self-authenticates, and fleet identity is not embedded in project
identity because the same logical project identity may be rebound under a different Fleet authority.

That logical portability does **not** establish that another implementation can discover Customs merely
because a project directory or archive moved. The Candidate `pacs-project-fs-v1` profile is one bounded
construction: it checks only `.pacs/carrier.cbor` below a supplied root, resolves exact derived closed-store
paths of the form `.pacs/store/{o,b,c}/sha256/<digest>` where the digest matches `[a-z2-7]{52}`,
confines reads to stable ordinary-file handles, and reports distinct `CarrierUnsupported`,
`CarrierQuarantined`, or unauthorizing `CandidateStaged` outcomes. A conforming export includes that bootstrap
and every required store entry but excludes trust pins, Fleet/recovery anchors, high-water state, grants,
sessions, private identity mappings, keys, and durable nonces; those are independently reattached at the
destination [C-052, C-053; PACS-CARRIER-001–006].

This profile does not settle universal project-root discovery, POSIX/Windows mappings, case and reserved
device rules, network filesystems, archive/container extraction, media registration, atomic publication,
resource ceilings, or independent cross-platform vectors. Those remain **HOLD-CARRIER-001**, and no general
claim that “moving the project moves Customs” is supported.

The portable graph has one active linear governance checkpoint per ProjectIdentity. A normal HeadReceipt
selects an ordinary Release; an independently accepted RecoveryTransition at higher term/sequence 0 selects
only its SafeRecoveryRelease, and the next normal HeadReceipt parents it at sequence 1. Copies, clones, and
worktrees preserve identity. Competing same-position checkpoints are equivocation and quarantine. An
intentional fork mints a new ProjectId/GenesisDigest with optional parent provenance; no runtime fork
identifier exists.

Verification tracks a local high-water mark and fails on missing, corrupt, unsupported, or equivocal
required material [C-140–C-143].

A capsule or export carries a closed portable graph only under its named transport/discovery profile and
verified inclusion rules; otherwise it is merely offered Carrier material. Local sidecars contain trust
pins, mounts, private keys/endpoints, high-water state, decision/audit records, caches, compiled Charters,
and the private `AgentId` map. Capsules contain no secrets, process fences, or reusable authority credentials
[C-144].

Root loss has no magical recovery. Content addressing detects differing objects but does not stop a cloned
signer from presenting consistent, signed split views; signer equivocation remains HOLD without a
witness/transparency mechanism. Certificate Transparency gossip is precedent for isolated-view limitations,
not an adopted Customs protocol [C-145, C-146].

## 16. Agent Customs lifecycle

Personal and trial Customs can steer security-relevant choices, but cannot expand reference-monitor
authority, mutate higher governance, or enter another AgentId’s Charter. Trials require isolation and
consent; agent authorship never activates. The Candidate lifecycle is:

`draft → trial/shadow → personal active → promotion proposal/review → new project Custom`.

There is no silent promotion or synchronization. Self-adoption requires explicit granted capability and a
non-widening check. Promotion creates a new project-owned Custom with lineage/provenance and project
governance authorization, review, and active-head selection. Identity authority binds stable AgentId to the
session and private `(ProjectId, ProjectPrincipalId) ↔ AgentId` map; missing or ambiguous mapping denies, and
name/self-claim never resolves it. Imports are inactive in quarantine [C-150–C-153].

Within a scoped overlay or project-Custom series, revision evolution is **Candidate**, immutable, and
non-numeric: revision 0 has a null predecessor; each successor is exact +1 from the same-key current
predecessor and re-enters full review without inheriting `PersonalActive` or Release-current state. At most
one revision per series is active/current. Concurrent successors remain inactive or quarantined until review
selects one; activation atomically retires the predecessor, which remains non-projecting provenance rather
than latent authority. Imports and claimed currentness begin inactive [C-154; PACS-LIFE-005/007/008/009].

PACS-LIFE-004 requires promotion to create a new immutable project-owned Custom with lineage to the exact
source overlay revision. That is a normative obligation, not current implementation evidence: the corrected
wire profile lacks a distinguished promotion-source commitment, generic dependency/predecessor edges cannot
substitute for it, and `AgentLifecyclePrivacy` has no series/revision/supersession state machine. Portable
lifecycle evidence, promotion-source binding, concurrency selection, provenance retention/erasure, and a
reviewed formal refinement remain **Unsupported/HOLD-LIFECYCLE-001** [C-155].

## 17. Assurance and containment

Conformance is a capability matrix, not a monotone ladder [C-160]. Independent columns are **Carrier**,
**Projection**, **Delivery**, **EffectAuthorization**, **EffectContainment**, **OutputRelease**, and
**SemanticEvaluation**. Each reports `Enforced`, `Detected`, `Empirical`, or `Unsupported` where meaningful.
A strong Carrier cell implies nothing about output or semantics. Freshness and threat profiles are
orthogonal. One “Customs enabled” flag is prohibited.

Full containment cannot be claimed for an ambient vendor CLI without OS/container isolation and brokered
filesystem, process, network, Git, secrets, and browser access. The protected-boundary registry must cover at
least provider data/cost, output release, filesystem, process, network, Git, bus/messages, memory, Customs
mutation, credentials, browser/UI, approvals/delegation, project/session lifecycle, attachments, telemetry,
updates/plugins/MCP, and schedulers. Queued actions re-authorize when executed [C-161–C-163].

This boundary follows established reasoning: complete mediation checks every access; a reference monitor is
always invoked, tamper-resistant, and verifiable; PDP/PEP architectures separate decision from enforcement;
and execution monitoring cannot enforce arbitrary semantic properties [C-164–C-167]. Saltzer and
Schroeder’s economy-of-mechanism principle supports keeping the v0 meet small. OPA’s signed-bundle behavior
is useful implementation precedent for validate-before-activation; its documentation says conflicting
bundles loaded at different times may enter an error state and supplies no cross-bundle ordering. OPA is not
an adopted Customs engine [C-168].

## 18. Rejected hard claims and explicit degradation

Rejected claims include: every physical vendor inference was admitted; hidden retry or compaction carried
the Charter; the model understood or obeyed; remote cancellation retroactively retracted accepted work or
delivered output; decision-current admission remained available through authority partition; and external
effects are universally exactly once [C-170].

Required degradations and tests are explicit: guidance overflow denies; admitted bytes are checked exactly;
a hidden-call stub is reported outside assurance; a mid-turn generation change blocks later tools and
quarantines or labels the remaining stream; an ignored interrupt yields `cancellation-unconfirmed` with zero
authorized effects; ambient raw-effect attempts must fail before containment is advertised; authoritative
guidance change rotates to a new provider context [C-171].

## 19. Counterexample catalogue

Mandatory negative vectors include queued-decision TOCTOU; render-after-admission suffix; hidden/cached
provider context; inference decision reused for effect; exact-clone double-spend; rollback; signer split
view; midstream output release; fact spoof/provenance downgrade; relational cross-product; account/tenant/
endpoint replay; project-trust/fleet-trust/locator substitution; scoped-map loss/erasure; AgentId/name/
self-claim confusion; session resurrection/ABA; model-in-compiler and deviation/image circularity; and
approval replay after a policy change [C-180].

## 20. Automated conformance oracles

The Candidate suite defines falsification oracles [C-181]. Passing a non-exhaustive suite is bounded evidence
and does not establish general enforcement:

- zero adapter-dispatched provider calls observed at the named controlled boundary without a valid admission
  decision and exact final-envelope equality;
- at-most-one authoritative gateway send transition per exact attempt and no cross-kind/fence/incarnation/
  project/adapter/provider/model/account/tenant/endpoint reuse;
- zero protected effects without a fresh effect decision;
- head changes invalidate unconsumed requests, while admitted operations remain admitted; overflow denies;
- fail-closed unknown fields/old peers and stable operation identifiers;
- new provider context after authoritative guidance changes;
- execution-time scheduler, bus, and approval checks;
- containment bypass tests for every claimed boundary;
- display-name rebinding changes no ownership;
- offline stale capsules cause zero decision-current admission;
- assurance is emitted capability-by-capability, never as one enabled flag.

## 21. Formal gate

The formal gate is organized as three TLA+/PlusCal modules [C-190]:

- **A — authority and carrier:** independent project/fleet trust, releases, high-water rollback,
  equivocation, moves, and intentional new-identity forks;
- **B — runtime authorization:** activation, admission, effects, grants, restart fences, generation changes,
  and compaction;
- **C — agent lifecycle and privacy:** identity/name separation, scoped principals, trials, promotion,
  quarantine, and erasure.

The gate requires safety properties plus conditional liveness under explicit availability/fairness
assumptions, and retained model-check artifacts before any ratification proposal. Lamport’s separation of
safety and liveness motivates the structure but proves nothing about this Candidate [C-191].

The current evidence is a set of peer-reported finite model checks, not an accepted proof. Under Microsoft
OpenJDK 21.0.12+8 and tla2tools 1.7.4 (SANY2 2.1; TLC2 2.19, revision `5a47802`), SANY reported no semantic
errors for all three modules. The executable artifacts and exact commands/configurations are committed at
formal state `70458fc6cc7903d6da984865c617e3f1ef5bcb38`, based on gate
`a2b57551863241d90bca663ee07190accfa834d2` [C-193]. TLC reported the following completed no-error explorations
[C-195]:

| Configuration | Explicit bounded scope | Generated / distinct / depth |
|---|---|---:|
| `AuthorityCarrier.cfg` | one identity, proposal, release, HeadReceipt, and site; two closure items; term 1; sequences 0/1 | 289,465 / 15,792 / 20 |
| `AuthorityCarrier.adversarial.cfg` | three release/HeadReceipt slots; two roots and terms; targeted equivocation freeze and higher-term governance recovery | 410 / 257 / 8 |
| `AuthorityCarrier.fork.cfg` | intentional new-identity fork harness | 5 / 5 / 2 |
| `RuntimeAuthorization.cfg` | one-request `FiniteSpec` | 22,102 / 4,206 / 15 |
| `RuntimeAuthorization.targeted.cfg` | two-request inference-to-effect/output, stale-source, crash/reconciliation harness | 616,169 / 141,366 / 19 |
| `AgentLifecyclePrivacy.cfg` | one instance of each modeled identity/lifecycle artifact | 2,029,281 / 321,904 / 21 |
| `AgentLifecyclePrivacy.mapping.cfg` | two-agent/name/principal mapping harness | 1,044,801 / 114,880 / 22 |

The targeted harnesses also produced three expected mutation counterexamples—for unsafe carrier
authorization, cached DecisionRecord bearer use, and post-erasure name/self-claim overlay—and thirteen
reachability sentinels for the intended equivocation, recovery, Custom-level definite-False, intentional-fork,
offline-proposal, post-recovery sequence-1 normal-head parent path, crash, reconciliation, stale-downstream,
promotion, capsule, ambiguity, and erased-map fail-closed states. The new post-recovery harness reaches its
sentinel at state 11 after 96,472 generated and 41,320 distinct states. Those targeted counts stop at the
first expected counterexample and are not exhaustive-search totals [C-196].

The seven passing results exhaust only the enumerated finite configurations and modeled invariants, subject
to TLC fingerprinting. They do not establish universal correctness, cryptographic or canonicalization
correctness, cross-implementation conformance, hidden-vendor behavior, continuous observation, or
model-to-implementation correspondence.
External monotonic non-rollback HeadReceipt trust, closure/effect-registry completeness, a durable linearizable
gateway CAS/audit/sole-transport boundary, OS containment, and weak fairness/eventual availability remain
assumptions or Open obligations. Formal acceptance and implementation therefore remain **HOLD**
[C-190, C-192, C-194].

The retained formal README explicitly excludes any claim that TLC covers Custom series/revision/currentness/
successor/supersession/re-review/concurrency/provenance semantics or physical project-root discovery,
filesystem confinement, discovery outcomes, resolver traces, and export inclusion. Those obligations require
separate models and external negative/cross-implementation tests [C-052, C-053, C-154, C-155].

Implementation remains **HOLD** until canonical encoding/schema, trust bootstrap/recovery, carrier profiles,
accepted formal review and model-to-implementation correspondence, cross-implementation vectors, a closed
effect registry/canonicalizers, atomic guarded dispatch, exact adapter capacity tests, OS containment,
output-release rules, authority epochs/high-water/nonces, stable `AgentId` bindings, and auxiliary-inference
inventory are resolved [C-192].

## 22. Closed Custom and applicability candidate

One v0 Custom is one immutable `NormBody`, not a multi-clause bundle [C-200]:

- **Guard** — forbids or constrains; never positively Allows. Positive authority comes from SessionGrant or
  capability-grant state.
- **Requirement** — typed all-of evidence; the narrowly proposed
  `InstantaneousAttestationPrecondition` form is examined in §26.
- **Guidance** — mandatory semantic content without machine-obedience assurance.
- **Evaluation** — empirical evidence only and never authority.

Authorship, observations, and rationale are provenance, not applicability or authority. Applicability uses
closed registered selectors over a canonical authenticated `FactSnapshot` with issuer, provenance, and
freshness. Evaluation is three-valued once per one-NormBody Custom: definite False omits the whole Custom
with provenance; definite True evaluates its NormBody; and any security-relevant Unknown—including Guidance
applicability—denies projection until the fact exists. Applicability never silently skips individual
Requirement atoms. Evaluation NormBodies may remain unknown but cannot authorize [C-201, C-202, C-241].

Ordering exists only for canonical serialization and diagnostics; authority composition is monotone
narrowing. Different content in one declared exclusive guidance slot is a fatal conflict. Arbitrary
semantic contradiction across distinct guidance remains empirical/Open [C-203].

## 23. Threat profiles and achievable claim

Claims separately name base crash/restart, rollback/clone resistance, or Byzantine signer/equivocation
profiles [C-210]. Local nonce sets, fences, high-water, and VM state do not survive an exact clone or
rollback. Strong anti-clone requires an external non-rollback authoritative ledger/gateway, hardware
fencing, quorum/consensus, destination deduplication, or sole channel ownership. The base claim is
**at-most-one authoritative gateway send transition per exact attempt**, never universal exactly-once
provider computation/effect
[C-211, C-212].

Gateway timestamps are audit metadata unless a named trusted-time profile backs them. Security ordering uses
authority epoch and sequence, not wall-clock time [C-213].

## 24. Related work and working name

Related work is compared feature by feature as of 2026-07-29; the comparison supports no priority,
uniqueness, “nearest,” or absence-of-standard conclusion [C-220]. The `.agents Repository Folder
Specification` is a project-carrier comparator for canonical repository configuration and deterministic
resolution. Microsoft Agent Control Specification and Agent OS are enforcement comparators. The individual
AIP draft distinguishes identifier, key material, and human-readable name. AuthZEN’s draft approval profile
returns approval context to a fresh authorization re-evaluation rather than making approval itself authority
[C-221–C-224].

The OpenA2A AAP individual draft is an authorization comparator: it describes scoped grants, brokered
credential confinement outside model reasoning, identity/authorization separation, default deny, and a
limit on semantic-intent authorization. Those overlaps narrow the paper’s claims; its draft status and
different scope support no novelty conclusion [C-260, C-261].

“Customs” also names a trade/border domain, and “PACS” is established medical-imaging terminology. Portable
Agentic Customs / PACS is a working name only pending collision review [C-225].

## 25. Candidate carrier, active-head governance, and recovery

This section incorporates a bounded subset of the preserved `819eedf` proposal as **Candidate** research.
Git repositories, capsules, and `CarrierManifest` objects transport claims but do not confer authority or
choose active state. The Candidate portable object vocabulary includes `ProjectGenesis`,
`CustomRevision`/`OverlayObject`, `Release`, `ClosureManifest`, `CarrierManifest`, and
`GovernanceProposal`; exact names and schemas remain Open [C-230, C-231; PACS-HEAD-001].

A **HeadReceipt** is the sole Candidate normal project-governance selector for an ordinary Release. PACS
accepts it only with a distinct profile-defined head `SignatureBundle` over a typed `SigningStatement` whose
subject is that exact HeadReceipt; the accepted checkpoint is the pair, without making the bundle a second
selector. After independent project/fleet trust, local high-water/term/sequence/parent checks, exact
base-state governance verification, and exact Release/closure/proposal verification, a valid HeadReceipt may
select one ordinary active trusted head. Its closed Candidate body binds:

    (ProjectIdentity, authorityTerm, sequence, parentHeadCheckpointRef(kind, digest), releaseDigest,
     closureManifestDigest, governanceProposalDigest, projectAuthorizationSignatureBundle,
     rootEpoch, flags = 0, optionalNonAuthorizingAuditTime)

The committed Candidate specification records these selection, uniqueness, and sequencer/high-water
obligations as PACS-HEAD-002/003/006.

The base wire profile defines no custom **WitnessReceipt** object. Only after PACS accepts the exact
HeadReceipt/head-SignatureBundle pair may optional `witnessEvidence` be submitted as a separate RFC 9943
Signed Statement wrapping a typed transparency-submit `SigningStatement`. That statement names the head
SignatureBundle as its subject and binds the exact project/authority-term/head scope. An RFC 9942 inclusion
receipt can prove membership at one signed root, and an optional consistency receipt can prove append-only
linkage between two observed roots. Under a separately specified query/comparison policy this evidence can
support split-view detection, but it cannot prove statement truth, substitute for a HeadReceipt, establish
project authority, select a head, resolve a same-slot fork, or override local high-water/parent rules
[C-232, C-233; PACS-HEAD-004/007].

The Candidate governance model uses one logical sequencer. Offline work yields
`GovernanceProposal`s only; stale proposals require explicit rebase and review. Conflicting authorized
HeadReceipts for the same `(ProjectId, authorityTerm, sequence)` freeze or quarantine rather than resolving
by last-writer-wins, wall-clock order, or carrier order. Active closure covers every required normative
object or authenticated locator; missing, unauthenticated, undecryptable, or ambiguous required material
denies activation [C-234, C-235].

A `RecoveryPlane`, if adopted, is an independent Kernel/Fleet governance-only mechanism for fetch, inspect,
verify, restore, authority-term rotation, and a defined trust ceremony. An externally accepted
`RecoveryTransition` is the narrow exception to normal HeadReceipt selection: it is the checkpoint at a
higher authority term and sequence 0, selects only its `SafeRecoveryRelease`, and must be parented by the next
normal HeadReceipt at sequence 1. It is not ordinary project authority and has no ordinary inference, tool,
secret, or protected-effect authority. Project policy cannot authorize its own recovery. Offline activation,
automatic CRDT/LWW governance merge, capsule self-bootstrap, and project-authorized self-recovery remain
**Open**; recovery ceremony, threshold, credential custody, and nonrollback mechanics remain **HOLD**, as
does implementation [C-236, C-237; PACS-REC-001–007].

## 26. Candidate instantaneous attestation precondition

`InstantaneousAttestationPrecondition` (IAP) is a **Candidate** narrow machine-checkable Requirement form: a
finite conjunction of positive authorized attestation atoms evaluated at one protected decision. It excludes
OR, NOT, threshold, counting, arbitrary predicates, and model predicates. Calling IAP the exclusive v0
Requirement would itself require ratification; this paper claims only that the narrow form is analyzable and
falsifiable [C-240].

Applicability belongs to the containing one-NormBody Custom, not to independently skippable atoms. The
projection algorithm evaluates that applicability once:

- definite **False** omits the entire Custom and records the provenance of that result;
- definite **True** requires every IAP atom to verify; and
- security-relevant **Unknown** denies the protected decision.

Thus, no implementation may turn a False or Unknown condition into selective atom skipping [C-241; Candidate
PACS-APP-001/002 and PACS-IAP-006].

Each immutable `EvidenceTypeDef` declares an exact sorted set of allowed closed canonical target kinds. Each
registered target kind fixes its canonicalizer and closed relevant-dimension set. An attestation chooses
exactly one allowed kind and binds one complete `ProtectedTarget` digest over every dimension fixed for that
kind, with no open-ended ambient field set. Missing, extra, partial-reusable, ambiguous, changed, or
disallowed-kind dimensions deny. For example, a requirement about an artifact may bind an artifact digest
without inventing provider dimensions, while an effect attestation binds the canonical effect target and
operation identity declared by its chosen target kind. Project, policy/Charter, grant, request, action,
artifact, observation, and freshness fields are bound only when the registered kind declares them relevant
[C-242, C-243].
The committed Candidate specification records the evidence-definition, closed-dimension, freshness, and
revocation obligations as PACS-IAP-003/004/005.

Every Candidate target kind binds the exact project/Genesis and head/term/sequence/Release/closure authority
tuple, `PolicyBinding`, scoped principal, session/incarnation/enforcer/fence, private identity-mapping
handle/epoch, and grant. Activation has a null SemanticCharter and adds exact activation identity/fence,
adapter/provider scope, effective capability tuples, and atom set. Inference adds the exact Charter, accepted
activation decision, request/attempt, `VendorRequestManifest`, and adapter/provider scope. Effect adds the
exact Charter, accepted activation and origin-inference decisions, origin `TargetDigest`, operation
identifier, indivisible capability tuple, input/output references, and effect adapter. Except for the
registered lowercase-ASCII provider token, provider-envelope identifiers are exact opaque bytes under the
named adapter canonicalizer. The manifest binds the finalized envelope and the inference target binds the
manifest CID, without a manifest/target-digest cycle [C-245].

An attestation also binds the complete target and `TargetDigest`, its `EvidenceTypeDef` and
`RequirementAtom`, issuer authority, expected claim, challenge/observation, and a decision-current nonce or
other independently named freshness input. Its `EvidenceTypeDef` fixes issuer/key policy, claim schema and
media, allowed target kinds and canonicalizer, freshness method, status/revocation policy, and critical
claims. `issuedAt` alone does not establish freshness. Across applicable Customs, IAP conjunction remains
monotone narrowing. Temporal and future postconditions, liveness, history or absence claims, cross-agent
hyperproperties, semantic quality, and consumable evidence remain **Open** unless a completely mediated
monitor is atomically coupled to every relevant effect and has authoritative ordered events, clocks/timers,
durable checkpoint/replay/recovery, and explicit crash semantics [C-243, C-244].

## 27. Conformance evidence and falsifiability

A finite non-exhaustive public suite cannot establish general `Enforced` or `Detected` behavior against an
arbitrary, malicious, or test-aware system. It can falsify a claim with a counterexample and can support only
a bounded statement about the tested build, configuration, boundary, oracle, and cases [C-250].

Two stronger empirical forms remain bounded:

- **exhaustive closed-domain evidence** may support a property over a proved finite, closed, fully enumerated
  input/state domain with deterministic semantics and a trusted complete oracle; it says nothing about
  dimensions outside that closure; and
- **continuous independent observation** may support an operational claim only for the named deployment,
  observer, covered boundary, and time interval, with observation gaps and losses reported. It says nothing
  about unobserved paths or future behavior [C-251, C-252].

Formal proof can support a quantified property only under its explicit model, assumptions, and demonstrated
model-to-implementation correspondence. A finite TLC run is exhaustive only over its configured closed state
space and establishes no claim about states or implementations outside that model. The reported TLC results
are bounded empirical evidence; no Customs proof or model-to-implementation correspondence has been accepted
[C-190, C-194–C-196].

Every capability-cell claim must bind the standard, lane, profile, and adapter digests; exact system build,
configuration, platform, and date; closed scope and exclusions; named boundary, trusted computing base, and
observer; freshness and threat profile; oracle, procedure, retained evidence, and result; and one evidence
mode (`formal`, `exhaustive-closed-domain`, `sampled-suite`, or `continuous-observation`) [C-253].
Candidate PACS-CLAIM-001–007 records the bounded-claim grammar; PACS-CLAIM-004 and PACS-TEST-003 state the
finite non-exhaustive limitation. These clause references add no implementation evidence.

The Candidate matrix keeps `CarrierIntegrity`, `PortableClosure`, `GovernanceAuthorization`,
`IdentityBinding`, `PrivacyProjection`, `PolicyProjection`, `CharterDelivery`, `EffectAuthorization`,
`EffectContainment`, `OutputRelease`, and `SemanticEvaluation` independent. Audit evidence is cross-cutting,
not an aggregate “Customs enabled” claim. The exact final matrix and claim schema remain **Open** [C-254].

## 28. SCITT related work and boundary

RFC 9942 and RFC 9943, published on the IETF Standards Track in June 2026, materially strengthen the
transparency related-work baseline. RFC 9942 defines COSE Receipts for verifiable-data-structure proofs and
instantiates inclusion and consistency proof forms for `RFC9162_SHA256`. RFC 9943 defines SCITT signed
statements, registration, transparency services, receipts, and auditing. Together they can support evidence
that a signed statement was registered and included at one signed log root/tree size and—where the selected
VDS and receipt profile provide it—that two roots have append-only consistency linkage [C-262].

Those results do not choose Customs governance. RFC 9943 leaves statement management and storage outside its
scope, leaves relying-party trust choices outside its scope, and warns that VDS order need not equal issuance
order unless the registration policy says otherwise. Therefore a SCITT receipt, even if cryptographically
valid, neither proves that its statement was authorized by the Customs project nor selects which
`HeadReceipt` is active. A future Customs-to-SCITT profile may treat a SCITT receipt as witness evidence, but
must separately specify HeadReceipt authority, exact statement binding, trust anchors, query/comparison
policy, freshness, quorum, equivocation response, and failure behavior [C-233, C-262, C-263].

## 29. Current research status

All mechanisms introduced in §§25–28 are **Candidate** or **Open** exactly as shown in the evidence ledger.
No result is promoted to Ratified, no model is accepted as proof, and no finite suite is reported as proof
of enforcement. Carrier encoding, schemas, active-head trust, witness-evidence policy, recovery,
applicability and target registries, monitor semantics, conformance schema, adapter capacity, and containment
remain unresolved. Public registries/IANA types, enrollment and local nonrollback head trust, witness
anti-equivocation policy, key lifecycle and trusted time, recovery ceremony, private-overlay CEK/nonce
durability, full EAT mapping, PolicyImage materialization, resource measurements, and independent
interoperability vectors also remain **Open** pending profile adoption and those enumerated dependencies.
General physical root/archive discovery and a reviewed discovery/export model remain HOLD; so do portable
lifecycle-state evidence, distinguished promotion-source wire binding, and a formal revision/supersession
machine [C-052, C-053, C-154, C-155]. Implementation therefore remains **HOLD**
[C-192, C-237, C-244, C-253, C-263, C-264].
