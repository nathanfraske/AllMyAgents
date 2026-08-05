import { spawn, spawnSync, type ChildProcess } from 'node:child_process'
import readline from 'node:readline'
import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'
import { AGENT_MCP_SERVER_NAME } from '../codexMcpConfig.js'
import { windowsPathToWsl } from '../workspaceLocation.js'
import { nativeWslExecutable, spawnInWsl } from '../wslProcess.js'
import { repairCodexRolloutPaths } from '../codexRolloutRelocation.js'
import { CODEX_COMPACTION_PROMPT } from '../compactionContinuity.js'
import {
  documentTextBlock,
  isPdfAttachment,
  isTextAttachment,
  officeAttachmentKind,
  type AttachmentMeta,
} from '../attachments.js'

/**
 * Absolute path to the codex CLI entry, or null if we cannot find it.
 *
 * WHY THIS EXISTS: the app-server used to be started as `spawn('codex app-server', { shell: true })`,
 * i.e. resolved through PATH. That silently couples the hub to HOW it was launched — the desktop starts
 * it via `cmd /C pnpm hubctl:dev`, and it is *pnpm* that injects `node_modules/.bin` into PATH. Start the
 * SAME hub any other way (a direct `node hubctl.js`, a service, a scheduler, or an installed build whose
 * environment nobody controls) and `codex` is not on PATH, so the shell — not codex — exits 1. Every Codex
 * turn then dies instantly with "codex app-server exited (1)" and an empty stderr, which points at
 * completely the wrong thing. Observed exactly that way in production. Resolving from our own
 * node_modules and launching with our own node removes the entire class, and matters most for the alpha,
 * where the installed app's environment is not ours to predict.
 */
function codexEntry(): string | null {
  const rel = path.join('@openai', 'codex', 'bin', 'codex.js')
  // Both src/adapters/*.ts and dist/adapters/*.js sit two levels under the hub package root.
  for (const base of ['..', '../..', '../../..']) {
    const candidate = path.resolve(import.meta.dirname, base, 'node_modules', rel)
    try {
      if (fs.existsSync(candidate)) return candidate
    } catch {
      /* keep looking */
    }
  }
  try {
    return createRequire(import.meta.url).resolve('@openai/codex/bin/codex.js')
  } catch {
    return null
  }
}

type EventSink = (kind: string, payload: unknown) => void

export type CodexApprovalHandler = (method: string, params: unknown) => Promise<unknown>

/** Codex server-request method for an MCP **elicitation** (a server asking the user), as opposed to the
 *  exec/patch approvals. Codex raises one the first time a thread uses a given MCP server's tool. */
export const CODEX_ELICITATION_METHOD = 'mcpServer/elicitation/request'
export const CODEX_PERMISSIONS_APPROVAL_METHOD = 'item/permissions/requestApproval'

/**
 * Build the JSON-RPC result codex expects for a server request. THE SHAPES DIFFER and getting it wrong is
 * silent: an elicitation follows the MCP spec (`{action}`) while exec/patch approvals use `{decision}`, and
 * answering an elicitation with `{decision:'accept'}` is read as a REJECTION — the agent is simply told
 * "user rejected MCP tool call". Observed exactly that: an approved Codex tool call came back rejected.
 */
/**
 * Best-effort human reason from a `codex/turn/error` payload, shared by both executors so the two report
 * a failed Codex turn identically.
 *
 * NEVER returns blank. A terminal event whose message renders as an empty string produces exactly the
 * failure this project keeps hitting: the UI shows *something went wrong* with no way to learn what, or
 * worse, an empty error card. Same rule as the Claude result path, which had to stop reading a field that
 * does not exist on the error shape.
 */
export function codexTurnErrorMessage(payload: unknown): string {
  const p = payload as { error?: unknown; message?: unknown } | null
  const err = p?.error
  const fromError =
    typeof err === 'string' ? err : typeof (err as { message?: unknown } | null)?.message === 'string' ? ((err as { message: string }).message) : undefined
  const direct = typeof p?.message === 'string' ? p.message : undefined
  return (fromError ?? direct ?? '').trim() || 'codex reported a turn error with no message'
}

/** How a Codex turn actually ended. `unknown` is deliberately distinct from `completed`. */
export type CodexTurnOutcome =
  | { kind: 'completed' }
  | { kind: 'interrupted' }
  | { kind: 'failed'; message: string }
  | { kind: 'unknown' }

/**
 * Read the terminal outcome from a `codex/turn/completed` payload.
 *
 * EVERY turn ends with turn/completed — success, interruption and failure alike — and `turn.status`
 * (completed | interrupted | failed) is what distinguishes them, with `turn.error` carrying the reason.
 * Both executors used to treat the event itself as success and never look at the status, so a genuinely
 * FAILED Codex turn stopped the spinner and reported plain "ready", with the reason discarded. That is the
 * same defect as the blank Claude error card, arrived at from the opposite direction: there we rendered an
 * error with no text, here we render no error at all.
 *
 * An unrecognised or missing status returns `unknown`, never `completed`. Treating "I do not recognise
 * this" as success is how a failure gets a green tick.
 */
export function codexTurnOutcome(payload: unknown): CodexTurnOutcome {
  const turn = (payload as { turn?: { status?: unknown; error?: unknown } } | null)?.turn
  const status = typeof turn?.status === 'string' ? turn.status : undefined
  if (status === 'completed') return { kind: 'completed' }
  if (status === 'interrupted') return { kind: 'interrupted' }
  if (status === 'failed') return { kind: 'failed', message: codexTurnErrorMessage(turn) }
  return { kind: 'unknown' }
}

/**
 * A stable, human-readable name for the THING a Codex approval is about — 'commandExecution',
 * 'fileChange', and so on.
 *
 * Claude approvals carry `toolName`, and everything downstream keys on it: the card's title, the
 * "Always allow <tool>" button, the per-chat allowlist, and the policy that reads it back. Codex
 * approvals carry no such field, so all of that silently did nothing for Codex — the button never
 * rendered and a grant would have had nothing to match. Deriving the name HERE, once, and putting it in
 * the payload under the same key means the UI and the policy cannot drift apart: there is one definition
 * and both sides read it rather than each parsing the method string their own way.
 */
export function codexGrantKey(method: string): string {
  const core = method.replace(/^item\//, '').replace(/\/requestApproval$/, '')
  return core || method
}

export function codexRequestResult(
  method: string,
  approved: boolean,
  params?: unknown,
): Record<string, unknown> {
  if (method === CODEX_ELICITATION_METHOD) {
    return { action: approved ? 'accept' : 'decline' }
  }
  if (method === CODEX_PERMISSIONS_APPROVAL_METHOD) {
    const requested = (params as { permissions?: unknown } | null)?.permissions
    const permissions = approved && requested !== null && typeof requested === 'object' && !Array.isArray(requested)
      ? requested
      : {}
    // App-server 0.145 does not accept the ordinary `{decision}` response for request_permissions.
    // It requires the granted SUBSET. Echoing only the exact requested profile after hub approval is
    // fail-closed, and turn scope avoids silently converting one operator decision into a durable grant.
    return { permissions, scope: 'turn' }
  }
  return { decision: approved ? 'accept' : 'decline' }
}

/**
 * True when the request is codex asking permission to use OUR OWN hub-registered MCP server. Auto-accepted,
 * mirroring the Claude side's AUTO_ALLOW set: the hub wrote that server into the profile config itself, the
 * tool bodies run IN the hub, and they already enforce the same-project ACL, scope checks, and the practice
 * self-gate. Prompting the operator once per thread for the hub's own bus/memory tools is pure friction and
 * breaks cross-vendor parity, since Claude never prompts for them.
 */
export function isOwnAgentServerRequest(method: string, params: unknown): boolean {
  if (method !== CODEX_ELICITATION_METHOD) return false
  return (params as { serverName?: unknown } | null)?.serverName === AGENT_MCP_SERVER_NAME
}

export interface CodexTurnOptions {
  model?: string
  effort?: string
  serviceTier?: string
  approvalPolicy?: string
  /** `{ mode, writableRoots }` — what the agent is allowed to touch. See {@link codexTurnPolicy}. */
  sandboxPolicy?: { type: string; writableRoots?: string[] }
}

function turnInput(text: string, attachments: readonly AttachmentMeta[]): Array<Record<string, string>> {
  const input: Array<Record<string, string>> = []
  if (text || attachments.length === 0) input.push({ type: 'text', text })
  for (const attachment of attachments) {
    if (isPdfAttachment(attachment)) {
      input.push({ type: 'text', text: documentTextBlock(attachment, true) })
    } else if (attachment.mime.startsWith('image/')) {
      input.push({ type: 'localImage', path: attachment.executionPath ?? attachment.path })
    } else if (officeAttachmentKind(attachment)) {
      input.push({ type: 'text', text: documentTextBlock(attachment, true) })
    } else if (isTextAttachment(attachment)) {
      input.push({ type: 'text', text: documentTextBlock(attachment) })
    } else {
      throw new Error(`unsupported Codex attachment reached adapter: ${attachment.name}`)
    }
  }
  return input
}

/**
 * Translate a chat's permission mode into the two settings Codex actually needs — and they must be set
 * TOGETHER, because they answer different questions:
 *   - approvalPolicy: may the agent ASK a human?
 *   - sandboxPolicy:  what may the agent TOUCH?
 *
 * Only the first was ever sent, and `full` mapped to `never`. With no sandbox set, Codex defaults to
 * read-only — so a chat the operator had explicitly put in FULL ACCESS launched an agent that could not
 * write AND was forbidden to ask, which reads from the inside as a broken agent rather than a permission
 * setting. Half of a two-part contract, with the missing half defaulting to the strictest value.
 *
 * The approval policy is now ALWAYS 'on-request', for every mode, which looks surprising until you see
 * what it buys: Codex asks the hub, and the HUB decides. That is exactly the Claude arrangement, and it
 * keeps the things that only exist hub-side — the audit row for anything auto-approved, the bus-origin
 * clamp, and the ability to tighten a live chat from Full to Safe. Mapping `full` to `never` would hand
 * the decision to the vendor and lose all three. "No prompts" is the hub's answer to give, not Codex's.
 *
 * `full` is the explicit operator choice that lifts Codex's filesystem/network sandbox. Approval requests
 * still flow through the hub, so live mode changes, the audit trail, and the bus-origin clamp remain in
 * force. A normal operator-origin Full turn receives dangerFullAccess; a teammate-caused turn is clamped
 * to Edits before it reaches this function unless the operator separately enables Full access for every
 * origin in Danger Zone. This does not manufacture OS administrator rights: Windows UAC / sudo still
 * applies at the operating-system boundary, but Full no longer prevents an agent from invoking an
 * operator-approved elevation mechanism.
 */
export function codexTurnPolicy(spec: {
  permissionMode?: 'safe' | 'edits' | 'full'
  worktree?: string
  cwd: string
}): Pick<CodexTurnOptions, 'approvalPolicy' | 'sandboxPolicy'> {
  return {
    approvalPolicy: 'on-request',
    sandboxPolicy:
      spec.permissionMode === 'full'
        ? { type: 'dangerFullAccess' }
        : { type: 'workspaceWrite', writableRoots: [spec.worktree ?? spec.cwd] },
  }
}

/** Normalized token usage forwarded to the UI as a `session/tokens` event (all fields optional). */
export interface TokenUsage {
  input?: number
  output?: number
  total?: number
  context?: number
}

function numField(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

/**
 * Map a Codex app-server `thread/tokenUsage/updated` notification's params to the hub's normalized
 * token shape. The exact field names vary by installed app-server version, so this probes both a
 * nested usage object (`params.usage` / `tokenUsage` / `tokens` / `info`) and the flat params, in
 * camelCase and snake_case, and never throws on missing fields. Returns undefined when nothing
 * usable is present. The raw notification is still journaled as `codex/thread/tokenUsage/updated`,
 * so the live wire shape can be sanity-checked and this mapping widened if the names differ.
 */
export function mapCodexTokenUsage(params: unknown): TokenUsage | undefined {
  if (!params || typeof params !== 'object') return undefined
  const p = params as Record<string, unknown>
  const nested = [p.usage, p.tokenUsage, p.tokens, p.info].find(
    (v): v is Record<string, unknown> => !!v && typeof v === 'object'
  )
  const pick = (...keys: string[]): number | undefined => {
    for (const src of [nested, p]) {
      if (!src) continue
      for (const key of keys) {
        const n = numField(src[key])
        if (n !== undefined) return n
      }
    }
    return undefined
  }
  const input = pick('input_tokens', 'inputTokens', 'input', 'prompt_tokens', 'promptTokens')
  const output = pick('output_tokens', 'outputTokens', 'output', 'completion_tokens', 'completionTokens')
  let total = pick('total_tokens', 'totalTokens', 'total', 'total_token_usage', 'totalTokenUsage')
  if (total === undefined && input !== undefined && output !== undefined) total = input + output
  const context = pick(
    'context_window',
    'contextWindow',
    'context',
    'context_tokens',
    'contextTokens',
    'used_context_window',
    'usedContextWindow'
  )
  const out: TokenUsage = {}
  if (input !== undefined) out.input = input
  if (output !== undefined) out.output = output
  if (total !== undefined) out.total = total
  if (context !== undefined) out.context = context
  return Object.keys(out).length > 0 ? out : undefined
}

interface Pending {
  method: string
  resolve: (value: unknown) => void
  reject: (err: Error) => void
}

export class CodexClient {
  private child: ChildProcess | undefined
  private nextId = 1
  private readonly pending = new Map<number, Pending>()
  /**
   * Codex 0.145 models a spawned agent as another app-server thread. Notifications produced by that
   * thread carry the CHILD thread id, while the hub only knows the root thread id it persisted as the
   * chat's vendorSessionId. Keep the protocol's explicit parent edges so child events can be routed to
   * the owning chat without erasing who produced them.
   */
  private readonly threadParents = new Map<string, string | null>()
  /** Child threads are not implicitly subscribed on the connection that owns their parent. Once the
   * parent emits its structured SubAgentActivity edge, resume the child exactly once to join its live
   * event stream. This is what makes its own turn/item lifecycle available for attribution. */
  private readonly subagentSubscriptions = new Set<string>()
  // threadId -> id of the turn currently running on that thread (for steer's expectedTurnId)
  private readonly activeTurns = new Map<string, string>()
  /** Last developer-instruction bytes applied to each root thread. Invalidated after compaction. */
  private readonly developerInstructionsByThread = new Map<string, string>()
  /**
   * `thread/start` allocates an id before app-server has written a rollout. `thread/resume` rejects that
   * id until the first turn starts, even on the same live connection. Keep the short pristine window
   * explicit so a concurrent topology change cannot turn the first send into "no rollout found".
   */
  private readonly pristineThreads = new Set<string>()
  private initPromise: Promise<void> | undefined

  constructor(
    private readonly profileDir: string,
    private readonly onEvent: EventSink,
    private readonly onApproval?: CodexApprovalHandler,
    private readonly wsl?: { distro: string },
  ) {}

  private send(msg: Record<string, unknown>): void {
    this.child?.stdin?.write(JSON.stringify(msg) + '\n')
  }

  request<T = unknown>(method: string, params?: unknown): Promise<T> {
    const id = this.nextId++
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { method, resolve: resolve as (v: unknown) => void, reject })
      this.send(params === undefined ? { id, method } : { id, method, params })
    })
  }

  async ensureStarted(): Promise<void> {
    if (!this.initPromise) this.initPromise = this.startInner()
    return this.initPromise
  }

  private async startInner(): Promise<void> {
    // Codex indexes each rollout by absolute path in state_N.sqlite. A profile first used from a Windows
    // packaged app can later appear at the normal Roaming root while that index still points into the
    // package's vanished LocalCache virtualization tree. Repair only exact, contained root relocations
    // before app-server opens the database; otherwise every affected thread/resume fails independently.
    if (!this.wsl) {
      const relocation = repairCodexRolloutPaths(this.profileDir)
      for (const repair of relocation.repairs) this.onEvent('codex/rollout-path-rebased', repair)
      for (const warning of relocation.warnings) this.onEvent('codex/rollout-path-repair-warning', warning)
    }
    const env = {
      ...process.env,
      CODEX_HOME: this.wsl ? windowsPathToWsl(this.profileDir) : this.profileDir,
    }
    const entry = this.wsl ? null : codexEntry()
    // Preferred: our own node running the resolved entry — no shell, no PATH dependency (see codexEntry).
    // Fallback keeps the historical PATH lookup so an unusual layout we cannot resolve still works.
    const child = this.wsl
      ? spawnInWsl(
          this.wsl.distro,
          '/',
          nativeWslExecutable(this.wsl.distro, 'codex'),
          ['app-server'],
          env,
        )
      : entry
        ? spawn(process.execPath, [entry, 'app-server'], { env })
        : spawn('codex app-server', { shell: true, env })
    if (!this.wsl && !entry) {
      this.onEvent('codex/spawn-fallback', {
        reason: 'could not resolve @openai/codex; using PATH lookup',
      })
    }
    this.child = child
    if (child.stdout) {
      const rl = readline.createInterface({ input: child.stdout })
      rl.on('line', (line) => this.onLine(line))
    }
    child.stderr?.on('data', (d: Buffer) => this.onEvent('codex/stderr', d.toString()))
    child.on('exit', (code) => {
      this.onEvent('codex/exited', { code })
      const err = new Error(`codex app-server exited (${code})`)
      for (const p of this.pending.values()) p.reject(err)
      this.pending.clear()
      this.child = undefined
      this.initPromise = undefined
    })
    await this.request('initialize', {
      clientInfo: { name: 'allmyagents-hub', title: 'AllMyAgents hub', version: '0.0.1' },
    })
    this.send({ method: 'initialized' })
  }

  private onLine(line: string): void {
    if (!line.trim()) return
    let msg: { id?: number; method?: string; params?: unknown; result?: unknown; error?: unknown }
    try {
      msg = JSON.parse(line) as typeof msg
    } catch {
      this.onEvent('codex/raw', line)
      return
    }
    const isResponse = msg.id !== undefined && msg.method === undefined
    const isServerRequest = msg.id !== undefined && msg.method !== undefined
    if (isResponse) {
      const p = this.pending.get(msg.id as number)
      if (!p) return
      this.pending.delete(msg.id as number)
      if (msg.error) p.reject(new Error(`${p.method}: ${JSON.stringify(msg.error)}`))
      else p.resolve(msg.result)
      return
    }
    if (isServerRequest) {
      const id = msg.id as number
      const method = msg.method as string
      // Approval requests made inside a sub-agent carry its child thread id too. Route the card through
      // the root chat, but retain `agentThreadId` so the request is still attributable. The response is
      // keyed by JSON-RPC id, so replacing threadId in this local copy does not alter Codex's decision.
      const routed = this.routeThreadPayload(msg.params ?? null)
      this.onEvent(`codex/request/${method}`, routed.payload)
      if (this.onApproval) {
        void this.onApproval(method, routed.payload)
          .then((result) => this.send({ id, result }))
          .catch(() => this.send({ id, result: codexRequestResult(method, false, msg.params) }))
      } else {
        this.send({ id, result: codexRequestResult(method, false, msg.params) })
      }
      return
    }
    // Track the active turn per thread so steer can target it: turn/started carries the
    // new turn's id (params.turn.id); turn/completed and turn/error end that turn.
    if (msg.method === 'turn/started') {
      const p = msg.params as { threadId?: string; turn?: { id?: string } } | null
      if (p?.threadId && p.turn?.id) {
        this.activeTurns.set(p.threadId, p.turn.id)
        this.pristineThreads.delete(p.threadId)
      }
    } else if (msg.method === 'turn/completed' || msg.method === 'turn/error') {
      const p = msg.params as { threadId?: string } | null
      if (p?.threadId) this.activeTurns.delete(p.threadId)
    }
    if (msg.method === 'item/completed') {
      const p = msg.params as { threadId?: string; item?: { type?: string } } | null
      if (p?.threadId && p.item?.type === 'contextCompaction') {
        // Developer instructions are thread settings and remain in Codex's protected prefix across
        // compaction. Clear the local equality cache anyway so the next turn reasserts the exact live
        // app/topology bytes through thread/resume instead of trusting that invariant indefinitely.
        // This does NOT clear the vendor thread, its new continuity summary, or any conversation state.
        this.developerInstructionsByThread.delete(p.threadId)
      }
    }
    const method = msg.method as string
    const routed = this.routeThreadPayload(msg.params ?? null)
    // Keep root event names byte-for-byte compatible. Child events use an explicit namespace so the
    // executor does not mistake a child's turn/completed for the ROOT turn completing and mark the whole
    // chat idle. Claude supplies a parent tool id on each SDK envelope. Codex 0.145 instead emits a
    // SubAgentActivity item on the parent; after we subscribe to that child thread, its separate stream
    // must be re-homed here without erasing the child id.
    this.onEvent(routed.isSubagent ? `codex/subagent/${method}` : `codex/${method}`, routed.payload)
  }

  async startThread(cwd: string, developerInstructions?: string): Promise<string> {
    await this.ensureStarted()
    const normalized = developerInstructions?.trim()
    const params: Record<string, unknown> = {
      cwd,
      // Installed app-server 0.145 exposes thread-scoped config overrides on thread/start. The official
      // Codex config key is snake_case; unlike developerInstructions, this controls the summary request
      // itself. CODEX_COMPACTION_PROMPT is deliberately a complete replacement prompt.
      config: { compact_prompt: CODEX_COMPACTION_PROMPT },
    }
    if (normalized) params.developerInstructions = normalized
    const result = await this.request<{
      threadId?: string
      thread?: { id?: string; parentThreadId?: string | null }
    }>('thread/start', params)
    const threadId = result.threadId ?? result.thread?.id
    if (!threadId) throw new Error('thread/start returned no thread id')
    this.threadParents.set(threadId, result.thread?.parentThreadId ?? null)
    this.pristineThreads.add(threadId)
    if (normalized) this.developerInstructionsByThread.set(threadId, normalized)
    return threadId
  }

  async resumeThread(threadId: string, developerInstructions?: string): Promise<void> {
    await this.ensureStarted()
    const normalized = developerInstructions?.trim()
    const params: Record<string, unknown> = {
      threadId,
      // Reassert the compaction contract when joining an existing thread, including threads created by
      // an older AllMyAgents cut. This upgrades current sessions without requiring recreation.
      config: { compact_prompt: CODEX_COMPACTION_PROMPT },
    }
    if (normalized) params.developerInstructions = normalized
    const result = await this.request<{ thread?: { id?: string; parentThreadId?: string | null } }>(
      'thread/resume',
      params
    )
    const resumedId = result.thread?.id ?? threadId
    this.threadParents.set(resumedId, result.thread?.parentThreadId ?? null)
    this.pristineThreads.delete(threadId)
    this.pristineThreads.delete(resumedId)
    if (normalized) this.developerInstructionsByThread.set(resumedId, normalized)
  }

  /** Refresh changed app/topology instructions on an already-loaded thread without adding a fake turn. */
  async ensureDeveloperInstructions(threadId: string, developerInstructions?: string): Promise<void> {
    const normalized = developerInstructions?.trim()
    if (!normalized || this.developerInstructionsByThread.get(threadId) === normalized) return
    // The initial developer contract is already installed on this in-memory thread. App-server does not
    // expose an in-place pre-turn mutation seam, and thread/resume cannot address it until a rollout
    // exists. Keep the safe initial bytes for turn one; after turn/started clears this marker, the next
    // accepted turn can refresh changed topology through the supported resume seam.
    if (this.pristineThreads.has(threadId)) return
    // The generated 0.145 protocol exposes developerInstructions on thread/start and thread/resume,
    // not as an arbitrary turn/start field. Rejoining a running thread is the supported update seam.
    await this.resumeThread(threadId, normalized)
  }

  /**
   * Normalize one app-server payload for the hub event stream.
   *
   * App-server's authoritative 0.145 schema exposes both:
   *   - a parent-thread `subAgentActivity` item with `agentThreadId` + `agentPath`; and
   *   - `thread.parentThreadId` after this client explicitly resumes/subscribes to the child.
   * Child turn/item notifications then carry the child id in `params.threadId`.
   *
   * The hub routes by `payload.threadId`, so a child payload is copied with the ROOT in `threadId` and
   * the untouched child/immediate-parent ids in `agentThreadId`/`parentThreadId`. No prose, tool output,
   * or timing guess participates in this attribution.
   */
  private routeThreadPayload(payload: unknown): {
    payload: unknown
    isSubagent: boolean
  } {
    if (!payload || typeof payload !== 'object') return { payload, isSubagent: false }
    const p = payload as Record<string, unknown>
    const sourceThreadId = typeof p.threadId === 'string' ? p.threadId : undefined
    const item =
      p.item && typeof p.item === 'object' ? (p.item as Record<string, unknown>) : undefined
    if (sourceThreadId && item?.type === 'subAgentActivity' && typeof item.agentThreadId === 'string') {
      // This is the first edge emitted in a real 0.145 spawn. `thread/started` for the child is not sent
      // to the parent's subscriber, so waiting for that event leaves later child approvals unattributed.
      const childThreadId = item.agentThreadId
      this.threadParents.set(childThreadId, sourceThreadId)
      if (item.kind !== 'interrupted') this.subscribeSubagent(childThreadId, sourceThreadId)
    }
    const thread =
      p.thread && typeof p.thread === 'object' ? (p.thread as Record<string, unknown>) : undefined
    const announcedId = typeof thread?.id === 'string' ? thread.id : undefined
    if (announcedId) {
      const parent = typeof thread?.parentThreadId === 'string' ? thread.parentThreadId : null
      this.threadParents.set(announcedId, parent)
    }

    const actualThreadId =
      typeof p.threadId === 'string' ? p.threadId : announcedId
    if (!actualThreadId) return { payload, isSubagent: false }
    const parentThreadId = this.threadParents.get(actualThreadId)
    if (typeof parentThreadId !== 'string') return { payload, isSubagent: false }

    let rootThreadId = parentThreadId
    const seen = new Set([actualThreadId])
    while (!seen.has(rootThreadId)) {
      seen.add(rootThreadId)
      const parent = this.threadParents.get(rootThreadId)
      if (typeof parent !== 'string') break
      rootThreadId = parent
    }
    return {
      payload: {
        ...p,
        threadId: rootThreadId,
        agentThreadId: actualThreadId,
        parentThreadId,
      },
      isSubagent: true,
    }
  }

  private subscribeSubagent(childThreadId: string, parentThreadId: string): void {
    if (this.subagentSubscriptions.has(childThreadId)) return
    this.subagentSubscriptions.add(childThreadId)
    // `thread/resume` is also app-server's live-subscription operation. Do not pass `excludeTurns`: that
    // option is experimental in 0.145 and is rejected because this adapter intentionally initializes with
    // stable capabilities only. The response stays internal; new child items arrive as live notifications.
    void this.request<{ thread?: { id?: string; parentThreadId?: string | null } }>('thread/resume', {
      threadId: childThreadId,
    })
      .then((result) => {
        const id = result.thread?.id ?? childThreadId
        this.threadParents.set(id, result.thread?.parentThreadId ?? parentThreadId)
      })
      .catch((error: unknown) => {
        this.subagentSubscriptions.delete(childThreadId)
        this.onEvent('codex/subagent/subscription/error', {
          threadId: this.rootThreadId(parentThreadId),
          agentThreadId: childThreadId,
          parentThreadId,
          message: error instanceof Error ? error.message : String(error),
        })
      })
  }

  private rootThreadId(threadId: string): string {
    let root = threadId
    const seen = new Set<string>()
    while (!seen.has(root)) {
      seen.add(root)
      const parent = this.threadParents.get(root)
      if (typeof parent !== 'string') break
      root = parent
    }
    return root
  }

  async sendTurn(
    threadId: string,
    text: string,
    opts: CodexTurnOptions = {},
    attachments: readonly AttachmentMeta[] = []
  ): Promise<void> {
    // Codex may otherwise complete reasoning items with empty summary/content arrays, leaving the
    // operator no explanation for a long reasoning phase. `summary` is the app-server's sticky
    // turn/start override (ReasoningSummary = auto|concise|detailed|none).
    // The installed app-server's UserInput enum has localImage but no generic document/file item.
    // Documents therefore become text inputs (or a path instruction when large); only actual images may
    // cross the protocol as localImage.
    const input = turnInput(text, attachments)
    const params: Record<string, unknown> = {
      threadId,
      input,
      summary: 'auto',
    }
    if (opts.model) params.model = opts.model
    if (opts.effort) params.effort = opts.effort
    if (opts.serviceTier) params.serviceTier = opts.serviceTier
    if (opts.approvalPolicy) params.approvalPolicy = opts.approvalPolicy
    if (opts.sandboxPolicy) params.sandboxPolicy = opts.sandboxPolicy
    await this.request('turn/start', params)
  }

  async interrupt(threadId: string): Promise<void> {
    // Codex 0.145 requires BOTH identifiers. Sending only threadId is accepted by our JSON-RPC transport
    // but rejected by app-server, which made the HTTP interrupt route return 500 while the command kept
    // running. Child agents are threads too, so this same method is the truthful targeted-stop primitive.
    const turnId = this.activeTurns.get(threadId)
    if (!turnId) throw new Error('no active Codex turn to interrupt')
    await this.request('turn/interrupt', { threadId, turnId })
  }

  // Append user input to the turn currently running on this thread. The app-server requires
  // expectedTurnId to match the live turn (else -32600), so we send the tracked active turn id.
  async steer(threadId: string, text: string, attachments: readonly AttachmentMeta[] = []): Promise<void> {
    const expectedTurnId = this.activeTurns.get(threadId)
    if (!expectedTurnId) throw new Error('no active Codex turn to steer')
    const input = turnInput(text, attachments)
    await this.request('turn/steer', {
      threadId,
      input,
      expectedTurnId,
    })
  }

  async readRateLimits(): Promise<unknown> {
    await this.ensureStarted()
    return this.request('account/rateLimits/read', {})
  }

  stop(): void {
    const child = this.child
    if (!child) return
    // Windows has no kill-on-parent-death, so killing `child` alone orphans everything under it —
    // the codex app-server's own children (MCP servers, exec'd tools), plus the cmd.exe→app-server
    // grandchild in the legacy `shell:true` fallback path above. `taskkill /T /F` terminates the whole
    // tree by PID (the same approach the desktop shell's kill_hub uses). Best-effort: fall back to
    // child.kill() if taskkill can't be spawned, and never throw out of a shutdown path.
    //
    // POSIX (macOS/Linux) gets a direct kill, deliberately: `child` shares the HUB's process group, so
    // hubctl's group-kill (killTree in hubctl.ts) sweeps it and all of its descendants on teardown.
    // Giving it its OWN group here would make a single-session stop() tidier but would remove it from
    // that sweep — the leak on quit is far worse than the one on session close.
    if (process.platform === 'win32' && child.pid !== undefined) {
      try {
        spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], {
          windowsHide: true,
          stdio: 'ignore',
        })
      } catch {
        child.kill()
      }
    } else {
      child.kill()
    }
  }
}
