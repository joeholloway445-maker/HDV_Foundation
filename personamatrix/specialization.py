"""specialization.py -- Python twin of nodes/specialization.ts (Phase 7).

Persona specialty tags and a deterministic SpecialtyRouter that picks the best specialist(s)
for a task, all UNDER ONE Big AI owner. Mirrors the TypeScript module field-for-field so the
Python persona loop and the TS backbone stay in lockstep.

Constitutional guardrails (this module changes NO routing rule):
    - It only ever picks personas under one Big AI owner. It never selects a cross-agent
      destination and never mints or sends a RoutingPacket -- inter-agent traffic still flows
      SOURCE -> APEX -> KNOLL -> DEST. This is intra-owner persona selection only.
    - The ``guardian`` specialty is a persona-level SELF-review role for the owner's own output.
      It is NOT a governance power: KNOLL remains the one and only master auditor.

Standard library only.
"""
from __future__ import annotations

from dataclasses import dataclass, field
from typing import Dict, List, Optional, Sequence, Tuple

# The six persona specialties a Big AI's node matrix can spawn.
PERSONA_SPECIALTIES: Tuple[str, ...] = (
    "researcher",
    "writer",
    "critic",
    "coder",
    "analyst",
    "guardian",
)


@dataclass(frozen=True)
class PersonaSpecialization:
    specialty: str
    description: str
    keywords: Tuple[str, ...]
    weight: float


# Keyword stems match case-insensitively as substrings, so "researching" hits "research".
SPECIALIZATIONS: Dict[str, PersonaSpecialization] = {
    "researcher": PersonaSpecialization(
        "researcher",
        "Gathers, searches, and synthesizes source material for a task.",
        ("research", "find", "search", "gather", "investigate", "explore", "discover", "survey", "source", "reference"),
        0.5,
    ),
    "writer": PersonaSpecialization(
        "writer",
        "Drafts, summarizes, and documents prose and reports.",
        ("write", "draft", "summar", "document", "compose", "narrat", "describe", "explain", "report", "article"),
        0.5,
    ),
    "critic": PersonaSpecialization(
        "critic",
        "Reviews, critiques, and stress-tests proposals and outputs.",
        ("review", "critique", "evaluate", "assess", "judge", "compare", "improve", "refine", "feedback", "weakness"),
        0.5,
    ),
    "coder": PersonaSpecialization(
        "coder",
        "Implements, refactors, and debugs code and scripts.",
        ("code", "implement", "build", "refactor", "debug", "function", "script", "compile", "program", "api"),
        0.6,
    ),
    "analyst": PersonaSpecialization(
        "analyst",
        "Measures, models, and reasons over data and metrics.",
        ("analy", "data", "metric", "measure", "statistic", "forecast", "model", "calculate", "quantif", "chart"),
        0.5,
    ),
    "guardian": PersonaSpecialization(
        "guardian",
        "Self-checks the owner\u2019s own output for safety and policy (not governance).",
        ("verify", "validate", "check", "audit", "safe", "secur", "policy", "comply", "risk", "sanitize"),
        0.4,
    ),
}


@dataclass
class SpecialtyMatch:
    specialty: str
    score: float
    matched_keywords: List[str]


@dataclass
class SpecialtyAssignment:
    owner: str
    task: str
    primary: SpecialtyMatch
    specialists: List[SpecialtyMatch]


def _round4(x: float) -> float:
    return round(x, 4)


def _score_specialty(specialty: str, lowered_task: str) -> SpecialtyMatch:
    spec = SPECIALIZATIONS[specialty]
    matched = [kw for kw in spec.keywords if kw in lowered_task]
    coverage = min(1.0, len(matched) / 3.0)
    score = 0.0 if coverage == 0 else _round4(0.85 * coverage + 0.15 * spec.weight)
    return SpecialtyMatch(specialty=specialty, score=score, matched_keywords=matched)


class SpecialtyRouter:
    """Picks the best persona specialist(s) for a task, all under ONE Big AI owner.

    The owner is fixed at construction so the router can never fan a task across agents; it only
    chooses which of the owner's own specialized personas to spawn. Selection is deterministic.
    """

    def __init__(
        self,
        owner: str,
        roster: Optional[Sequence[str]] = None,
        min_score: float = 0.1,
        max_specialists: int = 3,
    ) -> None:
        self.owner = owner
        chosen = tuple(roster) if roster is not None else PERSONA_SPECIALTIES
        if not chosen:
            raise ValueError("SpecialtyRouter: roster must not be empty")
        self.roster: Tuple[str, ...] = chosen
        self.min_score = min_score
        self.max_specialists = max(1, max_specialists)

    def rank(self, task: str) -> List[SpecialtyMatch]:
        text = task.lower()
        matches = [_score_specialty(s, text) for s in self.roster]
        # Highest score first; break ties by specialty name for determinism.
        matches.sort(key=lambda m: (-m.score, m.specialty))
        return matches

    def route(self, task: str) -> SpecialtyAssignment:
        if not isinstance(task, str) or not task.strip():
            raise ValueError("SpecialtyRouter.route: task must be a non-empty string")
        ranked = self.rank(task)
        primary = ranked[0]
        specialists = [primary] + [m for m in ranked[1:] if m.score >= self.min_score]
        specialists = specialists[: self.max_specialists]
        return SpecialtyAssignment(owner=self.owner, task=task, primary=primary, specialists=specialists)
