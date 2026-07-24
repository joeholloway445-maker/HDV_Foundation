/**
 * nodes/persona.ts — the ephemeral persona lifecycle: spawn -> execute -> terminate.
 *
 * A persona is the smallest unit of work in the matrix. It is created, does exactly one
 * job, and is destroyed. Personas never persist. Each is conceptually tied to a model.
 *
 * When HDV_PERSONA_INFERENCE=1 (or live:true), executePersona drives a REAL Ollama
 * completion and folds the text into the score. Otherwise it keeps the deterministic
 * offline pseudo-score (tests / no model).
 */
import { execFileSync } from 'node:child_process';
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
  /** Provenance when a live model ran the persona. */
  backend?: 'stub' | 'ollama';
  modelId?: string;
  text?: string;
}

export interface ExecutePersonaOptions {
  /** Force live Ollama inference for this call. */
  live?: boolean;
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
 * EXECUTE — run the persona's single job.
 * Live path (HDV_PERSONA_INFERENCE=1): Ollama generate → score from generated text.
 * Offline path: deterministic pseudo-score (reproducible tests, no model required).
 */
export function executePersona(
  persona: Persona,
  input: Record<string, unknown>,
  options: ExecutePersonaOptions = {},
): PersonaExecution {
  if (persona.state === 'TERMINATED') {
    throw new Error(`persona ${persona.id} already terminated — cannot execute`);
  }
  persona.state = 'EXECUTING';
  const live =
    options.live === true ||
    (options.live !== false &&
      ['1', 'true', 'yes', 'on'].includes((process.env.HDV_PERSONA_INFERENCE ?? '').trim().toLowerCase()));

  if (live) {
    try {
      return executePersonaOllama(persona, input);
    } catch (err) {
      // Fall through to stub so a transient Ollama blip never bricks routing.
      if (process.env.HDV_PERSONA_INFERENCE_STRICT === '1') throw err;
    }
  }

  const score = pseudoScore(JSON.stringify(input) + persona.id);
  return { personaId: persona.id, input, score, durationMs: 1, backend: 'stub', modelId: 'stub-1' };
}

/** TERMINATE — destroy the persona. Ephemeral by contract; no reuse afterward. */
export function terminatePersona(persona: Persona): Persona {
  persona.state = 'TERMINATED';
  persona.terminatedAt = Date.now();
  return persona;
}

/** Live Ollama persona: one short completion, score folded from the generated text. */
function executePersonaOllama(persona: Persona, input: Record<string, unknown>): PersonaExecution {
  const started = Date.now();
  const baseRaw =
    process.env.PERSONAMATRIX_OLLAMA_URL ||
    process.env.OLLAMA_HOST ||
    process.env.HDV_LLM_BASE_URL ||
    'http://127.0.0.1:11434';
  const base = baseRaw.replace(/\/v1\/?$/, '').replace(/\/$/, '');
  const root = base.includes('://') ? base : `http://${base}`;
  const model =
    process.env.PERSONAMATRIX_MODEL_ID || process.env.HDV_LLM_MODEL || 'llama3.2:3b';
  const intent =
    typeof input.intent === 'string' && input.intent.trim()
      ? input.intent.trim()
      : JSON.stringify(input);
  const prompt =
    `You are ephemeral persona ${persona.id} under ${persona.owner}. ` +
    `Reply in ONE short sentence (max 40 words) for this task:\n${intent}`;
  const payload = JSON.stringify({
    model,
    prompt,
    stream: false,
    options: { num_predict: 48, temperature: 0.4 },
  });
  const out = execFileSync(
    'curl',
    ['-sS', '--max-time', '120', '-X', 'POST', `${root}/api/generate`, '-H', 'Content-Type: application/json', '-d', payload],
    { encoding: 'utf8', maxBuffer: 2 * 1024 * 1024 },
  );
  const parsed = JSON.parse(out) as { response?: string };
  const text = (parsed.response ?? '').trim() || `(empty ollama response for ${persona.id})`;
  const score = pseudoScore(text);
  return {
    personaId: persona.id,
    input,
    score,
    durationMs: Date.now() - started,
    backend: 'ollama',
    modelId: model,
    text,
  };
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
