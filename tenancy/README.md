# tenancy/ — BYOK + subscription model routing

Picks **which model** a tenant runs and **how it is served / paid for**. Built entirely on the
pure text providers in [`providers/`](../providers/README.md); it knows **nothing** about
agents, `RoutingPacket`s, APEX, KNOLL, DREAM, or VISION, and never executes or routes tasks —
it only decides where a text completion is sent.

## Concepts

- **Tenant** (`tenant.ts`) — `{ id, plan, byokKeys?, preferredModelId?, maxActiveParams? }`.
  - `plan`: `FREE | STARTER | PRO | ENTERPRISE | BYOK`.
  - `byokKeys.openaiCompatible`: `{ apiKey, baseUrl, model? }` — the tenant's own endpoint.
- **ModelCatalog** (`catalog.ts`) — loads `config/models.json` and `resolve(tenant, request)`s a
  concrete model from an explicit id **or** a desired parameter count (nearest match), scoped to
  what the plan (and the tenant's own `maxActiveParams`) allows.
- **ProviderRouter** (`router.ts`) — turns the resolved model into an `LlmProvider`:
  - `plan === BYOK` + usable keys → `OpenAiCompatibleProvider` at the **tenant's** `baseUrl`/key.
  - otherwise (**HDV subscription**) → platform keys from env by hosting: `hostinger`
    (`HDV_HOSTINGER_LLM_*`), `cloud` (`HDV_LLM_*`), `local` (`HDV_LOCAL_LLM_*` or the offline
    **StubProvider**). Missing platform config degrades gracefully to the stub.

**Security:** raw API keys are never logged, thrown, or serialized. `TenantRoute` exposes the
base URL and a **redacted** key hint only (`redactSecret` from `providers/`).

## Plan entitlements

| Plan | Hostings | Max active params |
| --- | --- | --- |
| FREE | local | 7B |
| STARTER | local, hostinger | 8B |
| PRO | local, hostinger, cloud | 70B |
| ENTERPRISE | local, hostinger, cloud | no cap |
| BYOK | any (tenant's own endpoint) | no cap |

## Usage

```ts
import { defaultCatalog, ProviderRouter, createTenantProvider } from './tenancy/index.js';

const catalog = defaultCatalog();

// Subscription tenant: pick by parameter count (nearest allowed model).
const pro = { id: 't1', plan: 'PRO' as const };
const route = new ProviderRouter(catalog).route(pro, { paramCount: 70 });
console.log(route.path, route.model.id, route.endpoint, route.keyHint); // no raw key

// BYOK tenant: uses their own endpoint + key.
const byok = {
  id: 't2',
  plan: 'BYOK' as const,
  byokKeys: { openaiCompatible: { apiKey: process.env.MY_KEY!, baseUrl: 'https://api.openai.com/v1' } },
};
const provider = createTenantProvider(byok, { catalog, request: { modelId: 'gpt-4o-mini' } });
const { text } = await provider.complete('Summarize this in one line.');
```

## Configuration (env)

| Variable | Path | Notes |
| --- | --- | --- |
| `HDV_HOSTINGER_LLM_BASE_URL` / `HDV_HOSTINGER_LLM_API_KEY` | subscription · hostinger | HDV-hosted open models |
| `HDV_LLM_BASE_URL` / `HDV_LLM_API_KEY` | subscription · cloud | shared with `providers/` |
| `HDV_LOCAL_LLM_BASE_URL` / `HDV_LOCAL_LLM_API_KEY` | local | optional; else offline stub |

The model catalog lives in [`config/models.json`](../config/models.json) (param counts in
billions, `hosting`, `providerKind`, `costMultiplier`, `runsOn`). It holds **no** secrets.

## Scripts

```bash
npm run demo:tenancy   # offline demo of BYOK + subscription + param-count routing
npm run test:tenancy   # tenancy tests (BYOK/subscription/nearest-param/no-key-leak)
```
