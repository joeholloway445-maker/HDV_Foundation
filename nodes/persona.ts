/**
 * nodes/persona.ts — the ephemeral persona lifecycle: spawn -> execute -> terminate.
 *
 * A persona is the smallest unit of work in the matrix. It is created, does exactly one
 * job, and is destroyed. Personas never persist. Each is conceptually tied to a 7B model.
 */
import { randomUUID } from 'node:crypto';
import type { AgentRole } from '../config/routing_schema.js';
import { MODEL_SIZE } from './constants.js';

export type PersonaState = 'SPAWNED' | 'EXECUTING' | 'TERMINATED';

export interface Persona {
  id: string;
  owner: AgentRole;
  nodeId: string;
  modelSize: string;
  state: PersonaState;
  spawnedAt: number;
  terminatedAt?: number;
}

export interface PersonaExecution {
  personaId: string;
  input: Record<string, unknown>;
  score: number;
  durationMs: number;
}

/** SPAWN — create an ephemeral persona bound to a node of a given Big AI. */
export function spawnPersona(owner: AgentRole, nodeId: string): Persona {
  return {
    id: `persona_${randomUUID()}`,
    owner,
    nodeId,
    modelSize: MODEL_SIZE,
    state: 'SPAWNED',
    spawnedAt: Date.now(),
  };
}

/**
 * EXECUTE — run the persona's single job. Phase 1 produces a deterministic pseudo-score
 * derived from the input so results are reproducible without real model inference.
 */
export function executePersona(persona: Persona, input: Record<string, unknown>): PersonaExecution {
  if (persona.state === 'TERMINATED') {
    throw new Error(`persona ${persona.id} already terminated — cannot execute`);
  }
  persona.state = 'EXECUTING';
  const score = pseudoScore(JSON.stringify(input) + persona.id);
  return { personaId: persona.id, input, score, durationMs: 1 };
}

/** TERMINATE — destroy the persona. Ephemeral by contract; no reuse afterward. */
export function terminatePersona(persona: Persona): Persona {
  persona.state = 'TERMINATED';
  persona.terminatedAt = Date.now();
  return persona;
}

/** Deterministic 0..1 pseudo-score (FNV-1a hash normalized). */
function pseudoScore(seed: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < seed.length; i++) {
    h ^= seed.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return ((h >>> 0) % 10000) / 10000;
}
