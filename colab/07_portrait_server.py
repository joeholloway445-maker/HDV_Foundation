# ---
# Big 5 Matrix -- Colab: Companion Portrait Server (v0.3.0)
# ML LAB ONLY: GPU image generation. Simulation/compute only.
# RESTRICTION: no webcam, no microphone, no physical-world I/O.
#
# Notebook-style (`# %%` cell markers) so it opens cleanly in Colab/Jupyter. Unlike the other
# colab/*.py files, this one is NOT meant to also run top-to-bottom as a plain script -- the
# server cell blocks (it's a server), so run cells in order and leave the last cell running.
#
# WHAT THIS IS
# ------------
# A FastAPI server exposing ONE endpoint that speaks the exact contract HDV's
# ColabTunnelImageProvider expects (providers/colab_tunnel_image.ts):
#
#   POST /generate
#   body: { "prompt": str, "style"?: str, "negative_prompt"?: str, "width"?: int,
#           "height"?: int, "steps"?: int, "seed"?: int }
#   200 -> { "image_base64": str, "mime_type": "image/png", "model": str }
#
# `style` (from PortraitPersona.style -- FuckLike/web's own "Realistic" / "Anime" create-form
# option) picks WHICH checkpoint runs this request -- see MODEL_ROUTES below. This is the
# SAME pattern as Ollama (deploy/OLLAMA.md): a plain HTTP endpoint the gateway calls. The
# gateway never knows or cares which checkpoint(s) are loaded here -- that's the whole point
# of the provider seam (providers/image_types.ts). It never touches APEX/KNOLL/routing.
#
# MODELS -- v0.3.0 defaults, both verified via the HF Hub API (download/like counts, task tag,
# base_model lineage), not guessed. Re-check periodically since versions do move on:
# realistic -> SG161222/RealVisXL_V4.0 -- 6.8M downloads, openrail++ license, standard
#              diffusers-format StableDiffusionXLPipeline. https://huggingface.co/SG161222
# anime     -> Bakanayatsu/Pony-Diffusion-V6-XL-for-Anime -- a full, standalone,
#              diffusers-compatible Pony Diffusion V6 XL checkpoint (38.5K downloads); paired
#              by default with the LyliaEngine/Pony_Diffusion_V6_XL LoRA (862K downloads,
#              cdla-permissive-2.0), whose own HF metadata declares this exact repo as its
#              base_model -- i.e. this is the base+LoRA pair the community itself uses, not an
#              improvised pairing. The loader (Cell 2) handles either a Hugging Face repo id OR
#              a direct .safetensors path/URL for either MODEL_ROUTES or LORA_ROUTES, so a
#              Civitai-only checkpoint/LoRA drops in the same way if you swap either later.
#
# Both are SDXL-family (~3.5B params) -- night-and-day lighter than LingBot-World's ~18.5B.
# A single one comfortably fits a free Colab T4 (16GB) in fp16; having BOTH loaded
# simultaneously is tighter but still very plausible, especially on Colab Pro. Default
# behavior here is lazy-load-and-swap (keeps only the most recently used style's pipeline in
# VRAM) so it works on the smallest GPU tier; set PRELOAD_ALL=1 once you've confirmed your GPU
# has headroom for both at once, to avoid the swap latency on style changes.
#
# COLAB SETUP (do this first in Colab)
# -------------------------------------
#   Runtime -> Change runtime type -> Hardware accelerator: GPU (T4 is enough for either model
#   alone; more headroom needed for PRELOAD_ALL=1).
#   !pip install -q diffusers transformers accelerate safetensors fastapi uvicorn pyngrok
#
# EXPOSING IT TO THE INTERNET (so the gateway can reach it)
# -----------------------------------------------------------
#   This notebook uses pyngrok for the tunnel (simplest path from inside Colab). Set
#   NGROK_AUTHTOKEN (free at ngrok.com) before running the tunnel cell. Cloudflare Tunnel is a
#   fine alternative if you'd rather not depend on ngrok -- swap the tunnel cell for `cloudflared`.
#
# WIRING IT INTO THE GATEWAY (on the VPS, in .env)
# ---------------------------------------------------
#   HDV_IMAGE_PROVIDER=colab_tunnel
#   HDV_IMAGE_BASE_URL=<the https://....ngrok-free.app URL this notebook prints>
#   HDV_IMAGE_API_KEY=<same value as PORTRAIT_SERVER_TOKEN below>
#   Then restart the gateway. No frontend changes -- FuckLike/web already sends persona.style
#   with every POST /v1/companion/portrait call and never talks to this server directly.
#
# CAVEAT: free Colab sessions are NOT persistent -- the notebook (and the tunnel URL) dies
# when the runtime disconnects/recycles. That's fine for development; for production uptime,
# either keep a Colab Pro session alive, or move this same server onto a dedicated GPU box
# later (the contract above doesn't change either way).
# ---

# %% [markdown]
# # 07 - Companion Portrait Server
# 1. Configure the realistic/anime model routes.
# 2. Define the lazy-loading pipeline loader (HF repo id OR direct .safetensors).
# 3. Define the `/generate` endpoint (the exact contract `ColabTunnelImageProvider` expects).
# 4. Open a tunnel and print the URL to paste into `HDV_IMAGE_BASE_URL`.
# 5. Run the server (blocks -- leave this cell running while the tunnel is in use).

# %%
# --- Cell 1: config -- EDIT / VERIFY before going live (see the header comment above) ---
import os

MODEL_ROUTES = {
    "realistic": os.environ.get("PORTRAIT_MODEL_REALISTIC", "SG161222/RealVisXL_V4.0"),
    # Verified via the HF Hub API (not guessed): LyliaEngine/Pony_Diffusion_V6_XL -- the
    # highest-download Pony V6 XL mirror on HF -- is itself a LoRA whose declared base_model is
    # this repo, which is a full, standalone, diffusers-compatible Pony V6 XL checkpoint. Using
    # it directly as the base avoids a base+LoRA dependency chain for the common case; the
    # LyliaEngine LoRA is wired in below as an optional refinement layer on top of it.
    "anime": os.environ.get("PORTRAIT_MODEL_ANIME", "Bakanayatsu/Pony-Diffusion-V6-XL-for-Anime"),
}
DEFAULT_STYLE = "realistic"  # used when persona.style is missing or doesn't match a route

# Optional: path/URL to a LoRA weights file to layer on top of a given style's checkpoint.
# Keyed the same as MODEL_ROUTES; leave a value empty/unset to skip for that style.
LORA_ROUTES = {
    "realistic": os.environ.get("PORTRAIT_LORA_REALISTIC", ""),
    "anime": os.environ.get("PORTRAIT_LORA_ANIME", "LyliaEngine/Pony_Diffusion_V6_XL"),
}

# Shared-secret bearer token this server requires on every request. MUST match
# HDV_IMAGE_API_KEY in the gateway's .env -- an ngrok URL is public, this is the only lock.
PORTRAIT_SERVER_TOKEN = os.environ.get("PORTRAIT_SERVER_TOKEN", "change-me-before-going-live")
DEFAULT_WIDTH = 1024
DEFAULT_HEIGHT = 1024
DEFAULT_STEPS = 30
# Load every configured route's checkpoint at startup and keep them all resident (needs more
# VRAM headroom). Default 0 = lazy-load-and-swap, keeping only the most recently used one.
PRELOAD_ALL = os.environ.get("PRELOAD_ALL", "0") == "1"

for style, model_id in MODEL_ROUTES.items():
    print(f"{style}: {model_id or '(not set)'}" + (f"  + LoRA {LORA_ROUTES[style]}" if LORA_ROUTES.get(style) else ""))

# %%
# --- Cell 2: lazy-loading pipeline loader (HF repo id OR a direct .safetensors path/URL) ---
import gc

import torch
from diffusers import StableDiffusionXLPipeline

DEVICE = "cuda" if torch.cuda.is_available() else "cpu"
if DEVICE == "cpu":
    print("WARNING: no GPU detected -- this will be extremely slow. Runtime -> Change runtime type -> GPU.")

_loaded_pipelines: dict[str, StableDiffusionXLPipeline] = {}


def _load_one(style: str) -> StableDiffusionXLPipeline:
    model_id = MODEL_ROUTES.get(style)
    if not model_id:
        raise RuntimeError(
            f"No model configured for style={style!r}. Set MODEL_ROUTES[{style!r}] "
            f"(env var PORTRAIT_MODEL_{style.upper()}) to a Hugging Face repo id or a direct "
            f".safetensors path/URL -- see this file's header comment for where to find one."
        )
    dtype = torch.float16 if DEVICE == "cuda" else torch.float32
    print(f"Loading {style} -> {model_id} ...")
    if model_id.endswith(".safetensors"):
        pipe = StableDiffusionXLPipeline.from_single_file(model_id, torch_dtype=dtype)
    else:
        pipe = StableDiffusionXLPipeline.from_pretrained(model_id, torch_dtype=dtype)
    pipe = pipe.to(DEVICE)

    lora = LORA_ROUTES.get(style)
    if lora:
        pipe.load_lora_weights(lora)
        print(f"  + LoRA: {lora}")

    print(f"  ready on {DEVICE}")
    return pipe


def get_pipeline(style: str) -> StableDiffusionXLPipeline:
    """Lazy-load-and-swap by default (VRAM-friendly on a single GPU); PRELOAD_ALL=1 keeps
    every configured route resident so style switches never pay a reload cost."""
    if style in _loaded_pipelines:
        return _loaded_pipelines[style]

    if not PRELOAD_ALL:
        # Evict whatever's currently loaded before loading the new one.
        for old_style, old_pipe in list(_loaded_pipelines.items()):
            del old_pipe
            del _loaded_pipelines[old_style]
        gc.collect()
        if DEVICE == "cuda":
            torch.cuda.empty_cache()

    _loaded_pipelines[style] = _load_one(style)
    return _loaded_pipelines[style]


if PRELOAD_ALL:
    for _style in MODEL_ROUTES:
        if MODEL_ROUTES[_style]:
            get_pipeline(_style)
else:
    print("Lazy-load-and-swap mode -- the first request for each style will load its checkpoint.")

# %%
# --- Cell 3: the /generate endpoint -- this IS the ColabTunnelImageProvider contract ---
import base64
import io

from fastapi import FastAPI, Header, HTTPException
from pydantic import BaseModel

app = FastAPI(title="HDV Companion Portrait Server")


class GenerateRequest(BaseModel):
    prompt: str
    style: str | None = None
    negative_prompt: str | None = None
    width: int | None = None
    height: int | None = None
    steps: int | None = None
    seed: int | None = None


class GenerateResponse(BaseModel):
    image_base64: str
    mime_type: str = "image/png"
    model: str


@app.get("/health")
def health():
    return {"ok": True, "routes": {k: bool(v) for k, v in MODEL_ROUTES.items()}, "device": DEVICE}


@app.post("/generate", response_model=GenerateResponse)
def generate(req: GenerateRequest, authorization: str | None = Header(default=None)):
    # Same shape as HDV's own gateway auth: "Bearer <token>". This is the only thing standing
    # between a public ngrok URL and anyone on the internet -- keep PORTRAIT_SERVER_TOKEN secret.
    expected = f"Bearer {PORTRAIT_SERVER_TOKEN}"
    if authorization != expected:
        raise HTTPException(status_code=401, detail="unauthorized")

    style = req.style if req.style in MODEL_ROUTES else DEFAULT_STYLE
    try:
        pipe = get_pipeline(style)
    except RuntimeError as e:
        raise HTTPException(status_code=503, detail=str(e))

    generator = None
    if req.seed is not None:
        generator = torch.Generator(device=DEVICE).manual_seed(req.seed)

    result = pipe(
        prompt=req.prompt,
        negative_prompt=req.negative_prompt,
        width=req.width or DEFAULT_WIDTH,
        height=req.height or DEFAULT_HEIGHT,
        num_inference_steps=req.steps or DEFAULT_STEPS,
        generator=generator,
    )
    image = result.images[0]

    buf = io.BytesIO()
    image.save(buf, format="PNG")
    image_b64 = base64.b64encode(buf.getvalue()).decode("ascii")

    return GenerateResponse(image_base64=image_b64, mime_type="image/png", model=MODEL_ROUTES[style])


print("FastAPI app defined: GET /health, POST /generate")

# %%
# --- Cell 4: open a tunnel and print the URL for HDV_IMAGE_BASE_URL ---
from pyngrok import ngrok

NGROK_AUTHTOKEN = os.environ.get("NGROK_AUTHTOKEN", "")
if NGROK_AUTHTOKEN:
    ngrok.set_auth_token(NGROK_AUTHTOKEN)

PORT = 8000
public_url = ngrok.connect(PORT, "http")
print("=" * 72)
print(f"Tunnel is live: {public_url}")
print("On the VPS, in HDV_Foundation's .env:")
print(f"  HDV_IMAGE_PROVIDER=colab_tunnel")
print(f"  HDV_IMAGE_BASE_URL={public_url}")
print(f"  HDV_IMAGE_API_KEY={PORTRAIT_SERVER_TOKEN}")
print("Then restart the gateway (systemctl restart hdv-gateway, or docker compose up -d gateway).")
print("=" * 72)

# %%
# --- Cell 5: run the server (BLOCKS -- leave this cell running) ---
import uvicorn

uvicorn.run(app, host="0.0.0.0", port=PORT)
