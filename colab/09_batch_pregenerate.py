# ---
# Big 5 Matrix -- Batch Pre-Generate Persona x Prompt Matrix (v0.2.0)
# ML LAB ONLY: image/video generation. Simulation/compute only.
# RESTRICTION: no webcam, no microphone, no physical-world I/O.
#
# WHAT THIS IS
# ------------
# The $0 strategy for portraits: instead of a live tunnel serving on-demand requests (which
# needs an always-running, always-reachable GPU -- a recurring cost), this runs ONCE as a batch
# job over a fixed grid:
#
#   PERSONAS (the 16 named gallery presets) x PROMPT_LIBRARY (common requests)
#   ARCHETYPES (style x personality, for CUSTOM companions -- see below) x PROMPT_LIBRARY
#
# ...generating one portrait per cell of each matrix, writing everything to disk with a
# manifest.json mapping id -> output file paths.
#
# It's RESUMABLE: every cell checks whether its output file already exists before generating,
# so if a session dies partway through, just run it again -- completed cells are skipped, it
# picks up where it left off.
#
# TWO WAYS TO RUN IT, BOTH FREE
# ------------------------------
# 1. Directly on your VPS, on CPU. No Colab account, no GPU, no signup, no recurring cost --
#    just the box you already pay for, sitting there anyway. Cell 2 already detects "no GPU"
#    and falls back to CPU automatically; it just runs slower (SDXL on CPU can be several
#    minutes per image, sometimes more, depending on the VPS's vCPU). That's fine: this is a
#    one-time job meant to run unattended, e.g. overnight in `screen`/`tmux`/`nohup`:
#       cd big5-matrix && nohup python3 colab/09_batch_pregenerate.py > pregenerate.log 2>&1 &
#    Point BATCH_OUTPUT_DIR (Cell 1) straight at the web root and there's no zip/download/
#    upload round-trip at all -- the files land exactly where nginx already serves them:
#       BATCH_OUTPUT_DIR=/var/www/fucklike.ai/public_html/assets python3 colab/09_batch_pregenerate.py
#    Then copy (or symlink) that same assets/ folder into /var/www/fucklike.me/public_html/ too
#    (both domains serve identical companion content).
# 2. In free-tier Colab (a real GPU, much faster, but a session that will eventually
#    disconnect -- fine, since this is resumable): Runtime -> Change runtime type -> Hardware
#    accelerator: GPU, then `!pip install -q diffusers transformers accelerate safetensors`.
#    Cell 6 zips OUTPUT_DIR and downloads it to your browser; from there the simplest path (no
#    terminal needed) is Hostinger hPanel -> your VPS -> File Manager -> navigate to
#    /var/www/fucklike.ai/ -> Upload -> pick the zip -> Extract into an "assets" folder. Copy
#    that same folder into /var/www/fucklike.me/ too.
#
# Either way this is a ONE-TIME job, not infrastructure to keep paying for or keep running.
#
# WHAT THIS IS NOT
# -----------------
# Not a live server (that's 07_portrait_server.py / 08_scene_server.py -- optional future
# upgrades once trained LoRAs or a dedicated GPU are actually worth the recurring cost; neither
# is required to ship real art today). This script's output is a static asset library the
# nginx configs (deploy/nginx-fucklike.*.conf) already serve directly from /assets/.
#
# WHY TWO MATRICES (PERSONAS + ARCHETYPES)
# ------------------------------------------
# PERSONAS gives the 16 named gallery presets (FuckLike/web/app.js's PRESETS array) their own
# dedicated art. ARCHETYPES covers every (style, personality) combination the Create form can
# produce, so a brand-new CUSTOM companion also gets a real portrait immediately -- no live
# generation needed -- by matching its style+personality to the nearest template (see
# FuckLike/web/app.js's useArchetypeAssets). This is deliberately the same trick as an
# off-the-shelf template generator (e.g. perchance.org): a curated, pre-made set of art picked
# by tag match instead of unique-per-request generation -- just self-hosted, so there's no
# dependency on a third party's uptime, ToS, or shared free-tier GPU queue.
#
# NO LOCKED-FACE IDENTITY YET -- READ BEFORE ADDING NSFW PROMPT VARIANTS
# --------------------------------------------------------------------------
# None of PERSONAS or ARCHETYPES has a trained LoRA (see colab/11_train_character_lora.py --
# that's what actually locks in a consistent, recognizable face per character). Until a
# specific persona has one, generated art for it should NOT be sold/presented as "this is
# definitely her face" in intimate/NSFW contexts, because a plain style checkpoint has no
# concept of a consistent identity across generations -- every image is a different face. If/
# when you add NSFW entries to PROMPT_LIBRARY, prefer a portrait_suffix that doesn't hinge on a
# specific locked face for any persona/archetype without a trained LoRA -- e.g. "from behind",
# "face turned away, artistic silhouette lighting", "cropped below the neck" -- the same rule
# colab/07_portrait_server.py's PERSONA_LORA_ROUTES exists to eventually lift, persona by
# persona, once each one actually has a trained LoRA.
#
# EDITING THE PROMPT LIBRARY
# ----------------------------
# PROMPT_LIBRARY below is a deliberately small, safe, generic STARTER grid. It exists so this
# script produces something real out of the box. Expand/edit it to whatever specific requests
# you actually want covered -- that's a content decision for you to make, same as picking the
# checkpoint/LoRA was. `generate_scene` is OFF by default everywhere: scene/video generation
# needs the much heavier LingBot-World pipeline (multi-GB weights, very slow on CPU) and isn't
# needed to fix "no portraits" -- flip it back on for specific entries once you're ready to
# spend the time/GPU on animated loops too.
# ---

# %% [markdown]
# # 09 - Batch Pre-Generate Persona x Prompt Matrix
# 1. Define PERSONAS + ARCHETYPES (the art matrix) and PROMPT_LIBRARY (edit this to your
#    actual desired content).
# 2. Load the portrait pipelines (same routing as 07_portrait_server.py) + optionally LingBot.
# 3. Generation helpers (portrait via diffusers, scene via LingBot's generate.py subprocess).
# 4. The matrix loops themselves -- resumable.
# 5. Write manifest.json.
# 6. Zip + download (Colab) or just leave the files on disk (VPS).

# %%
# --- Cell 1: PERSONAS + ARCHETYPES + PROMPT_LIBRARY -- EDIT THESE to taste ---
import os

# Mirrors FuckLike/web/app.js's PRESETS array exactly (same ids/name/style/personality/
# appearance/age/order) -- all 16 gallery presets, not a subset. `appearance`/`backstory` are
# optional and only set where the product calls for a specific look/character (e.g. Jordyn);
# omitted entries fall back to style/personality alone, same as the TS side
# (companion/portrait_types.ts / scene_types.ts).
PERSONAS = [
    {
        "id": "jordyn", "name": "Jordyn", "style": "realistic", "personality": "bratty",
        "appearance": "gorgeous, thick, light brunette hair",
        "backstory": "A devoted girlfriend/wife type who loves hard -- but she's got a mean, teasing streak and isn't afraid to talk back.",
        "age": 24,
    },
    {"id": "isabella", "name": "Isabella", "style": "realistic", "personality": "romantic", "age": 25},
    {"id": "aria", "name": "Aria", "style": "anime", "personality": "bratty", "age": 21},
    {"id": "sofia", "name": "Sofia", "style": "realistic", "personality": "dominant", "age": 27},
    {"id": "mila", "name": "Mila", "style": "realistic", "personality": "romantic", "age": 22},
    {"id": "nova", "name": "Nova", "style": "anime", "personality": "mysterious", "age": 24},
    {"id": "elena", "name": "Elena", "style": "realistic", "personality": "soft", "age": 29},
    {"id": "kai", "name": "Kai", "style": "realistic", "personality": "playful", "age": 26},
    {"id": "harley", "name": "Harley", "style": "realistic", "personality": "bratty", "age": 22},
    {"id": "selene", "name": "Selene", "style": "anime", "personality": "mysterious", "age": 26},
    {"id": "ruby", "name": "Ruby", "style": "realistic", "personality": "dominant", "age": 30},
    {"id": "skye", "name": "Skye", "style": "anime", "personality": "playful", "age": 20},
    {"id": "willow", "name": "Willow", "style": "realistic", "personality": "soft", "age": 23},
    {"id": "jade", "name": "Jade", "style": "anime", "personality": "dominant", "age": 24},
    {"id": "faith", "name": "Faith", "style": "realistic", "personality": "romantic", "age": 28},
    {"id": "nadia", "name": "Nadia", "style": "realistic", "personality": "mysterious", "age": 33},
]

# Every (style, personality) combination the Create form can produce -- gives brand-new CUSTOM
# companions real art immediately via a tag match instead of live generation. See
# FuckLike/web/app.js's useArchetypeAssets, which builds this same "<style>-<personality>" id.
# `age` here is just a generic adult default for the prompt (no specific character), not tied
# to any real persona.
STYLES = ["realistic", "anime"]
PERSONALITIES = ["playful", "romantic", "bratty", "dominant", "soft", "mysterious"]
ARCHETYPES = [
    {"id": f"{style}-{personality}", "name": "", "style": style, "personality": personality, "age": 24}
    for style in STYLES
    for personality in PERSONALITIES
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
        # Off by default -- see the header note on LingBot being a much heavier, separate
        # pipeline. Flip to True for specific entries once you're ready to spend the extra
        # time/GPU on animated loops; portraits alone don't need it.
        "generate_scene": False,
        "scene_action": "Gentle, natural idle motion -- subtle breathing, occasional blinking, calm expression.",
        "action_string": None,  # None -> derived from persona.personality, see build_action_string()
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

NEEDS_SCENES = any(p.get("generate_scene") for p in PROMPT_LIBRARY)
total_portraits = (len(PERSONAS) + len(ARCHETYPES)) * len(PROMPT_LIBRARY)
total_scenes = len(PERSONAS) * sum(1 for p in PROMPT_LIBRARY if p.get("generate_scene")) if NEEDS_SCENES else 0
print(
    f"{len(PERSONAS)} personas + {len(ARCHETYPES)} archetypes x {len(PROMPT_LIBRARY)} prompts "
    f"= {total_portraits} portraits, {total_scenes} scenes"
)
print(f"Output: {OUTPUT_DIR}")

# %%
# --- Cell 2: load portrait pipelines (same MODEL_ROUTES as 07_portrait_server.py); LingBot
# is cloned/downloaded ONLY if PROMPT_LIBRARY actually needs scenes (NEEDS_SCENES, Cell 1) --
# it's a multi-GB, GPU-hungry separate pipeline that portraits alone don't touch. ---
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
LINGBOT_WEIGHTS_REPO = os.environ.get("LINGBOT_WEIGHTS_REPO", "cahlen/lingbot-world-base-cam-nf4")
LINGBOT_WEIGHTS_DIR = os.environ.get("LINGBOT_WEIGHTS_DIR", f"{LINGBOT_DIR}/lingbot-world-base-cam")

if NEEDS_SCENES:
    if not os.path.isdir(LINGBOT_DIR):
        os.system(f"git clone {LINGBOT_REPO} {LINGBOT_DIR}")
        os.system(f"pip install -q -r {LINGBOT_DIR}/requirements.txt")
    if not os.path.isdir(LINGBOT_WEIGHTS_DIR):
        os.system('pip install -q "huggingface_hub[cli]"')
        os.system(f"huggingface-cli download {LINGBOT_WEIGHTS_REPO} --local-dir {LINGBOT_WEIGHTS_DIR}")
    print("Portrait + LingBot setup ready.")
else:
    print("Portrait setup ready (no PROMPT_LIBRARY entry needs scenes -- skipping LingBot entirely).")

# %%
# --- Cell 3: generation helpers ---
import subprocess
import time


def build_portrait_prompt(persona: dict, suffix: str) -> str:
    # ARCHETYPES entries have no name (they're a style/personality template, not a named
    # character) -- drop the "named X" clause entirely rather than emit "named .".
    subject = f"fictional character named {persona['name']}" if persona.get("name") else "fictional character"
    lines = [
        f"Character portrait of an adult (age {persona['age']}) {subject}.",
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


# Mirrors companion/action_string.ts (kept in sync by hand -- ties the LingBot camera schedule
# to persona.personality instead of leaving it null/free-form). Format verified against the
# real parser in lingbot-world's wan/utils/wasd_ijkl_to_c2ws.py: comma-separated
# "<keys>-<frames>" segments applied in order (w/a/s/d translate, i/j/k/l pitch/yaw, "none"
# holds still); the total must sum to exactly --frame_num (81 below).
MOTION_CELLS = {
    "playful": ["w-3", "none-2", "d-3", "none-2", "i-2", "none-2", "k-2", "none-2", "a-3", "none-2"],
    "romantic": ["none-10", "i-4", "none-10", "k-4"],
    "bratty": ["j-4", "none-1", "l-4", "none-1", "j-3", "none-3"],
    "dominant": ["none-35", "w-6", "none-35"],
    "soft": ["none-15", "i-2", "none-15", "k-2"],
    "mysterious": ["l-15", "none-5"],
}


def build_action_string(personality: str, total_frames: int = 81) -> str:
    cell = MOTION_CELLS.get(personality, MOTION_CELLS["playful"])
    cell_frames = sum(int(seg.rsplit("-", 1)[-1]) for seg in cell)

    segments: list[str] = []
    used = 0
    while cell_frames > 0 and used + cell_frames <= total_frames:
        segments.extend(cell)
        used += cell_frames
    remainder = total_frames - used
    if remainder > 0:
        segments.append(f"none-{remainder}")
    return ",".join(segments)


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
    action_string = prompt_entry.get("action_string") or build_action_string(persona["personality"])
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
# --- Cell 4: the matrix loops -- resumable. Two separate subtrees so this lines up EXACTLY
# with FuckLike/web/app.js's PRESET_ASSET_BASE ("/assets/personas") and TEMPLATE_ASSET_BASE
# ("/assets/templates") -- point BATCH_OUTPUT_DIR at .../public_html/assets and both land
# exactly where the frontend already looks for them, no renaming step needed. ---
import json

PERSONAS_DIR = os.path.join(OUTPUT_DIR, "personas")
TEMPLATES_DIR = os.path.join(OUTPUT_DIR, "templates")

manifest: dict = {}
manifest_path = os.path.join(OUTPUT_DIR, "manifest.json")
if os.path.exists(manifest_path):
    with open(manifest_path) as f:
        manifest = json.load(f)


def run_matrix(entries: list[dict], base_dir: str, manifest_key: str) -> None:
    manifest.setdefault(manifest_key, {})
    for persona in entries:
        persona_dir = os.path.join(base_dir, persona["id"])
        os.makedirs(persona_dir, exist_ok=True)
        manifest[manifest_key].setdefault(persona["id"], {})
        print(f"=== {persona['name'] or persona['id']} ({persona['id']}) ===")

        for prompt_entry in PROMPT_LIBRARY:
            slug = prompt_entry["slug"]
            portrait_path = os.path.join(persona_dir, f"{slug}.png")
            generate_portrait(persona, prompt_entry, portrait_path)
            entry = manifest[manifest_key][persona["id"]].setdefault(slug, {})
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


run_matrix(PERSONAS, PERSONAS_DIR, "personas")     # -> assets/personas/<id>/<slug>.png
run_matrix(ARCHETYPES, TEMPLATES_DIR, "templates")  # -> assets/templates/<id>/<slug>.png

print("Matrix complete (or resumed to current state). See manifest.json.")

# %%
# --- Cell 5: sanity check -- print what's actually on disk vs. what the manifest claims ---
def count_done(entries, base_dir, want_scenes):
    portraits = sum(1 for p in entries for e in PROMPT_LIBRARY if os.path.exists(os.path.join(base_dir, p["id"], f"{e['slug']}.png")))
    scenes = sum(
        1 for p in entries for e in PROMPT_LIBRARY
        if want_scenes and e.get("generate_scene") and os.path.exists(os.path.join(base_dir, p["id"], f"{e['slug']}.mp4"))
    )
    return portraits, scenes


persona_portraits, persona_scenes = count_done(PERSONAS, PERSONAS_DIR, NEEDS_SCENES)
template_portraits, _ = count_done(ARCHETYPES, TEMPLATES_DIR, False)
done_portraits = persona_portraits + template_portraits
done_scenes = persona_scenes
print(f"Portraits on disk: {done_portraits}/{total_portraits} ({persona_portraits} personas, {template_portraits} templates)")
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
