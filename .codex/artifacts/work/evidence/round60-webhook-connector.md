---
workItemIds: [T-591, T-592, T-593, T-594, T-595, T-596, T-597, T-598, T-599, T-600]
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

# Round 60 Evidence - HTTP/Webhook Connector

Date: 2026-08-03
Scope: Final 5.0 AA-05: HTTP/Webhook payload normalization, HMAC signature
verification, edge adapter, and connector manifest.

## Implemented

- `src/edge_platform/connectors/webhook.py`: canonical webhook payload
  envelope, constant-time HMAC signature verification, and
  `BaseAdapter`-compatible edge adapter.
- `http-webhook-generic-1.0.0.json` connector manifest with endpointPath and
  signatureHeader config.
- Connector TCK extended from 25 to 29 checks for webhook signature and
  canonical payload mapping.

## Verification

```text
Python contract tests: 117 passed (was 114)
Connector TCK: 29/29 checks passed
ruff: clean
```

The webhook tests cover valid/invalid HMAC signatures, payload normalization,
and adapter enqueue/read.
