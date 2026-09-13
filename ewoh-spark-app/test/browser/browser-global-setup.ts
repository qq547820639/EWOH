import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import postgres from 'postgres';
import { cleanupE2EFixture, connectOwner, createE2EFixture, type E2EFixture, type OwnerSql } from '../helpers/e2e-db';
const { resolveBrowserBaseUrl, resolveBackendUrl } = require('./runtime-target');

const appDir = path.resolve(__dirname, '../..');

export default async function setup() {
  const evidenceDir = path.resolve(process.env.EWOH_BROWSER_EVIDENCE_DIR || '../output/playwright/browser-final');
  mkdirSync(evidenceDir, { recursive: true });
  execFileSync('npm', ['run', 'build:client:standalone'], { cwd: appDir, stdio: 'pipe' });
  if (process.env.EWOH_BROWSER_MODE === 'mock') {
    console.log('[browser] Mock-only run: local standalone client; no real API evidence.');
    return;
  }
  if (process.env.EWOH_E2E_BASE) {
    console.log(`[browser] Explicit target: ${resolveBrowserBaseUrl()}; backend: ${resolveBackendUrl()}`);
    return;
  }
  if (process.env.EWOH_E2E_BACKEND_URL) {
    throw new Error('Set EWOH_E2E_BASE as well when selecting an explicit backend. Automatic runs use one isolated local server.');
  }
  const ownerUrl = process.env.EWOH_E2E_OWNER_DATABASE_URL;
  const runtimeUrl = process.env.EWOH_E2E_RUNTIME_DATABASE_URL;
  if (!ownerUrl || !runtimeUrl) {
    throw new Error('Local browser verification requires EWOH_E2E_OWNER_DATABASE_URL and EWOH_E2E_RUNTIME_DATABASE_URL. For a selected mock-only spec use EWOH_BROWSER_MODE=mock.');
  }
  const ownerTarget = new URL(ownerUrl);
  const runtimeTarget = new URL(runtimeUrl);
  for (const target of [ownerTarget, runtimeTarget]) {
    if (!['127.0.0.1', 'localhost', '[::1]'].includes(target.hostname)) {
      throw new Error('Automatic browser fixtures require local PostgreSQL; use an explicit EWOH_E2E_BASE for another test environment.');
    }
  }
  if (ownerTarget.host !== runtimeTarget.host || ownerTarget.pathname !== runtimeTarget.pathname) {
    throw new Error('Browser owner and runtime URLs must address the same database.');
  }
  const runtime = postgres(runtimeUrl, { max: 1, connect_timeout: 5 });
  try {
    const [role] = await runtime`select current_user, rolsuper, rolbypassrls from pg_roles where rolname = current_user`;
    if (role.rolsuper || role.rolbypassrls) throw new Error('Browser API runtime must be a non-superuser role without BYPASSRLS.');
    console.log(`[browser] Local PostgreSQL runtime role: ${role.current_user}; RLS enabled.`);
  } finally {
    await runtime.end();
  }
  execFileSync('npm', ['run', 'build:server'], { cwd: appDir, stdio: 'pipe' });
  let owner: OwnerSql | undefined;
  let fixture: E2EFixture | undefined;
  let server: ChildProcess | undefined;
  let serverLog = '';
  const cleanup = async () => {
    if (server && server.exitCode === null && server.signalCode === null) {
      const exited = new Promise<void>((resolve) => server!.once('exit', () => resolve()));
      server.kill('SIGTERM');
      const timer = setTimeout(() => server!.kill('SIGKILL'), 5_000);
      await exited;
      clearTimeout(timer);
    }
    writeFileSync(path.join(evidenceDir, 'standalone-server.log'), serverLog);
    if (owner) {
      try { if (fixture) await cleanupE2EFixture(owner, fixture); }
      finally { await owner.end(); }
    }
  };
  try {
    owner = await connectOwner(ownerUrl);
    fixture = await createE2EFixture(owner);
    process.env.EWOH_E2E_USER = fixture.globalAdminA.username;
    process.env.EWOH_E2E_PASS = fixture.globalAdminA.password;
    process.env.EWOH_E2E_DISPATCH_USER = fixture.dispatcherA.username;
    process.env.EWOH_E2E_DISPATCH_PASS = fixture.dispatcherA.password;
    process.env.EWOH_E2E_ORG_ID = fixture.orgA.id;
    process.env.EWOH_BROWSER_LOCAL_FIXTURE = '1';
    const port = process.env.EWOH_BROWSER_RUNTIME_PORT || '3106';
    process.env.EWOH_E2E_BASE = `http://127.0.0.1:${port}`;
    process.env.EWOH_E2E_BACKEND_URL = process.env.EWOH_E2E_BASE;
    server = spawn(process.execPath, ['test/browser/standalone-browser-server.js'], {
      cwd: appDir,
      env: {
        ...process.env,
        NODE_ENV: 'production', EWOH_DEPLOY_TARGET: 'standalone', HOST: '127.0.0.1', PORT: port,
        DATABASE_URL: runtimeUrl, JWT_SECRET: 'ewoh-browser-local-fixture-secret-2026-09-10',
        EWOH_SIMULATOR_DISABLED: '1', REDIS_URL: '',
        ALLOW_LOCAL_FILE_STORAGE: 'true',
        INGEST_API_KEY: 'ewoh-browser-local-ingest-only',
        RATE_LIMIT_MAX: '100000', LOGIN_RATE_LIMIT_MAX: '10000',
        EWOH_BOOTSTRAP_ADMIN_USERNAME: '', EWOH_BOOTSTRAP_ADMIN_PASSWORD: '',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    server.stdout!.on('data', (chunk) => { serverLog += String(chunk); });
    server.stderr!.on('data', (chunk) => { serverLog += String(chunk); });
    const deadline = Date.now() + 60_000;
    while (Date.now() < deadline) {
      if (server.exitCode !== null || server.signalCode !== null) throw new Error(`Standalone server exited: ${serverLog.slice(-4000)}`);
      try {
        const response = await fetch(`${resolveBrowserBaseUrl()}/health/live`, { signal: AbortSignal.timeout(1000) });
        if (response.ok) {
          const login = await fetch(`${resolveBrowserBaseUrl()}/api/auth/login`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(fixture.dispatcherA),
          });
          if (!login.ok) throw new Error(`Fixture login failed: ${login.status} ${await login.text()}`);
          console.log(`[browser] Standalone ready: ${resolveBrowserBaseUrl()}; unique tenant ${fixture.orgA.id}`);
          writeFileSync(path.join(evidenceDir, 'environment.json'), JSON.stringify({
            baseUrl: resolveBrowserBaseUrl(), orgId: fixture.orgA.id,
            runtimeRole: runtimeTarget.username, database: runtimeTarget.pathname.slice(1),
            startedAt: new Date().toISOString(),
          }, null, 2));
          return cleanup;
        }
      } catch (error) {
        if (String(error).includes('Fixture login failed')) throw error;
      }
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    throw new Error(`Standalone startup timed out: ${serverLog.slice(-4000)}`);
  } catch (error) {
    await cleanup();
    throw error;
  }
}
