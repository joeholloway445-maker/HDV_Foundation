/**
 * tests/creator.test.ts — creator marketplace unit tests (creator/).
 *
 * Coverage:
 *   A. parseCreatorApplyRequest / parseCreatorPersonaRequest — validation.
 *   B. CreatorPayoutStub — requestVerification/checkVerificationStatus, and THE MOST IMPORTANT
 *      TEST: requestPayout is UNCONDITIONALLY blocked, regardless of verification requests or
 *      accrued balance, since nothing can ever set a creator's status to 'verified' yet.
 *   C. creator/handlers.ts — handleCreatorApply, handleCreatePersona (incl. the 409 conflict),
 *      handleGetEarnings (accrual math + payoutAvailable always false), handleRequestVerification,
 *      handleRequestPayout (mirrors B's safety-gate assertion at the handler/HTTP-shape level).
 *   D. recordLikenessUsage — never throws/blocks the caller even when misconfigured, correctly
 *      attributes usage to the owning creator, and no-ops for a non-creator-owned personaId.
 *
 * Run: node --import tsx --test tests/creator.test.ts   (or the full suite: npm test)
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  parseCreatorApplyRequest,
  parseCreatorPersonaRequest,
  CreatorValidationError,
  LIKENESS_RATE_USD,
  handleCreatorApply,
  handleCreatePersona,
  handleGetEarnings,
  handleRequestVerification,
  handleRequestPayout,
  recordLikenessUsage,
  CreatorPayoutStub,
  PayoutBlockedError,
  PayoutStubError,
} from '../creator/index.js';
import {
  InMemoryCreatorProfileRepository,
  InMemoryCreatorPersonaRepository,
  InMemoryLikenessUsageEventRepository,
} from '../persistence/index.js';

// ---------------------------------------------------------------------------
// A. Validation
// ---------------------------------------------------------------------------

test('parseCreatorApplyRequest requires a non-empty displayName', () => {
  assert.throws(() => parseCreatorApplyRequest(null), CreatorValidationError);
  assert.throws(() => parseCreatorApplyRequest({}), CreatorValidationError);
  assert.throws(() => parseCreatorApplyRequest({ displayName: '   ' }), CreatorValidationError);
});

test('parseCreatorApplyRequest accepts an optional bio, defaulting to undefined', () => {
  const withBio = parseCreatorApplyRequest({ displayName: 'Jordyn', bio: 'Hi, I make content.' });
  assert.equal(withBio.displayName, 'Jordyn');
  assert.equal(withBio.bio, 'Hi, I make content.');

  const without = parseCreatorApplyRequest({ displayName: 'Jordyn' });
  assert.equal(without.bio, undefined);
});

test('parseCreatorPersonaRequest requires personaId and displayName', () => {
  assert.throws(() => parseCreatorPersonaRequest(null), CreatorValidationError);
  assert.throws(() => parseCreatorPersonaRequest({}), CreatorValidationError);
  assert.throws(
    () => parseCreatorPersonaRequest({ personaId: 'jordyn' }),
    CreatorValidationError,
  ); // no displayName
  assert.throws(
    () => parseCreatorPersonaRequest({ displayName: 'Jordyn' }),
    CreatorValidationError,
  ); // no personaId
});

test('parseCreatorPersonaRequest rejects a personaId with characters outside [A-Za-z0-9_-]', () => {
  assert.throws(
    () => parseCreatorPersonaRequest({ personaId: 'not valid!', displayName: 'Jordyn' }),
    (err: unknown) => err instanceof CreatorValidationError && err.code === 'invalid_persona_id',
  );
});

test('parseCreatorPersonaRequest defaults referencePhotoUrls to [] and accepts valid http(s) URLs', () => {
  const withUrls = parseCreatorPersonaRequest({
    personaId: 'jordyn',
    displayName: 'Jordyn',
    referencePhotoUrls: ['https://cdn.example.com/a.jpg', 'http://cdn.example.com/b.jpg'],
  });
  assert.deepEqual(withUrls.referencePhotoUrls, [
    'https://cdn.example.com/a.jpg',
    'http://cdn.example.com/b.jpg',
  ]);

  const without = parseCreatorPersonaRequest({ personaId: 'jordyn', displayName: 'Jordyn' });
  assert.deepEqual(without.referencePhotoUrls, []);
});

test('parseCreatorPersonaRequest rejects non-URL / non-http(s) referencePhotoUrls entries (never raw image bytes)', () => {
  assert.throws(
    () => parseCreatorPersonaRequest({ personaId: 'jordyn', displayName: 'Jordyn', referencePhotoUrls: ['not-a-url'] }),
    (err: unknown) => err instanceof CreatorValidationError && err.code === 'invalid_photo_url',
  );
  assert.throws(
    () =>
      parseCreatorPersonaRequest({
        personaId: 'jordyn',
        displayName: 'Jordyn',
        referencePhotoUrls: ['data:image/png;base64,QUJD'],
      }),
    (err: unknown) => err instanceof CreatorValidationError && err.code === 'invalid_photo_url',
  );
  assert.throws(
    () => parseCreatorPersonaRequest({ personaId: 'jordyn', displayName: 'Jordyn', referencePhotoUrls: 'nope' }),
    CreatorValidationError,
  );
});

test('parseCreatorPersonaRequest defaults scanUrls to [] and accepts valid http(s) URLs', () => {
  const withUrls = parseCreatorPersonaRequest({
    personaId: 'jordyn',
    displayName: 'Jordyn',
    scanUrls: ['https://poly.cam/capture/abc123', 'https://cdn.example.com/scan.glb'],
  });
  assert.deepEqual(withUrls.scanUrls, [
    'https://poly.cam/capture/abc123',
    'https://cdn.example.com/scan.glb',
  ]);

  const without = parseCreatorPersonaRequest({ personaId: 'jordyn', displayName: 'Jordyn' });
  assert.deepEqual(without.scanUrls, []);
});

test('parseCreatorPersonaRequest rejects non-URL / non-http(s) scanUrls entries (never raw scan bytes)', () => {
  assert.throws(
    () => parseCreatorPersonaRequest({ personaId: 'jordyn', displayName: 'Jordyn', scanUrls: ['not-a-url'] }),
    (err: unknown) => err instanceof CreatorValidationError && err.code === 'invalid_scan_url',
  );
  assert.throws(
    () => parseCreatorPersonaRequest({ personaId: 'jordyn', displayName: 'Jordyn', scanUrls: 'nope' }),
    CreatorValidationError,
  );
});

// ---------------------------------------------------------------------------
// B. CreatorPayoutStub — the safety gate
// ---------------------------------------------------------------------------

test('CreatorPayoutStub.checkVerificationStatus starts every creator at "unverified"', () => {
  const stub = new CreatorPayoutStub();
  assert.equal(stub.checkVerificationStatus('creator-1'), 'unverified');
});

test('CreatorPayoutStub.requestVerification always returns a session in "requires_input" (async — interface compatibility, no behavior change)', async () => {
  const stub = new CreatorPayoutStub();
  const session = await stub.requestVerification('creator-1');
  assert.equal(session.status, 'requires_input');
  assert.equal(session.creatorUserId, 'creator-1');
  assert.ok(session.id.length > 0);
  assert.ok(session.url.startsWith('https://'));

  // Never auto-completes, and status moves to 'pending' — NEVER 'verified'.
  assert.equal(stub.checkVerificationStatus('creator-1'), 'pending');
  const again = await stub.requestVerification('creator-1');
  assert.equal(again.status, 'requires_input');
  assert.equal(stub.checkVerificationStatus('creator-1'), 'pending');
});

test('CreatorPayoutStub.requestPayout ALWAYS rejects with PayoutBlockedError(not_verified), regardless of verification requests or amount — THE SAFETY GATE', async () => {
  const stub = new CreatorPayoutStub();

  // Fresh, never-verified creator.
  await assert.rejects(
    () => stub.requestPayout('creator-a', 10),
    (err: unknown) => err instanceof PayoutBlockedError && err.code === 'not_verified',
  );

  // Even after requesting (stub) verification — status is 'pending', never 'verified'.
  await stub.requestVerification('creator-b');
  assert.equal(stub.checkVerificationStatus('creator-b'), 'pending');
  await assert.rejects(
    () => stub.requestPayout('creator-b', 1),
    (err: unknown) => err instanceof PayoutBlockedError && err.code === 'not_verified',
  );

  // Regardless of how large the requested amount is.
  await assert.rejects(
    () => stub.requestPayout('creator-b', 1_000_000),
    (err: unknown) => err instanceof PayoutBlockedError,
  );

  // Repeated calls: still always blocked, every single time.
  for (let i = 0; i < 5; i += 1) {
    await assert.rejects(
      () => stub.requestPayout('creator-b', 5),
      (err: unknown) => err instanceof PayoutBlockedError,
    );
  }
});

test('CreatorPayoutStub.requestPayout rejects a non-positive amount with PayoutStubError', async () => {
  const stub = new CreatorPayoutStub();
  await assert.rejects(() => stub.requestPayout('creator-a', 0), PayoutStubError);
  await assert.rejects(() => stub.requestPayout('creator-a', -5), PayoutStubError);
  await assert.rejects(() => stub.requestPayout('creator-a', NaN), PayoutStubError);
});

// ---------------------------------------------------------------------------
// C. creator/handlers.ts
// ---------------------------------------------------------------------------

test('handleCreatorApply creates a profile starting at unverified, and 503s without a repository', () => {
  const noRepo = handleCreatorApply('user-1', { displayName: 'Jordyn' });
  assert.equal(noRepo.status, 503);

  const repo = new InMemoryCreatorProfileRepository();
  const res = handleCreatorApply('user-1', { displayName: 'Jordyn', bio: 'hi' }, { creatorProfileRepository: repo });
  assert.equal(res.status, 200);
  const profile = res.body.profile as { userId: string; displayName: string; verificationStatus: string };
  assert.equal(profile.userId, 'user-1');
  assert.equal(profile.displayName, 'Jordyn');
  assert.equal(profile.verificationStatus, 'unverified');
});

test('handleCreatorApply rejects invalid input with 400', () => {
  const repo = new InMemoryCreatorProfileRepository();
  const res = handleCreatorApply('user-1', {}, { creatorProfileRepository: repo });
  assert.equal(res.status, 400);
});

test('handleCreatorApply re-applying preserves createdAt and never bumps verificationStatus', () => {
  const repo = new InMemoryCreatorProfileRepository();
  let now = 1000;
  const first = handleCreatorApply('user-1', { displayName: 'Jordyn' }, { creatorProfileRepository: repo, now: () => now });
  now = 5000;
  const second = handleCreatorApply(
    'user-1',
    { displayName: 'Jordyn V2' },
    { creatorProfileRepository: repo, now: () => now },
  );
  const firstProfile = first.body.profile as { createdAt: number };
  const secondProfile = second.body.profile as { createdAt: number; displayName: string; verificationStatus: string };
  assert.equal(secondProfile.createdAt, firstProfile.createdAt);
  assert.equal(secondProfile.displayName, 'Jordyn V2');
  assert.equal(secondProfile.verificationStatus, 'unverified');
});

test('handleCreatePersona creates a persona and 503s without a repository', () => {
  const noRepo = handleCreatePersona('user-1', { personaId: 'jordyn', displayName: 'Jordyn' });
  assert.equal(noRepo.status, 503);

  const repo = new InMemoryCreatorPersonaRepository();
  const res = handleCreatePersona(
    'user-1',
    { personaId: 'jordyn', displayName: 'Jordyn' },
    { creatorPersonaRepository: repo },
  );
  assert.equal(res.status, 200);
  const persona = res.body.persona as { creatorUserId: string; personaId: string };
  assert.equal(persona.creatorUserId, 'user-1');
  assert.equal(persona.personaId, 'jordyn');
  assert.ok(repo.findByPersonaId('jordyn'));
});

test('handleCreatePersona rejects a personaId already claimed by a DIFFERENT creator with 409', () => {
  const repo = new InMemoryCreatorPersonaRepository();
  handleCreatePersona('user-1', { personaId: 'jordyn', displayName: 'Jordyn' }, { creatorPersonaRepository: repo });

  const conflict = handleCreatePersona(
    'user-2',
    { personaId: 'jordyn', displayName: 'Someone Else' },
    { creatorPersonaRepository: repo },
  );
  assert.equal(conflict.status, 409);
  assert.equal(conflict.body.code, 'persona_id_taken');
});

test('handleCreatePersona allows the SAME creator to update their own persona in place', () => {
  const repo = new InMemoryCreatorPersonaRepository();
  const first = handleCreatePersona(
    'user-1',
    { personaId: 'jordyn', displayName: 'Jordyn' },
    { creatorPersonaRepository: repo },
  );
  const second = handleCreatePersona(
    'user-1',
    { personaId: 'jordyn', displayName: 'Jordyn Updated', description: 'now with a bio' },
    { creatorPersonaRepository: repo },
  );
  assert.equal(second.status, 200);
  const firstPersona = first.body.persona as { id: string };
  const secondPersona = second.body.persona as { id: string; displayName: string };
  assert.equal(secondPersona.id, firstPersona.id, 'same row, updated in place');
  assert.equal(secondPersona.displayName, 'Jordyn Updated');
});

test('handleGetEarnings sums accruedUsd for the creator and always reports payoutAvailable: false', () => {
  const usageRepo = new InMemoryLikenessUsageEventRepository();
  usageRepo.append({
    id: '1',
    creatorUserId: 'user-1',
    personaId: 'jordyn',
    eventType: 'chat_turn',
    accruedUsd: LIKENESS_RATE_USD.chat_turn,
    createdAt: Date.now(),
  });
  usageRepo.append({
    id: '2',
    creatorUserId: 'user-1',
    personaId: 'jordyn',
    eventType: 'portrait_generated',
    accruedUsd: LIKENESS_RATE_USD.portrait_generated,
    createdAt: Date.now(),
  });
  // A different creator's events must NOT bleed into user-1's sum.
  usageRepo.append({
    id: '3',
    creatorUserId: 'someone-else',
    personaId: 'other',
    eventType: 'scene_generated',
    accruedUsd: LIKENESS_RATE_USD.scene_generated,
    createdAt: Date.now(),
  });

  const res = handleGetEarnings('user-1', { likenessUsageRepository: usageRepo });
  assert.equal(res.status, 200);
  const body = res.body as { accruedUsd: number; verificationStatus: string; payoutAvailable: boolean };
  assert.ok(Math.abs(body.accruedUsd - (LIKENESS_RATE_USD.chat_turn + LIKENESS_RATE_USD.portrait_generated)) < 1e-9);
  assert.equal(body.verificationStatus, 'unverified');
  assert.equal(body.payoutAvailable, false);
});

test('handleGetEarnings reports 0 when no likenessUsageRepository is configured (clean no-op)', () => {
  const res = handleGetEarnings('user-1');
  assert.equal(res.status, 200);
  assert.equal((res.body as { accruedUsd: number }).accruedUsd, 0);
  assert.equal((res.body as { payoutAvailable: boolean }).payoutAvailable, false);
});

test('handleGetEarnings reflects the payout provider verification status when configured', async () => {
  const stub = new CreatorPayoutStub();
  await stub.requestVerification('user-1');
  const res = handleGetEarnings('user-1', { payoutProvider: stub });
  assert.equal((res.body as { verificationStatus: string }).verificationStatus, 'pending');
});

test('handleRequestVerification returns a "requires_input" session and 503s without a provider', async () => {
  const noProvider = await handleRequestVerification('user-1');
  assert.equal(noProvider.status, 503);

  const stub = new CreatorPayoutStub();
  const res = await handleRequestVerification('user-1', { payoutProvider: stub });
  assert.equal(res.status, 200);
  const verification = res.body.verification as { status: string };
  assert.equal(verification.status, 'requires_input');
});

test('handleRequestPayout ALWAYS 403s with a clear message, and 503s without a provider — THE SAFETY GATE at the handler level', async () => {
  const noProvider = await handleRequestPayout('user-1', { amountUsd: 5 });
  assert.equal(noProvider.status, 503);

  const stub = new CreatorPayoutStub();
  const res = await handleRequestPayout('user-1', { amountUsd: 5 }, { payoutProvider: stub });
  assert.equal(res.status, 403);
  assert.equal(res.body.code, 'not_verified');
  assert.match(res.body.error as string, /not identity-verified/i);

  // Even after a huge accrued balance is implied and verification was requested.
  await stub.requestVerification('user-1');
  const stillBlocked = await handleRequestPayout('user-1', { amountUsd: 1_000_000 }, { payoutProvider: stub });
  assert.equal(stillBlocked.status, 403);
  assert.equal(stillBlocked.body.code, 'not_verified');
});

test('handleRequestPayout rejects a missing/invalid amountUsd with 400', async () => {
  const stub = new CreatorPayoutStub();
  const missing = await handleRequestPayout('user-1', {}, { payoutProvider: stub });
  assert.equal(missing.status, 400);
  const negative = await handleRequestPayout('user-1', { amountUsd: -1 }, { payoutProvider: stub });
  assert.equal(negative.status, 400);
});

// ---------------------------------------------------------------------------
// D. recordLikenessUsage — fire-and-forget, never throws/blocks the caller
// ---------------------------------------------------------------------------

test('recordLikenessUsage never throws when misconfigured (no repositories, no personaId)', () => {
  assert.doesNotThrow(() => recordLikenessUsage(undefined, 'chat_turn'));
  assert.doesNotThrow(() => recordLikenessUsage('jordyn', 'chat_turn'));
  assert.doesNotThrow(() => recordLikenessUsage('jordyn', 'chat_turn', {}));
  assert.doesNotThrow(() =>
    recordLikenessUsage('jordyn', 'chat_turn', { creatorPersonaRepository: new InMemoryCreatorPersonaRepository() }),
  );
});

test('recordLikenessUsage no-ops cleanly for a personaId that is NOT creator-owned (the common case)', async () => {
  const personaRepo = new InMemoryCreatorPersonaRepository();
  const usageRepo = new InMemoryLikenessUsageEventRepository();
  recordLikenessUsage('not-a-creator-persona', 'chat_turn', {
    creatorPersonaRepository: personaRepo,
    likenessUsageRepository: usageRepo,
  });
  // Fire-and-forget: give the microtask queue a tick to settle.
  await new Promise((r) => setImmediate(r));
  assert.equal(usageRepo.all().length, 0);
});

test('recordLikenessUsage appends a LikenessUsageEvent at the placeholder rate for a creator-owned persona', async () => {
  const personaRepo = new InMemoryCreatorPersonaRepository();
  const usageRepo = new InMemoryLikenessUsageEventRepository();
  personaRepo.upsert({
    id: 'p1',
    creatorUserId: 'user-1',
    personaId: 'jordyn',
    displayName: 'Jordyn',
    referencePhotoUrls: [],
    scanUrls: [],
    createdAt: Date.now(),
  });

  recordLikenessUsage('jordyn', 'portrait_generated', {
    creatorPersonaRepository: personaRepo,
    likenessUsageRepository: usageRepo,
  });
  await new Promise((r) => setImmediate(r));

  const events = usageRepo.all();
  assert.equal(events.length, 1);
  assert.equal(events[0].creatorUserId, 'user-1');
  assert.equal(events[0].personaId, 'jordyn');
  assert.equal(events[0].eventType, 'portrait_generated');
  assert.equal(events[0].accruedUsd, LIKENESS_RATE_USD.portrait_generated);
  assert.equal(usageRepo.sumAccruedUsd('user-1'), LIKENESS_RATE_USD.portrait_generated);
});

test('recordLikenessUsage never throws even when the repository itself throws on append', async () => {
  const personaRepo = new InMemoryCreatorPersonaRepository();
  personaRepo.upsert({
    id: 'p1',
    creatorUserId: 'user-1',
    personaId: 'jordyn',
    displayName: 'Jordyn',
    referencePhotoUrls: [],
    scanUrls: [],
    createdAt: Date.now(),
  });
  const throwingUsageRepo = {
    append() {
      throw new Error('db is down');
    },
    byCreator: () => [],
    sumAccruedUsd: () => 0,
    all: () => [],
    clear: () => {},
  };

  assert.doesNotThrow(() =>
    recordLikenessUsage('jordyn', 'chat_turn', {
      creatorPersonaRepository: personaRepo,
      likenessUsageRepository: throwingUsageRepo,
    }),
  );
  // Let the swallowed rejection settle so it doesn't surface as an unhandled rejection later.
  await new Promise((r) => setImmediate(r));
});
