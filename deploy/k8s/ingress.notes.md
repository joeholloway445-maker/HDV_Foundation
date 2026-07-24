# Ingress / TLS notes — `deploy/k8s/`

The gateway `Service` (`gateway.service.yaml`) is **ClusterIP only**. External traffic reaches
the HOPE gateway exclusively through an Ingress that terminates TLS, so the "single legal road"
holds at the network edge: there is no side door into the matrix, and the pods never speak
plaintext to the public internet.

This is deliberately notes-only (not a committed `Ingress` object) because the concrete
manifest depends on your ingress controller and cert issuer. Two common shapes:

## Option A — ingress-nginx + cert-manager

```yaml
apiVersion: networking.k8s.io/v1
kind: Ingress
metadata:
  name: hdv-gateway
  namespace: hdv-foundation
  annotations:
    cert-manager.io/cluster-issuer: letsencrypt-prod
    nginx.ingress.kubernetes.io/ssl-redirect: "true"
    # Keep the public health probe cheap; rate-limit real API paths at the edge too.
    nginx.ingress.kubernetes.io/limit-rps: "20"
spec:
  ingressClassName: nginx
  tls:
    - hosts: ["api.your-domain.example"]
      secretName: hdv-gateway-tls   # populated by cert-manager
  rules:
    - host: api.your-domain.example
      http:
        paths:
          - path: /
            pathType: Prefix
            backend:
              service:
                name: hdv-gateway
                port:
                  number: 80
```

## Option B — Caddy / other reverse proxy

The repo already ships a `deploy/Caddyfile` and `deploy/nginx.conf.sample` for the
single-VM (docker-compose) deployment. In k8s, prefer an ingress controller, but the same
principles apply: TLS terminated at the edge, forward to `hdv-gateway:80`, and leave
`/v1/health` public and unauthenticated for probes/uptime checks.

## Invariants preserved

- Only the gateway is ever exposed. `postgres`, `redis`, `kafka`, and `vllm` are ClusterIP
  services reachable **inside** the namespace only — never published externally.
- TLS terminates at the ingress; pods serve HTTP on `8787` on the cluster network.
- `/v1/health` stays public (auth- and rate-limit-exempt) for liveness/readiness/uptime.
