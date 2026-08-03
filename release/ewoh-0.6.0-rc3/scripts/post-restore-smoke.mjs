#!/usr/bin/env node
/* Post-restore smoke: verifies identity sequences advance after logical restore. */

import postgres from '../ewoh-spark-app/node_modules/postgres/src/index.js';

const url = process.env.RESTORE_URL;
if (!url) {
  throw new Error('RESTORE_URL is required');
}

const sql = postgres(url, { max: 1 });
try {
  await sql.unsafe(`
    insert into public.ewoh_world_delta_log
      (org_id, snapshot_version, entity_type, entity_id, delta_type, source_type)
    values
      ('00000000-0000-4000-8000-000000000001'::uuid, 1, 'ops', 'drill', 'upsert', 'simulated')
  `);
  console.log('identity sequence advanced after restore');
} finally {
  await sql.end();
}
