# HANDOFF — Hostinger / domain deploy (HDV Foundation · HOPE gateway)

> **Purpose.** A complete, self-contained handoff so **another AI agent OR Joe** can finish the
> Hostinger + domain deployment of the HOPE gateway **without rediscovering context**. Follow it
> top-to-bottom; every command is copy-pasteable. It only uses what the repo already ships and
> never touches the Big 5 routing/security invariants.
>
> - Full runbook (deep dive): [`deploy/HOSTINGER.md`](../deploy/HOSTINGER.md)
> - Local LLM (Ollama): [`deploy/OLLAMA.md`](../deploy/OLLAMA.md)
> - Start a fresh Cursor Cloud Agent to do this: [`docs/AGENT_HANDOFF_PROMPT.md`](./AGENT_HANDOFF_PROMPT.md)
> - Launch checklist: [`docs/LAUNCH_CHECKLIST.md`](./LAUNCH_CHECKLIST.md)

---

## 0. TL;DR (the whole deploy in one screen)

```bash
# On the VPS, as root or a sudo user:
export DOMAIN="api.yourdomain.com"                # the FQDN you will serve TLS on
sudo -E DOMAIN="$DOMAIN" bash big5-matrix/deploy/bootstrap_hostinger.sh
#   -> installs Node/Docker/UFW, clones repo, renders .env with a generated HDV_API_KEY,
#      and (Docker path) runs `docker compose up`. Gateway ends up on 127.0.0.1:8787.

# Put Caddy in front for automatic HTTPS (edit the domain first):
sudo cp /opt/hdv-foundation/big5-matrix/deploy/Caddyfile /etc/caddy/Caddyfile
sudo sed -i "s/api\.yourdomain\.com/$DOMAIN/" /etc/caddy/Caddyfile
sudo systemctl reload caddy

# Verify from anywhere:
BASE_URL="https://$DOMAIN" bash big5-matrix/scripts/verify_public.sh
```

If the four checks in `verify_public.sh` pass, the deploy is done. The rest of this doc is the
detail behind each step, plus the secrets you must supply.

---

## 1. Secrets & inputs you must provide

These are the ONLY things that cannot be discovered from the repo — they must come from Joe /
Hostinger / the domain registrar. Provide them as environment variables (Cursor Cloud Agent:
Dashboard → Cloud Agents → Secrets; local: shell `export`).

| Secret / input | What it is | Where to get it | Required? |
|----------------|-----------|-----------------|-----------|
| `HOSTINGER_SSH` | SSH target for the VPS, e.g. `root@203.0.113.10` (or `hdv@203.0.113.10`). Optionally the full `ssh` string / a key path. | Hostinger hPanel → VPS → your plan → **SSH access** | **Yes** |
| VPS root/sudo password **or** SSH key | Auth for the SSH session. Prefer an SSH key added to the box (`ssh-copy-id`). | Hostinger hPanel (initial root password) / your laptop key | **Yes** (one of) |
| `DOMAIN` | The FQDN to serve on, e.g. `api.yourdomain.com`. Used for TLS + `HDV_PUBLIC_URL` + CORS. | Domain registrar / Hostinger Domains | **Yes** |
| VPS public IP (and IPv6 if any) | The A/AAAA record target. | Hostinger hPanel → VPS overview | **Yes** (for DNS) |
| `HDV_API_KEY` | API key that protects non-public routes. **The bootstrap generates one automatically** if you don't supply it; you only set this to pin a known value. | `openssl rand -hex 32`, or reuse an existing key | Optional |
| `STRIPE_SECRET_KEY` | Live/test Stripe key for real checkout. Billing works with a stub if unset. | Stripe dashboard | Optional |
| LLM provider key (`HDV_LLM_API_KEY`) | Only if you use a **hosted** OpenAI-compatible provider instead of local Ollama. | OpenAI/Groq/Together/etc. | Optional |

> **sudo note.** The bootstrap and the Caddy/systemd steps need root. Either SSH in as `root`,
> or as a sudo-capable user (the script auto-prepends `sudo` when not root). If you created a
> non-root `hdv` user, make sure it is in the `sudo` group (`usermod -aG sudo hdv`).

---

## 2. Connect to the box

```bash
# Using the HOSTINGER_SSH secret:
ssh "$HOSTINGER_SSH"                 # e.g. ssh root@203.0.113.10
# First-time hardening (optional but recommended) — see deploy/HOSTINGER.md §1:
adduser hdv && usermod -aG sudo hdv  # then ssh-copy-id hdv@<ip> from your laptop
```

If a fresh box, the bootstrap script below installs everything. If you cannot pipe from GitHub
(private repo / no outbound), `scp` the repo or `git clone` with a token first.

---

## 3. Run the bootstrap (`deploy/bootstrap_hostinger.sh`)

This is the one-command provisioner. **It is idempotent — safe to re-run.** What each step does:

1. **Base packages** — `apt-get install ca-certificates curl git gnupg ufw openssl`.
2. **Node.js 22 LTS** via NodeSource (skipped if already ≥ major; `SKIP_NODE=1` to skip).
3. **Docker Engine + compose plugin** via `get.docker.com` (`SKIP_DOCKER=1` to skip → bare-metal/systemd path).
4. **UFW firewall** — allow OpenSSH + `80/tcp` + `443/tcp` only. **Never** opens `8787`, `5432`, `6379`, `11434`.
5. **Clone/update the repo** into `TARGET_DIR` (default `/opt/hdv-foundation`) at `REPO_REF` (default `main`).
6. **Render `.env`** from `.env.example` with a freshly generated `HDV_API_KEY` + `POSTGRES_PASSWORD` (idempotent: leaves an existing `.env` untouched). Sets `HDV_PUBLIC_URL=https://$DOMAIN`.
7. **`docker compose up`** (Docker path) unless `NO_UP=1`, then `db:push` for the schema.
8. **DNS + Caddy reminders** printed at the end.

### 3.1 Invocation

From a checkout on the box (recommended so `$DOMAIN` is captured in `.env`):

```bash
cd /path/to/HDV_Foundation           # wherever you cloned it
export DOMAIN="api.yourdomain.com"
sudo -E DOMAIN="$DOMAIN" bash big5-matrix/deploy/bootstrap_hostinger.sh
```

Or one-liner straight from GitHub (public repo):

```bash
export DOMAIN="api.yourdomain.com"
curl -fsSL https://raw.githubusercontent.com/joeholloway445-maker/HDV_Foundation/main/big5-matrix/deploy/bootstrap_hostinger.sh \
  | sudo -E DOMAIN="$DOMAIN" bash
```

### 3.2 Useful environment overrides

| Var | Default | Meaning |
|-----|---------|---------|
| `DOMAIN` | *(unset)* | FQDN; drives DNS reminder, `HDV_PUBLIC_URL`, and the Caddyfile hint. |
| `REPO_URL` | `https://github.com/joeholloway445-maker/HDV_Foundation.git` | Repo to clone. |
| `REPO_REF` | `main` | Branch/tag. |
| `TARGET_DIR` | `/opt/hdv-foundation` | Clone destination. |
| `APP_SUBDIR` | `big5-matrix` | Package dir inside the repo. |
| `SKIP_DOCKER=1` | — | Use the bare-metal/systemd path instead of Docker. |
| `SKIP_NODE=1` | — | Don't install Node. |
| `NO_UP=1` | — | Install everything but don't `docker compose up`. |
| `OLLAMA_MODEL` | `llama3.2:3b` | Model to `ollama pull` when `WITH_OLLAMA=1` (try `mistral` or `tinyllama` on small boxes). |
| `WITH_OLLAMA=1` | — | Also install Ollama and pull `$OLLAMA_MODEL` (co-located local inference). |

The app directory after cloning is `TARGET_DIR/APP_SUBDIR`, i.e. `/opt/hdv-foundation/big5-matrix`.

---

## 4. DNS: point the domain at the VPS

In Hostinger hPanel → **Domains** (or your registrar's DNS), create records pointing at the VPS
IP. **Do this before requesting TLS** — Caddy/Let's Encrypt need the A record to resolve to this
box.

| Type | Name | Value | TTL |
|------|------|-------|-----|
| A | `api` (or `@`) | `YOUR_VPS_IP` | 3600 |
| AAAA | `api` (or `@`) | `YOUR_VPS_IPV6` | 3600 (only if the KVM4 has IPv6) |

Verify propagation from the box before continuing:

```bash
dig +short api.yourdomain.com     # must print YOUR_VPS_IP
```

---

## 5. TLS reverse proxy (Caddy — automatic HTTPS)

The gateway listens on `127.0.0.1:8787`. Caddy is the only process on `:80/:443` and gets/renews
Let's Encrypt certs automatically.

```bash
# Install Caddy (Debian/Ubuntu):
sudo apt-get install -y debian-keyring debian-archive-keyring apt-transport-https
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' \
  | sudo gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' \
  | sudo tee /etc/apt/sources.list.d/caddy-stable.list
sudo apt-get update && sudo apt-get install -y caddy

# Install the repo's Caddyfile and set the domain:
APP_DIR=/opt/hdv-foundation/big5-matrix
sudo cp "$APP_DIR/deploy/Caddyfile" /etc/caddy/Caddyfile
sudo sed -i "s/api\.yourdomain\.com/$DOMAIN/" /etc/caddy/Caddyfile
sudo systemctl reload caddy          # reload (not restart) to pick up config with zero downtime
sudo systemctl status caddy --no-pager
```

The shipped `Caddyfile` reverse-proxies to `127.0.0.1:8787`, forwards the real client IP for the
rate limiter, health-checks `/v1/health`, and adds HSTS/security headers. nginx + certbot is the
alternative — see [`deploy/HOSTINGER.md`](../deploy/HOSTINGER.md) §6.3.

---

## 6. Ollama (optional local 7B/8B inference on the same box)

Co-locating a small model gives a fully self-hosted, no-vendor-key path. **KVM4 (~16 GB RAM,
CPU-only) runs a quantized 7B/8B**, slowly. Full guide: [`deploy/OLLAMA.md`](../deploy/OLLAMA.md).

Bare-metal quick path (the bootstrap does this when `WITH_OLLAMA=1`):

```bash
curl -fsSL https://ollama.com/install.sh | sh
# keep it loopback-only (never `ufw allow 11434`):
sudo systemctl edit ollama    # add: Environment="OLLAMA_HOST=127.0.0.1:11434"
sudo systemctl daemon-reload && sudo systemctl restart ollama

ollama pull llama3.2:3b       # fast default; or: mistral (7B) / tinyllama (smallest)
```

Wire it into the gateway `.env`:

```bash
HDV_LLM_PROVIDER=openai_compatible
HDV_LLM_BASE_URL=http://127.0.0.1:11434/v1   # loopback; use http://ollama:11434/v1 on Docker path
HDV_LLM_MODEL=llama3.2:3b                     # match what you pulled
HDV_LLM_API_KEY=                              # empty — Ollama is keyless
```

Restart the gateway to pick it up: `sudo systemctl restart hdv-gateway` (bare metal) or
`docker compose -f deploy/docker-compose.prod.yml up -d gateway` (Docker). Docker profile:
`docker compose -f deploy/docker-compose.prod.yml --profile local-llm up -d`, then in `.env` use
`HDV_LLM_BASE_URL=http://ollama:11434/v1`.

> Provider = pure text transducer (`complete(prompt) -> { text }`). It only enriches HOPE's
> intent summary; it never routes, executes, creates, or bypasses APEX/KNOLL. Swapping the stub
> for a real model changes text quality, nothing about governance.

---

## 7. Environment variables (`.env`) reference

The bootstrap renders `.env` for you; edit `$APP_DIR/.env` to change anything. The keys that
matter in production:

```bash
PORT=8787                                   # loopback bind; the proxy forwards to this
HDV_API_KEY=<generated by bootstrap>        # REQUIRED in prod — unset ⇒ auth DISABLED (dev mode)
HDV_RATE_LIMIT=120                          # requests/min per client IP before 429
HDV_CORS_ORIGIN=https://yourdomain.com      # tighten from "*" to your site origin
HDV_PUBLIC_URL=https://api.yourdomain.com   # used for Stripe redirects; set to $DOMAIN

# Persistence (Docker path sets these to the compose service names automatically):
DATABASE_URL="postgresql://big5:...@localhost:5432/big5_matrix?schema=public"
REDIS_URL="redis://localhost:6379"

# LLM provider seam (optional; offline stub is the default):
HDV_LLM_PROVIDER=stub                        # stub | openai_compatible
# HDV_LLM_BASE_URL=http://127.0.0.1:11434/v1
# HDV_LLM_MODEL=llama3.2:3b
# HDV_LLM_API_KEY=                            # empty for keyless local servers
```

Hard rules:

- **`HDV_API_KEY` must be set on a public box.** Unset ⇒ the gateway runs auth-off dev mode.
  `/v1/health` and `/v1/billing/pricing` stay public regardless.
- **`HDV_CORS_ORIGIN`** should be your real site origin, not `*`, once a browser calls the API.
- `.env` must be `chmod 600`, owned by the deploy user, and is git-ignored — never commit it.
  ```bash
  chmod 600 "$APP_DIR/.env"
  ```

---

## 8. Verify — curls after deploy

`/v1/health` and `/v1/billing/pricing` are public; everything else needs the key. The full public
smoke test is scripted:

```bash
BASE_URL="https://$DOMAIN" bash big5-matrix/scripts/verify_public.sh
# or: npm run verify:public     (uses BASE_URL from the env)
```

Manual equivalents:

```bash
# 1) Health (public, must be 200)
curl -fsS "https://$DOMAIN/v1/health" | head -c 300; echo

# 2) Pricing (public, must be 200)
curl -fsS "https://$DOMAIN/v1/billing/pricing" | head -c 300; echo

# 3) Auth enforced — protected route must be 401 WITHOUT the key, 200 WITH it
curl -s -o /dev/null -w '%{http_code}\n' "https://$DOMAIN/v1/matrix/stats"                 # expect 401
curl -s -o /dev/null -w '%{http_code}\n' "https://$DOMAIN/v1/matrix/stats" \
     -H "X-HDV-Key: $HDV_API_KEY"                                                          # expect 200

# 4) Metrics (protected; JSON, or Prometheus exposition with ?format=prometheus)
curl -fsS "https://$DOMAIN/v1/metrics" -H "X-HDV-Key: $HDV_API_KEY" | head -c 300; echo
```

---

## 9. Waitlist test (the public conversion path)

`POST /v1/waitlist` is **public** (auth-exempt) but rate-limited. It returns **201** for a brand-new
signup and **200** for an idempotent re-signup (same email).

```bash
curl -s -w '\n%{http_code}\n' -X POST "https://$DOMAIN/v1/waitlist" \
  -H 'content-type: application/json' \
  -d "{\"email\":\"founder+$(date +%s)@example.com\",\"name\":\"Joe\",\"company\":\"HDV\",\"interestedTier\":\"PRO\",\"useCase\":\"launch\"}"
# expect trailing 201 (new) or 200 (repeat)

# Aggregate stats are PROTECTED (privacy-safe counts only):
curl -fsS "https://$DOMAIN/v1/waitlist/stats" -H "X-HDV-Key: $HDV_API_KEY" | head -c 300; echo
```

The static waitlist page (`marketing/waitlist.html`) posts here; preview it against the live box
with `waitlist.html?api=https://$DOMAIN`.

---

## 10. Open the marketing site on the domain

The marketing/waitlist pages are static, self-contained (no build step). Two options:

- **Serve on the apex domain via Caddy** — uncomment the `yourdomain.com { root * .../marketing; file_server }`
  block at the bottom of the shipped `Caddyfile`, set the root path, and `sudo systemctl reload caddy`.
  Keep the API on `api.yourdomain.com` and marketing on `yourdomain.com`.
- **Preview locally / any static host** — `npm run marketing` prints the file path; or `npx serve marketing`.

Point the page's API calls at the live gateway with `?api=https://api.yourdomain.com`.

---

## 11. Post-deploy checklist

- [ ] `curl https://$DOMAIN/v1/health` → `200` (public).
- [ ] `curl https://$DOMAIN/v1/billing/pricing` → `200` (public).
- [ ] `curl https://$DOMAIN/v1/matrix/stats` → **`401`** without the key; `200` with `-H "X-HDV-Key: $HDV_API_KEY"`.
- [ ] `POST /v1/waitlist` → `201`/`200`; `GET /v1/waitlist/stats` → `401` without the key.
- [ ] `HDV_API_KEY` set (auth ON), `HDV_CORS_ORIGIN` is your site (not `*`), `.env` is `chmod 600`.
- [ ] Ports `8787`, `5432`, `6379`, `11434` are **not** reachable from outside (only `22/80/443`).
- [ ] TLS auto-renewal works (Caddy handles it; nginx: `certbot renew --dry-run`).
- [ ] `scripts/verify_public.sh` exits `0` against `https://$DOMAIN`.
- [ ] Gateway healthy after reboot (`systemctl status hdv-gateway` or `docker compose ps`).

---

## 12. MCP note (drive the matrix from Cursor / any MCP client)

The repo ships an MCP server so an agent (e.g. a Cursor Cloud Agent) can drive the matrix over
stdio JSON-RPC instead of raw HTTP:

```bash
npm run mcp        # stdio JSON-RPC server; logs to stderr
```

Tools exposed: `hdv_intent`, `hdv_estimate_cost`, `hdv_health`, `hdv_models`, `hdv_usage`. Config
and the full tool schema live in [`docs/MCP.md`](./MCP.md). The MCP server is a thin client of the
same public `/v1` surface — it never bypasses APEX/KNOLL, so it is safe to expose to an agent that
is finishing this deploy. For a remote box, point the MCP/HTTP client at `https://$DOMAIN` and pass
`HDV_API_KEY` for protected tools.

---

## 13. Constitution invariants (do NOT violate while deploying)

Deployment is infrastructure only. It must never weaken these (see `.cursorrules` and
[`packages/constitution/README.md`](../packages/constitution/README.md)):

- **Single legal road.** All inter-agent traffic flows `SOURCE → APEX → KNOLL → DEST`. No agent
  talks to another directly. Never expose the internal ports (`8787` stays loopback behind the proxy;
  `5432/6379/11434` stay on the Docker/loopback network). Exposing them breaches the road at the network layer.
- **KNOLL gates every packet.** APEX calls `KNOLL.intercept()` before every route; the gateway only
  submits `HOPE → APEX`. Deploy config never bypasses this.
- **DREAM ↔ VISION never communicate directly**, in either direction.
- **Providers are pure text transducers.** Ollama/any LLM only enriches text; it never routes,
  executes, creates, or governs. No key ever goes into a `RoutingPacket`.
- **`/v1/health` and `/v1/billing/pricing` are the only always-public routes.** Everything else is
  KNOLL-gated and API-key-protected.
- **Never commit `.env` or any secret.** Keys live only in `.env` (`chmod 600`), never in git.
