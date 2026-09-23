# Account model discovery

The chat model menu and Settings → Accounts expose **Refresh models**. Refresh updates the catalog,
not the selected model or the conversation. Remote chat refreshes use the owning hub's paired token.
Authenticated profile reads trigger stale-while-revalidate discovery every six hours for signed-in,
available managed accounts; no provider work is on the boot/readiness path. Failures retain the last
successful list in that hub process and back off five minutes. At most two catalogs refresh globally,
with one in-flight read per account. Explicit refresh bypasses the six-hour TTL, but not concurrency or
account admission/ownership. An empty provider list stays empty rather than enabling fallback models.

## Provider boundaries

- Codex: paged `model/list` through the existing account-owned app-server. Up to 200 models / 10 pages,
  15 seconds per RPC and a 30-second discovery deadline. No inference, cache deletion, process restart,
  or made-up force-refresh flag. Codex 0.153.3 uses `OnlineIfUncached`; the provider can satisfy a refresh
  from its still-fresh five-minute cache. API-key and subscription accounts may advertise different catalogs.
  The local Codex cache remains the initial offline fallback when no live catalog is held yet.
- Claude: `Query.supportedModels()` on an ephemeral SDK metadata connection with empty streaming input,
  no tools and no persisted session. Close on success, failure, or the 30-second deadline. Resolve
  provider aliases to canonical model ids where advertised. Existing Claude thinking controls remain
  distinct from Codex reasoning effort and service-tier semantics. Discovery is what the installed SDK
  advertises, not a guarantee that an inference call will be admitted by the provider.
- A worker transport read is bounded by its existing 45-second relay deadline; the UI waits at most
  50 seconds. Failed or late responses do not erase a good list or cross an account-identity change.
  A newer model requiring a newer vendor runtime can still require an app/runtime update.

## Truthful New badges

“New” means a **known release date less than 90 days ago**, excluding future dates. Refreshing, signing
in, or discovering a model for the first time does not restart this clock. The badge tooltip shows the
date; an open menu rechecks the clock every minute. Explicit release-date metadata is preferred. For
providers that omit it, `modelReleaseDates.ts` contains a small, sourced release-date registry, separate
from availability. Unknown dates get no badge; newly discovered models still appear immediately.
The registry does not offer any model to an account that did not advertise it.

Protocol references checked against the installed versions:

- [Codex model/list documentation](https://learn.chatgpt.com/docs/app-server)
- [Codex 0.153.3 discovery implementation](https://github.com/openai/codex/blob/rust-v0.153.3/codex-rs/app-server/src/models.rs)
- [Codex 0.153.3 cache TTL and refresh strategy](https://github.com/openai/codex/blob/rust-v0.153.3/codex-rs/models-manager/src/manager.rs)
- Claude Agent SDK 0.3.220 `sdk.d.ts`: `Query.supportedModels`, `ModelInfo`, `Query.close`.
- [OpenAI release dates](https://developers.openai.com/api/docs/changelog)
- [Claude Opus 5 release](https://www.anthropic.com/news/claude-opus-5) and
  [Anthropic announcements](https://www.anthropic.com/news).

Tests use disposable profiles, mocked provider control methods, and real authenticated HTTP routes;
they never consume a model turn or modify a live account.
