# Portable Agentic Customs wire-format profile

Governance status: **Candidate**
Review recommendation: **RATIFY-CANDIDATE with enumerated HOLD items**
Profile identifier: `pacs-cbor-v1`
Wire-profile number: `1`
Object-schema version: `1`

This document defines the candidate portable object, content-address, signature,
closure, and transparency-receipt profile for Portable Agentic Customs (PACS).
It does not define the substantive governance policy, recovery ceremony,
runtime authorization algorithm, or the local trust anchors that decide which
signers are authoritative.

The key words **MUST**, **MUST NOT**, **REQUIRED**, **SHOULD**, **SHOULD NOT**,
and **MAY** have the RFC 2119/RFC 8174 meanings when uppercase. They are
requirements on an implementation of this candidate profile. They do not mean
that this repository already has an implementation or that the profile has
been ratified. `RATIFY-CANDIDATE` is this document's
review recommendation, not a sixth governance state alongside Ratified,
Candidate, Open, Rejected, and Empirical-only.

“Portable Agentic Customs” and “PACS” remain working names under the repository
naming policy; both have known collision risks. This document uses **PACS**
only as shorthand and makes no naming-ratification claim.

## 1. Decision summary

### 1.1 RATIFY-CANDIDATE

The following choices are sufficiently bounded to ratify as a versioned
candidate:

1. Logical PACS objects use RFC 8949 Core Deterministic Encoding CBOR, with a
   closed CDDL model written using RFC 8610 as updated by RFC 9682.
2. Every logical object carries an explicit wire profile, object type, schema
   version, and critical-extension list. Unknown body fields and unknown
   critical extensions fail closed.
3. Content identity is a domain-separated SHA-256 digest of the exact
   deterministic object or blob bytes. A reference always carries the expected
   object type as well as the content identifier.
4. Signatures use a tagged RFC 9052 `COSE_Sign1` per signer over an attached,
   typed `SigningStatement`. The initial algorithm suite is Ed25519/EdDSA.
   A threshold set is multiple independent `COSE_Sign1` envelopes over
   identical statement bytes, not a transform to or from `COSE_Sign`.
5. A `ClosureManifest` names every reachable public object and blob and every
   sealed private slot. Resolution, type checking, canonicality, hashing,
   schema checking, decryption, and exact reachability are all fail closed.
6. `HeadReceipt` is the sole normal selector for an ordinary `Release`. Its
   authority comes only from separately configured head trust plus PACS
   parent, term, sequence, release, closure, and governance checks. A
   `RecoveryTransition` is the distinct recovery-plane checkpoint: it is
   accepted only under independent fleet/kernel recovery trust and can select
   only its matching `SafeRecoveryRelease` at a strictly higher term and
   sequence zero.
7. Instead of defining a custom `WitnessReceipt`, the base profile uses an
   RFC 9943 SCITT registration of the exact signed head checkpoint with an
   RFC 9942 inclusion receipt and, when useful, an RFC 9942 consistency
   receipt. These receipts are witness evidence only.
8. `Attestation` binds a complete closed `ProtectedTarget`, its current
   authority and policy state, its evidence definition and atom, and its
   freshness challenge. A timestamp by itself is not freshness.
9. `SemanticCharter`, `VendorRequestManifest`, and `DecisionRecord` are
   content-addressed evidence of projection, rendering, and a decision. None
   is bearer authority.
10. Conformance claims are finite, dimension-specific, and evidence-backed.
    There is no aggregate “portable”, “secure”, or “conformant” bit.
11. Revision and predecessor fields are immutable structure, never
    latest-revision authority. A successor is checked against the exact base
    head and release-current series member; concurrent branches quarantine
    and no successor inherits lifecycle activation.
12. An abstract `ProjectCarrierProfile` fixes discovery, naming, confinement,
    outcomes, and export completeness. Candidate profile
    `pacs-project-fs-v1` uses a fixed project-root-relative `CarrierManifest`
    bootstrap and a closed content-addressed filesystem store. Successful
    discovery stages a candidate and conveys no authority.

### 1.2 HOLD

The following remain **HOLD** and MUST NOT be inferred from the candidate:

- final IANA media-type registrations and stable public object, purpose,
  extension, selector, schema, reason-code, and conformance registries;
- the operational head sequencer, head-key distribution and rotation, witness
  selection or quorum, anti-equivocation query policy, and availability rules;
- project-governance and independent recovery thresholds, ceremonies, key
  custody, compromise response, revocation, and trusted-time sources;
- private-overlay content-encryption-key distribution, rotation, recovery, and
  durable nonce allocation;
- a complete PACS EAT profile and mapping of every required PACS target field;
- whether the committed final policy tuple is separately materialized or named
  `PolicyImage`; profile 1 binds a digest and does not make such an artifact
  authoritative;
- portable lifecycle-transition evidence for Draft, Shadow, Trial, and
  PersonalActive; a distinguished exact-source promotion commitment; branch
  reconciliation; and recovery migration of revision state;
- universal project-root discovery, cross-platform safe filesystem resolver
  mappings, archive/container mapping, filesystem snapshot semantics, and
  stable carrier outcome/profile registries;
- temporal monitors, consumable evidence across decisions, OR/NOT/threshold/
  count/arbitrary/model-evaluated evidence predicates, and offline activation;
- empirical confirmation of the candidate resource ceilings in section 15;
- independently produced codecs, test vectors, formal refinements, and
  interoperability results.

RFC 9052, RFC 9942, RFC 9943, TUF, and the other referenced standards provide
useful encoding, signing, logging, or update-system machinery. **They do not
establish PACS project authority, select the active head, or prove that a PACS
policy or statement is true.**

## 2. Standards baseline and selection

### 2.1 Primary sources

This profile is based on:

- [RFC 2119, Key Words for Use in RFCs](https://www.rfc-editor.org/rfc/rfc2119.html)
- [RFC 8174, Ambiguity of Uppercase and Lowercase in RFC 2119 Key Words](https://www.rfc-editor.org/rfc/rfc8174.html)
- [RFC 8785, JSON Canonicalization Scheme (JCS)](https://www.rfc-editor.org/rfc/rfc8785.html)
- [RFC 8949, Concise Binary Object Representation (CBOR)](https://www.rfc-editor.org/rfc/rfc8949.html)
- [RFC 8610, Concise Data Definition Language (CDDL)](https://www.rfc-editor.org/rfc/rfc8610.html)
- [RFC 9682, Updates to the CDDL Grammar](https://www.rfc-editor.org/info/rfc9682/)
- [RFC 9052, COSE Structures and Process](https://www.rfc-editor.org/rfc/rfc9052.html)
- [RFC 9053, COSE Initial Algorithms](https://www.rfc-editor.org/rfc/rfc9053.html)
- [RFC 9596, COSE `typ` Header Parameter](https://www.rfc-editor.org/rfc/rfc9596.html)
- [RFC 9597, CWT Claims in COSE Headers](https://www.rfc-editor.org/rfc/rfc9597.html)
- [RFC 8392, CBOR Web Token (CWT)](https://www.rfc-editor.org/rfc/rfc8392.html)
- [RFC 9942, COSE Receipts](https://www.rfc-editor.org/rfc/rfc9942.html)
- [RFC 9943, SCITT Architecture](https://www.rfc-editor.org/rfc/rfc9943.html)
- [RFC 9711, Entity Attestation Token (EAT)](https://www.rfc-editor.org/rfc/rfc9711.html)
- [RFC 9334, RATS Architecture](https://www.rfc-editor.org/rfc/rfc9334.html)
- [RFC 9162, Certificate Transparency Version 2.0](https://www.rfc-editor.org/rfc/rfc9162.html)
- [RFC 8032, Edwards-Curve Digital Signature Algorithm](https://www.rfc-editor.org/rfc/rfc8032.html)
- [RFC 6234, SHA Algorithms](https://www.rfc-editor.org/rfc/rfc6234.html)
- [RFC 3986, URI Generic Syntax](https://www.rfc-editor.org/rfc/rfc3986.html)
- [RFC 4648, Base-N Encodings](https://www.rfc-editor.org/rfc/rfc4648.html)
- [RFC 6838, Media Type Specifications and Registration Procedures](https://www.rfc-editor.org/rfc/rfc6838.html)
- [The Update Framework specification](https://theupdateframework.github.io/specification/)
  and the pinned comparison target,
  [TUF v1.0.35](https://theupdateframework.github.io/specification/v1.0.35/index.html)
- [Microsoft, Naming Files, Paths, and Namespaces](https://learn.microsoft.com/en-us/windows/win32/fileio/naming-a-file)
- [Microsoft, Reparse Points](https://learn.microsoft.com/en-us/windows/win32/fileio/reparse-points)
- [Microsoft, File Streams](https://learn.microsoft.com/en-us/windows/win32/fileio/file-streams)
- [Microsoft, Hard Links and Junctions](https://learn.microsoft.com/en-us/windows/win32/fileio/hard-links-and-junctions)

RFC 8610 as updated by RFC 9682 describes data shape; it does not itself
require deterministic serialization. RFC 8949 supplies the deterministic
encoding rules. CDDL validation and deterministic-byte validation are separate
mandatory steps.

### 2.2 JCS versus deterministic CBOR/CDDL/COSE

| Question | RFC 8785 JCS | Selected RFC 8949 / CDDL / COSE profile |
|---|---|---|
| Deterministic bytes | Yes, for the JCS I-JSON subset | Yes, after the PACS restrictions below |
| Duplicate names/keys | Prohibited by I-JSON/JCS input constraints | Rejected before map construction |
| Number model | IEEE-754 binary64 JSON numbers; NaN and infinity prohibited | Integers only; floats, bignums, decimals, and rationals prohibited |
| String ordering | UTF-16 code-unit property ordering | Encoded CBOR map-key ordering |
| Unicode normalization | None; exact code points are preserved | None; exact Unicode scalar values are preserved |
| Binary values | Require an application convention such as base64url | Native byte strings |
| Schema notation | Separate JSON schema choice required | CDDL is designed for CBOR data models |
| Signature structure | Application must define it | COSE defines signature structures and protected headers |
| Compact integer labels | Awkward | Native |
| JSON ecosystem/debugging | Strong advantage | Diagnostic notation can be generated, but is not signed |

JCS is technically viable for a human-facing diagnostic or gateway format, but
it forces PACS byte strings into a text convention, inherits the binary64
number boundary, and still needs a separate signature envelope and schema
profile. The PACS object graph is dominated by digests, keys, signatures, and
bounded integer labels. Therefore `pacs-cbor-v1` selects deterministic CBOR,
CDDL, and COSE.

Transcoding between JCS and CBOR creates a new representation. A JCS digest or
signature MUST NOT be treated as a `pacs-cbor-v1` digest or signature, even if
an application believes the decoded values are equivalent.

### 2.3 TUF comparison

TUF is a useful precedent for:

- explicit roles and threshold keys;
- root-key replacement authorized by both old and new roots;
- version, expiry, rollback, freeze, mix-and-match, hash, length, and
  consistent-snapshot defenses.

PACS borrows the discipline of explicit roles, hashes, lengths, monotonic state,
and locally pinned trust. PACS does not claim TUF metadata is a substitute for
`HeadReceipt`, project governance, recovery-plane separation, applicability,
runtime authorization, or exact-target evidence. TUF expiration also does not
create a trusted clock where PACS has none.

## 3. Common data model

The following CDDL is descriptive of schema version 1. Text following the CDDL
adds constraints CDDL alone cannot express.

```cddl
pacs-object = {
  0: 1,                         ; wire profile
  1: object-type,
  2: 1,                         ; schema version
  3: [* uint],                  ; sorted, unique critical extension labels
  4: { * uint => any },         ; closed body selected by object-type
  ? 5: { * uint => any }        ; extension map
}

object-type = 1..21

cid = [1, bytes .size 32]       ; digest suite 1 = SHA-256
typed-ref = [object-type, cid]
media-type = tstr .size (3..127)
blob-ref = [
  1,                            ; blob digest suite
  media-type,
  uint,                         ; exact byte length
  bytes .size 32
]

project-identity = [
  bytes .size 32,               ; project_id
  cid                           ; GenesisDigest
]

head-ref = [8, cid] / [10, cid]
release-ref = [4, cid] / [9, cid]

key-ref = bytes .size 32
key-entry = {
  0: key-ref,
  1: -8,                        ; EdDSA
  2: bytes .size 32,            ; Ed25519 public key
  3: [+ uint]                   ; sorted, unique permitted roles
}
threshold-policy = {
  0: 1,                         ; threshold-policy version
  1: uint,                      ; threshold, 1..key count
  2: [+ key-entry],             ; sorted by key-ref
  3: uint                       ; policy epoch
}

principal-ref = [
  uint,                         ; closed principal kind
  bytes .size (16..64)          ; project-scoped opaque identifier
]

schema-id = [tstr, uint]
selector = [schema-id, blob-ref]
norm-body = [
  1..4,                         ; Guard, IAP, Guidance, Evaluation
  schema-id,
  blob-ref
]

profile-limits = {
  0: uint,                       ; ordinary object bytes
  1: uint,                       ; nesting depth
  2: uint,                       ; generic array members
  3: uint,                       ; applicable customs/overlays
  4: uint                        ; required atoms/attestations
}

policy-binding = {
  0: blob-ref,                   ; canonical PolicyBasis
  1: schema-id,                  ; compiler/canonicalizer version
  2: [* blob-ref],               ; sorted accepted DeviationGrant commitments
  3: bytes .size 32              ; FinalPolicyTupleDigest
}
```

`AgentId`, display name, email address, model-generated label, and ambient
process identity are not valid `principal-ref` kinds. A principal identifier is
project scoped. Any local mapping from a private agent identity to this opaque
identifier stays outside portable objects unless the mapping is intentionally
disclosed.

A `media-type` has exactly one `/`, no parameters, and only lowercase ASCII
letters, digits, and `!#$&^_.+-` in each nonempty component. A `schema-id`
registry name is 1 through 64 lowercase ASCII letters, digits, dots, and
hyphens. Candidate principal kinds are `1 governance actor`, `2 overlay
owner`, `3 runtime-subject pseudonym`, and `4 test/observer authority`; other
values reject in profile 1.

Each `profile-limits` value is nonzero and no greater than the corresponding
profile ceiling in section 15. It can narrow a project or charter but cannot
raise the wire-profile ceiling.

In a `threshold-policy`, the threshold is from 1 through the number of key
entries. Key references and public keys are unique, every `KeyRef` is
recomputed from its public key, entries are sorted by `KeyRef`, and each
nonempty role array is sorted and duplicate free. Threshold satisfaction
counts distinct authorized key references, not signature bytes.

`policy-binding` commits to the deviation-free `PolicyBasis`, the exact
compiler/canonicalizer, the sorted accepted deviation-grant commitments, and
the compiler's canonical final policy tuple. It does not define or require a
separately persisted authoritative `PolicyImage`. If a profile materializes a
compiled view for diagnostics, that artifact is non-authorizing and cannot
replace recomputation of label 3.
Each accepted deviation commitment must bind label 0's basis digest and its
exact rule, subject/target scope, authority, compensation, and expiry
coordinate. The final tuple digest is an output, never an input to its own
compiler or to a deviation it contains. Wall-clock expiry has no authority
effect without a separately named trusted-time profile.

## 4. Deterministic encoding rules

An encoder and decoder conform only if all of these rules hold.

1. Every logical object is one complete CBOR data item using RFC 8949 Core
   Deterministic Encoding.
2. Integers and lengths use their shortest encodings. Indefinite-length items
   are prohibited.
3. Map keys are unsigned integers and are serialized in the RFC 8949 core
   deterministic order. A decoder MUST reject any duplicate key before
   constructing a native map.
4. A received logical object MUST already be deterministic. A verifier
   re-encodes the validated data model and requires byte-for-byte equality with
   the received bytes. It does not silently canonicalize malformed bytes and
   then accept their digest or signature.
5. Floats, simple values other than `false`, `true`, and `null`, CBOR bignums,
   decimal fractions, bigfloats, arbitrary tags, and undefined are prohibited.
   Tags 18 and 16 are allowed only around the COSE objects specified in
   sections 8 and 13. No tag appears inside a `pacs-object`.
6. Security counters, terms, sequences, epochs, sizes, and counts are
   unsigned integers from 0 through `2^63-1`. Audit-only epoch times are signed
   integers from `-2^63` through `2^63-1`.
7. CBOR text must be valid UTF-8 representing Unicode scalar values; lone
   surrogate code points are invalid. No Unicode normalization is performed.
   NFC and NFD spellings that look alike remain distinct bytes and distinct
   content identities.
8. PACS-owned machine tokens, registry names, reason codes, media types, and
   URI scheme/host components admitted by a PACS canonicalizer are lowercase
   ASCII. Externally assigned opaque identifiers are exact byte strings under
   a named canonicalizer and are never implicitly folded or normalized.
   Human-facing text may contain any allowed Unicode scalar values, but it MUST
   NOT participate in identity, role, selector, or authorization matching.
9. A schema-marked set is an array sorted lexicographically by each member's
   complete deterministic CBOR encoding. Duplicate encoded members are
   rejected. An order-bearing array retains application order and MUST NOT be
   sorted.
10. The envelope map accepts only labels 0 through 5. Every body map is closed
    to the labels stated in this document. Unknown envelope or body labels are
    rejected.
11. The critical-extension array and extension-map keys are sorted and unique.
    Each critical label must be present in the extension map. An unknown
    critical label is rejected. An extension omitted from `crit` is, by
    definition, ignorable and MUST NOT alter identity, closure, applicability,
    authorization, recovery, privacy, or conformance semantics.
12. There is no profile, algorithm, schema, or media-type negotiation during
    verification. An unsupported exact identifier is a failure, not a signal
    to fall back.

## 5. Object types and media types

These numeric assignments and media strings are exact inside candidate profile
1 but remain **HOLD** for a stable public registry and IANA registration.

| Type | Object | Provisional media type |
|---:|---|---|
| 1 | `ProjectGenesis` | `application/vnd.portable-agentic-customs.project-genesis+cbor` |
| 2 | `CustomRevision` | `application/vnd.portable-agentic-customs.custom-revision+cbor` |
| 3 | `OverlayObject` | `application/vnd.portable-agentic-customs.overlay-object+cbor` |
| 4 | `Release` | `application/vnd.portable-agentic-customs.release+cbor` |
| 5 | `ClosureManifest` | `application/vnd.portable-agentic-customs.closure-manifest+cbor` |
| 6 | `CarrierManifest` | `application/vnd.portable-agentic-customs.carrier-manifest+cbor` |
| 7 | `GovernanceProposal` | `application/vnd.portable-agentic-customs.governance-proposal+cbor` |
| 8 | `HeadReceipt` | `application/vnd.portable-agentic-customs.head-receipt+cbor` |
| 9 | `SafeRecoveryRelease` | `application/vnd.portable-agentic-customs.safe-recovery-release+cbor` |
| 10 | `RecoveryTransition` | `application/vnd.portable-agentic-customs.recovery-transition+cbor` |
| 11 | `EvidenceTypeDef` | `application/vnd.portable-agentic-customs.evidence-type-def+cbor` |
| 12 | `RequirementAtom` | `application/vnd.portable-agentic-customs.requirement-atom+cbor` |
| 13 | `Attestation` | `application/vnd.portable-agentic-customs.attestation+cbor` |
| 14 | `SemanticCharter` | `application/vnd.portable-agentic-customs.semantic-charter+cbor` |
| 15 | `VendorRequestManifest` | `application/vnd.portable-agentic-customs.vendor-request-manifest+cbor` |
| 16 | `DecisionRecord` | `application/vnd.portable-agentic-customs.decision-record+cbor` |
| 17 | `ConformanceClaim` | `application/vnd.portable-agentic-customs.conformance-claim+cbor` |
| 18 | `ConformanceEvidence` | `application/vnd.portable-agentic-customs.conformance-evidence+cbor` |
| 19 | `SigningStatement` | `application/vnd.portable-agentic-customs.signing-statement+cbor` |
| 20 | `SignatureBundle` | `application/vnd.portable-agentic-customs.signature-bundle+cbor` |
| 21 | `SealedClosure` | `application/vnd.portable-agentic-customs.sealed-closure+cbor` |

The signature-envelope media type is
`application/vnd.portable-agentic-customs.signed-statement+cose`.
The encrypted private-closure media type is
`application/vnd.portable-agentic-customs.sealed-private-closure+cose`.
Its authenticated plaintext content type is
`application/vnd.portable-agentic-customs.private-closure+cbor`.
These are provisional vendor-tree names, not claims of IANA registration.
The optional transparency attachment instead uses RFC 9943's registered
`application/scitt-statement+cose` and `application/scitt-receipt+cose` outer
media types.

An HTTP, archive, or message-layer content type MUST agree with the object's
internal type. A missing, generic, or contradictory outer type never overrides
the internal type. A verifier expecting one type rejects any other type even
when the object happens to have compatible field labels.

## 6. Content addressing and domain separation

All formula literals in this section are their exact ASCII bytes. `u16be` and
`u64be` are unsigned fixed-width big-endian encodings.

For deterministic logical-object bytes `O`:

```text
ObjectDigest =
  SHA-256(
    "PACS-OBJECT-CID-V1" || 0x00 ||
    u64be(length(O)) || O
  )

ObjectCID = [1, ObjectDigest]
```

The profile, object type, schema version, critical extensions, body, and
noncritical extension bytes are all inside `O` and therefore inside the
content identity.

For blob bytes `B` with a lowercase ASCII media type `M`:

```text
BlobDigest =
  SHA-256(
    "PACS-BLOB-CID-V1" || 0x00 ||
    u16be(length(M)) || M ||
    u64be(length(B)) || B
  )

BlobRef = [1, M, length(B), BlobDigest]
```

Media-type parameters are prohibited in profile 1 blob references. Compression
and transfer encoding are not part of `B`: the carrier resolves and decodes
them first, then verifies the logical byte length and digest.

For an Ed25519 public key `K` of exactly 32 bytes:

```text
KeyRef =
  SHA-256("PACS-KEYREF-ED25519-V1" || 0x00 || K)
```

For an exact tagged COSE envelope `C` with lowercase ASCII media type `M` when
an audit object needs its transport identity:

```text
CoseEnvelopeDigest(M, C) =
  SHA-256(
    "PACS-COSE-ENVELOPE-V1" || 0x00 ||
    u16be(length(M)) || M ||
    u64be(length(C)) || C
  )
```

For deterministic `ProtectedTarget` bytes `T`:

```text
TargetDigest =
  SHA-256(
    "PACS-PROTECTED-TARGET-V1" || 0x00 ||
    u64be(length(T)) || T
  )
```

For canonical final policy-tuple bytes `Q` emitted by the exact compiler in a
`policy-binding`:

```text
FinalPolicyTupleDigest =
  SHA-256(
    "PACS-FINAL-POLICY-TUPLE-V1" || 0x00 ||
    u64be(length(Q)) || Q
  )
```

`Q` is an in-memory canonical authorization relation under the named compiler
and semantic registry. The digest binds it without requiring a separately
persisted `PolicyImage`.

For deterministic bytes `P` of a `project-identity`, the SCITT correlation
subject in section 11 uses:

```text
ProjectSubjectDigest =
  SHA-256(
    "PACS-SCITT-PROJECT-SUBJECT-V1" || 0x00 ||
    u64be(length(P)) || P
  )
```

For deterministic bytes `K` of a role-2 head `threshold-policy`:

```text
HeadKeySetDigest =
  SHA-256(
    "PACS-HEAD-KEYSET-V1" || 0x00 ||
    u64be(length(K)) || K
  )
```

These domains are deliberately disjoint. A raw SHA-256 value without its
domain and structured reference type is not a PACS content identifier.
CID equality is a computational claim under SHA-256 collision resistance, not
mathematical identity. If a store ever presents two different byte strings for
one domain-separated digest, the project is quarantined; a verifier does not
choose one by arrival order.

An optional diagnostic spelling is `pacs1:` followed by lowercase unpadded
base32 of `ObjectDigest` under RFC 4648. It is not signed and MUST round-trip
to the binary `cid`; mixed case, padding, and noncanonical spellings reject.

## 7. Exact logical objects

In every schema below, the map shown is the entire value of envelope label 4.
An omitted optional field has no default unless the text explicitly says so.

### 7.1 `ProjectGenesis` (type 1)

```cddl
project-genesis = {
  0: bytes .size 32,             ; random project_id
  1: threshold-policy,           ; initial project governance
  2: blob-ref,                   ; schema/catalog snapshot
  3: blob-ref,                   ; selector/canonicalizer catalog
  4: blob-ref,                   ; semantic registry snapshot
  5: 0,                          ; initial root_epoch
  6: profile-limits,
  7: bytes .size (16..64)        ; genesis ceremony nonce
}
```

`GenesisDigest` is this object's `ObjectCID`; it is not a self-referential body
field. `ProjectIdentity` is `[project_id, GenesisDigest]`. A consumer MUST pin
or obtain that pair through a separately trusted enrollment process. A
self-signed genesis does not bootstrap its own authority. Project objects
cannot create, replace, or weaken the independent fleet/kernel recovery trust
anchor.
The local `ProjectTrustPin` stores this exact `ProjectIdentity`; the local
`FleetTrustAnchor` is a separate trust namespace and is never selected by a
project object or locator.
Keys counted by the genesis governance threshold carry role
`1 project-governance`.
The project id is 32 uniformly random bytes from a cryptographically secure
generator, is never reused, and is not derived from a display name, key,
repository, locator, or genesis bytes.
An intentional authority fork mints a new project id and genesis; an optional
reference to the old project is provenance only and cannot create shared
authority.

### 7.2 `CustomRevision` (type 2)

```cddl
custom-revision = {
  0: project-identity,
  1: bytes .size 16,             ; custom series id
  2: uint,                       ; revision number
  3: null / [2, cid],            ; predecessor; provenance edge
  4: selector,                   ; closed applicability selector
  5: norm-body,                  ; exactly one normative body
  6: [* typed-ref],              ; sorted normative dependencies
  7: [* blob-ref]                ; sorted normative data dependencies
}
```

`norm-body` kind is exactly one of Guard `1`, IAP `2`, Guidance `3`, or
Evaluation `4`. Its registered schema and all dependencies must be in the
active closure. Unknown body kinds, schemas, selectors, or canonicalizers deny
applicability. The predecessor is lineage evidence and is not a normative
closure edge unless it is repeated in label 6.
Guard schemas only forbid or constrain and cannot encode a positive allow;
IAP schemas reference finite all-of atoms; Guidance is delivered semantic
content but model obedience is not inferred; Evaluation is empirical and
never authorizes.
Registered applicability returns exactly true, false, or unknown over an
authenticated fact snapshot. True includes the object, false excludes it, and
security-relevant unknown denies projection. Evaluation-only unknown remains
non-authorizing and cannot widen authority.

### 7.3 `OverlayObject` (type 3)

```cddl
overlay-object = {
  0: project-identity,
  1: bytes .size 16,             ; overlay series id
  2: uint,                       ; revision number
  3: null / [3, cid],            ; predecessor; provenance edge
  4: principal-ref,              ; project-scoped owner
  5: selector,
  6: norm-body,
  7: [* [2, cid]],               ; sorted base CustomRevision refs
  8: [* typed-ref],              ; sorted normative dependencies
  9: [* blob-ref]                ; sorted normative data dependencies
}
```

An overlay is portable only to the extent its owner identifier and selector
are deliberately portable. It never embeds a local private `AgentId`.
Applicability cannot expand authority: the result is intersected with the
active base policy and current grant.
Canonical array order is serialization and diagnostic order only; it is not
policy precedence. The named compiler combines applicable constraints by the
registered commutative, monotone meet and treats an exclusive-slot guidance
conflict as fatal.

#### 7.3.1 Revision, supersession, promotion, and import

Revision structure is validated against an exact accepted base state; it does
not create authority. The series keys are:

```text
CustomSeriesKey =
  (ProjectIdentity, CustomRevision.series_id)

OverlaySeriesKey =
  (ProjectIdentity, OverlayObject.owner, OverlayObject.series_id)
```

Profile 1 applies all of these rules:

1. An initial series member has revision `0` and a null predecessor. Its
   16-byte series identifier is generated uniformly at random and is not
   reused within its series-key scope.
2. A successor has the same series key and project as its predecessor, a
   nonnull predecessor reference to the exact release-current member at the
   candidate release's base head, and revision exactly one greater than that
   predecessor. Overflow rejects. An overlay successor also has the exact same
   owner `principal-ref`.
3. The public logical roots of one `Release` contain at most one
   `CustomRevision` for each `CustomSeriesKey` and at most one `OverlayObject`
   for each `OverlaySeriesKey`. That member is **release-current**. Merely
   appearing in a closure, dependency list, carrier, proposal, import, or
   predecessor field never makes a revision release-current.
4. Selecting a successor removes its predecessor from the release-current
   root set. A predecessor is provenance only unless separately repeated in a
   normative dependency field. Revision number, arrival order, filesystem
   time, Git position, and lexicographic CID order never select “latest”.
5. Two distinct successors of the same release-current predecessor are
   concurrent branches. They remain inactive candidates in quarantine until
   an authorized workflow constructs and selects one unambiguous successor.
   A release rooting both rejects. Conflicting `HeadReceipt` objects selecting
   different branches at one term/sequence invoke the section 7.8 freeze rule.
   The losing branch cannot later activate as though its predecessor were
   still current; branch merge/reconciliation semantics remain HOLD.
6. A new object does not inherit Draft, Shadow, Trial, PersonalActive, or any
   other lifecycle status from its predecessor. Those mutable workflow states
   are not fields of an immutable `CustomRevision` or `OverlayObject`.
   A successor re-enters the applicable Draft/Shadow/Trial and non-widening
   review before any lifecycle or release selection. Profile 1 can validate
   series structure and release-current uniqueness, but the portable objects,
   transition evidence, and review authority for that lifecycle remain HOLD.
7. An imported object is decoded, typed, hashed, and stored only as a
   candidate. An unknown project/base/predecessor, unavailable current member,
   series collision, owner change, revision gap, or concurrent branch produces
   quarantine. Import never renumbers, rebases, merges, or activates an object.

The current `CustomRevision` schema does **not** contain a distinguished
promotion-source field. Its predecessor can reference only another
`CustomRevision`; label 6 contains normative dependencies and MUST NOT be
overloaded as promotion provenance. Therefore profile 1 cannot verify the
abstract claim that a project-owned Custom was promoted from one exact
`OverlayObject`. Until a new closed schema, critical extension, or typed
promotion object binds that source CID and its review, a purported promotion
reports that lineage check as `Unsupported` and remains inactive/quarantined.
Content immutability does ensure that later edits to an alleged source cannot
mutate an already created project-owned CID, but that fact alone does not prove
the source lineage.

### 7.4 `Release` (type 4)

```cddl
release = {
  0: project-identity,
  1: null / head-ref,            ; exact base active head
  2: uint,                       ; authority_term
  3: uint,                       ; root_epoch
  4: 1,                          ; wire-profile number
  5: blob-ref,                   ; schema/catalog snapshot
  6: blob-ref,                   ; selector/canonicalizer catalog
  7: blob-ref,                   ; semantic registry snapshot
  8: [* typed-ref],              ; sorted public logical roots
  9: [* blob-ref],               ; sorted public blob roots
  10: [5, cid],                  ; ClosureManifest
  11: 0                          ; normal release mode
}
```

`Release` packages a candidate state; it does not activate itself. Labels 5
through 9 must exactly equal the corresponding roots in its manifest. The
release and closure are selected only by an accepted `HeadReceipt`.
The logical-root set contains the exact `[1, GenesisDigest]` once and otherwise
only types 2, 3, 11, and 12. Those are the only logical types admitted to an
active normal release closure; type 21 is admitted only through a manifest
sealed slot. Carrier, proposal, head/recovery, runtime, signature, and
conformance objects remain outside the active policy closure.
In profile 1 a normal release keeps the current authority term and root epoch;
it cannot replace project-governance or head keys. A normal dual-control root
rotation analogous to TUF, including old/new threshold rules, remains HOLD.
Root/term replacement in this candidate occurs only through the independently
authorized recovery path.

### 7.5 `ClosureManifest` (type 5)

```cddl
object-entry = [object-type, cid, uint]
sealed-slot = [
  bytes .size 16,                ; slot id
  [21, cid],                     ; SealedClosure
  uint,                          ; expected private object count
  uint                           ; expected plaintext bytes
]

closure-manifest = {
  0: project-identity,
  1: 1,                          ; closure algorithm version
  2: [* typed-ref],              ; sorted public logical roots
  3: [* blob-ref],               ; sorted public blob roots
  4: [* object-entry],           ; sorted exact public object set
  5: [* blob-ref],               ; sorted exact public blob set
  6: [* sealed-slot],            ; sorted by slot id
  7: uint,                       ; exact public object count
  8: uint,                       ; exact public blob count
  9: uint                        ; exact public logical bytes
}
```

The manifest does not include itself or its referring release in labels 4 or
5, which avoids a hash cycle. It does include each `SealedClosure` named by
label 6 in the public object set. Section 9 gives the exact closure algorithm.

### 7.6 `CarrierManifest` (type 6)

```cddl
locator = tstr .size (1..2048)
carrier-id =
  [1, typed-ref] /               ; logical PACS object
  [2, blob-ref] /                ; logical blob
  [3, bytes .size 32]            ; CoseEnvelopeDigest
carrier-entry = [
  carrier-id,
  uint,                          ; decoded logical length
  media-type,
  0,                             ; identity transfer encoding
  null,                          ; no separate transfer digest in v1
  [+ locator]                    ; ordered alternatives
]

carrier-manifest = {
  0: null / project-identity,
  1: null / release-ref,
  2: [* carrier-entry],
  3: bytes .size (16..64)        ; carrier instance nonce
}
```

`CarrierManifest` is untrusted transport and relocation metadata. Git history,
branch names, file paths, URLs, archive member names, timestamps, and carrier
signatures cannot select a head or add an object to a release.
If label 1 is nonnull, label 0 must be nonnull and the resolved release project
must match it; disagreement rejects the manifest but never affects head state.
Entries are sorted by canonical `carrier-id` and duplicate identifiers reject;
locator alternatives retain resolver preference order.
For a kind-3 entry, the identifier is recomputed from the entry's exact media
type and decoded COSE bytes using `CoseEnvelopeDigest(M, C)`.
Profile 1 carrier entries use identity transfer only. Archive or compression
layers may exist outside an entry, but the resolver removes them under local
resource limits before returning the exact logical bytes; those layers never
change an entry identifier.

Profile 1 locators are either relative RFC 3986 references or `https` URIs.
They MUST NOT contain user information, fragments, credentials, backslashes,
query components, encoded path separators, or dot-segment traversal. A
relative locator is
resolved only against an explicitly configured carrier base. Relocating or
mirroring data regenerates this manifest without changing a release,
`HeadReceipt`, logical object CID, or blob reference. The resolved bytes remain
untrusted until decoded, length checked, hashed, typed, and schema checked.

#### 7.6.1 Abstract `ProjectCarrierProfile`

A `ProjectCarrierProfile` is an implementation-profile contract, not a PACS
logical object and not an authority statement. It fixes:

1. how a host supplies one candidate project root;
2. one exact root-relative bootstrap name and byte format;
3. content-store naming and transfer decoding;
4. root-confined resolution and race checks;
5. resource ceilings and candidate staging;
6. visible missing, malformed, and success outcomes; and
7. the files an export must contain to claim that profile.

A carrier profile may make bytes discoverable; it cannot establish a
`ProjectTrustPin`, a fleet/kernel recovery anchor, an active head, freshness,
private principal mapping, grant, key, nonce state, or rollback-protected
high-water. Those are reattached and verified independently after discovery.

#### 7.6.2 Candidate filesystem profile `pacs-project-fs-v1`

This is one bounded Candidate mapping, not a universal filesystem or archive
standard.

**Root and bootstrap.** The caller supplies exactly one already-open project
root directory. The profile does not search parents, descendants, environment
variables, Git metadata, home directories, or current-working-directory
aliases to find it. The exact bootstrap locator, using `/` as its profile
separator, is:

```text
.pacs/carrier.cbor
```

That file is the exact deterministic bytes of one type-6 `CarrierManifest`;
there is no wrapper. Its project and release fields are nonnull, and its
project must match every project-scoped object it offers. The bootstrap is not
an entry in itself. A different spelling, case, normalization, profile
version, or outer type at that location rejects; no alternative bootstrap name
is searched.
The exact bootstrap name denotes filesystem discovery profile version `1`,
and its inner PACS envelope must be `(wire profile 1, object type 6, schema
version 1)`. A future incompatible filesystem profile uses a different fixed
bootstrap name; version negotiation from attacker-controlled bytes is
prohibited.

**Closed content-addressed store.** Let `d` be exactly 52 ASCII characters
matching `[a-z2-7]{52}`, the lowercase, unpadded RFC 4648 base32 spelling of a
32-byte digest. The only profile-1 entry locators are:

```text
object: .pacs/store/o/sha256/d
blob:   .pacs/store/b/sha256/d
cose:   .pacs/store/c/sha256/d
```

For an object entry, `d` encodes the `ObjectDigest` inside its `cid`; for a
blob entry it encodes `BlobDigest`; for a COSE entry it encodes the 32-byte
`CoseEnvelopeDigest`. Each `carrier-entry` has exactly one locator, and it must
equal the path derived from its `carrier-id`. Transfer encoding is identity,
decoded length and media type are exact, and no filename extension,
percent-encoding, query, fragment, backslash, colon, drive/volume prefix, or
alternate spelling is permitted. The files below `.pacs/store` are in
one-to-one correspondence with manifest entries; an extra, missing, duplicate,
case-alias, or canonical-name alias file quarantines the carrier.

**Confinement and read algorithm.** A conforming resolver:

1. pins a local identity for the already-open root and the bootstrap before
   reading any carrier bytes;
2. traverses every component relative to held directory handles/capabilities,
   never by concatenating an absolute path and reopening it;
3. requires `.pacs`, `store`, kind, and `sha256` components to be ordinary
   directories and the final component to be one ordinary regular file;
4. rejects `.`/`..`, absolute, drive-relative, UNC, NT/device-namespace,
   device-name, alternate-data-stream, special-file, socket, pipe, mount-point,
   cross-volume/device, symbolic-link, hard-link alias, junction, reparse
   point, or other name-surrogate resolution at every component;
5. requires exactly the stated ASCII name at every component and rejects
   case-fold, Unicode-normalization, short-name, or filesystem-canonical-name
   ambiguity;
6. opens the unnamed/default data stream only, holds the file handle while
   reading, enforces the declared length before allocation, reads exactly once,
   and hashes the bytes before parsing or use;
7. copies verified bytes into a private candidate staging store keyed by the
   logical reference and never reopens the carrier path for authorization; and
8. rechecks pinned root, bootstrap, directory, and file identities after the
   scan. Any replacement, rename ambiguity, root change, inconsistent
   enumeration, or unverifiable race condition quarantines the scan.

These requirements address platform path namespaces, streams, links, and
reparse behavior documented by Microsoft in the primary materials in section
2.1. They specify security properties, not particular APIs. An implementation
that lacks primitives to prove them reports the profile as unsupported; a
string-prefix or `realpath`-only check is not a conforming substitute.

After all entries are staged, the resolver locates the exact release in
`CarrierManifest` label 1 and runs the content-address and closure portions of
section 9 using only staged entries. Base-relative revision, local trust,
high-water, private mapping, and authority checks run only after their
independent state is reattached. Missing closure or offered authorization bytes
cannot be fetched by scanning ambient paths. The result is one of these visible
local outcomes:

- `CarrierUnsupported`: the exact bootstrap is absent, the caller supplied no
  root, or the host cannot implement the confinement contract. There is no
  fallback filename or recursive discovery.
- `CarrierQuarantined`: a bootstrap exists but is unreadable, noncanonical,
  malformed, unsafe, ambiguous, over limit, incomplete, wrong-project, or
  fails any length, digest, type, schema, closure, or race check.
- `CandidateStaged`: the complete offered release and closure verify as
  candidate bytes. This outcome is not activation and does not assert that an
  offered `HeadReceipt` or `RecoveryTransition` is acceptable. Objects whose
  base/series state cannot yet be checked remain in inactive import quarantine;
  absence of deliberately excluded local sidecars alone does not make the
  carrier bytes malformed.

The outcome names are Candidate diagnostic vocabulary, not stable registry
codes. A recipient separately reattaches the exact `ProjectTrustPin`, recovery
anchor, private identity mappings, private decryption keys, and rollback-
protected head state, then applies the ordinary authority rules. Copying or
moving this carrier retains `ProjectIdentity`; an intentional authority fork
creates a new project id and genesis rather than editing the bootstrap.

**Export completeness.** A directory export claiming
`pacs-project-fs-v1` MUST contain the exact bootstrap and every derived store
file named by it, including sealed ciphertext but excluding decryption keys.
The manifest must be sufficient for the complete offered release closure.
An export claiming that an offered checkpoint can be authority-validated must
also carry its complete section 9.3 authorization closure; otherwise it may
claim only candidate release transport. Export tooling MUST NOT place trust
pins, fleet anchors, high-water state, grants, session state, private
principal/`AgentId` mappings, content-encryption keys, or durable nonce state
in this profile namespace. Hidden-file omission invalidates the export claim.

An archive may transport the directory bytes, but no archive syntax or safe
extraction mapping is selected here. It first extracts into a new confined
candidate root under separately bounded rules, then the filesystem profile is
applied. Project-root discovery, POSIX/Windows API mappings, case behavior,
filesystem snapshots, network filesystems, archive formats, and atomic export
publication remain HOLD.

### 7.7 `GovernanceProposal` (type 7)

```cddl
governance-proposal = {
  0: project-identity,
  1: bytes .size 32,             ; proposal id/nonce
  2: null / head-ref,            ; exact base; null only at enrollment
  3: [4, cid],                   ; candidate normal Release
  4: [5, cid],                   ; candidate closure
  5: 1,                          ; normal-release proposal
  6: principal-ref,              ; author, not an authority proof
  7: uint,                       ; expected authority_term
  8: uint,                       ; expected next sequence
  9: bytes .size (16..64)        ; ceremony/request nonce
}
```

Offline work produces proposals only. Project endorsements sign a
`SigningStatement` whose subject is this proposal and whose base head, term,
and policy scope match it. A stale proposal is not auto-rebased, merged, or
activated; it returns to review against the new base.
The null base is legal only in the separately trusted initial-enrollment
ceremony; it is invalid after any local high-water exists.

### 7.8 `HeadReceipt` (type 8)

```cddl
head-receipt = {
  0: project-identity,
  1: uint,                       ; authority_term
  2: uint,                       ; sequence
  3: null / head-ref,            ; parent
  4: [4, cid],                   ; selected Release
  5: [5, cid],                   ; selected ClosureManifest
  6: [7, cid],                   ; GovernanceProposal
  7: [20, cid],                  ; project authorization bundle
  8: uint,                       ; root_epoch
  9: uint,                       ; flags; zero in profile 1
  ? 10: int                      ; audit issued-at, nonauthoritative
}
```

The companion head signature is a `SignatureBundle` over a
`SigningStatement` with purpose `head-select` and subject equal to this
`HeadReceipt`. The signature bundle cannot be included in the signed receipt
without a hash cycle, so the accepted checkpoint is the pair
`(HeadReceipt, head SignatureBundle)`.

`HeadReceipt` is the only object that can select an ordinary `Release` under
project governance. The separately authorized recovery-plane transition in
section 7.10 is limited to its exact `SafeRecoveryRelease`; it is not an
ordinary-release or project-governance selection path.

The minimum local, nonportable sidecar state is:

```cddl
head-trust-state = {
  0: project-identity,
  1: uint,                       ; trusted authority_term
  2: threshold-policy,           ; role 2 head-sequencer keys
  3: null / [
    head-ref,
    uint,                        ; high-water sequence
    release-ref,
    [5, cid],
    uint                         ; root_epoch
  ],
  4: uint                        ; rollback-protected local generation
}
```

This state is excluded from capsules and object CIDs. Its rollback, clone,
backup, and availability guarantees bound the head claim; local disk state
alone cannot resist an exact clone or rollback.
There is one logical ordering stream per `ProjectIdentity`. Threshold signing
may distribute a role, but it does not create mergeable concurrent heads,
offline activation, last-writer-wins resolution, or CRDT authority.

For a normal transition, acceptance requires all of:

1. project identity equals the locally pinned identity;
2. the head signing keys and threshold are authorized by the independently
   configured local head trust for this project and term;
3. parent equals the current accepted head, term is current, and sequence is
   exactly current sequence plus one;
4. proposal base, expected term/sequence, release, and closure match the
   receipt;
5. the project authorization bundle contains enough distinct authorized
   project-governance signatures over that exact proposal and base state;
6. release base, term, unchanged root epoch, and closure match;
7. closure verification succeeds completely.

The first normal head after genesis uses a locally specified initial parent
rule; that rule is **HOLD** with enrollment. Two different valid-looking
receipts for the same project, term, and sequence cause freeze/quarantine and
operator reconciliation. Arrival order, wall clock, Git position, and a
transparency timestamp do not choose a winner.
If required head trust, rollback-protected high-water, parent data, or current
head service is unavailable, profile 1 cannot claim decision-current authority
and performs no activation, inference, or effect admission.

### 7.9 `SafeRecoveryRelease` (type 9)

```cddl
safe-recovery-release = {
  0: project-identity,
  1: head-ref,                   ; last accepted/failed head
  2: uint,                       ; old authority_term
  3: uint,                       ; new authority_term
  4: uint,                       ; new root_epoch
  5: threshold-policy,           ; candidate new project governance
  6: bytes .size 32,             ; expected new head-key-set digest
  7: blob-ref,                   ; schema/catalog snapshot
  8: blob-ref,                   ; selector/canonicalizer catalog
  9: blob-ref,                   ; semantic registry snapshot
  10: [* typed-ref],             ; safe-mode public roots
  11: [* blob-ref],              ; safe-mode public blob roots
  12: [5, cid],                  ; ClosureManifest
  13: [],                        ; effective runtime capabilities: empty
  14: 1                          ; safe-recovery mode
}
```

The safe closure is restricted to genesis, schema/registry material, recovery
governance, inspection, verification, restore, and key-rotation material. It
cannot authorize model inference, secret delivery, ordinary tools, effects, or
output release. Label 6 is a ceremony expectation; a project object cannot
replace the local head-trust configuration merely by naming new keys.
Profile 1 safe logical roots contain exactly `[1, GenesisDigest]`; recovery
policy and ceremony material are blob roots under closed local recovery
schemas, not executable PACS customs.

### 7.10 `RecoveryTransition` (type 10)

```cddl
recovery-transition = {
  0: project-identity,
  1: head-ref,                   ; old parent
  2: uint,                       ; old term
  3: uint,                       ; old sequence
  4: uint,                       ; new term
  5: 0,                          ; new-term sequence zero
  6: [9, cid],                   ; SafeRecoveryRelease
  7: [5, cid],                   ; closure
  8: bytes .size 32,             ; local recovery-policy identifier
  9: [* blob-ref],               ; sorted ceremony evidence
  10: bytes .size (16..64),      ; ceremony nonce
  11: bytes .size 32             ; expected new head-key-set digest
}
```

A recovery signature bundle uses purpose `recovery-transition` and is checked
only under an independent fleet/kernel recovery anchor. Normal project
governance cannot sign itself into that role. After independent recovery-plane
acceptance, this object becomes the current head at `(new term, sequence 0)`
and selects only its exact `SafeRecoveryRelease`. This is the one non-normal
head transition in profile 1; `HeadReceipt` remains the sole selector for an
ordinary `Release` under project governance. The next normal `HeadReceipt` has
the transition as parent and sequence 1. Conflicting transitions for the same
new term quarantine.
The old parent/term/sequence must equal local high-water, the new term and root
epoch must be strictly greater than their old values, and the transition,
safe release, closure, governance policy, and expected head-key-set digest
must match exactly. Skipped numeric values are permitted only when the local
recovery ceremony explicitly selected them; greater numbers alone confer no
authority.

### 7.11 `EvidenceTypeDef` (type 11)

```cddl
freshness-profile = [
  1,                             ; decision-current challenge
  1,                             ; exactly one decision per challenge
  null,                          ; no wall-clock age claim
  [* schema-id]                  ; required freshness claims
]

evidence-type-def = {
  0: project-identity,
  1: bytes .size 16,             ; evidence type series id
  2: uint,                       ; immutable version
  3: null / [11, cid],           ; predecessor; provenance
  4: schema-id,                  ; claim schema
  5: media-type,                 ; canonical claim bytes
  6: threshold-policy,           ; exact permitted issuer keys
  7: [* uint],                   ; sorted allowed ProtectedTarget kinds
  8: schema-id,                  ; target canonicalizer
  9: freshness-profile,
  10: null / blob-ref,           ; status/revocation profile
  11: [* uint]                   ; sorted critical claim labels
}
```

Definitions are immutable objects. Updating an issuer, schema, target
canonicalizer, freshness method, or status policy creates a new definition and
requires activation in a new release. `issuedAt` is audit data, not proof that
an attestation is fresh for the current decision.
Every key in label 6 used to satisfy the threshold must carry role
`4 evidence-issuer`; other roles do not count.

Profile 1 admits only the decision-current challenge method above for a hard
authorization atom. Bounded-stability and snapshot evidence may be reported as
explicitly weaker audit/conformance modes, but they do not claim authority
currentness and require a future registered wire profile before use in an
authorizing atom.

RFC 9711 EAT MAY carry the evidence claim bytes only under a complete PACS EAT
profile that defines decoding, verification, freshness, nonce use, key
authority, and every PACS target binding. Base EAT, an EAT profile that omits a
PACS target dimension, or an EAT timestamp alone cannot replace
`EvidenceTypeDef` plus `Attestation`.

### 7.12 `RequirementAtom` (type 12)

```cddl
requirement-atom = {
  0: project-identity,
  1: bytes .size 16,             ; atom id
  2: [11, cid],                  ; EvidenceTypeDef
  4: selector,                   ; closed exact-target selector
  5: schema-id,                  ; expected-claim schema
  6: blob-ref,                   ; canonical positive expected claim
  7: freshness-profile,
  8: true                        ; complete target equality required
}
```

`RequirementAtom` has no applicability selector. Applicability is evaluated
exactly once at the enclosing `CustomRevision` or `OverlayObject`: definite
false omits that whole Custom, definite true includes its one `NormBody`, and
unknown denies projection. Once the enclosing Custom is included, every atom
referenced by its IAP `NormBody` is required and profile 1 evaluates them as a
finite AND. Label 4 constrains the exact protected target: false, unknown, or
failure means the atom is unsatisfied and denies the decision; it never skips
the atom.

Profile 1 has no atom-local applicability, OR, NOT, issuer-count,
threshold-evidence, arbitrary code, natural-language predicate, or
model-evaluated predicate. Requirements from multiple included Customs are
unioned, which can only narrow admission.
The atom freshness profile must equal the referenced definition's profile in
version 1; a future profile may define a provable “at least as strong” relation,
but an atom can never weaken its evidence definition.

### 7.13 `Attestation` (type 13)

```cddl
attestation = {
  0: project-identity,
  1: [11, cid],                  ; EvidenceTypeDef
  2: [12, cid],                  ; RequirementAtom
  3: protected-target,
  4: bytes .size 32,             ; recomputed TargetDigest
  5: schema-id,                  ; claim schema
  6: blob-ref,                   ; canonical positive claim
  7: bytes .size (16..64),       ; verifier challenge/nonce
  8: [1, [* blob-ref]],          ; decision-current freshness evidence
  9: null / blob-ref,            ; status/revocation evidence
  ? 10: int,                     ; audit issued-at
  ? 11: int                      ; audit observed-at
}
```

Its signature purpose is `attest`. The signer must satisfy the exact active
`EvidenceTypeDef`; possession of a syntactically valid key or `kid` is not
authority. Project, definition, atom, claim, target, challenge, current head,
release, closure, policy/charter, grant, request/action/artifact fields, and
freshness evidence are all covered through the attached `SigningStatement`
and its subject CID. Any mismatch, omission, unknown critical claim, revoked
issuer, replayed challenge, or unprovable freshness denies.

Profile 1 challenges and attestations are single-decision inputs. It does not
define a portable consumable-evidence balance, threshold counter, reservation,
or cross-decision consumption protocol; those remain HOLD.
The verifier generates at least 16 uniformly random challenge bytes, binds
them to the pending target and attempt, and records one-time consumption at the
guarded decision. Reuse, an unsolicited issuer nonce, or a challenge issued for
another target is not freshness.

### 7.14 `SemanticCharter` (type 14)

```cddl
semantic-charter = {
  0: project-identity,
  1: head-ref,
  2: uint,                       ; authority_term
  3: uint,                       ; head sequence
  4: release-ref,
  5: [5, cid],
  6: blob-ref,                   ; projection-profile snapshot
  7: blob-ref,                   ; authenticated fact snapshot
  8: policy-binding,
  9: principal-ref,
  10: session-binding,
  11: grant-binding,
  12: selector,                  ; request scope
  13: [* [2, cid]],              ; sorted applicable customs
  14: [* [3, cid]],              ; sorted applicable overlays
  15: blob-ref,                  ; guard/conflict projection
  16: [* capability-tuple],      ; sorted effective capabilities
  17: [* [12, cid]],             ; sorted RequirementAtoms
  18: [* [uint, blob-ref]],      ; ordered guidance slots
  19: [* typed-ref],             ; evaluation/provenance refs
  20: [* uint],                  ; sorted denial/reason codes
  21: profile-limits
}
```

The charter is the deterministic projection of authenticated facts and active
policy for a bounded request scope. It does not carry a session secret or
grant capability and cannot be presented to obtain rights. Admission binds its
CID and recomputes or verifies all security-relevant projection inputs. Every
custom, overlay, evidence atom, schema, selector, and registry input must be in
the exact selected release closure; a content-valid object from another release
is not eligible.

### 7.15 `VendorRequestManifest` (type 15)

```cddl
vendor-request-manifest = {
  0: project-identity,
  1: [14, cid],                  ; SemanticCharter
  2: schema-id,                  ; renderer profile/version
  3: blob-ref,                   ; exact CharterRendering bytes
  4: blob-ref,                   ; exact final request bytes
  5: provider-binding,
  6: [* [schema-id, blob-ref, blob-ref]], ; tool schema+implementation refs
  7: [* blob-ref],               ; ordered attachments
  8: [* [uint, blob-ref]],       ; ordered instruction channel/role bytes
  9: blob-ref,                   ; generation parameters
  10: session-binding,
  11: adapter-binding
}
```

The manifest is created after final rendering and before inference admission.
Its CID covers exact bytes, lengths, media types, tools,
attachments, instruction ordering, parameters, provider/model, account,
tenant, endpoint/region, context/cache/conversation, adapter profile,
session incarnation, and enforcer generation. The inference
`ProtectedTarget` then binds that manifest CID and is hashed separately; the
manifest does not embed `TargetDigest`, which would create a hash cycle.
Mutation or provider truncation after admission requires a new manifest and
decision. Oversize or unrecordable provider envelopes deny.

### 7.16 `DecisionRecord` (type 16)

```cddl
decision-variant =
  [1, activation-variant, null / bytes .size 32] /
  [2, inference-variant, null / blob-ref] /
  [3, effect-variant, null / blob-ref]

decision-record = {
  0: 1..3,                       ; activate, infer, effect
  1: project-identity,
  2: head-ref,
  3: uint,                       ; authority_term
  4: uint,                       ; head sequence
  5: release-ref,
  6: [5, cid],
  7: protected-target,
  8: bytes .size 32,             ; recomputed TargetDigest
  9: null / [14, cid],           ; SemanticCharter
  10: grant-binding,
  11: [* [[13, cid], [20, cid]]], ; sorted attestation+bundle pairs
  12: 1..3,                      ; allow/deny/error
  13: [* uint],                  ; sorted reason codes
  14: uint,                      ; atomic linearization/fence value
  15: [1..3, bytes .size (16..64)], ; won/already-consumed/failed
  16: decision-variant,
  17: false / true,              ; send/effect start actually crossed
  ? 18: int                      ; audit time, nonauthoritative
}
```

The closed variant repeats all kind-specific fields from the protected target
and records actual result identifiers, origin inference, operation ID,
capability tuple, destination/resource/conditions, and artifact/output digest
where relevant. A decision linearizes against the current head, policy,
grant/session incarnation, enforcer generation, and fence immediately before
the transition. Queue insertion, audit insertion, an old allow record, and
`DecisionRecord` possession do not authorize a later operation.
The discriminants in label 0, the embedded `ProtectedTarget`, and label 16
MUST agree. The final variant member is, respectively, an activation-handle
digest, an inference response/usage blob, or an effect-result blob; it is null
for denial or when disclosure policy omits result bytes. Label 9 is null for
activation and must equal the target's charter reference for inference and
effect.
Label 12 values are `1 allow`, `2 deny`, and `3 error`. Label 17 may be true
only for an allowed record whose exact-attempt CAS and guarded transition
crossed; a true value records the transition but does not authorize a retry.
The CAS result values are `1 won`, `2 already-consumed`, and `3 failed`; only
`won` can accompany label 17 true. Label 11 pairs are sorted by the canonical
encoding of the attestation reference and reject a bundle whose
`SigningStatement` does not subject that exact attestation.

### 7.17 `ConformanceClaim` (type 17)

```cddl
conformance-claim = {
  0: schema-id,                  ; PACS profile/specification revision
  1: schema-id,                  ; exact dimension
  2: blob-ref,                   ; SUT build/configuration identity
  3: blob-ref,                   ; platform/environment identity
  4: blob-ref,                   ; adapter/provider profile, if applicable
  5: 1..4,                       ; Enforced, Detected, Empirical, Unsupported
  6: selector,                   ; exact claim scope
  7: [* schema-id],              ; sorted exclusions
  8: blob-ref,                   ; boundary/TCB/observer statement
  9: blob-ref,                   ; threat and freshness profile
  10: [* [18, cid]],             ; sorted evidence refs
  11: 1..3,                     ; pass/fail/inconclusive
  12: [* uint],                  ; limitations/reason codes
  ? 13: int                      ; audit observation time
}
```

Claims are signed with purpose `conformance-claim` by an explicitly named test
or observer authority. `Enforced` requires an enforcement path that denies the
negative case before the protected transition. `Detected` requires reliable
detection but permits that the transition occurred. `Empirical` reports only
the measured configuration. `Unsupported` is explicit, not omitted.
Label 5 maps `1 Enforced`, `2 Detected`, `3 Empirical`, and `4 Unsupported`;
label 11 maps `1 pass`, `2 fail`, and `3 inconclusive`.
Label 13 is descriptive and does not establish trusted freshness.

### 7.18 `ConformanceEvidence` (type 18)

```cddl
conformance-evidence = {
  0: schema-id,                  ; dimension
  1: bytes .size 16,             ; test/run id
  2: blob-ref,                   ; procedure
  3: blob-ref,                   ; oracle
  4: [* blob-ref],               ; inputs/fixtures
  5: [* blob-ref],               ; observations/traces
  6: blob-ref,                   ; expected result
  7: blob-ref,                   ; actual result
  8: [* blob-ref],               ; tool/version/build manifests
  9: blob-ref,                   ; environment snapshot
  10: null / blob-ref,           ; redaction/disclosure manifest
  11: 1..3                      ; pass/fail/inconclusive
}
```

Evidence must remain independently inspectable at the stated disclosure level.
Redaction changes the blob and must be declared; a redaction manifest does not
prove the hidden material. No suite-wide result is inferred from one dimension.
Label 11 maps `1 pass`, `2 fail`, and `3 inconclusive`.

### 7.19 `SigningStatement` (type 19)

```cddl
signing-scope = {
  0: null / project-identity,
  1: null / uint,                ; authority_term
  2: null / head-ref,            ; exact base/current head
  3: null / typed-ref,           ; policy/definition basis
  4: uint,                       ; signer role
  5: bytes .size (16..64)        ; transaction/context nonce
}

signing-statement = {
  0: uint,                       ; closed signature-purpose value
  1: typed-ref,                  ; subject
  2: signing-scope
}
```

Candidate purpose values are: `1 governance-endorse`, `2 head-select`,
`3 recovery-transition`, `4 attest`, `5 audit-decision`,
`6 conformance-claim`, `7 carrier-provenance`, and
`8 transparency-submit`. Purpose and role registries remain HOLD. A verifier
recomputes every required scope value from the subject and current local state;
merely signing a caller-supplied scope is insufficient.

Candidate signer-role values are: `1 project-governance`, `2 head-sequencer`,
`3 independent-recovery`, `4 evidence-issuer`, `5 audit-recorder`,
`6 conformance-observer`, `7 carrier-provenance`, and
`8 transparency-submitter`. A purpose accepts only its correspondingly numbered
role in profile 1. Identical numeric values are a compact registry convention,
not permission to omit either signed field.

### 7.20 `SignatureBundle` (type 20)

```cddl
signature-member = [
  key-ref,
  bytes                          ; exact tagged COSE_Sign1 bytes
]

signature-bundle = {
  0: [19, cid],                  ; SigningStatement
  1: [+ signature-member]        ; sorted by key-ref, no duplicates
}
```

Every member has the exact same attached `SigningStatement` bytes. Threshold
counting is over distinct authorized `key-ref` values, after full signature,
role, epoch, project, term, base-head, and policy validation. Duplicate keys,
unknown keys, wrong-role keys, and extra invalid members reject the entire
bundle; they are not silently ignored.

### 7.21 `SealedClosure` (type 21)

```cddl
sealed-closure = {
  0: project-identity,
  1: bytes .size 16,             ; slot id
  2: bytes .size 32,             ; local key-slot id
  3: uint,                       ; key epoch
  4: 1,                          ; PACS encryption profile
  5: uint,                       ; exact plaintext length
  6: uint,                       ; exact private object count
  7: blob-ref                    ; exact tagged COSE_Encrypt0 bytes
}
```

Label 7 has media type
`application/vnd.portable-agentic-customs.sealed-private-closure+cose`.
Section 13 defines the ciphertext and decrypted private closure. The local key
slot and content-encryption key never enter a portable capsule.

## 8. Signature profile and coverage

### 8.1 Exact `COSE_Sign1`

Each signature member is RFC 9052 tag 18 `COSE_Sign1` with:

- attached payload: exact deterministic bytes of the referenced
  `SigningStatement`;
- protected header `1` (`alg`): integer `-8` (EdDSA);
- protected header `3` (`content type`):
  `application/vnd.portable-agentic-customs.signing-statement+cbor`;
- protected header `4` (`kid`): the 32-byte `KeyRef`;
- protected header `16` (`typ`):
  `application/vnd.portable-agentic-customs.signed-statement+cose`;
- protected header `2` (`crit`): the one-element array `[16]`;
- unprotected header: the empty map;
- external AAD: the empty byte string.

The outer COSE array, tag, lengths, protected-map serialization, and all
embedded values use the section 4 deterministic CBOR rules. The protected
header byte string contains exactly one deterministic encoding of the stated
map. The Ed25519 signature is exactly 64 bytes. A semantically equivalent but
noncanonical COSE encoding rejects before bundle hashing or threshold
counting.

All protected headers are mandatory and exact. Header labels MUST NOT occur in
both protected and unprotected maps. Unknown protected or unprotected headers
reject in profile 1. `kid` is an untrusted lookup hint/reference; authority is
established only by resolving the exact public key and role from the applicable
trusted policy. An algorithm identifier never selects a key or a role.

The signature input is the RFC 9052 `Sig_structure` for `Signature1`, including
the serialized protected headers, empty external AAD, and attached payload.
The payload's object CID binds purpose, subject, project, term, base/current
head, policy basis, role, and context nonce. The subject CID in turn binds all
subject fields. No signature covers an ambiguous decoded object, a locator, or
an implicit default.

Subject objects never contain their own signatures. Adding, removing, or
rotating a signer leaves the subject CID unchanged and changes the
`SigningStatement`/`SignatureBundle` graph as applicable. This separation
prevents self-referential hashes and keeps threshold evidence explicit.

Ed25519 keys and signatures follow RFC 8032 and the EdDSA registration in
RFC 9053. The selected variant is pure Ed25519, not Ed25519ctx or Ed25519ph;
verifiers reject noncanonical key, point, scalar, and signature encodings.
Batch verification is not part of profile 1. ES256, other curves,
prehash variants, countersignatures, detached payloads, and algorithm
negotiation require a new wire-profile suite and are HOLD.

### 8.2 Why not `COSE_Sign`

RFC 9052 gives `COSE_Sign` and `COSE_Sign1` different signature contexts; they
are not interchangeable wrappers. Independent `COSE_Sign1` envelopes allow
each signer to produce and verify the exact same object without an aggregator
rewriting a multi-signature structure. A deterministic `SignatureBundle`
orders those envelopes and counts distinct authorized keys.

### 8.3 CWT claims

RFC 9597 permits protected CWT claims in COSE headers. Base profile 1 does not
copy PACS authority fields into CWT claims, because two copies create equality
and criticality hazards. A future profile MAY use the RFC 9597 protected CWT
Claims header only if it defines exact duplicate-value equality and privacy
rules. Until then, all PACS authority scope is in the signed payload.
Section 11 is a deliberately separate SCITT attachment profile: RFC 9943
requires `iss` and `sub` in protected CWT Claims there, and section 11 fixes
their derivation. Those correlation claims do not enter PACS authority checks.

## 9. Exact public closure

### 9.1 Normative edge classes

Only schema-declared normative edges participate in release closure.

| Source | Normative edges |
|---|---|
| `CustomRevision` | label 5 body blob, label 6 object dependencies, label 7 blob dependencies, selector blob |
| `OverlayObject` | label 6 body blob, label 7 base customs, label 8 object dependencies, label 9 blob dependencies, selector blob |
| `EvidenceTypeDef` | claim schema/catalog material, target canonicalizer, status profile |
| `RequirementAtom` | evidence definition, exact-target selector, expected-claim blob |
| `SemanticCharter` if released as a fixture | every object/blob field declared in its schema |
| `ConformanceClaim` or `ConformanceEvidence` if released | every evidence/procedure/oracle/fixture/result/tool/environment blob or object reference |
| Other reachable object | every typed or blob reference its schema marks normative |

Predecessor/provenance fields are not closure edges unless repeated in an
explicit dependency list. `CarrierManifest`, locators, audit timestamps,
display strings, comments, Git identities, and signature arrival metadata are
never normative edges.

### 9.2 Verification algorithm

Given release `R`, manifest `M`, and a resolver:

1. Verify deterministic bytes, envelope, type, schema, limits, and CID for `R`
   and `M`.
2. Require `R.project == M.project`, `R.closure == ref(M)`, and exact
   set-equality between `R` labels 8/9 plus catalog labels 5/6/7 and `M` root
   labels 2/3. `SafeRecoveryRelease` uses labels 7 through 11 analogously.
3. Initialize a work queue with every public logical root and every
   `SealedClosure` in `M`, plus a blob queue with every public blob root.
4. Pop a typed object reference. Resolve bytes without trusting its locator,
   reject over-limit data, require deterministic encoding, require the exact
   expected type/profile/schema, recompute its CID, and validate its closed
   schema and project identity. Enforce the normal or safe-release type
   allowlist before following any edge. For type 1, require its body
   `project_id` and computed CID to equal the two components of the release
   project identity; for every other active object, require exact
   `project-identity` equality.
5. Require one and only one matching `object-entry` with the exact decoded byte
   length. Add every schema-declared normative object and blob edge to its
   queue. Reject a dependency with the wrong expected type.
6. Pop a blob reference. Resolve and decode transport bytes, enforce the
   declared logical length before unbounded allocation, recompute the
   domain-separated blob digest including media type and length, and require
   one and only one exact manifest blob entry. If the declaring field supplies
   a registered schema/canonicalizer, validate the blob under that exact
   version and enqueue every reference returned by its registered normative-
   edge extractor. A schema with no registered extractor declares the blob a
   leaf and may not smuggle authority references. Unknown schema/extractor
   behavior denies.
7. Maintain visited sets. Repeated identical references are processed once.
   A directed cycle in normative object edges rejects even if all individual
   digests verify; predecessor-only cycles are separately invalid lineage but
   do not force old provenance into release closure.
8. For every sealed slot, run section 13 and union its verified private
   normative closure with the effective release state.
9. At queue exhaustion, require exact equality between visited public objects
   and manifest label 4, and between visited public blobs and label 5. Reject
   missing entries, extra entries, duplicates, count mismatch, byte-total
   mismatch, unused sealed slots, or an object reachable only through an
   undeclared/unknown field.
10. Reject logical-key ambiguity: two different CIDs in one effective closure
    may not claim the same `(ProjectIdentity, custom series, revision)`,
    `(ProjectIdentity, owner, overlay series, revision)`, evidence type
    series/version, or requirement-atom id. Apply the release-current
    uniqueness and successor checks in section 7.3.1 before activation.
    Registry and selector identifiers likewise resolve to one exact versioned
    definition.

The effective state is available only if this entire algorithm succeeds.
Partial closure, “best effort” parsing, a missing optional repository, an
unknown applicability input, or a temporarily unavailable private key denies
the release. An authenticated resolver or signed carrier can improve
availability/provenance but does not relax any closure step.

### 9.3 Authorization closure around a head

Release closure is necessary but not sufficient for head authorization. An
accepted normal checkpoint also requires the `HeadReceipt`, its head
`SigningStatement` and `SignatureBundle`, the exact `GovernanceProposal`, its
project `SigningStatement` and `SignatureBundle`, the candidate `Release`, and
the `ClosureManifest`. Each reference, signature role, base head, term,
sequence, root epoch, and project identity must close without an unresolved
edge. These dynamic authority objects are not inserted into the release
manifest, avoiding a content hash cycle.

An offered recovery checkpoint analogously carries the
`RecoveryTransition`, its recovery `SigningStatement` and `SignatureBundle`,
the exact `SafeRecoveryRelease`, its `ClosureManifest`, and every ceremony
evidence blob referenced by the transition. Those portable bytes still do not
carry or replace the independently reattached fleet/kernel recovery anchor,
local recovery-policy interpretation, or rollback-protected high-water.

## 10. Protected targets

### 10.1 Common structure

```cddl
session-binding = [
  bytes .size (16..64),          ; session id
  uint,                          ; incarnation
  bytes .size 32,                ; enforcer id
  uint,                          ; enforcer generation
  uint,                          ; fence
  bytes .size 32,                ; private identity-mapping handle
  uint                           ; identity-mapping epoch
]

grant-binding = [
  bytes .size (16..64),          ; grant id
  uint,                          ; grant epoch
  bytes .size 32                 ; grant-scope digest
]

authority-binding = [
  project-identity,
  head-ref,
  uint,                          ; authority_term
  uint,                          ; head sequence
  release-ref,
  [5, cid]
]

capability-tuple = [
  schema-id,                     ; capability kind/version
  bytes,                         ; action
  bytes,                         ; resource
  bytes,                         ; destination
  bytes                          ; closed canonical conditions
]

adapter-binding = [
  schema-id,                     ; adapter profile/version
  bytes .size 32,                ; implementation/build digest
  uint                           ; adapter generation
]

provider-binding = {
  0: schema-id,                  ; envelope canonicalizer/version
  1: tstr,                       ; registered provider token
  2: bytes .size (1..256),       ; exact model/deployment id
  3: bytes .size (1..256),       ; exact account id
  4: bytes .size (1..256),       ; exact tenant/project id
  5: bytes .size (1..1024),      ; exact endpoint bytes
  6: bytes .size (1..256),       ; exact region/routing-domain id
  7: bytes .size (1..256),       ; exact context/cache-domain id
  8: bytes .size (1..256)        ; exact conversation/thread id
}

activation-variant = {
  0: bytes .size (16..64),       ; activation id
  1: uint,                       ; activation fence
  2: adapter-binding,
  3: provider-binding,
  4: [* capability-tuple],       ; sorted effective capabilities
  5: [* [12, cid]]               ; sorted required atom set
}

inference-variant = {
  0: [16, cid],                  ; accepted activation DecisionRecord
  1: bytes .size (16..64),       ; request id
  2: uint,                       ; attempt
  3: [15, cid],                  ; exact VendorRequestManifest
  4: adapter-binding,
  5: provider-binding
}

effect-variant = {
  0: [16, cid],                  ; accepted activation DecisionRecord
  1: [16, cid],                  ; origin inference DecisionRecord
  2: bytes .size 32,             ; origin inference TargetDigest
  3: bytes .size (16..64),       ; operation id
  4: capability-tuple,
  5: null / blob-ref,            ; input artifact
  6: null / blob-ref,            ; output/release artifact
  7: adapter-binding
}

target-variant =
  [1, activation-variant] /
  [2, inference-variant] /
  [3, effect-variant]

protected-target = {
  0: 1..3,                       ; activate, infer, effect
  1: authority-binding,
  2: policy-binding,
  3: principal-ref,
  4: session-binding,
  5: grant-binding,
  6: null / [14, cid],           ; null only for activate
  7: target-variant
}
```

Every field is mandatory. Label 6 MUST be null for `activate` and MUST be the
exact request `SemanticCharter` for `infer` and `effect`; this preserves the
corpus's progressive target model instead of making a request charter an
activation input. Any other inapplicable dimension uses an explicitly
registered sentinel inside its variant; implementations may not omit a field
and later infer it from ambient state. The target is re-encoded and its
`TargetDigest` recomputed before attestation or decision verification. The
discriminant in `target-variant` MUST equal protected-target label 0.

The identity-mapping handle is an opaque, randomly generated commitment issued
by the local identity authority for the exact private
`(ProjectIdentity, principal-ref, AgentId, mapping epoch)` row. It is not a raw
or unkeyed hash of `AgentId`. The private sidecar must resolve that handle
uniquely at decision time; missing, ambiguous, erased, or epoch-mismatched
mapping denies. Objects containing the handle are private runtime/audit
objects unless explicit disclosure policy says otherwise.

A `capability-tuple` is canonicalized and compared as one registered relation.
An implementation MUST NOT independently intersect action, resource,
destination, and conditions and recombine components that were never
authorized together. Unknown tuple schema or field denies.

The provider token is 1 through 64 lowercase ASCII letters, digits, dots, and
hyphens. All other provider-binding identifiers are exact opaque byte
sequences emitted by the named adapter canonicalizer. They are never
implicitly case folded, Unicode normalized, URI normalized, or decoded and
re-encoded by the PACS layer. If an upstream namespace is case-sensitive, its
canonicalizer must preserve that distinction. If a field is genuinely absent,
the selected canonicalizer defines one explicit nonempty sentinel byte
sequence; absence is never inferred from omission or an empty value.

### 10.2 Closed target variants

An activation target binds:

- activation identifier and fence;
- adapter profile, implementation digest, and enforcer generation;
- provider, model/deployment, account, tenant/project, endpoint/region,
  context/cache, and conversation scope;
- projected effective capabilities and requirement-atom set.

An inference target binds all activation dimensions plus:

- the accepted activation decision;
- request identifier and attempt;
- exact `VendorRequestManifest`, CharterRendering, final request bytes/length/
  media type, tools and implementation digests, attachments, ordered
  instruction channels, generation parameters, and adapter profile;
- exact provider/model/account/tenant/endpoint/region/context/cache/
  conversation routing for this attempt.

An effect target binds all activation authority/session/grant dimensions plus:

- the origin inference decision and origin inference target digest;
- operation identifier;
- complete canonical capability tuple;
- action, resource, destination, and conditions;
- input artifact, output artifact, or release bytes/length/media/digest as
  applicable;
- effect adapter/implementation identity and generation.

These variants are closed registered maps. Reusing an attestation after any
listed dimension changes is a target mismatch. A broad statement about a
model, machine, account, session, or tool is not an exact-target attestation.
`output.release` uses the effect variant. A strong profile buffers final bytes
and obtains a fresh exact effect decision before disclosure. Streaming cannot
retroactively retract disclosed chunks and therefore requires per-chunk
targets or an explicitly weaker claim; the final output rule remains HOLD.

### 10.3 Relevance by decision

| Dimension | Activate | Infer | Effect |
|---|:---:|:---:|:---:|
| Project, genesis, head, term/sequence, release, closure | required | required | required |
| Final policy binding | required | required | required |
| SemanticCharter | null | required | required and tied to origin |
| Principal, session/incarnation, enforcer generation/fence | required | required | required |
| Grant id, epoch, and scope digest | required | required | required |
| Adapter/provider/model/account/tenant/routing scope | required | required | effect adapter plus origin scope |
| Request id/attempt and exact VendorRequestManifest | no | required | origin inference ref |
| Rendered bytes, tools, attachments, instruction order, parameters | no | required | origin inference ref |
| Operation id and canonical capability tuple | no | no | required |
| Resource/destination/conditions and artifact/output digest | no | no | required |
| Evidence definition, atom, target digest, challenge/freshness | required for every atom of each included IAP | required for every atom of each included IAP | required for every atom of each included IAP |

## 11. Head authority versus transparency

### 11.1 SCITT profile boundary

The base profile has no custom `WitnessReceipt` type, code, schema, or content
identifier. “Witness receipt” is only an analytic label for the following
optional standards-based evidence.

After accepting checkpoint `(H, B)`, where `H` is a `HeadReceipt` and `B` is
its verified head `SignatureBundle`, the submitter constructs a
`SigningStatement` `S` with:

- purpose `8 transparency-submit`;
- subject `[20, CID(B)]`;
- scope project equal to `H.project`;
- scope term equal to `H.authority_term`;
- scope head equal to `[8, CID(H)]`;
- null policy basis;
- the `transparency-submitter` role;
- a fresh 16-to-64-byte submission nonce.

Because `B` contains the head `SigningStatement` whose subject is `H`, `S`
binds both halves of the accepted checkpoint without a hash cycle. The PACS
verifier checks that transitive link before considering witness evidence.

`S` is then the attached payload of a separate RFC 9943 SCITT Signed Statement,
a tag 18 `COSE_Sign1`. It is not a member of a profile-1 `SignatureBundle`,
because SCITT has additional mandatory headers. Its protected map is exactly:

```cddl
{
  1: -8,                         ; EdDSA
  2: [15, 16],                   ; understood critical headers
  3: "application/vnd.portable-agentic-customs.signing-statement+cbor",
  4: key-ref,                    ; submitter kid
  15: {                          ; RFC 9597 CWT Claims
    1: tstr,                     ; iss
    2: tstr                      ; sub
  },
  16: "application/scitt-statement+cose"
}
```

The unprotected map is empty at registration, external AAD is empty, and the
signature input is the RFC 9052 `Signature1` structure. The complete SCITT
Signed Statement and its protected map use section 4 deterministic encoding,
and its Ed25519 signature is exactly 64 bytes. The `iss` string is
`key1-` followed by lowercase unpadded RFC 4648 base32 of the submitter
`KeyRef`. The `sub` string is `project1-` followed by lowercase unpadded base32
of `ProjectSubjectDigest`. Neither string contains a colon, and neither is
case folded on receipt. `iss` identifies the SCITT statement issuer; it does
not grant a PACS role. `sub` deliberately correlates heads for one project and
therefore has the privacy cost described in section 14.

The transparency service applies its configured RFC 9943 registration policy
and returns an `application/scitt-receipt+cose` receipt. The PACS witness
attachment retains:

1. the exact SCITT Signed Statement bytes as registered;
2. an RFC 9942 inclusion receipt for that exact candidate entry; and
3. optionally, an RFC 9942 consistency receipt between two retained roots.

Each retained COSE item is referenced by its `CoseEnvelopeDigest`, exact byte
length, and exact registered or provisional media type and may be carried by a
`CarrierManifest` kind-3 entry. Those references are audit/availability edges,
not release-closure or authority edges. There is no PACS `WitnessReceipt` CID
that a verifier could accidentally treat as a head.

When the RFC 9942 `RFC9162_SHA256` VDS is selected, protected header label 395
is `1`; inclusion proof label `-1` contains `[tree-size, leaf-index,
inclusion-path]`, and consistency proof label `-2` follows the RFC 9942
registered structure. Proofs are carried under unprotected VDP label 396 and
the receipt signature covers the computed/supplied Merkle root as specified by
RFC 9942. RFC 9943 may attach receipt bytes under unprotected header label 394
to form a Transparent Statement; the candidate entry for proof verification is
the registered Signed Statement with its registration-time empty unprotected
map, reconstructed exactly as RFC 9942 and RFC 9943 require.

For inclusion, the verifier applies the proof to the exact candidate entry to
obtain the Merkle root, then verifies the receipt `COSE_Sign1`, its protected
CWT claims, VDS identifier, service key, and local service policy. For
consistency, it verifies the receipt signature and newer root and then the
older-to-newer path as RFC 9942 specifies. A valid signature with an invalid
proof, or a valid proof under an untrusted service key, is a failed receipt.

Receipt algorithms, transparency-service keys, CWT claims, registration-policy
versions, VDS choice, and service identity are pinned by the local PACS witness
policy. They are not negotiated from attacker-controlled input. Final service
selection and registration policy remain HOLD. PACS does not reinterpret SCITT
or RFC 9942 proof algorithms as project-governance algorithms.

### 11.2 What the receipts do and do not prove

| Evidence | Establishes | Does not establish |
|---|---|---|
| Valid PACS head signature | designated key signed exact head statement | that key is locally authorized, or that this is latest |
| Accepted `HeadReceipt` | local PACS head trust and exact parent/term/sequence/governance/closure checks passed | global publication or third-party observation |
| RFC 9942 inclusion receipt | exact statement is a member at the signed log root/tree size | statement truth, project authority, latest head, unique head |
| RFC 9942 consistency receipt | one observed log root extends another under the selected VDS | absence of a split view elsewhere, or PACS head authority |
| Multiple witness observations | evidence useful for comparing views | automatic quorum or conflict winner without PACS policy |

RFC 9943 explicitly leaves relying-party trust and policy choices to the
relying party; registration order need not be issuance order unless the
registration policy says so. A transparency service can log false, stale, or
unauthorized statements faithfully. PACS therefore verifies head authority
first and treats logging as an additional accountability signal.

Detecting equivocation requires a PACS witness policy that specifies which
transparency services or monitors to query, how to compare tree roots and
head coordinates, retention, gossip, availability, and the response to split
views. That policy remains HOLD. A receipt timestamp is audit metadata and
does not override local high-water state.

## 12. Schema evolution and confusion defenses

1. Profile number selects deterministic encoding, domains, limits, primitive
   rules, and cryptographic suite. Schema version selects the closed body for
   one object type. Neither value is negotiated.
2. A wire-profile change always changes object bytes and CIDs. A schema change
   changes the schema version even when an encoder believes the old and new
   bodies are “equivalent”.
3. Unknown normative fields cannot be placed in a noncritical extension.
   Senders requiring new semantics list the registered extension in `crit`;
   old receivers reject it.
4. `typ`, COSE content type, internal object type, expected `TypedRef` type,
   signature purpose, signer role, project identity, authority term, head,
   policy basis, and target kind are all independently checked.
5. The fixed algorithm is protected. There is no “none”, downgrade, alternate
   curve, key search across roles, or retry under another profile.
6. A signature valid in one project, term, head, purpose, role, object type, or
   target kind is invalid in another. A valid carrier-provenance signature is
   not a governance endorsement; a conformance signature is not an
   attestation; a decision record is not a capability.
7. A `kid` collision or ambiguous local key mapping is an error. A verifier
   never tries every key until one succeeds.
8. The local trust store is indexed by project identity, role, term/epoch, and
   key reference. Project and fleet/kernel recovery trust namespaces are
   disjoint.
9. A decoded value obtained through JSON, YAML, a database row, a language
   native map, or another protocol has no PACS identity until encoded under this
   exact profile. Cross-protocol “same fields” is not signature equivalence.
10. Error messages and audit views should distinguish malformed,
    noncanonical, unsupported, unresolved, unauthorized, stale, conflicting,
    and over-limit inputs without treating any of them as authorization.

## 13. Encrypted/private overlay closure

Private closure uses RFC 9052 tag 16 `COSE_Encrypt0` and RFC 9053 algorithm 3,
A256GCM, with a 256-bit content-encryption key, a unique 96-bit nonce for that
key, and a 128-bit authentication tag. A candidate implementation rotates a
key before `2^24` encryptions and MUST never approach RFC 9053's absolute
`2^32`-message ceiling. Failure to prove nonce uniqueness across crash,
rollback, clone, and restore is a sealing failure.

The verifier first resolves `SealedClosure` label 7, enforces its blob length
and media type, and verifies its domain-separated blob digest. Only then does
it parse and authenticate the tagged `COSE_Encrypt0`.

The protected header contains:

- `alg = 3`;
- content type =
  `application/vnd.portable-agentic-customs.private-closure+cbor`;
- `typ = application/vnd.portable-agentic-customs.sealed-private-closure+cose`;
- `crit = [16]`;
- `IV` = the exact 12-byte nonce.

The unprotected map is empty. External AAD is the deterministic CBOR encoding
of:

```cddl
private-aad = [
  1,                             ; encryption profile
  project-identity,
  bytes .size 16,                ; slot id
  bytes .size 32,                ; key-slot id
  uint,                          ; key epoch
  uint                           ; plaintext length
]
```

The tag, outer `COSE_Encrypt0` array, protected-map bytes, IV, ciphertext, and
lengths use section 4 deterministic encoding. A noncanonical wrapper rejects
before authenticated decryption even if an AEAD implementation would accept
its decoded fields.

The plaintext is:

```cddl
private-closure = {
  0: 1,
  1: project-identity,
  2: bytes .size 16,             ; slot id
  3: [* typed-ref],              ; sorted private object roots
  4: [* blob-ref],               ; sorted private blob roots
  5: [* [object-type, cid, uint, bytes]],
  6: [* [blob-ref, bytes]]
}
```

After successful authenticated decryption, the verifier:

1. checks AAD, project, slot, key slot/epoch, declared plaintext length, and
   private object count;
2. requires deterministic private-closure bytes;
3. verifies every embedded logical object and blob exactly as public content;
4. traverses normative private edges from private roots;
5. requires exact equality between reachable objects/blobs and labels 5/6,
   with no extra, missing, duplicated, wrong-project, or wrong-type item.

The public `ClosureManifest` exposes the `SealedClosure` CID, slot identifier,
expected plaintext length, and object count. It need not expose inner CIDs
before decryption. Re-encryption, even of identical plaintext, creates a new
`SealedClosure` CID, closure manifest, release, and head candidate.

Missing key material, failed authentication, reused/ambiguous nonce, wrong AAD,
unknown encryption profile, inner hash/type/schema failure, or incomplete
private reachability denies the entire release. Key material remains in a
local sidecar or hardware-backed store and is never inferred from a capsule.

Encryption still leaks ciphertext length, slot count, update timing, access
patterns, carrier metadata, and any statement deliberately logged to SCITT.
Padding policy, key distribution, durable nonce allocation, rotation,
multi-device recovery, recipient sets, and revocation remain HOLD. A private
deployment should log a typed head commitment rather than private statement
contents when disclosure minimization requires it.

## 14. Privacy and relocation

- Portable identity is project identity plus opaque project-scoped principals,
  not private `AgentId`, hostname, user directory, device serial, account
  email, or workspace path.
- Provider account, tenant, endpoint, conversation, artifacts, prompts,
  attestations, and conformance traces can be sensitive. Implementations SHOULD
  keep them in the minimum required disclosure domain and MAY use sealed
  closure or separately controlled audit storage.
- Content hashes are correlators and dictionary-attack oracles, not
  confidentiality. Low-entropy secret content must not be published merely
  because it is hashed.
- `kid`, issuer, subject, log tree size, receipt headers, and ciphertext length
  can leak identity or activity. RFC 9597 and RFC 9942 privacy considerations
  apply in addition to PACS-specific minimization.
- A redacted object is a different object with a different CID. A presentation
  must not claim that omitted fields remain covered unless it supplies an
  explicitly supported selective-disclosure proof profile; none is selected in
  version 1.
- A carrier may change location, archive layout, compression, mirroring, and
  transfer digest. It may not change deterministic logical bytes. Absolute
  machine paths and ambient base directories are never normative.

## 15. Resource limits

The following ceilings are part of the candidate wire behavior but remain
**HOLD pending implementation measurement**. A receiver may configure lower
local limits. Raising a limit while claiming interoperable profile 1 requires
ratification because it can alter denial behavior.
`KiB` means `2^10` bytes and `MiB` means `2^20` bytes.

| Resource | Candidate ceiling |
|---|---:|
| Ordinary logical object bytes | 1 MiB |
| `ClosureManifest` or `CarrierManifest` bytes | 8 MiB |
| Nesting depth | 32 |
| Map pairs | 128 |
| Generic array members | 4,096 |
| Manifest object or blob entries | 65,536 each |
| Carrier entries | 65,536 |
| Sealed private slots | 64 |
| Reachable logical objects | 65,536 |
| Reachable graph edges | 262,144 |
| Normative traversal path depth | 128 |
| Total verified public plus decrypted logical bytes | 512 MiB |
| Total `pacs-project-fs-v1` staged entry bytes | 512 MiB |
| Text-string bytes | 64 KiB |
| Inline byte-string bytes | 1 MiB |
| Applicable customs or overlays per charter | 4,096 |
| Required atoms/attestations per decision | 256 |
| Locator alternatives per carrier entry | 16 |

Counts and declared lengths are checked before allocation, decompression,
decryption, or recursive descent. Transfer decoders use streaming limits and
reject trailing data, concatenated members not selected by the transfer
profile, expansion beyond the declared logical length, or incomplete input.
Large content is a `BlobRef`, not an oversized inline byte string.
The manifest/carrier entry ceilings are the only profile-1 exceptions to the
generic array-member ceiling.
All count, length, and byte-total additions are checked for overflow in a
wider accumulator; overflow rejects rather than wrapping.

## 16. Negative conformance vectors

Every conforming verifier must include equivalent negative cases. Vector names
are stable candidate identifiers; exact encoded fixtures remain HOLD pending
independent implementation.

| ID | Mutation or adversarial input | Required result |
|---|---|---|
| `NEG-01-DUPKEY` | Envelope or body contains the same integer map key twice | Reject before native map construction |
| `NEG-02-NONCANON` | Long-form integer/length, indefinite item, or incorrectly ordered map | Reject; do not re-encode and accept |
| `NEG-03-UNICODE` | Replace an identifier or signed string with visually identical NFC/NFD spelling | CID/target mismatch or schema rejection; never normalize |
| `NEG-04-NUMTAG` | Float, NaN, bignum, decimal tag, undefined, or unregistered tag | Reject |
| `NEG-05-TYPECONFUSION` | Valid bytes/CID supplied under the wrong `TypedRef`, media type, COSE `typ`, content type, or signature purpose | Reject |
| `NEG-06-CRITICAL` | Unknown body label, unknown critical extension, missing listed extension, or normative field smuggled as noncritical | Reject |
| `NEG-07-CROSSSCOPE` | Replay valid signature across project, term, base head, signer role, policy, target kind, or context nonce | Reject |
| `NEG-08-STALEPROPOSAL` | Previously endorsed proposal presented after active head changes | Reject; require new review/signatures |
| `NEG-09-FORK` | Two different `HeadReceipt` objects at the same project/term/sequence | Freeze/quarantine; arrival time cannot choose |
| `NEG-10-CLOSURE` | Missing, extra, duplicate, wrong-size, wrong-type, cyclic, or unreachable manifest item | Reject entire release |
| `NEG-11-CARRIER` | Locator traversal/substitution, mirror returns different logical bytes, or Git branch points elsewhere | Reject bytes or ignore carrier authority; active head unchanged |
| `NEG-12-PRIVATE` | Missing key, modified ciphertext/tag, wrong slot/AAD/epoch, reused nonce, or bad inner CID | Reject entire release |
| `NEG-13-SCITT` | RFC 9942 inclusion receipt for a stale or unauthorized head statement | Preserve as log evidence; reject as active-head authority |
| `NEG-14-CONSISTENCY` | Valid consistency proof offered as proof that its newest root contains the latest PACS head | Reject the authority inference |
| `NEG-15-EATFRESH` | Valid EAT with `iat` but no required decision challenge or incomplete PACS target mapping | Reject the required atom |
| `NEG-16-TARGETREPLAY` | Reuse attestation after provider/account/request/tool/operation/artifact/grant/fence change | TargetDigest mismatch; reject |
| `NEG-17-TRANSCODE` | JCS object or semantically equivalent noncanonical CBOR substituted for signed PACS bytes | CID/signature mismatch or canonicality rejection |
| `NEG-18-DECISIONCAP` | Old allow `DecisionRecord` or queue entry presented as authorization for a new send/effect | Reject; perform a new atomic decision |
| `NEG-19-RENDER` | Provider truncates rendering or account/tenant/endpoint/context/parameters differ from manifest | Reject before send; new manifest required |
| `NEG-20-CONFORMANCE` | Aggregate “conformant” claim lacks exact dimension, SUT build, boundary, oracle, or retained evidence | Reject claim as malformed/unsupported |
| `NEG-21-LIMIT` | Deep nesting, huge declared count, decompression bomb, ciphertext expansion, or trailing data | Reject within configured resource bound |
| `NEG-22-DOWNGRADE` | Unsupported profile/algorithm/schema triggers retry as JCS, unsigned CBOR, or older PACS version | Reject without fallback |
| `NEG-23-OPAQUECASE` | Change case or Unicode spelling of a case-sensitive account, tenant, model, context, or conversation identifier while leaving its display spelling “equivalent” | Exact opaque bytes and TargetDigest differ; reject without folding or normalization |
| `NEG-24-IDMAP` | Private identity-mapping handle is missing, ambiguous, erased, or at a different epoch while the public principal spelling is unchanged | Reject activation/inference/effect; name or self-claim cannot repair the mapping |
| `NEG-25-ATOMSKIP` | Add removed RequirementAtom label 3, or treat a false/unknown exact-target selector as atom-local inapplicability | Reject the object or deny the decision; once its enclosing IAP is included, the atom cannot be skipped |
| `NEG-26-REVISION` | Initial revision is nonzero, successor skips a number, changes owner/series, or does not name the base release-current predecessor | Quarantine the candidate and reject any release that roots it |
| `NEG-27-BRANCH` | Two successor CIDs claim one current predecessor, or two revisions of one scoped series are rooted together | Quarantine branches/reject release; arrival order and numeric maximum cannot select |
| `NEG-28-PROMOTION` | Generic dependency or same-type predecessor is presented as proof of exact Overlay-to-Custom promotion lineage | Report lineage `Unsupported`; keep purported promotion inactive/quarantined |
| `NEG-29-BOOTSTRAP` | Filesystem bootstrap is missing, differently cased, duplicated, malformed, wrong-type, wrong-project, or incomplete | Missing produces visible `CarrierUnsupported`; any present-invalid case produces `CarrierQuarantined`; never scan for fallback |
| `NEG-30-FSESCAPE` | Derived path encounters traversal, absolute/device/UNC/drive syntax, named stream, case alias, special file, symlink, hard-link alias, junction, reparse point, mount, or cross-volume edge | `CarrierQuarantined`; do not read through the edge |
| `NEG-31-FSRACE` | Root, bootstrap, directory, or file identity changes during resolution, or verified bytes are later reopened by path | `CarrierQuarantined`; discard staging and never authorize from reopened bytes |
| `NEG-32-CARRIERAUTH` | A fully valid filesystem carrier is offered as proof that its release or checkpoint is active | At most `CandidateStaged`; require independent trust, high-water, and authority validation |

## 17. Conformance matrix

Each row is independently claimed and evidenced using `ConformanceClaim` and
`ConformanceEvidence`. “Required oracle” is the minimum negative boundary, not
an assertion that the repository already passes it.

| Dimension | Objects/evidence bound | Required oracle for `Enforced` | Maximum claim without that oracle |
|---|---|---|---|
| `CarrierIntegrity` | Bootstrap, root identity, carrier entry, confined resolver trace, staged bytes | Path/link/reparse/root-swap or transfer substitution cannot pass confinement/CID/length/type checks | `Detected` |
| `PortableClosure` | Release, ClosureManifest, sealed slots, resolver trace | Any missing/extra/wrong-type/decryption edge denies activation | `Detected` |
| `GovernanceAuthorization` | Proposal, project signature bundle, HeadReceipt, head bundle | Stale base, insufficient role threshold, or fork cannot activate | `Detected` |
| `IdentityBinding` | Project identity, principal/session/grant mappings | Cross-project/principal/session replay denies | `Detected` |
| `PrivacyProjection` | Disclosure/redaction manifest, sealed closure, carrier/log view | Forbidden private field never crosses stated boundary | `Empirical` |
| `PolicyProjection` | Active closure, fact snapshot, policy binding, charter | Unknown selector/conflict/missing fact denies; capabilities never expand | `Detected` |
| `CharterDelivery` | Charter, rendering, VendorRequestManifest, provider trace | Byte/order/truncation/provider-route mismatch denies before send | `Detected` |
| `EffectAuthorization` | Effect target, atoms/attestations, atomic decision | Changed operation/capability/artifact/grant/head denies | `Detected` |
| `EffectContainment` | Sandbox/enforcer build, effect trace, escape oracle | Unauthorized resource/destination cannot be reached | `Detected` |
| `OutputRelease` | Origin inference, output target/manifest, release decision | Output mutation or missing release decision cannot cross boundary | `Detected` |
| `SemanticEvaluation` | Evaluation schema, fixtures, oracle, observed results | Registered deterministic oracle passes all stated cases | `Empirical` |

An implementation reports `Unsupported` where it lacks the required observer
or enforcement boundary. `Detected` must not be advertised as `Enforced`.
Finite public suites must pin the profile, SUT build/configuration, adapter,
provider/model scope, threat model, environment, and retained evidence. A
matrix row does not establish any other row.

## 18. Ratification and implementation gates

Before changing the candidate to a ratified interoperable profile, the project
should require:

1. two independent deterministic encoders/decoders that agree on positive and
   negative byte vectors;
2. CDDL schemas and a separate semantic validator for every closed constraint;
3. signature, threshold, key-role, fork, closure, sealed-closure, and
   downgrade tests;
4. a published provisional registry snapshot and collision process;
5. an explicit enrollment and local trust-store specification;
6. a recovery ceremony and state machine reconciled with formal invariants;
7. a SCITT witness/query policy that never promotes log evidence to head
   authority;
8. resource-ceiling measurements under adversarial inputs;
9. privacy review covering correlators, carrier/log metadata, redaction,
   ciphertext size, and provider routing fields;
10. media-type registration strategy under RFC 6838;
11. signed conformance evidence for every claimed matrix dimension;
12. cross-platform filesystem and archive resolver tests, including path
    alias, link/reparse, device, stream, race, and incomplete-export cases;
13. a closed lifecycle-transition and exact promotion-source wire design with
    branch reconciliation and import-quarantine vectors; and
14. whole-Custom applicability vectors proving that no atom-local false or
    unknown can bypass an included IAP atom.

Until those gates close, `pacs-cbor-v1` is a concrete review and test target,
not an established industry standard and not proof that PACS project authority
has been solved.
