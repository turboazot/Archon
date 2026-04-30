# Labels And Routing

Use labels as the first source of truth. They are easy to inspect, easy for humans to override, and simple for an orchestrator to reconcile.

## Lifecycle Labels

```text
archon:ready
archon:in-progress
archon:blocked
archon:pr-open
archon:ready-for-review
archon:needs-fix
archon:done
archon:auto-merge
```

## Workflow Routing Labels

Use `archon-workflow:*` labels to tell the orchestrator which Archon worker workflow should handle an issue or PR.

```text
archon-workflow:ralph
  -> archon-ralph-dag

archon-workflow:fix-issue
  -> archon-fix-github-issue or equivalent issue-fix workflow

archon-workflow:review-pr
  -> maintainer-review-pr or equivalent PR review workflow

archon-workflow:docs
  -> docs-focused workflow

archon-workflow:test-loop
  -> archon-test-loop-dag

archon-workflow:refactor
  -> archon-refactor-safely

archon-workflow:e2e-tiny
  -> archon-e2e-tiny
```

The label chooses the workflow. The issue body provides the prompt, acceptance criteria, and constraints. The user is responsible for applying the routing label before the orchestrator starts work.

`archon-workflow:e2e-tiny` is reserved for the harness live smoke test. It is not
a general issue-fixing route. It exists so the live E2E loop can exercise real
GitHub issue labels, Archon workflow start/polling, branch creation, draft PR
creation, and orchestrator PR reconciliation without paying the cost of the full
`archon-fix-github-issue` research/plan/review loop.

## Auto-Merge Label

Suggested merge policy:

```text
archon:auto-merge + green CI + clean Archon review
  -> may auto-merge

missing archon:auto-merge
  -> human review required
```

The user decides in advance whether an issue is eligible for automatic merge by applying `archon:auto-merge`. Archon should not infer merge risk from issue content for the first POC.

## Area Labels Open Question

The open scheduling question is whether `area:*` labels are needed, and what they should mean if they exist.

Example area labels:

```text
area:products
area:catalogs
area:docs
area:infra
```

Options:

```text
No area labels
  -> simplest first POC
  -> rely on max_parallel_workflows = 1, GitHub issue dependencies, PR review, and CI
  -> avoids asking users to classify issues beyond readiness and workflow

Coarse area labels as scheduling locks
  -> user applies area labels up front
  -> orchestrator avoids running two active issues with the same area label
  -> simple and inspectable, but can be over-conservative

Area labels as status/reporting only
  -> labels help humans read the board
  -> labels do not affect scheduling
  -> avoids false blocking but gives less coordination safety
```

Recommendation for the POC: start with area labels as optional coarse scheduling locks only if `max_parallel_workflows > 1`. If the issue has no `area:*` label, either run it only when no other issue is active or mark it blocked with a request for an area label. Revisit after the first harness run shows whether this is useful friction or needless bookkeeping.

## Eligibility Rule

```text
archon:ready + exactly one archon-workflow:* label + no unresolved GitHub issue dependency blockers = eligible
```

Blocked cases:

```text
archon:ready + zero archon-workflow:* labels
  -> add archon:blocked
  -> comment: "Missing archon-workflow:* routing label"

archon:ready + multiple archon-workflow:* labels
  -> add archon:blocked
  -> comment: "Ambiguous workflow routing labels"
```

## Example Labels

Feature issue:

```text
archon:ready
archon-workflow:ralph
area:products
```

Docs issue:

```text
archon:ready
archon-workflow:docs
area:docs
archon:auto-merge
```

Bug issue:

```text
archon:ready
archon-workflow:fix-issue
area:catalogs
```

Harness tiny live smoke issue:

```text
archon-e2e
archon:ready
archon-workflow:e2e-tiny
area:e2e
```

## Issue Template

Each issue should include enough information for an agent to scope and validate the work.

```md
## Goal

Short description of the product or engineering change.

## Acceptance Criteria

- Specific observable requirement
- Specific validation requirement
- Type-check, lint, test, and format pass

## Notes

Any API, product, or design constraints the agent should preserve.
```

Do not ask users to provide a touch set in the issue template. The orchestrator should derive changed files from the branch/PR after work starts.
