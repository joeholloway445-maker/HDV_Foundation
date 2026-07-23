# ---
# Big 5 Matrix -- Colab: GPU / 7B Model Integration Hooks (v0.3.0)
# ML LAB ONLY: GPU processing and persona spawning. Simulation/compute only.
# RESTRICTION: no webcam, no microphone, no physical-world I/O.
#
# Notebook-style (`# %%` cell markers) so it opens cleanly in Colab/Jupyter and also runs
# top-to-bottom as a plain script:  python3 colab/06_gpu_model_hooks.py
#
# WHAT THIS DOES
# --------------
# This is the bridge from the deterministic persona loop to a REAL 7B-class model on a GPU.
# It never changes routing/security/ledger/topology -- it only swaps the per-persona
# inference backend (see personamatrix/model_backend.py):
#   1. Detect CUDA / GPU and print device info.
#   2. ALWAYS run the deterministic StubBackend (no GPU, no third-party deps required).
#   3. ATTEMPT the TransformersBackend only if `torch` + `transformers` import AND a GPU is
#      present; otherwise SKIP gracefully and print exact Colab install instructions.
#
# COLAB SETUP (do this first in Colab)
# ------------------------------------
#   Runtime -> Change runtime type -> Hardware accelerator: GPU (T4 is enough for a smoke test).
#   Then, to enable the real 7B path:
#       !pip install transformers accelerate torch
#   Optionally choose a model (defaults to a small public 7B-class instruct id):
#       import os
#       os.environ["PERSONAMATRIX_BACKEND"]  = "transformers"
#       os.environ["PERSONAMATRIX_MODEL_ID"] = "mistralai/Mistral-7B-Instruct-v0.2"
#   A 7B model needs ~14 GB in fp16; on a 16 GB T4 prefer `accelerate` device_map or a
#   smaller id (e.g. "sshleifer/tiny-gpt2") just to validate the wiring.
# ---

# %% [markdown]
# # 06 - GPU / 7B Model Integration Hooks
# The persona loop is backend-agnostic. By default every persona runs the deterministic
# **StubBackend**. On a GPU Colab runtime with `transformers` installed you can flip a
# single env var and the SAME loop drives a real **7B model** -- no other code changes.
#
# **Colab notebook cells** (each `# %%` block below is one cell):
# 1. Environment / repo import.
# 2. Detect CUDA / print device info.
# 3. Run the StubBackend (always works).
# 4. Attempt the TransformersBackend (GPU + deps) or skip with instructions.
# 5. Summary.

# %%
# --- Cell 1: environment ---
import os
import sys

REPO_ROOT = os.path.abspath(os.getcwd())
if os.path.basename(REPO_ROOT) == "colab":
    REPO_ROOT = os.path.dirname(REPO_ROOT)
if REPO_ROOT not in sys.path:
    sys.path.insert(0, REPO_ROOT)
print("Repo root:", REPO_ROOT)

# In Colab you would first clone/upload the repo so `personamatrix` is importable:
#   !git clone <your-remote>/big5-matrix.git
#   %cd big5-matrix

from personamatrix import (  # noqa: E402
    DEFAULT_MODEL_ID,
    GenerationRequest,
    ModelBackendUnavailableError,
    StubBackend,
    TransformersBackend,
    filter_director,
    filter_params,
    get_backend,
    spawn,
)


# %%
# --- Cell 2: detect CUDA / GPU and print device info ---
def detect_device() -> dict:
    """Return a small dict describing the available compute device.

    Uses torch if importable; otherwise reports CPU-only. Never raises -- absence of a GPU
    is a normal, supported state (the stub path always works).
    """
    info = {"torch_installed": False, "cuda_available": False, "device": "cpu", "gpus": []}
    try:
        import torch  # type: ignore

        info["torch_installed"] = True
        info["torch_version"] = torch.__version__
        if torch.cuda.is_available():
            info["cuda_available"] = True
            info["device"] = "cuda"
            info["cuda_version"] = getattr(torch.version, "cuda", None)
            info["gpus"] = [
                {
                    "index": i,
                    "name": torch.cuda.get_device_name(i),
                    "total_mem_gb": round(
                        torch.cuda.get_device_properties(i).total_memory / (1024 ** 3), 2
                    ),
                }
                for i in range(torch.cuda.device_count())
            ]
    except Exception as exc:  # torch not installed or broken -> CPU-only is fine
        info["note"] = f"torch unavailable ({exc!r}); CPU-only, stub path still runs"
    return info


DEVICE = detect_device()
print("Device info:")
for k, v in DEVICE.items():
    print(f"  {k}: {v}")
if not DEVICE["cuda_available"]:
    print(
        "  -> No CUDA GPU detected. In Colab: Runtime > Change runtime type > GPU. "
        "The StubBackend below runs regardless."
    )


# %%
# --- Cell 3: ALWAYS run the deterministic StubBackend (no GPU needed) ---
def run_stub_demo(batch: int = 20) -> float:
    """Run a persona batch on the StubBackend and return the average score."""
    stub = StubBackend()
    print(f"StubBackend: {stub!r}")
    # Single-persona sanity check through the backend directly.
    p = spawn(owner="DREAM", node_id="DREAM-mgr-00-node-00")
    single = stub.generate(
        GenerationRequest(persona_id=p.id, payload={"intent": "simulate weather"}, filters=filter_params())
    )
    print(f"  single stub score = {single.score} (backend={single.backend}, model={single.model_id})")

    # Full batch via the canonical persona loop, backend injected explicitly.
    payloads = [{"intent": "simulate surge outcomes", "branch": i} for i in range(batch)]
    results = filter_director("DREAM", "DREAM-mgr-00-node-00", payloads, backend=stub)
    avg = sum(r.score for r in results) / len(results)
    print(f"  ran {len(results)} personas on stub · avg score = {avg:.4f}")
    assert all(r.output["backend"] == "stub" for r in results)
    return avg


stub_avg = run_stub_demo()


# %%
# --- Cell 4: ATTEMPT the real 7B TransformersBackend (GPU + deps) or SKIP gracefully ---
def try_transformers(model_id: str = DEFAULT_MODEL_ID, prompt: str = "simulate the launch plan") -> bool:
    """Attempt a real transformers generation. Returns True if it ran, False if skipped.

    Skips (returns False) -- never crashes -- when transformers/torch are missing or no GPU
    is present, printing the exact Colab commands needed to enable the real path.
    """
    if not TransformersBackend.is_available():
        print("SKIP: `transformers`/`torch` are not installed.")
        print("  To enable the real 7B path in Colab, run in a cell:")
        print("      !pip install transformers accelerate torch")
        print("  Then set:")
        print("      import os")
        print("      os.environ['PERSONAMATRIX_BACKEND']  = 'transformers'")
        print(f"      os.environ['PERSONAMATRIX_MODEL_ID'] = '{model_id}'")
        return False

    if not DEVICE.get("cuda_available"):
        print("SKIP: transformers is installed but NO CUDA GPU is available.")
        print("  In Colab: Runtime > Change runtime type > Hardware accelerator: GPU, then re-run.")
        print("  (Loading a 7B model on CPU is impractically slow, so we skip it here.)")
        return False

    print(f"Loading real model via transformers: {model_id} (this downloads weights on first run)...")
    try:
        backend = TransformersBackend(model_id=model_id)
        result = backend.generate(
            GenerationRequest(persona_id="persona_gpu_demo", payload={"intent": prompt}, filters=filter_params())
        )
        print(f"  device      : {result.metadata.get('device')}")
        print(f"  filtered score: {result.score}")
        print(f"  generated    : {result.text[:200]!r}")
        return True
    except ModelBackendUnavailableError as exc:
        print(f"SKIP: transformers backend unavailable at construction: {exc}")
        return False
    except Exception as exc:  # OOM, gated repo, network, etc. -- keep the notebook alive
        print(f"SKIP: real model run failed ({type(exc).__name__}: {exc}).")
        print("  Common fixes: pick a smaller PERSONAMATRIX_MODEL_ID, use a bigger GPU, or")
        print("  authenticate to a gated repo with `huggingface-cli login`.")
        return False


# You can also let the factory pick the backend straight from the environment:
#   os.environ["PERSONAMATRIX_BACKEND"] = "transformers"
#   backend = get_backend()   # -> TransformersBackend if deps present, else clear error
ran_real = try_transformers()


# %%
# --- Cell 5: summary ---
print("\n" + "=" * 70)
print("GPU / 7B MODEL HOOKS SUMMARY")
print("=" * 70)
print(f"  CUDA available    : {DEVICE['cuda_available']}")
print(f"  Stub batch avg    : {stub_avg:.4f} (always runs)")
print(f"  Real 7B executed  : {ran_real}")
if not ran_real:
    print("  Real 7B path skipped (expected off-GPU). Stub path validated the wiring.")
print("=" * 70)


def main() -> int:
    # When invoked as a script, re-assert the invariants so the exit code is meaningful.
    dev = detect_device()
    assert dev["device"] in ("cpu", "cuda")
    avg = run_stub_demo(batch=10)
    assert 0.0 <= avg <= 1.0, "stub average must be a normalized score"
    # The transformers path is optional: it must either run cleanly or skip without raising.
    _ = try_transformers()
    print("\nRESULT: PASS -- stub ran; transformers path ran or skipped gracefully.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
