---
workItemIds: T-093
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

# EWOH Round 11 Evidence - OEE and Andon

Date: 2026-08-03
Scope: WP-OEE-01 device status timeline, OEE calculation, and andon SLA
escalation.

## Changes Landed

- `OeeModule` adds:
  - Device status timeline records persisted to `ewoh_event` with status,
    reason, start/end, duration, output quantity, and source type.
  - OEE calculation from status durations with downtime breakdown and quality
    adjustment from quality inspection events.
  - Andon open/list/transition with state machine
    `open -> acknowledged -> processing -> closed` and reopen.
  - SLA escalation: acknowledgment beyond `slaSeconds` creates an
    `ewoh_notification` row and marks `escalationLevel=1` in evidence.
- Drizzle schema now exposes `ewoh_notification`; no physical table changes
  were required, so the 48-table packaging remains unchanged.
- OpenAPI: 7 new OEE routes and schemas.

## Verification Results

- NestJS Jest: 49 suites / 196 tests passed.
- HTTP + PostgreSQL E2E: 16/16, including device status recording, OEE
  calculation (0.6 availability), andon SLA escalation notification, and
  close with org scoping.
- OpenAPI strict audit: 123/123 documented, 0 unimplemented.
- `npm run lint`: passed.

## Next Steps

- Quality traceability graph and ERP connector (WP-ERP-01).
- Mobile workbench and frontend pages for OEE/andon.
