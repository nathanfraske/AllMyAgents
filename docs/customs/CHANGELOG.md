# Portable Agentic Customs documentation changelog

All notable stewardship changes are recorded here. This log records documentation history, not canonical
standard releases.

## 2026-07-29 — consolidated corrective pass

### Corrected

- Narrowed currentness to decision-current admission at authoritative CAS-consume plus atomic audit/outbox
  commit; replaced reusable receipts with durable outbox work.
- Separated crash/restart, rollback/clone, and Byzantine/equivocation threat profiles; limited the base claim
  to at-most-one authoritative enqueue.
- Made output release a typed Effect, removed runtime fork identity, separated project/fleet trust bootstrap,
  and distinguished SemanticCharter from adapter rendering and the complete provider envelope.
- Replaced independent capability-field intersections with relational tuples and registered lattices; made
  approval typed evidence for fresh re-evaluation.
- Added the closed one-NormBody Custom union, authenticated three-valued FactSnapshot applicability,
  identity-map failure rules, two-stage deviation compilation, expanded negative vectors, related work, and
  working-name collision findings.
- Corrected RFC 9162 to Experimental §11.3 and narrowed OPA conflict wording to “may,” with no cross-bundle
  ordering claim.
- Added evidence class G for locally authenticated governance reports. No Candidate/Open item was promoted.
  Implementation remains HOLD.
- Clarified that the authoritative gateway must own/proxy transport, the four targets are decision views
  rather than mandatory persisted objects, assurance is an orthogonal capability matrix, external generation
  is distinct from local SessionIncarnation, and wall-clock time is non-authoritative absent trusted time.

## 2026-07-29 — reconciled v0 Candidate architecture

### Changed

- Recorded the initial four-target authorization machine, decision union, admission-currentness, meet,
  release/high-water, Agent lifecycle, and assurance taxonomy as Candidate only; the corrective entry above
  supersedes its overbroad details.
- Recorded a then-generic local trust-pin bootstrap; the corrective entry above replaces it with independent
  `ProjectTrustPin` and `FleetTrustAnchor`.
- Defined one-shot currentness at the authority decision and indivisible local guarded-dispatch transition,
  without claiming physical simultaneity or retroactive invalidation of an admitted remote operation.
- Added explicit rejected claims, degradation behavior, ten counterexamples, automated conformance oracles,
  and a three-module TLA+/PlusCal formal gate.
- Expanded HOLD blockers for canonical schemas, authority/recovery, carrier profiles, formal artifacts,
  effect registry/canonicalizers, atomic dispatch, adapter capacity, OS containment, output release,
  epochs/high-water/nonces, identity bindings, and auxiliary inference.
- Added bounded primary-source support for complete mediation/reference monitors, execution-monitor
  enforceability, PDP/PEP separation, OPA bundle activation/conflict precedent, split-view limitations, and
  safety/liveness methodology.

### Status

- No proposition was promoted to Ratified.
- Existing Ratified vocabulary, identity/privacy boundaries, lane separation, and HOLD state were preserved.
- Product code was not modified.

## 2026-07-29 — initial replacement-steward baseline

### Added

- A clearly labelled ROUGH DRAFT academic paper baseline.
- A claim-to-evidence ledger assigning primary sources, formal obligations, or empirical-test requirements
  to every major paper claim.
- A decision/status ledger with the fixed states Ratified, Candidate, Open, Rejected, and Empirical-only.
- Explicit normative-standard, implementation-profile, and vendor-adapter lanes.
- A source register using primary specifications for deterministic JSON, deterministic CBOR, COSE, TUF,
  in-toto, and pairwise-identifier privacy rationale.

### Recorded governance state

- Ratified the supplied semantic vocabulary and identity/privacy/assurance boundaries only as reported by
  the authorized manager brief.
- Kept the signed content-addressed graph plus local sidecar architecture at Candidate.
- Kept carrier, schemas, authority recovery, freshness, obligation algebra, effect containment, adapter
  contracts, conformance tests, and projection mechanics Open.
- Recorded Culture-as-object, name-as-identity/authenticator, and natural-language obedience guarantees as
  Rejected.
- Recorded implementation status as HOLD.

### Provenance and gaps

- No Customs documents existed on this branch before this baseline.
- The blocked prior steward’s worktree was not accessed or modified. The manager later forwarded that the
  denied file change created no document or recoverable patch; no prior draft text was incorporated.
- The manager-forwarded structural finding independently matched this baseline: there was no existing
  Customs subtree, and one cohesive `docs/customs/` directory was appropriate. This is documentation
  provenance, not normative authority.
- The repository contains `AGENTS.md` but no `CLAUDE.md` at this revision.
- Canonical external decision identifiers and a registry verification procedure remain unavailable. Future
  reconciliation must preserve provenance and status history.
