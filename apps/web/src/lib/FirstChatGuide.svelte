<script lang="ts">
  let {
    provider,
    projectName,
    workingDirectory,
    permissionMode,
  }: {
    provider: 'claude' | 'codex'
    projectName: string
    workingDirectory: string
    permissionMode: string
  } = $props()

  const providerName = $derived(provider === 'claude' ? 'Claude Code' : 'Codex')
  const accessName = $derived(
    permissionMode === 'full' ? 'Full access' : permissionMode === 'edits' ? 'Edits' : 'Safe'
  )
</script>

<section class="guide" aria-labelledby="first-chat-title">
  <div class="eyebrow">YOUR FIRST CHAT</div>
  <h2 id="first-chat-title">You’re about to start a coding agent</h2>
  <p>
    AllMyAgents will run {providerName} in <strong>{projectName}</strong>. The agent works from
    <code title={workingDirectory}>{workingDirectory}</code> and can inspect or change files according
    to the access mode you choose.
  </p>

  <div class="checks">
    <div><span>1</span><p><strong>Check where it will work.</strong> The project and working directory are always shown in the header above.</p></div>
    <div><span>2</span><p><strong>Choose the controls below.</strong> Account, model and <em>{accessName}</em> access apply to this chat.</p></div>
    <div><span>3</span><p><strong>Describe one concrete task.</strong> Sending the message starts the agent; its work and approval requests appear here.</p></div>
  </div>

  <p class="setup">
    First-launch note: the desktop app installs the local hub’s pinned npm dependencies, including the
    Claude Code and Codex CLIs. That one-time setup and account sign-in need an internet connection.
  </p>
</section>

<style>
  .guide {
    align-self: center; width: min(640px, 100%); margin: 0 auto; padding: 1rem 1.1rem;
    border: 1px solid var(--border); border-radius: 12px; background: var(--surface);
  }
  .eyebrow { color: var(--accent); font-size: 0.66rem; font-weight: 700; letter-spacing: 0.1em; }
  h2 { margin: 0.25rem 0 0.5rem; font-size: 1rem; }
  p { margin: 0; color: var(--muted); font-size: 0.79rem; line-height: 1.45; }
  strong { color: var(--text); font-weight: 600; }
  code {
    display: inline; color: var(--text); font-size: 0.74rem; overflow-wrap: anywhere;
    font-family: var(--mono); background: var(--surface-2); border-radius: 4px; padding: 0.06rem 0.24rem;
  }
  .checks { display: grid; gap: 0.45rem; margin: 0.8rem 0; }
  .checks > div { display: grid; grid-template-columns: 1.25rem minmax(0, 1fr); gap: 0.45rem; align-items: start; }
  .checks span {
    display: grid; place-items: center; width: 1.25rem; height: 1.25rem; border-radius: 50%;
    color: var(--accent); background: color-mix(in srgb, var(--accent) 13%, transparent);
    font-size: 0.68rem; font-weight: 700;
  }
  .setup { padding-top: 0.65rem; border-top: 1px solid var(--border-subtle); font-size: 0.72rem; }

  @container (max-width: 340px) {
    .guide { padding: 0.8rem; }
    .checks { gap: 0.35rem; margin-block: 0.6rem; }
  }
</style>
