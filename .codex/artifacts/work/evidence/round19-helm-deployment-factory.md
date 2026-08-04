---
workItemIds: T-103
kind: test
result: passed
commitSha: dee6503effd7c4cea76dbb1d7ce30054d366f0cb
branch: main
buildVersion: 0.6.0-rc4
envFingerprint: 5fe7c6feb11e2726634abc7e27cd90a86f694b21422960b4c3d7f6c71d1facce
dependencyVersion: 3:2.2.5
producedAt: 2026-08-04T05:35:50.594Z
command: "npm test"
suite: ops-drill
startedAt: 2026-08-04T05:35:50.594Z
completedAt: 2026-08-04T05:35:50.594Z
artifactChecksum: 316ad7d3425e1d8abdb09f15de3ce93aefce2a84d33576764d23e6fd541e0a4f
expiresAt: 2026-11-02T05:35:50.594Z
verifier: "EWOH independent verification agent"
---

# Round 19 Evidence - Helm Deployment Factory

Date: 2026-08-03
Scope: Final 5.0 Y1-07 Helm Chart and Factory Values.

## Implemented

- `deploy/cloud/helm/ewoh/Chart.yaml`: v2 application chart for EWOH
  `0.6.0-rc2`.
- `values.yaml`: image, replica count, Service, Ingress, HPA, PDB, resources,
  migration Job, storage, and `factory.id` / `factory.name` /
  `factory.upgradeRing` values.
- Templates render Namespace, ConfigMap, migration Job hook, Deployment,
  Service, Ingress, HPA, PDB, and local-storage PVC.
- Chart never generates secrets from values; runtime credentials must be
  provided through `ewoh-api-secret` and `ewoh-migration-secret`.
- `scripts/verify-helm-chart.js` statically validates Chart metadata, required
  value paths, template presence, all `.Values.*` references, probes, HPA/PDB
  bounds, migration commands, and secret posture.
- `npm run verify:helm` and `test/contract/helm-chart.spec.ts` make the chart
  contract part of the regular test suite.

## Verification

```text
Helm chart audit: ewoh 0.1.0 (app 0.6.0-rc2) | 10 templates | 123 checks passed
Jest contract: 4/4 passed
Type check + lint: passed
```

Cluster apply with `helm template` / `helm install` remains an environment-gated
drill because Docker/Kubernetes tooling is not installed in this workspace.
