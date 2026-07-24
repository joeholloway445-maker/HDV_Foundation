# AGENT HANDOFF PROMPT — start a new Cursor Cloud Agent to finish the Hostinger deploy

> Copy the block below into a **new Cursor Cloud Agent** with the **`HDV_Foundation` repo
> attached**. It tells the agent exactly what to do to finish the Hostinger + domain deploy,
> which secrets to read from the environment, and which invariants it must never violate.
>
> **Before you start the agent, add these secrets** (Cursor Dashboard → Cloud Agents → Secrets):
>
> | Secret | Required | Example / notes |
> |--------|----------|-----------------|
> | `HOSTINGER_SSH` | **Yes** | SSH target for the VPS, e.g. `root@203.0.113.10` (or `hdv@<ip>`). Add the matching SSH key to the box, or include a password path. |
> | `DOMAIN` | **Yes** | FQDN to serve on, e.g. `api.yourdomain.com`. |
> | `HDV_API_KEY` | Optional | Pin a known API key; if omitted the bootstrap generates one on the box. |
>
> (Optional extras the deploy can use if present: `STRIPE_SECRET_KEY`, `HDV_LLM_API_KEY`.)

---

## Copy-paste prompt

```text
You are finishing the production deployment of the HDV Foundation "HOPE gateway" onto a
Hostinger KVM4 VPS with a real domain and TLS. The HDV_Foundation repo is attached; the app
lives in the big5-matrix/ subdirectory. Work autonomously and do NOT ask me questions — read
everything you need from the repo and from the secrets injected as environment variables.

SECRETS (read from env; never print or commit them):
  - HOSTINGER_SSH : SSH target for the VPS, e.g. "root@203.0.113.10". Use it to SSH in.
  - DOMAIN        : the FQDN to serve on, e.g. "api.yourdomain.com".
  - HDV_API_KEY   : OPTIONAL. If set, pin it in the box's .env; if unset, the bootstrap
                    generates one and you must read it back from the box's .env for verification.

AUTHORITATIVE DOCS (read these first, in this order):
  1. big5-matrix/docs/HANDOFF_HOSTINGER.md   <- the full step-by-step handoff
  2. big5-matrix/deploy/bootstrap_hostinger.sh
  3. big5-matrix/deploy/HOSTINGER.md and big5-matrix/deploy/OLLAMA.md
  4. big5-matrix/.cursorrules and big5-matrix/packages/constitution/README.md (invariants)

DO THIS, IN ORDER:
  1. SSH to the VPS using $HOSTINGER_SSH. Confirm you can run sudo.
  2. Deploy: run the idempotent bootstrap on the box (safe to re-run):
        export DOMAIN="$DOMAIN"
        sudo -E DOMAIN="$DOMAIN" bash big5-matrix/deploy/bootstrap_hostinger.sh
     (clone the repo onto the box first if it isn't there; the script also installs
      Node/Docker/UFW, renders .env with a generated HDV_API_KEY, and brings the stack up.)
     If HDV_API_KEY was provided as a secret, ensure it is the value written in the box's
     big5-matrix/.env; otherwise read the generated key back from that .env for later checks.
  3. Enable TLS on the domain: ensure DNS A/AAAA for $DOMAIN points at the VPS IP (remind me
     if I must set it at the registrar and it isn't resolving yet), then install Caddy and the
     shipped Caddyfile, substitute $DOMAIN into it, and reload Caddy so it auto-issues
     Let's Encrypt certs:
        sudo cp /opt/hdv-foundation/big5-matrix/deploy/Caddyfile /etc/caddy/Caddyfile
        sudo sed -i "s/api\.yourdomain\.com/$DOMAIN/" /etc/caddy/Caddyfile
        sudo systemctl reload caddy
  4. Run a local 7B model with Ollama on the same box for co-located inference:
        curl -fsSL https://ollama.com/install.sh | sh
        sudo systemctl edit ollama   # Environment="OLLAMA_HOST=127.0.0.1:11434"
        sudo systemctl daemon-reload && sudo systemctl restart ollama
        ollama pull mistral          # a 7B model (or llama3.1:8b; tinyllama on tiny boxes)
     Wire it into big5-matrix/.env:
        HDV_LLM_PROVIDER=openai_compatible
        HDV_LLM_BASE_URL=http://127.0.0.1:11434/v1
        HDV_LLM_MODEL=mistral
        HDV_LLM_API_KEY=
     Restart the gateway (systemctl restart hdv-gateway, or `docker compose ... up -d gateway`).
     Keep Ollama loopback-only — never `ufw allow 11434`.
  5. Verify /v1/health is public over HTTPS, plus the rest of the public surface:
        BASE_URL="https://$DOMAIN" bash big5-matrix/scripts/verify_public.sh
     It must exit 0 (checks health, pricing, waitlist, metrics). Also confirm a protected route
     returns 401 without the key and 200 with `-H "X-HDV-Key: $HDV_API_KEY"`.
  6. Open the marketing page on the domain: either serve big5-matrix/marketing on the apex
     domain via the commented Caddy block, or confirm the static page loads and posts to
     https://$DOMAIN/v1/waitlist (?api=https://$DOMAIN). Do a real waitlist signup and confirm
     a 201 (or 200 on repeat).

CONSTITUTION INVARIANTS (binding — never violate; see .cursorrules and packages/constitution):
  - Single legal road: all inter-agent traffic flows SOURCE -> APEX -> KNOLL -> DEST. No agent
    talks to another directly. DREAM and VISION never communicate directly, ever.
  - APEX is the sole router and MUST call KNOLL.intercept() before every route; the gateway
    only submits HOPE -> APEX and never bypasses APEX or KNOLL.
  - Enforce the RoutingPacket contract; any non-conforming inter-agent data = compromised =
    BLOCKED. Never put a provider/API key into a RoutingPacket.
  - Providers (Ollama/any LLM) are pure text transducers: complete(prompt) -> { text }. They
    only enrich text; they never route, execute, create, or govern.
  - Network layer must mirror the road: the gateway stays on 127.0.0.1:8787 behind the proxy;
    5432/6379/11434 stay internal. Only 22/80/443 are public. Never expose 8787/5432/6379/11434.
  - /v1/health and /v1/billing/pricing are the ONLY always-public routes; everything else is
    KNOLL-gated and API-key-protected.
  - Never commit .env or any secret; .env is chmod 600 and git-ignored.

DO NOT: git commit/push app code changes as part of deploy, open/merge PRs, force-push, weaken
any invariant above, or expose internal ports. This is infrastructure + config only.

WHEN DONE: report the live URLs (https://$DOMAIN/v1/health, pricing, marketing), the output of
verify_public.sh, the Ollama model running, and confirm the invariants above still hold.
```

---

## Notes for whoever launches this agent

- The agent needs **outbound network + SSH** from its environment to reach the VPS. If Cloud
  Agent egress is restricted, allow the VPS host (and GitHub, Caddy/cloudsmith, ollama.com,
  nodesource, get.docker.com) or run the bootstrap by SSHing from a machine that can.
- If the repo is **private**, make sure the agent can clone it onto the VPS (deploy token / SSH
  key), or `scp` the checkout up.
- DNS is the one step that may need a human at the registrar; the agent will flag it if `$DOMAIN`
  isn't resolving to the VPS yet. TLS issuance only succeeds once the A record propagates.
- Everything the agent needs beyond secrets is in [`docs/HANDOFF_HOSTINGER.md`](./HANDOFF_HOSTINGER.md).
