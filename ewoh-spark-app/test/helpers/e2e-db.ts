import { randomUUID } from 'node:crypto';
import * as bcrypt from 'bcryptjs';
import postgres from 'postgres';

export type OwnerSql = ReturnType<typeof postgres>;

export interface SchedulerFixture {
  taskId: string;
  personId: string;
  deviceIds: [string, string];
  stationId: string;
}

/** Real persisted, explicitly simulated resources; no application security overrides. */
export async function seedSchedulerFixture(
  owner: OwnerSql,
  orgId: string,
): Promise<SchedulerFixture> {
  const suffix = randomUUID().slice(0, 8);
  const taskId = randomUUID();
  const personId = randomUUID();
  const stationId = `WS-E2E-${suffix}`;
  const deviceBusinessIds: [string, string] = [
    `EXO-E2E-${suffix}-A`,
    `EXO-E2E-${suffix}-B`,
  ];
  const deviceIds: [string, string] = [randomUUID(), randomUUID()];
  const start = Date.now() + 120_000;
  await owner.begin(async (tx) => {
    await tx.unsafe(
      `insert into public.ewoh_spatial_entity
       (org_id, entity_id, entity_type, name, x, y, status, source_type, capacity, coordinate_type)
       values ($1::uuid, $2, 'workstation', $2, 10, 20, 'active', 'simulated', 1, 'FACTORY_CARTESIAN')`,
      [orgId, stationId],
    );
    await tx.unsafe(
      `insert into public.ewoh_personnel
       (id, org_id, name, employee_no, status, health_status, spatial_entity_id, skills, workload)
       values ($1::uuid, $2::uuid, $3, $3, 'available', 'normal', $4, '["lifting"]'::jsonb, 0)`,
      [personId, orgId, `E2E Worker ${suffix}`, personId],
    );
    await tx.unsafe(
      `insert into public.ewoh_spatial_entity
       (org_id, entity_id, entity_type, name, x, y, status, source_type, coordinate_type)
       values ($1::uuid, $2, 'person', $3, 10, 20, 'active', 'simulated', 'FACTORY_CARTESIAN')`,
      [orgId, personId, `E2E Worker ${suffix}`],
    );
    for (const [index, deviceId] of deviceBusinessIds.entries()) {
      await tx.unsafe(
        `insert into public.ewoh_device
         (id, org_id, device_id, device_model, device_category, online, battery_pct, source_type,
          lifecycle_status, runtime_status, health_status, capabilities,
          last_telemetry_at, telemetry_updated_at, location_lat, location_lng,
          location_updated_at, location_confidence, location_coordinate_type)
         values ($3::uuid, $1::uuid, $2, 'EXO-E2E', 'exoskeleton', true, 95, 'simulated',
          'active', 'idle', 'normal', '["lifting_assist"]'::jsonb,
          now(), now(), 10, 20, now(), 1, 'FACTORY_CARTESIAN')`,
        [orgId, deviceId, deviceIds[index]],
      );
    }
    await tx.unsafe(
      `insert into public.ewoh_production_task
       (id, org_id, title, task_type, priority, base_priority, status, source, spatial_entity_id,
        plan_start, plan_end, earliest_start_ms, latest_finish_ms,
        required_skills, required_device_capabilities)
       values ($1::uuid, $2::uuid, $3, 'production', 'high', 'P1', 'pending_dispatch', 'simulated', $4,
        to_timestamp($5::double precision / 1000), to_timestamp(($5::double precision + 60000) / 1000),
        $5::bigint, $6::bigint, '["lifting"]'::jsonb, '["lifting_assist"]'::jsonb)`,
      [
        taskId,
        orgId,
        `E2E Lift ${suffix}`,
        stationId,
        start,
        start + 3_600_000,
      ],
    );
  });
  return { taskId, personId, deviceIds, stationId };
}

export interface E2EOrg {
  id: string;
  name: string;
}

export interface E2ECredentials {
  username: string;
  password: string;
}

export interface E2EFixture {
  orgA: E2EOrg;
  orgB: E2EOrg;
  viewerA: E2ECredentials;
  globalAdminA: E2ECredentials;
  dispatcherA: E2ECredentials;
  approverA: E2ECredentials;
  viewerB: E2ECredentials;
  globalAdminB: E2ECredentials;
  dispatcherB: E2ECredentials;
}

interface UserSeed {
  username: string;
  passwordHash: string;
  displayName: string;
  orgId: string;
  roles: string[];
  isGlobalAdmin: boolean;
}

const ORG_SCOPED_TABLES = [
  'ewoh_ai_suggestion',
  'ewoh_audit_log',
  'ewoh_control_command',
  'ewoh_control_request',
  'ewoh_control_result',
  'ewoh_device',
  'ewoh_device_binding',
  'ewoh_device_capability',
  'ewoh_device_config',
  'ewoh_environment',
  'ewoh_event',
  'ewoh_event_action',
  'ewoh_event_chain',
  'ewoh_event_rule',
  'ewoh_event_subscription',
  'ewoh_knowledge_base',
  'ewoh_knowledge_entry',
  'ewoh_model_asset',
  'ewoh_model_binding',
  'ewoh_model_registry',
  'ewoh_notification',
  'ewoh_person_role',
  'ewoh_person_skill',
  'ewoh_personnel',
  'ewoh_production_task',
  'ewoh_resource_binding',
  'ewoh_resource_preorder',
  'ewoh_role',
  'ewoh_schedule_assignment',
  'ewoh_schedule_audit',
  'ewoh_schedule_plan',
  'ewoh_schedule_task',
  'ewoh_schedule_task_step',
  'ewoh_scheduler_config',
  'ewoh_spatial_entity',
  'ewoh_spatial_hierarchy',
  'ewoh_spatial_relation',
  'ewoh_skill',
  'ewoh_system_config',
  'ewoh_task_skill_req',
  'ewoh_task_step',
  'ewoh_task_template',
  'ewoh_telemetry',
  'ewoh_topology',
  'ewoh_workstation',
  'ewoh_workstation_device',
  'ewoh_workstation_person',
  'ewoh_workstation_relation',
  'ewoh_workstation_skill',
  'ewoh_world_delta_log',
  'ewoh_world_snapshot',
  'ewoh_world_state',
  'ewoh_factory_template',
  'ewoh_factory_profile',
  'ewoh_asset_package',
  'ewoh_assignment_event',
  'ewoh_scheduling_execution',
  'ewoh_scheduling_feedback',
  'ewoh_scheduling_plan_assignment',
  'ewoh_scheduling_run',
  'ewoh_scheduling_policy',
  'ewoh_scheduling_conflict',
  'ewoh_scheduling_constraint',
  'ewoh_scheduling_kpi',
  'ewoh_policy_replay',
  'ewoh_policy_activation',
  'ewoh_replan_trigger',
  'ewoh_resource_reservation',
  'ewoh_world_state_snapshot',
  'ewoh_route_cost_matrix',
  'ewoh_route_edge',
  'ewoh_route_node',
  'prediction_shadow_observation',
  'ewoh_agent_approval',
  'ewoh_agent_manifest',
  'ewoh_agent_task',
  'ewoh_dead_letter',
  'ewoh_exo_config',
  'ewoh_exo_session',
  'ewoh_factory_replication_sessions',
  'ewoh_idempotency_keys',
  'ewoh_identity_mapping',
  'ewoh_inference_result',
  'ewoh_ingest_event_dedup',
  'ewoh_learning_evaluation',
  'ewoh_learning_proposal',
  'ewoh_maintenance_condition',
  'ewoh_outbox',
  'ewoh_outcome_annotation',
  'ewoh_quality_finding',
  'ewoh_resource_locks',
  'ewoh_simulation_run',
  'ewoh_trace_span',
  'ewoh_work_order',
];

export async function connectOwner(url: string): Promise<OwnerSql> {
  const client = postgres(url, {
    max: 5,
    idle_timeout: 30_000,
    connect_timeout: 10,
    prepare: false,
  });
  await client.unsafe('select 1 as ready');
  return client;
}

export async function createE2EFixture(owner: OwnerSql): Promise<E2EFixture> {
  const suffix = randomUUID().slice(0, 8);
  const orgA: E2EOrg = {
    id: randomUUID(),
    name: `EWOH E2E Org A ${suffix}`,
  };
  const orgB: E2EOrg = {
    id: randomUUID(),
    name: `EWOH E2E Org B ${suffix}`,
  };

  const viewerA: E2ECredentials = {
    username: `e2e_a_viewer_${suffix}`,
    password: `E2E-Viewer-A-${suffix}-Aa1!`,
  };
  const globalAdminA: E2ECredentials = {
    username: `e2e_a_admin_${suffix}`,
    password: `E2E-Admin-A-${suffix}-Aa1!`,
  };
  const dispatcherA: E2ECredentials = {
    username: `e2e_a_dispatch_${suffix}`,
    password: `E2E-Dispatch-A-${suffix}-Aa1!`,
  };
  const approverA: E2ECredentials = {
    username: `e2e_a_approver_${suffix}`,
    password: `E2E-Approver-A-${suffix}-Aa1!`,
  };
  const viewerB: E2ECredentials = {
    username: `e2e_b_viewer_${suffix}`,
    password: `E2E-Viewer-B-${suffix}-Bb2@`,
  };
  const globalAdminB: E2ECredentials = {
    username: `e2e_b_admin_${suffix}`,
    password: `E2E-Admin-B-${suffix}-Bb2@`,
  };
  const dispatcherB: E2ECredentials = {
    username: `e2e_b_dispatch_${suffix}`,
    password: `E2E-Dispatch-B-${suffix}-Bb2@`,
  };

  const [
    viewerAHash,
    globalAdminAHash,
    dispatcherAHash,
    approverAHash,
    viewerBHash,
    globalAdminBHash,
    dispatcherBHash,
  ] = await Promise.all(
    [
      viewerA.password,
      globalAdminA.password,
      dispatcherA.password,
      approverA.password,
      viewerB.password,
      globalAdminB.password,
      dispatcherB.password,
    ].map((password) => bcrypt.hash(password, 10)),
  );

  const users: UserSeed[] = [
    {
      username: viewerA.username,
      passwordHash: viewerAHash,
      displayName: 'E2E Viewer A',
      orgId: orgA.id,
      roles: ['viewer'],
      isGlobalAdmin: false,
    },
    {
      username: approverA.username,
      passwordHash: approverAHash,
      displayName: 'E2E Approver A',
      orgId: orgA.id,
      roles: ['workshop_lead'],
      isGlobalAdmin: false,
    },
    {
      username: globalAdminA.username,
      passwordHash: globalAdminAHash,
      displayName: 'E2E Global Admin A',
      orgId: orgA.id,
      roles: ['global_admin'],
      isGlobalAdmin: true,
    },
    {
      username: dispatcherA.username,
      passwordHash: dispatcherAHash,
      displayName: 'E2E Dispatcher A',
      orgId: orgA.id,
      roles: ['dispatcher'],
      isGlobalAdmin: false,
    },
    {
      username: viewerB.username,
      passwordHash: viewerBHash,
      displayName: 'E2E Viewer B',
      orgId: orgB.id,
      roles: ['viewer'],
      isGlobalAdmin: false,
    },
    {
      username: globalAdminB.username,
      passwordHash: globalAdminBHash,
      displayName: 'E2E Global Admin B',
      orgId: orgB.id,
      roles: ['global_admin'],
      isGlobalAdmin: true,
    },
    {
      username: dispatcherB.username,
      passwordHash: dispatcherBHash,
      displayName: 'E2E Dispatcher B',
      orgId: orgB.id,
      roles: ['dispatcher'],
      isGlobalAdmin: false,
    },
  ];

  await owner.begin(async (tx) => {
    for (const org of [orgA, orgB]) {
      await tx.unsafe(
        `insert into public.ewoh_organization
          (id, org_id, name, org_type, status, _created_at, _updated_at)
         values ($1::uuid, $1::uuid, $2, 'e2e', 'active', now(), now())`,
        [org.id, org.name],
      );
    }
    for (const user of users) {
      const rolesLiteral = JSON.stringify(user.roles).replace(/'/g, "''");
      await tx.unsafe(
        `insert into public.ewoh_user
          (username, password_hash, display_name, org_id, roles, is_global_admin, status)
         values ($1, $2, $3, $4::uuid, '${rolesLiteral}'::jsonb, $5, 'active')`,
        [
          user.username,
          user.passwordHash,
          user.displayName,
          user.orgId,
          user.isGlobalAdmin,
        ],
      );
    }
  });

  return {
    orgA,
    orgB,
    viewerA,
    globalAdminA,
    dispatcherA,
    approverA,
    viewerB,
    globalAdminB,
    dispatcherB,
  };
}

export async function cleanupE2EFixture(
  owner: OwnerSql,
  fixture: E2EFixture,
): Promise<void> {
  const orgIds = [fixture.orgA.id, fixture.orgB.id];
  await owner.begin(async (tx) => {
    const existingOrgTables = await tx.unsafe<{ table_name: string }[]>(
      `select table_name
       from information_schema.columns
       where table_schema = 'public'
         and column_name = 'org_id'
         and table_name = any($1::text[])`,
      [ORG_SCOPED_TABLES],
    );
    for (const { table_name: table } of existingOrgTables) {
      await tx.unsafe(
        `delete from public.${table} where org_id::text = any($1::text[])`,
        [orgIds],
      );
    }
    await tx.unsafe(
      'delete from public.ewoh_user where org_id::text = any($1::text[])',
      [orgIds],
    );
    await tx.unsafe(
      'delete from public.ewoh_organization where id = any($1::uuid[])',
      [orgIds],
    );
  });
}

export interface ControlRequestRow {
  request_id: string;
  org_id: string;
  device_id: string;
  status: string;
  idempotency_key: string | null;
}

export async function findControlRequest(
  owner: OwnerSql,
  requestId: string,
  orgId: string,
): Promise<ControlRequestRow | null> {
  const rows = await owner.unsafe<ControlRequestRow[]>(
    `select request_id, org_id::text, device_id, status, idempotency_key
     from public.ewoh_control_request
     where request_id = $1 and org_id = $2::uuid`,
    [requestId, orgId],
  );
  return rows[0] ?? null;
}
