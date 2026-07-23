/**
 * market/store.ts — in-memory waitlist store (launch GTM surface).
 *
 * Captures and dedups waitlist signups and produces privacy-safe aggregate stats. It is a plain
 * data structure: no network, no database, no dependency on any Big 5 agent. In production this
 * would be backed by the Prisma repository seam, but the offline in-memory store keeps the launch
 * fully runnable with zero infrastructure (mirroring the rest of the offline-first backbone).
 *
 * Abuse posture: signups are deduped by normalised email, entries are capped (oldest-wins is
 * rejected once full — we never silently drop an existing supporter), and validation is strict.
 */
import { randomUUID } from 'node:crypto';
import {
  WAITLIST_SOURCES,
  WaitlistValidationError,
  type PublicWaitlistEntry,
  type WaitlistEntry,
  type WaitlistSignupInput,
  type WaitlistSignupResult,
  type WaitlistSource,
  type WaitlistStats,
} from './types.js';

/** Default maximum number of entries the in-memory store will hold. */
export const DEFAULT_MAX_ENTRIES = 100_000;

/** Reasonable upper bounds so a single request can't store unbounded text. */
const MAX_EMAIL_LEN = 254;
const MAX_TEXT_LEN = 500;

const DAY_MS = 24 * 60 * 60 * 1000;

export interface WaitlistStoreOptions {
  /** Hard cap on stored entries. Defaults to DEFAULT_MAX_ENTRIES. */
  maxEntries?: number;
  /** Injectable id generator (tests / determinism). Defaults to crypto.randomUUID. */
  idFactory?: () => string;
}

export class WaitlistStore {
  /** Insertion-ordered entries. Map preserves order, giving us position + recency for free. */
  private readonly entries = new Map<string, WaitlistEntry>();
  private readonly maxEntries: number;
  private readonly idFactory: () => string;

  constructor(options: WaitlistStoreOptions = {}) {
    this.maxEntries = options.maxEntries && options.maxEntries > 0 ? Math.floor(options.maxEntries) : DEFAULT_MAX_ENTRIES;
    this.idFactory = options.idFactory ?? (() => `wl_${randomUUID()}`);
  }

  /** Number of unique signups currently stored. */
  size(): number {
    return this.entries.size;
  }

  /**
   * Add (or idempotently re-confirm) a signup. Throws WaitlistValidationError on bad input, and
   * a plain Error only when the store is full AND the email is new (existing supporters always
   * succeed idempotently). Re-signing with new details updates the mutable fields in place.
   */
  add(input: WaitlistSignupInput): WaitlistSignupResult {
    const email = normaliseEmail(input.email);
    const at = typeof input.at === 'number' && Number.isFinite(input.at) ? input.at : Date.now();

    const existing = this.entries.get(email);
    if (existing) {
      // Idempotent re-signup: enrich empty fields without clobbering earlier answers.
      mergeEnrichment(existing, input);
      return {
        created: false,
        duplicate: true,
        entry: toPublic(existing),
        position: this.positionOf(email),
      };
    }

    if (this.entries.size >= this.maxEntries) {
      throw new Error('waitlist is full');
    }

    const entry: WaitlistEntry = {
      id: this.idFactory(),
      email,
      name: optionalText(input.name, 'name'),
      company: optionalText(input.company, 'company'),
      interestedTier: optionalTier(input.interestedTier),
      useCase: optionalText(input.useCase, 'useCase'),
      source: normaliseSource(input.source),
      referral: optionalText(input.referral, 'referral'),
      at,
      ip: typeof input.ip === 'string' && input.ip.length > 0 ? input.ip : undefined,
    };
    this.entries.set(email, entry);
    return { created: true, duplicate: false, entry: toPublic(entry), position: this.entries.size };
  }

  /** True when an email is already on the list. */
  has(email: unknown): boolean {
    try {
      return this.entries.has(normaliseEmail(email));
    } catch {
      return false;
    }
  }

  /** All entries (public projection), oldest first. */
  all(): PublicWaitlistEntry[] {
    return [...this.entries.values()].map(toPublic);
  }

  /** The most recent `n` entries (public projection), newest first. */
  recent(n: number): PublicWaitlistEntry[] {
    const limit = Number.isFinite(n) && n > 0 ? Math.floor(n) : 10;
    return [...this.entries.values()].slice(-limit).reverse().map(toPublic);
  }

  /** Privacy-safe aggregate stats. `now` is injectable for deterministic tests. */
  stats(now: number = Date.now()): WaitlistStats {
    const bySource: Record<string, number> = {};
    const byTier: Record<string, number> = {};
    let last24h = 0;
    let last7d = 0;
    let firstAt: number | null = null;
    let lastAt: number | null = null;

    for (const entry of this.entries.values()) {
      bySource[entry.source] = (bySource[entry.source] ?? 0) + 1;
      if (entry.interestedTier) byTier[entry.interestedTier] = (byTier[entry.interestedTier] ?? 0) + 1;
      if (now - entry.at <= DAY_MS) last24h += 1;
      if (now - entry.at <= 7 * DAY_MS) last7d += 1;
      if (firstAt === null || entry.at < firstAt) firstAt = entry.at;
      if (lastAt === null || entry.at > lastAt) lastAt = entry.at;
    }

    return { total: this.entries.size, bySource, byTier, last24h, last7d, firstAt, lastAt };
  }

  /** 1-based position of an email by signup order (0 when absent). */
  private positionOf(email: string): number {
    let i = 0;
    for (const key of this.entries.keys()) {
      i += 1;
      if (key === email) return i;
    }
    return 0;
  }
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

/**
 * Pragmatic email validation: single @, non-empty local + domain parts, a dot in the domain, no
 * whitespace, within length bounds. Deliberately permissive (RFC 5322 is not worth re-deriving)
 * but strict enough to reject the obvious garbage a public form attracts.
 */
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function normaliseEmail(raw: unknown): string {
  if (typeof raw !== 'string') throw new WaitlistValidationError('email is required and must be a string');
  const email = raw.trim().toLowerCase();
  if (email.length === 0) throw new WaitlistValidationError('email is required');
  if (email.length > MAX_EMAIL_LEN) throw new WaitlistValidationError('email is too long');
  if (!EMAIL_RE.test(email)) throw new WaitlistValidationError('email is not a valid address');
  return email;
}

function optionalText(raw: unknown, field: string): string | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw !== 'string') throw new WaitlistValidationError(`${field} must be a string`);
  const value = raw.trim();
  if (value.length === 0) return undefined;
  if (value.length > MAX_TEXT_LEN) throw new WaitlistValidationError(`${field} is too long (max ${MAX_TEXT_LEN})`);
  return value;
}

function optionalTier(raw: unknown): string | undefined {
  const value = optionalText(raw, 'interestedTier');
  return value ? value.toUpperCase() : undefined;
}

function normaliseSource(raw: unknown): WaitlistSource {
  if (typeof raw !== 'string') return 'api';
  const value = raw.trim().toLowerCase();
  return (WAITLIST_SOURCES as readonly string[]).includes(value) ? (value as WaitlistSource) : 'other';
}

/** Merge new non-empty details onto an existing entry without overwriting prior answers. */
function mergeEnrichment(entry: WaitlistEntry, input: WaitlistSignupInput): void {
  entry.name ??= optionalText(input.name, 'name');
  entry.company ??= optionalText(input.company, 'company');
  entry.interestedTier ??= optionalTier(input.interestedTier);
  entry.useCase ??= optionalText(input.useCase, 'useCase');
  entry.referral ??= optionalText(input.referral, 'referral');
}

/** Strip server-only fields (ip) before exposing an entry to a client. */
function toPublic(entry: WaitlistEntry): PublicWaitlistEntry {
  const { ip: _ip, ...pub } = entry;
  void _ip;
  return pub;
}
