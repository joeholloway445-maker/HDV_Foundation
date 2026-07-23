"""persona.py -- the ephemeral persona loop driven by the filter_director.

Lifecycle, mirrored from the TypeScript nodes layer: spawn -> execute -> terminate.
Each persona is conceptually tied to a 7B model. The `filter_director` applies the
tuning params from config/filters.json (intensity, waveSpeed, shift, ...) to shape a
persona's ephemeral behavior, then tears it down.

Standard library only (Phase 1).
"""
from __future__ import annotations

import time
import uuid
from dataclasses import dataclass, field
from enum import Enum
from typing import Any, Dict, List, Optional

from .config_loader import filter_params, load_matrix
from .model_backend import (
    GenerationRequest,
    ModelBackend,
    default_backend,
    deterministic_seed,
)


class PersonaState(str, Enum):
    SPAWNED = "SPAWNED"
    EXECUTING = "EXECUTING"
    TERMINATED = "TERMINATED"


@dataclass
class Persona:
    owner: str
    node_id: str
    model_size: str = "7B"
    id: str = field(default_factory=lambda: f"persona_{uuid.uuid4()}")
    state: PersonaState = PersonaState.SPAWNED
    spawned_at: float = field(default_factory=time.time)
    terminated_at: Optional[float] = None


@dataclass
class PersonaExecution:
    persona_id: str
    score: float
    output: Dict[str, Any]


def spawn(owner: str, node_id: str) -> Persona:
    """SPAWN -- create an ephemeral persona bound to a node of a Big AI."""
    matrix = load_matrix()
    model_size = matrix.get("topology", {}).get("modelSize", "7B")
    return Persona(owner=owner, node_id=node_id, model_size=model_size)


def execute(
    persona: Persona,
    payload: Dict[str, Any],
    filters: Optional[Dict[str, float]] = None,
    backend: Optional[ModelBackend] = None,
) -> PersonaExecution:
    """EXECUTE -- run the persona's single job through the model backend + filter transform.

    ``backend`` is the pluggable inference seam (see ``model_backend``). When omitted, the
    process-wide deterministic ``StubBackend`` is used, so behavior is byte-for-byte
    backward compatible with the historical persona loop. Pass a ``TransformersBackend`` to
    drive a real 7B-class model on GPU.
    """
    if persona.state == PersonaState.TERMINATED:
        raise RuntimeError(f"persona {persona.id} already terminated -- cannot execute")
    persona.state = PersonaState.EXECUTING
    f = filters if filters is not None else filter_params()
    active_backend = backend if backend is not None else default_backend()

    result = active_backend.generate(
        GenerationRequest(persona_id=persona.id, payload=payload, filters=f)
    )

    output: Dict[str, Any] = {
        "owner": persona.owner,
        "node_id": persona.node_id,
        "applied_filters": f,
        "backend": result.backend,
        "model_id": result.model_id,
    }
    if result.text:
        output["text"] = result.text

    return PersonaExecution(persona_id=persona.id, score=result.score, output=output)


def terminate(persona: Persona) -> Persona:
    """TERMINATE -- destroy the persona. Ephemeral by contract; no reuse."""
    persona.state = PersonaState.TERMINATED
    persona.terminated_at = time.time()
    return persona


def filter_director(
    owner: str,
    node_id: str,
    payloads: List[Dict[str, Any]],
    filters: Optional[Dict[str, float]] = None,
    backend: Optional[ModelBackend] = None,
) -> List[PersonaExecution]:
    """Direct a full persona loop for a batch of payloads.

    For each payload: spawn -> execute (through the backend + filters) -> terminate. Returns
    one execution record per payload. This is the canonical persona loop for the matrix.
    ``backend`` defaults to the deterministic StubBackend (see ``execute``); pass a real
    backend once and it is shared across the whole batch (loaded once, reused per persona).
    """
    results: List[PersonaExecution] = []
    for payload in payloads:
        p = spawn(owner, node_id)
        results.append(execute(p, payload, filters, backend=backend))
        terminate(p)
    return results


def _seed(text: str) -> float:
    """Deterministic 0..~10 float seed from text (FNV-1a normalized).

    Retained for backward compatibility; delegates to ``model_backend.deterministic_seed``.
    """
    return deterministic_seed(text)
