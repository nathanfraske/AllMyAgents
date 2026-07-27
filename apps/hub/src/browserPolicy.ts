export type BrowserGateDecision =
  | { ok: true }
  | {
      ok: false
      code: 'disabled' | 'teammate_message' | 'unattributed_turn'
      message: string
    }

export function decideBrowserGate(input: {
  enabled: boolean
  isOperatorTurn: boolean
  isTeammateMessageTurn: boolean
}): BrowserGateDecision {
  if (!input.enabled) {
    return {
      ok: false,
      code: 'disabled',
      message: 'Browser access is off for this chat. The operator must enable it in the chat controls.',
    }
  }
  if (input.isTeammateMessageTurn) {
    return {
      ok: false,
      code: 'teammate_message',
      message: 'Browser access is not available during a teammate-message turn.',
    }
  }
  if (!input.isOperatorTurn) {
    return {
      ok: false,
      code: 'unattributed_turn',
      message: 'Browser access is unavailable because this turn is not attributed to the operator.',
    }
  }
  return { ok: true }
}

export interface SafeJournalUrl {
  scheme: 'http' | 'https'
  host: string
  port?: number
  path: string
  queryKeys: string[]
}

export function parseBrowserUrl(raw: string): URL {
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    throw new Error('Navigation refused: url must be an absolute http or https URL.')
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error('Navigation refused: only http and https URLs are allowed.')
  }
  if (url.username || url.password) {
    throw new Error('Navigation refused: URLs containing usernames or passwords are not allowed.')
  }
  url.hash = ''
  return url
}

export function safeJournalUrl(url: URL): SafeJournalUrl {
  return {
    scheme: url.protocol === 'https:' ? 'https' : 'http',
    host: url.hostname,
    ...(url.port ? { port: Number(url.port) } : {}),
    path: url.pathname || '/',
    queryKeys: [...new Set(url.searchParams.keys())].sort(),
  }
}

export function isLiteralLocalAddress(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, '')
  if (host === 'localhost' || host.endsWith('.localhost')) return true
  if (host === '::1' || host === '0:0:0:0:0:0:0:1' || host.startsWith('fe80:') || host.startsWith('fc') || host.startsWith('fd')) return true
  const parts = host.split('.').map(Number)
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return false
  return (
    parts[0] === 0 ||
    parts[0] === 10 ||
    parts[0] === 127 ||
    (parts[0] === 100 && parts[1] >= 64 && parts[1] <= 127) ||
    (parts[0] === 169 && parts[1] === 254) ||
    (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) ||
    (parts[0] === 192 && parts[1] === 168)
  )
}
