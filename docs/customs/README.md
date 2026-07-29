# Portable Agentic Customs

This directory is the living research and stewardship record for an emerging vendor-neutral standard. The
versioned normative draft is documentation, not an AllMyAgents implementation contract, and it changes no
product behavior.

## Authority and reading order

External canonical governance state is authoritative. Repository text, profiles, meeting notes, summaries,
tests, and model memory cannot ratify a decision. Until a canonical registry and verification procedure
exist, this repository records Ratified status only when an authorized manager explicitly forwards it.

1. [`specification.md`](specification.md) — self-contained **0.1.0-draft.2 Candidate Normative Standard**.
2. [`decision-ledger.md`](decision-ledger.md) — controlling local index of Ratified, Candidate, Open,
   Rejected, and Empirical-only propositions.
3. [`rough-draft-paper.md`](rough-draft-paper.md) — non-final academic-paper baseline.
4. [`claim-evidence-ledger.md`](claim-evidence-ledger.md) — claim-by-claim evidence and proof obligations.
5. [`CHANGELOG.md`](CHANGELOG.md) — documentation history and provenance.

If documents disagree, apply the more conservative status. “Ratified” describes reported external
governance state; it does not mean this repository is the canonical registry. Candidate requirements are
binding only when evaluating conformance to that exact draft, not as a claim of external ratification.

## Non-interchangeable lanes

- **Normative Standard** — portable meanings, required transitions, validation boundaries, failures, and
  conformance grammar.
- **Implementation Profile** — one interoperable binding to encoding, established cryptographic
  standards, registries, transport, storage, freshness, and mediation.
- **Adapter/Vendor Profile** — a bounded binding to an exact vendor, version/build, platform, date,
  observable envelope, effect surface, and known limitations.
- **Guidance** — non-binding implementation advice. A `Guidance` NormBody is semantic content whose exact
  delivery can be enforced, but whose obedience cannot.
- **Evaluation** — empirical criteria and results; never authority.
- **Open Research** — unresolved proof, registry, profile, or design choices marked `HOLD-*`.

The fixed governance statuses are:

- **Ratified** — explicitly accepted by the authorized external process.
- **Candidate** — a concrete proposal ready for evaluation, not Ratified.
- **Open** — unresolved design space or proof obligation.
- **Rejected** — explicitly excluded with rationale retained.
- **Empirical-only** — observed in a bounded environment and not generalized.

Implementation and final ratification remain **HOLD**.

## Candidate v0 machine

The draft separates Candidate Carriers from authority. Git, capsules, archives, locators, and
`CarrierManifest` objects only stage candidates. Candidate filesystem profile `pacs-project-fs-v1`
discovers `.pacs/carrier.cbor` relative to an explicitly supplied root, confines exact derived
content-addressed store paths, and reports `CarrierUnsupported`, `CarrierQuarantined`, or
`CandidateStaged`; it never supplies trust. A moved project reattaches `ProjectTrustPin`,
`FleetTrustAnchor`, protected high-water state, and private principal mappings independently, and an export
claiming local project portability includes its closed carrier without those sidecars.

A validated authorizing `HeadReceipt` is the sole normal selector of an ordinary `Release`, after exact
profile-defined companion authentication and all transition checks pass. The one recovery exception is an
independently Kernel/Fleet-authorized `RecoveryTransition` at a higher term and sequence zero; it selects
only its exact empty-runtime-capability `SafeRecoveryRelease`, and the next normal `HeadReceipt` parents it
at sequence one. Companion evidence authenticates a normal receipt and is not bearer authority.
“Witness receipt” is only an analytic label for non-authorizing standards-based transparency evidence; the
base profile defines no parallel Customs object. The reviewed profile constructs a separate SCITT
transparency submission only after accepting the head checkpoint. Same-position competing HeadReceipts
freeze and quarantine; offline work is proposal-only.

One Custom contains one `Guard`, `InstantaneousAttestationPrecondition`, `Guidance`, or `Evaluation`.
Applicability is three-valued at the whole-Custom level: definite `False` omits the whole Custom,
security-relevant `Unknown` denies, and an applicable IAP never skips an ambiguous atom. Layer composition
is monotone narrowing over complete relational targets; positive runtime authority comes from the exact
current `SessionGrant`.

Agent-owned Customs evolve as immutable overlay revisions. Revision zero has a null predecessor; a
successor is the exact next revision of the same scoped series and exact current predecessor, re-enters
review at `Draft`, and never inherits `PersonalActive`. At most one revision is active; concurrent branches
stay inactive, retired revisions are provenance only, and promotion binds an exact source revision into a
new immutable project-owned Custom. The corrected wire profile validates structural series currentness but
does not yet encode lifecycle-review evidence or the distinguished promotion-source commitment; those
claims remain HOLD/Unsupported.

Provider, effect, and output work uses typed attempts. Queue entries and `DecisionRecord` objects are
nonauthorizing. A gateway that owns or proxies transport re-evaluates at dequeue/execution, atomically
checks current state and consumes the exact attempt, records audit evidence, and enters its immediate send
path. The base claim is at-most-one local gateway send transition, never universal remote exactly-once.

The draft also fixes private project-principal mapping, agent-authored Custom lifecycle, exact observable
inference/rendering boundaries, hidden-compaction degradation, IAP limits, governance-only recovery,
capability-by-capability conformance grammar, privacy rules, version/extension behavior, and mandatory
negative-test outcomes.

## Profile and proof status

Retained corrected wire-profile commit `beb974c30a922ca47679b1427dd241923a13628d` defines a reviewed Candidate
Implementation Profile using deterministic CBOR/CDDL, COSE_Sign1, Ed25519/EdDSA, and domain-separated
SHA-256. It remains a profile candidate, not Standard semantics or Ratified cryptography. JCS is diagnostic
or gateway-only, never CID/signature-equivalent. The profile binds `FinalPolicyBinding` without requiring
an authoritative `PolicyImage`, preserves upstream provider dimensions as exact opaque bytes, and
finalizes `VendorRequestManifest` before its inference target to avoid a hash cycle. Activation binds a
null Charter slot, inference/effect bind the exact Charter, and effect also binds accepted activation and
origin inference plus its target digest. Stable registries/media/purposes, measured limits,
trust/non-rollback, rotation, witness policy, recovery/key/nonce/time/EAT profiles, independent
vectors/codecs, and interoperability remain Open/HOLD.

Preserved commit 66d14ed contains bounded runtime and lifecycle drafts but no authority/carrier module and
records no successful tool run. Executable formal-gate commit
`a2b57551863241d90bca663ee07190accfa834d2`, reconciled by
`70458fc6cc7903d6da984865c617e3f1ef5bcb38`, reconstructs all three modules and passes SANY semantic
processing. Seven finite TLC configurations completed without errors and with zero queued states, and
sixteen additional harnesses—three mutation checks and thirteen reachability sentinels—produced their
intended counterexamples or traces; exact toolchain and state counts are recorded in `specification.md`.
These closed-universe results are bounded design evidence, not an unbounded, implementation,
cryptographic, or hidden-vendor proof, so `HOLD-FORMAL-001` remains effective. Finite non-exhaustive
public suites likewise cannot alone establish general `Enforced` or `Detected` behavior against a
malicious or test-aware system. The corrected authority model covers only a finite recovery-selector
abstraction; the checked models do not cover physical project-carrier discovery/path confinement or
immutable overlay successor semantics.

Natural-language obedience, vendor-hidden inference/compaction, retroactive cancellation, universal remote
exactly-once behavior, and containment of unmediated side effects are outside the guarantees.

“Portable Agentic Customs” and “PACS” are working names pending collision review.
