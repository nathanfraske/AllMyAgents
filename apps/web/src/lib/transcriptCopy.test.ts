import { describe, expect, it } from 'vitest'
import { transcriptClipboardPayload } from './transcriptCopy'

function selectContents(root: HTMLElement): Selection {
  const range = document.createRange()
  range.selectNodeContents(root)
  const selection = window.getSelection()
  if (!selection) throw new Error('selection API unavailable')
  selection.removeAllRanges()
  selection.addRange(range)
  return selection
}

function fixture(markup: string): { host: HTMLElement; selection: Selection } {
  const host = document.createElement('div')
  host.innerHTML = `<div data-transcript-copy>${markup}</div>`
  document.body.appendChild(host)
  return { host, selection: selectContents(host.querySelector('[data-transcript-copy]')!) }
}

function selectTextBetween(first: Node, last: Node): Selection {
  const range = document.createRange()
  range.setStart(first, 0)
  range.setEnd(last, last.textContent?.length ?? 0)
  const selection = window.getSelection()
  if (!selection) throw new Error('selection API unavailable')
  selection.removeAllRanges()
  selection.addRange(range)
  return selection
}

describe('transcript clipboard serialization', () => {
  it('copies rendered prose as clean text in both clipboard flavours', () => {
    const { host, selection } = fixture(
      '<div class="seg"><p style="color:red">Hello <strong class="loud">clean</strong> world.</p></div>',
    )

    expect(transcriptClipboardPayload(host, selection)).toEqual({
      plain: 'Hello clean world.',
      html: 'Hello clean world.',
    })
  })

  it('preserves code content exactly without syntax-highlighting markup', () => {
    const code = 'function answer() {\n  const value = "  keep spaces  ";\n\n  return value;\n}\n'
    const host = document.createElement('div')
    const copyRoot = document.createElement('div')
    copyRoot.dataset.transcriptCopy = ''
    copyRoot.innerHTML =
      '<div class="code"><div class="chead"><span>typescript</span><button>copy</button></div>' +
      '<pre class="cbody"><code></code></pre></div>'
    copyRoot.querySelector('code')!.append(
      document.createTextNode('function answer() {\n  const value = "  keep spaces  ";\n\n'),
      Object.assign(document.createElement('span'), { className: 'hljs-keyword', textContent: '  return' }),
      document.createTextNode(' value;\n}\n'),
    )
    host.append(copyRoot)
    document.body.append(host)

    expect(transcriptClipboardPayload(host, selectContents(copyRoot))).toEqual({
      plain: code,
      html:
        '<pre><code>function answer() {\n  const value = &quot;  keep spaces  &quot;;\n\n' +
        '  return value;\n}\n</code></pre>',
    })
  })

  it('keeps prose readable and code exact in a mixed selection', () => {
    const code = 'if (ready) {\n  run();\n}'
    const { host, selection } = fixture(
      '<div class="seg"><p>Before the code.</p></div>' +
      '<div class="seg"><div class="code"><div class="chead">shell<button>copy</button></div>' +
      `<pre><code>if (ready) {\n  <span class="hljs-title">run</span>();\n}</code></pre></div></div>` +
      '<div class="seg"><p>After the code.</p></div>',
    )

    expect(transcriptClipboardPayload(host, selection)).toEqual({
      plain: `Before the code.\n\n${code}\n\nAfter the code.`,
      html:
        `Before the code.<br><br><pre><code>if (ready) {\n  run();\n}</code></pre>` +
        '<br><br>After the code.',
    })
  })

  it('cleans a selection spanning transcript messages without copying intervening app chrome', () => {
    const host = document.createElement('div')
    host.innerHTML =
      '<div data-transcript-copy><p>First message.</p></div>' +
      '<div class="toolbar">Agent controls that are not transcript content</div>' +
      '<div data-transcript-copy><p>Second message.</p></div>'
    document.body.append(host)

    const messages = host.querySelectorAll('[data-transcript-copy]')
    const selection = selectTextBetween(messages[0].querySelector('p')!.firstChild!, messages[1].querySelector('p')!.firstChild!)
    expect(transcriptClipboardPayload(host, selection)).toEqual({
      plain: 'First message.\n\nSecond message.',
      html: 'First message.<br><br>Second message.',
    })
  })

  it('does not claim selections outside transcript content', () => {
    const host = document.createElement('div')
    host.innerHTML = '<div data-transcript-copy>message</div><textarea>composer text</textarea><div class="diff">diff text</div>'
    document.body.append(host)

    expect(transcriptClipboardPayload(host, selectContents(host.querySelector('textarea')!))).toBeNull()
    expect(transcriptClipboardPayload(host, selectContents(host.querySelector('.diff')!))).toBeNull()
  })
})
