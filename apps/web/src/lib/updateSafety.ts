type UpdateSession = { record: { status: string } }

export function countLiveUpdateTurns(sessions: Record<string, UpdateSession>): number {
  return Object.values(sessions).filter(
    (session) => session.record.status === 'active' || session.record.status === 'starting'
  ).length
}

export function updateInstallBlock(liveTurns: number, allowLiveTurns: boolean): string | null {
  if (liveTurns === 0 || allowLiveTurns) return null
  return `${liveTurns} ${liveTurns === 1 ? 'chat is' : 'chats are'} mid-turn. Choose Update when idle, or explicitly choose Update anyway.`
}
