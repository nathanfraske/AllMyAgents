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
