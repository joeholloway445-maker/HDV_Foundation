#!/usr/bin/env bash
#
# scripts/verify_public.sh — verify a LIVE HDV Foundation HOPE gateway over its public surface.
#
# Curls a BASE_URL and checks the marquee public/marketing endpoints:
#   1. GET  /v1/health          -> 200   (always public)
#   2. GET  /v1/billing/pricing -> 200   (always public — marketing pricing)
#   3. POST /v1/waitlist        -> 201 (new) or 200 (idempotent re-signup)   (public, rate-limited)
#   4. GET  /v1/metrics         -> 200 with HDV_API_KEY, else expects 401 (auth enforced)
#
# It also asserts auth is ENFORCED: a protected route must return 401 WITHOUT the key.
# Exits NON-ZERO if any check fails (CI/handoff friendly).
#
# Usage:
#   BASE_URL="https://api.yourdomain.com" bash scripts/verify_public.sh
#   BASE_URL=... HDV_API_KEY=... npm run verify:public
#   BASE_URL="http://127.0.0.1:8787" bash scripts/verify_public.sh   # local gateway
#
# Env:
#   BASE_URL       base URL of the gateway (default: http://localhost:8787)
#   HDV_API_KEY    API key for protected routes (optional; enables the metrics 200 check +
#                  the "401 without key -> 200 with key" auth assertion)
#   CURL_TIMEOUT   per-request timeout in seconds (default: 15)
#
# This only talks to HOPE's public HTTP surface — exactly like any other client. It never
# bypasses APEX/KNOLL and touches no invariant.
set -uo pipefail

BASE_URL="${BASE_URL:-http://localhost:8787}"
BASE_URL="${BASE_URL%/}"   # strip a trailing slash so ${BASE_URL}/v1/... is clean
HDV_API_KEY="${HDV_API_KEY:-}"
CURL_TIMEOUT="${CURL_TIMEOUT:-15}"

# Colors only when attached to a terminal.
if [ -t 1 ]; then
  BOLD="$(printf '\033[1m')"; RESET="$(printf '\033[0m')"
  GREEN="$(printf '\033[32m')"; RED="$(printf '\033[31m')"; CYAN="$(printf '\033[36m')"; DIM="$(printf '\033[2m')"
else
  BOLD=""; RESET=""; GREEN=""; RED=""; CYAN=""; DIM=""
fi

command -v curl >/dev/null 2>&1 || { echo "${RED}verify_public.sh: curl is required.${RESET}" >&2; exit 2; }

FAILURES=0
ok()   { echo "  ${GREEN}✓${RESET} $*"; }
bad()  { echo "  ${RED}✗${RESET} $*" >&2; FAILURES=$((FAILURES + 1)); }
body_preview() { printf '      %s\n' "${DIM}$(printf '%s' "$1" | tr -d '\n' | cut -c1-140)${RESET}"; }

# curl_status <method> <path> [json-body] [extra-header]
# echoes: "<http_code>\n<body>"
curl_call() {
  local method="$1" path="$2" data="${3:-}" hdr="${4:-}"
  local url="${BASE_URL}${path}"
  local args=(-s --max-time "${CURL_TIMEOUT}" -w $'\n%{http_code}' -X "${method}")
  [ -n "${hdr}" ] && args+=(-H "${hdr}")
  if [ -n "${data}" ]; then
    args+=(-H 'content-type: application/json' -d "${data}")
  fi
  curl "${args[@]}" "${url}" 2>/dev/null || printf '\n000'
}

# check <label> <method> <path> <expected-codes-csv> [json-body] [extra-header]
check() {
  local label="$1" method="$2" path="$3" want="$4" data="${5:-}" hdr="${6:-}"
  local out code body
  out="$(curl_call "${method}" "${path}" "${data}" "${hdr}")"
  code="$(printf '%s' "${out}" | tail -n1)"
  body="$(printf '%s' "${out}" | sed '$d')"
  case ",${want}," in
    *",${code},"*)
      ok "${label} — ${method} ${path} [${code}]"
      [ -n "${body}" ] && body_preview "${body}"
      ;;
    *)
      bad "${label} — ${method} ${path} [got ${code}, wanted ${want}]"
      [ -n "${body}" ] && body_preview "${body}"
      ;;
  esac
}

echo "========================================================================"
echo "${BOLD}HDV Foundation — public surface verification${RESET}"
echo "base: ${CYAN}${BASE_URL}${RESET}"
echo "key : $([ -n "${HDV_API_KEY}" ] && echo 'HDV_API_KEY set (auth checks enabled)' || echo 'no HDV_API_KEY (protected checks limited)')"
echo "========================================================================"

# 1) Health — always public.
check "health"  GET "/v1/health" "200"

# 2) Pricing — always public (marketing).
check "pricing" GET "/v1/billing/pricing" "200"

# 3) Waitlist — public, rate-limited. 201 new, 200 idempotent re-signup, (429 if rate-limited).
WAITLIST_BODY="{\"email\":\"verify+$(date +%s)@hdv.example\",\"name\":\"Verify\",\"company\":\"HDV\",\"interestedTier\":\"PRO\",\"useCase\":\"public verify\"}"
check "waitlist" POST "/v1/waitlist" "200,201" "${WAITLIST_BODY}"

# 4) Metrics — protected. With a key: expect 200. Without: expect 401 (auth enforced).
if [ -n "${HDV_API_KEY}" ]; then
  check "metrics (with key)" GET "/v1/metrics" "200" "" "X-HDV-Key: ${HDV_API_KEY}"
  # Auth-enforcement assertion: the SAME route must reject an unauthenticated request.
  check "auth enforced (no key -> 401)" GET "/v1/metrics" "401"
else
  # No key provided: we can still assert the route is protected (401), which proves auth is on.
  echo "  ${DIM}(no HDV_API_KEY — checking that protected /v1/metrics is 401 to prove auth is on)${RESET}"
  check "metrics protected (no key -> 401)" GET "/v1/metrics" "401"
fi

echo "========================================================================"
if [ "${FAILURES}" -eq 0 ]; then
  echo "${GREEN}${BOLD}ALL CHECKS PASSED${RESET} — ${BASE_URL} public surface is healthy."
  echo "========================================================================"
  exit 0
else
  echo "${RED}${BOLD}${FAILURES} CHECK(S) FAILED${RESET} — see output above."
  echo "========================================================================"
  exit 1
fi
