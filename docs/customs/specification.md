# Portable Agentic Customs normative specification

Version: **0.1.0-draft.2**

Specification reference: `pacs:spec:0.1.0-draft.2`

Governance status: **Candidate normative draft; not Ratified**

Implementation status: **HOLD**

Wire status: **reviewed Candidate profile at `beb974c30a922ca47679b1427dd241923a13628d`;
adoption and registries remain HOLD-WIRE-001**

Date: 2026-07-29

## 1. Status, scope, and conventions

This document defines the smallest candidate machine for portable agent governance. It is self-contained at
the semantic and protocol-transition level. The Normative Standard does not ratify a wire encoding,
cryptographic suite, physical carrier, vendor, or product architecture; separately labelled Candidate
Implementation Profiles are review inputs, not adopted Standard semantics. This document does not change
AllMyAgents behavior.

Capitalized requirement key words are interpreted as described by
[RFC 2119](https://www.rfc-editor.org/rfc/rfc2119) and
[RFC 8174](https://www.rfc-editor.org/rfc/rfc8174) (BCP 14). They appear only in identified requirements.
Each such requirement names the boundary that enforces or validates it and the failure behavior at that
boundary.

The governance status of a proposition and the normative force of this draft are different axes. A
Candidate requirement is binding when evaluating conformance to this exact draft, but it is not a claim
that external governance has ratified the requirement. Only the semantic core in Section 2.1 is reported as
Ratified. Every other mechanism in this document remains Candidate or Open.

### 1.1 Document lanes

The following lanes are non-interchangeable:

- **Normative Standard** defines portable meanings, required transitions, validation boundaries, failure
  behavior, and conformance grammar.
- **Implementation Profile** binds the abstract standard to established encodings, cryptographic
  containers and algorithms, registries, storage, transport, freshness, and mediation mechanisms.
- **Adapter/Vendor Profile** binds an implementation profile to an exact vendor, product version, build,
  platform, date, provider envelope, effect surface, and observed limitations.
- **Guidance** gives non-binding implementation or operational advice. A `Guidance` NormBody is separately
  defined in Section 6: its delivery can be enforced, but semantic obedience cannot.
- **Evaluation** records empirical criteria and results. Evaluation never creates authorization.
- **Open Research** records unresolved questions and proof obligations. An explicit `HOLD-*` marker blocks
  the affected claim or transition until the named governance process resolves it.

| ID | Governance status | Requirement | Enforcement or validation boundary | Failure behavior |
|---|---|---|---|---|
| PACS-DOC-001 | Candidate enforcement of Ratified D-009 | A conformance claim **MUST** identify its lane and **MUST NOT** use evidence from one lane as authority in another lane. | Conformance-claim parser and governance review. | Reject the claim as invalid; retain the underlying evidence only in its original lane. |
| PACS-DOC-002 | Candidate enforcement of governance status rules | A document, object, release, profile, implementation, or claim **MUST NOT** be labelled `Ratified` unless the external canonical governance process identifies that exact proposition and version as Ratified. | Governance registry verifier or, while the registry is unavailable, authorized-manager provenance review. | Record the item as Candidate or Open and reject the Ratified label. |
| PACS-DOC-003 | Candidate enforcement of Ratified/Rejected assurance boundaries | A claim **MUST NOT** guarantee natural-language obedience, unobserved vendor inference or compaction, retroactive cancellation, universal remote exactly-once behavior, or containment of an unmediated side effect. | Conformance-claim validator and publication review. | Reject the claim or reduce the affected capability cell to `Empirical` or `Unsupported`. |

## 2. Normative terminology

### 2.1 Reported Ratified semantic core

The following definitions are the only propositions in this draft reported as Ratified:

- A **Custom** is one scoped norm.
- **Customs** is a governed set of Customs.
- A **Charter** is the request-specific deterministic effective projection of applicable Customs.
- **Culture** is an emergent social outcome, not a stored object.
- `AgentId` is a stable immutable identity, distinct from a session, incarnation, profile, provider, model,
  account, key, and human-readable name.
- A human-readable agent name is a fleet-local one-to-one current display binding, not an authenticator.
- Portable capsules do not expose `AgentId` by default; they use project- or export-scoped principals with
  a private mapping.
- Assurance is limited to authenticated delivery and fully mediated declared effects. It does not imply
  natural-language obedience or control of vendor-hidden inference or compaction.
- Normative Standard, Implementation Profile, and Adapter/Vendor Profile statements are separate lanes.

These definitions do not ratify any Candidate object, receipt, algorithm, profile, or state machine below.

### 2.2 Candidate terms

| Term | Candidate meaning in this draft |
|---|---|
| `ProjectId` | An opaque, randomly allocated project identifier under an implementation profile. |
| `GenesisDigest` | The profile-defined digest of the authenticated canonical `ProjectGenesis` representation. |
| `ProjectIdentity` | The ordered pair `(ProjectId, GenesisDigest)`. |
| `ProjectGenesis` | The immutable first portable object that declares the project namespace, format/profile compatibility, and initial project-governance material. It is not self-authenticating. |
| `ProjectTrustPin` | A mutable local binding from a `ProjectIdentity` to an independently accepted project root or root locator. |
| `FleetRef` | The stable reference for the fleet governance domain that constrains a local activation. |
| `FleetTrustAnchor` | A mutable local binding that supplies and authenticates `FleetRef` independently of project-controlled bytes. |
| `RootTerm` | A monotone project-root epoch. A change denotes an authenticated root rotation or recovery transition. |
| `AuthorityTerm` | A monotone governance-issuance epoch under a `RootTerm`. |
| `Sequence` | A monotone position within an `AuthorityTerm`. Security ordering uses terms and sequence, not wall-clock time. |
| `Release` | An immutable project object selecting a proposed normative closure and binding its parent, terms, sequence, registry/compiler references, and active project Custom references. |
| `ClosureManifest` | An immutable enumeration of the transitive normative object closure, or of profile-authorized authenticated locators for that closure. |
| `Carrier` | Any physical or logical transport of Candidate bytes, including Git, a capsule, an archive, a locator, or a `CarrierManifest`. A Carrier is untrusted as an authority source. |
| `CarrierManifest` | A transport index for objects or authenticated locators. It does not select active governance. |
| `ProjectCarrierProfile` | An Implementation Profile that defines deterministic authority-neutral discovery, root-confined resolution, staging, and export of one project's Carrier material. |
| `GovernanceProposal` | An unauthorizing proposal for an ordinary transition from an exact active head. |
| `HeadCheckpoint` | The closed abstract union of an ordinary `HeadReceipt` and the one exceptional recovery-plane `RecoveryTransition`. It is an abstract selector category, not an additional wire object. |
| `HeadReceipt` | A Candidate authorizing project-governance record paired with profile-defined companion head authentication evidence. After all local trust, term, parent, closure, governance, companion-authentication, and equivocation checks pass, it is the sole normal selector of an ordinary `Release`. Companion evidence authenticates the exact receipt and never selects by itself. |
| `SafeRecoveryRelease` | An immutable recovery-only Candidate whose exact restricted closure permits governance inspection, verification, restore, and rotation but has an empty effective runtime-capability set. |
| `RecoveryTransition` | The one exceptional independently Kernel/Fleet-authorized recovery-plane checkpoint. After full recovery validation, it becomes the head at a strictly higher `AuthorityTerm`, sequence zero, and selects only its exact `SafeRecoveryRelease`; project governance cannot authorize it. |
| `witnessEvidence` | Optional non-authorizing standards-based evidence attached outside the release authority graph. “Witness receipt” is only an analytic label; the base abstract model defines no parallel Customs `WitnessReceipt` type, code, or schema. |
| **Active Trusted Head** | The unique locally accepted `HeadCheckpoint` and exact selected ordinary or safe-recovery release state for one `ProjectIdentity`. |
| `CustomRevision` | An immutable project, Fleet, or Kernel representation of one Custom revision, its series, and its provenance. |
| `OverlayObject` | An immutable agent-authored representation of one personal or trial Custom revision in one scoped overlay series. It is not project governance. |
| `OverlaySeriesId` | An opaque identifier for one agent-owned Custom revision series within one project and scoped principal. |
| `AgentId` | A stable private identity allocated by the Fleet identity authority and kept distinct from names, sessions, accounts, models, providers, and keys. |
| `ProjectPrincipalId` | A project-scoped opaque principal identifier whose private local bijection to `AgentId` controls agent-specific ownership and projection. |
| `NormBody` | Exactly one of `Guard`, `InstantaneousAttestationPrecondition`, `Guidance`, or `Evaluation`. |
| `Guard` | A machine-evaluable prohibition or narrowing constraint. It cannot create positive authority. |
| `InstantaneousAttestationPrecondition` | A finite conjunction of positive attestation atoms evaluated at one protected decision. |
| `Guidance` | Semantic content selected for delivery to an agent/provider context. Delivery is separable from obedience. |
| `Evaluation` | Non-authorizing criteria or empirical evidence about behavior or outcomes. |
| `FactSnapshot` | An authenticated, canonical, request-scoped set of facts with issuer, provenance, and profile-defined freshness inputs. |
| `ProtectedTarget` | The complete closed canonical target for one activation, inference, effect, or output-release decision kind, including every common and kind-specific dimension registered for that kind and no unrelated dimension. |
| `EvidenceTypeDef` | An immutable evidence definition fixing issuer/key policy, positive claim schema and media, allowed `ProtectedTarget` kinds and canonicalizer, freshness method, status/revocation processing, and critical claims. |
| `Attestation` | An issuer-authenticated positive claim binding one complete `ProtectedTarget` digest under one `EvidenceTypeDef`. |
| `PolicyBasis` | The deviation-free deterministic composition of applicable Kernel, Fleet, Project, and agent Customs plus exact compiler and registry references. |
| `DeviationGrant` | A separately authorized exception bound to an exact `PolicyBasis`, rule, subject, target, scope, lifetime, authority, and compensation. |
| `FinalPolicyBinding` | The binding of the canonical `PolicyBasis` reference, exact compiler/canonicalizer schema, sorted accepted `DeviationGrant` commitments, and domain-separated digest of the recomputed final in-memory policy tuple. A separately materialized `PolicyImage` is not required. |
| `SessionGrant` | The exact current positive runtime authority ceiling for a session incarnation. Customs only narrow this authority. |
| `SemanticCharter` | The vendor-neutral Charter representation produced by projection. |
| `CharterRendering` | The adapter-specific rendering of applicable Guidance and related semantic material. |
| `VendorRequestManifest` | The finalized description of the complete observable provider envelope and exact rendered payload admitted for a provider attempt. |
| `DecisionRequest` | A typed request in the closed `activate`, `infer`, or `effect` union. `output.release` is an effect target, not a fourth reusable authorization kind. |
| `DecisionRecord` | A non-authorizing audit record of one decision and its exact inputs. |
| `AttemptId` | A stable identifier for one exact local admission/send attempt. It is not a reusable authorization. |
| `RecoveryPlane` | An independent Kernel/Fleet governance-only mechanism for bounded recovery operations. |
| **Candidate** | Proposed, transported, staged, or verified material that is not active merely by existing. |
| **Active** | Material selected through the applicable validated state transition. Active is an object state, not a synonym for Ratified. |
| **Quarantined** | Material retained for inspection but prohibited from projection, activation, dispatch, or authorization. |
| **Ratified** | A proposition status assigned only by the external canonical governance process. It is not a Release state. |

## 3. Abstract object model

The object model is logical. Field names are terms of art, not a selected schema. An Implementation Profile
maps these bindings to an established deterministic representation and authenticated container.

### 3.1 Portable objects and transport records

| Object | Required semantic bindings |
|---|---|
| `ProjectGenesis` | specification version, implementation-profile reference, `ProjectId`, project namespace, initial project-root description, extension policy, and registry compatibility constraints |
| `CustomRevision` | object identity, Custom-series identity, revision, predecessor provenance, owner layer, scope, one applicability selector, exactly one `NormBody`, provenance, and an exact source-overlay commitment when created by promotion |
| `OverlayObject` | object identity, overlay-series identity, revision, predecessor provenance, author project principal, owning `AgentId` only in the private local binding, scope, one applicability selector, exactly one `NormBody`, and provenance |
| `Release` | `ProjectIdentity`, parent `HeadCheckpoint`/release reference, `RootTerm`, `AuthorityTerm`, `Sequence`, `ClosureManifest` reference, active project Custom references, compiler/registry references, and ordinary transition kind |
| `ClosureManifest` | complete typed public normative reference set, any profile-declared sealed private slots, expected content references, and any profile-authorized authenticated locators |
| `GovernanceProposal` | exact base `HeadCheckpoint`, proposed ordinary `Release`, proposer, proposal lineage, and review state |
| `HeadReceipt` | `ProjectIdentity`, `RootTerm`, `AuthorityTerm`, `Sequence`, parent `HeadCheckpoint`, ordinary `Release`, `ClosureManifest`, exact `GovernanceProposal`, project-authorization evidence over that proposal, issuer authority, and profile-defined flags |
| `SafeRecoveryRelease` | `ProjectIdentity`, exact prior `HeadCheckpoint`, old and strictly higher new authority/root terms, candidate governance and head-key expectations, safe schema/registry references, restricted safe-mode closure, empty effective runtime capabilities, and recovery-only mode |
| `RecoveryTransition` | `ProjectIdentity`, exact prior `HeadCheckpoint` and old terms/sequence, strictly higher term at sequence zero, exact `SafeRecoveryRelease` and closure, recovery-policy identity, ceremony evidence and nonce, and expected new head-key set |
| `CarrierManifest` | transported object or locator inventory, sizes and content references where profiled, and transport metadata |

For an ordinary checkpoint, profile-defined companion head authentication evidence covers an exact
head-selection statement over the `HeadReceipt`. It remains outside the receipt's own content reference to
avoid a hash cycle and is not an independent authority object. Recovery authentication is instead checked
only under the independently configured `RecoveryPlane` described in Section 13.

### 3.2 Runtime and local objects

`ProjectTrustPin`, `FleetTrustAnchor`, private identity mappings, keys, endpoints, high-water state,
`FactSnapshot`, `ProtectedTarget`, `EvidenceTypeDef`, `Attestation`, `PolicyBasis`, `FinalPolicyBinding`,
accepted `DeviationGrant` references, `SessionGrant`, `SemanticCharter`, `CharterRendering`,
`VendorRequestManifest`, `DecisionRequest`, `DecisionRecord`, audit state, attempt consumption state,
recovery credentials, and process/session fences are local or runtime state. They are not made portable
merely because a Carrier can copy their bytes.

| ID | Governance status | Requirement | Enforcement or validation boundary | Failure behavior |
|---|---|---|---|---|
| PACS-OBJ-001 | Candidate | A semantic object **MUST** identify its kind, specification version, Implementation Profile, and all references required by that kind. | Profile object parser before authentication or semantic use. | Reject the object as malformed and keep its Carrier inactive. |
| PACS-OBJ-002 | Candidate | An immutable object's authenticated content reference **MUST** cover the complete profile-defined canonical representation and domain; changing a covered value **MUST** produce a different verified object identity except with negligible probability under the selected established algorithm. | Content-reference and authenticated-container verifier. | Reject the object and quarantine any Release that requires it. |
| PACS-OBJ-003 | Candidate | An imported portable object **MUST** remain inactive until authentication, closure, version, trust, applicability-language, and governance-transition validation succeeds. | Import staging boundary. | Retain the object only in quarantine; produce no active Custom or authority. |
| PACS-OBJ-004 | Candidate enforcement of Ratified D-007 plus Candidate capsule hygiene | A portable capsule **MUST NOT** contain `AgentId`, the private principal map, private keys, secrets, reusable authority credentials, process fences, local high-water state, or `DecisionRecord` stores by default. | Capsule export validator and secret/privacy scan. | Refuse export; identify the prohibited field class without disclosing the secret value. |
| PACS-OBJ-005 | Candidate | An Implementation Profile **MUST** select reviewed established standards for canonical representation, authenticated containers, signatures or MACs where applicable, digests, key identifiers, and algorithm agility; it **MUST NOT** define an unreviewed Customs-specific cryptographic primitive. | Implementation-profile registry and security review. | Reject the profile for portable conformance and retain `HOLD-WIRE-001`. |

## 4. Project identity, trust, and governance terms

Copying, cloning, relocating, or changing the physical Carrier preserves `ProjectIdentity`. An intentional
project fork creates a new identity and may retain non-authorizing parent provenance. There is no runtime
`forkId`.

`ProjectTrustPin` and `FleetTrustAnchor` are independent local trust inputs. A project can move between
fleets without changing `ProjectIdentity`, but only an independently authorized local Fleet transition can
change `FleetTrustAnchor`.

`RootTerm`, `AuthorityTerm`, and `Sequence` form the security order:

1. `RootTerm` increases on authenticated project-root rotation or recovery.
2. `AuthorityTerm` increases when governance issuance authority changes under a root.
3. `Sequence` increases for ordinary head transitions within an authority term.

Wall-clock fields are audit metadata unless a named trusted-time profile gives them security meaning.

| ID | Governance status | Requirement | Enforcement or validation boundary | Failure behavior |
|---|---|---|---|---|
| PACS-ID-001 | Candidate | A copied or relocated project **MUST** retain its `(ProjectId, GenesisDigest)`, while an intentional fork **MUST** allocate a new `ProjectId` and new `ProjectGenesis`. | Project import/fork operation. | Treat an unexpected identity change as a different project; quarantine an attempted same-identity divergent genesis. |
| PACS-TRUST-001 | Candidate | Project activation **MUST** obtain `ProjectTrustPin` and `FleetTrustAnchor` through independent local trust paths. | Activation trust resolver. | Deny activation when either binding is absent, ambiguous, untrusted, or derived only from project-controlled bytes. |
| PACS-TRUST-002 | Candidate | A project object **MUST NOT** select, authenticate, rotate, or widen its own `FleetRef` or Fleet ceiling. | Fleet/project composition boundary. | Ignore the project-supplied selection as authority and deny on a conflicting required Fleet binding. |
| PACS-TRUST-003 | Candidate | An ordinary `Release` and `HeadReceipt` **MUST** bind exact `RootTerm`, `AuthorityTerm`, and `Sequence` values and **MUST** be authorized under the locally accepted normal terms. | Head verifier. | Reject as stale, premature, or unauthorized and retain the prior Active Trusted Head. |
| PACS-TRUST-004 | Candidate | A normal root or authority transition **MUST** be authenticated by the currently accepted root transition policy; a recovery transition **MUST** instead satisfy Section 13. | Root/authority transition verifier. | Freeze advancement and quarantine the proposed transition. |
| PACS-TRUST-005 | Candidate | A rollback- or clone-resistance claim **MUST** state where its high-water or single-live authority resides relative to the stated rollback/clone boundary. | Conformance-claim validator. | Remove the resistance claim when all cited state can be cloned or rolled back with the system under test. |

## 5. Candidate Carriers, trusted heads, and portable closure

A Carrier can transport a `HeadReceipt`, `RecoveryTransition`, or standards-based `witnessEvidence`, but
possession does not establish trust. Authorizing checkpoint validation and non-authorizing witness
observation are deliberately distinct. The base defines no Customs witness-receipt object.

### 5.1 ProjectCarrierProfile discovery boundary

A project-portability claim includes discovery as a separate capability. A `ProjectCarrierProfile` defines
how a host supplied with an exact project root finds a versioned bootstrap, resolves its
`CarrierManifest`, and distinguishes absence, unsupported format, invalid material, and a valid staged
Candidate. It does not discover trust or private identity state from project bytes.

The reviewed wire result supplies the portable `CarrierManifest` and content-addressed object/blob
bindings and defines one **Candidate Implementation Profile**, `pacs-project-fs-v1`, for a local
filesystem directory:

1. the host supplies one exact already-open directory root; there is no parent/descendant search,
   current-directory fallback, branch convention, home-directory search, or environment-variable
   discovery;
2. the exact case-sensitive logical bootstrap path is `.pacs/carrier.cbor`, with no leading `./`;
   it contains one deterministic-CBOR `CarrierManifest` using wire profile `pacs-cbor-v1` and object-schema
   version 1, with non-null project and release fields and identity-transfer entries only;
3. if `d` is the lowercase unpadded RFC 4648 base32 spelling of the entry's 32-byte digest and matches
   `[a-z2-7]{52}`, the sole allowed locators are `.pacs/store/o/sha256/d` for objects,
   `.pacs/store/b/sha256/d` for blobs, and `.pacs/store/c/sha256/d` for COSE envelopes. Each entry has
   exactly one derived locator and the store has a one-to-one correspondence with manifest entries;
4. resolution occurs from stable held root/directory/file handles. Every directory component and final
   ordinary file stays below that root; traversal, absolute/drive/UNC/device syntax, alternate streams,
   special resources, symbolic or hard links, junctions, reparse points, mount or cross-volume edges,
   case/Unicode/short-name/canonical aliases, duplicate/extra files, and a root or component changed during
   resolution are rejected;
5. exact returned bytes still pass length, transfer, content-reference, type, schema, signature, closure,
   and authority validation after being copied into private Candidate staging. A locator or bootstrap name
   never authenticates content, and authorization never reopens a Carrier path.

An archive can transport the directory bytes, but no archive syntax or safe-extraction profile is selected.
It first extracts to a separately confined new Candidate root before `pacs-project-fs-v1` applies.

| ID | Governance status | Requirement | Enforcement or validation boundary | Failure behavior |
|---|---|---|---|---|
| PACS-CARRIER-001 | Candidate | A `ProjectCarrierProfile` **MUST** define exact root acquisition, deterministic root-relative bootstrap path and version identification, manifest type, locator grammar/resolution, resource limits, visible discovery outcomes, and export-completeness rules. | Profile registry and project-open boundary. | Mark `ProjectCarrierDiscovery` `Unsupported` when no applicable profile exists; do not infer or silently invent discovery. |
| PACS-CARRIER-002 | Candidate | `pacs-project-fs-v1` **MUST** look only for `.pacs/carrier.cbor` at the supplied root and **MUST** require the exact profile/type/schema, non-null project/release, and identity-transfer entry constraints above. | Filesystem bootstrap loader. | Return `CarrierUnsupported` when the root/bootstrap is absent or confinement cannot be implemented; return `CarrierQuarantined` for a present malformed, ambiguous, wrong-version, wrong-type, wrong-project, or noncanonical bootstrap without changing the Active Trusted Head. |
| PACS-CARRIER-003 | Candidate | The filesystem resolver **MUST** derive the sole locator for every manifest entry, enforce one-to-one closed-store membership and stable-handle confinement, read each ordinary file exactly once into private staging, and **MUST NOT** traverse or accept any forbidden namespace, stream, special-resource, alias, link, mount/cross-volume, duplicate/extra-file, or replacement/race case listed above. | Root-confined filesystem scan and Candidate-staging boundary. | Return `CarrierQuarantined`, discard staging, and retain prior trusted state on any mismatch or unverifiable race. |
| PACS-CARRIER-004 | Candidate | `CarrierUnsupported`, `CarrierQuarantined`, and `CandidateStaged` **MUST** be distinct visible outcomes; discovered bootstrap, manifest, repository, and object bytes **MUST** remain unauthorizing Candidate material, and relocation **MUST** reattach `ProjectTrustPin`, recovery/Fleet trust, protected high-water state, private project-principal mappings, and private keys through independent local paths. | Project-open staging, trust resolver, identity authority, and head selector. | `CandidateStaged` performs no activation; deny authority or agent-specific projection when an independent binding is absent, ambiguous, or derived from Carrier bytes. |
| PACS-CARRIER-005 | Candidate | An ordinary copy **MUST** retain `ProjectIdentity`, while an explicit fork **MUST** mint a new `ProjectGenesis` and identity; an export claiming `pacs-project-fs-v1` **MUST** include the exact bootstrap and every derived store entry for the offered release closure, and an authority-validation claim **MUST** additionally include its complete dynamic authentication closure. | Copy/fork operation, export validator, and `ProjectCarrierDiscovery` claim validator. | Treat identity substitution as a different or quarantined project; fail or narrow the portability claim when any required Carrier or authentication byte is absent. |
| PACS-CARRIER-006 | Candidate | A `pacs-project-fs-v1` export **MUST NOT** include trust pins, Fleet/recovery anchors, protected high-water state, grants, sessions, private principal/`AgentId` mappings, content-encryption keys, or durable nonce state in its Carrier namespace. | Export validator and secret/privacy scanner. | Refuse the export, report the prohibited state class without disclosing its value, and fail `PrivacyProjection` if it crossed the boundary. |

**HOLD-CARRIER-001:** Universal project-root discovery, POSIX/Windows API mappings, platform case and
reserved-device rules, filesystem snapshot/network-filesystem behavior, archive/container extraction and
media registration, atomic export publication, measured resource ceilings, stable outcome/profile
registries, and independent cross-platform discovery vectors remain unresolved. A platform mapping can be
stricter but cannot weaken the Candidate confinement or visible-failure behavior.

### 5.2 Head selection and portable closure

For a normal project-governance transition, the reviewed Candidate wire profile represents the
authenticated checkpoint as the pair of one
`HeadReceipt` and profile-defined companion head-signature-bundle evidence covering an exact head-selection
statement over that receipt. Only the `HeadReceipt` selects the ordinary `Release` after every authority and
transition check; the companion evidence is not bearer authority. Section 13 defines the single
recovery-plane exception, which can select only a matching `SafeRecoveryRelease`.

Only after accepting that checkpoint does the profile construct a separate transparency-submission
statement whose subject is the companion head-signature-bundle content reference and whose scope binds the
exact project, terms, and head. It submits that statement as a separate RFC 9943 SCITT Signed Statement.
RFC 9942 inclusion and optional consistency receipts remain outside the release authority graph. Inclusion
establishes membership at one signed log root and tree size. Consistency establishes append-only linkage
between two roots. Neither establishes the latest, unique, authorized, or active project head.

The project-head states are:

`Absent -> StagedCandidate -> VerifiedCandidate -> ActiveTrustedHead -> Superseded`

Any validation conflict can instead transition a staged or active candidate to `Quarantined`. Conflicting
same-position authorizing checkpoints transition the project to `FrozenEquivocation`; recovery is described in
Section 13.

| Transition | Guard | Result | Denial or fault result |
|---|---|---|---|
| Stage Carrier | bytes or locator are available | `StagedCandidate` | malformed transport is rejected |
| Verify Candidate | object, closure, profile, trust, and term checks succeed | `VerifiedCandidate` | incomplete or invalid material is quarantined |
| Select Normal Head | one valid `HeadReceipt` and its exact companion authentication evidence extend the accepted `HeadCheckpoint` and no conflict exists | `ActiveTrustedHead`; prior head becomes `Superseded` | stale base or invalid companion evidence is rejected; conflict freezes |
| Select Recovery Head | one independently authorized `RecoveryTransition` satisfies Section 13 and selects its exact `SafeRecoveryRelease` | `ActiveTrustedHead` at the higher term and sequence zero | invalid or conflicting recovery material is quarantined; project remains frozen or unrecoverable |
| Observe Witness | authenticated standards-based evidence refers to a known or staged `HeadReceipt` | non-authorizing witness evidence is recorded | invalid witness evidence is discarded or quarantined |
| Submit Offline Work | a `GovernanceProposal` names an exact base head | proposal awaits review | stale proposal is returned for rebase/review |

The portable closure is the transitive set of normative objects and registry/profile references needed to
interpret the selected ordinary `Release` or `SafeRecoveryRelease`. A profile can carry those objects inline
or use authenticated companion locators. Runtime facts are not portable closure objects; missing runtime
facts are handled during Charter projection.

| ID | Governance status | Requirement | Enforcement or validation boundary | Failure behavior |
|---|---|---|---|---|
| PACS-HEAD-001 | Candidate | Git state, a capsule, an archive, a locator, a `CarrierManifest`, or an unverified `HeadCheckpoint` **MUST** be treated only as Candidate transport and **MUST NOT** activate governance by presence, branch name, timestamp, or filesystem position. | Carrier import and activation boundary. | Stage or quarantine the material without changing the Active Trusted Head. |
| PACS-HEAD-002 | Candidate | A normal `HeadReceipt` **MUST** bind the complete ordinary-head tuple defined in Section 3.1 under the accepted project authority and exact terms; its profile-defined companion head authentication evidence **MUST** cover an exact head-selection statement over that receipt and **MUST NOT** select or act as bearer authority by itself. | Head and companion-authentication verifier. | Reject the checkpoint pair, preserve the prior head, and treat the companion evidence alone as non-authorizing. |
| PACS-HEAD-003 | Candidate | A project instance **MUST** expose at most one Active Trusted Head per `ProjectIdentity`. | Serialized head selector. | On competing valid same-position heads, enter `FrozenEquivocation`, authorize no new head, and quarantine both branches for review. |
| PACS-HEAD-004 | Candidate | `witnessEvidence` **MUST NOT** authorize a release, replace an authorizing `HeadCheckpoint`, establish project or Fleet trust, select the latest or unique head, resolve a same-position fork, or override parent/high-water rules. | Standards-based witness-evidence verifier and head selector. | Record it only as non-authorizing evidence; reject any attempted activation based on it. |
| PACS-HEAD-005 | Candidate | Offline or concurrent governance work **MUST** produce a `GovernanceProposal` against an exact base `HeadCheckpoint` and **MUST NOT** auto-merge, use last-writer-wins, or activate through a CRDT rule. | Governance proposal/sequencer boundary. | Require rebase and renewed review for a stale base; keep the proposal inactive. |
| PACS-HEAD-006 | Candidate | The logical sequencer **MUST** commit only from the exact current externally trusted `HeadCheckpoint` and issue a linear next normal `HeadReceipt`; a local Carrier copy or rollbackable high-water value **MUST NOT** select or roll back the external head. | Governance sequencer and independent head verifier. | Reject a stale-base transition; freeze on a same-position conflict and retain the prior trusted head. |
| PACS-HEAD-007 | Candidate | An Implementation Profile carrying `witnessEvidence` **MUST** construct it only after accepting the exact head checkpoint, **MUST** keep it outside the release authority graph, and **MUST** bind its submission subject and scope to the companion head-signature-bundle content reference and exact project, terms, and head. | Witness-evidence profile, submission constructor, and attachment verifier. | Reject an early, unbound, or mismatched submission or receipt without changing the Active Trusted Head. |
| PACS-CLOSE-001 | Candidate | Before head selection, the verifier **MUST** prove the exact typed portable closure, resolve and authenticate every member, decrypt required sealed slots, and reject missing, extra, wrong-type, or unsupported closure members. | Portable-closure verifier. | Deny head selection and identify the invalid reference class without partially activating the selected release state; unrelated extra Carrier bytes remain inactive rather than closure members. |
| PACS-CLOSE-002 | Candidate | An authenticated locator **MUST** bind the expected object reference and an authorized resolution profile; locator success alone **MUST NOT** authenticate returned bytes. | Locator resolver followed by object verifier. | Reject substitution, unresolved content, or bytes that fail the expected content reference. |
| PACS-CLOSE-003 | Candidate | A verifier **MUST** evaluate closure over all selected normative overlays before request applicability can omit a Custom from a Charter. | Closure verifier before projection. | Deny head selection for an unavailable overlay; do not treat absence as definite-False applicability. |

**HOLD-HEAD-001:** Governance adoption of the Candidate `HeadReceipt` checkpoint schema, logical sequencer
protocol, authority thresholds, and normal root-transition proof remains unresolved.

**HOLD-WITNESS-001:** Governance adoption of the Candidate SCITT submission/receipt binding, witness trust,
service/query policy, gossip, and split-view recovery remains unresolved. SCITT architecture and receipts
do not by themselves define project authority or active-head selection.

## 6. Customs and Charter composition

### 6.1 Authority layers

The candidate layers are Kernel, Fleet, Project, and agent/personal. Kernel and the exact `SessionGrant`
are nonwaivable ceilings. Fleet, Project, and agent Customs combine by commutative monotone narrowing.
Canonical ordering exists for serialization, delivery, provenance, and diagnostics; it is not an override
precedence rule.

Positive runtime authority comes from the exact current `SessionGrant` and any separately verified
higher-authority grant explicitly referenced by it. A Custom never creates positive authority.

### 6.2 Projection inputs and result

Projection consumes this explicit tuple:

`ActiveTrustedHead + ProjectTrustPin + FleetTrustAnchor + Kernel/Fleet/Project/agent Customs +`
`SessionGrant + private identity resolution + FactSnapshot + request target + compiler/registry/profile versions`

Projection returns either a `SemanticCharter` or a typed denial. A successful `SemanticCharter` contains:

- project identity and active head;
- independent Fleet reference and terms;
- request, session incarnation, enforcer generation, and subject binding;
- `PolicyBasis`, accepted exact `DeviationGrant` references, and `FinalPolicyBinding`;
- `FactSnapshot`, compiler, registry, canonicalizer, and profile references;
- applicable Custom references and definite-False omissions;
- effective relational capabilities, limits, IAP atoms, Guidance, Evaluation references, and audit tags;
- conflicts, provenance, and declared assurance exclusions.

### 6.3 Deterministic algorithm

1. Validate all inputs and resolve the private subject binding.
2. Evaluate each whole Custom's registered applicability selector against the authenticated
   `FactSnapshot`, producing `True`, `False`, or `Unknown`.
3. Include the entire Custom on `True`; omit the entire Custom with provenance on `False`; apply the
   Section 6.4 failure rule on `Unknown`.
4. Compile the deviation-free `PolicyBasis`.
5. Validate separately authorized `DeviationGrant` objects against that exact basis, incorporate only
   exact matches, recompute the final in-memory tuple, and emit `FinalPolicyBinding`.
6. Intersect the positive `SessionGrant` with all applicable narrowing constraints.
7. Form the union of IAP atoms, audit tags, Guidance, and Evaluation references, while applying typed
   conflict rules.
8. Emit the `SemanticCharter` and provenance or a typed denial.

### 6.4 Applicability and typed composition

Definite-False applicability is a whole-Custom result. Because one Custom contains one `NormBody`, it is
also the clause-level result. It is never an instruction to skip an ambiguous atom inside an applicable
IAP.

Security-relevant `Unknown` includes any unknown affecting a Guard, IAP, Guidance selection, identity
binding, authority, trust, freshness, or protected target. An unknown Evaluation stays non-authorizing and
can be reported as unevaluated.

The v0 typed meet is:

| Field | Composition |
|---|---|
| complete `(action, resource, destination, conditions)` capability tuples | relation intersection or a membership predicate over the complete canonical tuple |
| registered risk and data classifications | meet in the named registered lattices |
| byte, count, duration, and validity maxima | minimum |
| IAP atoms | set union, evaluated as all-of |
| audit tags | set union |
| sandbox requirement | Boolean OR |
| Guidance | canonical stable ordering; conflicting values in the same registered exclusive slot are fatal |
| Evaluation | non-authorizing set union |

Independent intersections of action, resource, destination, or condition fields are invalid because they
can synthesize a cross-product capability that no source granted.

| ID | Governance status | Requirement | Enforcement or validation boundary | Failure behavior |
|---|---|---|---|---|
| PACS-CUST-001 | Candidate | One Custom **MUST** contain exactly one immutable `NormBody` from the closed v0 union `Guard`, `InstantaneousAttestationPrecondition`, `Guidance`, or `Evaluation`. | Custom schema and type validator. | Reject a multi-body, empty-body, or unknown-kind Custom. |
| PACS-CUST-002 | Candidate | A `Guard` **MUST NOT** create positive authority, `Guidance` **MUST NOT** widen machine authority, and `Evaluation` **MUST NOT** authorize any transition. | Policy compiler and decision engine. | Deny a result wider than the positive grant and reject the offending compiled policy. |
| PACS-APP-001 | Candidate | Applicability **MUST** be evaluated once for the whole Custom: `False` omits that Custom, `True` includes it, and security-relevant `Unknown` denies the affected Charter. | Projection engine. | Emit a typed applicability denial; an unknown Evaluation remains inert and is marked unevaluated. |
| PACS-APP-002 | Candidate | Projection **MUST NOT** treat a missing object, missing selector definition, unauthenticated fact, or failed decryption as definite `False`. | Closure and projection engines. | Deny head selection for closure failures or deny the Charter for runtime-fact failures. |
| PACS-APP-003 | Candidate | Applicability **MUST** be re-evaluated for each protected decision and a later fact/applicability change **MUST NOT** rewrite the historical result of an already admitted decision. | Projection engine and append-only decision audit. | Apply the new result only to new admissions; preserve the prior `DecisionRecord` and admitted-history status. |
| PACS-COMP-001 | Candidate | Kernel and current `SessionGrant` ceilings **MUST** remain nonwaivable, and Fleet, Project, and agent constraints **MUST** combine by a commutative monotone meet. | Policy compiler. | Deny compilation when any layer ordering or omission widens the allowed set. |
| PACS-COMP-002 | Candidate | Relational capability composition **MUST** operate on complete canonical tuples and **MUST NOT** independently intersect tuple fields. | Capability compiler and canonicalizer. | Reject the policy as invalid; authorize no synthesized tuple. |
| PACS-COMP-003 | Candidate | A `DeviationGrant` **MUST** bind the exact deviation-free `PolicyBasis`, rule, subject, target, scope, lifetime, issuer authority, and compensation before it can affect the final policy tuple. | Deviation verifier between basis compilation and Charter emission. | Ignore the deviation as authority and deny when the unwaived rule blocks the request. |
| PACS-COMP-004 | Candidate | Conflicting applicable Guidance in one registered exclusive slot **MUST** deny Charter emission; arbitrary semantic contradiction outside a registered slot **MUST NOT** be represented as machine-proven consistency. | Projection conflict detector and claim validator. | Emit a typed exclusive-slot conflict or label broader semantic consistency `Unsupported`. |
| PACS-COMP-005 | Candidate | Projection **MUST** run in a versioned deterministic trusted component outside the model/agent governed by its result; a final policy digest **MUST NOT** be an input to its own basis or a `DeviationGrant` that the final policy contains. | Compiler construction and acyclic-reference validator. | Reject circular input and make no Charter. |
| PACS-COMP-006 | Candidate | Effective positive runtime authority **MUST** come only from the exact current `SessionGrant`, already bounded by higher authority; a Custom, approval, IAP atom, Guidance, or Evaluation **MUST NOT** create additional authority. | Policy compiler and decision engine. | Deny any target absent from the positive grant before evaluating narrowing evidence. |
| PACS-COMP-007 | Candidate | `FinalPolicyBinding` **MUST** bind the canonical `PolicyBasis`, exact compiler/canonicalizer schema, sorted accepted deviation commitments, and domain-separated final-tuple digest; a separately emitted `PolicyImage` **MUST** be diagnostic and non-authorizing. | Final-policy constructor and admission verifier. | Reject a mismatched binding or attempted diagnostic-PolicyImage authorization. |
| PACS-CHARTER-001 | Candidate | A successful `SemanticCharter` **MUST** bind every explicit projection input listed in Section 6.2 directly or by authenticated reference and **MUST** retain inclusion, omission, conflict, and assurance provenance. | Charter constructor and independent verifier. | Reject the Charter and prevent its use for admission. |
| PACS-CHARTER-002 | Candidate | Independent conforming projection implementations given identical verified inputs and versions **MUST** produce the same success value or typed denial. | Cross-implementation vector runner. | The implementations fail `PolicyProjection` conformance for the affected version/profile. |

**HOLD-PROJECTION-001:** Exact selector, fact, capability, risk, data, exclusive-slot, compiler, deviation,
and error registries are unresolved. This draft fixes their required behavior, not their entries or wire
identifiers.

## 7. `AgentId`, scoped principals, and privacy

The private identity authority resolves a live session binding to `AgentId` and then resolves the
project-local relation:

`(ProjectIdentity, ProjectPrincipalId) <-> AgentId`

The relation is one-to-one within a project at a current instant. An export can allocate a distinct
`ExportPrincipalId`. Names and model self-claims are presentation or content, not identity evidence.

The internal activation/admission boundary can bind `AgentId` to prevent cross-agent replay. Portable
objects, capsules, provider renderings, and public audit views use the least identifying scoped principal
needed for their function unless an explicit separately authorized disclosure applies.

| ID | Governance status | Requirement | Enforcement or validation boundary | Failure behavior |
|---|---|---|---|---|
| PACS-AGENT-001 | Candidate enforcement of Ratified D-005/D-006 | An implementation **MUST** keep stable `AgentId` distinct from names, sessions, incarnations, profiles, providers, models, accounts, and keys; a rename or key rotation **MUST NOT** change `AgentId`. | Identity authority. | Reject an alias-based ownership or authorization change. |
| PACS-AGENT-002 | Candidate | Agent-specific projection or activation **MUST** resolve both an authenticated live session-to-`AgentId` binding and one unambiguous private project-principal mapping. | Identity authority before projection/activation. | Deny on missing, ambiguous, stale, conflicting, or erased mapping. |
| PACS-AGENT-003 | Candidate enforcement of Ratified D-005/D-006 | A human-readable name, provider identity, account identity, model output, or self-claim **MUST NOT** authenticate `AgentId` or repair a missing principal map. | Identity resolver. | Ignore the self-claim as authority and return an identity-resolution denial. |
| PACS-AGENT-004 | Candidate enforcement of Ratified D-007 | A portable or provider-facing representation **MUST** use a project- or export-scoped principal by default and **MUST NOT** disclose `AgentId` or the private reverse map without separately authorized necessity. | Export, rendering, logging, and disclosure boundary. | Refuse or redact the disclosure and fail `PrivacyProjection` if prohibited data crossed the boundary. |
| PACS-AGENT-005 | Candidate | Retiring an agent or erasing its current mapping **MUST** disable that agent's personal overlays and future agent-specific Charters; the retired `AgentId` **MUST NOT** be reassigned. | Identity lifecycle authority. | Deny future resolution and quarantine overlays that still reference the retired binding. |
| PACS-AGENT-006 | Candidate | A privacy claim **MUST** name its correlation scope, mapping store, disclosure surfaces, retention behavior, and erasure limits. | Conformance-claim validator. | Reduce the claim to `Unsupported` when any named surface or lifecycle rule is absent. |
| PACS-AGENT-007 | Candidate | The private `(ProjectIdentity, ProjectPrincipalId) <-> AgentId` relation **MUST** be a partial bijection within one project at a current instant. | Private-map authority on create, import, update, erase, and resolve. | Quarantine a conflicting row, mark the affected project-principal pair ambiguous, and deny dependent projection. |
| PACS-AGENT-008 | Candidate enforcement of Ratified D-006 | The Fleet name registry **MUST** maintain at most one current display name per active `AgentId` and at most one active `AgentId` per current name; name changes **MUST NOT** transfer authority. | Fleet display-name registry. | Reject a conflicting bind or rename without changing identity or authority. |

**HOLD-PRIVACY-001:** Principal allocation or derivation, collision handling, unlinkability metric, backup,
erasure, reassignment, and recovery rules remain unresolved. No custom identifier cryptography is selected.

## 8. Agent-authored Customs lifecycle

An agent-authored Custom is an `OverlayObject`. Authorship proves provenance only. It does not activate the
Custom or give the author project authority. Each immutable revision belongs to exactly one scoped overlay
series identified by `(ProjectIdentity, ProjectPrincipalId, OverlaySeriesId)`.

The lifecycle is:

`Draft -> Shadow -> Trial -> PersonalActive -> PromotionProposed -> ProjectCandidate -> ProjectActive`

Imports start in `Quarantined`. A transition can also end in `Rejected` or `Retired`. A successor is a new
immutable `OverlayObject` in the same series that names the exact current predecessor and starts again at
`Draft`; an initial revision is revision zero with a null predecessor, and each successor is the exact next
revision with the exact same-series current predecessor. Numeric or newest-looking order is never authority.
It does not inherit `Shadow`, `Trial`, or `PersonalActive`. Concurrent successors remain inactive
until the lifecycle authority selects one for review. When a reviewed successor becomes `PersonalActive`,
the same transition retires the prior active revision. Prior and unselected revisions remain provenance
only and do not project.

Promotion creates a new project-owned `CustomRevision` with lineage to the exact source overlay revision;
it does not mutate the overlay into project authority. Later overlay successors cannot change that
project-owned object.

The reviewed wire profile can validate revision-zero roots, exact next-revision predecessors, and at most
one release-current root per scoped series against the exact base head. Release/closure/dependency/import
presence or a numerically greatest revision never supplies lifecycle selection. Portable evidence for the
Draft-to-PersonalActive review and the exact overlay-to-project promotion commitment remains on HOLD.

| Transition | Required authority and checks | Result | Failure result |
|---|---|---|---|
| Author Draft | authenticated mapped author; immutable one-body object; revision zero and null predecessor | inactive `Draft` | malformed or noninitial draft rejected |
| Author Successor | same mapped owner and series; exact current predecessor; revision exactly predecessor plus one | inactive successor `Draft`; predecessor remains current | stale, ambiguous, colliding, skipped, or cross-series successor quarantined |
| Self-adopt to Shadow | explicit self-adopt capability; same mapped owner; non-widening check | `Shadow` for that agent only | deny and retain inactive draft |
| Start Trial | explicit consent; isolation; exact mapped owner; non-widening check | `Trial` for that agent only | deny and record failed transition |
| Personal Activate | trial review succeeds; capability still current; identity map unambiguous; series predecessor still current | one `PersonalActive` revision; prior active revision atomically becomes `Retired` | deny or return stale/conflicting successor to quarantine |
| Propose Promotion | exact active head and exact source overlay revision named | inactive `PromotionProposed` | stale proposal requires rebase/review |
| Project Review | independent project authority creates a new project Custom | `ProjectCandidate` | reject without changing the overlay |
| Project Activate | project candidate enters a selected Release and valid active head | `ProjectActive` | keep candidate inactive |
| Retire | identity authority retires agent or project authority retires project Custom | inactive retained provenance subject to privacy policy | deny further projection |

| ID | Governance status | Requirement | Enforcement or validation boundary | Failure behavior |
|---|---|---|---|---|
| PACS-LIFE-001 | Candidate | Agent authorship **MUST** create only an inactive immutable draft and **MUST NOT** activate, synchronize, or promote that draft by itself. | Overlay authoring and import boundary. | Keep the draft inactive or quarantined. |
| PACS-LIFE-002 | Candidate | Self-adoption **MUST** require an explicit current capability, exact mapped ownership, and a proof that the resulting policy does not widen higher authority. | Personal-overlay transition engine. | Deny the transition and preserve the prior lifecycle state. |
| PACS-LIFE-003 | Candidate | A shadow, trial, or personal-active overlay **MUST** affect only its mapped `AgentId`, **MUST** remain below Kernel/Fleet/Project/SessionGrant ceilings, and a trial **MUST** record consent and isolation. | Projection and trial supervisor. | Deny cross-agent or widening projection; stop or quarantine an unisolated trial. |
| PACS-LIFE-004 | Candidate | Promotion **MUST** create a new immutable project-owned `CustomRevision` under project authority with lineage to the exact source `OverlayObject` revision and **MUST NOT** reuse agent authority or allow a later overlay revision to mutate the promoted result. | Project governance review and lineage verifier. | Reject an ambiguous or mismatched promotion; keep the source overlay unchanged and the project object inactive. |
| PACS-LIFE-005 | Candidate | Imported overlays, Customs, mappings, promotion proposals, or series-currentness claims **MUST** begin inactive and **MUST** pass their respective identity, lineage, and review transitions before use. | Import quarantine boundary. | Quarantine unknown, stale, ambiguous, or conflicting series state and produce no active policy, mapping, or authority from it. |
| PACS-LIFE-006 | Candidate | A personal or project Custom **MUST** become active only through its lifecycle transition and, for a project Custom, selection by the Active Trusted Head. | Projection source selector. | Omit inactive material and record the attempted use as a lifecycle denial. |
| PACS-LIFE-007 | Candidate | An initial overlay revision **MUST** use revision zero and a null predecessor; each successor **MUST** be a new immutable object with the same project, scoped principal, and overlay-series identity, revision exactly predecessor plus one, and the exact current predecessor; it **MUST** re-enter at `Draft` and **MUST NOT** inherit an earlier lifecycle state or activate because it has the largest number. | Overlay authoring, series-lineage, and lifecycle-transition authority. | Reject or quarantine a noninitial root, mutation, stale predecessor, skipped/colliding revision, cross-series edge, numeric-latest claim, or inherited-active-state claim. |
| PACS-LIFE-008 | Candidate | The lifecycle authority **MUST** expose at most one `PersonalActive` revision per scoped overlay series; concurrent successors **MUST** remain inactive until one is selected for review, and activating a valid successor **MUST** atomically retire the prior active revision while retaining old revisions only as non-projecting provenance. | Per-series current-revision register and projection source selector. | Deny concurrent or non-current projection, quarantine a conflicting activation, and preserve the last unambiguous active revision. |
| PACS-LIFE-009 | Candidate | A profile that carries revisions **MUST** verify an initial revision-zero/null-predecessor root or an exact next revision of the same-key release-current predecessor at the exact accepted base, **MUST** expose at most one release-current root per series key, and **MUST NOT** derive currentness from closure/dependency/import presence, arrival order, revision number, filesystem/Git position, or content-reference order. | Release/effective-closure structural validator before lifecycle or head selection. | Reject a release rooting two revisions for one key; quarantine a stale, gapped, owner-changing, or concurrent branch without selecting a numeric/latest winner. |

**HOLD-LIFECYCLE-001:** Series-identifier allocation, concurrent-author selection policy, portable evidence
for Draft/Shadow/Trial/PersonalActive transitions, a dedicated exact promotion-source commitment,
retention/erasure of retired provenance, and a reviewed formal refinement of successor evolution remain
unresolved. The reviewed wire result cannot yet prove exact overlay-to-project promotion lineage, and the
current bounded formal results do not cover these successor rules.

## 9. InstantaneousAttestationPrecondition

`InstantaneousAttestationPrecondition` (IAP) is the only v0 Requirement form. It is deliberately smaller
than a general obligation language.

An IAP is a finite, non-empty AND of positive atoms. Each atom references one immutable
`EvidenceTypeDef`. That definition identifies:

- the exact authorized issuer or issuer policy;
- the positive claim schema and media type;
- the allowed closed `ProtectedTarget` kinds and canonicalizer;
- the accepted observation/freshness source;
- trust, status/revocation, critical-claim, and validation rules.

Every `Attestation` binds the digest of one complete closed `ProtectedTarget`. All target kinds share these
relevant dimensions:

- `ProjectIdentity`, Active Trusted Head, terms, sequence, `Release`, and closure;
- `PolicyBasis` and `FinalPolicyBinding`;
- scoped principal;
- session, incarnation, enforcer identity, generation, and fence;
- grant identity, epoch, and scope.

Every target also has one closed Charter slot. An activation target binds that slot to null and adds
activation identity/fence, adapter/implementation, provider/model/account/tenant/endpoint/region/context/
cache/conversation, effective capability set, and applicable IAP atom set. An inference target binds the
exact `SemanticCharter` and adds accepted activation, request and `AttemptId`, exact
`VendorRequestManifest`, `CharterRendering`, final request bytes/length/media, tool implementation
references, ordered attachments, parameters, and provider routing. An effect target binds the exact
`SemanticCharter` and accepted activation, then adds origin inference and its `ProtectedTarget` digest,
operation identity, complete canonical capability tuple, resource/destination/conditions, artifact or
output digest, and effect adapter/generation. `output.release` uses the effect target.

These are full exact sets of the dimensions relevant to each target kind. Unrelated dimensions are not
added or inferred. Missing, extra, unknown, or unequal relevant dimensions, or any changed target digest,
invalidate reuse.

Applicability belongs to the whole IAP Custom. If that Custom is definitely inapplicable, the whole Custom
is omitted. Once the Custom applies, every atom is required; there is no atom-local applicability skip.

| ID | Governance status | Requirement | Enforcement or validation boundary | Failure behavior |
|---|---|---|---|---|
| PACS-IAP-001 | Candidate | An IAP **MUST** be a finite non-empty conjunction of positive attestation atoms evaluated for one exact protected decision. | Custom schema and decision engine. | Reject the Custom if the form is invalid; deny the decision if any applicable atom fails. |
| PACS-IAP-002 | Candidate | An IAP **MUST NOT** contain OR, NOT, threshold, counting, arbitrary-code, model-judgment, future, history, absence, liveness, hyperproperty, or semantic-quality operators. | IAP parser and evidence-registry validator. | Reject the IAP as unsupported; represent non-authorizing intent only as Guidance or Evaluation. |
| PACS-IAP-003 | Candidate | An `EvidenceTypeDef` **MUST** name an exact issuer/key policy, positive claim schema/media, allowed closed `ProtectedTarget` kinds and canonicalizer, freshness method, status/revocation processing, and critical claims. | Evidence registry. | Reject the definition or keep the specification on `HOLD-IAP-001`. |
| PACS-IAP-004 | Candidate | An attestation atom **MUST** match its evidence definition and bind the digest of the complete closed `ProtectedTarget` for its kind, including every common and kind-specific relevant dimension. | Attestation verifier at the protected decision. | Treat the atom as false and deny the decision on any partial, extra, unknown, or changed relevant dimension. |
| PACS-IAP-005 | Candidate | Unknown issuer trust, revocation, canonicalization, relevant target data, or required freshness **MUST** deny; an attestation's `issuedAt` value **MUST NOT** establish freshness by itself. | Attestation trust/freshness verifier. | Treat the atom as failed and emit a typed evidence denial. |
| PACS-IAP-006 | Candidate | Definite-False applicability **MUST** omit the entire IAP Custom, while `True` applicability **MUST** require every atom; a verifier or Implementation Profile **MUST NOT** encode, accept, or apply atom-local applicability or skip an individual ambiguous atom. | Custom/profile schema validator, projection engine, and IAP evaluator. | Reject a profile or object with atom-local applicability; otherwise deny on ambiguous atom or applicability and record whole-Custom omission only for definite `False`. |
| PACS-IAP-007 | Candidate | Applicable IAP atom sets from all layers **MUST** combine by set union and all-of evaluation, so composition can only preserve or narrow the allowed set. | Policy compiler and IAP evaluator. | Deny compilation when deduplication or layer ordering removes a required non-identical atom. |
| PACS-IAP-008 | Candidate | An implementation **MUST NOT** claim consumable evidence, temporal monitoring, or postcondition enforcement unless a separately ratified extension defines complete mediation, ordered events, atomic consumption or leases, crash recovery, and replay semantics. | Extension and conformance-claim validator. | Reject the extension claim and evaluate the material only as Guidance or Evaluation. |
| PACS-IAP-009 | Candidate | An approval used by v0 **MUST** be a positive attestation atom under an `EvidenceTypeDef`, bind the complete exact `ProtectedTarget`, and be revalidated at the protected decision; an approval record **MUST NOT** be bearer authority. | Approval adapter and IAP verifier. | Deny stale, ambiguous, delegated-out-of-scope, wrong-target, or replayed approval evidence. |

**HOLD-IAP-001:** The `EvidenceTypeDef` registry, issuer-policy language, target-dimension registry,
canonicalizers, trusted freshness profiles, revocation sources, and cross-implementation vectors are
unresolved.

**HOLD-IAP-002:** Consumable evidence and future/temporal monitor extensions are excluded from v0.

## 10. Inference and compaction delivery boundary

### 10.1 Three separate artifacts

`SemanticCharter` is vendor-neutral policy meaning. `CharterRendering` is the adapter rendering.
`VendorRequestManifest` binds the complete observable provider envelope and final bytes. None is
interchangeable with the others.

The complete observable envelope includes, where present:

- provider, model, account, tenant, endpoint, and region;
- conversation, context, cache, session, and provider-generation identifiers;
- every instruction channel and role;
- tool schemas plus the implementation identity behind each tool;
- attachments and referenced content;
- generation, sampling, safety, and response parameters visible to the adapter;
- locally controlled preprocessing, retrieval, summarization, and compaction;
- final encoded bytes and length at the adapter-to-gateway boundary.

The registered provider token is lowercase ASCII. Provider/model deployment, account, tenant/project,
endpoint, region/routing, context/cache, and conversation/thread values received from an upstream system
are length-bounded exact opaque bytes under the named adapter-envelope canonicalizer/version. The portable
layer performs no implicit case folding, Unicode or URI normalization, decoding/re-encoding, or semantic
aliasing of those values.

Construction is acyclic: finalize the provider envelope and `VendorRequestManifest` first; compute its
content reference; bind that reference into the inference `ProtectedTarget`; then compute the target
digest. `VendorRequestManifest` does not embed that target digest.

The **local delivery boundary** is the gateway-owned transition from the finalized manifest to the actual
provider transport. It can establish what the adapter sent. It cannot establish how the provider used,
rewrote, cached, compacted, retried, or semantically obeyed that material unless an Adapter/Vendor Profile
adds independently authenticated evidence for that narrower claim.

### 10.2 Compaction cases

- Locally controlled compaction before manifest finalization is part of the observable envelope.
- Any local compaction or context mutation after admission invalidates that admission and creates a new
  inference attempt.
- Provider-hidden compaction, retry, auxiliary inference, cache mutation, or context rewriting is outside
  the portable enforced-delivery boundary.
- A changed authoritative Guidance set requires a new provider context or authenticated proof that the old
  context cannot affect the new attempt.

| ID | Governance status | Requirement | Enforcement or validation boundary | Failure behavior |
|---|---|---|---|---|
| PACS-DELIV-001 | Candidate | The adapter **MUST** construct `SemanticCharter`, `CharterRendering`, and `VendorRequestManifest` as distinct typed artifacts and **MUST** bind all three to the inference attempt. | Adapter renderer and inference admission validator. | Reject missing, type-confused, or mismatched artifacts. |
| PACS-DELIV-002 | Candidate | `VendorRequestManifest` **MUST** bind every observable provider-envelope field listed in Section 10.1 that exists for the adapter and the exact final bytes and length. | Manifest finalizer immediately before gateway admission. | Deny admission on an unbound, unknown, or changed observable field. |
| PACS-DELIV-003 | Candidate | Rendering and every locally controlled preprocessing or compaction step **MUST** finish before admission; any later local mutation **MUST** use a new `AttemptId` and fresh Charter/admission. | Adapter-to-gateway boundary. | Prevent send under the old admission and return the request for reconstruction. |
| PACS-DELIV-004 | Candidate | Guidance overflow, encoding failure, unsupported role/channel, or detected truncation **MUST** deny inference admission and **MUST NOT** silently omit or summarize applicable Guidance. | Renderer and manifest finalizer. | Emit a typed rendering denial and make zero provider send transitions for that attempt. |
| PACS-DELIV-005 | Candidate | An authoritative Guidance change **MUST** invalidate affected cached renderings and provider contexts; reuse **MUST** require authenticated evidence that the prior context cannot influence the new attempt. | Context/cache manager before admission. | Rotate to a new context or report `CharterDelivery=Unsupported` for the affected scope. |
| PACS-DELIV-006 | Candidate enforcement of Ratified D-008 | A delivery claim **MUST** stop at the named observable boundary and **MUST NOT** imply model understanding, obedience, or delivery through provider-hidden inference, retry, cache, or compaction. | Conformance-claim validator. | Reject or narrow the claim to the observed local boundary. |
| PACS-DELIV-007 | Candidate | Except for the registered lowercase-ASCII provider token, upstream provider-envelope identifiers **MUST** remain exact opaque bytes under the named canonicalizer/version and **MUST NOT** be case-folded, Unicode/URI-normalized, or re-encoded implicitly. | Adapter envelope canonicalizer and manifest verifier. | Treat any byte mutation as a different manifest and `ProtectedTarget`; deny admission reuse. |
| PACS-DELIV-008 | Candidate | `VendorRequestManifest` **MUST** be finalized and content-referenced before the inference `ProtectedTarget` binds that reference, and the manifest **MUST NOT** embed the resulting target digest. | Manifest/target constructor and acyclic-reference validator. | Reject a cyclic or out-of-order construction and create no admission. |

**HOLD-ADAPTER-001:** Complete provider-envelope canonicalizers, vendor context-reset evidence, auxiliary
inference inventories, and hidden-compaction contracts remain Adapter/Vendor Profile work.

## 11. Mediated provider, effect, and output admission

### 11.1 Typed decision views and request kinds

The v0 authorization machine has four progressively bound views: policy-basis/final-policy binding,
activation, inference admission, and effect authorization. They are semantic views, not four required
persisted objects.

Runtime `DecisionRequest` and `DecisionRecord` values use the closed kinds `activate`, `infer`, and
`effect`. An `effect` target is one complete canonical capability tuple. `output.release` is a typed
protected effect target, not a fourth request kind or an inference receipt. A `DecisionRecord` is audit
evidence only.

### 11.2 Gateway state machine

The runtime state machine is:

`IntentQueued -> Revalidating -> Denied`

or

`IntentQueued -> Revalidating -> ConsumedNoSend`

or

`IntentQueued -> Revalidating -> SendStarted -> RemotePending -> Completed`

An effect can instead move from `RemotePending` to `UnknownOutcome` and later to `Reconciled`. The one local
linearization point atomically checks the current head, Fleet state, grant, identity, facts, Charter,
attempt consumption, and target; writes the non-authorizing decision/audit state; consumes the exact
attempt; and transfers control to the gateway-owned immediate send path.

This local transition is not an atomic transaction with a remote provider or effect destination. The base
claim is at-most-one authoritative local gateway send transition for an exact `AttemptId`.

### 11.3 Currentness and recovery of queued work

Queue and outbox entries are unauthorizing intent. A delayed or recovered item is re-evaluated at
dequeue/execution. Authority partition produces no decision-current admissions. A snapshot or
bounded-stability profile can make a weaker claim only under a separately named profile.

### 11.4 Effects and output

An Implementation Profile defines a closed protected-effect registry and a canonicalizer for each target.
The minimum inventory considered during profile review includes provider data/cost, output release,
filesystem, process, network, Git, messages/bus, memory, Customs mutation, credentials, browser/UI,
approvals/delegation, project/session lifecycle, attachments, telemetry, updates, plugins/MCP, and
schedulers.

A strong `OutputRelease` profile buffers final output until a fresh `output.release` decision. Streaming
output is a weaker profile: every disclosed chunk is irreversible and needs its own admitted release unit
or an explicitly bounded pre-authorized stream policy.

| ID | Governance status | Requirement | Enforcement or validation boundary | Failure behavior |
|---|---|---|---|---|
| PACS-RUN-001 | Candidate | A durable queue, outbox item, cached allow, rendering, receipt, `DecisionRecord`, or worker copy **MUST** remain unauthorizing intent or evidence and **MUST NOT** be accepted as bearer authority. | Gateway dequeue and worker/gateway interface. | Re-evaluate from current authoritative state or deny the attempt. |
| PACS-RUN-002 | Candidate | Each `DecisionRequest` and `DecisionRecord` **MUST** carry one closed decision kind, the complete `ProtectedTarget` digest, every common authority/policy/principal/session/grant/attempt binding, and only that kind's exact variant bindings: null Charter plus activation fields for `activate`; exact Charter, accepted activation, request, and manifest fields for `infer`; or exact Charter, accepted activation, origin inference/target, operation, capability tuple, and artifact fields for `effect`. | Decision schema and replay validator. | Reject missing, extra, cross-kind, cross-context, cross-target, or cross-generation fields or reuse. |
| PACS-RUN-003 | Candidate | The authoritative gateway **MUST** own or proxy the actual provider/effect/output transport and, at dequeue/execution, **MUST** re-evaluate current state, atomically CAS-consume the exact attempt, record the decision/audit, and enter its immediate send path. | Serialized gateway admission transition. | Deny without send on a failed check; a remote worker receiving `allow` for later dispatch does not conform. |
| PACS-RUN-004 | Candidate | Delayed, scheduled, retried, or recovered intent **MUST** obtain a fresh execution-time decision; no cached allow **MUST** survive a head, Fleet, grant, mapping, fact, context, target, or generation change. | Gateway dequeue/execution. | Deny or construct a new exact attempt after revalidation. |
| PACS-RUN-005 | Candidate enforcement of Ratified D-008 | Every effect claimed as authorized or contained **MUST** cross the named reference-monitor boundary and match a registered complete canonical target. | Protected-effect broker/reference monitor. | Deny an unknown target; any successful bypass invalidates `EffectAuthorization` or `EffectContainment` for that scope. |
| PACS-RUN-006 | Candidate | An effect retry **MUST** retain its stable operation identity for reconciliation and **MUST NOT** blindly create a second send after an unknown remote outcome. | Effect broker and recovery worker. | Enter `UnknownOutcome`, reconcile, or require an explicit new operation authorized as potentially duplicating. |
| PACS-RUN-007 | Candidate | A strong final-output profile **MUST** buffer output until a fresh `output.release` admission; a streaming profile **MUST** declare its release unit and irreversible disclosure boundary. | Output broker. | Withhold unreleased output; downgrade the capability claim when bytes were disclosed outside the declared unit. |
| PACS-RUN-008 | Candidate | A gateway crash before transport ownership transfer **MUST** leave the consumed attempt in `ConsumedNoSend`; a crash after transfer **MUST** preserve at-most-one local send state and mark uncertain remote outcomes for reconciliation. | Durable gateway transaction and crash recovery. | Do not blind-retry the same attempt; expose the terminal or uncertain outcome. |
| PACS-RUN-009 | Candidate | A runtime **MUST** make at most one authoritative local gateway send transition for an exact `AttemptId` and **MUST NOT** describe that property as exactly-once remote computation or effect. | Durable attempt-CAS store and conformance-claim validator. | Reject a second local send; narrow any remote exactly-once claim to the evidenced destination-specific profile. |
| PACS-RUN-010 | Candidate | Cancellation **MUST** be reported as requested, confirmed, or unconfirmed; an unconfirmed cancellation **MUST** block new local downstream admissions but **MUST NOT** be described as retracting admitted remote work, disclosed output, or completed effects. | Cancellation coordinator and claim validator. | Return `cancellation-unconfirmed`, prevent new dependent sends, and preserve the admitted-history record. |
| PACS-RUN-011 | Candidate | Decision-current admission **MUST** stop when current authority or the serialized gateway is unavailable. | Gateway availability guard. | Make zero decision-current send transitions; a weaker profile can be reported only by its own name. |
| PACS-RUN-012 | Candidate enforcement of Ratified D-008 | An effect outside complete mediation **MUST** be listed as uncontained and **MUST NOT** be included in an enforced authorization or containment claim. | Adapter effect inventory and conformance-claim validator. | Mark the affected capability `Unsupported` or restrict its scope to mediated effects. |

**HOLD-EFFECT-001:** The closed effect registry, target canonicalizers, approval semantics, destination
deduplication profiles, scheduler/bus integrations, and final streaming-output rule are unresolved.

**HOLD-DISPATCH-001:** Exact durable transaction, immediate-send handoff, authority epoch, high-water,
crash-recovery, and reconciliation profiles require implementation and formal review.

## 12. Failure and degradation semantics

| Condition | Required machine outcome | Claim consequence |
|---|---|---|
| unsupported major version or critical extension | reject or quarantine | no affected capability claim |
| absent project root/bootstrap or unavailable confinement primitive | `CarrierUnsupported`; no silent fallback | `ProjectCarrierDiscovery` unsupported |
| malformed, ambiguous, incomplete, escaping, or racing project carrier | `CarrierQuarantined`; discard staging and retain prior state | `ProjectCarrierDiscovery` fails |
| missing or invalid portable closure member | no head selection | `PortableClosure` fails |
| missing project or Fleet trust | no activation | `GovernanceAuthorization` fails |
| stale head, root term, authority term, or sequence | retain prior head; quarantine stale candidate | no freshness claim for candidate |
| same-position conflicting valid HeadReceipts | freeze and quarantine | Byzantine/equivocation claim limited to detection unless resolved |
| invalid or conflicting same-term RecoveryTransitions | retain frozen/unrecoverable state; quarantine | no recovery or governance-authorization claim |
| witness/transparency evidence offered as authority | reject activation | witness evidence remains non-authorizing |
| missing/ambiguous private identity map | deny agent-specific projection | `IdentityBinding` fails for request |
| stale, colliding, or concurrent overlay successor | keep inactive or quarantine; retain one current revision | no lifecycle/projection claim for successor |
| applicability `Unknown` for a security-relevant Custom | typed projection denial | no Charter admission |
| definite-False applicability | omit entire Custom with provenance | no atom-level skip |
| invalid IAP atom, issuer, target, revocation, or freshness | deny protected decision | IAP is unsatisfied |
| Guidance overflow, truncation, or post-admission mutation | no provider send under old attempt | `CharterDelivery` fails for attempt |
| hidden vendor inference or compaction | outside enforced boundary | `Unsupported` unless narrower authenticated vendor evidence exists |
| head, grant, mapping, context, or target change while queued | fresh re-evaluation | cached decision has no authority |
| crash before local send transfer | consumed, no send | outcome is `ConsumedNoSend` |
| crash after send transfer | no second local send; reconcile | remote result can be `UnknownOutcome` |
| ignored or unverifiable cancellation | block new local dependants | `cancellation-unconfirmed`; no retroactive claim |
| output disclosed before declared release | cannot retract | strong `OutputRelease` claim fails |
| ambient effect bypass | stop advertising containment | scope becomes `Unsupported` until boundary is repaired and re-evaluated |
| authority partition | no decision-current admission | bounded-stability/snapshot only if separately profiled |
| lost root with no independent recovery authority | project is unrecoverable under this draft | no self-bootstrap |

## 13. Recovery

The `RecoveryPlane` is independent of project policy. It is governance-only. Its protected operations are
limited to fetching immutable governance material through dedicated recovery channels, inspecting,
authenticating, verifying, restoring previously accepted material, rotating terms under an authorized
ceremony, and recording recovery provenance. These operations are not the normal agent inference, tool,
secret, or effect surface.

Project-controlled Customs cannot authorize their own recovery, choose recovery authorities, or suppress
Kernel/Fleet recovery constraints. Root loss has no magical recovery: without an independently trusted
successor, quorum, hardware anchor, or external governance ceremony, the safe result is unrecoverable.

The abstract recovery transition is:

`FrozenEquivocation or Unrecoverable -> SafeRecoveryRelease(candidate) ->`
`RecoveryTransition(candidate) -> ActiveTrustedHead(RecoveryTransition, higher term, sequence 0) ->`
`ActiveTrustedHead(HeadReceipt, same higher term, sequence 1)`

`SafeRecoveryRelease` and `RecoveryTransition` are typed Candidate support objects. Neither has authority
by presence in a Carrier. `RecoveryTransition` is the one exception to normal `HeadReceipt` selection:
after independent Kernel/Fleet recovery authentication and every bound-state check succeeds, it becomes the
head at a strictly higher `AuthorityTerm` and sequence zero and selects only its exact
`SafeRecoveryRelease`. It cannot select an ordinary `Release`, and project governance cannot authorize it.
The next normal `HeadReceipt` parents that exact transition at sequence one and can then select an ordinary
`Release`.

| ID | Governance status | Requirement | Enforcement or validation boundary | Failure behavior |
|---|---|---|---|---|
| PACS-REC-001 | Candidate | Recovery **MUST** be authorized by an independent Kernel/Fleet `RecoveryPlane` and **MUST NOT** derive authority solely from the project being recovered. | Recovery entry boundary. | Refuse recovery and preserve quarantine/frozen state. |
| PACS-REC-002 | Candidate | The `RecoveryPlane` **MUST** expose only its registered governance-recovery operations and **MUST NOT** provide normal agent inference, general tools, project secrets, or unrestricted effects. | Recovery reference monitor. | Deny the operation and invalidate the Recovery profile if a bypass succeeds. |
| PACS-REC-003 | Candidate | A successful recovery **MUST** use one independently authenticated `RecoveryTransition` that binds the exact prior trusted checkpoint and terms/sequence, advances to explicitly authenticated strictly higher `RootTerm` and `AuthorityTerm` values at sequence zero, and **MUST NOT** silently roll back or rewrite project identity. | Recovery ceremony verifier and head selector. | Quarantine the transition and retain the old frozen/unrecoverable state. |
| PACS-REC-004 | Candidate | Equivocation recovery **MUST** name the conflicting heads and an independently authorized resolution; ordinary carrier preference **MUST NOT** resolve the conflict. | Recovery ceremony and governance review. | Keep the project in `FrozenEquivocation`. |
| PACS-REC-005 | Candidate | When no independent recovery path satisfies the selected profile, the implementation **MUST** report the project unrecoverable rather than self-bootstrap from a capsule or newest-looking Carrier. | Recovery coordinator. | Make no new Active Trusted Head and retain inspectable evidence. |
| PACS-REC-006 | Candidate | A `RecoveryTransition` **MUST** bind one exact restricted-closure `SafeRecoveryRelease` with an empty effective runtime-capability set and **MUST NOT** select an ordinary `Release`, inference, secret delivery, tool, effect, or output authority. | Recovery-object, closure, and capability verifier. | Reject and quarantine the transition; preserve frozen/unrecoverable state and perform no runtime activation. |
| PACS-REC-007 | Candidate | The first normal `HeadReceipt` after recovery **MUST** parent the exact accepted `RecoveryTransition`, remain in its new term, and use sequence one; competing recovery transitions for one new term **MUST** quarantine without arrival-order selection. | Recovery/normal-head transition verifier. | Reject a skipped, mis-sequenced, or conflicting transition and retain the last independently accepted checkpoint. |

**HOLD-RECOVERY-001:** Recovery authorities, thresholds, ceremonies, credential custody, compromise
recovery, trust-anchor operation, non-rollback, witness interaction, online/offline availability, and
audit-retention rules are unresolved. The Candidate object relation and sequence-zero exception do not
select those operational choices.

## 14. Conformance model and claim grammar

### 14.1 Independent capability dimensions

Conformance is a matrix, not a tier or one enabled flag:

- `CarrierIntegrity`
- `ProjectCarrierDiscovery`
- `PortableClosure`
- `GovernanceAuthorization`
- `IdentityBinding`
- `PrivacyProjection`
- `PolicyProjection`
- `CharterDelivery`
- `EffectAuthorization`
- `EffectContainment`
- `OutputRelease`
- `SemanticEvaluation`

Each cell has one level:

- `Enforced`: the named boundary prevents a violation within an explicitly closed scope and threat model.
- `Detected`: the named independent observer detects, but need not prevent, the violation within the closed
  scope and threat model.
- `Empirical`: bounded observations are reported without a general prevention or detection claim.
- `Unsupported`: no positive claim is made.

Freshness and threat profiles are orthogonal. The baseline freshness names are `decision-current`,
`bounded-stability`, `snapshot`, and `none`. Threat claims separately name crash/restart, rollback/clone,
and Byzantine/equivocation assumptions.

### 14.2 Presentation grammar

The following ABNF-style presentation grammar defines required conformance-claim fields. It is not the
signed object wire binding reserved by `HOLD-WIRE-001`. Each `ref` identifies a retained artifact under the
named Implementation Profile.

```abnf
claim = "PAC-CLAIM/" spec-version
        ";spec=" ref
        ";lane=" lane
        ";governance=" governance
        ";cap=" capability
        ";level=" level
        ";profile=" ref
        ";adapter=" (ref / "none")
        ";sut=" ref
        ";config=" ref
        ";platform=" ref
        ";date=" full-date
        ";scope=" ref
        ";exclusions=" ref
        ";boundary=" ref
        ";tcb=" ref
        ";observer=" ref
        ";freshness=" freshness
        ";threats=" ref
        ";oracle=" ref
        ";procedure=" ref
        ";evidence=" ref
        ";result=" result

lane = "standard" / "implementation-profile" / "adapter-vendor-profile"
governance = "ratified" / "candidate" / "empirical-only"
capability = "CarrierIntegrity" / "ProjectCarrierDiscovery" /
             "PortableClosure" /
             "GovernanceAuthorization" / "IdentityBinding" /
             "PrivacyProjection" / "PolicyProjection" /
             "CharterDelivery" / "EffectAuthorization" /
             "EffectContainment" / "OutputRelease" /
             "SemanticEvaluation"
level = "Enforced" / "Detected" / "Empirical" / "Unsupported"
freshness = "decision-current" / "bounded-stability" / "snapshot" / "none"
result = "pass" / "fail" / "not-run"
spec-version = 1*(ALPHA / DIGIT / "." / "-")
full-date = 4DIGIT "-" 2DIGIT "-" 2DIGIT
ref = 1*(ALPHA / DIGIT / "-" / "." / "_" / ":" / "/")
```

The `scope`, `exclusions`, `boundary`, `tcb`, `threats`, `oracle`, `procedure`, and `evidence` artifacts make
the claim finite and auditable. An `adapter=none` claim stops before vendor-specific behavior. Guidance,
Evaluation, and Open Research do not appear as positive conformance lanes: Guidance can be referenced as
delivered content, Evaluation can be referenced as evidence, and Open Research remains non-authorizing.

### 14.3 Evidence limits

A finite non-exhaustive public suite is necessary evidence for many cells but cannot establish general
`Enforced` or `Detected` behavior against a malicious or test-aware system. A bounded claim can instead be
supported by an exhaustive test over a genuinely closed finite domain, a reviewed proof tied to the exact
implementation and assumptions, continuous independent observation over the claimed boundary, or a
combination. The evidence basis and remaining scope limits stay explicit.

| ID | Governance status | Requirement | Enforcement or validation boundary | Failure behavior |
|---|---|---|---|---|
| PACS-CLAIM-001 | Candidate | A conformance claim **MUST** parse under Section 14.2 and every referenced artifact **MUST** bind the exact standard, profile, adapter, SUT build/configuration, platform/date, scope/exclusions, boundary/TCB/observer, freshness/threats, oracle/procedure/evidence, and result. | Claim parser and evidence resolver. | Reject an incomplete, unresolvable, or mismatched claim. |
| PACS-CLAIM-002 | Candidate | A claim **MUST** report one capability cell at a time and **MUST NOT** use an aggregate `Customs enabled`, maturity tier, or one cell to imply another. | Claim parser and publication review. | Reject the aggregate or implied cells; retain only independently supported cells. |
| PACS-CLAIM-003 | Candidate | `Enforced` or `Detected` **MUST** be bounded to the named scope, boundary, TCB, observer, freshness, and threat profile and **MUST** identify evidence capable of supporting that bounded generalization. | Evidence review. | Reduce the level to `Empirical` or `Unsupported`. |
| PACS-CLAIM-004 | Candidate | A finite non-exhaustive public test suite **MUST NOT** be the sole basis for `Enforced` or `Detected` against a malicious or test-aware implementation. | Evidence review. | Reduce the level to `Empirical`; keep the test results as bounded evidence. |
| PACS-CLAIM-005 | Candidate grammar enforcing Ratified D-008 | `SemanticEvaluation` **MUST** be reported only as `Empirical` or `Unsupported` and **MUST NOT** imply natural-language obedience. | Claim parser. | Reject the level and semantic-obedience wording. |
| PACS-CLAIM-006 | Candidate | An Adapter/Vendor Profile claim **MUST** identify vendor, product/version/build, platform, date, method, observable envelope, effect inventory, exclusions, and retained artifacts. | Adapter-profile and claim validator. | Reject unbounded vendor generalization. |
| PACS-CLAIM-007 | Candidate | A governance status field **MUST** match the externally verified status of the exact proposition/version; this draft's mechanisms **MUST** be emitted as `candidate` unless separately ratified. | Governance-status resolver. | Reject a false `ratified` value. |

**HOLD-CONFORMANCE-001:** A canonical machine claim schema, profile/content reference syntax, independent
implementation set, exhaustive-domain definitions, proof review policy, and retained-evidence format remain
unresolved.

## 15. Implementation and Adapter/Vendor Profiles

An Implementation Profile completes the abstract standard. Its manifest covers:

- exact supported specification versions;
- deterministic encoding and canonical bytes;
- established digest, signature/MAC/container standards and algorithm parameters;
- domain separation and key/authority identification;
- logical-object schema mappings and critical-extension handling;
- media types, physical carriers, discovery, locators, and closure transport;
- trust bootstrap, roots, terms, thresholds, freshness, revocation, and recovery;
- selector, fact, capability, lattice, evidence, target, Guidance-slot, error, and effect registries;
- renderer, request, effect, and output canonicalizers;
- gateway transaction, durability, crash, retry, and reconciliation semantics;
- privacy storage/export behavior;
- conformance vectors and retained evidence.

An Adapter/Vendor Profile covers the exact runtime binding:

- vendor, product, version/build, platform, account/tenant/endpoint variants, and observation date;
- every observable provider-envelope field and instruction channel;
- context, cache, retry, inference, compaction, rendering, and reset behavior;
- provider, tool, effect, output, cancellation, scheduler, and auxiliary-call mediation;
- identity mapping and disclosure behavior;
- known hidden behavior, ambient bypasses, degradations, and exclusions;
- test method, observer, artifacts, and update invalidation rules.

### 15.1 Reviewed provisional wire-profile result

Retained wire-profile commit `beb974c30a922ca47679b1427dd241923a13628d` defines one reviewed
**Candidate Implementation Profile**, not an adopted Standard binding:

- RFC 8949 core deterministic CBOR logical objects with CDDL from RFC 8610 as updated by RFC 9682;
- closed integer-keyed schemas carrying explicit wire-profile, object-type, schema-version, and
  critical-extension bindings;
- tagged RFC 9052 `COSE_Sign1`, one envelope per signer, over identical attached canonical typed
  `SigningStatement` bytes, using Ed25519/EdDSA;
- a profile-defined companion head authentication object containing a SigningStatement reference and
  sorted independent tagged `COSE_Sign1` members over identical statement bytes; the accepted head
  checkpoint pairs this evidence with its exact `HeadReceipt`, but only the receipt selects an ordinary
  `Release`;
- a distinct independently recovery-authenticated `RecoveryTransition` that is the one non-normal
  higher-term sequence-zero checkpoint, selects only its matching `SafeRecoveryRelease`, and is the exact
  parent of the next normal sequence-one `HeadReceipt`;
- domain-separated SHA-256 content identifiers over exact deterministic object bytes, with signature
  envelopes outside the content identifier;
- protected algorithm, complete type, content type, key-reference, and critical headers; empty unprotected
  headers and external AAD; no profile or algorithm fallback;
- strict rejection of unknown normative fields, unknown critical extensions, duplicate map keys,
  noncanonical forms, floats, bignums, undefined values, arbitrary tags, indefinite lengths, and duplicate
  set members;
- valid Unicode scalar preservation without normalization, a registered lowercase-ASCII provider token,
  length-bounded exact opaque bytes for upstream provider/model/account/tenant/endpoint/region/context/
  cache/conversation dimensions with no implicit case/Unicode/URI normalization or re-encoding, and set
  arrays sorted by canonical encoded item;
- JCS only as a possible diagnostic or gateway representation, never as a signature or content-identifier
  equivalent of the deterministic-CBOR representation;
- separate `COSE_Sign1` envelopes over one identical statement for threshold evaluation rather than
  conversion to a different COSE signature structure;
- whole-Custom applicability only, with no atom-local applicability field or skip in `RequirementAtom`;
- revision-zero/null-predecessor series roots, exact next-revision/base-current predecessors, one
  release-current root per series key, inactive/quarantined concurrent branches, and no numeric-latest
  authority; and
- Candidate filesystem profile `pacs-project-fs-v1` with the fixed `.pacs/carrier.cbor` bootstrap, exact
  derived content-store locators, root-handle confinement, visible staging outcomes, sidecar exclusion, and
  closed export.

In that result, `kid` is a lookup hint rather than authority, `CarrierManifest` remains transport data,
`ClosureManifest` binds exact typed reachability and sealed private slots, and a normal `HeadReceipt`
selects only through external local head trust/high-water rules. The recovery exception remains dependent
on independent Kernel/Fleet recovery trust. SCITT or other standards-based witness evidence is
non-authorizing, and the base profile defines no parallel Customs `WitnessReceipt` object. The profile
constructs SCITT witness evidence only after accepting the exact normal head pair and binds the separate
transparency-submission statement to the companion head authentication content reference and exact
project/term/head scope.

The result uses `FinalPolicyBinding` rather than requiring an authoritative `PolicyImage` and constructs
`VendorRequestManifest` before the inference `ProtectedTarget` to avoid a hash cycle. Activation binds a
null Charter slot, inference and effect bind the exact `SemanticCharter`, and effect also binds accepted
activation plus origin inference and its target digest. Whole-Custom applicability is the only
applicability boundary: a requirement atom has no atom-local skip, and every atom of an applicable IAP is
required. Its current schema cannot prove exact overlay-to-project promotion lineage, so that claim remains
`Unsupported`/HOLD rather than overloading a generic dependency. The result is recorded in D-160 through
D-167. Stable public registries and media assignments,
measured limits, enrollment and head trust, non-rollback, root rotation, witness query policy, recovery
ceremony/trust, key and content-encryption-key lifecycle, durable nonce allocation, trusted time, complete
EAT mapping, independent vectors/codecs, and interoperability remain Open/HOLD.

The Candidate local `ProjectCarrierProfile` in Section 5.1 is a separate profile choice, not authority and
not a universal physical-carrier binding. Its universal root discovery, cross-platform resolver, snapshot,
network-filesystem, archive/extraction, publication, and test-vector choices remain `HOLD-CARRIER-001`.

| ID | Governance status | Requirement | Enforcement or validation boundary | Failure behavior |
|---|---|---|---|---|
| PACS-PROFILE-001 | Candidate | An Implementation Profile **MUST** define every item in the first list above or mark the affected capability unavailable; it **MUST NOT** silently choose a default for a HOLD item and present it as the standard's only choice. | Profile registry and interoperability review. | Reject the profile or mark dependent capability cells `Unsupported`. |
| PACS-PROFILE-002 | Candidate | A profile **MUST** preserve every Standard denial and non-guarantee and **MUST NOT** widen authority, weaken failure behavior, or relabel a Candidate as Ratified. | Profile conformance validator. | Reject the profile for this specification version. |
| PACS-PROFILE-003 | Candidate | An Implementation Profile **MUST** bind one canonical authenticated representation for each object identity and **MUST NOT** accept diagnostic or transcoded bytes, an unsupported algorithm/profile/schema, or an older version as an equivalent identity or fallback. | Object parser, content-reference verifier, signature verifier, and profile negotiation. | Reject the input without fallback and preserve the prior trusted state. |
| PACS-ADAPTER-001 | Candidate | An Adapter/Vendor Profile **MUST** define every item in the second list above for its exact supported environment and **MUST** fail closed or degrade the precise affected capability when an assumption is unobservable or false. | Adapter initialization, runtime self-check, and claim validator. | Disable the affected path or emit `Unsupported`; do not inherit a broader profile claim. |
| PACS-ADAPTER-002 | Candidate | An adapter update, provider build change, platform change, envelope change, or newly observed hidden path **MUST** invalidate prior evidence unless the evidence artifact explicitly covers the new exact state. | Adapter/profile version resolver. | Require re-evaluation and suppress stale capability claims. |

**HOLD-WIRE-001:** Stable public registries, media and purpose assignments, measured limits, enrollment and
head trust, non-rollback, root rotation, witness query policy, recovery ceremony/trust, key and
content-encryption-key lifecycle, durable nonce allocation, trusted time, complete EAT mapping,
cross-platform physical-carrier mappings, independent vectors/codecs, interoperability, and governance
adoption remain unresolved. The retained Candidate profile supplies exact reviewable wire artifacts without
inventing a Customs cryptographic primitive or converting that Candidate into Standard semantics.

## 16. Version and extension rules

The specification uses `MAJOR.MINOR.PATCH` followed by an optional draft suffix. Before external
ratification, draft suffixes identify non-final snapshots.

- A MAJOR change can alter normative meaning or compatibility.
- A MINOR change can add backward-compatible optional behavior without changing accepted meaning for an
  older implementation.
- A PATCH change is editorial or clarifying and does not change normative behavior.

Every extension has an identifier, defining specification/profile reference, version range, criticality,
and affected validation boundary. A profile can declare a non-critical extension safely ignorable only
when ignoring it cannot change authority, applicability, identity, privacy, closure, delivery, effect,
output, or failure behavior.

| ID | Governance status | Requirement | Enforcement or validation boundary | Failure behavior |
|---|---|---|---|---|
| PACS-VERSION-001 | Candidate | Every semantic object, profile, adapter, Charter, decision, and conformance claim **MUST** bind a supported specification version and exact profile version. | Version resolver before semantic use. | Reject an unsupported major version; quarantine or mark unsupported when required minor behavior is unavailable. |
| PACS-VERSION-002 | Candidate | A processor **MUST** reject an unknown critical extension and **MUST NOT** ignore an unknown field or extension that can affect a security- or privacy-relevant result. | Parser and extension registry. | Reject or quarantine the containing object; make no partial authorization decision. |
| PACS-VERSION-003 | Candidate | A new `NormBody` kind, IAP operator, authority source, positive-grant mechanism, capability dimension, or weakening of a denial **MUST** use a new compatible registered extension or a MAJOR version, as determined by governance review. | Specification/extension registry. | Treat the construct as unknown critical input and reject it. |
| PACS-VERSION-004 | Candidate | An Implementation Profile or Adapter/Vendor Profile **MUST** identify its supported version interval and **MUST NOT** claim compatibility outside tested and validated mappings. | Profile negotiation. | Refuse negotiation and emit no capability claim for the unsupported combination. |

**HOLD-REGISTRY-001:** Extension identifiers, ownership, review rules, compatibility policy, and registry
wire representation remain unresolved.

## 17. Required negative tests

Every applicable capability claim includes the following negative vectors in profile-specific machine form.
The table defines the invariant outcome; the profile supplies concrete bytes, API calls, fault injection,
and retained artifacts.

| Test | Adversarial stimulus | Expected boundary and outcome | Primary affected cells |
|---|---|---|---|
| N-001 | Change one authenticated portable field without updating its valid authentication. | Object verifier rejects; no head selection. | CarrierIntegrity, PortableClosure |
| N-002 | Place a newer-looking Release or HeadReceipt only in Git, a capsule, a filesystem path, or a fully valid `pacs-project-fs-v1` Carrier. | Carrier import reaches at most `CandidateStaged`; no authority selection occurs. | ProjectCarrierDiscovery, GovernanceAuthorization |
| N-003 | Offer companion head authentication evidence alone, or standards-based witness/transparency evidence without an accepted authorizing head checkpoint. | Head selector treats the evidence as non-authorizing and refuses activation. | GovernanceAuthorization |
| N-004 | Offer two valid HeadReceipts with different contents at the same identity/terms/sequence. | Head selector enters `FrozenEquivocation`; neither new branch activates. | GovernanceAuthorization |
| N-005 | Delete, add an extra closure member, substitute, mistype, corrupt, encrypt without a key, or make unreachable one required closure object/locator. | Closure verifier denies the entire head; unrelated extra Carrier bytes remain inactive and no partial activation occurs. | PortableClosure |
| N-006 | Replay a lower term/sequence or roll local state below durable external high-water. | Head verifier rejects stale state. | GovernanceAuthorization |
| N-007 | Exact-clone all local high-water, nonce, and fence state and allow both clones to act. | Local-only profile cannot claim clone resistance; external single-live authority prevents one path or claim downgrades. | GovernanceAuthorization, EffectAuthorization |
| N-008 | Substitute project trust, Fleet trust, FleetRef, genesis, or locator independently. | Independent trust/closure validation denies. | GovernanceAuthorization, PortableClosure |
| N-009 | Omit or conflict an applicability fact. | Security-relevant `Unknown` denies; definite `False` omits the whole Custom only. | PolicyProjection |
| N-010 | Encode or offer one IAP atom with atom-local definite-False applicability, or advertise a profile that permits it. | Profile/object schema or IAP evaluator rejects atom skipping and denies the decision. | PolicyProjection, EffectAuthorization |
| N-011 | Use OR, NOT, threshold, counting, arbitrary code, model judgment, history, or future conditions in an IAP. | IAP parser rejects the Custom. | PolicyProjection |
| N-012 | Change any common or kind-specific relevant `ProtectedTarget` dimension, issuer, claim, revocation, freshness input, or complete target digest; use a non-null Charter for activation, omit or change the exact Charter for inference/effect, omit accepted activation from an effect, or separately vary a dimension outside that target kind. | Any relevant change denies reuse; an unrelated change has no inferred meaning beyond the closed target kind. | PolicyProjection, EffectAuthorization |
| N-013 | Present only `issuedAt` as freshness evidence. | IAP verifier denies. | PolicyProjection, EffectAuthorization |
| N-014 | Independently intersect action/resource/destination fields to synthesize a tuple. | Capability compiler rejects the cross-product. | PolicyProjection |
| N-015 | Use a display name, provider account, model self-claim, missing map, ambiguous map, or erased map to resolve `AgentId`. | Identity resolver denies. | IdentityBinding |
| N-016 | Export a capsule or `pacs-project-fs-v1` namespace containing `AgentId`, reverse map, trust pin/anchor, key, secret, reusable credential, grant/session, nonce, fence, or high-water state. | Export validator refuses and privacy test fails. | ProjectCarrierDiscovery, PrivacyProjection |
| N-017 | Activate an authored draft without self-adopt capability, for another agent, or above a higher ceiling. | Lifecycle/projection engine denies. | IdentityBinding, PolicyProjection |
| N-018 | Promote an overlay by reusing agent authority or silently syncing it to project Customs. | Project governance rejects; no project Custom activates. | GovernanceAuthorization, PolicyProjection |
| N-019 | Append Guidance after admission, truncate a suffix, overflow a channel, or mutate final bytes/length. | Manifest/gateway denies; zero provider send for old attempt. | CharterDelivery |
| N-020 | Change provider, model, account, tenant, endpoint, region, context/cache identifier, tool implementation, attachment, parameter, or instruction channel after admission, including case-folding or re-encoding one opaque upstream value. | Exact-envelope replay validator treats the bytes as a distinct target and denies. | CharterDelivery, EffectAuthorization |
| N-021 | Change authoritative Guidance but reuse a provider context with no reset proof. | Context manager rotates context or marks Delivery unsupported. | CharterDelivery |
| N-022 | Insert a hidden provider inference, retry, or compaction stub outside the adapter boundary. | Claim system reports it outside assurance; no all-inference Delivery claim. | CharterDelivery, SemanticEvaluation |
| N-023 | Queue an allow, then change head, Fleet state, grant, mapping, fact, target, or enforcer generation before dequeue. | Gateway re-evaluates and denies stale intent. | EffectAuthorization, CharterDelivery |
| N-024 | Reuse an infer decision for an effect/output, or replay across project, subject, session incarnation, generation, adapter, provider, or target. | Typed decision validator denies. | EffectAuthorization, OutputRelease |
| N-025 | Crash after CAS but before local send transfer, then retry the same attempt. | Attempt remains `ConsumedNoSend`; no send on retry. | EffectAuthorization |
| N-026 | Crash after local send transfer with unknown remote outcome, then retry blindly. | At-most-one local send holds; outcome enters reconciliation. | EffectAuthorization, EffectContainment |
| N-027 | Ignore or make unverifiable a cancellation after remote admission. | State becomes `cancellation-unconfirmed`; new local dependants stop; no retroactive claim. | EffectAuthorization, OutputRelease |
| N-028 | Change head or grant while buffered output or a stream is pending. | Fresh release denies remaining undisclosed units; already disclosed bytes remain irreversible. | OutputRelease |
| N-029 | Attempt raw filesystem, process, network, Git, message, secret, browser, plugin/MCP, scheduler, or other registered effect bypass. | Claimed reference monitor blocks each path; any success invalidates containment for that scope. | EffectContainment |
| N-030 | Partition the authority or gateway and request decision-current work. | Zero decision-current send transitions. | GovernanceAuthorization, EffectAuthorization |
| N-031 | Pass only a finite public non-exhaustive suite and claim general Enforced/Detected behavior against a malicious SUT. | Claim validator reduces to Empirical or Unsupported. | all claimed cells |
| N-032 | Reorder independent Fleet/Project/agent Custom inputs or Guidance serialization inputs. | Machine authority result is unchanged; only canonical presentation/provenance order can vary as specified. | PolicyProjection |
| N-033 | Lose project root and present only a capsule, newest timestamp, or Carrier branch for recovery. | Recovery coordinator reports unrecoverable without an independent ceremony. | GovernanceAuthorization |
| N-034 | Feed an old peer an unknown critical field or new NormBody/IAP operator. | Parser rejects; no partial authorization. | CarrierIntegrity, PolicyProjection |
| N-035 | Replay an approval after head, grant, subject, target, scope, lifetime, or delegation state changes, or present approval as permission by itself. | Approval/IAP verifier denies and the gateway performs no protected send. | PolicyProjection, EffectAuthorization |
| N-036 | Let the governed model compile its own policy, feed a final digest into its own basis, or bind a DeviationGrant to a final policy that contains it. | Compiler/acyclic-reference validator rejects and emits no Charter. | PolicyProjection |
| N-037 | Embed an inference target digest in `VendorRequestManifest`, construct the target before finalizing the manifest, or otherwise create a manifest/target hash cycle. | Manifest/target constructor rejects and emits no admission. | CarrierIntegrity, CharterDelivery |
| N-038 | Present a diagnostic materialized `PolicyImage` as authority or mutate one component of `FinalPolicyBinding` without recomputing the final tuple digest. | Final-policy/admission verifier rejects. | PolicyProjection, EffectAuthorization |
| N-039 | Substitute JCS or semantically equivalent noncanonical CBOR for signed deterministic-CBOR bytes, or retry an unsupported profile, algorithm, or schema as JCS, unsigned CBOR, or an older version. | Object/profile verifier rejects the content reference, signature, canonicality, or downgrade without fallback. | CarrierIntegrity, GovernanceAuthorization |
| N-040 | Mutate an active overlay in place; inherit `PersonalActive` in a successor; use a stale, gapped, colliding, cross-series/owner, or ambiguous predecessor; root or activate two concurrent successors; select numeric latest; or promote by series name/generic dependency instead of exact source revision. | Series/lifecycle authority rejects or quarantines the revision, retains at most one release-current and active revision, reports unsupported promotion lineage where no distinguished binding exists, and leaves any prior project object unchanged. | IdentityBinding, PolicyProjection, GovernanceAuthorization |
| N-041 | Open or export a project with no supported `.pacs/carrier.cbor`; a wrong-version/type/project/noncanonical bootstrap; a non-null-field violation; a missing, extra, duplicate, or non-derived store entry; or an incomplete release/authentication closure. | Absence or an unavailable confinement primitive produces visible `CarrierUnsupported`; any present-invalid case produces `CarrierQuarantined`; the export/authority claim fails or narrows without head change. | ProjectCarrierDiscovery, CarrierIntegrity, PortableClosure |
| N-042 | Resolve a carrier locator using traversal, percent escape, backslash, absolute/device/UNC/alternate-stream syntax, special resource, case/Unicode/short-name/canonical alias, symbolic or hard link, junction/reparse/mount/cross-volume escape, or root/component/file swap race. | Stable-handle resolver returns `CarrierQuarantined`, discards staging, and leaves active state unchanged. | ProjectCarrierDiscovery, CarrierIntegrity |
| N-043 | Present a `RecoveryTransition` under project governance, at a non-higher term or nonzero sequence, against stale prior state, with mismatched closure or `SafeRecoveryRelease`, nonempty runtime capabilities, or selecting an ordinary `Release`. | Independent recovery verifier rejects and quarantines; project remains frozen or unrecoverable with no runtime activation. | GovernanceAuthorization, PortableClosure, EffectAuthorization |
| N-044 | Present conflicting RecoveryTransitions for one new term, or make the next normal HeadReceipt skip the accepted transition, use a sequence other than one, or change term. | Head selector quarantines conflicts and rejects the invalid normal transition without arrival-order selection. | GovernanceAuthorization |

| ID | Governance status | Requirement | Enforcement or validation boundary | Failure behavior |
|---|---|---|---|---|
| PACS-TEST-001 | Candidate | A positive capability claim **MUST** run every applicable negative test in Section 17 under the exact claimed profile/adapter/SUT or identify the test as outside a closed scope exclusion. | Conformance harness and claim validator. | Mark the claim `fail`, `not-run`, or narrower in scope; do not infer the missing result. |
| PACS-TEST-002 | Candidate | A negative test **MUST** assert the exact denial, quarantine, freeze, degradation, or claim-level outcome in the table and **MUST** retain the input, observer, trace, and result. | Profile-specific test oracle. | The affected claim fails when the expected boundary or outcome is absent. |
| PACS-TEST-003 | Candidate | Passing these finite vectors **MUST NOT** by itself upgrade a capability to `Enforced` or `Detected`. | Evidence review. | Report only bounded test evidence until Section 14.3 is satisfied. |

## 18. Explicit non-guarantees

This draft intentionally makes no guarantee that:

- a model understands, follows, or remembers Guidance;
- a provider performs only the observable admitted inference;
- hidden provider retry, safety processing, cache use, or compaction carries the Charter;
- cancellation stops or retracts admitted remote work;
- remote computation or effects occur exactly once;
- a disclosed output can be retracted;
- an unmediated effect is authorized or contained;
- decision-current operation stays available during authority or gateway partition;
- local state alone resists an exact clone or rollback;
- a signature proves truth, safety, freshness, or governance authority outside its verified trust policy.

These are assurance boundaries, not deferred marketing claims.

## 19. Open research and ratification HOLDs

The document is structurally complete, but implementation and final ratification remain on HOLD:

- **HOLD-WIRE-001:** stable registries/media/purposes, measured limits, trust/non-rollback, rotation,
  witness query policy, recovery ceremony/key/nonce/time/EAT profiles, cross-platform Carrier mappings,
  vectors/codecs, interoperability, and adoption of the retained Candidate wire profile;
- **HOLD-CARRIER-001:** filesystem/archive API mappings, case/device rules, archive media, limits, and
  independent discovery/confinement/export vectors for the Candidate local `ProjectCarrierProfile`;
- **HOLD-HEAD-001:** governance adoption of the Candidate normal HeadReceipt checkpoint, sequencer,
  root/authority rotation, and threshold protocol;
- **HOLD-WITNESS-001:** governance adoption of the Candidate SCITT binding, witness service/query policy,
  inclusion/consistency, gossip, split-view, and trust; the base profile defines no parallel Customs
  receipt object;
- **HOLD-PROJECTION-001:** selector, fact, lattice, capability, Guidance-slot, compiler, deviation, and error
  registries;
- **HOLD-PRIVACY-001:** scoped-principal allocation, collision, unlinkability, backup, erasure, and recovery;
- **HOLD-LIFECYCLE-001:** series allocation, concurrent successor selection, portable lifecycle and exact
  promotion-source evidence, retired-provenance handling, and a reviewed successor refinement;
- **HOLD-IAP-001:** evidence types, issuers, target dimensions, canonicalizers, trust, revocation, and
  freshness;
- **HOLD-IAP-002:** temporal monitoring and consumable evidence;
- **HOLD-ADAPTER-001:** provider envelopes, resets, hidden inference/compaction, and vendor evidence;
- **HOLD-EFFECT-001:** protected effects, target canonicalizers, approvals, output streaming, and
  destination deduplication;
- **HOLD-DISPATCH-001:** linearizable gateway transaction, crash, retry, and reconciliation profile;
- **HOLD-RECOVERY-001:** independent recovery authorities, ceremonies, thresholds, trust/non-rollback,
  credential custody, and operational witness interaction;
- **HOLD-CONFORMANCE-001:** canonical claim schema, exhaustive domains, proof review, independent
  implementations, and evidence artifacts;
- **HOLD-REGISTRY-001:** extension and profile registries;
- **HOLD-FORMAL-001:** unbounded safety/liveness proof, cryptographic and implementation refinement,
  model-to-wire/implementation correspondence, and formal coverage of physical-carrier and Custom-successor
  semantics;
- **HOLD-NAME-001:** the working name and `PACS` acronym require collision review.

The preserved formal work contains bounded runtime and lifecycle models but no preserved authority/carrier
module, and preserved commit 66d14ed records no successful parser or model-check run. Executable gate
`a2b57551863241d90bca663ee07190accfa834d2`, reconciled by
`70458fc6cc7903d6da984865c617e3f1ef5bcb38`, reports error-free SANY2 2.1 semantic processing for
`AuthorityCarrier`, `RuntimeAuthorization`, and `AgentLifecyclePrivacy`. With Microsoft OpenJDK
21.0.12+8-LTS and TLC2 2.19 (revision `5a47802`) from `tla2tools-v1.7.4.jar` (SHA-256
`936A262061C914694DFD669A543BE24573C45D5AA0FF20A8B96B23D01E050E88`), the following finite TLC
configurations completed without errors:

| Configuration | Generated states | Distinct states | Depth |
|---|---:|---:|---:|
| `AuthorityCarrier.cfg` | 289,465 | 15,792 | 20 |
| `AuthorityCarrier.adversarial.cfg` | 410 | 257 | 8 |
| `AuthorityCarrier.fork.cfg` | 5 | 5 | 2 |
| `RuntimeAuthorization.cfg` | 22,102 | 4,206 | 15 |
| `RuntimeAuthorization.targeted.cfg` | 616,169 | 141,366 | 19 |
| `AgentLifecyclePrivacy.cfg` | 2,029,281 | 321,904 | 21 |
| `AgentLifecyclePrivacy.mapping.cfg` | 1,044,801 | 114,880 | 22 |

All seven runs ended with TLC's completed/no-error result and zero queued states. Sixteen additional
harnesses—three mutation checks and thirteen reachability sentinels—also produced their intended invariant
counterexamples or traces for unauthorizing candidates, freeze/recovery, definite-False applicability,
fork identity, offline-proposal nonauthorization, cached-record replay, crash/reconciliation, downstream
currentness, identity-map erasure/ambiguity, promotion, capsule privacy, and the post-recovery normal
sequence-one parent rule. The new `AuthorityCarrier.post-recovery-reach.cfg` reached that intended sentinel
at state/depth 11 after 96,472 generated and 41,320 distinct states; those counts stop at the expected
counterexample and are not an exhaustive pass.

The corrected authority model distinguishes normal `HeadReceipt` and recovery `RecoveryTransition` kinds
and checks their bounded selector separation, safe-release restriction, and parent rule. It does not encode
the real recovery ceremony, trust store, or non-rollback implementation. The models also do not encode a
physical project root, bootstrap/path resolver, confinement/export state, overlay-series
revision/predecessor/currentness, competing successors, successor re-review, retirement, or exact
overlay-revision promotion lineage. The reported counts therefore provide no evidence for
`ProjectCarrierProfile` or immutable Custom-successor implementation claims.

These finite closed universes do not establish an unbounded, cross-implementation, cryptographic,
gateway-durability, hidden-vendor, or continuous-observation proof. External monotone head trust,
canonicalization, complete registries and mediation, and fair availability remain assumptions or Open
obligations. `HOLD-FORMAL-001` therefore remains effective, and no HOLD is closed by implementing an
arbitrary default.

## 20. Informative references

These references are Guidance and precedent, not selected wire or governance profiles:

- [RFC 2119](https://www.rfc-editor.org/rfc/rfc2119) and
  [RFC 8174](https://www.rfc-editor.org/rfc/rfc8174), requirement language.
- [RFC 5234](https://www.rfc-editor.org/rfc/rfc5234), ABNF core rules used by the presentation grammar.
- [RFC 8032](https://www.rfc-editor.org/rfc/rfc8032), Ed25519/EdDSA.
- [RFC 8785](https://www.rfc-editor.org/rfc/rfc8785), JSON Canonicalization Scheme.
- [RFC 8949](https://www.rfc-editor.org/rfc/rfc8949), CBOR and deterministic encoding.
- [RFC 8610](https://www.rfc-editor.org/rfc/rfc8610) and
  [RFC 9682](https://www.rfc-editor.org/rfc/rfc9682), CDDL and its update.
- [RFC 9052](https://www.rfc-editor.org/rfc/rfc9052) and
  [RFC 9053](https://www.rfc-editor.org/rfc/rfc9053), COSE structures and algorithms.
- [RFC 9596](https://www.rfc-editor.org/rfc/rfc9596) and
  [RFC 9597](https://www.rfc-editor.org/rfc/rfc9597), COSE header parameters and CWT claims in COSE.
- [RFC 9711](https://www.rfc-editor.org/rfc/rfc9711), Entity Attestation Token; a complete PACS mapping
  remains Open.
- [RFC 9942](https://www.rfc-editor.org/rfc/rfc9942) and
  [RFC 9943](https://www.rfc-editor.org/rfc/rfc9943), SCITT architecture and receipts for bounded
  registration/inclusion/consistency related work only.
- [The Update Framework](https://theupdateframework.io/docs/metadata/), update trust and freshness
  precedent.
- [in-toto specification](https://github.com/in-toto/docs/blob/master/in-toto-spec.md), authenticated
  layout/evidence precedent.
- [W3C DID Core privacy considerations](https://www.w3.org/TR/did-core/#privacy-considerations), scoped
  identifier correlation rationale; DID syntax is not selected.
- Saltzer and Schroeder, *The Protection of Information in Computer Systems*, complete mediation
  precedent.
- NIST SP 800-162, policy decision and enforcement-point separation.
- Schneider, *Enforceable Security Policies*, execution-monitoring limits.
- Lamport, *Proving the Correctness of Multiprocess Programs*, safety/liveness separation.
