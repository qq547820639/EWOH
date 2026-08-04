---
workItemIds: T-096
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

# EWOH Round 14 Evidence - Mobile Workbench UI

Date: 2026-08-03
Scope: frontend mobile workbench page/PWA-ready route.

## Changes Landed

- New React page `client/src/pages/MobileWorkbench/MobileWorkbench.tsx`:
  - QR/order scan input to load a work order.
  - Assigned pending/in-progress step list for the current user.
  - Step action buttons: 开工 / 报工 / 审核 / 交收, wired to the mobile API.
  - Work order status and step status badges.
- API client `client/src/api/mobile.ts` and React Query keys.
- Navigation item `/mobile-workbench` visible to
  `global_admin`, `dispatcher`, `workshop_lead`, `device_ops`.
- Client test coverage for the navigation entry; full client suite passes.

## Verification Results

- Client Jest: 6 suites / 20 tests passed.
- NestJS Jest: 51 suites / 203 tests passed.
- HTTP + PostgreSQL E2E: 17/17.
- OpenAPI: 134/134.
- `RELEASE DRILL PASSED` including standalone client build.

## Next Steps

- PWA manifest/offline shell and real-device mobile testing.
- Production ERP gateway and field acceptance remain external gates.
