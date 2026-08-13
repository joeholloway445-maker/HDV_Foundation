/**
 * persistence/repositories.ts — repository interfaces + in-memory implementations.
 *
 * Phase 2 persistence layer. These interfaces mirror the Prisma models in
 * `config/schema.prisma` exactly (RequestLog, NodeIdentity, SecurityAudit, IntentDocument,
 * CompanionMemory — companion/'s opt-in relationship memory, see companion/memory.ts — and
 * CreatorProfile/CreatorPersona/LikenessUsageEvent — the creator marketplace, see creator/).
 * The in-memory implementations are drop-in defaults so the running backbone never requires
 * a real Postgres; a Phase 4 Prisma-backed implementation can satisfy the same interfaces
 * without touching call sites.
 *
 * This module imports ONLY from `config/` so it stays agent-neutral: APEX (ledger),
 * KNOLL (audit), and HOPE (intent archive) can all optionally wrap a repository without
 * creating cross-agent coupling.
 */
import { randomUUID } from 'node:crypto';
import type { AgentRole, RoutingStatus } from '../config/routing_schema.js';

// ---------------------------------------------------------------------------
// Record shapes — one per Prisma model. Field names match schema.prisma so the
// in-memory store is a faithful stand-in for the durable table.
// ---------------------------------------------------------------------------

/** Mirrors the RequestLog model (APEX ledger row). */
export interface RequestLogRecord {
  id: string;
  packetId: string;
  timestamp: number;
  source: AgentRole;
  destination: AgentRole;
  status: RoutingStatus;
  cost_usd: number;
  knollSignature: string;
}

/** Mirrors the NodeIdentity model (one row per fleet node). */
export interface NodeIdentityRecord {
  node_id: string;
  role: AgentRole;
  status: 'ACTIVE' | 'IDLE' | 'TERMINATED';
  last_seen: number;
  is_ephemeral: boolean;
}

/** Mirrors the SecurityAudit model (one row per KNOLL verdict). */
export interface SecurityAuditRecord {
  id: string;
  packetId: string;
  outcome: 'ALLOWED' | 'BLOCKED';
  reasoning?: string;
  timestamp: number;
}

/** Mirrors the IntentDocument model (Hope's documented user intent). */
export interface IntentDocumentRecord {
  id: string;
  utterance: string;
  kind: string;
  entities: string[];
  goals: string[];
  constraints: string[];
  suggestedDestination: AgentRole;
  confidence: number;
  documentedAt: number;
  clarificationNeeded: boolean;
}

/** Mirrors the User model (auth/) — one row per registered email+password account. */
export interface UserRecord {
  id: string;
  email: string;
  /** `scrypt` salt:hash encoding — see auth/service.ts. NEVER the raw password. */
  passwordHash: string;
  createdAt: number;
}

/** Mirrors the Session model (auth/) — one row per active login. */
export interface SessionRecord {
  token: string;
  userId: string;
  createdAt: number;
  expiresAt: number;
}

/**
 * Mirrors the CompanionMemory model (companion/'s opt-in relationship memory — see
 * companion/memory.ts). One row per client-supplied companionId; there is no user-account
 * system yet, so this is an opaque client-generated id, not a real user id.
 */
export interface CompanionMemoryRecord {
  companionId: string;
  /** 0-100. */
  affectionLevel: number;
  /** Running relationship/fact summary, capped length. */
  summary: string;
  turnCount: number;
  updatedAt: number;
}

/**
 * Mirrors the CreatorProfile model (creator/) — one row per User who has applied to become a
 * creator (real people turning themselves into an AI companion persona — see creator/index.ts).
 * `verificationStatus` starts 'unverified' and NOTHING in creator/payout_stub.ts (the default,
 * unconfigured build) ever sets it to 'verified' — see that module's header for why that is the
 * safety mechanism gating real-money payouts in the stub-only build.
 *
 * `stripeAccountId` / `stripeVerificationSessionId` / `verificationStatusCache` are used ONLY by
 * creator/payout_stripe_live.ts (the real Stripe Identity + Connect implementation, wired only
 * when STRIPE_SECRET_KEY + STRIPE_WEBHOOK_SECRET are both configured — see
 * creator/payout_factory.ts). `verificationStatusCache` is updated exclusively by a verified
 * Stripe webhook event (creator/stripe_webhook.ts) — it is a fast LOCAL read for display
 * purposes (e.g. GET /v1/creator/earnings) and is NEVER the sole gate for money movement: a real
 * payout re-checks Stripe live, first-hand, every time (see CreatorPayoutStripeLive.requestPayout's
 * doc comment). All three fields are optional/undefined for every creator until the live
 * provider is actually configured and used — the stub-only build never touches them.
 */
export interface CreatorProfileRecord {
  userId: string;
  displayName: string;
  bio?: string;
  verificationStatus: 'unverified' | 'pending' | 'verified';
  createdAt: number;
  /** Stripe Connect Express account id (creator/payout_stripe_live.ts only). */
  stripeAccountId?: string;
  /** Stripe Identity VerificationSession id (creator/payout_stripe_live.ts only). */
  stripeVerificationSessionId?: string;
  /** Webhook-updated LOCAL cache of verification status (creator/payout_stripe_live.ts only) —
   *  display-only, never authoritative for a payout decision. */
  verificationStatusCache?: 'unverified' | 'pending' | 'verified';
}

/**
 * Mirrors the CreatorPersona model (creator/) — one row per persona a creator has submitted.
 * `personaId` is the SAME id space as companion/portrait_types.ts's PortraitPersona.personaId /
 * FuckLike's companion presetId — it is the join key creator/handlers.ts's recordLikenessUsage
 * uses to attribute a chat/portrait/scene event back to the owning creator.
 * `referencePhotoUrls`/`scanUrls` are URLs only — no file bytes (photo, 3D scan, or otherwise)
 * are ever stored here or in Postgres; the creator hosts the file elsewhere (a 3D-scan app's
 * own share link, cloud storage, etc.) and pastes the link. Same reasoning both fields: this
 * server has no upload/object-storage layer, so accepting raw bytes would mean building and
 * paying for one — a link costs nothing and works with any hosting the creator already has.
 */
export interface CreatorPersonaRecord {
  id: string;
  creatorUserId: string;
  personaId: string;
  displayName: string;
  description?: string;
  referencePhotoUrls: string[];
  /** Links to a 3D scan/model (e.g. a Polycam/RealityScan/in3D share link, or any hosted .glb/
   *  .usdz/.obj) or a multi-angle photo set — same link-only posture as referencePhotoUrls. */
  scanUrls: string[];
  createdAt: number;
}

/**
 * Mirrors the LikenessUsageEvent model (creator/) — one row per billable likeness-usage event
 * (a chat turn, portrait, or scene generated using a creator-owned persona). `accruedUsd` comes
 * from the placeholder per-event rate table in creator/types.ts (LIKENESS_RATE_USD) — an
 * operator-tunable figure, not final pricing. Append-only; never mutated after creation.
 */
export interface LikenessUsageEventRecord {
  id: string;
  creatorUserId: string;
  personaId: string;
  eventType: 'chat_turn' | 'portrait_generated' | 'scene_generated';
  accruedUsd: number;
  createdAt: number;
}

// ---------------------------------------------------------------------------
// Repository interfaces
// ---------------------------------------------------------------------------

export interface RequestLogRepository {
  save(record: RequestLogRecord): RequestLogRecord;
  all(): readonly RequestLogRecord[];
  findByPacketId(packetId: string): RequestLogRecord | undefined;
  countByStatus(status: RoutingStatus): number;
  clear(): void;
}

export interface NodeIdentityRepository {
  upsert(record: NodeIdentityRecord): NodeIdentityRecord;
  get(nodeId: string): NodeIdentityRecord | undefined;
  all(): readonly NodeIdentityRecord[];
  countByStatus(status: NodeIdentityRecord['status']): number;
  clear(): void;
}

export interface SecurityAuditRepository {
  save(record: SecurityAuditRecord): SecurityAuditRecord;
  all(): readonly SecurityAuditRecord[];
  blocked(): readonly SecurityAuditRecord[];
  clear(): void;
}

export interface IntentArchiveRepository {
  save(record: IntentDocumentRecord): IntentDocumentRecord;
  get(id: string): IntentDocumentRecord | undefined;
  all(): readonly IntentDocumentRecord[];
  needingClarification(): readonly IntentDocumentRecord[];
  clear(): void;
}

/** Account identity (auth/). Email is the natural key; findByEmail must be case-normalized
 *  by the caller (AuthService lower-cases before every read/write). */
export interface UserRepository {
  create(record: UserRecord): UserRecord;
  findByEmail(email: string): UserRecord | undefined;
  findById(id: string): UserRecord | undefined;
  clear(): void;
}

/** Session tokens (auth/). Token is the primary key. */
export interface SessionRepository {
  create(record: SessionRecord): SessionRecord;
  findByToken(token: string): SessionRecord | undefined;
  delete(token: string): void;
  clear(): void;
}

export interface CompanionMemoryRepository {
  get(companionId: string): CompanionMemoryRecord | undefined;
  upsert(record: CompanionMemoryRecord): CompanionMemoryRecord;
  all(): readonly CompanionMemoryRecord[];
  clear(): void;
}

/** Creator profiles (creator/). userId is the natural key — one profile per User. */
export interface CreatorProfileRepository {
  upsert(record: CreatorProfileRecord): CreatorProfileRecord;
  get(userId: string): CreatorProfileRecord | undefined;
  clear(): void;
}

/** Creator personas (creator/). `id` is the primary key; `personaId` is the join key every
 *  lookup outside creator/ itself actually cares about (see findByPersonaId). */
export interface CreatorPersonaRepository {
  upsert(record: CreatorPersonaRecord): CreatorPersonaRecord;
  findByPersonaId(personaId: string): CreatorPersonaRecord | undefined;
  findByCreator(creatorUserId: string): readonly CreatorPersonaRecord[];
  all(): readonly CreatorPersonaRecord[];
  clear(): void;
}

/** Likeness-usage events (creator/). Append-only; sumAccruedUsd powers GET /v1/creator/earnings. */
export interface LikenessUsageEventRepository {
  append(record: LikenessUsageEventRecord): LikenessUsageEventRecord;
  byCreator(creatorUserId: string): readonly LikenessUsageEventRecord[];
  sumAccruedUsd(creatorUserId: string): number;
  all(): readonly LikenessUsageEventRecord[];
  clear(): void;
}

// ---------------------------------------------------------------------------
// In-memory implementations
// ---------------------------------------------------------------------------

export class InMemoryRequestLogRepository implements RequestLogRepository {
  private readonly rows: RequestLogRecord[] = [];

  save(record: RequestLogRecord): RequestLogRecord {
    this.rows.push(record);
    return record;
  }
  all(): readonly RequestLogRecord[] {
    return this.rows;
  }
  findByPacketId(packetId: string): RequestLogRecord | undefined {
    return this.rows.find((r) => r.packetId === packetId);
  }
  countByStatus(status: RoutingStatus): number {
    return this.rows.filter((r) => r.status === status).length;
  }
  clear(): void {
    this.rows.length = 0;
  }
}

export class InMemoryNodeIdentityRepository implements NodeIdentityRepository {
  private readonly rows = new Map<string, NodeIdentityRecord>();

  upsert(record: NodeIdentityRecord): NodeIdentityRecord {
    this.rows.set(record.node_id, record);
    return record;
  }
  get(nodeId: string): NodeIdentityRecord | undefined {
    return this.rows.get(nodeId);
  }
  all(): readonly NodeIdentityRecord[] {
    return Array.from(this.rows.values());
  }
  countByStatus(status: NodeIdentityRecord['status']): number {
    let n = 0;
    for (const r of this.rows.values()) if (r.status === status) n += 1;
    return n;
  }
  clear(): void {
    this.rows.clear();
  }
}

export class InMemorySecurityAuditRepository implements SecurityAuditRepository {
  private readonly rows: SecurityAuditRecord[] = [];

  save(record: SecurityAuditRecord): SecurityAuditRecord {
    this.rows.push(record);
    return record;
  }
  all(): readonly SecurityAuditRecord[] {
    return this.rows;
  }
  blocked(): readonly SecurityAuditRecord[] {
    return this.rows.filter((r) => r.outcome === 'BLOCKED');
  }
  clear(): void {
    this.rows.length = 0;
  }
}

export class InMemoryIntentArchiveRepository implements IntentArchiveRepository {
  private readonly rows = new Map<string, IntentDocumentRecord>();

  save(record: IntentDocumentRecord): IntentDocumentRecord {
    this.rows.set(record.id, record);
    return record;
  }
  get(id: string): IntentDocumentRecord | undefined {
    return this.rows.get(id);
  }
  all(): readonly IntentDocumentRecord[] {
    return Array.from(this.rows.values());
  }
  needingClarification(): readonly IntentDocumentRecord[] {
    return this.all().filter((r) => r.clarificationNeeded);
  }
  clear(): void {
    this.rows.clear();
  }
}

export class InMemoryUserRepository implements UserRepository {
  private readonly rows = new Map<string, UserRecord>(); // keyed by id
  private readonly byEmail = new Map<string, string>(); // email -> id

  create(record: UserRecord): UserRecord {
    this.rows.set(record.id, record);
    this.byEmail.set(record.email, record.id);
    return record;
  }
  findByEmail(email: string): UserRecord | undefined {
    const id = this.byEmail.get(email);
    return id === undefined ? undefined : this.rows.get(id);
  }
  findById(id: string): UserRecord | undefined {
    return this.rows.get(id);
  }
  clear(): void {
    this.rows.clear();
    this.byEmail.clear();
  }
}

export class InMemorySessionRepository implements SessionRepository {
  private readonly rows = new Map<string, SessionRecord>();

  create(record: SessionRecord): SessionRecord {
    this.rows.set(record.token, record);
    return record;
  }
  findByToken(token: string): SessionRecord | undefined {
    return this.rows.get(token);
  }
  delete(token: string): void {
    this.rows.delete(token);
  }
  clear(): void {
    this.rows.clear();
  }
}

export class InMemoryCompanionMemoryRepository implements CompanionMemoryRepository {
  private readonly rows = new Map<string, CompanionMemoryRecord>();

  get(companionId: string): CompanionMemoryRecord | undefined {
    return this.rows.get(companionId);
  }
  upsert(record: CompanionMemoryRecord): CompanionMemoryRecord {
    this.rows.set(record.companionId, record);
    return record;
  }
  all(): readonly CompanionMemoryRecord[] {
    return Array.from(this.rows.values());
  }
  clear(): void {
    this.rows.clear();
  }
}

export class InMemoryCreatorProfileRepository implements CreatorProfileRepository {
  private readonly rows = new Map<string, CreatorProfileRecord>();

  upsert(record: CreatorProfileRecord): CreatorProfileRecord {
    this.rows.set(record.userId, record);
    return record;
  }
  get(userId: string): CreatorProfileRecord | undefined {
    return this.rows.get(userId);
  }
  clear(): void {
    this.rows.clear();
  }
}

export class InMemoryCreatorPersonaRepository implements CreatorPersonaRepository {
  private readonly rows = new Map<string, CreatorPersonaRecord>(); // keyed by id
  private readonly byPersonaId = new Map<string, string>(); // personaId -> id

  upsert(record: CreatorPersonaRecord): CreatorPersonaRecord {
    this.rows.set(record.id, record);
    this.byPersonaId.set(record.personaId, record.id);
    return record;
  }
  findByPersonaId(personaId: string): CreatorPersonaRecord | undefined {
    const id = this.byPersonaId.get(personaId);
    return id === undefined ? undefined : this.rows.get(id);
  }
  findByCreator(creatorUserId: string): readonly CreatorPersonaRecord[] {
    return this.all().filter((r) => r.creatorUserId === creatorUserId);
  }
  all(): readonly CreatorPersonaRecord[] {
    return Array.from(this.rows.values());
  }
  clear(): void {
    this.rows.clear();
    this.byPersonaId.clear();
  }
}

export class InMemoryLikenessUsageEventRepository implements LikenessUsageEventRepository {
  private readonly rows: LikenessUsageEventRecord[] = [];

  append(record: LikenessUsageEventRecord): LikenessUsageEventRecord {
    this.rows.push(record);
    return record;
  }
  byCreator(creatorUserId: string): readonly LikenessUsageEventRecord[] {
    return this.rows.filter((r) => r.creatorUserId === creatorUserId);
  }
  sumAccruedUsd(creatorUserId: string): number {
    return this.byCreator(creatorUserId).reduce((sum, r) => sum + r.accruedUsd, 0);
  }
  all(): readonly LikenessUsageEventRecord[] {
    return this.rows;
  }
  clear(): void {
    this.rows.length = 0;
  }
}

/** Convenience: generate a persistence row id (uuid-backed). */
export function newRowId(prefix = 'row'): string {
  return `${prefix}_${randomUUID()}`;
}
