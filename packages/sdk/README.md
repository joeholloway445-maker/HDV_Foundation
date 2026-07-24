# @big5-matrix/sdk

A tiny, typed, **fetch-based** client for the Big 5 Matrix (HDV Foundation) HOPE gateway.

It talks **only** to the gateway's public `/v1` HTTP surface. It imports **zero** agent
internals — no APEX router, no KNOLL engine, no node fleet — so it is safe to ship to browsers
and third parties. The full route contract lives in [`docs/openapi.yaml`](../../docs/openapi.yaml).

## Install

This package is part of the monorepo and is consumed directly from source in-repo. When
published it will be `npm i @big5-matrix/sdk`. It requires a global `fetch` (Node ≥ 18 or any
modern browser); pass your own `fetch` for older runtimes.

## Usage

```ts
import { HdvClient } from '@big5-matrix/sdk';

const hdv = new HdvClient({
  baseUrl: 'http://localhost:8787',
  apiKey: process.env.HDV_API_KEY, // optional; sent as Authorization: Bearer
  tenantId: 'acme',                // optional; sent as X-HDV-Tenant on tenant routes
});

// Submit a natural-language intent (HOPE → APEX → KNOLL → DREAM|VISION)
const res = await hdv.submitIntent('summarize the latest sales report');
console.log(res.routingStatus, res.voice);

// Resident-agent health + KNOLL gate state
console.log(await hdv.health());

// Observability snapshot (or Prometheus text)
console.log(await hdv.metrics());
console.log(await hdv.metricsPrometheus());

// Billing
console.log(await hdv.billingPricing());
console.log(await hdv.billingUsage({ tenantId: 'acme', limit: 10 }));
console.log(await hdv.billingEstimate({ activeParams: 7e9, durationSec: 2 }));

// Waitlist
await hdv.waitlistSignup({ email: 'founder@acme.com', interestedTier: 'PRO' });
console.log(await hdv.waitlistStats());
```

## Errors

Non-2xx responses throw `HdvApiError` with `.status`, `.path`, and the parsed `.body`.

## Covered routes

| Method | Path | Client method |
| ------ | ---- | ------------- |
| POST | `/v1/intent` | `submitIntent` |
| GET | `/v1/health` | `health` |
| GET | `/v1/metrics` | `metrics` / `metricsPrometheus` |
| GET | `/v1/billing/usage` | `billingUsage` |
| GET | `/v1/billing/pricing` | `billingPricing` |
| GET | `/v1/billing/estimate` | `billingEstimate` |
| POST | `/v1/billing/allowance` | `setBillingAllowance` |
| POST | `/v1/waitlist` | `waitlistSignup` |
| GET | `/v1/waitlist/stats` | `waitlistStats` |

The SDK is intentionally thin: it maps one method to one route and returns typed JSON. The
gateway remains the single source of truth for routing, gating (KNOLL), and metering (APEX).
