# HDV Foundation — Launch Checklist (this week)

A concrete, day-by-day runbook to take the HOPE gateway + marketing surfaces live on a Hostinger
KVM4 for an **ASAP launch**. Anchored to the current week starting **Thursday, Jul 23, 2026**.

Everything here uses what already ships in this repo — the offline-first backbone, the HOPE
gateway, the launch waitlist (`market/`), the Stripe checkout stub (`billing/stripe_stub.ts`),
the marketing pages (`marketing/`), and the one-command bootstrap (`deploy/bootstrap_hostinger.sh`).
No new infrastructure is required to start collecting signups.

Legend: **[ ]** todo · **[x]** done · _(owner)_ suggested owner.

---

## Day 1 — Thu Jul 23: Prove it green + provision the box

Goal: the stack runs locally and a bare VPS is reachable.

- [ ] `npm ci` then `npm run ci` — confirm `db:generate` + `typecheck` + full test suite pass. _(eng)_
- [ ] `npm run test:market` — waitlist + Stripe-stub tests green. _(eng)_
- [ ] Start the gateway locally: `npm run gateway`, then smoke test:
  - `curl -s localhost:8787/v1/health`
  - `curl -s -XPOST localhost:8787/v1/waitlist -H 'content-type: application/json' -d '{"email":"you@co.com","source":"marketing"}'`
- [ ] Buy/confirm the domain and point DNS **A/AAAA** records at the KVM4 IP (TTL low for launch week). _(ops)_
- [ ] Provision the VPS in one shot: `sudo bash deploy/bootstrap_hostinger.sh`
      (installs Node 22, Docker, UFW; clones the repo; renders `.env` with a generated `HDV_API_KEY`; `compose up`). _(ops)_
- [ ] Record the generated `HDV_API_KEY` and `POSTGRES_PASSWORD` from the server's `.env` in the team secret store. _(ops)_

## Day 2 — Fri Jul 24: TLS, reverse proxy, waitlist live

Goal: `https://<domain>/v1/health` returns 200 and the waitlist accepts real signups.

- [ ] Put a TLS reverse proxy in front of the loopback gateway:
  - Caddy: copy `deploy/Caddyfile`, set the domain, reload (automatic Let's Encrypt). _(ops)_
  - or nginx + certbot via `deploy/nginx.conf.sample`.
- [ ] Verify: `curl -s https://<domain>/v1/health` → `{ "ok": true, ... }`.
- [ ] Confirm auth posture in prod: `GET /v1/waitlist/stats` returns **401** without a key, **200** with `X-HDV-Key`.
      `POST /v1/waitlist` works **without** a key (public, rate-limited).
- [ ] Publish the marketing pages behind the same domain (or a static host): `marketing/index.html` + `marketing/waitlist.html`.
- [ ] Point the waitlist form at prod: open `waitlist.html?api=https://<domain>` to preview, then set the deployed
      form's endpoint to the same-origin `/v1/waitlist` (default) or your gateway host. _(eng)_
- [ ] End-to-end: submit the real form, confirm `stats.total` increments (via `GET /v1/waitlist/stats` with the key).

## Day 3 — Sat Jul 25: Payments path (stub → ready)

Goal: an upgrade/checkout flow exists and is safe to demo; real Stripe is wire-in-ready.

- [ ] Exercise the checkout stub (`billing/stripe_stub.ts`): create sessions for STARTER/PRO/ENTERPRISE,
      confirm amounts match `DEFAULT_MONTHLY_PRICE_USD` and FREE needs no payment.
- [ ] Decide launch pricing: reconcile `DEFAULT_MONTHLY_PRICE_USD` (platform fee) with usage pricing in
      `config/pricing.json` and the tiers on `marketing/index.html#pricing`. _(founder)_
- [ ] If taking cards at launch: create the Stripe account, add `STRIPE_SECRET_KEY` to the server `.env`
      (test key first). The stub reflects `cs_test_`/`cs_live_` by key prefix — swap to the real SDK later. _(ops)_
- [ ] If NOT taking cards yet: keep the stub, route "Go Pro" CTAs to the waitlist. _(founder)_

## Day 4 — Sun Jul 26: Content, SEO, and analytics-light

Goal: the page tells the honest story and is shareable.

- [ ] Proof-read `marketing/index.html` copy against `docs/GTM.md` and `docs/MOAT.md` (no over-claims). _(founder)_
- [ ] Verify OG/meta tags render well (title, description, `og:*`) — test a link unfurl in Slack/X.
- [ ] Add a lightweight, privacy-respecting counter if desired (server-side `GET /v1/waitlist/stats` is enough
      to track signups without third-party trackers). _(eng)_
- [ ] Accessibility pass on `marketing/waitlist.html`: labels, focus states, keyboard submit, reduced-motion. _(eng)_

## Day 5 — Mon Jul 27: Harden + observe

Goal: the box survives launch traffic and you can see what's happening.

- [ ] Confirm rate limits: `HDV_RATE_LIMIT` tuned for expected traffic; `POST /v1/waitlist` stays rate-limited.
- [ ] Check `GET /v1/metrics` (and `?format=prometheus`) and wire an uptime probe against `/v1/health`. _(ops)_
- [ ] Back up Postgres (waitlist + ledger): schedule `pg_dump` (see `deploy/HOSTINGER.md`). _(ops)_
- [ ] Load-sanity: fire ~100 signups (unique emails) and confirm dedup, stats, and no 5xx. _(eng)_
- [ ] Confirm secrets are NOT in logs (the gateway logger never logs keys; verify `journalctl`/container logs). _(eng)_

## Day 6 — Tue Jul 28: Dry run + fallback

Goal: rehearse launch day and have a rollback.

- [ ] Full dress rehearsal: fresh browser → landing page → waitlist submit → confirmation → stats increment.
- [ ] Duplicate-submit test: same email twice returns 200 `duplicate:true` (no error, no dupe row).
- [ ] Prepare the announcement assets (X/LinkedIn/HN/newsletter) with the honest "conceptual capacity" framing. _(founder)_
- [ ] Rollback plan documented: `docker compose -f deploy/docker-compose.prod.yml down` + restore last DB dump. _(ops)_

## Day 7 — Wed Jul 29: LAUNCH

Goal: go live and capture demand.

- [ ] Final `curl https://<domain>/v1/health` + one live waitlist signup as a canary.
- [ ] Publish announcements; pin the waitlist link. _(founder)_
- [ ] Watch `GET /v1/waitlist/stats`, `/v1/metrics`, and server logs for the first few hours. _(all)_
- [ ] Reply to inbound within the day; tag high-intent signups (`interestedTier`, `useCase`) for follow-up. _(founder)_
- [ ] Retro note: what broke, what to automate next (webhooks, email confirmations, real Stripe). _(all)_

---

## Endpoints touched at launch

| Endpoint | Auth | Purpose |
|---|---|---|
| `GET /v1/health` | public | liveness/readiness probe |
| `POST /v1/waitlist` | **public** (rate-limited) | capture a signup from the marketing form |
| `GET /v1/waitlist/stats` | **protected** (API key) | privacy-safe aggregate signup stats (no raw emails) |
| `GET /v1/billing/pricing` | public | marketing pricing table |
| `POST /v1/billing/allowance` | protected | set a tenant allowance/tier |

## Files that power the launch

- `market/` — waitlist store + handlers (in-memory, dependency-free, dedup by email).
- `gateway/` — additive routes for the waitlist; `middleware.ts` keeps signup public but rate-limited.
- `billing/stripe_stub.ts` — checkout session stub (no `stripe` SDK; `STRIPE_SECRET_KEY` optional).
- `deploy/bootstrap_hostinger.sh` — one-command-ish KVM4 bootstrap (Node, Docker, UFW, clone, `.env`, compose up).
- `marketing/index.html` · `marketing/waitlist.html` — landing page + wired waitlist form.
- Runbook: `deploy/HOSTINGER.md` · GTM/pricing: `docs/GTM.md`.

## Go / No-Go gate (before Day 7)

- [ ] `https://<domain>/v1/health` green from an external network.
- [ ] Waitlist signup works end-to-end from the deployed page; stats increment.
- [ ] `HDV_API_KEY` set; `/v1/waitlist/stats` is 401 without it.
- [ ] TLS valid (no cert warnings); DNS resolves globally.
- [ ] DB backup taken in the last 24h; rollback rehearsed.
