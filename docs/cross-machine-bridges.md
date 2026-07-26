# Cross-machine project bridges + account/site affinity — implementation plan

Follow-on to `docs/mesh-unified-fleet.md`, which specced the unified fleet view and shipped its **first
cut** (read-only roster, projects/sessions badged by machine). This document covers what is actually true
in the code *now*, the account question that has not been specced anywhere, and how to get from here to
"open and drive a remote project".

Everything marked CONFIRMED was read out of the source at the cited location. Everything marked INFERENCE
follows from confirmed pieces but has not been executed end-to-end against two real machines.

---

## 1. Where we actually are

**Shipped (the S–M first cut).** `buildFleet` (`apps/hub/src/fleet.ts:58`) asks the node for the owned
roster, calls `site_map(device, 7777)` for each member, probes `/api/health`, and returns a `FleetSite[]`
carrying a `localhost:<port>` `baseUrl` per site. The client merges each site's projects/sessions under
`${siteId}:`-namespaced ids and badges the row by machine. — CONFIRMED

### 1.0 That baseUrl is NOT usable by the client, and this changes the architecture

An earlier draft of this document said "every remote site already carries a usable `baseUrl`" and
concluded the routing primitive was done. **That is wrong, and the error is load-bearing.**

`site_map` is called by *the hub's* node and opens a loopback port **on the hub machine**
(`meshSite.ts:282`, `fleet.ts:74`). The client then fetches that `http://localhost:<port>` **directly**
from the browser (`api.ts:185`, `store.svelte.ts:836`). That works only while the browser and the
mapping-owning node are the same machine.

**On a phone, `localhost` is the phone.** So the shipped direct-pull fleet view cannot work remotely at
all — which matters because remote-from-phone is the stated goal of the whole feature. The `baseUrl` is
usable *by the local hub process*, not by whatever is rendering the UI.

Consequence: the local-hub gateway (§3) is **a topology requirement, not an ergonomics preference**. There
is no version of client-side fan-out that works from a phone, at any level of token convenience, because
the addresses are meaningless off-machine. — CONFIRMED by review

The rest of §1 still holds: everything client-side assumes exactly one hub.

**Not shipped, and the client is single-hub throughout:**

| Thing | State | Evidence |
|---|---|---|
| API base | ONE hardcoded base for every call | `api.ts:163` `HUB_HTTP = 'http://127.0.0.1:7777'` |
| Event stream | ONE WebSocket, ONE `lastSeq` cursor | `store.svelte.ts` `connect()` / `lastSeq` |
| Mutations | All go to the local hub regardless of the row's site | `api.send` etc. take a bare id |
| Remote history | Explicitly a no-op | `store.svelte.ts:1753` — marks pulled, returns |
| Accounts | Local hub only | `api.profiles()`; `scanProfiles(profilesDir)` at boot |

### 1.1 What a user hits today — worse than a bad error message

Opening a remote chat works and shows the merged row. Sending to it does not, and an earlier draft here
described the failure too kindly: it said the namespaced id reaches the local hub, 404s, and shows
"unknown session".

**The account-switch path does not fail that way.** Review found (`store.svelte.ts:716`, `:760`) that an
apparently-empty remote chat **strips the namespaced id and creates a LOCAL draft under the remote project
id**, and a non-empty one **ports via a local `spawn` using the remote cwd/project metadata**. So instead
of an error, the operator can get a local chat pointed at another machine's paths. That is a data-integrity
problem, not a wording problem. — CONFIRMED by review

Every remote mutation therefore has to be **guarded, not merely re-worded**, and the guard list is longer
than "send": steer, model/settings, permission mode, allow-tool, compact, interrupt, stop, reopen, rename,
delete, approval decisions, and account switching. Current call sites are visibly unscoped
(`ThreadView.svelte:215`, `:318`, `:604`).

### 1.2 Reachable is not authorized

`/api/health` is public (`server.ts:380`), so a token-enforcing peer answers the probe and is shown
**online** — while its roster request returns 401. `jget` checks neither `res.ok` nor the payload shape
(`api.ts:189`), so the store then iterates something that is not an array (`store.svelte.ts:836`).

`reachable` and `authorized` must be distinct states, and upstream responses must be validated before use.
This is a live bug today, independent of everything else in this document. — CONFIRMED by review

---

## 2. Accounts: site affinity, with per-site credential binding

This was the open question — can accounts be shared across machines, or does each machine use its own?

An earlier draft answered "they cannot be pooled, and the reason is structural". **That was too absolute.**
The remote hub does launch the vendor under its own profile directory (`CLAUDE_CONFIG_DIR`,
`adapters/claude.ts:69`; `CODEX_HOME`, `adapters/codex.ts:265`), but a *synchronised* credential file would
also be on that machine's disk. So the architecture does not prove impossibility — it proves credentials
must be **provisioned per site**.

The right invariant:

> Execution and profiles have **site affinity**; every executing site must have usable credentials.
> A profile's identity is `(siteId, profileId)`, not `profileId`.

### 2.0 Can you just sync the credential files? Mostly no, and it depends on the vendor

Reviewed against the installed CLIs (Claude Code 2.1.218, Codex 0.145.0) and vendor source. — CONFIRMED by
review, credential *values* never printed.

| What you'd sync | Verdict |
|---|---|
| Whole `CLAUDE_CONFIG_DIR` / `CODEX_HOME` | **Trap.** Holds sessions, caches, plugins, logs and live SQLite/WAL alongside credentials. |
| Codex `auth.json` | **Trap** under ordinary async sync — see below. |
| Claude `.credentials.json` | **Viable with caveats**, and only on a genuinely shared store. |

**Codex is the harder case, and the rotation concern is real.** It persists a replacement refresh token
back into `auth.json`, explicitly treats `refresh_token_reused` as a *permanent* failure, and rewrites the
file by truncation with **no cross-process lock and no atomic temp-file rename**. It does reload storage
immediately before refreshing and skips the grant if another writer got there first — so if A's refreshed
file reaches B *before* B refreshes, it recovers correctly. But two copied access tokens share an expiry,
both machines refresh inside the same window, and eventual-consistency sync can lose that race. The loser
hits a permanent "sign in again", which the hub may surface merely as a failed turn.

**Claude is materially better.** 2.1.218 embeds `.oauth_refresh.lock`, sibling-token adoption and
refresh-race recovery, with changelog entries fixing exactly these concurrent-session races. Concurrent
Claude processes sharing *one physical store* is plausibly supported. That is **not** the same as
Syncthing/Drive-style replication, where each machine can take its own local lock before either lock
propagates and both then spend the same token.

Shared credentials stay viable only if *all* of these hold: sync the credential file only, never the
directory; one refresh writer (or only one machine active on that credential at a time); atomic, ordered,
fenced replication with no bidirectional last-writer-wins; new credentials reach every reader before an old
refresh token can be reused; readers reload after propagation and fail closed while stale; lock files are
never synced. At that point you have built a credential coordinator, not folder sync.

**So: log in per site remains the default — for operational reasons, not structural impossibility and not
security.** Two independent logins each hold their own token, so there is no rotation race at all. Static
API-key auth is a much easier case, having no rotating refresh lineage.

### 2.1 The latent bug this creates

`store.profiles` is populated from the local hub only, and `AccountPicker.svelte` renders that list
unconditionally. It is **not** only a new-chat control — it is mounted per open chat view
(`AccountPicker.svelte:8`) and is the account-swap affordance on an already-open one. So for a remote chat
the picker is live and offers **accounts that do not exist on the machine that would execute the turn**.
— CONFIRMED

Two visible consequences today:

- `current` resolves via `store.profiles.find(p => p.id === view.record.profileId)`
  (`AccountPicker.svelte:11`). A remote chat's `profileId` names a profile on the *remote* hub, which is
  usually absent locally, so `current` is `undefined` and the pill renders with no provider logo. Mildly
  broken-looking, and actually a useful tell that the data is wrong.
- Picking an account calls `store.useAccount(...)`, which routes to the local hub with a namespaced session
  id and fails the same way §1.1 does.

So the wrong-account offer is masked only by the *other* bug. It stops being masked the moment §4's routing
lands — at which point the request reaches the remote hub carrying a `profileId` that hub has never heard
of, and (since the fix in this release) comes back a clean `400 unknown profile` listing the profiles that
*do* exist. Better than a 500, still a thing we should never have offered.

**Fix — and "filter it by site" is not available yet.** `FleetSite` carries no profiles at all
(`fleet.ts:15`), so there is nothing to filter *against*; an earlier draft proposed filtering as if the
data were already there. — CONFIRMED by review

The honest first move is to **disable** the picker on a remote row and display the recorded remote
profile + site read-only, so the app states which machine's account is in play without pretending it can
change it. Fetching remote profiles (lazily, via the gateway in §3) turns that back into a real picker
later. Keep topology (`/api/fleet`) separate from profile data, so a slow or unauthorized peer degrades the
account list rather than the roster.

---

## 3. The fork the spec flagged, and a recommendation

`docs/mesh-unified-fleet.md` §5.1 named cross-site auth as "the fork … the one decision that reshapes the
whole full-thing architecture", and left it open:

- **(A) Client-side fan-out** — the client opens N loopback bases directly and holds N device tokens.
- **(B) Local-hub aggregator** — the client talks only to its own hub, which holds peer tokens and relays.

**Recommend (B), and the deciding argument is the phone.**

Remote-from-phone is a stated product goal (DESIGN.md D13.1). Under (A), the phone must hold *every* hub's
device token, and the only distribution mechanism that exists is manual copy-paste of one token
(`SettingsModal` pairing). That is N pastes per device, re-done whenever a hub regenerates its token —
untenable at even three machines, and it puts long-lived credentials for every machine onto the most
easily-lost device.

Under (B) a device pairs **once**, with its own local hub. Peer tokens live on the machines, never on the
phone. It also preserves the client's single-base assumption, which is baked in deeply enough
(`HUB_HTTP`, one WS, one `lastSeq`) that (A) means touching every call site anyway — so (A)'s "simpler"
reputation only holds while `requireToken` is off, which is exactly the configuration we should stop
assuming.

The cost of (B) is real and should be stated plainly: **the local hub becomes a proxy**, which means it can
see and relay everything on every peer. That is a genuine concentration of trust. It is defensible here
because all the machines are one owner's, which is the premise of the whole product — but it would not be
defensible in a multi-tenant setting, and the code should not drift toward that assumption.

---

## 4. Phased plan

Ordered so each phase is independently shippable and the early ones are cheap.

### Phase 1 — Stop lying (S)

No architecture. Make the current read-only reality legible.

1. **Remote rows say so.** Replace the "unknown session" failure with an explicit refusal at the store
   level: a remote chat is viewable, and sending offers *"This chat runs on `<machine>` — open it there,
   or wait for remote drive."* Guard the same way `pullHistory` already does (`store.svelte.ts:1753`).
2. **Filter the account picker by site** (§2.1), so the app never offers an account the executing machine
   does not have.
3. **Surface which machine's accounts apply** next to the picker when the row is remote.

Nothing here needs a node change, a token, or a new endpoint.

### Phase 2 — Route mutations (M)

Add `/api/site/:siteId/*` to the local hub: a thin reverse proxy that forwards to that site's `baseUrl`
(already computed by `buildFleet`) with the peer's token attached, and refuses any `siteId` not in the
current fleet.

Client: `api.ts` grows a `baseFor(siteId)` and every mutation takes the row's site. This is mechanical but
touches every call site — spec §5.3 rates it M and that still looks right.

At the end of Phase 2 you can **drive** a remote chat (send, stop, approve, change mode) but its output
still does not stream — you would be poll-refreshing. Worth shipping anyway: it is the difference between
"read-only" and "usable in a pinch".

### Phase 3 — Bridge the event streams (L)

The real work, and the reason the spec rated the full thing L.

The local hub subscribes to each peer's `/ws` and re-exposes a **multiplexed** stream with per-site
cursors, so the client keeps one connection.

**Do not merge peer events into the local journal** — but the reason given in an earlier draft was wrong,
and a wrong reason is worth correcting even when the conclusion survives. It claimed foreign events would
corrupt replay, the `wseq` cursor and `seq` monotonicity. In fact `seq` is SQLite `AUTOINCREMENT`, so
appended foreign rows stay monotonic (`journal.ts:38`); `wseq` is a worker-only column whose cursor query
ignores null-`wseq` rows entirely (`journal.ts:55`, `:85`); and client-visible `HubEvent` does not even
carry `wseq` (`api.ts:150`). With `(siteId, remoteSeq)` idempotency and namespaced sessions, replication
could in fact be implemented safely. — CONFIRMED by review

The real reasons not to: the local journal is the authoritative record of *this machine's* execution, so
foreign rows duplicate ownership, grow storage without bound, and create awkward stale-event semantics on
replay. Use a transient relay, or a separate federation-cursor/cache table.

Client: `lastSeq` becomes a per-site map, and `apply()` branches get tagged by origin site. Spec §5.2.

**Known sharp edge:** `site_map` local ports change across node restarts (§5.4), so the bridge needs to
rehydrate from `site_mappings` and re-point. The remote hub's own blue-green restarts are *not* a problem —
it keeps port 7777 on its side — but a dropped tunnel needs remap + reconnect. The existing
`since=lastSeq` reconnect generalises per site.

### Phase 4 — Token distribution (M), only if `requireToken` goes on

Under (B) the local hub needs each peer's token. Options, cheapest first: paste-once-per-peer stored
hub-side; or a mesh-authenticated exchange where already-paired peers hand tokens over the node socket. Not
worth designing until Phases 1–3 exist, since enforcement is off by default today.

---

## 5. What I could not verify

- **No two-machine test was run.** Everything about the tunnel byte-path is inference from the node source
  cited in `mesh-unified-fleet.md` plus our own guards. The first thing Phase 2 should do is prove a single
  authenticated REST call reaching a peer hub end-to-end, before any of the client refactor.
- **Whether `site_map` survives a peer hub's blue-green restart in practice.** Reasoned as safe (port 7777
  is stable on the remote side) but never observed.
- **Vendor multi-device login limits.** §2 assumes a subscription can be logged in on several machines,
  which is true for ordinary use, but no vendor's current terms were re-read while writing this.
- **Whether a *new chat* can be started directly into a remote project.** §2.1 confirms the account picker
  is live on an already-open remote chat; the new-chat-into-a-remote-project entry point was not traced. It
  may be inert for unrelated reasons. Either way the fix is the same filter.
