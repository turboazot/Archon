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

Production smoke scenarios should stay explicit and disposable. They are
validation paths for this package, not the feature boundary itself.

Auto-merge is intentionally conservative: a PR with no status checks is treated
as pending, not passing. Configure at least one required check on repositories
where `archon:auto-merge` is used.

## Tests And Smoke

Deterministic fixture E2E runs live with the package:

```bash
bun --filter @archon/backlog-orchestrator test:e2e
```

Live GitHub smoke remains opt-in through the `smoke:live` script. The target
repository comes from `.archon/config.yaml` `backlog.projects`; pass
`--project <name>` or `--repo <owner/name>` to choose one explicitly.

```bash
ARCHON_BASE_URL=http://localhost:3090 \
bun --filter @archon/backlog-orchestrator smoke:live -- --repo owner/name --preflight
```

Focused one-issue workflow-owned auto-merge smoke:

```bash
ARCHON_BASE_URL=http://localhost:3090 \
bun --filter @archon/backlog-orchestrator smoke:live -- --repo owner/name --scenario single-auto-merge
```

Run the full scratch ecommerce auto-merge smoke against a disposable repository.
`ARCHON_BASE_URL` defaults to `http://localhost:3090`, so it can be omitted when
Archon is running locally:

```bash
bun --filter @archon/backlog-orchestrator smoke:live -- --repo owner/name --scenario ecommerce-app-auto-merge
```

To only seed the ecommerce test GitHub issues and let an already-running backlog
orchestrator pick them up:

```bash
bun --filter @archon/backlog-orchestrator smoke:create-ecommerce-issues -- --repo owner/name
```

The helper creates plain issue titles by default, without an `[archon-test:...]`
prefix. Add `--title-prefix "[archon-test:my-session] "` only when you want that
extra title marker.

The helper only applies orchestration labels by default. Ecommerce implementation
issues get `archon:ready`, `archon-workflow:fix-issue-simple`, and
`archon:auto-merge` unless `--no-auto-merge` is passed. The video recording
issue gets `archon:ready` and `archon-workflow:video-recording`.

Recommended preflight before starting:

```bash
curl -fsS http://localhost:3090/health
gh issue list -R owner/name --label archon-test --state open
gh pr list -R owner/name --state open --head 'archon-test/*'
```

A passing scratch run creates four disposable issues, three PRs, and one video
artifact branch:

- skeleton issue and PR merge first
- catalog and cart/checkout unblock together
- video recording waits for catalog and cart/checkout
- one of the two follow-up PRs may conflict after the other merges
- `archon-resolve-conflicts` should resolve the conflict, then its
  `merge-if-auto` node should merge the PR when the issue has
  `archon:auto-merge`

Success criteria:

- command exits with code `0`
- result artifact has `"completedEarly": true`
- all session issues are closed with `archon:done`
- all session PRs are `MERGED`
- the target repository contains the expected smoke-test merge commits

Useful checks after a run:

```bash
SESSION_ID=2026-05-01T18-13-44-278Z

jq '{sessionId, scenario, completedEarly}' \
  "packages/backlog-orchestrator/e2e/results/${SESSION_ID}/result.json"

gh issue list -R owner/name --label archon-test --state all --limit 20 \
  --json number,title,state,closedAt,labels \
  | jq -r --arg session "$SESSION_ID" \
    '.[] | select(.title|contains($session)) | "#\(.number) \(.state) labels=[\([.labels[].name]|join(","))] \(.title)"'

gh pr list -R owner/name --state all --limit 20 \
  --json number,title,state,mergedAt,headRefName,mergeable,isDraft \
  | jq -r --arg session "$SESSION_ID" \
    '.[] | select(.headRefName and (.headRefName|contains($session))) | "#\(.number) \(.state) draft=\(.isDraft) \(.headRefName) merged=\(.mergedAt) \(.title)"'
```
