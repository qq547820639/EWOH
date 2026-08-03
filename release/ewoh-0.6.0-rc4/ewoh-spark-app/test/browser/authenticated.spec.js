const { test, expect } = require('@playwright/test');
const { spawn } = require('node:child_process');
const { randomUUID } = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const postgres = require('postgres');
const bcrypt = require('bcryptjs');

const APP_DIR = path.resolve(__dirname, '..', '..');
const ROOT = path.resolve(APP_DIR, '..');
const OWNER_URL =
  process.env.EWOH_E2E_OWNER_DATABASE_URL ||
  'postgresql://postgres:ewoh-test-only@127.0.0.1:55432/postgres';
const RUNTIME_URL = process.env.EWOH_E2E_RUNTIME_DATABASE_URL;
const PORT = Number(process.env.EWOH_BROWSER_PORT || 3105);
const BASE_URL = `http://127.0.0.1:${PORT}`;

async function waitForHealth(timeoutMs = 45_000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    try {
      const response = await fetch(`${BASE_URL}/health/live`);
      if (response.ok) {
        return;
      }
    } catch {
      // server still starting
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error('Standalone API did not become ready');
}

async function loginAsDispatcher(page, user) {
  await page.goto(`${BASE_URL}/login`);
  await page.fill('#username', user.username);
  await page.fill('#password', user.password);
  await page.click('button[type="submit"]');
  await page.waitForURL(/command-center/, { timeout: 30_000 });
  await expect(page.locator('body')).toContainText('指挥中心');
}

test.describe('authenticated browser flow', () => {
  let owner;
  let server;
  let credentials;
  let orgId;
  let serverLog = '';

  test.beforeAll(async () => {
    if (!RUNTIME_URL) {
      throw new Error('EWOH_E2E_RUNTIME_DATABASE_URL is required');
    }
    owner = postgres(OWNER_URL, {
      max: 5,
      idle_timeout: 30_000,
      connect_timeout: 10,
      prepare: false,
    });
    await owner.unsafe('select 1 as ready');

    const suffix = randomUUID().slice(0, 8);
    orgId = randomUUID();
    credentials = {
      username: `browser_dispatch_${suffix}`,
      password: `Browser-Dispatch-${suffix}-Aa1!`,
    };
    const passwordHash = await bcrypt.hash(credentials.password, 10);
    await owner.begin(async (tx) => {
      await tx.unsafe(
        `insert into public.ewoh_organization
          (id, org_id, name, org_type, status, _created_at, _updated_at)
         values ($1::uuid, $1::uuid, $2, 'e2e', 'active', now(), now())`,
        [orgId, `Browser Org ${suffix}`],
      );
      await tx.unsafe(
        `insert into public.ewoh_user
          (username, password_hash, display_name, org_id, roles, is_global_admin, status)
         values ($1, $2, $3, $4::uuid, '["dispatcher"]'::jsonb, false, 'active')`,
        [credentials.username, passwordHash, 'Browser Dispatcher', orgId],
      );
    });

    server = spawn(process.execPath, ['dist/server/main.js'], {
      cwd: APP_DIR,
      env: {
        ...process.env,
        NODE_ENV: 'production',
        EWOH_DEPLOY_TARGET: 'standalone',
        HOST: '127.0.0.1',
        PORT: String(PORT),
        DATABASE_URL: RUNTIME_URL,
        JWT_SECRET: 'ewoh-browser-test-secret-2026-08-04',
        EWOH_WORK_WRITABLE: 'false',
        RATE_LIMIT_MAX: '10000',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    server.stdout?.on('data', (chunk) => {
      serverLog += String(chunk);
    });
    server.stderr?.on('data', (chunk) => {
      serverLog += String(chunk);
    });
    try {
      await waitForHealth();
    } catch (error) {
      throw new Error(`${String(error?.message || error)}\n--- server log ---\n${serverLog.slice(-3000)}`);
    }
  }, 90_000);

  test.afterAll(async () => {
    if (server && server.exitCode === null) {
      server.kill('SIGTERM');
      await new Promise((resolve) => server.once('exit', resolve));
    }
    if (owner) {
      try {
        await owner.unsafe(
          'delete from public.ewoh_user where org_id = $1::uuid',
          [orgId],
        );
        await owner.unsafe(
          'delete from public.ewoh_organization where id = $1::uuid',
          [orgId],
        );
      } finally {
        await owner.end();
      }
    }
  });

  test('logs in as dispatcher and renders the command center', async ({ page }) => {
    await loginAsDispatcher(page, credentials);

    const screenshotDir = path.join(ROOT, 'output', 'playwright');
    fs.mkdirSync(screenshotDir, { recursive: true });
    await page.screenshot({
      path: path.join(screenshotDir, 'browser-authenticated-command-center.png'),
    });
  });

  test('renders the command map after login', async ({ page }) => {
    await loginAsDispatcher(page, credentials);
    await page.goto(`${BASE_URL}/command-map`);
    await expect(page.locator('body')).toContainText('EWOH 指挥地图');
    await expect(page.locator('input[placeholder*="搜索实体"]')).toBeVisible();
  });

  test('renders the mobile workbench after login', async ({ page }) => {
    await loginAsDispatcher(page, credentials);
    await page.goto(`${BASE_URL}/mobile-workbench`);
    await expect(page.locator('body')).toContainText('移动工作台');
    await expect(page.locator('input[placeholder*="扫码或输入工单号"]')).toBeVisible();
  });

  test('renders the alerts page after login', async ({ page }) => {
    await loginAsDispatcher(page, credentials);
    await page.goto(`${BASE_URL}/alerts`);
    await expect(page.locator('body')).toContainText('风险与告警');
  });
});
