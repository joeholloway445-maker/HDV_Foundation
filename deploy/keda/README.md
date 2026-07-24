# `deploy/keda/` — scale-to-zero DREAM/VISION workers

This is the **"workers to zero"** half of the Phase 6 thesis (the always-on trio lives in
[`../k8s/`](../k8s/)). Two KEDA `ScaledJob`s watch Kafka consumer-group **lag** on the per-role
topics that `KafkaTaskQueue` already produces and materialize ephemeral worker Jobs **on
demand** — down to **zero** when there is nothing to do.

```
APEX ──publishes claim──▶ Kafka topic  hdv.routing.DREAM / hdv.routing.VISION
                                   │  (lag > 0)
                                   ▼
                    KEDA ScaledJob  (minReplicaCount: 0)
                                   │  materializes ≤ maxReplicaCount Jobs
                                   ▼
        DREAM / VISION worker Job ── claims a slice (nodes/lease.ts) ── runs ── → APEX → HOPE
                                   │  (lag → 0, cooldown)
                                   ▼
                            0 running workers  ⇒  0 GPU $
```

## Files

| File | What it is |
| ---- | ---------- |
| `dream.scaledjob.yaml` | `ScaledJob` for DREAM, bound to lag on `hdv.routing.DREAM`. |
| `vision.scaledjob.yaml` | `ScaledJob` for VISION, bound to lag on `hdv.routing.VISION`. |

## The topic contract

Topic names are exactly what `KafkaTaskQueue.topicFor(role)` emits: `<prefix>.<ROLE>` with the
default prefix `hdv.routing` (see `persistence/kafka_real.ts`). Set `HDV_QUEUE=kafka` on the
gateway (see `../k8s/configmap.sample.yaml`) so APEX publishes claims onto these topics.

## Prerequisites

```bash
# 1) Install KEDA (once per cluster).
helm repo add kedacore https://kedacore.github.io/charts && helm repo update
helm install keda kedacore/keda --namespace keda --create-namespace

# 2) Build/push a worker image whose entrypoint drains one claim and exits (args: --role DREAM|VISION).
# 3) Apply the always-on core first (../k8s/), then:
kubectl apply -f dream.scaledjob.yaml
kubectl apply -f vision.scaledjob.yaml
```

## Acceptance (Phase 6 exit)

A load test pushing N intents materializes **≤ N** workers and returns to **0 running
workers** within the cooldown window — verifiable with `kubectl get jobs -n hdv-foundation -w`.

## Invariants

- `minReplicaCount: 0` — idle ⇒ zero workers ⇒ zero GPU cost (idle ≈ $0).
- DREAM and VISION are separate ScaledJobs on separate topics; they never address each other
  (KNOLL LAW 3). Workers report results `→ APEX → HOPE`, never DREAM↔VISION.
- The ScaledJob is transport/scheduling only — it never inspects, mutates, or routes packets.
