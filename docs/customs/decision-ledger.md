# Portable Agentic Customs decision and status ledger

Last updated: 2026-07-29. This is a local stewardship index, not the external canonical registry.

## Rules

Only an explicit authorized-manager report of canonical state can add a **Ratified** or **Rejected** entry.
Research may add Candidate, Open, or Empirical-only entries. Changing status requires a dated changelog
entry and provenance. Silence, apparent consensus, implementation, and model memory do not ratify.

| ID | Lane | Status | Proposition | Provenance / rationale |
|---|---|---|---|---|
| D-001 | Normative | Ratified | A Custom is one scoped norm. | Authorized manager brief, 2026-07-29. |
| D-002 | Normative | Ratified | Customs is a governed set of Customs. | Authorized manager brief, 2026-07-29. |
| D-003 | Normative | Ratified | A Charter is the request-specific deterministic effective projection of applicable Customs. | Authorized manager brief, 2026-07-29. Projection algorithm remains Open (D-031). |
| D-004 | Normative | Ratified | Culture is an emergent social outcome, not a stored object. | Authorized manager brief, 2026-07-29. |
| D-005 | Normative | Ratified | `AgentId` is stable and immutable, and distinct from session, profile, provider, model, account, and key identifiers. | Authorized manager brief plus recalled ratified identity note, 2026-07-29. |
| D-006 | Normative | Ratified | A human-readable agent name is a fleet-local one-to-one current display binding, not an authenticator. | Authorized manager brief plus recalled ratified identity note, 2026-07-29. |
| D-007 | Normative | Ratified | Portable capsules do not expose `AgentId` by default; they use project/export-scoped principals with a private mapping. | Authorized manager brief, 2026-07-29. |
| D-008 | Normative | Ratified | Assurance is limited to authenticated delivery and fully mediated declared effects; natural-language obedience and vendor-hidden inference/compaction are not guaranteed. | Authorized manager brief, 2026-07-29. |
| D-009 | Normative | Ratified | Normative standard, implementation profiles, and vendor-adapter findings are separate lanes. | Authorized manager brief, 2026-07-29. |
| D-010 | Implementation profile | Candidate | Portable state uses immutable content-addressed signed object/release graphs plus mutable local trust/mount sidecars. | Authorized manager brief labels this design direction; exact mechanism unresolved. |
| D-011 | Implementation profile | Open | Select universal logical carrier encoding and canonical signed-byte representation. | JSON/JCS and deterministic CBOR/COSE are researched alternatives; no selection. |
| D-012 | Implementation profile | Open | Define physical carriers, discovery, transport, and media types. | No canonical decision. Logical encoding and physical transport must not be conflated. |
| D-013 | Normative | Open | Define exact object, release, signature, dependency, scope, principal, and sidecar schemas. | Formal blocker. |
| D-014 | Normative | Open | Define authority bootstrap, rotation, compromise recovery, revocation, delegation, and thresholds. | Formal blocker; TUF is comparative evidence only. |
| D-015 | Normative | Open | Define online and offline freshness, expiry, rollback, and replay rules. | Formal blocker; trusted-time and newest-state assumptions unresolved. |
| D-016 | Normative | Open | Define obligation algebra, including composition, conflict, discharge, and failure semantics. | Formal blocker. |
| D-017 | Normative | Open | Define the complete protected-effect inventory and containment/conformance rules. | Formal blocker; complete mediation cannot be claimed without inventory. |
| D-018 | Vendor adapter | Open | Define adapter contract, evidence format, versioning, and degradation behavior. | Vendor-specific observations must remain bounded. |
| D-019 | Normative | Open | Define conformance classes and cross-implementation test vectors. | Required to turn prose determinism into reproducible evidence. |
| D-020 | Normative | Open | Define scoped-principal derivation/allocation, unlinkability goal, collision handling, and private-map lifecycle. | Privacy default is Ratified; exact construction is not. |
| D-021 | Normative | Rejected | Treat Culture as a stored, portable object. | Contradicts D-004; authorized manager brief explicitly excludes it. |
| D-022 | Normative | Rejected | Equate agent name with stable identity or authentication authority. | Contradicts D-005 and D-006. |
| D-023 | Normative | Rejected | Promise deterministic natural-language obedience or control of vendor-hidden inference/compaction. | Contradicts D-008. |
| D-024 | Vendor adapter | Empirical-only | No current vendor behavior is recorded as portable fact in this baseline. | Placeholder boundary; requires dated test artifacts before adding findings. |
| D-030 | Project | Ratified | Implementation work is HOLD pending formal blockers. | Authorized manager brief, 2026-07-29. Documentation research may continue. |
| D-031 | Normative | Open | Specify Charter applicability, ordering, precedence, conflict resolution, defaults, provenance, and error output. | D-003 ratifies the concept, not its algorithm. |
| D-100 | Implementation profile | Candidate | Use four typed decision views for policy binding, activation, inference admission/RequestCharter, and effect authorization. | Not four mandatory persisted objects; separate authoritative PolicyImage is an Open minimality/naming choice. |
| D-101 | Implementation profile | Candidate | DecisionRequest/non-authorizing DecisionRecord is a closed activate/infer/effect union with non-interchangeable domains. | Only gateway dispatcher receives outbox work; untrusted agent worker has neither reusable authorization nor transport authority. |
| D-102 | Normative | Candidate | FleetRef is irreducible; Kernel and exact SessionGrant ceilings are nonwaivable; Fleet/Project/agent constraints combine by commutative monotone meet. | Lower authority cannot waive higher rule; canonical ordering is diagnostic only. |
| D-103 | Implementation profile | Candidate | Decision-current admission occurs when the gateway-owned dispatcher re-evaluates at dequeue/execution, atomically checks current policy/grant, CAS-consumes the exact attempt, records DecisionRecord/audit, and enters immediate send. | Queued intent is unauthorizing; delayed/recovered jobs re-evaluate. |
| D-104 | Implementation profile | Candidate | Freshness profiles are decision-current admission, bounded-stability, and snapshot. | Only the first claims authority currentness at admission. |
| D-105 | Normative | Candidate | v0 hard authorization uses default-deny relational capability tuples, registered risk/data lattices, minima, all-of typed evidence, audit-tag union, and sandbox OR. | Independent field intersections forbidden; unknown/invalid meet denies. |
| D-106 | Implementation profile | Candidate | One linear Release head exists per `(ProjectId, GenesisDigest)`; transitions interleave and each Release binds authority term/root epoch. Competing heads quarantine; intentional fork mints a new identity. | No runtime fork identifier. Schemas/encoding Open. |
| D-107 | Implementation profile | Candidate | Capsules carry a closed portable graph or profile-declared authenticated companion locator; mutable/private runtime state stays in sidecars. | No secrets, fences, reusable authority credentials in capsules. |
| D-108 | Normative | Candidate | Personal/trial Customs cannot expand reference-monitor authority, mutate higher governance, or enter another AgentId’s Charter; trials require isolation/consent and promotion creates a project-owned Custom. | They may steer security-relevant choices; authorship never activates. |
| D-109 | Normative | Candidate | Report an independent capability matrix for Carrier, Projection, Delivery, EffectAuthorization, EffectContainment, OutputRelease, and SemanticEvaluation, with Enforced/Detected/Empirical/Unsupported cells. | Freshness/threat profiles orthogonal; no tier implication or aggregate enabled claim. |
| D-110 | Normative | Open | Close and canonicalize protected-effect registry and output-release rule. | Required for containment claims. |
| D-111 | Implementation profile | Open | Specify dequeue-time re-evaluation plus atomic current-check/CAS/DecisionRecord/immediate-send transition, authority epoch/head, durable high-water, and crash semantics. | No cached allow or reusable bearer authorization survives queue/recovery. |
| D-112 | Vendor adapter | Open | Prove exact admission/effect capacity per adapter, including auxiliary/hidden inference and provider-context rotation. | Ambient behavior cannot be presumed mediated. |
| D-113 | Implementation profile | Open | Establish OS/container containment and broker filesystem/process/network/Git/secrets/browser paths. | Requires bypass evidence. |
| D-114 | Formal | Open | Produce/model-check TLA+/PlusCal modules A (authority/carrier), B (runtime authorization), and C (agent lifecycle/privacy). | Safety plus conditional liveness. |
| D-115 | Normative | Rejected | Claim every physical vendor inference was admitted or hidden retry/compaction carried the Charter. | Uncontrolled vendor paths exceed assurance. |
| D-116 | Normative | Rejected | Claim model obedience, retroactive cancellation/retraction, decision-current admission availability during partition, or universal exactly-once effects. | Exceeds enforceability or physical reversibility. |
| D-117 | Implementation profile | Open | Define witness/transparency handling for signer equivocation and split views. | Content addressing alone is insufficient. |
| D-118 | Normative | Open | Define exact approval target, lifetime, consumption, delegation, and ambiguity-denial semantics. | Prevent approval replay/confusion. |
| D-119 | Normative | Candidate | `output.release` is a typed Effect; strong profile buffers final output for fresh release authorization, while streaming is weaker and irreversible. | Exact output rule remains Open. |
| D-120 | Implementation profile | Candidate | `ProjectTrustPin` and `FleetTrustAnchor` are independent local bindings; a project neither selects FleetRef nor self-authenticates. | Projects can move across fleets. |
| D-121 | Normative | Candidate | Separate vendor-neutral SemanticCharter from adapter CharterRendering/VendorRequestManifest and bind both plus the complete observable provider envelope. | Renderer/envelope canonicalizers Open. |
| D-122 | Normative | Candidate | One Custom is one immutable NormBody in the closed Guard/Requirement/Guidance/Evaluation union. | Guard cannot positively Allow; Evaluation never authorizes. |
| D-123 | Normative | Candidate | Applicability evaluates closed selectors over authenticated FactSnapshot with three-valued logic; security-relevant Unknown denies, including Guidance applicability. | Unknown Evaluation may remain non-authorizing. |
| D-124 | Normative | Candidate | Identity authority resolves AgentId through session binding and private project-principal map; missing/ambiguous map, name, and self-claim fail closed. | Self-adoption needs granted capability plus non-widening check. |
| D-125 | Assurance | Candidate | Threat profiles separately state crash/restart, rollback/clone resistance, and Byzantine signer/equivocation. | Local state alone cannot resist exact clone/rollback. |
| D-126 | Assurance | Candidate | Base dispatch claim is at-most-one authoritative gateway send transition per exact attempt. | Never universal exactly-once provider computation/effect. |
| D-127 | Research | Open | Portable Agentic Customs/PACS is a working name pending trade-domain and medical-acronym collision review. | No naming ratification. |
| D-128 | Implementation profile | Candidate | Compile deviation-free PolicyBasis; bind DeviationGrants to its digest and exact rule/scope/expiry/authority/compensation; then bind accepted refs into the final policy tuple. | Tuple may be named/materialized PolicyImage; prevents self-reference; exact schema Open. |
| D-129 | Normative | Candidate | Security ordering uses authority epoch/sequence; gateway time is audit metadata unless a named trusted-time profile applies. | Trusted-time profile remains Open. |

## Formal unblock gate

Implementation remains on HOLD until the authorized governance process identifies a bounded implementable
profile and, at minimum, closes or explicitly defers D-011 through D-020, D-031, D-110 through D-114,
D-117, and D-118 with stated conformance consequences. A prototype cannot close these decisions merely by
choosing defaults. Currentness, anti-clone resistance, carrier profiles, calculus, agent lifecycle, and
adapter guarantees remain Candidate/Open; model-check artifacts are required before ratification.
