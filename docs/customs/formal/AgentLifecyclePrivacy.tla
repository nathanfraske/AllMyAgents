----------------------- MODULE AgentLifecyclePrivacy -----------------------
EXTENDS FiniteSets, TLC

\* A bounded candidate model for AgentId lifecycle, personal Custom adoption,
\* project promotion, private principal mappings, and capsule privacy.

CONSTANTS
    AgentIds, Names, ProjectIds, ProjectPrincipals,
    DraftIds, NormBodies, PermissionAtoms, CustomIds, CapsuleIds,
    ProjectAuthorities, AgentAuthorities,
    InitialAgent, InitialName, InitialProject, InitialPrincipal,
    InitialProjectAuthority, InitialAgentAuthority,
    NoAgent, NoName, NoProject, NoPrincipal, NoDraft, NoBody, NoKind,
    NoCustom, NoAuthority, NoMode

NormKinds == {"Guard", "Requirement", "Guidance", "Evaluation"}
CustomModes == {"shadow", "trial", "active"}
ScopedPairs == ProjectIds \X ProjectPrincipals
MappingUniverse ==
    {<<p, principal, agent>> :
        p \in ProjectIds,
        principal \in ProjectPrincipals,
        agent \in AgentIds}
AdoptionUniverse == AgentIds \X DraftIds
OverlayUniverse ==
    {<<p, principal, agent, draft>> :
        p \in ProjectIds,
        principal \in ProjectPrincipals,
        agent \in AgentIds,
        draft \in DraftIds}
PromotionUniverse == ProjectIds \X DraftIds
FailedOverlayUniverse ==
    {<<p, principal, draft>> :
        p \in ProjectIds,
        principal \in ProjectPrincipals,
        draft \in DraftIds}

ASSUME /\ IsFiniteSet(AgentIds)
       /\ IsFiniteSet(Names)
       /\ IsFiniteSet(ProjectIds)
       /\ IsFiniteSet(ProjectPrincipals)
       /\ IsFiniteSet(DraftIds)
       /\ IsFiniteSet(NormBodies)
       /\ IsFiniteSet(PermissionAtoms)
       /\ IsFiniteSet(CustomIds)
       /\ IsFiniteSet(CapsuleIds)
       /\ IsFiniteSet(ProjectAuthorities)
       /\ IsFiniteSet(AgentAuthorities)
       /\ InitialAgent \in AgentIds
       /\ InitialName \in Names
       /\ InitialProject \in ProjectIds
       /\ InitialPrincipal \in ProjectPrincipals
       /\ InitialProjectAuthority \in ProjectAuthorities
       /\ InitialAgentAuthority \in AgentAuthorities
       /\ ProjectAuthorities \cap AgentAuthorities = {}
       /\ AgentIds \cap
            (Names \cup ProjectIds \cup ProjectPrincipals \cup
             DraftIds \cup NormBodies \cup CustomIds \cup CapsuleIds \cup
             ProjectAuthorities \cup AgentAuthorities) = {}
       /\ NoAgent \notin AgentIds
       /\ NoName \notin Names
       /\ NoProject \notin ProjectIds
       /\ NoPrincipal \notin ProjectPrincipals
       /\ NoDraft \notin DraftIds
       /\ NoBody \notin NormBodies
       /\ NoKind \notin NormKinds
       /\ NoCustom \notin CustomIds
       /\ NoAuthority \notin
            ProjectAuthorities \cup AgentAuthorities
       /\ NoMode \notin CustomModes

VARIABLES
    activeAgents,
    retiredAgents,
    displayName,
    agentAuthority,
    agentAuthorityAvailable,
    agentCeiling,
    selfAdoptCapability,
    projectAuthority,
    projectAuthorityAvailable,
    projectCeiling,
    privateMap,
    mappingCandidates,
    quarantinedMappings,
    ambiguousPairs,
    failedOverlayRequests,
    drafts,
    draftCandidates,
    authenticatedDraftCandidates,
    importedDrafts,
    quarantinedDrafts,
    draftBody,
    draftKind,
    draftAuthor,
    draftRights,
    shadowAdoptions,
    trialOverlays,
    activeOverlays,
    pendingPromotions,
    customs,
    customCandidates,
    importedCustoms,
    promotedCustoms,
    quarantinedCustoms,
    customProject,
    customSourceDraft,
    customBody,
    customAuthority,
    customRights,
    customMode,
    capsules,
    capsuleProject,
    capsulePrincipal,
    capsuleCustom,
    capsuleBody

vars ==
    <<activeAgents, retiredAgents, displayName, agentAuthority,
      agentAuthorityAvailable, agentCeiling, selfAdoptCapability,
      projectAuthority, projectAuthorityAvailable, projectCeiling, privateMap,
      mappingCandidates, quarantinedMappings, ambiguousPairs,
      failedOverlayRequests, drafts, draftCandidates,
      authenticatedDraftCandidates, importedDrafts, quarantinedDrafts,
      draftBody, draftKind, draftAuthor, draftRights, shadowAdoptions,
      trialOverlays, activeOverlays, pendingPromotions, customs,
      customCandidates, importedCustoms, promotedCustoms, quarantinedCustoms,
      customProject, customSourceDraft, customBody, customAuthority,
      customRights, customMode, capsules, capsuleProject, capsulePrincipal,
      capsuleCustom, capsuleBody>>

AgentVars ==
    <<activeAgents, retiredAgents, displayName, agentAuthority,
      agentAuthorityAvailable, agentCeiling, selfAdoptCapability>>

ProjectVars ==
    <<projectAuthority, projectAuthorityAvailable, projectCeiling>>

MappingVars ==
    <<privateMap, mappingCandidates, quarantinedMappings, ambiguousPairs,
      failedOverlayRequests>>

DraftVars ==
    <<drafts, draftCandidates, authenticatedDraftCandidates, importedDrafts,
      quarantinedDrafts, draftBody, draftKind, draftAuthor, draftRights>>

AdoptionVars ==
    <<shadowAdoptions, trialOverlays, activeOverlays, pendingPromotions>>

CustomVars ==
    <<customs, customCandidates, importedCustoms, promotedCustoms,
      quarantinedCustoms, customProject, customSourceDraft, customBody,
      customAuthority, customRights, customMode>>

CapsuleVars ==
    <<capsules, capsuleProject, capsulePrincipal, capsuleCustom, capsuleBody>>

Init ==
    /\ activeAgents = {InitialAgent}
    /\ retiredAgents = {}
    /\ displayName =
        [a \in AgentIds |->
            IF a = InitialAgent THEN InitialName ELSE NoName]
    /\ agentAuthority =
        [a \in AgentIds |->
            IF a = InitialAgent
                THEN InitialAgentAuthority
                ELSE NoAuthority]
    /\ agentAuthorityAvailable = TRUE
    /\ agentCeiling =
        [a \in AgentIds |->
            IF a = InitialAgent THEN PermissionAtoms ELSE {}]
    /\ selfAdoptCapability = {}
    /\ projectAuthority =
        [p \in ProjectIds |->
            IF p = InitialProject
                THEN InitialProjectAuthority
                ELSE NoAuthority]
    /\ projectAuthorityAvailable =
        [p \in ProjectIds |-> p = InitialProject]
    /\ projectCeiling =
        [p \in ProjectIds |-> PermissionAtoms]
    /\ privateMap =
        {<<InitialProject, InitialPrincipal, InitialAgent>>}
    /\ mappingCandidates = {}
    /\ quarantinedMappings = {}
    /\ ambiguousPairs = {}
    /\ failedOverlayRequests = {}
    /\ drafts = {}
    /\ draftCandidates = {}
    /\ authenticatedDraftCandidates = {}
    /\ importedDrafts = {}
    /\ quarantinedDrafts = {}
    /\ draftBody = [d \in DraftIds |-> NoBody]
    /\ draftKind = [d \in DraftIds |-> NoKind]
    /\ draftAuthor = [d \in DraftIds |-> NoAgent]
    /\ draftRights = [d \in DraftIds |-> {}]
    /\ shadowAdoptions = {}
    /\ trialOverlays = {}
    /\ activeOverlays = {}
    /\ pendingPromotions = {}
    /\ customs = {}
    /\ customCandidates = {}
    /\ importedCustoms = {}
    /\ promotedCustoms = {}
    /\ quarantinedCustoms = {}
    /\ customProject = [c \in CustomIds |-> NoProject]
    /\ customSourceDraft = [c \in CustomIds |-> NoDraft]
    /\ customBody = [c \in CustomIds |-> NoBody]
    /\ customAuthority = [c \in CustomIds |-> NoAuthority]
    /\ customRights = [c \in CustomIds |-> {}]
    /\ customMode = [c \in CustomIds |-> NoMode]
    /\ capsules = {}
    /\ capsuleProject = [x \in CapsuleIds |-> NoProject]
    /\ capsulePrincipal = [x \in CapsuleIds |-> NoPrincipal]
    /\ capsuleCustom = [x \in CapsuleIds |-> NoCustom]
    /\ capsuleBody = [x \in CapsuleIds |-> NoBody]

UnusedName(name) ==
    \A a \in activeAgents : displayName[a] # name

EnrollAgent(agent, name, authority) ==
    /\ agent \in AgentIds \ (activeAgents \cup retiredAgents)
    /\ name \in Names
    /\ UnusedName(name)
    /\ authority \in AgentAuthorities
    /\ activeAgents' = activeAgents \cup {agent}
    /\ displayName' = [displayName EXCEPT ![agent] = name]
    /\ agentAuthority' =
        [agentAuthority EXCEPT ![agent] = authority]
    /\ agentCeiling' =
        [agentCeiling EXCEPT ![agent] = PermissionAtoms]
    /\ UNCHANGED <<retiredAgents, agentAuthorityAvailable,
                   selfAdoptCapability, ProjectVars, MappingVars, DraftVars,
                   AdoptionVars, CustomVars, CapsuleVars>>

RenameAgent(agent, name) ==
    /\ agent \in activeAgents
    /\ name \in Names
    /\ name # displayName[agent]
    /\ UnusedName(name)
    /\ displayName' = [displayName EXCEPT ![agent] = name]
    /\ UNCHANGED <<activeAgents, retiredAgents, agentAuthority,
                   agentAuthorityAvailable, agentCeiling, selfAdoptCapability,
                   ProjectVars, MappingVars, DraftVars, AdoptionVars,
                   CustomVars, CapsuleVars>>

IssueSelfAdoptCapability(agent) ==
    /\ agentAuthorityAvailable
    /\ agent \in activeAgents
    /\ agentAuthority[agent] \in AgentAuthorities
    /\ agent \notin selfAdoptCapability
    /\ selfAdoptCapability' = selfAdoptCapability \cup {agent}
    /\ UNCHANGED <<activeAgents, retiredAgents, displayName, agentAuthority,
                   agentAuthorityAvailable, agentCeiling, ProjectVars,
                   MappingVars, DraftVars, AdoptionVars, CustomVars,
                   CapsuleVars>>

InstallProjectAuthority(project, authority) ==
    /\ project \in ProjectIds
    /\ projectAuthority[project] = NoAuthority
    /\ authority \in ProjectAuthorities
    /\ projectAuthority' =
        [projectAuthority EXCEPT ![project] = authority]
    /\ projectAuthorityAvailable' =
        [projectAuthorityAvailable EXCEPT ![project] = TRUE]
    /\ UNCHANGED <<AgentVars, projectCeiling, MappingVars, DraftVars,
                   AdoptionVars, CustomVars, CapsuleVars>>

SetProjectAuthorityAvailability(project, value) ==
    /\ project \in ProjectIds
    /\ projectAuthority[project] \in ProjectAuthorities
    /\ value \in BOOLEAN
    /\ value # projectAuthorityAvailable[project]
    /\ projectAuthorityAvailable' =
        [projectAuthorityAvailable EXCEPT ![project] = value]
    /\ UNCHANGED <<AgentVars, projectAuthority, projectCeiling, MappingVars,
                   DraftVars, AdoptionVars, CustomVars, CapsuleVars>>

SetAgentAuthorityAvailability(value) ==
    /\ value \in BOOLEAN
    /\ value # agentAuthorityAvailable
    /\ agentAuthorityAvailable' = value
    /\ UNCHANGED <<activeAgents, retiredAgents, displayName, agentAuthority,
                   agentCeiling, selfAdoptCapability, ProjectVars, MappingVars,
                   DraftVars, AdoptionVars, CustomVars, CapsuleVars>>

Owners(project, principal) ==
    {agent \in AgentIds :
        <<project, principal, agent>> \in privateMap}

UniqueOwner(project, principal, agent) ==
    /\ <<project, principal>> \notin ambiguousPairs
    /\ Owners(project, principal) = {agent}

CanAcceptMapping(project, principal, agent) ==
    /\ agent \in activeAgents
    /\ <<project, principal>> \notin ambiguousPairs
    /\ \A other \in AgentIds :
        <<project, principal, other>> \in privateMap => other = agent
    /\ \A otherPrincipal \in ProjectPrincipals :
        <<project, otherPrincipal, agent>> \in privateMap
            => otherPrincipal = principal

StageMappingImport(project, principal, agent) ==
    /\ project \in ProjectIds
    /\ principal \in ProjectPrincipals
    /\ agent \in AgentIds
    /\ <<project, principal, agent>> \notin mappingCandidates
    /\ mappingCandidates' =
        mappingCandidates \cup {<<project, principal, agent>>}
    /\ UNCHANGED <<AgentVars, ProjectVars, privateMap,
                   quarantinedMappings, ambiguousPairs,
                   failedOverlayRequests, DraftVars, AdoptionVars,
                   CustomVars, CapsuleVars>>

AcceptMappingImport(project, principal, agent) ==
    /\ <<project, principal, agent>> \in mappingCandidates
    /\ CanAcceptMapping(project, principal, agent)
    /\ privateMap' =
        privateMap \cup {<<project, principal, agent>>}
    /\ mappingCandidates' =
        mappingCandidates \ {<<project, principal, agent>>}
    /\ UNCHANGED <<AgentVars, ProjectVars, quarantinedMappings,
                   ambiguousPairs, failedOverlayRequests, DraftVars,
                   AdoptionVars, CustomVars, CapsuleVars>>

QuarantineAmbiguousMapping(project, principal, agent) ==
    /\ <<project, principal, agent>> \in mappingCandidates
    /\ ~CanAcceptMapping(project, principal, agent)
    /\ LET affected ==
        {pair \in ScopedPairs :
            /\ pair[1] = project
            /\ \/ pair = <<project, principal>>
               \/ <<project, pair[2], agent>> \in privateMap}
       IN
       /\ mappingCandidates' =
            mappingCandidates \ {<<project, principal, agent>>}
       /\ quarantinedMappings' =
            quarantinedMappings \cup {<<project, principal, agent>>}
       /\ ambiguousPairs' = ambiguousPairs \cup affected
       /\ trialOverlays' =
            {overlay \in trialOverlays :
                <<overlay[1], overlay[2]>> \notin affected}
       /\ activeOverlays' =
            {overlay \in activeOverlays :
                <<overlay[1], overlay[2]>> \notin affected}
    /\ UNCHANGED <<AgentVars, ProjectVars, privateMap,
                   failedOverlayRequests, DraftVars, shadowAdoptions,
                   pendingPromotions, CustomVars, CapsuleVars>>

ReviewMappingFor(project, principal, agent) ==
    AcceptMappingImport(project, principal, agent) \/
        QuarantineAmbiguousMapping(project, principal, agent)

ResolveMappingAmbiguity(project, principal) ==
    /\ projectAuthorityAvailable[project]
    /\ <<project, principal>> \in ambiguousPairs
    /\ ambiguousPairs' =
        ambiguousPairs \ {<<project, principal>>}
    /\ UNCHANGED <<AgentVars, ProjectVars, privateMap, mappingCandidates,
                   quarantinedMappings, failedOverlayRequests, DraftVars,
                   AdoptionVars, CustomVars, CapsuleVars>>

EraseMapping(project, principal, agent) ==
    /\ projectAuthorityAvailable[project]
    /\ <<project, principal, agent>> \in privateMap
    /\ privateMap' =
        privateMap \ {<<project, principal, agent>>}
    /\ ambiguousPairs' =
        ambiguousPairs \ {<<project, principal>>}
    /\ trialOverlays' =
        {overlay \in trialOverlays :
            <<overlay[1], overlay[2], overlay[3]>>
                # <<project, principal, agent>>}
    /\ activeOverlays' =
        {overlay \in activeOverlays :
            <<overlay[1], overlay[2], overlay[3]>>
                # <<project, principal, agent>>}
    /\ UNCHANGED <<AgentVars, ProjectVars, mappingCandidates,
                   quarantinedMappings, failedOverlayRequests, DraftVars,
                   shadowAdoptions, pendingPromotions, CustomVars,
                   CapsuleVars>>

UnusedDraft(draft) ==
    draft \notin drafts \cup draftCandidates \cup quarantinedDrafts

AuthorDraft(agent, draft, body, kind, rights) ==
    /\ agent \in activeAgents
    /\ draft \in DraftIds
    /\ UnusedDraft(draft)
    /\ body \in NormBodies
    /\ kind \in NormKinds
    /\ rights \subseteq PermissionAtoms
    /\ drafts' = drafts \cup {draft}
    /\ draftBody' = [draftBody EXCEPT ![draft] = body]
    /\ draftKind' = [draftKind EXCEPT ![draft] = kind]
    /\ draftAuthor' = [draftAuthor EXCEPT ![draft] = agent]
    /\ draftRights' = [draftRights EXCEPT ![draft] = rights]
    /\ UNCHANGED <<AgentVars, ProjectVars, MappingVars, draftCandidates,
                   authenticatedDraftCandidates, importedDrafts,
                   quarantinedDrafts, AdoptionVars, CustomVars, CapsuleVars>>

StageDraftImport(agent, draft, body, kind, rights, authenticated) ==
    /\ agent \in AgentIds
    /\ draft \in DraftIds
    /\ UnusedDraft(draft)
    /\ body \in NormBodies
    /\ kind \in NormKinds
    /\ rights \subseteq PermissionAtoms
    /\ authenticated \in BOOLEAN
    /\ draftCandidates' = draftCandidates \cup {draft}
    /\ authenticatedDraftCandidates' =
        IF authenticated
            THEN authenticatedDraftCandidates \cup {draft}
            ELSE authenticatedDraftCandidates
    /\ draftBody' = [draftBody EXCEPT ![draft] = body]
    /\ draftKind' = [draftKind EXCEPT ![draft] = kind]
    /\ draftAuthor' = [draftAuthor EXCEPT ![draft] = agent]
    /\ draftRights' = [draftRights EXCEPT ![draft] = rights]
    /\ UNCHANGED <<AgentVars, ProjectVars, MappingVars, drafts,
                   importedDrafts, quarantinedDrafts, AdoptionVars,
                   CustomVars, CapsuleVars>>

ValidDraftCandidate(draft) ==
    /\ draft \in draftCandidates
    /\ draft \in authenticatedDraftCandidates
    /\ draftBody[draft] \in NormBodies
    /\ draftKind[draft] \in NormKinds
    /\ draftAuthor[draft] \in activeAgents

AcceptDraftImport(draft) ==
    /\ ValidDraftCandidate(draft)
    /\ drafts' = drafts \cup {draft}
    /\ importedDrafts' = importedDrafts \cup {draft}
    /\ draftCandidates' = draftCandidates \ {draft}
    /\ authenticatedDraftCandidates' =
        authenticatedDraftCandidates \ {draft}
    /\ UNCHANGED <<AgentVars, ProjectVars, MappingVars, quarantinedDrafts,
                   draftBody, draftKind, draftAuthor, draftRights,
                   AdoptionVars, CustomVars, CapsuleVars>>

QuarantineDraftImport(draft) ==
    /\ draft \in draftCandidates
    /\ ~ValidDraftCandidate(draft)
    /\ quarantinedDrafts' = quarantinedDrafts \cup {draft}
    /\ draftCandidates' = draftCandidates \ {draft}
    /\ authenticatedDraftCandidates' =
        authenticatedDraftCandidates \ {draft}
    /\ UNCHANGED <<AgentVars, ProjectVars, MappingVars, drafts,
                   importedDrafts, draftBody, draftKind, draftAuthor,
                   draftRights, AdoptionVars, CustomVars, CapsuleVars>>

ReviewDraftFor(draft) ==
    AcceptDraftImport(draft) \/ QuarantineDraftImport(draft)

NarrowAgentCeiling(agent, newCeiling) ==
    /\ agent \in activeAgents
    /\ newCeiling \subseteq agentCeiling[agent]
    /\ newCeiling # agentCeiling[agent]
    /\ agentCeiling' =
        [agentCeiling EXCEPT ![agent] = newCeiling]
    /\ shadowAdoptions' =
        {adoption \in shadowAdoptions :
            adoption[1] # agent \/
                draftRights[adoption[2]] \subseteq newCeiling}
    /\ trialOverlays' =
        {overlay \in trialOverlays :
            overlay[3] # agent \/
                draftRights[overlay[4]] \subseteq newCeiling}
    /\ activeOverlays' =
        {overlay \in activeOverlays :
            overlay[3] # agent \/
                draftRights[overlay[4]] \subseteq newCeiling}
    /\ UNCHANGED <<activeAgents, retiredAgents, displayName, agentAuthority,
                   agentAuthorityAvailable, selfAdoptCapability, ProjectVars,
                   MappingVars, DraftVars, pendingPromotions, CustomVars,
                   CapsuleVars>>

SelfAdoptShadow(agent, draft) ==
    /\ agent \in activeAgents
    /\ agent \in selfAdoptCapability
    /\ draft \in drafts
    /\ draftAuthor[draft] = agent
    /\ draftRights[draft] \subseteq agentCeiling[agent]
    /\ <<agent, draft>> \notin shadowAdoptions
    /\ shadowAdoptions' = shadowAdoptions \cup {<<agent, draft>>}
    /\ UNCHANGED <<AgentVars, ProjectVars, MappingVars, DraftVars,
                   trialOverlays, activeOverlays, pendingPromotions,
                   CustomVars, CapsuleVars>>

StartTrial(project, principal, agent, draft) ==
    /\ UniqueOwner(project, principal, agent)
    /\ <<agent, draft>> \in shadowAdoptions
    /\ draftRights[draft] \subseteq agentCeiling[agent]
    /\ <<project, principal, agent, draft>> \notin trialOverlays
    /\ trialOverlays' =
        trialOverlays \cup {<<project, principal, agent, draft>>}
    /\ UNCHANGED <<AgentVars, ProjectVars, MappingVars, DraftVars,
                   shadowAdoptions, activeOverlays, pendingPromotions,
                   CustomVars, CapsuleVars>>

ActivateTrial(project, principal, agent, draft) ==
    /\ UniqueOwner(project, principal, agent)
    /\ <<project, principal, agent, draft>> \in trialOverlays
    /\ draftRights[draft] \subseteq agentCeiling[agent]
    /\ activeOverlays' =
        activeOverlays \cup {<<project, principal, agent, draft>>}
    /\ UNCHANGED <<AgentVars, ProjectVars, MappingVars, DraftVars,
                   shadowAdoptions, trialOverlays, pendingPromotions,
                   CustomVars, CapsuleVars>>

FailClosedOverlayAttempt(project, principal, draft) ==
    /\ project \in ProjectIds
    /\ principal \in ProjectPrincipals
    /\ draft \in DraftIds
    /\ ~(\E agent \in AgentIds :
            UniqueOwner(project, principal, agent))
    /\ <<project, principal, draft>> \notin failedOverlayRequests
    /\ failedOverlayRequests' =
        failedOverlayRequests \cup {<<project, principal, draft>>}
    /\ UNCHANGED <<AgentVars, ProjectVars, privateMap, mappingCandidates,
                   quarantinedMappings, ambiguousPairs, DraftVars,
                   AdoptionVars, CustomVars, CapsuleVars>>

\* A readable name or self-claim is deliberately insufficient to resolve an
\* otherwise missing/ambiguous scoped mapping.
FailClosedNameOrSelfClaim(project, principal, agent, draft) ==
    /\ agent \in activeAgents
    /\ displayName[agent] \in Names
    /\ ~(\E owner \in AgentIds :
            UniqueOwner(project, principal, owner))
    /\ <<project, principal, draft>> \notin failedOverlayRequests
    /\ failedOverlayRequests' =
        failedOverlayRequests \cup {<<project, principal, draft>>}
    /\ UNCHANGED <<AgentVars, ProjectVars, privateMap, mappingCandidates,
                   quarantinedMappings, ambiguousPairs, DraftVars,
                   AdoptionVars, CustomVars, CapsuleVars>>

RequestPromotion(project, draft) ==
    /\ projectAuthorityAvailable[project]
    /\ \E principal \in ProjectPrincipals, agent \in AgentIds :
        <<project, principal, agent, draft>> \in trialOverlays
    /\ <<project, draft>> \notin pendingPromotions
    /\ pendingPromotions' =
        pendingPromotions \cup {<<project, draft>>}
    /\ UNCHANGED <<AgentVars, ProjectVars, MappingVars, DraftVars,
                   shadowAdoptions, trialOverlays, activeOverlays,
                   CustomVars, CapsuleVars>>

UnusedCustom(custom) ==
    custom \notin
        customs \cup customCandidates \cup quarantinedCustoms

PromoteDraft(project, draft, custom) ==
    /\ <<project, draft>> \in pendingPromotions
    /\ projectAuthorityAvailable[project]
    /\ projectAuthority[project] \in ProjectAuthorities
    /\ draft \in drafts
    /\ UnusedCustom(custom)
    /\ \E principal \in ProjectPrincipals, agent \in AgentIds :
        <<project, principal, agent, draft>> \in trialOverlays
    /\ customs' = customs \cup {custom}
    /\ promotedCustoms' = promotedCustoms \cup {custom}
    /\ customProject' =
        [customProject EXCEPT ![custom] = project]
    /\ customSourceDraft' =
        [customSourceDraft EXCEPT ![custom] = draft]
    /\ customBody' =
        [customBody EXCEPT ![custom] = draftBody[draft]]
    /\ customAuthority' =
        [customAuthority EXCEPT
            ![custom] = projectAuthority[project]]
    /\ customRights' =
        [customRights EXCEPT ![custom] = draftRights[draft]]
    /\ customMode' = [customMode EXCEPT ![custom] = "shadow"]
    /\ pendingPromotions' =
        pendingPromotions \ {<<project, draft>>}
    /\ UNCHANGED <<AgentVars, ProjectVars, MappingVars, DraftVars,
                   shadowAdoptions, trialOverlays, activeOverlays,
                   customCandidates, importedCustoms, quarantinedCustoms,
                   CapsuleVars>>

PromoteFor(project, draft) ==
    \E custom \in CustomIds : PromoteDraft(project, draft, custom)

StageCustomImport(custom, project, draft, authority, rights) ==
    /\ custom \in CustomIds
    /\ UnusedCustom(custom)
    /\ project \in ProjectIds
    /\ draft \in DraftIds
    /\ authority \in
        ProjectAuthorities \cup AgentAuthorities \cup {NoAuthority}
    /\ rights \subseteq PermissionAtoms
    /\ customCandidates' = customCandidates \cup {custom}
    /\ customProject' =
        [customProject EXCEPT ![custom] = project]
    /\ customSourceDraft' =
        [customSourceDraft EXCEPT ![custom] = draft]
    /\ customBody' =
        [customBody EXCEPT ![custom] = draftBody[draft]]
    /\ customAuthority' =
        [customAuthority EXCEPT ![custom] = authority]
    /\ customRights' =
        [customRights EXCEPT ![custom] = rights]
    /\ UNCHANGED <<AgentVars, ProjectVars, MappingVars, DraftVars,
                   AdoptionVars, customs, importedCustoms, promotedCustoms,
                   quarantinedCustoms, customMode, CapsuleVars>>

ValidCustomCandidate(custom) ==
    LET project == customProject[custom]
        draft == customSourceDraft[custom]
    IN  /\ custom \in customCandidates
        /\ projectAuthorityAvailable[project]
        /\ projectAuthority[project] \in ProjectAuthorities
        /\ customAuthority[custom] = projectAuthority[project]
        /\ draft \in drafts
        /\ customBody[custom] = draftBody[draft]
        /\ customRights[custom] \subseteq projectCeiling[project]

AcceptCustomImport(custom) ==
    /\ ValidCustomCandidate(custom)
    /\ customs' = customs \cup {custom}
    /\ importedCustoms' = importedCustoms \cup {custom}
    /\ customCandidates' = customCandidates \ {custom}
    /\ customMode' = [customMode EXCEPT ![custom] = "shadow"]
    /\ UNCHANGED <<AgentVars, ProjectVars, MappingVars, DraftVars,
                   AdoptionVars, promotedCustoms, quarantinedCustoms,
                   customProject, customSourceDraft, customBody,
                   customAuthority, customRights, CapsuleVars>>

QuarantineCustomImport(custom) ==
    /\ custom \in customCandidates
    /\ projectAuthorityAvailable[customProject[custom]]
    /\ ~ValidCustomCandidate(custom)
    /\ customCandidates' = customCandidates \ {custom}
    /\ quarantinedCustoms' = quarantinedCustoms \cup {custom}
    /\ UNCHANGED <<AgentVars, ProjectVars, MappingVars, DraftVars,
                   AdoptionVars, customs, importedCustoms, promotedCustoms,
                   customProject, customSourceDraft, customBody,
                   customAuthority, customRights, customMode, CapsuleVars>>

ReviewCustomFor(custom) ==
    AcceptCustomImport(custom) \/ QuarantineCustomImport(custom)

AdvanceCustomToTrial(custom) ==
    /\ custom \in customs
    /\ customMode[custom] = "shadow"
    /\ projectAuthorityAvailable[customProject[custom]]
    /\ customAuthority[custom] =
        projectAuthority[customProject[custom]]
    /\ customMode' = [customMode EXCEPT ![custom] = "trial"]
    /\ UNCHANGED <<AgentVars, ProjectVars, MappingVars, DraftVars,
                   AdoptionVars, customs, customCandidates, importedCustoms,
                   promotedCustoms, quarantinedCustoms, customProject,
                   customSourceDraft, customBody, customAuthority,
                   customRights, CapsuleVars>>

ActivateProjectCustom(custom) ==
    /\ custom \in customs
    /\ customMode[custom] = "trial"
    /\ projectAuthorityAvailable[customProject[custom]]
    /\ customAuthority[custom] =
        projectAuthority[customProject[custom]]
    /\ customMode' = [customMode EXCEPT ![custom] = "active"]
    /\ UNCHANGED <<AgentVars, ProjectVars, MappingVars, DraftVars,
                   AdoptionVars, customs, customCandidates, importedCustoms,
                   promotedCustoms, quarantinedCustoms, customProject,
                   customSourceDraft, customBody, customAuthority,
                   customRights, CapsuleVars>>

CreateCapsule(capsule, project, principal, custom) ==
    /\ capsule \in CapsuleIds \ capsules
    /\ custom \in customs
    /\ customMode[custom] = "active"
    /\ customProject[custom] = project
    /\ \E agent \in AgentIds :
        UniqueOwner(project, principal, agent)
    /\ capsules' = capsules \cup {capsule}
    /\ capsuleProject' =
        [capsuleProject EXCEPT ![capsule] = project]
    /\ capsulePrincipal' =
        [capsulePrincipal EXCEPT ![capsule] = principal]
    /\ capsuleCustom' =
        [capsuleCustom EXCEPT ![capsule] = custom]
    /\ capsuleBody' =
        [capsuleBody EXCEPT ![capsule] = customBody[custom]]
    /\ UNCHANGED <<AgentVars, ProjectVars, MappingVars, DraftVars,
                   AdoptionVars, CustomVars>>

RetireAgent(agent) ==
    /\ agent \in activeAgents
    /\ activeAgents' = activeAgents \ {agent}
    /\ retiredAgents' = retiredAgents \cup {agent}
    /\ displayName' = [displayName EXCEPT ![agent] = NoName]
    /\ agentAuthority' =
        [agentAuthority EXCEPT ![agent] = NoAuthority]
    /\ agentCeiling' = [agentCeiling EXCEPT ![agent] = {}]
    /\ selfAdoptCapability' = selfAdoptCapability \ {agent}
    /\ privateMap' =
        {mapping \in privateMap : mapping[3] # agent}
    /\ quarantinedMappings' =
        quarantinedMappings \cup
            {mapping \in mappingCandidates : mapping[3] = agent}
    /\ mappingCandidates' =
        {mapping \in mappingCandidates : mapping[3] # agent}
    /\ shadowAdoptions' =
        {adoption \in shadowAdoptions : adoption[1] # agent}
    /\ trialOverlays' =
        {overlay \in trialOverlays : overlay[3] # agent}
    /\ activeOverlays' =
        {overlay \in activeOverlays : overlay[3] # agent}
    /\ pendingPromotions' =
        {promotion \in pendingPromotions :
            draftAuthor[promotion[2]] # agent}
    /\ UNCHANGED <<agentAuthorityAvailable, ProjectVars, ambiguousPairs,
                   failedOverlayRequests, DraftVars, CustomVars, CapsuleVars>>

Next ==
    \/ \E a \in AgentIds, n \in Names, auth \in AgentAuthorities :
          EnrollAgent(a, n, auth)
    \/ \E a \in AgentIds, n \in Names : RenameAgent(a, n)
    \/ \E a \in AgentIds : IssueSelfAdoptCapability(a)
    \/ \E p \in ProjectIds, auth \in ProjectAuthorities :
          InstallProjectAuthority(p, auth)
    \/ \E p \in ProjectIds, value \in BOOLEAN :
          SetProjectAuthorityAvailability(p, value)
    \/ \E value \in BOOLEAN : SetAgentAuthorityAvailability(value)
    \/ \E p \in ProjectIds, principal \in ProjectPrincipals,
          a \in AgentIds : StageMappingImport(p, principal, a)
    \/ \E p \in ProjectIds, principal \in ProjectPrincipals,
          a \in AgentIds : ReviewMappingFor(p, principal, a)
    \/ \E p \in ProjectIds, principal \in ProjectPrincipals :
          ResolveMappingAmbiguity(p, principal)
    \/ \E p \in ProjectIds, principal \in ProjectPrincipals,
          a \in AgentIds : EraseMapping(p, principal, a)
    \/ \E a \in AgentIds, d \in DraftIds, b \in NormBodies,
          k \in NormKinds, rights \in SUBSET PermissionAtoms :
          AuthorDraft(a, d, b, k, rights)
    \/ \E a \in AgentIds, d \in DraftIds, b \in NormBodies,
          k \in NormKinds, rights \in SUBSET PermissionAtoms,
          authenticated \in BOOLEAN :
          StageDraftImport(a, d, b, k, rights, authenticated)
    \/ \E d \in DraftIds : ReviewDraftFor(d)
    \/ \E a \in AgentIds, ceiling \in SUBSET PermissionAtoms :
          NarrowAgentCeiling(a, ceiling)
    \/ \E a \in AgentIds, d \in DraftIds :
          SelfAdoptShadow(a, d)
    \/ \E p \in ProjectIds, principal \in ProjectPrincipals,
          a \in AgentIds, d \in DraftIds :
          StartTrial(p, principal, a, d)
    \/ \E p \in ProjectIds, principal \in ProjectPrincipals,
          a \in AgentIds, d \in DraftIds :
          ActivateTrial(p, principal, a, d)
    \/ \E p \in ProjectIds, principal \in ProjectPrincipals,
          d \in DraftIds : FailClosedOverlayAttempt(p, principal, d)
    \/ \E p \in ProjectIds, principal \in ProjectPrincipals,
          a \in AgentIds, d \in DraftIds :
          FailClosedNameOrSelfClaim(p, principal, a, d)
    \/ \E p \in ProjectIds, d \in DraftIds :
          RequestPromotion(p, d)
    \/ \E p \in ProjectIds, d \in DraftIds : PromoteFor(p, d)
    \/ \E c \in CustomIds, p \in ProjectIds, d \in DraftIds,
          auth \in ProjectAuthorities \cup AgentAuthorities \cup {NoAuthority},
          rights \in SUBSET PermissionAtoms :
          StageCustomImport(c, p, d, auth, rights)
    \/ \E c \in CustomIds : ReviewCustomFor(c)
    \/ \E c \in CustomIds : AdvanceCustomToTrial(c)
    \/ \E c \in CustomIds : ActivateProjectCustom(c)
    \/ \E x \in CapsuleIds, p \in ProjectIds,
          principal \in ProjectPrincipals, c \in CustomIds :
          CreateCapsule(x, p, principal, c)
    \/ \E a \in AgentIds : RetireAgent(a)

TypeOK ==
    /\ activeAgents \subseteq AgentIds
    /\ retiredAgents \subseteq AgentIds
    /\ activeAgents \cap retiredAgents = {}
    /\ displayName \in [AgentIds -> Names \cup {NoName}]
    /\ agentAuthority \in
        [AgentIds -> AgentAuthorities \cup {NoAuthority}]
    /\ agentAuthorityAvailable \in BOOLEAN
    /\ agentCeiling \in [AgentIds -> SUBSET PermissionAtoms]
    /\ selfAdoptCapability \subseteq activeAgents
    /\ projectAuthority \in
        [ProjectIds -> ProjectAuthorities \cup {NoAuthority}]
    /\ projectAuthorityAvailable \in [ProjectIds -> BOOLEAN]
    /\ projectCeiling \in [ProjectIds -> SUBSET PermissionAtoms]
    /\ privateMap \subseteq MappingUniverse
    /\ mappingCandidates \subseteq MappingUniverse
    /\ quarantinedMappings \subseteq MappingUniverse
    /\ ambiguousPairs \subseteq ScopedPairs
    /\ failedOverlayRequests \subseteq FailedOverlayUniverse
    /\ drafts \subseteq DraftIds
    /\ draftCandidates \subseteq DraftIds
    /\ authenticatedDraftCandidates \subseteq draftCandidates
    /\ importedDrafts \subseteq drafts
    /\ quarantinedDrafts \subseteq DraftIds
    /\ draftBody \in [DraftIds -> NormBodies \cup {NoBody}]
    /\ draftKind \in [DraftIds -> NormKinds \cup {NoKind}]
    /\ draftAuthor \in [DraftIds -> AgentIds \cup {NoAgent}]
    /\ draftRights \in [DraftIds -> SUBSET PermissionAtoms]
    /\ shadowAdoptions \subseteq AdoptionUniverse
    /\ trialOverlays \subseteq OverlayUniverse
    /\ activeOverlays \subseteq OverlayUniverse
    /\ pendingPromotions \subseteq PromotionUniverse
    /\ customs \subseteq CustomIds
    /\ customCandidates \subseteq CustomIds
    /\ importedCustoms \subseteq customs
    /\ promotedCustoms \subseteq customs
    /\ quarantinedCustoms \subseteq CustomIds
    /\ customProject \in [CustomIds -> ProjectIds \cup {NoProject}]
    /\ customSourceDraft \in [CustomIds -> DraftIds \cup {NoDraft}]
    /\ customBody \in [CustomIds -> NormBodies \cup {NoBody}]
    /\ customAuthority \in
        [CustomIds ->
            ProjectAuthorities \cup AgentAuthorities \cup {NoAuthority}]
    /\ customRights \in [CustomIds -> SUBSET PermissionAtoms]
    /\ customMode \in [CustomIds -> CustomModes \cup {NoMode}]
    /\ capsules \subseteq CapsuleIds
    /\ capsuleProject \in [CapsuleIds -> ProjectIds \cup {NoProject}]
    /\ capsulePrincipal \in
        [CapsuleIds -> ProjectPrincipals \cup {NoPrincipal}]
    /\ capsuleCustom \in [CapsuleIds -> CustomIds \cup {NoCustom}]
    /\ capsuleBody \in [CapsuleIds -> NormBodies \cup {NoBody}]

UniqueReadableNames ==
    /\ \A agent \in activeAgents : displayName[agent] \in Names
    /\ \A a1 \in activeAgents, a2 \in activeAgents :
        displayName[a1] = displayName[a2] => a1 = a2

PrivateMapIsProjectLocalBijection ==
    /\ \A p \in ProjectIds, principal \in ProjectPrincipals,
          a1 \in AgentIds, a2 \in AgentIds :
          /\ <<p, principal, a1>> \in privateMap
          /\ <<p, principal, a2>> \in privateMap
          => a1 = a2
    /\ \A p \in ProjectIds, agent \in AgentIds,
          principal1 \in ProjectPrincipals,
          principal2 \in ProjectPrincipals :
          /\ <<p, principal1, agent>> \in privateMap
          /\ <<p, principal2, agent>> \in privateMap
          => principal1 = principal2
    /\ \A mapping \in privateMap : mapping[3] \in activeAgents

ExactlyOneNormBodyPerImmutableDraft ==
    \A draft \in drafts :
        /\ draftBody[draft] \in NormBodies
        /\ draftKind[draft] \in NormKinds
        /\ draftAuthor[draft] \in AgentIds

KnownDraftMetadataDoesNotChange ==
    \A draft \in
        drafts \cup draftCandidates \cup quarantinedDrafts :
        /\ draftBody'[draft] = draftBody[draft]
        /\ draftKind'[draft] = draftKind[draft]
        /\ draftAuthor'[draft] = draftAuthor[draft]
        /\ draftRights'[draft] = draftRights[draft]

DraftsAreImmutable == [][KnownDraftMetadataDoesNotChange]_vars

SelfAdoptionIsExplicitAndNonWidening ==
    \A adoption \in shadowAdoptions :
        /\ adoption[1] \in selfAdoptCapability
        /\ adoption[1] \in activeAgents
        /\ adoption[2] \in drafts
        /\ draftAuthor[adoption[2]] = adoption[1]
        /\ draftRights[adoption[2]]
            \subseteq agentCeiling[adoption[1]]

OverlayOnlyMappedOwner ==
    \A overlay \in trialOverlays \cup activeOverlays :
        /\ UniqueOwner(overlay[1], overlay[2], overlay[3])
        /\ <<overlay[3], overlay[4]>> \in shadowAdoptions
        /\ draftAuthor[overlay[4]] = overlay[3]
        /\ draftRights[overlay[4]]
            \subseteq agentCeiling[overlay[3]]

AuthorshipNeverActivates ==
    /\ activeOverlays \subseteq trialOverlays
    /\ \A overlay \in activeOverlays :
        <<overlay[3], overlay[4]>> \in shadowAdoptions
    /\ \A custom \in customs :
        customMode[custom] = "active"
            => custom \in promotedCustoms \cup importedCustoms

PromotionCannotReuseAgentAuthority ==
    \A custom \in customs :
        /\ customAuthority[custom] \in ProjectAuthorities
        /\ customAuthority[custom] \notin AgentAuthorities
        /\ customProject[custom] \in ProjectIds
        /\ customSourceDraft[custom] \in drafts
        /\ customBody[custom] =
            draftBody[customSourceDraft[custom]]

ImportsRemainInactiveUntilReview ==
    /\ customCandidates \cap customs = {}
    /\ quarantinedCustoms \cap customs = {}
    /\ draftCandidates \cap drafts = {}
    /\ quarantinedDrafts \cap drafts = {}

MissingAmbiguousOrErasedMapFailsClosed ==
    \A overlay \in trialOverlays \cup activeOverlays :
        <<overlay[1], overlay[2]>> \notin ambiguousPairs

NewFailedResolutionDoesNotActivate ==
    \A failed \in FailedOverlayUniverse :
        /\ failed \notin failedOverlayRequests
        /\ failed \in failedOverlayRequests'
        => ~(\E agent \in AgentIds :
                <<failed[1], failed[2], agent, failed[3]>>
                    \in activeOverlays')

FailClosedAttemptsDoNotActivate ==
    [][NewFailedResolutionDoesNotActivate]_vars

RetirementErasesMapping ==
    \A agent \in retiredAgents :
        /\ displayName[agent] = NoName
        /\ ~(\E project \in ProjectIds,
                principal \in ProjectPrincipals :
                <<project, principal, agent>> \in privateMap)
        /\ ~(\E overlay \in trialOverlays \cup activeOverlays :
                overlay[3] = agent)

RetirementDoesNotReverse ==
    retiredAgents \subseteq retiredAgents'

RetiredAgentIdsAreNeverReused ==
    [][RetirementDoesNotReverse]_vars

CapsuleValues(capsule) ==
    {capsuleProject[capsule], capsulePrincipal[capsule],
     capsuleCustom[capsule], capsuleBody[capsule]}

CapsulesExcludeAgentId ==
    \A capsule \in capsules :
        /\ CapsuleValues(capsule) \cap AgentIds = {}
        /\ capsuleProject[capsule] \in ProjectIds
        /\ capsulePrincipal[capsule] \in ProjectPrincipals
        /\ capsuleCustom[capsule] \in customs
        /\ capsuleBody[capsule] =
            customBody[capsuleCustom[capsule]]

PromotionResourcesRemain(project, draft) ==
    /\ <<project, draft>> \in pendingPromotions
    /\ projectAuthorityAvailable[project]
    /\ \E custom \in CustomIds : UnusedCustom(custom)
    /\ \E principal \in ProjectPrincipals, agent \in AgentIds :
        <<project, principal, agent, draft>> \in trialOverlays

ConditionalPromotionLiveness ==
    \A project \in ProjectIds, draft \in DraftIds :
        /\ <>[]projectAuthorityAvailable[project]
        /\ [](<<project, draft>> \in pendingPromotions
                => PromotionResourcesRemain(project, draft))
        => (<<project, draft>> \in pendingPromotions
             ~> <<project, draft>> \notin pendingPromotions)

ConditionalMappingReviewLiveness ==
    \A project \in ProjectIds, principal \in ProjectPrincipals,
        agent \in AgentIds :
        <<project, principal, agent>> \in mappingCandidates
        ~> <<project, principal, agent>> \notin mappingCandidates

ConditionalDraftReviewLiveness ==
    \A draft \in DraftIds :
        draft \in draftCandidates ~> draft \notin draftCandidates

\* Targeted finite harnesses reuse the lifecycle actions while removing
\* unrelated import/availability interleavings.
LifecycleHarnessNext ==
    \/ \E a \in AgentIds : IssueSelfAdoptCapability(a)
    \/ \E a \in AgentIds, d \in DraftIds, b \in NormBodies,
          k \in NormKinds, rights \in SUBSET PermissionAtoms :
          AuthorDraft(a, d, b, k, rights)
    \/ \E a \in AgentIds, d \in DraftIds :
          SelfAdoptShadow(a, d)
    \/ \E p \in ProjectIds, principal \in ProjectPrincipals,
          a \in AgentIds, d \in DraftIds :
          StartTrial(p, principal, a, d)
    \/ \E p \in ProjectIds, principal \in ProjectPrincipals,
          a \in AgentIds, d \in DraftIds :
          ActivateTrial(p, principal, a, d)
    \/ \E p \in ProjectIds, principal \in ProjectPrincipals,
          a \in AgentIds : EraseMapping(p, principal, a)
    \/ \E p \in ProjectIds, principal \in ProjectPrincipals,
          d \in DraftIds : FailClosedOverlayAttempt(p, principal, d)
    \/ \E p \in ProjectIds, principal \in ProjectPrincipals,
          a \in AgentIds, d \in DraftIds :
          FailClosedNameOrSelfClaim(p, principal, a, d)
    \/ \E p \in ProjectIds, d \in DraftIds :
          RequestPromotion(p, d)
    \/ \E p \in ProjectIds, d \in DraftIds : PromoteFor(p, d)
    \/ \E c \in CustomIds : AdvanceCustomToTrial(c)
    \/ \E c \in CustomIds : ActivateProjectCustom(c)
    \/ \E x \in CapsuleIds, p \in ProjectIds,
          principal \in ProjectPrincipals, c \in CustomIds :
          CreateCapsule(x, p, principal, c)
    \/ \E a \in AgentIds : RetireAgent(a)

MappingHarnessNext ==
    \/ \E a \in AgentIds, n \in Names, auth \in AgentAuthorities :
          EnrollAgent(a, n, auth)
    \/ \E p \in ProjectIds, principal \in ProjectPrincipals,
          a \in AgentIds : StageMappingImport(p, principal, a)
    \/ \E p \in ProjectIds, principal \in ProjectPrincipals,
          a \in AgentIds : ReviewMappingFor(p, principal, a)
    \/ \E p \in ProjectIds, principal \in ProjectPrincipals :
          ResolveMappingAmbiguity(p, principal)
    \/ \E p \in ProjectIds, principal \in ProjectPrincipals,
          a \in AgentIds : EraseMapping(p, principal, a)
    \/ \E p \in ProjectIds, principal \in ProjectPrincipals,
          d \in DraftIds : FailClosedOverlayAttempt(p, principal, d)
    \/ \E p \in ProjectIds, principal \in ProjectPrincipals,
          a \in AgentIds, d \in DraftIds :
          FailClosedNameOrSelfClaim(p, principal, a, d)
    \/ \E a \in AgentIds : RetireAgent(a)

LifecycleHarnessSpec ==
    /\ Init
    /\ [][LifecycleHarnessNext]_vars
    /\ \A p \in ProjectIds, d \in DraftIds :
          WF_vars(PromoteFor(p, d))

MappingHarnessSpec ==
    /\ Init
    /\ [][MappingHarnessNext]_vars
    /\ \A p \in ProjectIds, principal \in ProjectPrincipals,
          a \in AgentIds : WF_vars(ReviewMappingFor(p, principal, a))

\* Expected-failure mutation: a readable-name/self claim installs an active
\* overlay after the private scoped mapping is absent.
UnsafeNameClaimOverlay(project, principal, agent, draft) ==
    /\ project \in ProjectIds
    /\ principal \in ProjectPrincipals
    /\ agent \in activeAgents
    /\ draft \in drafts
    /\ displayName[agent] \in Names
    /\ ~UniqueOwner(project, principal, agent)
    /\ <<project, principal, agent, draft>> \notin activeOverlays
    /\ activeOverlays' =
        activeOverlays \cup {<<project, principal, agent, draft>>}
    /\ UNCHANGED <<AgentVars, ProjectVars, MappingVars, DraftVars,
                   shadowAdoptions, trialOverlays, pendingPromotions,
                   CustomVars, CapsuleVars>>

MappingMutationNext ==
    LifecycleHarnessNext \/
    \E p \in ProjectIds, principal \in ProjectPrincipals,
       a \in AgentIds, d \in DraftIds :
       UnsafeNameClaimOverlay(p, principal, a, d)

MappingMutationSpec == Init /\ [][MappingMutationNext]_vars

PromotionReachabilitySentinel == promotedCustoms = {}
CapsuleReachabilitySentinel == capsules = {}
MappingAmbiguityReachabilitySentinel == ambiguousPairs = {}
FailClosedReachabilitySentinel == failedOverlayRequests = {}

Spec ==
    /\ Init
    /\ [][Next]_vars
    /\ \A p \in ProjectIds, principal \in ProjectPrincipals,
          a \in AgentIds : WF_vars(ReviewMappingFor(p, principal, a))
    /\ \A d \in DraftIds : WF_vars(ReviewDraftFor(d))
    /\ \A c \in CustomIds : WF_vars(ReviewCustomFor(c))
    /\ \A p \in ProjectIds, d \in DraftIds :
          WF_vars(PromoteFor(p, d))

=============================================================================
