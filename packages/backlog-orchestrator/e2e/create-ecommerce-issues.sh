#!/usr/bin/env bash
set -euo pipefail

repo=""
session_id="$(date -u +"%Y-%m-%dT%H-%M-%S-%3NZ")"
auto_merge=1
title_prefix=""

usage() {
  cat <<'EOF'
Usage: create-ecommerce-issues.sh --repo owner/name [--session id] [--title-prefix text] [--no-auto-merge]

Creates four disposable ecommerce live test issues with Archon backlog labels:
  1. Ecommerce app skeleton
  2. Ecommerce catalog interactions
  3. Ecommerce cart and checkout
  4. Record ecommerce Playwright video

The catalog and cart/checkout issues are blocked by the skeleton issue.
The video recording issue is blocked by catalog and cart/checkout.
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
    --title-prefix)
      title_prefix="${2:?Missing value for --title-prefix}"
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

if [[ -z "$repo" ]]; then
  echo "Missing required --repo owner/name" >&2
  usage >&2
  exit 2
fi

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
    echo "This disposable issue was created by the Archon harness ecommerce app live test runner."
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
    echo "- This is a live test issue; keep the implementation intentionally small."
    echo "- Do not add external services, auth, payments, persistence, deploy config, or CI changes."
    echo "- Let the agent choose the file layout that best fits the current repository state."
  } >"$path"
}

labels=(
  "archon:ready"
  "archon-workflow:fix-issue-simple"
)

if [[ "$auto_merge" -eq 1 ]]; then
  labels+=("archon:auto-merge")
  pr_merge_instruction="Open a PR and allow Archon to merge it automatically after verification."
else
  pr_merge_instruction="Open a PR but do not auto-merge this issue."
fi

ensure_label "archon:ready"
ensure_label "archon-workflow:fix-issue-simple"
ensure_label "archon-workflow:video-recording"
ensure_label "archon:auto-merge"

skeleton_body="$tmp_dir/skeleton.md"
catalog_body="$tmp_dir/catalog.md"
cart_body="$tmp_dir/cart-checkout.md"
video_body="$tmp_dir/video-recording.md"

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

write_body \
  "$video_body" \
  "video-recording" \
  "Record a short Playwright video after the ecommerce app work is complete." \
  "Inspect the repository and identify the simplest runnable user-facing UI." \
  "Start the application locally using the repo conventions." \
  "Exercise one short happy path that a real user would recognize as the app working." \
  "Prefer a path that reaches a meaningful loaded or interactive state rather than only checking that the page renders." \
  "Record the browser session while performing the flow and produce a final MP4 artifact." \
  "Add brief pauses after the page loads, after meaningful interactions, and on the final success state so the recording is easy to follow." \
  "Verify at least one visible outcome that proves the happy path succeeded." \
  "Comment on this issue with the GitHub-hosted raw MP4 link."

echo "Creating ecommerce test issues in $repo"
echo "Session: $session_id"

skeleton_number="$(
  create_issue "${title_prefix}Ecommerce app skeleton" "$skeleton_body" "${labels[@]}"
)"
catalog_number="$(
  create_issue "${title_prefix}Ecommerce catalog interactions" "$catalog_body" "${labels[@]}"
)"
cart_number="$(
  create_issue "${title_prefix}Ecommerce cart and checkout" "$cart_body" "${labels[@]}"
)"
video_number="$(
  create_issue \
    "${title_prefix}Record ecommerce Playwright video" \
    "$video_body" \
    "archon:ready" \
    "archon-workflow:video-recording"
)"

add_blocked_by "$catalog_number" "$skeleton_number"
add_blocked_by "$cart_number" "$skeleton_number"
add_blocked_by "$video_number" "$catalog_number"
add_blocked_by "$video_number" "$cart_number"

echo "Created issues:"
echo "  Skeleton:      #$skeleton_number"
echo "  Catalog:       #$catalog_number blocked by #$skeleton_number"
echo "  Cart checkout: #$cart_number blocked by #$skeleton_number"
echo "  Video:         #$video_number blocked by #$catalog_number and #$cart_number"
echo
echo "View them:"
echo "  gh issue list --repo $repo --search \"$session_id\" --state all"
