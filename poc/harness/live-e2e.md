# Live E2E Notes

## Purpose

The live E2E harness proves the real boundary between:

- GitHub issues, labels, comments, branches, and PRs in `podlodka-ai-club/X15`.
- Archon REST workflow start/polling.
- The dependency-injected `HarnessOrchestrator`.
- SQLite-backed orchestrator bookkeeping.

It is not meant to validate a production issue-fixing workflow. Keep the live
smoke tiny so the feedback loop stays fast.

## Current Live Smoke Route

```text
GitHub label: archon-workflow:e2e-tiny
Archon workflow: archon-e2e-tiny
Branch: archon-e2e/<session>
File: archon-e2e/<session>.md
PR: draft
```

The workflow lives at:

```text
.archon/workflows/defaults/archon-e2e-tiny.yaml
```

It is bash-only by design:

1. Parse the harness prompt for session, issue number, and branch.
2. Create one disposable marker file.
3. Commit, push, and open one draft PR.

## Self-Merge Tiny Route

```text
GitHub label: archon-workflow:e2e-tiny-self-merge
Archon workflow: archon-e2e-tiny-self-merge
Branch: archon-e2e/issue-<number>-<session>
File: archon-e2e/<session>-<issue-number>.md
PR: non-draft, self-reviewed, then merged when ARCHON_E2E_ALLOW_MERGE=1
```

This route is still bash-only and disposable. Its self-review checks that the PR
changes exactly one scoped marker file and that the marker includes the session
id. It comments the review result on the PR, then merges through `gh pr merge`
only when the explicit merge env gate is enabled.

## Commands

Start Archon server if it is not already running:

```bash
bun run dev:server
```

For the self-merge route, the server process must also receive the merge gate
because workflow bash nodes inherit the server environment:

```bash
ARCHON_E2E_ALLOW_MERGE=1 bun run dev:server
```

Preflight without mutating GitHub:

```bash
bun ./poc/harness/e2e/run-live.ts \
  --repo podlodka-ai-club/X15 \
  --issue-size tiny \
  --preflight
```

Run the tiny live smoke:

```bash
bun ./poc/harness/e2e/run-live.ts \
  --cycles 3 \
  --repo podlodka-ai-club/X15 \
  --issue-size tiny
```

Run the dependency-unblock live smoke:

```bash
# Requires the server to have been started with ARCHON_E2E_ALLOW_MERGE=1.
ARCHON_E2E_ALLOW_MERGE=1 \
bun ./poc/harness/e2e/run-live.ts \
  --cycles 6 \
  --repo podlodka-ai-club/X15 \
  --scenario blocked-parallel
```

That scenario creates:

- one skeleton issue routed to `archon-e2e-tiny-self-merge`
- two ready issues marked as blocked by the skeleton through GitHub's native
  issue dependency API

Expected behavior: the two blocked issues remain idle while the skeleton is
open, then start together after the skeleton PR self-merges and GitHub closes
the skeleton issue.

Known gotchas from live runs:

- Create dependencies with `gh api -F issue_id=<id>` so GitHub receives a JSON
  integer. `-f issue_id=<id>` sends a string and the API rejects it.
- Do not use `gh pr merge --delete-branch` from the workflow worktree. The PR
  can merge successfully, then `gh` may fail while trying local branch cleanup
  because the base branch is owned by another worktree.

The runner loads repo-root `.env` by default. Required values:

```text
ARCHON_E2E_LIVE=1
ARCHON_BASE_URL=http://localhost:3090
ARCHON_CODEBASE_URL=git@github.com:podlodka-ai-club/X15.git
```

GitHub auth uses the local `gh` CLI session.

## Safety Rules

- Live runner refuses to run unless `ARCHON_E2E_LIVE=1`.
- GitHub resources are marked with `archon-e2e`.
- The single scenario uses one branch: `archon-e2e/<session>`.
- The blocked-parallel scenario uses one branch per issue:
  `archon-e2e/issue-<number>-<session>`.
- Auto-merge is disabled unless `ARCHON_E2E_ALLOW_MERGE=1`.
- Cleanup should only touch `archon-e2e` issues, PRs, and branches.

## Latest Successful Run

### Single Smoke

```text
Issue: podlodka-ai-club/X15#7
PR: podlodka-ai-club/X15#8
Workflow run: e64e3573f29b339e9bb1cc326d84ca49
Branch: archon-e2e/2026-04-30T20-13-44-187Z
Result: workflow completed, orchestrator recorded pr_open
Artifacts: poc/harness/e2e/results/2026-04-30T20-13-44-187Z/result.json
```

The successful issue and draft PR were left open intentionally for inspection.

### Blocked Parallel Smoke

```text
Issues: podlodka-ai-club/X15#22, #23, #24
PRs: podlodka-ai-club/X15#25, #26, #27
Workflow: archon-e2e-tiny-self-merge
Result: cycle 1 started #22 and blocked #23/#24 on native GitHub dependency; cycle 2 started #23 and #24 together; all runs ended done.
Artifacts: poc/harness/e2e/results/2026-04-30T20-36-33-498Z/result.json
```
