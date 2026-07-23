/**
 * demo/run_tenancy_demo.ts — BYOK + subscription model routing, end to end.
 *
 * Shows how the tenancy layer decides, for each tenant:
 *   1. WHICH model (by explicit id or nearest parameter count, within plan entitlements).
 *   2. HOW it is served / paid for (BYOK tenant endpoint vs HDV subscription vs offline stub).
 *   3. That raw API keys NEVER appear in route metadata (only a redacted hint).
 *
 * Offline-first: with no env set, subscription/local paths degrade to the deterministic
 * StubProvider so this runs fully offline. Set HDV_HOSTINGER_LLM_* / HDV_LLM_* / HDV_LOCAL_LLM_*
 * to route to real endpoints. Nothing here executes, routes packets, or creates — text only.
 *
 * Run: npm run demo:tenancy
 */
import { defaultCatalog, ProviderRouter, type Tenant } from '../tenancy/index.js';

function hr(title: string): void {
  console.log('\n' + '='.repeat(74));
  console.log(title);
  console.log('='.repeat(74));
}

async function main(): Promise<void> {
  hr('BIG 5 MATRIX — TENANCY DEMO (BYOK + subscription · text only · never executes)');

  const catalog = defaultCatalog();
  const router = new ProviderRouter(catalog); // reads process.env for platform keys

  hr('CATALOG (config/models.json) — param counts in billions');
  for (const m of catalog.models) {
    console.log(
      `  ${m.id.padEnd(22)} ${String(m.parameterCount).padStart(5)}B  ` +
        `${m.hosting.padEnd(9)} x${m.costMultiplier}  runsOn=[${m.runsOn.join(', ')}]`,
    );
  }

  const tenants: Array<{ label: string; tenant: Tenant; request?: { modelId?: string; paramCount?: number } }> = [
    { label: 'FREE, wants ~7B', tenant: { id: 'free-1', plan: 'FREE' }, request: { paramCount: 7 } },
    { label: 'STARTER, wants 8B hosted', tenant: { id: 'starter-1', plan: 'STARTER' }, request: { modelId: 'llama3-8b-hostinger' } },
    { label: 'PRO, wants ~70B (nearest)', tenant: { id: 'pro-1', plan: 'PRO' }, request: { paramCount: 65 } },
    { label: 'ENTERPRISE, wants cloud gpt-4o-mini', tenant: { id: 'ent-1', plan: 'ENTERPRISE' }, request: { modelId: 'gpt-4o-mini' } },
    {
      label: 'BYOK, own OpenAI-compatible key',
      tenant: {
        id: 'byok-1',
        plan: 'BYOK',
        byokKeys: { openaiCompatible: { apiKey: 'sk-demo-tenant-key-abcdef123456', baseUrl: 'https://api.openai.com/v1' } },
      },
      request: { modelId: 'gpt-4o-mini' },
    },
  ];

  hr('ROUTING — model selection + serving path (keys shown only as a redacted hint)');
  for (const { label, tenant, request } of tenants) {
    const route = router.route(tenant, request ?? {});
    console.log(`\n${label}`);
    console.log(`  tenant  : ${tenant.id} (plan ${tenant.plan})`);
    console.log(`  model   : ${route.model.id} (${route.model.parameterCount}B, ${route.model.hosting})`);
    console.log(`  path    : ${route.path}  billedTo=${route.billedTo}`);
    console.log(`  endpoint: ${route.endpoint}`);
    console.log(`  key     : ${route.keyHint}`); // redacted — never the raw key
    console.log(`  provider: ${route.provider.name} (model=${route.provider.model})`);
  }

  hr('SAMPLE COMPLETION — whatever path the FREE tenant resolved to (offline stub by default)');
  const freeRoute = router.route({ id: 'free-1', plan: 'FREE' }, { paramCount: 7 });
  const result = await freeRoute.provider.complete('In one line, what is BYOK?', { maxTokens: 40 });
  console.log(`  text : ${result.text}`);
  console.log(`  usage: ${result.usage.totalTokens} tokens (model=${result.model})`);

  hr('TENANCY DEMO COMPLETE — model routing only; nothing executed, routed, or created.');
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
