import { resolveHubResource } from './api'

// The URL the transcript uses to DISPLAY a stored attachment (an <img src> or a download link). This is
// the display/GET side of attachments; it is intentionally separate from the composer's staging object
// URLs, so a message from a previous session renders from the hub after a reload when any blob: URL is
// long dead. (The upload + send side is api.ts's contract — Franklin.)
//
// `<img>` cannot set an Authorization header, so a token-gated hub must accept the device token as a
// `?token=` query param on the GET-serve route (noted to the hub owner). On a same-origin dev/sandbox
// hub (no token) it is a plain relative URL that the vite proxy forwards.
export function attachmentUrl(sessionId: string, attachmentId: string): string {
  const target = resolveHubResource(sessionId)
  const url = `${target.baseUrl}/api/sessions/${encodeURIComponent(target.id)}/attachments/${encodeURIComponent(attachmentId)}`
  return target.token ? `${url}?token=${encodeURIComponent(target.token)}` : url
}
