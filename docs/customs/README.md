# Portable Agentic Customs

This directory is the living research record for an emerging vendor-neutral standard. It is documentation,
not an implementation contract, and it does not change AllMyAgents product behavior.

## Authority and reading order

External canonical governance state is authoritative. Repository text, meeting notes, summaries, and model
memory are evidence or working material only; they cannot ratify a decision. Until a canonical registry and
its verification procedure are specified, the steward records only decisions explicitly forwarded as
ratified by the authorized manager.

1. [`rough-draft-paper.md`](rough-draft-paper.md) — clearly non-final academic-paper baseline.
2. [`decision-ledger.md`](decision-ledger.md) — the controlling local index of ratified, candidate, open,
   rejected, and empirical-only propositions.
3. [`claim-evidence-ledger.md`](claim-evidence-ledger.md) — a claim-by-claim audit trail.
4. [`CHANGELOG.md`](CHANGELOG.md) — documentation history and provenance.

If prose and the decision ledger disagree, use the more conservative status and record the discrepancy in
the changelog. “Ratified” describes reported external state; it is not a claim that this repository is the
canonical registry.

## Document lanes

- **Normative standard:** portable semantics and conformance requirements, but only after ratification.
- **Implementation profile:** one interoperable realization of the standard; never the only allowed design
  unless the standard explicitly requires it.
- **Vendor-adapter findings:** measured facts and limitations for a particular vendor/version/environment.
  These cannot silently become portable requirements.

Status vocabulary is fixed for this research record:

- **Ratified** — the authorized external process has explicitly accepted the proposition.
- **Candidate** — concrete proposal ready for evaluation, not binding.
- **Open** — unresolved design space or proof obligation.
- **Rejected** — explicitly excluded; rationale is retained.
- **Empirical-only** — observed in a bounded environment and not generalized.

Implementation status is **HOLD** pending the formal blockers in the decision ledger.
