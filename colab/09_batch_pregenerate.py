# ---
# Big 5 Matrix -- Colab: Batch Pre-Generate Persona x Prompt Matrix (v0.1.0)
# ML LAB ONLY: GPU image/video generation. Simulation/compute only.
# RESTRICTION: no webcam, no microphone, no physical-world I/O.
#
# WHAT THIS IS
# ------------
# The free-Colab-tier strategy for portraits/scenes: instead of a live tunnel serving
# on-demand requests (which needs an always-running, always-reachable session -- not something
# the free tier gives you), this notebook runs ONCE as a batch job over a fixed grid:
#
#   PERSONAS (ordered by presumed popularity) x PROMPT_LIBRARY (common requests)
#
# ...generating one portrait (and, for the "default" entry, one animated scene/loop) per cell
# of that matrix, in persona-major order -- i.e. it fully completes persona #1 across every
# prompt before moving to persona #2, exactly matching "top persona first, then the rest in
# popularity order" -- and writes everything to disk with a manifest.json mapping
# (personaId, promptSlug) -> output file paths.
#
# It's RESUMABLE: every cell checks whether its output file already exists before generating,
# so if a free Colab session disconnects partway through (it will, eventually), just reopen
# this notebook and run it again -- completed cells are skipped, it picks up where it left off.
#
# WHAT THIS IS NOT
# -----------------
# Not a live server (that's 07_portrait_server.py / 08_scene_server.py -- keep those for
# on-demand generation of CUSTOM user-created companions once you're on Colab Pro / a
# dedicated GPU box). This notebook's output is a static asset library meant to be uploaded
# once to the VPS and served by nginx directly -- see "GETTING THE OUTPUT ONTO THE VPS" below.
# The 8 preset companions in FuckLike/web's gallery are exactly what PERSONAS mirrors, so once
# uploaded, the site can show real pre-generated art for every preset with ZERO live GPU
# involvement -- no tunnel needs to be up for a visitor to see them.
#
# EDITING THE PROMPT LIBRARY
# ----------------------------
# PROMPT_LIBRARY below is a deliberately small, safe, generic STARTER grid (a default portrait
# variant or two, one scene). It exists so this notebook produces something real out of the
# box. Expand/edit it to whatever specific requests you actually want covered -- that's a
# content decision for you to make, same as picking the checkpoint/LoRA was.
#
# COLAB SETUP
# -------------
#   Runtime -> Change runtime type -> Hardware accelerator: GPU.
#   !pip install -q diffusers transformers accelerate safetensors
#   Clone LingBot-World the same way 08_scene_server.py does (Cell 2 below handles it).
#
# GETTING THE OUTPUT ONTO THE VPS
# -----------------------------------
#   Cell 6 zips OUTPUT_DIR and calls files.download() -- it lands in your browser's normal
#   downloads. From there, the simplest path (no terminal needed): Hostinger hPanel -> your
#   VPS -> File Manager -> navigate to /var/www/fucklike.ai/ -> Upload -> pick the zip -> once
#   uploaded, right-click it -> Extract, into an "assets" folder there. Then in the *same* File
#   Manager, copy that assets/ folder into /var/www/fucklike.me/ too (both domains serve
#   identical companion content). If you'd rather use the browser terminal instead of File
#   Manager's extract button, `unzip pregenerated_assets.zip -d assets` works the same way
#   once the zip is uploaded.
# ---

# %% [markdown]
# # 09 - Batch Pre-Generate Persona x Prompt Matrix
# 1. Define PERSONAS (mirrors FuckLike/web's 8 gallery presets, ordered by popularity) and
#    PROMPT_LIBRARY (edit this to your actual desired content).
# 2. Load the portrait pipelines (same routing as 07_portrait_server.py) + clone LingBot-World.
# 3. Generation helpers (portrait via diffusers, scene via LingBot's generate.py subprocess).
# 4. The matrix loop itself -- resumable, persona-major order.
# 5. Write manifest.json.
# 6. Zip + download.

# %%
# --- Cell 1: PERSONAS + PROMPT_LIBRARY -- EDIT THESE to taste ---
import os

# Mirrors FuckLike/web/app.js's PRESETS array exactly (same ids/name/style/personality/
# appearance/age), reordered so the two marked `live: true` in the product (Jordyn, Nova --
# the ones already featured) go first, then the rest in their existing array order. This IS
# "presumed popularity" -- the best signal actually available today. Re-order freely once you
# have real usage data. `appearance`/`backstory` are optional and only set where the product
# calls for a specific look/character (e.g. Jordyn); omitted entries fall back to
# style/personality alone, same as the TS side (companion/portrait_types.ts / scene_types.ts).
PERSONAS = [
    {
        "id": "jordyn", "name": "Jordyn", "style": "realistic", "personality": "bratty",
        "appearance": "gorgeous, thick, light brunette hair",
        "backstory": "A devoted girlfriend/wife type who loves hard -- but she's got a mean, teasing streak and isn't afraid to talk back.",
        "age": 24,
    },
    {"id": "nova", "name": "Nova", "style": "anime", "personality": "mysterious", "age": 24},
    {"id": "isabella", "name": "Isabella", "style": "realistic", "personality": "romantic", "age": 25},
    {"id": "aria", "name": "Aria", "style": "anime", "personality": "bratty", "age": 21},
    {"id": "sofia", "name": "Sofia", "style": "realistic", "personality": "dominant", "age": 27},
    {"id": "mila", "name": "Mila", "style": "realistic", "personality": "romantic", "age": 22},
    {"id": "elena", "name": "Elena", "style": "realistic", "personality": "soft", "age": 29},
    {"id": "kai", "name": "Kai", "style": "realistic", "personality": "playful", "age": 26},
]

# Each entry = one "common request". `generate_scene` gates the (much slower) LingBot step --
# keep it on only for the requests that most need to "feel alive"; add more portrait-only
# variants freely, they're cheap. `portrait_suffix` is appended to the same persona prompt
# companion/portrait_handlers.ts already builds server-side (name/style/personality/backstory);
# `scene_action` feeds the LingBot scene prompt the same way companion/scene_handlers.ts does.
PROMPT_LIBRARY = [
    {
        "slug": "default",
        "portrait_suffix": "",
        "generate_scene": True,
        "scene_action": "Gentle, natural idle motion -- subtle breathing, occasional blinking, calm expression.",
        "action_string": None,  # free-form motion, no explicit camera path
    },
    {
        "slug": "smiling",
        "portrait_suffix": "smiling warmly at the viewer",
        "generate_scene": False,
    },
    {
        "slug": "closeup",
        "portrait_suffix": "close-up shot, soft studio lighting",
        "generate_scene": False,
    },
]

OUTPUT_DIR = os.environ.get("BATCH_OUTPUT_DIR", "/content/pregenerated_assets")
os.makedirs(OUTPUT_DIR, exist_ok=True)

total_portraits = len(PERSONAS) * len(PROMPT_LIBRARY)
total_scenes = len(PERSONAS) * sum(1 for p in PROMPT_LIBRARY if p.get("generate_scene"))
print(f"{len(PERSONAS)} personas x {len(PROMPT_LIBRARY)} prompts = {total_portraits} portraits, {total_scenes} scenes")
print(f"Output: {OUTPUT_DIR}")

# %%
# --- Cell 2: load portrait pipelines (same MODEL_ROUTES as 07_portrait_server.py) + clone LingBot ---
import torch
from diffusers import StableDiffusionXLPipeline

DEVICE = "cuda" if torch.cuda.is_available() else "cpu"
if DEVICE == "cpu":
    print("WARNING: no GPU detected -- Runtime -> Change runtime type -> GPU.")

MODEL_ROUTES = {
    "realistic": os.environ.get("PORTRAIT_MODEL_REALISTIC", "SG161222/RealVisXL_V4.0"),
    "anime": os.environ.get("PORTRAIT_MODEL_ANIME", "Bakanayatsu/Pony-Diffusion-V6-XL-for-Anime"),
}
LORA_ROUTES = {
    "realistic": os.environ.get("PORTRAIT_LORA_REALISTIC", ""),
    "anime": os.environ.get("PORTRAIT_LORA_ANIME", "LyliaEngine/Pony_Diffusion_V6_XL"),
}

_pipelines: dict[str, StableDiffusionXLPipeline] = {}


def get_portrait_pipeline(style: str) -> StableDiffusionXLPipeline:
    if style not in _pipelines:
        model_id = MODEL_ROUTES[style]
        dtype = torch.float16 if DEVICE == "cuda" else torch.float32
        print(f"Loading {style} portrait model: {model_id}")
        if model_id.endswith(".safetensors"):
            pipe = StableDiffusionXLPipeline.from_single_file(model_id, torch_dtype=dtype)
        else:
            pipe = StableDiffusionXLPipeline.from_pretrained(model_id, torch_dtype=dtype)
        pipe = pipe.to(DEVICE)
        if LORA_ROUTES.get(style):
            pipe.load_lora_weights(LORA_ROUTES[style])
        _pipelines[style] = pipe
    return _pipelines[style]


LINGBOT_REPO = os.environ.get("LINGBOT_REPO", "https://github.com/joeholloway445-maker/lingbot-world.git")
LINGBOT_DIR = os.environ.get("LINGBOT_DIR", "/content/lingbot-world")
if not os.path.isdir(LINGBOT_DIR):
    os.system(f"git clone {LINGBOT_REPO} {LINGBOT_DIR}")
    os.system(f"pip install -q -r {LINGBOT_DIR}/requirements.txt")

LINGBOT_WEIGHTS_REPO = os.environ.get("LINGBOT_WEIGHTS_REPO", "cahlen/lingbot-world-base-cam-nf4")
LINGBOT_WEIGHTS_DIR = os.environ.get("LINGBOT_WEIGHTS_DIR", f"{LINGBOT_DIR}/lingbot-world-base-cam")
if not os.path.isdir(LINGBOT_WEIGHTS_DIR):
    os.system('pip install -q "huggingface_hub[cli]"')
    os.system(f"huggingface-cli download {LINGBOT_WEIGHTS_REPO} --local-dir {LINGBOT_WEIGHTS_DIR}")

print("Portrait + LingBot setup ready.")

# %%
# --- Cell 3: generation helpers ---
import subprocess
import time


def build_portrait_prompt(persona: dict, suffix: str) -> str:
    lines = [
        f"Character portrait of an adult (age {persona['age']}) fictional character named {persona['name']}.",
        f"Visual style: {persona['style']}.",
        f"Personality to convey through expression and mood: {persona['personality']}.",
    ]
    if persona.get("appearance"):
        lines.append(f"Physical appearance: {persona['appearance']}.")
    if persona.get("backstory"):
        lines.append(f"Character background: {persona['backstory']}")
    if suffix:
        lines.append(suffix)
    lines.append("The subject is clearly an adult. Do not depict a minor or anyone who appears underage.")
    return " ".join(lines)


def generate_portrait(persona: dict, prompt_entry: dict, out_path: str) -> None:
    if os.path.exists(out_path):
        return  # resumable: already done
    pipe = get_portrait_pipeline(persona["style"])
    prompt = build_portrait_prompt(persona, prompt_entry.get("portrait_suffix", ""))
    result = pipe(prompt=prompt, width=1024, height=1024, num_inference_steps=30)
    result.images[0].save(out_path)
    print(f"  portrait -> {out_path}")


def build_scene_prompt(persona: dict, prompt_entry: dict) -> str:
    lines = [
        f"Short looping scene featuring {persona['name']}, an adult (age {persona['age']}) fictional character.",
        f"Personality to convey through subtle motion and mood: {persona['personality']}.",
    ]
    if persona.get("appearance"):
        lines.append(f"Physical appearance: {persona['appearance']}.")
    if persona.get("backstory"):
        lines.append(f"Character background: {persona['backstory']}")
    lines.append(prompt_entry.get("scene_action", "Gentle, natural idle motion."))
    lines.append("The subject is clearly an adult throughout.")
    return " ".join(lines)


def generate_scene(persona: dict, prompt_entry: dict, seed_image_path: str, out_path: str) -> None:
    if os.path.exists(out_path):
        return  # resumable: already done
    prompt = build_scene_prompt(persona, prompt_entry)
    cmd = [
        "python", "generate.py",
        "--task", "i2v-A14B",
        "--size", "480*832",
        "--ckpt_dir", LINGBOT_WEIGHTS_DIR,
        "--image", seed_image_path,
        "--prompt", prompt,
        "--frame_num", "81",
        "--sample_steps", "20",
        "--save_file", out_path,
        "--offload_model", "True",
        "--t5_cpu",
        "--convert_model_dtype",
    ]
    action_string = prompt_entry.get("action_string")
    if action_string:
        cmd += ["--action_string", action_string, "--action_path", f"{LINGBOT_DIR}/examples/05", "--allow_act2cam"]

    started = time.time()
    result = subprocess.run(cmd, cwd=LINGBOT_DIR, capture_output=True, text=True)
    elapsed = time.time() - started
    if result.returncode != 0 or not os.path.exists(out_path):
        print(f"  SCENE FAILED after {elapsed:.0f}s (exit {result.returncode}): {result.stderr[-1000:]}")
        return
    print(f"  scene -> {out_path} ({elapsed:.0f}s)")

# %%
# --- Cell 4: the matrix loop -- persona-major order, resumable ---
import json

manifest: dict = {}
manifest_path = os.path.join(OUTPUT_DIR, "manifest.json")
if os.path.exists(manifest_path):
    with open(manifest_path) as f:
        manifest = json.load(f)

for persona in PERSONAS:  # top-popularity persona first, fully completed, then the next
    persona_dir = os.path.join(OUTPUT_DIR, persona["id"])
    os.makedirs(persona_dir, exist_ok=True)
    manifest.setdefault(persona["id"], {})
    print(f"=== {persona['name']} ({persona['id']}) ===")

    for prompt_entry in PROMPT_LIBRARY:
        slug = prompt_entry["slug"]
        portrait_path = os.path.join(persona_dir, f"{slug}.png")
        generate_portrait(persona, prompt_entry, portrait_path)
        entry = manifest[persona["id"]].setdefault(slug, {})
        entry["portrait"] = f"{persona['id']}/{slug}.png"

        if prompt_entry.get("generate_scene"):
            scene_path = os.path.join(persona_dir, f"{slug}.mp4")
            generate_scene(persona, prompt_entry, portrait_path, scene_path)
            if os.path.exists(scene_path):
                entry["scene"] = f"{persona['id']}/{slug}.mp4"

        # Save the manifest after every cell, not just at the end -- if the session dies
        # mid-run, whatever completed so far is still recorded and won't be redone.
        with open(manifest_path, "w") as f:
            json.dump(manifest, f, indent=2)

print("Matrix complete (or resumed to current state). See manifest.json.")

# %%
# --- Cell 5: sanity check -- print what's actually on disk vs. what the manifest claims ---
done_portraits = sum(1 for p in PERSONAS for e in PROMPT_LIBRARY if os.path.exists(os.path.join(OUTPUT_DIR, p["id"], f"{e['slug']}.png")))
done_scenes = sum(
    1 for p in PERSONAS for e in PROMPT_LIBRARY
    if e.get("generate_scene") and os.path.exists(os.path.join(OUTPUT_DIR, p["id"], f"{e['slug']}.mp4"))
)
print(f"Portraits on disk: {done_portraits}/{total_portraits}")
print(f"Scenes on disk:    {done_scenes}/{total_scenes}")
if done_portraits < total_portraits or done_scenes < total_scenes:
    print("Incomplete -- re-run Cell 4 (it skips everything already done) to continue.")

# %%
# --- Cell 6: zip it up and download -- see "GETTING THE OUTPUT ONTO THE VPS" in the header ---
import shutil

zip_path = shutil.make_archive("/content/pregenerated_assets", "zip", OUTPUT_DIR)
print(f"Zipped: {zip_path}")

try:
    from google.colab import files
    files.download(zip_path)
except ImportError:
    print("Not running in Colab -- find the zip at the path above and copy it yourself.")
