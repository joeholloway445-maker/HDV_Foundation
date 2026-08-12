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

## Step 3: Set up fucklike.me (placeholder)

```bash
# Create the web root
mkdir -p /var/www/fucklike.me/public_html

# Create placeholder index (replace with real app when ready)
echo '<html><body><h1>FuckLike Creator Marketplace</h1><p>Coming soon...</p></body></html>' > /var/www/fucklike.me/public_html/index.html

# Verify permissions
chown -R www-data:www-data /var/www/fucklike.me/public_html
```

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
3. Open Settings → Developer → "Gateway base URL override"
4. Enter your gateway URL (e.g., `https://hopedreamvision.com` or `http://localhost:8787` if testing locally)
5. Try the companion chat — you should get real responses from the gateway

### Test fucklike.me

1. Open https://fucklike.me in a browser
2. You should see "Coming soon" placeholder
3. Once the creator marketplace web app is built, replace `/var/www/fucklike.me/public_html/index.html` with the real app

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
