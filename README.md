# Archon

Archon is a harness for AI coding agents. It turns a GitHub backlog into a
controlled delivery loop: pick ready issues, run the right agent workflow,
watch the PR, react to checks and reviews, resolve conflicts, retry failures,
and mark work done only when the repository agrees.

The original product-facing README is preserved in [ARCHON.md](./ARCHON.md).
This file focuses on the harness and backlog orchestrator.

## Agent Reading Order

For repo analysis:

1. `CLAUDE.md` — engineering rules.
2. `README.md` — current harness/backlog framing.
3. `ARCHON.md` — product/workflow-engine context, especially workflow customization.
4. `packages/backlog-orchestrator/README.md` — package-specific behavior.

Keep the boundary clear: backlog-orchestrator schedules and reconciles the
GitHub issue/PR lifecycle; implementation, validation, review, approval, and PR
creation behavior is defined by customizable Archon YAML workflows.

## The Harness

The important demo is not "an agent wrote code." The important demo is that the
agent is inside a governed loop.

`@archon/backlog-orchestrator` is that loop. It treats GitHub as the visible
source of truth and Archon workflows as the execution workers:

- GitHub issues are the queue.
- Labels are the routing and lifecycle protocol.
- GitHub issue dependencies block scheduling until upstream work closes.
- Area labels prevent unsafe parallel work in the same part of the codebase.
- Archon workflows implement, fix, review, validate, and resolve conflicts.
- PR checks, reviews, mergeability, and closing references decide the next move.
- The database stores only harness bookkeeping: run IDs, retry counts, comment
  idempotency keys, branch names, PR numbers, and changed-file snapshots.

That makes the harness observable and reversible. A human can inspect the queue,
labels, PRs, comments, checks, and merge history without trusting hidden agent
memory.

## Request Flow

```text
GitHub backlog
issues / labels / dependencies / PRs / checks / reviews
   |
   v
Backlog orchestrator reconcile loop
- list issues and pull requests
- sync active workflow runs
- enforce capacity and area locks
- choose the next eligible issues
   |
   v
Archon workflow runner
- start implementation workflows
- start fix workflows when checks or reviews fail
- start conflict workflows when mergeability breaks
   |
   v
Workflow DAG executor
- run agent, bash, script, loop, and approval nodes
- stream progress
- write artifacts
- create commits and PRs
   |
   v
GitHub feedback
- PR opened
- checks passing or failing
- review approved or changes requested
- mergeable or conflicting
   |
   v
Harness decision
done / blocked / retry / needs-fix / ready-for-review / auto-merge
```

## Backlog Protocol

The backlog harness uses labels as a small, inspectable control plane:

| Label | Meaning |
| --- | --- |
| `archon:ready` | Issue is eligible for scheduling. |
| `archon:in-progress` | A workflow owns this issue right now. |
| `archon:blocked` | The harness found a missing route, dependency, unsafe PR link, or exhausted retry path. |
| `archon:pr-open` | A workflow produced a PR for the issue. |
| `archon:ready-for-review` | The PR passed validation and is ready for a human or auto-merge. |
| `archon:needs-fix` | Checks, review, or mergeability require another workflow pass. |
| `archon:done` | The work merged or completed through an allowed no-PR workflow. |
| `archon:auto-merge` | Merge automatically when every safety condition is satisfied. |
| `archon-workflow:*` | Route this issue to a specific Archon workflow. |
| `area:*` | Optional concurrency lock for related code areas. |

An issue becomes schedulable only when it is open, has `archon:ready`, has
exactly one `archon-workflow:*` routing label, is not blocked by another open
issue, and does not conflict with the configured area lock policy.

## Reconcile Loop

The harness is intentionally boring: one deterministic reconciliation cycle at
a time.

1. Read repository metadata, issues, PRs, and stored runs.
2. Sync active workflow runs with the latest Archon workflow state.
3. Adopt newly opened PRs by branch.
4. Verify each tracked PR has exactly one closing reference to its issue.
5. Mark merged PRs as done and label the issue `archon:done`.
6. Schedule fix workflows for failing checks or requested changes.
7. Schedule conflict-resolution workflows for conflicting PRs.
8. Mark passing PRs as `archon:ready-for-review`.
9. Auto-merge only when the issue and PR satisfy all safety gates.
10. Start new eligible issues within workflow, PR, and per-cycle capacity.

If a workflow fails, the harness retries within `maxRunAttempts`. If a PR keeps
failing or conflicting, fix attempts are bounded by `maxFixAttempts`. Exhausted
paths become visible as `archon:blocked` or `archon:needs-fix`, with comments
posted once per event key.

## Safety Gates

Auto-merge is deliberately conservative. A PR can be merged by the harness only
when all of these are true:

- the issue has `archon:auto-merge`
- the PR closes exactly that one issue
- the PR targets the repository default branch
- GitHub auto-close semantics are available
- the PR is open, non-draft, mergeable, and not in a fix workflow
- required checks are present and passing
- no review has requested changes

Everything else stops at `archon:ready-for-review` for a human.

## Running The Harness

From the CLI:

```bash
archon backlog setup
archon backlog reconcile
archon backlog run
archon backlog status
```

From source:

```bash
bun run cli backlog setup
bun run cli backlog reconcile
bun run cli backlog run --cycles 5 --poll-interval 30
bun run cli backlog status
```

Typical project configuration lives in `.archon/config.yaml`:

```yaml
backlog:
  projects:
    - name: demo
      repo: owner/repo
      cwd: /path/to/repo
      maxParallelWorkflows: 2
      maxOpenAgentPrs: 3
      maxNewRunsPerCycle: 1
      maxRunAttempts: 2
      maxFixAttempts: 2
      autoMergeEnabled: true
      areaLockPolicy: conservative
      conflictWorkflowName: archon-resolve-conflicts
      workflowLabelToName:
        archon-workflow:fix-issue-simple: archon-fix-github-issue-simple
```

## Workflow Engine Underneath

Workflows live in `.archon/workflows/` and bundled defaults live in
`.archon/workflows/defaults/`. A workflow is YAML:

```yaml
name: archon-small-interactive-prd
description: Clarify a small idea, approve a plan, then implement it.

provider: codex
model: gpt-5.5
interactive: true

nodes:
  - id: brainstorm
    prompt: |
      Restate the request, then ask three focused questions.

  - id: brainstorm-gate
    approval:
      message: Answer the questions so I can write the plan.
      capture_response: true
    depends_on: [brainstorm]

  - id: write-plan
    prompt: |
      Inspect the codebase and write a small implementation plan.
    depends_on: [brainstorm-gate]

  - id: implement
    command: archon-implement
    context: fresh
    depends_on: [write-plan]
```

Nodes declare `depends_on`, so Archon can run the graph in topological order.
Independent nodes in the same layer can execute concurrently. Downstream nodes
can read upstream output through variables such as `$nodeId.output` or through
files written into `$ARTIFACTS_DIR`.

## Node Types

Each node specifies exactly one execution type:

| Type | Purpose |
| --- | --- |
| `command` | Load a markdown command from `.archon/commands/` and send it to an agent. |
| `prompt` | Send an inline prompt directly to an agent. |
| `bash` | Run deterministic shell code and capture stdout. |
| `script` | Run a discovered script with structured workflow context. |
| `loop` | Repeat an agent step until a completion signal appears. |
| `approval` | Pause for human approval or revision feedback. |
| `cancel` | End the workflow early with an explicit reason. |

Common node controls include `when`, `trigger_rule`, `context: fresh`,
`provider`, `model`, `retry`, `idle_timeout`, `mcp`, `skills`, `agents`,
`allowed_tools`, `denied_tools`, `sandbox`, and structured `output_format`.

## Why Fresh Context Works

Large agent sessions get noisy. Archon encourages a file-handoff model:

1. An investigation node writes `investigation.md` into `$ARTIFACTS_DIR`.
2. An implementation node starts with `context: fresh`.
3. The implementation prompt reads `investigation.md` explicitly.
4. A validation or review node reads the implementation artifact and the diff.

That keeps each agent step focused while still preserving the important facts.
The workflow, not hidden chat memory, becomes the source of truth.

## Harness Ports

The backlog orchestrator is packaged behind typed ports, so the harness can be
tested with fixtures and run against real GitHub:

| Port | Responsibility |
| --- | --- |
| `GitHubPort` | List issues and PRs, read repository metadata, mutate labels, post comments, merge PRs. |
| `ArchonPort` | Start workflows and read workflow run status. |
| `OrchestratorStore` | Persist run state, retry counts, comment keys, branch and PR links. |

The CLI production path wires these ports to `gh`, Archon's workflow runner, and
Archon's database-backed store.

## Isolation Model

By default, workflow runs happen in git worktrees:

```text
~/.archon/
  archon.db
  config.yaml
  workspaces/
    owner/repo/
      source/
      worktrees/
      artifacts/
```

This gives every run a branch, a working directory, and an artifact directory.
The user's main checkout stays clean, multiple workflows can run in parallel,
and failed runs can be inspected or discarded without guessing what changed.

Repo-level configuration lives in:

```text
your-repo/.archon/
  commands/
  workflows/
  scripts/
  config.yaml
```

Repo files override bundled defaults with the same name, so teams can commit
their own process while keeping the engine generic.

## Runtime State

Archon stores operational state in SQLite by default, with PostgreSQL available
for deployments that need it. The database tracks:

- codebases and their default working directories
- conversations and messages
- assistant sessions
- isolation environments
- workflow runs
- workflow events
- environment variables scoped to codebases

The Web UI subscribes to workflow events to show live progress, tool calls,
approval waits, errors, and completed runs. Chat platforms can receive either
streamed or batched output depending on adapter capabilities.

## Demo Smoke

The backlog orchestrator has deterministic fixture E2E tests and opt-in live
GitHub smoke scenarios.

```bash
bun --filter @archon/backlog-orchestrator test:e2e
```

Live smoke uses a configured project and a running Archon server:

```bash
ARCHON_BASE_URL=http://localhost:3090 \
bun --filter @archon/backlog-orchestrator smoke:live -- --repo owner/name --preflight
```

The full ecommerce smoke seeds a dependency graph of disposable GitHub issues,
lets the harness schedule implementation PRs, waits for upstream dependencies,
handles conflicts, and verifies that all session PRs merge and all session
issues close with `archon:done`.

## Package Map

| Package | Responsibility |
| --- | --- |
| `@archon/backlog-orchestrator` | Backlog harness: issue eligibility, lifecycle labels, PR tracking, retries, fix loops, conflict loops, auto-merge gates. |
| `@archon/core` | Main conversation orchestrator, database access, config loading, workflow operations. |
| `@archon/workflows` | YAML loading, schema validation, routing, DAG execution, hooks, events. |
| `@archon/providers` | Agent provider interface and implementations for Claude, Codex, and Pi. |
| `@archon/isolation` | Worktree resolution, lifecycle, stale-state handling, PR state checks. |
| `@archon/adapters` | Platform adapters for chat and forge integrations. |
| `@archon/server` | Hono API, Web adapter, OpenAPI routes, server startup. |
| `@archon/web` | React dashboard, chat, workflow monitoring, workflow builder. |
| `@archon/cli` | Local command-line entrypoint for chat, workflows, isolation, setup, serve. |
| `@archon/git` | Git helpers built around safe `execFile` usage. |
| `@archon/paths` | Global paths, environment loading, logging, telemetry utilities. |
| `@archon/docs-web` | Documentation site. |

## Development

Install dependencies:

```bash
bun install
```

Run server and Web UI together:

```bash
bun run dev
```

Run them separately:

```bash
bun run dev:server
bun run dev:web
```

Use the CLI from source:

```bash
bun run cli workflow list
bun run cli workflow run archon-assist "What does this repo do?"
bun run cli backlog reconcile
```

Validate before a PR:

```bash
bun run validate
```

`bun run validate` checks bundled defaults, type checking, linting, formatting,
and package-isolated tests.

## A Minimal Mental Model

Archon is a deterministic harness around probabilistic coding agents:

```text
GitHub backlog + labels + workflow DAGs + worktrees + PR feedback
                              |
                              v
             governed, repeatable AI software delivery
```

The harness is the product: backlog in, controlled PR lifecycle out.
