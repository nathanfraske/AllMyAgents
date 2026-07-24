<script lang="ts">
  // Custom dark window titlebar (replaces the native OS titlebar, which was disabled via
  // `decorations: false`). Slim brand bar on the left doubles as the OS drag handle; modern
  // Windows-style min / maximize / close controls on the right — shown only inside Tauri.
  import {
    inTauri,
    minimizeWindow,
    toggleMaximizeWindow,
    closeWindow,
    isMaximized,
  } from './window'

  // Reflect the OS maximized state so the middle control shows the right glyph:
  // a single square = "maximize", two offset squares = "restore". Only meaningful in Tauri.
  let maximized = $state(false)

  async function refreshMaxState(): Promise<void> {
    maximized = await isMaximized()
  }

  // Keep the glyph in sync with the OS window. The DOM `resize` event fires on maximize,
  // restore and manual resize, so re-querying there tracks the state without pulling in Tauri's
  // event API. Nothing is attached in a plain browser (no OS window to reflect).
  $effect(() => {
    if (!inTauri) return
    void refreshMaxState()
    const onResize = (): void => void refreshMaxState()
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  })

  async function onToggleMax(): Promise<void> {
    await toggleMaximizeWindow()
    await refreshMaxState()
  }
</script>

<!-- The bar itself is the drag region. `.brand` is pointer-events:none so clicks on the logo /
     wordmark and the empty middle fall through to this element — dragging moves the window and
     a double-click toggles maximize (both handled natively by Tauri's drag region). The control
     buttons keep pointer events, so they are NOT drag regions and their clicks register. -->
<header class="titlebar" data-tauri-drag-region>
  <div class="brand">
    <img class="logo" src="/logo.png" alt="" />
    <span class="wordmark">AllMyAgents</span>
  </div>

  {#if inTauri}
    <div class="controls">
      <button class="ctl" type="button" title="Minimize" aria-label="Minimize" onclick={minimizeWindow}>
        <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true">
          <path d="M1.5 5h7" />
        </svg>
      </button>

      <button
        class="ctl"
        type="button"
        title={maximized ? 'Restore' : 'Maximize'}
        aria-label={maximized ? 'Restore' : 'Maximize'}
        onclick={onToggleMax}
      >
        {#if maximized}
          <!-- restore: two offset squares -->
          <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true">
            <path d="M3.2 3.2V2A0.8 0.8 0 0 1 4 1.2H8A0.8 0.8 0 0 1 8.8 2V6A0.8 0.8 0 0 1 8 6.8H6.8" />
            <rect x="1.2" y="3.2" width="5.6" height="5.6" rx="0.8" />
          </svg>
        {:else}
          <!-- maximize: single square -->
          <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true">
            <rect x="1.5" y="1.5" width="7" height="7" rx="0.8" />
          </svg>
        {/if}
      </button>

      <button class="ctl close" type="button" title="Close" aria-label="Close" onclick={closeWindow}>
        <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true">
          <path d="M1.6 1.6l6.8 6.8M8.4 1.6l-6.8 6.8" />
        </svg>
      </button>
    </div>
  {/if}
</header>

<style>
  .titlebar {
    display: flex;
    align-items: stretch;
    height: 36px;
    flex: none;
    background: var(--sidebar);
    border-bottom: 1px solid var(--border);
    user-select: none;
    -webkit-user-select: none;
  }

  /* Non-interactive identity block; pointer-events:none makes the whole area a pass-through to
     the drag region above. */
  .brand {
    display: flex;
    align-items: center;
    gap: var(--space-2);
    padding: 0 var(--space-4);
    pointer-events: none;
  }
  .logo {
    width: 17px;
    height: 17px;
    object-fit: contain;
  }
  .wordmark {
    font-size: var(--text-sm);
    font-weight: var(--fw-semibold);
    color: var(--text);
    letter-spacing: 0.01em;
  }

  /* Pushed to the right; the free space it leaves in the middle stays part of the drag region. */
  .controls {
    margin-left: auto;
    display: flex;
    align-items: stretch;
  }

  .ctl {
    width: 46px;
    height: 100%;
    display: grid;
    place-items: center;
    border: 0;
    background: transparent;
    color: var(--muted);
    cursor: default; /* window chrome — arrow cursor, not a link/text cursor */
  }
  .ctl svg {
    fill: none;
    stroke: currentColor;
    stroke-width: 1;
    stroke-linecap: round;
    stroke-linejoin: round;
    pointer-events: none; /* clicks resolve to the button, never the glyph */
  }
  .ctl:hover {
    background: var(--surface-2);
    color: var(--text);
  }
  .ctl:active {
    background: var(--surface-3);
  }
  .ctl.close:hover {
    background: #e81123;
    color: #fff;
  }
  .ctl.close:active {
    background: #c50f1f;
    color: #fff;
  }

  @media (prefers-reduced-motion: no-preference) {
    .ctl {
      transition: background var(--dur-fast) var(--ease), color var(--dur-fast) var(--ease);
    }
  }
</style>
