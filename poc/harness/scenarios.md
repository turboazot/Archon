# Orchestrator Scenarios

These scenarios define the behavior the harness orchestrator should cover.

## 1. Ready Issue Starts Successfully

Input:

```text
open issue
archon:ready
exactly one archon-workflow:* label
no dependency blockers
capacity available
```

Action:

```text
remove archon:ready
add archon:in-progress
create orchestrator_runs row
start selected Archon workflow
comment with workflow run and branch when known
```

Owner: orchestrator.

## 2. Missing Workflow Label

Input:

```text
open issue
archon:ready
zero archon-workflow:* labels
```

Action:

```text
add archon:blocked
comment: Missing archon-workflow:* routing label
do not start workflow
```

Owner: orchestrator detects, user fixes labels.

## 3. Multiple Workflow Labels

Input:

```text
open issue
archon:ready
multiple archon-workflow:* labels
```

Action:

```text
add archon:blocked
comment: Ambiguous workflow routing labels
do not start workflow
```

Owner: orchestrator detects, user fixes labels.

## 4. Issue Blocked By Dependency

Input:

```text
open issue
archon:ready
blocked by one or more open GitHub issues
```

Action:

```text
leave unstarted
optionally add archon:blocked
comment only once with blocker list
```

Owner: GitHub stores dependencies, orchestrator enforces blockers, user or merged PR resolves blocker.

## 5. WIP Limit Reached

Input:

```text
eligible issue
max_parallel_workflows reached
```

Action:

```text
do not start
do not mark blocked unless the issue itself is blocked
include in status report as waiting for capacity
```

Owner: orchestrator.

## 6. Area Lock Conflict

Input:

```text
eligible issue
area locks enabled
issue shares area:* label with active run or open agent PR
```

Action:

```text
do not start
optionally add archon:blocked
comment only once with conflicting issue or PR
```

Owner: orchestrator.

## 7. Workflow Starts But No PR Appears

Input:

```text
workflow completes successfully
no PR is found for expected branch
```

Action:

```text
mark failed or blocked
add archon:blocked
comment with missing PR summary
preserve workflow logs/link if available
```

Owner: Archon workflow should normally open PR, orchestrator detects missing PR.

## 8. Workflow Fails

Input:

```text
workflow reaches failed terminal state
```

Action:

```text
remove archon:in-progress
add archon:blocked or archon:needs-fix
store last_error
comment with concise failure summary
```

Owner: Archon workflow provides failure, orchestrator records and labels.

## 9. PR Opened

Input:

```text
workflow opens PR
```

Action:

```text
store pr_number
store changed files when available
add archon:pr-open
comment issue with PR link
```

Owner: Archon workflow opens PR, orchestrator links and tracks.

## 10. Validation Passes

Input:

```text
PR exists
required checks pass
Archon review passes
```

Action:

```text
remove archon:in-progress
add archon:ready-for-review
comment with validation summary
```

Owner: Archon workflow or validation workflow produces evidence, orchestrator updates lifecycle.

## 11. Validation Fails

Input:

```text
PR exists
required checks fail
```

Action:

```text
add archon:needs-fix
schedule fix workflow if retry budget remains
comment with failing checks
```

Owner: GitHub reports checks, orchestrator schedules fix, Archon fix workflow implements fix.

## 12. Human Requests Changes

Input:

```text
PR review requests changes
```

Action:

```text
add archon:needs-fix
schedule fix workflow if retry budget remains
comment that review feedback is being handled
```

Owner: human reviews, orchestrator schedules fix, Archon fix workflow applies changes.

## 13. Human Approves PR

Input:

```text
PR approved
issue lacks archon:auto-merge
```

Action:

```text
leave ready for human merge
include in status report
```

Owner: human merges.

## 14. Auto-Merge Eligible PR

Input:

```text
issue has archon:auto-merge
PR is not draft
required checks pass
Archon review passes
no requested-changes review is unresolved
branch is mergeable
```

Action:

```text
merge PR
comment with merge result
mark issue done when GitHub reports merged/closed
```

Owner: user grants permission by label, orchestrator performs merge, GitHub executes merge.

## 15. PR Merged

Input:

```text
tracked PR is merged
```

Action:

```text
remove active lifecycle labels
add archon:done
status = done
ensure issue is closed or comment if it did not close
release area lock
```

Owner: GitHub reports merge, orchestrator finalizes bookkeeping.

## 16. PR Closed Without Merge

Input:

```text
tracked PR is closed unmerged
```

Action:

```text
remove archon:pr-open and archon:ready-for-review
add archon:blocked
status = blocked or abandoned
comment with closure summary
release area lock
```

Owner: human or GitHub closes PR, orchestrator reconciles.

## 17. Issue Closed Before Work Starts

Input:

```text
issue is closed
no active run
```

Action:

```text
do not start
mark stale local queued/blocked record done or abandoned
```

Owner: GitHub/user, orchestrator reconciles.

## 18. Issue Closed During Active Run

Input:

```text
issue is closed
workflow still running
```

Action:

```text
do not autonomously destroy work if cancellation semantics are uncertain
mark run as needing manual attention
comment or status report that issue closed while workflow active
```

Owner: user decides whether to cancel, orchestrator surfaces state.

## 19. Orchestrator Restarts

Input:

```text
process restarts with existing SQLite rows
```

Action:

```text
load non-terminal runs
sync GitHub issue/PR state
sync Archon workflow run state
repair labels if safe
continue scheduling
```

Owner: orchestrator.

## 20. Duplicate Start Prevented

Input:

```text
issue has active non-terminal orchestrator row
loop sees archon:ready again due to manual label change
```

Action:

```text
do not start second workflow
comment only if manual label change creates ambiguity
```

Owner: orchestrator.

## 21. GitHub API Or CLI Fails

Input:

```text
GitHub API or gh command fails temporarily
```

Action:

```text
retry with backoff where appropriate
preserve state
do not start new work based on incomplete data
surface degraded status
```

Owner: orchestrator.

## 22. Permissions Missing

Input:

```text
token cannot read issues, write labels/comments, read checks, or merge PRs
```

Action:

```text
fail fast for required permissions
disable only optional actions when safe
comment or log actionable setup error when possible
```

Owner: user fixes credentials, orchestrator reports.

## 23. Retry Budget Exhausted

Input:

```text
fix workflow has already been attempted max_fix_attempts times
```

Action:

```text
stop scheduling fixes
add archon:blocked
comment that retry budget is exhausted
include in status report
```

Owner: orchestrator, human decides next step.

## 24. Human Overrides Labels

Input:

```text
human removes archon:blocked or re-adds archon:ready
```

Action:

```text
respect current GitHub labels if no active run conflict exists
re-evaluate eligibility next loop
do not fight the user with repeated label rewrites
```

Owner: user, orchestrator reconciles.
