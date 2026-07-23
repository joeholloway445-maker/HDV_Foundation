"""worker_protocol.py -- Phase 4 horizontal Colab worker protocol.

The Big 5 hierarchy needs standby presence for only THREE of the five Big AI — HOPE, KNOLL
and APEX are always-on. DREAM and VISION are EPHEMERAL: they are spun up on demand, do one
batch of work, hand results back through APEX, and self-terminate. That makes them a perfect
fit for horizontally-scaled, disposable Colab/GPU workers.

This module defines the CONTRACT such a worker speaks:
  - `WorkerManifest`  — what an ephemeral worker claims: which Big AI (DREAM or VISION),
                        which matrix slice (managers × nodes), and a GPU hint.
  - `WorkerReport`    — the structured result payload, shaped so APEX can RE-INGEST it as a
                        RoutingPacket (source = the worker's role → destination via APEX).

INVARIANTS (mirrored from .cursorrules):
  - Only DREAM and VISION may be worker roles (they are the ephemeral agents). HOPE, KNOLL,
    and APEX are always-on and are NEVER horizontally disposable workers.
  - A worker NEVER talks to a peer. It reports back through APEX only. In particular a DREAM
    worker's report is destined for HOPE *via APEX* — never straight to VISION, and vice
    versa (DREAM ↔ VISION direct is forbidden).
  - The worker is compute-only (ML lab): no webcam/mic/physical-world I/O.

Standard library only.
"""
from __future__ import annotations

from dataclasses import dataclass, field, asdict
from typing import Any, Dict, List, Optional

# Only the ephemeral Big AI may back a horizontal worker.
EPHEMERAL_WORKER_ROLES = ("DREAM", "VISION")
# All five roles, for validation of report destinations.
ALL_ROLES = ("HOPE", "DREAM", "VISION", "KNOLL", "APEX")

# The `data.kind` discriminator every worker result carries. Kept as a named constant so the
# Python worker and the TypeScript gateway agree on one wire literal.
WORKER_RESULT_KIND = "WORKER_RESULT"
# The HOPE gateway route that re-ingests a WorkerReport through APEX (gateway/server.ts).
# Documented here so `to_apex_payload()` / `to_gateway_request()` and the gateway stay aligned.
GATEWAY_REPORT_PATH = "/v1/worker/report"

# Matrix invariants (mirror nodes/constants.ts). A worker claims a *slice* of these.
MANAGERS_PER_AGENT = 64
NODES_PER_MANAGER = 64


class WorkerProtocolError(ValueError):
    """Raised when a manifest or report violates the worker protocol."""


@dataclass
class NodeSlice:
    """A contiguous slice of one agent's 64×64 matrix a worker will claim.

    manager_start .. manager_start+manager_count-1 managers, and within each the first
    `nodes_per_manager` nodes. Kept small — a Colab worker materializes only what it needs.
    """

    manager_start: int = 0
    manager_count: int = 1
    nodes_per_manager: int = 1

    def node_count(self) -> int:
        return self.manager_count * self.nodes_per_manager

    def validate(self) -> None:
        if not (0 <= self.manager_start < MANAGERS_PER_AGENT):
            raise WorkerProtocolError(
                f"manager_start {self.manager_start} out of range 0..{MANAGERS_PER_AGENT - 1}"
            )
        if self.manager_count < 1 or self.manager_start + self.manager_count > MANAGERS_PER_AGENT:
            raise WorkerProtocolError(
                f"manager_count {self.manager_count} invalid for start {self.manager_start} "
                f"(max {MANAGERS_PER_AGENT})"
            )
        if not (1 <= self.nodes_per_manager <= NODES_PER_MANAGER):
            raise WorkerProtocolError(
                f"nodes_per_manager {self.nodes_per_manager} out of range 1..{NODES_PER_MANAGER}"
            )


@dataclass
class WorkerManifest:
    """What an ephemeral worker declares before claiming a slice and running a batch."""

    agent_role: str
    node_slice: NodeSlice = field(default_factory=NodeSlice)
    gpu_hint: str = "cpu"
    worker_id: str = ""
    task: str = ""

    def validate(self) -> None:
        if self.agent_role not in EPHEMERAL_WORKER_ROLES:
            raise WorkerProtocolError(
                f"agent_role must be one of {EPHEMERAL_WORKER_ROLES} (ephemeral only); "
                f"got {self.agent_role!r}. HOPE/KNOLL/APEX are always-on, never workers."
            )
        if not isinstance(self.gpu_hint, str) or not self.gpu_hint.strip():
            raise WorkerProtocolError("gpu_hint must be a non-empty string (e.g. 'T4', 'A100', 'cpu')")
        self.node_slice.validate()

    def is_valid(self) -> bool:
        try:
            self.validate()
            return True
        except WorkerProtocolError:
            return False

    def to_dict(self) -> Dict[str, Any]:
        return asdict(self)


@dataclass
class WorkerReport:
    """Structured worker output, shaped for APEX re-ingestion as a RoutingPacket.

    A DREAM/VISION worker reports back to HOPE VIA APEX. `to_apex_payload()` returns exactly
    the fields the TypeScript `createPacket({...})` / orchestrator expects, so the result can
    be minted into a legal packet and dispatched through KNOLL like any other traffic.
    """

    manifest: WorkerManifest
    persona_count: int
    avg_score: float
    top_scores: List[float]
    active_parameters: int
    destination: str = "HOPE"

    def validate(self) -> None:
        self.manifest.validate()
        if self.destination not in ALL_ROLES:
            raise WorkerProtocolError(f"destination {self.destination!r} is not a valid AgentRole")
        # A worker must not attempt a forbidden direct DREAM↔VISION hand-off.
        src = self.manifest.agent_role
        if {src, self.destination} == {"DREAM", "VISION"}:
            raise WorkerProtocolError(
                "illegal report route: DREAM ↔ VISION direct is forbidden; report via APEX to HOPE"
            )

    def to_apex_payload(self) -> Dict[str, Any]:
        """The re-ingestion envelope. `source` is the worker's role; APEX + KNOLL mediate.

        The returned dict is EXACTLY the JSON body the HOPE gateway's POST
        ``/v1/worker/report`` (gateway/server.ts ``handleWorkerReport``) expects:
        ``{ source, destination, intent, data }``. The gateway re-mints it as a RoutingPacket
        via ``sendViaApex`` (→ KNOLL → HOPE); it never bypasses APEX.
        """
        self.validate()
        # intent must be a non-empty string (createPacket + the gateway both require it).
        intent = f"worker-result:{self.manifest.task or self.manifest.agent_role.lower()}"
        return {
            "source": self.manifest.agent_role,
            "destination": self.destination,
            "intent": intent,
            "data": {
                "kind": WORKER_RESULT_KIND,
                "workerId": self.manifest.worker_id,
                "agentRole": self.manifest.agent_role,
                "gpuHint": self.manifest.gpu_hint,
                "nodeSlice": self.manifest.node_slice.__dict__,
                "personaCount": self.persona_count,
                "avgScore": round(self.avg_score, 6),
                "topScores": [round(s, 6) for s in self.top_scores],
                "activeParameters": self.active_parameters,
                "ephemeral": True,
                "selfTerminated": True,
            },
        }

    def to_gateway_request(self) -> Dict[str, Any]:
        """Alias for :meth:`to_apex_payload`, named for the HTTP re-ingestion path.

        Additive convenience so caller code reads clearly at the POST ``/v1/worker/report``
        boundary (``GATEWAY_REPORT_PATH``). Byte-for-byte identical to ``to_apex_payload()``.
        """
        return self.to_apex_payload()


def new_worker_id(prefix: str = "worker") -> str:
    """Generate an ephemeral worker id."""
    import uuid

    return f"{prefix}_{uuid.uuid4().hex[:12]}"


def build_manifest(
    agent_role: str,
    manager_start: int = 0,
    manager_count: int = 1,
    nodes_per_manager: int = 1,
    gpu_hint: str = "cpu",
    task: str = "",
    worker_id: Optional[str] = None,
) -> WorkerManifest:
    """Convenience builder that returns a validated manifest (raises on invalid input)."""
    manifest = WorkerManifest(
        agent_role=agent_role,
        node_slice=NodeSlice(
            manager_start=manager_start,
            manager_count=manager_count,
            nodes_per_manager=nodes_per_manager,
        ),
        gpu_hint=gpu_hint,
        worker_id=worker_id or new_worker_id(),
        task=task,
    )
    manifest.validate()
    return manifest
