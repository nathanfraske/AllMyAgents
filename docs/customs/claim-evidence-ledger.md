# Portable Agentic Customs claim-to-evidence ledger

Last updated: 2026-07-29. “Manager brief” means the authorized task brief delivered to this steward; it is
local provenance for reported status, not a substitute for the future canonical registry.

Evidence classes:

- **P** — primary specification or canonical governance record.
- **F** — formal proof obligation; open until a proof/model and review artifact exist.
- **E** — empirical test; bounded to the recorded environment.

| Claim | Major claim | Status | Evidence / obligation | Gap or acceptance test |
|---|---|---|---|---|
| C-001 | Prompt text alone cannot establish enforced effect policy. | Ratified boundary | P: manager brief (D-008). F: protected-effect mediation obligation C-025. | Define effect model and adversarial bypass tests. |
| C-002 | Vendor-hidden inference/compaction cannot be guaranteed by a portable layer. | Ratified boundary | P: manager brief (D-008). | Adapter may claim more only with an authenticated vendor contract and tests. |
| C-003 | The standard governs scoped norms/projection, not cognition or stored Culture. | Ratified | P: manager brief (D-001–D-004). | Canonical decision identifiers are not yet available. |
| C-010 | Custom means one scoped norm. | Ratified | P: manager brief (D-001). | Await canonical registry reference. |
| C-011 | Customs means a governed set. | Ratified | P: manager brief (D-002). | Await canonical registry reference. |
| C-012 | Charter means request-specific deterministic effective projection. | Ratified concept | P: manager brief (D-003). F: C-024 and C-050. | Exact algorithm Open (D-031). |
| C-013 | Culture is emergent, not stored. | Ratified | P: manager brief (D-004); Rejected inverse D-021. | None beyond canonical reference. |
| C-014 | Immutable `AgentId` is distinct from name/session/profile/provider/model/account/key; name is a fleet-local display binding. | Ratified | P: manager brief and recalled ratified identity note (D-005, D-006). | Await canonical registry reference and lifecycle semantics. |
| C-020 | Authenticated objects can support an authenticated-delivery claim. | Ratified boundary / Candidate mechanism | P: manager brief (D-008); [COSE, RFC 9052](https://www.rfc-editor.org/rfc/rfc9052.html) defines signing structures. F: bind trust policy, signed bytes, algorithms, and verification result. | Signature suite and schema Open. |
| C-021 | Host enforcement can cover only fully mediated declared effects. | Ratified boundary | P: manager brief (D-008). F: C-025. | Inventory/containment Open (D-017). |
| C-022 | Authentication does not prove semantic obedience. | Ratified boundary | P: manager brief (D-008). | Ensure conformance language never upgrades delivery to cognition. |
| C-023 | Unmediated effects are outside the portable enforcement claim. | Ratified boundary | P: manager brief (D-008). F: every adapter reports contained and uncontained effects. | Adapter contract Open (D-018). |
| C-024 | Charter projection is reproducible for identical explicit inputs. | Open formal obligation | F: for projection `P`, prove/test `P(I)=P(I)` across independent conforming implementations for verified input tuple `I`; include error outputs and algorithm version. | Projection rules and vectors Open. |
| C-025 | Every protected effect is mediated or explicitly reported uncontained. | Open formal obligation | F: define effect universe `E`, protected subset `P`, mediation set `M`, and require evidence that `P ⊆ M`; negative tests attempt bypass per effect. | Effect inventory Open (D-017). |
| C-030 | Capsule does not expose `AgentId` by default. | Ratified | P: manager brief (D-007). | Exact capsule schema Open. |
| C-031 | Capsule uses project/export-scoped principals with private mapping to `AgentId`. | Ratified requirement / Open mechanism | P: manager brief (D-007). F: unlinkability/collision/lifecycle properties. | Construction Open (D-020). |
| C-032 | Pairwise/scoped identifiers reduce avoidable correlation compared with one global identifier. | Supporting rationale | P: [W3C DID Core 1.0 privacy considerations](https://www.w3.org/TR/did-core/#privacy-considerations) discuss pairwise unique information and correlation risks. | This does not select DID syntax or a derivation scheme. |
| C-033 | Name and key are not identical to agent identity. | Ratified | P: manager brief (D-005, D-006). | Define key rotation and name reassignment without identity mutation. |
| C-040 | Immutable content-addressed object/release graphs are the current portability architecture. | Candidate | P: manager brief (D-010). | Exact graph/schema/hash domain Open. |
| C-041 | Content addressing detects byte changes relative to the selected digest definition. | Candidate technical claim | F: specify domain separation, canonical bytes, allowed hash algorithms, and verification vectors. | “Detects” is computational and algorithm-relative, not absolute. |
| C-042 | Signatures authenticate statements only under verification and trust policy. | Candidate technical claim | P: RFC 9052 supplies signature processing structures; [in-toto specification](https://github.com/in-toto/docs/blob/master/in-toto-spec.md) separates owner layouts, functionary evidence, and client verification. | Customs trust semantics Open. |
| C-043 | Releases can select immutable graph roots without mutating objects. | Candidate | F: graph model must prove referenced closure and reject missing, cyclic-if-forbidden, or type-confused edges. | Schema Open. |
| C-044 | Mutable local trust/mount/private-map state can differ without changing portable object identity. | Candidate | F: show object digest excludes sidecar; define binding inputs and tamper model. | Sidecar schema and backup/recovery Open. |
| C-045 | Stable hashes/signatures require a fully specified deterministic byte representation. | Technical premise | P: [RFC 8785](https://www.rfc-editor.org/rfc/rfc8785.html) states cryptographic hashing/signing needs invariant representation; [RFC 8949 §4.2](https://www.rfc-editor.org/rfc/rfc8949.html#section-4.2) defines deterministic CBOR. | Selection remains Open (D-011). |
| C-046 | JCS is an available deterministic JSON option. | Candidate alternative | P: RFC 8785. | Verified errata, numeric limits, Unicode handling, and test vectors must be assessed before adoption. |
| C-047 | Deterministic CBOR plus COSE is an available encoding/signature option. | Candidate alternative | P: RFC 8949 and RFC 9052. | Profile must fix tag/number/map rules and algorithm suite. |
| C-048 | Update metadata precedent covers roles, thresholds, hashes/sizes, and freshness metadata. | Comparative evidence | P: [TUF roles and metadata](https://theupdateframework.io/docs/metadata/) documents root, targets, snapshot, timestamp, hashes/sizes, delegation, and thresholds. | TUF is not incorporated; map threats and semantics before reuse. |
| C-049 | Signed layouts plus step evidence are precedent for authorized graph/process verification. | Comparative evidence | P: in-toto specification. | Customs is not a software supply-chain protocol; analogy is bounded. |
| C-050 | Determinism is relative to complete explicit inputs and algorithm version. | Candidate formal framing | F: enumerate all projection inputs; property-based and cross-implementation vectors perturb each one. | Input taxonomy Open. |
| C-051 | No Charter conformance claim is possible before projection and conflict rules exist. | Open blocker | F: conformance suite cannot be constructed without expected outputs. | Close D-031. |
| C-060 | Standard, profile, and adapter findings are non-interchangeable. | Ratified | P: manager brief (D-009). | Add document lint/review rule if corpus grows. |
| C-061 | Vendor claims require vendor/version/platform/date/method bounds. | Research control | E: each finding must carry this tuple and retained artifacts. | No adapter findings recorded yet. |
| C-062 | Adapter observations cannot ratify normative semantics. | Ratified governance rule | P: manager brief’s authority limitation and D-009. | Await canonical governance procedure. |
| C-070 | Threat model must cover carrier/graph/trust/freshness/privacy/adapter/effect failures. | Candidate scope | F: threat-model review maps every threat to prevention, detection, recovery, or accepted residual risk. | Formal threat model Open. |
| C-071 | A valid signature alone does not prove truth, safety, freshness, or obedience. | Technical limitation | P: RFC 9052 defines cryptographic processing, not those higher-level properties. F: conformance language audits all signature claims. | Trust and freshness semantics Open. |
| C-072 | Offline verification cannot generally prove newest authority state without trusted freshness input. | Candidate security claim | P: TUF uses timestamp/snapshot expiry and versioning as explicit freshness mechanisms. F: construct indistinguishable cached-state histories absent time/contact. | Offline rule Open (D-015). |
| C-080 | Every major claim needs P, F, or E evidence. | Stewardship control | P: authorized manager brief. | Audit on every change. |
| C-081 | Cross-implementation vectors are needed for interoperability claims. | Candidate method | F/E: at least two independent implementations produce identical accepted/rejected results for shared vectors. | Conformance classes Open. |
| C-090 | Implementation is HOLD because formal blockers remain. | Ratified project state | P: manager brief (D-030); open D-011–D-020 and D-031. | Manager must explicitly change status. |

## Source register

| Source | Role here | Authority limit |
|---|---|---|
| Authorized manager brief, 2026-07-29 | Reports canonical decisions and current HOLD status. | Local copy has no external canonical object identifier yet. |
| [RFC 8785, JSON Canonicalization Scheme](https://www.rfc-editor.org/rfc/rfc8785.html) | Primary serialization specification. | Informational RFC; not selected by Customs. |
| [RFC 8949, CBOR](https://www.rfc-editor.org/rfc/rfc8949.html) | Primary deterministic-CBOR specification. | Does not define Customs schemas or trust. |
| [RFC 9052, COSE](https://www.rfc-editor.org/rfc/rfc9052.html) | Primary signing-structure specification. | Does not select Customs algorithms or authorities. |
| [TUF metadata documentation](https://theupdateframework.io/docs/metadata/) | Primary project documentation for update trust/freshness precedent. | Comparative only. |
| [in-toto specification](https://github.com/in-toto/docs/blob/master/in-toto-spec.md) | Primary project specification for signed layout/link precedent. | Comparative only. |
| [W3C DID Core 1.0](https://www.w3.org/TR/did-core/) | W3C Recommendation supporting identifier privacy rationale. | DID adoption is neither proposed nor ratified. |
