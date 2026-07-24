// Plain-TS port of t3code's model/option-descriptor contract (no Effect).
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

const REASONING: OptionDescriptor = {
  id: 'effort',
  label: 'Reasoning',
  type: 'select',
  options: [
    { value: 'minimal', label: 'Minimal' },
    { value: 'low', label: 'Low' },
    { value: 'medium', label: 'Medium', isDefault: true },
    { value: 'high', label: 'High' },
    { value: 'xhigh', label: 'Extra high' },
  ],
}

// Claude effort maps to thinking depth; consumed as a turn hint (safe to omit).
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

export const MODELS: ModelDef[] = [
  { slug: 'claude-opus-4-8', name: 'Claude Opus 4.8', shortName: 'Opus 4.8', provider: 'claude', isDefault: true, descriptors: [THINKING] },
  { slug: 'claude-fable-5', name: 'Claude Fable 5', shortName: 'Fable 5', provider: 'claude', isNew: true, descriptors: [THINKING] },
  { slug: 'claude-sonnet-5', name: 'Claude Sonnet 5', shortName: 'Sonnet 5', provider: 'claude', descriptors: [THINKING] },
  { slug: 'claude-haiku-4-5', name: 'Claude Haiku 4.5', shortName: 'Haiku 4.5', provider: 'claude', descriptors: [] },
  { slug: 'gpt-5.4-codex', name: 'GPT-5.4 Codex', shortName: '5.4 Codex', provider: 'codex', isDefault: true, descriptors: [REASONING] },
  { slug: 'gpt-5.6-codex', name: 'GPT-5.6 Codex', shortName: '5.6 Codex', provider: 'codex', isNew: true, descriptors: [REASONING] },
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
