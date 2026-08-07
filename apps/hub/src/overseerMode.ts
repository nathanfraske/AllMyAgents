import type {
  OverseerConfig,
  OverseerModePolicy,
  OverseerOperatingMode,
} from './types.js'

export interface OverseerModeUpdate {
  operatingMode: OverseerOperatingMode
  guidance?: string
  ideaPool?: string[]
  maxParallelAgents?: number
  preferredEffort?: string
}

const DEFAULT_POLICIES: Record<Exclude<OverseerOperatingMode, 'standard'>, OverseerModePolicy> = {
  tokenmaxxing: {
    ideaPool: [
      'Run a broad independent code-review swarm and reconcile only findings with concrete evidence.',
      'Audit tests, security boundaries, failure recovery, and user-facing regressions in parallel.',
      'Give an existing project team one bounded verification objective per agent, then synthesize the results.',
    ],
    maxParallelAgents: 16,
    preferredEffort: 'high',
  },
  eco: {
    ideaPool: [
      'Use one capable agent to reproduce and rank the issue before assigning any parallel work.',
      'Reuse an existing idle project agent for a focused review instead of creating a new swarm.',
      'Run the smallest relevant test slice first and expand only when evidence requires it.',
    ],
    maxParallelAgents: 2,
    preferredEffort: 'low',
  },
}

function boundedText(value: unknown, field: string, max: number): string | undefined {
  if (value === undefined || value === null || value === '') return undefined
  if (typeof value !== 'string') throw new Error(`${field} must be text`)
  const normalized = value.trim()
  if (normalized.length > max) throw new Error(`${field} must be no longer than ${max} characters`)
  return normalized || undefined
}

export function effectiveOverseerMode(config: OverseerConfig): {
  operatingMode: OverseerOperatingMode
  policy?: OverseerModePolicy
} {
  const operatingMode = config.operatingMode === 'tokenmaxxing' || config.operatingMode === 'eco'
    ? config.operatingMode
    : 'standard'
  if (operatingMode === 'standard') return { operatingMode }
  const stored = config.modePolicies?.[operatingMode]
  return {
    operatingMode,
    policy: {
      ...DEFAULT_POLICIES[operatingMode],
      ...stored,
      ideaPool: stored?.ideaPool ?? DEFAULT_POLICIES[operatingMode].ideaPool,
    },
  }
}

/** Apply a validated mode/preset update while preserving the other mode's reusable idea pool. */
export function applyOverseerModeUpdate(
  current: OverseerConfig,
  update: OverseerModeUpdate,
): OverseerConfig {
  const mode = update.operatingMode
  if (mode !== 'standard' && mode !== 'tokenmaxxing' && mode !== 'eco') {
    throw new Error('operatingMode must be standard, tokenmaxxing, or eco')
  }
  const next: OverseerConfig = {
    ...current,
    operatingMode: mode,
    updatedAt: new Date().toISOString(),
  }
  if (mode === 'standard') return next

  const prior = effectiveOverseerMode({ ...current, operatingMode: mode }).policy!
  const maxParallelAgents = update.maxParallelAgents ?? prior.maxParallelAgents
  if (!Number.isInteger(maxParallelAgents) || maxParallelAgents < 1 || maxParallelAgents > 16) {
    throw new Error('maxParallelAgents must be a whole number from 1 to 16')
  }
  const rawIdeas = update.ideaPool ?? prior.ideaPool
  if (!Array.isArray(rawIdeas) || rawIdeas.length > 20) {
    throw new Error('ideaPool must contain at most 20 ideas')
  }
  const ideaPool = rawIdeas.map((idea, index) => {
    const normalized = boundedText(idea, `ideaPool[${index}]`, 500)
    if (!normalized) throw new Error(`ideaPool[${index}] must not be empty`)
    return normalized
  })
  const guidance = update.guidance === undefined
    ? prior.guidance
    : boundedText(update.guidance, 'guidance', 10_000)
  const preferredEffort = update.preferredEffort === undefined
    ? prior.preferredEffort
    : boundedText(update.preferredEffort, 'preferredEffort', 64)
  const policy: OverseerModePolicy = {
    maxParallelAgents,
    ideaPool: [...new Set(ideaPool)],
    ...(guidance ? { guidance } : {}),
    ...(preferredEffort ? { preferredEffort } : {}),
  }
  next.modePolicies = { ...current.modePolicies, [mode]: policy }
  return next
}

export function overseerModeInstructions(config: OverseerConfig): string {
  const { operatingMode, policy } = effectiveOverseerMode(config)
  if (operatingMode === 'standard' || !policy) {
    return [
      '## OVERSEER OPERATING MODE: STANDARD',
      'No Tokenmaxxing or Eco policy is active. Choose resources proportionally to the operator request.',
    ].join('\n')
  }
  const ideas = policy.ideaPool.length
    ? policy.ideaPool.map((idea) => `- ${idea}`).join('\n')
    : '- No saved ideas; ask the operator what useful outcome they want.'
  if (operatingMode === 'tokenmaxxing') {
    return [
      '## OVERSEER OPERATING MODE: TOKENMAXXING (ACTIVE)',
      'This mode is operator-selected resource policy, not authorization to invent work.',
      'At the start of a planning turn, call overseer_control operation "status" and inspect its live usage/reset data. Ask the operator how they want to use capacity that will reset soon, unless their current message already names the exact task and desired swarm.',
      `Prefer useful one-shot review/audit/verification swarms, or focus an existing team on one account. Never exceed ${policy.maxParallelAgents} concurrent agents from this mode; manager and account limits remain hard independent ceilings.`,
      `Preferred effort: ${policy.preferredEffort ?? 'operator/model default'}. Use worker-owned one-shot children only when the manager grant explicitly enables them. Reconcile independent results, stop duplicated work, and finish at the stated acceptance criteria rather than consuming tokens for its own sake.`,
      ...(policy.guidance ? [`Operator definition of Tokenmaxxing:\n${policy.guidance}`] : []),
      `Saved idea pool (offer choices; do not launch solely because they are listed):\n${ideas}`,
    ].join('\n\n')
  }
  return [
    '## OVERSEER OPERATING MODE: ECO (ACTIVE)',
    'Prefer the cheapest still-capable model/account and the smallest evidence-producing step. Reuse an idle agent before creating a new one; reproduce and rank a problem before parallelizing.',
    `Default to effort ${policy.preferredEffort ?? 'low'} and no more than ${policy.maxParallelAgents} concurrent agents from this mode. Ask the operator before exceeding either preference, launching a swarm, or choosing a materially more expensive model.`,
    'Stop when acceptance criteria are verified. Do not extend work because context or quota remains.',
    ...(policy.guidance ? [`Operator definition of Eco mode:\n${policy.guidance}`] : []),
    `Saved economical idea pool (offer choices; do not launch solely because they are listed):\n${ideas}`,
  ].join('\n\n')
}
