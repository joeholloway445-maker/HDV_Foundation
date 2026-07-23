/**
 * hope/documenter.ts — HOPE's documentation layer (Phase 2).
 *
 * One of HOPE's core jobs is DOCUMENTING user intent. This module turns a parsed
 * StructuredIntent into a persisted `IntentDocument` and stores it in an IntentArchive.
 * The archive is backed by the persistence layer's IntentArchiveRepository (in-memory by
 * default, DB-ready for a later phase).
 *
 * CONSTRAINT: documenting is interpretation, NOT execution or creation of artifacts.
 * HOPE records what the user meant; it never acts on it. It imports no peer agent.
 */
import { randomUUID } from 'node:crypto';
import type { AgentRole } from '../config/routing_schema.js';
import {
  InMemoryIntentArchiveRepository,
  type IntentArchiveRepository,
  type IntentDocumentRecord,
} from '../persistence/repositories.js';
import type { StructuredIntent, IntentKind } from './interpreter.js';

/**
 * The documented, persistable form of a user intent. Matches the IntentDocument Prisma
 * model in config/schema.prisma.
 */
export interface IntentDocument {
  id: string;
  utterance: string;
  kind: IntentKind;
  entities: string[];
  goals: string[];
  constraints: string[];
  suggestedDestination: AgentRole;
  confidence: number;
  documentedAt: number;
  clarificationNeeded?: boolean;
}

export interface HopeDocumenterOptions {
  /** Archive backend; defaults to an in-memory IntentArchiveRepository. */
  archive?: IntentArchiveRepository;
}

export class HopeDocumenter {
  private readonly archive: IntentArchiveRepository;

  constructor(options: HopeDocumenterOptions = {}) {
    this.archive = options.archive ?? new InMemoryIntentArchiveRepository();
  }

  /** Turn a parsed intent into a persisted IntentDocument and store it. */
  document(intent: StructuredIntent): IntentDocument {
    const doc: IntentDocument = {
      id: `intent_${randomUUID()}`,
      utterance: intent.intent,
      kind: intent.kind,
      entities: [...intent.entities],
      goals: [...intent.goals],
      constraints: [...intent.constraints],
      suggestedDestination: intent.suggestedDestination,
      confidence: intent.confidence,
      documentedAt: Date.now(),
      clarificationNeeded: intent.clarificationNeeded,
    };
    this.archive.save(toRecord(doc));
    return doc;
  }

  /** Retrieve a documented intent by id. */
  get(id: string): IntentDocument | undefined {
    const rec = this.archive.get(id);
    return rec ? fromRecord(rec) : undefined;
  }

  /** All documented intents. */
  all(): IntentDocument[] {
    return this.archive.all().map(fromRecord);
  }

  /** Documented intents still awaiting user clarification. */
  needingClarification(): IntentDocument[] {
    return this.archive.needingClarification().map(fromRecord);
  }

  count(): number {
    return this.archive.all().length;
  }
}

function toRecord(doc: IntentDocument): IntentDocumentRecord {
  return {
    id: doc.id,
    utterance: doc.utterance,
    kind: doc.kind,
    entities: doc.entities,
    goals: doc.goals,
    constraints: doc.constraints,
    suggestedDestination: doc.suggestedDestination,
    confidence: doc.confidence,
    documentedAt: doc.documentedAt,
    clarificationNeeded: doc.clarificationNeeded ?? false,
  };
}

function fromRecord(rec: IntentDocumentRecord): IntentDocument {
  return {
    id: rec.id,
    utterance: rec.utterance,
    kind: rec.kind as IntentKind,
    entities: rec.entities,
    goals: rec.goals,
    constraints: rec.constraints,
    suggestedDestination: rec.suggestedDestination,
    confidence: rec.confidence,
    documentedAt: rec.documentedAt,
    clarificationNeeded: rec.clarificationNeeded,
  };
}
