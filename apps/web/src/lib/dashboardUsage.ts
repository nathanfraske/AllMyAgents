/**
 * Mix percentage for a day in the dashboard heatmap.
 *
 * The busiest day in the visible window is always 100%; every other non-empty day is scaled
 * linearly against it. A small floor keeps low-activity days visible without turning the calendar
 * back into the old binary "worked / did not work" display.
 */
export function heatmapMixPercent(turns: number, busiestDayTurns: number): number {
  if (!Number.isFinite(turns) || turns <= 0 || !Number.isFinite(busiestDayTurns) || busiestDayTurns <= 0) return 6
  const relative = Math.min(1, turns / busiestDayTurns)
  return Math.round((18 + relative * 82) * 10) / 10
}

export function heatmapColor(turns: number, busiestDayTurns: number): string {
  return `color-mix(in srgb, var(--accent) ${heatmapMixPercent(turns, busiestDayTurns)}%, var(--surface-2))`
}

export function heatmapRelativePercent(turns: number, busiestDayTurns: number): number {
  if (!Number.isFinite(turns) || turns <= 0 || !Number.isFinite(busiestDayTurns) || busiestDayTurns <= 0) return 0
  return Math.round(Math.min(1, turns / busiestDayTurns) * 100)
}
