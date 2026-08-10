# Deploying HDV Foundation on Hostinger KVM4

> Production runbook for the **HOPE gateway** (the always-on front door of the HDV
> Foundation matrix) on a **Hostinger KVM4 VPS**, with an optional **local LLM (Ollama)**
> co-located on the same box for BYOK/self-hosted inference.
>
> Everything here uses only what the repo already ships: the Node gateway
> (`npm run gateway`), the optional Postgres/Redis from `docker-compose.yml`, and the
> optional provider seam (`providers/`). No agent invariant is touched — every routed
> packet is still gated by KNOLL and carried by APEX.

Companion files in this folder:

- [`docker-compose.prod.yml`](./docker-compose.prod.yml) — gateway + Postgres + Redis (+ optional Ollama) for a container deploy.
- [`Caddyfile`](./Caddyfile) — one-line HTTPS reverse proxy (auto TLS via Let's Encrypt).
- [`nginx.conf.sample`](./nginx.conf.sample) — nginx reverse-proxy alternative.
- [`hdv-gateway.service`](./hdv-gateway.service) — systemd unit for the bare-metal (no Docker) path.
- [`OLLAMA.md`](./OLLAMA.md) — running a local 7B/8B model on the same VPS and wiring BYOK.

---

## 0. What you're deploying

The **HOPE gateway** is the only forward-facing process. It is a small `node:http`
server (no framework) that exposes:

| Method | Path                | Purpose                                              |
|--------|---------------------|------------------------------------------------------|
| POST   | `/v1/intent`        | HOPE interpret + document + submit via APEX (KNOLL-gated) |
| GET    | `/v1/health`        | Liveness/readiness (always public, always fast)       |
| GET    | `/v1/health/deep`   | Per-dependency reachability diagnostics — Postgres/Redis/LLM/image/video (protected, bounded; see §11.1) |
| GET    | `/v1/ledger`        | Recent APEX billing entries (read-only)               |
| GET    | `/v1/audit`         | Recent KNOLL verdicts (read-only)                     |
| GET    | `/v1/matrix/stats`  | Node/persona topology + parameter accounting          |
| GET    | `/v1/metrics`       | Observability snapshot (`?format=prometheus`)         |
| POST   | `/v1/companion/chat`| One in-character companion reply (public, rate-limited per-IP AND per-tenant; see `companion/`) |
| POST   | `/v1/companion/portrait`| One companion portrait image (public, rate-limited per-IP AND per-tenant; see `companion/` + `providers/image_*`) |
| POST   | `/v1/companion/scene`| One companion scene/loop video from an existing portrait (public, rate-limited per-IP AND per-tenant; see `providers/video_*` + `colab/08_scene_server.py`) |
| POST   | `/v1/billing/checkout`, `/v1/billing/checkout/settle` | (Stub) Stripe Checkout (public, rate-limited per-IP AND per-tenant) |

It binds `PORT` (default `8787`) on loopback; a reverse proxy (Caddy or nginx)
terminates TLS on `443` and forwards to it.

**Recommended KVM4 sizing.** KVM4 (≈4 vCPU / 16 GB RAM / 200 GB NVMe) comfortably runs
the gateway + Postgres + Redis with headroom. If you also run **Ollama with a 7B–8B
quantized model on CPU**, that headroom is why KVM4 (not KVM1/KVM2) is the floor — see
[`OLLAMA.md`](./OLLAMA.md).

---

## 1. First login & base hardening

SSH in as root using the credentials from the Hostinger hPanel (VPS → your plan →
*SSH access*):

```bash
ssh root@YOUR_VPS_IP
```

Create a non-root deploy user and give it sudo:

```bash
adduser hdv
usermod -aG sudo hdv
# copy your key so you can log in as hdv (from your laptop):
#   ssh-copy-id hdv@YOUR_VPS_IP
```

Update the base image:

```bash
apt-get update && apt-get -y upgrade
apt-get install -y ca-certificates curl git ufw fail2ban
```

Harden SSH (optional but recommended) — disable root login & passwords once your key works:

```bash
sed -i 's/^#\?PermitRootLogin.*/PermitRootLogin no/' /etc/ssh/sshd_config
sed -i 's/^#\?PasswordAuthentication.*/PasswordAuthentication no/' /etc/ssh/sshd_config
systemctl restart ssh
```

---

## 2. Firewall (UFW)

Only expose SSH + HTTP + HTTPS. The gateway itself stays on loopback (`127.0.0.1:8787`)
behind the proxy — never open `8787` to the world.

```bash
ufw default deny incoming
ufw default allow outgoing
ufw allow OpenSSH          # 22
ufw allow 80/tcp           # ACME HTTP-01 + redirect
ufw allow 443/tcp          # HTTPS
ufw enable
ufw status verbose
```

> Do **not** `ufw allow 8787`, `5432` (Postgres), `6379` (Redis), or `11434` (Ollama).
> They are reached only over the Docker network / loopback. Exposing them is a breach of
> the "single legal road" principle at the network layer.

---

## 3. Attaching your domain

In Hostinger hPanel → *Domains* (or your registrar's DNS), point the domain at the VPS:

| Type | Name  | Value            | TTL  |
|------|-------|------------------|------|
| A    | `@`   | `YOUR_VPS_IP`    | 3600 |
| A    | `api` | `YOUR_VPS_IP`    | 3600 |
| AAAA | `@`   | `YOUR_VPS_IPV6`  | 3600 | (only if your KVM4 has IPv6) |

Verify propagation before requesting certificates (Caddy/nginx-certbot need the A record
to resolve to this box):

```bash
dig +short api.yourdomain.com     # should print YOUR_VPS_IP
```

Caddy will then obtain and renew TLS **automatically**; with nginx you run certbot once
(see §6).

---

## 4. Install Node 22

The repo targets **Node ≥ 20, developed on Node 22**. Install Node 22 from NodeSource:

```bash
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt-get install -y nodejs
node -v    # v22.x
npm -v
```

Clone the repo (as the `hdv` user):

```bash
sudo -iu hdv
git clone https://github.com/joeholloway445-maker/HDV_Foundation.git
cd HDV_Foundation/big5-matrix
npm ci
npm run typecheck       # sanity: must be zero errors
npm test                # optional: full backbone suite (skips DB/Kafka tests if absent)
```

---

## 5. Environment variables

Copy the example and edit. **Generate a real API key** — never ship the gateway in dev
mode (auth off) on a public box.

```bash
cp .env.example .env
# generate a strong key:
openssl rand -hex 32
```

Edit `.env` (add the gateway/production keys — these are read by `gateway/` and
`providers/`):

```bash
# --- Gateway (gateway/middleware.ts) ------------------------------------------
PORT=8787                       # loopback bind; the proxy forwards to this
HDV_API_KEY=<paste openssl rand -hex 32 output>   # REQUIRED in prod (enables auth)
HDV_RATE_LIMIT=120              # requests/min per client IP before 429
HDV_TENANT_RATE_LIMIT=20        # requests/min per X-HDV-Tenant before 429 — ADDITIVE to
                                 # HDV_RATE_LIMIT above, applies only to /v1/companion/* and
                                 # /v1/billing/checkout*. On a shared VPS many distinct users
                                 # can sit behind one IP (NAT/proxy); this gives each tenant id
                                 # its own budget instead of letting them all share one bucket.
HDV_CORS_ORIGIN=https://yourdomain.com   # tighten from "*" to your site origin

# --- Persistence (optional; in-memory is the default) -------------------------
DATABASE_URL="postgresql://big5:CHANGE_ME@localhost:5432/big5_matrix?schema=public"
REDIS_URL="redis://localhost:6379"

# --- LLM provider seam (providers/) — see §8 for BYOK vs platform keys ---------
HDV_LLM_PROVIDER=stub           # stub | openai_compatible
# HDV_LLM_BASE_URL=http://127.0.0.1:11434/v1   # local Ollama on this VPS
# HDV_LLM_MODEL=llama3.1
# HDV_LLM_API_KEY=              # empty for keyless local servers (Ollama/vLLM)
```

Key rules:

- **`HDV_API_KEY` must be set in production.** Unset ⇒ the gateway runs in dev mode with
  auth disabled. `/v1/health` stays public either way for probes; `/v1/health/deep` does
  **not** — it always requires the key when one is configured (see §11.1).
- **`HDV_TENANT_RATE_LIMIT`** is a second, additive limiter on top of `HDV_RATE_LIMIT` — it
  never replaces the per-IP check, it just adds a per-tenant one on the companion + checkout
  routes specifically.
- **`HDV_CORS_ORIGIN`** should be your actual site origin, not `*`, once the marketing
  page / product calls the API from a browser.
- The providers block is **optional and offline-first** — with `HDV_LLM_PROVIDER=stub` the
  gateway needs no keys and no network. Providers only enrich *text*; they never route,
  execute, or create (see `providers/README.md`).

---

## 6. Deploy path A — bare metal + systemd (no Docker)

Simplest for a single always-on gateway. In-memory persistence by default (fine for a
first launch / demo); add Postgres later via Deploy path B or a managed DB.

### 6.1 Install the systemd unit

Copy [`hdv-gateway.service`](./hdv-gateway.service) into place and adjust the paths/user
if you cloned elsewhere:

```bash
sudo cp deploy/hdv-gateway.service /etc/systemd/system/hdv-gateway.service
sudo systemctl daemon-reload
sudo systemctl enable --now hdv-gateway
sudo systemctl status hdv-gateway --no-pager
journalctl -u hdv-gateway -f          # tail logs
```

Confirm it's up on loopback:

```bash
curl -s localhost:8787/v1/health | head -c 300; echo
```

### 6.2 Reverse proxy with Caddy (auto HTTPS)

Caddy gets and renews Let's Encrypt certs automatically — the fastest way to real TLS.

```bash
sudo apt-get install -y debian-keyring debian-archive-keyring apt-transport-https
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' \
  | sudo gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' \
  | sudo tee /etc/apt/sources.list.d/caddy-stable.list
sudo apt-get update && sudo apt-get install -y caddy

# install the sample (edit the domain + upstream port inside first):
sudo cp deploy/Caddyfile /etc/caddy/Caddyfile
sudo nano /etc/caddy/Caddyfile        # set api.yourdomain.com
sudo systemctl reload caddy
```

Test from your laptop:

```bash
curl -s https://api.yourdomain.com/v1/health
curl -s https://api.yourdomain.com/v1/matrix/stats -H "X-HDV-Key: $HDV_API_KEY"
```

### 6.3 Reverse proxy with nginx + certbot (alternative)

If you prefer nginx:

```bash
sudo apt-get install -y nginx certbot python3-certbot-nginx
sudo cp deploy/nginx.conf.sample /etc/nginx/sites-available/hdv
sudo nano /etc/nginx/sites-available/hdv     # set server_name + upstream
sudo ln -s /etc/nginx/sites-available/hdv /etc/nginx/sites-enabled/hdv
sudo nginx -t && sudo systemctl reload nginx
sudo certbot --nginx -d api.yourdomain.com   # obtains + auto-renews TLS
```

---

## 7. Deploy path B — Docker Compose (gateway + Postgres + Redis)

Use this when you want durable Postgres persistence and one-command lifecycle. Install
Docker Engine + the Compose plugin:

```bash
curl -fsSL https://get.docker.com | sudo sh
sudo usermod -aG docker hdv       # log out/in for the group to take effect
docker --version && docker compose version
```

Bring the stack up from the repo root (`big5-matrix/`):

```bash
# .env already holds DATABASE_URL/REDIS_URL/HDV_API_KEY (see §5)
docker compose -f deploy/docker-compose.prod.yml up -d --build
docker compose -f deploy/docker-compose.prod.yml ps
docker compose -f deploy/docker-compose.prod.yml logs -f gateway
```

Initialize the schema (first boot only) against the running Postgres:

```bash
docker compose -f deploy/docker-compose.prod.yml exec gateway npm run db:push
```

Then put Caddy or nginx (§6.2 / §6.3) in front of the published `127.0.0.1:8787`. The
compose file **only binds the gateway to loopback**; Postgres/Redis are internal to the
Docker network and never published to the host's public interface.

Update / redeploy:

```bash
cd ~/HDV_Foundation && git pull
docker compose -f big5-matrix/deploy/docker-compose.prod.yml up -d --build gateway
```

---

## 8. BYOK vs platform keys on the VPS

The provider seam (`providers/`) is where inference credentials live. There are three
honest modes; pick per deployment (or per tenant later):

| Mode | `.env` on the VPS | Who pays inference | Notes |
|------|-------------------|--------------------|-------|
| **Stub (default)** | `HDV_LLM_PROVIDER=stub` | nobody | Deterministic, offline. Governance/routing/ledger all work with **no key**. Great for the first launch and demos. |
| **Local / self-host** | `HDV_LLM_PROVIDER=openai_compatible`, `HDV_LLM_BASE_URL=http://127.0.0.1:11434/v1`, `HDV_LLM_API_KEY=` (empty) | you (the VPS owner, via hardware) | Ollama or vLLM on the same KVM4 — see [`OLLAMA.md`](./OLLAMA.md). No third-party key leaves the box. |
| **Platform key** | `HDV_LLM_PROVIDER=openai_compatible`, `HDV_LLM_BASE_URL=https://api.openai.com/v1`, `HDV_LLM_API_KEY=sk-...` | you (billed by the vendor) | The VPS holds a single shared vendor key. Use for the hosted "Start free / Starter / Pro" tiers. |
| **BYOK (bring your own key)** | same as platform, but the key is the **customer's** | the customer (billed by their vendor) | The customer supplies their own OpenAI/Groq/Together key. HDV charges a flat governance platform fee, not per active-param-second on their inference. See `docs/GTM.md`. |

Operational hygiene for keys on the VPS:

- Keys live **only** in `/home/hdv/HDV_Foundation/big5-matrix/.env` (mode `600`,
  owned by `hdv`). `.env` is git-ignored (`.gitignore`) — never commit it.
  ```bash
  chmod 600 .env && chown hdv:hdv .env
  ```
- The gateway **never logs the key** (the request logger redacts it) and never puts a
  provider key in a `RoutingPacket`. Providers only touch text after classification.
- For real multi-tenant BYOK (customer keys stored per-tenant, not in a shared `.env`),
  that lands with Phase 8 tenancy in `docs/ROADMAP.md`; today, one key per deployment.
- Rotate by editing `.env` and restarting: `sudo systemctl restart hdv-gateway`
  (path A) or `docker compose -f deploy/docker-compose.prod.yml up -d gateway` (path B).

---

## 9. Optional: local LLM on the same VPS

Co-locating a small model on the KVM4 gives you a **fully self-hosted, no-vendor-key**
path (the "Local / self-host" row above). Full instructions — install, model pull,
memory sizing, systemd, and wiring `HDV_LLM_BASE_URL` — are in [`OLLAMA.md`](./OLLAMA.md).
If you're deploying for FuckLike's companion chat specifically, use `OLLAMA.md` §6 instead
of the generic model below — a mainstream instruct model will refuse the in-character
adult roleplay the product wants regardless of prompt engineering.

Short version (generic HOPE-enrichment case):

```bash
curl -fsSL https://ollama.com/install.sh | sh
ollama pull llama3.1:8b
# in .env:  HDV_LLM_PROVIDER=openai_compatible  HDV_LLM_BASE_URL=http://127.0.0.1:11434/v1  HDV_LLM_MODEL=llama3.1:8b
sudo systemctl restart hdv-gateway
```

Keep Ollama on loopback (`OLLAMA_HOST=127.0.0.1`) — it must never be exposed publicly
(no `ufw allow 11434`).

---

## 10. Post-deploy checklist

- [ ] `curl https://api.yourdomain.com/v1/health` returns `200` (public).
- [ ] `curl https://api.yourdomain.com/v1/matrix/stats` returns **`401`** without the key.
- [ ] Same call **with** `-H "X-HDV-Key: $HDV_API_KEY"` returns `200`.
- [ ] `curl -H "X-HDV-Key: $HDV_API_KEY" https://api.yourdomain.com/v1/health/deep` returns
      `200` with every configured dependency `"ok": true` (see §11.1 if not).
- [ ] `HDV_API_KEY` is set (auth ENABLED), `HDV_CORS_ORIGIN` is your site (not `*`).
- [ ] Ports `8787`, `5432`, `6379`, `11434` are **not** reachable from outside (`nmap` from your laptop shows only `22/80/443`).
- [ ] `.env` is `chmod 600`, git-ignored, and contains no committed secrets.
- [ ] TLS auto-renewal confirmed (`caddy` handles it; nginx: `certbot renew --dry-run`).
- [ ] `systemctl status hdv-gateway` (or `docker compose ps`) shows the gateway healthy after a reboot.

---

## 11. Troubleshooting

| Symptom | Likely cause | Fix |
|---------|--------------|-----|
| `502 Bad Gateway` from the proxy | gateway not listening on `8787` | `systemctl status hdv-gateway` / `docker compose logs gateway`; check `PORT` |
| TLS cert not issued | DNS A record not propagated to this box | `dig +short api.yourdomain.com`; wait, then `systemctl reload caddy` |
| Everything returns `401` | `HDV_API_KEY` set, client not sending it | add `-H "X-HDV-Key: <key>"` or `Authorization: Bearer <key>` |
| `429 Too Many Requests` — `"error": "rate limit exceeded"` | per-IP rate limit hit | raise `HDV_RATE_LIMIT`; check `Retry-After` / `X-RateLimit-*` headers |
| `429 Too Many Requests` — `"error": "tenant rate limit exceeded"` | one X-HDV-Tenant id hit its own budget (companion/checkout routes only) | raise `HDV_TENANT_RATE_LIMIT`; the response body's `tenantId` names which one tripped |
| Prisma tests / boot fail on DB | `DATABASE_URL` set but no DB | start Postgres (path B) and `npm run db:push`, or unset to use in-memory |
| Ollama replies are slow | 7B/8B on CPU is inherently slow | use a smaller/quantized model or BYOK a hosted provider — see `OLLAMA.md` |
| Companion chat silently degrades to canned/fallback replies after a while | Ollama down, OOM'd, rate-limited, or unreachable from the gateway container — see §11.1 | `curl -H "X-HDV-Key: $HDV_API_KEY" .../v1/health/deep` and read `checks.llm` |

### 11.1 "Is Ollama actually reachable from the gateway?" — use `GET /v1/health/deep`

This was the real pain point that motivated this endpoint: companion chat degrading to its
canned fallback reply gives **no external signal** for *why* — rate limit? Ollama down? OOM?
network? Previously the only way to find out was SSHing in and guessing. Now:

```bash
curl -s -H "X-HDV-Key: $HDV_API_KEY" https://api.yourdomain.com/v1/health/deep | python3 -m json.tool
```

(No `python3`? `| head -c 2000; echo` works too — the JSON is small.) Read `checks.llm`:

- `"configured": false, "skipped": true` — `HDV_LLM_PROVIDER` is unset or `stub`. Chat falling
  back is *expected*: there's no real backend wired at all. Set `HDV_LLM_PROVIDER=openai_compatible`
  and `HDV_LLM_BASE_URL` (see §9 / `OLLAMA.md`) if you meant to point at Ollama.
- `"configured": true, "skipped": false, "ok": true` — the gateway CAN reach Ollama's `/models`
  endpoint right now. If chat still degrades intermittently, it's likely per-request timeouts
  or rate limiting under load, not a dead backend — check `HDV_RATE_LIMIT` /
  `HDV_TENANT_RATE_LIMIT` and Ollama's own response time (`OLLAMA.md`'s CPU sizing notes).
- `"configured": true, "skipped": false, "ok": false"` — the gateway genuinely cannot reach
  the configured `HDV_LLM_BASE_URL` right now. `detail` carries the underlying error (e.g.
  `ECONNREFUSED` — Ollama isn't running/listening; a DNS/timeout message — wrong host or
  `OLLAMA_HOST` not bound where expected). From the VPS itself, cross-check directly:
  `curl -s http://127.0.0.1:11434/api/tags` (Ollama's own native health-ish endpoint) or
  `curl -s $HDV_LLM_BASE_URL/models` (what the gateway itself just hit) and
  `systemctl status ollama` / `journalctl -u ollama -f`.

This endpoint is intentionally **protected** (requires `HDV_API_KEY`, unlike `GET /v1/health`)
and **bounded** (a few seconds max, even if a dependency is fully hung) — safe to poll manually
whenever chat looks degraded, without risking it hanging your terminal or slowing down the
always-fast `/v1/health` liveness probe.
