/* Phase 4 收口：Command Map 真实后端 + 真实浏览器 E2E。
 *
 * 前置：
 *  1. PostgreSQL（15432）已跑全链 standalone migration + admin seed；
 *  2. 真实 NestJS 已启动：EWOH_E2E_SERVER_PORT=3100（standalone-e2e-server.ts）；
 *  3. dist/client standalone 已构建（含 PlanCompare/ConflictPreview）。
 *
 * 运行：
 *   npx playwright test --config playwright.commandmap.config.ts --project=chromium
 */
import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: './test/browser',
  testMatch: /scheduler-command-map\.e2e\.spec\.ts/,
  timeout: 120_000,
  workers: 1,
  fullyParallel: false,
  reporter: [['list'], ['html', { outputFolder: 'test-results/commandmap-report' }]],
  use: {
    headless: true,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
});
