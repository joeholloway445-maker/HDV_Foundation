# 03 - Behavioral Scoring (Colab / ML Lab notes)

**ML LAB ONLY.** Simulation and compute only. No webcam, microphone, or physical-world I/O.

KNOLL's **behavioral anomaly scorer** is an **additive** gate that runs *after* the six
virtual laws (see `knoll/laws.ts`). The laws give hard, structural guarantees (endpoints,
DREAM↔VISION isolation, forgery, hash integrity, HOPE cannot command, hard malicious
patterns). The scorer catches *behavioral* risk the laws can't express as a hard rule.

- TypeScript engine: [`knoll/scoring.ts`](../knoll/scoring.ts) + [`knoll/features.ts`](../knoll/features.ts)
- Python twin (for this lab): [`personamatrix/scoring.py`](../personamatrix/scoring.py)
- Interactive script: [`colab/03_behavioral_scoring.py`](./03_behavioral_scoring.py)

## Features

Each feature is normalized to `0..1`, where **higher = more suspicious**. The anomaly
score is a weighted sum, clamped to `0..1`.

| Feature             | Weight | What it measures                                                        |
|---------------------|--------|------------------------------------------------------------------------|
| `rate`              | 0.15   | Recent request volume from the source within the rate window (flooding).|
| `intent_entropy`    | 0.10   | Shannon character entropy of intent + string payload (random blobs).    |
| `malicious_hits`    | 0.30   | Soft suspicious-keyword hits (weaker than the hard LAW 6 block).         |
| `endpoint_risk`     | 0.15   | Inherent risk of the `(source → destination)` pair.                     |
| `payload_size`      | 0.10   | Normalized serialized payload size (oversized / exfil-shaped data).      |
| `priority_abuse`    | 0.10   | `CRITICAL` priority used where it shouldn't be (queue-jumping).          |
| `source_reputation` | 0.10   | Accumulated risk history for the source (repeat offenders climb).        |

## Thresholds

- `score >= threshold` (default **0.6**) → **DENY** (`enforcedConstraints: ['BEHAVIORAL_SCORE']`).
- `flag_threshold <= score < threshold` (default flag **0.4**) → **ALLOW but flag** (logged).
- Below `flag_threshold` → clean; the source's reputation slowly decays back toward zero.

## Reputation feedback loop

An anomalous verdict bumps the source's reputation risk (`+0.25`); a flag nudges it
(`+0.05`); clean traffic decays it (`−0.02`). So a source that keeps tripping the scorer
climbs toward denial even if any single packet is only borderline — while a source that
behaves is gradually forgiven.

## Tuning

Weights and thresholds are constructor parameters on `BehavioralScorer` in both the
TypeScript and Python implementations, so you can experiment here and then port the tuned
values into `knoll/scoring.ts`. Keep the Python twin and the TS engine in sync.
