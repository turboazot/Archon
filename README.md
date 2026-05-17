# Archon

Archon is a harness for repeatable AI coding workflows. It lets you encode a
development process as YAML, then run that process from the CLI, Web UI, Slack,
Telegram, or GitHub.

The workflow defines the sequence, validation gates, artifacts, and approval
points. The AI agent supplies judgment inside those steps; Archon keeps the run
structured, isolated, and observable.

## Why Archon?

When you ask an AI agent to "fix this bug", the result depends on the model,
prompt, context, and tool state. Archon makes the process explicit:

- **Repeatable** - same workflow, same sequence, every time.
- **Isolated** - workflow runs can use their own git worktrees.
- **Composable** - combine AI nodes, bash nodes, scripts, loops, and approvals.
- **Portable** - commit workflows in `.archon/workflows/` and run them anywhere.
- **Reviewable** - keep plans, validation, reviews, and PR creation in the run.

## Quick Start

Run Archon from source:

```bash
bun install
bun run cli workflow list
bun run cli workflow run archon-assist "Explain this repository"
```

Start the server and Web UI:

```bash
bun run dev
```

Or run the pieces separately:

```bash
bun run dev:server
bun run dev:web
```

## Workflow Example

Workflows live in `.archon/workflows/` and bundled defaults live in
`.archon/workflows/defaults/`. A workflow is a YAML DAG:

```yaml
name: build-feature
description: Plan, implement, validate, review, and create a PR.

nodes:
  - id: plan
    prompt: Explore the codebase and create an implementation plan.

  - id: implement
    depends_on: [plan]
    loop:
      prompt: Read the plan. Implement the next task. Run validation.
      until: ALL_TASKS_COMPLETE
      fresh_context: true

  - id: run-tests
    depends_on: [implement]
    bash: bun run validate

  - id: review
    depends_on: [run-tests]
    prompt: Review all changes against the plan. Fix any issues.

  - id: create-pr
    depends_on: [review]
    prompt: Push changes and create a pull request.
```

Nodes declare `depends_on`, so Archon can run the graph in topological order.
Independent nodes in the same layer can execute concurrently. Downstream nodes
can read upstream output through variables such as `$nodeId.output` or through
files written into `$ARTIFACTS_DIR`.

## CLI

```bash
# List available workflows
bun run cli workflow list

# Run a workflow
bun run cli workflow run archon-assist "What does this code do?"

# Run in a specific repository
bun run cli workflow run archon-fix-github-issue --cwd /path/to/repo "Fix login bug"

# Create or reuse an isolated worktree branch
bun run cli workflow run archon-idea-to-pr --branch feature-dark-mode "Add dark mode"

# Run directly in the current checkout
bun run cli workflow run quick-fix --no-worktree "Fix typo"

# Show, resume, abandon, or clean workflow runs
bun run cli workflow status
bun run cli workflow resume <run-id>
bun run cli workflow abandon <run-id>
bun run cli workflow cleanup
```

## Default Workflows

Archon ships with workflows for common development tasks:

| Workflow | What it does |
| --- | --- |
| `archon-assist` | General Q&A, debugging, and exploration. |
| `archon-fix-github-issue` | Investigate, plan, implement, validate, review, and create a PR for a GitHub issue. |
| `archon-idea-to-pr` | Turn a feature idea into a plan, implementation, validation, review, and PR. |
| `archon-plan-to-pr` | Execute an existing plan through implementation, validation, review, and PR creation. |
| `archon-smart-pr-review` | Classify PR complexity and run targeted review agents. |
| `archon-comprehensive-pr-review` | Run a multi-agent PR review with automatic fixes. |
| `archon-validate-pr` | Validate a PR against main and feature branches. |
| `archon-resolve-conflicts` | Detect, resolve, validate, and commit merge conflict fixes. |

Run `archon workflow list` to see every bundled and repository-defined workflow.
Repository workflows with the same name as bundled defaults override them.

## Project Layout

| Package | Purpose |
| --- | --- |
| `@archon/cli` | Command-line entry point for workflow, isolation, setup, chat, serve, and validation commands. |
| `@archon/core` | Conversation handling, configuration, persistence, and shared runtime logic. |
| `@archon/workflows` | Workflow DAG loading, execution, schemas, stores, loops, hooks, and command nodes. |
| `@archon/providers` | Built-in and community AI provider registry. |
| `@archon/adapters` | Platform adapters for Slack, Telegram, GitHub, CLI, and web usage. |
| `@archon/isolation` | Git worktree isolation for workflow runs. |
| `@archon/git` | Git utilities used by workflows and isolation. |
| `@archon/server` | API server and webhook handling. |
| `@archon/web` | Web UI. |
| `@archon/docs-web` | Documentation site. |

## Development

```bash
bun run type-check
bun run lint
bun run format:check
bun run test
```

Before opening a PR:

```bash
bun run validate
```

The original product-facing overview is preserved in [ARCHON.md](./ARCHON.md).
