------------------------ MODULE RuntimeAuthorization ------------------------
EXTENDS Integers, FiniteSets, TLC

\* A bounded candidate model for decision-current gateway authorization.
\* intentQueued is durable but unauthorizing. GatewayDequeueExecute is the
\* linearized current-check/CAS/record/audit/local-send transition. Its FALSE
\* branch models a crash after CAS but before transport invocation. Remote
\* receipt/computation is later still.

CONSTANTS
    RequestIds, SessionIds, SessionIncarnations, EnforcerGenerations,
    PolicyDigests, GrantIds, DeviationGrantIds, Workers,
    GrantEpochs, RetryCounts, HigherConstraint,
    InferenceTarget, EffectTarget, OutputReleaseTarget,
    InitialPolicyDigest, InitialSessionIncarnation,
    InitialEnforcerGeneration, InitialPolicyCeiling,
    ZeroGrantEpoch, ZeroRetryCount,
    CanonicalRenderer,
    NoRequest, NoGrant, NoPolicy, NoCharter, NoManifest,
    NoOutcome, UnknownOutcome, SuccessOutcome, FailureOutcome

TargetKinds == {InferenceTarget, EffectTarget, OutputReleaseTarget}
CustomOps == {"narrow", "forbid", "require", "guide", "evaluate"}
RestrictingOps == {"narrow", "forbid"}
NonAuthorizingOps == {"require", "guide", "evaluate"}
FinalOutcomes == {SuccessOutcome, FailureOutcome}

ASSUME /\ IsFiniteSet(RequestIds)
       /\ IsFiniteSet(SessionIds)
       /\ IsFiniteSet(SessionIncarnations)
       /\ IsFiniteSet(EnforcerGenerations)
       /\ IsFiniteSet(PolicyDigests)
       /\ IsFiniteSet(GrantIds)
       /\ IsFiniteSet(DeviationGrantIds)
       /\ IsFiniteSet(Workers)
       /\ IsFiniteSet(GrantEpochs)
       /\ IsFiniteSet(RetryCounts)
       /\ HigherConstraint \subseteq TargetKinds
       /\ InitialPolicyDigest \in PolicyDigests
       /\ InitialSessionIncarnation \in SessionIncarnations
       /\ InitialEnforcerGeneration \in EnforcerGenerations
       /\ InitialPolicyCeiling \subseteq HigherConstraint
       /\ ZeroGrantEpoch \in GrantEpochs
       /\ ZeroRetryCount \in RetryCounts
       /\ NoRequest \notin RequestIds
       /\ NoGrant \notin GrantIds
       /\ NoPolicy \notin PolicyDigests
       /\ NoOutcome # UnknownOutcome
       /\ UnknownOutcome \notin FinalOutcomes
       /\ InferenceTarget # EffectTarget
       /\ InferenceTarget # OutputReleaseTarget
       /\ EffectTarget # OutputReleaseTarget

PolicyBasis(policyDigest, ceiling) ==
    [kind |-> "PolicyBasis",
     digest |-> policyDigest,
     deviations |-> {},
     ceiling |-> ceiling]

SemanticCharter(
        requestId, policyDigest, ceiling, sessionGrant, grantEpochValue,
        rights, deviations, incarnation, generation, target, source) ==
    [kind |-> "SemanticCharter",
     request |-> requestId,
     policyBasis |-> PolicyBasis(policyDigest, ceiling),
     exactDeviationGrants |-> deviations,
     sessionGrant |-> sessionGrant,
     grantEpoch |-> grantEpochValue,
     effectiveTargets |-> rights \cap ceiling \cap HigherConstraint,
     sessionIncarnation |-> incarnation,
     enforcerGeneration |-> generation,
     target |-> target,
     sourceInference |-> source]

RenderManifest(requestId, charter) ==
    [kind |-> "RenderManifest",
     request |-> requestId,
     renderer |-> CanonicalRenderer,
     semanticCharter |-> charter]

VARIABLES
    authorityAvailable,
    gatewayAvailable,
    providerAvailable,
    effectTransportAvailable,
    outputTransportAvailable,
    currentPolicy,
    policyCeiling,
    usedPolicies,
    lastCustomOp,
    currentIncarnation,
    usedIncarnations,
    currentEnforcerGeneration,
    usedEnforcerGenerations,
    sessionGrant,
    grantEpoch,
    grantRights,
    grantDeviations,
    knownRequests,
    intentQueued,
    requestSession,
    requestIncarnation,
    requestGeneration,
    requestTarget,
    requestSource,
    decisionConsumed,
    decisionAllowed,
    decisionDenied,
    decisionAudited,
    duplicateRejected,
    decisionPolicy,
    decisionGrant,
    decisionGrantEpoch,
    decisionIncarnation,
    decisionGeneration,
    decisionTarget,
    admitted,
    admissionPolicy,
    admissionCeiling,
    admissionGrant,
    admissionGrantEpoch,
    admissionRights,
    admissionDeviations,
    admissionIncarnation,
    admissionGeneration,
    admissionCharter,
    admissionRenderManifest,
    abandonedBeforeSend,
    gatewaySent,
    admissionCount,
    sendCount,
    completed,
    inferenceCompleted,
    effectAttempted,
    outputReleased,
    effectOutcome,
    needsReconciliation,
    retryCount,
    workerCache,
    workerReceipts,
    receiptAttempts

vars ==
    <<authorityAvailable, gatewayAvailable, providerAvailable,
      effectTransportAvailable, outputTransportAvailable, currentPolicy,
      policyCeiling, usedPolicies, lastCustomOp, currentIncarnation,
      usedIncarnations, currentEnforcerGeneration, usedEnforcerGenerations,
      sessionGrant, grantEpoch, grantRights, grantDeviations, knownRequests,
      intentQueued, requestSession, requestIncarnation, requestGeneration,
      requestTarget, requestSource, decisionConsumed, decisionAllowed,
      decisionDenied, decisionAudited, duplicateRejected, decisionPolicy,
      decisionGrant, decisionGrantEpoch, decisionIncarnation,
      decisionGeneration, decisionTarget, admitted, admissionPolicy,
      admissionCeiling, admissionGrant, admissionGrantEpoch, admissionRights,
      admissionDeviations, admissionIncarnation, admissionGeneration,
      admissionCharter, admissionRenderManifest, abandonedBeforeSend,
      gatewaySent, admissionCount, sendCount, completed, inferenceCompleted,
      effectAttempted, outputReleased, effectOutcome, needsReconciliation,
      retryCount, workerCache, workerReceipts, receiptAttempts>>

AvailabilityVars ==
    <<authorityAvailable, gatewayAvailable, providerAvailable,
      effectTransportAvailable, outputTransportAvailable>>

PolicyVars ==
    <<currentPolicy, policyCeiling, usedPolicies, lastCustomOp>>

SessionVars ==
    <<currentIncarnation, usedIncarnations, currentEnforcerGeneration,
      usedEnforcerGenerations, sessionGrant, grantEpoch, grantRights,
      grantDeviations>>

RequestVars ==
    <<knownRequests, intentQueued, requestSession, requestIncarnation,
      requestGeneration, requestTarget, requestSource>>

DecisionVars ==
    <<decisionConsumed, decisionAllowed, decisionDenied, decisionAudited,
      duplicateRejected, decisionPolicy, decisionGrant, decisionGrantEpoch,
      decisionIncarnation, decisionGeneration, decisionTarget>>

AdmissionVars ==
    <<admitted, admissionPolicy, admissionCeiling, admissionGrant,
      admissionGrantEpoch, admissionRights, admissionDeviations,
      admissionIncarnation, admissionGeneration, admissionCharter,
      admissionRenderManifest>>

TransportStateVars ==
    <<abandonedBeforeSend, gatewaySent, admissionCount, sendCount, completed,
      inferenceCompleted, effectAttempted, outputReleased, effectOutcome,
      needsReconciliation>>

WorkerVars ==
    <<retryCount, workerCache, workerReceipts, receiptAttempts>>

Init ==
    /\ authorityAvailable = TRUE
    /\ gatewayAvailable = TRUE
    /\ providerAvailable = TRUE
    /\ effectTransportAvailable = TRUE
    /\ outputTransportAvailable = TRUE
    /\ currentPolicy = InitialPolicyDigest
    /\ policyCeiling = InitialPolicyCeiling
    /\ usedPolicies = {InitialPolicyDigest}
    /\ lastCustomOp = "evaluate"
    /\ currentIncarnation =
        [s \in SessionIds |-> InitialSessionIncarnation]
    /\ usedIncarnations =
        [s \in SessionIds |-> {InitialSessionIncarnation}]
    /\ currentEnforcerGeneration = InitialEnforcerGeneration
    /\ usedEnforcerGenerations = {InitialEnforcerGeneration}
    /\ sessionGrant = [s \in SessionIds |-> NoGrant]
    /\ grantEpoch = [s \in SessionIds |-> ZeroGrantEpoch]
    /\ grantRights = [s \in SessionIds |-> {}]
    /\ grantDeviations = [s \in SessionIds |-> {}]
    /\ knownRequests = {}
    /\ intentQueued = {}
    /\ requestSession =
        [r \in RequestIds |-> CHOOSE s \in SessionIds : TRUE]
    /\ requestIncarnation =
        [r \in RequestIds |-> InitialSessionIncarnation]
    /\ requestGeneration =
        [r \in RequestIds |-> InitialEnforcerGeneration]
    /\ requestTarget = [r \in RequestIds |-> InferenceTarget]
    /\ requestSource = [r \in RequestIds |-> NoRequest]
    /\ decisionConsumed = {}
    /\ decisionAllowed = {}
    /\ decisionDenied = {}
    /\ decisionAudited = {}
    /\ duplicateRejected = {}
    /\ decisionPolicy = [r \in RequestIds |-> NoPolicy]
    /\ decisionGrant = [r \in RequestIds |-> NoGrant]
    /\ decisionGrantEpoch =
        [r \in RequestIds |-> ZeroGrantEpoch]
    /\ decisionIncarnation =
        [r \in RequestIds |-> InitialSessionIncarnation]
    /\ decisionGeneration =
        [r \in RequestIds |-> InitialEnforcerGeneration]
    /\ decisionTarget = [r \in RequestIds |-> InferenceTarget]
    /\ admitted = {}
    /\ admissionPolicy = [r \in RequestIds |-> NoPolicy]
    /\ admissionCeiling = [r \in RequestIds |-> {}]
    /\ admissionGrant = [r \in RequestIds |-> NoGrant]
    /\ admissionGrantEpoch =
        [r \in RequestIds |-> ZeroGrantEpoch]
    /\ admissionRights = [r \in RequestIds |-> {}]
    /\ admissionDeviations = [r \in RequestIds |-> {}]
    /\ admissionIncarnation =
        [r \in RequestIds |-> InitialSessionIncarnation]
    /\ admissionGeneration =
        [r \in RequestIds |-> InitialEnforcerGeneration]
    /\ admissionCharter = [r \in RequestIds |-> NoCharter]
    /\ admissionRenderManifest =
        [r \in RequestIds |-> NoManifest]
    /\ abandonedBeforeSend = {}
    /\ gatewaySent = {}
    /\ admissionCount = [r \in RequestIds |-> 0]
    /\ sendCount = [r \in RequestIds |-> 0]
    /\ completed = {}
    /\ inferenceCompleted = {}
    /\ effectAttempted = {}
    /\ outputReleased = {}
    /\ effectOutcome = [r \in RequestIds |-> NoOutcome]
    /\ needsReconciliation = {}
    /\ retryCount = [r \in RequestIds |-> ZeroRetryCount]
    /\ workerCache = [w \in Workers |-> {}]
    /\ workerReceipts = [w \in Workers |-> {}]
    /\ receiptAttempts = {}

TransportAvailable(target) ==
    CASE target = InferenceTarget -> providerAvailable
      [] target = EffectTarget -> effectTransportAvailable
      [] target = OutputReleaseTarget -> outputTransportAvailable

SourceInferenceCurrent(r) ==
    IF requestTarget[r] = InferenceTarget
        THEN requestSource[r] = NoRequest
        ELSE
            LET source == requestSource[r]
                session == requestSession[r]
            IN  /\ source \in inferenceCompleted
                /\ requestTarget[source] = InferenceTarget
                /\ requestSession[source] = session
                /\ admissionPolicy[source] = currentPolicy
                /\ admissionCeiling[source] = policyCeiling
                /\ admissionGrant[source] = sessionGrant[session]
                /\ admissionGrantEpoch[source] = grantEpoch[session]
                /\ admissionRights[source] = grantRights[session]
                /\ admissionDeviations[source] =
                     grantDeviations[session]
                /\ admissionIncarnation[source] =
                     currentIncarnation[session]
                /\ admissionGeneration[source] =
                     currentEnforcerGeneration

AuthorizationCurrent(r) ==
    LET session == requestSession[r]
    IN  /\ r \in knownRequests
        /\ requestIncarnation[r] = currentIncarnation[session]
        /\ requestGeneration[r] = currentEnforcerGeneration
        /\ sessionGrant[session] # NoGrant
        /\ requestTarget[r] \in grantRights[session]
        /\ requestTarget[r] \in policyCeiling
        /\ requestTarget[r] \in HigherConstraint
        /\ SourceInferenceCurrent(r)

QueueNewIntent(r, session, incarnation, generation, target, source) ==
    /\ r \in RequestIds \ knownRequests
    /\ session \in SessionIds
    /\ incarnation \in SessionIncarnations
    /\ generation \in EnforcerGenerations
    /\ target \in TargetKinds
    /\ source \in RequestIds \cup {NoRequest}
    /\ IF target = InferenceTarget
          THEN source = NoRequest
          ELSE source \in RequestIds
    /\ knownRequests' = knownRequests \cup {r}
    /\ intentQueued' = intentQueued \cup {r}
    /\ requestSession' = [requestSession EXCEPT ![r] = session]
    /\ requestIncarnation' =
        [requestIncarnation EXCEPT ![r] = incarnation]
    /\ requestGeneration' =
        [requestGeneration EXCEPT ![r] = generation]
    /\ requestTarget' = [requestTarget EXCEPT ![r] = target]
    /\ requestSource' = [requestSource EXCEPT ![r] = source]
    /\ UNCHANGED <<AvailabilityVars, PolicyVars, SessionVars, DecisionVars,
                   AdmissionVars, TransportStateVars, WorkerVars>>

RetryIntent(r, nextRetry) ==
    /\ r \in knownRequests
    /\ r \notin intentQueued
    /\ nextRetry \in RetryCounts
    /\ nextRetry = retryCount[r] + 1
    /\ intentQueued' = intentQueued \cup {r}
    /\ retryCount' = [retryCount EXCEPT ![r] = nextRetry]
    /\ UNCHANGED <<AvailabilityVars, PolicyVars, SessionVars, knownRequests,
                   requestSession, requestIncarnation, requestGeneration,
                   requestTarget, requestSource, DecisionVars, AdmissionVars,
                   TransportStateVars, workerCache, workerReceipts,
                   receiptAttempts>>

GatewayDequeueExecute(r, invokeTransport) ==
    /\ authorityAvailable
    /\ gatewayAvailable
    /\ r \in intentQueued
    /\ r \notin decisionConsumed
    /\ admissionCount[r] = 0
    /\ invokeTransport \in BOOLEAN
    /\ AuthorizationCurrent(r)
    /\ TransportAvailable(requestTarget[r])
    /\ LET session == requestSession[r]
           charter ==
             SemanticCharter(
                r, currentPolicy, policyCeiling, sessionGrant[session],
                grantEpoch[session], grantRights[session],
                grantDeviations[session], currentIncarnation[session],
                currentEnforcerGeneration, requestTarget[r],
                requestSource[r])
       IN
       /\ intentQueued' = intentQueued \ {r}
       /\ decisionConsumed' = decisionConsumed \cup {r}
       /\ decisionAllowed' = decisionAllowed \cup {r}
       /\ decisionAudited' = decisionAudited \cup {r}
       /\ decisionPolicy' =
            [decisionPolicy EXCEPT ![r] = currentPolicy]
       /\ decisionGrant' =
            [decisionGrant EXCEPT ![r] = sessionGrant[session]]
       /\ decisionGrantEpoch' =
            [decisionGrantEpoch EXCEPT ![r] = grantEpoch[session]]
       /\ decisionIncarnation' =
            [decisionIncarnation EXCEPT
                ![r] = currentIncarnation[session]]
       /\ decisionGeneration' =
            [decisionGeneration EXCEPT
                ![r] = currentEnforcerGeneration]
       /\ decisionTarget' =
            [decisionTarget EXCEPT ![r] = requestTarget[r]]
       /\ admitted' = admitted \cup {r}
       /\ admissionPolicy' =
            [admissionPolicy EXCEPT ![r] = currentPolicy]
       /\ admissionCeiling' =
            [admissionCeiling EXCEPT ![r] = policyCeiling]
       /\ admissionGrant' =
            [admissionGrant EXCEPT ![r] = sessionGrant[session]]
       /\ admissionGrantEpoch' =
            [admissionGrantEpoch EXCEPT ![r] = grantEpoch[session]]
       /\ admissionRights' =
            [admissionRights EXCEPT ![r] = grantRights[session]]
       /\ admissionDeviations' =
            [admissionDeviations EXCEPT
                ![r] = grantDeviations[session]]
       /\ admissionIncarnation' =
            [admissionIncarnation EXCEPT
                ![r] = currentIncarnation[session]]
       /\ admissionGeneration' =
            [admissionGeneration EXCEPT
                ![r] = currentEnforcerGeneration]
       /\ admissionCharter' =
            [admissionCharter EXCEPT ![r] = charter]
       /\ admissionRenderManifest' =
            [admissionRenderManifest EXCEPT
                ![r] = RenderManifest(r, charter)]
       /\ admissionCount' = [admissionCount EXCEPT ![r] = 1]
       /\ gatewayAvailable' =
            IF invokeTransport THEN gatewayAvailable ELSE FALSE
       /\ abandonedBeforeSend' =
            IF invokeTransport
                THEN abandonedBeforeSend
                ELSE abandonedBeforeSend \cup {r}
       /\ gatewaySent' =
            IF invokeTransport
                THEN gatewaySent \cup {r}
                ELSE gatewaySent
       /\ sendCount' =
            IF invokeTransport
                THEN [sendCount EXCEPT ![r] = 1]
                ELSE sendCount
       /\ effectAttempted' =
            IF invokeTransport /\ requestTarget[r] = EffectTarget
                THEN effectAttempted \cup {r}
                ELSE effectAttempted
       /\ outputReleased' =
            IF invokeTransport /\
                    requestTarget[r] = OutputReleaseTarget
                THEN outputReleased \cup {r}
                ELSE outputReleased
       /\ effectOutcome' =
            IF invokeTransport /\ requestTarget[r] = EffectTarget
                THEN [effectOutcome EXCEPT ![r] = UnknownOutcome]
                ELSE effectOutcome
       /\ completed' =
            IF invokeTransport /\
                    requestTarget[r] = OutputReleaseTarget
                THEN completed \cup {r}
                ELSE completed
       /\ needsReconciliation' =
            IF invokeTransport
                THEN needsReconciliation
                ELSE needsReconciliation \cup
                    {other \in effectAttempted :
                        effectOutcome[other] = UnknownOutcome}
    /\ UNCHANGED <<authorityAvailable, providerAvailable,
                   effectTransportAvailable, outputTransportAvailable,
                   PolicyVars, SessionVars, knownRequests, requestSession,
                   requestIncarnation, requestGeneration, requestTarget,
                   requestSource, decisionDenied, duplicateRejected,
                   inferenceCompleted, retryCount, workerCache, workerReceipts,
                   receiptAttempts>>

GatewayDeny(r) ==
    /\ authorityAvailable
    /\ gatewayAvailable
    /\ r \in intentQueued
    /\ r \notin decisionConsumed
    /\ ~AuthorizationCurrent(r)
    /\ LET session == requestSession[r]
       IN
       /\ intentQueued' = intentQueued \ {r}
       /\ decisionConsumed' = decisionConsumed \cup {r}
       /\ decisionDenied' = decisionDenied \cup {r}
       /\ decisionAudited' = decisionAudited \cup {r}
       /\ decisionPolicy' =
            [decisionPolicy EXCEPT ![r] = currentPolicy]
       /\ decisionGrant' =
            [decisionGrant EXCEPT ![r] = sessionGrant[session]]
       /\ decisionGrantEpoch' =
            [decisionGrantEpoch EXCEPT ![r] = grantEpoch[session]]
       /\ decisionIncarnation' =
            [decisionIncarnation EXCEPT
                ![r] = currentIncarnation[session]]
       /\ decisionGeneration' =
            [decisionGeneration EXCEPT
                ![r] = currentEnforcerGeneration]
       /\ decisionTarget' =
            [decisionTarget EXCEPT ![r] = requestTarget[r]]
    /\ UNCHANGED <<authorityAvailable, gatewayAvailable, providerAvailable,
                   effectTransportAvailable, outputTransportAvailable,
                   PolicyVars, SessionVars, knownRequests, requestSession,
                   requestIncarnation, requestGeneration, requestTarget,
                   requestSource, decisionAllowed, duplicateRejected,
                   AdmissionVars, TransportStateVars, WorkerVars>>

RejectDuplicateRetry(r) ==
    /\ r \in intentQueued
    /\ r \in decisionConsumed
    /\ intentQueued' = intentQueued \ {r}
    /\ duplicateRejected' = duplicateRejected \cup {r}
    /\ UNCHANGED <<AvailabilityVars, PolicyVars, SessionVars, knownRequests,
                   requestSession, requestIncarnation, requestGeneration,
                   requestTarget, requestSource, decisionConsumed,
                   decisionAllowed, decisionDenied, decisionAudited,
                   decisionPolicy, decisionGrant, decisionGrantEpoch,
                   decisionIncarnation, decisionGeneration, decisionTarget,
                   AdmissionVars, TransportStateVars, WorkerVars>>

ProcessFor(r) ==
    (\E invokeTransport \in BOOLEAN :
        GatewayDequeueExecute(r, invokeTransport))
    \/ GatewayDeny(r)
    \/ RejectDuplicateRetry(r)

CompleteInference(r) ==
    /\ gatewayAvailable
    /\ providerAvailable
    /\ r \in gatewaySent
    /\ requestTarget[r] = InferenceTarget
    /\ r \notin inferenceCompleted
    /\ inferenceCompleted' = inferenceCompleted \cup {r}
    /\ completed' = completed \cup {r}
    /\ UNCHANGED <<AvailabilityVars, PolicyVars, SessionVars, RequestVars,
                   DecisionVars, AdmissionVars, abandonedBeforeSend,
                   gatewaySent, admissionCount, sendCount, effectAttempted,
                   outputReleased, effectOutcome, needsReconciliation,
                   WorkerVars>>

ConfirmEffect(r, outcome) ==
    /\ gatewayAvailable
    /\ effectTransportAvailable
    /\ r \in effectAttempted
    /\ effectOutcome[r] = UnknownOutcome
    /\ outcome \in FinalOutcomes
    /\ effectOutcome' = [effectOutcome EXCEPT ![r] = outcome]
    /\ completed' = completed \cup {r}
    /\ needsReconciliation' = needsReconciliation \ {r}
    /\ UNCHANGED <<AvailabilityVars, PolicyVars, SessionVars, RequestVars,
                   DecisionVars, AdmissionVars, abandonedBeforeSend,
                   gatewaySent, admissionCount, sendCount, inferenceCompleted,
                   effectAttempted, outputReleased, WorkerVars>>

ReconcileEffect(r, outcome) ==
    /\ gatewayAvailable
    /\ effectTransportAvailable
    /\ r \in needsReconciliation
    /\ effectOutcome[r] = UnknownOutcome
    /\ outcome \in FinalOutcomes
    /\ effectOutcome' = [effectOutcome EXCEPT ![r] = outcome]
    /\ completed' = completed \cup {r}
    /\ needsReconciliation' = needsReconciliation \ {r}
    /\ UNCHANGED <<AvailabilityVars, PolicyVars, SessionVars, RequestVars,
                   DecisionVars, AdmissionVars, abandonedBeforeSend,
                   gatewaySent, admissionCount, sendCount, inferenceCompleted,
                   effectAttempted, outputReleased, WorkerVars>>

ResolveEffectFor(r) ==
    \E outcome \in FinalOutcomes :
        ConfirmEffect(r, outcome) \/ ReconcileEffect(r, outcome)

ApplyCustom(op, newPolicy, newCeiling) ==
    /\ authorityAvailable
    /\ op \in CustomOps
    /\ newPolicy \in PolicyDigests \ usedPolicies
    /\ newCeiling \subseteq HigherConstraint
    /\ IF op \in RestrictingOps
          THEN newCeiling \subseteq policyCeiling
          ELSE newCeiling = policyCeiling
    /\ currentPolicy' = newPolicy
    /\ policyCeiling' = newCeiling
    /\ usedPolicies' = usedPolicies \cup {newPolicy}
    /\ lastCustomOp' = op
    /\ UNCHANGED <<AvailabilityVars, SessionVars, RequestVars, DecisionVars,
                   AdmissionVars, TransportStateVars, WorkerVars>>

InstallSessionGrant(session, newGrant, newEpoch, rights, deviations) ==
    /\ authorityAvailable
    /\ session \in SessionIds
    /\ newGrant \in GrantIds
    /\ newEpoch \in GrantEpochs
    /\ newEpoch > grantEpoch[session]
    /\ rights \subseteq HigherConstraint
    /\ deviations \subseteq DeviationGrantIds
    /\ sessionGrant' = [sessionGrant EXCEPT ![session] = newGrant]
    /\ grantEpoch' = [grantEpoch EXCEPT ![session] = newEpoch]
    /\ grantRights' = [grantRights EXCEPT ![session] = rights]
    /\ grantDeviations' =
        [grantDeviations EXCEPT ![session] = deviations]
    /\ UNCHANGED <<AvailabilityVars, PolicyVars, currentIncarnation,
                   usedIncarnations, currentEnforcerGeneration,
                   usedEnforcerGenerations, RequestVars, DecisionVars,
                   AdmissionVars, TransportStateVars, WorkerVars>>

RevokeSessionGrant(session, newEpoch) ==
    /\ authorityAvailable
    /\ session \in SessionIds
    /\ newEpoch \in GrantEpochs
    /\ newEpoch > grantEpoch[session]
    /\ sessionGrant' = [sessionGrant EXCEPT ![session] = NoGrant]
    /\ grantEpoch' = [grantEpoch EXCEPT ![session] = newEpoch]
    /\ grantRights' = [grantRights EXCEPT ![session] = {}]
    /\ grantDeviations' = [grantDeviations EXCEPT ![session] = {}]
    /\ UNCHANGED <<AvailabilityVars, PolicyVars, currentIncarnation,
                   usedIncarnations, currentEnforcerGeneration,
                   usedEnforcerGenerations, RequestVars, DecisionVars,
                   AdmissionVars, TransportStateVars, WorkerVars>>

RecreateSession(session, newIncarnation, newEpoch) ==
    /\ authorityAvailable
    /\ session \in SessionIds
    /\ newIncarnation \in
        SessionIncarnations \ usedIncarnations[session]
    /\ newEpoch \in GrantEpochs
    /\ newEpoch > grantEpoch[session]
    /\ currentIncarnation' =
        [currentIncarnation EXCEPT ![session] = newIncarnation]
    /\ usedIncarnations' =
        [usedIncarnations EXCEPT ![session] = @ \cup {newIncarnation}]
    /\ sessionGrant' = [sessionGrant EXCEPT ![session] = NoGrant]
    /\ grantEpoch' = [grantEpoch EXCEPT ![session] = newEpoch]
    /\ grantRights' = [grantRights EXCEPT ![session] = {}]
    /\ grantDeviations' = [grantDeviations EXCEPT ![session] = {}]
    /\ UNCHANGED <<AvailabilityVars, PolicyVars, currentEnforcerGeneration,
                   usedEnforcerGenerations, RequestVars, DecisionVars,
                   AdmissionVars, TransportStateVars, WorkerVars>>

RotateEnforcerGeneration(newGeneration) ==
    /\ authorityAvailable
    /\ newGeneration \in
        EnforcerGenerations \ usedEnforcerGenerations
    /\ currentEnforcerGeneration' = newGeneration
    /\ usedEnforcerGenerations' =
        usedEnforcerGenerations \cup {newGeneration}
    /\ UNCHANGED <<AvailabilityVars, PolicyVars, currentIncarnation,
                   usedIncarnations, sessionGrant, grantEpoch, grantRights,
                   grantDeviations, RequestVars, DecisionVars, AdmissionVars,
                   TransportStateVars, WorkerVars>>

SetAuthorityAvailability(value) ==
    /\ value \in BOOLEAN
    /\ value # authorityAvailable
    /\ authorityAvailable' = value
    /\ UNCHANGED <<gatewayAvailable, providerAvailable,
                   effectTransportAvailable, outputTransportAvailable,
                   PolicyVars, SessionVars, RequestVars, DecisionVars,
                   AdmissionVars, TransportStateVars, WorkerVars>>

CrashGateway ==
    /\ gatewayAvailable
    /\ gatewayAvailable' = FALSE
    /\ needsReconciliation' =
        needsReconciliation \cup
            {r \in effectAttempted : effectOutcome[r] = UnknownOutcome}
    /\ UNCHANGED <<authorityAvailable, providerAvailable,
                   effectTransportAvailable, outputTransportAvailable,
                   PolicyVars, SessionVars, RequestVars, DecisionVars,
                   AdmissionVars, abandonedBeforeSend, gatewaySent,
                   admissionCount, sendCount, completed, inferenceCompleted,
                   effectAttempted, outputReleased, effectOutcome, WorkerVars>>

RecoverGateway ==
    /\ ~gatewayAvailable
    /\ gatewayAvailable' = TRUE
    /\ UNCHANGED <<authorityAvailable, providerAvailable,
                   effectTransportAvailable, outputTransportAvailable,
                   PolicyVars, SessionVars, RequestVars, DecisionVars,
                   AdmissionVars, TransportStateVars, WorkerVars>>

SetProviderAvailability(value) ==
    /\ value \in BOOLEAN
    /\ value # providerAvailable
    /\ providerAvailable' = value
    /\ UNCHANGED <<authorityAvailable, gatewayAvailable,
                   effectTransportAvailable, outputTransportAvailable,
                   PolicyVars, SessionVars, RequestVars, DecisionVars,
                   AdmissionVars, TransportStateVars, WorkerVars>>

SetEffectTransportAvailability(value) ==
    /\ value \in BOOLEAN
    /\ value # effectTransportAvailable
    /\ effectTransportAvailable' = value
    /\ UNCHANGED <<authorityAvailable, gatewayAvailable, providerAvailable,
                   outputTransportAvailable, PolicyVars, SessionVars,
                   RequestVars, DecisionVars, AdmissionVars,
                   TransportStateVars, WorkerVars>>

SetOutputTransportAvailability(value) ==
    /\ value \in BOOLEAN
    /\ value # outputTransportAvailable
    /\ outputTransportAvailable' = value
    /\ UNCHANGED <<authorityAvailable, gatewayAvailable, providerAvailable,
                   effectTransportAvailable, PolicyVars, SessionVars,
                   RequestVars, DecisionVars, AdmissionVars,
                   TransportStateVars, WorkerVars>>

CacheDecision(w, r) ==
    /\ w \in Workers
    /\ r \in decisionConsumed
    /\ r \notin workerCache[w]
    /\ workerCache' = [workerCache EXCEPT ![w] = @ \cup {r}]
    /\ workerReceipts' =
        [workerReceipts EXCEPT ![w] = @ \cup {r}]
    /\ UNCHANGED <<AvailabilityVars, PolicyVars, SessionVars, RequestVars,
                   DecisionVars, AdmissionVars, TransportStateVars,
                   retryCount, receiptAttempts>>

CloneWorkerState(sourceWorker, destinationWorker) ==
    /\ sourceWorker \in Workers
    /\ destinationWorker \in Workers
    /\ sourceWorker # destinationWorker
    /\ workerCache' =
        [workerCache EXCEPT ![destinationWorker] = workerCache[sourceWorker]]
    /\ workerReceipts' =
        [workerReceipts EXCEPT
            ![destinationWorker] = workerReceipts[sourceWorker]]
    /\ UNCHANGED <<AvailabilityVars, PolicyVars, SessionVars, RequestVars,
                   DecisionVars, AdmissionVars, TransportStateVars,
                   retryCount, receiptAttempts>>

PresentReceipt(w, r) ==
    /\ w \in Workers
    /\ r \in workerReceipts[w]
    /\ <<w, r>> \notin receiptAttempts
    /\ receiptAttempts' = receiptAttempts \cup {<<w, r>>}
    /\ UNCHANGED <<AvailabilityVars, PolicyVars, SessionVars, RequestVars,
                   DecisionVars, AdmissionVars, TransportStateVars,
                   retryCount, workerCache, workerReceipts>>

Next ==
    \/ \E r \in RequestIds, s \in SessionIds,
          i \in SessionIncarnations, g \in EnforcerGenerations,
          t \in TargetKinds, source \in RequestIds \cup {NoRequest} :
          QueueNewIntent(r, s, i, g, t, source)
    \/ \E r \in RequestIds, retry \in RetryCounts :
          RetryIntent(r, retry)
    \/ \E r \in RequestIds : ProcessFor(r)
    \/ \E r \in RequestIds : CompleteInference(r)
    \/ \E r \in RequestIds : ResolveEffectFor(r)
    \/ \E op \in CustomOps, p \in PolicyDigests,
          ceiling \in SUBSET HigherConstraint :
          ApplyCustom(op, p, ceiling)
    \/ \E s \in SessionIds, g \in GrantIds, e \in GrantEpochs,
          rights \in SUBSET HigherConstraint,
          deviations \in SUBSET DeviationGrantIds :
          InstallSessionGrant(s, g, e, rights, deviations)
    \/ \E s \in SessionIds, e \in GrantEpochs :
          RevokeSessionGrant(s, e)
    \/ \E s \in SessionIds, i \in SessionIncarnations,
          e \in GrantEpochs : RecreateSession(s, i, e)
    \/ \E g \in EnforcerGenerations : RotateEnforcerGeneration(g)
    \/ \E value \in BOOLEAN : SetAuthorityAvailability(value)
    \/ CrashGateway
    \/ RecoverGateway
    \/ \E value \in BOOLEAN : SetProviderAvailability(value)
    \/ \E value \in BOOLEAN : SetEffectTransportAvailability(value)
    \/ \E value \in BOOLEAN : SetOutputTransportAvailability(value)
    \/ \E w \in Workers, r \in RequestIds : CacheDecision(w, r)
    \/ \E source \in Workers, destination \in Workers :
          CloneWorkerState(source, destination)
    \/ \E w \in Workers, r \in RequestIds : PresentReceipt(w, r)

TypeOK ==
    /\ authorityAvailable \in BOOLEAN
    /\ gatewayAvailable \in BOOLEAN
    /\ providerAvailable \in BOOLEAN
    /\ effectTransportAvailable \in BOOLEAN
    /\ outputTransportAvailable \in BOOLEAN
    /\ currentPolicy \in PolicyDigests
    /\ policyCeiling \subseteq HigherConstraint
    /\ usedPolicies \subseteq PolicyDigests
    /\ lastCustomOp \in CustomOps
    /\ currentIncarnation \in
        [SessionIds -> SessionIncarnations]
    /\ usedIncarnations \in
        [SessionIds -> SUBSET SessionIncarnations]
    /\ currentEnforcerGeneration \in EnforcerGenerations
    /\ usedEnforcerGenerations \subseteq EnforcerGenerations
    /\ sessionGrant \in [SessionIds -> GrantIds \cup {NoGrant}]
    /\ grantEpoch \in [SessionIds -> GrantEpochs]
    /\ grantRights \in [SessionIds -> SUBSET HigherConstraint]
    /\ grantDeviations \in
        [SessionIds -> SUBSET DeviationGrantIds]
    /\ knownRequests \subseteq RequestIds
    /\ intentQueued \subseteq knownRequests
    /\ requestSession \in [RequestIds -> SessionIds]
    /\ requestIncarnation \in
        [RequestIds -> SessionIncarnations]
    /\ requestGeneration \in
        [RequestIds -> EnforcerGenerations]
    /\ requestTarget \in [RequestIds -> TargetKinds]
    /\ requestSource \in [RequestIds -> RequestIds \cup {NoRequest}]
    /\ decisionConsumed \subseteq knownRequests
    /\ decisionAllowed \subseteq decisionConsumed
    /\ decisionDenied \subseteq decisionConsumed
    /\ decisionAudited \subseteq decisionConsumed
    /\ duplicateRejected \subseteq knownRequests
    /\ decisionPolicy \in
        [RequestIds -> PolicyDigests \cup {NoPolicy}]
    /\ decisionGrant \in [RequestIds -> GrantIds \cup {NoGrant}]
    /\ decisionGrantEpoch \in [RequestIds -> GrantEpochs]
    /\ decisionIncarnation \in
        [RequestIds -> SessionIncarnations]
    /\ decisionGeneration \in
        [RequestIds -> EnforcerGenerations]
    /\ decisionTarget \in [RequestIds -> TargetKinds]
    /\ admitted \subseteq decisionAllowed
    /\ admissionPolicy \in
        [RequestIds -> PolicyDigests \cup {NoPolicy}]
    /\ admissionCeiling \in [RequestIds -> SUBSET HigherConstraint]
    /\ admissionGrant \in [RequestIds -> GrantIds \cup {NoGrant}]
    /\ admissionGrantEpoch \in [RequestIds -> GrantEpochs]
    /\ admissionRights \in [RequestIds -> SUBSET HigherConstraint]
    /\ admissionDeviations \in
        [RequestIds -> SUBSET DeviationGrantIds]
    /\ admissionIncarnation \in
        [RequestIds -> SessionIncarnations]
    /\ admissionGeneration \in
        [RequestIds -> EnforcerGenerations]
    /\ DOMAIN admissionCharter = RequestIds
    /\ DOMAIN admissionRenderManifest = RequestIds
    /\ abandonedBeforeSend \subseteq admitted
    /\ gatewaySent \subseteq admitted
    /\ admissionCount \in [RequestIds -> {0, 1}]
    /\ sendCount \in [RequestIds -> {0, 1}]
    /\ completed \subseteq gatewaySent
    /\ inferenceCompleted \subseteq completed
    /\ effectAttempted \subseteq gatewaySent
    /\ outputReleased \subseteq gatewaySent
    /\ effectOutcome \in
        [RequestIds ->
            {NoOutcome, UnknownOutcome, SuccessOutcome, FailureOutcome}]
    /\ needsReconciliation \subseteq effectAttempted
    /\ retryCount \in [RequestIds -> RetryCounts]
    /\ workerCache \in [Workers -> SUBSET RequestIds]
    /\ workerReceipts \in [Workers -> SUBSET RequestIds]
    /\ receiptAttempts \subseteq Workers \X RequestIds

MatchingAdmission(r) ==
    /\ r \in admitted
    /\ r \in decisionAllowed
    /\ r \in decisionAudited
    /\ admissionPolicy[r] \in PolicyDigests
    /\ admissionGrant[r] \in GrantIds
    /\ requestTarget[r] \in admissionRights[r]
    /\ requestTarget[r] \in admissionCeiling[r]
    /\ requestTarget[r] \in HigherConstraint
    /\ admissionCharter[r] =
        SemanticCharter(
            r, admissionPolicy[r], admissionCeiling[r],
            admissionGrant[r], admissionGrantEpoch[r],
            admissionRights[r], admissionDeviations[r],
            admissionIncarnation[r], admissionGeneration[r],
            requestTarget[r], requestSource[r])
    /\ admissionRenderManifest[r] =
        RenderManifest(r, admissionCharter[r])

NoActionWithoutMatchingAdmission ==
    /\ \A r \in admitted : MatchingAdmission(r)
    /\ \A r \in gatewaySent : MatchingAdmission(r)
    /\ \A r \in effectAttempted : MatchingAdmission(r)
    /\ \A r \in outputReleased : MatchingAdmission(r)

AtomicAdmissionAndOutcome ==
    /\ admitted = gatewaySent \cup abandonedBeforeSend
    /\ gatewaySent \cap abandonedBeforeSend = {}
    /\ \A r \in RequestIds :
        (admissionCount[r] = 1) <=> (r \in admitted)

AtMostOneLocalGatewaySend ==
    /\ gatewaySent \subseteq admitted
    /\ \A r \in RequestIds :
        (sendCount[r] = 1) <=> (r \in gatewaySent)

AtMostOneAuthoritativeEnqueue ==
    \A r \in RequestIds :
        /\ admissionCount[r] <= 1
        /\ sendCount[r] <= 1

DecisionRecordsAreNonAuthorizing ==
    /\ decisionConsumed = decisionAllowed \cup decisionDenied
    /\ decisionAllowed \cap decisionDenied = {}
    /\ decisionAudited = decisionConsumed
    /\ decisionDenied \cap admitted = {}
    /\ \A w \in Workers :
        \A r \in workerReceipts[w] :
            r \notin admitted => r \notin gatewaySent

PolicyBasisIsDeviationFree ==
    \A r \in admitted :
        admissionCharter[r].policyBasis.deviations = {}

ExactDeviationGrants ==
    \A r \in admitted :
        admissionCharter[r].exactDeviationGrants =
            admissionDeviations[r]

SemanticAndRenderArtifactsAreSeparate ==
    \A r \in admitted :
        /\ admissionCharter[r].kind = "SemanticCharter"
        /\ admissionRenderManifest[r].kind = "RenderManifest"
        /\ admissionCharter[r] # admissionRenderManifest[r]

SessionGrantIsSolePositiveAuthority ==
    \A r \in admitted :
        /\ admissionGrant[r] \in GrantIds
        /\ requestTarget[r] \in admissionRights[r]
        /\ admissionCharter[r].effectiveTargets
            \subseteq admissionRights[r] \cap HigherConstraint

TypedGatewayTargets ==
    /\ \A r \in inferenceCompleted :
        requestTarget[r] = InferenceTarget
    /\ \A r \in effectAttempted :
        requestTarget[r] = EffectTarget
    /\ \A r \in outputReleased :
        requestTarget[r] = OutputReleaseTarget

NewAdmissionUsesCurrentDecision ==
    \A r \in RequestIds :
        r \notin admitted /\ r \in admitted'
        => /\ authorityAvailable
           /\ gatewayAvailable
           /\ AuthorizationCurrent(r)
           /\ TransportAvailable(requestTarget[r])
           /\ admissionPolicy'[r] = currentPolicy
           /\ admissionGrant'[r] = sessionGrant[requestSession[r]]
           /\ admissionGrantEpoch'[r] = grantEpoch[requestSession[r]]
           /\ admissionIncarnation'[r] =
                currentIncarnation[requestSession[r]]
           /\ admissionGeneration'[r] = currentEnforcerGeneration
           /\ admissionCount'[r] = 1

AdmissionLinearizesAtCurrentState ==
    [][NewAdmissionUsesCurrentDecision]_vars

NewDownstreamAdmissionUsesCurrentInference ==
    \A r \in RequestIds :
        /\ r \notin admitted
        /\ r \in admitted'
        /\ requestTarget[r] \in {EffectTarget, OutputReleaseTarget}
        => SourceInferenceCurrent(r)

HeadOrGrantChangeBlocksStaleDownstream ==
    [][NewDownstreamAdmissionUsesCurrentInference]_vars

NewLocalSendIsSameFreshTransition ==
    \A r \in RequestIds :
        r \notin gatewaySent /\ r \in gatewaySent'
        => /\ r \notin admitted
           /\ r \in admitted'
           /\ AuthorizationCurrent(r)
           /\ TransportAvailable(requestTarget[r])
           /\ sendCount'[r] = 1

NoCachedAllowSurvivesDelay ==
    [][NewLocalSendIsSameFreshTransition]_vars

CustomsDoNotWiden ==
    /\ policyCeiling' \subseteq policyCeiling
    /\ \A s \in SessionIds :
        grantRights'[s] \subseteq HigherConstraint

LowerLayersNeverWiden == [][CustomsDoNotWiden]_vars

ServiceAvailableFor(r) ==
    /\ authorityAvailable
    /\ gatewayAvailable
    /\ TransportAvailable(requestTarget[r])

ConditionalGatewayLiveness ==
    \A r \in RequestIds :
        <>[]ServiceAvailableFor(r)
        => (r \in intentQueued ~> r \notin intentQueued)

ConditionalInferenceCompletion ==
    \A r \in RequestIds :
        <>[](gatewayAvailable /\ providerAvailable)
        => (r \in gatewaySent /\ requestTarget[r] = InferenceTarget
             ~> r \in inferenceCompleted)

ConditionalEffectReconciliation ==
    \A r \in RequestIds :
        <>[](gatewayAvailable /\ effectTransportAvailable)
        => (r \in needsReconciliation
             ~> effectOutcome[r] \in FinalOutcomes)

Spec ==
    /\ Init
    /\ [][Next]_vars
    /\ \A r \in RequestIds : WF_vars(ProcessFor(r))
    /\ \A r \in RequestIds : WF_vars(CompleteInference(r))
    /\ \A r \in RequestIds : WF_vars(ResolveEffectFor(r))

=============================================================================
