/**
 * serving/persona_adapters.ts — a persona as a cheap DELTA over shared base weights
 * (Phase 6.2 "the honest big-number").
 *
 * The system's headline is ~2,048,000 personas over a ~14.3-quadrillion-parameter fleet. The
 * truthful bridge from that to real compute is: DON'T load a 7B per persona. Load the 7B BASE
 * once per vLLM replica, and represent each persona as a small `(LoRA adapter, prompt profile,
 * sampling)` delta applied at request time. This module builds those adapters, renders a persona
 * request for `VllmClient`, and reports the honest per-persona parameter cost (via
 * `nodes/parameters.ts`) so the ledger/eval board price active-parameter-seconds truthfully.
 *
 * It is pure data + text assembly: no routing, no gating, no ledger, no network.
 */
import { deltaParamsPerPersona as loraDeltaParams } from '../nodes/parameters.js';
import type { VllmClient, VllmCompletion, VllmCompleteOptions, VllmSampling } from './vllm_client.js';

export interface PersonaAdapterInput {
  /** Stable persona identifier (e.g. a node/persona coordinate). */
  personaId: string;
  /** The shared base model id all personas ride on (loaded once per replica). */
  baseModel: string;
  /** Optional persona "voice"/instruction profile, prepended to the user prompt. */
  systemPrompt?: string;
  /** Optional LoRA adapter id to activate on the vLLM server for this persona. */
  loraId?: string;
  /**
   * LoRA rank for this persona's delta. Default 16. Pass 0 for a prompt/sampling-only persona
   * (zero adapter weights — the cheapest possible persona).
   */
  loraRank?: number;
  /** Per-persona sampling profile. */
  sampling?: VllmSampling;
}

export interface PersonaAdapter {
  readonly personaId: string;
  readonly baseModel: string;
  readonly systemPrompt?: string;
  readonly loraId?: string;
  readonly loraRank: number;
  readonly sampling: VllmSampling;
  /** Parameters this persona adds ON TOP of the shared base — the only params that scale with it. */
  readonly deltaParams: number;
}

/** Build a persona adapter, computing its honest delta-parameter footprint. */
export function createPersonaAdapter(input: PersonaAdapterInput): PersonaAdapter {
  const loraRank = input.loraRank === undefined ? 16 : Math.max(0, Math.floor(input.loraRank));
  return {
    personaId: input.personaId,
    baseModel: input.baseModel,
    systemPrompt: input.systemPrompt,
    loraId: input.loraId,
    loraRank,
    sampling: { ...input.sampling },
    deltaParams: loraDeltaParams(loraRank),
  };
}

export interface RenderedPersonaRequest {
  /** The assembled prompt (system profile + user text) for the /v1/completions call. */
  prompt: string;
  /** The vLLM call options (model, lora, sampling) derived from the adapter. */
  options: VllmCompleteOptions;
}

/**
 * Assemble the concrete `/v1/completions` request for a persona and a user prompt. The system
 * profile becomes a prefix (the completions endpoint has no message roles), and the adapter's
 * base model / LoRA / sampling are folded into the call options.
 */
export function renderPersonaRequest(adapter: PersonaAdapter, userPrompt: string): RenderedPersonaRequest {
  const prompt = adapter.systemPrompt ? `${adapter.systemPrompt.trim()}\n\n${userPrompt}` : userPrompt;
  const options: VllmCompleteOptions = {
    model: adapter.baseModel,
    ...adapter.sampling,
  };
  if (adapter.loraId) options.loraId = adapter.loraId;
  return { prompt, options };
}

/** Run one persona against a vLLM client. Thin convenience over render + client.complete. */
export function completeWithPersona(
  client: VllmClient,
  adapter: PersonaAdapter,
  userPrompt: string,
): Promise<VllmCompletion> {
  const { prompt, options } = renderPersonaRequest(adapter, userPrompt);
  return client.complete(prompt, options);
}

export interface PersonaBatchAccounting {
  /** Personas in the batch. */
  personaCount: number;
  /** Distinct base models the batch touches (ideally 1 → maximal weight sharing). */
  baseModels: string[];
  /** Sum of every persona's delta params — the batch's marginal parameter cost. */
  totalDeltaParams: number;
}

/**
 * Account for a node's worth of personas batched onto the SAME shared server (vLLM continuous
 * batching keeps the GPU hot). This reports only the marginal DELTA cost — the base weights are
 * counted once per replica by `nodes/parameters.sharedBaseParams`, not here.
 */
export function accountPersonaBatch(adapters: readonly PersonaAdapter[]): PersonaBatchAccounting {
  const baseModels = Array.from(new Set(adapters.map((a) => a.baseModel)));
  const totalDeltaParams = adapters.reduce((sum, a) => sum + a.deltaParams, 0);
  return { personaCount: adapters.length, baseModels, totalDeltaParams };
}
