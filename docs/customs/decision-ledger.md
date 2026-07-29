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

## Formal unblock gate

Implementation remains on HOLD until the authorized governance process identifies a bounded implementable
profile and, at minimum, closes or explicitly defers D-011 through D-020 and D-031 with stated conformance
consequences. A prototype cannot close these decisions merely by choosing defaults.
