import crypto from 'node:crypto'
import fs from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'

const TAG_JSON = 0
const TAG_BYTES = 1
const MAX_FRAME_BYTES = 64 * 1024 * 1024
const MAX_JSON_RESPONSE_BYTES = 4 * 1024 * 1024
const FILE_CHUNK_BYTES = 512 * 1024

interface WireResponse<T = unknown> {
  ok: boolean
  result?: T
  error?: string
}

export type FilePlaneEvent =
  | { kind: 'list'; req: number; path: string }
  | { kind: 'write'; req: number; path: string; data: string; append?: boolean; eof?: boolean }
  | { kind: 'mkdir'; req: number; path: string }
  | { kind: 'delete'; req: number; path: string }
  | { kind: 'entries'; req: number; path: string; home: string; entries: unknown[] }
  | { kind: 'ok'; req: number }
  | { kind: 'err'; req: number; reason: string }

export interface AllMyStuffTransferProgress {
  file: string
  filesCompleted: number
  filesTotal: number
  bytesTransferred: number
  bytesTotal: number
  elapsedMs: number
  bytesPerSecond: number
}

export interface AllMyStuffCommandResult {
  ok: boolean
  exitCode: number
  output: string
  elapsedMs: number
}

type PlaneFrameRequest = (
  command: string,
  args: Record<string, unknown>,
  expectedTag: 0 | 1,
  timeoutMs: number,
) => Promise<Buffer>

function defaultSocketPath(): string {
  if (process.env.AMST_NODE_SOCKET?.trim()) return process.env.AMST_NODE_SOCKET.trim()
  if (process.platform === 'win32') return '\\\\.\\pipe\\allmystuff-node'
  const configuredHome = process.env.MYOWNMESH_HOME?.trim()
  const base = configuredHome || path.join(os.homedir(), '.myownmesh')
  return path.join(base, 'allmystuff-node.sock')
}

function framedRequest(
  socketPath: string,
  command: string,
  args: Record<string, unknown>,
  expectedTag: 0 | 1,
  timeoutMs: number,
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(socketPath)
    let buffer = Buffer.alloc(0)
    let settled = false
    const finish = (error?: Error, body?: Buffer): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      socket.destroy()
      if (error) reject(error)
      else resolve(body ?? Buffer.alloc(0))
    }
    const timer = setTimeout(() => finish(new Error(`AllMyStuff ${command} timed out after ${timeoutMs}ms`)), timeoutMs)
    timer.unref?.()
    socket.on('connect', () => {
      const payload = Buffer.from(JSON.stringify({ cmd: command, args }), 'utf8')
      const frame = Buffer.allocUnsafe(payload.length + 5)
      frame.writeUInt32BE(payload.length + 1, 0)
      frame.writeUInt8(TAG_JSON, 4)
      payload.copy(frame, 5)
      socket.write(frame)
    })
    socket.on('data', (chunk: Buffer) => {
      buffer = Buffer.concat([buffer, chunk])
      while (buffer.length >= 4) {
        const length = buffer.readUInt32BE(0)
        if (length < 1 || length > MAX_FRAME_BYTES) {
          finish(new Error('AllMyStuff control frame length was invalid'))
          return
        }
        if (buffer.length < length + 4) return
        const tag = buffer.readUInt8(4)
        const body = buffer.subarray(5, 4 + length)
        buffer = buffer.subarray(4 + length)
        if (tag !== expectedTag) continue
        finish(undefined, body)
        return
      }
    })
    socket.on('error', (error) => finish(error))
    socket.on('close', () => finish(new Error(`AllMyStuff ${command} closed before responding`)))
  })
}

function decodeBatches(body: Buffer, json: boolean): Array<Buffer | FilePlaneEvent> {
  const values: Array<Buffer | FilePlaneEvent> = []
  let offset = 0
  while (offset + 4 <= body.length) {
    const length = body.readUInt32LE(offset)
    offset += 4
    if (length === 0 || offset + length > body.length) break
    const value = body.subarray(offset, offset + length)
    offset += length
    if (!json) values.push(value)
    else {
      try { values.push(JSON.parse(value.toString('utf8')) as FilePlaneEvent) } catch { /* Drop one malformed response. */ }
    }
  }
  return values
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function remoteJoin(root: string, ...parts: string[]): string {
  const separator = /^[A-Za-z]:[\\/]/u.test(root) || root.includes('\\') ? '\\' : '/'
  return [root.replace(/[\\/]+$/u, ''), ...parts.map((part) => part
    .replace(/^[\\/]+|[\\/]+$/gu, '')
    .split(/[\\/]+/u)
    .join(separator))]
    .filter(Boolean)
    .join(separator)
}

function payloadFiles(root: string): Array<{ absolute: string; relative: string; bytes: number }> {
  const files: Array<{ absolute: string; relative: string; bytes: number }> = []
  const walk = (directory: string, relative: string): void => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const childRelative = relative ? path.posix.join(relative, entry.name) : entry.name
      const absolute = path.join(directory, entry.name)
      if (entry.isDirectory()) walk(absolute, childRelative)
      else if (entry.isFile()) files.push({ absolute, relative: childRelative, bytes: fs.statSync(absolute).size })
    }
  }
  walk(root, '')
  return files
}

export class AllMyStuffPlanes {
  private requestId = 0
  private readonly request: PlaneFrameRequest

  constructor(input?: { socketPath?: string; request?: PlaneFrameRequest }) {
    const socketPath = input?.socketPath ?? defaultSocketPath()
    this.request = input?.request ?? ((command, args, expectedTag, timeoutMs) =>
      framedRequest(socketPath, command, args, expectedTag, timeoutMs))
  }

  private async json<T = unknown>(command: string, args: Record<string, unknown>, timeoutMs = 10_000): Promise<T> {
    const body = await this.request(command, args, TAG_JSON, timeoutMs)
    if (body.length > MAX_JSON_RESPONSE_BYTES) throw new Error(`AllMyStuff ${command} JSON response exceeded its size bound`)
    const response = JSON.parse(body.toString('utf8')) as WireResponse<T>
    if (!response.ok) throw new Error(response.error?.slice(0, 2_000) || `AllMyStuff ${command} failed`)
    return response.result as T
  }

  private bytes(command: string, args: Record<string, unknown>, timeoutMs = 10_000): Promise<Buffer> {
    return this.request(command, args, TAG_BYTES, timeoutMs)
  }

  async connectTerminal(localDevice: string, remoteDevice: string): Promise<string> {
    const nonce = `${Date.now().toString(36)}-${(++this.requestId).toString(36)}`
    return await this.json<string>('connect_route', {
      from: `${remoteDevice}:terminal`,
      to: `${localDevice}:term-view:${nonce}`,
      media: 'generic',
      video: [],
      session: null,
    }, 15_000)
  }

  async connectFiles(localDevice: string, remoteDevice: string): Promise<string> {
    const nonce = `${Date.now().toString(36)}-${(++this.requestId).toString(36)}`
    return await this.json<string>('connect_route', {
      from: `${remoteDevice}:files`,
      to: `${localDevice}:files-view:${nonce}`,
      media: 'generic',
      video: [],
      session: null,
    }, 15_000)
  }

  async disconnect(routeId: string): Promise<void> {
    await this.json('disconnect_route', { route_id: routeId }, 10_000).catch(() => undefined)
  }

  private async waitTerminalReady(routeId: string, timeoutMs = 20_000): Promise<number> {
    const token = await this.json<number>('term_watch', { route_id: routeId })
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      try {
        await this.json('term_send', { route_id: routeId, event: { kind: 'resize', cols: 120, rows: 40 } }, 5_000)
        return token
      } catch {
        await delay(100)
      }
    }
    await this.json('term_unwatch', { route_id: routeId, token }).catch(() => undefined)
    throw new Error('AllMyStuff remote terminal did not become active')
  }

  async runCommand(routeId: string, platform: 'windows' | 'unix', command: string, timeoutMs = 120_000): Promise<AllMyStuffCommandResult> {
    const token = await this.waitTerminalReady(routeId)
    const marker = `__AMA_DONE_${cryptoRandomMarker()}__`
    const wrapped = platform === 'windows'
      ? `& { ${command} }; $amaExit = if ($null -eq $LASTEXITCODE) { if ($?) { 0 } else { 1 } } else { $LASTEXITCODE }; Write-Output \"${marker}:$amaExit\"`
      : `{ ${command}; }; ama_exit=$?; printf '\\n${marker}:%s\\n' \"$ama_exit\"`
    const started = performance.now()
    const deadline = Date.now() + timeoutMs
    let output = ''
    try {
      await this.json('term_send', {
        route_id: routeId,
        event: { kind: 'data', bytes: Buffer.from(`${wrapped}\r\n`, 'utf8').toString('base64') },
      }, 10_000)
      while (Date.now() < deadline) {
        const body = await this.bytes('term_poll', { route_id: routeId }, 10_000)
        for (const chunk of decodeBatches(body, false) as Buffer[]) output += chunk.toString('utf8')
        const match = output.match(new RegExp(`${marker}:(\\d+)`, 'u'))
        if (match) {
          const exitCode = Number(match[1])
          return {
            ok: exitCode === 0,
            exitCode,
            output: output.slice(0, 2 * 1024 * 1024),
            elapsedMs: Math.round((performance.now() - started) * 10) / 10,
          }
        }
        if (Buffer.byteLength(output) > 2 * 1024 * 1024) throw new Error('AllMyStuff terminal output exceeded its bootstrap bound')
        await delay(50)
      }
      throw new Error(`AllMyStuff remote command outcome was not observed within ${timeoutMs}ms`)
    } finally {
      await this.json('term_unwatch', { route_id: routeId, token }).catch(() => undefined)
    }
  }

  private async pollFileResponse(routeId: string, req: number, timeoutMs: number): Promise<FilePlaneEvent> {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      const body = await this.bytes('file_poll', { route_id: routeId }, 10_000)
      for (const event of decodeBatches(body, true) as FilePlaneEvent[]) {
        if (event.req !== req) continue
        if (event.kind === 'err') throw new Error(event.reason)
        if (event.kind === 'ok' || event.kind === 'entries') return event
      }
      await delay(75)
    }
    throw new Error(`AllMyStuff file operation ${req} outcome was not observed within ${timeoutMs}ms`)
  }

  private async sendFileEvent(routeId: string, event: FilePlaneEvent): Promise<void> {
    await this.json('file_send', { route_id: routeId, event }, 15_000)
  }

  async remoteHome(routeId: string): Promise<string> {
    const token = await this.json<number>('file_watch', { route_id: routeId })
    const req = ++this.requestId
    try {
      const deadline = Date.now() + 20_000
      while (true) {
        try {
          await this.sendFileEvent(routeId, { kind: 'list', req, path: '' })
          break
        } catch (error) {
          if (Date.now() >= deadline) throw error
          await delay(100)
        }
      }
      const response = await this.pollFileResponse(routeId, req, 20_000)
      if (response.kind !== 'entries' || !response.home) throw new Error('AllMyStuff did not return the remote home directory')
      return response.home
    } finally {
      await this.json('file_unwatch', { route_id: routeId, token }).catch(() => undefined)
    }
  }

  async removeTree(routeId: string, remotePath: string): Promise<void> {
    if (!remotePath || /^[A-Za-z]:[\\/]?$/u.test(remotePath) || remotePath === '/' || remotePath === '\\') {
      throw new Error('refusing to remove an unbounded remote path')
    }
    const token = await this.json<number>('file_watch', { route_id: routeId })
    const req = ++this.requestId
    try {
      await this.sendFileEvent(routeId, { kind: 'delete', req, path: remotePath })
      await this.pollFileResponse(routeId, req, 60_000)
    } finally {
      await this.json('file_unwatch', { route_id: routeId, token }).catch(() => undefined)
    }
  }

  async uploadTree(
    routeId: string,
    localRoot: string,
    remoteRoot: string,
    onProgress?: (progress: AllMyStuffTransferProgress) => void,
  ): Promise<{ files: number; bytes: number; elapsedMs: number; bytesPerSecond: number }> {
    const files = payloadFiles(localRoot)
    const bytesTotal = files.reduce((total, file) => total + file.bytes, 0)
    const token = await this.json<number>('file_watch', { route_id: routeId })
    const started = performance.now()
    let bytesTransferred = 0
    const mkdir = async (remotePath: string): Promise<void> => {
      const req = ++this.requestId
      await this.sendFileEvent(routeId, { kind: 'mkdir', req, path: remotePath })
      await this.pollFileResponse(routeId, req, 30_000)
    }
    try {
      await mkdir(remoteRoot)
      const directories = [...new Set(files.map((file) => path.posix.dirname(file.relative)).filter((value) => value !== '.'))]
        .sort((left, right) => left.split('/').length - right.split('/').length)
      for (const directory of directories) await mkdir(remoteJoin(remoteRoot, directory))
      for (let fileIndex = 0; fileIndex < files.length; fileIndex += 1) {
        const file = files[fileIndex]!
        const handle = fs.openSync(file.absolute, 'r')
        const req = ++this.requestId
        let offset = 0
        try {
          if (file.bytes === 0) {
            await this.sendFileEvent(routeId, { kind: 'write', req, path: remoteJoin(remoteRoot, file.relative), data: '', append: false, eof: true })
          } else {
            const buffer = Buffer.allocUnsafe(Math.min(FILE_CHUNK_BYTES, file.bytes))
            while (offset < file.bytes) {
              const count = fs.readSync(handle, buffer, 0, Math.min(buffer.length, file.bytes - offset), offset)
              if (count <= 0) throw new Error(`local testbed payload ended early at ${file.relative}`)
              await this.sendFileEvent(routeId, {
                kind: 'write',
                req,
                path: remoteJoin(remoteRoot, file.relative),
                data: buffer.subarray(0, count).toString('base64'),
                append: offset > 0,
                eof: offset + count >= file.bytes,
              })
              offset += count
              bytesTransferred += count
              const elapsedMs = Math.max(1, performance.now() - started)
              onProgress?.({
                file: file.relative,
                filesCompleted: fileIndex,
                filesTotal: files.length,
                bytesTransferred,
                bytesTotal,
                elapsedMs: Math.round(elapsedMs * 10) / 10,
                bytesPerSecond: Math.round(bytesTransferred / (elapsedMs / 1000)),
              })
            }
          }
        } finally {
          fs.closeSync(handle)
        }
        await this.pollFileResponse(routeId, req, Math.max(30_000, Math.ceil(file.bytes / 50_000)))
      }
      const elapsedMs = Math.max(1, performance.now() - started)
      return {
        files: files.length,
        bytes: bytesTransferred,
        elapsedMs: Math.round(elapsedMs * 10) / 10,
        bytesPerSecond: Math.round(bytesTransferred / (elapsedMs / 1000)),
      }
    } finally {
      await this.json('file_unwatch', { route_id: routeId, token }).catch(() => undefined)
    }
  }
}

function cryptoRandomMarker(): string {
  return crypto.randomBytes(8).toString('hex')
}

export const allMyStuffRemotePathJoin = remoteJoin
