import { readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

const root = resolve(__dirname, '../../../..');
const { migrationChain } = require(resolve(root, 'db/runner/standalone-chain.js'));
const { FILES, EXECUTE_COMMANDS } = require(resolve(root, 'db/runner/run_migrations.js'));

describe('standalone migration chain', () => {
  it('covers every migration file exactly once with registered apply, verify and rollback commands', () => {
    const chain = migrationChain();
    const files = readdirSync(resolve(root, 'db/migrations'))
      .filter((file) => /^standalone_\d+_.*\.sql$/.test(file) && !file.endsWith('.rollback.sql'));

    expect(chain.map((migration: { file: string }) => migration.file).sort())
      .toEqual(files.map((file) => resolve(root, 'db/migrations', file)).sort());
    expect(new Set(chain.map((migration: { id: string }) => migration.id)).size).toBe(chain.length);
    for (const migration of chain) {
      for (const action of ['apply', 'verify', 'rollback']) {
        expect(EXECUTE_COMMANDS.has(migration[action])).toBe(true);
      }
    }
  });

  it('creates scheduling dependencies before their consumers and reverses them for rollback', () => {
    const ids = migrationChain().map((migration: { id: string }) => migration.id);
    expect(ids.indexOf('017')).toBeLessThan(ids.indexOf('008'));
    expect(ids.indexOf('006')).toBeLessThan(ids.indexOf('048'));
    expect(ids.indexOf('029')).toBeLessThan(ids.indexOf('048'));
    const rollbackIds = [...ids].reverse();
    expect(rollbackIds.indexOf('008')).toBeLessThan(rollbackIds.indexOf('017'));
  });

  it('rejects missing registration or rollback artifacts instead of silently omitting a migration', () => {
    const files = { ...FILES };
    delete files.standalone_scheduling;
    expect(() => migrationChain(files)).toThrow('files and runner registrations do not match');
    expect(() => migrationChain({ ...FILES, standalone_scheduling_rollback: undefined }))
      .toThrow('Missing rollback registration');
  });

  it('rejects missing verification commands and duplicate migration IDs', () => {
    const commands = new Set(EXECUTE_COMMANDS);
    commands.delete('--verify-standalone-scheduling');
    expect(() => migrationChain(FILES, commands)).toThrow('Unregistered verify command');
    expect(() => migrationChain({
      ...FILES,
      standalone_workbench_prod: FILES.standalone_scheduling,
      standalone_workbench_prod_rollback: FILES.standalone_scheduling_rollback,
    })).toThrow('Duplicate standalone migration ID');
  });

  it('requires both DDL and destructive rollback authorization before invoking any migration', () => {
    const result = spawnSync(process.execPath, [resolve(root, 'db/runner/standalone-chain.js'), '--rollback'], {
      env: { ...process.env, EWOH_ALLOW_DDL: '1', EWOH_ALLOW_DESTRUCTIVE_ROLLBACK: '' },
      encoding: 'utf8',
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('EWOH_ALLOW_DESTRUCTIVE_ROLLBACK=1 is required');
    expect(result.stdout).not.toContain('[standalone-chain] rollback');
  });
});
