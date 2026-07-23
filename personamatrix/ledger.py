"""ledger.py -- the APEX billing ledger (Python side).

Mirrors apex/ledger.ts: every ephemeral persona execution is billed with cost_usd and a
SUCCESS / BLOCKED / FAILED status. Rows map onto the RequestLog Prisma model. In-memory
for Phase 1; the shape is interface-ready for a DB-backed Phase 2.
"""
from __future__ import annotations

import time
import uuid
from dataclasses import dataclass, field
from typing import List, Literal

from .config_loader import billing_config

Status = Literal["SUCCESS", "BLOCKED", "FAILED"]


@dataclass
class LedgerEntry:
    packet_id: str
    source: str
    destination: str
    status: Status
    cost_usd: float
    knoll_signature: str
    id: str = field(default_factory=lambda: f"led_{uuid.uuid4()}")
    timestamp: float = field(default_factory=time.time)


class ApexLedger:
    """In-memory billing ledger. `request()` is the persona-matrix billing entry point."""

    def __init__(self) -> None:
        self._rows: List[LedgerEntry] = []
        cfg = billing_config()
        self.cost_per_persona = float(cfg.get("costPerPersonaUsd", 0.0001))
        self.cost_per_model_second = float(cfg.get("costPerModelSecondUsd", 0.00002))

    def log_request(
        self,
        packet_id: str,
        source: str,
        destination: str,
        status: Status,
        cost_usd: float,
        knoll_signature: str,
    ) -> LedgerEntry:
        entry = LedgerEntry(
            packet_id=packet_id,
            source=source,
            destination=destination,
            status=status,
            cost_usd=round(cost_usd, 6),
            knoll_signature=knoll_signature,
        )
        self._rows.append(entry)
        return entry

    def request(
        self,
        packet_id: str,
        source: str,
        destination: str,
        personas: int,
        model_seconds: float = 0.0,
        status: Status = "SUCCESS",
        knoll_signature: str = "knoll_ok",
    ) -> LedgerEntry:
        """Bill a single ephemeral execution by persona count and model-seconds."""
        cost = personas * self.cost_per_persona + model_seconds * self.cost_per_model_second
        return self.log_request(packet_id, source, destination, status, cost, knoll_signature)

    def total_cost(self) -> float:
        return round(sum(r.cost_usd for r in self._rows), 6)

    def count_by_status(self, status: Status) -> int:
        return sum(1 for r in self._rows if r.status == status)

    def entries(self) -> List[LedgerEntry]:
        return list(self._rows)
