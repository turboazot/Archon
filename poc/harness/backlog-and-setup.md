# Backlog And Setup

## POC Backlog Scenario

Create these issues after merging the ecommerce seed PR.

### Issue 1: Add Product Inventory Field

Labels:

```text
archon:ready
archon-workflow:fix-issue
area:products
```

Acceptance criteria:

- Products support `inventoryQuantity`.
- Create/update validation requires integer `inventoryQuantity >= 0`.
- Product responses include `inventoryQuantity`.
- Existing product tests are updated.
- README documents the field.
- Type-check, lint, test, and format pass.

### Issue 2: Add Catalog Visibility Filtering

Labels:

```text
archon:ready
archon-workflow:fix-issue
area:catalogs
```

Acceptance criteria:

- Catalogs support `visibility: "public" | "private"`.
- Create/update validation defaults to `public`.
- `GET /catalogs?visibility=public` filters catalogs.
- Tests cover default visibility and filtering.
- README documents the query parameter.
- Type-check, lint, test, and format pass.

### Issue 3: Add Product Search By Name

Labels:

```text
archon:ready
archon-workflow:fix-issue
area:products
```

Acceptance criteria:

- `GET /products?q=shirt` filters products by case-insensitive name substring.
- Empty or missing `q` preserves existing list behavior.
- Tests cover match, no match, and case-insensitive search.
- README documents the query parameter.
- Type-check, lint, test, and format pass.

Expected scheduling behavior:

```text
If area labels are used as locks, Issue 3 should be blocked while Issue 1 is active because both are area:products.
```

### Issue 4: Add API Error Code Documentation

Labels:

```text
archon:ready
archon-workflow:docs
area:docs
archon:auto-merge
```

Acceptance criteria:

- README documents the common error response shape.
- README lists validation, not found, and conflict examples.
- No code changes except docs.
- Format check passes.

Expected scheduling behavior:

```text
This can run alongside one product issue and one catalog issue if area locks are enabled because it is area:docs.
Because it has archon:auto-merge, the orchestrator may merge it after green CI and clean Archon review.
```

### Issue 5: Add Metrics Endpoint

Labels:

```text
archon:ready
archon-workflow:ralph
area:infra
```

Acceptance criteria:

- `GET /metrics` returns JSON with product count, catalog count, and membership count.
- App wires repositories into a metrics route.
- Tests cover empty and populated state.
- README documents the endpoint.
- Type-check, lint, test, and format pass.

Expected scheduling behavior:

```text
If this depends on Issue 1 or Issue 2, model that with GitHub issue dependencies.
This is routed to `archon-ralph-dag` because the user applied `archon-workflow:ralph`.
```

## Expected POC Run

With `max_parallel_workflows = 3` and no active PRs:

```text
Start:
- Issue 1: product inventory
- Issue 2: catalog visibility
- Issue 4: docs-only error documentation

Block:
- Issue 3: blocked by area:products if area locks are enabled
- Issue 5: blocked only if it has unresolved GitHub issue dependencies or an area lock conflict
```

After human merges Issue 1:

```text
Start:
- Issue 3: product search
```

After Issue 2 is merged:

```text
Consider:
- Issue 5: metrics endpoint
```

## GitHub CLI Setup Commands

Create labels:

```bash
cd ~/projects/misc/harness

for label in \
  archon:ready archon:in-progress archon:blocked archon:pr-open \
  archon:ready-for-review archon:needs-fix archon:done archon:auto-merge \
  archon-workflow:ralph archon-workflow:fix-issue archon-workflow:review-pr \
  archon-workflow:docs archon-workflow:test-loop archon-workflow:refactor \
  area:products area:catalogs area:docs area:infra
do
  gh label create "$label" --force
done
```

Create Issue 1:

```bash
gh issue create \
  --title "Add product inventory field" \
  --label "archon:ready,archon-workflow:fix-issue,area:products" \
  --body "$(cat <<'EOF'
## Goal

Products should track available inventory.

## Acceptance Criteria

- Products support `inventoryQuantity`.
- Create/update validation requires integer `inventoryQuantity >= 0`.
- Product responses include `inventoryQuantity`.
- Existing product tests are updated.
- README documents the field.
- Type-check, lint, test, and format pass.
EOF
)"
```

Use the same structure to create the remaining issues. Add dependencies through GitHub issue relationships instead of body text when one issue must wait for another.
