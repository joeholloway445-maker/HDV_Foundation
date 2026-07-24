#!/usr/bin/env bash
#
# deploy/bootstrap_hostinger.sh — one-command-ish bootstrap for a Hostinger KVM4 (Ubuntu) VPS.
#
# Brings a fresh box to a running HDV Foundation HOPE gateway:
#   1. system update + base packages
#   2. Node.js 22 LTS (for the bare-metal path and `npm` tooling)
#   3. Docker Engine + compose plugin (for the container path)
#   4. UFW firewall (allow OpenSSH + 80/443; the gateway stays loopback-only behind a proxy)
#   5. clone (or update) the repo
#   6. render a .env from .env.example with a generated HDV_API_KEY (idempotent)
#   7. docker compose up (deploy/docker-compose.prod.yml) unless --no-up
#
# It is SAFE TO RE-RUN: every step is idempotent and skips work that is already done.
#
# Usage (as root, or a sudo-capable user):
#   curl -fsSL https://raw.githubusercontent.com/joeholloway445-maker/HDV_Foundation/main/big5-matrix/deploy/bootstrap_hostinger.sh | bash
# or, from a checkout:
#   sudo bash deploy/bootstrap_hostinger.sh
#
# Environment overrides (all optional):
#   REPO_URL     git URL to clone            (default: https://github.com/joeholloway445-maker/HDV_Foundation.git)
#   REPO_REF     branch/tag to check out     (default: main)
#   TARGET_DIR   where to clone              (default: /opt/hdv-foundation)
#   APP_SUBDIR   package dir within the repo (default: big5-matrix)
#   DOMAIN       domain for the reverse proxy note (default: unset — printed as a reminder)
#   SKIP_DOCKER=1   skip Docker install + compose up (bare-metal / systemd path)
#   SKIP_NODE=1     skip the Node.js install
#   NO_UP=1         install everything but do NOT run `docker compose up`
#   WITH_OLLAMA=1   also install Ollama (loopback-only) and pull OLLAMA_MODEL for local inference
#   OLLAMA_MODEL    model to pull when WITH_OLLAMA=1   (default: llama3.2:3b; try mistral / tinyllama)
#   WITH_CADDY=1    also install Caddy and drop in deploy/Caddyfile with DOMAIN substituted, then reload
#
# This script only provisions infrastructure and renders config. It never edits application code
# and never touches the Big 5 routing/security invariants.

set -euo pipefail

# --------------------------------------------------------------------------------------------
# config + tiny helpers
# --------------------------------------------------------------------------------------------
REPO_URL="${REPO_URL:-https://github.com/joeholloway445-maker/HDV_Foundation.git}"
REPO_REF="${REPO_REF:-main}"
TARGET_DIR="${TARGET_DIR:-/opt/hdv-foundation}"
APP_SUBDIR="${APP_SUBDIR:-big5-matrix}"
NODE_MAJOR="${NODE_MAJOR:-22}"
OLLAMA_MODEL="${OLLAMA_MODEL:-llama3.2:3b}"

log()  { printf '\033[1;36m[hdv]\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m[hdv:warn]\033[0m %s\n' "$*" >&2; }
die()  { printf '\033[1;31m[hdv:err]\033[0m %s\n' "$*" >&2; exit 1; }

# Run a command as root: use sudo when we are not already root.
if [ "$(id -u)" -eq 0 ]; then SUDO=""; else SUDO="sudo"; fi
need_cmd() { command -v "$1" >/dev/null 2>&1; }

on_debian() { [ -f /etc/debian_version ] || need_cmd apt-get; }

# --------------------------------------------------------------------------------------------
# 0. sanity
# --------------------------------------------------------------------------------------------
log "HDV Foundation — Hostinger KVM4 bootstrap starting"
if ! on_debian; then
  warn "This script targets Debian/Ubuntu (apt). Detected a non-apt system — proceeding best-effort."
fi
export DEBIAN_FRONTEND=noninteractive

# --------------------------------------------------------------------------------------------
# 1. base packages
# --------------------------------------------------------------------------------------------
if need_cmd apt-get; then
  log "Updating apt and installing base packages (curl, git, ufw, ca-certificates)…"
  $SUDO apt-get update -y
  $SUDO apt-get install -y ca-certificates curl git gnupg ufw openssl
fi

# --------------------------------------------------------------------------------------------
# 2. Node.js (LTS) — for tooling and the bare-metal path
# --------------------------------------------------------------------------------------------
if [ "${SKIP_NODE:-0}" != "1" ]; then
  if need_cmd node && [ "$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)" -ge "$NODE_MAJOR" ]; then
    log "Node.js $(node -v) already present — skipping."
  elif need_cmd apt-get; then
    log "Installing Node.js ${NODE_MAJOR} LTS via NodeSource…"
    curl -fsSL "https://deb.nodesource.com/setup_${NODE_MAJOR}.x" | $SUDO -E bash -
    $SUDO apt-get install -y nodejs
    log "Node.js $(node -v) / npm $(npm -v) installed."
  else
    warn "Cannot install Node.js automatically on this system; install Node ${NODE_MAJOR}+ manually."
  fi
else
  log "SKIP_NODE=1 — skipping Node.js install."
fi

# --------------------------------------------------------------------------------------------
# 3. Docker Engine + compose plugin
# --------------------------------------------------------------------------------------------
if [ "${SKIP_DOCKER:-0}" != "1" ]; then
  if need_cmd docker; then
    log "Docker $(docker --version | awk '{print $3}' | tr -d ',') already present — skipping."
  elif need_cmd apt-get; then
    log "Installing Docker Engine + compose plugin (get.docker.com)…"
    curl -fsSL https://get.docker.com | $SUDO sh
    $SUDO systemctl enable --now docker || warn "Could not enable docker via systemctl (containerless host?)."
    # Let the invoking non-root user run docker without sudo (takes effect on next login).
    if [ -n "${SUDO_USER:-}" ]; then $SUDO usermod -aG docker "$SUDO_USER" || true; fi
  else
    warn "Cannot install Docker automatically on this system; install Docker manually."
  fi
else
  log "SKIP_DOCKER=1 — skipping Docker install."
fi

# --------------------------------------------------------------------------------------------
# 4. firewall (UFW) — allow SSH + HTTP/HTTPS; gateway itself stays loopback-only behind a proxy
# --------------------------------------------------------------------------------------------
if need_cmd ufw; then
  log "Configuring UFW (allow OpenSSH, 80/tcp, 443/tcp; deny the rest)…"
  $SUDO ufw allow OpenSSH || $SUDO ufw allow 22/tcp || true
  $SUDO ufw allow 80/tcp || true
  $SUDO ufw allow 443/tcp || true
  $SUDO ufw --force enable || warn "Could not enable UFW (containerized host?)."
  $SUDO ufw status verbose || true
else
  warn "ufw not available — skipping firewall configuration."
fi

# --------------------------------------------------------------------------------------------
# 5. clone or update the repo
# --------------------------------------------------------------------------------------------
if [ -d "$TARGET_DIR/.git" ]; then
  log "Repo already at $TARGET_DIR — fetching latest ($REPO_REF)…"
  $SUDO git -C "$TARGET_DIR" fetch --depth 1 origin "$REPO_REF"
  $SUDO git -C "$TARGET_DIR" checkout "$REPO_REF"
  $SUDO git -C "$TARGET_DIR" reset --hard "origin/$REPO_REF" || true
else
  log "Cloning $REPO_URL ($REPO_REF) into $TARGET_DIR…"
  $SUDO mkdir -p "$(dirname "$TARGET_DIR")"
  $SUDO git clone --depth 1 --branch "$REPO_REF" "$REPO_URL" "$TARGET_DIR"
fi

APP_DIR="$TARGET_DIR/$APP_SUBDIR"
[ -d "$APP_DIR" ] || die "Expected app directory not found: $APP_DIR"
log "Application directory: $APP_DIR"

# --------------------------------------------------------------------------------------------
# 6. render .env (idempotent) — generate a strong HDV_API_KEY on first run
# --------------------------------------------------------------------------------------------
ENV_FILE="$APP_DIR/.env"
if [ -f "$ENV_FILE" ]; then
  log ".env already exists — leaving it untouched."
else
  log "Rendering $ENV_FILE from .env.example with a generated HDV_API_KEY…"
  $SUDO cp "$APP_DIR/.env.example" "$ENV_FILE"
  API_KEY="$(openssl rand -hex 32 2>/dev/null || head -c 32 /dev/urandom | od -An -tx1 | tr -d ' \n')"
  # Append production-critical settings not present in the example (idempotent-friendly appends).
  {
    echo ""
    echo "# --- Added by deploy/bootstrap_hostinger.sh on $(date -u +%Y-%m-%dT%H:%M:%SZ) ---"
    echo "# Require an API key on protected routes (POST /v1/waitlist stays public, rate-limited)."
    echo "HDV_API_KEY=\"${API_KEY}\""
    echo "# Postgres password used by docker-compose.prod.yml."
    echo "POSTGRES_PASSWORD=\"$(openssl rand -hex 16 2>/dev/null || echo change-me)\""
    echo "# Public base URL (used for Stripe checkout success/cancel redirects)."
    echo "HDV_PUBLIC_URL=\"https://${DOMAIN:-your-domain.example}\""
    echo "# Stripe checkout is OPTIONAL — the billing/stripe_stub.ts stub works with no key."
    echo "# STRIPE_SECRET_KEY=\"sk_test_...\""
  } | $SUDO tee -a "$ENV_FILE" >/dev/null
  log "Generated HDV_API_KEY (stored in $ENV_FILE). Keep it secret."
fi

# --------------------------------------------------------------------------------------------
# 7. bring the stack up (Docker path)
# --------------------------------------------------------------------------------------------
COMPOSE_FILE="deploy/docker-compose.prod.yml"
if [ "${SKIP_DOCKER:-0}" != "1" ] && [ "${NO_UP:-0}" != "1" ] && need_cmd docker; then
  log "Starting the stack: docker compose -f $COMPOSE_FILE up -d --build"
  ( cd "$APP_DIR" && $SUDO docker compose -f "$COMPOSE_FILE" up -d --build )
  log "Applying the database schema (first-boot): db:push"
  ( cd "$APP_DIR" && $SUDO docker compose -f "$COMPOSE_FILE" exec -T gateway npm run db:push ) \
    || warn "db:push failed or gateway not ready yet — re-run once the gateway is healthy."
  log "Stack is up. Gateway is bound to 127.0.0.1:8787 (put a TLS reverse proxy in front)."
else
  log "Skipping 'compose up' (SKIP_DOCKER / NO_UP set, or docker unavailable)."
fi

# --------------------------------------------------------------------------------------------
# 8. Ollama (OPTIONAL) — co-located local 7B/8B inference, loopback-only
# --------------------------------------------------------------------------------------------
# Enable with WITH_OLLAMA=1. Installs Ollama, pins it to 127.0.0.1 (never publicly reachable —
# no `ufw allow 11434`), and pulls OLLAMA_MODEL. A provider is a pure text transducer; this
# changes text quality only and never touches routing/security. See deploy/OLLAMA.md.
if [ "${WITH_OLLAMA:-0}" = "1" ]; then
  if need_cmd ollama; then
    log "Ollama already installed — skipping install."
  else
    log "Installing Ollama (loopback-only local inference)…"
    curl -fsSL https://ollama.com/install.sh | sh || warn "Ollama install failed — see deploy/OLLAMA.md."
  fi
  if need_cmd ollama || [ -x /usr/local/bin/ollama ]; then
    # Pin Ollama to loopback via a systemd drop-in (idempotent: rewrite each run).
    if need_cmd systemctl; then
      $SUDO mkdir -p /etc/systemd/system/ollama.service.d
      printf '[Service]\nEnvironment="OLLAMA_HOST=127.0.0.1:11434"\nEnvironment="OLLAMA_KEEP_ALIVE=30m"\n' \
        | $SUDO tee /etc/systemd/system/ollama.service.d/override.conf >/dev/null
      $SUDO systemctl daemon-reload || true
      $SUDO systemctl enable --now ollama 2>/dev/null || $SUDO systemctl restart ollama 2>/dev/null || \
        warn "Could not (re)start ollama via systemctl."
    fi
    log "Pulling Ollama model: ${OLLAMA_MODEL} (this can take a while)…"
    ollama pull "${OLLAMA_MODEL}" || warn "ollama pull ${OLLAMA_MODEL} failed — pull it manually later."
    log "Ollama ready on 127.0.0.1:11434. Wire it in $ENV_FILE:"
    log "  HDV_LLM_PROVIDER=openai_compatible  HDV_LLM_BASE_URL=http://127.0.0.1:11434/v1  HDV_LLM_MODEL=${OLLAMA_MODEL}"
  fi
else
  log "WITH_OLLAMA not set — skipping local Ollama install (BYOK/stub provider by default)."
fi

# --------------------------------------------------------------------------------------------
# 9. Caddy (OPTIONAL) — automatic HTTPS reverse proxy in front of the loopback gateway
# --------------------------------------------------------------------------------------------
# Enable with WITH_CADDY=1 (needs DOMAIN + DNS already pointing at this box). Installs Caddy,
# drops in deploy/Caddyfile with DOMAIN substituted, and reloads. Idempotent: re-running just
# refreshes the config and reloads.
if [ "${WITH_CADDY:-0}" = "1" ]; then
  if [ -z "${DOMAIN:-}" ]; then
    warn "WITH_CADDY=1 but DOMAIN is unset — set DOMAIN=api.yourdomain.com and re-run."
  elif ! need_cmd apt-get; then
    warn "WITH_CADDY=1 but apt-get is unavailable — install Caddy manually (see deploy/HOSTINGER.md §6.2)."
  else
    if need_cmd caddy; then
      log "Caddy already installed — refreshing config."
    else
      log "Installing Caddy…"
      $SUDO apt-get install -y debian-keyring debian-archive-keyring apt-transport-https || true
      curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' \
        | $SUDO gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
      curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' \
        | $SUDO tee /etc/apt/sources.list.d/caddy-stable.list >/dev/null
      $SUDO apt-get update -y && $SUDO apt-get install -y caddy
    fi
    log "Installing Caddyfile for ${DOMAIN}…"
    $SUDO cp "$APP_DIR/deploy/Caddyfile" /etc/caddy/Caddyfile
    $SUDO sed -i "s/api\.yourdomain\.com/${DOMAIN}/g" /etc/caddy/Caddyfile
    $SUDO systemctl reload caddy 2>/dev/null || $SUDO systemctl restart caddy 2>/dev/null || \
      warn "Could not reload caddy — check 'systemctl status caddy' and DNS for ${DOMAIN}."
    log "Caddy configured for https://${DOMAIN} (auto TLS via Let's Encrypt)."
  fi
else
  log "WITH_CADDY not set — set up the reverse proxy manually (see 'Next steps' below)."
fi

# --------------------------------------------------------------------------------------------
# done — next steps
# --------------------------------------------------------------------------------------------
# DNS reminder: only print the "point your records" nudge if the domain does NOT yet resolve to
# this box (idempotent — a correctly configured domain shows a ✓ instead of a to-do).
DNS_HINT="  2. DNS: point ${DOMAIN:-your-domain} A/AAAA records at this server, then obtain TLS."
if [ -n "${DOMAIN:-}" ] && need_cmd dig; then
  RESOLVED="$(dig +short "${DOMAIN}" A | head -n1 || true)"
  MYIP="$(curl -fsS4 https://api.ipify.org 2>/dev/null || true)"
  if [ -n "${RESOLVED}" ] && [ -n "${MYIP}" ] && [ "${RESOLVED}" = "${MYIP}" ]; then
    DNS_HINT="  2. DNS: ✓ ${DOMAIN} already resolves to this box (${MYIP}) — TLS can be issued."
  elif [ -n "${RESOLVED}" ]; then
    DNS_HINT="  2. DNS: ${DOMAIN} resolves to ${RESOLVED} but this box is ${MYIP:-unknown} — fix the A record before TLS."
  fi
fi

cat <<EOF

$(log "Bootstrap complete.")
Next steps:
  1. Point a reverse proxy at the loopback gateway (skip if you passed WITH_CADDY=1):
       - Caddy:  cp $APP_DIR/deploy/Caddyfile /etc/caddy/Caddyfile   (set your domain, then: systemctl reload caddy)
       - nginx:  see $APP_DIR/deploy/nginx.conf.sample + certbot
${DNS_HINT}
  3. Smoke test (from the box):
       curl -s http://127.0.0.1:8787/v1/health
       curl -s -XPOST http://127.0.0.1:8787/v1/waitlist -H 'content-type: application/json' \\
            -d '{"email":"founder@example.com","source":"marketing"}'
  4. Verify the public surface once TLS is up (from anywhere):
       BASE_URL="https://${DOMAIN:-api.yourdomain.com}" bash $APP_DIR/scripts/verify_public.sh
  5. Full handoff: $APP_DIR/docs/HANDOFF_HOSTINGER.md
     Runbook: $APP_DIR/deploy/HOSTINGER.md · Ollama: $APP_DIR/deploy/OLLAMA.md · Launch: $APP_DIR/docs/LAUNCH_CHECKLIST.md

EOF
