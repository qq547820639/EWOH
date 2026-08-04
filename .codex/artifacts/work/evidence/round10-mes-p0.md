---
workItemIds: T-091,T-092
kind: test
result: passed
commitSha: dee6503effd7c4cea76dbb1d7ce30054d366f0cb
branch: main
buildVersion: 0.6.0-rc4
envFingerprint: 5fe7c6feb11e2726634abc7e27cd90a86f694b21422960b4c3d7f6c71d1facce
dependencyVersion: 3:2.2.5
producedAt: 2026-08-04T05:35:50.594Z
command: "npm run test:e2e"
suite: http-e2e
startedAt: 2026-08-04T05:35:50.594Z
completedAt: 2026-08-04T05:35:50.594Z
artifactChecksum: 5890c6a439b06e6af6eccbbe29040bb14a9563cbb897f17ccbdd0a27c70518a1
expiresAt: 2026-11-02T05:35:50.594Z
verifier: "EWOH independent verification agent"
---

# EWOH Round 10 Evidence - Final 4.0 Adoption and MES P0

Date: 2026-08-03
Scope: Final 4.0 master baseline adoption and WP-MES-01 production execution
closed loop.

## Changes Landed

- `EWOH...编排方案_最新研究升级版.docx` Final 4.0 adopted as master baseline;
  Final 3.0 kept as `authoritative-plan-final3.txt`, Final 4.0 stored in
  `authoritative-plan-final4.txt`, and the docx copied to
  `delivery/01_开发基线/`.
- D-011/D-012/D-013 recorded: Final 4.0 supersedes, MES P0 is next critical
  path, and MES maps to existing physical tables so the 48-table packaging is
  unchanged.
- New `MesModule`:
  - Work order create/list/detail.
  - Work order state machine `draft -> released -> in_progress -> completed`,
    with cancel.
  - Step state machine `pending -> in_progress -> reported -> reviewed ->
    handed_over`, with pause/resume/cancel.
  - Material consumption persisted to `ewoh_resource_binding` with audit.
  - Quality inspection persisted to step `result_json` plus
    `ewoh_event`/audit.
- Drizzle schema now exposes `ewoh_schedule_task`,
  `ewoh_schedule_task_step`, `ewoh_resource_binding`, `ewoh_task_template`,
  and `ewoh_task_step`.
- OpenAPI: 8 new MES routes and schemas.

## Verification Results

- NestJS Jest: 48 suites / 190 tests passed.
- HTTP + PostgreSQL E2E: 15/15, including a complete MES work order flow:
  create -> release -> start -> step start/report/inspection/review/handover
  -> material consumption -> complete, with org scoping and audit verified in
  PostgreSQL.
- OpenAPI strict audit: 116/116 documented, 0 unimplemented.
- `npm run lint`: passed.
- Final 4.0 text is machine-readable at
  `.codex/artifacts/authoritative-plan-final4.txt`.

## Next Steps

- OEE/andon work package (WP-OEE-01) and quality traceability extension.
- ERP connector skeleton (WP-ERP-01) with idempotent inbound/outbound queues.
- Mobile workbench and frontend pages for MES work orders.
