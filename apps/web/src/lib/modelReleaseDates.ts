// Release metadata is NOT availability: these entries never add a model to an account's picker.
// Prefer an explicit provider release date. Neither discovery time, cache mtime, nor an API object's
// creation time proves a release. Unknown dates deliberately have no New badge.
// Sources verified 2026-09-23:
// https://developers.openai.com/api/docs/changelog (Jul 9, Sep 3, Sep 22)
// https://www.anthropic.com/news/claude-opus-5 (Jul 24)
// https://www.anthropic.com/news (Opus 5.5 announcement, Sep 22)
const RELEASES: Record<string, string> = {
  'gpt-5.6-sol': '2026-07-09',
  'gpt-5.6-terra': '2026-07-09',
  'gpt-5.6-luna': '2026-07-09',
  'gpt-6-astra': '2026-09-03',
  'gpt-6-sol': '2026-09-22',
  'gpt-6-luna': '2026-09-22',
  'claude-opus-5': '2026-07-24',
  'claude-opus-5-5': '2026-09-22',
}
export const MODEL_NEW_WINDOW_MS = 90 * 24 * 60 * 60_000
export function modelReleaseDate(slug: string, providerDate?: string): string | undefined {
  return providerDate && Number.isFinite(Date.parse(providerDate)) ? providerDate : RELEASES[slug]
}
export function isRecentlyReleased(slug: string, providerDate?: string, now = Date.now()): boolean {
  const date = modelReleaseDate(slug, providerDate)
  const age = date ? now - Date.parse(date) : NaN
  return age >= 0 && age < MODEL_NEW_WINDOW_MS
}
