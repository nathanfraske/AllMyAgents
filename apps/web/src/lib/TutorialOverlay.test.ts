import { cleanup, fireEvent, render, screen } from '@testing-library/svelte'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import TutorialOverlay from './TutorialOverlay.svelte'
import { store } from './store.svelte'
import { tutorials } from './tutorialState.svelte'

beforeEach(() => {
  localStorage.clear()
  store.settingsOpen = false
  tutorials.initialized = true
  tutorials.firstRunOpen = false
  tutorials.firstRunPhase = 'accounts'
  tutorials.firstRunStep = 0
  tutorials.newProjectOpen = false
  tutorials.newProjectStep = 0
  tutorials.login = { status: 'idle' }
})

afterEach(() => cleanup())

describe('first-run tutorial overlay', () => {
  it('keeps Skip visible and explains an in-flight browser sign-in without looking frozen', () => {
    tutorials.replayFirstRun(false)
    tutorials.setLogin({
      status: 'waiting',
      provider: 'claude',
      startedAt: Date.now() - 5_000,
      message: 'Waiting for you to finish in the browser…',
    })

    render(TutorialOverlay, { props: { kind: 'first-run' } })

    expect(screen.getByRole('button', { name: 'Skip tutorial' })).toBeTruthy()
    expect(screen.getByText('Waiting for you to finish signing in in your browser')).toBeTruthy()
    expect(screen.getByText(/usually takes about 30 seconds/i)).toBeTruthy()
    expect(screen.getByText(/elapsed/i)).toBeTruthy()
  })
})

describe('first New Project tutorial overlay', () => {
  it('teaches the real deferred pipeline while leaving every step skippable', async () => {
    tutorials.replayNewProject()
    render(TutorialOverlay, { props: { kind: 'new-project' } })

    expect(screen.getByText('A shared place for related work')).toBeTruthy()
    expect(screen.getByText(/do not need a project for a quick chat/i)).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Skip tutorial' })).toBeTruthy()

    await fireEvent.click(screen.getByRole('button', { name: 'Next' }))
    expect(screen.getByText(/existing directory, choose a GitHub repository/i)).toBeTruthy()

    await fireEvent.click(screen.getByRole('button', { name: 'Next' }))
    expect(screen.getByText(/isolated branch and folder/i)).toBeTruthy()

    await fireEvent.click(screen.getByRole('button', { name: 'Next' }))
    expect(screen.getByText(/manager-led team/i)).toBeTruthy()
    expect(screen.getByText(/Either choice is optional/i)).toBeTruthy()

    await fireEvent.click(screen.getByRole('button', { name: 'Next' }))
    expect(screen.getByText(/Nothing is created until Finalize/i)).toBeTruthy()
    expect(screen.getByText(/only when you finalize the launch/i)).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Finish' })).toBeTruthy()
  })
})
