# Backlog Orchestrator

`@archon/backlog-orchestrator` is the production home for Archon's GitHub issue
backlog supervisor. It promotes the proven harness loop into a reusable package
with typed ports for GitHub, Archon workflow execution, and durable run storage.

The CLI exposes it through:

```bash
archon backlog setup
archon backlog reconcile
archon backlog run
archon backlog status
```

GitHub remains the visible source of truth for issues, PRs, labels, checks,
reviews, merge state, and native issue dependencies. Archon's database stores
only the bookkeeping GitHub does not naturally provide, such as workflow run IDs,
comment idempotency keys, retry counts, and changed file snapshots.

Production smoke scenarios should stay gated behind explicit environment
variables and disposable labels/branches. They are validation paths for this
package, not the feature boundary itself.

## Tests And Smoke

Deterministic fixture E2E runs live with the package:

```bash
bun --filter @archon/backlog-orchestrator test:e2e
```

Live GitHub smoke remains opt-in and gated:

```bash
ARCHON_E2E_LIVE=1 \
ARCHON_BASE_URL=http://localhost:3090 \
ARCHON_CODEBASE_URL=git@github.com:podlodka-ai-club/X15.git \
bun --filter @archon/backlog-orchestrator smoke:live -- --repo podlodka-ai-club/X15 --preflight
```
