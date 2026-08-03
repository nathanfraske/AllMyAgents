# Managed workspace size safeguards

AllMyAgents monitors the private scratch workspace or Git worktree assigned to each chat. It deliberately
does not scan an arbitrary project directory merely because a chat happens to work there: those folders may
be operator-owned, shared, or much larger than the agent checkout lifecycle.

## Triggers and delivery

The hub checks up to four managed checkouts every two minutes, prioritizing active and least-recently
measured sessions. A warning begins at any of these boundaries:

| Condition | Warning | Critical |
| --- | ---: | ---: |
| Total apparent checkout size | 4 GiB | 12 GiB |
| Recognized build/dependency output | 2 GiB | 8 GiB |
| Free space on the containing volume | 10 GiB | 3 GiB |

Low-disk warnings require the checkout itself to occupy at least 512 MiB. This avoids blaming a tiny chat
workspace for unrelated pressure on the volume. Once a warning exists, the measured byte count must fall
below 75% of its threshold before it clears; low disk similarly needs extra recovered headroom. An unchanged
condition reminds the agent at most once every 24 hours, while escalation to critical notifies immediately.

The same measured state has three surfaces:

- An active turn receives a hub-authored steer at the next tool boundary. It does not create operator
  provenance or change the turn's permissions.
- The hub writes the warning into managed `AGENTS.md` or `CLAUDE.md` instructions, so an idle, starting, or
  temporarily unreachable agent sees it on a later turn.
- The operator sees a disk badge in the session row and a detailed warning above that chat.

Warnings tell the agent to remove only outputs it can regenerate and to report what it cleaned. The hub
never automatically removes an active checkout, source, uncommitted changes, or required deliverables.
The separate orphan-worktree reaper remains conservative and requires Git proof that an unowned checkout
contains neither uncommitted nor unmerged work.

## Scan safety and interpretation

Each scan is capped at 250,000 entries, eight seconds, and the critical total-size boundary. It yields to the
event loop while walking and never follows a symbolic link or Windows junction. This prevents a checkout
from making the monitor traverse an unrelated directory or monopolize the hub. Recognized artifact groups
include `node_modules`, Rust `target`, common `dist`/`build`/`out` directories, coverage output, framework
caches, Python caches and virtual environments, and compiled `bin`/`obj` directories.

A scan stopped by one of those bounds is explicitly a lower bound. A lower-bound result may raise or
escalate a warning, but it is never accepted as proof that an existing warning cleared. Read failures are
counted without exposing filesystem paths to the agent. If the filesystem cannot report free space (some
network or WSL providers cannot), size and artifact checks still work.

Windows-hosted WSL worktrees are measured through their canonical UNC projection. The agent's message keeps
the same distro-native execution context; the monitor does not invoke commands inside the distribution or
transfer workspace contents.
