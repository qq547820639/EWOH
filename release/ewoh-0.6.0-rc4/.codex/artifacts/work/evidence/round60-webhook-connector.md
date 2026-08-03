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
