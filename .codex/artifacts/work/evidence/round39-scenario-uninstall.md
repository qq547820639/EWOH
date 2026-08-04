---
workItemIds: T-123
kind: test
result: passed
commitSha: dee6503effd7c4cea76dbb1d7ce30054d366f0cb
branch: main
buildVersion: 0.6.0-rc4
envFingerprint: 5fe7c6feb11e2726634abc7e27cd90a86f694b21422960b4c3d7f6c71d1facce
dependencyVersion: 3:2.2.5
producedAt: 2026-08-04T05:35:50.594Z
expiresAt: 2026-11-02T05:35:50.594Z
verifier: "EWOH independent verification agent"
---

# Round 39 Evidence - Scenario Pack Uninstall

Date: 2026-08-03
Scope: Scenario pack lifecycle closeout (install/demonstrate/accept/remove).

## Implemented

- `POST /api/scale/scenario-packs/:id/uninstall` validates package type,
  marks the asset `uninstalled`, clears `publishedAt`, and writes a
  `scale.scenario.uninstall` audit entry.
- Unit test covers type validation, state update, and audit; E2E uninstalls a
  registered scenario pack over HTTP and verifies the PostgreSQL row.

## Verification

```text
OpenAPI strict audit: 175/175
Scale unit tests: uninstall passed
HTTP + PostgreSQL E2E: 23/23 passed including scenario uninstall
```
