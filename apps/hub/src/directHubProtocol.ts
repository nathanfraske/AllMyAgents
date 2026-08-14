import crypto from 'node:crypto'

export const DIRECT_HUB_PROTOCOL_VERSION = 1
const MAX_CLOCK_SKEW_MS = 5 * 60 * 1000

export interface DirectHubEnvelope {
  version: 1
  messageId: string
  sourceSiteId: string
  sourceLabel: string
  sentAt: string
  operation: 'device_capabilities' | 'device_action' | 'overseer_message'
  payload: unknown
  signature: string
}

/**
 * Canonical JSON for signing.
 *
 * MyOwnMesh relays an envelope by deserializing and re-serializing it, and its map emits keys in
 * sorted order — so an HMAC taken over insertion-ordered JSON cannot survive the round trip. Only an
 * empty payload was order-free, which is why `device_capabilities` authenticated while every
 * populated operation was rejected; hubs that still hold an AllMyStuff Site route masked that by
 * silently falling back to it. Normalizing through JSON first reproduces exactly what crosses the
 * wire (toJSON, dropped undefined, array holes), and emitting keys in sorted order then makes signer
 * and verifier hash identical bytes however the relay chose to order them.
 */
function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null'
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  return `{${Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
    .map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`)
    .join(',')}}`
}

function unsigned(envelope: Omit<DirectHubEnvelope, 'signature'>): string {
  return canonicalJson(JSON.parse(JSON.stringify({
    version: envelope.version,
    messageId: envelope.messageId,
    sourceSiteId: envelope.sourceSiteId,
    sourceLabel: envelope.sourceLabel,
    sentAt: envelope.sentAt,
    operation: envelope.operation,
    payload: envelope.payload,
  })))
}

export function signDirectHubEnvelope(
  token: string,
  source: { siteId: string; label: string },
  operation: DirectHubEnvelope['operation'],
  payload: unknown,
  now = new Date(),
): DirectHubEnvelope {
  const envelope: Omit<DirectHubEnvelope, 'signature'> = {
    version: DIRECT_HUB_PROTOCOL_VERSION,
    messageId: crypto.randomUUID(),
    sourceSiteId: source.siteId,
    sourceLabel: source.label,
    sentAt: now.toISOString(),
    operation,
    payload,
  }
  return {
    ...envelope,
    signature: crypto.createHmac('sha256', token).update(unsigned(envelope)).digest('hex'),
  }
}

export function verifyDirectHubEnvelope(
  value: unknown,
  input: { fromPeer: string; token: string; now?: Date },
): DirectHubEnvelope {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('direct hub envelope is malformed')
  const envelope = value as Partial<DirectHubEnvelope>
  if (envelope.version !== DIRECT_HUB_PROTOCOL_VERSION) throw new Error('direct hub protocol version is unsupported')
  if (typeof envelope.messageId !== 'string' || !/^[0-9a-f-]{36}$/iu.test(envelope.messageId)) {
    throw new Error('direct hub message id is malformed')
  }
  if (typeof envelope.sourceSiteId !== 'string' || envelope.sourceSiteId.length > 256) {
    throw new Error('direct hub source id is malformed')
  }
  if (envelope.sourceSiteId.toLowerCase() !== input.fromPeer.split('-', 1)[0]!.toLowerCase()) {
    throw new Error('direct hub source does not match the authenticated mesh peer')
  }
  if (
    typeof envelope.sourceLabel !== 'string' ||
    !envelope.sourceLabel.trim() ||
    envelope.sourceLabel.length > 200 ||
    /[\u0000-\u001f\u007f]/u.test(envelope.sourceLabel)
  ) {
    throw new Error('direct hub source label is malformed')
  }
  if (!['device_capabilities', 'device_action', 'overseer_message'].includes(envelope.operation ?? '')) {
    throw new Error('direct hub operation is unsupported')
  }
  const sentAtMs = typeof envelope.sentAt === 'string' ? Date.parse(envelope.sentAt) : Number.NaN
  const nowMs = (input.now ?? new Date()).getTime()
  if (!Number.isFinite(sentAtMs) || Math.abs(nowMs - sentAtMs) > MAX_CLOCK_SKEW_MS) {
    throw new Error('direct hub message timestamp is outside the five-minute acceptance window')
  }
  if (typeof envelope.signature !== 'string' || !/^[0-9a-f]{64}$/iu.test(envelope.signature)) {
    throw new Error('direct hub signature is malformed')
  }
  const expected = crypto.createHmac('sha256', input.token).update(unsigned(envelope as Omit<DirectHubEnvelope, 'signature'>)).digest()
  const actual = Buffer.from(envelope.signature, 'hex')
  if (actual.length !== expected.length || !crypto.timingSafeEqual(actual, expected)) {
    throw new Error('direct hub signature was rejected; pair both hubs again')
  }
  return envelope as DirectHubEnvelope
}
