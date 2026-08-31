# Durable GitHub CI monitor

AllMyAgents can keep a bounded, hub-owned watch on one GitHub pull request or one exact Actions workflow
run and wake the watching chat when CI fails or completes successfully. The watch is persisted in `hub.db`;
it consumes no model tokens while waiting and survives an ordinary hub restart.

## Agent workflow

1. The operator grants the project or exact chat the narrow `workflow_runs` GitHub automation capability.
2. After dispatching CI, the manager, worker, or application Overseer calls `monitor_ci` with
   `operation: "watch"`, an exact `owner/repository`, and exactly one of `pull_request` or
   `workflow_run_id`. `wake_on` defaults to both `failure` and `success`.
3. The hub uses the already-authenticated GitHub CLI; it never copies a GitHub token into a session,
   journal event, command line, or monitor row.
4. At a requested terminal boundary, the hub inserts one exactly-once, attention-required bus message.
   That starts a fresh bus-origin turn even for a high-context idle manager, while retaining the ordinary
   permission clamp. A CI result is evidence, not operator authority.

`monitor_ci` also supports `list` and `cancel`. A chat can hold at most eight active watches and the hub
at most 128. Terminal records are retained for 30 days with a 1,000-row cap. Polling defaults to 30 seconds,
backs off to five minutes on GitHub/credential/network errors, and never overlaps itself. The interval can
be changed with `ALLMYAGENTS_GITHUB_CI_POLL_MS` within the enforced 10-second to five-minute range.

## Terminal semantics

- A failing, timed-out, cancelled, action-required, startup-failure, or stale check wakes immediately as
  failure when failure wakeups are enabled.
- Pull-request success requires every observed check run and commit status to be terminal-successful and
  the complete observed set to remain identical across two polls. This avoids declaring success in the
  short gap before a later job is created.
- An exact workflow run uses GitHub's terminal run conclusion; successful, neutral, and skipped are the
  non-failing terminal conclusions.
- An empty check set is pending, never success. Pull requests with more than the bounded 100 check runs
  report monitor degradation rather than silently ignoring the tail.
- Poll errors remain durable and retry with exponential backoff. They do not masquerade as CI failures.

The monitor is intentionally narrower than a general scheduler. It cannot run arbitrary commands, change
repositories, rerun workflows, merge, push, or answer approvals. Those operations continue to require their
own independently granted GitHub capability.
