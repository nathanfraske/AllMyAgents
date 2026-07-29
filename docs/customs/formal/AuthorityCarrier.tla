-------------------------- MODULE AuthorityCarrier --------------------------
EXTENDS Integers, FiniteSets, TLC

\* Bounded candidate model for release authority and portable carriers.
\* Carrier manifests and GovernanceProposals are candidates only.  A release is
\* active only when the external witness has selected a HeadReceipt.  Local
\* copies, observations, and high-water values are deliberately non-authoritative.

CONSTANTS
    ProjectIds, GenesisDigests, ProposalIds, ReleaseIds, ReceiptIds,
    Sites, ClosureItems, NormativeItems, LocatorItems,
    RootKeys, FleetAnchors, Terms, Sequences,
    BaseProjectId, BaseGenesisDigest,
    InitialRootKey, InitialFleetAnchor, InitialTerm, ZeroSequence,
    NoIdentity, NoProposal, NoRelease, NoReceipt, NoRootKey,
    TrueApplicability, FalseApplicability, UnknownApplicability

IdentityUniverse == ProjectIds \X GenesisDigests
BaseIdentity == <<BaseProjectId, BaseGenesisDigest>>
RequiredClosure == NormativeItems \cup LocatorItems
ApplicabilityValues ==
    {TrueApplicability, FalseApplicability, UnknownApplicability}
ProposalKinds == {"ordinary", "forkGenesis"}
ReleaseKinds == {"ordinary", "forkGenesis", "recovery"}
RecoveryOperations == {"fetch", "inspect", "verify", "restore", "rotate"}
RuntimeOperations == {"inference", "tools", "secrets", "normalEffects"}

ProposalUniverse ==
    {<<p, i>> : p \in ProposalIds, i \in IdentityUniverse}
UseUniverse ==
    {<<s, i, q, r>> :
        s \in Sites,
        i \in IdentityUniverse,
        q \in ReceiptIds \cup {NoReceipt},
        r \in ReleaseIds}

ASSUME /\ IsFiniteSet(ProjectIds)
       /\ IsFiniteSet(GenesisDigests)
       /\ IsFiniteSet(ProposalIds)
       /\ IsFiniteSet(ReleaseIds)
       /\ IsFiniteSet(ReceiptIds)
       /\ IsFiniteSet(Sites)
       /\ IsFiniteSet(ClosureItems)
       /\ IsFiniteSet(NormativeItems)
       /\ IsFiniteSet(LocatorItems)
       /\ IsFiniteSet(RootKeys)
       /\ IsFiniteSet(FleetAnchors)
       /\ IsFiniteSet(Terms)
       /\ IsFiniteSet(Sequences)
       /\ BaseProjectId \in ProjectIds
       /\ BaseGenesisDigest \in GenesisDigests
       /\ InitialRootKey \in RootKeys
       /\ InitialFleetAnchor \in FleetAnchors
       /\ InitialTerm \in Terms
       /\ ZeroSequence \in Sequences
       /\ Terms \subseteq Nat
       /\ Sequences \subseteq Nat
       /\ InitialTerm > 0
       /\ ZeroSequence = 0
       /\ RequiredClosure \subseteq ClosureItems
       /\ NormativeItems \cap LocatorItems = {}
       /\ Cardinality(RequiredClosure) > 0
       /\ NoIdentity \notin IdentityUniverse
       /\ NoProposal \notin ProposalIds
       /\ NoRelease \notin ReleaseIds
       /\ NoReceipt \notin ReceiptIds
       /\ NoRootKey \notin RootKeys
       /\ TrueApplicability # FalseApplicability
       /\ TrueApplicability # UnknownApplicability
       /\ FalseApplicability # UnknownApplicability

VARIABLES
    witnessAvailable,
    sequencerAvailable,
    recoveryAvailable,
    knownIdentities,
    forkSource,
    authorityKey,
    proposals,
    offlineProposals,
    committedProposals,
    proposalIdentity,
    proposalBaseReceipt,
    proposalClosure,
    proposalKind,
    candidateReleases,
    sequencedReleases,
    recoveryReleases,
    releaseIdentity,
    releaseTerm,
    releaseSequence,
    releaseParent,
    releaseClosure,
    releaseKey,
    releaseProposal,
    releaseKind,
    pendingSequenced,
    pendingRecovery,
    headReceipts,
    conflictingReceipts,
    quarantinedReleases,
    receiptIdentity,
    receiptTerm,
    receiptSequence,
    receiptParent,
    receiptRelease,
    receiptClosure,
    witnessTerm,
    witnessSequence,
    acceptedHeadReceipt,
    frozen,
    freezeBase,
    fleetTrustAnchor,
    projectTrustPin,
    carrierAt,
    receiptAt,
    closureAt,
    decryptableAt,
    applicabilityAt,
    localObservedReceipt,
    localObservedSequence,
    allowedUses,
    deniedUses,
    falseResolvedUses,
    recoveryTransitions,
    recoveryOperationsPerformed,
    recoveryRuntimeOperations

vars ==
    <<witnessAvailable, sequencerAvailable, recoveryAvailable,
      knownIdentities, forkSource, authorityKey, proposals, offlineProposals,
      committedProposals, proposalIdentity, proposalBaseReceipt,
      proposalClosure, proposalKind, candidateReleases, sequencedReleases,
      recoveryReleases, releaseIdentity, releaseTerm, releaseSequence,
      releaseParent, releaseClosure, releaseKey, releaseProposal, releaseKind,
      pendingSequenced, pendingRecovery, headReceipts,
      conflictingReceipts, quarantinedReleases, receiptIdentity, receiptTerm,
      receiptSequence, receiptParent, receiptRelease, receiptClosure,
      witnessTerm, witnessSequence, acceptedHeadReceipt, frozen, freezeBase,
      fleetTrustAnchor, projectTrustPin, carrierAt, receiptAt, closureAt,
      decryptableAt, applicabilityAt, localObservedReceipt,
      localObservedSequence, allowedUses, deniedUses, falseResolvedUses,
      recoveryTransitions, recoveryOperationsPerformed,
      recoveryRuntimeOperations>>

AvailabilityVars ==
    <<witnessAvailable, sequencerAvailable, recoveryAvailable>>

IdentityVars ==
    <<knownIdentities, forkSource, authorityKey>>

ProposalVars ==
    <<proposals, offlineProposals, committedProposals, proposalIdentity,
      proposalBaseReceipt, proposalClosure, proposalKind>>

ReleaseVars ==
    <<candidateReleases, sequencedReleases, recoveryReleases,
      releaseIdentity, releaseTerm, releaseSequence, releaseParent,
      releaseClosure, releaseKey, releaseProposal, releaseKind,
      pendingSequenced, pendingRecovery>>

ReceiptVars ==
    <<headReceipts, conflictingReceipts, quarantinedReleases,
      receiptIdentity, receiptTerm, receiptSequence, receiptParent,
      receiptRelease, receiptClosure, witnessTerm, witnessSequence,
      acceptedHeadReceipt, frozen, freezeBase>>

LocalVars ==
    <<fleetTrustAnchor, projectTrustPin, carrierAt, receiptAt, closureAt,
      decryptableAt, applicabilityAt, localObservedReceipt,
      localObservedSequence, allowedUses, deniedUses, falseResolvedUses>>

RecoveryAuditVars ==
    <<recoveryTransitions, recoveryOperationsPerformed,
      recoveryRuntimeOperations>>

Init ==
    /\ witnessAvailable = TRUE
    /\ sequencerAvailable = TRUE
    /\ recoveryAvailable = TRUE
    /\ knownIdentities = {BaseIdentity}
    /\ forkSource =
        [i \in IdentityUniverse |-> NoIdentity]
    /\ authorityKey =
        [i \in IdentityUniverse |-> InitialRootKey]
    /\ proposals = {}
    /\ offlineProposals = {}
    /\ committedProposals = {}
    /\ proposalIdentity =
        [p \in ProposalIds |-> BaseIdentity]
    /\ proposalBaseReceipt =
        [p \in ProposalIds |-> NoReceipt]
    /\ proposalClosure =
        [p \in ProposalIds |-> {}]
    /\ proposalKind =
        [p \in ProposalIds |-> "ordinary"]
    /\ candidateReleases = {}
    /\ sequencedReleases = {}
    /\ recoveryReleases = {}
    /\ releaseIdentity =
        [r \in ReleaseIds |-> BaseIdentity]
    /\ releaseTerm =
        [r \in ReleaseIds |-> InitialTerm]
    /\ releaseSequence =
        [r \in ReleaseIds |-> ZeroSequence]
    /\ releaseParent =
        [r \in ReleaseIds |-> NoRelease]
    /\ releaseClosure =
        [r \in ReleaseIds |-> {}]
    /\ releaseKey =
        [r \in ReleaseIds |-> NoRootKey]
    /\ releaseProposal =
        [r \in ReleaseIds |-> NoProposal]
    /\ releaseKind =
        [r \in ReleaseIds |-> "ordinary"]
    /\ pendingSequenced =
        [i \in IdentityUniverse |-> NoRelease]
    /\ pendingRecovery =
        [i \in IdentityUniverse |-> NoRelease]
    /\ headReceipts = {}
    /\ conflictingReceipts = {}
    /\ quarantinedReleases = {}
    /\ receiptIdentity =
        [q \in ReceiptIds |-> BaseIdentity]
    /\ receiptTerm =
        [q \in ReceiptIds |-> InitialTerm]
    /\ receiptSequence =
        [q \in ReceiptIds |-> ZeroSequence]
    /\ receiptParent =
        [q \in ReceiptIds |-> NoRelease]
    /\ receiptRelease =
        [q \in ReceiptIds |-> NoRelease]
    /\ receiptClosure =
        [q \in ReceiptIds |-> {}]
    /\ witnessTerm =
        [i \in IdentityUniverse |-> InitialTerm]
    /\ witnessSequence =
        [i \in IdentityUniverse |-> ZeroSequence]
    /\ acceptedHeadReceipt =
        [i \in IdentityUniverse |-> NoReceipt]
    /\ frozen = {}
    /\ freezeBase =
        [i \in IdentityUniverse |-> NoRelease]
    /\ fleetTrustAnchor =
        [s \in Sites |-> InitialFleetAnchor]
    /\ projectTrustPin =
        [s \in Sites |->
            [i \in IdentityUniverse |-> InitialRootKey]]
    /\ carrierAt = [s \in Sites |-> {}]
    /\ receiptAt = [s \in Sites |-> {}]
    /\ closureAt = [s \in Sites |-> {}]
    /\ decryptableAt = [s \in Sites |-> {}]
    /\ applicabilityAt =
        [s \in Sites |->
            [item \in NormativeItems |-> UnknownApplicability]]
    /\ localObservedReceipt =
        [s \in Sites |->
            [i \in IdentityUniverse |-> NoReceipt]]
    /\ localObservedSequence =
        [s \in Sites |->
            [i \in IdentityUniverse |-> ZeroSequence]]
    /\ allowedUses = {}
    /\ deniedUses = {}
    /\ falseResolvedUses = {}
    /\ recoveryTransitions = {}
    /\ recoveryOperationsPerformed = {}
    /\ recoveryRuntimeOperations = {}

SelectedReceipt(i) == acceptedHeadReceipt[i]

SelectedRelease(i) ==
    IF i \in frozen \/ SelectedReceipt(i) = NoReceipt
        THEN NoRelease
        ELSE receiptRelease[SelectedReceipt(i)]

ClosureComplete(r) ==
    /\ r \in candidateReleases
    /\ RequiredClosure \subseteq releaseClosure[r]

ReceiptBindsRelease(q) ==
    LET r == receiptRelease[q]
    IN  /\ q \in headReceipts
        /\ r \in candidateReleases
        /\ receiptIdentity[q] = releaseIdentity[r]
        /\ receiptTerm[q] = releaseTerm[r]
        /\ receiptSequence[q] = releaseSequence[r]
        /\ receiptParent[q] = releaseParent[r]
        /\ receiptClosure[q] = releaseClosure[r]
        /\ ClosureComplete(r)

SiteTrustsReceipt(s, q) ==
    LET r == receiptRelease[q]
        i == receiptIdentity[q]
    IN  /\ q \in headReceipts
        /\ r \in candidateReleases
        /\ fleetTrustAnchor[s] = InitialFleetAnchor
        /\ projectTrustPin[s][i] = releaseKey[r]

ApplicabilityResolvedAt(s, r) ==
    \A item \in NormativeItems \cap releaseClosure[r] :
        applicabilityAt[s][item] # UnknownApplicability

SiteHasCompleteClosure(s, r) ==
    /\ releaseClosure[r] \subseteq closureAt[s]
    /\ releaseClosure[r] \subseteq decryptableAt[s]
    /\ ApplicabilityResolvedAt(s, r)

CanUseAt(s, i) ==
    LET q == SelectedReceipt(i)
        r == SelectedRelease(i)
    IN  /\ i \in knownIdentities
        /\ i \notin frozen
        /\ q # NoReceipt
        /\ r # NoRelease
        /\ q \in receiptAt[s]
        /\ r \in carrierAt[s]
        /\ localObservedReceipt[s][i] = q
        /\ ReceiptBindsRelease(q)
        /\ SiteTrustsReceipt(s, q)
        /\ SiteHasCompleteClosure(s, r)

AuthorGovernanceProposal(p, i, closure) ==
    /\ p \in ProposalIds \ proposals
    /\ i \in knownIdentities
    /\ closure \subseteq ClosureItems
    /\ proposals' = proposals \cup {p}
    /\ offlineProposals' =
        IF witnessAvailable
            THEN offlineProposals
            ELSE offlineProposals \cup {p}
    /\ proposalIdentity' =
        [proposalIdentity EXCEPT ![p] = i]
    /\ proposalBaseReceipt' =
        [proposalBaseReceipt EXCEPT ![p] = acceptedHeadReceipt[i]]
    /\ proposalClosure' =
        [proposalClosure EXCEPT ![p] = closure]
    /\ proposalKind' =
        [proposalKind EXCEPT ![p] = "ordinary"]
    /\ UNCHANGED <<AvailabilityVars, IdentityVars, committedProposals,
                   ReleaseVars, ReceiptVars, LocalVars, RecoveryAuditVars>>

IntentionalFork(p, sourceIdentity, newIdentity, closure) ==
    /\ p \in ProposalIds \ proposals
    /\ sourceIdentity \in knownIdentities
    /\ newIdentity \in IdentityUniverse \ knownIdentities
    /\ newIdentity # sourceIdentity
    /\ closure \subseteq ClosureItems
    /\ knownIdentities' = knownIdentities \cup {newIdentity}
    /\ forkSource' =
        [forkSource EXCEPT ![newIdentity] = sourceIdentity]
    /\ authorityKey' =
        [authorityKey EXCEPT ![newIdentity] = InitialRootKey]
    /\ proposals' = proposals \cup {p}
    /\ offlineProposals' =
        IF witnessAvailable
            THEN offlineProposals
            ELSE offlineProposals \cup {p}
    /\ proposalIdentity' =
        [proposalIdentity EXCEPT ![p] = newIdentity]
    /\ proposalBaseReceipt' =
        [proposalBaseReceipt EXCEPT ![p] = NoReceipt]
    /\ proposalClosure' =
        [proposalClosure EXCEPT ![p] = closure]
    /\ proposalKind' =
        [proposalKind EXCEPT ![p] = "forkGenesis"]
    /\ UNCHANGED <<AvailabilityVars, committedProposals, ReleaseVars,
                   ReceiptVars, LocalVars, RecoveryAuditVars>>

SequencerCommit(p, r, nextSequence) ==
    /\ sequencerAvailable
    /\ witnessAvailable
    /\ p \in proposals \ committedProposals
    /\ LET i == proposalIdentity[p]
       IN  /\ i \in knownIdentities
           /\ i \notin frozen
           /\ proposalBaseReceipt[p] = acceptedHeadReceipt[i]
           /\ RequiredClosure \subseteq proposalClosure[p]
           /\ pendingSequenced[i] = NoRelease
           /\ pendingRecovery[i] = NoRelease
           /\ r \in ReleaseIds \ candidateReleases
           /\ nextSequence \in Sequences
           /\ nextSequence = witnessSequence[i] + 1
           /\ candidateReleases' = candidateReleases \cup {r}
           /\ sequencedReleases' = sequencedReleases \cup {r}
           /\ releaseIdentity' =
                [releaseIdentity EXCEPT ![r] = i]
           /\ releaseTerm' =
                [releaseTerm EXCEPT ![r] = witnessTerm[i]]
           /\ releaseSequence' =
                [releaseSequence EXCEPT ![r] = nextSequence]
           /\ releaseParent' =
                [releaseParent EXCEPT ![r] = SelectedRelease(i)]
           /\ releaseClosure' =
                [releaseClosure EXCEPT ![r] = proposalClosure[p]]
           /\ releaseKey' =
                [releaseKey EXCEPT ![r] = authorityKey[i]]
           /\ releaseProposal' =
                [releaseProposal EXCEPT ![r] = p]
           /\ releaseKind' =
                [releaseKind EXCEPT ![r] = proposalKind[p]]
           /\ pendingSequenced' =
                [pendingSequenced EXCEPT ![i] = r]
           /\ committedProposals' = committedProposals \cup {p}
    /\ UNCHANGED <<AvailabilityVars, IdentityVars, proposals,
                   offlineProposals, proposalIdentity, proposalBaseReceipt,
                   proposalClosure, proposalKind, recoveryReleases,
                   pendingRecovery, ReceiptVars, LocalVars,
                   RecoveryAuditVars>>

SequenceFor(i) ==
    \E p \in ProposalIds, r \in ReleaseIds, n \in Sequences :
        /\ proposalIdentity[p] = i
        /\ SequencerCommit(p, r, n)

AcceptHeadReceipt(i, q) ==
    /\ witnessAvailable
    /\ i \in knownIdentities
    /\ i \notin frozen
    /\ LET r == pendingSequenced[i]
       IN  /\ r \in sequencedReleases
           /\ q \in ReceiptIds \ headReceipts
           /\ releaseTerm[r] = witnessTerm[i]
           /\ releaseSequence[r] = witnessSequence[i] + 1
           /\ releaseParent[r] = SelectedRelease(i)
           /\ ClosureComplete(r)
           /\ headReceipts' = headReceipts \cup {q}
           /\ receiptIdentity' =
                [receiptIdentity EXCEPT ![q] = i]
           /\ receiptTerm' =
                [receiptTerm EXCEPT ![q] = releaseTerm[r]]
           /\ receiptSequence' =
                [receiptSequence EXCEPT ![q] = releaseSequence[r]]
           /\ receiptParent' =
                [receiptParent EXCEPT ![q] = releaseParent[r]]
           /\ receiptRelease' =
                [receiptRelease EXCEPT ![q] = r]
           /\ receiptClosure' =
                [receiptClosure EXCEPT ![q] = releaseClosure[r]]
           /\ witnessSequence' =
                [witnessSequence EXCEPT ![i] = releaseSequence[r]]
           /\ acceptedHeadReceipt' =
                [acceptedHeadReceipt EXCEPT ![i] = q]
           /\ pendingSequenced' =
                [pendingSequenced EXCEPT ![i] = NoRelease]
    /\ UNCHANGED <<AvailabilityVars, IdentityVars, ProposalVars,
                   candidateReleases, sequencedReleases, recoveryReleases,
                   releaseIdentity, releaseTerm, releaseSequence,
                   releaseParent, releaseClosure, releaseKey,
                   releaseProposal, releaseKind, pendingRecovery,
                   conflictingReceipts, quarantinedReleases, witnessTerm,
                   frozen, freezeBase, LocalVars, RecoveryAuditVars>>

HeadReceiptFor(i) ==
    \E q \in ReceiptIds : AcceptHeadReceipt(i, q)

StageSameSlotCandidate(i, r, closure) ==
    /\ i \in knownIdentities
    /\ acceptedHeadReceipt[i] # NoReceipt
    /\ r \in ReleaseIds \ candidateReleases
    /\ closure \subseteq ClosureItems
    /\ RequiredClosure \subseteq closure
    /\ LET selected == acceptedHeadReceipt[i]
       IN  /\ candidateReleases' = candidateReleases \cup {r}
           /\ releaseIdentity' =
                [releaseIdentity EXCEPT ![r] = i]
           /\ releaseTerm' =
                [releaseTerm EXCEPT ![r] = receiptTerm[selected]]
           /\ releaseSequence' =
                [releaseSequence EXCEPT ![r] = receiptSequence[selected]]
           /\ releaseParent' =
                [releaseParent EXCEPT ![r] = receiptParent[selected]]
           /\ releaseClosure' =
                [releaseClosure EXCEPT ![r] = closure]
           /\ releaseKey' =
                [releaseKey EXCEPT ![r] = authorityKey[i]]
           /\ releaseProposal' =
                [releaseProposal EXCEPT ![r] = NoProposal]
           /\ releaseKind' =
                [releaseKind EXCEPT ![r] = "ordinary"]
    /\ UNCHANGED <<AvailabilityVars, IdentityVars, ProposalVars,
                   sequencedReleases, recoveryReleases, pendingSequenced,
                   pendingRecovery, ReceiptVars, LocalVars,
                   RecoveryAuditVars>>

PublishConflictingReceipt(i, r, q) ==
    /\ witnessAvailable
    /\ i \in knownIdentities
    /\ acceptedHeadReceipt[i] # NoReceipt
    /\ r \in candidateReleases
    /\ q \in ReceiptIds \ headReceipts
    /\ LET selected == acceptedHeadReceipt[i]
       IN  /\ r # receiptRelease[selected]
           /\ releaseIdentity[r] = i
           /\ releaseTerm[r] = receiptTerm[selected]
           /\ releaseSequence[r] = receiptSequence[selected]
           /\ releaseParent[r] = receiptParent[selected]
           /\ ClosureComplete(r)
           /\ headReceipts' = headReceipts \cup {q}
           /\ conflictingReceipts' =
                conflictingReceipts \cup {selected, q}
           /\ quarantinedReleases' =
                quarantinedReleases \cup
                    {receiptRelease[selected], r}
           /\ receiptIdentity' =
                [receiptIdentity EXCEPT ![q] = i]
           /\ receiptTerm' =
                [receiptTerm EXCEPT ![q] = releaseTerm[r]]
           /\ receiptSequence' =
                [receiptSequence EXCEPT ![q] = releaseSequence[r]]
           /\ receiptParent' =
                [receiptParent EXCEPT ![q] = releaseParent[r]]
           /\ receiptRelease' =
                [receiptRelease EXCEPT ![q] = r]
           /\ receiptClosure' =
                [receiptClosure EXCEPT ![q] = releaseClosure[r]]
           /\ frozen' = frozen \cup {i}
           /\ freezeBase' =
                [freezeBase EXCEPT ![i] = receiptParent[selected]]
    /\ UNCHANGED <<AvailabilityVars, IdentityVars, ProposalVars, ReleaseVars,
                   witnessTerm, witnessSequence, acceptedHeadReceipt,
                   LocalVars, RecoveryAuditVars>>

SafeRecoveryRelease(i, r, newTerm, newKey, closure) ==
    /\ recoveryAvailable
    /\ i \in knownIdentities
    /\ i \in frozen
    /\ pendingRecovery[i] = NoRelease
    /\ pendingSequenced[i] = NoRelease
    /\ r \in ReleaseIds \ candidateReleases
    /\ newTerm \in Terms
    /\ newTerm = witnessTerm[i] + 1
    /\ newKey \in RootKeys
    /\ newKey # authorityKey[i]
    /\ closure \subseteq ClosureItems
    /\ RequiredClosure \subseteq closure
    /\ candidateReleases' = candidateReleases \cup {r}
    /\ recoveryReleases' = recoveryReleases \cup {r}
    /\ releaseIdentity' =
        [releaseIdentity EXCEPT ![r] = i]
    /\ releaseTerm' =
        [releaseTerm EXCEPT ![r] = newTerm]
    /\ releaseSequence' =
        [releaseSequence EXCEPT ![r] = ZeroSequence + 1]
    /\ releaseParent' =
        [releaseParent EXCEPT
            ![r] = IF i \in frozen
                    THEN freezeBase[i]
                    ELSE SelectedRelease(i)]
    /\ releaseClosure' =
        [releaseClosure EXCEPT ![r] = closure]
    /\ releaseKey' =
        [releaseKey EXCEPT ![r] = newKey]
    /\ releaseProposal' =
        [releaseProposal EXCEPT ![r] = NoProposal]
    /\ releaseKind' =
        [releaseKind EXCEPT ![r] = "recovery"]
    /\ pendingRecovery' =
        [pendingRecovery EXCEPT ![i] = r]
    /\ recoveryOperationsPerformed' =
        recoveryOperationsPerformed \cup RecoveryOperations
    /\ UNCHANGED <<AvailabilityVars, IdentityVars, ProposalVars,
                   sequencedReleases, pendingSequenced, ReceiptVars,
                   LocalVars, recoveryTransitions,
                   recoveryRuntimeOperations>>

RecoveryTransition(i, q) ==
    /\ recoveryAvailable
    /\ witnessAvailable
    /\ i \in knownIdentities
    /\ LET r == pendingRecovery[i]
       IN  /\ r \in recoveryReleases
           /\ q \in ReceiptIds \ headReceipts
           /\ releaseTerm[r] = witnessTerm[i] + 1
           /\ releaseSequence[r] = ZeroSequence + 1
           /\ ClosureComplete(r)
           /\ headReceipts' = headReceipts \cup {q}
           /\ receiptIdentity' =
                [receiptIdentity EXCEPT ![q] = i]
           /\ receiptTerm' =
                [receiptTerm EXCEPT ![q] = releaseTerm[r]]
           /\ receiptSequence' =
                [receiptSequence EXCEPT ![q] = releaseSequence[r]]
           /\ receiptParent' =
                [receiptParent EXCEPT ![q] = releaseParent[r]]
           /\ receiptRelease' =
                [receiptRelease EXCEPT ![q] = r]
           /\ receiptClosure' =
                [receiptClosure EXCEPT ![q] = releaseClosure[r]]
           /\ witnessTerm' =
                [witnessTerm EXCEPT ![i] = releaseTerm[r]]
           /\ witnessSequence' =
                [witnessSequence EXCEPT ![i] = releaseSequence[r]]
           /\ acceptedHeadReceipt' =
                [acceptedHeadReceipt EXCEPT ![i] = q]
           /\ frozen' = frozen \ {i}
           /\ authorityKey' =
                [authorityKey EXCEPT ![i] = releaseKey[r]]
           /\ pendingRecovery' =
                [pendingRecovery EXCEPT ![i] = NoRelease]
           /\ recoveryTransitions' = recoveryTransitions \cup {q}
    /\ UNCHANGED <<AvailabilityVars, knownIdentities, forkSource,
                   ProposalVars, candidateReleases, sequencedReleases,
                   recoveryReleases, releaseIdentity, releaseTerm,
                   releaseSequence, releaseParent, releaseClosure, releaseKey,
                   releaseProposal, releaseKind, pendingSequenced,
                   conflictingReceipts, quarantinedReleases, freezeBase,
                   LocalVars, recoveryOperationsPerformed,
                   recoveryRuntimeOperations>>

RecoveryFor(i) ==
    \E q \in ReceiptIds : RecoveryTransition(i, q)

ImportCarrier(s, r) ==
    /\ s \in Sites
    /\ r \in candidateReleases
    /\ r \notin carrierAt[s]
    /\ carrierAt' = [carrierAt EXCEPT ![s] = @ \cup {r}]
    /\ UNCHANGED <<AvailabilityVars, IdentityVars, ProposalVars, ReleaseVars,
                   ReceiptVars, fleetTrustAnchor, projectTrustPin, receiptAt,
                   closureAt, decryptableAt, applicabilityAt,
                   localObservedReceipt, localObservedSequence, allowedUses,
                   deniedUses, falseResolvedUses, RecoveryAuditVars>>

CopyCarrier(source, destination, r) ==
    /\ source \in Sites
    /\ destination \in Sites
    /\ source # destination
    /\ r \in carrierAt[source]
    /\ r \notin carrierAt[destination]
    /\ carrierAt' =
        [carrierAt EXCEPT ![destination] = @ \cup {r}]
    /\ UNCHANGED <<AvailabilityVars, IdentityVars, ProposalVars, ReleaseVars,
                   ReceiptVars, fleetTrustAnchor, projectTrustPin, receiptAt,
                   closureAt, decryptableAt, applicabilityAt,
                   localObservedReceipt, localObservedSequence, allowedUses,
                   deniedUses, falseResolvedUses, RecoveryAuditVars>>

ImportReceipt(s, q) ==
    /\ s \in Sites
    /\ q \in headReceipts
    /\ q \notin receiptAt[s]
    /\ receiptAt' = [receiptAt EXCEPT ![s] = @ \cup {q}]
    /\ UNCHANGED <<AvailabilityVars, IdentityVars, ProposalVars, ReleaseVars,
                   ReceiptVars, fleetTrustAnchor, projectTrustPin, carrierAt,
                   closureAt, decryptableAt, applicabilityAt,
                   localObservedReceipt, localObservedSequence, allowedUses,
                   deniedUses, falseResolvedUses, RecoveryAuditVars>>

InstallClosureEvidence(s, item, decryptable, applicability) ==
    /\ s \in Sites
    /\ item \in ClosureItems
    /\ decryptable \in BOOLEAN
    /\ applicability \in ApplicabilityValues
    /\ closureAt' = [closureAt EXCEPT ![s] = @ \cup {item}]
    /\ decryptableAt' =
        IF decryptable
            THEN [decryptableAt EXCEPT ![s] = @ \cup {item}]
            ELSE [decryptableAt EXCEPT ![s] = @ \ {item}]
    /\ applicabilityAt' =
        IF item \in NormativeItems
            THEN [applicabilityAt EXCEPT ![s][item] = applicability]
            ELSE applicabilityAt
    /\ UNCHANGED <<AvailabilityVars, IdentityVars, ProposalVars, ReleaseVars,
                   ReceiptVars, fleetTrustAnchor, projectTrustPin, carrierAt,
                   receiptAt, localObservedReceipt, localObservedSequence,
                   allowedUses, deniedUses, falseResolvedUses,
                   RecoveryAuditVars>>

ObserveExternalHead(s, i) ==
    /\ s \in Sites
    /\ i \in knownIdentities
    /\ i \notin frozen
    /\ acceptedHeadReceipt[i] # NoReceipt
    /\ acceptedHeadReceipt[i] \in receiptAt[s]
    /\ receiptRelease[acceptedHeadReceipt[i]] \in carrierAt[s]
    /\ SiteTrustsReceipt(s, acceptedHeadReceipt[i])
    /\ localObservedReceipt' =
        [localObservedReceipt EXCEPT ![s][i] = acceptedHeadReceipt[i]]
    /\ localObservedSequence' =
        [localObservedSequence EXCEPT ![s][i] = witnessSequence[i]]
    /\ UNCHANGED <<AvailabilityVars, IdentityVars, ProposalVars, ReleaseVars,
                   ReceiptVars, fleetTrustAnchor, projectTrustPin, carrierAt,
                   receiptAt, closureAt, decryptableAt, applicabilityAt,
                   allowedUses, deniedUses, falseResolvedUses,
                   RecoveryAuditVars>>

RollbackLocalState(s, i, oldSequence) ==
    /\ s \in Sites
    /\ i \in knownIdentities
    /\ oldSequence \in Sequences
    /\ oldSequence <= localObservedSequence[s][i]
    /\ localObservedReceipt' =
        [localObservedReceipt EXCEPT ![s][i] = NoReceipt]
    /\ localObservedSequence' =
        [localObservedSequence EXCEPT ![s][i] = oldSequence]
    /\ receiptAt' = [receiptAt EXCEPT ![s] = {}]
    /\ closureAt' = [closureAt EXCEPT ![s] = {}]
    /\ decryptableAt' = [decryptableAt EXCEPT ![s] = {}]
    /\ applicabilityAt' =
        [applicabilityAt EXCEPT
            ![s] =
                [item \in NormativeItems |-> UnknownApplicability]]
    /\ UNCHANGED <<AvailabilityVars, IdentityVars, ProposalVars, ReleaseVars,
                   ReceiptVars, fleetTrustAnchor, projectTrustPin, carrierAt,
                   allowedUses, deniedUses, falseResolvedUses,
                   RecoveryAuditVars>>

SetFleetTrustAnchor(s, anchor) ==
    /\ s \in Sites
    /\ anchor \in FleetAnchors
    /\ anchor # fleetTrustAnchor[s]
    /\ fleetTrustAnchor' =
        [fleetTrustAnchor EXCEPT ![s] = anchor]
    /\ UNCHANGED <<AvailabilityVars, IdentityVars, ProposalVars, ReleaseVars,
                   ReceiptVars, projectTrustPin, carrierAt, receiptAt,
                   closureAt, decryptableAt, applicabilityAt,
                   localObservedReceipt, localObservedSequence, allowedUses,
                   deniedUses, falseResolvedUses, RecoveryAuditVars>>

InstallCurrentProjectTrustPin(s, i) ==
    /\ s \in Sites
    /\ i \in knownIdentities
    /\ projectTrustPin[s][i] # authorityKey[i]
    /\ projectTrustPin' =
        [projectTrustPin EXCEPT ![s][i] = authorityKey[i]]
    /\ UNCHANGED <<AvailabilityVars, IdentityVars, ProposalVars, ReleaseVars,
                   ReceiptVars, fleetTrustAnchor, carrierAt, receiptAt,
                   closureAt, decryptableAt, applicabilityAt,
                   localObservedReceipt, localObservedSequence, allowedUses,
                   deniedUses, falseResolvedUses, RecoveryAuditVars>>

EvaluateActiveAtSite(s, i) ==
    /\ s \in Sites
    /\ i \in knownIdentities
    /\ LET q == acceptedHeadReceipt[i]
           r == IF q = NoReceipt THEN NoRelease ELSE receiptRelease[q]
       IN
       IF CanUseAt(s, i)
          THEN
            /\ allowedUses' = allowedUses \cup {<<s, i, q, r>>}
            /\ falseResolvedUses' =
                IF \E item \in NormativeItems \cap releaseClosure[r] :
                        applicabilityAt[s][item] = FalseApplicability
                    THEN falseResolvedUses \cup {<<s, i, q, r>>}
                    ELSE falseResolvedUses
            /\ UNCHANGED deniedUses
          ELSE
            /\ deniedUses' = deniedUses \cup {<<s, i>>}
            /\ UNCHANGED <<allowedUses, falseResolvedUses>>
    /\ UNCHANGED <<AvailabilityVars, IdentityVars, ProposalVars, ReleaseVars,
                   ReceiptVars, fleetTrustAnchor, projectTrustPin, carrierAt,
                   receiptAt, closureAt, decryptableAt, applicabilityAt,
                   localObservedReceipt, localObservedSequence,
                   RecoveryAuditVars>>

SetWitnessAvailability(value) ==
    /\ value \in BOOLEAN
    /\ value # witnessAvailable
    /\ witnessAvailable' = value
    /\ UNCHANGED <<sequencerAvailable, recoveryAvailable, IdentityVars,
                   ProposalVars, ReleaseVars, ReceiptVars, LocalVars,
                   RecoveryAuditVars>>

SetSequencerAvailability(value) ==
    /\ value \in BOOLEAN
    /\ value # sequencerAvailable
    /\ sequencerAvailable' = value
    /\ UNCHANGED <<witnessAvailable, recoveryAvailable, IdentityVars,
                   ProposalVars, ReleaseVars, ReceiptVars, LocalVars,
                   RecoveryAuditVars>>

SetRecoveryAvailability(value) ==
    /\ value \in BOOLEAN
    /\ value # recoveryAvailable
    /\ recoveryAvailable' = value
    /\ UNCHANGED <<witnessAvailable, sequencerAvailable, IdentityVars,
                   ProposalVars, ReleaseVars, ReceiptVars, LocalVars,
                   RecoveryAuditVars>>

Next ==
    \/ \E p \in ProposalIds, i \in IdentityUniverse,
          closure \in SUBSET ClosureItems :
          AuthorGovernanceProposal(p, i, closure)
    \/ \E p \in ProposalIds, source \in IdentityUniverse,
          target \in IdentityUniverse, closure \in SUBSET ClosureItems :
          IntentionalFork(p, source, target, closure)
    \/ \E i \in IdentityUniverse : SequenceFor(i)
    \/ \E i \in IdentityUniverse : HeadReceiptFor(i)
    \/ \E i \in IdentityUniverse, r \in ReleaseIds,
          closure \in SUBSET ClosureItems :
          StageSameSlotCandidate(i, r, closure)
    \/ \E i \in IdentityUniverse, r \in ReleaseIds, q \in ReceiptIds :
          PublishConflictingReceipt(i, r, q)
    \/ \E i \in IdentityUniverse, r \in ReleaseIds,
          t \in Terms, k \in RootKeys,
          closure \in SUBSET ClosureItems :
          SafeRecoveryRelease(i, r, t, k, closure)
    \/ \E i \in IdentityUniverse : RecoveryFor(i)
    \/ \E s \in Sites, r \in ReleaseIds : ImportCarrier(s, r)
    \/ \E source \in Sites, destination \in Sites, r \in ReleaseIds :
          CopyCarrier(source, destination, r)
    \/ \E s \in Sites, q \in ReceiptIds : ImportReceipt(s, q)
    \/ \E s \in Sites, item \in ClosureItems, d \in BOOLEAN,
          a \in ApplicabilityValues :
          InstallClosureEvidence(s, item, d, a)
    \/ \E s \in Sites, i \in IdentityUniverse :
          ObserveExternalHead(s, i)
    \/ \E s \in Sites, i \in IdentityUniverse, n \in Sequences :
          RollbackLocalState(s, i, n)
    \/ \E s \in Sites, a \in FleetAnchors :
          SetFleetTrustAnchor(s, a)
    \/ \E s \in Sites, i \in IdentityUniverse :
          InstallCurrentProjectTrustPin(s, i)
    \/ \E s \in Sites, i \in IdentityUniverse :
          EvaluateActiveAtSite(s, i)
    \/ \E value \in BOOLEAN : SetWitnessAvailability(value)
    \/ \E value \in BOOLEAN : SetSequencerAvailability(value)
    \/ \E value \in BOOLEAN : SetRecoveryAvailability(value)

TypeOK ==
    /\ witnessAvailable \in BOOLEAN
    /\ sequencerAvailable \in BOOLEAN
    /\ recoveryAvailable \in BOOLEAN
    /\ knownIdentities \subseteq IdentityUniverse
    /\ forkSource \in
        [IdentityUniverse -> IdentityUniverse \cup {NoIdentity}]
    /\ authorityKey \in [IdentityUniverse -> RootKeys]
    /\ proposals \subseteq ProposalIds
    /\ offlineProposals \subseteq proposals
    /\ committedProposals \subseteq proposals
    /\ proposalIdentity \in [ProposalIds -> IdentityUniverse]
    /\ proposalBaseReceipt \in
        [ProposalIds -> ReceiptIds \cup {NoReceipt}]
    /\ proposalClosure \in [ProposalIds -> SUBSET ClosureItems]
    /\ proposalKind \in [ProposalIds -> ProposalKinds]
    /\ candidateReleases \subseteq ReleaseIds
    /\ sequencedReleases \subseteq candidateReleases
    /\ recoveryReleases \subseteq candidateReleases
    /\ releaseIdentity \in [ReleaseIds -> IdentityUniverse]
    /\ releaseTerm \in [ReleaseIds -> Terms]
    /\ releaseSequence \in [ReleaseIds -> Sequences]
    /\ releaseParent \in [ReleaseIds -> ReleaseIds \cup {NoRelease}]
    /\ releaseClosure \in [ReleaseIds -> SUBSET ClosureItems]
    /\ releaseKey \in [ReleaseIds -> RootKeys \cup {NoRootKey}]
    /\ releaseProposal \in
        [ReleaseIds -> ProposalIds \cup {NoProposal}]
    /\ releaseKind \in [ReleaseIds -> ReleaseKinds]
    /\ pendingSequenced \in
        [IdentityUniverse -> ReleaseIds \cup {NoRelease}]
    /\ pendingRecovery \in
        [IdentityUniverse -> ReleaseIds \cup {NoRelease}]
    /\ headReceipts \subseteq ReceiptIds
    /\ conflictingReceipts \subseteq headReceipts
    /\ quarantinedReleases \subseteq candidateReleases
    /\ receiptIdentity \in [ReceiptIds -> IdentityUniverse]
    /\ receiptTerm \in [ReceiptIds -> Terms]
    /\ receiptSequence \in [ReceiptIds -> Sequences]
    /\ receiptParent \in
        [ReceiptIds -> ReleaseIds \cup {NoRelease}]
    /\ receiptRelease \in
        [ReceiptIds -> ReleaseIds \cup {NoRelease}]
    /\ receiptClosure \in [ReceiptIds -> SUBSET ClosureItems]
    /\ witnessTerm \in [IdentityUniverse -> Terms]
    /\ witnessSequence \in [IdentityUniverse -> Sequences]
    /\ acceptedHeadReceipt \in
        [IdentityUniverse -> ReceiptIds \cup {NoReceipt}]
    /\ frozen \subseteq knownIdentities
    /\ freezeBase \in
        [IdentityUniverse -> ReleaseIds \cup {NoRelease}]
    /\ fleetTrustAnchor \in [Sites -> FleetAnchors]
    /\ projectTrustPin \in
        [Sites -> [IdentityUniverse -> RootKeys]]
    /\ carrierAt \in [Sites -> SUBSET ReleaseIds]
    /\ receiptAt \in [Sites -> SUBSET ReceiptIds]
    /\ closureAt \in [Sites -> SUBSET ClosureItems]
    /\ decryptableAt \in [Sites -> SUBSET ClosureItems]
    /\ applicabilityAt \in
        [Sites -> [NormativeItems -> ApplicabilityValues]]
    /\ localObservedReceipt \in
        [Sites ->
            [IdentityUniverse -> ReceiptIds \cup {NoReceipt}]]
    /\ localObservedSequence \in
        [Sites -> [IdentityUniverse -> Sequences]]
    /\ allowedUses \subseteq UseUniverse
    /\ deniedUses \subseteq Sites \X IdentityUniverse
    /\ falseResolvedUses \subseteq allowedUses
    /\ recoveryTransitions \subseteq headReceipts
    /\ recoveryOperationsPerformed \subseteq RecoveryOperations
    /\ recoveryRuntimeOperations \subseteq RuntimeOperations

OneLogicalSequencer ==
    /\ \A i \in IdentityUniverse :
        pendingSequenced[i] = NoRelease \/
            /\ pendingSequenced[i] \in sequencedReleases
            /\ releaseIdentity[pendingSequenced[i]] = i
    /\ \A r1 \in sequencedReleases, r2 \in sequencedReleases :
        /\ releaseIdentity[r1] = releaseIdentity[r2]
        /\ releaseTerm[r1] = releaseTerm[r2]
        /\ releaseSequence[r1] = releaseSequence[r2]
        => r1 = r2

HeadReceiptSelectedActiveRelease ==
    \A i \in knownIdentities :
        IF i \in frozen
            THEN SelectedRelease(i) = NoRelease
            ELSE
                acceptedHeadReceipt[i] = NoReceipt \/
                /\ acceptedHeadReceipt[i] \in headReceipts
                /\ ReceiptBindsRelease(acceptedHeadReceipt[i])
                /\ receiptIdentity[acceptedHeadReceipt[i]] = i
                /\ receiptTerm[acceptedHeadReceipt[i]] = witnessTerm[i]
                /\ receiptSequence[acceptedHeadReceipt[i]] =
                     witnessSequence[i]
                /\ SelectedRelease(i) =
                     receiptRelease[acceptedHeadReceipt[i]]

CandidateCarriersAreNonAuthorizing ==
    /\ \A i \in knownIdentities :
        SelectedRelease(i) # NoRelease
            => SelectedRelease(i) \in
                sequencedReleases \cup recoveryReleases
    /\ \A use \in allowedUses :
        /\ use[3] \in headReceipts
        /\ receiptRelease[use[3]] = use[4]
        /\ ReceiptBindsRelease(use[3])

ActiveClosureIsComplete ==
    \A i \in knownIdentities :
        SelectedRelease(i) # NoRelease
            => ClosureComplete(SelectedRelease(i))

ReceiptEquivocationFreezes ==
    \A q1 \in headReceipts, q2 \in headReceipts :
        /\ q1 # q2
        /\ receiptIdentity[q1] = receiptIdentity[q2]
        /\ receiptTerm[q1] = receiptTerm[q2]
        /\ receiptSequence[q1] = receiptSequence[q2]
        /\ receiptRelease[q1] # receiptRelease[q2]
        /\ receiptTerm[q1] = witnessTerm[receiptIdentity[q1]]
        => /\ receiptIdentity[q1] \in frozen
           /\ q1 \in conflictingReceipts
           /\ q2 \in conflictingReceipts
           /\ receiptRelease[q1] \in quarantinedReleases
           /\ receiptRelease[q2] \in quarantinedReleases

GovernanceOnlyRecovery ==
    /\ recoveryOperationsPerformed \subseteq RecoveryOperations
    /\ recoveryRuntimeOperations = {}
    /\ RecoveryOperations \cap RuntimeOperations = {}
    /\ \A q \in recoveryTransitions :
        /\ q \in headReceipts
        /\ receiptRelease[q] \in recoveryReleases
        /\ releaseKind[receiptRelease[q]] = "recovery"

ForksMintNewIdentity ==
    \A i \in knownIdentities :
        forkSource[i] # NoIdentity
            => /\ forkSource[i] \in knownIdentities
               /\ forkSource[i] # i

DefiniteFalseIsResolvedButNeverAuthority ==
    /\ falseResolvedUses \subseteq allowedUses
    /\ TrueApplicability # FalseApplicability
    /\ FalseApplicability # UnknownApplicability

NewFalseResolvedUseWasDefiniteFalse ==
    \A use \in UseUniverse :
        /\ use \notin falseResolvedUses
        /\ use \in falseResolvedUses'
        => /\ use \in allowedUses'
           /\ \E item \in NormativeItems \cap releaseClosure[use[4]] :
                applicabilityAt[use[1]][item] = FalseApplicability

FalseApplicabilityIsResolvedNotAuthority ==
    [][NewFalseResolvedUseWasDefiniteFalse]_vars

ExistingReleaseMetadataStable ==
    \A r \in candidateReleases :
        /\ releaseIdentity'[r] = releaseIdentity[r]
        /\ releaseTerm'[r] = releaseTerm[r]
        /\ releaseSequence'[r] = releaseSequence[r]
        /\ releaseParent'[r] = releaseParent[r]
        /\ releaseClosure'[r] = releaseClosure[r]
        /\ releaseKey'[r] = releaseKey[r]
        /\ releaseProposal'[r] = releaseProposal[r]
        /\ releaseKind'[r] = releaseKind[r]

ReleaseMetadataImmutable ==
    [][ExistingReleaseMetadataStable]_vars

WitnessOrderDoesNotRollback ==
    \A i \in IdentityUniverse :
        /\ witnessTerm'[i] >= witnessTerm[i]
        /\ witnessTerm'[i] = witnessTerm[i]
            => witnessSequence'[i] >= witnessSequence[i]

ExternalWitnessRollbackResistant ==
    [][WitnessOrderDoesNotRollback]_vars

OfflineCannotAdvanceAuthority ==
    ~witnessAvailable =>
        /\ witnessTerm' = witnessTerm
        /\ witnessSequence' = witnessSequence
        /\ acceptedHeadReceipt' = acceptedHeadReceipt
        /\ headReceipts' = headReceipts
        /\ recoveryTransitions' = recoveryTransitions

OfflineProposalOnly ==
    [][OfflineCannotAdvanceAuthority]_vars

NewAllowedUseIsCurrentAndComplete ==
    \A use \in UseUniverse :
        /\ use \notin allowedUses
        /\ use \in allowedUses'
        => /\ use[2] \in knownIdentities
           /\ use[2] \notin frozen
           /\ use[3] = acceptedHeadReceipt[use[2]]
           /\ use[4] = SelectedRelease(use[2])
           /\ CanUseAt(use[1], use[2])

UseLinearizesAtExternalReceipt ==
    [][NewAllowedUseIsCurrentAndComplete]_vars

PendingProposalResources(p) ==
    LET i == proposalIdentity[p]
    IN  /\ p \in proposals \ committedProposals
        /\ i \in knownIdentities
        /\ i \notin frozen
        /\ RequiredClosure \subseteq proposalClosure[p]
        /\ proposalBaseReceipt[p] = acceptedHeadReceipt[i]
        /\ pendingSequenced[i] = NoRelease
        /\ pendingRecovery[i] = NoRelease
        /\ \E r \in ReleaseIds \ candidateReleases,
              n \in Sequences :
              n = witnessSequence[i] + 1

ConditionalSequencerLiveness ==
    \A p \in ProposalIds :
        /\ <>[](sequencerAvailable /\ witnessAvailable)
        /\ [](p \in proposals \ committedProposals =>
                PendingProposalResources(p))
        => (p \in proposals \ committedProposals
             ~> p \in committedProposals)

PendingWitnessResources(i) ==
    /\ i \in knownIdentities
    /\ i \notin frozen
    /\ pendingSequenced[i] \in sequencedReleases
    /\ \E q \in ReceiptIds \ headReceipts : TRUE

ConditionalWitnessLiveness ==
    \A i \in IdentityUniverse :
        /\ <>[]witnessAvailable
        /\ [](pendingSequenced[i] # NoRelease =>
                PendingWitnessResources(i))
        => (pendingSequenced[i] # NoRelease
             ~> pendingSequenced[i] = NoRelease \/ i \in frozen)

PendingRecoveryResources(i) ==
    /\ i \in knownIdentities
    /\ pendingRecovery[i] \in recoveryReleases
    /\ \E q \in ReceiptIds \ headReceipts : TRUE

ConditionalRecoveryLiveness ==
    \A i \in IdentityUniverse :
        /\ <>[](recoveryAvailable /\ witnessAvailable)
        /\ [](pendingRecovery[i] # NoRelease =>
                PendingRecoveryResources(i))
        => (pendingRecovery[i] # NoRelease
             ~> pendingRecovery[i] = NoRelease)

\* Expected-failure mutation: a local candidate is used with no receipt.
UnsafeCandidateUse(s, i, r) ==
    /\ s \in Sites
    /\ i \in knownIdentities
    /\ r \in candidateReleases
    /\ r # SelectedRelease(i)
    /\ <<s, i, NoReceipt, r>> \notin allowedUses
    /\ allowedUses' =
        allowedUses \cup {<<s, i, NoReceipt, r>>}
    /\ UNCHANGED <<AvailabilityVars, IdentityVars, ProposalVars, ReleaseVars,
                   ReceiptVars, fleetTrustAnchor, projectTrustPin, carrierAt,
                   receiptAt, closureAt, decryptableAt, applicabilityAt,
                   localObservedReceipt, localObservedSequence, deniedUses,
                   falseResolvedUses, RecoveryAuditVars>>

UnsafeNext ==
    Next \/
    \E s \in Sites, i \in IdentityUniverse, r \in ReleaseIds :
        UnsafeCandidateUse(s, i, r)

MutationSpec == Init /\ [][UnsafeNext]_vars

\* Targeted finite harness for the witnessed-head/equivocation/recovery path.
\* It uses the same production actions but removes unrelated local-state and
\* availability interleavings.  The adversarial configs provide exactly three
\* releases and receipts: selected, conflicting, and recovery.
AdversarialNext ==
    \/ \E p \in ProposalIds :
          AuthorGovernanceProposal(p, BaseIdentity, RequiredClosure)
    \/ SequenceFor(BaseIdentity)
    \/ HeadReceiptFor(BaseIdentity)
    \/ \E r \in ReleaseIds :
          StageSameSlotCandidate(BaseIdentity, r, RequiredClosure)
    \/ \E r \in ReleaseIds, q \in ReceiptIds :
          PublishConflictingReceipt(BaseIdentity, r, q)
    \/ \E r \in ReleaseIds, t \in Terms, k \in RootKeys :
          SafeRecoveryRelease(
              BaseIdentity, r, t, k, RequiredClosure)
    \/ RecoveryFor(BaseIdentity)

AdversarialSpec == Init /\ [][AdversarialNext]_vars

ForkHarnessNext ==
    \E p \in ProposalIds, target \in IdentityUniverse,
       closure \in SUBSET ClosureItems :
       IntentionalFork(p, BaseIdentity, target, closure)

ForkHarnessSpec == Init /\ [][ForkHarnessNext]_vars

RecoveryReachabilitySentinel == recoveryTransitions = {}
EquivocationReachabilitySentinel == frozen = {}
FalseApplicabilityReachabilitySentinel == falseResolvedUses = {}
ForkReachabilitySentinel == knownIdentities = {BaseIdentity}
OfflineProposalReachabilitySentinel == offlineProposals = {}

Spec ==
    /\ Init
    /\ [][Next]_vars
    /\ \A i \in IdentityUniverse : WF_vars(SequenceFor(i))
    /\ \A i \in IdentityUniverse : WF_vars(HeadReceiptFor(i))
    /\ \A i \in IdentityUniverse : WF_vars(RecoveryFor(i))

=============================================================================
