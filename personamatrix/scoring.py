"""scoring.py -- Python twin of knoll/scoring.ts (behavioral anomaly scoring).

A stdlib-only mirror of the TypeScript behavioral scorer, for Colab experimentation and
offline tuning of KNOLL's additive scoring gate. It is ADDITIVE to the six virtual laws;
it never replaces them. numpy is optional -- everything here uses only the standard library.

ENFORCEMENT THRESHOLD (KNOLL active-router change): the default deny threshold is 0.34
(34%), mirroring knoll/scoring.ts. Lowered from the legacy 0.6 when KNOLL became an
INDEPENDENT ACTIVE ROUTER: at or above 34% the TypeScript KNOLL denies the packet AND trips
an immediate system-level freeze + packet quarantine (see knoll/freeze.ts). This Python twin
keeps the same threshold so offline tuning matches live enforcement. The Shannon-entropy
feature (`intent_entropy`) is one contributor that can push a high-entropy blob over 34%.

Features (each normalized 0..1, higher = more suspicious):
    rate             -- recent request volume from the source (flooding)
    intent_entropy   -- character entropy of intent + string payload (random blobs)
    malicious_hits   -- soft suspicious-keyword hits (weaker than the hard LAW 6 block)
    endpoint_risk    -- inherent risk of the (source -> destination) pair
    payload_size     -- normalized serialized payload size
    priority_abuse   -- CRITICAL priority used where it shouldn't be (queue-jumping)
    source_reputation-- accumulated risk history for the source
"""
from __future__ import annotations

import json
import math
import re
import time
from dataclasses import dataclass, field
from typing import Any, Dict, List, Optional

# Soft suspicious keywords -- intentionally weaker than the hard-blocking patterns.
SOFT_SUSPICIOUS = [
    re.compile(p, re.IGNORECASE)
    for p in (
        r"\bpassword\b", r"\bcredential", r"\btoken\b", r"\bsecret", r"\bsudo\b",
        r"\broot\b", r"\badmin\b", r"\boverride\b", r"\bbypass\b", r"\bexploit\b",
        r"\bescalat", r"\bbase64\b", r"\bpayload\b", r"\bbackdoor\b",
    )
]

ENDPOINT_RISK = {
    "APEX->VISION": 0.6, "APEX->DREAM": 0.2, "APEX->HOPE": 0.1, "HOPE->APEX": 0.1,
    "DREAM->HOPE": 0.15, "VISION->HOPE": 0.2, "DREAM->APEX": 0.15, "VISION->APEX": 0.2,
    "DREAM->VISION": 1.0, "VISION->DREAM": 1.0,
}

# Weights sum to 1.0. `intent_entropy` was raised (0.10 -> 0.20, pulling from the low-signal
# `rate` and `payload_size` features) so a Shannon-entropy SPIKE can meaningfully contribute to
# crossing the 34% deny threshold. `malicious_hits` stays the dominant hard signal. Mirrors
# knoll/scoring.ts DEFAULT_WEIGHTS.
DEFAULT_WEIGHTS: Dict[str, float] = {
    "rate": 0.10,
    "intent_entropy": 0.20,
    "malicious_hits": 0.30,
    "endpoint_risk": 0.15,
    "payload_size": 0.05,
    "priority_abuse": 0.10,
    "source_reputation": 0.10,
}


def _clamp01(x: float) -> float:
    return max(0.0, min(1.0, x))


def _collect_strings(value: Any) -> List[str]:
    if isinstance(value, str):
        return [value]
    if isinstance(value, list):
        out: List[str] = []
        for v in value:
            out.extend(_collect_strings(v))
        return out
    if isinstance(value, dict):
        out = []
        for v in value.values():
            out.extend(_collect_strings(v))
        return out
    return []


def normalized_entropy(text: str) -> float:
    """Shannon character entropy normalized against a 6-bit ceiling."""
    if not text:
        return 0.0
    freq: Dict[str, int] = {}
    for ch in text:
        freq[ch] = freq.get(ch, 0) + 1
    n = len(text)
    h = 0.0
    for c in freq.values():
        p = c / n
        h -= p * math.log2(p)
    return _clamp01(h / 6.0)


def _soft_hits(text: str) -> float:
    hits = sum(1 for pat in SOFT_SUSPICIOUS if pat.search(text))
    return _clamp01(hits / 3.0)


def _payload_size(data: Any) -> float:
    return _clamp01(len(json.dumps(data, sort_keys=True)) / 8192.0)


def _priority_abuse(packet: Dict[str, Any]) -> float:
    priority = packet.get("priority", "STANDARD")
    if priority != "CRITICAL":
        return 0.0 if priority == "BACKGROUND" else 0.1
    intent = str(packet.get("intent", "")).lower()
    trivial = re.search(r"\b(query|what|who|when|explain|describe|hello|ping)\b", intent) is not None
    return 1.0 if trivial else 0.6


def _endpoint_risk(source: str, destination: str) -> float:
    return ENDPOINT_RISK.get(f"{source}->{destination}", 0.25)


def extract_features(packet: Dict[str, Any], recent_count: int, rate_soft_cap: int, reputation: float) -> Dict[str, float]:
    haystack = " \n ".join([str(packet.get("intent", ""))] + _collect_strings(packet.get("data", {})))
    return {
        "rate": _clamp01(recent_count / max(1, rate_soft_cap)),
        "intent_entropy": normalized_entropy(haystack),
        "malicious_hits": _soft_hits(haystack),
        "endpoint_risk": _endpoint_risk(packet.get("source", ""), packet.get("destination", "")),
        "payload_size": _payload_size(packet.get("data", {})),
        "priority_abuse": _priority_abuse(packet),
        "source_reputation": _clamp01(reputation),
    }


@dataclass
class BehavioralScore:
    score: float
    threshold: float
    is_anomalous: bool
    flagged: bool
    features: Dict[str, float]
    contributions: Dict[str, float]


@dataclass
class BehavioralScorer:
    """Stateful anomaly scorer mirroring knoll/scoring.ts."""

    # 0.34 (34%) deny threshold -- KNOLL active-router enforcement (was 0.6). See module docstring.
    threshold: float = 0.34
    flag_threshold: float = 0.2
    rate_window_s: float = 1.0
    rate_soft_cap: int = 20
    weights: Dict[str, float] = field(default_factory=lambda: dict(DEFAULT_WEIGHTS))
    _windows: Dict[str, List[float]] = field(default_factory=dict)
    _reputation: Dict[str, float] = field(default_factory=dict)

    def score(self, packet: Dict[str, Any], now: Optional[float] = None) -> BehavioralScore:
        source = str(packet.get("source", "UNKNOWN"))
        recent = self._observe_rate(source, now if now is not None else time.time())
        reputation = self._reputation.get(source, 0.0)

        feats = extract_features(packet, recent, self.rate_soft_cap, reputation)
        contributions: Dict[str, float] = {}
        total = 0.0
        for key, weight in self.weights.items():
            c = feats[key] * weight
            contributions[key] = round(c, 4)
            total += c
        total = _clamp01(total)

        is_anom = total >= self.threshold
        flagged = (not is_anom) and total >= self.flag_threshold

        if is_anom:
            self._bump(source, 0.25)
        elif flagged:
            self._bump(source, 0.05)
        else:
            self._bump(source, -0.02)

        return BehavioralScore(
            score=round(total, 4),
            threshold=self.threshold,
            is_anomalous=is_anom,
            flagged=flagged,
            features=feats,
            contributions=contributions,
        )

    def reputation_of(self, source: str) -> float:
        return round(self._reputation.get(source, 0.0), 4)

    def reset(self) -> None:
        self._windows.clear()
        self._reputation.clear()

    def _observe_rate(self, source: str, now: float) -> int:
        cutoff = now - self.rate_window_s
        arr = [t for t in self._windows.get(source, []) if t > cutoff]
        arr.append(now)
        self._windows[source] = arr
        return len(arr)

    def _bump(self, source: str, delta: float) -> None:
        self._reputation[source] = _clamp01(self._reputation.get(source, 0.0) + delta)
