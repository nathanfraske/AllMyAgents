import net from 'node:net'
import os from 'node:os'
import path from 'node:path'

const DEFAULT_METHOD = 'allmyagents.hub.v1'
const MAX_CONTROL_LINE_BYTES = 3 * 1024 * 1024
const MAX_ERROR_CHARS = 2_000

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

function canonicalDevice(value: string): string {
  return value.split('-', 1)[0]!.trim().toLowerCase()
}

function safeLabel(value: unknown, fallback: string): string {
  const label = typeof value === 'string' ? value.trim() : ''
  return label && label.length <= 200 && !/[\u0000-\u001f\u007f]/u.test(label) ? label : fallback
}

function defaultSocketPath(): string {
  if (process.env.MYOWNMESH_CONTROL_SOCKET?.trim()) return process.env.MYOWNMESH_CONTROL_SOCKET.trim()
  if (process.platform === 'win32') return '\\\\.\\pipe\\myownmesh.sock'
  const home = process.env.MYOWNMESH_HOME?.trim() || os.homedir()
  return path.join(home, process.env.MYOWNMESH_HOME?.trim() ? 'daemon.sock' : '.myownmesh', 'daemon.sock')
}

function responseError(response: MyOwnMeshControlResponse, operation: string): Error {
  return new Error(response.error?.slice(0, MAX_ERROR_CHARS) || `${operation} failed`)
}

/** One bounded JSON-line request to the existing MyOwnMesh daemon IPC socket. */
export function myOwnMeshControlRequest<T = unknown>(
  request: Record<string, unknown>,
  timeoutMs = 10_000,
  socketPath = defaultSocketPath(),
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

function allMyStuffPeer(peer: MyOwnMeshPeer): boolean {
  const tags = peer.capabilities?.tags
  return Array.isArray(tags) && tags.some((tag) => typeof tag === 'string' && tag.toLowerCase() === 'allmystuff')
}

/** Prefer the actual AllMyStuff fleet, never the LAN claim/support helper networks. */
export function selectFleetNetwork(candidates: MyOwnMeshNetworkCandidate[]): MyOwnMeshNetworkCandidate | undefined {
  return candidates
    .map((candidate) => {
      const label = `${candidate.label ?? ''} ${candidate.config_id} ${candidate.network_id ?? ''}`.toLowerCase()
      const peers = candidate.peers ?? []
      let score = candidate.phase === 'active' ? 10 : 0
      if (label.includes('fleet')) score += 100
      if (label.includes('allmystuff')) score += 30
      if (label.includes('local claim') || label.includes('support')) score -= 200
      score += peers.filter(allMyStuffPeer).length * 25
      score += peers.filter((peer) => peer.status === 'active').length * 5
      return { candidate, score }
    })
    .filter(({ candidate }) => (candidate.peers ?? []).some(allMyStuffPeer))
    .sort((left, right) => right.score - left.score)[0]?.candidate
}

/**
 * Site-free hub transport over MyOwnMesh's generic authenticated RPC lane. It uses one persistent local
 * event subscription for inbound calls and ordinary one-shot local IPC connections for outbound calls.
 * No TCP listener, mapped localhost port, or AllMyStuff Site is involved.
 */
export class MyOwnMeshRpcBridge {
  private networkId = ''
  private handler: DirectMeshHandler | null = null
  private eventSocket: net.Socket | null = null
  private stopped = true
  private reconnectTimer: NodeJS.Timeout | null = null
  private reconnectAttempt = 0

  constructor(
    private readonly request: MyOwnMeshControlRequest = myOwnMeshControlRequest,
    private readonly socketPath = defaultSocketPath(),
    private readonly method = DEFAULT_METHOD,
  ) {}

  status(): { available: boolean; networkId?: string; method: string } {
    return { available: Boolean(this.networkId && this.eventSocket && !this.eventSocket.destroyed), ...(this.networkId ? { networkId: this.networkId } : {}), method: this.method }
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
    const network = await this.discoverNetwork(forceDiscovery)
    if (!network) return []
    return (network.peers ?? [])
      .filter(allMyStuffPeer)
      .map((peer) => ({
        siteId: canonicalDevice(peer.device_id),
        label: safeLabel(peer.label, canonicalDevice(peer.device_id).slice(0, 8)),
        online: peer.status === 'active',
        status: peer.status ?? 'unknown',
        ...(typeof peer.rtt_ms === 'number' ? { rttMs: peer.rtt_ms } : {}),
      }))
  }

  setHandler(handler: DirectMeshHandler): void {
    this.handler = handler
  }

  async start(handler?: DirectMeshHandler): Promise<void> {
    if (handler) this.handler = handler
    if (!this.handler) throw new Error('A direct mesh RPC handler must be configured before start.')
    this.stopped = false
    await this.connectInbound()
  }

  stop(): void {
    this.stopped = true
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer)
    this.reconnectTimer = null
    this.eventSocket?.destroy()
    this.eventSocket = null
  }

  async call(peer: string, payload: unknown, timeoutMs = 20_000): Promise<unknown> {
    const network = await this.discoverNetwork()
    if (!network) throw new Error('No active AllMyStuff fleet network with compatible peers was found.')
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

  private async discoverNetwork(force = false): Promise<MyOwnMeshNetworkCandidate | undefined> {
    if (this.networkId && !force) {
      const peers = await this.readPeers(this.networkId)
      return { config_id: this.networkId, phase: 'active', peers }
    }
    const preferred = process.env.ALLMYAGENTS_MESH_NETWORK?.trim()
    const listed = await this.request<{ networks?: MyOwnMeshNetworkCandidate[] }>({ op: 'networks_list' }, 5_000).catch(() => null)
    if (!listed?.ok) return undefined
    const candidates = await Promise.all((listed.data?.networks ?? []).map(async (candidate) => ({
      ...candidate,
      peers: await this.readPeers(candidate.config_id),
    })))
    const selected = preferred
      ? candidates.find((candidate) => candidate.config_id === preferred || candidate.network_id === preferred)
      : selectFleetNetwork(candidates)
    this.networkId = selected?.config_id ?? ''
    return selected
  }

  private async readPeers(network: string): Promise<MyOwnMeshPeer[]> {
    const response = await this.request<{ peers?: MyOwnMeshPeer[] }>({ op: 'peers_list', network }, 5_000).catch(() => null)
    return response?.ok && Array.isArray(response.data?.peers) ? response.data.peers : []
  }

  private async connectInbound(): Promise<void> {
    if (this.stopped || this.eventSocket) return
    const network = await this.discoverNetwork(true)
    if (!network) {
      this.scheduleReconnect()
      return
    }
    await new Promise<void>((resolve, reject) => {
      const socket = net.createConnection(this.socketPath)
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
            this.eventSocket = socket
            void this.registerHandler(clientId, network.config_id)
              .then(() => {
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
        if (this.eventSocket === socket) this.eventSocket = null
        if (!acknowledged) finishStart(new Error('MyOwnMesh event socket closed before subscription'))
        this.scheduleReconnect()
      })
    }).catch(() => {
      this.scheduleReconnect()
    })
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
}
