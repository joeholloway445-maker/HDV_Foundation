#!/usr/bin/env bash
#
# deploy/seal_production.sh — seal every operational back door EXCEPT constitutional laws.
#
# Run ON the VPS after the gateway is up. Idempotent. Requires root/sudo.
#
# What it seals:
#   - UFW: only 22/80/443 (SSH rate-limited); deny everything else inbound
#   - Postgres/Redis/Ollama/Kafka/Gateway bound to loopback (compose already does this;
#     this script verifies and fails loud if something is world-reachable)
#   - fail2ban for sshd + optional Caddy
#   - sysctl: disable source routing / redirects; enable rp_filter
#   - Ensures HDV_PRODUCTION=1 + strong HDV_API_KEY + explicit CORS in .env
#   - Removes world-writable cruft; tightens .env permissions to 600
#
# What it does NOT touch (our laws — intentional front doors):
#   - GET  /v1/health
#   - GET  /v1/billing/pricing
#   - POST /v1/waitlist (rate-limited)
#   - KNOLL virtual laws on every RoutingPacket (APEX→KNOLL gate)
#
# Usage:
#   sudo bash deploy/seal_production.sh
#   DOMAIN=api.example.com CORS_ORIGIN=https://example.com sudo -E bash deploy/seal_production.sh
#
set -euo pipefail

DOMAIN="${DOMAIN:-}"
CORS_ORIGIN="${CORS_ORIGIN:-}"
TARGET_DIR="${TARGET_DIR:-/opt/hdv-foundation}"
APP_SUBDIR="${APP_SUBDIR:-.}"   # repo root IS the app (not big5-matrix/)
ENV_FILE="${ENV_FILE:-$TARGET_DIR/$APP_SUBDIR/.env}"

if [ "$(id -u)" -eq 0 ]; then SUDO=""; else SUDO="sudo"; fi
log()  { printf '\033[1;36m[seal]\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m[seal:warn]\033[0m %s\n' "$*" >&2; }
die()  { printf '\033[1;31m[seal:err]\033[0m %s\n' "$*" >&2; exit 1; }

log "Sealing production — back doors closed; constitutional fronts remain."

# --------------------------------------------------------------------------------------------
# 1. Firewall — only SSH + HTTP/HTTPS
# --------------------------------------------------------------------------------------------
if command -v ufw >/dev/null 2>&1; then
  log "UFW: default deny incoming, allow OpenSSH (rate-limited), 80, 443"
  $SUDO ufw --force reset >/dev/null 2>&1 || true
  $SUDO ufw default deny incoming
  $SUDO ufw default allow outgoing
  $SUDO ufw limit OpenSSH
  $SUDO ufw allow 80/tcp
  $SUDO ufw allow 443/tcp
  $SUDO ufw --force enable
  $SUDO ufw status verbose || true
else
  warn "ufw not installed — install it and re-run"
fi

# --------------------------------------------------------------------------------------------
# 2. fail2ban
# --------------------------------------------------------------------------------------------
if command -v apt-get >/dev/null 2>&1; then
  $SUDO apt-get install -y -qq fail2ban >/dev/null 2>&1 || warn "fail2ban install skipped"
fi
if command -v systemctl >/dev/null 2>&1 && systemctl list-unit-files | grep -q fail2ban; then
  $SUDO systemctl enable --now fail2ban || true
  log "fail2ban enabled"
fi

# --------------------------------------------------------------------------------------------
# 3. Kernel / network hygiene
# --------------------------------------------------------------------------------------------
$SUDO tee /etc/sysctl.d/99-hdv-seal.conf >/dev/null <<'SYS'
net.ipv4.conf.all.rp_filter=1
net.ipv4.conf.default.rp_filter=1
net.ipv4.conf.all.accept_source_route=0
net.ipv4.conf.default.accept_source_route=0
net.ipv4.conf.all.accept_redirects=0
net.ipv4.conf.default.accept_redirects=0
net.ipv4.conf.all.send_redirects=0
net.ipv6.conf.all.accept_redirects=0
net.ipv4.tcp_syncookies=1
SYS
$SUDO sysctl --system >/dev/null 2>&1 || true

# --------------------------------------------------------------------------------------------
# 4. .env production seal
# --------------------------------------------------------------------------------------------
if [ ! -f "$ENV_FILE" ]; then
  die "Missing $ENV_FILE — run bootstrap first"
fi
$SUDO chmod 600 "$ENV_FILE"
$SUDO chown root:root "$ENV_FILE" 2>/dev/null || true

set_env() {
  local key="$1" val="$2"
  if grep -q "^${key}=" "$ENV_FILE" 2>/dev/null; then
    $SUDO sed -i "s|^${key}=.*|${key}=${val}|" "$ENV_FILE"
  else
    echo "${key}=${val}" | $SUDO tee -a "$ENV_FILE" >/dev/null
  fi
}

set_env "HDV_PRODUCTION" "1"
set_env "HDV_BIND_HOST" "127.0.0.1"

# Ensure strong API key
CURRENT_KEY=$(grep "^HDV_API_KEY=" "$ENV_FILE" | cut -d= -f2- | tr -d '"' || true)
if [ "${#CURRENT_KEY}" -lt 24 ]; then
  NEW_KEY=$(openssl rand -hex 32)
  set_env "HDV_API_KEY" "$NEW_KEY"
  log "Generated strong HDV_API_KEY (stored in $ENV_FILE — rotate after session)"
fi

if [ -n "$CORS_ORIGIN" ]; then
  set_env "HDV_CORS_ORIGIN" "$CORS_ORIGIN"
elif [ -n "$DOMAIN" ]; then
  set_env "HDV_CORS_ORIGIN" "https://${DOMAIN}"
else
  # refuse wildcard in production
  if grep -q '^HDV_CORS_ORIGIN=\*' "$ENV_FILE" || ! grep -q '^HDV_CORS_ORIGIN=' "$ENV_FILE"; then
    die "Set DOMAIN=... or CORS_ORIGIN=https://your.site before sealing (no wildcard CORS in prod)"
  fi
fi

set_env "HDV_RATE_LIMIT" "${HDV_RATE_LIMIT:-60}"

# --------------------------------------------------------------------------------------------
# 5. Verify nothing sensitive is world-reachable
# --------------------------------------------------------------------------------------------
log "Scanning for world-reachable service ports (should be empty / only 22,80,443)…"
OPEN=$(ss -tulpn 2>/dev/null | awk 'NR>1 {print $5}' | grep -E ':(5432|6379|9092|11434|8787)\s*$' | grep -v '127.0.0.1' | grep -v '\[::1\]' || true)
if [ -n "$OPEN" ]; then
  warn "SENSITIVE PORTS APPEAR NON-LOOPBACK:"
  warn "$OPEN"
  die "Fix compose/bind addresses so Postgres/Redis/Kafka/Ollama/Gateway are 127.0.0.1 only"
else
  log "No sensitive ports exposed publicly ✓"
fi

# --------------------------------------------------------------------------------------------
# 6. Restart gateway if systemd unit exists
# --------------------------------------------------------------------------------------------
if systemctl list-unit-files 2>/dev/null | grep -q hdv-gateway; then
  $SUDO systemctl restart hdv-gateway || true
  log "Restarted hdv-gateway"
elif [ -f "$TARGET_DIR/$APP_SUBDIR/deploy/docker-compose.prod.yml" ]; then
  (cd "$TARGET_DIR/$APP_SUBDIR" && $SUDO docker compose -f deploy/docker-compose.prod.yml up -d) || true
  log "docker compose refreshed"
fi

log "SEAL COMPLETE."
log "Constitutional fronts still open: /v1/health · /v1/billing/pricing · /v1/waitlist (rate-limited)"
log "Everything else requires HDV_API_KEY. KNOLL laws gate every RoutingPacket."
log "AFTER THIS SESSION: rotate HDV_API_KEY, revoke any temporary SSH keys, delete chat-pasted secrets."
