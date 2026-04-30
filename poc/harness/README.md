# Harness Engineering POC

This folder contains the planning docs for proving that Archon can run a lightweight autonomous engineering loop against a real GitHub repository.

## Reading Order

1. [Overview](./overview.md) - goal, hypothesis, operating model, and success criteria.
2. [Labels And Routing](./labels-and-routing.md) - GitHub labels, workflow routing, issue template, and the open area-label question.
3. [Orchestrator Logic](./orchestrator-logic.md) - responsibilities, source-of-truth boundaries, state model, scheduling, and merge guardrails.
4. [Scenarios](./scenarios.md) - scenario-by-scenario behavior the orchestrator should cover.
5. [Backlog And Setup](./backlog-and-setup.md) - sample issues, expected run, and GitHub CLI setup commands.
6. [Live E2E Notes](./live-e2e.md) - current live runner, tiny workflow, commands, and latest successful smoke.

## Target Repository

```text
podlodka-ai-club/X15
```

Live E2E uses the real GitHub repository `git@github.com:podlodka-ai-club/X15.git`.
Local fixture E2E uses in-memory mocks only.

## Mock Orchestrator Implementation

The runnable POC lives in [`src/orchestrator.ts`](./src/orchestrator.ts). It is dependency-injected behind three ports:

- `GitHubPort` for issues, labels, comments, PR state, checks, reviews, and merges.
- `ArchonPort` for starting and reading workflow runs.
- `OrchestratorStore` for durable run bookkeeping.

[`src/mocks.ts`](./src/mocks.ts) provides in-memory GitHub, Archon, and store implementations so the orchestrator can be developed without real GitHub credentials or live Archon workflow execution.

The implementation is split so adapters can be replaced without rewriting scheduling policy:

- [`src/types.ts`](./src/types.ts) defines the adapter contracts and shared data model.
- [`src/config.ts`](./src/config.ts) owns POC defaults and workflow label routing.
- [`src/lifecycle.ts`](./src/lifecycle.ts) owns lifecycle labels and run-status sets.
- [`src/eligibility.ts`](./src/eligibility.ts) owns pure issue eligibility and area-lock policy.
- [`src/orchestrator.ts`](./src/orchestrator.ts) owns the reconcile flow and coordinates the ports.
- [`src/adapters/github-gh.ts`](./src/adapters/github-gh.ts) implements `GitHubPort` using the authenticated `gh` CLI.
- [`src/adapters/archon-rest.ts`](./src/adapters/archon-rest.ts) implements `ArchonPort` using the Archon REST API.
- [`src/stores/sqlite-store.ts`](./src/stores/sqlite-store.ts) implements durable live-run bookkeeping with `bun:sqlite`.

Run the focused POC tests with:

```bash
bun test ./poc/harness/src/orchestrator.test.ts
```

## E2E Harness

Fixture E2E runs use the in-memory GitHub and Archon ports with typed scripted
events. They write artifacts to `poc/harness/e2e/results/`.

```bash
bun ./poc/harness/e2e/run-fixture.ts ready-success
bun ./poc/harness/e2e/run-fixture.ts pr-validation-fails-then-fix
```

Live E2E is explicitly gated and scoped to disposable `archon-e2e` issues,
labels, and one `archon-e2e/<session>` branch per test in `podlodka-ai-club/X15`.
The live runner defaults to `--issue-size tiny`, which asks for exactly one new
file under `archon-e2e/<session>.md`. Use `--issue-size small` for a slightly
richer one-file docs artifact.
GitHub operations use the authenticated `gh` CLI.
The default live smoke route uses `archon-workflow:e2e-tiny`, mapped to the
dedicated `archon-e2e-tiny` workflow instead of the full
`archon-fix-github-issue` loop. That workflow is intentionally bash-only and
small: parse the harness prompt, create one `archon-e2e/<session>.md` file,
push one `archon-e2e/<session>` branch, and open one draft PR.
The blocked-parallel live scenario uses `archon-workflow:e2e-tiny-self-merge`,
mapped to `archon-e2e-tiny-self-merge`, which creates one scoped marker file,
opens a non-draft PR, performs a deterministic self-review, and merges only
when `ARCHON_E2E_ALLOW_MERGE=1`.
The ecommerce-app live scenario uses one skeleton issue routed to
`archon-workflow:fix-issue-simple` with auto-merge enabled, then two dependent
issues routed to the same simple implementation workflow. After the skeleton
PR merges, the catalog and cart/checkout issues should start in parallel and
open PRs without auto-merging.
For self-merge tests, start the Archon server with `ARCHON_E2E_ALLOW_MERGE=1`
in its environment too; workflow bash nodes inherit the server process
environment, not the runner's process environment.
The runner loads repo-root `.env` by default before validating env vars; pass
`--env-file path/to/file` to use a different file. Existing shell env vars win
over values from the file.
Use `--preflight` for a non-mutating check of `.env`, `gh` repo access, and
Archon `/api/health` before creating an issue.

```bash
ARCHON_E2E_LIVE=1 \
ARCHON_BASE_URL=http://localhost:3090 \
ARCHON_CODEBASE_URL=git@github.com:podlodka-ai-club/X15.git \
bun ./poc/harness/e2e/run-live.ts --cycles 3 --repo podlodka-ai-club/X15 --issue-size tiny
```

```bash
bun ./poc/harness/e2e/run-live.ts --repo podlodka-ai-club/X15 --issue-size tiny --preflight
```

Run the dependency-unblock scenario. It creates one skeleton issue and two
issues blocked by that skeleton using GitHub's native issue dependency API.
After the skeleton PR is self-reviewed and merged, the two dependent issues
should be started in the same reconcile cycle.

```bash
# In another terminal, start the server with the merge gate:
ARCHON_E2E_ALLOW_MERGE=1 bun run dev:server

ARCHON_E2E_LIVE=1 \
ARCHON_E2E_ALLOW_MERGE=1 \
ARCHON_BASE_URL=http://localhost:3090 \
ARCHON_CODEBASE_URL=git@github.com:podlodka-ai-club/X15.git \
bun ./poc/harness/e2e/run-live.ts --cycles 6 --repo podlodka-ai-club/X15 --scenario blocked-parallel
```

Run the small ecommerce app scenario. It creates a real tiny browser app
skeleton first, merges it when validation passes, then starts two implementation
issues in parallel. The runner defaults to a longer 120-cycle budget for this
scenario and exits early when the skeleton issue is closed and both dependent
issues have opened PRs.

```bash
ARCHON_E2E_LIVE=1 \
ARCHON_E2E_ALLOW_MERGE=1 \
ARCHON_BASE_URL=http://localhost:3090 \
ARCHON_CODEBASE_URL=git@github.com:podlodka-ai-club/X15.git \
bun ./poc/harness/e2e/run-live.ts --repo podlodka-ai-club/X15 --scenario ecommerce-app
```

The live GitHub adapter refuses to merge unless `ARCHON_E2E_ALLOW_MERGE=1` is
also set.

Latest known successful live smoke:

```text
Issue: podlodka-ai-club/X15#7
PR: podlodka-ai-club/X15#8
Workflow: archon-e2e-tiny
Workflow run: e64e3573f29b339e9bb1cc326d84ca49
Branch: archon-e2e/2026-04-30T20-13-44-187Z
Result: workflow completed, orchestrator recorded pr_open
Changed file: archon-e2e/2026-04-30T20-13-44-187Z.md
Artifacts: poc/harness/e2e/results/2026-04-30T20-13-44-187Z/result.json
```

Latest known successful blocked-parallel live smoke:

```text
Issues: podlodka-ai-club/X15#22, #23, #24
PRs: podlodka-ai-club/X15#25, #26, #27
Workflow: archon-e2e-tiny-self-merge
Result: skeleton issue #22 completed first; #23 and #24 started together in cycle 2; all runs ended done.
Artifacts: poc/harness/e2e/results/2026-04-30T20-36-33-498Z/result.json
```

## Key Decisions

- GitHub issues are the backlog.
- Archon workflows are implementation workers.
- GitHub PRs are the review and merge gate.
- Users select automation readiness with `archon:ready`.
- Users select the worker with exactly one `archon-workflow:*` label.
- Users opt into automatic merge eligibility with `archon:auto-merge`.
- GitHub issue dependencies model explicit ordering.
- The POC should not ask users to provide touch sets.
- SQLite stores orchestrator bookkeeping.
- Live E2E uses one scoped branch per test: `archon-e2e/<session>`.
- Live smoke uses a dedicated tiny workflow rather than production issue-fixing workflows.
- Live blocked-parallel uses per-issue `archon-e2e/issue-<number>-<session>` branches.
- Live ecommerce-app uses the generic simple fix workflow to implement actual app code.

## Open Questions

- Should `area:*` labels be required, optional scheduling locks, or reporting-only?
- Should lifecycle comments be posted to the issue, PR, or both?
- Should the orchestrator run as a CLI command, an Archon workflow, or a long-lived server task?
- Should auto-merge be enabled in the POC, or only detected and reported?
