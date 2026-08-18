#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const { createRequire } = require('module');

const root = path.resolve(__dirname, '..', '..');
const appDir = path.join(root, 'ewoh-spark-app');
const requireFromApp = createRequire(path.join(appDir, 'package.json'));

const FILES = {
  migration: path.join(root, 'db/migrations/001_ewoh_managed_tables.sql'),
  rollback: path.join(root, 'db/migrations/001_ewoh_managed_tables.rollback.sql'),
  verify: path.join(root, 'db/verify/001_verify.sql'),
  seed: path.join(root, 'db/seed/001_demo_seed.sql'),
  users: path.join(root, 'db/migrations/002_ewoh_users.sql'),
  users_rollback: path.join(root, 'db/migrations/002_ewoh_users.rollback.sql'),
  users_seed: path.join(root, 'db/seed/002_default_admin.sql'),
  users_verify: path.join(root, 'db/verify/002_ewoh_users_verify.sql'),
  standalone_users_verify: path.join(root, 'db/verify/standalone_002_users_verify.sql'),
  standalone_runtime_role_verify: path.join(root, 'db/verify/standalone_003_runtime_role_verify.sql'),
  standalone_scheduling_persistence_verify: path.join(root, 'db/verify/standalone_007_scheduling_persistence_verify.sql'),
  standalone_phase2_realtime_verify: path.join(root, 'db/verify/standalone_008_phase2_realtime_verify.sql'),
  standalone: path.join(root, 'db/migrations/standalone_001_schema.sql'),
  standalone_rollback: path.join(root, 'db/migrations/standalone_001_schema.rollback.sql'),
  standalone_verify: path.join(root, 'db/verify/standalone_001_verify.sql'),
  standalone_seed: path.join(root, 'db/seed/standalone_001_seed.sql'),
  standalone_users: path.join(root, 'db/migrations/standalone_002_users.sql'),
  standalone_users_rollback: path.join(root, 'db/migrations/standalone_002_users.rollback.sql'),
  standalone_runtime_role: path.join(root, 'db/migrations/standalone_003_runtime_role.sql'),
  standalone_runtime_role_rollback: path.join(root, 'db/migrations/standalone_003_runtime_role.rollback.sql'),
  standalone_domain: path.join(root, 'db/migrations/standalone_004_ewoh_domain.sql'),
  standalone_domain_rollback: path.join(root, 'db/migrations/standalone_004_ewoh_domain.rollback.sql'),
  standalone_domain_verify: path.join(root, 'db/verify/standalone_004_verify.sql'),
  standalone_admin: path.join(root, 'db/seed/standalone_002_admin.sql'),
  standalone_workbench_prod: path.join(root, 'db/migrations/standalone_005_workbench_prod.sql'),
  standalone_workbench_prod_rollback: path.join(root, 'db/migrations/standalone_005_workbench_prod.rollback.sql'),
  standalone_workbench_prod_verify: path.join(root, 'db/verify/standalone_005_verify.sql'),
  standalone_scheduling: path.join(root, 'db/migrations/standalone_006_scheduling.sql'),
  standalone_scheduling_persistence: path.join(root, 'db/migrations/standalone_007_scheduling_persistence.sql'),
  standalone_scheduling_persistence_rollback: path.join(root, 'db/migrations/standalone_007_scheduling_persistence.rollback.sql'),
  standalone_phase2_realtime: path.join(root, 'db/migrations/standalone_008_phase2_realtime.sql'),
  standalone_phase2_realtime_rollback: path.join(root, 'db/migrations/standalone_008_phase2_realtime.rollback.sql'),
  standalone_scheduling_rollback: path.join(root, 'db/migrations/standalone_006_scheduling.rollback.sql'),
  standalone_scheduling_verify: path.join(root, 'db/verify/standalone_006_verify.sql'),
  standalone_scheduling_seed: path.join(root, 'db/seed/standalone_006_scheduling_seed.sql'),
  standalone_reservation_conflict: path.join(root, 'db/migrations/standalone_009_reservation_conflict.sql'),
  standalone_reservation_conflict_rollback: path.join(root, 'db/migrations/standalone_009_reservation_conflict.rollback.sql'),
  standalone_reservation_conflict_verify: path.join(root, 'db/verify/standalone_009_verify.sql'),
  standalone_scheduling_feedback: path.join(root, 'db/migrations/standalone_010_scheduling_feedback.sql'),
  standalone_scheduling_feedback_rollback: path.join(root, 'db/migrations/standalone_010_scheduling_feedback.rollback.sql'),
  standalone_scheduling_feedback_verify: path.join(root, 'db/verify/standalone_010_verify.sql'),
  standalone_outbox_sequence: path.join(root, 'db/migrations/standalone_011_outbox_sequence.sql'),
  standalone_outbox_sequence_rollback: path.join(root, 'db/migrations/standalone_011_outbox_sequence.rollback.sql'),
  standalone_outbox_sequence_verify: path.join(root, 'db/verify/standalone_011_verify.sql'),
  standalone_domain_columns: path.join(root, 'db/migrations/standalone_012_domain_columns.sql'),
  standalone_domain_columns_rollback: path.join(root, 'db/migrations/standalone_012_domain_columns.rollback.sql'),
  standalone_domain_columns_verify: path.join(root, 'db/verify/standalone_012_domain_columns.verify.sql'),
  standalone_route_cost_matrix: path.join(root, 'db/migrations/standalone_015_route_cost_matrix.sql'),
  standalone_route_cost_matrix_rollback: path.join(root, 'db/migrations/standalone_015_route_cost_matrix.rollback.sql'),
  standalone_route_cost_matrix_verify: path.join(root, 'db/verify/standalone_015_route_cost_matrix.verify.sql'),
  standalone_policy_weights: path.join(root, 'db/migrations/standalone_014_policy_weights.sql'),
  standalone_policy_weights_rollback: path.join(root, 'db/migrations/standalone_014_policy_weights.rollback.sql'),
  standalone_policy_weights_verify: path.join(root, 'db/verify/standalone_014_policy_weights.verify.sql'),
  standalone_conflict_lifecycle: path.join(root, 'db/migrations/standalone_013_conflict_lifecycle.sql'),
  standalone_conflict_lifecycle_rollback: path.join(root, 'db/migrations/standalone_013_conflict_lifecycle.rollback.sql'),
  standalone_conflict_lifecycle_verify: path.join(root, 'db/verify/standalone_013_conflict_lifecycle.verify.sql'),
  standalone_task_requirement: path.join(root, 'db/migrations/standalone_016_task_requirement.sql'),
  standalone_task_requirement_rollback: path.join(root, 'db/migrations/standalone_016_task_requirement.rollback.sql'),
  standalone_task_requirement_verify: path.join(root, 'db/verify/standalone_016_task_requirement.verify.sql'),
  standalone_scheduling_tables_fix: path.join(root, 'db/migrations/standalone_017_scheduling_tables_fix.sql'),
  standalone_scheduling_tables_fix_rollback: path.join(root, 'db/migrations/standalone_017_scheduling_tables_fix.rollback.sql'),
  standalone_scheduling_tables_fix_verify: path.join(root, 'db/verify/standalone_017_scheduling_tables_fix.verify.sql'),
  standalone_execution_feedback: path.join(root, 'db/migrations/standalone_018_execution_feedback.sql'),
  standalone_execution_feedback_rollback: path.join(root, 'db/migrations/standalone_018_execution_feedback.rollback.sql'),
  standalone_execution_feedback_verify: path.join(root, 'db/verify/standalone_018_execution_feedback.verify.sql'),
  standalone_kpi_replay: path.join(root, 'db/migrations/standalone_019_kpi_replay.sql'),
  standalone_kpi_replay_rollback: path.join(root, 'db/migrations/standalone_019_kpi_replay.rollback.sql'),
  standalone_kpi_replay_verify: path.join(root, 'db/verify/standalone_019_kpi_replay.verify.sql'),
  standalone_policy_lifecycle: path.join(root, 'db/migrations/standalone_020_policy_lifecycle.sql'),
  standalone_policy_lifecycle_rollback: path.join(root, 'db/migrations/standalone_020_policy_lifecycle.rollback.sql'),
  standalone_policy_lifecycle_verify: path.join(root, 'db/verify/standalone_020_policy_lifecycle.verify.sql'),
  standalone_sse_envelope: path.join(root, 'db/migrations/standalone_021_sse_envelope.sql'),
  standalone_sse_envelope_rollback: path.join(root, 'db/migrations/standalone_021_sse_envelope.rollback.sql'),
  standalone_sse_envelope_verify: path.join(root, 'db/verify/standalone_021_sse_envelope.verify.sql'),
  standalone_reservation_capacity: path.join(root, 'db/migrations/standalone_022_reservation_capacity.sql'),
  standalone_reservation_capacity_rollback: path.join(root, 'db/migrations/standalone_022_reservation_capacity.rollback.sql'),
  standalone_reservation_capacity_verify: path.join(root, 'db/verify/standalone_022_reservation_capacity.verify.sql'),
  standalone_scheduler_incremental: path.join(root, 'db/migrations/standalone_023_scheduler_incremental.sql'),
  standalone_scheduler_incremental_rollback: path.join(root, 'db/migrations/standalone_023_scheduler_incremental.rollback.sql'),
  standalone_scheduler_incremental_verify: path.join(root, 'db/verify/standalone_023_scheduler_incremental.verify.sql'),
  standalone_scheduler_outbox_notify: path.join(root, 'db/migrations/standalone_024_scheduler_outbox_notify.sql'),
  standalone_scheduler_outbox_notify_rollback: path.join(root, 'db/migrations/standalone_024_scheduler_outbox_notify.rollback.sql'),
  standalone_scheduler_outbox_notify_verify: path.join(root, 'db/verify/standalone_024_scheduler_outbox_notify.verify.sql'),
  standalone_scheduler_rls: path.join(root, 'db/migrations/standalone_025_scheduler_rls.sql'),
  standalone_scheduler_rls_rollback: path.join(root, 'db/migrations/standalone_025_scheduler_rls.rollback.sql'),
  standalone_scheduler_rls_verify: path.join(root, 'db/verify/standalone_025_scheduler_rls.verify.sql'),
  standalone_route_cost_matrix_full_key: path.join(root, 'db/migrations/standalone_026_route_cost_matrix_full_key.sql'),
  standalone_route_cost_matrix_full_key_rollback: path.join(root, 'db/migrations/standalone_026_route_cost_matrix_full_key.rollback.sql'),
  standalone_route_cost_matrix_full_key_verify: path.join(root, 'db/verify/standalone_026_route_cost_matrix_full_key.verify.sql'),
  standalone_resource_time_windows: path.join(root, 'db/migrations/standalone_027_resource_time_windows.sql'),
  standalone_resource_time_windows_rollback: path.join(root, 'db/migrations/standalone_027_resource_time_windows.rollback.sql'),
  standalone_resource_time_windows_verify: path.join(root, 'db/verify/standalone_027_resource_time_windows.verify.sql'),
  standalone_assignment_event_tenancy: path.join(root, 'db/migrations/standalone_028_assignment_event_tenancy.sql'),
  standalone_assignment_event_tenancy_rollback: path.join(root, 'db/migrations/standalone_028_assignment_event_tenancy.rollback.sql'),
  standalone_assignment_event_tenancy_verify: path.join(root, 'db/verify/standalone_028_assignment_event_tenancy.verify.sql'),
  standalone_prediction_shadow_observation: path.join(root, 'db/migrations/standalone_029_prediction_shadow_observation.sql'),
  standalone_prediction_shadow_observation_rollback: path.join(root, 'db/migrations/standalone_029_prediction_shadow_observation.rollback.sql'),
  standalone_prediction_shadow_observation_verify: path.join(root, 'db/verify/standalone_029_prediction_shadow_observation.verify.sql'),
  standalone_solver_activation: path.join(root, 'db/migrations/standalone_030_solver_activation.sql'),
  standalone_solver_activation_rollback: path.join(root, 'db/migrations/standalone_030_solver_activation.rollback.sql'),
  standalone_solver_activation_verify: path.join(root, 'db/verify/standalone_030_solver_activation.verify.sql'),
  standalone_snapshot_version_counter: path.join(root, 'db/migrations/standalone_031_snapshot_version_counter.sql'),
  standalone_snapshot_version_counter_rollback: path.join(root, 'db/migrations/standalone_031_snapshot_version_counter.rollback.sql'),
  standalone_snapshot_version_counter_verify: path.join(root, 'db/verify/standalone_031_snapshot_version_counter.verify.sql'),
  standalone_identity_mapping: path.join(root, 'db/migrations/standalone_032_identity_mapping.sql'),
  standalone_identity_mapping_rollback: path.join(root, 'db/migrations/standalone_032_identity_mapping.rollback.sql'),
  standalone_identity_mapping_verify: path.join(root, 'db/verify/standalone_032_identity_mapping.verify.sql'),
  standalone_maintenance_quality: path.join(root, 'db/migrations/standalone_034_maintenance_quality.sql'),
  standalone_maintenance_quality_rollback: path.join(root, 'db/migrations/standalone_034_maintenance_quality.rollback.sql'),
  standalone_maintenance_quality_verify: path.join(root, 'db/verify/standalone_034_maintenance_quality.verify.sql'),
  standalone_work_order: path.join(root, 'db/migrations/standalone_035_work_order.sql'),
  standalone_work_order_rollback: path.join(root, 'db/migrations/standalone_035_work_order.rollback.sql'),
  standalone_work_order_verify: path.join(root, 'db/verify/standalone_035_work_order.verify.sql'),
  standalone_event_dedup: path.join(root, 'db/migrations/standalone_036_event_dedup.sql'),
  standalone_event_dedup_rollback: path.join(root, 'db/migrations/standalone_036_event_dedup.rollback.sql'),
  standalone_event_dedup_verify: path.join(root, 'db/verify/standalone_036_event_dedup.verify.sql'),
  standalone_agent_manifest: path.join(root, 'db/migrations/standalone_037_agent_manifest.sql'),
  standalone_agent_manifest_rollback: path.join(root, 'db/migrations/standalone_037_agent_manifest.rollback.sql'),
  standalone_agent_manifest_verify: path.join(root, 'db/verify/standalone_037_agent_manifest.verify.sql'),
  standalone_agent_task: path.join(root, 'db/migrations/standalone_038_agent_task.sql'),
  standalone_agent_task_rollback: path.join(root, 'db/migrations/standalone_038_agent_task.rollback.sql'),
  standalone_agent_task_verify: path.join(root, 'db/verify/standalone_038_agent_task.verify.sql'),
  standalone_knowledge_entry: path.join(root, 'db/migrations/standalone_039_knowledge_entry.sql'),
  standalone_knowledge_entry_rollback: path.join(root, 'db/migrations/standalone_039_knowledge_entry.rollback.sql'),
  standalone_knowledge_entry_verify: path.join(root, 'db/verify/standalone_039_knowledge_entry.verify.sql'),
  standalone_inference_result: path.join(root, 'db/migrations/standalone_040_inference_result.sql'),
  standalone_inference_result_rollback: path.join(root, 'db/migrations/standalone_040_inference_result.rollback.sql'),
  standalone_inference_result_verify: path.join(root, 'db/verify/standalone_040_inference_result.verify.sql'),
  standalone_learning_evaluation: path.join(root, 'db/migrations/standalone_041_learning_evaluation.sql'),
  standalone_learning_evaluation_rollback: path.join(root, 'db/migrations/standalone_041_learning_evaluation.rollback.sql'),
  standalone_learning_evaluation_verify: path.join(root, 'db/verify/standalone_041_learning_evaluation.verify.sql'),
  standalone_trace_span: path.join(root, 'db/migrations/standalone_042_trace_span.sql'),
  standalone_trace_span_rollback: path.join(root, 'db/migrations/standalone_042_trace_span.rollback.sql'),
  standalone_trace_span_verify: path.join(root, 'db/verify/standalone_042_trace_span.verify.sql'),
  standalone_dead_letter: path.join(root, 'db/migrations/standalone_043_dead_letter.sql'),
  standalone_dead_letter_rollback: path.join(root, 'db/migrations/standalone_043_dead_letter.rollback.sql'),
  standalone_dead_letter_verify: path.join(root, 'db/verify/standalone_043_dead_letter.verify.sql'),
  standalone_simulation_run: path.join(root, 'db/migrations/standalone_044_simulation_run.sql'),
  standalone_simulation_run_rollback: path.join(root, 'db/migrations/standalone_044_simulation_run.rollback.sql'),
  standalone_simulation_run_verify: path.join(root, 'db/verify/standalone_044_simulation_run.verify.sql'),
  standalone_learning_proposal: path.join(root, 'db/migrations/standalone_045_learning_proposal.sql'),
  standalone_exo_session: path.join(root, 'db/migrations/standalone_046_exo_session.sql'),
  standalone_outcome_annotation: path.join(root, 'db/migrations/standalone_047_outcome_annotation.sql'),
  standalone_shadow_plan_isolation: path.join(root, 'db/migrations/standalone_048_shadow_plan_isolation.sql'),
  standalone_agent_approval: path.join(root, 'db/migrations/standalone_049_agent_approval.sql'),
  standalone_decision_records: path.join(root, 'db/migrations/standalone_050_decision_records.sql'),
  standalone_exo_config: path.join(root, 'db/migrations/standalone_051_exo_config.sql'),
  standalone_agent_approval_decision: path.join(root, 'db/migrations/standalone_052_agent_approval_decision.sql'),
  standalone_learning_proposal_decision: path.join(root, 'db/migrations/standalone_053_learning_proposal_decision.sql'),
  standalone_policy_activation_decision: path.join(root, 'db/migrations/standalone_054_policy_activation_decision.sql'),
  standalone_route_org_isolation: path.join(root, 'db/migrations/standalone_056_route_org_isolation.sql'),
  standalone_rls_null_reject: path.join(root, 'db/migrations/standalone_057_rls_null_reject.sql'),
  standalone_rls_null_reject_rollback: path.join(root, 'db/migrations/standalone_057_rls_null_reject.rollback.sql'),
  standalone_rls_null_reject_verify: path.join(root, 'db/verify/standalone_057_rls_null_reject.verify.sql'),
  // R2-DBM-002：058/059 迁移补接入 runner（此前只落了 SQL 文件，无 FILES 键/命令/verify）。
  standalone_control_attempt_unique: path.join(root, 'db/migrations/standalone_058_control_attempt_unique.sql'),
  standalone_control_attempt_unique_rollback: path.join(root, 'db/migrations/standalone_058_control_attempt_unique.rollback.sql'),
  standalone_control_attempt_unique_verify: path.join(root, 'db/verify/standalone_058_control_attempt_unique.verify.sql'),
  standalone_spatial_entity_org_unique: path.join(root, 'db/migrations/standalone_059_spatial_entity_org_unique.sql'),
  standalone_spatial_entity_org_unique_rollback: path.join(root, 'db/migrations/standalone_059_spatial_entity_org_unique.rollback.sql'),
  standalone_spatial_entity_org_unique_verify: path.join(root, 'db/verify/standalone_059_spatial_entity_org_unique.verify.sql'),
  // R2-SDB-006：幂等键租户维度（org_id + 复合唯一 + RLS）。
  standalone_idempotency_org: path.join(root, 'db/migrations/standalone_060_idempotency_org.sql'),
  standalone_idempotency_org_rollback: path.join(root, 'db/migrations/standalone_060_idempotency_org.rollback.sql'),
  standalone_idempotency_org_verify: path.join(root, 'db/verify/standalone_060_idempotency_org.verify.sql'),
  standalone_learning_proposal_rollback: path.join(root, 'db/migrations/standalone_045_learning_proposal.rollback.sql'),
  standalone_exo_session_rollback: path.join(root, 'db/migrations/standalone_046_exo_session.rollback.sql'),
  standalone_outcome_annotation_rollback: path.join(root, 'db/migrations/standalone_047_outcome_annotation.rollback.sql'),
  standalone_shadow_plan_isolation_rollback: path.join(root, 'db/migrations/standalone_048_shadow_plan_isolation.rollback.sql'),
  standalone_agent_approval_rollback: path.join(root, 'db/migrations/standalone_049_agent_approval.rollback.sql'),
  standalone_decision_records_rollback: path.join(root, 'db/migrations/standalone_050_decision_records.rollback.sql'),
  standalone_exo_config_rollback: path.join(root, 'db/migrations/standalone_051_exo_config.rollback.sql'),
  standalone_agent_approval_decision_rollback: path.join(root, 'db/migrations/standalone_052_agent_approval_decision.rollback.sql'),
  standalone_learning_proposal_decision_rollback: path.join(root, 'db/migrations/standalone_053_learning_proposal_decision.rollback.sql'),
  standalone_policy_activation_decision_rollback: path.join(root, 'db/migrations/standalone_054_policy_activation_decision.rollback.sql'),
  standalone_route_org_isolation_rollback: path.join(root, 'db/migrations/standalone_056_route_org_isolation.rollback.sql'),
  standalone_learning_proposal_verify: path.join(root, 'db/verify/standalone_045_learning_proposal.verify.sql'),
  standalone_exo_session_verify: path.join(root, 'db/verify/standalone_046_exo_session.verify.sql'),
  standalone_outcome_annotation_verify: path.join(root, 'db/verify/standalone_047_outcome_annotation.verify.sql'),
  standalone_shadow_plan_isolation_verify: path.join(root, 'db/verify/standalone_048_shadow_plan_isolation.verify.sql'),
  standalone_agent_approval_verify: path.join(root, 'db/verify/standalone_049_agent_approval.verify.sql'),
  standalone_decision_records_verify: path.join(root, 'db/verify/standalone_050_decision_records.verify.sql'),
  standalone_exo_config_verify: path.join(root, 'db/verify/standalone_051_exo_config.verify.sql'),
  standalone_agent_approval_decision_verify: path.join(root, 'db/verify/standalone_052_agent_approval_decision.verify.sql'),
  standalone_learning_proposal_decision_verify: path.join(root, 'db/verify/standalone_053_learning_proposal_decision.verify.sql'),
  standalone_policy_activation_decision_verify: path.join(root, 'db/verify/standalone_054_policy_activation_decision.verify.sql'),
  standalone_route_org_isolation_verify: path.join(root, 'db/verify/standalone_056_route_org_isolation.verify.sql'),
};

const PLAN_NAMES = Object.freeze(Object.keys(FILES));
const ROLLBACK_COMMANDS = new Set([
  '--rollback',
  '--rollback-users',
  '--rollback-standalone',
  '--rollback-standalone-users',
  '--rollback-standalone-runtime-role',
  '--rollback-standalone-domain',
  '--rollback-standalone-workbench-prod',
  '--rollback-standalone-scheduling',
  '--rollback-standalone-reservation-conflict',
  '--rollback-standalone-scheduling-feedback',
  '--rollback-standalone-outbox-sequence',
  '--rollback-standalone-domain-columns',
  '--rollback-standalone-route-cost-matrix',
  '--rollback-standalone-policy-weights',
  '--rollback-standalone-conflict-lifecycle',
  '--rollback-standalone-task-requirement',
  '--rollback-standalone-scheduling-tables-fix',
  '--rollback-standalone-execution-feedback',
  '--rollback-standalone-kpi-replay',
  '--rollback-standalone-policy-lifecycle',
  '--rollback-standalone-sse-envelope',
  '--rollback-standalone-reservation-capacity',
  '--rollback-standalone-scheduler-incremental',
  '--rollback-standalone-scheduler-outbox-notify',
  '--rollback-standalone-scheduler-rls',
  '--rollback-standalone-route-cost-matrix-full-key',
  '--rollback-standalone-resource-time-windows',
  '--rollback-standalone-assignment-event-tenancy',
  '--rollback-standalone-prediction-shadow-observation',
  '--rollback-standalone-snapshot-version-counter',
  '--rollback-standalone-solver-activation',
  '--rollback-standalone-identity-mapping',
  '--rollback-standalone-maintenance-quality',
  '--rollback-standalone-work-order',
  '--rollback-standalone-event-dedup',
  '--rollback-standalone-agent-manifest',
  '--rollback-standalone-agent-task',
  '--rollback-standalone-knowledge-entry',
  '--rollback-standalone-inference-result',
  '--rollback-standalone-learning-evaluation',
  '--rollback-standalone-trace-span',
  '--rollback-standalone-dead-letter',
  '--rollback-standalone-simulation-run',
  '--rollback-standalone-learning-proposal',
  '--rollback-standalone-exo-session',
  '--rollback-standalone-outcome-annotation',
  '--rollback-standalone-decision-records',
  '--rollback-standalone-exo-config',
  '--rollback-standalone-agent-approval-decision',
  '--rollback-standalone-learning-proposal-decision',
  '--rollback-standalone-policy-activation-decision',
  '--rollback-standalone-route-org-isolation',
  '--rollback-standalone-rls-null-reject',
]);
const EXECUTE_COMMANDS = new Set([
  '--apply',
  '--rollback',
  '--verify',
  '--verify-users',
  '--verify-standalone-users',
  '--verify-standalone-runtime-role',
  '--verify-standalone-scheduling-persistence',
  '--verify-standalone-phase2-realtime',
  '--seed',
  '--apply-users',
  '--rollback-users',
  '--seed-users',
  '--apply-standalone',
  '--rollback-standalone',
  '--verify-standalone',
  '--seed-standalone',
  '--apply-standalone-users',
  '--rollback-standalone-users',
  '--apply-standalone-runtime-role',
  '--rollback-standalone-runtime-role',
  '--seed-standalone-admin',
  '--apply-standalone-domain',
  '--rollback-standalone-domain',
  '--verify-standalone-domain',
  '--apply-standalone-workbench-prod',
  '--rollback-standalone-workbench-prod',
  '--verify-standalone-workbench-prod',
  '--apply-standalone-scheduling',
  '--rollback-standalone-scheduling',
  '--verify-standalone-scheduling',
  '--seed-standalone-scheduling',
  '--apply-standalone-scheduling-persistence',
  '--rollback-standalone-scheduling-persistence',
  '--apply-standalone-phase2-realtime',
  '--rollback-standalone-phase2-realtime',
  '--apply-standalone-reservation-conflict',
  '--rollback-standalone-reservation-conflict',
  '--verify-standalone-reservation-conflict',
  '--apply-standalone-scheduling-feedback',
  '--rollback-standalone-scheduling-feedback',
  '--verify-standalone-scheduling-feedback',
  '--apply-standalone-outbox-sequence',
  '--rollback-standalone-outbox-sequence',
  '--verify-standalone-outbox-sequence',
  '--apply-standalone-domain-columns',
  '--rollback-standalone-domain-columns',
  '--verify-standalone-domain-columns',
  '--apply-standalone-route-cost-matrix',
  '--rollback-standalone-route-cost-matrix',
  '--verify-standalone-route-cost-matrix',
  '--apply-standalone-policy-weights',
  '--rollback-standalone-policy-weights',
  '--verify-standalone-policy-weights',
  '--apply-standalone-conflict-lifecycle',
  '--rollback-standalone-conflict-lifecycle',
  '--verify-standalone-conflict-lifecycle',
  '--apply-standalone-task-requirement',
  '--rollback-standalone-task-requirement',
  '--verify-standalone-task-requirement',
  '--apply-standalone-scheduling-tables-fix',
  '--rollback-standalone-scheduling-tables-fix',
  '--verify-standalone-scheduling-tables-fix',
  '--apply-standalone-execution-feedback',
  '--rollback-standalone-execution-feedback',
  '--verify-standalone-execution-feedback',
  '--apply-standalone-kpi-replay',
  '--rollback-standalone-kpi-replay',
  '--verify-standalone-kpi-replay',
  '--apply-standalone-policy-lifecycle',
  '--rollback-standalone-policy-lifecycle',
  '--verify-standalone-policy-lifecycle',
  '--apply-standalone-sse-envelope',
  '--rollback-standalone-sse-envelope',
  '--verify-standalone-sse-envelope',
  '--apply-standalone-reservation-capacity',
  '--rollback-standalone-reservation-capacity',
  '--verify-standalone-reservation-capacity',
  '--apply-standalone-scheduler-incremental',
  '--rollback-standalone-scheduler-incremental',
  '--verify-standalone-scheduler-incremental',
  '--apply-standalone-scheduler-outbox-notify',
  '--rollback-standalone-scheduler-outbox-notify',
  '--verify-standalone-scheduler-outbox-notify',
  '--apply-standalone-scheduler-rls',
  '--rollback-standalone-scheduler-rls',
  '--verify-standalone-scheduler-rls',
  '--apply-standalone-route-cost-matrix-full-key',
  '--rollback-standalone-route-cost-matrix-full-key',
  '--verify-standalone-route-cost-matrix-full-key',
  '--apply-standalone-resource-time-windows',
  '--rollback-standalone-resource-time-windows',
  '--verify-standalone-resource-time-windows',
  '--apply-standalone-assignment-event-tenancy',
  '--rollback-standalone-assignment-event-tenancy',
  '--verify-standalone-assignment-event-tenancy',
  '--apply-standalone-prediction-shadow-observation',
  '--rollback-standalone-prediction-shadow-observation',
  '--verify-standalone-prediction-shadow-observation',
  '--apply-standalone-solver-activation',
  '--rollback-standalone-solver-activation',
  '--verify-standalone-solver-activation',
  '--apply-standalone-snapshot-version-counter',
  '--rollback-standalone-snapshot-version-counter',
  '--verify-standalone-snapshot-version-counter',
  '--apply-standalone-identity-mapping',
  '--rollback-standalone-identity-mapping',
  '--verify-standalone-identity-mapping',
  '--apply-standalone-maintenance-quality',
  '--rollback-standalone-maintenance-quality',
  '--verify-standalone-maintenance-quality',
  '--apply-standalone-work-order',
  '--rollback-standalone-work-order',
  '--verify-standalone-work-order',
  '--apply-standalone-event-dedup',
  '--rollback-standalone-event-dedup',
  '--verify-standalone-event-dedup',
  '--apply-standalone-agent-manifest',
  '--rollback-standalone-agent-manifest',
  '--verify-standalone-agent-manifest',
  '--apply-standalone-agent-task',
  '--rollback-standalone-agent-task',
  '--verify-standalone-agent-task',
  '--apply-standalone-knowledge-entry',
  '--rollback-standalone-knowledge-entry',
  '--verify-standalone-knowledge-entry',
  '--apply-standalone-inference-result',
  '--rollback-standalone-inference-result',
  '--verify-standalone-inference-result',
  '--apply-standalone-learning-evaluation',
  '--rollback-standalone-learning-evaluation',
  '--verify-standalone-learning-evaluation',
  '--apply-standalone-trace-span',
  '--rollback-standalone-trace-span',
  '--verify-standalone-trace-span',
  '--apply-standalone-dead-letter',
  '--rollback-standalone-dead-letter',
  '--verify-standalone-dead-letter',
  '--apply-standalone-simulation-run',
  '--rollback-standalone-simulation-run',
  '--verify-standalone-simulation-run',
  '--apply-standalone-learning-proposal',
  '--rollback-standalone-learning-proposal',
  '--verify-standalone-learning-proposal',
  '--apply-standalone-exo-session',
  '--rollback-standalone-exo-session',
  '--verify-standalone-exo-session',
  '--apply-standalone-outcome-annotation',
  '--rollback-standalone-outcome-annotation',
  '--verify-standalone-outcome-annotation',
  '--apply-standalone-decision-records',
  '--rollback-standalone-decision-records',
  '--verify-standalone-decision-records',
  '--apply-standalone-exo-config',
  '--rollback-standalone-exo-config',
  '--verify-standalone-exo-config',
  '--apply-standalone-agent-approval-decision',
  '--rollback-standalone-agent-approval-decision',
  '--verify-standalone-agent-approval-decision',
  '--apply-standalone-learning-proposal-decision',
  '--rollback-standalone-learning-proposal-decision',
  '--verify-standalone-learning-proposal-decision',
  '--apply-standalone-policy-activation-decision',
  '--rollback-standalone-policy-activation-decision',
  '--verify-standalone-policy-activation-decision',
  '--apply-standalone-route-org-isolation',
  '--rollback-standalone-route-org-isolation',
  '--verify-standalone-route-org-isolation',
  '--apply-standalone-rls-null-reject',
  '--rollback-standalone-rls-null-reject',
  '--verify-standalone-rls-null-reject',
  '--apply-standalone-shadow-plan-isolation',
  '--rollback-standalone-shadow-plan-isolation',
  '--verify-standalone-shadow-plan-isolation',
  '--apply-standalone-agent-approval',
  '--rollback-standalone-agent-approval',
  '--verify-standalone-agent-approval',
  '--apply-standalone-control-attempt-unique',
  '--rollback-standalone-control-attempt-unique',
  '--verify-standalone-control-attempt-unique',
  '--apply-standalone-spatial-entity-org-unique',
  '--rollback-standalone-spatial-entity-org-unique',
  '--verify-standalone-spatial-entity-org-unique',
  '--apply-standalone-idempotency-org',
  '--rollback-standalone-idempotency-org',
  '--verify-standalone-idempotency-org',
]);

/** 简单型 verify 命令表（审计 SQL-107 抽象，2026-08-17）：单行结果、
 * 「okField === 1」断言的 verify handler 统一为表驱动，消除原先
 * FILES / EXECUTE_COMMANDS / ALLOW_DDL 列表 / handler / which 映射 5 处
 * 手工同步中的 handler 重复段。新增此类迁移只需：
 *   1) FILES 加 <key> 与 <key>_verify 路径；
 *   2) EXECUTE_COMMANDS 加 apply/rollback/verify 三个命令；
 *   3) 本表登记一行 [fileKey, okField, 成功描述]；
 *   4) which 映射加 apply/rollback 两行（verify 由本表驱动）。
 * 结构：command → [FILES key, 断言字段, VERIFY OK 描述] */
const SIMPLE_VERIFY_COMMANDS = {
  '--verify-standalone-event-dedup': ['standalone_event_dedup_verify', 'standalone_036_verified', 'standalone_036 event dedup (TENANT_SCOPED + RLS + unique + time-semantics)'],
  '--verify-standalone-agent-manifest': ['standalone_agent_manifest_verify', 'standalone_037_verified', 'standalone_037 agent manifest (TENANT_SCOPED + RLS + CHECK + unique)'],
  '--verify-standalone-agent-task': ['standalone_agent_task_verify', 'standalone_038_verified', 'standalone_038 agent task (TENANT_SCOPED + RLS + CHECK + unique)'],
  '--verify-standalone-knowledge-entry': ['standalone_knowledge_entry_verify', 'standalone_039_verified', 'standalone_039 knowledge entry (TENANT_SCOPED + RLS + scope CHECK + unique)'],
  '--verify-standalone-inference-result': ['standalone_inference_result_verify', 'standalone_040_verified', 'standalone_040 inference result (TENANT_SCOPED + RLS + CHECK + unique)'],
  '--verify-standalone-learning-evaluation': ['standalone_learning_evaluation_verify', 'standalone_041_verified', 'standalone_041 learning evaluation (TENANT_SCOPED + RLS + CHECK + unique)'],
  '--verify-standalone-trace-span': ['standalone_trace_span_verify', 'standalone_042_verified', 'standalone_042 trace span (span checks + org/global visibility policy + unique)'],
  '--verify-standalone-dead-letter': ['standalone_dead_letter_verify', 'standalone_043_verified', 'standalone_043 dead letter (TENANT_SCOPED + RLS + CHECK + unique)'],
  '--verify-standalone-simulation-run': ['standalone_simulation_run_verify', 'standalone_044_verified', 'standalone_044 simulation run (TENANT_SCOPED + RLS + isolation CHECK)'],
  '--verify-standalone-learning-proposal': ['standalone_learning_proposal_verify', 'standalone_045_verified', 'standalone_045 learning proposal (TENANT_SCOPED + RLS + shadow-gate/approval CHECK)'],
  '--verify-standalone-exo-session': ['standalone_exo_session_verify', 'standalone_046_verified', 'standalone_046 exo session (TENANT_SCOPED + RLS + active-unique + end CHECK)'],
  '--verify-standalone-outcome-annotation': ['standalone_outcome_annotation_verify', 'standalone_047_verified', 'standalone_047 outcome annotation (TENANT_SCOPED + RLS + registry CHECK)'],
  '--verify-standalone-shadow-plan-isolation': ['standalone_shadow_plan_isolation_verify', 'standalone_048_verified', 'standalone_048 shadow plan isolation (CHECK 纵深防御：shadow 行禁生产状态/确认事实)'],
  '--verify-standalone-agent-approval': ['standalone_agent_approval_verify', 'standalone_049_verified', 'standalone_049 agent approval (TENANT_SCOPED + RLS + status/resolved/roles CHECK + unique)'],
  '--verify-standalone-decision-records': ['standalone_decision_records_verify', 'standalone_050_verified', 'standalone_050 decision records (decision_records_json jsonb 列 + DecisionRecord 形状 roundtrip + NULL 存量语义)'],
  '--verify-standalone-exo-config': ['standalone_exo_config_verify', 'standalone_051_verified', 'standalone_051 exo config (TENANT_SCOPED + RLS exo_config_org_isolation + kind/status/mode/facts/time CHECK + unique)'],
  '--verify-standalone-agent-approval-decision': ['standalone_agent_approval_decision_verify', 'standalone_052_verified', 'standalone_052 agent approval decision (decision_json jsonb 列 + agent_approval DecisionRecord 形状 roundtrip + NULL 存量语义)'],
  '--verify-standalone-learning-proposal-decision': ['standalone_learning_proposal_decision_verify', 'standalone_053_verified', 'standalone_053 learning proposal decision (decision_json jsonb 列 + learning_proposal_activation DecisionRecord 形状 roundtrip + NULL 存量语义)'],
  '--verify-standalone-policy-activation-decision': ['standalone_policy_activation_decision_verify', 'standalone_054_verified', 'standalone_054 policy activation decision (decision_json jsonb 列 + policy_activation DecisionRecord 形状 roundtrip + NULL 存量语义)'],
  '--verify-standalone-route-org-isolation': ['standalone_route_org_isolation_verify', 'standalone_056_verified', 'standalone_056 route org isolation (route_node/edge org_id 列 + RLS org 匹配或 NULL 存量放行 + SET LOCAL GUC 可见性自证)'],
  '--verify-standalone-identity-mapping': ['standalone_identity_mapping_verify', 'standalone_032_verified', 'standalone_032 identity mapping (TENANT_SCOPED + RLS + unique)'],
  '--verify-standalone-maintenance-quality': ['standalone_maintenance_quality_verify', 'standalone_034_verified', 'standalone_034 maintenance/quality (TENANT_SCOPED + RLS + CHECK)'],
  '--verify-standalone-work-order': ['standalone_work_order_verify', 'standalone_035_verified', 'standalone_035 work order (TENANT_SCOPED + RLS + CHECK)'],
  '--verify-standalone-rls-null-reject': ['standalone_rls_null_reject_verify', 'standalone_057_verified', 'standalone_057 RLS NULL reject (policy 无 NULL 放行 + TO service_role + org_id NOT NULL + (org_id,x) 复合唯一 + ewoh_org_visible(text) 重载)'],
  // R2-DBM-002：058/059/060 verify 登记（单字段断言形态，同 SQL-103 先例）。
  '--verify-standalone-control-attempt-unique': ['standalone_control_attempt_unique_verify', 'standalone_058_verified', 'standalone_058 control attempt unique (uq_ewoh_control_command_attempt (request_id,command_key,attempt_no) 唯一且有效)'],
  '--verify-standalone-spatial-entity-org-unique': ['standalone_spatial_entity_org_unique_verify', 'standalone_059_verified', 'standalone_059 spatial entity org unique (uq_ewoh_spatial_entity_org_entity (org_id,entity_id) 唯一且有效 + 旧单列唯一已清除)'],
  '--verify-standalone-idempotency-org': ['standalone_idempotency_org_verify', 'standalone_060_verified', 'standalone_060 idempotency org (org_id NOT NULL + (org_id,scope,idempotency_key) 复合唯一 + RLS 租户隔离)'],
  // 审计 SQL-103（2026-08-17）补齐的 5 个缺失 verify 脚本，同为单字段断言形态。
  '--verify-users': ['users_verify', 'users_verified', '002_ewoh_users (ewoh_user fail-closed RLS + SECURITY DEFINER 函数受控读取)'],
  '--verify-standalone-users': ['standalone_users_verify', 'standalone_002_users_verified', 'standalone_002_users (ewoh_user fail-closed RLS + SECURITY DEFINER 函数受控读取)'],
  '--verify-standalone-runtime-role': ['standalone_runtime_role_verify', 'standalone_003_verified', 'standalone_003 runtime role (ewoh_api 最小权限 + service_role 成员 + search_path 固定)'],
  '--verify-standalone-scheduling-persistence': ['standalone_scheduling_persistence_verify', 'standalone_007_verified', 'standalone_007 scheduling persistence (plan/assignment V2 元数据列)'],
  '--verify-standalone-phase2-realtime': ['standalone_phase2_realtime_verify', 'standalone_008_verified', 'standalone_008 phase2 realtime (outbox entity 列 + sequence 索引)'],
};

/** 复杂型 verify 命令（多字段断言 / DO 块自证，保留独立 handler 分支）。 */
const COMPLEX_VERIFY_COMMANDS = [
  '--verify',
  '--verify-standalone',
  '--verify-standalone-domain',
  '--verify-standalone-workbench-prod',
  '--verify-standalone-scheduling',
  '--verify-standalone-scheduling-feedback',
  '--verify-standalone-reservation-conflict',
  '--verify-standalone-outbox-sequence',
  '--verify-standalone-domain-columns',
  '--verify-standalone-route-cost-matrix',
  '--verify-standalone-policy-weights',
  '--verify-standalone-conflict-lifecycle',
  '--verify-standalone-task-requirement',
  '--verify-standalone-scheduling-tables-fix',
  '--verify-standalone-execution-feedback',
  '--verify-standalone-kpi-replay',
  '--verify-standalone-policy-lifecycle',
  '--verify-standalone-sse-envelope',
  '--verify-standalone-reservation-capacity',
  '--verify-standalone-scheduler-incremental',
  '--verify-standalone-scheduler-outbox-notify',
  '--verify-standalone-scheduler-rls',
  '--verify-standalone-route-cost-matrix-full-key',
  '--verify-standalone-resource-time-windows',
  '--verify-standalone-assignment-event-tenancy',
  '--verify-standalone-prediction-shadow-observation',
  '--verify-standalone-snapshot-version-counter',
  '--verify-standalone-solver-activation',
];

const TOKEN = '__EWOH_SCHEMA__';
const DEFAULT_SCHEMA = 'workspace_aadknm4yzbyds';
// SCR-026: legacy 001 DDL 现使用 __EWOH_ROLE_*__ 角色占位符，运行时按 schema 名
// 派生（与 legacy Miaoda 命名 anon_<schema>/authenticated_<schema>/
// user_authenticated_<schema>/service_role_<schema> 完全一致，行为不变）。
const ROLE_TOKENS = [
  ['__EWOH_ROLE_USER_AUTHENTICATED__', (schema) => `user_authenticated_${schema}`],
  ['__EWOH_ROLE_AUTHENTICATED__', (schema) => `authenticated_${schema}`],
  ['__EWOH_ROLE_ANON__', (schema) => `anon_${schema}`],
  ['__EWOH_ROLE_SERVICE__', (schema) => `service_role_${schema}`],
];

function loadEnv() {
  try {
    const dotenv = requireFromApp('dotenv');
    for (const name of ['.env.local', '.env']) {
      const file = path.join(appDir, name);
      if (fs.existsSync(file)) dotenv.config({ path: file, quiet: true });
    }
  } catch (err) {
    // Plan mode does not need project env loading.
  }
}

function schemaName() {
  return process.env.EWOH_SCHEMA || DEFAULT_SCHEMA;
}

function validateSchema(value) {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(value)) {
    throw new Error(`Invalid EWOH_SCHEMA: ${value}`);
  }
  return value;
}

function substitute(sqlText, schema) {
  let out = sqlText.split(TOKEN).join(schema);
  for (const [roleToken, render] of ROLE_TOKENS) {
    out = out.split(roleToken).join(render(schema));
  }
  return out;
}

function read(file) {
  return fs.readFileSync(file, 'utf8');
}

/** F61-02 域表白名单：由 standalone_004_ewoh_domain.sql 单独创建、由 --verify-standalone-domain
 * 单独验证，不参与 --verify / --verify-standalone 的 managed_table_count / rls_enabled 统计。 */
const F61_02_DOMAIN_TABLES = Object.freeze([
  'ewoh_resource_locks', 'ewoh_handoffs', 'ewoh_git_sync_state',
  'ewoh_evidence_metadata', 'ewoh_factory_replication_sessions', 'ewoh_idempotency_keys',
]);

function loadManifestManagedTables() {
  const yaml = requireFromApp('js-yaml');
  const manifestPath = path.join(root, 'db/contracts/schema-manifest.yaml');
  const doc = yaml.load(read(manifestPath));
  return Array.isArray(doc && doc.managed_tables) ? doc.managed_tables : [];
}

/** Batch 8 G5：从 schema-manifest.yaml（单一事实源）派生 F61-02 域表数量。
 * 消除 verify 期望值硬编码（原固定 6），manifest 变更时 verify 自动跟随。
 * js-yaml 经 createRequire 从应用依赖加载；解析失败回退硬编码值并告警。 */
function domainTableCountFromManifest() {
  try {
    const tables = loadManifestManagedTables();
    // F61-02 域表：capability_mapping 含 domain 能力 或 domain=Scale 的 6 张持久化表。
    // 与 standalone_004_verify.sql 的 6 张表（resource_locks/handoffs/git_sync_state/
    // evidence_metadata/factory_replication_sessions/idempotency_keys）对应。
    const domainTables = tables.filter(
      (t) =>
        t &&
        Array.isArray(t.capability_mapping) &&
        t.capability_mapping.some((c) => String(c).startsWith('scale.') || String(c) === 'domain.persistence'),
    );
    // 兜底：若 manifest 无显式 domain 标记，按 004 迁移的 6 张表白名单精确匹配。
    const matched = tables.filter((t) => t && F61_02_DOMAIN_TABLES.includes(t.physical_table));
    const expected = matched.length > 0 ? matched.length : domainTables.length;
    if (expected > 0) return expected;
    console.warn('[verify] schema-manifest 未找到 F61-02 域表条目，回退硬编码 6');
    return 6;
  } catch (e) {
    console.warn(`[verify] 解析 schema-manifest 失败（${e.message}），回退硬编码 6`);
    return 6;
  }
}

/** 核心受管表数量：managed_tables 中除去 6 张 F61-02 域表后的物理表数。
 * 作为 --verify / --verify-standalone 中 managed_table_count 与 rls_enabled 的期望值，
 * 与 db/verify/001_verify.sql、db/verify/standalone_001_verify.sql 的 expected 列表一致。
 * 口径（2026-08-17 审计 SQL-109/SQL-032 更新）：manifest header managed_count=74
 * 是全量逻辑受管表数（68 核心 + 6 域表），本函数返回 68；二者是不同度量、非漂移。
 * 审计 SQL-109 修复：解析失败或条目为空时直接抛错（fail-fast）——静默回退旧值
 * （原硬编码 51）会在 manifest 损坏时以错误期望继续 verify，误报失败/掩盖漂移。 */
function coreManagedTableCountFromManifest() {
  const tables = loadManifestManagedTables();
  const core = tables.filter((t) => t && !F61_02_DOMAIN_TABLES.includes(t.physical_table));
  if (core.length === 0) {
    throw new Error('schema-manifest.yaml 解析失败或 managed_tables 为空：无法派生核心受管表数量（拒绝回退硬编码，见审计 SQL-109）');
  }
  return core.length;
}

/** 核心受管表名集合（审计 SQL-104）：与 db/verify/001_verify.sql /
 * standalone_001_verify.sql 中 expected(name) 静态列表对账，防止「manifest 删表
 * 但 verify SQL 列表未同步」时 count 巧合相等掩盖表丢失。 */
function coreManagedTableNamesFromManifest() {
  const tables = loadManifestManagedTables();
  return new Set(
    tables
      .filter((t) => t && !F61_02_DOMAIN_TABLES.includes(t.physical_table))
      .map((t) => t.physical_table),
  );
}

/** 从 verify SQL 文本提取 expected(name) AS (VALUES (...)) 静态列表（审计 SQL-104）。
 * expected CTE 在 001_verify / standalone_001_verify 中为单行（首个换行前），
 * 按行切片后提取全部单引号字面量。 */
function expectedTableNamesFromVerifySql(sqlText) {
  const marker = 'expected(name) AS (VALUES ';
  const idx = sqlText.indexOf(marker);
  if (idx === -1) return null;
  const rest = sqlText.slice(idx + marker.length);
  const lineEnd = rest.indexOf('\n');
  const chunk = lineEnd === -1 ? rest : rest.slice(0, lineEnd);
  return new Set(Array.from(chunk.matchAll(/'([^']+)'/g), (m) => m[1]));
}

function renderAdminSeed(sqlText) {
  const username = process.env.EWOH_BOOTSTRAP_ADMIN_USERNAME;
  const password = process.env.EWOH_BOOTSTRAP_ADMIN_PASSWORD;
  const displayName = process.env.EWOH_BOOTSTRAP_ADMIN_DISPLAY_NAME || username;
  if (!username || !/^[A-Za-z0-9_.@-]{3,128}$/.test(username)) {
    throw new Error('EWOH_BOOTSTRAP_ADMIN_USERNAME must be 3-128 safe characters');
  }
  if (!password || password.length < 12) {
    throw new Error('EWOH_BOOTSTRAP_ADMIN_PASSWORD must be at least 12 characters');
  }
  const bcrypt = requireFromApp('bcryptjs');
  const passwordHash = bcrypt.hashSync(password, 12);
  const escapeLiteral = (value) => String(value).replace(/'/g, "''");
  return sqlText
    .split('__EWOH_ADMIN_USERNAME__').join(escapeLiteral(username))
    .split('__EWOH_ADMIN_PASSWORD_HASH__').join(escapeLiteral(passwordHash))
    .split('__EWOH_ADMIN_DISPLAY_NAME__').join(escapeLiteral(displayName));
}

function renderRuntimeRole(sqlText) {
  const password = process.env.EWOH_API_DATABASE_PASSWORD;
  if (!password || password.length < 16) {
    throw new Error('EWOH_API_DATABASE_PASSWORD must be at least 16 characters');
  }
  const escapedPassword = password.replace(/'/g, "''");
  return sqlText.split('__EWOH_API_DATABASE_PASSWORD__').join(escapedPassword);
}

function usage() {
  console.error(`Usage: run_migrations.js --plan [${PLAN_NAMES.join('|')}]`);
  console.error('       run_migrations.js --apply | --rollback | --verify | --seed');
  console.error('       run_migrations.js --verify-users | --verify-standalone-users | --verify-standalone-runtime-role');
  console.error('       run_migrations.js --verify-standalone-scheduling-persistence | --verify-standalone-phase2-realtime | --verify-standalone-rls-null-reject');
  console.error('       run_migrations.js --apply-users | --rollback-users | --seed-users');
  console.error('       run_migrations.js --apply-standalone | --rollback-standalone | --verify-standalone | --seed-standalone');
  console.error('       run_migrations.js --apply-standalone-users | --rollback-standalone-users | --seed-standalone-admin');
  console.error('       run_migrations.js --apply-standalone-runtime-role | --rollback-standalone-runtime-role');
  console.error('       run_migrations.js --apply-standalone-domain | --rollback-standalone-domain | --verify-standalone-domain');
  console.error('       run_migrations.js --apply-standalone-workbench-prod | --rollback-standalone-workbench-prod | --verify-standalone-workbench-prod');
  console.error('       run_migrations.js --apply-standalone-scheduling | --rollback-standalone-scheduling | --verify-standalone-scheduling | --seed-standalone-scheduling');
  console.error('       run_migrations.js --apply-standalone-reservation-conflict | --rollback-standalone-reservation-conflict | --verify-standalone-reservation-conflict');
  console.error('       run_migrations.js --apply-standalone-scheduling-feedback | --rollback-standalone-scheduling-feedback | --verify-standalone-scheduling-feedback');
  console.error('       run_migrations.js --apply-standalone-outbox-sequence | --rollback-standalone-outbox-sequence | --verify-standalone-outbox-sequence');
  console.error('       run_migrations.js --apply-standalone-domain-columns | --rollback-standalone-domain-columns | --verify-standalone-domain-columns');
  console.error('       run_migrations.js --apply-standalone-route-cost-matrix | --rollback-standalone-route-cost-matrix | --verify-standalone-route-cost-matrix');
  console.error('       run_migrations.js --apply-standalone-policy-weights | --rollback-standalone-policy-weights | --verify-standalone-policy-weights');
  console.error('       run_migrations.js --apply-standalone-conflict-lifecycle | --rollback-standalone-conflict-lifecycle | --verify-standalone-conflict-lifecycle');
  console.error('       run_migrations.js --apply-standalone-task-requirement | --rollback-standalone-task-requirement | --verify-standalone-task-requirement');
  console.error('       run_migrations.js --apply-standalone-reservation-capacity | --rollback-standalone-reservation-capacity | --verify-standalone-reservation-capacity');
  console.error('       run_migrations.js --apply-standalone-scheduler-incremental | --rollback-standalone-scheduler-incremental | --verify-standalone-scheduler-incremental');
  console.error('       run_migrations.js --apply-standalone-scheduler-outbox-notify | --rollback-standalone-scheduler-outbox-notify | --verify-standalone-scheduler-outbox-notify');
  console.error('       run_migrations.js --apply-standalone-scheduler-rls | --rollback-standalone-scheduler-rls | --verify-standalone-scheduler-rls');
  console.error('       run_migrations.js --apply-standalone-route-cost-matrix-full-key | --rollback-standalone-route-cost-matrix-full-key | --verify-standalone-route-cost-matrix-full-key');
  console.error('       run_migrations.js --apply-standalone-resource-time-windows | --rollback-standalone-resource-time-windows | --verify-standalone-resource-time-windows');
  console.error('       run_migrations.js --apply-standalone-assignment-event-tenancy | --rollback-standalone-assignment-event-tenancy | --verify-standalone-assignment-event-tenancy');
  console.error('       run_migrations.js --apply-standalone-prediction-shadow-observation | --rollback-standalone-prediction-shadow-observation | --verify-standalone-prediction-shadow-observation');
  console.error('       run_migrations.js --apply-standalone-snapshot-version-counter | --rollback-standalone-snapshot-version-counter | --verify-standalone-snapshot-version-counter');
  console.error('Env: EWOH_DATABASE_URL or SUDA_DATABASE_URL, EWOH_SCHEMA, EWOH_ALLOW_DDL=1');
  console.error('Rollback also requires EWOH_ALLOW_DESTRUCTIVE_ROLLBACK=1.');
  process.exit(2);
}

function main() {
  loadEnv();
  const args = process.argv.slice(2);
  const command = args[0];
  if (!command) usage();

  const fileArg = args.find((a) => PLAN_NAMES.includes(a));

  if (command === '--plan') {
    const which = fileArg || 'migration';
    const schema = validateSchema(which.startsWith('standalone') ? 'public' : schemaName());
    const sql = substitute(read(FILES[which]), schema);
    process.stdout.write(`-- EWOH DDL plan: ${which} | schema: ${schema}\n`);
    process.stdout.write(sql.endsWith('\n') ? sql : `${sql}\n`);
    return;
  }

  if (!EXECUTE_COMMANDS.has(command)) usage();

  const isStandalone = command.includes('standalone');
  const schema = validateSchema(isStandalone ? 'public' : schemaName());

  const url = process.env.EWOH_DATABASE_URL || process.env.SUDA_DATABASE_URL;
  if (!url) {
    console.error('EWOH_DATABASE_URL or SUDA_DATABASE_URL is required.');
    process.exit(2);
  }
  // 审计 SQL-107（2026-08-17）：verify 命令清单从 SIMPLE_VERIFY_COMMANDS 表 +
  // COMPLEX_VERIFY_COMMANDS 派生，不再手工维护第 5 份同步列表。
  if (![...Object.keys(SIMPLE_VERIFY_COMMANDS), ...COMPLEX_VERIFY_COMMANDS].includes(command) && process.env.EWOH_ALLOW_DDL !== '1') {
    console.error('EWOH_ALLOW_DDL=1 is required for --apply and --rollback.');
    process.exit(2);
  }
  if (ROLLBACK_COMMANDS.has(command) && process.env.EWOH_ALLOW_DESTRUCTIVE_ROLLBACK !== '1') {
    console.error('EWOH_ALLOW_DESTRUCTIVE_ROLLBACK=1 is required for destructive rollback.');
    process.exit(2);
  }

  const postgres = requireFromApp('postgres');
  const sql = postgres(url, {
    max: 1,
    onnotice: process.env.EWOH_SHOW_NOTICES === '1' ? undefined : () => {},
  });

  (async () => {
    // 审计 SQL-107（2026-08-17）：简单型 verify（单行单字段 ===1 断言）统一走
    // SIMPLE_VERIFY_COMMANDS 表驱动分支，替代原先 23 个结构相同的 if 分支。
    if (SIMPLE_VERIFY_COMMANDS[command]) {
      const [fileKey, okField, okLabel] = SIMPLE_VERIFY_COMMANDS[command];
      const result = await sql.unsafe(substitute(read(FILES[fileKey]), schema));
      console.log(JSON.stringify(result, null, 2));
      // 多语句 verify（如前置 SELECT set_config 的 002）返回多个结果集；
      // 在所有结果集中查找断言字段（部署回归修复 2026-08-18）。
      const rows = Array.isArray(result[0]) ? result.flat() : result;
      const row = rows.find((r) => r && okField in r) || {};
      if (Number(row[okField] || 0) !== 1) {
        console.error(`VERIFY FAILED: ${command} did not return ${okField}=1`);
        process.exitCode = 1;
      } else {
        console.log(`VERIFY OK: ${okLabel}`);
      }
      return;
    }

    if (command === '--verify-standalone-domain') {
      const rows = await sql.unsafe(substitute(read(FILES.standalone_domain_verify), schema));
      console.log(JSON.stringify(rows, null, 2));
      const row = rows[0] || {};
      const count = Number(row.ewoh_domain_table_count || 0);
      // Batch 8 G5：期望值从 schema-manifest.yaml（单一事实源）派生，消除硬编码 6。
      const expected = domainTableCountFromManifest();
      if (count !== expected) {
        console.error(`VERIFY FAILED: expected ewoh_domain_table_count=${expected}, got ${count}`);
        process.exitCode = 1;
      } else {
        console.log(`VERIFY OK: all ${expected} F61-02 domain tables present`);
      }
      return;
    }

    if (command === '--verify-standalone-workbench-prod') {
      const rows = await sql.unsafe(substitute(read(FILES.standalone_workbench_prod_verify), schema));
      console.log(JSON.stringify(rows, null, 2));
      const row = rows[0] || {};
      const tableCount = Number(row.ewoh_workbench_persist_table_count || 0);
      const orgColumns = Number(row.workbench_org_columns || 0);
      const defaultUq = Number(row.saved_views_default_uq || 0);
      // 期望值来源：standalone_005_verify.sql 自述（2 张新表 / 6 个 org_id 列 / 1 个默认视图唯一索引），
      // 与迁移 005 的结构契约一致（非漂移源，自包含验证）。
      if (tableCount !== 2 || orgColumns !== 6 || defaultUq !== 1) {
        console.error(`VERIFY FAILED: expected (2,6,1), got (${tableCount},${orgColumns},${defaultUq})`);
        process.exitCode = 1;
      } else {
        console.log('VERIFY OK: workbench persistence tables + org_id columns + default-view unique index present');
      }
      return;
    }

    if (command === '--verify-standalone-reservation-conflict') {
      const rows = await sql.unsafe(substitute(read(FILES.standalone_reservation_conflict_verify), schema));
      console.log(JSON.stringify(rows, null, 2));
      const row = rows[0] || {};
      const guard = Number(row.reservation_no_overlap_guard || 0);
      if (guard !== 1) {
        console.error(`VERIFY FAILED: expected reservation_no_overlap_guard=1, got ${guard}`);
        process.exitCode = 1;
      } else {
        console.log('VERIFY OK: reservation no-overlap exclusion constraint present');
      }
      return;
    }

    if (command === '--verify-standalone-scheduling-feedback') {
      const rows = await sql.unsafe(substitute(read(FILES.standalone_scheduling_feedback_verify), schema));
      console.log(JSON.stringify(rows, null, 2));
      const row = rows[0] || {};
      const columns = Number(row.ewoh_scheduling_feedback_columns || 0);
      const indexes = Number(row.ewoh_scheduling_feedback_indexes || 0);
      // 期望值来源：standalone_010_verify.sql 自述（feedback 表 16 列 / 4 索引）。
      if (columns !== 16 || indexes !== 4) {
        console.error(`VERIFY FAILED: expected (16,4), got (${columns},${indexes})`);
        process.exitCode = 1;
      } else {
        console.log('VERIFY OK: scheduling feedback table + indexes present');
      }
      return;
    }

    if (command === '--verify-standalone-scheduling') {
      const rows = await sql.unsafe(substitute(read(FILES.standalone_scheduling_verify), schema));
      console.log(JSON.stringify(rows, null, 2));
      const row = rows[0] || {};
      const tableCount = Number(row.ewoh_scheduling_table_count || 0);
      const v2Columns = Number(row.ewoh_schedule_plan_v2_columns || 0);
      const versionCol = Number(row.ewoh_schedule_plan_version_col || 0);
      // 期望值来源：standalone_006_verify.sql 自述（7 张 V2 表 / 7 个 V2 列 / 1 个 version 列）。
      if (tableCount !== 7 || v2Columns !== 7 || versionCol !== 1) {
        console.error(`VERIFY FAILED: expected (7,7,1), got (${tableCount},${v2Columns},${versionCol})`);
        process.exitCode = 1;
      } else {
        console.log('VERIFY OK: scheduling V2 tables + ewoh_schedule_plan V2 columns present');
      }
      return;
    }

    if (command === '--verify-standalone-outbox-sequence') {
      const rows = await sql.unsafe(substitute(read(FILES.standalone_outbox_sequence_verify), schema));
      console.log(JSON.stringify(rows, null, 2));
      const row = rows[0] || {};
      const exists = Number(row.outbox_sequence_exists || 0);
      const hasDefault = Number(row.outbox_sequence_default || 0);
      // 期望值来源：standalone_011_verify.sql 自述（序列存在 1 / sequence 列 DEFAULT 使用序列 1）。
      if (exists !== 1 || hasDefault !== 1) {
        console.error(`VERIFY FAILED: expected (1,1), got (${exists},${hasDefault})`);
        process.exitCode = 1;
      } else {
        console.log('VERIFY OK: outbox sequence exists and ewoh_outbox.sequence DEFAULT uses it');
      }
      return;
    }

    if (command === '--verify-standalone-conflict-lifecycle') {
      const rows = await sql.unsafe(substitute(read(FILES.standalone_conflict_lifecycle_verify), schema));
      console.log(JSON.stringify(rows, null, 2));
      const row = rows[0] || {};
      const columns = Number(row.conflict_columns || 0);
      const indexes = Number(row.conflict_indexes || 0);
      const statusDefault = Number(row.conflict_status_default || 0);
      // 期望值来源：standalone_013_conflict_lifecycle.verify.sql 自述（19 列 / 4 索引 / 1 默认 OPEN）。
      if (columns !== 19 || indexes !== 4 || statusDefault !== 1) {
        console.error(`VERIFY FAILED: expected (19,4,1), got (${columns},${indexes},${statusDefault})`);
        process.exitCode = 1;
      } else {
        console.log('VERIFY OK: conflict lifecycle table + status default OPEN present');
      }
      return;
    }

    if (command === '--verify-standalone-task-requirement') {
      const rows = await sql.unsafe(substitute(read(FILES.standalone_task_requirement_verify), schema));
      console.log(JSON.stringify(rows, null, 2));
      const last = Array.isArray(rows) ? rows[rows.length - 1] : rows;
      const row = (Array.isArray(last) ? last[0] : last) || {};
      const nullRows = Number(row.null_required_device_capability_rows || 0);
      // verify.sql 内 DO 块失败会整体抛错；此处额外断言 backfill 无 NULL 残留。
      if (nullRows > 0) {
        console.error(`VERIFY FAILED: ${nullRows} rows have NULL required_device_capabilities`);
        process.exitCode = 1;
      } else {
        console.log('VERIFY OK: TaskRequirement columns + backfill complete');
      }
      return;
    }

    if (command === '--verify-standalone-scheduling-tables-fix') {
      const rows = await sql.unsafe(substitute(read(FILES.standalone_scheduling_tables_fix_verify), schema));
      console.log(JSON.stringify(rows, null, 2));
      // 多语句执行返回结果数组；主查询是最后一条（DO 块无返回行）。
      const last = Array.isArray(rows) ? rows[rows.length - 1] : rows;
      const row = (Array.isArray(last) ? last[0] : last) || {};
      const ok = Number(row.outbox_key_cols || 0) >= 5
        && Number(row.reservation_key_cols || 0) >= 5
        && Number(row.policy_key_cols || 0) >= 4
        && Number(row.replan_trigger_key_cols || 0) >= 4;
      if (!ok) {
        console.error(`VERIFY FAILED: scheduling tables missing key columns (${JSON.stringify(row)})`);
        process.exitCode = 1;
      } else {
        console.log('VERIFY OK: scheduling tables (outbox/reservation/policy) present with key columns');
      }
      return;
    }

    if (command === '--verify-standalone-execution-feedback') {
      const rows = await sql.unsafe(substitute(read(FILES.standalone_execution_feedback_verify), schema));
      console.log(JSON.stringify(rows, null, 2));
      const last = Array.isArray(rows) ? rows[rows.length - 1] : rows;
      const row = (Array.isArray(last) ? last[0] : last) || {};
      const ok = Number(row.exec_key_cols || 0) >= 7 && Number(row.exec_indexes || 0) >= 5;
      if (!ok) {
        console.error(`VERIFY FAILED: execution table missing (${JSON.stringify(row)})`);
        process.exitCode = 1;
      } else {
        console.log('VERIFY OK: ewoh_scheduling_execution present with key columns + indexes');
      }
      return;
    }

    if (command === '--verify-standalone-kpi-replay') {
      const rows = await sql.unsafe(substitute(read(FILES.standalone_kpi_replay_verify), schema));
      console.log(JSON.stringify(rows, null, 2));
      const last = Array.isArray(rows) ? rows[rows.length - 1] : rows;
      const row = (Array.isArray(last) ? last[0] : last) || {};
      const ok = Number(row.replay_key_cols || 0) >= 6;
      if (!ok) {
        console.error(`VERIFY FAILED: kpi/replay tables missing (${JSON.stringify(row)})`);
        process.exitCode = 1;
      } else {
        console.log('VERIFY OK: kpi + policy_replay tables present');
      }
      return;
    }

    if (command === '--verify-standalone-policy-lifecycle') {
      const rows = await sql.unsafe(substitute(read(FILES.standalone_policy_lifecycle_verify), schema));
      console.log(JSON.stringify(rows, null, 2));
      const last = Array.isArray(rows) ? rows[rows.length - 1] : rows;
      const row = (Array.isArray(last) ? last[0] : last) || {};
      const ok = Number(row.activation_key_cols || 0) >= 5;
      if (!ok) {
        console.error(`VERIFY FAILED: policy lifecycle missing (${JSON.stringify(row)})`);
        process.exitCode = 1;
      } else {
        console.log('VERIFY OK: policy.status + activation + plan.is_shadow present');
      }
      return;
    }

    if (command === '--verify-standalone-sse-envelope') {
      const rows = await sql.unsafe(substitute(read(FILES.standalone_sse_envelope_verify), schema));
      console.log(JSON.stringify(rows, null, 2));
      const last = Array.isArray(rows) ? rows[rows.length - 1] : rows;
      const row = (Array.isArray(last) ? last[0] : last) || {};
      const ok = Number(row.outbox_indexes || 0) >= 4;
      if (!ok) {
        console.error(`VERIFY FAILED: sse envelope missing (${JSON.stringify(row)})`);
        process.exitCode = 1;
      } else {
        console.log('VERIFY OK: outbox.correlation_id + sequence index present');
      }
      return;
    }

    if (command === '--verify-standalone-reservation-capacity') {
      const rows = await sql.unsafe(substitute(read(FILES.standalone_reservation_capacity_verify), schema));
      console.log(JSON.stringify(rows, null, 2));
      const last = Array.isArray(rows) ? rows[rows.length - 1] : rows;
      const row = (Array.isArray(last) ? last[0] : last) || {};
      // DO 块内 RAISE EXCEPTION 会整体抛错；此处对返回行做防御断言。
      // 期望：表存在=1、person/device 过滤约束存在=1、旧的未过滤约束已移除=0。
      const tableOk = Number(row.reservation_table_exists || 0) === 1;
      const guardOk = Number(row.person_device_guard || 0) === 1;
      const oldDropped = Number(row.old_binary_guard_dropped || 0) === 0;
      if (!tableOk || !guardOk || !oldDropped) {
        console.error(`VERIFY FAILED: reservation capacity guard misconfigured (${JSON.stringify(row)})`);
        process.exitCode = 1;
      } else {
        console.log('VERIFY OK: person/device scoped exclusion present; station capacity left to app layer');
      }
      return;
    }

    if (command === '--verify-standalone-scheduler-incremental') {
      const rows = await sql.unsafe(substitute(read(FILES.standalone_scheduler_incremental_verify), schema));
      console.log(JSON.stringify(rows, null, 2));
      const last = Array.isArray(rows) ? rows[rows.length - 1] : rows;
      const row = (Array.isArray(last) ? last[0] : last) || {};
      // 期望：constraint 新列=6 / constraint 索引=2 / plan 新列=2 / spatial 新列=2 /
      // device 新列=1 / RLS policy=1（DO 块内 RAISE EXCEPTION 会整体抛错；此处防御断言）。
      const ok = Number(row.constraint_new_cols || 0) >= 6
        && Number(row.constraint_indexes || 0) >= 2
        && Number(row.plan_new_cols || 0) >= 2
        && Number(row.spatial_new_cols || 0) >= 2
        && Number(row.device_new_cols || 0) >= 1
        && Number(row.rls_policies || 0) === 1;
      if (!ok) {
        console.error(`VERIFY FAILED: scheduler incremental columns/policies misconfigured (${JSON.stringify(row)})`);
        process.exitCode = 1;
      } else {
        console.log('VERIFY OK: scheduler incremental columns + indexes + RLS policy present');
      }
      return;
    }

    if (command === '--verify-standalone-scheduler-outbox-notify') {
      const rows = await sql.unsafe(substitute(read(FILES.standalone_scheduler_outbox_notify_verify), schema));
      console.log(JSON.stringify(rows, null, 2));
      const last = Array.isArray(rows) ? rows[rows.length - 1] : rows;
      const row = (Array.isArray(last) ? last[0] : last) || {};
      // 期望：ewoh_outbox 的 AFTER INSERT notify trigger=1 / notify_scheduler_outbox 函数=1
      // （DO 块内 RAISE EXCEPTION 会整体抛错；此处防御断言）。
      const ok = Number(row.outbox_notify_trigger || 0) >= 1
        && Number(row.outbox_notify_function || 0) >= 1;
      if (!ok) {
        console.error(`VERIFY FAILED: outbox notify trigger/function missing (${JSON.stringify(row)})`);
        process.exitCode = 1;
      } else {
        console.log('VERIFY OK: ewoh_outbox AFTER INSERT notify trigger + function present');
      }
      return;
    }

    if (command === '--verify-standalone-scheduler-rls') {
      const rows = await sql.unsafe(substitute(read(FILES.standalone_scheduler_rls_verify), schema));
      console.log(JSON.stringify(rows, null, 2));
      const last = Array.isArray(rows) ? rows[rows.length - 1] : rows;
      const row = (Array.isArray(last) ? last[0] : last) || {};
      // 期望：8 张 org-scoped 表 RLS 启用 / 8 条 policy / 8 条 policy 定义含 app.current_org_id /
      // ewoh_schedule_plan.org_id 列=1（DO 块内 RAISE EXCEPTION 会整体抛错；此处防御断言）。
      const ok = Number(row.rls_enabled || 0) >= 8
        && Number(row.policy_count || 0) >= 8
        && Number(row.policy_guc || 0) >= 8
        && Number(row.plan_org_col || 0) === 1;
      if (!ok) {
        console.error(`VERIFY FAILED: scheduler RLS coverage misconfigured (${JSON.stringify(row)})`);
        process.exitCode = 1;
      } else {
        console.log('VERIFY OK: scheduler domain RLS enabled with current_org_id GUC policies');
      }
      return;
    }

    if (command === '--verify-standalone-route-cost-matrix-full-key') {
      const rows = await sql.unsafe(substitute(read(FILES.standalone_route_cost_matrix_full_key_verify), schema));
      console.log(JSON.stringify(rows, null, 2));
      const last = Array.isArray(rows) ? rows[rows.length - 1] : rows;
      const row = (Array.isArray(last) ? last[0] : last) || {};
      // 期望：全键列=2 / 全键索引=1 / 唯一=1
      // （DO 块内 RAISE EXCEPTION 会整体抛错；此处防御断言）。
      const ok = Number(row.full_key_columns || 0) >= 2
        && Number(row.full_key_index || 0) === 1
        && Number(row.full_key_unique || 0) === 1;
      if (!ok) {
        console.error(`VERIFY FAILED: route cost matrix full-key unique index misconfigured (${JSON.stringify(row)})`);
        process.exitCode = 1;
      } else {
        console.log('VERIFY OK: route cost matrix full-key unique index present');
      }
      return;
    }

    if (command === '--verify-standalone-resource-time-windows') {
      const rows = await sql.unsafe(substitute(read(FILES.standalone_resource_time_windows_verify), schema));
      console.log(JSON.stringify(rows, null, 2));
      const last = Array.isArray(rows) ? rows[rows.length - 1] : rows;
      const row = (Array.isArray(last) ? last[0] : last) || {};
      // 期望：ewoh_device 维护时间窗列=2（DO 块内 RAISE EXCEPTION 会整体抛错；此处防御断言）。
      const ok = Number(row.maintenance_cols || 0) === 2;
      if (!ok) {
        console.error(`VERIFY FAILED: device maintenance window columns misconfigured (${JSON.stringify(row)})`);
        process.exitCode = 1;
      } else {
        console.log('VERIFY OK: ewoh_device maintenance_start_ms/maintenance_end_ms present');
      }
      return;
    }

    if (command === '--verify-standalone-assignment-event-tenancy') {
      const rows = await sql.unsafe(substitute(read(FILES.standalone_assignment_event_tenancy_verify), schema));
      console.log(JSON.stringify(rows, null, 2));
      const last = Array.isArray(rows) ? rows[rows.length - 1] : rows;
      const row = (Array.isArray(last) ? last[0] : last) || {};
      // 期望（ADR-004 DERIVED_TENANT_OWNERSHIP）：org_id 列=1 / org 索引=1 /
      // 派生触发器=1 / 派生函数=1 / 派生不变量失配=0（DO 块内 RAISE EXCEPTION
      // 会整体抛错；此处防御断言）。
      const ok = Number(row.org_id_col || 0) === 1
        && Number(row.org_idx || 0) === 1
        && Number(row.trg_exists || 0) === 1
        && Number(row.fn_exists || 0) === 1
        && Number(row.derived_org_mismatches || 0) === 0;
      if (!ok) {
        console.error(`VERIFY FAILED: assignment_event derived tenancy misconfigured (${JSON.stringify(row)})`);
        process.exitCode = 1;
      } else {
        console.log('VERIFY OK: assignment_event org_id column + derive trigger + ownership invariant present');
      }
      return;
    }

    if (command === '--verify-standalone-prediction-shadow-observation') {
      const rows = await sql.unsafe(substitute(read(FILES.standalone_prediction_shadow_observation_verify), schema));
      console.log(JSON.stringify(rows, null, 2));
      const last = Array.isArray(rows) ? rows[rows.length - 1] : rows;
      const row = (Array.isArray(last) ? last[0] : last) || {};
      // 期望（Task 7）：表列=18 / 索引=3（DO 块内 RAISE EXCEPTION 会整体抛错；此处防御断言）。
      const ok = Number(row.shadow_obs_columns || 0) === 18
        && Number(row.shadow_obs_indexes || 0) === 3;
      if (!ok) {
        console.error(`VERIFY FAILED: prediction_shadow_observation misconfigured (${JSON.stringify(row)})`);
        process.exitCode = 1;
      } else {
        console.log('VERIFY OK: prediction_shadow_observation table + 18 columns + 3 indexes present');
      }
      return;
    }

    if (command === '--verify-standalone-snapshot-version-counter') {
      const rows = await sql.unsafe(substitute(read(FILES.standalone_snapshot_version_counter_verify), schema));
      console.log(JSON.stringify(rows, null, 2));
      const last = Array.isArray(rows) ? rows[rows.length - 1] : rows;
      const row = (Array.isArray(last) ? last[0] : last) || {};
      // 期望（standalone_031）：表列=4 / day 主键=1（DO 块内 RAISE EXCEPTION
      // 会整体抛错；此处防御断言）。
      const ok = Number(row.counter_columns || 0) === 4
        && Number(row.counter_pk || 0) === 1;
      if (!ok) {
        console.error(`VERIFY FAILED: snapshot version counter misconfigured (${JSON.stringify(row)})`);
        process.exitCode = 1;
      } else {
        console.log('VERIFY OK: ewoh_snapshot_version_counter table + 4 columns + day PK present');
      }
      return;
    }

    if (command === '--verify-standalone-solver-activation') {
      const rows = await sql.unsafe(substitute(read(FILES.standalone_solver_activation_verify), schema));
      console.log(JSON.stringify(rows, null, 2));
      const last = Array.isArray(rows) ? rows[rows.length - 1] : rows;
      const row = (Array.isArray(last) ? last[0] : last) || {};
      // 期望（standalone_030，Task A P0）：plan 列=2 / run 列=2
      // （DO 块内 RAISE EXCEPTION 会整体抛错；此处防御断言）。
      const ok = Number(row.plan_solver_columns || 0) === 2
        && Number(row.run_solver_columns || 0) === 2;
      if (!ok) {
        console.error(`VERIFY FAILED: solver activation columns misconfigured (${JSON.stringify(row)})`);
        process.exitCode = 1;
      } else {
        console.log('VERIFY OK: ewoh_schedule_plan + ewoh_scheduling_run solver_status/fallback_reason columns present');
      }
      return;
    }

    if (command === '--verify-standalone-policy-weights') {
      const rows = await sql.unsafe(substitute(read(FILES.standalone_policy_weights_verify), schema));
      console.log(JSON.stringify(rows, null, 2));
      const row = rows[0] || {};
      const policyCol = Number(row.policy_weights_json || 0);
      const planCol = Number(row.plan_weights_json || 0);
      // 期望值来源：standalone_014_policy_weights.verify.sql 自述（policy=1 / plan=1）。
      if (policyCol !== 1 || planCol !== 1) {
        console.error(`VERIFY FAILED: expected (1,1), got (${policyCol},${planCol})`);
        process.exitCode = 1;
      } else {
        console.log('VERIFY OK: policy + plan weights_json columns present');
      }
      return;
    }

    if (command === '--verify-standalone-route-cost-matrix') {
      const rows = await sql.unsafe(substitute(read(FILES.standalone_route_cost_matrix_verify), schema));
      console.log(JSON.stringify(rows, null, 2));
      const row = rows[0] || {};
      const columns = Number(row.route_cost_matrix_columns || 0);
      const indexes = Number(row.route_cost_matrix_indexes || 0);
      const uq = Number(row.route_cost_matrix_uq || 0);
      // 期望值来源：standalone_015_route_cost_matrix.verify.sql 自述（11 列 / ≥3 索引 /
      // 1 task_snapshot 唯一键）。索引数改用下限断言：026（full_key）与 057
      // （org 复合唯一）后续追加同类前缀索引，精确计数会在链式应用后误报失败。
      if (columns !== 11 || indexes < 3 || uq !== 1) {
        console.error(`VERIFY FAILED: expected (11,>=3,1), got (${columns},${indexes},${uq})`);
        process.exitCode = 1;
      } else {
        console.log('VERIFY OK: route cost matrix cache table + unique key present');
      }
      return;
    }

    if (command === '--verify-standalone-domain-columns') {
      const rows = await sql.unsafe(substitute(read(FILES.standalone_domain_columns_verify), schema));
      console.log(JSON.stringify(rows, null, 2));
      const row = rows[0] || {};
      const taskCols = Number(row.task_domain_columns || 0);
      const personnelCols = Number(row.personnel_domain_columns || 0);
      const deviceCols = Number(row.device_domain_columns || 0);
      const spatialCols = Number(row.spatial_domain_columns || 0);
      const runFailure = Number(row.run_failure_reason || 0);
      const safetyDefault = Number(row.safety_critical_default || 0);
      const preemptibleDefault = Number(row.preemptible_default || 0);
      const skillModeDefault = Number(row.skill_match_mode_default || 0);
      const impactDefault = Number(row.production_impact_default || 0);
      // 期望值来源：standalone_012_domain_columns.verify.sql 自述（(11,4,7,3,1,1,1,1,1)）。
      if (
        taskCols !== 11 || personnelCols !== 4 || deviceCols !== 7 ||
        spatialCols !== 3 || runFailure !== 1 ||
        safetyDefault !== 1 || preemptibleDefault !== 1 ||
        skillModeDefault !== 1 || impactDefault !== 1
      ) {
        console.error(
          `VERIFY FAILED: expected (11,4,7,3,1,1,1,1,1), got (${taskCols},${personnelCols},${deviceCols},${spatialCols},${runFailure},${safetyDefault},${preemptibleDefault},${skillModeDefault},${impactDefault})`,
        );
        process.exitCode = 1;
      } else {
        console.log('VERIFY OK: domain-model columns present with correct defaults');
      }
      return;
    }

    if (['--verify', '--verify-standalone'].includes(command)) {
      const verifyFile = command === '--verify-standalone' ? FILES.standalone_verify : FILES.verify;
      const verifySqlText = read(verifyFile);

      // 审计 SQL-104（2026-08-17）：verify SQL 的 expected(name) 静态列表与
      // schema-manifest 核心表集合对账——manifest 删表但 verify 列表未同步时，
      // managed_table_count 可能巧合相等而掩盖表丢失，此处集合级双向对账兜底。
      const sqlExpected = expectedTableNamesFromVerifySql(verifySqlText);
      const manifestCore = coreManagedTableNamesFromManifest();
      if (!sqlExpected) {
        console.error('VERIFY FAILED: verify SQL 中未找到 expected(name) 列表（SQL-104 对账无法执行）');
        process.exitCode = 1;
        return;
      }
      const onlyInSql = [...sqlExpected].filter((n) => !manifestCore.has(n));
      const onlyInManifest = [...manifestCore].filter((n) => !sqlExpected.has(n));
      if (onlyInSql.length || onlyInManifest.length) {
        console.error(`VERIFY FAILED: verify expected 列表与 manifest 核心表漂移（SQL 多出: ${onlyInSql.join(',') || '无'}; manifest 多出: ${onlyInManifest.join(',') || '无'}）`);
        process.exitCode = 1;
        return;
      }

      const rows = await sql.unsafe(substitute(verifySqlText, schema));
      console.log(JSON.stringify(rows, null, 2));
      const row = rows[0] || {};
      // 期望值来源：schema-manifest.yaml（单一事实源）。
      // 口径：managed_table_count / rls_enabled 只覆盖核心受管表（managed_tables
      // 去掉 6 张 F61-02 域表 = 68）；manifest header managed_count=74 是全量逻辑
      // 受管表数（68 核心 + 6 域表），二者是不同度量、非漂移。6 张域表由
      // --verify-standalone-domain 单独验证。
      const coreCount = coreManagedTableCountFromManifest();
      // 审计 SQL-105（2026-08-17）：显式列出 verify SQL 全部 14 个返回列的期望值，
      // 不再用 `expected[key] || 0` 隐式期望——未登记列的期望漂移会被静默放行。
      const expected = {
        managed_table_count: coreCount,
        missing_org_id: 0,
        org_not_null_violations: 0,
        missing_org_request_defaults: 0,
        rls_enabled: coreCount,
        tables_without_policy: 0,
        loose_policies: 0,
        authenticated_dml_grants: 0,
        anon_grants: 0,
        audit_seq_identity: 1,
        world_delta_seq_identity: 1,
        audit_function_count: 1,
        quantity_numeric_mismatch: 0,
        scheduler_config_org_key: 1,
      };
      const bad = Object.entries(expected)
        .filter(([key, value]) => Number(row[key]) !== value)
        .map(([key]) => `${key}=${row[key]} (expected ${expected[key]})`);
      const unknownColumns = Object.keys(row).filter((key) => !(key in expected));
      if (unknownColumns.length) {
        bad.push(`未登记的返回列（SQL-105 显式期望清单需同步）: ${unknownColumns.join(',')}`);
      }
      if (bad.length) {
        console.error(`VERIFY FAILED: ${bad.join(', ')}`);
        process.exitCode = 1;
      } else {
        console.log('VERIFY OK');
      }
      return;
    }

    const which = {
      '--apply': 'migration',
      '--rollback': 'rollback',
      '--apply-users': 'users',
      '--rollback-users': 'users_rollback',
      '--seed': 'seed',
      '--seed-users': 'users_seed',
      '--apply-standalone': 'standalone',
      '--rollback-standalone': 'standalone_rollback',
      '--seed-standalone': 'standalone_seed',
      '--apply-standalone-users': 'standalone_users',
      '--rollback-standalone-users': 'standalone_users_rollback',
      '--apply-standalone-runtime-role': 'standalone_runtime_role',
      '--rollback-standalone-runtime-role': 'standalone_runtime_role_rollback',
      '--apply-standalone-domain': 'standalone_domain',
      '--rollback-standalone-domain': 'standalone_domain_rollback',
      '--apply-standalone-workbench-prod': 'standalone_workbench_prod',
      '--rollback-standalone-workbench-prod': 'standalone_workbench_prod_rollback',
      '--apply-standalone-scheduling': 'standalone_scheduling',
      '--rollback-standalone-scheduling': 'standalone_scheduling_rollback',
      '--seed-standalone-admin': 'standalone_admin',
      '--seed-standalone-scheduling': 'standalone_scheduling_seed',
      '--apply-standalone-scheduling-persistence': 'standalone_scheduling_persistence',
      '--rollback-standalone-scheduling-persistence': 'standalone_scheduling_persistence_rollback',
      '--apply-standalone-phase2-realtime': 'standalone_phase2_realtime',
      '--rollback-standalone-phase2-realtime': 'standalone_phase2_realtime_rollback',
      '--apply-standalone-reservation-conflict': 'standalone_reservation_conflict',
      '--rollback-standalone-reservation-conflict': 'standalone_reservation_conflict_rollback',
      '--apply-standalone-scheduling-feedback': 'standalone_scheduling_feedback',
      '--rollback-standalone-scheduling-feedback': 'standalone_scheduling_feedback_rollback',
      '--apply-standalone-outbox-sequence': 'standalone_outbox_sequence',
      '--rollback-standalone-outbox-sequence': 'standalone_outbox_sequence_rollback',
      '--apply-standalone-domain-columns': 'standalone_domain_columns',
      '--rollback-standalone-domain-columns': 'standalone_domain_columns_rollback',
      '--apply-standalone-route-cost-matrix': 'standalone_route_cost_matrix',
      '--rollback-standalone-route-cost-matrix': 'standalone_route_cost_matrix_rollback',
      '--apply-standalone-policy-weights': 'standalone_policy_weights',
      '--rollback-standalone-policy-weights': 'standalone_policy_weights_rollback',
      '--apply-standalone-conflict-lifecycle': 'standalone_conflict_lifecycle',
      '--rollback-standalone-conflict-lifecycle': 'standalone_conflict_lifecycle_rollback',
      '--apply-standalone-task-requirement': 'standalone_task_requirement',
      '--rollback-standalone-task-requirement': 'standalone_task_requirement_rollback',
      '--apply-standalone-scheduling-tables-fix': 'standalone_scheduling_tables_fix',
      '--rollback-standalone-scheduling-tables-fix': 'standalone_scheduling_tables_fix_rollback',
      '--apply-standalone-execution-feedback': 'standalone_execution_feedback',
      '--rollback-standalone-execution-feedback': 'standalone_execution_feedback_rollback',
      '--apply-standalone-kpi-replay': 'standalone_kpi_replay',
      '--rollback-standalone-kpi-replay': 'standalone_kpi_replay_rollback',
      '--apply-standalone-policy-lifecycle': 'standalone_policy_lifecycle',
      '--rollback-standalone-policy-lifecycle': 'standalone_policy_lifecycle_rollback',
      '--apply-standalone-sse-envelope': 'standalone_sse_envelope',
      '--rollback-standalone-sse-envelope': 'standalone_sse_envelope_rollback',
      '--apply-standalone-reservation-capacity': 'standalone_reservation_capacity',
      '--rollback-standalone-reservation-capacity': 'standalone_reservation_capacity_rollback',
      '--apply-standalone-scheduler-incremental': 'standalone_scheduler_incremental',
      '--rollback-standalone-scheduler-incremental': 'standalone_scheduler_incremental_rollback',
      '--apply-standalone-scheduler-outbox-notify': 'standalone_scheduler_outbox_notify',
      '--rollback-standalone-scheduler-outbox-notify': 'standalone_scheduler_outbox_notify_rollback',
      '--apply-standalone-scheduler-rls': 'standalone_scheduler_rls',
      '--rollback-standalone-scheduler-rls': 'standalone_scheduler_rls_rollback',
      '--apply-standalone-route-cost-matrix-full-key': 'standalone_route_cost_matrix_full_key',
      '--rollback-standalone-route-cost-matrix-full-key': 'standalone_route_cost_matrix_full_key_rollback',
      '--apply-standalone-resource-time-windows': 'standalone_resource_time_windows',
      '--rollback-standalone-resource-time-windows': 'standalone_resource_time_windows_rollback',
      '--apply-standalone-assignment-event-tenancy': 'standalone_assignment_event_tenancy',
      '--rollback-standalone-assignment-event-tenancy': 'standalone_assignment_event_tenancy_rollback',
      '--apply-standalone-prediction-shadow-observation': 'standalone_prediction_shadow_observation',
      '--rollback-standalone-prediction-shadow-observation': 'standalone_prediction_shadow_observation_rollback',
      '--apply-standalone-snapshot-version-counter': 'standalone_snapshot_version_counter',
      '--rollback-standalone-snapshot-version-counter': 'standalone_snapshot_version_counter_rollback',
      '--apply-standalone-solver-activation': 'standalone_solver_activation',
      '--rollback-standalone-solver-activation': 'standalone_solver_activation_rollback',
      // NO-02b / NO-05b / NO-05e-b：专项迁移计划（apply/rollback 走通用执行路径；
      // verify 走上方专用 handler）。此前缺失这些条目导致命令在 which 映射处
      // read(undefined) 崩溃——CI 从未运行未提交改动，故该潜伏缺陷未被触发；
      // 本轮随 standalone_035 一并补齐（032/034/035 全部覆盖）。
      '--apply-standalone-identity-mapping': 'standalone_identity_mapping',
      '--rollback-standalone-identity-mapping': 'standalone_identity_mapping_rollback',
      '--apply-standalone-maintenance-quality': 'standalone_maintenance_quality',
      '--rollback-standalone-maintenance-quality': 'standalone_maintenance_quality_rollback',
      '--apply-standalone-work-order': 'standalone_work_order',
      '--rollback-standalone-work-order': 'standalone_work_order_rollback',
      '--apply-standalone-event-dedup': 'standalone_event_dedup',
      '--rollback-standalone-event-dedup': 'standalone_event_dedup_rollback',
      '--apply-standalone-agent-manifest': 'standalone_agent_manifest',
      '--rollback-standalone-agent-manifest': 'standalone_agent_manifest_rollback',
      '--apply-standalone-agent-task': 'standalone_agent_task',
      '--rollback-standalone-agent-task': 'standalone_agent_task_rollback',
      '--apply-standalone-knowledge-entry': 'standalone_knowledge_entry',
      '--rollback-standalone-knowledge-entry': 'standalone_knowledge_entry_rollback',
      '--apply-standalone-inference-result': 'standalone_inference_result',
      '--rollback-standalone-inference-result': 'standalone_inference_result_rollback',
      '--apply-standalone-learning-evaluation': 'standalone_learning_evaluation',
      '--rollback-standalone-learning-evaluation': 'standalone_learning_evaluation_rollback',
      '--apply-standalone-trace-span': 'standalone_trace_span',
      '--rollback-standalone-trace-span': 'standalone_trace_span_rollback',
      '--apply-standalone-dead-letter': 'standalone_dead_letter',
      '--rollback-standalone-dead-letter': 'standalone_dead_letter_rollback',
      '--apply-standalone-simulation-run': 'standalone_simulation_run',
      '--rollback-standalone-simulation-run': 'standalone_simulation_run_rollback',
      '--apply-standalone-learning-proposal': 'standalone_learning_proposal',
      '--rollback-standalone-learning-proposal': 'standalone_learning_proposal_rollback',
      '--apply-standalone-exo-session': 'standalone_exo_session',
      '--rollback-standalone-exo-session': 'standalone_exo_session_rollback',
      '--apply-standalone-outcome-annotation': 'standalone_outcome_annotation',
      '--rollback-standalone-outcome-annotation': 'standalone_outcome_annotation_rollback',
      '--apply-standalone-shadow-plan-isolation': 'standalone_shadow_plan_isolation',
      '--rollback-standalone-shadow-plan-isolation': 'standalone_shadow_plan_isolation_rollback',
      '--apply-standalone-agent-approval': 'standalone_agent_approval',
      '--rollback-standalone-agent-approval': 'standalone_agent_approval_rollback',
      '--apply-standalone-decision-records': 'standalone_decision_records',
      '--rollback-standalone-decision-records': 'standalone_decision_records_rollback',
      '--apply-standalone-exo-config': 'standalone_exo_config',
      '--rollback-standalone-exo-config': 'standalone_exo_config_rollback',
      '--apply-standalone-agent-approval-decision': 'standalone_agent_approval_decision',
      '--rollback-standalone-agent-approval-decision': 'standalone_agent_approval_decision_rollback',
      '--apply-standalone-learning-proposal-decision': 'standalone_learning_proposal_decision',
      '--rollback-standalone-learning-proposal-decision': 'standalone_learning_proposal_decision_rollback',
      '--apply-standalone-policy-activation-decision': 'standalone_policy_activation_decision',
      '--rollback-standalone-policy-activation-decision': 'standalone_policy_activation_decision_rollback',
      '--apply-standalone-route-org-isolation': 'standalone_route_org_isolation',
      '--rollback-standalone-route-org-isolation': 'standalone_route_org_isolation_rollback',
      '--apply-standalone-rls-null-reject': 'standalone_rls_null_reject',
      '--rollback-standalone-rls-null-reject': 'standalone_rls_null_reject_rollback',
      // R2-DBM-002/R2-SDB-006：058/059/060 应用/回滚命令映射。
      '--apply-standalone-control-attempt-unique': 'standalone_control_attempt_unique',
      '--rollback-standalone-control-attempt-unique': 'standalone_control_attempt_unique_rollback',
      '--apply-standalone-spatial-entity-org-unique': 'standalone_spatial_entity_org_unique',
      '--rollback-standalone-spatial-entity-org-unique': 'standalone_spatial_entity_org_unique_rollback',
      '--apply-standalone-idempotency-org': 'standalone_idempotency_org',
      '--rollback-standalone-idempotency-org': 'standalone_idempotency_org_rollback',
    }[command];
    let sqlText = substitute(read(FILES[which]), schema);
    if (['--seed-users', '--seed-standalone-admin'].includes(command)) {
      sqlText = renderAdminSeed(sqlText);
    }
    if (command === '--apply-standalone-runtime-role') {
      sqlText = renderRuntimeRole(sqlText);
    }
    await sql.begin(async (tx) => {
      await tx.unsafe(sqlText);
    });
    console.log(`${command} completed for schema ${schema}`);
  })().catch((err) => {
    console.error('ERROR', err && (err.message || err));
    process.exitCode = 1;
  }).finally(async () => {
    try {
      await sql.end();
    } catch (err) {
      // Ignore close errors.
    }
  });
}

main();
