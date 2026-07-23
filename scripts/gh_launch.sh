#!/usr/bin/env bash
# gh_launch.sh — GitHub launch helpers for the HDV Foundation repo.
#
# Safe by default: with no flags it prints status only (read-only). All
# mutating actions are opt-in via explicit flags. If the GitHub API lacks the
# permission (e.g. no admin scope on the repo), the script prints the exact
# manual steps to do the same thing in the GitHub web UI instead of failing.
#
# Usage:
#   bash scripts/gh_launch.sh [--status] [--public] [--protect-main] [-h|--help]
#
# Flags:
#   --status         Print repo visibility, default branch, CI workflow, and
#                    current branch-protection state (read-only). Default when
#                    no other action flag is given.
#   --public         Make the repository public (gh repo edit --visibility public).
#   --protect-main   Require the CI status check on main before merge, via the
#                    GitHub branch-protection API (gh api).
#   -h, --help       Show this help.
#
# Requirements: gh (GitHub CLI), authenticated (`gh auth login`). Nothing here
# commits, pushes, or merges. It only edits repo settings you explicitly ask for.

set -euo pipefail

# --- constants ---------------------------------------------------------------
CI_CHECK_CONTEXT="node"        # CI job name that must pass (see .github/workflows/ci.yml)
CI_CHECK_CONTEXT_ALT="python"  # second CI job name
DEFAULT_BRANCH="main"

# --- pretty output helpers ---------------------------------------------------
bold() { printf '\033[1m%s\033[0m\n' "$*"; }
info() { printf '  %s\n' "$*"; }
ok()   { printf '  \033[32m✓\033[0m %s\n' "$*"; }
warn() { printf '  \033[33m!\033[0m %s\n' "$*"; }
err()  { printf '  \033[31m✗\033[0m %s\n' "$*" >&2; }
rule() { printf -- '--------------------------------------------------------------\n'; }

usage() {
  # Print the leading comment header (everything from line 2 up to the first
  # non-comment line), stripping the leading "# ".
  awk 'NR==1{next} /^#/{sub(/^# ?/,""); print; next} {exit}' "$0"
}

# --- preflight: gh present & authenticated -----------------------------------
require_gh() {
  if ! command -v gh >/dev/null 2>&1; then
    err "GitHub CLI (gh) is not installed."
    info "Install: https://cli.github.com/  then run: gh auth login"
    return 1
  fi
  if ! gh auth status >/dev/null 2>&1; then
    err "GitHub CLI is not authenticated."
    info "Run: gh auth login   (needs 'repo' + 'admin:repo' for protection)"
    return 1
  fi
  return 0
}

# Resolve owner/repo from the current git remote (via gh).
repo_slug() {
  gh repo view --json nameWithOwner -q .nameWithOwner 2>/dev/null || true
}

# --- manual fallbacks (printed when the API can't do it) ---------------------
manual_public() {
  local slug="$1"
  rule
  bold "Manual steps — make the repo PUBLIC"
  info "1. Open: https://github.com/${slug}/settings"
  info "2. Scroll to the 'Danger Zone' at the bottom."
  info "3. Click 'Change repository visibility' → 'Change to public'."
  info "4. Confirm by typing the repo name."
  rule
}

manual_protect() {
  local slug="$1"
  rule
  bold "Manual steps — protect the '${DEFAULT_BRANCH}' branch (require CI)"
  info "1. Open: https://github.com/${slug}/settings/branches"
  info "2. 'Add branch ruleset' (or classic 'Add rule')."
  info "3. Branch name pattern: ${DEFAULT_BRANCH}"
  info "4. Enable 'Require status checks to pass before merging'."
  info "5. Search & add these required checks: '${CI_CHECK_CONTEXT}' and '${CI_CHECK_CONTEXT_ALT}'."
  info "6. (Recommended) Enable 'Require a pull request before merging'."
  info "7. Save changes."
  rule
}

# --- actions -----------------------------------------------------------------
do_status() {
  local slug="$1"
  bold "HDV Foundation — GitHub launch status"
  info "Repo: ${slug}"
  rule

  # Visibility
  local vis
  vis="$(gh repo view "$slug" --json visibility -q .visibility 2>/dev/null || echo 'unknown')"
  if [ "$vis" = "PUBLIC" ] || [ "$vis" = "public" ]; then
    ok "Visibility: PUBLIC"
  else
    warn "Visibility: ${vis} (run: bash scripts/gh_launch.sh --public)"
  fi

  # Default branch
  local defbr
  defbr="$(gh repo view "$slug" --json defaultBranchRef -q .defaultBranchRef.name 2>/dev/null || echo 'unknown')"
  info "Default branch: ${defbr}"

  # CI workflow presence
  if [ -f ".github/workflows/ci.yml" ]; then
    ok "CI workflow present (.github/workflows/ci.yml)"
  else
    warn "CI workflow (.github/workflows/ci.yml) not found in working tree."
  fi

  # Branch protection state (may be forbidden without admin)
  if gh api "repos/${slug}/branches/${DEFAULT_BRANCH}/protection" >/dev/null 2>&1; then
    ok "Branch protection: ENABLED on '${DEFAULT_BRANCH}'"
    local checks
    checks="$(gh api "repos/${slug}/branches/${DEFAULT_BRANCH}/protection/required_status_checks" \
      -q '.contexts | join(", ")' 2>/dev/null || true)"
    [ -n "$checks" ] && info "Required checks: ${checks}"
  else
    warn "Branch protection: not set / not readable on '${DEFAULT_BRANCH}'."
    info "Enable with: bash scripts/gh_launch.sh --protect-main"
  fi
  rule
}

do_public() {
  local slug="$1"
  bold "Making repository PUBLIC…"
  if gh repo edit "$slug" --visibility public --accept-visibility-change-consequences >/dev/null 2>&1 \
     || gh repo edit "$slug" --visibility public >/dev/null 2>&1; then
    ok "Repository is now PUBLIC: https://github.com/${slug}"
  else
    err "Could not change visibility via the API (likely missing admin permission)."
    manual_public "$slug"
    return 1
  fi
}

do_protect_main() {
  local slug="$1"
  bold "Protecting '${DEFAULT_BRANCH}' — require CI checks before merge…"

  # Build the protection payload. Requires the CI status checks to pass and a
  # PR before merging; keeps admins enforceable. strict=true => branch must be
  # up to date before merging.
  local payload
  payload="$(cat <<JSON
{
  "required_status_checks": {
    "strict": true,
    "contexts": ["${CI_CHECK_CONTEXT}", "${CI_CHECK_CONTEXT_ALT}"]
  },
  "enforce_admins": true,
  "required_pull_request_reviews": {
    "required_approving_review_count": 0
  },
  "restrictions": null
}
JSON
)"

  if printf '%s' "$payload" | gh api -X PUT \
      -H "Accept: application/vnd.github+json" \
      "repos/${slug}/branches/${DEFAULT_BRANCH}/protection" \
      --input - >/dev/null 2>&1; then
    ok "Branch protection applied to '${DEFAULT_BRANCH}' (requires: ${CI_CHECK_CONTEXT}, ${CI_CHECK_CONTEXT_ALT})."
  else
    err "Could not set branch protection via the API (needs admin on the repo)."
    manual_protect "$slug"
    return 1
  fi
}

# --- arg parsing -------------------------------------------------------------
WANT_STATUS=0
WANT_PUBLIC=0
WANT_PROTECT=0

if [ "$#" -eq 0 ]; then
  WANT_STATUS=1
fi

while [ "$#" -gt 0 ]; do
  case "$1" in
    --status)       WANT_STATUS=1 ;;
    --public)       WANT_PUBLIC=1 ;;
    --protect-main) WANT_PROTECT=1 ;;
    -h|--help)      usage; exit 0 ;;
    *)
      err "Unknown flag: $1"
      usage
      exit 2
      ;;
  esac
  shift
done

# --- main --------------------------------------------------------------------
main() {
  if ! require_gh; then
    warn "gh unavailable/unauthenticated — printing manual steps only."
    local slug="joeholloway445-maker/HDV_Foundation"
    [ "$WANT_PUBLIC" -eq 1 ]  && manual_public "$slug"
    [ "$WANT_PROTECT" -eq 1 ] && manual_protect "$slug"
    [ "$WANT_STATUS" -eq 1 ] && { rule; info "Cannot read live status without gh. See settings: https://github.com/${slug}/settings"; }
    return 1
  fi

  local slug
  slug="$(repo_slug)"
  if [ -z "$slug" ]; then
    err "Could not resolve the repository (are you in the repo, with a GitHub remote?)."
    return 1
  fi

  local rc=0
  [ "$WANT_PUBLIC" -eq 1 ]  && { do_public "$slug"  || rc=1; }
  [ "$WANT_PROTECT" -eq 1 ] && { do_protect_main "$slug" || rc=1; }
  [ "$WANT_STATUS" -eq 1 ]  && do_status "$slug"

  return "$rc"
}

main
