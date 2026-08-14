import net from 'node:net'
import os from 'node:os'
import path from 'node:path'

const DEFAULT_METHOD = 'allmyagents.hub.v1'
const MAX_CONTROL_LINE_BYTES = 3 * 1024 * 1024
const MAX_ERROR_CHARS = 2_000
const NETWORK_DISCOVERY_TTL_MS = 15_000

export interface MyOwnMeshControlResponse<T = unknown> {
  ok: boolean
  data?: T
  error?: string
}

export type MyOwnMeshControlRequest = <T = unknown>(
  request: Record<string, unknown>,
  timeoutMs?: number,
) => Promise<MyOwnMeshControlResponse<T>>

export interface MyOwnMeshNetworkCandidate {
  config_id: string
  network_id?: string
  label?: string
  phase?: string
  peers?: MyOwnMeshPeer[]
}

export interface MyOwnMeshPeer {
  device_id: string
  label?: string
  status?: string
  rtt_ms?: number | null
  capabilities?: { tags?: unknown }
}

export interface DirectMeshPeer {
  siteId: string
  label: string
  online: boolean
  status: string
  rttMs?: number
}

export interface DirectMeshIdentity {
  siteId: string
  label: string
}

export interface DirectMeshInbound {
  network: string
  from: string
  payload: unknown
}

export type DirectMeshHandler = (input: DirectMeshInbound) => Promise<unknown>

export type DirectMeshUnavailableReason =
  | 'not-started'
  | 'connecting'
  | 'no-daemon'
  | 'permission-denied'
  | 'no-networks'
  | 'control-error'

export interface DirectMeshStatus {
  available: boolean
  networkId?: string
  networkIds?: string[]
  method: string
  reason?: DirectMeshUnavailableReason
  error?: string
}

function canonicalDevice(value: string): string {
  return value.split('-', 1)[0]!.trim().toLowerCase()
}

function safeLabel(value: unknown, fallback: string): string {
  const label = typeof value === 'string' ? value.trim() : ''
  return label && label.length <= 200 && !/[\u0000-\u001f\u007f]/u.test(label) ? label : fallback
}

export function defaultMyOwnMeshSocketPath(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
  homeDirectory = os.homedir(),
): string {
  if (env.MYOWNMESH_CONTROL_SOCKET?.trim()) return env.MYOWNMESH_CONTROL_SOCKET.trim()
  if (platform === 'win32') return '\\\\.\\pipe\\myownmesh.sock'
  const configuredHome = env.MYOWNMESH_HOME?.trim()
  return configuredHome
    ? path.join(configuredHome, 'daemon.sock')
    : path.join(homeDirectory, '.myownmesh', 'daemon.sock')
}

function responseError(response: MyOwnMeshControlResponse, operation: string): Error {
  return new Error(response.error?.slice(0, MAX_ERROR_CHARS) || `${operation} failed`)
}

/** One bounded JSON-line request to the existing MyOwnMesh daemon IPC socket. */
export function myOwnMeshControlRequest<T = unknown>(
  request: Record<string, unknown>,
  timeoutMs = 10_000,
  socketPath = defaultMyOwnMeshSocketPath(),
): Promise<MyOwnMeshControlResponse<T>> {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(socketPath)
    let settled = false
    let bytes = 0
    let buffered = ''
    const finish = (error?: Error, value?: MyOwnMeshControlResponse): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      socket.destroy()
      if (error) reject(error)
      else resolve(value as MyOwnMeshControlResponse<T>)
    }
    const timer = setTimeout(() => finish(new Error(`MyOwnMesh control request timed out after ${timeoutMs}ms`)), timeoutMs)
    timer.unref?.()
    socket.on('connect', () => socket.write(`${JSON.stringify(request)}\n`))
    socket.on('data', (chunk: Buffer) => {
      bytes += chunk.length
      if (bytes > MAX_CONTROL_LINE_BYTES) {
        finish(new Error('MyOwnMesh control response exceeded its size bound'))
        return
      }
      buffered += chunk.toString('utf8')
      const newline = buffered.indexOf('\n')
      if (newline < 0) return
      try {
        finish(undefined, JSON.parse(buffered.slice(0, newline)) as MyOwnMeshControlResponse)
      } catch (error) {
        finish(error instanceof Error ? error : new Error(String(error)))
      }
    })
    socket.on('error', (error) => finish(error))
    socket.on('close', () => {
      if (!settled) finish(new Error('MyOwnMesh control socket closed before responding'))
    })
  })
}

function applicationPeer(peer: MyOwnMeshPeer): boolean {
  const tags = peer.capabilities?.tags
  return Array.isArray(tags) && tags.some((tag) => {
    if (typeof tag !== 'string') return false
    const normalized = tag.toLowerCase()
    return normalized === 'allmystuff' || normalized === 'allmyagents-testbed'
  })
}

function helperNetwork(candidate: MyOwnMeshNetworkCandidate): boolean {
  const label = `${candidate.label ?? ''} ${candidate.config_id} ${candidate.network_id ?? ''}`.toLowerCase()
  return label.includes('local claim') || label.includes('support')
}

function fleetNetworkScore(candidate: MyOwnMeshNetworkCandidate): number {
  const label = `${candidate.label ?? ''} ${candidate.config_id} ${candidate.network_id ?? ''}`.toLowerCase()
  const peers = candidate.peers ?? []
  let score = candidate.phase === 'active' ? 10 : 0
  if (label.includes('fleet')) score += 100
  if (label.includes('allmystuff')) score += 30
  score += peers.filter(applicationPeer).length * 25
  // Reachability is more important than a cosmetic network name. In particular, a network named
  // "Fleet" must not win when the requested machine is pending there but active on another owned mesh.
  score += peers.filter((peer) => applicationPeer(peer) && peer.status === 'active').length * 100
  return score
}

/**
 * Every non-helper MyOwnMesh network that can carry AllMyStuff application RPC, best route first.
 * A Hub may share more than one mesh with a peer; retaining all of them lets routing be decided for
 * the target device instead of pinning the entire application to one globally scored network.
 */
export function selectFleetNetworks(candidates: MyOwnMeshNetworkCandidate[]): MyOwnMeshNetworkCandidate[] {
  return candidates
    .filter((candidate) => !helperNetwork(candidate) && (candidate.peers ?? []).some(applicationPeer))
    .map((candidate) => ({ candidate, score: fleetNetworkScore(candidate) }))
    .sort((left, right) => right.score - left.score)
    .map(({ candidate }) => candidate)
}

/** Backwards-compatible primary route for status text and callers that truly need one network. */
export function selectFleetNetwork(candidates: MyOwnMeshNetworkCandidate[]): MyOwnMeshNetworkCandidate | undefined {
  return selectFleetNetworks(candidates)[0]
}

function peerStatusRank(status: string | undefined): number {
  if (status === 'active') return 4
  if (status === 'pending_approval') return 3
  if (status === 'sighted') return 2
  if (status === 'offline') return 1
  return 0
}

/** Merge duplicate peer presence across networks, preferring an active and then lower-latency route. */
export function mergeFleetPeers(candidates: MyOwnMeshNetworkCandidate[]): DirectMeshPeer[] {
  const merged = new Map<string, MyOwnMeshPeer>()
  for (const candidate of candidates) {
    for (const peer of candidate.peers ?? []) {
      if (!applicationPeer(peer)) continue
      const siteId = canonicalDevice(peer.device_id)
      if (!siteId) continue
      const current = merged.get(siteId)
      const rank = peerStatusRank(peer.status)
      const currentRank = peerStatusRank(current?.status)
      const latency = typeof peer.rtt_ms === 'number' ? peer.rtt_ms : Number.POSITIVE_INFINITY
      const currentLatency = typeof current?.rtt_ms === 'number' ? current.rtt_ms : Number.POSITIVE_INFINITY
      if (!current || rank > currentRank || (rank === currentRank && latency < currentLatency)) {
        merged.set(siteId, peer)
      }
    }
  }
  return [...merged.entries()].map(([siteId, peer]) => ({
    siteId,
    label: safeLabel(peer.label, siteId.slice(0, 8)),
    online: peer.status === 'active',
    status: peer.status ?? 'unknown',
    ...(typeof peer.rtt_ms === 'number' ? { rttMs: peer.rtt_ms } : {}),
  }))
}

/** Pick an active application-RPC route for one peer from an already best-first network list. */
export function selectPeerNetwork(
  candidates: MyOwnMeshNetworkCandidate[],
  peerId: string,
): MyOwnMeshNetworkCandidate | undefined {
  const wanted = canonicalDevice(peerId)
  return candidates
    .map((candidate, order) => ({
      candidate,
      order,
      peer: (candidate.peers ?? []).find((peer) => applicationPeer(peer) && canonicalDevice(peer.device_id) === wanted),
    }))
    .filter((entry) => entry.peer?.status === 'active')
    .sort((left, right) => {
      const leftRtt = typeof left.peer?.rtt_ms === 'number' ? left.peer.rtt_ms : Number.POSITIVE_INFINITY
      const rightRtt = typeof right.peer?.rtt_ms === 'number' ? right.peer.rtt_ms : Number.POSITIVE_INFINITY
      return leftRtt - rightRtt || left.order - right.order
    })[0]?.candidate
}

/**
 * Site-free hub transport over MyOwnMesh's generic authenticated RPC lane. It uses one persistent local
 * event subscription for inbound calls and ordinary one-shot local IPC connections for outbound calls.
 * No TCP listener, mapped localhost port, or AllMyStuff Site is involved.
 */
export class MyOwnMeshRpcBridge {
  private networks: MyOwnMeshNetworkCandidate[] = []
  private networkDiscoveredAt = 0
  private handler: DirectMeshHandler | null = null
  private readonly eventSockets = new Map<string, net.Socket>()
  private readonly connectingNetworks = new Map<string, Promise<void>>()
  private readonly connectingSockets = new Map<string, net.Socket>()
  private stopped = true
  private reconnectTimer: NodeJS.Timeout | null = null
  private reconnectAttempt = 0
  private unavailableReason: DirectMeshUnavailableReason = 'not-started'
  private unavailableError: string | undefined

  constructor(
    private readonly request: MyOwnMeshControlRequest = myOwnMeshControlRequest,
    private readonly socketPath = defaultMyOwnMeshSocketPath(),
    private readonly method = DEFAULT_METHOD,
  ) {}

  status(): DirectMeshStatus {
    const networkIds = [...this.eventSockets.entries()]
      .filter(([, socket]) => !socket.destroyed)
      .map(([network]) => network)
    return {
      available: networkIds.length > 0,
      ...(networkIds[0] ? { networkId: networkIds[0], networkIds } : {}),
      method: this.method,
      ...(networkIds.length === 0 ? {
        reason: this.unavailableReason,
        ...(this.unavailableError ? { error: this.unavailableError } : {}),
      } : {}),
    }
  }

  async identity(): Promise<DirectMeshIdentity | null> {
    const response = await this.request<Record<string, unknown>>({ op: 'identity_show' }, 4_000).catch(() => null)
    if (!response?.ok || !response.data) return null
    const data = response.data
    const raw = typeof data.device_id === 'string'
      ? data.device_id
      : typeof data.deviceId === 'string'
        ? data.deviceId
        : typeof data.node === 'string'
          ? data.node
          : ''
    const siteId = canonicalDevice(raw)
    if (!siteId) return null
    const label = safeLabel(data.label, os.hostname())
    return { siteId, label }
  }

  async peers(forceDiscovery = false): Promise<DirectMeshPeer[]> {
    const networks = await this.discoverNetworks(forceDiscovery)
    if (!this.stopped) void this.syncInboundNetworks(networks)
    return mergeFleetPeers(networks)
  }

  setHandler(handler: DirectMeshHandler): void {
    this.handler = handler
  }

  async start(
    handler?: DirectMeshHandler,
    options: { requireConnection?: boolean } = {},
  ): Promise<void> {
    if (handler) this.handler = handler
    if (!this.handler) throw new Error('A direct mesh RPC handler must be configured before start.')
    this.stopped = false
    this.unavailableReason = 'connecting'
    this.unavailableError = undefined
    await this.connectInbound()
    if (options.requireConnection && this.eventSockets.size === 0) {
      const status = this.status()
      this.stop()
      throw new Error(
        status.error ||
          `MyOwnMesh direct RPC did not open an inbound route (${status.reason ?? 'unavailable'}).`,
      )
    }
  }

  stop(): void {
    this.stopped = true
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer)
    this.reconnectTimer = null
    for (const socket of this.eventSockets.values()) socket.destroy()
    for (const socket of this.connectingSockets.values()) socket.destroy()
    this.eventSockets.clear()
    this.connectingNetworks.clear()
    this.connectingSockets.clear()
    this.unavailableReason = 'not-started'
    this.unavailableError = undefined
  }

  async call(peer: string, payload: unknown, timeoutMs = 20_000): Promise<unknown> {
    let networks = await this.discoverNetworks()
    let network = selectPeerNetwork(networks, peer)
    if (!network) {
      networks = await this.discoverNetworks(true)
      network = selectPeerNetwork(networks, peer)
    }
    if (!network) {
      const known = mergeFleetPeers(networks).find((candidate) => candidate.siteId === canonicalDevice(peer))
      throw new Error(known
        ? `MyOwnMesh peer ${known.label} is ${known.status} on every eligible shared network.`
        : 'No active AllMyStuff fleet route to that peer was found.')
    }
    const response = await this.request<{ response?: unknown }>({
      op: 'rpc_call',
      network: network.config_id,
      peer: canonicalDevice(peer),
      method: this.method,
      payload,
    }, timeoutMs)
    if (!response.ok) throw responseError(response, 'direct hub RPC')
    return response.data?.response
  }

  private async discoverNetworks(force = false): Promise<MyOwnMeshNetworkCandidate[]> {
    if (this.networks.length > 0 && !force && Date.now() - this.networkDiscoveredAt < NETWORK_DISCOVERY_TTL_MS) {
      this.networks = await Promise.all(this.networks.map(async (candidate) => ({
        ...candidate,
        peers: await this.readPeers(candidate.config_id),
      })))
      return this.networks
    }
    const preferred = process.env.ALLMYAGENTS_MESH_NETWORK?.trim()
    let listed: MyOwnMeshControlResponse<{ networks?: MyOwnMeshNetworkCandidate[] }>
    try {
      listed = await this.request<{ networks?: MyOwnMeshNetworkCandidate[] }>({ op: 'networks_list' }, 5_000)
    } catch (error) {
      this.recordControlFailure(error)
      return this.networks
    }
    if (!listed.ok) {
      this.unavailableReason = 'control-error'
      this.unavailableError = (listed.error || 'MyOwnMesh refused network discovery').slice(0, MAX_ERROR_CHARS)
      return this.networks
    }
    const candidates = await Promise.all((listed.data?.networks ?? []).map(async (candidate) => ({
      ...candidate,
      peers: await this.readPeers(candidate.config_id),
    })))
    this.networks = preferred
      ? candidates.filter((candidate) => candidate.config_id === preferred || candidate.network_id === preferred)
      : selectFleetNetworks(candidates)
    this.networkDiscoveredAt = Date.now()
    if (this.networks.length === 0) {
      this.unavailableReason = 'no-networks'
      this.unavailableError = 'MyOwnMesh answered, but no eligible active AllMyStuff fleet network was found.'
    } else if (this.eventSockets.size === 0) {
      this.unavailableReason = 'connecting'
      this.unavailableError = undefined
    }
    return this.networks
  }

  private async readPeers(network: string): Promise<MyOwnMeshPeer[]> {
    const response = await this.request<{ peers?: MyOwnMeshPeer[] }>({ op: 'peers_list', network }, 5_000).catch(() => null)
    return response?.ok && Array.isArray(response.data?.peers) ? response.data.peers : []
  }

  private async connectInbound(): Promise<void> {
    if (this.stopped) return
    const networks = await this.discoverNetworks(true)
    if (networks.length === 0) {
      this.scheduleReconnect()
      return
    }
    await this.syncInboundNetworks(networks)
    if (this.eventSockets.size < networks.length) this.scheduleReconnect()
  }

  private async syncInboundNetworks(networks: MyOwnMeshNetworkCandidate[]): Promise<void> {
    if (this.stopped) return
    const desired = new Set(networks.map((network) => network.config_id))
    for (const [network, socket] of this.eventSockets) {
      if (!desired.has(network)) socket.destroy()
    }
    const results = await Promise.allSettled(
      networks.map((network) => this.connectInboundNetwork(network.config_id)),
    )
    // Each failed socket records a typed unavailable reason. The hub remains fail-soft and retries in
    // the background; callers that require a live lane (the lightweight node) use requireConnection.
  }

  private async connectInboundNetwork(network: string): Promise<void> {
    if (this.stopped || this.eventSockets.has(network)) return
    const pending = this.connectingNetworks.get(network)
    if (pending) return pending
    const connection = this.openInboundNetwork(network)
    this.connectingNetworks.set(network, connection)
    try {
      await connection
      this.unavailableError = undefined
    } finally {
      if (this.connectingNetworks.get(network) === connection) this.connectingNetworks.delete(network)
    }
  }

  private async openInboundNetwork(network: string): Promise<void> {
    try {
      await new Promise<void>((resolve, reject) => {
      const socket = net.createConnection(this.socketPath)
      this.connectingSockets.set(network, socket)
      let buffer = ''
      let acknowledged = false
      let settled = false
      const timeout = setTimeout(() => {
        if (!acknowledged) socket.destroy(new Error('MyOwnMesh event subscription timed out'))
      }, 8_000)
      timeout.unref?.()
      const finishStart = (error?: Error): void => {
        if (settled) return
        settled = true
        clearTimeout(timeout)
        if (error) reject(error)
        else resolve()
      }
      socket.on('connect', () => socket.write('{"op":"events_subscribe"}\n'))
      socket.on('data', (chunk: Buffer) => {
        buffer += chunk.toString('utf8')
        if (Buffer.byteLength(buffer) > MAX_CONTROL_LINE_BYTES) {
          socket.destroy(new Error('MyOwnMesh event frame exceeded its size bound'))
          return
        }
        while (true) {
          const newline = buffer.indexOf('\n')
          if (newline < 0) break
          const line = buffer.slice(0, newline)
          buffer = buffer.slice(newline + 1)
          if (!line.trim()) continue
          let frame: Record<string, unknown>
          try {
            frame = JSON.parse(line) as Record<string, unknown>
          } catch {
            continue
          }
          if (!acknowledged) {
            const response = frame as unknown as MyOwnMeshControlResponse<{ client_id?: string }>
            const clientId = response.data?.client_id
            if (!response.ok || !clientId) {
              socket.destroy(responseError(response, 'MyOwnMesh event subscription'))
              return
            }
            acknowledged = true
            void this.registerHandler(clientId, network)
              .then(() => {
                if (this.stopped || socket.destroyed) {
                  finishStart(new Error(this.stopped
                    ? 'Direct mesh bridge stopped during registration'
                    : 'MyOwnMesh event socket closed during registration'))
                  if (!socket.destroyed) socket.destroy()
                  return
                }
                this.connectingSockets.delete(network)
                this.eventSockets.set(network, socket)
                this.reconnectAttempt = 0
                finishStart()
              })
              .catch((error) => socket.destroy(error instanceof Error ? error : new Error(String(error))))
            continue
          }
          void this.handleFrame(frame)
        }
      })
      socket.on('error', (error) => finishStart(error))
      socket.on('close', () => {
        clearTimeout(timeout)
        if (this.connectingSockets.get(network) === socket) this.connectingSockets.delete(network)
        if (this.eventSockets.get(network) === socket) this.eventSockets.delete(network)
        if (!settled) finishStart(new Error(acknowledged
          ? 'MyOwnMesh event socket closed during registration'
          : 'MyOwnMesh event socket closed before subscription'))
        this.scheduleReconnect()
      })
      })
      this.unavailableError = undefined
    } catch (error) {
      this.recordControlFailure(error)
      throw error
    }
  }

  private async registerHandler(clientId: string, network: string): Promise<void> {
    const response = await this.request({
      op: 'rpc_register',
      client_id: clientId,
      network,
      method: this.method,
      streaming: false,
    }, 8_000)
    if (!response.ok) throw responseError(response, 'direct hub RPC registration')
  }

  private async handleFrame(frame: Record<string, unknown>): Promise<void> {
    if (frame.kind !== 'rpc_inbound' || frame.method !== this.method || !this.handler) return
    const requestId = typeof frame.request_id === 'string' ? frame.request_id : ''
    const network = typeof frame.network === 'string' ? frame.network : ''
    const from = typeof frame.from === 'string' ? canonicalDevice(frame.from) : ''
    if (!requestId || !network || !from) return
    try {
      const result = await this.handler({ network, from, payload: frame.payload })
      await this.request({ op: 'rpc_respond', request_id: requestId, ok: result ?? null }, 10_000)
    } catch (error) {
      await this.request({
        op: 'rpc_respond',
        request_id: requestId,
        error: (error instanceof Error ? error.message : String(error)).slice(0, MAX_ERROR_CHARS),
      }, 10_000).catch(() => undefined)
    }
  }

  private scheduleReconnect(): void {
    if (this.stopped || this.reconnectTimer) return
    const delay = Math.min(30_000, 1_000 * 2 ** Math.min(this.reconnectAttempt++, 5))
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null
      void this.connectInbound()
    }, delay)
    this.reconnectTimer.unref?.()
  }

  private recordControlFailure(error: unknown): void {
    const code = typeof error === 'object' && error !== null && 'code' in error
      ? String((error as { code?: unknown }).code ?? '')
      : ''
    const message = (error instanceof Error ? error.message : String(error)).slice(0, MAX_ERROR_CHARS)
    if (code === 'ENOENT') {
      this.unavailableReason = 'no-daemon'
      this.unavailableError = 'MyOwnMesh control socket was not found. Start or repair MyOwnMesh on this machine.'
      return
    }
    if (code === 'EPERM' || code === 'EACCES' || /access.*denied|permission/i.test(message)) {
      this.unavailableReason = 'permission-denied'
      this.unavailableError = process.platform === 'win32'
        ? 'MyOwnMesh is running, but this user cannot open its control pipe for read/write access. Repair the pipe ACL so the interactive user has full duplex access.'
        : 'MyOwnMesh is running, but this user cannot read and write its control socket. Repair the socket ownership or permissions.'
      return
    }
    this.unavailableReason = 'control-error'
    this.unavailableError = message || 'MyOwnMesh control request failed.'
  }
}
