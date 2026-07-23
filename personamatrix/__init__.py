"""personamatrix -- ephemeral persona loop + APEX billing ledger for the Big 5 Matrix.

Public API:
    - Persona lifecycle:  spawn, execute, terminate, filter_director
    - Billing:            ApexLedger
    - Config:             load_filters, load_matrix, filter_params, billing_config

Phase 1: standard library only.
"""
from __future__ import annotations

from .config_loader import (
    billing_config,
    filter_params,
    load_filters,
    load_matrix,
)
from .ledger import ApexLedger, LedgerEntry
from .persona import (
    Persona,
    PersonaExecution,
    PersonaState,
    execute,
    filter_director,
    spawn,
    terminate,
)

__all__ = [
    "Persona",
    "PersonaExecution",
    "PersonaState",
    "spawn",
    "execute",
    "terminate",
    "filter_director",
    "ApexLedger",
    "LedgerEntry",
    "load_filters",
    "load_matrix",
    "filter_params",
    "billing_config",
]

__version__ = "0.1.0"
