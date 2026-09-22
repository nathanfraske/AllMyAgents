# Worktree attribution and notification bounds

The September 22 incident produced 2,487 distinct pair/path notices across 612 paths.
It was not an exact-key deduplication bypass: each worker inherited the same accepted
history ahead of protected main, and comparing every branch against main incorrectly
counted that shared history as concurrent writing.

Concurrent-write detection now compares each actual HEAD pair against its shared
ancestry. Uncommitted edits and unique branch commits remain writers; shared ancestry
alone is not. Independent same-path edits are still detected even when their final
blobs happen to match. Main, original session bases, and the mandatory stale-base
integration gate are not rewritten. The activity dashboard's file/commit lists remain
relative to the configured integration base; those lists are not exclusive ownership
claims. Current branch names are read from Git rather than stale session metadata.

New warnings are grouped by writer/pair and recipient, with at most eight sample paths
and an explicit total. At most 16 batches are emitted per poll; deferred new batches
remain eligible on subsequent polls. All current risks remain in project activity.
Unchanged risks do not re-notify; a complete observation of resolution clears dedupe
so reappearance warns again. Failed observations do not count as resolution. Git
subprocesses have a 15-second bound, and pair comparisons cache at most 64 HEAD pairs.

Regression fixtures use four disposable worktrees, 612 shared accepted paths with
protected main unchanged, disjoint current edits, a task-branch transition, genuine
overlap, independent identical-blob commits, 60-path warning fan-out, resolution and
reappearance. No live workers, branches, or grants are changed to test this repair.
