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
| D-100 | Implementation profile | Candidate | Use four typed targets: PolicyImage, ActivationTarget, InferenceAdmissionTarget/RequestCharter, and EffectAuthorizationTarget. | Reconciled v0 proposal, 2026-07-29; not ratified. |
| D-101 | Implementation profile | Candidate | A generic request/receipt is a closed activate/infer/effect union with non-interchangeable signed domains. | Formal model pending. |
| D-102 | Normative | Candidate | FleetRef is irreducible; Kernel and exact SessionGrant ceilings are nonwaivable; agent trials only narrow. | Algebra proof pending. |
| D-103 | Implementation profile | Candidate | Strict-current uses online nonce-bound single-use receipts and atomic verify-and-dispatch at each controlled inference and protected effect. | Current means authority head at receipt linearization. |
| D-104 | Implementation profile | Candidate | Bounded-stability/offline lease is separately named and never claims strict-current. | Explicit availability/freshness tradeoff. |
| D-105 | Normative | Candidate | v0 hard authorization uses default-deny typed meet: intersections, minima, unions, and sandbox OR only. | Unknown/invalid meet denies; arbitrary obligations Open. |
| D-106 | Implementation profile | Candidate | Project identity is `(random ProjectId, GenesisDigest)`; local TrustPin binds that pair, while the portable chain is `ProjectGenesis → RootTransition* → AuthorityGrant(term) → Release* → CustomRevision refs`, with explicit forks and local high-water. | TrustPin is sidecar bootstrap state, not a portable chain object; schemas/encoding Open. |
| D-107 | Implementation profile | Candidate | Capsules carry a closed portable graph or profile-declared authenticated companion locator; mutable/private runtime state stays in sidecars. | No secrets, fences, reusable authority credentials in capsules. |
| D-108 | Normative | Candidate | Agent trial/personal Customs narrow one stable AgentId only and require reviewed promotion to create a project Custom. | Imports inactive in quarantine; no silent sync/promotion. |
| D-109 | Normative | Candidate | Report Carrier, Delivery, Declared Effect, Contained Effect, and empirical-only Semantic Assurance separately, with orthogonal freshness. | Prohibits one “Customs enabled” claim. |
| D-110 | Normative | Open | Close and canonicalize protected-effect registry and output-release rule. | Required for containment claims. |
| D-111 | Implementation profile | Open | Specify atomic guarded dispatcher, authority epoch/head/nonces, durable high-water, and crash semantics. | Required for strict-current/replay safety. |
| D-112 | Vendor adapter | Open | Prove exact admission/effect capacity per adapter, including auxiliary/hidden inference and provider-context rotation. | Ambient behavior cannot be presumed mediated. |
| D-113 | Implementation profile | Open | Establish OS/container containment and broker filesystem/process/network/Git/secrets/browser paths. | Requires bypass evidence. |
| D-114 | Formal | Open | Produce/model-check TLA+/PlusCal modules A (authority/carrier), B (runtime authorization), and C (agent lifecycle/privacy). | Safety plus conditional liveness. |
| D-115 | Normative | Rejected | Claim every physical vendor inference was admitted or hidden retry/compaction carried the Charter. | Uncontrolled vendor paths exceed assurance. |
| D-116 | Normative | Rejected | Claim model obedience, retroactive cancellation/retraction, strict-current availability during partition, or universal exactly-once effects. | Exceeds enforceability or physical reversibility. |
| D-117 | Implementation profile | Open | Define witness/transparency handling for signer equivocation and split views. | Content addressing alone is insufficient. |
| D-118 | Normative | Open | Define exact approval target, lifetime, consumption, delegation, and ambiguity-denial semantics. | Prevent approval replay/confusion. |

## Formal unblock gate

Implementation remains on HOLD until the authorized governance process identifies a bounded implementable
profile and, at minimum, closes or explicitly defers D-011 through D-020, D-031, D-110 through D-114,
D-117, and D-118 with stated conformance consequences. A prototype cannot close these decisions merely by
choosing defaults.
