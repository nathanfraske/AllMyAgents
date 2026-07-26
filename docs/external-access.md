# External access — device lock + an outward-facing MCP endpoint

Two requirements captured from the operator, both about reaching the hub from **outside the machine it
runs on**. Spec only; nothing here is implemented.

Related: `docs/vendor-remote-control.md` (driving *vendor* remote-control features from a phone — a
different thing, and largely declined), `docs/cross-machine-bridges.md` (hub-to-hub within the owner's own
fleet), `docs/mesh-unified-fleet.md` (the mesh underneath both).

---

## A. Phone app: biometric / passcode lock

**Requirement.** The phone client must be locked behind Face ID / Touch ID / device passcode before its
contents are visible, the way the Codex mobile app behaves.

**Why it is its own control, and not covered by anything we already have.** Device-token pairing answers
"may this *device* talk to the hub". It says nothing about who is holding the device thirty seconds after
it is left on a desk. Once paired, the phone is a live console onto every project on every machine —
transcripts, file contents, and the ability to start full-access turns. A lock screen is the only control
that addresses a borrowed or lost handset, and it is the cheapest meaningful one available.

**Shape.**

- Gate on **app foreground**, not just cold launch — an app resumed from the background must re-prompt.
  Cold-launch-only is the common mistake and it protects almost nothing.
- Platform primitives: `LocalAuthentication` / `LAContext` on iOS, `BiometricPrompt` on Android. Both fall
  back to the device passcode automatically, which is what we want — biometrics failing must not lock the
  owner out, and must not silently downgrade to no gate either.
- **The gate is local.** It protects the screen, not the transport. It must never be treated as
  authenticating the *request*: the device token still does that. Conflating the two would mean a
  jailbroken or rooted device bypassing the lock also bypasses hub auth.
- Setting: on by default, with an explicit off switch (this is the owner's device and the owner's call),
  and a short configurable grace period so switching apps for five seconds is not punished.

**Effort: S**, and independent of everything else here. Worth doing whenever the phone client is built,
not deferred behind the MCP work below.

---

## B. Outward-facing MCP endpoint

**Requirement.** An agent running *outside* this fleet — Claude or Codex in their own hosted apps,
connected remotely — should be able to reach in and use the hub's capabilities the way an agent running
*inside* the hub already does.

### B.1 A large part of this already exists

The agent tool surface was built transport-agnostic from the start, and that is most of the work already
done. `agentToolCore.ts` holds the tool *bodies*; two transports already wrap them:

- **Claude** — an in-process SDK MCP server.
- **Codex** — a real stdio MCP server (`agentMcpServer.ts`, JSON-RPC 2.0 over line-delimited stdio),
  spawned as a child and bridged back to the hub (`agentBridge.ts`).

Tools exposed today: `list_agents`, `send_message`, `read_messages`, `peek_agent`, `memory_write`,
`memory_search`, `memory_read`, `practice_write`, `practice_edit`, `practice_read`, `practice_list`
(plus `restart_hub` behind its own gate). — CONFIRMED

**So a third transport is an addition, not a rewrite.** That is the good news, and it is worth saying
before the rest of this section, which is mostly caution.

### B.2 The invariant that must not bend

From `agentToolCore.ts:38`, describing the services every tool body receives:

> Every method takes the CALLER's identity/sessionId (**supplied by the hub, never by the caller**).

Both existing transports satisfy this structurally: a Claude tool call arrives inside a session the hub
started, and the Codex stdio child is spawned per session with its cwd as the correlating signal. In both
cases identity is something the hub *knows*, not something the caller *says*.

**An external caller has no session, so it has no identity by that mechanism.** This is the single most
important design constraint here: identity must be **minted by the hub from the authenticated credential**
and attached server-side. The endpoint must never accept a `sessionId` or agent identity as a request
parameter. Get this wrong and an external caller can impersonate any local agent — reading its bus
messages, writing practices attributed to it, and doing so with that agent's scopes.

Concretely: one credential ⇒ one synthetic identity (e.g. `external:<client-id>`), with its own account
scope, appearing in `list_agents` as what it is. An external caller should be visible to the fleet as an
outsider, not disguised as a teammate.

### B.3 What is actually missing

| Piece | State | Note |
|---|---|---|
| Tool bodies | **exist** | transport-agnostic already |
| stdio transport | **exists** | `agentMcpServer.ts` |
| HTTP transport | missing | remote MCP is streamable HTTP; stdio cannot cross a network |
| Auth the vendors speak | missing | see B.4 |
| Reachability | missing | hub binds loopback only |
| External identity minting | missing | B.2 |
| Per-credential capability scope | missing | B.5 |

### B.4 Auth is the hard part, and our device token will not do

Hosted MCP clients (Claude's connectors, ChatGPT's) expect **OAuth 2.1 with dynamic client registration**
against the MCP server — not a bearer token pasted into a config. The hub's device token is a single
shared secret with no rotation, no scopes, no per-client identity and no revocation beyond regenerating it
and re-pairing every device. It is fine for "my own devices on my own mesh"; it is not what a hosted
client will negotiate with, and it is not what should sit in front of an endpoint reachable from outside.

This is genuinely the bulk of the work: an authorization server, client registration, token issue and
revoke, and per-client scopes.

**Note on reachability.** The hub binds `127.0.0.1` and its origin/host guards assume loopback. Exposure
therefore needs either a mesh tunnel terminating somewhere publicly reachable, or a relay. A vendor-hosted
relay is the obvious shortcut and is the thing this project has consistently declined
(`docs/vendor-remote-control.md`), so assume self-hosted termination and price it in.

### B.5 Scope: this is where "not worried about compromise" stops applying

The operator's position — that a compromise of the AllMyStuff fleet means far bigger problems than the
agents — is **reasonable and correct for the fleet**, and it is why `docs/cross-machine-bridges.md`
recommends letting the local hub hold peer tokens without hand-wringing. Everything inside the fleet is
one owner's machines.

**This feature is the one place that reasoning does not carry over**, and the distinction is not caution
for its own sake: it changes what the design has to do. An outward-facing MCP endpoint is, by definition,
reachable by something that is *not* inside the fleet. Its blast radius is not "someone already owns my
machines" — it is "an endpoint on the internet, and whatever reaches it, gets the fleet". The premise that
made the internal decisions easy is exactly the premise this feature removes.

Practically, that means the tool set exposed externally should be a **deliberate allow-list rather than
everything the internal agents get**, and the split should follow the same logic the hub's existing
approval policy already uses: reads and messaging are ordinary; anything that reshapes future behaviour or
widens capability is not.

- Reasonable to expose: `list_agents`, `read_messages`, `send_message`, `peek_agent`, `memory_search`,
  `memory_read`.
- Should not be exposed, at least not by default: `practice_write` / `practice_edit` (they change how every
  future teammate behaves, fleet-wide), `restart_hub`, and anything that spawns or drives a session.
- `memory_write` is the judgement call. It is persistent and it is read back into future agents' context,
  which makes it a slow-acting influence channel rather than a plain write.

Same Danger-Zone philosophy as everywhere else in this app: safe defaults with switches, no un-disable-able
rules. The default should simply not be "everything".

### B.6 Effort and sequencing

**L overall**, dominated by B.4 rather than by MCP itself.

1. **HTTP transport + external identity + the allow-list, as ONE slice (M).** Streamable HTTP alongside
   stdio, still loopback-bound and device-token-gated.

   These were originally listed as two steps, which was wrong: the transport cannot ship without them.
   Every tool body demands a caller identity (B.2), so the moment an HTTP request can reach a tool, the
   question "whose identity does this run as" is already answered — either deliberately, or by whatever
   placeholder got typed first. There is no coherent intermediate state where the transport exists and
   identity does not, and a placeholder identity is precisely the bug B.2 exists to prevent. Same for the
   allow-list: a transport that reaches every tool and is narrowed afterwards has an interval where it
   does not.

2. **OAuth + exposure (L).** B.4. The real work, and the only part that makes the endpoint reachable from
   outside.

Slice 1 is worth building regardless of whether slice 2 ever happens — a *local* external process (a CLI,
a script, another agent on the same machine) can use it as-is, and it is what makes slice 2 safe rather
than merely possible.

---

## Open questions

- Does either vendor's hosted client accept a **self-signed or private-CA** endpoint, or is a publicly
  trusted certificate mandatory? Not checked, and it constrains the exposure design.
- Is there an existing MCP **revocation** story a hosted client honours, or does revocation mean rotating
  the authorization server's signing key and forcing re-consent everywhere?
- Should an external caller appear in `list_agents` at all? Argued yes above (visible as an outsider), but
  it does mean an external identity can be *messaged* by internal agents, which is a channel in its own
  right and may want its own switch.
