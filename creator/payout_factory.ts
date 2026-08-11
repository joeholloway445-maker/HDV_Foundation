/**
 * creator/payout_factory.ts — build a CreatorPayoutProvider from the environment.
 *
 * Mirrors providers/tts_factory.ts / providers/image_factory.ts exactly. SAFE-BY-DEFAULT by
 * construction: the default is ALWAYS the unconditionally-blocked CreatorPayoutStub
 * (creator/payout_stub.ts) — a real Stripe Identity + Connect payout provider
 * (creator/payout_stripe_live.ts) is returned ONLY when BOTH STRIPE_SECRET_KEY (a real
 * `sk_test_…`/`sk_live_…` key, not empty/placeholder) AND STRIPE_WEBHOOK_SECRET are configured.
 * Anyone who hasn't set up real Stripe keys gets exactly the same safe-blocked behavior as
 * before this module existed — see creator/payout_stub.ts's module doc comment.
 *
 * Environment variables:
 *   STRIPE_SECRET_KEY    — sk_test_… or sk_live_… (shared with billing/stripe_stub.ts — one
 *                           Stripe account for the whole platform is intentional)
 *   STRIPE_WEBHOOK_SECRET — whsec_… signing secret for POST /v1/creator/webhooks/stripe
 *
 * Resolution order for each setting is: explicit argument -> environment variable -> default.
 */
import type { CreatorProfileRepository } from '../persistence/repositories.js';
import { CreatorPayoutStub } from './payout_stub.js';
import { CreatorPayoutStripeLive, type CreatorPayoutStripeLiveOptions } from './payout_stripe_live.js';
import type { CreatorPayoutProvider, CreatorPayoutProviderKind } from './payout_types.js';

export const ENV_STRIPE_SECRET_KEY = 'STRIPE_SECRET_KEY';
export const ENV_STRIPE_WEBHOOK_SECRET = 'STRIPE_WEBHOOK_SECRET';

export interface CreatorPayoutFactoryOptions {
  /** Explicit provider kind (overrides env-derived selection). */
  kind?: CreatorPayoutProviderKind;
  /** Explicit secret key (overrides env). */
  secretKey?: string;
  /** Explicit webhook secret (overrides env). */
  webhookSecret?: string;
  env?: NodeJS.ProcessEnv;
  /** Injectable Stripe client — passed straight through to CreatorPayoutStripeLive. Tests can
   *  supply a fake here so `createCreatorPayoutProvider({ kind: 'stripe_live', ... })` never
   *  makes a real network call even when exercising the "live" branch. */
  stripeClient?: CreatorPayoutStripeLiveOptions['stripeClient'];
  /** REQUIRED for the live provider (ignored for the stub) — see
   *  CreatorPayoutStripeLive's doc comment on why it needs durable storage. */
  creatorProfileRepository?: CreatorProfileRepository;
  /** Base URL for Connect onboarding redirect URLs (live provider only). */
  baseUrl?: string;
}

/** Raised when `kind: 'stripe_live'` is requested explicitly but required config is missing. */
export class UnknownCreatorPayoutProviderError extends Error {
  constructor(kind: string) {
    super(`Unknown creator payout provider kind ${JSON.stringify(kind)}; expected "stub" or "stripe_live".`);
    this.name = 'UnknownCreatorPayoutProviderError';
  }
}

/** True when `value` looks like a genuine Stripe secret key (test or live), not empty/placeholder. */
function isRealStripeKey(value: string): boolean {
  return value.startsWith('sk_test_') || value.startsWith('sk_live_');
}

/**
 * Resolve which kind of provider the environment calls for, WITHOUT constructing anything.
 * Exported mainly for tests/observability (e.g. an operator boot log can report "live" vs
 * "stub" without needing a repository on hand).
 */
export function resolveCreatorPayoutProviderKind(
  options: Pick<CreatorPayoutFactoryOptions, 'kind' | 'secretKey' | 'webhookSecret' | 'env'> = {},
): CreatorPayoutProviderKind {
  if (options.kind) return options.kind;
  const env = options.env ?? process.env;
  const secretKey = (options.secretKey ?? env[ENV_STRIPE_SECRET_KEY] ?? '').trim();
  const webhookSecret = (options.webhookSecret ?? env[ENV_STRIPE_WEBHOOK_SECRET] ?? '').trim();
  return isRealStripeKey(secretKey) && webhookSecret.length > 0 ? 'stripe_live' : 'stub';
}

/**
 * Build a provider from explicit options and/or the environment. Only the `stripe_live` path
 * can throw (missing repository / keys); the `stub` path never throws.
 */
export function createCreatorPayoutProvider(options: CreatorPayoutFactoryOptions = {}): CreatorPayoutProvider {
  const env = options.env ?? process.env;
  const kind = resolveCreatorPayoutProviderKind(options);

  if (kind === 'stub') {
    return new CreatorPayoutStub({ secretKey: options.secretKey, env });
  }

  if (kind === 'stripe_live') {
    if (!options.creatorProfileRepository) {
      throw new Error(
        'creator payout provider "stripe_live" requires a creatorProfileRepository (persists ' +
          'Connect account ids and the webhook-updated verification-status cache).',
      );
    }
    return new CreatorPayoutStripeLive({
      secretKey: options.secretKey ?? env[ENV_STRIPE_SECRET_KEY],
      webhookSecret: options.webhookSecret ?? env[ENV_STRIPE_WEBHOOK_SECRET],
      env,
      stripeClient: options.stripeClient,
      creatorProfileRepository: options.creatorProfileRepository,
      baseUrl: options.baseUrl,
    });
  }

  throw new UnknownCreatorPayoutProviderError(kind);
}

/**
 * Like createCreatorPayoutProvider, but NEVER throws: on any error (including misconfiguration
 * or a missing repository) it falls back to the safe, unconditionally-blocked CreatorPayoutStub.
 * This is the SAFE DEFAULT used by gateway/server.ts and gateway/cli.ts — a misconfiguration of
 * the live provider degrades to "payouts stay blocked", never to a crash or an accidentally-open
 * payout path.
 */
export function createCreatorPayoutProviderOrStub(options: CreatorPayoutFactoryOptions = {}): CreatorPayoutProvider {
  try {
    return createCreatorPayoutProvider(options);
  } catch {
    return new CreatorPayoutStub({ secretKey: options.secretKey, env: options.env });
  }
}
