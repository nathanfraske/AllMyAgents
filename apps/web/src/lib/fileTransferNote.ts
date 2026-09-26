/** Shared live/history projection. A transfer has one stable row, never one row per buffer. */
export function fileTransferNote(kind: string, payload: unknown): { key: string; text: string } | undefined {
  if (!/^file-transfer\/(progress|completed|failed|cancelled|outcome_unknown)$/u.test(kind) || !payload || typeof payload !== 'object') return
  const p = payload as Record<string, unknown>
  if (typeof p.id !== 'string' || p.id.length > 128 || typeof p.size !== 'number' || typeof p.transferred !== 'number') return
  const state = kind.slice('file-transfer/'.length)
  const size = (Math.max(0, p.size) / 1048576).toFixed(1)
  const done = (Math.max(0, p.transferred) / 1048576).toFixed(1)
  const file = typeof p.localPath === 'string' ? p.localPath.slice(0, 240) : 'file'
  return { key: `file-transfer:${p.id}`, text: `${p.direction === 'upload' ? 'Upload' : 'Download'} ${file}: ${state === 'progress' ? 'transferring' : state.replaceAll('_', ' ')} — ${done}/${size} MiB${state === 'outcome_unknown' ? '; inspect receipt before retrying' : ''}${typeof p.error === 'string' ? ` — ${p.error.slice(0, 300)}` : ''}` }
}
