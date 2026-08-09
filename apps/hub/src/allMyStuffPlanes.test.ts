import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { AllMyStuffPlanes, allMyStuffRemotePathJoin, type FilePlaneEvent } from './allMyStuffPlanes.js'

const roots: string[] = []

function temporaryRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ama-planes-'))
  roots.push(root)
  return root
}

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true })
})

function json(value: unknown): Buffer {
  return Buffer.from(JSON.stringify({ ok: true, result: value }), 'utf8')
}

function batch(values: Array<Buffer | object>): Buffer {
  return Buffer.concat(values.map((raw) => {
    const value = Buffer.isBuffer(raw) ? raw : Buffer.from(JSON.stringify(raw), 'utf8')
    const header = Buffer.alloc(4)
    header.writeUInt32LE(value.length)
    return Buffer.concat([header, value])
  }))
}

describe('AllMyStuff privileged planes bootstrap client', () => {
  it('opens an owner/fleet terminal and observes one command outcome without resending it', async () => {
    let marker = ''
    let dataSends = 0
    let routeArgs: Record<string, unknown> | undefined
    const planes = new AllMyStuffPlanes({
      request: async (command, args, expectedTag) => {
        if (command === 'connect_route') { routeArgs = args; return json('route:terminal') }
        if (command === 'term_watch') return json(4)
        if (command === 'term_unwatch') return json(null)
        if (command === 'term_send') {
          const event = args.event as { kind: string; bytes?: string }
          if (event.kind === 'data') {
            dataSends += 1
            const sent = Buffer.from(event.bytes!, 'base64').toString('utf8')
            marker = sent.match(/__AMA_DONE_[0-9a-f]+__/u)?.[0] ?? ''
          }
          return json(null)
        }
        if (command === 'term_poll' && expectedTag === 1) return batch([Buffer.from(`installed\r\n${marker}:0\r\n`)])
        throw new Error(`unexpected ${command}`)
      },
    })
    const route = await planes.connectTerminal('local', 'remote')
    const result = await planes.runCommand(route, 'windows', 'Write-Output installed')
    expect(result).toMatchObject({ ok: true, exitCode: 0 })
    expect(result.output).toContain('installed')
    expect(dataSends).toBe(1)
    expect(routeArgs).toMatchObject({
      from: 'remote:terminal',
      to: expect.stringMatching(/^local:term-view:/u),
      media: 'generic',
    })
  })

  it('uploads a directory tree in bounded file-plane pieces and waits for each final acknowledgement', async () => {
    const root = temporaryRoot()
    fs.mkdirSync(path.join(root, 'dist'))
    fs.writeFileSync(path.join(root, 'README.txt'), 'hello')
    fs.writeFileSync(path.join(root, 'dist', 'node.js'), Buffer.alloc(700_000, 7))
    const responses: FilePlaneEvent[] = []
    const writes: Array<Extract<FilePlaneEvent, { kind: 'write' }>> = []
    const planes = new AllMyStuffPlanes({
      request: async (command, args, expectedTag) => {
        if (command === 'file_watch') return json(9)
        if (command === 'file_unwatch') return json(null)
        if (command === 'file_send') {
          const event = args.event as FilePlaneEvent
          if (event.kind === 'mkdir') responses.push({ kind: 'ok', req: event.req })
          if (event.kind === 'write') {
            writes.push(event)
            if (event.eof) responses.push({ kind: 'ok', req: event.req })
          }
          return json(null)
        }
        if (command === 'file_poll' && expectedTag === 1) {
          const pending = responses.splice(0)
          return batch(pending)
        }
        throw new Error(`unexpected ${command}`)
      },
    })
    const progress: number[] = []
    const result = await planes.uploadTree('route:files', root, 'C:\\Users\\Test\\.ama-bootstrap', (value) => {
      progress.push(value.bytesTransferred)
    })
    expect(result).toMatchObject({ files: 2, bytes: 700_005 })
    expect(writes.filter((event) => event.path.endsWith('node.js'))).toHaveLength(2)
    expect(writes.at(-1)?.eof).toBe(true)
    expect(progress.at(-1)).toBe(700_005)
  })

  it('uses the remote path family instead of the source operating system', () => {
    expect(allMyStuffRemotePathJoin('C:\\Users\\Test', '.ama', 'dist/node.js')).toBe('C:\\Users\\Test\\.ama\\dist\\node.js')
    expect(allMyStuffRemotePathJoin('/home/test', '.ama', 'dist/node.js')).toBe('/home/test/.ama/dist/node.js')
  })

  it('removes only a bounded exact bootstrap tree and refuses a drive root', async () => {
    const replies: FilePlaneEvent[] = []
    const sent: FilePlaneEvent[] = []
    const planes = new AllMyStuffPlanes({
      request: async (command, args, expectedTag) => {
        if (command === 'file_watch') return json(3)
        if (command === 'file_unwatch') return json(null)
        if (command === 'file_send') {
          const event = args.event as FilePlaneEvent
          sent.push(event)
          replies.push({ kind: 'ok', req: event.req })
          return json(null)
        }
        if (command === 'file_poll' && expectedTag === 1) return batch(replies.splice(0))
        throw new Error(`unexpected ${command}`)
      },
    })
    await planes.removeTree('route:files', 'C:\\Users\\Test\\.allmyagents-testbed-bootstrap\\deploy_1')
    expect(sent).toEqual([expect.objectContaining({
      kind: 'delete', path: 'C:\\Users\\Test\\.allmyagents-testbed-bootstrap\\deploy_1',
    })])
    await expect(planes.removeTree('route:files', 'C:\\')).rejects.toThrow(/unbounded remote path/u)
  })
})
