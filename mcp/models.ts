/**
 * mcp/models.ts — the model catalog surfaced by the `hdv_models` MCP tool.
 *
 * If `config/models.json` exists it is treated as the source of truth (parsed leniently). If
 * it is absent or malformed, we fall back to a static, offline-first list of 7B / local
 * options. Nothing here reaches the network or requires a paid API — it only describes the
 * shapes an operator *could* wire in via the providers/ package env vars.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { MODEL_SIZE, MODEL_PARAMS } from '../nodes/constants.js';

export interface ModelInfo {
  /** Stable identifier an agent would pass as `model`. */
  id: string;
  /** Human-readable label. */
  label: string;
  /** Rough parameter class (e.g. "7B"). */
  size: string;
  /** How this model is reached: the offline default, or an env-driven provider. */
  provider: 'stub' | 'openai_compatible';
  /** Whether the model runs locally / offline (no paid API required). */
  local: boolean;
  /** Short description. */
  description: string;
}

export interface ModelCatalog {
  /** 'config' when loaded from config/models.json, 'builtin' for the static fallback. */
  source: 'config' | 'builtin';
  /** The conceptual per-persona model size the matrix is built on. */
  matrixModel: { size: string; params: number };
  models: ModelInfo[];
}

const CONFIG_MODELS_PATH = path.resolve(fileURLToPath(new URL('../config/models.json', import.meta.url)));

/**
 * The offline-first default catalog. Every entry is a local / self-hostable 7B-8B option,
 * plus the deterministic in-process stub and a generic openai-compatible endpoint (wired via
 * HDV_LLM_* env vars — see providers/factory.ts). No entry requires a paid API by default.
 */
export const BUILTIN_MODELS: ModelInfo[] = [
  {
    id: 'hdv-stub-1',
    label: 'HDV Stub (deterministic, offline)',
    size: MODEL_SIZE,
    provider: 'stub',
    local: true,
    description: 'Deterministic, network-free text transducer. The always-available default.',
  },
  {
    id: 'llama-3.1-8b-local',
    label: 'Llama 3.1 8B (local)',
    size: '8B',
    provider: 'openai_compatible',
    local: true,
    description: 'Self-hosted via an OpenAI-compatible server (Ollama / vLLM / llama.cpp).',
  },
  {
    id: 'mistral-7b-local',
    label: 'Mistral 7B (local)',
    size: '7B',
    provider: 'openai_compatible',
    local: true,
    description: 'Self-hosted 7B; the size class the matrix personas are conceptually built on.',
  },
  {
    id: 'qwen2.5-7b-local',
    label: 'Qwen2.5 7B (local)',
    size: '7B',
    provider: 'openai_compatible',
    local: true,
    description: 'Self-hosted 7B instruction model over an OpenAI-compatible endpoint.',
  },
  {
    id: 'phi-3.5-mini-local',
    label: 'Phi-3.5 Mini (local)',
    size: '3.8B',
    provider: 'openai_compatible',
    local: true,
    description: 'Small, fast local model for cheap enrichment; runs comfortably on CPU/GPU.',
  },
];

/**
 * Build the model catalog. Reads config/models.json when present (array of ModelInfo, or an
 * object with a `models` array); otherwise returns the built-in offline list. Never throws —
 * a missing or malformed file falls back to the built-ins.
 */
export function loadModelCatalog(configPath: string = CONFIG_MODELS_PATH): ModelCatalog {
  const matrixModel = { size: MODEL_SIZE, params: MODEL_PARAMS };
  try {
    const raw = readFileSync(configPath, 'utf8');
    const parsed: unknown = JSON.parse(raw);
    const models = coerceModels(parsed);
    if (models.length > 0) {
      return { source: 'config', matrixModel, models };
    }
  } catch {
    // Missing / unreadable / invalid JSON — fall through to the built-in list.
  }
  return { source: 'builtin', matrixModel, models: BUILTIN_MODELS };
}

/**
 * Accept either a bare array or `{ models: [...] }`, keeping only well-formed entries. The
 * reader is tolerant of alternate field names used elsewhere in the repo's model catalog
 * (`displayName`, `parameterCount` in billions, `providerKind`, `hosting`) so a single
 * config/models.json can serve multiple front doors.
 */
function coerceModels(parsed: unknown): ModelInfo[] {
  const arr = Array.isArray(parsed)
    ? parsed
    : parsed && typeof parsed === 'object' && Array.isArray((parsed as { models?: unknown }).models)
      ? (parsed as { models: unknown[] }).models
      : [];
  const out: ModelInfo[] = [];
  for (const item of arr) {
    if (!item || typeof item !== 'object') continue;
    const rec = item as Record<string, unknown>;
    if (typeof rec.id !== 'string' || rec.id.length === 0) continue;

    const label =
      typeof rec.label === 'string' ? rec.label : typeof rec.displayName === 'string' ? rec.displayName : rec.id;
    const size =
      typeof rec.size === 'string'
        ? rec.size
        : typeof rec.parameterCount === 'number'
          ? `${rec.parameterCount}B`
          : 'unknown';
    const provider =
      rec.provider === 'openai_compatible' || rec.providerKind === 'openai_compatible' ? 'openai_compatible' : 'stub';
    const local =
      typeof rec.local === 'boolean' ? rec.local : rec.hosting === undefined ? true : rec.hosting === 'local';

    out.push({
      id: rec.id,
      label,
      size,
      provider,
      local,
      description: typeof rec.description === 'string' ? rec.description : '',
    });
  }
  return out;
}
