<script lang="ts">
  const ALPHABET = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ'
  const LENGTH = 8

  let {
    value = $bindable(''),
    disabled = false,
    label = 'Pairing code',
    onchange = () => {},
    onenter = () => {},
  }: {
    value?: string
    disabled?: boolean
    label?: string
    onchange?: (value: string) => void
    onenter?: () => void
  } = $props()

  let cells = $state<HTMLInputElement[]>([])
  const characters = $derived(sanitize(value).split(''))

  function sanitize(raw: string): string {
    return [...raw.toUpperCase()]
      .filter((character) => ALPHABET.includes(character))
      .slice(0, LENGTH)
      .join('')
  }

  function format(raw: string): string {
    const clean = sanitize(raw)
    return clean.length > 4 ? `${clean.slice(0, 4)}-${clean.slice(4)}` : clean
  }

  function commit(raw: string, focusIndex?: number): void {
    value = format(raw)
    onchange(value)
    if (focusIndex === undefined) return
    queueMicrotask(() => cells[Math.min(focusIndex, LENGTH - 1)]?.focus())
  }

  function inputAt(index: number, event: Event): void {
    const typed = sanitize((event.currentTarget as HTMLInputElement).value)
    const next = [...characters]
    if (!typed) {
      next.splice(index, 1)
      commit(next.join(''))
      return
    }
    next.splice(index, typed.length, ...typed)
    commit(next.join(''), Math.min(index + typed.length, LENGTH - 1))
  }

  function keyAt(index: number, event: KeyboardEvent): void {
    if (event.key === 'Enter') {
      if (characters.length === LENGTH) onenter()
      return
    }
    if (event.key === 'ArrowLeft' && index > 0) {
      event.preventDefault()
      cells[index - 1]?.focus()
      return
    }
    if (event.key === 'ArrowRight' && index < LENGTH - 1) {
      event.preventDefault()
      cells[index + 1]?.focus()
      return
    }
    if (event.key !== 'Backspace') return
    event.preventDefault()
    const next = [...characters]
    if (next[index]) {
      next.splice(index, 1)
      commit(next.join(''), index)
    } else if (index > 0) {
      next.splice(index - 1, 1)
      commit(next.join(''), index - 1)
    }
  }

  function pasteAt(index: number, event: ClipboardEvent): void {
    const pasted = sanitize(event.clipboardData?.getData('text') ?? '')
    if (!pasted) return
    event.preventDefault()
    const start = pasted.length === LENGTH ? 0 : index
    const next = [...characters]
    next.splice(start, pasted.length, ...pasted)
    commit(next.join(''), Math.min(start + pasted.length, LENGTH - 1))
  }
</script>

<div class="pairing-cells" role="group" aria-label={label}>
  {#each Array(LENGTH) as _, index (index)}
    {#if index === 4}<span class="separator" aria-hidden="true">–</span>{/if}
    <input
      bind:this={cells[index]}
      class:filled={Boolean(characters[index])}
      aria-label={`${label}, character ${index + 1} of ${LENGTH}`}
      autocomplete={index === 0 ? 'one-time-code' : 'off'}
      autocapitalize="characters"
      inputmode="text"
      maxlength="1"
      spellcheck="false"
      {disabled}
      value={characters[index] ?? ''}
      onfocus={(event) => (event.currentTarget as HTMLInputElement).select()}
      oninput={(event) => inputAt(index, event)}
      onkeydown={(event) => keyAt(index, event)}
      onpaste={(event) => pasteAt(index, event)}
    />
  {/each}
</div>

<style>
  .pairing-cells {
    display: inline-flex;
    align-items: center;
    gap: 0.28rem;
    flex: none;
  }
  input {
    box-sizing: border-box;
    width: 2rem;
    min-width: 2rem;
    height: 2.25rem;
    padding: 0;
    border: 1px solid var(--border-strong, var(--border));
    border-radius: var(--r-sm, 6px);
    background: var(--surface-0, var(--surface));
    color: var(--text);
    font-family: var(--font-mono, ui-monospace, monospace);
    font-size: var(--text-sm, 0.875rem);
    font-weight: 700;
    line-height: 1;
    text-align: center;
    text-transform: uppercase;
  }
  input:focus {
    border-color: var(--accent);
    outline: 2px solid color-mix(in srgb, var(--accent) 28%, transparent);
    outline-offset: 1px;
  }
  input.filled { border-color: color-mix(in srgb, var(--accent) 62%, var(--border)); }
  input:disabled { cursor: not-allowed; opacity: 0.55; }
  .separator {
    margin: 0 0.08rem;
    color: var(--dim);
    font-family: var(--font-mono, ui-monospace, monospace);
    font-weight: 700;
  }
</style>
