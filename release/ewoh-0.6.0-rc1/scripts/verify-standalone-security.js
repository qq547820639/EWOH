#!/usr/bin/env node
'use strict';

const path = require('path');
const { createRequire } = require('module');

const root = path.resolve(__dirname, '..');
const requireFromApp = createRequire(path.join(root, 'ewoh-spark-app', 'package.json'));
const postgres = requireFromApp('postgres');

const ORG_A = '10000000-0000-4000-8000-000000000001';
const ORG_B = '20000000-0000-4000-8000-000000000002';
const ORG_B_CHILD = '20000000-0000-4000-8000-000000000003';
const USERNAME = 'ewoh_security_probe';

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

async function expectDenied(action, label) {
  try {
    await action();
  } catch (error) {
    if (error && error.code === '42501') {
      return;
    }
    throw new Error(`${label} failed with unexpected error: ${error && (error.message || error)}`);
  }
  throw new Error(`${label} unexpectedly succeeded`);
}

async function setOrgContext(sql, orgIds, isGlobalAdmin = false) {
  await sql`select set_config('app.user_id', 'security-probe', true)`;
  await sql`select set_config('app.current_org_id', ${orgIds[0] || ''}, true)`;
  await sql`select set_config('app.current_org_ids', ${orgIds.join(',')}, true)`;
  await sql`select set_config('app.is_global_admin', ${isGlobalAdmin ? 'true' : 'false'}, true)`;
}

async function cleanup(owner) {
  await owner`delete from public.ewoh_audit_log where org_id in (${ORG_A}::uuid, ${ORG_B}::uuid)`;
  await owner`delete from public.ewoh_user where username = ${USERNAME}`;
  await owner`delete from public.ewoh_organization where id in (${ORG_A}::uuid, ${ORG_B}::uuid, ${ORG_B_CHILD}::uuid)`;
}

async function main() {
  const ownerUrl = process.env.EWOH_DATABASE_URL || process.env.SUDA_DATABASE_URL;
  const runtimeUrl = process.env.EWOH_RUNTIME_DATABASE_URL;
  if (!ownerUrl || !runtimeUrl) {
    throw new Error('EWOH_DATABASE_URL and EWOH_RUNTIME_DATABASE_URL are required');
  }

  const owner = postgres(ownerUrl, { max: 1 });
  const runtime = postgres(runtimeUrl, { max: 1 });
  const evidence = {};

  try {
    await cleanup(owner);
    await owner`
      insert into public.ewoh_organization (id, org_id, name, org_type, status)
      values
        (${ORG_A}::uuid, ${ORG_A}::uuid, 'Security Org A', 'factory', 'active'),
        (${ORG_B}::uuid, ${ORG_B}::uuid, 'Security Org B', 'factory', 'active')
    `;
    await owner`
      insert into public.ewoh_user
        (username, password_hash, display_name, org_id, roles, is_global_admin, status)
      values
        (${USERNAME}, 'security-probe-hash', 'Security Probe', ${ORG_A}::uuid, '["viewer"]'::jsonb, false, 'active')
    `;

    const [role] = await owner`
      select
        rolcanlogin,
        rolsuper,
        rolcreatedb,
        rolcreaterole,
        rolreplication,
        rolbypassrls,
        pg_has_role('ewoh_api', 'service_role', 'member') as service_member
      from pg_roles
      where rolname = 'ewoh_api'
    `;
    assert(role, 'ewoh_api role is missing');
    assert(role.rolcanlogin === true, 'ewoh_api must be a login role');
    assert(role.rolsuper === false, 'ewoh_api must not be superuser');
    assert(role.rolcreatedb === false, 'ewoh_api must not create databases');
    assert(role.rolcreaterole === false, 'ewoh_api must not create roles');
    assert(role.rolreplication === false, 'ewoh_api must not replicate');
    assert(role.rolbypassrls === false, 'ewoh_api must not bypass RLS');
    assert(role.service_member === true, 'ewoh_api must inherit service_role');
    evidence.runtime_role = 'LOGIN, NOBYPASSRLS, least-privilege attributes verified';

    await expectDenied(
      () => runtime`select username from public.ewoh_user where username = ${USERNAME}`,
      'direct user table read',
    );
    const users = await runtime`select * from public.ewoh_find_active_user(${USERNAME})`;
    assert(users.length === 1 && users[0].username === USERNAME, 'controlled user lookup failed');
    evidence.user_lookup = 'direct table read denied; SECURITY DEFINER lookup returned one active user';

    await runtime.begin(async (tx) => {
      await setOrgContext(tx, [ORG_A]);
      const visible = await tx`
        select id::text as id
        from public.ewoh_organization
        where id in (${ORG_A}::uuid, ${ORG_B}::uuid)
        order by id
      `;
      assert(visible.length === 1 && visible[0].id === ORG_A, 'organization B leaked into A context');

      const ownUpdate = await tx`
        update public.ewoh_organization
        set description = 'updated by organization A'
        where id = ${ORG_A}::uuid
        returning id::text as id
      `;
      assert(ownUpdate.length === 1, 'organization A could not update its own row');

      const crossUpdate = await tx`
        update public.ewoh_organization
        set description = 'cross-organization write'
        where id = ${ORG_B}::uuid
        returning id::text as id
      `;
      assert(crossUpdate.length === 0, 'organization A updated organization B');
    });

    await expectDenied(
      () => runtime.begin(async (tx) => {
        await setOrgContext(tx, [ORG_A]);
        await tx`
          insert into public.ewoh_organization (id, org_id, name, org_type, status)
          values (${ORG_B_CHILD}::uuid, ${ORG_B}::uuid, 'Blocked Cross Org', 'factory', 'active')
        `;
      }),
      'cross-organization insert',
    );

    await runtime.begin(async (tx) => {
      await setOrgContext(tx, [ORG_A], true);
      const visible = await tx`
        select id::text as id
        from public.ewoh_organization
        where id in (${ORG_A}::uuid, ${ORG_B}::uuid)
      `;
      assert(visible.length === 2, 'global administrator context could not read both organizations');
    });
    evidence.rls = 'org A positive read/update, org B negative read/update/insert, global admin read verified';

    await runtime.begin(async (tx) => {
      await setOrgContext(tx, [ORG_A]);
      await tx`
        select public.ewoh_append_audit_log(
          ${ORG_A}::uuid, 'security-probe', 'create', 'device', 'probe-device-1',
          null, '{"state":"created"}'::jsonb, 'security verification', '127.0.0.1',
          'security-probe-1', false, 'normal'
        )
      `;
      await tx`
        select public.ewoh_append_audit_log(
          ${ORG_A}::uuid, 'security-probe', 'update', 'device', 'probe-device-1',
          '{"state":"created"}'::jsonb, '{"state":"active"}'::jsonb,
          'security verification', '127.0.0.1', 'security-probe-2', true, 'high'
        )
      `;
      const visible = await tx`
        select hash
        from public.ewoh_audit_log
        where org_id = ${ORG_A}::uuid
        order by audit_seq
      `;
      assert(visible.length === 2, 'runtime role could not read its organization audit chain');
      assert(visible.every((row) => row.hash.length === 64), 'audit hash is not SHA-256 hex');
    });

    await expectDenied(
      () => runtime.begin(async (tx) => {
        await setOrgContext(tx, [ORG_A]);
        await tx`
          select public.ewoh_append_audit_log(
            ${ORG_B}::uuid, 'security-probe', 'create', 'device', 'blocked-cross-org'
          )
        `;
      }),
      'cross-organization audit append',
    );
    await expectDenied(
      () => runtime.begin(async (tx) => {
        await setOrgContext(tx, [ORG_A]);
        await tx`
          update public.ewoh_audit_log
          set hash = repeat('f', 64)
          where org_id = ${ORG_A}::uuid
        `;
      }),
      'direct audit tampering',
    );

    const chain = await owner`
      select
        chain_seq,
        prev_hash,
        hash,
        encode(sha256(convert_to(concat_ws('|',
          prev_hash,
          coalesce(org_id::text, ''),
          coalesce(actor_id, ''),
          action,
          entity_type,
          coalesce(entity_id, ''),
          coalesce(before_json::text, ''),
          coalesce(after_json::text, ''),
          coalesce(reason, ''),
          coalesce(client_ip, ''),
          coalesce(request_id, ''),
          coalesce(is_high_risk::text, 'false'),
          to_char(occurred_at at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')
        ), 'UTF8')), 'hex') as recomputed_hash
      from public.ewoh_audit_log
      where org_id = ${ORG_A}::uuid
      order by audit_seq
    `;
    assert(chain.length === 2, 'expected two audit entries for chain verification');
    let previous = '0'.repeat(64);
    for (let index = 0; index < chain.length; index += 1) {
      const row = chain[index];
      assert(Number(row.chain_seq) === index + 1, `audit chain sequence mismatch at ${index + 1}`);
      assert(row.prev_hash === previous, `audit previous hash mismatch at ${index + 1}`);
      assert(row.hash === row.recomputed_hash, `audit hash mismatch at ${index + 1}`);
      previous = row.hash;
    }
    evidence.audit = 'two-entry SHA-256 chain recomputed; cross-org append and direct tampering denied';

    console.log(JSON.stringify(evidence, null, 2));
    console.log('STANDALONE SECURITY VERIFY OK');
  } finally {
    try {
      await cleanup(owner);
    } finally {
      await Promise.allSettled([runtime.end(), owner.end()]);
    }
  }
}

main().catch((error) => {
  console.error('STANDALONE SECURITY VERIFY FAILED', error && (error.stack || error.message || error));
  process.exitCode = 1;
});
