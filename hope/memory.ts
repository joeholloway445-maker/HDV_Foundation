/**
 * hope/memory.ts — IntentMemory: the intent archive as retrievable context (Phase 7).
 *
 * HOPE interprets utterances into structured intents. This module lets HOPE REMEMBER past
 * intents and RECALL the most similar ones as context for interpreting the next utterance —
 * the seam for "memory: intent archive as context (pgvector)" in the roadmap.
 *
 * It is deliberately dependency-free and offline:
 *   - `embedIntent` is a STUB embedder: a deterministic hashed-bag-of-tokens vector (no model,
 *     no network). It is good enough for similarity ordering in tests and demos and swaps out
 *     for a real embedding model later without changing the `VectorStore` contract.
 *   - `InMemoryVectorStore` is the default backing store. `PgVectorStore` is a CONTRACT-ONLY
 *     stub documenting the pgvector shape for a later durable, tenant-isolated index.
 *
 * CONSTITUTIONAL INVARIANT — HOPE memory CANNOT execute. It only stores and retrieves text +
 * vectors. It mints no RoutingPacket, imports no peer agent (no DREAM/VISION/APEX/KNOLL logic),
 * runs no tool, and triggers no side effects beyond its own store. It is pure recall.
 */

/** Embedding dimensionality of the stub embedder. Small, fixed, deterministic. */
export const EMBED_DIM = 64;

/** A stored intent vector. Shape mirrors a future pgvector row (id, embedding, payload, tenant). */
export interface StoredIntent {
  id: string;
  /** The original intent text (or a summary of it). */
  text: string;
  /** The embedding vector (length = dim). */
  vector: number[];
  /** Optional tenant for isolated retrieval (NO_CROSS_TENANT). */
  tenantId?: string;
  /** Opaque metadata carried alongside the intent (never executed). */
  metadata?: Record<string, unknown>;
  createdAt: number;
}

export interface VectorQuery {
  vector: number[];
  /** Number of nearest neighbors to return. */
  k: number;
  /** When set, only vectors with the same tenantId are considered (tenant isolation). */
  tenantId?: string;
}

export interface VectorMatch {
  record: StoredIntent;
  /** Cosine similarity in 0..1 (higher = more similar). */
  similarity: number;
}

/**
 * The storage seam. `InMemoryVectorStore` implements it now; a pgvector-backed store implements
 * the same contract later. All methods are async so a DB-backed implementation is a drop-in.
 */
export interface VectorStore {
  upsert(record: StoredIntent): Promise<void>;
  query(q: VectorQuery): Promise<VectorMatch[]>;
  size(): Promise<number>;
  clear(): Promise<void>;
}

/**
 * Deterministic STUB embedder: a signed hashed-bag-of-tokens vector, L2-normalized. Two texts
 * sharing tokens land near each other; disjoint texts are near-orthogonal. No model, no network.
 */
export function embedIntent(text: string, dim: number = EMBED_DIM): number[] {
  const vec = new Array<number>(dim).fill(0);
  const tokens = tokenize(text);
  for (const tok of tokens) {
    const h = fnv1a(tok);
    const bucket = h % dim;
    // A second hash decides the sign so collisions don't all pull the same direction.
    const sign = (fnv1a(`${tok}#sign`) & 1) === 0 ? 1 : -1;
    vec[bucket] += sign;
  }
  return l2normalize(vec);
}

/** Cosine similarity mapped to 0..1 (1 = identical direction, 0.5 = orthogonal, 0 = opposite). */
export function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length) throw new Error('cosineSimilarity: vector dimension mismatch');
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  if (na === 0 || nb === 0) return 0;
  const cos = dot / (Math.sqrt(na) * Math.sqrt(nb));
  // Map [-1, 1] → [0, 1] so callers get a clean 0..1 similarity.
  return round6((cos + 1) / 2);
}

/** The default, offline vector store. Linear scan — fine for the archive sizes we test with. */
export class InMemoryVectorStore implements VectorStore {
  private readonly records = new Map<string, StoredIntent>();

  async upsert(record: StoredIntent): Promise<void> {
    this.records.set(record.id, { ...record, vector: [...record.vector] });
  }

  async query(q: VectorQuery): Promise<VectorMatch[]> {
    const matches: VectorMatch[] = [];
    for (const record of this.records.values()) {
      if (q.tenantId !== undefined && record.tenantId !== q.tenantId) continue;
      matches.push({ record, similarity: cosineSimilarity(q.vector, record.vector) });
    }
    matches.sort((a, b) => b.similarity - a.similarity || cmp(a.record.id, b.record.id));
    return matches.slice(0, Math.max(0, q.k));
  }

  async size(): Promise<number> {
    return this.records.size;
  }

  async clear(): Promise<void> {
    this.records.clear();
  }
}

/**
 * CONTRACT-ONLY pgvector store stub. It documents the intended table/DDL and the query shape so
 * a later PR can wire a real client. Without an injected client, every call throws a clear,
 * actionable error rather than silently pretending to persist.
 *
 * Intended schema (Postgres + pgvector):
 *   CREATE EXTENSION IF NOT EXISTS vector;
 *   CREATE TABLE intent_memory (
 *     id         text PRIMARY KEY,
 *     tenant_id  text,
 *     text       text NOT NULL,
 *     embedding  vector(64) NOT NULL,
 *     metadata   jsonb,
 *     created_at timestamptz NOT NULL DEFAULT now()
 *   );
 *   CREATE INDEX ON intent_memory USING ivfflat (embedding vector_cosine_ops);
 *   -- retrieval (tenant-isolated):  ORDER BY embedding <=> $1  WHERE tenant_id = $2  LIMIT $k;
 */
export interface PgVectorClient {
  upsert(record: StoredIntent): Promise<void>;
  query(q: VectorQuery): Promise<VectorMatch[]>;
  size(): Promise<number>;
  clear(): Promise<void>;
}

export class PgVectorStore implements VectorStore {
  constructor(private readonly client?: PgVectorClient) {}

  private ensure(): PgVectorClient {
    if (!this.client) {
      throw new Error(
        'PgVectorStore is a contract-only stub: inject a PgVectorClient (Postgres + pgvector) to use it. ' +
          'See the DDL in hope/memory.ts. For offline use, prefer InMemoryVectorStore.',
      );
    }
    return this.client;
  }

  async upsert(record: StoredIntent): Promise<void> {
    return this.ensure().upsert(record);
  }

  async query(q: VectorQuery): Promise<VectorMatch[]> {
    return this.ensure().query(q);
  }

  async size(): Promise<number> {
    return this.ensure().size();
  }

  async clear(): Promise<void> {
    return this.ensure().clear();
  }
}

export interface IntentMemoryOptions {
  /** Backing store. Defaults to an in-memory store. */
  store?: VectorStore;
  /** Embedding dimensionality. Default EMBED_DIM (64). */
  dim?: number;
  /** Pluggable embedder (defaults to the deterministic hash-vector stub). */
  embed?: (text: string, dim: number) => number[];
  /** Injectable id factory (deterministic tests). */
  newId?: () => string;
}

export interface RememberOptions {
  tenantId?: string;
  metadata?: Record<string, unknown>;
  /** Optional explicit id (for upsert / dedup). A fresh one is minted when omitted. */
  id?: string;
}

export interface RecallOptions {
  /** How many similar intents to return. Default 5. */
  k?: number;
  /** Restrict recall to one tenant (tenant-isolated retrieval). */
  tenantId?: string;
}

/**
 * IntentMemory — remember interpreted intents and recall the most similar ones as context.
 *
 * Pure recall: it never executes, routes, or creates. It is the HOPE-side archive that a future
 * pgvector index will back; today it runs fully offline on the stub embedder + in-memory store.
 */
export class IntentMemory {
  private readonly store: VectorStore;
  private readonly dim: number;
  private readonly embed: (text: string, dim: number) => number[];
  private readonly newId: () => string;
  private counter = 0;

  constructor(options: IntentMemoryOptions = {}) {
    this.store = options.store ?? new InMemoryVectorStore();
    this.dim = options.dim ?? EMBED_DIM;
    this.embed = options.embed ?? embedIntent;
    this.newId = options.newId ?? (() => `intent_${Date.now().toString(36)}_${(this.counter++).toString(36)}`);
  }

  /** Embed and store an intent. Returns the stored record (including its vector + id). */
  async remember(text: string, options: RememberOptions = {}): Promise<StoredIntent> {
    if (typeof text !== 'string' || text.trim().length === 0) {
      throw new Error('IntentMemory.remember: text must be a non-empty string');
    }
    const record: StoredIntent = {
      id: options.id ?? this.newId(),
      text,
      vector: this.embed(text, this.dim),
      tenantId: options.tenantId,
      metadata: options.metadata,
      createdAt: Date.now(),
    };
    await this.store.upsert(record);
    return record;
  }

  /** Recall the k most similar past intents to a query (tenant-isolated when a tenant is given). */
  async recall(query: string, options: RecallOptions = {}): Promise<VectorMatch[]> {
    if (typeof query !== 'string' || query.trim().length === 0) {
      throw new Error('IntentMemory.recall: query must be a non-empty string');
    }
    return this.store.query({
      vector: this.embed(query, this.dim),
      k: options.k ?? 5,
      tenantId: options.tenantId,
    });
  }

  /** Number of intents currently archived. */
  async size(): Promise<number> {
    return this.store.size();
  }

  /** Forget everything (test/reset helper). */
  async clear(): Promise<void> {
    return this.store.clear();
  }
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length > 0);
}

/** 32-bit FNV-1a hash (unsigned). */
function fnv1a(str: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

function l2normalize(vec: number[]): number[] {
  let norm = 0;
  for (const v of vec) norm += v * v;
  norm = Math.sqrt(norm);
  if (norm === 0) return vec.map(() => 0);
  return vec.map((v) => round6(v / norm));
}

function cmp(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function round6(n: number): number {
  return Math.round((n + Number.EPSILON) * 1e6) / 1e6;
}
