/**
 * tests/creator_webhook.test.ts — handleStripeWebhook unit tests (creator/stripe_webhook.ts).
 *
 * ALL tests inject a fake `stripeClient` whose `webhooks.constructEvent` is fully controlled by
 * the test (throws to simulate an invalid/forged signature, or returns a canned Stripe.Event) —
 * ZERO real network calls and ZERO real HMAC/crypto machinery needed to exercise this handler's
 * dispatch logic and, critically, its signature-verification-first posture.
 *
 * Coverage:
 *   A. Valid signature + identity.verification_session.verified → cache updated to 'verified'.
 *   B. Missing stripe-signature header → 400, cache untouched.
 *   C. Invalid/forged signature (constructEvent throws) → 400, cache untouched, payload NEVER read.
 *   D. identity.verification_session.requires_input / .canceled → cache updated accordingly.
 *   E. account.updated and an entirely unrecognized event type → 200, safe no-op (not an error).
 *
 * Run: node --import tsx --test tests/creator_webhook.test.ts   (or the full suite: npm test)
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type Stripe from 'stripe';

import { CreatorPayoutStripeLive, handleStripeWebhook } from '../creator/index.js';
import { InMemoryCreatorProfileRepository } from '../persistence/index.js';

/** A fake Stripe client whose `webhooks.constructEvent` is fully test-controlled. */
function makeFakeStripe(constructEvent: (raw: unknown, sig: unknown, secret: unknown) => Stripe.Event): Stripe {
  return {
    webhooks: { constructEvent },
    // The other surfaces CreatorPayoutStripeLive needs at construction time; unused by these
    // webhook tests but required so `new CreatorPayoutStripeLive(...)` type-checks/works.
    accounts: { create: async () => ({ id: 'acct_x' }), retrieve: async (id: string) => ({ id, payouts_enabled: true }) },
    identity: {
      verificationSessions: {
        create: async () => ({ id: 'vs_x', status: 'requires_input', url: 'https://x' }),
        retrieve: async (id: string) => ({ id, status: 'verified' }),
      },
    },
    accountLinks: { create: async () => ({ url: 'https://x' }) },
    transfers: { create: async () => ({ id: 'tr_x' }) },
  } as unknown as Stripe;
}

function fakeEvent(type: string, dataObject: Record<string, unknown>): Stripe.Event {
  return { id: 'evt_1', type, data: { object: dataObject } } as unknown as Stripe.Event;
}

function makeHarness(constructEvent: (raw: unknown, sig: unknown, secret: unknown) => Stripe.Event) {
  const stripeClient = makeFakeStripe(constructEvent);
  const repo = new InMemoryCreatorProfileRepository();
  const payoutProvider = new CreatorPayoutStripeLive({
    secretKey: 'sk_test_fake',
    webhookSecret: 'whsec_fake',
    stripeClient,
    creatorProfileRepository: repo,
  });
  return { stripeClient, repo, payoutProvider };
}

// ---------------------------------------------------------------------------
// A. Valid signature — identity.verification_session.verified updates the cache
// ---------------------------------------------------------------------------

test('a valid signature + identity.verification_session.verified event updates the local cache to "verified"', async () => {
  const { payoutProvider } = makeHarness((_raw, sig) => {
    assert.equal(sig, 'valid-sig');
    return fakeEvent('identity.verification_session.verified', {
      id: 'vs_1',
      metadata: { creatorUserId: 'creator-verified' },
    });
  });

  assert.equal(payoutProvider.checkVerificationStatus('creator-verified'), 'unverified');

  const result = await handleStripeWebhook(Buffer.from('{}'), 'valid-sig', {
    webhookSecret: 'whsec_fake',
    payoutProvider,
  });

  assert.equal(result.status, 200);
  assert.equal(result.body.received, true);
  assert.equal(payoutProvider.checkVerificationStatus('creator-verified'), 'verified');
});

// ---------------------------------------------------------------------------
// B. Missing signature header
// ---------------------------------------------------------------------------

test('a missing stripe-signature header → 400, cache untouched, constructEvent never called', async () => {
  let constructEventCalled = false;
  const { payoutProvider } = makeHarness(() => {
    constructEventCalled = true;
    return fakeEvent('identity.verification_session.verified', { metadata: { creatorUserId: 'x' } });
  });

  const result = await handleStripeWebhook(Buffer.from('{}'), undefined, {
    webhookSecret: 'whsec_fake',
    payoutProvider,
  });

  assert.equal(result.status, 400);
  assert.equal(constructEventCalled, false);
  assert.equal(payoutProvider.checkVerificationStatus('x'), 'unverified');
});

// ---------------------------------------------------------------------------
// C. Invalid/forged signature
// ---------------------------------------------------------------------------

test('an invalid/forged signature (constructEvent throws) → 400, cache untouched, payload NEVER read', async () => {
  const { payoutProvider } = makeHarness(() => {
    throw new Error('No signatures found matching the expected signature for payload');
  });

  const result = await handleStripeWebhook(
    Buffer.from(JSON.stringify({ type: 'identity.verification_session.verified', data: { object: { metadata: { creatorUserId: 'forged' } } } })),
    'totally-forged-signature',
    { webhookSecret: 'whsec_fake', payoutProvider, log: () => {} },
  );

  assert.equal(result.status, 400);
  assert.match(result.body.error as string, /invalid stripe webhook signature/i);
  // The attacker's claimed creatorUserId must never be applied — the payload was never trusted.
  assert.equal(payoutProvider.checkVerificationStatus('forged'), 'unverified');
});

// ---------------------------------------------------------------------------
// D. requires_input / canceled
// ---------------------------------------------------------------------------

test('identity.verification_session.requires_input sets the cache to "pending"', async () => {
  const { payoutProvider } = makeHarness(() =>
    fakeEvent('identity.verification_session.requires_input', { metadata: { creatorUserId: 'creator-pending' } }),
  );
  await handleStripeWebhook(Buffer.from('{}'), 'sig', { webhookSecret: 'whsec_fake', payoutProvider });
  assert.equal(payoutProvider.checkVerificationStatus('creator-pending'), 'pending');
});

test('identity.verification_session.canceled sets the cache to "unverified"', async () => {
  const { payoutProvider } = makeHarness(() =>
    fakeEvent('identity.verification_session.canceled', { metadata: { creatorUserId: 'creator-canceled' } }),
  );
  payoutProvider.updateVerificationCache('creator-canceled', 'pending');
  assert.equal(payoutProvider.checkVerificationStatus('creator-canceled'), 'pending');

  await handleStripeWebhook(Buffer.from('{}'), 'sig', { webhookSecret: 'whsec_fake', payoutProvider });
  assert.equal(payoutProvider.checkVerificationStatus('creator-canceled'), 'unverified');
});

// ---------------------------------------------------------------------------
// E. account.updated and unrecognized event types — safe no-ops
// ---------------------------------------------------------------------------

test('account.updated is a safe no-op → 200, not an error', async () => {
  const { payoutProvider } = makeHarness(() => fakeEvent('account.updated', { id: 'acct_1' }));
  const result = await handleStripeWebhook(Buffer.from('{}'), 'sig', {
    webhookSecret: 'whsec_fake',
    payoutProvider,
    log: () => {},
  });
  assert.equal(result.status, 200);
});

test('an entirely unrecognized event type is a safe no-op → 200, not an error', async () => {
  const { payoutProvider } = makeHarness(() => fakeEvent('some.future.stripe.event.type', {}));
  const result = await handleStripeWebhook(Buffer.from('{}'), 'sig', {
    webhookSecret: 'whsec_fake',
    payoutProvider,
    log: () => {},
  });
  assert.equal(result.status, 200);
  assert.equal(result.body.received, true);
});

test('identity.verification_session.verified with no metadata.creatorUserId is ignored, not an error', async () => {
  const { payoutProvider } = makeHarness(() =>
    fakeEvent('identity.verification_session.verified', { id: 'vs_no_meta', metadata: {} }),
  );
  const result = await handleStripeWebhook(Buffer.from('{}'), 'sig', {
    webhookSecret: 'whsec_fake',
    payoutProvider,
    log: () => {},
  });
  assert.equal(result.status, 200);
});
