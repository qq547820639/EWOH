#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const SCHEMA = '__EWOH_SCHEMA__';

const ROLES = {
  anon: 'anon_workspace_aadknm4yzbyds',
  authenticated: 'authenticated_workspace_aadknm4yzbyds',
  userAuthenticated: 'user_authenticated_workspace_aadknm4yzbyds',
  service: 'service_role_workspace_aadknm4yzbyds',
};

const DEFAULT_ORG = '00000000-0000-4000-8000-000000000001';
const ORG_ID_DEFAULT = `(nullif(current_setting('app.current_org_id', true), '')::uuid)`;

const USER_DEFAULT = `(CASE WHEN current_setting('app.user_id', true) = '' THEN NULL ELSE concat('(', current_setting('app.user_id', true), ')')::${SCHEMA}.user_profile END)`;

const AUDIT_COLS = [
  `_created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP`,
  `_updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP`,
  `_created_by ${SCHEMA}.user_profile DEFAULT ${USER_DEFAULT}`,
  `_updated_by ${SCHEMA}.user_profile DEFAULT ${USER_DEFAULT}`,
];

function renderCreateTable(t) {
  const org = t.orgPolicy === 'special'
    ? `org_id uuid DEFAULT ${ORG_ID_DEFAULT}`
    : `org_id uuid NOT NULL DEFAULT ${ORG_ID_DEFAULT}`;
  const cols = [
    'id uuid PRIMARY KEY DEFAULT gen_random_uuid()',
    org,
    ...t.columns,
    ...AUDIT_COLS,
  ];
  const lines = `CREATE TABLE IF NOT EXISTS ${SCHEMA}.${t.name} (\n${cols
    .map((c) => `  ${c}`)
    .join(',\n')}\n);\n`;
  const indexes = (t.extraIndexes || [
    `CREATE INDEX IF NOT EXISTS idx_${t.name}_org ON ${SCHEMA}.${t.name} (org_id);`,
  ]).map((s) => `${s}\n`);
  return `${lines}\n${indexes.join('')}\n`;
}

function renderBaselineTable(name, columns) {
  const cols = ['id uuid PRIMARY KEY DEFAULT gen_random_uuid()', ...columns];
  return `CREATE TABLE IF NOT EXISTS ${SCHEMA}.${name} (\n${cols
    .map((c) => `  ${c}`)
    .join(',\n')}\n);\n`;
}

const BASELINE_TABLES = [
  {
    name: 'ewoh_ai_suggestion',
    columns: [
      `suggestion_id varchar(255) NOT NULL`,
      `title varchar(255)`,
      `suggestion_type varchar(255)`,
      `status varchar(255) DEFAULT 'not_generated'`,
      `related_event_id varchar(255)`,
      `related_task_id varchar(255)`,
      `input_summary text`,
      `content text`,
      `risk_assessment text`,
      `ai_level varchar(255) DEFAULT 'A2'`,
      `triggered_by varchar(255)`,
      `plan_content jsonb`,
      `adopted_at timestamptz`,
      `_created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP`,
      `_created_by ${SCHEMA}.user_profile DEFAULT ${USER_DEFAULT}`,
      `_updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP`,
      `_updated_by ${SCHEMA}.user_profile DEFAULT ${USER_DEFAULT}`,
    ],
  },
  {
    name: 'ewoh_device',
    columns: [
      `device_id varchar(255) NOT NULL UNIQUE`,
      `worker_name varchar(255)`,
      `device_model varchar(255)`,
      `battery_pct integer DEFAULT 100`,
      `online boolean DEFAULT false`,
      `last_telemetry_at timestamptz`,
      `_created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP`,
      `_updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP`,
      `source_type varchar(50) DEFAULT 'simulated'`,
      `firmware_version varchar(100)`,
      `hardware_version varchar(100)`,
      `protocol_version varchar(50)`,
      `temperature_c real`,
      `fault_code varchar(100)`,
      `last_raw_ref varchar(128)`,
    ],
  },
  {
    name: 'ewoh_device_binding',
    columns: [
      `device_id varchar(255) NOT NULL`,
      `binding_type varchar(255) NOT NULL`,
      `target_id varchar(255) NOT NULL`,
      `target_type varchar(255) NOT NULL`,
      `start_time timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP`,
      `expected_end_time timestamptz`,
      `actual_end_time timestamptz`,
      `reason text`,
      `status varchar(255) DEFAULT 'active'`,
      `operator_id varchar(255)`,
      `_created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP`,
      `_created_by ${SCHEMA}.user_profile DEFAULT ${USER_DEFAULT}`,
      `_updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP`,
      `_updated_by ${SCHEMA}.user_profile DEFAULT ${USER_DEFAULT}`,
    ],
  },
  {
    name: 'ewoh_device_config',
    columns: [
      `device_id varchar(255) NOT NULL`,
      `device_type varchar(255)`,
      `manufacturer varchar(255)`,
      `serial_number varchar(255)`,
      `install_date timestamptz`,
      `owner_id varchar(255)`,
      `access_config jsonb`,
      `run_config jsonb`,
      `description text`,
      `_created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP`,
      `_created_by ${SCHEMA}.user_profile DEFAULT ${USER_DEFAULT}`,
      `_updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP`,
      `_updated_by ${SCHEMA}.user_profile DEFAULT ${USER_DEFAULT}`,
    ],
  },
  {
    name: 'ewoh_environment',
    columns: [
      `sensor_id varchar(255) NOT NULL`,
      `entity_id varchar(255)`,
      `temperature real`,
      `vibration real`,
      `noise real`,
      `air_quality real`,
      `ts timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP`,
      `_created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP`,
      `_updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP`,
      `source_type varchar(50) DEFAULT 'simulated'`,
      `record_id varchar(64)`,
      `data_confidence real DEFAULT 1.0`,
    ],
  },
  {
    name: 'ewoh_event',
    columns: [
      `event_id varchar(255) NOT NULL UNIQUE`,
      `device_id varchar(255)`,
      `event_code varchar(255)`,
      `event_type varchar(255)`,
      `severity varchar(255)`,
      `title varchar(500)`,
      `status varchar(255) DEFAULT 'open'`,
      `created_at timestamptz`,
      `handler_action text`,
      `_created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP`,
      `_updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP`,
      `source_type varchar(50) DEFAULT 'simulated'`,
      `trigger_record_id varchar(64)`,
      `evidence_json jsonb`,
    ],
  },
  {
    name: 'ewoh_event_chain',
    columns: [
      `event_id varchar(255) NOT NULL`,
      `parent_event_id varchar(255)`,
      `causal_type varchar(255) DEFAULT 'triggered'`,
      `description text`,
      `created_at timestamptz DEFAULT CURRENT_TIMESTAMP`,
      `_created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP`,
      `_updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP`,
    ],
  },
  {
    name: 'ewoh_model_registry',
    columns: [
      `model_id varchar(255) NOT NULL UNIQUE`,
      `model_name varchar(255) NOT NULL`,
      `version varchar(50) NOT NULL`,
      `type varchar(100) NOT NULL`,
      `status varchar(50) DEFAULT 'active'`,
      `card_json jsonb`,
      `_created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP`,
      `_updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP`,
    ],
  },
  {
    name: 'ewoh_organization',
    columns: [
      `name varchar(255) NOT NULL`,
      `org_type varchar(100) NOT NULL`,
      `parent_id varchar(255)`,
      `description text`,
      `status varchar(50) DEFAULT 'active'`,
      `_created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP`,
      `_created_by ${SCHEMA}.user_profile DEFAULT ${USER_DEFAULT}`,
      `_updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP`,
      `_updated_by ${SCHEMA}.user_profile DEFAULT ${USER_DEFAULT}`,
    ],
  },
  {
    name: 'ewoh_personnel',
    columns: [
      `name varchar(255) NOT NULL`,
      `employee_no varchar(255) NOT NULL`,
      `org_id varchar(255)`,
      `team_name varchar(255)`,
      `position varchar(255)`,
      `skills jsonb`,
      `status varchar(50) DEFAULT 'available'`,
      `health_status varchar(50) DEFAULT 'normal'`,
      `current_load jsonb`,
      `spatial_entity_id varchar(255)`,
      `_created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP`,
      `_created_by ${SCHEMA}.user_profile DEFAULT ${USER_DEFAULT}`,
      `_updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP`,
      `_updated_by ${SCHEMA}.user_profile DEFAULT ${USER_DEFAULT}`,
    ],
  },
  {
    name: 'ewoh_production_task',
    columns: [
      `title varchar(255) NOT NULL`,
      `description text`,
      `task_type varchar(100) NOT NULL`,
      `priority varchar(50) DEFAULT 'medium'`,
      `status varchar(50) DEFAULT 'draft'`,
      `assignee_id varchar(255)`,
      `device_id varchar(255)`,
      `spatial_entity_id varchar(255)`,
      `plan_start timestamptz`,
      `plan_end timestamptz`,
      `progress integer DEFAULT 0`,
      `source varchar(50) DEFAULT 'manual'`,
      `_created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP`,
      `_created_by ${SCHEMA}.user_profile DEFAULT ${USER_DEFAULT}`,
      `_updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP`,
      `_updated_by ${SCHEMA}.user_profile DEFAULT ${USER_DEFAULT}`,
    ],
  },
  {
    name: 'ewoh_schedule_audit',
    columns: [
      `audit_id varchar(255) NOT NULL UNIQUE`,
      `plan_id varchar(255) NOT NULL`,
      `action varchar(100) NOT NULL`,
      `operator varchar(255)`,
      `reason text`,
      `created_at timestamptz DEFAULT CURRENT_TIMESTAMP`,
      `_created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP`,
      `_updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP`,
    ],
  },
  {
    name: 'ewoh_schedule_plan',
    columns: [
      `plan_id varchar(255) NOT NULL UNIQUE`,
      `plan_name varchar(255) NOT NULL`,
      `strategy varchar(100) NOT NULL`,
      `status varchar(50) DEFAULT 'shadow'`,
      `takt_improvement real DEFAULT 0`,
      `high_load_persons integer DEFAULT 0`,
      `low_battery_risk integer DEFAULT 0`,
      `affected_persons integer DEFAULT 0`,
      `metrics_json jsonb`,
      `reason text`,
      `created_at timestamptz DEFAULT CURRENT_TIMESTAMP`,
      `confirmed_by varchar(255)`,
      `confirmed_at timestamptz`,
      `confirm_reason text`,
      `_created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP`,
      `_updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP`,
    ],
  },
  {
    name: 'ewoh_scheduler_config',
    columns: [
      `config_key varchar(255) NOT NULL`,
      `config_value jsonb NOT NULL`,
      `updated_by varchar(255)`,
      `_created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP`,
      `_updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP`,
    ],
  },
  {
    name: 'ewoh_spatial_entity',
    columns: [
      `entity_id varchar(255) NOT NULL UNIQUE`,
      `entity_type varchar(100) NOT NULL`,
      `parent_id varchar(255)`,
      `name varchar(255) NOT NULL`,
      `x real DEFAULT 0`,
      `y real DEFAULT 0`,
      `yaw real DEFAULT 0`,
      `bbox_w real DEFAULT 0`,
      `bbox_h real DEFAULT 0`,
      `status varchar(100) DEFAULT 'active'`,
      `source_type varchar(50) DEFAULT 'seed'`,
      `confidence real DEFAULT 1.0`,
      `version integer DEFAULT 1`,
      `extra jsonb`,
      `_created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP`,
      `_updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP`,
    ],
  },
  {
    name: 'ewoh_telemetry',
    columns: [
      `device_id varchar(255) NOT NULL`,
      `ts timestamptz NOT NULL`,
      `pitch_deg real`,
      `load_score real`,
      `fatigue_trend real`,
      `battery_pct integer`,
      `quality_status varchar(255)`,
      `_created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP`,
      `_updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP`,
      `source_type varchar(50) DEFAULT 'simulated'`,
      `record_id varchar(64)`,
      `ingested_at timestamptz DEFAULT CURRENT_TIMESTAMP`,
      `raw_ref varchar(128)`,
      `joint_angles jsonb`,
      `angular_velocity_dps real`,
      `assist_level varchar(50)`,
      `torque_nm real`,
      `cumulative_load_score real`,
      `temperature_c real`,
      `fault_code varchar(100)`,
      `packet_loss_pct real DEFAULT 0`,
      `data_confidence real DEFAULT 1.0`,
      `data_quality varchar(20) DEFAULT 'good'`,
    ],
  },
  {
    name: 'ewoh_topology',
    columns: [
      `from_entity varchar(255) NOT NULL`,
      `to_entity varchar(255) NOT NULL`,
      `relation varchar(100) DEFAULT 'adjacent'`,
      `distance real DEFAULT 0`,
      `_created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP`,
      `_updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP`,
    ],
  },
  {
    name: 'ewoh_world_state',
    columns: [
      `entity_id varchar(255) NOT NULL`,
      `state_json jsonb NOT NULL`,
      `ts timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP`,
      `_created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP`,
      `_updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP`,
    ],
  },
];

const NEW_TABLES = [
  {
    name: 'ewoh_person_skill',
    domain: 'Organization',
    logicalName: 'ewoh_person_skill',
    businessKey: ['org_id', 'person_id', 'skill_id'],
    orgPolicy: 'not_null',
    capabilities: ['person.skill'],
    columns: [
      `person_id varchar(255) NOT NULL`,
      `skill_id varchar(255) NOT NULL`,
      `level varchar(50) NOT NULL DEFAULT 'basic'`,
      `certified boolean NOT NULL DEFAULT false`,
      `certified_at timestamptz`,
      `expires_at timestamptz`,
      `status varchar(50) NOT NULL DEFAULT 'active'`,
      `UNIQUE (org_id, person_id, skill_id)`,
    ],
  },
  {
    name: 'ewoh_skill',
    domain: 'Organization',
    logicalName: 'ewoh_skill',
    businessKey: ['org_id', 'skill_id'],
    orgPolicy: 'not_null',
    capabilities: ['skill.registry'],
    columns: [
      `skill_id varchar(255) NOT NULL UNIQUE`,
      `name varchar(255) NOT NULL`,
      `category varchar(100)`,
      `description text`,
      `certification_required boolean NOT NULL DEFAULT false`,
      `status varchar(50) NOT NULL DEFAULT 'active'`,
      `deleted_at timestamptz`,
    ],
  },
  {
    name: 'ewoh_role',
    domain: 'Organization',
    logicalName: 'ewoh_role',
    businessKey: ['org_id', 'role_id'],
    orgPolicy: 'not_null',
    capabilities: ['role.registry'],
    columns: [
      `role_id varchar(255) NOT NULL UNIQUE`,
      `name varchar(255) NOT NULL`,
      `code varchar(100) NOT NULL`,
      `description text`,
      `scope varchar(50) NOT NULL DEFAULT 'org'`,
      `status varchar(50) NOT NULL DEFAULT 'active'`,
      `deleted_at timestamptz`,
      `UNIQUE (org_id, code)`,
    ],
  },
  {
    name: 'ewoh_person_role',
    domain: 'Organization',
    logicalName: 'ewoh_person_role',
    businessKey: ['org_id', 'person_id', 'role_id'],
    orgPolicy: 'not_null',
    capabilities: ['person.role'],
    columns: [
      `person_id varchar(255) NOT NULL`,
      `role_id varchar(255) NOT NULL`,
      `effective_from timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP`,
      `effective_to timestamptz`,
      `status varchar(50) NOT NULL DEFAULT 'active'`,
      `UNIQUE (org_id, person_id, role_id)`,
    ],
  },
  {
    name: 'ewoh_device_capability',
    domain: 'Device',
    logicalName: 'ewoh_device_capability',
    businessKey: ['org_id', 'device_id', 'capability_key'],
    orgPolicy: 'not_null',
    capabilities: ['device.capability'],
    columns: [
      `capability_id varchar(255) NOT NULL UNIQUE`,
      `device_id varchar(255) NOT NULL`,
      `capability_type varchar(100) NOT NULL`,
      `capability_key varchar(255) NOT NULL`,
      `capability_value jsonb`,
      `compatible boolean NOT NULL DEFAULT true`,
      `version integer NOT NULL DEFAULT 1`,
      `status varchar(50) NOT NULL DEFAULT 'active'`,
      `effective_from timestamptz`,
      `effective_to timestamptz`,
      `UNIQUE (org_id, device_id, capability_key)`,
    ],
  },
  {
    name: 'ewoh_spatial_relation',
    domain: 'Spatial',
    logicalName: 'ewoh_spatial_relation',
    businessKey: ['org_id', 'from_entity_id', 'to_entity_id', 'relation_type'],
    orgPolicy: 'not_null',
    capabilities: ['spatial.relation'],
    columns: [
      `relation_id varchar(255) NOT NULL UNIQUE`,
      `from_entity_id varchar(255) NOT NULL`,
      `to_entity_id varchar(255) NOT NULL`,
      `relation_type varchar(100) NOT NULL`,
      `distance_m numeric(18,4)`,
      `route_json jsonb`,
      `status varchar(50) NOT NULL DEFAULT 'active'`,
      `valid_from timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP`,
      `valid_to timestamptz`,
      `UNIQUE (org_id, from_entity_id, to_entity_id, relation_type)`,
    ],
  },
  {
    name: 'ewoh_spatial_hierarchy',
    domain: 'Spatial',
    logicalName: 'ewoh_spatial_hierarchy',
    businessKey: ['org_id', 'parent_entity_id', 'child_entity_id'],
    orgPolicy: 'not_null',
    capabilities: ['spatial.hierarchy'],
    columns: [
      `parent_entity_id varchar(255) NOT NULL`,
      `child_entity_id varchar(255) NOT NULL`,
      `hierarchy_level integer NOT NULL DEFAULT 0`,
      `path varchar(2048)`,
      `sort_order integer NOT NULL DEFAULT 0`,
      `status varchar(50) NOT NULL DEFAULT 'active'`,
      `UNIQUE (org_id, parent_entity_id, child_entity_id)`,
    ],
  },
  {
    name: 'ewoh_model_asset',
    domain: 'Model',
    logicalName: 'ewoh_model_asset',
    businessKey: ['org_id', 'asset_id'],
    orgPolicy: 'not_null',
    capabilities: ['model.asset'],
    columns: [
      `asset_id varchar(255) NOT NULL UNIQUE`,
      `name varchar(255) NOT NULL`,
      `asset_type varchar(50) NOT NULL`,
      `lod varchar(10) NOT NULL DEFAULT 'L0'`,
      `uri varchar(2048) NOT NULL`,
      `version integer NOT NULL DEFAULT 1`,
      `checksum varchar(128)`,
      `provenance text`,
      `spatial_entity_id varchar(255)`,
      `model_node_id varchar(255)`,
      `model_version_id varchar(255)`,
      `status varchar(50) NOT NULL DEFAULT 'draft'`,
      `published_at timestamptz`,
      `deleted_at timestamptz`,
    ],
  },
  {
    name: 'ewoh_model_binding',
    domain: 'Model',
    logicalName: 'ewoh_model_binding',
    businessKey: ['org_id', 'model_asset_id', 'entity_id', 'binding_type'],
    orgPolicy: 'not_null',
    capabilities: ['model.binding'],
    columns: [
      `binding_id varchar(255) NOT NULL UNIQUE`,
      `model_asset_id varchar(255) NOT NULL`,
      `entity_id varchar(255) NOT NULL`,
      `entity_type varchar(50) NOT NULL`,
      `binding_type varchar(100) NOT NULL`,
      `priority integer NOT NULL DEFAULT 0`,
      `status varchar(50) NOT NULL DEFAULT 'active'`,
      `effective_from timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP`,
      `effective_to timestamptz`,
      `UNIQUE (org_id, model_asset_id, entity_id, binding_type)`,
    ],
  },
  {
    name: 'ewoh_workstation',
    domain: 'Workstation',
    logicalName: 'ewoh_workstation',
    businessKey: ['org_id', 'workstation_id'],
    orgPolicy: 'not_null',
    capabilities: ['workstation.registry'],
    columns: [
      `workstation_id varchar(255) NOT NULL UNIQUE`,
      `name varchar(255) NOT NULL`,
      `workstation_type varchar(100) NOT NULL`,
      `spatial_entity_id varchar(255)`,
      `description text`,
      `capacity integer NOT NULL DEFAULT 1`,
      `status varchar(50) NOT NULL DEFAULT 'active'`,
      `deleted_at timestamptz`,
    ],
  },
  {
    name: 'ewoh_workstation_device',
    domain: 'Workstation',
    logicalName: 'ewoh_workstation_device',
    businessKey: ['org_id', 'workstation_id', 'device_id', 'binding_type'],
    orgPolicy: 'not_null',
    capabilities: ['workstation.device'],
    columns: [
      `workstation_id varchar(255) NOT NULL`,
      `device_id varchar(255) NOT NULL`,
      `binding_type varchar(100) NOT NULL DEFAULT 'installed'`,
      `start_time timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP`,
      `end_time timestamptz`,
      `status varchar(50) NOT NULL DEFAULT 'active'`,
      `operator_id varchar(255)`,
      `UNIQUE (org_id, workstation_id, device_id, binding_type)`,
    ],
  },
  {
    name: 'ewoh_workstation_person',
    domain: 'Workstation',
    logicalName: 'ewoh_workstation_person',
    businessKey: ['org_id', 'workstation_id', 'person_id', 'assignment_role'],
    orgPolicy: 'not_null',
    capabilities: ['workstation.person'],
    columns: [
      `workstation_id varchar(255) NOT NULL`,
      `person_id varchar(255) NOT NULL`,
      `assignment_role varchar(100) NOT NULL DEFAULT 'worker'`,
      `start_time timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP`,
      `end_time timestamptz`,
      `status varchar(50) NOT NULL DEFAULT 'active'`,
      `UNIQUE (org_id, workstation_id, person_id, assignment_role)`,
    ],
  },
  {
    name: 'ewoh_workstation_skill',
    domain: 'Workstation',
    logicalName: 'ewoh_workstation_skill',
    businessKey: ['org_id', 'workstation_id', 'skill_id'],
    orgPolicy: 'not_null',
    capabilities: ['workstation.skill'],
    columns: [
      `workstation_id varchar(255) NOT NULL`,
      `skill_id varchar(255) NOT NULL`,
      `required_level varchar(50) NOT NULL DEFAULT 'basic'`,
      `min_count integer NOT NULL DEFAULT 1`,
      `status varchar(50) NOT NULL DEFAULT 'active'`,
      `UNIQUE (org_id, workstation_id, skill_id)`,
    ],
  },
  {
    name: 'ewoh_workstation_relation',
    domain: 'Workstation',
    logicalName: 'ewoh_workstation_relation',
    businessKey: ['org_id', 'from_workstation_id', 'to_workstation_id', 'relation_type'],
    orgPolicy: 'not_null',
    capabilities: ['workstation.relation'],
    columns: [
      `relation_id varchar(255) NOT NULL UNIQUE`,
      `from_workstation_id varchar(255) NOT NULL`,
      `to_workstation_id varchar(255) NOT NULL`,
      `relation_type varchar(100) NOT NULL`,
      `distance_m numeric(18,4)`,
      `status varchar(50) NOT NULL DEFAULT 'active'`,
      `UNIQUE (org_id, from_workstation_id, to_workstation_id, relation_type)`,
    ],
  },
  {
    name: 'ewoh_task_template',
    domain: 'Task',
    logicalName: 'ewoh_task_template',
    businessKey: ['org_id', 'template_id'],
    orgPolicy: 'not_null',
    capabilities: ['task.template'],
    columns: [
      `template_id varchar(255) NOT NULL UNIQUE`,
      `name varchar(255) NOT NULL`,
      `task_type varchar(100) NOT NULL`,
      `description text`,
      `priority varchar(50) NOT NULL DEFAULT 'medium'`,
      `estimated_duration_sec integer`,
      `risk_level varchar(50) NOT NULL DEFAULT 'low'`,
      `status varchar(50) NOT NULL DEFAULT 'active'`,
      `version integer NOT NULL DEFAULT 1`,
      `deleted_at timestamptz`,
    ],
  },
  {
    name: 'ewoh_task_step',
    domain: 'Task',
    logicalName: 'ewoh_task_step',
    businessKey: ['org_id', 'template_id', 'step_no'],
    orgPolicy: 'not_null',
    capabilities: ['task.step'],
    columns: [
      `step_id varchar(255) NOT NULL UNIQUE`,
      `template_id varchar(255) NOT NULL`,
      `step_no integer NOT NULL`,
      `name varchar(255) NOT NULL`,
      `instruction text`,
      `duration_sec integer`,
      `status varchar(50) NOT NULL DEFAULT 'active'`,
      `UNIQUE (org_id, template_id, step_no)`,
    ],
  },
  {
    name: 'ewoh_task_skill_req',
    domain: 'Task',
    logicalName: 'ewoh_task_skill_req',
    businessKey: ['org_id', 'task_step_id', 'skill_id'],
    orgPolicy: 'not_null',
    capabilities: ['task.skill_requirement'],
    columns: [
      `task_step_id varchar(255) NOT NULL`,
      `skill_id varchar(255) NOT NULL`,
      `required_level varchar(50) NOT NULL DEFAULT 'basic'`,
      `min_people integer NOT NULL DEFAULT 1`,
      `max_people integer`,
      `priority integer NOT NULL DEFAULT 0`,
      `UNIQUE (org_id, task_step_id, skill_id)`,
    ],
  },
  {
    name: 'ewoh_schedule_task',
    domain: 'Schedule',
    logicalName: 'ewoh_schedule_task',
    businessKey: ['org_id', 'schedule_task_id'],
    orgPolicy: 'not_null',
    capabilities: ['schedule.task'],
    columns: [
      `schedule_task_id varchar(255) NOT NULL UNIQUE`,
      `template_id varchar(255)`,
      `title varchar(255) NOT NULL`,
      `description text`,
      `status varchar(50) NOT NULL DEFAULT 'draft'`,
      `priority varchar(50) NOT NULL DEFAULT 'medium'`,
      `source varchar(50) NOT NULL DEFAULT 'manual'`,
      `plan_start timestamptz`,
      `plan_end timestamptz`,
      `actual_start timestamptz`,
      `actual_end timestamptz`,
      `parent_task_id varchar(255)`,
      `approval_id varchar(255)`,
      `suggestion_id varchar(255)`,
      `session_id varchar(255)`,
      `is_simulation boolean NOT NULL DEFAULT false`,
      `progress integer NOT NULL DEFAULT 0`,
      `deleted_at timestamptz`,
    ],
  },
  {
    name: 'ewoh_schedule_task_step',
    domain: 'Schedule',
    logicalName: 'ewoh_schedule_task_step',
    businessKey: ['org_id', 'schedule_task_id', 'step_no'],
    orgPolicy: 'not_null',
    capabilities: ['schedule.task_step'],
    columns: [
      `step_id varchar(255) NOT NULL UNIQUE`,
      `schedule_task_id varchar(255) NOT NULL`,
      `step_no integer NOT NULL`,
      `name varchar(255) NOT NULL`,
      `instruction text`,
      `status varchar(50) NOT NULL DEFAULT 'pending'`,
      `planned_start timestamptz`,
      `planned_end timestamptz`,
      `actual_start timestamptz`,
      `actual_end timestamptz`,
      `assigned_person_id varchar(255)`,
      `assigned_device_id varchar(255)`,
      `spatial_entity_id varchar(255)`,
      `progress integer NOT NULL DEFAULT 0`,
      `result_json jsonb`,
      `parent_step_id varchar(255)`,
      `UNIQUE (org_id, schedule_task_id, step_no)`,
    ],
  },
  {
    name: 'ewoh_schedule_assignment',
    domain: 'Schedule',
    logicalName: 'ewoh_schedule_assignment',
    businessKey: ['org_id', 'assignment_id'],
    orgPolicy: 'not_null',
    capabilities: ['schedule.assignment'],
    columns: [
      `assignment_id varchar(255) NOT NULL UNIQUE`,
      `schedule_task_id varchar(255) NOT NULL`,
      `task_step_id varchar(255)`,
      `assignee_type varchar(50) NOT NULL`,
      `assignee_id varchar(255) NOT NULL`,
      `assignment_role varchar(100) NOT NULL DEFAULT 'executor'`,
      `planned_start timestamptz`,
      `planned_end timestamptz`,
      `actual_start timestamptz`,
      `actual_end timestamptz`,
      `status varchar(50) NOT NULL DEFAULT 'assigned'`,
      `is_primary boolean NOT NULL DEFAULT false`,
    ],
  },
  {
    name: 'ewoh_resource_preorder',
    domain: 'Resource',
    logicalName: 'ewoh_resource_preorder',
    businessKey: ['org_id', 'preorder_id'],
    orgPolicy: 'not_null',
    capabilities: ['resource.preorder'],
    columns: [
      `preorder_id varchar(255) NOT NULL UNIQUE`,
      `resource_type varchar(100) NOT NULL`,
      `resource_id varchar(255) NOT NULL`,
      `quantity numeric(18,4) NOT NULL DEFAULT 0`,
      `reserved_qty numeric(18,4) NOT NULL DEFAULT 0`,
      `issued_qty numeric(18,4) NOT NULL DEFAULT 0`,
      `consumed_qty numeric(18,4) NOT NULL DEFAULT 0`,
      `returned_qty numeric(18,4) NOT NULL DEFAULT 0`,
      `unit varchar(50)`,
      `batch_no varchar(255)`,
      `task_id varchar(255)`,
      `task_step_id varchar(255)`,
      `status varchar(50) NOT NULL DEFAULT 'pending'`,
      `priority integer NOT NULL DEFAULT 0`,
      `start_time timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP`,
      `end_time timestamptz`,
    ],
  },
  {
    name: 'ewoh_resource_binding',
    domain: 'Resource',
    logicalName: 'ewoh_resource_binding',
    businessKey: ['org_id', 'resource_id', 'target_id', 'binding_type'],
    orgPolicy: 'not_null',
    capabilities: ['resource.binding'],
    columns: [
      `binding_id varchar(255) NOT NULL UNIQUE`,
      `binding_type varchar(100) NOT NULL`,
      `resource_type varchar(100) NOT NULL`,
      `resource_id varchar(255) NOT NULL`,
      `target_type varchar(100) NOT NULL`,
      `target_id varchar(255) NOT NULL`,
      `start_time timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP`,
      `end_time timestamptz`,
      `reason text`,
      `status varchar(50) NOT NULL DEFAULT 'active'`,
      `operator_id varchar(255)`,
      `quantity numeric(18,4) NOT NULL DEFAULT 0`,
      `version integer NOT NULL DEFAULT 1`,
      `UNIQUE (org_id, resource_id, target_id, binding_type)`,
    ],
  },
  {
    name: 'ewoh_control_request',
    domain: 'Control',
    logicalName: 'ewoh_control_request',
    businessKey: ['org_id', 'request_id'],
    orgPolicy: 'not_null',
    capabilities: ['control.request'],
    columns: [
      `request_id varchar(255) NOT NULL UNIQUE`,
      `device_id varchar(255) NOT NULL`,
      `control_type varchar(100) NOT NULL`,
      `command_keys jsonb NOT NULL DEFAULT '[]'`,
      `status varchar(50) NOT NULL DEFAULT 'draft'`,
      `idempotency_key varchar(255)`,
      `requested_by varchar(255)`,
      `approved_by varchar(255)`,
      `approved_at timestamptz`,
      `reason text`,
      `risk_level varchar(50) NOT NULL DEFAULT 'normal'`,
      `requires_secondary_confirm boolean NOT NULL DEFAULT true`,
      `deadline timestamptz`,
      `requested_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP`,
      `completed_at timestamptz`,
    ],
    extraIndexes: [
      `CREATE INDEX IF NOT EXISTS idx_ewoh_control_request_org ON ${SCHEMA}.ewoh_control_request (org_id);`,
      `CREATE UNIQUE INDEX IF NOT EXISTS uq_ewoh_control_request_org_idem ON ${SCHEMA}.ewoh_control_request (org_id, idempotency_key) WHERE idempotency_key IS NOT NULL;`,
    ],
  },
  {
    name: 'ewoh_control_command',
    domain: 'Control',
    logicalName: 'ewoh_control_command',
    businessKey: ['org_id', 'root_command_id', 'attempt_no', 'command_key'],
    orgPolicy: 'not_null',
    capabilities: ['control.command'],
    columns: [
      `command_id varchar(255) NOT NULL UNIQUE`,
      `request_id varchar(255) NOT NULL`,
      `root_command_id varchar(255) NOT NULL`,
      `attempt_no integer NOT NULL DEFAULT 1`,
      `command_key varchar(255) NOT NULL`,
      `payload jsonb`,
      `status varchar(50) NOT NULL DEFAULT 'pending'`,
      `sent_at timestamptz`,
      `response_at timestamptz`,
      `response_json jsonb`,
      `error_code varchar(100)`,
      `error_message text`,
      `idempotency_key varchar(255)`,
      `UNIQUE (org_id, root_command_id, attempt_no, command_key)`,
    ],
  },
  {
    name: 'ewoh_control_result',
    domain: 'Control',
    logicalName: 'ewoh_control_result',
    businessKey: ['org_id', 'result_id'],
    orgPolicy: 'not_null',
    capabilities: ['control.result'],
    columns: [
      `result_id varchar(255) NOT NULL UNIQUE`,
      `request_id varchar(255) NOT NULL`,
      `command_id varchar(255) NOT NULL`,
      `result_type varchar(100) NOT NULL`,
      `result_code varchar(100)`,
      `result_json jsonb`,
      `success boolean NOT NULL DEFAULT false`,
      `completed_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP`,
      `operator_id varchar(255)`,
    ],
  },
  {
    name: 'ewoh_event_rule',
    domain: 'Event',
    logicalName: 'ewoh_event_rule',
    businessKey: ['org_id', 'rule_id'],
    orgPolicy: 'not_null',
    capabilities: ['event.rule'],
    columns: [
      `rule_id varchar(255) NOT NULL UNIQUE`,
      `name varchar(255) NOT NULL`,
      `rule_type varchar(100) NOT NULL`,
      `trigger_json jsonb NOT NULL DEFAULT '{}'`,
      `conditions_json jsonb`,
      `actions_json jsonb NOT NULL DEFAULT '[]'`,
      `priority integer NOT NULL DEFAULT 0`,
      `enabled boolean NOT NULL DEFAULT true`,
      `version integer NOT NULL DEFAULT 1`,
      `effective_from timestamptz`,
      `effective_to timestamptz`,
      `deleted_at timestamptz`,
    ],
  },
  {
    name: 'ewoh_event_action',
    domain: 'Event',
    logicalName: 'ewoh_event_action',
    businessKey: ['org_id', 'action_id'],
    orgPolicy: 'not_null',
    capabilities: ['event.action'],
    columns: [
      `action_id varchar(255) NOT NULL UNIQUE`,
      `rule_id varchar(255) NOT NULL`,
      `action_type varchar(100) NOT NULL`,
      `action_config jsonb NOT NULL DEFAULT '{}'`,
      `status varchar(50) NOT NULL DEFAULT 'active'`,
      `executed_count integer NOT NULL DEFAULT 0`,
      `last_executed_at timestamptz`,
    ],
  },
  {
    name: 'ewoh_event_subscription',
    domain: 'Event',
    logicalName: 'ewoh_event_subscription',
    businessKey: ['org_id', 'subscription_id'],
    orgPolicy: 'not_null',
    capabilities: ['event.subscription'],
    columns: [
      `subscription_id varchar(255) NOT NULL UNIQUE`,
      `subscriber_type varchar(50) NOT NULL`,
      `subscriber_id varchar(255) NOT NULL`,
      `event_type varchar(255) NOT NULL`,
      `severity_filter jsonb`,
      `channel varchar(100) NOT NULL`,
      `config jsonb`,
      `enabled boolean NOT NULL DEFAULT true`,
    ],
  },
  {
    name: 'ewoh_world_snapshot',
    domain: 'World',
    logicalName: 'ewoh_world_snapshot',
    businessKey: ['org_id', 'snapshot_version'],
    orgPolicy: 'special',
    capabilities: ['world.snapshot'],
    columns: [
      `snapshot_version bigint NOT NULL`,
      `snapshot_type varchar(50) NOT NULL DEFAULT 'full'`,
      `payload jsonb NOT NULL`,
      `entity_count integer NOT NULL DEFAULT 0`,
      `checksum varchar(128)`,
      `source_type varchar(50) NOT NULL DEFAULT 'simulated'`,
      `created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP`,
    ],
    extraIndexes: [
      `CREATE INDEX IF NOT EXISTS idx_ewoh_world_snapshot_org ON ${SCHEMA}.ewoh_world_snapshot (org_id);`,
      `CREATE UNIQUE INDEX IF NOT EXISTS uq_ewoh_world_snapshot_org_version ON ${SCHEMA}.ewoh_world_snapshot (coalesce(org_id, '00000000-0000-4000-8000-000000000000'::uuid), snapshot_version);`,
    ],
  },
  {
    name: 'ewoh_world_delta_log',
    domain: 'World',
    logicalName: 'ewoh_world_delta_log',
    businessKey: ['org_id', 'seq'],
    orgPolicy: 'special',
    capabilities: ['world.delta'],
    columns: [
      `seq bigint GENERATED ALWAYS AS IDENTITY UNIQUE NOT NULL`,
      `snapshot_version bigint NOT NULL`,
      `entity_type varchar(100) NOT NULL`,
      `entity_id varchar(255) NOT NULL`,
      `delta_type varchar(50) NOT NULL`,
      `payload jsonb`,
      `before_json jsonb`,
      `occurred_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP`,
      `source_type varchar(50) NOT NULL DEFAULT 'simulated'`,
    ],
    extraIndexes: [
      `CREATE INDEX IF NOT EXISTS idx_ewoh_world_delta_org_seq ON ${SCHEMA}.ewoh_world_delta_log (org_id, seq);`,
      `CREATE INDEX IF NOT EXISTS idx_ewoh_world_delta_version_seq ON ${SCHEMA}.ewoh_world_delta_log (snapshot_version, seq);`,
    ],
  },
  {
    name: 'ewoh_system_config',
    domain: 'System',
    logicalName: 'ewoh_system_config',
    businessKey: ['org_id', 'config_key'],
    orgPolicy: 'special',
    capabilities: ['system.config'],
    columns: [
      `config_id varchar(255) NOT NULL UNIQUE`,
      `config_key varchar(255) NOT NULL`,
      `config_value jsonb NOT NULL`,
      `is_public boolean NOT NULL DEFAULT false`,
      `version integer NOT NULL DEFAULT 1`,
      `effective_from timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP`,
      `effective_to timestamptz`,
      `status varchar(50) NOT NULL DEFAULT 'active'`,
      `deleted_at timestamptz`,
    ],
    extraIndexes: [
      `CREATE INDEX IF NOT EXISTS idx_ewoh_system_config_org ON ${SCHEMA}.ewoh_system_config (org_id);`,
      `CREATE UNIQUE INDEX IF NOT EXISTS uq_ewoh_system_config_org_key ON ${SCHEMA}.ewoh_system_config (coalesce(org_id, '00000000-0000-4000-8000-000000000000'::uuid), config_key);`,
    ],
  },
  {
    name: 'ewoh_knowledge_base',
    domain: 'System',
    logicalName: 'ewoh_knowledge_base',
    businessKey: ['org_id', 'base_id'],
    orgPolicy: 'not_null',
    capabilities: ['knowledge.base'],
    columns: [
      `base_id varchar(255) NOT NULL UNIQUE`,
      `name varchar(255) NOT NULL`,
      `description text`,
      `knowledge_type varchar(100) NOT NULL DEFAULT 'general'`,
      `status varchar(50) NOT NULL DEFAULT 'active'`,
      `version integer NOT NULL DEFAULT 1`,
      `deleted_at timestamptz`,
    ],
  },
  {
    name: 'ewoh_knowledge_entry',
    domain: 'System',
    logicalName: 'ewoh_knowledge_entry',
    businessKey: ['org_id', 'entry_id'],
    orgPolicy: 'not_null',
    capabilities: ['knowledge.entry'],
    columns: [
      `entry_id varchar(255) NOT NULL UNIQUE`,
      `base_id varchar(255) NOT NULL`,
      `title varchar(255) NOT NULL`,
      `content text NOT NULL`,
      `tags jsonb NOT NULL DEFAULT '[]'`,
      `source_type varchar(50) NOT NULL DEFAULT 'manual'`,
      `checksum varchar(128)`,
      `status varchar(50) NOT NULL DEFAULT 'draft'`,
      `version integer NOT NULL DEFAULT 1`,
      `deleted_at timestamptz`,
    ],
  },
  {
    name: 'ewoh_notification',
    domain: 'System',
    logicalName: 'ewoh_notification',
    businessKey: ['org_id', 'notification_id'],
    orgPolicy: 'not_null',
    capabilities: ['notification.registry'],
    columns: [
      `notification_id varchar(255) NOT NULL UNIQUE`,
      `recipient_type varchar(50) NOT NULL`,
      `recipient_id varchar(255) NOT NULL`,
      `channel varchar(100) NOT NULL`,
      `title varchar(255) NOT NULL`,
      `body text`,
      `severity varchar(50) NOT NULL DEFAULT 'info'`,
      `status varchar(50) NOT NULL DEFAULT 'pending'`,
      `scheduled_at timestamptz`,
      `sent_at timestamptz`,
      `read_at timestamptz`,
      `external_ref varchar(255)`,
      `error_message text`,
    ],
  },
  {
    name: 'ewoh_audit_log',
    domain: 'System',
    logicalName: 'ewoh_audit_log',
    businessKey: ['org_id', 'audit_seq'],
    orgPolicy: 'special',
    capabilities: ['audit.log'],
    columns: [
      `audit_seq bigint GENERATED ALWAYS AS IDENTITY UNIQUE NOT NULL`,
      `actor_id varchar(255) NOT NULL`,
      `action varchar(100) NOT NULL`,
      `entity_type varchar(255) NOT NULL`,
      `entity_id varchar(255) NOT NULL`,
      `before_json jsonb`,
      `after_json jsonb`,
      `reason text`,
      `client_ip varchar(64)`,
      `request_id varchar(128)`,
      `risk_level varchar(50) NOT NULL DEFAULT 'normal'`,
      `is_high_risk boolean NOT NULL DEFAULT false`,
      `occurred_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP`,
      `chain_seq bigint NOT NULL`,
      `prev_hash varchar(64) NOT NULL DEFAULT repeat('0', 64)`,
      `hash varchar(64) NOT NULL`,
    ],
    extraIndexes: [
      `CREATE INDEX IF NOT EXISTS idx_ewoh_audit_log_org_seq ON ${SCHEMA}.ewoh_audit_log (org_id, audit_seq);`,
      `CREATE INDEX IF NOT EXISTS idx_ewoh_audit_log_entity ON ${SCHEMA}.ewoh_audit_log (entity_type, entity_id);`,
    ],
  },
];

const ALTERED_TABLES = [
  { name: 'ewoh_scheduler_config', domain: 'Schedule', businessKey: ['org_id', 'config_key'], orgPolicy: 'not_null', capabilities: ['schedule.config'], status: 'altered' },
  { name: 'ewoh_environment', domain: 'Device', businessKey: ['org_id', 'sensor_id', 'ts'], orgPolicy: 'not_null', capabilities: ['device.environment'], status: 'altered' },
  { name: 'ewoh_model_registry', domain: 'Model', businessKey: ['org_id', 'model_id'], orgPolicy: 'not_null', capabilities: ['model.registry'], status: 'altered' },
  { name: 'ewoh_schedule_audit', domain: 'Schedule', businessKey: ['org_id', 'audit_id'], orgPolicy: 'not_null', capabilities: ['schedule.audit'], status: 'altered' },
  { name: 'ewoh_schedule_plan', domain: 'Schedule', businessKey: ['org_id', 'plan_id'], orgPolicy: 'not_null', capabilities: ['schedule.plan'], status: 'altered' },
  { name: 'ewoh_event_chain', domain: 'Event', businessKey: ['org_id', 'event_id', 'parent_event_id'], orgPolicy: 'not_null', capabilities: ['event.chain'], status: 'altered' },
  { name: 'ewoh_world_state', domain: 'World', businessKey: ['org_id', 'entity_id', 'ts'], orgPolicy: 'not_null', capabilities: ['world.state'], status: 'altered' },
  { name: 'ewoh_topology', domain: 'Spatial', businessKey: ['org_id', 'from_entity', 'to_entity', 'relation'], orgPolicy: 'not_null', capabilities: ['spatial.topology'], status: 'altered' },
  { name: 'ewoh_spatial_entity', domain: 'Spatial', businessKey: ['org_id', 'entity_id'], orgPolicy: 'not_null', capabilities: ['spatial.entity'], status: 'altered' },
  { name: 'ewoh_telemetry', domain: 'Device', businessKey: ['org_id', 'device_id', 'ts', 'record_id'], orgPolicy: 'not_null', capabilities: ['device.telemetry'], status: 'altered' },
  { name: 'ewoh_event', domain: 'Event', businessKey: ['org_id', 'event_id'], orgPolicy: 'not_null', capabilities: ['event.registry'], status: 'altered' },
  { name: 'ewoh_device', domain: 'Device', businessKey: ['org_id', 'device_id'], orgPolicy: 'not_null', capabilities: ['device.registry'], status: 'altered' },
];

const MAPPED_EXISTING = [
  {
    name: 'ewoh_organization',
    logicalName: 'ewoh_organization',
    domain: 'Organization',
    businessKey: ['org_id', 'id'],
    orgPolicy: 'not_null',
    capabilities: ['org.management'],
    status: 'mapped-existing',
  },
  {
    name: 'ewoh_personnel',
    logicalName: 'ewoh_person',
    domain: 'Organization',
    businessKey: ['org_id', 'employee_no'],
    orgPolicy: 'not_null',
    capabilities: ['person.profile'],
    status: 'mapped-existing',
  },
  {
    name: 'ewoh_ai_suggestion',
    logicalName: 'ewoh_ai_suggestion',
    domain: 'AI',
    businessKey: ['org_id', 'suggestion_id'],
    orgPolicy: 'not_null',
    capabilities: ['ai.suggestion'],
    status: 'mapped-existing',
  },
  {
    name: 'ewoh_device_config',
    logicalName: 'ewoh_device_config',
    domain: 'Device',
    businessKey: ['org_id', 'device_id'],
    orgPolicy: 'not_null',
    capabilities: ['device.configuration'],
    status: 'mapped-existing',
  },
  {
    name: 'ewoh_production_task',
    logicalName: 'ewoh_production_task',
    domain: 'Task',
    businessKey: ['org_id', 'id'],
    orgPolicy: 'not_null',
    capabilities: ['task.production_legacy'],
    status: 'mapped-existing',
  },
];

const DEVICE_BINDING_ENTRY = {
  name: 'ewoh_device_binding',
  logicalName: 'ewoh_device_person_binding',
  domain: 'Device',
  businessKey: ['org_id', 'device_id', 'target_id', 'binding_type'],
  orgPolicy: 'not_null',
  capabilities: ['device.person_binding', 'device.space_binding', 'device.device_binding'],
  status: 'mapped-existing',
};

const NEW_GROUP = [
  ...NEW_TABLES.filter((t) => t.name !== 'ewoh_device_binding'),
  DEVICE_BINDING_ENTRY,
].sort((a, b) => a.name.localeCompare(b.name));

function yamlString(value) {
  return JSON.stringify(String(value));
}

function yamlArray(values) {
  return JSON.stringify(values);
}

function renderManifest() {
  const lines = [];
  lines.push('# EWOH managed schema manifest');
  lines.push(`version: ${yamlString('1.0')}`);
  lines.push(`generated: ${yamlString('2026-08-03')}`);
  lines.push('source:');
  lines.push(`  data_contract: ${yamlString('.codex/artifacts/contracts/data-contract.md')}`);
  lines.push(`  security_contract: ${yamlString('.codex/artifacts/contracts/security-contract.md')}`);
  lines.push('managed_package:');
  lines.push(`  new_group_count: 36`);
  lines.push(`  frozen_alter_count: 12`);
  lines.push(`  managed_count: 48`);
  lines.push(`  physical_create_count: ${NEW_TABLES.length}`);
  lines.push(`  mapped_existing_count_in_group: 1`);
  lines.push('notes:');
  lines.push(`  - ${yamlString('Authoritative plan table 77 lists 38 logical new names under the label "36 new tables".')}`);
  lines.push(`  - ${yamlString('This package resolves the discrepancy by treating ewoh_organization and ewoh_person as capabilities satisfied by existing physical tables, leaving 36 rows in the new/expanded managed group.')}`);
  lines.push(`  - ${yamlString('Within that group, ewoh_device_person_binding is satisfied by the existing ewoh_device_binding table, so 35 physical CREATE statements are emitted.')}`);
  lines.push(`  - ${yamlString('No frozen capability is silently dropped; the capability map in tmp/ddl/capability-map.csv is the acceptance basis.')}`);
  lines.push('managed_tables:');
  for (const t of NEW_GROUP) {
    lines.push('  - domain: ' + yamlString(t.domain));
    lines.push(`    logical_name: ${yamlString(t.logicalName)}`);
    lines.push(`    physical_table: ${yamlString(t.name)}`);
    lines.push(`    business_key_columns: ${yamlArray(t.businessKey)}`);
    lines.push(`    org_id_policy: ${yamlString(t.orgPolicy === 'special' ? 'special' : 'NOT NULL')}`);
    lines.push(`    status: ${yamlString(t.status || 'new')}`);
    lines.push(`    capability_mapping: ${yamlArray(t.capabilities)}`);
  }
  for (const t of ALTERED_TABLES) {
    lines.push('  - domain: ' + yamlString(t.domain));
    lines.push(`    logical_name: ${yamlString(t.name)}`);
    lines.push(`    physical_table: ${yamlString(t.name)}`);
    lines.push(`    business_key_columns: ${yamlArray(t.businessKey)}`);
    lines.push(`    org_id_policy: ${yamlString(t.orgPolicy === 'special' ? 'special' : 'NOT NULL')}`);
    lines.push(`    status: ${yamlString('altered')}`);
    lines.push(`    capability_mapping: ${yamlArray(t.capabilities)}`);
  }
  lines.push('additional_hardened_existing_tables:');
  for (const t of MAPPED_EXISTING) {
    lines.push('  - domain: ' + yamlString(t.domain));
    lines.push(`    logical_name: ${yamlString(t.logicalName)}`);
    lines.push(`    physical_table: ${yamlString(t.name)}`);
    lines.push(`    business_key_columns: ${yamlArray(t.businessKey)}`);
    lines.push(`    org_id_policy: ${yamlString(t.orgPolicy === 'special' ? 'special' : 'NOT NULL')}`);
    lines.push(`    status: ${yamlString(t.status)}`);
    lines.push(`    capability_mapping: ${yamlArray(t.capabilities)}`);
  }
  return `${lines.join('\n')}\n`;
}

const CAPABILITIES = [
  ['org.management', 'organization management', 'ewoh_organization', 'mapped-existing', 'existing org master hardened with org_id/RLS', 'pending'],
  ['person.profile', 'personnel profile', 'ewoh_personnel', 'mapped-existing', 'ewoh_personnel satisfies ewoh_person; org_id converted to uuid', 'pending'],
  ['person.skill', 'person skill relation', 'ewoh_person_skill', 'new', 'new managed relation', 'pending'],
  ['skill.registry', 'skill registry', 'ewoh_skill', 'new', 'new managed master', 'pending'],
  ['role.registry', 'role registry', 'ewoh_role', 'new', 'new managed master', 'pending'],
  ['person.role', 'person role relation', 'ewoh_person_role', 'new', 'new managed relation', 'pending'],
  ['device.person_binding', 'device person binding', 'ewoh_device_binding', 'mapped-existing', 'existing generic binding satisfies device_person_binding', 'pending'],
  ['device.space_binding', 'device space binding', 'ewoh_device_binding', 'mapped-existing', 'existing binding_type=device_space rows', 'pending'],
  ['device.device_binding', 'device device binding', 'ewoh_device_binding', 'mapped-existing', 'existing binding_type=device_device rows', 'pending'],
  ['device.capability', 'device capability matrix', 'ewoh_device_capability', 'new', 'new managed capability/exoskeleton compatibility matrix', 'pending'],
  ['device.configuration', 'device 12-class configuration', 'ewoh_device_config', 'mapped-existing', 'existing config table hardened; capability remains', 'pending'],
  ['device.registry', 'device registry', 'ewoh_device', 'altered', 'frozen 12-table alter with lifecycle/runtime/health/category', 'pending'],
  ['device.telemetry', 'device telemetry', 'ewoh_telemetry', 'altered', 'frozen 12-table alter with org_id/RLS', 'pending'],
  ['device.environment', 'environment sensor data', 'ewoh_environment', 'altered', 'frozen 12-table alter with org_id/RLS', 'pending'],
  ['spatial.entity', 'spatial entity', 'ewoh_spatial_entity', 'altered', 'frozen detailed alter adds z/roll/pitch/bbox_d/coordinate fields', 'pending'],
  ['spatial.topology', 'spatial topology', 'ewoh_topology', 'altered', 'frozen 12-table alter with org_id/RLS', 'pending'],
  ['spatial.relation', 'spatial relation', 'ewoh_spatial_relation', 'new', 'new managed relation', 'pending'],
  ['spatial.hierarchy', 'spatial hierarchy', 'ewoh_spatial_hierarchy', 'new', 'new managed hierarchy', 'pending'],
  ['model.registry', 'AI/model registry', 'ewoh_model_registry', 'altered', 'frozen 12-table alter with org_id/RLS', 'pending'],
  ['model.asset', '3D scene asset', 'ewoh_model_asset', 'new', 'new managed asset authority', 'pending'],
  ['model.binding', 'model entity binding', 'ewoh_model_binding', 'new', 'new managed binding', 'pending'],
  ['workstation.registry', 'workstation registry', 'ewoh_workstation', 'new', 'new managed master', 'pending'],
  ['workstation.device', 'workstation device relation', 'ewoh_workstation_device', 'new', 'new managed relation', 'pending'],
  ['workstation.person', 'workstation person relation', 'ewoh_workstation_person', 'new', 'new managed relation', 'pending'],
  ['workstation.skill', 'workstation skill requirement', 'ewoh_workstation_skill', 'new', 'new managed relation', 'pending'],
  ['workstation.relation', 'workstation relation', 'ewoh_workstation_relation', 'new', 'new managed relation', 'pending'],
  ['task.template', 'task template', 'ewoh_task_template', 'new', 'new managed master', 'pending'],
  ['task.step', 'task step', 'ewoh_task_step', 'new', 'new managed step', 'pending'],
  ['task.skill_requirement', 'task skill requirement', 'ewoh_task_skill_req', 'new', 'new managed relation', 'pending'],
  ['task.production_legacy', 'legacy production task', 'ewoh_production_task', 'mapped-existing', 'legacy source hardened; schedule_task is the managed task target', 'pending'],
  ['schedule.config', 'scheduler configuration', 'ewoh_scheduler_config', 'altered', 'frozen 12-table alter with org_id/RLS', 'pending'],
  ['schedule.plan', 'schedule plan', 'ewoh_schedule_plan', 'altered', 'frozen detailed alter adds suggestion/session/version/parent/is_simulation/approval', 'pending'],
  ['schedule.audit', 'schedule audit', 'ewoh_schedule_audit', 'altered', 'frozen 12-table alter with org_id/RLS', 'pending'],
  ['schedule.task', 'schedule task', 'ewoh_schedule_task', 'new', 'new managed task lifecycle', 'pending'],
  ['schedule.task_step', 'schedule task step', 'ewoh_schedule_task_step', 'new', 'new managed step lifecycle', 'pending'],
  ['schedule.assignment', 'schedule assignment', 'ewoh_schedule_assignment', 'new', 'new managed assignment', 'pending'],
  ['resource.preorder', 'resource/material preorder', 'ewoh_resource_preorder', 'new', 'numeric(18,4) quantities for reservation/issue/consume/return', 'pending'],
  ['resource.binding', 'resource binding', 'ewoh_resource_binding', 'new', 'new managed binding with history', 'pending'],
  ['control.request', 'control request', 'ewoh_control_request', 'new', 'new managed request with idempotency key', 'pending'],
  ['control.command', 'control command attempt', 'ewoh_control_command', 'new', 'root_command_id/attempt_no logical chain', 'pending'],
  ['control.result', 'control result', 'ewoh_control_result', 'new', 'new managed result', 'pending'],
  ['event.registry', 'event/alert registry', 'ewoh_event', 'altered', 'frozen 12-table alter with org_id/RLS', 'pending'],
  ['event.chain', 'event causal chain', 'ewoh_event_chain', 'altered', 'frozen 12-table alter with org_id/RLS', 'pending'],
  ['event.rule', 'event rule', 'ewoh_event_rule', 'new', 'new managed rule', 'pending'],
  ['event.action', 'event action', 'ewoh_event_action', 'new', 'new managed action', 'pending'],
  ['event.subscription', 'event subscription', 'ewoh_event_subscription', 'new', 'new managed subscription', 'pending'],
  ['ai.suggestion', 'AI suggestion', 'ewoh_ai_suggestion', 'mapped-existing', 'existing AI suggestion table hardened with org_id/RLS', 'pending'],
  ['world.state', 'world state', 'ewoh_world_state', 'altered', 'frozen 12-table alter with org_id/RLS', 'pending'],
  ['world.snapshot', 'world snapshot', 'ewoh_world_snapshot', 'new', 'org_id NULL only for global admin', 'pending'],
  ['world.delta', 'world delta log', 'ewoh_world_delta_log', 'new', 'seq bigint identity; org_id NULL only for global admin', 'pending'],
  ['system.config', 'system configuration', 'ewoh_system_config', 'new', 'org_id NULL supports global/public config', 'pending'],
  ['knowledge.base', 'knowledge base', 'ewoh_knowledge_base', 'new', 'new managed master', 'pending'],
  ['knowledge.entry', 'knowledge entry', 'ewoh_knowledge_entry', 'new', 'new managed entry', 'pending'],
  ['notification.registry', 'notification', 'ewoh_notification', 'new', 'new managed notification', 'pending'],
  ['audit.log', 'audit log and hash chain', 'ewoh_audit_log', 'new', 'audit_seq identity; write only via SECURITY DEFINER function', 'pending'],
];

function csvCell(value) {
  const s = String(value);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function renderCapabilityCsv() {
  const header = 'capability_id,capability,physical_table,table_status,mapping_notes,verification_status';
  const rows = CAPABILITIES.map((row) => row.map(csvCell).join(','));
  return [header, ...rows, ''].join('\n');
}

function renderMigration() {
  const parts = [];
  parts.push(`-- EWOH managed tables migration (AG-10)`);
  parts.push(`-- Schema placeholder: ${SCHEMA}`);
  parts.push(`-- Re-entrant: CREATE IF NOT EXISTS / ADD COLUMN IF NOT EXISTS / DROP POLICY IF EXISTS.`);
  parts.push(`-- No physical foreign keys. RLS is org-scoped; direct DML is revoked from user roles.`);
  parts.push('');
  parts.push(`CREATE SCHEMA IF NOT EXISTS ${SCHEMA};`);
  parts.push(`SELECT set_config('search_path', '${SCHEMA}, pg_temp', false);`);
  parts.push('');
  parts.push(`DO $ewoh_type$`);
  parts.push(`BEGIN`);
  parts.push(`  IF NOT EXISTS (`);
  parts.push(`    SELECT 1 FROM pg_type t JOIN pg_namespace n ON n.oid = t.typnamespace`);
  parts.push(`    WHERE t.typname = 'user_profile' AND n.nspname = '${SCHEMA}'`);
  parts.push(`  ) THEN`);
  parts.push(`    EXECUTE format('CREATE TYPE %I.user_profile AS (user_id varchar)', '${SCHEMA}');`);
  parts.push(`  END IF;`);
  parts.push(`END`);
  parts.push(`$ewoh_type$;`);
  parts.push('');
  parts.push(`CREATE OR REPLACE FUNCTION ${SCHEMA}.ewoh_org_visible(p_org_id uuid)`);
  parts.push(`RETURNS boolean`);
  parts.push(`LANGUAGE sql`);
  parts.push(`STABLE`);
  parts.push(`AS $$`);
  parts.push(`  SELECT`);
  parts.push(`    coalesce(current_setting('app.is_global_admin', true), '') = 'true'`);
  parts.push(`    OR (`);
  parts.push(`      nullif(coalesce(current_setting('app.current_org_ids', true), ''), '') IS NOT NULL`);
  parts.push(`      AND EXISTS (`);
  parts.push(`        SELECT 1`);
  parts.push(`        FROM unnest(string_to_array(current_setting('app.current_org_ids', true), ',')) AS o(org)`);
  parts.push(`        WHERE btrim(o.org) <> '' AND btrim(o.org)::uuid = p_org_id`);
  parts.push(`      )`);
  parts.push(`    );`);
  parts.push(`$$;`);
  parts.push('');
  parts.push(`-- Existing physical table baselines (portable fresh-DB bootstrap).`);
  for (const t of BASELINE_TABLES) {
    parts.push(renderBaselineTable(t.name, t.columns));
  }
  parts.push(`-- New managed tables (35 physical CREATEs; ewoh_device_person_binding maps to existing ewoh_device_binding).`);
  for (const t of NEW_TABLES) {
    parts.push(renderCreateTable(t));
  }
  parts.push(`-- 12 frozen ALTERs plus mapped-existing hardening.`);
  const allExisting = [...BASELINE_TABLES.map((t) => t.name)];
  for (const name of allExisting) {
    parts.push(`ALTER TABLE ${SCHEMA}.${name} ADD COLUMN IF NOT EXISTS _created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP;`);
    parts.push(`ALTER TABLE ${SCHEMA}.${name} ADD COLUMN IF NOT EXISTS _updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP;`);
    parts.push(`ALTER TABLE ${SCHEMA}.${name} ADD COLUMN IF NOT EXISTS _created_by ${SCHEMA}.user_profile DEFAULT ${USER_DEFAULT};`);
    parts.push(`ALTER TABLE ${SCHEMA}.${name} ADD COLUMN IF NOT EXISTS _updated_by ${SCHEMA}.user_profile DEFAULT ${USER_DEFAULT};`);
    if (name !== 'ewoh_personnel') {
      parts.push(`ALTER TABLE ${SCHEMA}.${name} ADD COLUMN IF NOT EXISTS org_id uuid;`);
    }
    parts.push('');
  }
  parts.push(`DO $ewoh_personnel$`);
  parts.push(`BEGIN`);
  parts.push(`  IF EXISTS (`);
  parts.push(`    SELECT 1 FROM information_schema.columns`);
  parts.push(`    WHERE table_schema = '${SCHEMA}' AND table_name = 'ewoh_personnel' AND column_name = 'org_id' AND data_type <> 'uuid'`);
  parts.push(`  ) THEN`);
  parts.push(`    ALTER TABLE ${SCHEMA}.ewoh_personnel ADD COLUMN IF NOT EXISTS org_id_legacy varchar(255);`);
  parts.push(`    UPDATE ${SCHEMA}.ewoh_personnel SET org_id_legacy = org_id WHERE org_id_legacy IS NULL AND org_id IS NOT NULL;`);
  parts.push(`    ALTER TABLE ${SCHEMA}.ewoh_personnel ALTER COLUMN org_id TYPE uuid USING (CASE WHEN org_id ~ '^[0-9a-fA-F-]{36}$' THEN org_id::uuid ELSE NULL END);`);
  parts.push(`  END IF;`);
  parts.push(`END`);
  parts.push(`$ewoh_personnel$;`);
  parts.push('');
  parts.push(`-- Table 79 detailed ALTERs.`);
  parts.push(`ALTER TABLE ${SCHEMA}.ewoh_spatial_entity ADD COLUMN IF NOT EXISTS z real DEFAULT 0;`);
  parts.push(`ALTER TABLE ${SCHEMA}.ewoh_spatial_entity ADD COLUMN IF NOT EXISTS roll real DEFAULT 0;`);
  parts.push(`ALTER TABLE ${SCHEMA}.ewoh_spatial_entity ADD COLUMN IF NOT EXISTS pitch real DEFAULT 0;`);
  parts.push(`ALTER TABLE ${SCHEMA}.ewoh_spatial_entity ADD COLUMN IF NOT EXISTS bbox_d real DEFAULT 0;`);
  parts.push(`ALTER TABLE ${SCHEMA}.ewoh_spatial_entity ADD COLUMN IF NOT EXISTS model_node_id varchar(255);`);
  parts.push(`ALTER TABLE ${SCHEMA}.ewoh_spatial_entity ADD COLUMN IF NOT EXISTS model_version_id varchar(255);`);
  parts.push(`ALTER TABLE ${SCHEMA}.ewoh_spatial_entity ADD COLUMN IF NOT EXISTS coordinate_system varchar(100) DEFAULT 'world';`);
  parts.push(`ALTER TABLE ${SCHEMA}.ewoh_spatial_entity ADD COLUMN IF NOT EXISTS coordinate_origin jsonb;`);
  parts.push(`ALTER TABLE ${SCHEMA}.ewoh_spatial_entity ADD COLUMN IF NOT EXISTS floor_elevation real DEFAULT 0;`);
  parts.push(`ALTER TABLE ${SCHEMA}.ewoh_spatial_entity ADD COLUMN IF NOT EXISTS unit varchar(50) DEFAULT 'm';`);
  parts.push(`ALTER TABLE ${SCHEMA}.ewoh_device ADD COLUMN IF NOT EXISTS lifecycle_status varchar(50) DEFAULT 'active';`);
  parts.push(`ALTER TABLE ${SCHEMA}.ewoh_device ADD COLUMN IF NOT EXISTS runtime_status varchar(50) DEFAULT 'unknown';`);
  parts.push(`ALTER TABLE ${SCHEMA}.ewoh_device ADD COLUMN IF NOT EXISTS health_status varchar(50) DEFAULT 'unknown';`);
  parts.push(`ALTER TABLE ${SCHEMA}.ewoh_device ADD COLUMN IF NOT EXISTS device_category varchar(100);`);
  parts.push(`ALTER TABLE ${SCHEMA}.ewoh_device ADD COLUMN IF NOT EXISTS extra jsonb;`);
  parts.push(`ALTER TABLE ${SCHEMA}.ewoh_schedule_plan ADD COLUMN IF NOT EXISTS suggestion_id varchar(255);`);
  parts.push(`ALTER TABLE ${SCHEMA}.ewoh_schedule_plan ADD COLUMN IF NOT EXISTS session_id varchar(255);`);
  parts.push(`ALTER TABLE ${SCHEMA}.ewoh_schedule_plan ADD COLUMN IF NOT EXISTS version integer DEFAULT 1;`);
  parts.push(`ALTER TABLE ${SCHEMA}.ewoh_schedule_plan ADD COLUMN IF NOT EXISTS parent_plan_id varchar(255);`);
  parts.push(`ALTER TABLE ${SCHEMA}.ewoh_schedule_plan ADD COLUMN IF NOT EXISTS is_simulation boolean DEFAULT false;`);
  parts.push(`ALTER TABLE ${SCHEMA}.ewoh_schedule_plan ADD COLUMN IF NOT EXISTS approval_id varchar(255);`);
  parts.push('');
  parts.push(`DO $ewoh_backfill$`);
  parts.push(`DECLARE`);
  parts.push(`  v_default_org uuid;`);
  parts.push(`BEGIN`);
  parts.push(`  SELECT id INTO v_default_org`);
  parts.push(`  FROM ${SCHEMA}.ewoh_organization`);
  parts.push(`  ORDER BY CASE WHEN org_type = 'factory' THEN 0 WHEN org_type = 'base' THEN 1 ELSE 2 END, id`);
  parts.push(`  LIMIT 1;`);
  parts.push(`  IF NOT FOUND THEN`);
  parts.push(`    v_default_org := '${DEFAULT_ORG}'::uuid;`);
  parts.push(`    INSERT INTO ${SCHEMA}.ewoh_organization (id, org_id, name, org_type, status, _created_at, _updated_at)`);
  parts.push(`    VALUES (v_default_org, v_default_org, '默认组织', 'default', 'active', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`);
  parts.push(`    ON CONFLICT (id) DO NOTHING;`);
  parts.push(`  END IF;`);
  parts.push(`  UPDATE ${SCHEMA}.ewoh_organization SET org_id = id WHERE org_id IS NULL;`);
  for (const name of allExisting.filter((n) => n !== 'ewoh_organization')) {
    parts.push(`  UPDATE ${SCHEMA}.${name} SET org_id = COALESCE(org_id, v_default_org) WHERE org_id IS NULL;`);
  }
  parts.push(`END`);
  parts.push(`$ewoh_backfill$;`);
  parts.push('');
  for (const name of allExisting) {
    parts.push(`ALTER TABLE ${SCHEMA}.${name} ALTER COLUMN org_id SET NOT NULL;`);
    parts.push(`ALTER TABLE ${SCHEMA}.${name} ALTER COLUMN org_id SET DEFAULT ${ORG_ID_DEFAULT};`);
    parts.push(`CREATE INDEX IF NOT EXISTS idx_${name}_org ON ${SCHEMA}.${name} (org_id);`);
  }
  parts.push(`CREATE UNIQUE INDEX IF NOT EXISTS uq_ewoh_scheduler_config_org_key ON ${SCHEMA}.ewoh_scheduler_config (org_id, config_key);`);
  for (const name of NEW_TABLES.map((t) => t.name)) {
    parts.push(`ALTER TABLE ${SCHEMA}.${name} ALTER COLUMN org_id SET DEFAULT ${ORG_ID_DEFAULT};`);
  }
  parts.push('');
  parts.push(`CREATE OR REPLACE FUNCTION ${SCHEMA}.ewoh_append_audit_log(`);
  parts.push(`  p_org_id uuid,`);
  parts.push(`  p_actor_id text,`);
  parts.push(`  p_action text,`);
  parts.push(`  p_entity_type text,`);
  parts.push(`  p_entity_id text,`);
  parts.push(`  p_before jsonb DEFAULT NULL,`);
  parts.push(`  p_after jsonb DEFAULT NULL,`);
  parts.push(`  p_reason text DEFAULT NULL,`);
  parts.push(`  p_client_ip text DEFAULT NULL,`);
  parts.push(`  p_request_id text DEFAULT NULL,`);
  parts.push(`  p_is_high_risk boolean DEFAULT false,`);
  parts.push(`  p_risk_level text DEFAULT 'normal'`);
  parts.push(`) RETURNS uuid`);
  parts.push(`LANGUAGE plpgsql`);
  parts.push(`SECURITY DEFINER`);
  parts.push(`SET search_path = ${SCHEMA}, pg_temp`);
  parts.push(`AS $$`);
  parts.push(`DECLARE`);
  parts.push(`  v_prev_hash text;`);
  parts.push(`  v_hash text;`);
  parts.push(`  v_audit_id uuid := gen_random_uuid();`);
  parts.push(`  v_chain_seq bigint;`);
  parts.push(`BEGIN`);
  parts.push(`  IF p_org_id IS NULL THEN`);
  parts.push(`    IF coalesce(current_setting('app.is_global_admin', true), '') <> 'true' THEN`);
  parts.push(`      RAISE EXCEPTION 'global audit records require global administrator context' USING ERRCODE = '42501';`);
  parts.push(`    END IF;`);
  parts.push(`  ELSIF NOT ${SCHEMA}.ewoh_org_visible(p_org_id) THEN`);
  parts.push(`    RAISE EXCEPTION 'audit organization is outside the request context' USING ERRCODE = '42501';`);
  parts.push(`  END IF;`);
  parts.push(`  PERFORM pg_advisory_xact_lock(hashtextextended(coalesce(p_org_id::text, 'global'), 0));`);
  parts.push(`  SELECT hash, chain_seq INTO v_prev_hash, v_chain_seq`);
  parts.push(`  FROM ${SCHEMA}.ewoh_audit_log`);
  parts.push(`  WHERE org_id IS NOT DISTINCT FROM p_org_id`);
  parts.push(`  ORDER BY audit_seq DESC`);
  parts.push(`  LIMIT 1;`);
  parts.push(`  v_prev_hash := coalesce(v_prev_hash, repeat('0', 64));`);
  parts.push(`  v_chain_seq := coalesce(v_chain_seq, 0) + 1;`);
  parts.push(`  v_hash := encode(sha256(convert_to(concat_ws('|',`);
  parts.push(`    v_prev_hash,`);
  parts.push(`    coalesce(p_org_id::text, ''),`);
  parts.push(`    coalesce(p_actor_id, ''),`);
  parts.push(`    p_action,`);
  parts.push(`    p_entity_type,`);
  parts.push(`    coalesce(p_entity_id, ''),`);
  parts.push(`    coalesce(p_before::text, ''),`);
  parts.push(`    coalesce(p_after::text, ''),`);
  parts.push(`    coalesce(p_reason, ''),`);
  parts.push(`    coalesce(p_client_ip, ''),`);
  parts.push(`    coalesce(p_request_id, ''),`);
  parts.push(`    coalesce(p_is_high_risk::text, 'false'),`);
  parts.push(`    to_char(now() AT TIME ZONE 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`);
  parts.push(`  ), 'UTF8')), 'hex');`);
  parts.push(`  INSERT INTO ${SCHEMA}.ewoh_audit_log (`);
  parts.push(`    id, org_id, actor_id, action, entity_type, entity_id, before_json, after_json,`);
  parts.push(`    reason, client_ip, request_id, is_high_risk, risk_level, occurred_at, chain_seq, prev_hash, hash`);
  parts.push(`  ) VALUES (`);
  parts.push(`    v_audit_id, p_org_id, p_actor_id, p_action, p_entity_type, p_entity_id, p_before, p_after,`);
  parts.push(`    p_reason, p_client_ip, p_request_id, p_is_high_risk, p_risk_level, now(), v_chain_seq, v_prev_hash, v_hash`);
  parts.push(`  );`);
  parts.push(`  RETURN v_audit_id;`);
  parts.push(`END;`);
  parts.push(`$$;`);
  parts.push('');
  parts.push(`-- Replace loose legacy policies with org-scoped policies.`);
  const policyTables = [...allExisting, ...NEW_TABLES.map((t) => t.name)];
  parts.push(`DO $ewoh_drop_legacy_policies$`);
  parts.push(`DECLARE`);
  parts.push(`  p record;`);
  parts.push(`BEGIN`);
  parts.push(`  FOR p IN`);
  parts.push(`    SELECT policyname, tablename`);
  parts.push(`    FROM pg_policies`);
  parts.push(`    WHERE schemaname = '${SCHEMA}' AND tablename = ANY (ARRAY[${policyTables.map((n) => `'${n}'`).join(', ')}])`);
  parts.push(`  LOOP`);
  parts.push(`    EXECUTE format('DROP POLICY IF EXISTS %I ON %I.%I', p.policyname, '${SCHEMA}', p.tablename);`);
  parts.push(`  END LOOP;`);
  parts.push(`END`);
  parts.push(`$ewoh_drop_legacy_policies$;`);
  parts.push('');
  const normalPolicyTables = policyTables.filter((n) => !['ewoh_world_snapshot', 'ewoh_world_delta_log', 'ewoh_system_config', 'ewoh_audit_log'].includes(n));
  parts.push(`DO $ewoh_rls_normal$`);
  parts.push(`DECLARE`);
  parts.push(`  t text;`);
  parts.push(`BEGIN`);
  parts.push(`  FOREACH t IN ARRAY ARRAY[${normalPolicyTables.map((n) => `'${n}'`).join(', ')}] LOOP`);
  parts.push(`    EXECUTE format('ALTER TABLE %I.%I ENABLE ROW LEVEL SECURITY', '${SCHEMA}', t);`);
  parts.push(`    EXECUTE format('DROP POLICY IF EXISTS ewoh_org_select ON %I.%I', '${SCHEMA}', t);`);
  parts.push(`    EXECUTE format('CREATE POLICY ewoh_org_select ON %I.%I FOR SELECT TO %I USING (%I.ewoh_org_visible(org_id))', '${SCHEMA}', t, '${ROLES.authenticated}', '${SCHEMA}');`);
  parts.push(`    EXECUTE format('DROP POLICY IF EXISTS ewoh_service_all ON %I.%I', '${SCHEMA}', t);`);
  parts.push(`    EXECUTE format('CREATE POLICY ewoh_service_all ON %I.%I FOR ALL TO %I USING (%I.ewoh_org_visible(org_id)) WITH CHECK (%I.ewoh_org_visible(org_id))', '${SCHEMA}', t, '${ROLES.service}', '${SCHEMA}', '${SCHEMA}');`);
  parts.push(`  END LOOP;`);
  parts.push(`END`);
  parts.push(`$ewoh_rls_normal$;`);
  parts.push('');
  parts.push(`-- Special policies: global rows only for admin; system_config public rows readable.`);
  for (const t of ['ewoh_world_snapshot', 'ewoh_world_delta_log']) {
    parts.push(`ALTER TABLE ${SCHEMA}.${t} ENABLE ROW LEVEL SECURITY;`);
    parts.push(`DROP POLICY IF EXISTS ewoh_org_select ON ${SCHEMA}.${t};`);
    parts.push(`CREATE POLICY ewoh_org_select ON ${SCHEMA}.${t} FOR SELECT TO ${ROLES.authenticated} USING (${SCHEMA}.ewoh_org_visible(org_id) OR (org_id IS NULL AND coalesce(current_setting('app.is_global_admin', true), '') = 'true'));`);
    parts.push(`DROP POLICY IF EXISTS ewoh_service_all ON ${SCHEMA}.${t};`);
    parts.push(`CREATE POLICY ewoh_service_all ON ${SCHEMA}.${t} FOR ALL TO ${ROLES.service} USING (${SCHEMA}.ewoh_org_visible(org_id) OR (org_id IS NULL AND coalesce(current_setting('app.is_global_admin', true), '') = 'true')) WITH CHECK (${SCHEMA}.ewoh_org_visible(org_id) OR (org_id IS NULL AND coalesce(current_setting('app.is_global_admin', true), '') = 'true'));`);
  }
  parts.push(`ALTER TABLE ${SCHEMA}.ewoh_system_config ENABLE ROW LEVEL SECURITY;`);
  parts.push(`DROP POLICY IF EXISTS ewoh_org_select ON ${SCHEMA}.ewoh_system_config;`);
  parts.push(`CREATE POLICY ewoh_org_select ON ${SCHEMA}.ewoh_system_config FOR SELECT TO ${ROLES.authenticated} USING (${SCHEMA}.ewoh_org_visible(org_id) OR (org_id IS NULL AND (is_public OR coalesce(current_setting('app.is_global_admin', true), '') = 'true')));`);
  parts.push(`DROP POLICY IF EXISTS ewoh_service_all ON ${SCHEMA}.ewoh_system_config;`);
  parts.push(`CREATE POLICY ewoh_service_all ON ${SCHEMA}.ewoh_system_config FOR ALL TO ${ROLES.service} USING (${SCHEMA}.ewoh_org_visible(org_id) OR (org_id IS NULL AND (is_public OR coalesce(current_setting('app.is_global_admin', true), '') = 'true'))) WITH CHECK (${SCHEMA}.ewoh_org_visible(org_id) OR (org_id IS NULL AND coalesce(current_setting('app.is_global_admin', true), '') = 'true'));`);
  parts.push(`ALTER TABLE ${SCHEMA}.ewoh_audit_log ENABLE ROW LEVEL SECURITY;`);
  parts.push(`DROP POLICY IF EXISTS ewoh_audit_select ON ${SCHEMA}.ewoh_audit_log;`);
  parts.push(`CREATE POLICY ewoh_audit_select ON ${SCHEMA}.ewoh_audit_log FOR SELECT TO ${ROLES.service} USING (${SCHEMA}.ewoh_org_visible(org_id) OR (org_id IS NULL AND coalesce(current_setting('app.is_global_admin', true), '') = 'true'));`);
  parts.push('');
  parts.push(`-- Grants: only the trusted backend role gets DML; audit_log is write-only via function.`);
  for (const name of policyTables.filter((n) => n !== 'ewoh_audit_log')) {
    parts.push(`REVOKE ALL PRIVILEGES ON TABLE ${SCHEMA}.${name} FROM ${ROLES.anon}, ${ROLES.authenticated}, ${ROLES.userAuthenticated};`);
    parts.push(`GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE ${SCHEMA}.${name} TO ${ROLES.service};`);
  }
  parts.push(`REVOKE ALL PRIVILEGES ON TABLE ${SCHEMA}.ewoh_audit_log FROM ${ROLES.anon}, ${ROLES.authenticated}, ${ROLES.userAuthenticated}, ${ROLES.service};`);
  parts.push(`GRANT SELECT ON TABLE ${SCHEMA}.ewoh_audit_log TO ${ROLES.service};`);
  parts.push(`REVOKE ALL PRIVILEGES ON FUNCTION ${SCHEMA}.ewoh_append_audit_log FROM PUBLIC;`);
  parts.push(`GRANT EXECUTE ON FUNCTION ${SCHEMA}.ewoh_append_audit_log TO ${ROLES.service};`);
  parts.push(`GRANT USAGE ON SCHEMA ${SCHEMA} TO ${ROLES.service};`);
  parts.push('');
  return parts.join('\n');
}

function renderRollback() {
  const parts = [];
  const allExisting = BASELINE_TABLES.map((t) => t.name);
  const policyTables = [...allExisting, ...NEW_TABLES.map((t) => t.name)];
  parts.push(`-- EWOH managed tables rollback (AG-10)`);
  parts.push(`-- Drops new objects, reverses RLS/grants, and preserves data in retained additive columns.`);
  parts.push(`SELECT set_config('search_path', '${SCHEMA}, pg_temp', false);`);
  parts.push('');
  parts.push(`DO $ewoh_rollback_policies$`);
  parts.push(`DECLARE`);
  parts.push(`  p record;`);
  parts.push(`BEGIN`);
  parts.push(`  FOR p IN`);
  parts.push(`    SELECT policyname, tablename FROM pg_policies`);
  parts.push(`    WHERE schemaname = '${SCHEMA}' AND tablename = ANY (ARRAY[${policyTables.map((n) => `'${n}'`).join(', ')}])`);
  parts.push(`    AND policyname IN ('ewoh_org_select', 'ewoh_service_all', 'ewoh_audit_select')`);
  parts.push(`  LOOP`);
  parts.push(`    EXECUTE format('DROP POLICY IF EXISTS %I ON %I.%I', p.policyname, '${SCHEMA}', p.tablename);`);
  parts.push(`  END LOOP;`);
  parts.push(`END`);
  parts.push(`$ewoh_rollback_policies$;`);
  parts.push('');
  parts.push(`DROP FUNCTION IF EXISTS ${SCHEMA}.ewoh_append_audit_log(uuid, text, text, text, text, jsonb, jsonb, text, text, text, boolean, text);`);
  parts.push(`DROP FUNCTION IF EXISTS ${SCHEMA}.ewoh_org_visible(uuid);`);
  for (const t of NEW_TABLES) {
    parts.push(`DROP TABLE IF EXISTS ${SCHEMA}.${t.name};`);
  }
  parts.push('');
  parts.push(`-- Reverse NOT NULL org_id on existing tables while keeping additive columns for data preservation.`);
  for (const name of allExisting) {
    parts.push(`ALTER TABLE ${SCHEMA}.${name} ALTER COLUMN org_id DROP DEFAULT;`);
    parts.push(`ALTER TABLE ${SCHEMA}.${name} ALTER COLUMN org_id DROP NOT NULL;`);
    parts.push(`DROP INDEX IF EXISTS idx_${name}_org;`);
  }
  parts.push(`DO $ewoh_personnel_restore$`);
  parts.push(`BEGIN`);
  parts.push(`  IF EXISTS (`);
  parts.push(`    SELECT 1 FROM information_schema.columns`);
  parts.push(`    WHERE table_schema = '${SCHEMA}' AND table_name = 'ewoh_personnel' AND column_name = 'org_id' AND data_type = 'uuid'`);
  parts.push(`  ) THEN`);
  parts.push(`    ALTER TABLE ${SCHEMA}.ewoh_personnel ALTER COLUMN org_id TYPE varchar(255) USING org_id::text;`);
  parts.push(`    IF EXISTS (`);
  parts.push(`      SELECT 1 FROM information_schema.columns`);
  parts.push(`      WHERE table_schema = '${SCHEMA}' AND table_name = 'ewoh_personnel' AND column_name = 'org_id_legacy'`);
  parts.push(`    ) THEN`);
  parts.push(`      UPDATE ${SCHEMA}.ewoh_personnel SET org_id = COALESCE(org_id_legacy, org_id) WHERE org_id_legacy IS NOT NULL;`);
  parts.push(`      ALTER TABLE ${SCHEMA}.ewoh_personnel DROP COLUMN IF EXISTS org_id_legacy;`);
  parts.push(`    END IF;`);
  parts.push(`  END IF;`);
  parts.push(`END`);
  parts.push(`$ewoh_personnel_restore$;`);
  parts.push('');
  parts.push(`-- Restore equivalent permissive policies under ASCII names.`);
  for (const t of ['ewoh_ai_suggestion', 'ewoh_device_binding', 'ewoh_device_config', 'ewoh_organization', 'ewoh_personnel', 'ewoh_production_task']) {
    parts.push(`ALTER TABLE ${SCHEMA}.${t} ENABLE ROW LEVEL SECURITY;`);
    parts.push(`CREATE POLICY legacy_service_bypass ON ${SCHEMA}.${t} FOR ALL TO ${ROLES.service} USING (true);`);
    parts.push(`CREATE POLICY legacy_select_all ON ${SCHEMA}.${t} FOR SELECT TO ${ROLES.anon}, ${ROLES.authenticated} USING (true);`);
    parts.push(`CREATE POLICY legacy_modify_all ON ${SCHEMA}.${t} FOR ALL TO ${ROLES.authenticated} USING (true);`);
    parts.push(`CREATE POLICY legacy_modify_self ON ${SCHEMA}.${t} FOR ALL TO ${ROLES.authenticated} USING (current_setting('app.user_id') = ANY (ARRAY[]::text[]) AND current_setting('app.user_id') = ((_created_by).user_id)::text);`);
  }
  parts.push(`ALTER TABLE ${SCHEMA}.ewoh_scheduler_config ENABLE ROW LEVEL SECURITY;`);
  parts.push(`CREATE POLICY legacy_service_bypass_cfg ON ${SCHEMA}.ewoh_scheduler_config FOR ALL TO ${ROLES.service} USING (true);`);
  parts.push(`CREATE POLICY legacy_select_all_cfg ON ${SCHEMA}.ewoh_scheduler_config FOR SELECT TO ${ROLES.anon}, ${ROLES.authenticated} USING (true);`);
  parts.push(`CREATE POLICY legacy_modify_all_cfg ON ${SCHEMA}.ewoh_scheduler_config FOR ALL TO ${ROLES.authenticated} USING (true);`);
  for (const name of allExisting) {
    if (!['ewoh_ai_suggestion', 'ewoh_device_binding', 'ewoh_device_config', 'ewoh_organization', 'ewoh_personnel', 'ewoh_production_task', 'ewoh_scheduler_config'].includes(name)) {
      parts.push(`ALTER TABLE ${SCHEMA}.${name} DISABLE ROW LEVEL SECURITY;`);
    }
  }
  parts.push('');
  parts.push(`-- Restore the pre-migration direct grants on existing tables.`);
  for (const name of allExisting) {
    parts.push(`GRANT ALL PRIVILEGES ON TABLE ${SCHEMA}.${name} TO ${ROLES.anon}, ${ROLES.authenticated}, ${ROLES.service};`);
  }
  parts.push('');
  return parts.join('\n');
}

function renderVerify() {
  const managedPhysical = [
    ...NEW_GROUP.map((t) => t.name),
    ...ALTERED_TABLES.map((t) => t.name),
  ];
  const special = ['ewoh_world_snapshot', 'ewoh_world_delta_log', 'ewoh_system_config', 'ewoh_audit_log'];
  const notNull = managedPhysical.filter((n) => !special.includes(n));
  const expected = managedPhysical.map((n) => `'${n}'`).join(', ');
  const notNullList = notNull.map((n) => `'${n}'`).join(', ');
  const requestScoped = [...BASELINE_TABLES.map((t) => t.name), ...NEW_TABLES.map((t) => t.name)];
  const lines = [];
  lines.push(`-- EWOH managed schema verification (AG-10)`);
  lines.push(`-- Every result column must be 0 to pass, except audit_function_count which must be 1.`);
  lines.push(`WITH expected(name) AS (VALUES ${managedPhysical.map((n) => `('${n}')`).join(', ')}),`);
  lines.push(`request_scoped(name) AS (VALUES ${requestScoped.map((n) => `('${n}')`).join(', ')}),`);
  lines.push(`managed AS (`);
  lines.push(`  SELECT count(*) AS managed_table_count`);
  lines.push(`  FROM expected e`);
  lines.push(`  JOIN information_schema.tables t ON t.table_schema = '${SCHEMA}' AND t.table_name = e.name`);
  lines.push(`),`);
  lines.push(`missing_org AS (`);
  lines.push(`  SELECT count(*) AS missing_org_id`);
  lines.push(`  FROM expected e`);
  lines.push(`  LEFT JOIN information_schema.columns c ON c.table_schema = '${SCHEMA}' AND c.table_name = e.name AND c.column_name = 'org_id'`);
  lines.push(`  WHERE c.column_name IS NULL`);
  lines.push(`),`);
  lines.push(`nullable_org AS (`);
  lines.push(`  SELECT count(*) AS org_not_null_violations`);
  lines.push(`  FROM information_schema.columns c`);
  lines.push(`  WHERE c.table_schema = '${SCHEMA}' AND c.table_name = ANY (ARRAY[${notNullList}]) AND c.column_name = 'org_id' AND c.is_nullable = 'YES'`);
  lines.push(`),`);
  lines.push(`missing_org_defaults AS (`);
  lines.push(`  SELECT count(*) AS missing_org_request_defaults`);
  lines.push(`  FROM request_scoped e`);
  lines.push(`  LEFT JOIN information_schema.columns c ON c.table_schema = '${SCHEMA}' AND c.table_name = e.name AND c.column_name = 'org_id'`);
  lines.push(`  WHERE coalesce(c.column_default, '') NOT LIKE '%app.current_org_id%'`);
  lines.push(`),`);
  lines.push(`rls AS (`);
  lines.push(`  SELECT count(*) AS rls_enabled`);
  lines.push(`  FROM expected e`);
  lines.push(`  JOIN pg_class c ON c.relname = e.name`);
  lines.push(`  JOIN pg_namespace n ON n.oid = c.relnamespace AND n.nspname = '${SCHEMA}'`);
  lines.push(`  WHERE c.relrowsecurity`);
  lines.push(`),`);
  lines.push(`policy_missing AS (`);
  lines.push(`  SELECT coalesce(count(*), 0)::bigint AS tables_without_policy`);
  lines.push(`  FROM (`);
  lines.push(`    SELECT e.name`);
  lines.push(`    FROM expected e`);
  lines.push(`    LEFT JOIN pg_policies p ON p.schemaname = '${SCHEMA}' AND p.tablename = e.name`);
  lines.push(`    GROUP BY e.name`);
  lines.push(`    HAVING count(p.policyname) = 0`);
  lines.push(`  ) missing`);
  lines.push(`),`);
  lines.push(`loose AS (`);
  lines.push(`  SELECT count(*) AS loose_policies`);
  lines.push(`  FROM pg_policies p`);
  lines.push(`  JOIN expected e ON e.name = p.tablename`);
  lines.push(`  WHERE p.schemaname = '${SCHEMA}' AND (p.qual = 'true' OR p.with_check = 'true')`);
  lines.push(`),`);
  lines.push(`auth_dml AS (`);
  lines.push(`  SELECT count(DISTINCT g.table_name) AS authenticated_dml_grants`);
  lines.push(`  FROM information_schema.role_table_grants g`);
  lines.push(`  JOIN expected e ON e.name = g.table_name`);
  lines.push(`  WHERE g.table_schema = '${SCHEMA}'`);
  lines.push(`    AND g.grantee IN ('${ROLES.authenticated}', '${ROLES.userAuthenticated}')`);
  lines.push(`    AND g.privilege_type IN ('INSERT', 'UPDATE', 'DELETE', 'TRUNCATE')`);
  lines.push(`),`);
  lines.push(`anon_grants AS (`);
  lines.push(`  SELECT count(DISTINCT g.table_name) AS anon_grants`);
  lines.push(`  FROM information_schema.role_table_grants g`);
  lines.push(`  JOIN expected e ON e.name = g.table_name`);
  lines.push(`  WHERE g.table_schema = '${SCHEMA}' AND g.grantee = '${ROLES.anon}'`);
  lines.push(`),`);
  lines.push(`identities AS (`);
  lines.push(`  SELECT`);
  lines.push(`    count(*) FILTER (WHERE a.attrelid = to_regclass('${SCHEMA}.ewoh_audit_log') AND a.attname = 'audit_seq' AND a.attidentity = 'a') AS audit_seq_identity,`);
  lines.push(`    count(*) FILTER (WHERE a.attrelid = to_regclass('${SCHEMA}.ewoh_world_delta_log') AND a.attname = 'seq' AND a.attidentity = 'a') AS world_delta_seq_identity`);
  lines.push(`  FROM pg_attribute a`);
  lines.push(`),`);
  lines.push(`audit_fn AS (`);
  lines.push(`  SELECT count(*) AS audit_function_count`);
  lines.push(`  FROM pg_proc p`);
  lines.push(`  JOIN pg_namespace n ON n.oid = p.pronamespace AND n.nspname = '${SCHEMA}'`);
  lines.push(`  WHERE p.proname = 'ewoh_append_audit_log'`);
  lines.push(`),`);
  lines.push(`quantities AS (`);
  lines.push(`  SELECT count(*) AS quantity_numeric_mismatch`);
  lines.push(`  FROM information_schema.columns c`);
  lines.push(`  WHERE c.table_schema = '${SCHEMA}'`);
  lines.push(`    AND ((c.table_name = 'ewoh_resource_preorder' AND c.column_name IN ('quantity', 'reserved_qty', 'issued_qty', 'consumed_qty', 'returned_qty'))`);
  lines.push(`      OR (c.table_name = 'ewoh_resource_binding' AND c.column_name = 'quantity'))`);
  lines.push(`    AND c.data_type <> 'numeric'`);
  lines.push(`),`);
  lines.push(`config_unique AS (`);
  lines.push(`  SELECT count(*) AS scheduler_config_org_key`);
  lines.push(`  FROM pg_indexes`);
  lines.push(`  WHERE schemaname = '${SCHEMA}' AND tablename = 'ewoh_scheduler_config' AND indexname = 'uq_ewoh_scheduler_config_org_key'`);
  lines.push(`) SELECT`);
  lines.push(`  (SELECT managed_table_count FROM managed) AS managed_table_count,`);
  lines.push(`  (SELECT missing_org_id FROM missing_org) AS missing_org_id,`);
  lines.push(`  (SELECT org_not_null_violations FROM nullable_org) AS org_not_null_violations,`);
  lines.push(`  (SELECT missing_org_request_defaults FROM missing_org_defaults) AS missing_org_request_defaults,`);
  lines.push(`  (SELECT rls_enabled FROM rls) AS rls_enabled,`);
  lines.push(`  (SELECT tables_without_policy FROM policy_missing) AS tables_without_policy,`);
  lines.push(`  (SELECT loose_policies FROM loose) AS loose_policies,`);
  lines.push(`  (SELECT authenticated_dml_grants FROM auth_dml) AS authenticated_dml_grants,`);
  lines.push(`  (SELECT anon_grants FROM anon_grants) AS anon_grants,`);
  lines.push(`  (SELECT audit_seq_identity FROM identities) AS audit_seq_identity,`);
  lines.push(`  (SELECT world_delta_seq_identity FROM identities) AS world_delta_seq_identity,`);
  lines.push(`  (SELECT audit_function_count FROM audit_fn) AS audit_function_count,`);
  lines.push(`  (SELECT quantity_numeric_mismatch FROM quantities) AS quantity_numeric_mismatch,`);
  lines.push(`  (SELECT scheduler_config_org_key FROM config_unique) AS scheduler_config_org_key;`);
  return `${lines.join('\n')}\n`;
}

function ensureDir(p) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
}

function writeOutput(rel, content) {
  const p = path.join(ROOT, rel);
  ensureDir(p);
  fs.writeFileSync(p, content, 'utf8');
}

writeOutput('db/contracts/schema-manifest.yaml', renderManifest());
writeOutput('db/migrations/001_ewoh_managed_tables.sql', renderMigration());
writeOutput('db/migrations/001_ewoh_managed_tables.rollback.sql', renderRollback());
writeOutput('db/verify/001_verify.sql', renderVerify());
writeOutput('tmp/ddl/capability-map.csv', renderCapabilityCsv());

console.log('Generated EWOH DDL package artifacts.');
