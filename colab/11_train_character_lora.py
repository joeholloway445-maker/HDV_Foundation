# ---
# Big 5 Matrix -- Colab: Train a Per-Character Portrait LoRA (v0.1.0)
# ML LAB ONLY: GPU model training. Simulation/compute only.
# RESTRICTION: no webcam, no microphone, no physical-world I/O.
#
# WHAT THIS IS
# ------------
# Trains a small DreamBooth LoRA (a few MB of extra weights layered on top of the base SDXL
# checkpoint) on a handful of images of ONE character, so that character generates with a
# CONSISTENT likeness across every future portrait request -- instead of the generic per-style
# checkpoint producing a different-looking face every time. This is what
# colab/07_portrait_server.py's PERSONA_LORA_ROUTES / providers/image_types.ts's
# GenerateImageOptions.personaId exist to consume.
#
# Uses Hugging Face diffusers' own official DreamBooth-LoRA-for-SDXL training script
# (train_dreambooth_lora_sdxl.py, Apache-2.0, pinned to a specific diffusers release tag below
# so this notebook doesn't silently break when diffusers changes the script upstream).
#
# WHERE THE TRAINING IMAGES COME FROM
# --------------------------------------
# Anything works, including images/videos you already made with another tool (e.g. Grok) --
# DreamBooth doesn't care about the source, only that the images consistently show the SAME
# character. For a video, pull a handful of distinct frames (different angles/expressions) as
# stills first; only images are used for training here. Aim for 15-30 images: varied angles,
# expressions, lighting, framing (close-up + half-body + full-body) all showing the same face/
# character. Fewer than ~10 will still run but the result is much less reliable.
#
# HOW MUCH GPU THIS NEEDS
# ---------------------------
# A free Colab T4 is enough (LoRA training uses far less VRAM than full fine-tuning) -- this is
# NOT the same as needing Colab Pro. Training 15-30 images typically takes 15-40 minutes on a T4.
#
# COLAB SETUP (do this first in Colab)
# -------------------------------------
#   Runtime -> Change runtime type -> Hardware accelerator: GPU.
#   Cell 2 below installs everything else (diffusers, peft, accelerate, bitsandbytes) and
#   downloads the pinned training script -- nothing else to do by hand first.
#
# GETTING YOUR IMAGES IN
# --------------------------
#   Cell 3 gives you two options: upload directly through the browser (simplest, fine for a
#   couple dozen images), or mount Google Drive if you'd rather organize a folder there first.
#   Either way they need to end up in TRAINING_IMAGES_DIR (Cell 1).
#
# WIRING THE RESULT INTO THE PORTRAIT SERVER
# -----------------------------------------------
#   Cell 7 uploads the trained LoRA to a private Hugging Face model repo (needs a (free) HF
#   account + an access token with write permission -- huggingface.co/settings/tokens) and
#   prints the exact line to add wherever colab/07_portrait_server.py reads its environment
#   from, e.g.:
#     PORTRAIT_PERSONA_LORA_JORDYN=your-username/fucklike-jordyn-lora
#   Restart 07_portrait_server.py's Cell 2 (or the whole notebook) after adding it so the new
#   route is picked up.
# ---

# %% [markdown]
# # 11 - Train a Per-Character Portrait LoRA
# 1. Config -- which character, which base style, hyperparameters.
# 2. Install deps + download the pinned diffusers DreamBooth-LoRA-SDXL training script.
# 3. Get your training images into TRAINING_IMAGES_DIR (upload or Google Drive).
# 4. Sanity-check the image set (count + a quick contact-sheet preview).
# 5. Run training (accelerate launch -- this is the slow cell).
# 6. Quick test generation with the freshly trained LoRA, to eyeball the result before shipping.
# 7. Upload the LoRA to a private Hugging Face model repo and print the env var to wire it in.

# %%
# --- Cell 1: config -- EDIT these for the character you're training ---
import os

# The persona id this LoRA is FOR -- must match PortraitPersona.personaId / FuckLike/web's
# PRESETS ids (e.g. "jordyn") for colab/07_portrait_server.py's PERSONA_LORA_ROUTES to pick it
# up automatically by the env var name printed in Cell 7. Lowercase, matches the site's id.
CHARACTER_ID = os.environ.get("LORA_CHARACTER_ID", "jordyn")

# Which base checkpoint to train on top of -- MUST match this character's style in
# colab/07_portrait_server.py's MODEL_ROUTES (07 currently ships realistic/anime).
BASE_STYLE = os.environ.get("LORA_BASE_STYLE", "realistic")
BASE_MODEL_ROUTES = {
    "realistic": os.environ.get("PORTRAIT_MODEL_REALISTIC", "SG161222/RealVisXL_V4.0"),
    "anime": os.environ.get("PORTRAIT_MODEL_ANIME", "Bakanayatsu/Pony-Diffusion-V6-XL-for-Anime"),
}
BASE_MODEL = BASE_MODEL_ROUTES[BASE_STYLE]

# A rare, made-up token DreamBooth associates with this specific character -- deliberately NOT
# a real word (avoids the model conflating "jordyn" the common name with THIS character). The
# training prompt and every future portrait prompt for this character should include it.
INSTANCE_TOKEN = os.environ.get("LORA_INSTANCE_TOKEN", f"sks{CHARACTER_ID}")
INSTANCE_PROMPT = f"a photo of {INSTANCE_TOKEN} person"

TRAINING_IMAGES_DIR = f"/content/training_images/{CHARACTER_ID}"
OUTPUT_DIR = f"/content/loras/{CHARACTER_ID}"
os.makedirs(TRAINING_IMAGES_DIR, exist_ok=True)
os.makedirs(OUTPUT_DIR, exist_ok=True)

# Training hyperparameters -- sane DreamBooth-LoRA-SDXL defaults for a small (15-30 image)
# single-character dataset on a single GPU. RANK trades off fidelity vs. file size/overfitting
# risk; 32 is a solid middle ground. MAX_TRAIN_STEPS is recomputed from your actual image count
# in Cell 4 (roughly 100 steps per image, capped), this is just the fallback before that runs.
RESOLUTION = 1024
TRAIN_BATCH_SIZE = 1
GRADIENT_ACCUMULATION_STEPS = 4
LEARNING_RATE = 1e-4
LORA_RANK = 32
MAX_TRAIN_STEPS = 1500
SEED = 42

print(f"Character:    {CHARACTER_ID}  (token: {INSTANCE_TOKEN})")
print(f"Base model:   {BASE_MODEL}  ({BASE_STYLE})")
print(f"Images dir:   {TRAINING_IMAGES_DIR}")
print(f"Output dir:   {OUTPUT_DIR}")

# %%
# --- Cell 2: install deps + download the pinned diffusers DreamBooth-LoRA-SDXL script ---
# Pinned to a specific diffusers release tag (not "main") so this notebook keeps working even
# if the upstream script's CLI args change later -- re-check https://github.com/huggingface/
# diffusers/releases periodically and bump DIFFUSERS_TAG deliberately if you want the latest.
DIFFUSERS_TAG = os.environ.get("DIFFUSERS_TAG", "v0.39.0")

os.system("pip install -q -U diffusers transformers accelerate peft bitsandbytes safetensors datasets")

TRAIN_SCRIPT_PATH = "/content/train_dreambooth_lora_sdxl.py"
TRAIN_SCRIPT_URL = (
    f"https://raw.githubusercontent.com/huggingface/diffusers/{DIFFUSERS_TAG}"
    "/examples/dreambooth/train_dreambooth_lora_sdxl.py"
)
if not os.path.exists(TRAIN_SCRIPT_PATH):
    os.system(f"curl -fsSL {TRAIN_SCRIPT_URL} -o {TRAIN_SCRIPT_PATH}")
assert os.path.exists(TRAIN_SCRIPT_PATH) and os.path.getsize(TRAIN_SCRIPT_PATH) > 1000, (
    f"Failed to download the training script from {TRAIN_SCRIPT_URL} -- check DIFFUSERS_TAG "
    "still exists at https://github.com/huggingface/diffusers/releases"
)
print(f"Training script ready: {TRAIN_SCRIPT_PATH} (diffusers {DIFFUSERS_TAG})")

# %%
# --- Cell 3: get your training images in -- pick ONE of the two options below ---

# Option A: upload directly through the browser (simplest for a couple dozen images).
try:
    from google.colab import files

    print(f"Pick the image files for {CHARACTER_ID} now (multi-select in the file dialog)...")
    uploaded = files.upload()
    for filename, content in uploaded.items():
        with open(os.path.join(TRAINING_IMAGES_DIR, filename), "wb") as f:
            f.write(content)
    print(f"Saved {len(uploaded)} file(s) to {TRAINING_IMAGES_DIR}")
except ImportError:
    print("Not running in Colab -- copy your images into TRAINING_IMAGES_DIR yourself, then continue.")

# Option B (alternative to the upload dialog above): mount Google Drive instead, if you'd
# rather organize a folder there first, then copy/symlink it into TRAINING_IMAGES_DIR. Uncomment
# to use it (skip Option A's upload() call above if so):
#
# from google.colab import drive
# drive.mount('/content/drive')
# DRIVE_SOURCE_DIR = f"/content/drive/MyDrive/fucklike_training/{CHARACTER_ID}"
# os.system(f"cp {DRIVE_SOURCE_DIR}/*.* {TRAINING_IMAGES_DIR}/")

# %%
# --- Cell 4: sanity check -- image count + a quick contact-sheet preview ---
IMAGE_EXTS = (".png", ".jpg", ".jpeg", ".webp")
image_files = sorted(
    f for f in os.listdir(TRAINING_IMAGES_DIR) if f.lower().endswith(IMAGE_EXTS)
)
num_images = len(image_files)
print(f"{num_images} training image(s) found in {TRAINING_IMAGES_DIR}")
if num_images == 0:
    raise RuntimeError("No training images found -- go back to Cell 3.")
if num_images < 10:
    print(
        f"WARNING: only {num_images} images -- DreamBooth LoRA quality drops off noticeably "
        "below ~10-15. It'll still run, but expect a weaker/less consistent likeness."
    )

# Recompute MAX_TRAIN_STEPS from the real image count (~100 steps/image, capped 800-2500) --
# more images need proportionally fewer steps per image to avoid overfitting any single one.
MAX_TRAIN_STEPS = max(800, min(2500, num_images * 100))
print(f"MAX_TRAIN_STEPS set to {MAX_TRAIN_STEPS} based on {num_images} images.")

try:
    import matplotlib.pyplot as plt
    from PIL import Image

    preview = image_files[:12]
    cols = 4
    rows = (len(preview) + cols - 1) // cols
    fig, axes = plt.subplots(rows, cols, figsize=(12, 3 * rows))
    axes = axes.flatten() if rows > 1 else [axes] if cols == 1 else axes
    for i, ax in enumerate(axes):
        ax.axis("off")
        if i < len(preview):
            img = Image.open(os.path.join(TRAINING_IMAGES_DIR, preview[i]))
            ax.imshow(img)
            ax.set_title(preview[i], fontsize=8)
    plt.tight_layout()
    plt.show()
except Exception as e:
    print(f"(contact-sheet preview skipped: {e})")

# %%
# --- Cell 5: run training -- this is the slow cell (15-40 min on a T4 for ~15-30 images) ---
import subprocess

cmd = [
    "accelerate", "launch", TRAIN_SCRIPT_PATH,
    f"--pretrained_model_name_or_path={BASE_MODEL}",
    f"--instance_data_dir={TRAINING_IMAGES_DIR}",
    f"--instance_prompt={INSTANCE_PROMPT}",
    f"--output_dir={OUTPUT_DIR}",
    f"--resolution={RESOLUTION}",
    f"--train_batch_size={TRAIN_BATCH_SIZE}",
    f"--gradient_accumulation_steps={GRADIENT_ACCUMULATION_STEPS}",
    "--gradient_checkpointing",
    f"--learning_rate={LEARNING_RATE}",
    "--lr_scheduler=constant",
    "--lr_warmup_steps=0",
    f"--max_train_steps={MAX_TRAIN_STEPS}",
    f"--rank={LORA_RANK}",
    "--mixed_precision=fp16",
    f"--seed={SEED}",
    "--use_8bit_adam",
]
print("Running:", " ".join(cmd))
result = subprocess.run(cmd)
if result.returncode != 0:
    raise RuntimeError(f"Training failed (exit {result.returncode}) -- see the log above.")
print(f"Training complete. LoRA weights written to {OUTPUT_DIR}")

# %%
# --- Cell 6: quick test generation with the freshly trained LoRA -- eyeball it before shipping ---
import torch
from diffusers import StableDiffusionXLPipeline

_dtype = torch.float16 if torch.cuda.is_available() else torch.float32
_device = "cuda" if torch.cuda.is_available() else "cpu"

test_pipe = StableDiffusionXLPipeline.from_pretrained(BASE_MODEL, torch_dtype=_dtype).to(_device)
test_pipe.load_lora_weights(OUTPUT_DIR)

test_prompt = (
    f"Character portrait of an adult fictional character, {INSTANCE_TOKEN} person, "
    "smiling warmly at the viewer. The subject is clearly an adult."
)
test_image = test_pipe(prompt=test_prompt, num_inference_steps=30).images[0]
test_image_path = os.path.join(OUTPUT_DIR, "_test_generation.png")
test_image.save(test_image_path)
print(f"Test image saved: {test_image_path}")
try:
    import matplotlib.pyplot as plt

    plt.imshow(test_image)
    plt.axis("off")
    plt.title(f"{CHARACTER_ID} -- test generation")
    plt.show()
except Exception:
    pass

del test_pipe
torch.cuda.empty_cache() if _device == "cuda" else None

# %%
# --- Cell 7: upload the LoRA to a private Hugging Face model repo, print the env var to wire in ---
# Needs an HF account + an access token with WRITE permission: huggingface.co/settings/tokens
from huggingface_hub import HfApi, create_repo

HF_TOKEN = os.environ.get("HF_TOKEN", "")
HF_USERNAME = os.environ.get("HF_USERNAME", "")

if not HF_TOKEN or not HF_USERNAME:
    print("Set HF_TOKEN and HF_USERNAME (e.g. via Colab's Secrets panel, the key icon on the")
    print("left sidebar) before running this cell, then re-run it.")
else:
    repo_id = f"{HF_USERNAME}/fucklike-{CHARACTER_ID}-lora"
    create_repo(repo_id, token=HF_TOKEN, private=True, exist_ok=True)
    api = HfApi()
    api.upload_folder(
        folder_path=OUTPUT_DIR,
        repo_id=repo_id,
        token=HF_TOKEN,
        allow_patterns=["*.safetensors", "*.json", "*.png"],
    )
    env_var_name = f"PORTRAIT_PERSONA_LORA_{CHARACTER_ID.upper()}"
    print("=" * 72)
    print(f"Uploaded: https://huggingface.co/{repo_id}")
    print("Add this to wherever colab/07_portrait_server.py reads its environment from:")
    print(f"  {env_var_name}={repo_id}")
    print(f"Every future portrait request with persona.personaId={CHARACTER_ID!r} will now use")
    print("this trained LoRA instead of the generic per-style checkpoint.")
    print("=" * 72)
