# Kubernetes manifests

Reference manifests for deploying this service. They follow the v2
Best Practices doc, Pilar 9.

## Files

| File                | Purpose                                                |
| ------------------- | ------------------------------------------------------ |
| `deployment.yaml`   | Pod spec, probes, resources, lifecycle, anti-affinity  |
| `service.yaml`      | ClusterIP service in front of the pods                 |
| `hpa.yaml`          | HorizontalPodAutoscaler on CPU                         |
| `configmap.yaml`    | Non-sensitive env (`NODE_ENV`, `LOG_LEVEL`, etc.)      |
| `secret.example.yaml` | Template for the sensitive Secret (do **not** commit real values) |

## Deploy

These are templates — adjust the namespace, image tag, and replica
count to match your cluster.

```bash
# Replace ${IMAGE} with the registry path + commit SHA (never :latest).
sed "s|REPLACE_ME_IMAGE|${IMAGE}|g" deployment.yaml | kubectl apply -f -
kubectl apply -f service.yaml
kubectl apply -f hpa.yaml
kubectl apply -f configmap.yaml
# Create the Secret out-of-band (External Secrets Operator, sealed
# secrets, or a CD-managed pipeline). secret.example.yaml is just the
# shape.
```

## Probe rationale (Pilar 6)

- **Liveness `/healthz`** is intentionally cheap and dependency-free.
  K8s kills the pod when this fails — a slow database must NOT take all
  replicas down at once.
- **Readiness `/readyz`** pings Postgres. Failure removes the pod from
  the Service endpoints (stops routing traffic) but leaves the pod
  running so it can recover.
- **Startup probe** allows up to 150 s for the process to come online
  (slow cold start, container image pull on a fresh node).

## Graceful shutdown

`terminationGracePeriodSeconds` is generous (60 s) so in-flight HTTP
requests have time to finish. The app handles SIGTERM via NestJS
`enableShutdownHooks()` which closes the Postgres pool cleanly. There
is no `preStop` hook — the distroless image has no shell. If a load
balancer needs explicit deregistration, add an HTTP `preStop.httpGet`
endpoint to the controller (out of scope for the boilerplate).

## What is NOT here

- Ingress / Gateway — depends on your stack (ALB, Istio, NGINX, …)
- NetworkPolicy — depends on cluster CNI defaults
- ServiceMonitor / PodMonitor — once Prometheus / OTel is wired
- PodDisruptionBudget — once replica count is stable
- Helm chart — separate repository when the boilerplate forks become
  multiple services
