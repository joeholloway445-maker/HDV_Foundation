"""model_backend.py -- pluggable inference backend for the ephemeral persona loop.

Each persona is conceptually tied to a 7B model (see the constitution, §4). Phase 1-4 ran
that concept purely as a deterministic standard-library transform. This module adds a thin
seam so the SAME persona loop can, when real GPU hardware is available (e.g. Google Colab),
drive an actual 7B-class model via ``transformers`` -- without changing any routing,
security, ledger, or topology behavior.

Design
------
- ``ModelBackend`` is the abstract contract: ``generate(request) -> GenerationResult``.
- ``StubBackend`` is the DEFAULT and reproduces the exact deterministic score the persona
  loop has always produced (a damped wave shaped by the filter tuning params). No GPU, no
  third-party dependencies.
- ``TransformersBackend`` is OPTIONAL: it imports ``torch`` / ``transformers`` lazily and
  raises a clear, actionable error if they are not installed. It never becomes the default.
- ``get_backend(...)`` is the factory, driven by env vars:
      PERSONAMATRIX_BACKEND   = stub | transformers      (default: stub)
      PERSONAMATRIX_MODEL_ID  = <hf model id>            (default: DEFAULT_MODEL_ID)

This module is standard-library only at import time; ``torch`` / ``transformers`` are only
touched inside ``TransformersBackend`` when it is actually constructed.
"""
from __future__ import annotations

import math
import os
from abc import ABC, abstractmethod
from dataclasses import dataclass, field
from typing import Any, Dict, Optional

# A small, public, 7B-class instruct model id used as the documented DEFAULT for the
# transformers backend. It is a *placeholder default*: any HF 7B-class id works. Override
# with PERSONAMATRIX_MODEL_ID or the ``model_id=`` factory argument. Smaller alternatives
# that load faster on a modest Colab GPU include "sshleifer/tiny-gpt2" (for a smoke test).
DEFAULT_MODEL_ID = "mistralai/Mistral-7B-Instruct-v0.2"

# Recognized backend names for the env/factory selector.
BACKEND_STUB = "stub"
BACKEND_TRANSFORMERS = "transformers"


@dataclass
class GenerationRequest:
    """A single persona inference request.

    ``persona_id`` + ``payload`` seed the deterministic stub transform (preserving the
    historical persona-loop behavior); ``filters`` are the tuning params from
    config/filters.json that shape the score.
    """

    persona_id: str
    payload: Dict[str, Any]
    filters: Dict[str, float] = field(default_factory=dict)

    def seed_text(self) -> str:
        """The canonical text used to deterministically seed a persona execution."""
        return f"{self.persona_id}:{self.payload}"

    def prompt(self) -> str:
        """A natural-language prompt for a real model backend."""
        intent = self.payload.get("intent") if isinstance(self.payload, dict) else None
        return str(intent) if intent else self.seed_text()


@dataclass
class GenerationResult:
    """The result of one persona execution through a backend.

    ``score`` is the normalized 0..1 signal the persona loop bills and aggregates on.
    ``text`` is optional generated text (empty for the stub). ``backend`` / ``model_id``
    record provenance so the ledger and reports can attribute the run.
    """

    score: float
    text: str
    backend: str
    model_id: str
    metadata: Dict[str, Any] = field(default_factory=dict)


def deterministic_seed(text: str) -> float:
    """Deterministic 0..~10 float seed from text (FNV-1a normalized).

    Kept identical to the historical ``persona._seed`` so the stub backend reproduces the
    exact scores the persona loop has always produced.
    """
    h = 0x811C9DC5
    for ch in text:
        h ^= ord(ch)
        h = (h * 0x01000193) & 0xFFFFFFFF
    return (h % 100000) / 10000.0


def _filtered_score(seed: float, filters: Dict[str, float]) -> float:
    """The damped-wave filter transform, normalized to 0..1 and rounded to 6 dp.

    This is the canonical persona score shaping and is shared by every backend so a real
    model's raw signal is still shaped by the same tuning params (intensity/waveSpeed/...).
    """
    intensity = float(filters.get("intensity", 0.75))
    wave_speed = float(filters.get("waveSpeed", 1.2))
    shift = float(filters.get("shift", 0.05))
    decay = float(filters.get("decay", 0.9))
    raw = intensity * math.sin(wave_speed * seed + shift) * (decay ** (seed % 3))
    return round((raw + 1.0) / 2.0, 6)


class ModelBackend(ABC):
    """Abstract inference backend behind the persona loop.

    Implementations MUST be side-effect free with respect to routing/security/ledger; a
    backend only turns a ``GenerationRequest`` into a ``GenerationResult``.
    """

    name: str = "abstract"

    def __init__(self, model_id: str = DEFAULT_MODEL_ID) -> None:
        self.model_id = model_id

    @abstractmethod
    def generate(self, request: GenerationRequest) -> GenerationResult:
        """Run one persona inference and return a scored result."""

    @classmethod
    def is_available(cls) -> bool:
        """Whether this backend can actually run in the current environment."""
        return True

    def __repr__(self) -> str:  # pragma: no cover - cosmetic
        return f"{type(self).__name__}(name={self.name!r}, model_id={self.model_id!r})"


class StubBackend(ModelBackend):
    """Deterministic, dependency-free backend (the historical persona behavior).

    Produces exactly the same score the persona loop always has: a damped wave over an
    FNV-1a seed of ``persona_id:payload``, shaped by the filter tuning params. Always
    available; requires no GPU and no third-party packages.
    """

    name = BACKEND_STUB

    def generate(self, request: GenerationRequest) -> GenerationResult:
        seed = deterministic_seed(request.seed_text())
        score = _filtered_score(seed, request.filters)
        return GenerationResult(
            score=score,
            text="",
            backend=self.name,
            model_id=self.model_id,
            metadata={"seed": seed, "deterministic": True},
        )


class TransformersBackend(ModelBackend):
    """Optional backend that drives a real 7B-class model via ``transformers``.

    ``torch`` and ``transformers`` are imported lazily in ``__init__`` so this module stays
    standard-library only unless this backend is actually constructed. If the dependencies
    are missing, a clear, actionable ``ModelBackendUnavailableError`` is raised.

    The model's generated continuation is folded back through the SAME filter transform
    (seeded by the generated text) so the persona loop's scoring semantics are preserved on
    real hardware; the raw generated ``text`` is returned in the result for inspection.
    """

    name = BACKEND_TRANSFORMERS

    def __init__(
        self,
        model_id: str = DEFAULT_MODEL_ID,
        *,
        max_new_tokens: int = 32,
        device: Optional[str] = None,
    ) -> None:
        super().__init__(model_id=model_id)
        self.max_new_tokens = max_new_tokens

        try:
            import torch  # type: ignore
            from transformers import (  # type: ignore
                AutoModelForCausalLM,
                AutoTokenizer,
            )
        except Exception as exc:  # ImportError and downstream loader errors
            raise ModelBackendUnavailableError(
                "TransformersBackend requires `torch` and `transformers`, which are not "
                "importable in this environment.\n"
                "  Install (Colab GPU runtime recommended):\n"
                "    !pip install transformers accelerate torch\n"
                "  Then select the backend, e.g.:\n"
                "    export PERSONAMATRIX_BACKEND=transformers\n"
                f"    export PERSONAMATRIX_MODEL_ID={DEFAULT_MODEL_ID}\n"
                f"Original import error: {exc!r}"
            ) from exc

        self._torch = torch
        self.device = device or ("cuda" if torch.cuda.is_available() else "cpu")
        dtype = torch.float16 if self.device == "cuda" else torch.float32

        self._tokenizer = AutoTokenizer.from_pretrained(model_id)
        self._model = AutoModelForCausalLM.from_pretrained(
            model_id,
            torch_dtype=dtype,
        ).to(self.device)
        self._model.eval()

    @classmethod
    def is_available(cls) -> bool:
        """True only if both torch and transformers import cleanly."""
        try:
            import torch  # type: ignore  # noqa: F401
            import transformers  # type: ignore  # noqa: F401
        except Exception:
            return False
        return True

    def generate(self, request: GenerationRequest) -> GenerationResult:
        torch = self._torch
        prompt = request.prompt()
        inputs = self._tokenizer(prompt, return_tensors="pt").to(self.device)
        with torch.no_grad():
            out = self._model.generate(
                **inputs,
                max_new_tokens=self.max_new_tokens,
                do_sample=False,
            )
        text = self._tokenizer.decode(out[0], skip_special_tokens=True)
        # Fold the real generation back through the shared filter transform so scoring
        # semantics match the stub loop; the raw text is preserved for inspection.
        seed = deterministic_seed(text)
        score = _filtered_score(seed, request.filters)
        return GenerationResult(
            score=score,
            text=text,
            backend=self.name,
            model_id=self.model_id,
            metadata={"device": self.device, "prompt": prompt, "seed": seed},
        )


class ModelBackendUnavailableError(RuntimeError):
    """Raised when a requested backend cannot run (e.g. transformers/torch missing)."""


class UnknownBackendError(ValueError):
    """Raised when an unrecognized backend name is requested."""


def get_backend(
    backend: Optional[str] = None,
    model_id: Optional[str] = None,
    **kwargs: Any,
) -> ModelBackend:
    """Factory: build a ModelBackend from explicit args or environment.

    Resolution order for each setting is: explicit argument -> environment variable ->
    default.

        backend  : ``backend`` arg -> ``PERSONAMATRIX_BACKEND`` -> "stub"
        model_id : ``model_id`` arg -> ``PERSONAMATRIX_MODEL_ID`` -> DEFAULT_MODEL_ID

    Raises ``UnknownBackendError`` for an unrecognized name and
    ``ModelBackendUnavailableError`` if the transformers backend is requested but its
    dependencies are unavailable.
    """
    name = (backend or os.environ.get("PERSONAMATRIX_BACKEND") or BACKEND_STUB).strip().lower()
    resolved_model_id = model_id or os.environ.get("PERSONAMATRIX_MODEL_ID") or DEFAULT_MODEL_ID

    if name == BACKEND_STUB:
        return StubBackend(model_id=resolved_model_id)
    if name == BACKEND_TRANSFORMERS:
        return TransformersBackend(model_id=resolved_model_id, **kwargs)
    raise UnknownBackendError(
        f"Unknown PERSONAMATRIX_BACKEND {name!r}; expected "
        f"{BACKEND_STUB!r} or {BACKEND_TRANSFORMERS!r}."
    )


# A shared, always-available default backend so the persona loop needs no construction cost
# per call and stays byte-for-byte backward compatible when no backend is supplied.
_DEFAULT_STUB_BACKEND = StubBackend()


def default_backend() -> ModelBackend:
    """Return the process-wide default StubBackend (deterministic, dependency-free)."""
    return _DEFAULT_STUB_BACKEND
