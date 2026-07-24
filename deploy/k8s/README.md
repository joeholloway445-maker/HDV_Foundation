# `deploy/k8s/` — Kubernetes manifests for the always-on core

Phase 6 foundations: plain Kubernetes manifests for the **always-on trio** (HOPE · APEX ·
KNOLL, which all run inside the one gateway process). The **ephemeral DREAM/VISION workers**
are NOT here — they scale to zero and are materialized by the KEDA `ScaledJob` in
[`../keda/`](../keda/). This directory is the "tiny, cheap, never-scales-to-0" half of the
Phase 6 thesis; `../keda/` is the "workers to zero" half.

> These manifests are the substrate, not a running cluster. They render/validate offline
> (`kubectl apply --dry-run=client -k .` once you add a `kustomization.yaml`, or
> `kubectl apply -f <file> --dry-run=client`), and they mirror the env the container already
> reads in `../docker-compose.prod.yml`, so behavior is identical in compose and k8s.

## Files

| File | What it is |
| ---- | ---------- |
| `namespace.yaml` | The `hdv-foundation` namespace everything is scoped to. |
| `configmap.sample.yaml` | Non-secret gateway config (port, queue mode, Kafka brokers, LLM seam). Copy → `configmap.yaml`. |
| `secret.sample.yaml` | Template for `HDV_API_KEY`, `DATABASE_URL`, `REDIS_URL`. **Never commit real values** — create out-of-band. |
| `gateway.deployment.yaml` | The always-on HOPE gateway `Deployment` + an HPA that scales `1..n` (never to 0). |
| `gateway.service.yaml` | ClusterIP `Service` — reachable only in-cluster and via the Ingress. |
| `worker-rbac.yaml` | `ServiceAccount` + namespaced `Role`/`RoleBinding` letting the scheduler create/reap worker `Job`s. |
| `ingress.notes.md` | TLS-terminating Ingress recipes (ingress-nginx + cert-manager, or Caddy). |

## Apply order

```bash
kubectl apply -f namespace.yaml
# Create real secrets out-of-band (see secret.sample.yaml), then:
kubectl apply -f configmap.sample.yaml       # after copying/editing to configmap.yaml
kubectl apply -f worker-rbac.yaml
kubectl apply -f gateway.deployment.yaml
kubectl apply -f gateway.service.yaml
# Add an Ingress per ingress.notes.md.
# Then install KEDA and apply ../keda/ for scale-to-zero workers.
```

## Invariants (constitution holds at the edge)

- Only the gateway is exposed; `postgres`/`redis`/`kafka`/`vllm` are internal ClusterIP only.
- The trio is always-on (`minReplicas: 1`); only DREAM/VISION scale **to zero** (`../keda/`).
- Nothing here inspects, mutates, or routes packets — it is scheduling/transport substrate.
  Traffic still flows `SOURCE → APEX → KNOLL → DEST`, hashed/gated/billed/audited as always.
