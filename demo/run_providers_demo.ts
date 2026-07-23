/**
 * demo/run_providers_demo.ts — the optional LLM provider seam, end to end.
 *
 * Shows:
 *   1. The env-driven factory building a provider (defaults to the offline StubProvider).
 *   2. A raw completion through whichever provider is configured.
 *   3. HOPE's dependency-injected enricher improving the intent SUMMARY only — after the
 *      heuristic classifier has run — and falling back to heuristics with no provider.
 *
 * Offline-first: with no env set this runs fully offline via the deterministic stub. To try a
 * real backend, set HDV_LLM_PROVIDER=openai_compatible plus HDV_LLM_BASE_URL / HDV_LLM_MODEL
 * (and HDV_LLM_API_KEY if required). Nothing here executes, routes, or creates — text only.
 *
 * Run: npm run demo:providers
 */
import { createProviderOrStub } from '../providers/index.js';
import { IntentInterpreter, IntentEnricher } from '../hope/index.js';

function hr(title: string): void {
  console.log('\n' + '='.repeat(74));
  console.log(title);
  console.log('='.repeat(74));
}

async function main(): Promise<void> {
  hr('BIG 5 MATRIX — PROVIDERS DEMO (optional LLM seam · text only · never executes)');

  // 1. Build a provider from the environment. Falls back to the offline stub on any misconfig.
  const provider = createProviderOrStub();
  console.log(`Provider: ${provider.name}  (model: ${provider.model})`);
  console.log(
    provider.name === 'stub'
      ? 'Running offline-first with the deterministic StubProvider (no network, no API key).'
      : 'Running against a configured OpenAI-compatible endpoint.',
  );

  // 2. A raw completion through the provider.
  hr('RAW COMPLETION');
  const prompt = 'In one line, describe what an intent router does.';
  console.log(`Prompt: ${prompt}`);
  try {
    const result = await provider.complete(prompt, { maxTokens: 60 });
    console.log(`Text  : ${result.text}`);
    console.log(`Usage : ${result.usage.totalTokens} tokens (model=${result.model})`);
  } catch (err) {
    console.log(`Provider call failed: ${err instanceof Error ? err.message : String(err)}`);
  }

  // 3. HOPE enrichment: heuristic classify first, then (optionally) improve the summary text.
  hr('HOPE INTENT SUMMARY — heuristic classify, then optional LLM enrichment');
  const interpreter = new IntentInterpreter();
  const enricher = new IntentEnricher({ provider });
  console.log(`Enricher can enrich via provider: ${enricher.canEnrich}`);

  const utterances = [
    'Simulate how "Project Atlas" could launch, I want to reach 1000 users without spending over $500',
    'run and deploy the whole pipeline right now',
    'document that we deferred the "Beta" rollout until next quarter',
  ];

  for (const utterance of utterances) {
    const intent = interpreter.interpret(utterance);
    const { summary } = await enricher.enrichIntent(intent);
    console.log(`\nYou      : ${utterance}`);
    console.log(`Classify : kind=${intent.kind} -> ${intent.suggestedDestination} (confidence=${intent.confidence})`);
    console.log(`Summary  : ${summary.summary}`);
    console.log(`Source   : ${summary.source}${summary.model ? ` (${summary.model})` : ''}${summary.error ? ` [fallback: ${summary.error}]` : ''}`);
  }

  hr('PROVIDERS DEMO COMPLETE — text enrichment only; nothing executed, routed, or created.');
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
