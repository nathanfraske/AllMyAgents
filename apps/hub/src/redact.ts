const PATTERNS: RegExp[] = [
  /sk-ant-[A-Za-z0-9_-]{8,}/g,
  /sk-[A-Za-z0-9_-]{20,}/g,
  /ghp_[A-Za-z0-9]{20,}/g,
  /github_pat_[A-Za-z0-9_]{20,}/g,
  /AKIA[0-9A-Z]{16}/g,
  /eyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{10,}/g,
  /(?<=(?:api[_-]?key|authorization|bearer|token|secret|password)\\?["']?\s*[:=]\s*\\?["']?)[^\s"',;\\]{8,}/gi,
]

export function redact(text: string): string {
  let out = text
  for (const pattern of PATTERNS) out = out.replace(pattern, '[REDACTED]')
  return out
}
