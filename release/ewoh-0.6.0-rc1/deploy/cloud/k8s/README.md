# EWOH Kubernetes Deployment

Apply order:

```bash
kubectl apply -f namespace.yaml
kubectl apply -f configmap.yaml
kubectl apply -f migration-secret.example.yaml
kubectl apply -f secret.example.yaml
kubectl apply -f migration-job.yaml
kubectl wait --for=condition=complete job/ewoh-migrate --timeout=10m
kubectl apply -f api-deployment.yaml
kubectl apply -f api-service.yaml
kubectl apply -f ingress.yaml
kubectl apply -f hpa.yaml
kubectl apply -f pdb.yaml
```

Build and publish both `Dockerfile.migrate` and `Dockerfile.api`, then replace
their image references. Replace `ewoh.example.com` and provision both Secrets
through the deployment secret manager; the checked-in files are placeholders,
not deployable credentials. The runtime Secret must contain only the non-owner
`ewoh_api` URL. Multi-replica Kubernetes deployments require S3-compatible
object storage.

HA behavior:

- 3 replicas minimum, HPA scales to 12 on CPU/memory.
- PodDisruptionBudget keeps at least 2 available.
- Readiness probe on `/health/ready`; liveness probe on `/health/live`.
- Use managed PostgreSQL/Redis outside the cluster.
