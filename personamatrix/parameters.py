"""parameters.py -- Python twin of nodes/parameters.ts (Phase 4 parameter accounting).

Formalizes the "~14.3 quadrillion parameters" figure so it is computed, not asserted, and
mirrors the TypeScript module field-for-field. Topology is read from config/matrix.json so
the Python persona loop and the TS backbone stay in lockstep.

    TOTAL_CONCEPTUAL_PARAMETERS
      = total_nodes * personas_per_node * model_params
      = 20,480 * 100 * 7,000,000,000
      = 1.4336e16  (~14.3 quadrillion)

Idle agents draw ~zero compute: only live personas count toward ACTIVE parameters.
Standard library only.
"""
from __future__ import annotations

from dataclasses import dataclass
from typing import Dict, List, Optional

from .config_loader import load_matrix

# 7B model. Kept as a module constant to mirror nodes/constants.ts (MODEL_PARAMS).
MODEL_PARAMS = 7_000_000_000

ALWAYS_ON_AGENTS = ("HOPE", "KNOLL", "APEX")
EPHEMERAL_AGENTS = ("DREAM", "VISION")


@dataclass
class AgentParameterBreakdown:
    role: str
    always_on: bool
    ephemeral: bool
    nodes: int
    personas: int
    parameters: int
    share_of_total: float


@dataclass
class ParameterAccounting:
    model_size: str
    model_params: int
    total_nodes: int
    personas_per_node: int
    total_personas: int
    total_conceptual_parameters: int
    per_agent: List[AgentParameterBreakdown]
    big_five_count: int


@dataclass
class ActiveParameterUsage:
    active_personas: int
    active_parameters: int
    utilization: float
    idle_parameters: int


def _topology() -> Dict[str, object]:
    return load_matrix()["topology"]


def compute_parameter_accounting() -> ParameterAccounting:
    """Compute the full conceptual accounting with a per-agent breakdown."""
    topo = _topology()
    nodes_per_agent = int(topo["nodesPerAgent"])
    total_nodes = int(topo["totalNodes"])
    personas_per_node = int(topo["personasPerNode"])
    model_size = str(topo.get("modelSize", "7B"))

    personas_per_agent = nodes_per_agent * personas_per_node
    parameters_per_agent = personas_per_agent * MODEL_PARAMS
    total_personas = total_nodes * personas_per_node
    total_conceptual = total_nodes * personas_per_node * MODEL_PARAMS

    roles = [a["role"] for a in load_matrix()["agents"]]
    per_agent = [
        AgentParameterBreakdown(
            role=role,
            always_on=role in ALWAYS_ON_AGENTS,
            ephemeral=role in EPHEMERAL_AGENTS,
            nodes=nodes_per_agent,
            personas=personas_per_agent,
            parameters=parameters_per_agent,
            share_of_total=parameters_per_agent / total_conceptual,
        )
        for role in roles
    ]

    return ParameterAccounting(
        model_size=model_size,
        model_params=MODEL_PARAMS,
        total_nodes=total_nodes,
        personas_per_node=personas_per_node,
        total_personas=total_personas,
        total_conceptual_parameters=total_conceptual,
        per_agent=per_agent,
        big_five_count=len(roles),
    )


def compute_active_parameters(active_personas: int) -> ActiveParameterUsage:
    """Only live personas draw parameters; the rest of the 14.3Q sits idle at ~zero cost."""
    active_personas = max(0, int(active_personas))
    total = compute_parameter_accounting().total_conceptual_parameters
    active_parameters = active_personas * MODEL_PARAMS
    return ActiveParameterUsage(
        active_personas=active_personas,
        active_parameters=active_parameters,
        utilization=active_parameters / total,
        idle_parameters=total - active_parameters,
    )


def humanize_parameters(n: float) -> str:
    """Format a parameter count into a human word scale (quadrillion, trillion, ...)."""
    scales = [
        (1e18, "quintillion"),
        (1e15, "quadrillion"),
        (1e12, "trillion"),
        (1e9, "billion"),
        (1e6, "million"),
        (1e3, "thousand"),
    ]
    for factor, name in scales:
        if abs(n) >= factor:
            return f"{n / factor:.3f} {name}"
    return f"{n}"


def parameter_report(active_personas: Optional[int] = None) -> str:
    """Human-readable parameter report, mirroring nodes/parameters.ts parameterReport()."""
    acc = compute_parameter_accounting()
    lines: List[str] = []
    lines.append("BIG 5 MATRIX -- PARAMETER ACCOUNTING (Python twin)")
    lines.append(
        f"Model: {acc.model_size} ({acc.model_params:,} params) · "
        f"{acc.total_nodes:,} nodes x {acc.personas_per_node} personas/node"
    )
    lines.append(f"Total personas (full capacity): {acc.total_personas:,}")
    lines.append(
        f"TOTAL CONCEPTUAL PARAMETERS: {acc.total_conceptual_parameters:.4e} "
        f"(~{humanize_parameters(acc.total_conceptual_parameters)})"
    )
    lines.append("")
    lines.append("Per-agent breakdown (each Big AI owns an identical 4,096-node matrix):")
    for a in acc.per_agent:
        kind = "always-on" if a.always_on else ("ephemeral" if a.ephemeral else "other")
        lines.append(
            f"  {a.role:<6} {kind:<10} {a.nodes:,} nodes · {a.personas:,} personas · "
            f"{a.parameters:.4e} params ({a.share_of_total * 100:.1f}%)"
        )

    if active_personas is not None:
        usage = compute_active_parameters(active_personas)
        lines.append("")
        lines.append("ACTIVE snapshot (idle personas draw ~zero compute):")
        lines.append(
            f"  live personas: {usage.active_personas:,} · "
            f"active params: {usage.active_parameters:.4e} "
            f"(~{humanize_parameters(usage.active_parameters)})"
        )
        lines.append(
            f"  utilization: {usage.utilization * 100:.3e}% of the 14.3Q conceptual total"
        )

    return "\n".join(lines)
