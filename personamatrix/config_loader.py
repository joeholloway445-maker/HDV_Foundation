"""config_loader.py -- load shared JSON config for the persona matrix.

Reads ../config/filters.json and ../config/matrix.json so the Python persona loop and
the TypeScript backbone stay in lockstep on tuning params and topology. Standard library
only (Phase 1).
"""
from __future__ import annotations

import json
import os
from functools import lru_cache
from typing import Any, Dict

_HERE = os.path.dirname(os.path.abspath(__file__))
_CONFIG_DIR = os.path.normpath(os.path.join(_HERE, "..", "config"))


def _load_json(name: str) -> Dict[str, Any]:
    path = os.path.join(_CONFIG_DIR, name)
    with open(path, "r", encoding="utf-8") as fh:
        return json.load(fh)


@lru_cache(maxsize=None)
def load_filters() -> Dict[str, Any]:
    """Return the parsed config/filters.json."""
    return _load_json("filters.json")


@lru_cache(maxsize=None)
def load_matrix() -> Dict[str, Any]:
    """Return the parsed config/matrix.json."""
    return _load_json("matrix.json")


def billing_config() -> Dict[str, Any]:
    """Convenience accessor for the billing block of filters.json."""
    return load_filters().get("billing", {})


def filter_params() -> Dict[str, float]:
    """Convenience accessor for the tuning params of filters.json."""
    return load_filters().get("filters", {})
