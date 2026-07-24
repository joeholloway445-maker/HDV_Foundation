# HOPE live app (`hope/app/`)

A minimal, **live** browser front-end for the Big 5 Matrix. It is a single self-contained
`index.html` (HTML + inline JS + CSS, no build step, no framework).

## The hard rule: zero agent imports

This page imports **no** agent modules — not APEX, not KNOLL, not the node fleet. It reaches
the system **only** over the public gateway `/v1` HTTP surface:

- `POST /v1/intent` — submit a natural-language intent (HOPE → APEX → KNOLL → DREAM|VISION)
- `GET  /v1/health` — resident/ephemeral agent health + KNOLL gate state (polled)
- `GET  /v1/metrics` — observability snapshot (polled)

Polling is used (every 3s) rather than SSE so it works against the current gateway with zero
server changes; swapping to an SSE `/v1/metrics/stream` later is a drop-in change in the
`poll()` function. The full contract is in [`docs/openapi.yaml`](../../docs/openapi.yaml), and
the same routes are wrapped by the typed [`@big5-matrix/sdk`](../../packages/sdk).

## Serve note

The page is static — serve it with any static file server and point it at a running gateway.

```bash
# 1. start the gateway (default http://localhost:8787)
npm run gateway

# 2. serve this folder (no new deps)
npx serve hope/app
#   or: python3 -m http.server 8080 --directory hope/app

# 3. open the page, pointing it at the gateway:
#   http://localhost:3000/?api=http://localhost:8787
```

If you serve the page from the same origin as the gateway, omit `?api=` — it defaults to the
page's own origin. When the gateway is on a different origin, ensure CORS is enabled there (or
serve both behind one reverse proxy).

Opening `index.html` directly via `file://` also works for the intent form and polling as long
as you pass `?api=http://localhost:8787` and the gateway allows cross-origin requests.
