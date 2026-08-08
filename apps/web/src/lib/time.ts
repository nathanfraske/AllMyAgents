export function relativeTime(iso: string, nowMs = Date.now()): string {
  const then = new Date(iso).getTime()
  if (Number.isNaN(then)) return ''
  const s = Math.max(0, (nowMs - then) / 1000)
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

const MONTHS = ['Jan.', 'Feb.', 'Mar.', 'Apr.', 'May', 'Jun.', 'Jul.', 'Aug.', 'Sep.', 'Oct.', 'Nov.', 'Dec.']

function ordinal(day: number): string {
  const mod100 = day % 100
  if (mod100 >= 11 && mod100 <= 13) return `${day}th`
  if (day % 10 === 1) return `${day}st`
  if (day % 10 === 2) return `${day}nd`
  if (day % 10 === 3) return `${day}rd`
  return `${day}th`
}

function zonedPart(date: Date, part: Intl.DateTimeFormatPartTypes, timeZone?: string): string {
  return new Intl.DateTimeFormat('en-US', {
    ...(part === 'year' ? { year: 'numeric' as const } : {}),
    ...(part === 'month' ? { month: 'numeric' as const } : {}),
    ...(part === 'day' ? { day: 'numeric' as const } : {}),
    ...(timeZone ? { timeZone } : {}),
  }).formatToParts(date).find((item) => item.type === part)?.value ?? ''
}

/**
 * Usage reset label matching the useful Claude Code split: a live countdown when the reset is less
 * than 24 hours away, otherwise an absolute local date/time. `timeZone` exists for deterministic
 * tests; production intentionally uses the operator's local zone.
 */
export function resetLabel(unixSeconds?: number, nowMs = Date.now(), timeZone?: string): string {
  if (!unixSeconds || !Number.isFinite(unixSeconds)) return ''
  const target = new Date(unixSeconds * 1000)
  const remainingMs = target.getTime() - nowMs
  if (remainingMs <= 0) return 'Resets now'
  if (remainingMs < 24 * 60 * 60 * 1000) {
    const totalMinutes = Math.max(1, Math.floor(remainingMs / 60_000))
    const hours = Math.floor(totalMinutes / 60)
    const minutes = totalMinutes % 60
    return `Resets in ${hours > 0 ? `${hours} hr${minutes > 0 ? ` ${minutes} min` : ''}` : `${minutes} min`}`
  }

  const time = target.toLocaleTimeString('en-US', {
    hour: 'numeric',
    minute: '2-digit',
    ...(timeZone ? { timeZone } : {}),
  })
  const month = Number(zonedPart(target, 'month', timeZone))
  const day = Number(zonedPart(target, 'day', timeZone))
  const targetYear = zonedPart(target, 'year', timeZone)
  const currentYear = zonedPart(new Date(nowMs), 'year', timeZone)
  const year = targetYear && targetYear !== currentYear ? `, ${targetYear}` : ''
  return `Resets ${time} ${MONTHS[month - 1] ?? ''} ${ordinal(day)}${year}`
}
