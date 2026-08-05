<script lang="ts">
  import Icon from './Icon.svelte'

  let { agentName, purpose }: { agentName: string; purpose: string } = $props()
  let open = $state(false)
  let popoutLeft = $state(0)
  let popoutTop = $state(0)
  let popoutBelow = $state(false)

  function toggle(event: MouseEvent): void {
    event.stopPropagation()
    if (!open) {
      const rect = (event.currentTarget as HTMLButtonElement).getBoundingClientRect()
      const popoutWidth = Math.min(320, Math.max(160, window.innerWidth - 16))
      popoutLeft = Math.min(window.innerWidth - popoutWidth / 2 - 8, Math.max(popoutWidth / 2 + 8, rect.left + rect.width / 2))
      popoutBelow = rect.top < 120
      popoutTop = popoutBelow ? rect.bottom + 6 : rect.top - 6
    }
    open = !open
  }

  function stop(event: Event): void {
    event.stopPropagation()
  }

  function keydown(event: KeyboardEvent): void {
    event.stopPropagation()
    if (event.key === 'Escape') {
      open = false
      event.preventDefault()
    }
  }

</script>

<span class="purpose-info" class:open>
  <button
    type="button"
    title={`Purpose: ${purpose}`}
    data-purpose={purpose}
    aria-label={`${agentName} purpose: ${purpose}`}
    aria-expanded={open}
    onclick={toggle}
    onpointerdown={stop}
    ondblclick={stop}
    ondragstart={stop}
    onkeydown={keydown}
    onblur={() => (open = false)}
  ><Icon name="info" size={11} /></button>
  {#if open}
    <span
      class="purpose-popout"
      class:below={popoutBelow}
      style={`left:${popoutLeft}px;top:${popoutTop}px`}
      role="note"
    >
      <strong>Purpose</strong>
      <span>{purpose}</span>
    </span>
  {/if}
</span>

<style>
  .purpose-info { position: relative; flex: none; display: inline-grid; place-items: center; }
  button {
    position: relative; display: grid; place-items: center; width: 1.15rem; height: 1.15rem; padding: 0;
    border: 1px solid transparent; border-radius: 50%; color: var(--dim); background: transparent;
    cursor: help;
  }
  button:hover, button:focus-visible, .open button {
    color: var(--accent); border-color: color-mix(in srgb, var(--accent) 34%, transparent);
    background: color-mix(in srgb, var(--accent) 9%, transparent); outline: none;
  }
  /* Hover/focus gets an immediate tooltip without mounting duplicate purpose text into every row. */
  button::after {
    content: attr(data-purpose); position: absolute; z-index: 80; left: 50%; bottom: calc(100% + .4rem);
    width: max-content; max-width: min(19rem, 70vw); padding: .42rem .55rem; border: 1px solid var(--border-strong);
    border-radius: var(--r-sm); background: var(--surface-4, var(--surface-3)); color: var(--text);
    box-shadow: var(--shadow-2); font-size: var(--text-2xs); font-weight: var(--fw-normal); line-height: 1.35;
    letter-spacing: normal; text-align: left; text-transform: none; white-space: normal;
    transform: translateX(-50%); opacity: 0; visibility: hidden; pointer-events: none;
    transition: opacity var(--dur-fast) var(--ease), visibility var(--dur-fast) var(--ease);
  }
  button:hover::after, button:focus-visible::after { opacity: 1; visibility: visible; }
  .open button::after { opacity: 0; visibility: hidden; }
  .purpose-popout {
    position: fixed; z-index: 81; display: flex; flex-direction: column;
    gap: .2rem; width: max-content; min-width: 10rem; max-width: min(20rem, 75vw); padding: .55rem .65rem;
    border: 1px solid var(--border-strong); border-radius: var(--r-md); background: var(--surface-4, var(--surface-3));
    color: var(--text); box-shadow: var(--shadow-2); font-size: var(--text-xs); line-height: 1.4;
    letter-spacing: normal; text-align: left; text-transform: none; white-space: normal; transform: translate(-50%, -100%);
    pointer-events: none;
  }
  .purpose-popout.below { transform: translateX(-50%); }
  .purpose-popout strong { color: var(--accent); font-size: var(--text-2xs); text-transform: uppercase; letter-spacing: .06em; }
</style>
