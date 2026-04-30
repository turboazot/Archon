# Orchestrator Logic

## Reader And Goal

This document is for the engineer implementing the harness orchestrator.

After reading it, they should be able to build the POC orchestrator without guessing which decisions belong to the orchestrator, which belong to Archon workflows, and which belong to GitHub or the user.

## System Boundary

The harness orchestrator is the durable supervisor for a single GitHub repository backlog. It does not implement product changes itself. It chooses eligible GitHub issues, starts Archon workflows, records durable state, reconciles GitHub state, and stops when coordination boundaries are reached.

Archon workflows remain the implementation workers. They read the issue, modify code in an isolated branch/worktree, validate the change, and open or update PRs.

GitHub remains the human-visible source of truth for backlog state, review state, dependencies, labels, PRs, CI, and merge history.

For the live E2E smoke path, the selected workflow is intentionally smaller than
the production issue-fixing workflow. The harness routes `archon-workflow:e2e-tiny`
to `archon-e2e-tiny`, a bash-only workflow that creates one scoped file, pushes
one `archon-e2e/<session>` branch, and opens one draft PR. This keeps the live
feedback loop fast while still exercising the orchestrator's real GitHub and
Archon boundaries.

The harness also has a merge-capable live route for dependency testing:
`archon-workflow:e2e-tiny-self-merge` maps to
`archon-e2e-tiny-self-merge`, which opens a non-draft PR, checks its own scope,
comments the self-review result, and merges only when the explicit
`ARCHON_E2E_ALLOW_MERGE=1` gate is present.

## Responsibilities

### User

- Creates and curates GitHub issues.
- Applies `archon:ready` when an issue is ready for automation.
- Applies exactly one `archon-workflow:*` routing label.
- Optionally applies `archon:auto-merge` when the issue is allowed to merge automatically after required checks pass.
- Defines issue dependencies using GitHub issue relationships.
- Reviews PRs that are not eligible for auto-merge.
- Decides whether `area:*` labels are used and whether they are scheduling locks or reporting labels.

### GitHub

- Stores issues, labels, comments, PRs, review state, CI/check state, merge state, and issue dependencies.
- Provides the durable collaboration surface humans can inspect and override.
- Closes issues through PR closing keywords when the PR body uses `Closes #123`, `Fixes #123`, or `Resolves #123`.

### Harness Orchestrator

- Polls or receives GitHub state.
- Finds eligible issues.
- Enforces WIP limits.
- Enforces GitHub issue dependency blockers.
- Optionally enforces area-label scheduling locks.
- Starts the Archon workflow named by the issue's `archon-workflow:*` label.
- Records issue, workflow run, branch, PR, labels, changed files, status, timestamps, and last error in SQLite.
- Adds and removes Archon lifecycle labels.
- Comments with important state transitions.
- Detects workflow completion, failure, cancellation, and missing PRs.
- Detects PR validation state and review state.
- Schedules fix workflows when review or CI requires changes.
- Auto-merges only when the user pre-authorized the issue with `archon:auto-merge` and all required checks pass.
- Produces a concise status report of active runs, blocked work, PRs awaiting review, and next eligible issues.

### Archon Workflow

- Runs in an isolated branch/worktree.
- Uses the issue body and GitHub context as the task prompt.
- Implements the requested change.
- Runs validation appropriate to the workflow.
- Opens a draft PR or updates an existing PR for its branch.
- Includes the issue reference in the PR body.
- Reports validation results in the PR or issue.
- Does not decide whether the issue should be auto-merged.
- Does not decide whether a different workflow should have been used.
- Does not independently start additional backlog issues.

### Live E2E Worker Contract

The `archon-e2e-tiny` workflow is deliberately constrained:

```text
input issue label = archon-workflow:e2e-tiny
branch = archon-e2e/<session>
changed file = archon-e2e/<session>.md
PR = draft
scope = disposable smoke artifact only
```

It should not run research, planning, reviews, or broad validation. Those belong
to production workflows such as `archon-fix-github-issue`. The E2E worker exists
only to prove that the live loop can create a branch and PR and that the
orchestrator can observe the PR.

The `archon-e2e-tiny-self-merge` variant is similarly constrained, except it
uses one marker file per issue, opens a non-draft PR, performs a deterministic
self-review, and merges the PR behind the live merge gate. It exists so the live
harness can verify that closing one skeleton issue unblocks multiple dependent
issues and starts them in parallel.

### Archon Core Runtime

- Provides workflow execution, isolation, state tracking for workflow runs, logging, and existing Git/GitHub utilities.
- Does not own harness backlog policy.
- Does not mutate GitHub issue lifecycle labels unless invoked by the harness orchestrator or a workflow step explicitly assigned that task.

## Source Of Truth

Use GitHub as the source of truth for human-visible backlog and review state.

Use SQLite as the source of truth for orchestrator bookkeeping that GitHub does not naturally store:

```text
orchestrator_runs
- id
- repo
- issue_number
- workflow_run_id
- branch
- worktree_path
- pr_number
- status
- workflow_label
- area_labels_json
- changed_files_json
- started_at
- updated_at
- last_error
```

The orchestrator must be able to rebuild a useful view after restart by reconciling SQLite with GitHub issues, PRs, and Archon workflow runs.

## Main Loop

The orchestrator runs an indefinite reconcile loop:

```text
while running:
  sync open GitHub issues
  sync open and recently closed PRs
  sync Archon workflow runs known to SQLite
  reconcile issue labels with run state
  reconcile PR state with run state
  schedule fix work when needed
  schedule new issue work if capacity allows
  write status snapshot
  sleep poll_interval
```

Each loop should be idempotent. Running the same loop twice with unchanged GitHub and workflow state should not create duplicate workflow runs, duplicate PRs, or noisy repeated comments.

## Eligibility Logic

An issue is eligible to start when all of these are true:

```text
issue is open
issue has archon:ready
issue has exactly one archon-workflow:* label
issue has no unresolved GitHub issue dependency blockers
repo-level WIP limits allow another run
selected scheduling policy does not block it
no existing non-terminal orchestrator run owns the issue
```

An issue is not eligible when any of these are true:

```text
issue is closed
issue lacks archon:ready
issue has zero archon-workflow:* labels
issue has multiple archon-workflow:* labels
issue is blocked by an open dependency
issue conflicts with active area locks when area locks are enabled
max_parallel_workflows is reached
max_open_agent_prs is reached
an active run already exists for the issue
```

## Scheduling Policy

The first POC can run with:

```text
max_parallel_workflows = 1
```

That avoids pre-PR conflict detection.

When `max_parallel_workflows > 1`, choose one conservative policy:

```text
area locks enabled
  -> do not run two active issues that share an area:* label

area labels reporting-only
  -> ignore area labels for scheduling

workflow class limits
  -> allow only one active run for selected workflow labels, such as archon-workflow:ralph
```

If area locks are enabled and a ready issue has no `area:*` label, use one of these policies:

```text
strict
  -> mark blocked and comment asking for an area label

conservative
  -> start only when no other issue is active
```

Recommendation: use `conservative` for the POC because it reduces label friction while avoiding obvious overlap.

## State Machine

Use these orchestrator statuses:

```text
queued
running
pr_open
ready_for_review
needs_fix
fix_running
blocked
done
failed
abandoned
```

Expected lifecycle:

```text
eligible issue
  -> running
  -> pr_open
  -> ready_for_review
  -> needs_fix
  -> fix_running
  -> ready_for_review
  -> done
```

Failure lifecycle:

```text
eligible issue
  -> running
  -> failed
  -> blocked or needs_fix
```

The orchestrator should not hide terminal failures. It should preserve `last_error`, comment with the failure summary, and remove labels that imply active work if the run is no longer active.

## Fix Workflow Scheduling

The orchestrator may schedule a fix workflow when:

```text
tracked PR exists
PR has failing checks or requested changes
retry budget remains
no fix workflow is already active for the PR
```

The fix workflow input should include:

```text
repo
issue number
PR number
branch
failing checks or review comments
validation command expectations
```

The fix workflow should update the same branch and PR. It should not open a second PR for the same issue unless the first PR was closed and the orchestrator explicitly starts a replacement run.

## Auto-Merge Guardrails

Auto-merge requires all of these:

```text
issue has archon:auto-merge
PR is linked to the issue
PR is open
PR is not draft
required checks pass
Archon review passes
no unresolved requested-changes review
branch is mergeable
retry/fix workflow is not active
```

Auto-merge must not happen when:

```text
issue lacks archon:auto-merge
PR changes are unvalidated
PR has unresolved requested changes
PR has merge conflicts
PR belongs to an untracked issue
orchestrator cannot confidently map PR to issue
```

## Comments And Noise Control

The orchestrator should comment on durable state transitions:

```text
started workflow
blocked by missing routing label
blocked by dependency
PR opened
validation passed
validation failed and fix scheduled
retry budget exhausted
auto-merge completed
PR closed without merge
```

The orchestrator should avoid repeating the same comment every poll. Store enough local state to know whether a transition comment has already been posted.

## Status Report

The status report should include:

```text
active workflow runs
open agent PRs
PRs ready for human review
auto-merge candidates
issues waiting for capacity
issues blocked by dependencies
issues blocked by area locks
failed runs and runs needing manual attention
next eligible work
```

The report can be printed to the CLI for the POC. Later it can be posted to GitHub, Slack, Telegram, or a web UI.
