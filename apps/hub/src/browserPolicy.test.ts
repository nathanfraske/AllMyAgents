import { describe, expect, it } from 'vitest';
import {
  decideBrowserGate,
  isLiteralLocalAddress,
  parseBrowserUrl,
  safeJournalUrl,
} from './browserPolicy.js';

describe('decideBrowserGate', () => {
  it('reports that browsing is off until the owner enables it for the chat', () => {
    expect(
      decideBrowserGate({
        enabled: false,
        isOperatorTurn: true,
        isTeammateMessageTurn: false,
      }),
    ).toEqual({
      ok: false,
      code: 'disabled',
      message: 'Browser access is off for this chat. The operator must enable it in the chat controls.',
    });
  });

  it('hard-denies a teammate-message turn even if the chat is enabled', () => {
    expect(
      decideBrowserGate({
        enabled: true,
        isOperatorTurn: true,
        isTeammateMessageTurn: true,
      }),
    ).toEqual({
      ok: false,
      code: 'teammate_message',
      message: 'Browser access is not available during a teammate-message turn.',
    });
  });

  it('fails closed when the turn cannot be attributed to the operator', () => {
    expect(
      decideBrowserGate({
        enabled: true,
        isOperatorTurn: false,
        isTeammateMessageTurn: false,
      }),
    ).toEqual({
      ok: false,
      code: 'unattributed_turn',
      message: 'Browser access is unavailable because this turn is not attributed to the operator.',
    });
  });

  it('allows an enabled, operator-attributed turn', () => {
    expect(
      decideBrowserGate({
        enabled: true,
        isOperatorTurn: true,
        isTeammateMessageTurn: false,
      }),
    ).toEqual({ ok: true });
  });
});

describe('browser URL policy', () => {
  it.each([
    'file:///etc/passwd',
    'data:text/html,hello',
    'javascript:alert(1)',
    'blob:https://example.com/id',
    'https://user:secret@example.com/',
  ])('rejects forbidden URL %s', (raw) => {
    expect(() => parseBrowserUrl(raw)).toThrow(/refused/)
  })

  it('removes fragments and query values from journal payloads', () => {
    const safe = safeJournalUrl(parseBrowserUrl('https://docs.example/a?token=secret&q=words&q=again#private'))
    expect(safe).toEqual({
      scheme: 'https',
      host: 'docs.example',
      path: '/a',
      queryKeys: ['q', 'token'],
    })
    expect(JSON.stringify(safe)).not.toContain('secret')
    expect(JSON.stringify(safe)).not.toContain('private')
    expect(JSON.stringify(safe)).not.toContain('words')
  })

  it.each(['localhost', '127.0.0.1', '10.1.2.3', '172.16.2.3', '192.168.1.2', '169.254.169.254', '::1'])(
    'classifies %s as local/private',
    (host) => expect(isLiteralLocalAddress(host)).toBe(true),
  )
})
