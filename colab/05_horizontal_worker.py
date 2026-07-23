# ---
# Big 5 Matrix -- Colab: Horizontal Ephemeral Worker (Phase 4)
# ML LAB ONLY: GPU processing and persona spawning. Simulation/compute only.
# RESTRICTION: no webcam, no microphone, no physical-world I/O.
#
# Notebook-style (`# %%` cell markers) so it opens cleanly in Colab/Jupyter and also runs
# top-to-bottom as a plain script:  python3 colab/05_horizontal_worker.py
#
# WHY THIS EXISTS
# ---------------
# Only THREE of the five Big AI need standby presence: HOPE, KNOLL and APEX are always-on.
# DREAM and VISION are EPHEMERAL — spun up on demand, run one batch, report back through
# APEX, and self-terminate. This script simulates exactly one such disposable worker:
#   1. Claim an ephemeral DREAM (or VISION) matrix slice via a validated WorkerManifest.
#   2. Run a persona batch over that slice (spawn -> execute -> terminate).
#   3. Emit a structured WorkerReport payload, shaped for APEX RE-INGESTION as a RoutingPacket.
#   4. Self-terminate (nothing is kept warm).
# ---

# %% [markdown]
# # 05 - Horizontal Ephemeral Worker
# A DREAM/VISION worker is disposable. It reports to HOPE **via APEX** (never peer-to-peer,
# never DREAM<->VISION direct), then tears itself down. Standby is only for HOPE/KNOLL/APEX.

# %%
# --- Cell: environment ---
import os
import sys

REPO_ROOT = os.path.abspath(os.getcwd())
if os.path.basename(REPO_ROOT) == "colab":
    REPO_ROOT = os.path.dirname(REPO_ROOT)
if REPO_ROOT not in sys.path:
    sys.path.insert(0, REPO_ROOT)
# Ensure this script's own directory is importable so `worker_protocol` resolves whether we
# run from the repo root or from inside colab/.
_SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
if _SCRIPT_DIR not in sys.path:
    sys.path.insert(0, _SCRIPT_DIR)
print("Repo root:", REPO_ROOT)

# %%
# --- Cell: imports ---
from personamatrix import filter_director, compute_active_parameters  # noqa: E402
from worker_protocol import (  # noqa: E402
    WorkerReport,
    build_manifest,
    EPHEMERAL_WORKER_ROLES,
)

print("Ephemeral worker roles:", EPHEMERAL_WORKER_ROLES, "(HOPE/KNOLL/APEX are always-on)")


# %%
# --- Cell: the worker run ---
def run_worker(
    agent_role: str = "DREAM",
    task: str = "simulate surge-response outcomes",
    batch: int = 100,
    gpu_hint: str = "T4",
) -> dict:
    """Simulate a single ephemeral horizontal worker end-to-end.

    Returns the APEX re-ingestion payload (a dict shaped like a RoutingPacket's
    source/destination/intent/data). The caller (or APEX) mints a packet from it.
    """
    # 1) Claim an ephemeral matrix slice (validated: only DREAM/VISION allowed).
    manifest = build_manifest(
        agent_role=agent_role,
        manager_start=0,
        manager_count=1,
        nodes_per_manager=1,
        gpu_hint=gpu_hint,
        task=task,
    )
    manifest.validate()
    node_id = f"{agent_role}-mgr-00-node-00"
    print(
        f"[worker {manifest.worker_id}] claimed {agent_role} slice "
        f"({manifest.node_slice.node_count()} node(s), gpu={gpu_hint})"
    )

    # 2) Run a persona batch over the claimed slice (spawn -> execute -> terminate).
    payloads = [{"intent": task, "branch": i} for i in range(batch)]
    results = filter_director(owner=agent_role, node_id=node_id, payloads=payloads)
    scores = sorted((r.score for r in results), reverse=True)
    avg = sum(scores) / len(scores) if scores else 0.0
    usage = compute_active_parameters(len(results))
    print(
        f"[worker {manifest.worker_id}] ran {len(results)} personas · avg={avg:.4f} · "
        f"active params={usage.active_parameters:.3e}"
    )

    # 3) Build the structured report, shaped for APEX re-ingestion (source=role -> HOPE via APEX).
    report = WorkerReport(
        manifest=manifest,
        persona_count=len(results),
        avg_score=avg,
        top_scores=scores[:5],
        active_parameters=usage.active_parameters,
        destination="HOPE",
    )
    payload = report.to_apex_payload()
    print(
        f"[worker {manifest.worker_id}] report ready for APEX: "
        f"{payload['source']} -> {payload['destination']} intent={payload['intent']!r}"
    )

    # 4) Self-terminate: ephemeral by contract, nothing is kept warm.
    print(f"[worker {manifest.worker_id}] self-terminating (ephemeral).")
    return payload


# %%
# --- Cell: run a DREAM worker ---
dream_payload = run_worker(agent_role="DREAM", task="simulate surge-response outcomes")

# %%
# --- Cell: run a VISION worker too (also ephemeral) ---
vision_payload = run_worker(agent_role="VISION", task="execute the batch ingest", gpu_hint="A100")


# %%
def main() -> int:
    # Re-run with assertions so the exit code is meaningful when invoked as a script.
    payload = run_worker(agent_role="DREAM", task="simulate", batch=50)
    assert payload["source"] == "DREAM"
    assert payload["destination"] == "HOPE"
    assert payload["data"]["personaCount"] == 50
    assert payload["data"]["selfTerminated"] is True
    assert payload["data"]["activeParameters"] == 50 * 7_000_000_000

    # A VISION worker is also valid; an always-on role as a worker must be rejected.
    from worker_protocol import build_manifest as _bm, WorkerProtocolError

    _bm(agent_role="VISION")  # ok
    try:
        _bm(agent_role="APEX")  # must fail (APEX is always-on, never a worker)
        raise AssertionError("APEX must not be accepted as an ephemeral worker role")
    except WorkerProtocolError:
        pass

    print("\nRESULT: PASS -- ephemeral worker claimed, ran, reported via APEX, self-terminated.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
