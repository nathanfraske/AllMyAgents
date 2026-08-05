import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  FIRST_RUN_TUTORIAL_KEY,
  NEW_PROJECT_TUTORIAL_KEY,
  TutorialController,
  readTutorialDisposition,
} from './tutorialState.svelte'

class MemoryStorage implements Storage {
  private values = new Map<string, string>()
  get length(): number { return this.values.size }
  clear(): void { this.values.clear() }
  getItem(key: string): string | null { return this.values.get(key) ?? null }
  key(index: number): string | null { return [...this.values.keys()][index] ?? null }
  removeItem(key: string): void { this.values.delete(key) }
  setItem(key: string, value: string): void { this.values.set(key, value) }
}

describe('tutorial eligibility and persistence', () => {
  let storage: MemoryStorage

  beforeEach(() => {
    storage = new MemoryStorage()
    vi.useRealTimers()
  })

  it('classifies an installation with a real chat as established and permanently suppresses both tutorials', () => {
    const tutorials = new TutorialController(storage)

    tutorials.initializeFrom({
      profiles: [],
      sessions: [{ id: 'existing-chat' }],
    })

    expect(tutorials.firstRunOpen).toBe(false)
    expect(tutorials.newProjectOpen).toBe(false)
    expect(readTutorialDisposition(storage, FIRST_RUN_TUTORIAL_KEY)).toBe('completed')
    expect(readTutorialDisposition(storage, NEW_PROJECT_TUTORIAL_KEY)).toBe('completed')
    expect(tutorials.startNewProjectTutorial(false)).toBe(false)
  })

  it('does not treat a local unsent draft as an established chat', () => {
    const tutorials = new TutorialController(storage)

    tutorials.initializeFrom({
      profiles: [],
      sessions: [{ id: 'draft:new', draft: true }],
    })

    expect(tutorials.firstRunOpen).toBe(true)
    expect(tutorials.firstRunPhase).toBe('accounts')
    expect(readTutorialDisposition(storage, NEW_PROJECT_TUTORIAL_KEY)).toBe('new')
  })

  it('uses the short account-to-Overseer setup and keeps the full app tour optional', () => {
    const tutorials = new TutorialController(storage)
    tutorials.initializeFrom({ profiles: [], sessions: [] })

    expect(tutorials.firstRunPhase).toBe('accounts')
    tutorials.accountAdded()
    expect(tutorials.firstRunPhase).toBe('overseer')
    expect(tutorials.firstRunOpen).toBe(true)
    tutorials.overseerConfigured()
    expect(tutorials.firstRunOpen).toBe(false)
    expect(readTutorialDisposition(storage, FIRST_RUN_TUTORIAL_KEY)).toBe('completed')

    tutorials.replayAppTour()
    expect(tutorials.firstRunOpen).toBe(true)
    expect(tutorials.firstRunPhase).toBe('app')
  })

  it('does not render an empty-install tutorial when the hub bootstrap fails', async () => {
    const tutorials = new TutorialController(storage)

    const loaded = await tutorials.initialize(async () => {
      throw new Error('hub unavailable')
    })

    expect(loaded).toBe(false)
    expect(tutorials.initialized).toBe(false)
    expect(tutorials.firstRunOpen).toBe(false)
    expect(readTutorialDisposition(storage, FIRST_RUN_TUTORIAL_KEY)).toBe('new')
  })

  it('persists first-run skip across a reload', () => {
    const first = new TutorialController(storage)
    first.initializeFrom({ profiles: [], sessions: [] })
    first.skipFirstRun()

    const reloaded = new TutorialController(storage)
    reloaded.initializeFrom({ profiles: [], sessions: [] })

    expect(reloaded.firstRunOpen).toBe(false)
    expect(readTutorialDisposition(storage, FIRST_RUN_TUTORIAL_KEY)).toBe('skipped')
  })

  it('persists first-run finish across a reload', () => {
    const first = new TutorialController(storage)
    first.initializeFrom({ profiles: [{ id: 'claude-a' }], sessions: [] })
    first.finishFirstRun()

    const reloaded = new TutorialController(storage)
    reloaded.initializeFrom({ profiles: [{ id: 'claude-a' }], sessions: [] })

    expect(reloaded.firstRunOpen).toBe(false)
    expect(readTutorialDisposition(storage, FIRST_RUN_TUTORIAL_KEY)).toBe('completed')
  })

  it('keeps New Project separate from first-run and never reopens it after skip', () => {
    const tutorials = new TutorialController(storage)
    tutorials.initializeFrom({ profiles: [{ id: 'claude-a' }], sessions: [] })
    tutorials.skipFirstRun()

    expect(tutorials.startNewProjectTutorial(false)).toBe(true)
    expect(tutorials.newProjectOpen).toBe(true)
    tutorials.skipNewProject()

    expect(tutorials.startNewProjectTutorial(false)).toBe(false)
    const reloaded = new TutorialController(storage)
    reloaded.initializeFrom({ profiles: [{ id: 'claude-a' }], sessions: [] })
    expect(reloaded.startNewProjectTutorial(false)).toBe(false)
    expect(readTutorialDisposition(storage, NEW_PROJECT_TUTORIAL_KEY)).toBe('skipped')
  })

  it('does not start the New Project tutorial while project creation is already in progress', () => {
    const tutorials = new TutorialController(storage)
    tutorials.initializeFrom({ profiles: [{ id: 'claude-a' }], sessions: [] })

    expect(tutorials.startNewProjectTutorial(true)).toBe(false)
    expect(tutorials.newProjectOpen).toBe(false)
    expect(readTutorialDisposition(storage, NEW_PROJECT_TUTORIAL_KEY)).toBe('new')
  })

  it('does not reappear on the second New Project click even when the first tour was merely closed', () => {
    const tutorials = new TutorialController(storage)
    tutorials.initializeFrom({ profiles: [{ id: 'claude-a' }], sessions: [] })
    tutorials.skipFirstRun()

    expect(tutorials.startNewProjectTutorial(false)).toBe(true)
    tutorials.closeNewProjectTutorial()

    expect(tutorials.startNewProjectTutorial(false)).toBe(false)
    expect(tutorials.newProjectOpen).toBe(false)
    expect(readTutorialDisposition(storage, NEW_PROJECT_TUTORIAL_KEY)).toBe('in-progress')
  })

  it('persists New Project completion across reload and keeps it separate from first-run completion', () => {
    const first = new TutorialController(storage)
    first.initializeFrom({ profiles: [{ id: 'claude-a' }], sessions: [] })
    first.finishFirstRun()
    expect(first.startNewProjectTutorial(false)).toBe(true)
    first.finishNewProject()

    const reloaded = new TutorialController(storage)
    reloaded.initializeFrom({ profiles: [{ id: 'claude-a' }], sessions: [] })

    expect(reloaded.startNewProjectTutorial(false)).toBe(false)
    expect(readTutorialDisposition(storage, FIRST_RUN_TUTORIAL_KEY)).toBe('completed')
    expect(readTutorialDisposition(storage, NEW_PROJECT_TUTORIAL_KEY)).toBe('completed')
  })
})

describe('setLogin reactivity (the sign-in freeze)', () => {
  // A sign-in used to lock the entire app: SettingsModal mirrors login state to the tutorial from inside
  // an `$effect`, and setLogin READ `login` (for startedAt) then WROTE it on the same synchronous pass.
  // Svelte 5 tracks reads made by functions an effect calls, so the effect depended on the very state it
  // wrote — and since each call built a fresh object, the write always looked like a change. The effect
  // retriggered forever, pegging the renderer and compositor while the hub sat idle.
  //
  // `$effect` needs a component context, so these assert the two properties that make the cycle
  // impossible rather than instantiating one: the read is untracked, and an unchanged view is not written.
  it('does not mint a new object identity for an unchanged waiting view', () => {
    const c = new TutorialController(new MemoryStorage())
    c.setLogin({ status: 'waiting', provider: 'claude', startedAt: 1000, message: 'Signing in…' })
    const first = c.login

    c.setLogin({ status: 'waiting', provider: 'claude', startedAt: 1000, message: 'Signing in…' })

    // Identity must be preserved — a fresh object here is what woke the effect on every pass.
    expect(c.login).toBe(first)
  })

  it('converges instead of changing on every repeated call', () => {
    const c = new TutorialController(new MemoryStorage())
    const view = { status: 'waiting' as const, provider: 'claude' as const, message: 'Preparing…' }

    c.setLogin(view)
    const settled = c.login
    for (let i = 0; i < 25; i++) c.setLogin(view)

    expect(c.login).toBe(settled)
    expect(c.login.status).toBe('waiting')
    // startedAt is stamped once and then held, not re-stamped on every mirror.
    expect(c.login.startedAt).toBe(settled.startedAt)
  })

  it('still updates when the view genuinely changes, and clears startedAt when not waiting', () => {
    const c = new TutorialController(new MemoryStorage())
    c.setLogin({ status: 'waiting', provider: 'claude', startedAt: 5, message: 'a' })
    expect(c.login.startedAt).toBe(5)

    c.setLogin({ status: 'waiting', provider: 'claude', startedAt: 5, message: 'b' })
    expect(c.login.message).toBe('b')
    expect(c.login.startedAt).toBe(5)

    c.setLogin({ status: 'done', provider: 'claude', message: 'Account connected.' })
    expect(c.login.status).toBe('done')
    expect(c.login.startedAt).toBeUndefined()
  })
})
