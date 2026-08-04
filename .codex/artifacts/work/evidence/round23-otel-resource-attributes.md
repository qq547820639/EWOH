# Round 23 Evidence - OTel Resource Attributes

Date: 2026-08-03
Scope: Final 5.0 Y1-08 unified OTel resource attributes.

## Implemented

- `MetricsService` now exposes `ewoh_resource_info` with factory id, factory
  name, upgrade ring, release version, and region, sourced from
  `EWOH_FACTORY_ID`, `EWOH_FACTORY_NAME`, `EWOH_FACTORY_UPGRADE_RING`,
  `EWOH_RELEASE_VERSION`, and `EWOH_REGION`.
- Prometheus labels are escaped for quotes/backslashes/newlines.
- Environment contract propagated through `.env.standalone.example`,
  `deploy/cloud/.env.compose.example`, Docker Compose, Kubernetes ConfigMap,
  Helm values, and Helm ConfigMap template.
- `scripts/verify-deploy-artifacts.js` now checks the compose environment
  contract (66 checks total); Helm chart audit is 125 checks.
- Unit test verifies rendered resource labels; E2E verifies live `/metrics`
  output carries factory resource attributes.

## Verification

```text
Deploy artifact verifier: 66/66 passed
Helm chart audit: 125 checks passed
HTTP + PostgreSQL E2E: 20/20 passed including /metrics resource attributes
```
