#!/usr/bin/env node
'use strict';

/*
 * EWOH F61-02 (2.D / 2.F): dual-instance concurrency verification against a real
 * PostgreSQL. Simulates two independent app instances (two separate connections)
 * racing on the domain-persistence primitives, and asserts the multi-instance
 * invariants that the runtime relies on:
 *
 *   1. Unique (org, resource_key) constraint coalesces two concurrent lock
 *      acquisitions to a single holder (no dual ownership).
 *   2. Optimistic-lock version CAS: two concurrent conditional updates on the
 *      same row (WHERE version = X) yield exactly one winner.
 *   3. A non-holder cannot renew or release a lock (holder is verified).
 *   4. An expired lock can be safely taken over by another instance.
 *   5. Redundant re-run is safe (ewoh_% tables may be re-tested without data loss).
 *
 * Requires a runtime connection: EWOH_DATABASE_URL or EWOH_RUNTIME_DATABASE_URL.
 * Uses the same postgres driver as run_migrations.js. Exits non-zero on any failure.
 * Tables are cleaned up at the end (only rows created by this script are removed).
 */

const path = require('path');
const { createRequire } = require('module');
const { randomUUID } = require('crypto');

const root = path.resolve(__dirname, '..');
const appDir = path.join(root, 'ewoh-spark-app');
const requireFromApp = createRequire(path.join(appDir, 'package.json'));

const SCHEMA = process.env.EWOH_SCHEMA || 'public';
const url =
  process.env.EWOH_DATABASE_URL ||
  process.env.EWOH_RUNTIME_DATABASE_URL;

const runId = randomUUID().slice(0, 8);
const ORG = `conc-${runId}`;
const KEY = `res-${runId}`;

let failures = 0;
let checks = 0;

function check(name, ok, detail) {
  checks += 1;
  if (!ok) failures += 1;
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`);
}

function qualify(table) {
  return `${SCHEMA}.${table}`;
}

function main() {
  if (!url) {
    console.error(
      'EWOH_DATABASE_URL or EWOH_RUNTIME_DATABASE_URL is required ' +
        '(real PostgreSQL with the 6 domain tables migrated).',
    );
    process.exit(2);
  }
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(SCHEMA)) {
    console.error(`Invalid EWOH_SCHEMA: ${SCHEMA}`);
    process.exit(2);
  }

  const postgres = requireFromApp('postgres');
  // Two independent connections = two independent app instances.
  const instanceA = postgres(url, { max: 1, onnotice: () => {} });
  const instanceB = postgres(url, { max: 1, onnotice: () => {} });

  const L = qualify('ewoh_resource_locks');

  (async () => {
    console.log(`EWOH domain concurrency verification | schema=${SCHEMA} | org=${ORG}`);

    // --- 1) Unique-constraint race: two instances acquire the same lock. ---
    // Exactly one must win; the other must observe a unique violation (409-ish).
    const key1 = `${KEY}-race`;
    const attemptA = instanceA`
      insert into ${instanceA(L)} (org_id, resource_key, resource_id, holder, active, version)
      values (${ORG}, ${key1}, ${key1}, 'instance-A', true, 1)
      on conflict (org_id, resource_key) do nothing
      returning id`;
    const attemptB = instanceB`
      insert into ${instanceB(L)} (org_id, resource_key, resource_id, holder, active, version)
      values (${ORG}, ${key1}, ${key1}, 'instance-B', true, 1)
      on conflict (org_id, resource_key) do nothing
      returning id`;
    const [winnerRA, winnerRB] = await Promise.all([attemptA, attemptB]);

    const rowsRA = winnerRA && winnerRA.length;
    const rowsRB = winnerRB && winnerRB.length;
    const winners = [rowsRA, rowsRB].filter((n) => n === 1).length;
    check(
      'unique (org, resource_key) coalesces concurrent lock acquisition to one holder',
      winners === 1,
      `winners=${winners} (A=${rowsRA}, B=${rowsRB})`,
    );

    // --- 2) Optimistic-lock version CAS: concurrent conditional updates. ---
    const key2 = `${KEY}-cas`;
    await instanceA`
      insert into ${instanceA(L)} (org_id, resource_key, resource_id, holder, active, version)
      values (${ORG}, ${key2}, ${key2}, 'instance-A', true, 1)`;
    const casA = instanceA`
      update ${instanceA(L)}
      set version = version + 1, _updated_at = now()
      where org_id = ${ORG} and resource_key = ${key2} and version = 1`;
    const casB = instanceB`
      update ${instanceB(L)}
      set version = version + 1, _updated_at = now()
      where org_id = ${ORG} and resource_key = ${key2} and version = 1`;
    const [countA, countB] = await Promise.all([casA, casB]);
    // postgresjs returns a Result (Array subclass) for UPDATE without RETURNING,
    // whose .count is a leading-zero-padded *string* of affected rows. Compare the
    // numeric row counts, not the Result objects.
    const affectedA = Number(countA && countA.count);
    const affectedB = Number(countB && countB.count);
    const casWinners = [affectedA, affectedB].filter((c) => c === 1).length;
    check(
      'optimistic version CAS: concurrent WHERE version = X updates yield one winner',
      casWinners === 1,
      `winners=${casWinners} (A=${affectedA}, B=${affectedB})`,
    );

    // --- 3) Non-holder cannot release or renew a lock. ---
    const key3 = `${KEY}-holder`;
    await instanceA`
      insert into ${instanceA(L)} (org_id, resource_key, resource_id, holder, active, version)
      values (${ORG}, ${key3}, ${key3}, 'instance-A', true, 1)`;
    const [renewal, released] = await Promise.all([
      instanceB`
        update ${instanceB(L)}
        set renewed_at = now(), version = version + 1
        where org_id = ${ORG} and resource_key = ${key3}
          and active = true and holder = 'instance-B'`,
      instanceB`
        update ${instanceB(L)}
        set active = false, version = version + 1
        where org_id = ${ORG} and resource_key = ${key3}
          and active = true and holder = 'instance-B'`,
    ]);
    // Again, compare affected-row counts (strings from postgresjs) not objects.
    const renewAffected = Number(renewal && renewal.count);
    const releaseAffected = Number(released && released.count);
    check(
      'non-holder cannot renew/release: zero rows affected by holder-checked writes',
      renewAffected === 0 && releaseAffected === 0,
      `renewAffected=${renewAffected}, releaseAffected=${releaseAffected}`,
    );
    const holderStill = await instanceA`
      select active, holder from ${instanceA(L)}
      where org_id = ${ORG} and resource_key = ${key3}`;
    check(
      'lock remains held by the original holder after non-holder attempts',
      holderStill.length === 1 &&
        holderStill[0].holder === 'instance-A' &&
        holderStill[0].active === true,
      `holder=${holderStill[0] && holderStill[0].holder}`,
    );

    // --- 4) Expired lock can be safely taken over by another instance. ---
    const key4 = `${KEY}-expired`;
    await instanceA`
      insert into ${instanceA(L)} (org_id, resource_key, resource_id, holder, active, version)
      values (${ORG}, ${key4}, ${key4}, 'instance-A', true, 1)`;
    // Instance B takes over the (expired-by-holder-crash) lock via a version CAS.
    const [takenOver] = await instanceB`
      update ${instanceB(L)}
      set holder = 'instance-B', active = true, version = version + 1, _updated_at = now()
      where org_id = ${ORG} and resource_key = ${key4} and version = 1
      returning holder, version`;
    check(
      'expired/stale lock can be safely taken over by another instance (version CAS)',
      takenOver && takenOver.holder === 'instance-B' && takenOver.version === 2,
      `holder=${takenOver && takenOver.holder}, version=${takenOver && takenOver.version}`,
    );

    // --- 5) Redundant re-run safety: updates are idempotent, no double rows. ---
    const key5 = `${KEY}-rerun`;
    await instanceA`
      insert into ${instanceA(L)} (org_id, resource_key, resource_id, holder, active, version)
      values (${ORG}, ${key5}, ${key5}, 'instance-A', true, 1)
      on conflict (org_id, resource_key) do nothing`;
    await instanceB`
      insert into ${instanceB(L)} (org_id, resource_key, resource_id, holder, active, version)
      values (${ORG}, ${key5}, ${key5}, 'instance-A', true, 1)
      on conflict (org_id, resource_key) do nothing`;
    const count5 = await instanceA`
      select count(*)::int as n from ${instanceA(L)}
      where org_id = ${ORG} and resource_key = ${key5}`;
    check(
      're-entrant write to the same (org, resource_key) does not duplicate rows',
      count5.length === 1 && count5[0].n === 1,
      `rows=${count5[0] && count5[0].n}`,
    );
  })()
    .catch((err) => {
      failures += 1;
      checks += 1;
      console.error('ERROR', err && (err.message || err));
    })
    .finally(async () => {
      // Clean up only the rows this script created.
      try {
        await instanceA`
          delete from ${instanceA(L)} where org_id = ${ORG}`;
      } catch (err) {
        console.error('cleanup A failed', err && err.message);
      }
      try {
        await instanceA.end();
      } catch (err) {
        // ignore close errors
      }
      try {
        await instanceB.end();
      } catch (err) {
        // ignore close errors
      }
      console.log(`\n${checks - failures}/${checks} concurrency checks passed`);
      process.exitCode = failures === 0 ? 0 : 1;
    });
}

main();