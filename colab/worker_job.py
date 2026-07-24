"""worker_job.py -- Phase 5 PRODUCTION-shaped ephemeral DREAM/VISION worker.

Where ``05_horizontal_worker.py`` is a notebook-style walkthrough, this is the container
entrypoint a real deployment runs (see ``deploy/Dockerfile.worker``): a one-shot, ephemeral
worker that

  1. loads a ``WorkerManifest`` from the environment (which ephemeral Big AI, which matrix
     slice, GPU hint),
  2. runs a persona batch over that slice through ``personamatrix.filter_director`` using a
     real ``TransformersBackend`` when ``torch``/``transformers`` are importable, else the
     deterministic ``StubBackend`` (offline-safe default),
  3. builds a ``WorkerReport`` and POSTs it to ``$GATEWAY_URL/v1/worker/report`` so APEX
     re-ingests it (→ KNOLL → HOPE), and
  4. self-terminates (nothing is kept warm).

INVARIANTS (mirror .cursorrules / worker_protocol.py):
  - Only DREAM and VISION may back a worker (HOPE/KNOLL/APEX are always-on).
  - A worker reports back through APEX only; it never talks to a peer, and never attempts a
    direct DREAM↔VISION hand-off. Results are destined for HOPE VIA APEX.
  - Compute-only (ML lab): no webcam/mic/physical-world I/O.

OFFLINE-FIRST: with no ``GATEWAY_URL`` set (or ``--offline`` / ``HDV_WORKER_OFFLINE=1``) the
worker runs the full batch and PRINTS the exact re-ingestion payload instead of POSTing, so it
works with zero network and zero infra. Standard library only for the HTTP path (urllib).
"""
from __future__ import annotations

import argparse
import json
import os
import sys
import time
import urllib.error
import urllib.request
from typing import Any, Dict, Optional, Tuple

# --- Make personamatrix (repo root) and worker_protocol (this dir) importable, whether run
#     from the repo root, from inside colab/, or as a container entrypoint. ---------------
REPO_ROOT = os.path.abspath(os.getcwd())
if os.path.basename(REPO_ROOT) == "colab":
    REPO_ROOT = os.path.dirname(REPO_ROOT)
if REPO_ROOT not in sys.path:
    sys.path.insert(0, REPO_ROOT)
_SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
if _SCRIPT_DIR not in sys.path:
    sys.path.insert(0, _SCRIPT_DIR)

from personamatrix import (  # noqa: E402
    StubBackend,
    TransformersBackend,
    compute_active_parameters,
    filter_director,
    get_backend,
)
from personamatrix.model_backend import ModelBackend, ModelBackendUnavailableError  # noqa: E402
from worker_protocol import (  # noqa: E402
    EPHEMERAL_WORKER_ROLES,
    GATEWAY_REPORT_PATH,
    WorkerReport,
    build_manifest,
)


def _env(name: str, default: str = "") -> str:
    value = os.environ.get(name)
    return value if value is not None else default


def _env_int(name: str, default: int) -> int:
    raw = os.environ.get(name)
    if raw is None or not raw.strip():
        return default
    try:
        return int(raw)
    except ValueError:
        return default


def _truthy(value: str) -> bool:
    return value.strip().lower() in ("1", "true", "yes", "on")


def select_backend() -> ModelBackend:
    """Pick the inference backend: honor an explicit ``PERSONAMATRIX_BACKEND``, otherwise use a
    real ``TransformersBackend`` when it is importable, else the deterministic ``StubBackend``.

    Never raises for the auto path — a failed transformers load degrades to the stub so the
    worker always produces a valid report.
    """
    explicit = os.environ.get("PERSONAMATRIX_BACKEND")
    if explicit and explicit.strip():
        # Explicit selection: let get_backend surface a clear error for a bad name/missing dep.
        return get_backend(explicit)
    if TransformersBackend.is_available():
        try:
            backend = TransformersBackend()
            print(f"[worker] backend: transformers ({backend.model_id}) — real GPU/CPU inference")
            return backend
        except ModelBackendUnavailableError as exc:  # pragma: no cover - needs partial install
            print(f"[worker] transformers unavailable, falling back to stub: {exc}", file=sys.stderr)
    backend = StubBackend()
    print(f"[worker] backend: stub ({backend.model_id}) — deterministic, offline")
    return backend


def run_batch(
    agent_role: str,
    task: str,
    batch: int,
    gpu_hint: str,
    manager_start: int,
    manager_count: int,
    nodes_per_manager: int,
    backend: ModelBackend,
) -> Dict[str, Any]:
    """Claim a slice, run the persona batch through ``backend``, and return the APEX payload."""
    manifest = build_manifest(
        agent_role=agent_role,
        manager_start=manager_start,
        manager_count=manager_count,
        nodes_per_manager=nodes_per_manager,
        gpu_hint=gpu_hint,
        task=task,
    )
    manifest.validate()
    node_id = f"{agent_role}-mgr-{manager_start:02d}-node-00"
    print(
        f"[worker {manifest.worker_id}] claimed {agent_role} slice "
        f"({manifest.node_slice.node_count()} node(s), gpu={gpu_hint}, batch={batch})"
    )

    payloads = [{"intent": task, "branch": i} for i in range(batch)]
    started = time.time()
    results = filter_director(owner=agent_role, node_id=node_id, payloads=payloads, backend=backend)
    elapsed = time.time() - started
    scores = sorted((r.score for r in results), reverse=True)
    avg = sum(scores) / len(scores) if scores else 0.0
    usage = compute_active_parameters(len(results))
    print(
        f"[worker {manifest.worker_id}] ran {len(results)} personas in {elapsed:.2f}s · "
        f"avg={avg:.4f} · active params={usage.active_parameters:.3e}"
    )

    report = WorkerReport(
        manifest=manifest,
        persona_count=len(results),
        avg_score=avg,
        top_scores=scores[:5],
        active_parameters=usage.active_parameters,
        destination="HOPE",
    )
    return report.to_gateway_request()


def post_report(
    gateway_url: str,
    payload: Dict[str, Any],
    api_key: str = "",
    retries: int = 3,
    timeout: float = 15.0,
) -> Tuple[int, str]:
    """POST the report to ``$GATEWAY_URL/v1/worker/report`` (APEX re-ingestion), with backoff.

    Returns ``(status_code, body_text)``. Raises the last error if every attempt fails.
    """
    url = gateway_url.rstrip("/") + GATEWAY_REPORT_PATH
    data = json.dumps(payload).encode("utf-8")
    last_err: Optional[Exception] = None
    for attempt in range(1, retries + 1):
        req = urllib.request.Request(url, data=data, method="POST")
        req.add_header("Content-Type", "application/json")
        if api_key:
            req.add_header("X-HDV-Key", api_key)
        try:
            with urllib.request.urlopen(req, timeout=timeout) as resp:
                body = resp.read().decode("utf-8")
                return resp.status, body
        except urllib.error.HTTPError as exc:
            # 4xx are terminal (e.g. KNOLL block → 403, protocol violation → 400): don't retry.
            body = exc.read().decode("utf-8", errors="replace")
            if 400 <= exc.code < 500:
                return exc.code, body
            last_err = exc
        except (urllib.error.URLError, TimeoutError, OSError) as exc:
            last_err = exc
        if attempt < retries:
            backoff = 0.5 * (2 ** (attempt - 1))
            print(f"[worker] POST attempt {attempt} failed ({last_err}); retrying in {backoff:.1f}s", file=sys.stderr)
            time.sleep(backoff)
    raise RuntimeError(f"failed to POST report to {url} after {retries} attempts: {last_err}")


def parse_args(argv: Optional[list] = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Big 5 Matrix ephemeral DREAM/VISION worker (Phase 5).")
    parser.add_argument("--role", default=_env("HDV_WORKER_ROLE", "DREAM"), choices=list(EPHEMERAL_WORKER_ROLES))
    parser.add_argument("--task", default=_env("HDV_WORKER_TASK", "simulate surge-response outcomes"))
    parser.add_argument("--batch", type=int, default=_env_int("HDV_WORKER_BATCH", 100))
    parser.add_argument("--gpu-hint", default=_env("HDV_WORKER_GPU_HINT", "T4"))
    parser.add_argument("--manager-start", type=int, default=_env_int("HDV_WORKER_MANAGER_START", 0))
    parser.add_argument("--manager-count", type=int, default=_env_int("HDV_WORKER_MANAGER_COUNT", 1))
    parser.add_argument("--nodes-per-manager", type=int, default=_env_int("HDV_WORKER_NODES_PER_MANAGER", 1))
    parser.add_argument("--gateway-url", default=_env("GATEWAY_URL"))
    parser.add_argument("--api-key", default=_env("HDV_API_KEY"))
    parser.add_argument(
        "--offline",
        action="store_true",
        default=_truthy(_env("HDV_WORKER_OFFLINE", "0")),
        help="run the batch and PRINT the payload instead of POSTing (no network needed)",
    )
    return parser.parse_args(argv)


def main(argv: Optional[list] = None) -> int:
    args = parse_args(argv)
    backend = select_backend()

    payload = run_batch(
        agent_role=args.role,
        task=args.task,
        batch=args.batch,
        gpu_hint=args.gpu_hint,
        manager_start=args.manager_start,
        manager_count=args.manager_count,
        nodes_per_manager=args.nodes_per_manager,
        backend=backend,
    )

    offline = args.offline or not args.gateway_url
    if offline:
        reason = "no GATEWAY_URL" if not args.gateway_url else "--offline"
        print(f"[worker] OFFLINE ({reason}) — not POSTing. Re-ingestion payload:")
        print(json.dumps(payload, indent=2))
        print("[worker] self-terminating (ephemeral).")
        return 0

    print(f"[worker] POST {args.gateway_url.rstrip('/')}{GATEWAY_REPORT_PATH} (source={payload['source']} → APEX → HOPE)")
    try:
        status, body = post_report(args.gateway_url, payload, api_key=args.api_key)
    except RuntimeError as exc:
        print(f"[worker] ERROR: {exc}", file=sys.stderr)
        return 1

    print(f"[worker] gateway responded {status}: {body}")
    print("[worker] self-terminating (ephemeral).")
    # A KNOLL block (403) or protocol rejection (400) is a meaningful non-zero exit for the
    # orchestrator (KEDA/Job), but the worker itself did its job and shut down cleanly.
    return 0 if 200 <= status < 300 else 2


if __name__ == "__main__":
    raise SystemExit(main())
