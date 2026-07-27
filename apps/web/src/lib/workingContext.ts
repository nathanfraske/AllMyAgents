type SessionLocation = {
  projectId?: string
  cwd: string
  worktree?: string
}

type ProjectLocation = {
  id: string
  name: string
  path: string
}

export interface WorkingContext {
  projectName: string
  workingDirectory: string
}

/**
 * Shortens a path from the uninformative end. Windows paths in particular tend
 * to share a long user/app-data prefix, while the repo or worktree at the tail
 * is what distinguishes one agent from another.
 */
export function truncatePathTail(value: string, maxChars: number): string {
  const budget = Math.max(0, Math.floor(maxChars))
  if (budget === 0) return ''
  if (value.length <= budget) return value
  if (budget === 1) return '…'
  return `…${value.slice(-(budget - 1))}`
}

/**
 * Resolve the two pieces of location identity the chat header needs. Drafts
 * have no cwd until their first message materializes them, so their selected
 * project's directory is the honest preview of where they will start.
 */
export function resolveWorkingContext(
  session: SessionLocation,
  projects: readonly ProjectLocation[]
): WorkingContext {
  const project = session.projectId
    ? projects.find((candidate) => candidate.id === session.projectId)
    : undefined

  return {
    projectName: project?.name ?? (session.projectId || 'Unfiled'),
    workingDirectory: session.worktree || session.cwd || project?.path || 'Working directory not set',
  }
}
