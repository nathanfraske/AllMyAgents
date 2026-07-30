import { describe, expect, it } from 'vitest'
import { BrowserBroker, type BrowserTransport } from './browserBroker.js'
import { BROWSER_PROTOCOL_VERSION, type BrowserCommand } from './browserProtocol.js'

const hello = {
  protocolVersion: BROWSER_PROTOCOL_VERSION,
  desktopInstanceId: 'desktop-a',
}

function transport(command?: BrowserTransport['command']): BrowserTransport {
  return {
    hello: async () => hello,
    command:
      command ??
      (async (input) => ({
        hello,
        result: {
          id: input.id,
          protocolVersion: BROWSER_PROTOCOL_VERSION,
          ok: true,
          content: [{ type: 'text', text: 'page' }],
        },
      })),
    nextEvent: async (signal) =>
      await new Promise((_, reject) => signal.addEventListener('abort', () => reject(new Error('stopped')))),
  }
}

describe('BrowserBroker', () => {
  it('fails closed with a clear reason when the desktop broker is absent', async () => {
    const broker = new BrowserBroker({})

    await expect(
      broker.execute({
        sessionId: 'session-a',
        operation: 'navigate',
        arguments: { url: 'https://example.com/' },
      }),
    ).rejects.toThrow(
      'Browser unavailable: this hub was started without an authenticated desktop browser broker.',
    )
  })

  it('fails closed when a configured desktop endpoint is unreachable', async () => {
    const broker = new BrowserBroker({
      transport: {
        ...transport(),
        hello: async () => {
          throw new Error('connection refused')
        },
      },
    })

    await expect(
      broker.execute({
        sessionId: 'session-a',
        operation: 'read',
        arguments: {},
      }),
    ).rejects.toThrow(
      'Browser unavailable: no compatible AllMyAgents desktop browser host is connected. Headless hub sessions cannot browse.',
    )
  })

  it('rejects an older desktop protocol instead of silently degrading', async () => {
    const broker = new BrowserBroker({
      transport: {
        ...transport(),
        hello: async () => ({ protocolVersion: BROWSER_PROTOCOL_VERSION - 1, desktopInstanceId: 'old-desktop' }),
      },
    })
    await broker.refresh()
    expect(broker.status()).toEqual({
      available: false,
      reason: 'Browser unavailable: desktop browser protocol 0 is incompatible with hub protocol 1.',
    })
  })

  it('keeps an unverified desktop platform unavailable instead of sharing a fallback store', async () => {
    const broker = new BrowserBroker({
      transport: {
        ...transport(),
        hello: async () => ({
          ...hello,
          available: false,
          reason: 'Agent Browser is unavailable on this unverified platform.',
        }),
      },
    })
    await broker.refresh()
    expect(broker.status()).toEqual({
      available: false,
      reason: 'Agent Browser is unavailable on this unverified platform.',
    })
  })

  it('correlates one authenticated host command with its response', async () => {
    const broker = new BrowserBroker({ transport: transport() })
    await broker.refresh()

    await expect(
      broker.execute({
        sessionId: 'session-a',
        operation: 'read',
        arguments: {},
      }),
    ).resolves.toEqual([{ type: 'text', text: 'page' }])
  })

  it('keeps host-authored approval metadata out of ordinary model-visible content', async () => {
    const broker = new BrowserBroker({
      transport: transport(async (input) => ({
        hello,
        result: {
          id: input.id,
          protocolVersion: BROWSER_PROTOCOL_VERSION,
          ok: true,
          content: [],
          data: {
            token: 'action_0123456789abcdef',
            descriptor: { kind: 'button', name: 'Delete account' },
          },
        },
      })),
    })
    await broker.refresh()

    await expect(broker.executeDetailed({
      sessionId: 'session-a',
      operation: 'click_prepare',
      arguments: { ref: 'el_0123456789abcdef', pageGeneration: 'page_0123456789abcdef' },
    })).resolves.toEqual({
      content: [],
      data: {
        token: 'action_0123456789abcdef',
        descriptor: { kind: 'button', name: 'Delete account' },
      },
    })
  })

  it('queues a security-sensitive close behind an in-flight session command', async () => {
    let finishRead: ((command: BrowserCommand) => void) | undefined
    const broker = new BrowserBroker({
      transport: transport(async (command) => {
        if (command.operation === 'read') {
          await new Promise<BrowserCommand>((resolve) => {
            finishRead = resolve
          })
        }
        return {
          hello,
          result: {
            id: command.id,
            protocolVersion: BROWSER_PROTOCOL_VERSION,
            ok: true,
            content: [],
          },
        }
      }),
    })
    await broker.refresh()

    const readResponse = broker.execute({
      sessionId: 'session-a',
      operation: 'read',
      arguments: {},
    })
    const closeResponse = broker.executeAfterCurrent({
      sessionId: 'session-a',
      operation: 'close',
      arguments: {},
    })
    await Promise.resolve()
    finishRead?.({} as BrowserCommand)

    await expect(readResponse).resolves.toEqual([])
    await expect(closeResponse).resolves.toEqual([])
  })

  it('cancels an in-flight command when session browser authority is revoked', async () => {
    let finish: (() => void) | undefined
    const broker = new BrowserBroker({
      transport: transport(
        async (command) => {
          await new Promise<void>((resolve) => {
            finish = resolve
          })
          return {
            hello,
            result: {
              id: command.id,
              protocolVersion: BROWSER_PROTOCOL_VERSION,
              ok: true,
              content: [{ type: 'text', text: 'must not reach the model' }],
            },
          }
        },
      ),
    })
    await broker.refresh()
    const response = broker.execute({
      sessionId: 'session-a',
      operation: 'navigate',
      arguments: { url: 'https://example.com/' },
    })
    broker.cancelSession('session-a')
    finish?.()

    await expect(response).rejects.toThrow(
      'Browser command cancelled because this chat’s browser authority changed.',
    )
  })
})
