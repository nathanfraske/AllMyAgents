export function relativeTime(iso: string): string {
  const then = new Date(iso).getTime()
  if (Number.isNaN(then)) return ''
  const s = Math.max(0, (Date.now() - then) / 1000)
  if (s < 8) return 'just now'
  if (s < 60) return `${Math.floor(s)}s ago`
  const m = s / 60
  if (m < 60) return `${Math.floor(m)}m ago`
  const h = m / 60
  if (h < 24) return `${Math.floor(h)}h ago`
  const d = h / 24
  if (d < 30) return `${Math.floor(d)}d ago`
  return new Date(iso).toLocaleDateString()
}

export function resetIn(unixSeconds?: number): string {
  if (!unixSeconds) return ''
  const ms = unixSeconds * 1000 - Date.now()
  if (ms <= 0) return 'now'
  const h = Math.floor(ms / 3.6e6)
  const m = Math.floor((ms % 3.6e6) / 6e4)
  return h > 0 ? `${h}h ${m}m` : `${m}m`
}
