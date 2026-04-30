# Overview

## Goal

Prove that Archon can run a lightweight autonomous engineering loop against a real GitHub repository by using GitHub issues as the backlog, Archon workflows as implementation workers, and GitHub PRs as the human review/merge gate.

## Core Hypothesis

Archon should be able to keep producing useful, validated PRs from a backlog until it reaches a coordination boundary:

- too many open agent PRs are waiting for human review
- the next issues conflict with active work according to the selected scheduling policy
- the next issues are blocked by unresolved GitHub issue dependencies
- requirements are unclear
- validation or CI fails and the agent cannot fix confidently
- credentials, permissions, budget, or time limits are reached

Human review remains the merge gate by default. Archon can implement, self-review, fix, and open PRs autonomously.

## Operating Model

```text
GitHub issues
  -> backlog orchestrator
  -> isolated Archon workflow run
  -> branch + commits
  -> draft PR
  -> automated validation/review
  -> human review queue
  -> merge or fix loop
```

Each worker workflow should stay focused on one scoped task to PR. The backlog orchestrator should be the durable supervisor that runs indefinitely, tracks active workflow executions, starts the worker named by the issue's routing label, and reconciles GitHub state.

## POC Defaults

```text
max_parallel_workflows = 1
max_open_agent_prs = 3
max_new_runs_per_cycle = 1
poll_interval_seconds = 60
auto_merge_enabled = false
max_fix_attempts = 2
area_lock_policy = conservative
required_issue_label = archon:ready
required_workflow_label_prefix = archon-workflow:
```

`auto_merge_enabled = false` means the first POC may identify auto-merge candidates but should not merge them. Once the loop is reliable, enabling auto-merge should still require `archon:auto-merge` on each issue.

## Success Criteria

The POC is successful when Archon can:

- detect ready GitHub issues
- select eligible work according to workflow labels, dependency state, and the chosen area scheduling policy
- start isolated workflow runs
- produce draft PRs
- link PRs back to issues
- update issue labels/comments
- stop when WIP limits, dependency blockers, or area locks are reached
- resume once humans merge or close blocking PRs
- provide a concise status report of active runs, open PRs, blocked issues, and next eligible work

## Non-Goals For First POC

- Auto-merge by default
- Fully parallel execution without a conservative scheduling policy
- Perfect dependency inference
- Cross-repository planning
- Long-lived stacked PR chains
- Replacing human product judgment
