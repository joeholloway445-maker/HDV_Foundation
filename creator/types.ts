/**
 * creator/types.ts — shared vocabulary for the creator marketplace (creator/).
 *
 * Backs the fucklike.me pivot: real people can turn themselves into an AI companion persona
 * and earn money when that persona/likeness is used, as opposed to fucklike.ai which stays the
 * existing fully-fictional companion product. A "creator" is just an existing auth/ `User` with
 * an additional `CreatorProfile` — this module builds NO parallel auth system; every route that
 * touches these types requires an authenticated X-HDV-Session (see gateway/server.ts).
 *
 * `CreatorProfile` and `CreatorPersona`/`LikenessUsageEvent` are re-exported directly from the
 * persistence layer's record shapes (persistence/repositories.ts) — the same posture
 * companion/memory.ts takes with `CompanionMemoryRecord`: one canonical shape, no lossy public/
 * private split (unlike auth/types.ts's AuthUser vs. UserRecord, there is no secret field here
 * to strip).
 *
 * `personaId` (on CreatorPersona) is the SAME id space as companion/portrait_types.ts's
 * PortraitPersona.personaId / FuckLike's companion presetId — it is the join key
 * creator/handlers.ts's recordLikenessUsage uses to attribute a chat/portrait/scene event back
 * to a creator. Do NOT introduce a second id field for this under a different name.
 *
 * SCOPE (see creator/payout_stub.ts for the full explanation): nothing in this pass can ever
 * set verificationStatus to 'verified' — no real Stripe Identity integration exists yet — so
 * requestPayout is unconditionally blocked. This is a deliberately conservative first pass:
 * build the plumbing now, gate real payouts behind identity verification later.
 */
export type {
  CreatorProfileRecord as CreatorProfile,
  CreatorPersonaRecord as CreatorPersona,
  LikenessUsageEventRecord as LikenessUsageEvent,
} from '../persistence/repositories.js';

/** The three billable "a creator's likeness was used" events (creator/handlers.ts). */
export type LikenessEventType = 'chat_turn' | 'portrait_generated' | 'scene_generated';

/**
 * Placeholder per-event USD rates. These are deliberately simple, operator-tunable stand-ins —
 * NOT final pricing. An operator running this in production should replace them with real
 * unit economics (e.g. cost-plus-margin over the underlying LLM/image/video provider spend)
 * before paying anything out for real — see creator/payout_stub.ts for why nothing can be paid
 * out yet regardless.
 */
export const LIKENESS_RATE_USD: Record<LikenessEventType, number> = {
  chat_turn: 0.01,
  portrait_generated: 0.05,
  scene_generated: 0.25,
};

/** Thrown for malformed creator-marketplace request bodies; callers map this to a 400. */
export class CreatorValidationError extends Error {
  readonly code: string;
  constructor(message: string, code = 'invalid_creator_request') {
    super(message);
    this.name = 'CreatorValidationError';
    this.code = code;
  }
}

const MAX_DISPLAY_NAME_CHARS = 80;
const MAX_BIO_CHARS = 2000;
const MAX_DESCRIPTION_CHARS = 2000;
const MAX_PERSONA_ID_CHARS = 80;
const MAX_PHOTO_URLS = 20;
const MAX_PHOTO_URL_CHARS = 2000;
/** Same "safe identifier" shape used by companion/portrait_types.ts's PortraitPersona.personaId
 *  and companion/types.ts's companionId — one shared id grammar across the whole product. */
const PERSONA_ID_PATTERN = /^[A-Za-z0-9_-]+$/;

/** Parsed, validated input for POST /v1/creator/apply. */
export interface CreatorApplyInput {
  displayName: string;
  bio?: string;
}

/** Parse + validate a raw body into a CreatorApplyInput. */
export function parseCreatorApplyRequest(body: unknown): CreatorApplyInput {
  if (body === null || typeof body !== 'object') {
    throw new CreatorValidationError('body must be JSON with a "displayName" string');
  }
  const b = body as Record<string, unknown>;

  const displayName =
    typeof b.displayName === 'string' ? b.displayName.trim().slice(0, MAX_DISPLAY_NAME_CHARS) : '';
  if (!displayName) {
    throw new CreatorValidationError('"displayName" must be a non-empty string');
  }

  const bio =
    typeof b.bio === 'string' && b.bio.trim() ? b.bio.trim().slice(0, MAX_BIO_CHARS) : undefined;

  return { displayName, bio };
}

/** Parsed, validated input for POST /v1/creator/persona. */
export interface CreatorPersonaInput {
  personaId: string;
  displayName: string;
  description?: string;
  /** URLs only — see the module doc comment. Defaults to an empty array when omitted. */
  referencePhotoUrls: string[];
  /** Links to a 3D scan/model (e.g. a Polycam/RealityScan/in3D share link, or any hosted
   *  .glb/.usdz/.obj) or a multi-angle photo set. Same URL-only posture and validation as
   *  referencePhotoUrls — this server has no upload/object-storage layer, so a creator hosts
   *  the file wherever they made it and pastes the link. Defaults to [] when omitted. */
  scanUrls: string[];
}

/** Parse + validate a raw body into a CreatorPersonaInput. */
export function parseCreatorPersonaRequest(body: unknown): CreatorPersonaInput {
  if (body === null || typeof body !== 'object') {
    throw new CreatorValidationError('body must be JSON with "personaId" and "displayName"');
  }
  const b = body as Record<string, unknown>;

  const personaIdRaw = typeof b.personaId === 'string' ? b.personaId.trim() : '';
  if (!personaIdRaw) {
    throw new CreatorValidationError('"personaId" must be a non-empty string');
  }
  const personaId = personaIdRaw.slice(0, MAX_PERSONA_ID_CHARS);
  if (!PERSONA_ID_PATTERN.test(personaId)) {
    throw new CreatorValidationError(
      '"personaId" may only contain letters, numbers, "_", and "-"',
      'invalid_persona_id',
    );
  }

  const displayName =
    typeof b.displayName === 'string' ? b.displayName.trim().slice(0, MAX_DISPLAY_NAME_CHARS) : '';
  if (!displayName) {
    throw new CreatorValidationError('"displayName" must be a non-empty string');
  }

  const description =
    typeof b.description === 'string' && b.description.trim()
      ? b.description.trim().slice(0, MAX_DESCRIPTION_CHARS)
      : undefined;

  const referencePhotoUrls = normaliseUrlList('referencePhotoUrls', b.referencePhotoUrls, 'invalid_photo_url');
  const scanUrls = normaliseUrlList('scanUrls', b.scanUrls, 'invalid_scan_url');

  return { personaId, displayName, description, referencePhotoUrls, scanUrls };
}

/** Validate an optional array of http(s) URLs. Absent/undefined ⇒ []. Never accepts raw bytes
 *  (e.g. a data: URI) — see the module doc comment on why file bytes are never stored here.
 *  Shared by referencePhotoUrls and scanUrls — same shape, same reasoning, different field
 *  name in the error messages so a caller can tell which one it got wrong. */
function normaliseUrlList(fieldName: string, value: unknown, invalidUrlCode: string): string[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) {
    throw new CreatorValidationError(`"${fieldName}" must be an array of URL strings`);
  }
  if (value.length > MAX_PHOTO_URLS) {
    throw new CreatorValidationError(`"${fieldName}" exceeds the maximum of ${MAX_PHOTO_URLS} entries`);
  }
  const urls: string[] = [];
  for (const raw of value) {
    if (typeof raw !== 'string' || !raw.trim()) {
      throw new CreatorValidationError(`"${fieldName}" entries must be non-empty strings`);
    }
    const trimmed = raw.trim().slice(0, MAX_PHOTO_URL_CHARS);
    if (!/^https?:\/\//i.test(trimmed)) {
      throw new CreatorValidationError(
        `"${fieldName}" entries must be http(s) URLs — raw file bytes are never accepted here`,
        invalidUrlCode,
      );
    }
    urls.push(trimmed);
  }
  return urls;
}
