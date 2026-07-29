# Portable Agentic Customs: A Governance and Portability Substrate for Agent Systems

> **ROUGH DRAFT — academic paper baseline, 2026-07-29.**
>
> This document is non-final research documentation. It neither ratifies the standard nor authorizes an
> implementation. Every substantive claim is keyed to the
> [claim-to-evidence ledger](claim-evidence-ledger.md); governance status is controlled by the
> [decision ledger](decision-ledger.md).

## Abstract

Agent systems increasingly combine instructions, identities, tools, trust decisions, and vendor-specific
runtime behavior. Moving such a system between hosts or vendors risks either losing its governance or
mistaking advisory text for enforced policy. This draft frames **Portable Agentic Customs** as a governed
set of scoped norms whose effective, request-specific projection is a **Charter**. It separates portable
normative meaning from implementation profiles and empirical vendor adapters. The current design direction
uses immutable, content-addressed, signed object and release graphs, with mutable local trust and mount
decisions kept in sidecars. It deliberately makes narrower guarantees than “agent obedience”: authenticated
delivery and fully mediated declared effects are plausible enforcement boundaries, whereas natural-language
compliance and vendor-hidden inference or compaction are not. Identity is likewise split: an immutable
`AgentId` is not a session, profile, provider, model, account, key, or human-readable name, and portable
capsules use scoped pseudonymous principals rather than exposing `AgentId` by default. Carrier encoding,
authority recovery, freshness, exact schemas, effect algebra, and adapter contracts remain unresolved.

## 1. Problem and scope

A portable policy bundle has at least three separate jobs: preserve what was decided, determine which
decisions apply to a request, and constrain effects in an actual runtime. Collapsing these jobs into a
single prompt overstates what a host can guarantee. A vendor may perform hidden inference, summarize or
compact context, and expose only a partial effect surface. Therefore this draft treats natural-language
instructions as inputs to behavior, not as an enforcement mechanism [C-001, C-002].

The standard’s intended subject is governance metadata and its deterministic projection. It does not define
agent cognition, guarantee semantic obedience, prescribe one vendor, or store “culture” as a transferable
object [C-003].

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

Secondary summaries may guide discovery but do not close a claim. Conformance should ultimately be
demonstrated with cross-implementation vectors for serialization, hashes, signature verification, graph
resolution, projection, conflict handling, privacy defaults, and effect mediation [C-080, C-081].

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

## 12. Reconciled v0 candidate authorization machine

This section records a reconciled architecture as **Candidate**. Four typed decision views bind progressively
more runtime state, but they are not four mandatory persisted objects. No decision for one kind authorizes
another [C-100–C-112].

### 12.1 PolicyImage

A deviation-free `PolicyBasis` deterministically compiles active Kernel, Fleet, Project, and optional agent
Customs plus registry/compiler refs. Exact `DeviationGrant`s then bind the PolicyBasis digest, `RuleRef`,
subject/target scope, expiry, authority, and compensation. A final `PolicyImage` may bind the PolicyBasis
plus accepted DeviationGrant refs, but whether it is separately authoritative/persisted is an Open minimality
and naming choice; admission must bind the equivalent final tuple and request-specific SemanticCharter.

`FleetRef` is irreducible: a project or agent cannot compile away the fleet ceiling. The compiler is a
versioned deterministic component, not a model. A model compiling the policy that governs its own request
would make the trust argument circular. The artifact digest is output/binding, not an input to its own
compilation. A DeviationGrant cannot bind a final PolicyImage digest that includes itself [C-106].

### 12.2 ActivationTarget

An `ActivationTarget` binds the final policy tuple to stable `AgentId`, provider/adapter, `enforcerId`,
distinct `SessionIncarnation`, and authority-owned live Enforcer/Activation generation (`ActivationFence`).
An enforcer/worker restart rotates the generation but preserves the logical SessionIncarnation. Only logical
session recreation/resurrection mints a new incarnation. A local incarnation/fence does not survive exact
cloning; only external gateway single-live-channel/generation state can fence clones [C-107].

### 12.3 InferenceAdmissionTarget and RequestCharter

An `InferenceAdmissionTarget` binds exact grant/deviations and canonical request; both the vendor-neutral
`SemanticCharter` and adapter-specific `CharterRendering` / `VendorRequestManifest` digests; renderer/adapter
profile; and the complete observable provider envelope: provider/model, account/tenant, endpoint/region,
conversation/cache/context identifiers, tool definitions and implementation identities, attachments, all
instruction channels/roles, generation parameters, and final exact bytes/length. Rendering finishes before
admission; overflow or silent truncation denies [C-108–C-110].

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
identity because projects move between fleets.

The portable graph has one active linear Release head per ProjectIdentity. Root/authority transitions may
interleave with Releases, each of which binds exact authority term and root epoch. Copies, clones, and
worktrees preserve identity. Competing signed heads are equivocation and quarantine. An intentional fork
mints a new ProjectId/GenesisDigest with optional parent provenance; no runtime fork identifier exists.

Verification tracks a local high-water mark and fails on missing, corrupt, unsupported, or equivocal
required material [C-140–C-143].

A capsule carries the closed portable graph. A transport profile states whether it includes that graph
physically or carries an authenticated companion locator. Local sidecars contain trust pins, mounts, private
keys/endpoints, high-water state, decision/audit records, caches, compiled Charters, and the private `AgentId`
map. Capsules
contain no secrets, process fences, or reusable authority credentials [C-144].

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
ratification. Identity authority binds stable AgentId to the session and private
`(ProjectId, ProjectPrincipalId) ↔ AgentId` map; missing or ambiguous mapping denies, and name/self-claim
never resolves it. Imports are inactive in quarantine [C-150–C-153].

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

The Candidate suite must demonstrate [C-181]:

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

The next research artifact should be three TLA+/PlusCal modules [C-190]:

- **A — authority and carrier:** independent project/fleet trust, releases, high-water rollback,
  equivocation, moves, and intentional new-identity forks;
- **B — runtime authorization:** activation, admission, effects, grants, restart fences, generation changes,
  and compaction;
- **C — agent lifecycle and privacy:** identity/name separation, scoped principals, trials, promotion,
  quarantine, and erasure.

The gate requires safety properties plus conditional liveness under explicit availability/fairness
assumptions, and retained model-check artifacts before any ratification proposal. Lamport’s separation of
safety and liveness motivates the structure but proves nothing about this Candidate [C-191].

Implementation remains **HOLD** until canonical encoding/schema, trust bootstrap/recovery, carrier profiles,
formal model/model-check artifacts, cross-implementation vectors, a closed effect registry/canonicalizers,
atomic guarded dispatch, exact adapter capacity tests, OS containment, output-release rules, authority
epochs/high-water/nonces, stable `AgentId` bindings, and auxiliary-inference inventory are resolved [C-192].

## 22. Closed Custom and applicability candidate

One v0 Custom is one immutable `NormBody`, not a multi-clause bundle [C-200]:

- **Guard** — forbids or constrains; never positively Allows. Positive authority comes from SessionGrant or
  capability-grant state.
- **Requirement** — typed all-of evidence; approvals are bound typed evidence.
- **Guidance** — mandatory semantic content without machine-obedience assurance.
- **Evaluation** — empirical evidence only and never authority.

Authorship, observations, and rationale are provenance, not applicability or authority. Applicability uses
closed registered selectors over a canonical authenticated `FactSnapshot` with issuer, provenance, and
freshness. Evaluation is three-valued. Any security-relevant Unknown—including Guidance applicability—
denies projection until the fact exists; unknown scoped guidance is not injected. Evaluation may remain
unknown but cannot authorize [C-201, C-202].

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

Within the dated primary corpus inspected on 2026-07-29, no finalized specification was found combining the
full Customs requirements. This is a bounded survey result, never a first/only/no-standard claim [C-220].
The `.agents Repository Folder Specification` is the nearest project-carrier work in progress: it defines
canonical repository configuration and deterministic resolution but not authenticated freshness, AgentId
lifecycle, or governed amendment activation. Microsoft Agent Control Specification and Agent OS are
enforcement neighbors. The individual AIP draft independently
separates stable identifier, key material, and human-readable name. AuthZEN’s draft approval profile returns
approval context to a fresh authorization re-evaluation rather than making approval itself authority
[C-221–C-224].

“Customs” also names a trade/border domain, and “PACS” is established medical-imaging terminology. Portable
Agentic Customs / PACS is a working name only pending collision review [C-225].
