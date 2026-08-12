import type { ThreadItem } from './store.svelte'

// --- Tool-call blurbs ---------------------------------------------------------------------------
//
// A tool row used to show only the tool NAME, so forty `Read`s were forty identical rows that cost
// attention without paying it back. This derives the tool's SUBJECT — the file it read, the command
// it ran, the pattern it searched — as one pure, testable line.
//
// Single authority on purpose: codexGroup.ts's group summary calls the SAME function for its "current
// step" label, so the collapsed group and the expanded rows never disagree, and item 3 does not become
// a second renderer competing with item 2's grouping.

export interface ToolBlurb {
  /** One line, already trimmed/truncated — safe to render without wrapping. */
  label: string
  /** The full, untruncated value for a `title` (hover) — e.g. the absolute path or the whole command. */
  title?: string
}

/** Last path segment, tolerant of both separators and a trailing slash. `''` stays `''`. */
export function basename(p: string): string {
  const s = p.replace(/[\\/]+$/, '')
  const i = Math.max(s.lastIndexOf('/'), s.lastIndexOf('\\'))
  return i >= 0 ? s.slice(i + 1) : s
}

/**
 * Truncate the MIDDLE, keeping both ends. For a path the end is the part that identifies it (the
 * basename), so lopping the end — what CSS ellipsis does — is exactly wrong; this keeps it.
 */
export function truncateMiddle(s: string, max = 48): string {
  if (s.length <= max) return s
  const keep = max - 1 // room for the ellipsis
  const head = Math.ceil(keep / 2)
  const tail = Math.floor(keep / 2)
  return s.slice(0, head) + '…' + s.slice(s.length - tail)
}

/** Collapse whitespace and clip the END — for commands/queries, where the front carries the meaning. */
function clipEnd(s: string, max = 80): string {
  const one = s.replace(/\s+/g, ' ').trim()
  return one.length > max ? one.slice(0, max - 1) + '…' : one
}

function str(v: unknown): string | undefined {
  return typeof v === 'string' && v.trim().length > 0 ? v : undefined
}

/** A Codex/Claude command can be a string, an argv array, or `{ command }` — normalize to one line. */
function commandText(input: unknown): string | undefined {
  if (typeof input === 'string') return str(input)
  if (Array.isArray(input)) return str(input.map(String).join(' '))
  if (input && typeof input === 'object') {
    const c = (input as { command?: unknown }).command
    if (typeof c === 'string') return str(c)
    if (Array.isArray(c)) return str(c.map(String).join(' '))
  }
  return undefined
}

function unquote(s: string): string {
  const m = /^(['"])([\s\S]*)\1$/.exec(s.trim())
  return m ? (m[2] as string) : s
}

/**
 * Strip a leading shell-runner wrapper so the blurb shows the ACTUAL command, not the launcher.
 *
 * Codex on Windows runs every command as `"C:\…\powershell.exe" -Command <cmd>`, so an un-stripped
 * blurb is 60 characters of powershell path with the real command (`ls`, `cat package.json`) truncated
 * off the end — the launcher, not the thing it ran. Also handles cmd.exe /c and sh/bash -c. The full
 * wrapped command is still available on hover (the caller keeps it as the title).
 */
export function stripShellWrapper(cmd: string): string {
  const patterns = [
    /^\s*"?[^"]*\b(?:powershell|pwsh)(?:\.exe)?"?\s+(?:-\w+(?:\s+\S+)?\s+)*-Command\s+([\s\S]+)$/i,
    /^\s*"?[^"]*\bcmd(?:\.exe)?"?\s+\/[cC]\s+([\s\S]+)$/i,
    /^\s*"?[^"]*\b(?:ba)?sh"?\s+-[a-z]*c\s+([\s\S]+)$/i,
  ]
  for (const re of patterns) {
    const m = re.exec(cmd)
    if (m) return unquote((m[1] as string).trim())
  }
  return cmd
}

function firstString(obj: Record<string, unknown> | undefined, keys: string[]): string | undefined {
  if (!obj) return undefined
  for (const k of keys) {
    const v = str(obj[k])
    if (v) return v
  }
  return undefined
}

/**
 * Derive a subject line for a tool call. Returns `undefined` for anything it does not recognise — the
 * caller then shows the plain tool name, so an unknown/new vendor tool degrades gracefully rather than
 * rendering "undefined" or an empty blurb (this repo has been bitten by assuming payload shapes).
 */
export function toolBlurb(item: ThreadItem): ToolBlurb | undefined {
  if (item.kind !== 'tool') return undefined
  const name = item.toolName ?? ''
  const input = item.toolInput

  // --- Codex items (store sets toolInput to the command value / the file-change item) ---
  if (name === 'command') {
    const raw = commandText(input)
    if (!raw) return undefined
    return { label: clipEnd(stripShellWrapper(raw)), title: raw } // clean label, full command on hover
  }
  if (name === 'fileChange') {
    const p = firstString(objOf(input), ['path', 'file', 'filename'])
    return p ? { label: `edit ${truncateMiddle(basename(p))}`, title: p } : undefined
  }
  // Codex prefixes AllMyAgents calls with `mcp:`. Keep collapsed step summaries readable instead of
  // treating a protocol identifier as a useful subject line.
  if (name.startsWith('mcp:')) {
    const activity = agentActivity(item)
    return activity ? { label: activity.label, title: name } : undefined
  }

  const obj = objOf(input)

  // --- Claude file tools. `notebook_path` is a distinct, load-bearing spelling (see writeScope.ts,
  //     which had a containment bug from exactly this inconsistency) — do NOT collapse it to file_path.
  const filePath = firstString(obj, ['file_path', 'notebook_path'])
  if (filePath) return { label: truncateMiddle(basename(filePath)), title: filePath }

  // --- Glob / Grep ---
  const pattern = firstString(obj, ['pattern'])
  if (pattern) {
    const where = firstString(obj, ['path'])
    return where
      ? { label: `${clipEnd(pattern, 48)} in ${basename(where)}`, title: `${pattern}  ·  ${where}` }
      : { label: clipEnd(pattern, 64), title: pattern }
  }

  // --- Bash: prefer the human-written description; the full command is the more useful hover. ---
  const command = firstString(obj, ['command'])
  if (command !== undefined || name.toLowerCase() === 'bash') {
    const desc = firstString(obj, ['description'])
    const text = desc ?? command
    return text ? { label: clipEnd(text), title: command ?? desc } : undefined
  }

  // --- Other single-subject tools (WebFetch/WebSearch/Task/…) ---
  const url = firstString(obj, ['url'])
  if (url) return { label: clipEnd(url, 64), title: url }
  const query = firstString(obj, ['query'])
  if (query) return { label: clipEnd(query, 64), title: query }
  const description = firstString(obj, ['description'])
  if (description) return { label: clipEnd(description), title: description }

  return undefined
}

function objOf(input: unknown): Record<string, unknown> | undefined {
  return input && typeof input === 'object' && !Array.isArray(input) ? (input as Record<string, unknown>) : undefined
}

// --- Hub agent-tool activity (bus messages, peeks, memory/practice) ------------------------------
//
// The hub-provided MCP tools are teammate/agent activity, not ordinary file/shell tools — the operator
// wants them legible and colour-distinct, with a direction arrow (↑ sent, ↓ received) that reads WITHOUT
// colour. Claude names them `mcp__allmyagents__<tool>`; Codex surfaces them as `mcp:<tool>` — handle both.

export type AgentDir = 'out' | 'in' | 'none'
export interface AgentActivity {
  label: string
  dir: AgentDir
  /** The SINGLE counterparty's session id, when there is one (direct send, peek) — the caller resolves it
   *  to a vendor logo. Absent for a broadcast or a bulk poll, which have no one vendor to show. */
  counterpartyId?: string
}

const AGENT_TOOL_PREFIXES = ['mcp__allmyagents__', 'mcp:']

/** The current provider-neutral AllMyAgents surface, kept explicit so tests cover every inline row. */
export const ALLMYAGENTS_TOOL_NAMES = [
  'list_agents', 'send_message', 'read_messages', 'peek_agent', 'child_status', 'manage_team',
  'manage_child', 'spawn_agent', 'set_child_authority', 'decide_child_approval', 'assign_child_task',
  'start_run', 'inspect_runs', 'control_run', 'query_team', 'memory_write', 'memory_search',
  'memory_read', 'practice_write', 'practice_edit', 'practice_read', 'practice_list', 'browser_navigate',
  'browser_read_page', 'browser_click', 'browser_tabs', 'browser_open_tab', 'browser_switch_tab',
  'browser_close_tab', 'browser_download', 'browser_download_read', 'browser_screenshot', 'browser_status',
  'remote_list_devices', 'remote_ping', 'remote_inspect_environment', 'remote_inspect_git',
  'remote_prepare_project_location', 'remote_list_files', 'remote_read_file', 'remote_create_directory',
  'remote_write_file', 'remote_exec', 'overseer_control',
] as const

/** The bare hub tool name (e.g. 'send_message') if this is a hub agent tool, else null. */
export function agentToolName(toolName: string | undefined): string | null {
  if (!toolName) return null
  for (const p of AGENT_TOOL_PREFIXES) if (toolName.startsWith(p)) return toolName.slice(p.length)
  return null
}

function shortId(id: string | undefined): string {
  return id ? id.slice(0, 8) : 'unknown'
}

function compactSubject(value: string | undefined, max = 48): string | undefined {
  return value ? clipEnd(value, max) : undefined
}

function quoted(value: string | undefined): string {
  return value ? ` “${compactSubject(value)}”` : ''
}

function readableUrl(value: string | undefined): string | undefined {
  if (!value) return undefined
  try {
    return new URL(value).hostname || value
  } catch {
    return compactSubject(value, 56)
  }
}

function targetLabel(
  obj: Record<string, unknown> | undefined,
  resolveName: ((id: string) => string | undefined) | undefined,
  keys = ['child_session', 'target_session', 'session_id'],
): string | undefined {
  const id = firstString(obj, keys)
  return id ? resolveName?.(id) || shortId(id) : undefined
}

function withTarget(label: string, target: string | undefined): string {
  return target ? `${label} ${target}` : label
}

const OVERSEER_ACTIONS: Record<string, string> = {
  status: 'checked hub status',
  guide: 'looked up app guidance',
  ui_catalog: 'checked available app controls',
  highlight_ui: 'highlighted an app control',
  failure_context: 'investigated an agent failure',
  get_operating_mode: 'checked the operating mode',
  set_operating_mode: 'updated the operating mode',
  create_project: 'created a project',
  create_chat: 'created a chat',
  send_chat: 'sent a message to a chat',
  stop_chat: 'stopped a chat',
  reopen_chat: 'reopened a chat',
  approve: 'decided an approval',
  set_mode: 'updated a chat access mode',
  set_session_config: 'updated chat settings',
  configure_manager: 'configured a project manager',
  reassign_manager_account: 'moved a manager to another account',
  list_team_presets: 'listed team presets',
  save_team_preset: 'saved a team preset',
  delete_team_preset: 'deleted a team preset',
  launch_team: 'launched a project team',
  remote_catalog: 'checked remote devices',
  set_remote_grants: 'updated remote-device access',
  list_overseer_peers: 'listed peer Overseers',
  send_overseer_message: 'messaged a peer Overseer',
  start_account_login: 'started an account sign-in',
  github_repositories: 'listed GitHub repositories',
  clone_github_repository: 'started cloning a GitHub repository',
  github_clone_status: 'checked repository clone progress',
  get_github_automation_policy: 'checked GitHub automation access',
  configure_github_automation: 'updated GitHub automation access',
  issue_pairing_code: 'created a device pairing code',
  list_testbed_targets: 'listed testbed targets',
  inspect_testbed_target: 'inspected a testbed target',
  deploy_testbed_node: 'deployed a testbed node',
  get_elevation_policy: 'checked elevated-command access',
  configure_elevation: 'updated elevated-command access',
  analyze_elevated_command: 'analyzed an elevated command',
  run_elevated_command: 'ran an elevated command',
  restart_hub: 'restarted the hub',
}

const GENERIC_PAST: Record<string, string> = {
  analyze: 'analyzed', approve: 'approved', cancel: 'cancelled', check: 'checked', click: 'clicked',
  close: 'closed', configure: 'configured', control: 'controlled', create: 'created', decide: 'decided',
  delete: 'deleted', deploy: 'deployed', download: 'downloaded', edit: 'edited', get: 'checked',
  inspect: 'inspected', issue: 'created', launch: 'launched', list: 'listed', manage: 'managed',
  navigate: 'opened', open: 'opened', peek: 'peeked at', prepare: 'prepared', query: 'checked',
  read: 'read', reassign: 'reassigned', restart: 'restarted', run: 'ran', save: 'saved', search: 'searched',
  send: 'sent', set: 'updated', spawn: 'started', start: 'started', status: 'checked', stop: 'stopped',
  switch: 'switched', update: 'updated', write: 'wrote',
}

/** Future custom tools stay readable before a bespoke, argument-aware phrase is added. */
export function readableAgentToolFallback(tool: string): string {
  const words = tool
    .replace(/^mcp(?::|__allmyagents__)/, '')
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .split(/[_\-.\s]+/)
    .filter(Boolean)
    .map((word) => word.toLowerCase())
  if (words.length === 0) return 'used an app tool'
  const first = words.shift() as string
  const verb = GENERIC_PAST[first] ?? 'used'
  const subject = (GENERIC_PAST[first] ? words : [first, ...words]).join(' ')
  return subject ? `${verb} ${subject}` : verb
}

/** How many messages a read_messages result returned. Empty inbox is 'No messages.' (hub), so a poll
 *  that got nothing yields 0 — and MUST NOT render as an inbound message (a poll is not a receipt). */
export function readMessagesCount(result: string | undefined): number {
  if (!result) return 0
  const matches = result.match(/^\[\d+\] from /gm)
  return matches ? matches.length : 0
}

/**
 * Classify a hub agent-tool call. `resolveName` maps a teammate session id to a display name (its
 * scientist name, or the operator's rename); a short id is the rare fallback. Returns undefined for a hub
 * tool with no nice phrasing (falls back to the generic tool card) — never invents awkward text.
 */
export function agentActivity(
  item: ThreadItem,
  resolveName?: (id: string) => string | undefined
): AgentActivity | undefined {
  if (item.kind !== 'tool') return undefined
  const tool = agentToolName(item.toolName)
  if (!tool) return undefined
  const raw = objOf(item.toolInput)
  // Claude supplies the MCP arguments as the tool input itself. Codex's real `mcpToolCall` item wraps
  // them in `arguments`; unwrap that envelope so direct send/peek rows reach the same name resolver.
  const obj = objOf(raw?.arguments ?? raw)
  const nameOf = (id: string | undefined): string => (id ? resolveName?.(id) || shortId(id) : 'a teammate')
  const target = targetLabel(obj, resolveName)
  const path = firstString(obj, ['path'])
  const operation = firstString(obj, ['operation'])
  switch (tool) {
    case 'send_message': {
      const to = firstString(obj, ['to_session'])
      // Broadcast has no single recipient → no counterpartyId (and so no logo). Direct carries the id.
      return to
        ? { label: `message sent to ${nameOf(to)}`, dir: 'out', counterpartyId: to }
        : { label: 'broadcast to your project', dir: 'out' }
    }
    case 'read_messages': {
      const n = readMessagesCount(item.toolResult)
      // A poll that got nothing is not a receipt — no inbound arrow (dir 'none'). A bulk poll has no
      // single sender, so no counterpartyId either.
      return n > 0
        ? { label: `${n} message${n === 1 ? '' : 's'} received`, dir: 'in' }
        : { label: 'checked for messages', dir: 'none' }
    }
    case 'peek_agent': {
      const to = firstString(obj, ['to_session'])
      return { label: `peeked at ${nameOf(to)}`, dir: 'none', counterpartyId: to }
    }
    case 'list_agents':
      return { label: 'listed teammates', dir: 'none' }
    case 'child_status':
      return { label: 'checked child-agent status', dir: 'none' }
    case 'manage_team': {
      const team = firstString(obj, ['name', 'team_id'])
      const label = operation === 'list'
        ? 'reviewed project teams'
        : operation === 'create'
          ? `created team${quoted(team)}`
          : operation === 'activate'
            ? `switched to team${quoted(team)}`
            : operation === 'rename'
              ? `renamed a team${quoted(team)}`
              : 'managed project teams'
      return { label, dir: 'none' }
    }
    case 'manage_child': {
      const label = operation === 'resume' || operation === 'reactivate'
        ? 'resumed'
        : operation === 'set_role'
          ? 'updated the role for'
          : operation === 'retire'
            ? 'archived'
            : 'managed'
      return { label: withTarget(label, target), dir: 'none', counterpartyId: firstString(obj, ['child_session']) }
    }
    case 'spawn_agent':
      return { label: `started a new worker${quoted(firstString(obj, ['role', 'agent_type']))}`, dir: 'none' }
    case 'set_child_authority':
      return {
        label: target ? `updated access for ${target}` : 'updated child-agent access',
        dir: 'none',
        counterpartyId: firstString(obj, ['child_session']),
      }
    case 'decide_child_approval':
      return { label: obj?.approve === false ? 'declined a child approval' : 'approved a child request', dir: 'none' }
    case 'assign_child_task':
      return {
        label: `${target ? `assigned a task to ${target}` : 'assigned a child task'}${quoted(firstString(obj, ['title']))}`,
        dir: 'out',
        counterpartyId: firstString(obj, ['child_session']),
      }
    case 'start_run': {
      const kind = firstString(obj, ['kind']) ?? 'durable'
      const remote = firstString(obj, ['remote_device_id']) ? ' on a remote device' : ''
      return { label: `started a ${kind} run${remote}`, dir: 'none' }
    }
    case 'inspect_runs': {
      const run = firstString(obj, ['run_id'])
      return { label: run ? `checked run ${shortId(run)}` : 'checked durable runs', dir: 'none' }
    }
    case 'control_run':
      return { label: `cancelled run ${shortId(firstString(obj, ['run_id']))}`, dir: 'none' }
    case 'query_team': {
      const entities = Array.isArray(obj?.entities)
        ? obj.entities.filter((value): value is string => typeof value === 'string')
        : []
      return { label: entities.length ? `checked team ${entities.join(', ')}` : 'checked team activity', dir: 'none' }
    }
    case 'memory_write':
      return { label: `wrote a memory${quoted(firstString(obj, ['title']))}`, dir: 'none' }
    case 'memory_search':
      return { label: `searched memory${quoted(firstString(obj, ['query']))}`, dir: 'none' }
    case 'memory_read':
      return { label: 'read a memory', dir: 'none' }
    case 'practice_write':
      return { label: `wrote a practice${quoted(firstString(obj, ['title']))}`, dir: 'none' }
    case 'practice_edit':
      return { label: `updated a practice${quoted(firstString(obj, ['title']))}`, dir: 'none' }
    case 'practice_read':
      return { label: 'read a practice', dir: 'none' }
    case 'practice_list':
      return { label: 'listed practices', dir: 'none' }
    case 'browser_navigate':
      return { label: `opened ${readableUrl(firstString(obj, ['url'])) ?? 'a web page'}`, dir: 'none' }
    case 'browser_read_page':
      return { label: 'read the current web page', dir: 'none' }
    case 'browser_click':
      return { label: `clicked${quoted(firstString(obj, ['target_summary']))}`, dir: 'none' }
    case 'browser_tabs':
      return { label: 'listed browser tabs', dir: 'none' }
    case 'browser_open_tab':
      return { label: `opened a tab for ${readableUrl(firstString(obj, ['url'])) ?? 'a web page'}`, dir: 'none' }
    case 'browser_switch_tab':
      return { label: 'switched browser tabs', dir: 'none' }
    case 'browser_close_tab':
      return { label: 'closed a browser tab', dir: 'none' }
    case 'browser_download':
      return { label: `downloaded${quoted(firstString(obj, ['target_summary']))}`, dir: 'none' }
    case 'browser_download_read':
      return { label: 'read a browser download', dir: 'none' }
    case 'browser_screenshot':
      return { label: 'captured a browser screenshot', dir: 'none' }
    case 'browser_status':
      return { label: 'checked browser status', dir: 'none' }
    case 'remote_list_devices':
      return { label: 'listed available remote devices', dir: 'none' }
    case 'remote_ping':
      return { label: 'measured a remote connection', dir: 'none' }
    case 'remote_inspect_environment':
      return { label: 'inspected a remote environment', dir: 'none' }
    case 'remote_inspect_git':
      return { label: 'inspected a remote checkout', dir: 'none' }
    case 'remote_prepare_project_location':
      return { label: 'prepared a remote project checkout', dir: 'none' }
    case 'remote_list_files':
      return { label: path ? `listed remote files in ${truncateMiddle(path)}` : 'listed remote files', dir: 'none' }
    case 'remote_read_file':
      return { label: path ? `read remote file ${truncateMiddle(basename(path))}` : 'read a remote file', dir: 'none' }
    case 'remote_create_directory':
      return { label: path ? `created remote folder ${truncateMiddle(basename(path))}` : 'created a remote folder', dir: 'none' }
    case 'remote_write_file':
      return { label: path ? `wrote remote file ${truncateMiddle(basename(path))}` : 'wrote a remote file', dir: 'none' }
    // Keep command bytes in the explicitly expanded audit detail. Inline arguments can contain tokens,
    // passwords, or one-use authorization codes and must not leak into the collapsed conversation UI.
    case 'remote_exec':
      return { label: 'ran a remote command', dir: 'none' }
    case 'overseer_control': {
      let label = operation ? OVERSEER_ACTIONS[operation] : undefined
      if (!label) label = operation ? readableAgentToolFallback(operation) : 'used Overseer controls'
      if (operation === 'create_project') label += quoted(firstString(obj, ['name']))
      return { label, dir: 'none', counterpartyId: firstString(obj, ['session_id']) }
    }
    default:
      // Exact tool name and arguments remain in the expandable audit detail; inline text stays human.
      return { label: readableAgentToolFallback(tool), dir: 'none' }
  }
}

// --- Inbound bus frame (teammate messages the hub pushes into a turn as prompt text) -------------
export interface BusFrame {
  count: number
  senders: string[]
  /** The 8-char sender ids from the frame headers, positionally aligned with `senders`. When there is
   *  exactly one, the caller can show that sender's vendor logo; with several, no single vendor applies. */
  senderIds: string[]
}

/**
 * Detect + parse the hub's teammate-message frame if `text` IS one (see sessions.ts frameBusMessages):
 *   <<ALLMYAGENTS-BUS — N message(s) from teammate agents, delivered by the hub>>
 *   [1] from <label> (agent <id>) — <subject>
 *   …
 *   <<END ALLMYAGENTS-BUS>>
 *   <trust paragraph>
 * Returns the count + sender display names so it renders as an inbound blurb with the wall collapsed; null
 * for an ordinary message (so normal user turns are byte-for-byte untouched).
 */
export function parseBusFrame(text: string | undefined): BusFrame | null {
  if (!text) return null
  const head = /<<ALLMYAGENTS-BUS — (\d+) message\(s\)/.exec(text)
  if (!head || !text.includes('<<END ALLMYAGENTS-BUS>>')) return null
  const senders: string[] = []
  const senderIds: string[] = []
  const re = /^\[\d+\] from (.+?) \(agent ([0-9a-f]+)\)/gm
  let m: RegExpExecArray | null
  while ((m = re.exec(text)) !== null) {
    senders.push((m[1] as string).trim())
    senderIds.push(m[2] as string)
  }
  return { count: Number(head[1]) || 0, senders, senderIds }
}
