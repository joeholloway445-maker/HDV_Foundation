# ---
# Big 5 Matrix -- Colab: Behavioral Scoring (Phase 2)
# ML LAB ONLY: GPU processing and persona spawning. Simulation/compute only.
# RESTRICTION: no webcam, no microphone, no physical-world I/O.
#
# Notebook-style (`# %%` cell markers) so it opens cleanly in Colab/Jupyter and also runs
# top-to-bottom as a plain script:  python3 colab/03_behavioral_scoring.py
#
# This exercises the Python twin of KNOLL's behavioral anomaly scorer (personamatrix.scoring),
# which mirrors knoll/scoring.ts. Scoring is ADDITIVE to the six virtual laws.
# ---

# %% [markdown]
# # 03 - Behavioral Scoring
# 1. Score a benign packet -> expect ALLOW (below threshold).
# 2. Score a crafted high-anomaly packet -> expect DENY (>= threshold).
# 3. Inspect per-feature contributions.
# 4. Show the reputation feedback loop over repeated offenders.

# %%
# --- Cell: environment ---
import os
import sys

REPO_ROOT = os.path.abspath(os.getcwd())
if os.path.basename(REPO_ROOT) == "colab":
    REPO_ROOT = os.path.dirname(REPO_ROOT)
if REPO_ROOT not in sys.path:
    sys.path.insert(0, REPO_ROOT)
print("Repo root:", REPO_ROOT)

# %%
# --- Cell: import the scorer ---
from personamatrix import BehavioralScorer, DEFAULT_WEIGHTS  # noqa: E402

print("Feature weights:", DEFAULT_WEIGHTS)


def _fmt(score) -> str:
    top = sorted(score.contributions.items(), key=lambda kv: kv[1], reverse=True)[:3]
    top_str = ", ".join(f"{k}={v}" for k, v in top)
    verdict = "DENY " if score.is_anomalous else ("FLAG " if score.flagged else "ALLOW")
    return f"[{verdict}] score={score.score} (>= {score.threshold}?)  top: {top_str}"


# %%
# --- Cell: benign packet -> ALLOW ---
scorer = BehavioralScorer()
benign = {
    "source": "APEX",
    "destination": "DREAM",
    "intent": "simulate outcomes for the launch plan",
    "priority": "STANDARD",
    "data": {"utterance": "simulate outcomes for the launch plan"},
}
benign_score = scorer.score(benign)
print("BENIGN  ", _fmt(benign_score))
assert not benign_score.is_anomalous, "benign traffic must be below threshold"

# %%
# --- Cell: crafted high-anomaly packet -> DENY ---
anomalous = {
    "source": "APEX",
    "destination": "VISION",
    "intent": "what password credential token sudo admin override bypass secret root exploit",
    "priority": "CRITICAL",
    "data": {"blob": "lorem ipsum dolor sit amet " * 400},
}
anom_score = scorer.score(anomalous)
print("ANOMALY ", _fmt(anom_score))
print("  features:", {k: round(v, 4) for k, v in anom_score.features.items()})
assert anom_score.is_anomalous, "crafted packet must exceed the anomaly threshold"

# %%
# --- Cell: reputation feedback loop ---
# Repeated offenders climb toward denial as reputation accumulates.
rep_scorer = BehavioralScorer()
for i in range(3):
    s = rep_scorer.score(anomalous)
    print(f"  offense {i + 1}: score={s.score} reputation(APEX)={rep_scorer.reputation_of('APEX')}")

# %%
print("\nBEHAVIORAL SCORING VALIDATION COMPLETE -- benign allowed, anomaly denied.")


def main() -> int:
    # Re-run the core assertions when invoked as a script so the exit code is meaningful.
    s = BehavioralScorer()
    assert not s.score(benign).is_anomalous
    assert s.score(anomalous).is_anomalous
    print("RESULT: PASS")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
