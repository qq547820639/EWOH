# Data Contract (frozen v1.1)

Owner: AG-03
Status: Frozen (C1 v1.1, 2026-08-03)
Source: authoritative-plan Final 3.0 tables 75-80; live DB probe 2026-08-03

## Physical Packaging

Authoritative execution packaging: 36 new CREATE + 12 existing ALTER = 48
managed tables. Historical logical model used "48 new + 3 altered"; table 77
lists 38 logical new names. Resolution: every frozen logical capability maps
to a physical table, an existing-table extension, or a Service aggregate. The
DDL generator must output the capability-to-physical-table matrix before
freezing DDL. Table-count parity alone is not acceptance.

## Existing Physical Tables (workspace_aadknm4yzbyds, confirmed_current)

18 relations exist: ewoh_ai_suggestion, ewoh_device, ewoh_device_binding,
ewoh_device_config, ewoh_environment, ewoh_event, ewoh_event_chain,
ewoh_model_registry, ewoh_organization, ewoh_personnel,
ewoh_production_task, ewoh_schedule_audit, ewoh_schedule_plan,
ewoh_scheduler_config, ewoh_spatial_entity, ewoh_telemetry, ewoh_topology,
ewoh_world_state.

Gaps: most tables lack org_id; no unified audit hash chain; no
world_snapshot/delta_log; no control/task-step/resource/approval/alert/
knowledge/notification/system_config/event_rule tables.

## Logical Table Families

| Domain | Tables |
|--------|--------|
| Organization | ewoh_organization, ewoh_person, ewoh_person_skill, ewoh_skill, ewoh_role, ewoh_person_role |
| Device | ewoh_device_person_binding, ewoh_device_capability |
| Spatial | ewoh_spatial_relation, ewoh_spatial_hierarchy |
| Model | ewoh_model_asset, ewoh_model_binding |
| Workstation | ewoh_workstation, ewoh_workstation_device, ewoh_workstation_person, ewoh_workstation_skill, ewoh_workstation_relation |
| Task | ewoh_task_template, ewoh_task_step, ewoh_task_skill_req |
| Schedule | ewoh_schedule_task, ewoh_schedule_task_step, ewoh_schedule_assignment |
| Resource | ewoh_resource_preorder, ewoh_resource_binding |
| Control | ewoh_control_request, ewoh_control_command, ewoh_control_result |
| Event | ewoh_event_rule, ewoh_event_action, ewoh_event_subscription |
| World | ewoh_world_snapshot, ewoh_world_delta_log |
| System | ewoh_system_config, ewoh_knowledge_base, ewoh_knowledge_entry, ewoh_notification, ewoh_audit_log |

## Existing-Table Alterations

12 tables require org_id + RLS + defaults backfill:
ewoh_scheduler_config, ewoh_environment, ewoh_model_registry,
ewoh_schedule_audit, ewoh_schedule_plan, ewoh_event_chain,
ewoh_world_state, ewoh_topology, ewoh_spatial_entity, ewoh_telemetry,
ewoh_event, ewoh_device.

Detailed field changes:

- ewoh_spatial_entity: add org_id, z, roll, pitch, bbox_d, model_node_id,
  model_version_id, coordinate_system, coordinate_origin, floor_elevation, unit.
- ewoh_device: add org_id, lifecycle_status, runtime_status, health_status,
  device_category, extra; worker_name remains compatible but new code must not
  read/write it.
- ewoh_schedule_plan: add org_id, suggestion_id, session_id, version,
  parent_plan_id, is_simulation, approval_id.

## Approval Equivalent Mapping (C1, D-010)

The frozen 48-table DDL has no physical approval table (decision D-010). The
approval domain is explicitly mapped to existing tables and was verified on
2026-08-03 via unit tests plus the HTTP/PostgreSQL E2E approval persistence
case (AG-18/AG-14). No new tables and no `db/migrations/**` changes.

| Logical capability | Physical mapping |
| --- | --- |
| Approval instance | `ewoh_event`: `event_id` = approval instance id, `event_type` = `approval_instance`, `title` = readable title, `status` = instance status, `evidence_json` = `{ entityType, entityId, createdAt }`; `org_id` via GUC default, RLS via `ewoh_org_select` |
| Approval step | `ewoh_event_chain`: `event_id` = step id, `parent_event_id` = instance id, `causal_type` = `approval_step`, `description` = JSON string `{ role, status, reason, delegateTo }`; `org_id` via GUC default |
| Approval operation | `ewoh_audit_log` via `AuditService.appendAuditLog` / `ewoh_append_audit_log`: `entity_type` = `approval`, `entity_id` = instance id, actions `approve`/`reject`/`delegate`/`skip`/`expire`/`bypass`/`cancel`, `before_json`/`after_json` record state |

Mapping rules:

- Instance and step status transitions use conditional updates (`where status =
  current status`; step status lives in `description` JSONB). Zero rows return
  `409 STATE_CONFLICT`; no TOCTOU.
- All reads/writes go through the request-scoped `DRIZZLE_DATABASE`
  (GUC/RLS); the audit actor comes from `userContext`, org from GUC.
- API response shape stays `id/entityType/entityId/status/steps/createdAt`;
  `aggregateApprovalStatus` remains a pure function.

## Rules

- Primary/business tables: id uuid primary key default gen_random_uuid();
  business id varchar(255) unique not null.
- All managed tables carry org_id except world_snapshot/delta_log special
  cases and audit_log policy noted in the security contract.
- Quantities numeric(18,4); never real for inventory/reservation/issue.
- No physical foreign keys; Service layer validates logical references and
  types.
- world_delta_log.seq and audit_log.audit_seq are bigint generated always as
  identity.
- Soft delete for master data; binding ends via end_time/status; logs follow
  retention policy.
- All DDL is re-entrant (IF EXISTS / IF NOT EXISTS) with rollback scripts.

## Retention

Detailed delta 7d; snapshots 90d; person precise trajectory 30d then
aggregated; device trajectory 90d; alerts+evidence 365d; audit hot 365d then
archive. Person data at 30-90d is region-level de-identified aggregate.
