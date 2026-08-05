import { untrack } from 'svelte'

export const FIRST_RUN_TUTORIAL_KEY = 'allmyagents.firstRunTutorial'
export const NEW_PROJECT_TUTORIAL_KEY = 'allmyagents.newProjectTutorial'

export type TutorialDisposition = 'new' | 'in-progress' | 'completed' | 'skipped'
export type FirstRunPhase = 'accounts' | 'overseer' | 'app'
export type LoginStatus = 'idle' | 'waiting' | 'done' | 'error' | 'cancelled'

export interface AccountLoginView {
  status: LoginStatus
  provider?: 'claude' | 'codex'
  startedAt?: number
  message?: string
}

interface TutorialRecord {
  schema: 1
  disposition: TutorialDisposition
  phase?: FirstRunPhase
  step?: number
  updatedAt: string
}

interface BootstrapProfile {
  id: string
}

interface BootstrapSession {
  id: string
  draft?: boolean
}

export interface TutorialBootstrap {
  profiles: BootstrapProfile[]
  sessions: BootstrapSession[]
}

type TutorialStorage = Pick<Storage, 'getItem' | 'setItem'>

function defaultRecord(): TutorialRecord {
  return {
    schema: 1,
    disposition: 'new',
    updatedAt: new Date(0).toISOString(),
  }
}

function readRecord(storage: TutorialStorage | null, key: string): TutorialRecord {
  if (!storage) return defaultRecord()
  try {
    const parsed = JSON.parse(storage.getItem(key) ?? 'null') as Partial<TutorialRecord> | null
    if (
      parsed?.schema === 1 &&
      (parsed.disposition === 'new' ||
        parsed.disposition === 'in-progress' ||
        parsed.disposition === 'completed' ||
        parsed.disposition === 'skipped')
    ) {
      return {
        schema: 1,
        disposition: parsed.disposition,
        phase:
          parsed.phase === 'accounts' || parsed.phase === 'overseer' || parsed.phase === 'app'
            ? parsed.phase
            : undefined,
        step: typeof parsed.step === 'number' && parsed.step >= 0 ? Math.floor(parsed.step) : undefined,
        updatedAt: typeof parsed.updatedAt === 'string' ? parsed.updatedAt : new Date(0).toISOString(),
      }
    }
  } catch {
    // A damaged preference must not trap the user in onboarding.
  }
  return defaultRecord()
}

function writeRecord(
  storage: TutorialStorage | null,
  key: string,
  disposition: TutorialDisposition,
  phase?: FirstRunPhase,
  step?: number,
): void {
  if (!storage) return
  try {
    storage.setItem(
      key,
      JSON.stringify({
        schema: 1,
        disposition,
        phase,
        step,
        updatedAt: new Date().toISOString(),
      } satisfies TutorialRecord),
    )
  } catch {
    // Storage can be unavailable in hardened browser contexts. The tour remains dismissible for this run.
  }
}

function isTerminal(disposition: TutorialDisposition): boolean {
  return disposition === 'completed' || disposition === 'skipped'
}

function browserStorage(): TutorialStorage | null {
  return typeof localStorage === 'undefined' ? null : localStorage
}

export function readTutorialDisposition(
  storage: TutorialStorage,
  key: string,
): TutorialDisposition {
  return readRecord(storage, key).disposition
}

export class TutorialController {
  initialized = $state(false)
  firstRunOpen = $state(false)
  firstRunPhase = $state<FirstRunPhase>('accounts')
  firstRunStep = $state(0)
  newProjectOpen = $state(false)
  newProjectStep = $state(0)
  login = $state<AccountLoginView>({ status: 'idle' })

  private firstRunReplay = false
  private newProjectReplay = false

  constructor(private readonly storage: TutorialStorage | null = browserStorage()) {}

  async initialize(loader: () => Promise<TutorialBootstrap>): Promise<boolean> {
    if (this.initialized) return true
    try {
      this.initializeFrom(await loader())
      return true
    } catch {
      // A hub error is not an empty installation. Leave onboarding closed until a later successful load.
      return false
    }
  }

  initializeFrom(bootstrap: TutorialBootstrap): void {
    const hasRealChat = bootstrap.sessions.some((session) => !session.draft)
    if (hasRealChat) {
      writeRecord(this.storage, FIRST_RUN_TUTORIAL_KEY, 'completed')
      writeRecord(this.storage, NEW_PROJECT_TUTORIAL_KEY, 'completed')
      this.firstRunOpen = false
      this.newProjectOpen = false
      this.initialized = true
      return
    }

    const record = readRecord(this.storage, FIRST_RUN_TUTORIAL_KEY)
    if (!isTerminal(record.disposition)) {
      this.firstRunPhase = bootstrap.profiles.length > 0 ? 'overseer' : 'accounts'
      this.firstRunStep = record.phase === this.firstRunPhase ? (record.step ?? 0) : 0
      this.firstRunOpen = true
      writeRecord(
        this.storage,
        FIRST_RUN_TUTORIAL_KEY,
        'in-progress',
        this.firstRunPhase,
        this.firstRunStep,
      )
    }
    this.initialized = true
  }

  accountAdded(): void {
    if (!this.firstRunOpen || this.firstRunPhase !== 'accounts') return
    this.firstRunPhase = 'overseer'
    this.firstRunStep = 0
    this.login = { status: 'done', message: 'Account connected.' }
    if (!this.firstRunReplay) {
      writeRecord(this.storage, FIRST_RUN_TUTORIAL_KEY, 'in-progress', 'overseer', 0)
    }
  }

  overseerConfigured(): void {
    if (!this.firstRunOpen || this.firstRunPhase !== 'overseer') return
    this.finishFirstRun()
  }

  setLogin(view: AccountLoginView): void {
    // THE READ HERE MUST BE UNTRACKED, AND THE WRITE MUST BE CONDITIONAL.
    //
    // This runs synchronously inside SettingsModal's `$effect`, which mirrors login state up to the
    // tutorial. Svelte 5 tracks every `$state` read that happens during an effect — including reads
    // inside functions the effect calls. Reading `this.login` plainly therefore made `login` a
    // dependency of that effect, while the line below WRITES `login` on the very same pass. Each call
    // builds a fresh object, so the write always counted as a change and the effect retriggered itself
    // forever.
    //
    // It armed only during a sign-in: the `startedAt` branch is the sole place the previous value was
    // read, and it is reached only when `view.status === 'waiting'` — which SettingsModal reports for
    // `capturing`/`waiting`/`settling`. So the moment an account sign-in began, the renderer and the
    // compositor pegged and the entire app froze, while the hub sat idle and the sign-in itself
    // completed normally. That is why fixing the login/polling logic never helped.
    const previous = untrack(() => this.login)
    const startedAt =
      view.status === 'waiting'
        ? (previous.status === 'waiting' ? previous.startedAt : (view.startedAt ?? Date.now()))
        : undefined
    const next = { ...view, startedAt }
    // Belt and braces: an unchanged view must not mint a new object identity either, so no observer can
    // be woken by a write that carries no information.
    if (
      previous.status === next.status &&
      previous.provider === next.provider &&
      previous.startedAt === next.startedAt &&
      previous.message === next.message
    ) {
      return
    }
    this.login = next
  }

  setFirstRunStep(step: number): void {
    this.firstRunStep = Math.max(0, Math.floor(step))
    if (!this.firstRunReplay) {
      writeRecord(
        this.storage,
        FIRST_RUN_TUTORIAL_KEY,
        'in-progress',
        this.firstRunPhase,
        this.firstRunStep,
      )
    }
  }

  skipFirstRun(): void {
    this.firstRunOpen = false
    if (!this.firstRunReplay) writeRecord(this.storage, FIRST_RUN_TUTORIAL_KEY, 'skipped')
    this.firstRunReplay = false
  }

  finishFirstRun(): void {
    this.firstRunOpen = false
    if (!this.firstRunReplay) writeRecord(this.storage, FIRST_RUN_TUTORIAL_KEY, 'completed')
    this.firstRunReplay = false
  }

  replayFirstRun(hasAccounts: boolean): void {
    this.firstRunReplay = true
    this.firstRunPhase = hasAccounts ? 'overseer' : 'accounts'
    this.firstRunStep = 0
    this.firstRunOpen = true
  }

  replayAppTour(): void {
    this.firstRunReplay = true
    this.firstRunPhase = 'app'
    this.firstRunStep = 0
    this.firstRunOpen = true
  }

  startNewProjectTutorial(projectInProgress: boolean): boolean {
    const disposition = readRecord(this.storage, NEW_PROJECT_TUTORIAL_KEY).disposition
    if (
      !this.initialized ||
      projectInProgress ||
      this.firstRunOpen ||
      disposition !== 'new'
    ) {
      return false
    }
    this.newProjectReplay = false
    this.newProjectStep = 0
    this.newProjectOpen = true
    writeRecord(this.storage, NEW_PROJECT_TUTORIAL_KEY, 'in-progress', undefined, 0)
    return true
  }

  setNewProjectStep(step: number): void {
    this.newProjectStep = Math.max(0, Math.floor(step))
    if (!this.newProjectReplay) {
      writeRecord(
        this.storage,
        NEW_PROJECT_TUTORIAL_KEY,
        'in-progress',
        undefined,
        this.newProjectStep,
      )
    }
  }

  skipNewProject(): void {
    this.newProjectOpen = false
    if (!this.newProjectReplay) writeRecord(this.storage, NEW_PROJECT_TUTORIAL_KEY, 'skipped')
    this.newProjectReplay = false
  }

  finishNewProject(): void {
    this.newProjectOpen = false
    if (!this.newProjectReplay) writeRecord(this.storage, NEW_PROJECT_TUTORIAL_KEY, 'completed')
    this.newProjectReplay = false
  }

  closeNewProjectTutorial(): void {
    this.newProjectOpen = false
    this.newProjectReplay = false
  }

  replayNewProject(): void {
    this.newProjectReplay = true
    this.newProjectStep = 0
    this.newProjectOpen = true
  }
}

export const tutorials = new TutorialController()
