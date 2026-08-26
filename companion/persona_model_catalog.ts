/**
 * companion/persona_model_catalog.ts — text-generation twin of colab/07_portrait_server.py's
 * PERSONA_LORA_ROUTES, for chat instead of portraits.
 *
 * WHAT THIS IS
 * ------------
 * A "mixture of small experts" catalog: instead of one big general-purpose chat model
 * answering as every companion, each catalogued persona gets its own small, efficient LoRA
 * fine-tune — a few tens of MB, not a separate multi-GB model — layered on ONE shared base
 * model at serve time. This is the same efficient pattern the image pipeline already uses
 * (a shared SDXL checkpoint + one small per-persona LoRA), just applied to text.
 *
 * HOW IT'S SERVED (see colab/12_persona_chat_server.md for the full setup)
 * ---------------------------------------------------------------------------
 * vLLM's OpenAI-compatible server supports registering many LoRA adapters against one base
 * model at startup (`--enable-lora --lora-modules <name>=<path> ...`) and selecting between
 * them PER REQUEST via the ordinary OpenAI `model` field — no custom protocol needed. That's
 * exactly what `providers/openai_compatible.ts` already sends (`CompleteOptions.model`
 * overrides the provider's default per call) — this catalog just decides what to put there.
 *
 * A persona with NO entry here (the default for every persona until someone trains and
 * registers a LoRA for it) gets `undefined`, which means "use the provider's configured
 * default model" — the shared, un-specialized base — exactly mirroring how a persona with no
 * trained portrait LoRA falls back to the plain per-style checkpoint. Nothing breaks; replies
 * are just less specialized until a persona earns its own entry.
 *
 * SCALING UNDER LOAD ("kick on another expert")
 * -------------------------------------------------
 * This catalog only decides WHICH adapter name to request — it has no opinion on how many
 * vLLM replicas exist behind HDV_LLM_BASE_URL. Route more traffic to a hot persona by running
 * additional vLLM instances (or Kaggle/Colab GPU sessions) behind a load balancer / DNS round
 * robin, all serving the SAME registered adapter names — this catalog's output (the adapter
 * name) doesn't change, only how many servers can answer for it.
 *
 * ADDING A PERSONA
 * -------------------
 * 1. Fine-tune a small LoRA for that persona's voice (a chat-transcript LoRA, e.g. via
 *    Hugging Face `peft`/`trl` or axolotl — same idea as colab/11_train_character_lora.py but
 *    for text instead of image weights; not yet scripted here).
 * 2. Register it on the vLLM server with `--lora-modules <personaId>=<path-to-adapter>`.
 * 3. Add `<personaId>: '<personaId>'` below (the adapter name convention is "same as the
 *    persona/companion id" so this catalog stays a trivial allowlist, not a translation table).
 */

/**
 * personaId -> registered vLLM LoRA adapter name. Empty by default — same starting point as
 * PERSONA_LORA_ROUTES before any character had a trained portrait LoRA. Populate as adapters
 * are trained and registered; see the module doc comment above.
 */
export const PERSONA_MODEL_ROUTES: Readonly<Record<string, string>> = Object.freeze({});

/**
 * Resolve the model-override to send for a given companionId/personaId, or `undefined` when
 * uncatalogued (⇒ caller omits `CompleteOptions.model`, provider uses its configured default).
 * `catalog` defaults to PERSONA_MODEL_ROUTES; injectable for tests.
 */
export function resolvePersonaModel(
  companionId: string | undefined,
  catalog: Readonly<Record<string, string>> = PERSONA_MODEL_ROUTES,
): string | undefined {
  if (!companionId) return undefined;
  return catalog[companionId];
}
