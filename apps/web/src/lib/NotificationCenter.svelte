<script lang="ts">
  import { api, type NotificationRecord } from './api'
  import Icon from './Icon.svelte'
  import { store } from './store.svelte'
  import { relativeTime } from './time'
  import { saveSettingsTab } from './settingsSections'

  let open = $state(false)
  let root = $state<HTMLDivElement | null>(null)
  let items = $state<NotificationRecord[]>([])
  let unread = $state(0)
  let now = $state(Date.now())
  let error = $state('')

  async function refresh(): Promise<void> {
    try {
      const inbox = await api.notifications(100)
      items = inbox.items
      unread = inbox.unread
      error = ''
      await deliverDesktop(inbox.items)
    } catch (reason) {
      error = reason instanceof Error ? reason.message : String(reason)
    }
  }

  async function deliverDesktop(records: NotificationRecord[]): Promise<void> {
    if (typeof Notification === 'undefined' || Notification.permission !== 'granted') return
    const pending = records
      .filter((record) => record.desktopEligible && !record.desktopDeliveredAt)
      .slice()
      .reverse()
      .slice(0, 8)
    const delivered: string[] = []
    for (const record of pending) {
      try {
        new Notification(record.title, { body: record.body, tag: record.id })
        delivered.push(record.id)
      } catch {
        break
      }
    }
    if (delivered.length) {
      await api.markNotificationsDesktopDelivered(delivered)
      const deliveredIds = new Set(delivered)
      items = items.map((record) => deliveredIds.has(record.id)
        ? { ...record, desktopDeliveredAt: new Date().toISOString() }
        : record)
    }
  }

  $effect(() => {
    if (!store.connected) return
    void refresh()
    const poll = window.setInterval(() => void refresh(), 10_000)
    const clock = window.setInterval(() => (now = Date.now()), 15_000)
    return () => {
      window.clearInterval(poll)
      window.clearInterval(clock)
    }
  })

  function closeOutside(event: PointerEvent): void {
    if (open && !root?.contains(event.target as Node)) open = false
  }

  async function markAllRead(): Promise<void> {
    const result = await api.markNotificationsRead()
    if ('error' in result) {
      error = result.error
      return
    }
    const at = new Date().toISOString()
    items = items.map((record) => record.readAt ? record : { ...record, readAt: at })
    unread = 0
  }

  async function openRecord(record: NotificationRecord): Promise<void> {
    if (!record.readAt) {
      const result = await api.markNotificationsRead([record.id])
      if (!('error' in result)) {
        items = items.map((candidate) => candidate.id === record.id
          ? { ...candidate, readAt: new Date().toISOString() }
          : candidate)
        unread = Math.max(0, unread - 1)
      }
    }
    if (record.sessionId) store.select(record.sessionId)
    open = false
  }

  function openSettings(): void {
    saveSettingsTab('system')
    store.settingsOpen = true
    open = false
  }
</script>

<svelte:window onpointerdown={closeOutside} onkeydown={(event) => { if (event.key === 'Escape') open = false }} />

<div class="notification-center" bind:this={root}>
  <button
    class="notification-trigger"
    class:attention={unread > 0}
    type="button"
    aria-label={unread ? `${unread} unread notifications` : 'Notifications'}
    aria-expanded={open}
    aria-haspopup="dialog"
    title={unread ? `${unread} unread notifications` : 'Notifications'}
    onclick={() => {
      open = !open
      if (open) void refresh()
    }}
  >
    <Icon name="bell" size={14} />
    {#if unread > 0}<span class="notification-count">{unread > 99 ? '99+' : unread}</span>{/if}
  </button>

  {#if open}
    <dialog class="notification-popout" aria-label="Notifications" open>
      <header>
        <strong>Notifications</strong>
        <span>
          {#if unread > 0}<button onclick={markAllRead}>mark all read</button>{/if}
          <button aria-label="Notification settings" title="Notification settings" onclick={openSettings}><Icon name="settings" size={13} /></button>
        </span>
      </header>
      {#if error}<p class="notification-error">{error}</p>{/if}
      <div class="notification-list">
        {#each items as record (record.id)}
          <button
            class="notification-row {record.severity}"
            class:unread={!record.readAt}
            onclick={() => openRecord(record)}
          >
            <span class="notification-row-head">
              <b>{record.title}</b>
              <small>{relativeTime(record.createdAt, now)}</small>
            </span>
            <span class="notification-body">{record.body}</span>
            <span class="notification-route">{record.sourceRole} · routed to {record.route}</span>
          </button>
        {:else}
          <p class="notification-empty">No notifications yet.</p>
        {/each}
      </div>
    </dialog>
  {/if}
</div>

<style>
  .notification-center { position: relative; flex: none; }
  .notification-trigger { position: relative; display: grid; place-items: center; width: 32px; height: 28px; padding: 0;
    border: 1px solid transparent; border-radius: var(--r-pill); color: var(--muted); background: transparent; }
  .notification-trigger:hover, .notification-trigger[aria-expanded='true'] { color: var(--text); border-color: var(--border); background: var(--surface-2); }
  .notification-trigger.attention { color: var(--accent); }
  .notification-count { position: absolute; top: -5px; right: -5px; display: grid; place-items: center; min-width: 16px; height: 16px;
    padding: 0 4px; border: 2px solid var(--sidebar); border-radius: 999px; background: var(--accent); color: var(--surface);
    font-size: 9px; font-weight: 700; line-height: 1; }
  .notification-popout { position: absolute; z-index: 30; top: calc(100% + var(--space-2)); right: 0; left: auto; bottom: auto;
    width: min(360px, calc(100vw - 32px)); max-height: min(540px, calc(100vh - 100px)); margin: 0; padding: 0;
    border: 1px solid var(--border-strong); border-radius: var(--r-lg); background: var(--surface); color: var(--text);
    box-shadow: var(--shadow-4, 0 20px 55px rgba(0, 0, 0, 0.5)); overflow: hidden; }
  header { display: flex; align-items: center; justify-content: space-between; gap: var(--space-3); padding: var(--space-3) var(--space-4); border-bottom: 1px solid var(--border); }
  header strong { font-size: var(--text-sm); }
  header span { display: inline-flex; align-items: center; gap: var(--space-2); }
  header button { display: inline-grid; place-items: center; padding: 3px; border: 0; background: transparent; color: var(--muted); font-size: var(--text-2xs); }
  header button:hover { color: var(--text); }
  .notification-list { max-height: 460px; overflow-y: auto; }
  .notification-row { display: grid; width: 100%; gap: 4px; padding: var(--space-3) var(--space-4); border: 0; border-bottom: 1px solid var(--border-subtle);
    border-left: 3px solid transparent; border-radius: 0; background: transparent; color: var(--text); text-align: left; }
  .notification-row:hover { background: var(--surface-2); }
  .notification-row.unread { background: color-mix(in srgb, var(--accent) 7%, transparent); border-left-color: var(--accent); }
  .notification-row.warning { border-left-color: var(--warn); }
  .notification-row.error { border-left-color: var(--bad); }
  .notification-row-head { display: flex; align-items: baseline; justify-content: space-between; gap: var(--space-2); }
  .notification-row-head b { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: var(--text-xs); }
  .notification-row-head small { flex: none; color: var(--dim); font-size: var(--text-2xs); }
  .notification-body { color: var(--text-dim); font-size: var(--text-xs); line-height: 1.35; }
  .notification-route { color: var(--dim); font-size: var(--text-2xs); text-transform: capitalize; }
  .notification-empty, .notification-error { margin: 0; padding: var(--space-4); color: var(--dim); font-size: var(--text-xs); }
  .notification-error { color: var(--bad-text); border-bottom: 1px solid var(--border); }
</style>
