# ---
# Big 5 Matrix -- Colab: Companion Portrait Server (v0.1.0)
# ML LAB ONLY: GPU image generation. Simulation/compute only.
# RESTRICTION: no webcam, no microphone, no physical-world I/O.
#
# Notebook-style (`# %%` cell markers) so it opens cleanly in Colab/Jupyter. Unlike the other
# colab/*.py files, this one is NOT meant to also run top-to-bottom as a plain script — the
# server cell blocks (it's a server), so run cells in order and leave the last cell running.
#
# WHAT THIS IS
# ------------
# A minimal FastAPI server exposing ONE endpoint that speaks the exact contract HDV's
# ColabTunnelImageProvider expects (providers/colab_tunnel_image.ts):
#
#   POST /generate
#   body: { "prompt": str, "negative_prompt"?: str, "width"?: int, "height"?: int,
#           "steps"?: int, "seed"?: int }
#   200 -> { "image_base64": str, "mime_type": "image/png", "model": str }
#
# This is the SAME pattern as Ollama (deploy/OLLAMA.md): a plain HTTP endpoint the gateway
# calls. The gateway never knows or cares which checkpoint is loaded here -- that's the whole
# point of the provider seam (providers/image_types.ts). It never touches APEX/KNOLL/routing.
#
# CHOOSING A MODEL (do this before going live)
# ---------------------------------------------
# MODEL_ID below defaults to a small, well-known, SFW-safe base checkpoint purely so this
# scaffold runs out of the box on a free Colab T4 GPU for wiring/testing. Swap MODEL_ID (and
# LORA_PATH, if you're using a LoRA) for whatever checkpoint you've selected once you're ready
# to go live -- nothing else in this file needs to change. `diffusers` loads any standard
# Stable Diffusion / SDXL-format checkpoint from a Hugging Face repo id or a local/Drive path.
#
# COLAB SETUP (do this first in Colab)
# -------------------------------------
#   Runtime -> Change runtime type -> Hardware accelerator: GPU (T4 is enough to start).
#   !pip install -q diffusers transformers accelerate fastapi uvicorn pyngrok
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
#   Then restart the gateway. No frontend changes -- FuckLike/web already calls
#   POST /v1/companion/portrait and never talks to this server directly.
#
# CAVEAT: free Colab sessions are NOT persistent -- the notebook (and the tunnel URL) dies
# when the runtime disconnects/recycles. That's fine for development; for production uptime,
# either keep a Colab Pro session alive, or move this same server onto a dedicated GPU box
# later (the contract above doesn't change either way).
# ---

# %% [markdown]
# # 07 - Companion Portrait Server
# 1. Install deps + load a diffusion pipeline on the GPU.
# 2. Define the `/generate` endpoint (the exact contract `ColabTunnelImageProvider` expects).
# 3. Open a tunnel and print the URL to paste into `HDV_IMAGE_BASE_URL`.
# 4. Run the server (blocks -- leave this cell running while the tunnel is in use).

# %%
# --- Cell 1: config -- EDIT THESE when you've picked a checkpoint ---
import os

# Swap for your chosen checkpoint once selected. Any diffusers-compatible SD/SDXL repo id or
# local path works unchanged by the rest of this file.
MODEL_ID = os.environ.get("PORTRAIT_MODEL_ID", "stabilityai/stable-diffusion-xl-base-1.0")
# Optional: path to a LoRA weights file/repo to layer on top of MODEL_ID. Leave empty to skip.
LORA_PATH = os.environ.get("PORTRAIT_LORA_PATH", "")
# Shared-secret bearer token this server requires on every request. MUST match
# HDV_IMAGE_API_KEY in the gateway's .env -- an ngrok URL is public, this is the only lock.
PORTRAIT_SERVER_TOKEN = os.environ.get("PORTRAIT_SERVER_TOKEN", "change-me-before-going-live")
DEFAULT_WIDTH = 768
DEFAULT_HEIGHT = 768
DEFAULT_STEPS = 30

print(f"Model: {MODEL_ID}")
print(f"LoRA: {LORA_PATH or '(none)'}")

# %%
# --- Cell 2: load the pipeline on the GPU ---
import torch
from diffusers import DiffusionPipeline

DEVICE = "cuda" if torch.cuda.is_available() else "cpu"
if DEVICE == "cpu":
    print("WARNING: no GPU detected -- this will be extremely slow. Runtime -> Change runtime type -> GPU.")

pipe = DiffusionPipeline.from_pretrained(
    MODEL_ID,
    torch_dtype=torch.float16 if DEVICE == "cuda" else torch.float32,
)
pipe = pipe.to(DEVICE)

if LORA_PATH:
    pipe.load_lora_weights(LORA_PATH)
    print(f"Loaded LoRA: {LORA_PATH}")

print("Pipeline ready on", DEVICE)

# %%
# --- Cell 3: the /generate endpoint -- this IS the ColabTunnelImageProvider contract ---
import base64
import io

from fastapi import FastAPI, Header, HTTPException
from pydantic import BaseModel

app = FastAPI(title="HDV Companion Portrait Server")


class GenerateRequest(BaseModel):
    prompt: str
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
    return {"ok": True, "model": MODEL_ID, "device": DEVICE}


@app.post("/generate", response_model=GenerateResponse)
def generate(req: GenerateRequest, authorization: str | None = Header(default=None)):
    # Same shape as HDV's own gateway auth: "Bearer <token>". This is the only thing standing
    # between a public ngrok URL and anyone on the internet -- keep PORTRAIT_SERVER_TOKEN secret.
    expected = f"Bearer {PORTRAIT_SERVER_TOKEN}"
    if authorization != expected:
        raise HTTPException(status_code=401, detail="unauthorized")

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

    return GenerateResponse(image_base64=image_b64, mime_type="image/png", model=MODEL_ID)


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
