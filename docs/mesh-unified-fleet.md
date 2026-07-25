# Unified-across-mesh fleet view — feasibility scope

Raised 2026-07-24 (see `docs/backlog.md` §"Fleet: cross-machine project view"). Question: how hard is it
to turn today's *per-site* experience (open one machine's hub at a time) into ONE pane that lists and opens
projects/sessions from every reachable fleet machine, each project badged by the machine its files live on,
with access routed local-vs-remote?

Confidence tags: **CONFIRMED-FROM-SOURCE** (read the code) / **INFERENCE** / **NEEDS-NODE-INFO**.

---

## TL;DR verdict

**Much easier than it looks, because the mesh already does the hard part.** The AllMyStuff node's control
socket — the exact socket `apps/hub/src/meshSite.ts` already speaks — already exposes a **fleet directory**
(`owned_roster`), **remote-hub discovery** (`site_remote_list`), and **port mapping that hands you a
`localhost:<port>` for any peer's hub** (`site_map`). No upstream node change is required for discovery or
routing. That single fact removes what would otherwise be the biggest risk.

Because each hub already fully owns execution on its own machine and the web client is already a **stateless
replay viewer over one WS + REST base**, "remote" collapses to a **client-side aggregation + id-namespacing**
problem, not a new backend/execution problem. The mesh gives you a loopback URL per remote hub; the client
already knows how to drive a hub at a loopback URL.

| Deliverable | Size | Why |
|---|---|---|
| **First cut** — unified read-only roster, projects/sessions badged by machine | **S–M** | New `/api/fleet` endpoint (reuses meshSite's socket client) + client merge/badge. With `requireToken` OFF (today's default) needs **zero** auth work. |
| **Full thing** — open + drive remote projects live | **L** | Multi-hub WS fan-out, per-site event cursors, route every mutation to the owning hub, and cross-site device-token distribution. |
| ~~Move work between machines~~ | out of scope | That's `relocate_session` (P4, file transfer). This feature ships work-in-place and drives it remotely. |

**Single biggest unknown:** cross-site **auth ergonomics when `requireToken` is ON** — client-side fan-out
(client must hold *every* remote hub's device token; today the only distribution is manual copy-paste of one
token) vs. a local-hub **server-side aggregator/proxy** (client authenticates only to its local hub, which
holds/relays remote tokens). That fork drives most of the full-thing architecture.

---

## 1. What the mesh already gives us — CONFIRMED-FROM-SOURCE

`apps/hub/src/meshSite.ts` today does exactly two things: reads this node's own exposed map (`site_exposed`)
and merges its own hub port into it (`site_set_exposed`) — `meshSite.ts:184`, `meshSite.ts:191`. Registration
makes `tcp:<port>` → label `"AllMyAgents"` visible to the fleet (`meshSite.ts:143`, `:152`, `:190`). Its
generic frame client `roundTrip(socketPath, cmd, args, timeoutMs)` (`meshSite.ts:64`) can call **any** node
command with the same framing — it just isn't pointed at the discovery commands yet. (`roundTrip` is
module-private; `MeshSite` is the export — a fleet module would add methods to `MeshSite` or re-use the ~40-line
client.)

**The node control socket already offers a full directory + routing API.** Read from the in-repo AllMyStuff
checkout at `data/worktrees/2506afc9/node/src/` (a co-owned repo the user develops; point-in-time snapshot):

| Command | file:line | Returns | Use for unified view |
|---|---|---|---|
| `owned_roster` | `node_control.rs:1668` → `mesh.rs:9667` | `{ in_fleet, members:[{device:NodeId, label, role}], … }` | **The fleet directory.** Every fleet machine with its node id + human label. |
| `site_remote_list {node}` | `node_control.rs:1635` → `mesh.rs:14526` | async event `allmystuff://node-sites`: `{from, services:[{id,name,port,scheme,loopback,process,title}], exposed:{"tcp:7777":"AllMyAgents"}}` | Discover **which** machines expose an AllMyAgents hub (look for `tcp:7777` in `exposed`). Reply is event-driven (fire-and-forget), gated owner/fleet. |
| `site_map {node, port}` | `node_control.rs:1612` → `mesh.rs:14618` | `{ localPort }` | **The routing primitive.** Binds a local loopback port that tunnels to that peer's hub; idempotent. `site_map(nodeX, 7777)` → `http://localhost:<localPort>` **is** machine X's hub. |
| `site_mappings` | `node_control.rs:1625` → `mesh.rs:14517` | `[{node, port, localPort}]` | List/rehydrate active remote-hub mappings. |
| `site_unmap {node, port}` | `node_control.rs:1620` | ok | Tear a mapping down. |

Supporting facts:
- **The tunnel carries WebSocket end-to-end.** `sites.rs:24-30` — "a **transparent layer-4 tunnel** — raw
  bytes, no HTTP parsing, no idle timeout … a connection the client upgrades to a **WebSocket** … keeps
  flowing both ways for its whole life." So a remote hub's `/ws` replay stream works through the map unchanged.
- **Host side re-checks its own allow-list per connection** (`sites.rs:12-16`) and connects to
  `127.0.0.1:<port>` — so a mapped connection to a machine *not* running a hub simply fails; probing
  `/api/health` after `site_map` is the reliable "is there a hub here" signal. — INFERENCE (from the two halves).
- **Same-owner devices need no grant** (DESIGN.md D13.1, `:81`); the exposed set *is* the port allow-list.

**Bottom line for Q1:** the node offers a directory (`owned_roster`) AND per-peer hub discovery
(`site_remote_list`) AND the loopback-mapping routing primitive (`site_map`). **No node-side change is
required.** The hub simply needs to start *calling* these commands (it already holds the socket connection).

---

## 2. How the viewer loads a hub today — the real work is here

**The client is hard-wired to ONE hub origin.** — CONFIRMED-FROM-SOURCE
- `apps/web/src/lib/api.ts:147-148`: a single `HUB_HTTP` / `HUB_WS` base (empty in dev → Vite proxy; loopback
  in Tauri). Every `jget`/`jpost` prepends that one base (`api.ts:170`, `:176`), and one `hubToken`
  (`api.ts:153`) is attached to all of them (`authHeaders`, `api.ts:165`).
- `apps/web/src/lib/store.svelte.ts`: one store, one WebSocket (`connect()`, `store.svelte.ts:776`), one
  global replay cursor `lastSeq` (`:218`, guard at `:828`), one `sessions` map keyed by **raw** session id
  (`:201`), one `projects` array (`:199`). `apply()` (`:827`) assumes every event comes from that single hub.

**What aggregating N hubs takes:**
1. **A directory the client can fetch.** New hub route `GET /api/fleet` that calls `owned_roster` + (per member)
   `site_map(node, 7777)` + a health probe, returning `[{siteId, label, local:bool, baseUrl, token?}]`. This
   is the one genuinely new hub-side piece, and it's small (reuses meshSite's socket client).
2. **Per-site REST/WS bases.** `api.ts` grows from two constants to a per-site base; each call targets the
   owning site's `baseUrl` (+ that site's token). The `api` object's methods take/close-over a site base.
3. **A merge layer with id namespacing.** Session ids and project ids are `crypto.randomUUID()` per hub
   (`projects.ts:37`; sessions similarly), so cross-hub *collisions* are effectively impossible — but you
   still need a `siteId` prefix (`siteId:sessionId`) so the store knows **which hub to route a mutation to**
   and **which machine a row belongs to**. Namespacing is for routing + attribution, not just collision safety.
4. **First cut can skip the WS fan-out entirely** — poll each site's `/api/projects` + `/api/sessions` for a
   read-only badged roster. Live multi-hub WS is the full-thing lift (§5).

The sidebar itself is nearly ready: `Sidebar.svelte` already groups sessions by project
(`Sidebar.svelte:140-160`) and renders per-group badges — adding a machine badge/lane is additive, not a
rewrite. The store even self-describes as "a multi-pane/**fleet** hub" (`index.ts:36`).

---

## 3. The hub API a peer consumes, + machine tagging — CONFIRMED-FROM-SOURCE

A remote hub already exposes everything an aggregator needs, over the same `/api` + `/ws` a mapped loopback
port carries (`server.ts`): `GET /api/projects` (`:389`), `GET /api/sessions` (`:521`), `GET /api/approvals`
(`:525`), `GET /api/usage` (`:529`), `GET /api/mesh` (`:540`, returns `siteId`/`label`/`peerUrl`), the `/ws`
replay stream (`:684`), and all the drive routes (`POST /api/sessions` spawn `:563`, `/input|interrupt|stop`
`:646`, `/steer` `:605`, `/mode` `:593`, approvals `:587`, rename `:613`). So a remote project can be **driven**
with the identical calls the local client already makes — just aimed at that hub's base URL.

**Machine tag on a `Project`.** `Project` is `{id, name, path, createdAt}` — `types.ts:9`; `ProjectStore`'s
table has no machine column (`projects.ts:14`). Two ways to get the tag:
- **Aggregator-injected (preferred, no migration).** The `/api/fleet` merge stamps each project/session with
  the `siteId`/`label` of the hub that served it. Origin is inherently "the hub that returned the row," so the
  server needs to store nothing new. — INFERENCE (clean and migration-free).
- **Persisted (only if the hub itself must record origin).** Add optional `siteId?`/`machineLabel?` to `Project`
  (and the `projects` table) — additive, in the style of the existing optional `SessionRecord` fields
  (`imported?`, `transcriptPath?`, `types.ts:42-49`). Not needed for the first cut.

Note the **local file path is meaningful only on its own machine** — `ProjectStore.create` validates
`fs.existsSync(path)` locally (`projects.ts:33`) and sessions run in that hub's own worktrees
(`sessions.ts`, `data/worktrees/<id>`). This is *why* access must route to the owning hub rather than ship
files — which is exactly the intended model.

---

## 4. Access routing — the architecture already fits — INFERENCE (from confirmed pieces)

Intended model (backlog `:73`): the agent **runs on the machine where the files are local**; the operator
drives it remotely over the mesh; no file-shipping. Today's architecture matches this almost exactly:
- Each machine runs its own hub owning its own drivers (`SessionManager` + Claude Agent SDK / Codex
  app-server children), worktrees, journal, and SQLite (`index.ts:33-64`). Execution is **already** pinned to
  the machine with the files.
- **"Open a remote project" = point the existing client at that hub's mapped loopback port.** `site_map(node,
  7777)` → `localhost:<localPort>`; the client opens `/api/*` + `/ws` there; the remote hub's own drivers do
  the work in its own worktree. No proxying of file contents, no new execution path — the mesh tunnel + the
  remote hub's existing API **is** the routing.
- **The remote hub's security guards pass through the tunnel unchanged.** The node connects to the remote
  hub's `127.0.0.1:7777` (`sites.rs:12`), so `hostAllowed`/`originAllowed` (`server.ts:188`, `:200`) see a
  loopback Host/Origin — the client's `Host: localhost:<localPort>` has its port stripped and matches
  (`server.ts:203`). So with `requireToken` OFF (today's default), a mapped remote hub is reachable with **no
  auth work at all**. — CONFIRMED-FROM-SOURCE (guards) + INFERENCE (byte-path).

So the choice is **not** "proxy vs. aggregate execution" — execution stays remote either way. The choice is
purely **where the fan-out lives**:
- **(A) Client-side fan-out** — client opens N loopback bases directly. Simplest when `requireToken` is off;
  when on, the client must hold each hub's token.
- **(B) Local-hub server-side aggregator** — the local hub proxies/merges remote `/api` + `/ws`; the client
  authenticates only to its local hub. Better token story, more hub code (a WS multiplexer).

---

## 5. Hard parts, ranked, + effort

Ranked hardest → easiest for the **full** (drive-remote) version:

1. **Cross-site auth under `requireToken`** — *hardest / the fork.* Each hub mints its **own** per-install
   device token (`deviceToken.ts:16`, `data/device-token.txt`) and enforces it on every `/api` + `/ws`
   (`server.ts:313`, `:679`). Pairing today is one manual token paste (`store.svelte.ts:346` `pair()`;
   `SettingsModal.svelte:344-350`). A fleet of N hubs under enforcement needs N tokens distributed, or a
   server-side aggregator that holds them. **There is no fleet-wide token distribution/trust story today.**
   (With enforcement OFF — the default — this cost is zero, which is what makes the first cut S–M.)
2. **Multi-hub client aggregation / live WS fan-out** — *L.* The store is single-hub throughout: one `lastSeq`
   (`store.svelte.ts:218`), one WS (`:776`), one-in-flight roster refetch (`:660`), `suppressNextUserMsg`
   keyed by bare id (`:214`). Going live-multi means **per-site seq cursors**, one WS per site, and every
   `apply()` branch tagged by origin site.
3. **Routing every mutation to the owning hub** — *M.* `spawn/send/steer/stop/mode/approve/rename/delete`
   must target the base URL + token of the row's `siteId` instead of the single global base. Mechanical but
   touches every call site in `api.ts` + `store.svelte.ts`.
4. **Mapping/reconnection churn** — *M.* `site_map` local ports can change across node restarts; the client
   must rehydrate from `site_mappings` and re-point. Remote-hub **blue-green restarts** (`restartController`)
   keep port 7777 stable on the remote side, but a dropped tunnel needs a remap + WS reconnect (the client
   already reconnects with `since=lastSeq`, `store.svelte.ts:797` — that generalizes per site).
5. **Discovery robustness** — *S.* `site_remote_list` is event-driven and owner/fleet-gated; the pragmatic
   MVP is `owned_roster` → `site_map(node,7777)` for each member → probe `/api/health` (`server.ts:302`) →
   keep the ones that answer. No node change.
6. **Id namespacing + machine tag** — *S.* `siteId:` prefix in the merge layer; badge in the sidebar
   (`Sidebar.svelte` groups already exist). Aggregator-injected tag needs no schema migration (§3).

**First-cut path (S–M), concretely:** add `GET /api/fleet` (node `owned_roster` + `site_map` + health probe,
reusing `meshSite.ts` framing) → client fetches it, then per site fetches `/api/projects` + `/api/sessions`,
merges with a `siteId` tag and a machine badge, read-only. With `requireToken` off it needs no auth work and
no WS changes. This alone answers "one pane listing every machine's projects, badged by machine."

**Biggest single unknown:** the §5.1 auth fork (client-holds-N-tokens vs. server-side aggregator) — it's the
one decision that reshapes the whole full-thing architecture, and the only piece with no existing mechanism.

---

## Appendix — key citations

- Hub mesh client (own registration only today): `apps/hub/src/meshSite.ts:64` (`roundTrip`), `:175`
  (`register`), `:184`/`:191` (`site_exposed`/`site_set_exposed`), `:143`/`:152` (label + `tcp:<port>` siteId).
- Mesh wiring / auto-expose: `apps/hub/src/index.ts:108-144`.
- Node directory + routing API (in-repo AllMyStuff checkout): `data/worktrees/2506afc9/node/src/node_control.rs`
  — `owned_roster` `:1668`, `site_remote_list` `:1635`, `site_map` `:1612`, `site_mappings` `:1625`,
  `site_unmap` `:1620`; impls in `.../node/src/mesh.rs` — `fleet_roster_value` `:9667`, `site_map` `:14618`,
  `site_remote_list` `:14526`, `handle_site_control` `:14549`; tunnel transport doc `.../node/src/sites.rs:24-30`.
- Single-hub client: `apps/web/src/lib/api.ts:147-167`; `apps/web/src/lib/store.svelte.ts:197-201`, `:776`, `:827`.
- Hub API surface a peer consumes: `apps/hub/src/server.ts:389/521/525/529/540/563/587/593/605/613/646/684`.
- Machine tag surface: `apps/hub/src/types.ts:9`; `apps/hub/src/projects.ts:14/33/37`.
- Auth/token: `apps/hub/src/deviceToken.ts:16/31`; `server.ts:294/313/679`; guards `server.ts:188/200/203`;
  pairing UI `apps/web/src/lib/SettingsModal.svelte:327-361`, `store.svelte.ts:346`.
- Prior intent: `docs/backlog.md:64-74`; DESIGN.md D13.1 `:75-83`; mesh panel plan `docs/next-sequence.md:221-225`.
