"""persona.py -- the ephemeral persona loop driven by the filter_director.

Lifecycle, mirrored from the TypeScript nodes layer: spawn -> execute -> terminate.
Each persona is conceptually tied to a 7B model. The `filter_director` applies the
tuning params from config/filters.json (intensity, waveSpeed, shift, ...) to shape a
persona's ephemeral behavior, then tears it down.

Standard library only (Phase 1).
"""
from __future__ import annotations

import math
import time
import uuid
from dataclasses import dataclass, field
from enum import Enum
from typing import Any, Dict, List, Optional

from .config_loader import filter_params, load_matrix


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


def execute(persona: Persona, payload: Dict[str, Any], filters: Optional[Dict[str, float]] = None) -> PersonaExecution:
    """EXECUTE -- run the persona's single job through the filter transform."""
    if persona.state == PersonaState.TERMINATED:
        raise RuntimeError(f"persona {persona.id} already terminated -- cannot execute")
    persona.state = PersonaState.EXECUTING
    f = filters if filters is not None else filter_params()

    # Deterministic filter transform: a damped wave shaped by the tuning params.
    seed = _seed(f"{persona.id}:{payload}")
    intensity = float(f.get("intensity", 0.75))
    wave_speed = float(f.get("waveSpeed", 1.2))
    shift = float(f.get("shift", 0.05))
    decay = float(f.get("decay", 0.9))
    raw = intensity * math.sin(wave_speed * seed + shift) * (decay ** (seed % 3))
    score = round((raw + 1.0) / 2.0, 6)  # normalize to 0..1

    return PersonaExecution(
        persona_id=persona.id,
        score=score,
        output={"owner": persona.owner, "node_id": persona.node_id, "applied_filters": f},
    )


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
) -> List[PersonaExecution]:
    """Direct a full persona loop for a batch of payloads.

    For each payload: spawn -> execute (through filters) -> terminate. Returns one
    execution record per payload. This is the canonical persona loop for the matrix.
    """
    results: List[PersonaExecution] = []
    for payload in payloads:
        p = spawn(owner, node_id)
        results.append(execute(p, payload, filters))
        terminate(p)
    return results


def _seed(text: str) -> float:
    """Deterministic 0..~10 float seed from text (FNV-1a normalized)."""
    h = 0x811C9DC5
    for ch in text:
        h ^= ord(ch)
        h = (h * 0x01000193) & 0xFFFFFFFF
    return (h % 100000) / 10000.0
