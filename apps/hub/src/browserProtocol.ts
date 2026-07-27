export const BROWSER_PROTOCOL_VERSION = 1 as const

export type BrowserOperation = 'navigate' | 'read' | 'screenshot' | 'show' | 'close' | 'clear'

export interface BrowserCommand {
  id: string
  protocolVersion: typeof BROWSER_PROTOCOL_VERSION
  sessionId: string
  operation: BrowserOperation
  arguments: Record<string, unknown>
}

export type BrowserResultContent =
  | { type: 'text'; text: string }
  | { type: 'image'; data: string; mimeType: 'image/png' }

export interface BrowserCommandResult {
  id: string
  protocolVersion: typeof BROWSER_PROTOCOL_VERSION
  ok: boolean
  content?: BrowserResultContent[]
  error?: string
}

export interface BrowserHostHello {
  protocolVersion: number
  desktopInstanceId: string
  available?: boolean
  reason?: string
}

export interface BrowserNavigationEvent {
  protocolVersion: number
  desktopInstanceId: string
  sessionId: string
  url: string
  title?: string
  actor?: 'agent' | 'operator'
  ok?: boolean
  errorCode?: string
}
