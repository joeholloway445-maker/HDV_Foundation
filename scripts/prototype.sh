#!/usr/bin/env bash
#
# scripts/prototype.sh — ONE COMMAND to boot the marketable Big 5 Matrix prototype locally.
#
# What it does, in order:
#   1. Install deps if needed (npm ci, falling back to npm install)
#   2. Gate on quality: `npm run typecheck` + a fast programmatic smoke (`npm run smoke`)
#      (set PROTOTYPE_FULL_TESTS=1 to also run the full `npm test` suite)
#   3. Start the HOPE gateway on PORT (default 8787) in the background, recording its pid
#   4. Curl the marquee endpoints over the wire: health, intent, billing/pricing, waitlist, metrics
#   5. Print every URL / file path you can open: gateway, marketing page, showcase, waitlist, MCP
#   6. Keep the gateway alive so you can click around (Ctrl+C stops it); a trap always cleans up.
#      In CI mode (--ci or PROTOTYPE_CI=1) it stops the gateway and exits 0 after the curls.
#
# Usage:
#   npm run prototype                 # boot + verify, then keep the gateway running (Ctrl+C to stop)
#   ./scripts/prototype.sh --ci       # boot + verify, then stop and exit (automation-friendly)
#   PORT=9090 npm run prototype       # custom port
#   PROTOTYPE_FULL_TESTS=1 npm run prototype   # also run the full test suite in the gate
#
# It NEVER bypasses APEX/KNOLL — it only talks to HOPE's public HTTP surface, exactly like any
# other client would.
set -euo pipefail

# ---------------------------------------------------------------------------
# 0. Locate the repo root (this script lives in <root>/scripts) and set config.
# ---------------------------------------------------------------------------
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
cd "${ROOT_DIR}"

PORT="${PORT:-8787}"
BASE_URL="http://localhost:${PORT}"
CI_MODE=0
if [[ "${PROTOTYPE_CI:-0}" == "1" ]]; then CI_MODE=1; fi
for arg in "$@"; do
  case "${arg}" in
    --ci) CI_MODE=1 ;;
    -h|--help)
      grep -E '^#( |$)' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
      exit 0
      ;;
    *) echo "prototype.sh: unknown argument '${arg}' (try --ci or --help)" >&2; exit 2 ;;
  esac
done

GATEWAY_PID=""
GATEWAY_LOG="$(mktemp -t hdv-gateway.XXXXXX.log)"

# Colors only when attached to a terminal (keeps CI logs clean).
if [[ -t 1 ]]; then
  BOLD="$(printf '\033[1m')"; DIM="$(printf '\033[2m')"; RESET="$(printf '\033[0m')"
  GREEN="$(printf '\033[32m')"; RED="$(printf '\033[31m')"; CYAN="$(printf '\033[36m')"
else
  BOLD=""; DIM=""; RESET=""; GREEN=""; RED=""; CYAN=""
fi

step()  { echo; echo "${BOLD}${CYAN}==>${RESET} ${BOLD}$*${RESET}"; }
info()  { echo "    $*"; }
ok()    { echo "    ${GREEN}✓${RESET} $*"; }
warn()  { echo "    ${RED}!${RESET} $*" >&2; }
die()   { echo "${RED}${BOLD}prototype.sh failed:${RESET} $*" >&2; exit 1; }

# ---------------------------------------------------------------------------
# Cleanup trap — always stop the gateway we started, and show its log tail on error.
# ---------------------------------------------------------------------------
# Signal the gateway's whole process group. `npm run gateway` → tsx → node is a tree; killing
# only the leader would orphan the node child and leave the port held. Because we launch it under
# monitor mode (`set -m`), the job gets its own process group whose id equals GATEWAY_PID, so a
# negative-pid kill reaps the entire tree.
stop_gateway() {
  local sig="${1:-TERM}"
  [[ -n "${GATEWAY_PID}" ]] || return 0
  kill "-${sig}" "-${GATEWAY_PID}" 2>/dev/null || kill "-${sig}" "${GATEWAY_PID}" 2>/dev/null || true
}

cleanup() {
  local code=$?
  if [[ -n "${GATEWAY_PID}" ]] && kill -0 "${GATEWAY_PID}" 2>/dev/null; then
    echo
    info "stopping gateway (pid ${GATEWAY_PID})…"
    stop_gateway TERM
    # Give it a moment to release the port, then force-kill any stragglers.
    for _ in $(seq 1 10); do kill -0 "${GATEWAY_PID}" 2>/dev/null || break; sleep 0.2; done
    kill -0 "${GATEWAY_PID}" 2>/dev/null && stop_gateway KILL
    wait "${GATEWAY_PID}" 2>/dev/null || true
  fi
  if [[ ${code} -ne 0 && -s "${GATEWAY_LOG}" ]]; then
    echo
    warn "last gateway log lines (${GATEWAY_LOG}):"
    tail -n 20 "${GATEWAY_LOG}" >&2 || true
  fi
  rm -f "${GATEWAY_LOG}" 2>/dev/null || true
}
trap cleanup EXIT
trap 'exit 130' INT TERM

# ---------------------------------------------------------------------------
# Preflight: required tools.
# ---------------------------------------------------------------------------
command -v node >/dev/null 2>&1 || die "node is required (see https://nodejs.org — need >=20)."
command -v npm  >/dev/null 2>&1 || die "npm is required."
command -v curl >/dev/null 2>&1 || die "curl is required for the endpoint checks."

echo "========================================================================"
echo "${BOLD}BIG 5 MATRIX — LOCAL PROTOTYPE BOOT${RESET}"
echo "HOPE gateway · KNOLL gate enforced · APEX sole router · metering by active-param-seconds"
echo "root: ${ROOT_DIR}"
echo "port: ${PORT}   mode: $([[ ${CI_MODE} -eq 1 ]] && echo 'CI (boot, verify, exit)' || echo 'interactive (stays running)')"
echo "========================================================================"

# ---------------------------------------------------------------------------
# 1. Install dependencies if needed.
# ---------------------------------------------------------------------------
step "1/5 Dependencies"
if [[ -d node_modules && -x node_modules/.bin/tsx ]]; then
  ok "node_modules present (skipping install; delete node_modules to force a clean install)"
else
  if [[ -f package-lock.json ]]; then
    info "running npm ci (clean, lockfile-exact)…"
    npm ci || { warn "npm ci failed; falling back to npm install"; npm install; }
  else
    info "no lockfile — running npm install…"
    npm install
  fi
  [[ -x node_modules/.bin/tsx ]] || die "install completed but tsx is missing — cannot run TypeScript entrypoints."
  ok "dependencies installed"
fi

# ---------------------------------------------------------------------------
# 2. Quality gate: typecheck + fast smoke (optionally the full test suite).
# ---------------------------------------------------------------------------
step "2/5 Quality gate (typecheck + smoke)"
info "typecheck (tsc --noEmit)…"
npm run typecheck >/dev/null 2>&1 && ok "typecheck clean" || die "typecheck failed — run 'npm run typecheck' to see errors."

info "programmatic smoke (gateway handlers, no port)…"
if npm run --silent smoke; then
  ok "smoke passed"
else
  die "smoke failed — run 'npm run smoke' to see which handler regressed."
fi

if [[ "${PROTOTYPE_FULL_TESTS:-0}" == "1" ]]; then
  info "PROTOTYPE_FULL_TESTS=1 → running the full test suite…"
  npm test >/dev/null 2>&1 && ok "full test suite green" || die "full test suite failed — run 'npm test'."
else
  info "${DIM}(set PROTOTYPE_FULL_TESTS=1 to also run the full 'npm test' suite)${RESET}"
fi

# ---------------------------------------------------------------------------
# 3. Start the gateway in the background and wait for it to become healthy.
# ---------------------------------------------------------------------------
step "3/5 Start HOPE gateway on port ${PORT}"
if curl -sf -o /dev/null "${BASE_URL}/v1/health" 2>/dev/null; then
  die "something is already listening on ${BASE_URL} — set PORT=<other> and retry."
fi

# Monitor mode (`set -m`) puts the background gateway in its OWN process group so cleanup can
# reap the whole npm→tsx→node tree (see stop_gateway). We flip it off again immediately after.
set -m
PORT="${PORT}" npm run --silent gateway >"${GATEWAY_LOG}" 2>&1 &
GATEWAY_PID=$!
set +m
info "gateway pid: ${GATEWAY_PID}  (log: ${GATEWAY_LOG})"

# Poll /v1/health until it answers 200 (or time out with the log tail).
HEALTHY=0
for _ in $(seq 1 50); do
  if ! kill -0 "${GATEWAY_PID}" 2>/dev/null; then
    warn "gateway process exited early; log:"; tail -n 20 "${GATEWAY_LOG}" >&2 || true
    die "gateway failed to start."
  fi
  code="$(curl -s -o /dev/null -w '%{http_code}' "${BASE_URL}/v1/health" 2>/dev/null || echo 000)"
  if [[ "${code}" == "200" ]]; then HEALTHY=1; break; fi
  sleep 0.2
done
[[ ${HEALTHY} -eq 1 ]] || die "gateway did not become healthy within ~10s (see ${GATEWAY_LOG})."
ok "gateway healthy at ${BASE_URL}"

# ---------------------------------------------------------------------------
# 4. Curl the marquee endpoints over the wire.
# ---------------------------------------------------------------------------
# hit <label> <method> <path> [json-body] [expected-code]
hit() {
  local label="$1" method="$2" path="$3" data="${4:-}" want="${5:-200}"
  local url="${BASE_URL}${path}" code body
  if [[ -n "${data}" ]]; then
    body="$(curl -s -w $'\n%{http_code}' -X "${method}" -H 'content-type: application/json' -d "${data}" "${url}" 2>/dev/null || true)"
  else
    body="$(curl -s -w $'\n%{http_code}' -X "${method}" "${url}" 2>/dev/null || true)"
  fi
  code="$(printf '%s' "${body}" | tail -n1)"
  body="$(printf '%s' "${body}" | sed '$d')"
  if [[ "${code}" == "${want}" ]]; then
    ok "${label} → ${method} ${path} [${code}]"
    printf '        %s\n' "${DIM}$(printf '%s' "${body}" | tr -d '\n' | cut -c1-140)${RESET}"
  else
    warn "${label} → ${method} ${path} [${code}, wanted ${want}]"
    printf '        %s\n' "$(printf '%s' "${body}" | tr -d '\n' | cut -c1-200)"
    CURL_FAILED=1
  fi
}

step "4/5 Live endpoint checks (over HTTP → HOPE → APEX → KNOLL)"
CURL_FAILED=0
hit "health"          GET  "/v1/health"
hit "intent"         POST "/v1/intent"   '{"utterance":"Simulate three go-to-market strategies for a new AI product."}'
hit "billing/pricing" GET "/v1/billing/pricing"
hit "waitlist"       POST "/v1/waitlist" "{\"email\":\"prototype+$(date +%s)@hdv.example\",\"name\":\"Prototype\",\"interestedTier\":\"PRO\"}" 201
hit "metrics"         GET "/v1/metrics"
[[ ${CURL_FAILED} -eq 0 ]] || die "one or more live endpoint checks failed (see output above)."

# ---------------------------------------------------------------------------
# 5. Print everything you can open.
# ---------------------------------------------------------------------------
step "5/5 Open the prototype"
cat <<EOF
    ${BOLD}Gateway (HOPE HTTP API)${RESET}
      ${CYAN}${BASE_URL}${RESET}
      health          ${BASE_URL}/v1/health
      pricing         ${BASE_URL}/v1/billing/pricing
      metrics         ${BASE_URL}/v1/metrics   (add ?format=prometheus for exposition)
      matrix stats    ${BASE_URL}/v1/matrix/stats
      POST /v1/intent          {"utterance":"..."}
      POST /v1/waitlist        {"email":"..."}

    ${BOLD}Static marketing / product surfaces${RESET} (no build step — open the files directly)
      marketing page  file://${ROOT_DIR}/marketing/index.html
      waitlist page   file://${ROOT_DIR}/marketing/waitlist.html   ${DIM}(?api=${BASE_URL} to post here)${RESET}
      showcase        file://${ROOT_DIR}/showcase/index.html
      ${DIM}macOS:  open marketing/index.html      Linux:  xdg-open marketing/index.html${RESET}
      ${DIM}or serve (no new deps):  npx serve marketing${RESET}

    ${BOLD}MCP (drive the matrix from Cursor / any MCP client)${RESET}
      start server    npm run mcp        ${DIM}(stdio JSON-RPC; logs to stderr)${RESET}
      config + tools  docs/MCP.md
      tools           hdv_intent · hdv_estimate_cost · hdv_health · hdv_models · hdv_usage

    ${BOLD}More${RESET}
      honest timeline docs/PROTOTYPE.md
      go-to-market    docs/GTM.md · deploy: deploy/HOSTINGER.md · deploy/OLLAMA.md
EOF

echo
echo "========================================================================"
if [[ ${CI_MODE} -eq 1 ]]; then
  ok "CI mode: all checks passed — stopping the gateway and exiting 0."
  echo "========================================================================"
  exit 0
fi

# Interactive mode: keep the gateway in the foreground so the user can click around.
echo "${BOLD}Gateway is running (pid ${GATEWAY_PID}).${RESET}"
echo "  Stop it:  press ${BOLD}Ctrl+C${RESET}  (or from another shell: kill -TERM -${GATEWAY_PID})"
echo "========================================================================"
wait "${GATEWAY_PID}"
