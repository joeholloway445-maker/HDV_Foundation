# FuckLike Deployment Guide

This document covers deploying the FuckLike companion app (fucklike.ai) and creator marketplace (fucklike.me) to a production VPS with nginx reverse proxy.

## Prerequisites

- VPS with public IP (e.g., 31.97.98.79)
- nginx installed on the host
- HDV Foundation gateway running on `127.0.0.1:8787` (see HOSTINGER.md §5 for Docker setup)
- DNS A records pointing both domains to the VPS:
  - `fucklike.ai` → 31.97.98.79
  - `fucklike.me` → 31.97.98.79

## Step 1: Copy nginx configs to the VPS

SSH into your VPS and run:

```bash
# From the VPS, assuming HDV_Foundation is cloned in /root/hdv_foundation:
cp /root/hdv_foundation/deploy/nginx-fucklike.ai.conf /etc/nginx/sites-available/fucklike.ai
cp /root/hdv_foundation/deploy/nginx-fucklike.me.conf /etc/nginx/sites-available/fucklike.me

# Enable the sites
ln -sfn /etc/nginx/sites-available/fucklike.ai /etc/nginx/sites-enabled/
ln -sfn /etc/nginx/sites-available/fucklike.me /etc/nginx/sites-enabled/
```

## Step 2: Set up fucklike.ai static files

```bash
# Create the web root
mkdir -p /var/www/fucklike.ai/public_html

# Copy the FuckLike companion app
cp -r /root/fucklike/web/* /var/www/fucklike.ai/public_html/

# Verify permissions
chown -R www-data:www-data /var/www/fucklike.ai/public_html
```

## Step 2.5: Generate the free art library (fixes blank gallery / no images on Create)

Without this step, the gallery shows solid-color placeholder cards and newly created
companions show only an initial-letter avatar — nothing is broken, there's just no art on
disk yet. This is a **one-time, $0 job** — no Colab account, no paid GPU, no signup. It runs
directly on this VPS's CPU (slower than a GPU, but free and unattended):

```bash
cd /root/hdv_foundation
pip install -q diffusers transformers accelerate safetensors torch --index-url https://download.pytorch.org/whl/cpu

# Point the output straight at the web root — no zip/upload round-trip needed.
# Runs in the background so it survives your SSH session disconnecting; expect this to take
# a while on CPU (potentially hours for the full 28-image matrix) — that's fine, let it churn.
BATCH_OUTPUT_DIR=/var/www/fucklike.ai/public_html/assets \
  nohup python3 colab/09_batch_pregenerate.py > /root/pregenerate.log 2>&1 &

# Check progress any time:
tail -f /root/pregenerate.log
```

It's resumable — if it gets interrupted, just re-run the same command; anything already on
disk is skipped. Once it finishes (or even partway through — it fills in one persona/archetype
at a time), copy the same `assets/` folder into fucklike.me too:

```bash
cp -r /var/www/fucklike.ai/public_html/assets /var/www/fucklike.me/public_html/assets
```

Both the 16 named gallery presets (`assets/personas/<id>/`) and the style×personality
archetype library that gives brand-new custom companions real art (`assets/templates/<id>/`)
come from this one script — see the file's header comment for the full explanation, including
how to run it on free Colab GPU instead if you'd rather have it finish in minutes instead of
hours (still free, just needs a browser tab open).

## Step 3: Set up fucklike.me (creator marketplace)

```bash
# Create the web root
mkdir -p /var/www/fucklike.me/public_html

# Copy the creator marketplace app (signup/login, submit a persona, see earnings, verify, payout)
cp -r /root/fucklike/web-creator/* /var/www/fucklike.me/public_html/

# Verify permissions
chown -R www-data:www-data /var/www/fucklike.me/public_html
```

This talks to the SAME gateway as fucklike.ai (`/v1/` is proxied the same way by
`nginx-fucklike.me.conf`) — a creator signs up with email+password, submits a persona, and can
see their accrued balance. Payouts stay blocked with a clear "not available yet" message until
`STRIPE_SECRET_KEY`/`STRIPE_WEBHOOK_SECRET` are configured (see `STRIPE_CONNECT_SETUP.md`) —
nothing to do here for that, it's automatic.

## Step 4: Test and reload nginx

```bash
# Test nginx config syntax
nginx -t

# Reload if syntax is OK
systemctl reload nginx
```

## Step 5: Obtain TLS certificates

```bash
# Use Certbot to get HTTPS certificates (interactive)
certbot --nginx -d fucklike.ai --redirect
certbot --nginx -d fucklike.me --redirect
```

This will:
- Obtain certificates from Let's Encrypt
- Automatically update the nginx configs to use HTTPS
- Set up HTTP → HTTPS redirects

## Verification

### Test fucklike.ai

1. Open https://fucklike.ai in a browser
2. You should see the FuckLike companion app
3. Browse the gallery — cards should show real pre-generated art (once Step 2.5 has produced
   at least a few images) instead of solid-color placeholders, no gateway needed
4. Try Create a companion — it should get real archetype art immediately, no gateway needed
5. For live chat: Open Settings → Developer → "Gateway base URL override", enter your gateway
   URL (e.g., `https://hopedreamvision.com` or `http://localhost:8787` if testing locally), and
   try the companion chat — you should get real responses from the gateway

### Test fucklike.me

1. Open https://fucklike.me in a browser
2. Click "Become a creator", sign up with a test email + password
3. Fill in the creator profile form and save — should show "Profile saved"
4. Fill in the persona form (any persona ID, e.g. `test-creator`) and save — should show "Persona saved"
5. Balance should show `$0.00` and status `Unverified` (that's correct — nobody has used your persona yet, and identity verification isn't turned on by default)
6. Click "Start identity verification" — should show a "pending" notice, no error
7. Try "Request payout" for any amount — should show a clear "not available yet" message (this is the intended safety behavior, not a bug — see `deploy/HOSTINGER.md` §0.1)

## Troubleshooting

**nginx: [error] open() "/var/www/fucklike.ai/public_html/index.html" failed**
- Make sure you ran Step 2 and the file exists
- Check permissions: `ls -la /var/www/fucklike.ai/public_html/`

**ERR_NAME_NOT_RESOLVED (DNS not pointing to the VPS)**
- Update your DNS A records to point fucklike.ai and fucklike.me to your VPS IP
- DNS changes can take up to 24 hours to propagate (check with `dig fucklike.ai`)

**Cannot reach /v1/ gateway endpoints**
- Make sure Docker container `hdv-gateway` is running: `docker ps | grep gateway`
- Make sure it's listening on 127.0.0.1:8787: `netstat -tlnp | grep 8787`
- Test locally from the VPS: `curl http://127.0.0.1:8787/v1/health`

**HTTPS certificate issues**
- Run `certbot renew --dry-run` to test renewal
- Certificates auto-renew; check `/var/log/letsencrypt/` for issues

## Creator Marketplace (fucklike.me) Web App

When the creator marketplace web app is ready:

1. Build the web app (framework TBD)
2. Copy the static files to `/var/www/fucklike.me/public_html/`
3. Update the nginx config if needed (currently assumes a SPA with /index.html as fallback)
4. Reload nginx

The web app will automatically proxy `/v1/` calls to the HDV gateway, just like fucklike.ai.

## Related Documentation

- HOSTINGER.md — Full VPS deployment & Docker setup
- deploy/docker-compose.prod.yml — Docker stack configuration
- gateway/server.ts — HTTP gateway routes
- gateway/middleware.ts — CORS, auth, rate limiting config
