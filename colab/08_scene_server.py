# ---
# Big 5 Matrix -- Colab: Companion Scene/Loop Server (v0.1.0)
# ML LAB ONLY: GPU video generation. Simulation/compute only.
# RESTRICTION: no webcam, no microphone, no physical-world I/O.
#
# Notebook-style (`# %%` cell markers), same shape as colab/07_portrait_server.py. The server
# cell blocks -- run cells in order and leave the last one running.
#
# WHAT THIS IS
# ------------
# A FastAPI wrapper around this account's LingBot-World fork
# (github.com/joeholloway445-maker/lingbot-world -- an image+text-conditioned world-model video
# diffusion model, Apache 2.0 code AND weights, both verified). It speaks the exact contract
# HDV's ColabTunnelVideoProvider expects (providers/colab_tunnel_video.ts):
#
#   POST /generate
#   body: { "prompt": str, "seed_image_base64": str, "action_string"?: str,
#           "frame_num"?: int, "seed"?: int }
#   200 -> { "video_base64": str, "mime_type": "video/mp4", "model": str }
#
# Same pattern as Ollama for text and colab/07_portrait_server.py for stills: a plain HTTP
# endpoint the gateway calls. It never touches APEX/KNOLL/routing, and never knows or cares
# what persona/product is calling it.
#
# HONESTY NOTE (read before relying on this in production)
# ------------------------------------------------------------
# LingBot-World's own reference scripts (generate.py / generate_fast.py) are written for
# 8-GPU clusters (torchrun --nproc_per_node=8, FSDP sharding). This wrapper shells out to
# generate.py with SINGLE-GPU flags instead (no torchrun distribution, --offload_model,
# --t5_cpu, --convert_model_dtype -- the same memory-saving flags their own setup_kvm4.sh
# uses for CPU-only inference). This is a best-effort adaptation based on reading their
# source, not something battle-tested end-to-end here (no GPU was available while writing
# this). Expect to tune SAMPLE_STEPS / FRAME_NUM / the exact flags on your first real run --
# the wire CONTRACT above is what matters to the gateway; the invocation details below are
# free to change without touching providers/colab_tunnel_video.ts at all.
#
# COLAB SETUP (do this first in Colab)
# -------------------------------------
#   Runtime -> Change runtime type -> Hardware accelerator: GPU (a Colab Pro GPU is strongly
#   recommended -- the model is ~18.5B params; even 4-bit quantized, a free-tier T4 (16GB) is
#   likely too tight once you add the T5 text encoder and multi-frame activation memory. See
#   the GPU sizing discussion this scaffold came out of -- short clips MIGHT fit a T4, longer
#   ones almost certainly won't.)
#
# WIRING IT INTO THE GATEWAY (on the VPS, in .env)
# ---------------------------------------------------
#   HDV_VIDEO_PROVIDER=colab_tunnel
#   HDV_VIDEO_BASE_URL=<the https://....ngrok-free.app URL this notebook prints>
#   HDV_VIDEO_API_KEY=<same value as SCENE_SERVER_TOKEN below>
#   Then restart the gateway. No frontend changes needed beyond what's already wired --
#   FuckLike/web sends the companion's existing portrait as the seed image.
#
# CAVEAT: same as the portrait server -- free/non-persistent Colab sessions die on
# disconnect/recycle, taking the tunnel URL with them. Treat this as "generate once per
# companion, cache the result" (client already caches portraits this way), not live
# per-message generation -- video generation takes minutes, not seconds, regardless of GPU.
# ---

# %% [markdown]
# # 08 - Companion Scene/Loop Server
# 1. Clone the LingBot-World fork + install deps.
# 2. Download the 4-bit quantized weights (recommended for a single GPU).
# 3. Define the `/generate` endpoint -- wraps `generate.py` via subprocess.
# 4. Open a tunnel and print the URL for `HDV_VIDEO_BASE_URL`.
# 5. Run the server (blocks -- leave this cell running while the tunnel is in use).

# %%
# --- Cell 1: clone the repo + install deps ---
import os

LINGBOT_REPO = os.environ.get("LINGBOT_REPO", "https://github.com/joeholloway445-maker/lingbot-world.git")
LINGBOT_DIR = os.environ.get("LINGBOT_DIR", "/content/lingbot-world")

if not os.path.isdir(LINGBOT_DIR):
    os.system(f"git clone {LINGBOT_REPO} {LINGBOT_DIR}")

os.chdir(LINGBOT_DIR)
os.system("pip install -q -r requirements.txt")
os.system('pip install -q "huggingface_hub[cli]" fastapi uvicorn pyngrok')

print(f"LingBot-World checked out at {LINGBOT_DIR}")

# %%
# --- Cell 2: config + download weights -- EDIT if you've picked a different checkpoint ---
# Default: the community 4-bit quantized weights (Apache 2.0, verified), the realistic choice
# for a single Colab GPU. Swap for the full-precision robbyant/lingbot-world-base-cam (also
# Apache 2.0) if you have the VRAM for it -- nothing else in this file needs to change.
WEIGHTS_REPO = os.environ.get("LINGBOT_WEIGHTS_REPO", "cahlen/lingbot-world-base-cam-nf4")
WEIGHTS_DIR = os.environ.get("LINGBOT_WEIGHTS_DIR", f"{LINGBOT_DIR}/lingbot-world-base-cam")
SCENE_SERVER_TOKEN = os.environ.get("SCENE_SERVER_TOKEN", "change-me-before-going-live")
DEFAULT_SIZE = "480*832"
DEFAULT_FRAME_NUM = 81  # ~5s at 16fps; raise cautiously -- this is the main VRAM/time lever.
DEFAULT_SAMPLE_STEPS = 20
# Bundled camera intrinsics reused for every --action_string call (intrinsics = lens/FOV
# params, not the trajectory -- one file is fine to reuse across generations at a given size).
ACTION_INTRINSICS_DIR = f"{LINGBOT_DIR}/examples/05"

if not os.path.isdir(WEIGHTS_DIR):
    os.system(f"huggingface-cli download {WEIGHTS_REPO} --local-dir {WEIGHTS_DIR}")

print(f"Weights: {WEIGHTS_REPO} -> {WEIGHTS_DIR}")

# %%
# --- Cell 3: the /generate endpoint -- wraps generate.py via subprocess ---
import base64
import glob
import subprocess
import tempfile
import time

from fastapi import FastAPI, Header, HTTPException
from pydantic import BaseModel

app = FastAPI(title="HDV Companion Scene Server")


class GenerateRequest(BaseModel):
    prompt: str
    seed_image_base64: str
    action_string: str | None = None
    frame_num: int | None = None
    seed: int | None = None


class GenerateResponse(BaseModel):
    video_base64: str
    mime_type: str = "video/mp4"
    model: str = "lingbot-world-base-cam-nf4"


@app.get("/health")
def health():
    return {"ok": True, "weights": WEIGHTS_REPO}


@app.post("/generate", response_model=GenerateResponse)
def generate(req: GenerateRequest, authorization: str | None = Header(default=None)):
    expected = f"Bearer {SCENE_SERVER_TOKEN}"
    if authorization != expected:
        raise HTTPException(status_code=401, detail="unauthorized")

    workdir = tempfile.mkdtemp(prefix="hdv-scene-")
    image_path = os.path.join(workdir, "seed.png")
    with open(image_path, "wb") as f:
        f.write(base64.b64decode(req.seed_image_base64))

    save_file = os.path.join(workdir, "output.mp4")
    frame_num = req.frame_num or DEFAULT_FRAME_NUM

    cmd = [
        "python", "generate.py",
        "--task", "i2v-A14B",
        "--size", DEFAULT_SIZE,
        "--ckpt_dir", WEIGHTS_DIR,
        "--image", image_path,
        "--prompt", req.prompt,
        "--frame_num", str(frame_num),
        "--sample_steps", str(DEFAULT_SAMPLE_STEPS),
        "--save_file", save_file,
        "--offload_model", "True",
        "--t5_cpu",
        "--convert_model_dtype",
    ]
    if req.seed is not None:
        cmd += ["--base_seed", str(req.seed)]
    if req.action_string:
        cmd += ["--action_string", req.action_string, "--action_path", ACTION_INTRINSICS_DIR, "--allow_act2cam"]

    started = time.time()
    result = subprocess.run(cmd, cwd=LINGBOT_DIR, capture_output=True, text=True)
    elapsed = time.time() - started

    if result.returncode != 0 or not os.path.exists(save_file):
        # Truncate stderr -- generate.py's logs can be long; this is enough to diagnose.
        raise HTTPException(
            status_code=502,
            detail=f"generate.py failed after {elapsed:.0f}s (exit {result.returncode}): {result.stderr[-2000:]}",
        )

    with open(save_file, "rb") as f:
        video_b64 = base64.b64encode(f.read()).decode("ascii")

    return GenerateResponse(video_base64=video_b64, mime_type="video/mp4", model=WEIGHTS_REPO)


print("FastAPI app defined: GET /health, POST /generate")

# %%
# --- Cell 4: open a tunnel and print the URL for HDV_VIDEO_BASE_URL ---
from pyngrok import ngrok

NGROK_AUTHTOKEN = os.environ.get("NGROK_AUTHTOKEN", "")
if NGROK_AUTHTOKEN:
    ngrok.set_auth_token(NGROK_AUTHTOKEN)

PORT = 8001  # different port than 07_portrait_server.py so both can run side by side if needed
public_url = ngrok.connect(PORT, "http")
print("=" * 72)
print(f"Tunnel is live: {public_url}")
print("On the VPS, in HDV_Foundation's .env:")
print(f"  HDV_VIDEO_PROVIDER=colab_tunnel")
print(f"  HDV_VIDEO_BASE_URL={public_url}")
print(f"  HDV_VIDEO_API_KEY={SCENE_SERVER_TOKEN}")
print("Then restart the gateway (systemctl restart hdv-gateway, or docker compose up -d gateway).")
print("=" * 72)

# %%
# --- Cell 5: run the server (BLOCKS -- leave this cell running) ---
import uvicorn

uvicorn.run(app, host="0.0.0.0", port=PORT)
