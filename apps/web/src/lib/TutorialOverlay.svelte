<script lang="ts">
  import { onMount } from 'svelte'
  import { store } from './store.svelte'
  import { TUTORIAL_ANCHORS, type TutorialAnchor } from './tutorialAnchors'
  import { tutorials } from './tutorialState.svelte'

  let { kind }: { kind: 'first-run' | 'new-project' } = $props()

  interface StepCopy {
    anchor: TutorialAnchor
    eyebrow: string
    title: string
    body: string
  }

  const appSteps: StepCopy[] = [
    {
      anchor: TUTORIAL_ANCHORS.home,
      eyebrow: 'HOME',
      title: 'Your launch point',
      body: 'Home shows all your projects and what is happening in each one. Use it whenever you want the overall picture.',
    },
    {
      anchor: TUTORIAL_ANCHORS.projectList,
      eyebrow: 'PROJECTS',
      title: 'Keep related work together',
      body: 'Each project has its own overview with its working folder, agents, progress, and anything that needs your attention.',
    },
    {
      anchor: TUTORIAL_ANCHORS.newProject,
      eyebrow: 'NEW PROJECT',
      title: 'Set up organized work',
      body: 'New Project guides you through where the work lives, who should help, and the final launch. A manager can coordinate the team for you.',
    },
    {
      anchor: TUTORIAL_ANCHORS.projectView,
      eyebrow: 'PROJECT VIEW',
      title: 'See one project clearly',
      body: 'Open a project to see its team, current work, recent activity, and manager conversation in one place.',
    },
    {
      anchor: TUTORIAL_ANCHORS.newScratchpad,
      eyebrow: 'SCRATCHPADS',
      title: 'Start a standalone task',
      body: 'A scratchpad is for a quick task that does not need a project. It gets its own isolated working folder and opens ready for your first message.',
    },
  ]

  const projectSteps: StepCopy[] = [
    {
      anchor: TUTORIAL_ANCHORS.newProjectFlow,
      eyebrow: 'PROJECTS',
      title: 'A shared place for related work',
      body: 'A project combines a working directory with the agents that share it. You do not need a project for a quick chat—use a scratchpad for that.',
    },
    {
      anchor: TUTORIAL_ANCHORS.projectSource,
      eyebrow: 'WHERE WORK LIVES',
      title: 'Choose one starting point',
      body: 'Use an existing directory, choose a GitHub repository to clone, or enter only a name and let the app create a Git-backed project for you.',
    },
    {
      anchor: TUTORIAL_ANCHORS.projectIndependentAgents,
      eyebrow: 'INITIAL AGENTS',
      title: 'Set the agents that start with it',
      body: 'This is the real team step. For each independent agent, choose its account and model, write its first task, optionally narrow its scope, and choose a permission level. Add as many as you need, or none.',
    },
    {
      anchor: TUTORIAL_ANCHORS.projectWorktree,
      eyebrow: 'ISOLATION',
      title: 'Choose direct work or a worktree',
      body: 'Use a worktree to give an agent an isolated branch and folder, which is safer when several agents change code at once. Turn it off for the simpler shared project folder. Choose this independently for every starting agent.',
    },
    {
      anchor: TUTORIAL_ANCHORS.projectManager,
      eyebrow: 'OPTIONAL MANAGER',
      title: 'Add coordination when the work needs it',
      body: 'A manager can break work into child-agent roles and oversee them. The real fields below choose its account, model, permission, live-child limit, worker roles, and grant ceiling. Independent agents and a manager are both optional, and you may use both.',
    },
    {
      anchor: TUTORIAL_ANCHORS.projectFinalize,
      eyebrow: 'DRY-RUN REVIEW',
      title: 'Review the launch without creating it',
      body: 'This is the real Finalize step with a sample project, independent agent, and manager. During the tutorial the launch action is disabled: no project, clone, worktree, manager, or agent is created. Finish clears the sample and returns this dialog to a blank real setup.',
    },
  ]

  const accountStep: StepCopy = {
    anchor: TUTORIAL_ANCHORS.accountSignIn,
    eyebrow: 'STEP 1 OF 2',
    title: 'Connect one account',
    body: 'Choose Claude or Codex, give the account a name you will recognize, and use the real Log in button below. That is all the app needs before it can create your Overseer.',
  }

  const overseerStep: StepCopy = {
    anchor: TUTORIAL_ANCHORS.overseerSetup,
    eyebrow: 'STEP 2 OF 2',
    title: 'Choose your Overseer',
    body: 'Select the account you just connected and create the Overseer. The app will open its chat. Say "set this up for me" to have it build projects and teams, or "show me around" to ask how anything works.',
  }

  const step = $derived(
    kind === 'new-project'
      ? projectSteps[tutorials.newProjectStep]!
      : tutorials.firstRunPhase === 'accounts'
        ? accountStep
        : tutorials.firstRunPhase === 'overseer'
          ? overseerStep
          : appSteps[tutorials.firstRunStep]!,
  )
  const stepIndex = $derived(kind === 'new-project' ? tutorials.newProjectStep : tutorials.firstRunStep)
  const stepCount = $derived(
    kind === 'new-project'
      ? projectSteps.length
      : tutorials.firstRunPhase === 'accounts' || tutorials.firstRunPhase === 'overseer'
        ? 1
        : appSteps.length,
  )
  const waiting = $derived(kind === 'first-run' && tutorials.firstRunPhase === 'accounts' && tutorials.login.status === 'waiting')
  let elapsed = $state(0)
  let target = $state<DOMRect | null>(null)
  let targetFound = $state(false)

  function updateTarget(): void {
    const element = document.querySelector<HTMLElement>(`[data-tutorial-anchor="${step.anchor}"]`)
    const rect = element?.getBoundingClientRect()
    if (rect && rect.width > 0 && rect.height > 0) {
      target = rect
      targetFound = true
    } else {
      target = null
      targetFound = false
    }
  }

  $effect(() => {
    void step.anchor
    target = null
    targetFound = false
    const timers = [0, 120, 500, 1500].map((delay) => window.setTimeout(updateTarget, delay))
    return () => timers.forEach((timer) => clearTimeout(timer))
  })

  onMount(() => {
    const refresh = (): void => updateTarget()
    window.addEventListener('resize', refresh)
    window.addEventListener('scroll', refresh, true)
    return () => {
      window.removeEventListener('resize', refresh)
      window.removeEventListener('scroll', refresh, true)
    }
  })

  $effect(() => {
    if (!waiting || !tutorials.login.startedAt) {
      elapsed = 0
      return
    }
    const update = (): void => {
      elapsed = Math.max(0, Math.floor((Date.now() - tutorials.login.startedAt!) / 1000))
    }
    update()
    const timer = window.setInterval(update, 1000)
    return () => clearInterval(timer)
  })

  function back(): void {
    if (stepIndex === 0) return
    if (kind === 'new-project') tutorials.setNewProjectStep(stepIndex - 1)
    else tutorials.setFirstRunStep(stepIndex - 1)
  }

  function next(): void {
    if (stepIndex >= stepCount - 1) {
      if (kind === 'new-project') tutorials.finishNewProject()
      else tutorials.finishFirstRun()
      return
    }
    if (kind === 'new-project') tutorials.setNewProjectStep(stepIndex + 1)
    else tutorials.setFirstRunStep(stepIndex + 1)
  }

  function skip(): void {
    if (kind === 'new-project') tutorials.skipNewProject()
    else tutorials.skipFirstRun()
  }

  function reopenSettings(): void {
    store.settingsOpen = true
  }

  function onKey(event: KeyboardEvent): void {
    if (event.key === 'Escape') skip()
  }

  const cardVertical = $derived(target && target.y + target.height / 2 > window.innerHeight / 2 ? 'top' : 'bottom')
  const cardHorizontal = $derived(target && target.x + target.width / 2 > window.innerWidth / 2 ? 'left' : 'right')
</script>

<svelte:window onkeydown={onKey} />

{#if target}
  <div
    class="target"
    aria-hidden="true"
    style={`left:${target.x - 5}px;top:${target.y - 5}px;width:${target.width + 10}px;height:${target.height + 10}px`}
  ></div>
{/if}

<div
  class="tour-card {targetFound ? cardVertical : 'center'} {targetFound ? cardHorizontal : ''}"
  role="dialog"
  aria-modal="false"
  aria-labelledby={`tutorial-title-${kind}`}
  data-testid={`${kind}-tutorial`}
>
  <div class="tour-head">
    <span>{step.eyebrow}</span>
    <button onclick={skip}>Skip tutorial</button>
  </div>
  <h2 id={`tutorial-title-${kind}`}>{step.title}</h2>
  <p>{step.body}</p>

  {#if kind === 'first-run' && tutorials.firstRunPhase === 'accounts'}
    {#if waiting}
      <div class="waiting" role="status">
        <span class="pulse" aria-hidden="true"></span>
        <div>
          <b>Waiting for you to finish signing in in your browser</b>
          <span>This usually takes about 30 seconds. Keep this window open. {elapsed}s elapsed.</span>
        </div>
      </div>
    {:else if tutorials.login.status === 'error' || tutorials.login.status === 'cancelled'}
      <div class="waiting problem" role="status">
        <div>
          <b>{tutorials.login.status === 'cancelled' ? 'Sign-in was cancelled' : 'Sign-in needs attention'}</b>
          <span>{tutorials.login.message ?? 'Use the account panel to retry.'}</span>
        </div>
      </div>
    {:else}
      <p class="account-note">This tour continues automatically as soon as the account appears.</p>
    {/if}
    {#if !store.settingsOpen}
      <button class="primary" onclick={reopenSettings}>Open Accounts</button>
    {/if}
  {:else if kind === 'first-run' && tutorials.firstRunPhase === 'overseer'}
    <p class="account-note">Creating it finishes this setup guide. The full visual tour and New Project walkthrough remain available in Settings whenever you want them.</p>
    {#if !store.settingsOpen}
      <button class="primary" onclick={reopenSettings}>Open Overseer setup</button>
    {/if}
  {/if}

  {#if !targetFound}
    <p class="missing">This part of the app is not visible yet. You can continue—the tour will never wait on a missing control.</p>
  {/if}

  {#if !(kind === 'first-run' && (tutorials.firstRunPhase === 'accounts' || tutorials.firstRunPhase === 'overseer'))}
    <div class="tour-actions">
      <span>{stepIndex + 1} of {stepCount}</span>
      <div>
        {#if stepIndex > 0}<button class="secondary" onclick={back}>Back</button>{/if}
        <button class="primary" onclick={next}>{stepIndex === stepCount - 1 ? 'Finish' : 'Next'}</button>
      </div>
    </div>
  {/if}
</div>

<style>
  .target {
    position: fixed; z-index: 90; pointer-events: none; border: 2px solid var(--accent);
    border-radius: var(--r-md); box-shadow: 0 0 0 4px color-mix(in srgb, var(--accent) 22%, transparent), var(--shadow-3);
  }
  .tour-card {
    position: fixed; z-index: 91; width: min(390px, calc(100vw - 24px)); max-height: calc(100vh - 24px);
    overflow-y: auto; padding: var(--space-5); color: var(--text); background: var(--surface);
    border: 1px solid var(--border-accent); border-radius: var(--r-xl); box-shadow: var(--shadow-4);
  }
  .tour-card.top { top: 18px; }
  .tour-card.bottom { bottom: 18px; }
  .tour-card.left { left: 18px; }
  .tour-card.right { right: 18px; }
  .tour-card.center { inset: 50% auto auto 50%; transform: translate(-50%, -50%); }
  .tour-head { display: flex; align-items: center; justify-content: space-between; gap: var(--space-3); }
  .tour-head span { color: var(--accent); font-size: var(--text-2xs); font-weight: var(--fw-semibold); letter-spacing: var(--ls-label); }
  .tour-head button { color: var(--muted); font-size: var(--text-xs); text-decoration: underline; text-underline-offset: 3px; }
  h2 { margin: var(--space-2) 0; font-size: var(--text-lg); }
  p { margin: 0; color: var(--muted); font-size: var(--text-sm); line-height: 1.55; }
  .account-note, .missing { margin-top: var(--space-3); font-size: var(--text-xs); }
  .missing { padding: var(--space-3); border: 1px solid var(--border); border-radius: var(--r-md); background: var(--surface-2); }
  .waiting {
    display: flex; align-items: flex-start; gap: var(--space-3); margin-top: var(--space-4); padding: var(--space-3);
    border: 1px solid var(--border-accent); border-radius: var(--r-md); background: color-mix(in srgb, var(--accent) 8%, var(--surface));
  }
  .waiting > div { display: flex; flex-direction: column; gap: var(--space-1); }
  .waiting b { font-size: var(--text-sm); }
  .waiting span { color: var(--muted); font-size: var(--text-xs); line-height: 1.45; }
  .waiting.problem { border-color: var(--warn); }
  .pulse { width: 9px; height: 9px; margin-top: 4px; flex: none; border-radius: 50%; background: var(--accent); animation: pulse 1.4s ease-in-out infinite; }
  .tour-actions {
    display: flex; align-items: center; justify-content: space-between; gap: var(--space-3);
    margin-top: var(--space-5); padding-top: var(--space-4); border-top: 1px solid var(--border);
  }
  .tour-actions > span { color: var(--dim); font-size: var(--text-xs); }
  .tour-actions > div { display: flex; gap: var(--space-2); }
  .primary, .secondary { padding: var(--space-2) var(--space-4); border-radius: var(--r-md); font-weight: var(--fw-medium); }
  .primary { margin-top: var(--space-4); color: #fff; background: var(--accent); }
  .tour-actions .primary { margin-top: 0; }
  .secondary { border: 1px solid var(--border); }
  @keyframes pulse { 50% { opacity: .35; transform: scale(.78); } }
  @media (max-width: 560px) {
    .tour-card.top, .tour-card.bottom, .tour-card.left, .tour-card.right {
      inset: auto 8px 8px 8px; width: auto;
    }
  }
  @media (prefers-reduced-motion: reduce) {
    .pulse { animation: none; }
  }
</style>
