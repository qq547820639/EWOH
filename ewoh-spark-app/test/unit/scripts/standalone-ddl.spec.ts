import { cpSync, mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { execFileSync, spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';

const root = resolve(__dirname, '../../../..');
const yaml = require('js-yaml');
const domainTables = new Set([
  'ewoh_resource_locks', 'ewoh_handoffs', 'ewoh_git_sync_state',
  'ewoh_evidence_metadata', 'ewoh_factory_replication_sessions', 'ewoh_idempotency_keys',
]);
const verifyFiles = ['db/verify/001_verify.sql', 'db/verify/standalone_001_verify.sql'];
const generatorEnv = { ...process.env, EWOH_DDL_ROLES_JSON: '' };

function withGeneratorCopy(check: (copy: string) => void) {
  const copy = mkdtempSync(resolve(tmpdir(), 'ewoh-verify-generator-'));
  try {
    cpSync(resolve(root, 'db'), resolve(copy, 'db'), { recursive: true });
    mkdirSync(resolve(copy, 'scripts'));
    for (const name of ['generate-ddl-package.js', 'generate-standalone-ddl.js']) {
      cpSync(resolve(root, 'scripts', name), resolve(copy, 'scripts', name));
    }
    mkdirSync(resolve(copy, 'ewoh-spark-app'));
    cpSync(resolve(root, 'ewoh-spark-app/package.json'), resolve(copy, 'ewoh-spark-app/package.json'));
    symlinkSync(resolve(root, 'ewoh-spark-app/node_modules'), resolve(copy, 'ewoh-spark-app/node_modules'), 'dir');
    check(copy);
  } finally {
    rmSync(copy, { recursive: true, force: true });
  }
}

function generate(copy: string) {
  for (const script of ['generate-ddl-package.js', 'generate-standalone-ddl.js']) {
    execFileSync(process.execPath, [resolve(copy, 'scripts', script)], { env: generatorEnv });
  }
}

function expectedTables(sql: string): string[] {
  const cte = sql.match(/^WITH expected\(name\) AS \(VALUES ((?:\('[a-z0-9_]+'\))(?:, \('[a-z0-9_]+'\))*)\),\nrequest_scoped\(name\) AS/m);
  expect(cte).not.toBeNull();
  return [...cte![1].matchAll(/'([^']+)'/g)].map((match) => match[1]);
}
const { standaloneTransform } = require(
  resolve(root, 'scripts/generate-standalone-ddl.js'),
) as {
  standaloneTransform(
    sql: string,
    options?: { bootstrapRoles?: boolean },
  ): string;
};

describe('standalone DDL role mapping', () => {
  it('runs both generator CLIs twice without losing final registrations or verify SQL syntax', () => {
    withGeneratorCopy((copy) => {
      const manifest = readFileSync(resolve(copy, 'db/contracts/schema-manifest.yaml'), 'utf8');
      const expected = yaml.load(manifest).managed_tables
        .map((entry: { physical_table: string }) => entry.physical_table)
        .filter((name: string) => !domainTables.has(name));
      expect(expected).toHaveLength(68);
      for (let iteration = 0; iteration < 2; iteration += 1) {
        generate(copy);
        expect(readFileSync(resolve(copy, 'db/contracts/schema-manifest.yaml'), 'utf8')).toBe(manifest);
        for (const file of verifyFiles) {
          const sql = readFileSync(resolve(copy, file), 'utf8');
          expect(expectedTables(sql)).toEqual(expected);
          expect(sql).toBe(readFileSync(resolve(root, file), 'utf8'));
        }
      }
    });
  });

  it('includes future manifest registrations without reverting to a hard-coded 68-table list', () => {
    withGeneratorCopy((copy) => {
      const file = resolve(copy, 'db/contracts/schema-manifest.yaml');
      const manifest = yaml.load(readFileSync(file, 'utf8'));
      manifest.managed_tables.push({ physical_table: 'ewoh_future_test', org_id_policy: 'NOT NULL' });
      manifest.managed_package.managed_count += 1;
      manifest.managed_package.physical_create_count += 1;
      const text = yaml.dump(manifest);
      writeFileSync(file, text);
      generate(copy);
      expect(readFileSync(file, 'utf8')).toBe(text);
      for (const verifyFile of verifyFiles) {
        const names = expectedTables(readFileSync(resolve(copy, verifyFile), 'utf8'));
        expect(names).toHaveLength(69);
        expect(names).toContain('ewoh_future_test');
      }
    });
  });

  it.each(['missing count', 'duplicate table', 'missing domain table'])(
    'rejects a manifest with %s before writing any package output', (defect) => {
      withGeneratorCopy((copy) => {
        const file = resolve(copy, 'db/contracts/schema-manifest.yaml');
        const manifest = yaml.load(readFileSync(file, 'utf8'));
        if (defect === 'missing count') delete manifest.managed_package.managed_count;
        if (defect === 'duplicate table') manifest.managed_tables[1] = manifest.managed_tables[0];
        if (defect === 'missing domain table') {
          manifest.managed_tables.find((entry: { physical_table: string }) => entry.physical_table === 'ewoh_handoffs').physical_table = 'ewoh_wrong_domain';
        }
        const text = yaml.dump(manifest);
        writeFileSync(file, text);
        const migrationFile = resolve(copy, 'db/migrations/001_ewoh_managed_tables.sql');
        const before = readFileSync(migrationFile, 'utf8');
        const result = spawnSync(process.execPath, [resolve(copy, 'scripts/generate-ddl-package.js')], {
          env: generatorEnv, encoding: 'utf8',
        });
        expect(result.status).not.toBe(0);
        expect(result.stderr).toContain('schema-manifest.yaml');
        expect(readFileSync(migrationFile, 'utf8')).toBe(before);
        expect(readFileSync(file, 'utf8')).toBe(text);
      });
    },
  );

  it('keeps nullable global lineage out of NOT NULL checks while checking later tenant tables', () => {
    for (const file of verifyFiles) {
      const sql = readFileSync(resolve(root, file), 'utf8');
      const nullableCheck = sql.match(/nullable_org AS \(([\s\S]*?)\n\),/)![1];
      expect(expectedTables(sql)).toContain('ewoh_trace_span');
      expect(nullableCheck).not.toContain("'ewoh_trace_span'");
      expect(nullableCheck).toContain("'ewoh_exo_config'");
      expect(nullableCheck).toContain("'ewoh_identity_mapping'");
    }
  });

  it('derives both verify expected lists from the final manifest core footprint', () => {
    const generator = require(
      resolve(root, 'scripts/generate-ddl-package.js'),
    ) as {
      coreManagedTablesFromManifest(): string[];
      renderVerify(): string;
    };
    const coreTables = generator.coreManagedTablesFromManifest();
    const verify = generator.renderVerify();
    const expectedLine = verify
      .split('\n')
      .find((line) => line.startsWith('WITH expected'))!;
    const expected = [...expectedLine.matchAll(/'([^']+)'/g)].map(
      (match) => match[1],
    );
    const standalone = standaloneTransform(verify);
    const standaloneExpectedLine = standalone
      .split('\n')
      .find((line) => line.startsWith('WITH expected'))!;

    expect(coreTables).toHaveLength(68);
    expect(new Set(coreTables).size).toBe(68);
    expect(expected).toEqual(coreTables);
    expect(
      [...standaloneExpectedLine.matchAll(/'([^']+)'/g)].map(
        (match) => match[1],
      ),
    ).toEqual(coreTables);
    expect((expectedLine.match(/\(/g) || []).length).toBe(
      (expectedLine.match(/\)/g) || []).length,
    );
    expect(verify).toContain('request_scoped(name) AS (VALUES ');
    expect(verify).toContain('\nmanaged AS (');
  });

  it('keeps checked-in verify artifacts byte-for-byte reproducible', () => {
    const generator = require(
      resolve(root, 'scripts/generate-ddl-package.js'),
    ) as {
      renderVerify(): string;
    };
    const generated = generator.renderVerify();
    expect(readFileSync(resolve(root, 'db/verify/001_verify.sql'), 'utf8')).toBe(
      generated,
    );
    expect(
      readFileSync(resolve(root, 'db/verify/standalone_001_verify.sql'), 'utf8'),
    ).toBe(standaloneTransform(generated));
  });

  it('maps parameterized role names to the roles created on an empty database', () => {
    const source = readFileSync(
      resolve(root, 'db/migrations/001_ewoh_managed_tables.sql'),
      'utf8',
    );
    const transformed = standaloneTransform(source, { bootstrapRoles: true });

    expect(transformed).not.toMatch(/__EWOH_ROLE_|__EWOH_SCHEMA__/);
    expect(transformed).not.toMatch(
      /authenticated_public|service_role_public|anon_public/,
    );
    expect(transformed).toContain('CREATE ROLE authenticated NOLOGIN');
    expect(transformed).toContain('CREATE ROLE service_role NOLOGIN');
    expect(transformed).toContain("'authenticated', 'public'");
    expect(transformed).toContain("'service_role', 'public'");
  });

  it('keeps legacy and parameterized roles equivalent for grants and verification', () => {
    const roles = ['USER_AUTHENTICATED', 'AUTHENTICATED', 'ANON', 'SERVICE'];
    const output = standaloneTransform(
      roles.map((role) => `__EWOH_ROLE_${role}__`).join(' '),
    );

    expect(output).toBe('authenticated authenticated anon service_role');
    expect(
      standaloneTransform(
        'user_authenticated_workspace_aadknm4yzbyds authenticated_workspace_aadknm4yzbyds anon_workspace_aadknm4yzbyds service_role_workspace_aadknm4yzbyds',
      ),
    ).toBe(output);
  });

  it('generates a destructive rollback for every table in the standalone 001 schema', () => {
    const source = readFileSync(
      resolve(root, 'db/migrations/standalone_001_schema.sql'),
      'utf8',
    );
    const { renderStandaloneRollback } = require(
      resolve(root, 'scripts/generate-standalone-ddl.js'),
    ) as {
      renderStandaloneRollback(sql: string): string;
    };
    const rollback = renderStandaloneRollback(source);
    const tables = [
      ...source.matchAll(
        /^CREATE TABLE IF NOT EXISTS public\.([a-z0-9_]+)\s*\(/gm,
      ),
    ].map((match) => match[1]);

    expect(tables.length).toBeGreaterThan(0);
    for (const table of tables) {
      expect(rollback).toContain(
        `DROP TABLE IF EXISTS public.${table} CASCADE;`,
      );
    }
    expect(rollback).toContain('public.ewoh_ai_suggestion CASCADE');
  });
});
