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
where **every remote site already carries a usable `baseUrl`** — a `localhost:<port>` tunnel to that peer's
hub. The client merges each site's projects/sessions under `${siteId}:`-namespaced ids and badges the row
by machine. — CONFIRMED

That last point is the important one: **the routing primitive already exists and already works.** The hard
part the spec worried about — discovery and reaching a peer's hub — is done. What is missing is everything
on the *client* side that assumes there is exactly one hub.

**Not shipped, and the client is single-hub throughout:**

| Thing | State | Evidence |
|---|---|---|
| API base | ONE hardcoded base for every call | `api.ts:163` `HUB_HTTP = 'http://127.0.0.1:7777'` |
| Event stream | ONE WebSocket, ONE `lastSeq` cursor | `store.svelte.ts` `connect()` / `lastSeq` |
| Mutations | All go to the local hub regardless of the row's site | `api.send` etc. take a bare id |
| Remote history | Explicitly a no-op | `store.svelte.ts:1753` — marks pulled, returns |
| Accounts | Local hub only | `api.profiles()`; `scanProfiles(profilesDir)` at boot |

### 1.1 What a user hits today

Opening a remote chat works and shows the merged row. **Sending to it does not.** `api.send(sessionId, …)`
posts the namespaced id (`tcp:1234:abc-def`) to the *local* hub, which has never heard of that session, so
it 404s; the store re-queues the message and shows the hub's error text. — CONFIRMED (code path)

The user-visible result is a chat that looks ordinary and fails with **"unknown session"**. That is the
worst available wording: it reads as data loss rather than as "this chat lives on another machine". Fixing
the *message* is cheap and worth doing before any of the architecture below.

---

## 2. Accounts: the answer is affinity, not pooling

This was the open question — can accounts be shared across machines, or does each machine use its own?

**They cannot be pooled, and the reason is structural rather than a missing feature.**

- Profiles are per-hub: each hub scans its own `profilesDir` at boot (`index.ts`, `scanProfiles`), and the
  managed profile directory holds the *vendor CLI's own credential files*. — CONFIRMED
- Execution is pinned to the machine that has the files. Each hub owns its own drivers, worktrees, journal
  and SQLite; a remote project's turn runs on the remote hub, in the remote worktree. — CONFIRMED
  (`docs/mesh-unified-fleet.md` §4, and unchanged since)

So a remote project's turn **runs inside the remote hub's process**, and that process can only authenticate
with credentials on *its own* disk. There is no point at which the local machine's account could be used
without shipping credentials over the mesh — which we should not do: it copies long-lived vendor tokens
between machines, multiplies the blast radius of any one machine being compromised, and is squarely the
kind of thing vendor terms exist to discourage.

**Therefore: log in on both machines.** Each vendor allows a subscription on multiple devices, so
`claude-a` on the desktop and `claude-a` on the laptop are two logins of the same account, and each hub
holds its own. The app's job is not to pool them — it is to **stop pretending they are interchangeable**.

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

**Fix, and it is small:** make the fleet payload carry each site's profiles, and filter the picker by the
target row's `siteId`. The account list becomes a function of *where this chat will run*.

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
cursors, so the client keeps one connection. Do **not** merge peer events into the local journal — the
journal is this machine's durable record and polluting it with another machine's events would corrupt
replay, the `wseq` cursor logic, and every existing assumption about `seq` monotonicity.

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
