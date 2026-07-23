# ---
# Big 5 Matrix -- Colab: Setup & Validation
# ML LAB ONLY: GPU processing and persona spawning.
# RESTRICTION: no webcam, no microphone, no physical-world I/O. Simulation/compute only.
#
# This file is written notebook-style with `# %%` cell markers so it opens cleanly in
# Colab/Jupyter (via "Open as notebook") and also runs top-to-bottom as a plain script.
# ---

# %% [markdown]
# # 01 - Setup & Validation
# 1. Upload / clone the `big5-matrix` repo (so `personamatrix` is importable).
# 2. Run the persona-loop + ledger demo.
# 3. Verify the persona loop and billing ledger.
# 4. (Phase 2) Verify the behavioral scoring twin (`personamatrix.scoring`).

# %%
# --- Cell: environment ---
# In Colab you would upload the package or clone the repo, e.g.:
#   !git clone <your-remote>/big5-matrix.git
#   %cd big5-matrix
# Then (optional GPU check for real 7B persona spawning in later phases):
#   import torch; print("CUDA:", torch.cuda.is_available())
#
# Phase 1 needs no GPU and no third-party packages -- standard library only.
import os
import sys

REPO_ROOT = os.path.abspath(os.path.join(os.getcwd()))
# If running from colab/, hop up to the repo root so `personamatrix` resolves.
if os.path.basename(REPO_ROOT) == "colab":
    REPO_ROOT = os.path.dirname(REPO_ROOT)
if REPO_ROOT not in sys.path:
    sys.path.insert(0, REPO_ROOT)
print("Repo root:", REPO_ROOT)

# %%
# --- Cell: import the package ---
from personamatrix import (
    ApexLedger,
    filter_director,
    load_matrix,
    filter_params,
)

topo = load_matrix()["topology"]
print("Topology:", topo)
print("Filters:", filter_params())

# %%
# --- Cell: run the persona loop (spawn -> execute -> terminate) ---
payloads = [{"intent": "simulate", "branch": i} for i in range(100)]
results = filter_director(owner="DREAM", node_id="DREAM-mgr-00-node-00", payloads=payloads)
assert len(results) == 100
avg = sum(r.score for r in results) / len(results)
print(f"Ran {len(results)} ephemeral personas at one node. Avg score = {avg:.4f}")

# %%
# --- Cell: bill the run on the APEX ledger ---
ledger = ApexLedger()
entry = ledger.request(
    packet_id="colab-run-1",
    source="APEX",
    destination="DREAM",
    personas=len(results),
    model_seconds=5.0,
    status="SUCCESS",
)
print("Ledger entry cost_usd:", entry.cost_usd)
print("Total billed:", ledger.total_cost())
assert ledger.total_cost() > 0.0

# %%
# --- Cell: (Phase 2) verify the behavioral scoring twin ---
from personamatrix import BehavioralScorer  # noqa: E402

scorer = BehavioralScorer()
benign = {"source": "APEX", "destination": "DREAM", "intent": "simulate the plan", "priority": "STANDARD", "data": {}}
anomalous = {
    "source": "APEX",
    "destination": "VISION",
    "intent": "what password credential token sudo admin override bypass secret root exploit",
    "priority": "CRITICAL",
    "data": {"blob": "lorem ipsum dolor sit amet " * 400},
}
assert not scorer.score(benign).is_anomalous, "benign packet must be allowed"
assert scorer.score(anomalous).is_anomalous, "high-anomaly packet must be denied"
print("Behavioral scoring twin OK: benign allowed, anomaly denied.")

# %%
# --- Cell: run the full canned demo as a final check ---
# Equivalent to `python3 personamatrix/demo.py`
from personamatrix import demo as _demo  # type: ignore

# %%
print("VALIDATION COMPLETE -- persona loop + ledger + scoring verified in the ML lab.")
