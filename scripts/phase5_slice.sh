#!/usr/bin/env bash
#
# scripts/phase5_slice.sh — ONE COMMAND for the Phase 5 real end-to-end slice.
#
# Phase 5's exit criterion: "one documented command spins up Kafka + Postgres + one worker."
# This is that command. It wires the REAL infrastructure paths that ship behind seams:
#
#   1. If Docker is available: `docker compose up -d postgres kafka`, wait for health, then
#      apply the Prisma schema (`npm run db:push`).
#   2. Export the env that flips the gateway onto the durable + async paths:
#         DATABASE_URL   → APEX ledger + KNOLL audit mirrored to Postgres (hydrate on boot)
#         HDV_QUEUE=kafka + KAFKA_BROKERS → Kafka-backed APEX intake queue
#   3. Start the HOPE gateway (background), wait for /v1/health.
#   4. Run ONE ephemeral worker (colab/worker_job.py) that runs a persona batch and POSTs its
#      WorkerReport to the gateway → APEX re-ingests it (→ KNOLL → HOPE).
#   5. Read back /v1/ledger + /v1/audit to prove the slice went end-to-end, then clean up.
#
# NO DOCKER? The script prints a clear, copy-pasteable OFFLINE fallback (in-memory queue +
# in-memory persistence + `worker_job.py --offline`) and, unless --strict is given, RUNS it so
# you still see a green end-to-end slice with zero infra.
#
# Usage:
#   bash scripts/phase5_slice.sh          # full slice if Docker is present, else offline fallback
#   bash scripts/phase5_slice.sh --offline  # force the offline fallback (no Docker)
#   bash scripts/phase5_slice.sh --strict   # require Docker; fail (don't fall back) if missing
#   KEEP_UP=1 bash scripts/phase5_slice.sh  # leave the gateway + compose services running
#
# It NEVER bypasses APEX/KNOLL — the worker only talks to HOPE's public /v1/worker/report.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
cd "${ROOT_DIR}"

PORT="${PORT:-8787}"
BASE_URL="http://localhost:${PORT}"
FORCE_OFFLINE=0
STRICT=0
KEEP_UP="${KEEP_UP:-0}"

for arg in "$@"; do
  case "${arg}" in
    --offline) FORCE_OFFLINE=1 ;;
    --strict) STRICT=1 ;;
    -h|--help)
      grep -E '^#( |$)' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
      exit 0
      ;;
    *) echo "phase5_slice.sh: unknown argument '${arg}' (try --offline, --strict, or --help)" >&2; exit 2 ;;
  esac
done

log()  { printf '\n\033[1;36m▶ %s\033[0m\n' "$*"; }
ok()   { printf '\033[1;32m✓ %s\033[0m\n' "$*"; }
warn() { printf '\033[1;33m! %s\033[0m\n' "$*" >&2; }

GATEWAY_PID=""
COMPOSE_UP=0
GATEWAY_LOG="$(mktemp -t hdv-phase5.XXXXXX.log)"

compose() {
  if docker compose version >/dev/null 2>&1; then docker compose "$@"; else docker-compose "$@"; fi
}

cleanup() {
  if [[ -n "${GATEWAY_PID}" ]] && kill -0 "${GATEWAY_PID}" 2>/dev/null; then
    kill "${GATEWAY_PID}" 2>/dev/null || true
    wait "${GATEWAY_PID}" 2>/dev/null || true
  fi
  if [[ "${COMPOSE_UP}" == "1" && "${KEEP_UP}" != "1" ]]; then
    log "Tearing down compose services (set KEEP_UP=1 to keep them)…"
    compose stop postgres kafka >/dev/null 2>&1 || true
  fi
}
trap cleanup EXIT INT TERM

wait_for_health() {
  local url="$1" tries="${2:-60}"
  for _ in $(seq 1 "${tries}"); do
    if curl -fsS "${url}" >/dev/null 2>&1; then return 0; fi
    sleep 1
  done
  return 1
}

have_docker() { command -v docker >/dev/null 2>&1 && docker info >/dev/null 2>&1; }

# ---------------------------------------------------------------------------
# OFFLINE fallback — no Docker required. In-memory queue + in-memory persistence.
# ---------------------------------------------------------------------------
run_offline() {
  cat <<'EOF'

────────────────────────────────────────────────────────────────────────────
OFFLINE FALLBACK (no Docker) — the same slice with zero infra.

The backbone is offline-first, so the real code paths still run end-to-end using
the in-memory queue + in-memory ledger/audit. To reproduce manually:

  # terminal 1 — gateway (in-memory queue + persistence):
  npm run gateway

  # terminal 2 — one ephemeral worker reporting to the gateway:
  GATEWAY_URL=http://localhost:8787 python3 colab/worker_job.py --role DREAM --batch 25

  # or fully standalone (prints the payload, no gateway needed):
  python3 colab/worker_job.py --role DREAM --batch 25 --offline

For the REAL Kafka + Postgres slice, install Docker and re-run this script.
────────────────────────────────────────────────────────────────────────────
EOF

  log "Running the offline slice now…"
  log "Boot gateway (in-memory queue + persistence) on ${BASE_URL}"
  PORT="${PORT}" npm run gateway >"${GATEWAY_LOG}" 2>&1 &
  GATEWAY_PID=$!
  if ! wait_for_health "${BASE_URL}/v1/health" 40; then
    warn "gateway did not become healthy; log tail:"; tail -n 30 "${GATEWAY_LOG}" >&2; exit 1
  fi
  ok "gateway healthy"

  log "Run one ephemeral DREAM worker → POST /v1/worker/report (APEX → KNOLL → HOPE)"
  GATEWAY_URL="${BASE_URL}" python3 colab/worker_job.py --role DREAM --batch 25

  log "Read back the ledger + audit (proof the slice reached APEX/KNOLL)"
  curl -fsS "${BASE_URL}/v1/ledger" | head -c 600; echo
  curl -fsS "${BASE_URL}/v1/audit"  | head -c 600; echo
  ok "OFFLINE Phase 5 slice complete."
}

# ---------------------------------------------------------------------------
# FULL slice — Docker: Postgres + Kafka + gateway + worker.
# ---------------------------------------------------------------------------
run_full() {
  log "Docker detected — bringing up Postgres + Kafka"
  compose up -d postgres kafka
  COMPOSE_UP=1

  log "Waiting for Postgres + Kafka to report healthy…"
  for _ in $(seq 1 60); do
    local pg kf
    pg="$(compose ps --format '{{.Service}} {{.Health}}' 2>/dev/null | awk '$1=="postgres"{print $2}')"
    kf="$(compose ps --format '{{.Service}} {{.Health}}' 2>/dev/null | awk '$1=="kafka"{print $2}')"
    if [[ "${pg}" == "healthy" && "${kf}" == "healthy" ]]; then break; fi
    sleep 2
  done
  ok "infrastructure up"

  export DATABASE_URL="${DATABASE_URL:-postgresql://big5:big5@localhost:5432/big5_matrix?schema=public}"
  export HDV_QUEUE="kafka"
  export KAFKA_BROKERS="${KAFKA_BROKERS:-localhost:9092}"

  log "Ensure the Kafka client is installed (optional dep) + Prisma client generated"
  node -e "require.resolve('kafkajs')" 2>/dev/null || npm install kafkajs
  npm run db:generate >/dev/null
  log "Apply the Prisma schema to Postgres (db:push)"
  npm run db:push

  log "Boot the HOPE gateway (DATABASE_URL + HDV_QUEUE=kafka) on ${BASE_URL}"
  PORT="${PORT}" npm run gateway >"${GATEWAY_LOG}" 2>&1 &
  GATEWAY_PID=$!
  if ! wait_for_health "${BASE_URL}/v1/health" 60; then
    warn "gateway did not become healthy; log tail:"; tail -n 40 "${GATEWAY_LOG}" >&2; exit 1
  fi
  ok "gateway healthy (durable persistence + Kafka intake)"

  log "Run one ephemeral DREAM worker → POST /v1/worker/report (APEX → KNOLL → HOPE)"
  GATEWAY_URL="${BASE_URL}" python3 colab/worker_job.py --role DREAM --batch 50

  log "Read back the ledger + audit (proof the slice reached APEX/KNOLL and persisted)"
  curl -fsS "${BASE_URL}/v1/ledger" | head -c 800; echo
  curl -fsS "${BASE_URL}/v1/audit"  | head -c 800; echo
  ok "FULL Phase 5 slice complete (Kafka + Postgres + worker)."
}

# ---------------------------------------------------------------------------
main() {
  log "Big 5 Matrix — Phase 5 real slice"
  if [[ "${FORCE_OFFLINE}" == "1" ]]; then
    run_offline; return 0
  fi
  if have_docker; then
    run_full
  else
    if [[ "${STRICT}" == "1" ]]; then
      warn "Docker is required (--strict) but not available. Install Docker and retry."
      exit 1
    fi
    warn "Docker not available — using the OFFLINE fallback."
    run_offline
  fi
}

main
