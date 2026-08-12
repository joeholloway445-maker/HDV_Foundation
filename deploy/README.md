# deploy/ — production deployment for HDV Foundation

Runbooks and sample configs to put the always-on **HOPE gateway** in front of the world,
on a **Hostinger KVM4** VPS, with optional co-located **local LLM** inference.

Every path here preserves the constitution: the gateway submits `HOPE → APEX` only, KNOLL
gates every routed packet, and no side service (Postgres/Redis/Ollama) is publicly exposed.

| File | What it is |
|------|------------|
| [`HOSTINGER.md`](./HOSTINGER.md) | The full KVM4 runbook: Node 22, firewall, domain, systemd **or** Docker, TLS, env vars, BYOK vs platform keys. Start here. |
| [`docker-compose.prod.yml`](./docker-compose.prod.yml) | Gateway + Postgres + Redis (+ optional Ollama profile). Loopback-only gateway. |
| [`Dockerfile`](./Dockerfile) | Multi-stage production image for the gateway (build gate: `db:generate` + `typecheck`). |
| [`Caddyfile`](./Caddyfile) | HTTPS reverse proxy with automatic Let's Encrypt TLS. |
| [`nginx.conf.sample`](./nginx.conf.sample) | nginx + certbot reverse-proxy alternative. |
| [`hdv-gateway.service`](./hdv-gateway.service) | systemd unit for the bare-metal (no Docker) path. |
| [`OLLAMA.md`](./OLLAMA.md) | Local 7B/8B inference on the same VPS; wiring `HDV_LLM_*` for self-host / BYOK. |
| [`STRIPE_CONNECT_SETUP.md`](./STRIPE_CONNECT_SETUP.md) | Plain-English, numbered steps to turn on real creator-marketplace payouts (Stripe Identity + Connect). Optional — everything works without it. |

Quick start (bare metal): [`HOSTINGER.md`](./HOSTINGER.md) §1–§6.
Quick start (Docker): [`HOSTINGER.md`](./HOSTINGER.md) §7.

Go-to-market, pricing, and the launch checklist live in [`../docs/GTM.md`](../docs/GTM.md).
The marketing landing page is [`../marketing/index.html`](../marketing/index.html)
(`npm run marketing`).
