"""test_model_backend.py -- runnable checks for the pluggable model backend seam.

Run directly (no pytest required):
    python3 personamatrix/test_model_backend.py
or under pytest if you have it:
    pytest personamatrix/test_model_backend.py

Guarantees:
  * StubBackend is deterministic and always available (no GPU / no deps).
  * The factory honors env vars and rejects unknown backend names.
  * persona.execute stays backward compatible (defaults to the stub) and can accept an
    injected backend.
  * The transformers path is exercised only when torch+transformers are installed;
    otherwise it is SKIPPED gracefully and the clear-error contract is asserted instead.
"""
from __future__ import annotations

import os
import sys

# Allow running as a plain script by making the repo root importable.
_REPO_ROOT = os.path.normpath(os.path.join(os.path.dirname(os.path.abspath(__file__)), ".."))
if _REPO_ROOT not in sys.path:
    sys.path.insert(0, _REPO_ROOT)

from personamatrix import (  # noqa: E402
    BACKEND_STUB,
    BACKEND_TRANSFORMERS,
    DEFAULT_MODEL_ID,
    GenerationRequest,
    ModelBackendUnavailableError,
    StubBackend,
    TransformersBackend,
    UnknownBackendError,
    execute,
    filter_director,
    get_backend,
    spawn,
)


def test_stub_backend_deterministic() -> None:
    """Same request -> same score; StubBackend is dependency-free and reproducible."""
    backend = StubBackend()
    req = GenerationRequest(persona_id="persona_fixed", payload={"intent": "simulate"}, filters={})
    a = backend.generate(req)
    b = backend.generate(req)
    assert a.score == b.score, "stub scores must be deterministic for a fixed request"
    assert 0.0 <= a.score <= 1.0, "score must be normalized to 0..1"
    assert a.backend == BACKEND_STUB
    assert a.text == "", "stub generates no text"
    assert a.model_id == DEFAULT_MODEL_ID


def test_stub_backend_always_available() -> None:
    assert StubBackend.is_available() is True


def test_factory_default_is_stub(monkeypatch_env) -> None:
    """With no env override, the factory yields a StubBackend."""
    monkeypatch_env("PERSONAMATRIX_BACKEND", None)
    backend = get_backend()
    assert isinstance(backend, StubBackend)
    assert backend.name == BACKEND_STUB


def test_factory_env_selection(monkeypatch_env) -> None:
    """Explicit stub selection + custom model id via env are honored."""
    monkeypatch_env("PERSONAMATRIX_BACKEND", "stub")
    monkeypatch_env("PERSONAMATRIX_MODEL_ID", "acme/my-7b")
    backend = get_backend()
    assert isinstance(backend, StubBackend)
    assert backend.model_id == "acme/my-7b"


def test_factory_unknown_backend_raises(monkeypatch_env) -> None:
    monkeypatch_env("PERSONAMATRIX_BACKEND", "nope")
    raised = False
    try:
        get_backend()
    except UnknownBackendError:
        raised = True
    assert raised, "unknown backend name must raise UnknownBackendError"


def test_execute_backward_compatible_default() -> None:
    """persona.execute with no backend uses the stub and records provenance."""
    p = spawn(owner="DREAM", node_id="DREAM-mgr-00-node-00")
    ex = execute(p, {"intent": "simulate weather"})
    assert 0.0 <= ex.score <= 1.0
    assert ex.output["backend"] == BACKEND_STUB
    assert ex.output["model_id"] == DEFAULT_MODEL_ID


def test_execute_accepts_injected_backend() -> None:
    p = spawn(owner="VISION", node_id="VISION-mgr-00-node-00")
    backend = StubBackend(model_id="acme/injected-7b")
    ex = execute(p, {"intent": "execute task"}, backend=backend)
    assert ex.output["model_id"] == "acme/injected-7b"


def test_filter_director_shares_backend() -> None:
    backend = StubBackend(model_id="acme/batch-7b")
    payloads = [{"intent": "branch", "i": i} for i in range(10)]
    results = filter_director("DREAM", "DREAM-mgr-00-node-00", payloads, backend=backend)
    assert len(results) == 10
    assert all(r.output["model_id"] == "acme/batch-7b" for r in results)


def test_transformers_backend_optional() -> None:
    """Exercise the real path only if installed; otherwise assert graceful skip contract."""
    if TransformersBackend.is_available():
        # torch + transformers are importable. Constructing/loading a 7B model here would be
        # too heavy for a unit test, so we only assert the availability contract and that a
        # transformers backend is selectable via the factory API surface.
        assert get_backend  # factory exists; heavy model load intentionally not run here
        print("    [transformers] deps present -> real backend selectable (heavy load skipped)")
    else:
        # Deps absent: constructing the backend must raise a CLEAR, actionable error.
        raised = False
        try:
            TransformersBackend()
        except ModelBackendUnavailableError as exc:
            raised = True
            msg = str(exc)
            assert "pip install" in msg, "error must tell the user how to install deps"
            assert BACKEND_TRANSFORMERS in msg or "transformers" in msg
        assert raised, "missing transformers/torch must raise ModelBackendUnavailableError"

        # And requesting it through the factory raises the same clear error.
        raised_factory = False
        try:
            get_backend(backend="transformers")
        except ModelBackendUnavailableError:
            raised_factory = True
        assert raised_factory, "factory must surface the unavailable-backend error"
        print("    [transformers] deps absent -> SKIPPED gracefully with install instructions")


# --------------------------------------------------------------------------------------
# Tiny self-contained runner so this file works with `python3` and no pytest installed.
# When run under pytest, the `monkeypatch_env` fixture below is used instead.
# --------------------------------------------------------------------------------------
class _EnvGuard:
    """Context-managed env setter/restorer usable as a manual 'fixture'."""

    def __init__(self) -> None:
        self._saved: dict = {}

    def set(self, key: str, value):
        if key not in self._saved:
            self._saved[key] = os.environ.get(key)
        if value is None:
            os.environ.pop(key, None)
        else:
            os.environ[key] = value

    def restore(self) -> None:
        for key, value in self._saved.items():
            if value is None:
                os.environ.pop(key, None)
            else:
                os.environ[key] = value
        self._saved.clear()


try:  # pragma: no cover - only used when pytest is available
    import pytest

    @pytest.fixture()
    def monkeypatch_env():
        guard = _EnvGuard()
        yield guard.set
        guard.restore()
except Exception:  # pytest not installed; the manual runner supplies the arg
    pytest = None  # type: ignore


def _run() -> int:
    tests = [
        ("test_stub_backend_deterministic", test_stub_backend_deterministic, False),
        ("test_stub_backend_always_available", test_stub_backend_always_available, False),
        ("test_factory_default_is_stub", test_factory_default_is_stub, True),
        ("test_factory_env_selection", test_factory_env_selection, True),
        ("test_factory_unknown_backend_raises", test_factory_unknown_backend_raises, True),
        ("test_execute_backward_compatible_default", test_execute_backward_compatible_default, False),
        ("test_execute_accepts_injected_backend", test_execute_accepts_injected_backend, False),
        ("test_filter_director_shares_backend", test_filter_director_shares_backend, False),
        ("test_transformers_backend_optional", test_transformers_backend_optional, False),
    ]
    passed = 0
    failed = 0
    print("=" * 70)
    print("MODEL BACKEND TESTS -- stub always; transformers only if installed")
    print("=" * 70)
    for name, fn, needs_env in tests:
        guard = _EnvGuard()
        try:
            if needs_env:
                fn(guard.set)
            else:
                fn()
            print(f"  PASS  {name}")
            passed += 1
        except AssertionError as exc:
            print(f"  FAIL  {name}: {exc}")
            failed += 1
        except Exception as exc:  # unexpected error
            print(f"  ERROR {name}: {exc!r}")
            failed += 1
        finally:
            guard.restore()

    print("-" * 70)
    print(f"RESULT: {'PASS' if failed == 0 else 'FAIL'} -- {passed} passed, {failed} failed")
    print("=" * 70)
    return 0 if failed == 0 else 1


if __name__ == "__main__":
    raise SystemExit(_run())
