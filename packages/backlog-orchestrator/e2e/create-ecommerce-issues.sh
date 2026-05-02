#!/usr/bin/env bash
set -euo pipefail

repo="podlodka-ai-club/X15"
session_id="$(date -u +"%Y-%m-%dT%H-%M-%S-%3NZ")"
auto_merge=1

usage() {
  cat <<'EOF'
Usage: create-ecommerce-issues.sh [--repo owner/name] [--session id] [--no-auto-merge]

Creates the three disposable ecommerce live E2E issues with Archon backlog labels:
  1. Ecommerce app skeleton
  2. Ecommerce catalog interactions
  3. Ecommerce cart and checkout

The catalog and cart/checkout issues are marked as blocked by the skeleton issue.
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --repo)
      repo="${2:?Missing value for --repo}"
      shift 2
      ;;
    --session)
      session_id="${2:?Missing value for --session}"
      shift 2
      ;;
    --no-auto-merge)
      auto_merge=0
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "Unknown argument: $1" >&2
      usage >&2
      exit 2
      ;;
  esac
done

if [[ "$repo" != */* ]]; then
  echo "--repo must be owner/name" >&2
  exit 2
fi

command -v gh >/dev/null || {
  echo "Missing required command: gh" >&2
  exit 1
}

tmp_dir="$(mktemp -d)"
trap 'rm -rf "$tmp_dir"' EXIT

ensure_label() {
  local label="$1"
  local color="${2:-5319e7}"
  if gh label list --repo "$repo" --limit 1000 --json name --jq '.[].name' | grep -Fxq "$label"; then
    return
  fi
  gh label create "$label" --repo "$repo" --color "$color" >/dev/null
}

create_issue() {
  local title="$1"
  local body_file="$2"
  shift 2
  local body
  body="$(<"$body_file")"

  local args=(
    --method POST
    -H "Accept: application/vnd.github+json"
    -H "X-GitHub-Api-Version: 2026-03-10"
    "repos/$repo/issues"
    -f "title=$title"
    -f "body=$body"
  )

  local label
  for label in "$@"; do
    args+=(-f "labels[]=$label")
  done

  gh api "${args[@]}" --jq '.number'
}

add_blocked_by() {
  local issue_number="$1"
  local blocking_issue_number="$2"
  local blocking_issue_id

  blocking_issue_id="$(
    gh api \
      -H "Accept: application/vnd.github+json" \
      -H "X-GitHub-Api-Version: 2026-03-10" \
      "repos/$repo/issues/$blocking_issue_number" \
      --jq '.id'
  )"

  gh api \
    --method POST \
    -H "Accept: application/vnd.github+json" \
    -H "X-GitHub-Api-Version: 2026-03-10" \
    "repos/$repo/issues/$issue_number/dependencies/blocked_by" \
    -F "issue_id=$blocking_issue_id" >/dev/null
}

write_body() {
  local path="$1"
  local role="$2"
  local summary="$3"
  shift 3

  {
    echo "This disposable issue was created by the Archon harness ecommerce app live E2E runner."
    echo
    echo "Session: $session_id"
    echo "Role: $role"
    echo
    echo "Goal: $summary"
    echo
    echo "Acceptance criteria:"
    local criterion
    for criterion in "$@"; do
      echo "- $criterion"
    done
    echo
    echo "Safety constraints:"
    echo "- This is a live E2E test issue; keep the implementation intentionally small."
    echo "- Do not add external services, auth, payments, persistence, deploy config, or CI changes."
    echo "- Let the agent choose the file layout that best fits the current repository state."
  } >"$path"
}

labels=(
  "archon-e2e"
  "archon:ready"
  "archon-workflow:fix-issue-simple"
  "area:e2e"
)

if [[ "$auto_merge" -eq 1 ]]; then
  labels+=("archon:auto-merge")
  pr_merge_instruction="Open a PR and allow Archon to merge it automatically after verification."
else
  pr_merge_instruction="Open a PR but do not auto-merge this issue."
fi

ensure_label "archon-e2e" "d4c5f9"
ensure_label "archon:ready"
ensure_label "archon-workflow:fix-issue-simple"
ensure_label "archon:auto-merge"
ensure_label "area:e2e"

skeleton_body="$tmp_dir/skeleton.md"
catalog_body="$tmp_dir/catalog.md"
cart_body="$tmp_dir/cart-checkout.md"

write_body \
  "$skeleton_body" \
  "skeleton" \
  "Create the minimal runnable ecommerce storefront foundation." \
  "Create a small TypeScript browser app; choose the simplest structure and tooling that fits this empty repo." \
  "Render a storefront shell with a header, product grid or product cards, cart summary placeholder, and checkout placeholder." \
  "Include npm scripts for type-check, lint, format:check, test, and build that can run successfully in this tiny repo." \
  "Keep the implementation focused on the ecommerce app and avoid generated build/dependency output in git."

write_body \
  "$catalog_body" \
  "catalog" \
  "Add real catalog browsing behavior to the storefront." \
  "Add category filtering, text search, and price sorting over the product data from the skeleton." \
  "Choose appropriate files and function boundaries based on the skeleton implementation." \
  "Add focused tests for the catalog behavior." \
  "Wire the catalog behavior into the existing storefront UI while minimizing conflicts with cart/checkout work." \
  "$pr_merge_instruction"

write_body \
  "$cart_body" \
  "cart-checkout" \
  "Add cart totals and checkout confirmation behavior to the storefront." \
  "Add pure cart helpers for add, remove, quantity updates, subtotal, shipping, tax, and total." \
  "Add checkout validation for name, email, and shipping address plus a deterministic order confirmation id." \
  "Choose appropriate files and function boundaries based on the skeleton implementation." \
  "Add focused tests for cart and checkout behavior." \
  "Wire cart and checkout behavior into the existing storefront UI while minimizing conflicts with catalog work." \
  "$pr_merge_instruction"

echo "Creating ecommerce E2E issues in $repo"
echo "Session: $session_id"

skeleton_number="$(
  create_issue "[archon-e2e:$session_id] Ecommerce app skeleton" "$skeleton_body" "${labels[@]}"
)"
catalog_number="$(
  create_issue "[archon-e2e:$session_id] Ecommerce catalog interactions" "$catalog_body" "${labels[@]}"
)"
cart_number="$(
  create_issue "[archon-e2e:$session_id] Ecommerce cart and checkout" "$cart_body" "${labels[@]}"
)"

add_blocked_by "$catalog_number" "$skeleton_number"
add_blocked_by "$cart_number" "$skeleton_number"

echo "Created issues:"
echo "  Skeleton:      #$skeleton_number"
echo "  Catalog:       #$catalog_number blocked by #$skeleton_number"
echo "  Cart checkout: #$cart_number blocked by #$skeleton_number"
echo
echo "View them:"
echo "  gh issue list --repo $repo --search \"archon-e2e:$session_id\" --state all"
