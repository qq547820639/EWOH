---
workItemIds: [T-431, T-432, T-433, T-434, T-435, T-436, T-437, T-438, T-439, T-440]
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

# Round 44 Evidence - Factory Difference Resolution

Date: 2026-08-03
Scope: Y4-02 difference recycling closeout.

## Implemented

- `POST /api/scale/differences/:key/resolve` marks a registered factory
  difference as `resolved` and writes a `scale.difference.resolve` audit entry.
- Unit test covers read-update-resolve and audit; E2E registers, lists, and
  resolves a difference over HTTP.

## Verification

```text
OpenAPI strict audit: 178/178
Scale unit tests: resolve passed
HTTP + PostgreSQL E2E: 23/23 passed including difference resolve
```
