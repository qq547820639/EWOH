# EWOH Round 12 Evidence - ERP Connector

Date: 2026-08-03
Scope: WP-ERP-01 idempotent inbound/outbound connector and reconciliation.

## Changes Landed

- `ErpModule` adds:
  - Inbound ERP order reception with `externalOrderId` idempotency; creates an
    `ERP_ORDER` event and an ERP-sourced work order with a production step.
  - Outbound message queue (`production_report`,
    `material_consumption`, `inventory_receipt`) with `outboundId`
    idempotency and `pending -> sent/failed` acknowledgment transitions.
  - `POST /api/erp/reconcile` returns order/outbound status counts and
    completed ERP work orders.
- All records map to existing `ewoh_event`, `ewoh_schedule_task`, and
  `ewoh_schedule_task_step`; no physical table changes were required.
- OpenAPI: 6 new ERP routes and schemas.

## Verification Results

- NestJS Jest: 50 suites / 201 tests passed.
- HTTP + PostgreSQL E2E: 17/17, including duplicate order idempotency,
  outbound ack, reconcile, and org scoping in PostgreSQL.
- OpenAPI strict audit: 129/129 documented, 0 unimplemented.
- `npm run lint`: passed.

## Next Steps

- Quality traceability graph and mobile workbench.
- Production ERP gateway with real credentials remains an external gate.
