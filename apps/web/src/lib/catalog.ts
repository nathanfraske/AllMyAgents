// Plain-TS port of t3code's model/option-descriptor contract (no Effect).
// Codex models + params are from the live `codex app-server` model/list (codex 0.145).
export type Provider = 'claude' | 'codex'

export interface OptionChoice {
  value: string
  label: string
  isDefault?: boolean
}

export interface OptionDescriptor {
  id: string
  label: string
  type: 'select' | 'boolean'
  options?: OptionChoice[]
}

export interface ModelDef {
  slug: string
  name: string
  shortName?: string
  provider: Provider
  isDefault?: boolean
  isNew?: boolean
  descriptors: OptionDescriptor[]
}

const EFFORT_LABEL: Record<string, string> = {
  low: 'Low',
  medium: 'Medium',
  high: 'High',
  xhigh: 'Extra high',
  max: 'Max',
  ultra: 'Ultra',
}

function effort(values: string[], def: string): OptionDescriptor {
  return {
    id: 'effort',
    label: 'Effort',
    type: 'select',
    options: values.map((v) => ({ value: v, label: EFFORT_LABEL[v] ?? v, isDefault: v === def })),
  }
}

// Codex "Speed" = service tier. Standard (default) or priority/"Fast" (1.5x).
const SPEED: OptionDescriptor = {
  id: 'serviceTier',
  label: 'Speed',
  type: 'select',
  options: [
    { value: '', label: 'Standard', isDefault: true },
    { value: 'priority', label: 'Fast' },
  ],
}

// Claude "Thinking" — injected as a prompt keyword by the hub adapter.
const THINKING: OptionDescriptor = {
  id: 'effort',
  label: 'Thinking',
  type: 'select',
  options: [
    { value: '', label: 'Normal', isDefault: true },
    { value: 'think', label: 'Think' },
    { value: 'megathink', label: 'Megathink' },
    { value: 'ultrathink', label: 'Ultrathink' },
  ],
}

const FULL_EFFORT = ['low', 'medium', 'high', 'xhigh', 'max', 'ultra']
const NO_ULTRA = ['low', 'medium', 'high', 'xhigh', 'max']
const BASE_EFFORT = ['low', 'medium', 'high', 'xhigh']

export const MODELS: ModelDef[] = [
  // Claude (Agent SDK)
  { slug: 'claude-opus-4-8', name: 'Claude Opus 4.8', shortName: 'Opus 4.8', provider: 'claude', isDefault: true, descriptors: [THINKING] },
  { slug: 'claude-fable-5', name: 'Claude Fable 5', shortName: 'Fable 5', provider: 'claude', isNew: true, descriptors: [THINKING] },
  { slug: 'claude-sonnet-5', name: 'Claude Sonnet 5', shortName: 'Sonnet 5', provider: 'claude', descriptors: [THINKING] },
  { slug: 'claude-haiku-4-5', name: 'Claude Haiku 4.5', shortName: 'Haiku 4.5', provider: 'claude', descriptors: [] },
  // Codex (app-server) — slugs + effort/speed from live model/list
  { slug: 'gpt-5.6-sol', name: 'GPT-5.6 Sol', shortName: '5.6 Sol', provider: 'codex', isDefault: true, isNew: true, descriptors: [effort(FULL_EFFORT, 'low'), SPEED] },
  { slug: 'gpt-5.6-terra', name: 'GPT-5.6 Terra', shortName: '5.6 Terra', provider: 'codex', isNew: true, descriptors: [effort(FULL_EFFORT, 'medium'), SPEED] },
  { slug: 'gpt-5.6-luna', name: 'GPT-5.6 Luna', shortName: '5.6 Luna', provider: 'codex', isNew: true, descriptors: [effort(NO_ULTRA, 'medium'), SPEED] },
  { slug: 'gpt-5.5', name: 'GPT-5.5', shortName: '5.5', provider: 'codex', descriptors: [effort(BASE_EFFORT, 'medium'), SPEED] },
  { slug: 'gpt-5.4', name: 'GPT-5.4', shortName: '5.4', provider: 'codex', descriptors: [effort(BASE_EFFORT, 'medium'), SPEED] },
  { slug: 'gpt-5.4-mini', name: 'GPT-5.4 Mini', shortName: '5.4 Mini', provider: 'codex', descriptors: [effort(BASE_EFFORT, 'medium')] },
  { slug: 'gpt-5.3-codex-spark', name: 'GPT-5.3 Codex Spark', shortName: '5.3 Codex Spark', provider: 'codex', descriptors: [effort(BASE_EFFORT, 'high')] },
]

export function modelsFor(provider: Provider): ModelDef[] {
  return MODELS.filter((m) => m.provider === provider)
}

export function findModel(slug?: string): ModelDef | undefined {
  return slug ? MODELS.find((m) => m.slug === slug) : undefined
}

export function defaultModelFor(provider: Provider): ModelDef | undefined {
  return modelsFor(provider).find((m) => m.isDefault) ?? modelsFor(provider)[0]
}

export function descriptorLabel(d: OptionDescriptor, value: string | undefined): string {
  if (d.type === 'boolean') return value === 'true' ? d.label : `${d.label} off`
  const opt = d.options?.find((o) => o.value === value) ?? d.options?.find((o) => o.isDefault)
  return opt?.label ?? d.options?.[0]?.label ?? ''
}
