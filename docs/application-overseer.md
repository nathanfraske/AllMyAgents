# Application Overseer

The Application Overseer is a designated, projectless agent conversation for operating AllMyAgents itself.
It is not a project manager and it does not inherit authority merely because an account or ordinary chat is
set to Full access.

## Setup and entry point

Choose any available managed Claude or Codex account under **Settings / System / Application Overseer**.
Internal default vendor-home bindings used for history import cannot be selected. The hub creates the role,
forces Full access with an explicit operator override, persists the designated account in supervisor-readable
configuration, and exposes one persistent **Overseer** entry in the sidebar.

Changing the account creates a new role before revoking the old role so a failed transition cannot silently
remove the working Overseer. The role cannot be created through the ordinary session API.

## Control authority

The Overseer control tool can:

- inspect projects, chats, profiles, and pending approvals;
- create managed projects and projectless or project-bound chats;
- send messages to, stop, or reopen another chat;
- make an explicit operator permission-mode override on another chat;
- approve or decline another chat's pending request; and
- request restart through the normal restart supervisor.

Every operation is journaled. The hub checks the live role on every call and permits it only from a direct
operator-originated turn. Teammate/bus turns cannot exercise Overseer authority, an Overseer cannot approve
its own request, and it cannot stop or message itself through the control tool. This is an application-level
operator role, not an escape from the operating-system account that launched AllMyAgents.

## Database-offline boundary

The conversation, model execution, projects, approvals, and audit trail are journal-backed. If the journal
cannot open, no vendor agent—including the Overseer—can honestly reason or mutate that state.

To make that failure diagnosable, the desktop supervisor writes a separate bounded, token-free status file
covering startup, boot, live, restart, retry, recovery, offline, and stopping phases. It contains only coarse
health metadata, the designated profile ID, process/port facts, retry count, and a bounded error summary—no
credentials, prompts, session IDs, paths, commands, or journal contents. When the hub disconnects, the
desktop sidebar reads this status and a bounded desktop-log tail through a native command that does not
depend on the hub or its database.

This split gives the operator a dependable recovery view while keeping privileged model action fail-closed.
A future continuously reasoning Overseer during total journal failure would require a separately packaged,
authenticated vendor sidecar with its own minimal durable audit store; it must not be simulated by bypassing
journal preflight or by putting credentials in the supervisor status channel.
