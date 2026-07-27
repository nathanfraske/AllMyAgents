import fs from 'node:fs'
import path from 'node:path'
import { ApprovalService } from '../src/approvals.js'
import { AgentBus } from '../src/bus.js'
import type { Executor } from '../src/executor.js'
import { InstructionStore } from '../src/instructions.js'
import { Journal } from '../src/journal.js'
import { MemoryStore } from '../src/memory.js'
import { PracticeStore } from '../src/practices.js'
import { ProjectStore } from '../src/projects.js'
import { SessionManager } from '../src/sessions.js'
import { SessionStore } from '../src/store.js'
import type { Profile } from '../src/types.js'
import { UsageMonitor } from '../src/usage.js'
import { WorkspaceManager } from '../src/workspace.js'

const [dbFile, crashAfterText] = process.argv.slice(2)
if (!dbFile) throw new Error('db path required')
const crashAfter = Number(crashAfterText)
if (!Number.isInteger(crashAfter) || crashAfter < 1) throw new Error('positive crash point required')

const root = path.dirname(dbFile)
const profileDir = path.join(root, 'profile')
fs.mkdirSync(profileDir, { recursive: true })
const journal = new Journal(dbFile)
const store = new SessionStore(journal.db)
const profiles: Profile[] = [{ id: 'p1', provider: 'claude', dir: profileDir }]
const executor: Executor = {
  startThread: async () => 'unused',
  runTurn: async () => {},
  steer: async () => {},
  interrupt: async () => {},
  stopSession: async () => {},
  readCodexLimits: async () => ({}),
  listLive: async () => [],
  attach: async () => {},
  isBusy: () => false,
}
const sessions = new SessionManager(
  journal,
  store,
  new Map(profiles.map((profile) => [profile.id, profile])),
  new ApprovalService(journal),
  new UsageMonitor(journal, profiles, {}),
  new WorkspaceManager(path.join(root, 'worktrees')),
  new ProjectStore(journal.db),
  new InstructionStore(journal.db),
  new AgentBus(journal.db),
  new MemoryStore(journal.db),
  new PracticeStore(journal.db),
  { busCanUseRiskyTools: false, autoApprovePractices: false },
  false,
  root,
  executor
)
sessions.loadRecords()

const originalUpsert = store.upsert.bind(store)
let writes = 0
store.upsert = (record) => {
  originalUpsert(record)
  writes += 1
  if (writes !== crashAfter) return
  process.send?.({ type: 'persistence-boundary', writes })
  // The parent terminates this real process while SQLite has the transaction open. Atomics.wait avoids
  // timers, promises, or graceful cleanup that could accidentally let the call return and commit.
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0)
}

sessions.configureProjectManager(
  'manager',
  {
    enabled: true,
    maxLiveChildren: 2,
    delegation: [],
    allowedProfiles: ['p1'],
  },
  'operator'
)
throw new Error('crash harness unexpectedly completed')
