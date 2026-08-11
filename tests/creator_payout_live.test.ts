/**
 * tests/creator_payout_live.test.ts — CreatorPayoutStripeLive unit tests (creator/payout_stripe_live.ts).
 *
 * ALL tests inject a fake `stripeClient` (a plain object with stubbed methods) — ZERO real
 * network calls, ZERO real Stripe test-mode API usage anywhere in this file.
 *
 * Coverage:
 *   A. requestVerification — creates a Connect Express account + Identity VerificationSession,
 *      persists both ids, reuses an existing Connect account on a second call.
 *   B. checkVerificationStatus — reads the local cache only (never calls Stripe).
 *   C. requestPayout — *** THE CRITICAL DEFENSE-IN-DEPTH TEST ***: proves requestPayout calls
 *      the LIVE retrieve methods and throws PayoutBlockedError even when the local cache says
 *      'verified' but Stripe's live retrieve response disagrees. Also covers the happy path
 *      (both live checks pass → a real transfer is created) and the missing-onboarding case.
 *   D. Construction guards — missing secretKey/webhookSecret/creatorProfileRepository throws
 *      CreatorPayoutStripeLiveConfigError.
 *
 * Run: node --import tsx --test tests/creator_payout_live.test.ts   (or the full suite: npm test)
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type Stripe from 'stripe';

import {
  CreatorPayoutStripeLive,
  CreatorPayoutStripeLiveConfigError,
  CreatorPayoutStub,
  PayoutBlockedError,
  PayoutStubError,
  createCreatorPayoutProvider,
  createCreatorPayoutProviderOrStub,
  resolveCreatorPayoutProviderKind,
} from '../creator/index.js';
import { InMemoryCreatorProfileRepository } from '../persistence/index.js';

/** Minimal fake Stripe client — only the methods CreatorPayoutStripeLive actually calls. Every
 *  test below injects one of these (or a variant) so NO real network call is ever made. */
function makeFakeStripe(overrides: Record<string, unknown> = {}): Stripe {
  const calls: Record<string, unknown[]> = {};
  const record = (name: string, args: unknown) => {
    (calls[name] ??= []).push(args);
  };

  const base = {
    _calls: calls,
    accounts: {
      create: async (args: unknown) => {
        record('accounts.create', args);
        return { id: 'acct_fake_1', payouts_enabled: false };
      },
      retrieve: async (id: string) => {
        record('accounts.retrieve', id);
        return { id, payouts_enabled: true };
      },
    },
    identity: {
      verificationSessions: {
        create: async (args: unknown) => {
          record('identity.verificationSessions.create', args);
          return { id: 'vs_fake_1', status: 'requires_input', url: 'https://verify.stripe.com/fake' };
        },
        retrieve: async (id: string) => {
          record('identity.verificationSessions.retrieve', id);
          return { id, status: 'verified' };
        },
      },
    },
    accountLinks: {
      create: async (args: unknown) => {
        record('accountLinks.create', args);
        return { url: 'https://connect.stripe.com/fake-onboarding' };
      },
    },
    transfers: {
      create: async (args: unknown) => {
        record('transfers.create', args);
        return { id: 'tr_fake_1' };
      },
    },
  };

  return { ...base, ...overrides } as unknown as Stripe;
}

function makeLive(overrides: {
  stripeClient?: Stripe;
  creatorProfileRepository?: InMemoryCreatorProfileRepository;
} = {}): { live: CreatorPayoutStripeLive; repo: InMemoryCreatorProfileRepository } {
  const repo = overrides.creatorProfileRepository ?? new InMemoryCreatorProfileRepository();
  const live = new CreatorPayoutStripeLive({
    secretKey: 'sk_test_fake',
    webhookSecret: 'whsec_fake',
    stripeClient: overrides.stripeClient ?? makeFakeStripe(),
    creatorProfileRepository: repo,
  });
  return { live, repo };
}

// ---------------------------------------------------------------------------
// A. requestVerification
// ---------------------------------------------------------------------------

test('requestVerification creates a Connect Express account + Identity VerificationSession and persists both ids', async () => {
  const { live, repo } = makeLive();
  const session = await live.requestVerification('creator-1', 1000);

  assert.equal(session.creatorUserId, 'creator-1');
  assert.equal(session.id, 'vs_fake_1');
  assert.equal(session.status, 'requires_input');
  assert.ok(session.url.length > 0);

  const profile = repo.get('creator-1');
  assert.equal(profile?.stripeAccountId, 'acct_fake_1');
  assert.equal(profile?.stripeVerificationSessionId, 'vs_fake_1');
  assert.equal(profile?.verificationStatusCache, 'pending');
});

test('requestVerification reuses an existing Connect account on a second call (does not call accounts.create again)', async () => {
  let accountCreateCalls = 0;
  const stripeClient = makeFakeStripe({
    accounts: {
      create: async () => {
        accountCreateCalls += 1;
        return { id: 'acct_fake_1', payouts_enabled: false };
      },
      retrieve: async (id: string) => ({ id, payouts_enabled: true }),
    },
  });
  const { live } = makeLive({ stripeClient });

  await live.requestVerification('creator-1');
  await live.requestVerification('creator-1');
  assert.equal(accountCreateCalls, 1, 'a second requestVerification must reuse the stored Connect account id');
});

test('requestVerification seeds a minimal CreatorProfile row when the creator has not applied yet', async () => {
  const { live, repo } = makeLive();
  await live.requestVerification('never-applied-creator');
  const profile = repo.get('never-applied-creator');
  assert.ok(profile, 'a row must exist so the Connect/Identity ids have somewhere durable to live');
  assert.equal(profile?.verificationStatus, 'unverified');
});

// ---------------------------------------------------------------------------
// B. checkVerificationStatus — local cache only, never calls Stripe
// ---------------------------------------------------------------------------

test('checkVerificationStatus reads the local cache and never calls Stripe', async () => {
  let calledStripe = false;
  const stripeClient = makeFakeStripe({
    identity: {
      verificationSessions: {
        create: async () => ({ id: 'vs_fake_1', status: 'requires_input', url: 'https://x' }),
        retrieve: async () => {
          calledStripe = true;
          return { id: 'vs_fake_1', status: 'verified' };
        },
      },
    },
  });
  const { live } = makeLive({ stripeClient });

  assert.equal(live.checkVerificationStatus('unknown-creator'), 'unverified');
  await live.requestVerification('creator-1');
  assert.equal(live.checkVerificationStatus('creator-1'), 'pending');
  assert.equal(calledStripe, false, 'checkVerificationStatus must be a pure local read');
});

// ---------------------------------------------------------------------------
// C. requestPayout — THE SAFETY GATE
// ---------------------------------------------------------------------------

test('*** THE CRITICAL DEFENSE-IN-DEPTH TEST *** requestPayout calls the LIVE retrieve methods and throws PayoutBlockedError even when the local cache says "verified" but Stripe live disagrees', async () => {
  let sessionRetrieveCalled = false;
  const stripeClient = makeFakeStripe({
    identity: {
      verificationSessions: {
        create: async () => ({ id: 'vs_fake_1', status: 'requires_input', url: 'https://x' }),
        // LIVE check disagrees with the cache: NOT verified.
        retrieve: async (id: string) => {
          sessionRetrieveCalled = true;
          return { id, status: 'requires_input' };
        },
      },
    },
    transfers: {
      create: async () => {
        throw new Error('transfers.create must NEVER be called when the live recheck fails');
      },
    },
  });
  const repo = new InMemoryCreatorProfileRepository();
  const { live } = makeLive({ stripeClient, creatorProfileRepository: repo });

  await live.requestVerification('creator-stale-cache');
  // Simulate a stale/incorrect local cache claiming 'verified' (e.g. a hypothetical bug in the
  // webhook handler) — the live recheck below MUST NOT trust this.
  live.updateVerificationCache('creator-stale-cache', 'verified');
  assert.equal(
    live.checkVerificationStatus('creator-stale-cache'),
    'verified',
    'precondition: the local cache says verified',
  );

  await assert.rejects(
    () => live.requestPayout('creator-stale-cache', 25),
    (err: unknown) => err instanceof PayoutBlockedError && err.code === 'not_verified',
  );
  assert.equal(sessionRetrieveCalled, true, 'requestPayout must call identity.verificationSessions.retrieve LIVE');
});

test('requestPayout throws PayoutBlockedError when the live Identity check passes but payouts_enabled is false', async () => {
  const stripeClient = makeFakeStripe({
    identity: {
      verificationSessions: {
        create: async () => ({ id: 'vs_fake_1', status: 'requires_input', url: 'https://x' }),
        retrieve: async (id: string) => ({ id, status: 'verified' }),
      },
    },
    accounts: {
      create: async () => ({ id: 'acct_fake_1', payouts_enabled: false }),
      retrieve: async (id: string) => ({ id, payouts_enabled: false }), // LIVE: not enabled
    },
    transfers: {
      create: async () => {
        throw new Error('transfers.create must NEVER be called when payouts_enabled is false');
      },
    },
  });
  const { live } = makeLive({ stripeClient });
  await live.requestVerification('creator-2');

  await assert.rejects(
    () => live.requestPayout('creator-2', 10),
    (err: unknown) => err instanceof PayoutBlockedError && err.code === 'not_verified',
  );
});

test('requestPayout succeeds and creates a real transfer when BOTH live checks pass', async () => {
  let transferArgs: Record<string, unknown> | undefined;
  const stripeClient = makeFakeStripe({
    identity: {
      verificationSessions: {
        create: async () => ({ id: 'vs_fake_1', status: 'requires_input', url: 'https://x' }),
        retrieve: async (id: string) => ({ id, status: 'verified' }),
      },
    },
    accounts: {
      create: async () => ({ id: 'acct_fake_1', payouts_enabled: true }),
      retrieve: async (id: string) => ({ id, payouts_enabled: true }),
    },
    transfers: {
      create: async (args: Record<string, unknown>) => {
        transferArgs = args;
        return { id: 'tr_fake_success' };
      },
    },
  });
  const { live } = makeLive({ stripeClient });
  await live.requestVerification('creator-3');

  const result = await live.requestPayout('creator-3', 12.5);
  assert.equal(result.stripeTransferId, 'tr_fake_success');
  assert.equal(result.amountUsd, 12.5);
  assert.equal(result.status, 'submitted');
  assert.equal(transferArgs?.amount, 1250, 'amountUsd must be converted to cents');
  assert.equal(transferArgs?.currency, 'usd');
  assert.equal(transferArgs?.destination, 'acct_fake_1');
});

test('requestPayout throws PayoutBlockedError when the creator has never started verification/onboarding', async () => {
  const { live } = makeLive();
  await assert.rejects(
    () => live.requestPayout('never-verified', 5),
    (err: unknown) => err instanceof PayoutBlockedError,
  );
});

test('requestPayout rejects a non-positive amount with PayoutStubError before making any Stripe call', async () => {
  let anyStripeCall = false;
  const stripeClient = makeFakeStripe({
    identity: {
      verificationSessions: {
        create: async () => ({ id: 'vs_fake_1', status: 'requires_input', url: 'https://x' }),
        retrieve: async (id: string) => {
          anyStripeCall = true;
          return { id, status: 'verified' };
        },
      },
    },
  });
  const { live } = makeLive({ stripeClient });
  await live.requestVerification('creator-4');

  await assert.rejects(() => live.requestPayout('creator-4', 0), PayoutStubError);
  await assert.rejects(() => live.requestPayout('creator-4', -5), PayoutStubError);
  assert.equal(anyStripeCall, false, 'invalid amount must be rejected before any Stripe call');
});

// ---------------------------------------------------------------------------
// D. Construction guards
// ---------------------------------------------------------------------------

test('constructing CreatorPayoutStripeLive without a secretKey/webhookSecret/repository throws CreatorPayoutStripeLiveConfigError', () => {
  const repo = new InMemoryCreatorProfileRepository();
  assert.throws(
    () => new CreatorPayoutStripeLive({ webhookSecret: 'whsec_x', creatorProfileRepository: repo, env: {} }),
    CreatorPayoutStripeLiveConfigError,
  );
  assert.throws(
    () => new CreatorPayoutStripeLive({ secretKey: 'sk_test_x', creatorProfileRepository: repo, env: {} }),
    CreatorPayoutStripeLiveConfigError,
  );
  assert.throws(
    () =>
      new CreatorPayoutStripeLive({
        secretKey: 'sk_test_x',
        webhookSecret: 'whsec_x',
        creatorProfileRepository: undefined as unknown as InMemoryCreatorProfileRepository,
        env: {},
      }),
    CreatorPayoutStripeLiveConfigError,
  );
});

test('livemode is derived from the sk_live_/sk_test_ prefix, same convention as StripeCheckoutStub/CreatorPayoutStub', () => {
  const repo = new InMemoryCreatorProfileRepository();
  const testMode = new CreatorPayoutStripeLive({
    secretKey: 'sk_test_x',
    webhookSecret: 'whsec_x',
    stripeClient: makeFakeStripe(),
    creatorProfileRepository: repo,
  });
  assert.equal(testMode.livemode, false);

  const liveMode = new CreatorPayoutStripeLive({
    secretKey: 'sk_live_x',
    webhookSecret: 'whsec_x',
    stripeClient: makeFakeStripe(),
    creatorProfileRepository: repo,
  });
  assert.equal(liveMode.livemode, true);
});

// ---------------------------------------------------------------------------
// E. creator/payout_factory.ts — env-driven selection
// ---------------------------------------------------------------------------

test('createCreatorPayoutProvider(OrStub) returns CreatorPayoutStub when STRIPE_SECRET_KEY/STRIPE_WEBHOOK_SECRET are unconfigured', () => {
  const repo = new InMemoryCreatorProfileRepository();
  const emptyEnv = {};

  assert.equal(resolveCreatorPayoutProviderKind({ env: emptyEnv }), 'stub');

  const provider = createCreatorPayoutProvider({ env: emptyEnv, creatorProfileRepository: repo });
  assert.ok(provider instanceof CreatorPayoutStub);

  const providerOrStub = createCreatorPayoutProviderOrStub({ env: emptyEnv, creatorProfileRepository: repo });
  assert.ok(providerOrStub instanceof CreatorPayoutStub);
});

test('createCreatorPayoutProvider(OrStub) returns CreatorPayoutStub when only ONE of the two env vars is set', () => {
  const repo = new InMemoryCreatorProfileRepository();
  assert.ok(
    createCreatorPayoutProvider({
      env: { STRIPE_SECRET_KEY: 'sk_test_only' },
      creatorProfileRepository: repo,
    }) instanceof CreatorPayoutStub,
  );
  assert.ok(
    createCreatorPayoutProvider({
      env: { STRIPE_WEBHOOK_SECRET: 'whsec_only' },
      creatorProfileRepository: repo,
    }) instanceof CreatorPayoutStub,
  );
});

test('createCreatorPayoutProvider(OrStub) returns CreatorPayoutStripeLive when BOTH env vars are configured (fake stripeClient — no real key needed)', () => {
  const repo = new InMemoryCreatorProfileRepository();
  const env = { STRIPE_SECRET_KEY: 'sk_test_realish', STRIPE_WEBHOOK_SECRET: 'whsec_realish' };

  assert.equal(resolveCreatorPayoutProviderKind({ env }), 'stripe_live');

  const provider = createCreatorPayoutProvider({
    env,
    stripeClient: makeFakeStripe(),
    creatorProfileRepository: repo,
  });
  assert.ok(provider instanceof CreatorPayoutStripeLive);

  const providerOrStub = createCreatorPayoutProviderOrStub({
    env,
    stripeClient: makeFakeStripe(),
    creatorProfileRepository: repo,
  });
  assert.ok(providerOrStub instanceof CreatorPayoutStripeLive);
});

test('createCreatorPayoutProviderOrStub degrades safely to the stub when the live provider is requested but no creatorProfileRepository is supplied', () => {
  const env = { STRIPE_SECRET_KEY: 'sk_test_realish', STRIPE_WEBHOOK_SECRET: 'whsec_realish' };
  const providerOrStub = createCreatorPayoutProviderOrStub({ env, stripeClient: makeFakeStripe() });
  assert.ok(providerOrStub instanceof CreatorPayoutStub, 'misconfiguration must degrade to the safe stub, never throw');

  assert.throws(() => createCreatorPayoutProvider({ env, stripeClient: makeFakeStripe() }));
});

test('a placeholder/empty STRIPE_SECRET_KEY (not sk_test_/sk_live_) is treated as unconfigured', () => {
  const repo = new InMemoryCreatorProfileRepository();
  const provider = createCreatorPayoutProvider({
    env: { STRIPE_SECRET_KEY: 'not-a-real-key', STRIPE_WEBHOOK_SECRET: 'whsec_x' },
    creatorProfileRepository: repo,
  });
  assert.ok(provider instanceof CreatorPayoutStub);
});
