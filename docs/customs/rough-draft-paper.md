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

This section records a reconciled architecture as **Candidate**. Four target kinds bind progressively more
runtime state, and no receipt for one kind authorizes another [C-100–C-112].

### 12.1 PolicyImage

A `PolicyImage` is the exact deterministic compilation of:

`KernelRef + FleetRef + ProjectRef + optional agent trial + compiler/profile + artifact digest`.

`FleetRef` is irreducible: a project or agent cannot compile away the fleet ceiling. The compiler is a
versioned deterministic component, not a model. A model compiling the policy that governs its own request
would make the trust argument circular [C-106].

### 12.2 ActivationTarget

An `ActivationTarget` binds a `PolicyImage` to stable `AgentId`, provider/adapter, `enforcerId`, and a
never-reused `activationFence` representing the session incarnation. A restarted or resurrected session
receives a new fence; an old receipt fails even if every readable field or display name matches [C-107].

### 12.3 InferenceAdmissionTarget and RequestCharter

An `InferenceAdmissionTarget` binds the activation target to the exact `SessionGrant` head, exact deviations,
canonical request, provider/model/adapter, final rendered bytes and length, and tool-surface digest. The
corresponding `RequestCharter` is the deterministic projection and rendered admission artifact. Rendering
must finish before admission; overflow or attempted silent truncation denies. A suffix rendered after
authorization is unauthorized even if the earlier prefix was valid [C-108–C-110].

### 12.4 EffectAuthorizationTarget

An `EffectAuthorizationTarget` binds current activation, grant, and deviations to the canonical action,
adapter, origin inference, and a stable operation identifier. Scheduled or queued operations re-authorize at
execution rather than spending a stale queued receipt [C-111].

A single `DecisionRequest` / `Receipt` envelope is Candidate only as a closed discriminated union of
`activate | infer | effect`. The signed domain includes the kind and target-specific bindings, making
receipts non-interchangeable across kind, fence, incarnation, project, fork, adapter, provider, and model
[C-112].

## 13. Freshness profiles

**Strict-current** means an online, nonce-bound, single-use receipt at every AllMyAgents-controlled provider
dispatch and every protected effect, followed by atomic verify-and-dispatch. “Current” means the authority’s
head at the receipt linearization point, not timeless latestness. If the authority is unavailable, no
strict-current inference or protected effect occurs [C-120–C-123].

A lease may exist only under a separately named bounded-stability/offline profile. It cannot claim
strict-current. Authority changes cannot retroactively stop already accepted remote inference, retract
delivered output, or undo external effects. During a partition, strict-current availability is intentionally
sacrificed rather than guessed [C-124, C-125].

## 14. Candidate v0 precedence and obligation algebra

Validation, freshness, and required-audit failures deny. Kernel and the exact `SessionGrant` ceilings are
nonwaivable. Fleet applies before Project. Exact deviations can name only waivable Fleet or Project rules;
agent trials can narrow only. The hard authorization result is intersection with default deny [C-130].

| Field | Meet |
|---|---|
| actions, resources, destinations | set intersection |
| `maxRisk`, `maxData`, `maxBytes`, `validUntil` | minimum |
| `requiredApprovals`, `auditTags` | set union |
| `sandbox` | Boolean OR |

An unknown type, field, operator, invalid value, or undefined meet denies. Arbitrary prose, stateful
obligations, and disjunctive obligation systems remain Open and keep implementation on HOLD [C-131, C-132].

## 15. Candidate release and carrier profile

`ProjectIdentity = (random ProjectId, GenesisDigest)`. A local `TrustPin` bootstraps trust by binding that
pair; it is sidecar state, not a portable signed-chain object. The portable graph contains immutable signed
content-addressed objects and one linear v0 Release chain with explicit forks:

`ProjectGenesis → RootTransition* → AuthorityGrant(term) → Release* → CustomRevision references`.

Verification tracks a local high-water mark and fails on missing, corrupt, unsupported, or equivocal
required material [C-140–C-143].

A capsule carries the closed portable graph. A transport profile states whether it includes that graph
physically or carries an authenticated companion locator. Local sidecars contain trust pins, mounts, private
keys/endpoints, high-water state, receipts, caches, compiled Charters, and the private `AgentId` map. Capsules
contain no secrets, process fences, or reusable authority credentials [C-144].

Root loss has no magical recovery. Content addressing detects differing objects but does not stop a cloned
signer from presenting consistent, signed split views; signer equivocation remains HOLD without a
witness/transparency mechanism. Certificate Transparency gossip is precedent for isolated-view limitations,
not an adopted Customs protocol [C-145, C-146].

## 16. Agent Customs lifecycle

Personal and trial Customs can narrow only their stable `AgentId`; they cannot widen authority or affect
other agents, security, or governance. The Candidate lifecycle is:

`draft → trial/shadow → personal active → promotion proposal/review → new project Custom`.

There is no silent promotion or synchronization. Imports are quarantined and inactive. Capsules omit
`AgentId` by default and carry a project/export-scoped principal whose private map stays local. Culture is
emergent evidence, not a stored object [C-150–C-153].

## 17. Assurance and containment

Conformance claims are capability-by-capability and distinguish [C-160]:

- **Carrier Assurance** — selected objects arrived and decoded under a named carrier profile.
- **Delivery Assurance** — exact authenticated bytes reached a controlled dispatch boundary.
- **Declared Effect Assurance** — declared protected effects received current authorization.
- **Contained Effect Assurance** — bypass tests support that all claimed effect paths cross the enforcer.
- **Semantic Assurance** — bounded empirical evidence only; never model understanding or obedience.

Freshness profile is orthogonal to all five. One “Customs enabled” flag is prohibited.

Full containment cannot be claimed for an ambient vendor CLI without OS/container isolation and brokered
filesystem, process, network, Git, secrets, and browser access. The protected-boundary registry must cover at
least provider data/cost, output release, filesystem, process, network, Git, bus/messages, memory, Customs
mutation, credentials, browser/UI, approvals/delegation, project/session lifecycle, attachments, telemetry,
updates/plugins/MCP, and schedulers. Queued actions re-authorize when executed [C-161–C-163].

This boundary follows established reasoning: complete mediation checks every access; a reference monitor is
always invoked, tamper-resistant, and verifiable; PDP/PEP architectures separate decision from enforcement;
and execution monitoring cannot enforce arbitrary semantic properties [C-164–C-167]. Saltzer and
Schroeder’s economy-of-mechanism principle supports keeping the v0 meet small. OPA’s signed-bundle behavior
is useful implementation precedent for validate-before-activation and for treating multi-source conflicts
as errors, but it is not an adopted Customs engine [C-168].

## 18. Rejected hard claims and explicit degradation

Rejected claims include: every physical vendor inference was admitted; hidden retry or compaction carried
the Charter; the model understood or obeyed; remote cancellation retroactively retracted accepted work or
delivered output; strict-current operation remained current through authority partition; and external
effects are universally exactly once [C-170].

Required degradations and tests are explicit: guidance overflow denies; admitted bytes are checked exactly;
a hidden-call stub is reported outside assurance; a mid-turn generation change blocks later tools and
quarantines or labels the remaining stream; an ignored interrupt yields `cancellation-unconfirmed` with zero
authorized effects; ambient raw-effect attempts must fail before containment is advertised; authoritative
guidance change rotates to a new provider context [C-171].

## 19. Counterexample catalogue

Mandatory negative vectors are: queued-receipt TOCTOU; render-after-admission suffix; cached provider
context; inference receipt reused for effect; signer-clone split view; travel without high-water; display-name
rebind; session resurrection/ABA; model-in-compiler circularity; and ambiguous approval [C-180].

## 20. Automated conformance oracles

The Candidate suite must demonstrate [C-181]:

- zero provider calls without a valid inference receipt and exact final-byte equality;
- nonce single use and no cross-kind/fence/incarnation/project/fork/adapter/provider/model receipt reuse;
- zero protected effects without a current effect receipt;
- head changes invalidate unspent receipts, while already admitted operations remain admitted; overflow
  denies; restart fences survive crashes;
- fail-closed unknown fields/old peers and stable operation identifiers;
- new provider context after authoritative guidance changes;
- execution-time scheduler, bus, and approval checks;
- containment bypass tests for every claimed boundary;
- display-name rebinding changes no ownership;
- offline stale capsules cause zero strict-current dispatch;
- assurance is emitted capability-by-capability, never as one enabled flag.

## 21. Formal gate

The next research artifact should be three TLA+/PlusCal modules [C-190]:

- **A — authority and carrier:** trust, releases, high-water rollback, equivocation, moves, and forks;
- **B — runtime authorization:** activation, admission, effects, grants, restart fences, generation changes,
  and compaction;
- **C — agent lifecycle and privacy:** identity/name separation, scoped principals, trials, promotion,
  quarantine, and erasure.

The gate requires safety properties plus conditional liveness under explicit availability/fairness
assumptions. Lamport’s separation of safety and liveness motivates the structure but proves nothing about
this Candidate [C-191].

Implementation remains **HOLD** until canonical encoding/schema, trust bootstrap/recovery, carrier profiles,
formal model/model-check artifacts, cross-implementation vectors, a closed effect registry/canonicalizers,
atomic guarded dispatch, exact adapter capacity tests, OS containment, output-release rules, authority
epochs/high-water/nonces, stable `AgentId` bindings, and auxiliary-inference inventory are resolved [C-192].
