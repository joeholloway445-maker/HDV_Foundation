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
from .scoring import (
    BehavioralScore,
    BehavioralScorer,
    extract_features,
    normalized_entropy,
    DEFAULT_WEIGHTS,
)
from .parameters import (
    MODEL_PARAMS,
    ALWAYS_ON_AGENTS,
    EPHEMERAL_AGENTS,
    AgentParameterBreakdown,
    ParameterAccounting,
    ActiveParameterUsage,
    compute_parameter_accounting,
    compute_active_parameters,
    humanize_parameters,
    parameter_report,
)
from .model_backend import (
    DEFAULT_MODEL_ID,
    BACKEND_STUB,
    BACKEND_TRANSFORMERS,
    ModelBackend,
    StubBackend,
    TransformersBackend,
    GenerationRequest,
    GenerationResult,
    ModelBackendUnavailableError,
    UnknownBackendError,
    get_backend,
    default_backend,
    deterministic_seed,
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
    # Phase 2: behavioral scoring twin
    "BehavioralScorer",
    "BehavioralScore",
    "extract_features",
    "normalized_entropy",
    "DEFAULT_WEIGHTS",
    # Phase 4: parameter accounting twin
    "MODEL_PARAMS",
    "ALWAYS_ON_AGENTS",
    "EPHEMERAL_AGENTS",
    "AgentParameterBreakdown",
    "ParameterAccounting",
    "ActiveParameterUsage",
    "compute_parameter_accounting",
    "compute_active_parameters",
    "humanize_parameters",
    "parameter_report",
    # Colab GPU / 7B model integration hooks
    "DEFAULT_MODEL_ID",
    "BACKEND_STUB",
    "BACKEND_TRANSFORMERS",
    "ModelBackend",
    "StubBackend",
    "TransformersBackend",
    "GenerationRequest",
    "GenerationResult",
    "ModelBackendUnavailableError",
    "UnknownBackendError",
    "get_backend",
    "default_backend",
    "deterministic_seed",
]

__version__ = "0.3.0"
