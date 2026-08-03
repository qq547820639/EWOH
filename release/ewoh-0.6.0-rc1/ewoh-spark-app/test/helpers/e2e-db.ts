import { randomUUID } from 'node:crypto';
import * as bcrypt from 'bcryptjs';
import postgres from 'postgres';

export type OwnerSql = ReturnType<typeof postgres>;

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

  const [viewerAHash, globalAdminAHash, dispatcherAHash, viewerBHash, globalAdminBHash, dispatcherBHash] =
    await Promise.all(
      [
        viewerA.password,
        globalAdminA.password,
        dispatcherA.password,
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
    for (const table of ORG_SCOPED_TABLES) {
      await tx.unsafe(
        `delete from public.${table} where org_id = any($1::uuid[])`,
        [orgIds],
      );
    }
    await tx.unsafe('delete from public.ewoh_user where org_id = any($1::uuid[])', [
      orgIds,
    ]);
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
