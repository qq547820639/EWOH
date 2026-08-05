/**
 * UX-0011 工业网络 —— 低带宽/离线重连下的登录可用性。
 *
 * 使用 CDP Network.emulateNetworkConditions 模拟弱网（高延迟 + 低带宽），
 * 验证登录页在慢网络下仍能渲染出可用的登录表单。
 *
 * 说明：登录页是 SPA（无独立「网络加载」骨架屏），因此本用例聚焦稳健断言：
 * 在限速下页面最终仍渲染出标题与提交按钮（表单可用）。若后续引入 loading 壳，
 * 可在此追加「加载态」断言。
 *
 * 运行方式：
 *   npx playwright test --config playwright.config.ts --project=chromium --grep "UX-0011/Network"
 */
import { test, expect } from '@playwright/test';
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { startStaticServer } = require('./ux009-fixtures');

test.use({ serviceWorkers: 'block' });

// CDP Network.emulateNetworkConditions 仅 Chromium 系列可用；Firefox/WebKit 无等价
// 跨浏览器节流 API，故在非 Chromium 工程显式跳过（带原因，非静默跳过）。
// Firefox/WebKit 的弱网覆盖由 CI 的限速代理/路由层用例承担。
test.skip(({ browserName }) => browserName !== 'chromium', 'CDP network throttling is Chromium-only');

test.describe('UX-0011/Network', () => {
  let server: { baseUrl: string; close: () => Promise<void> };
  let baseUrl: string;

  test.beforeAll(async () => {
    server = await startStaticServer();
    baseUrl = server.baseUrl;
  });

  test.afterAll(async () => {
    await server.close();
  });

  test('低带宽 + 高延迟下登录页仍渲染出可用表单', async ({ page, context }) => {
    const client = await context.newCDPSession(page);
    await client.send('Network.enable');
    // 限速：约 200 KB/s 下行、1s RTT（近似低速工业现场网络）。
    await client.send('Network.emulateNetworkConditions', {
      offline: false,
      latency: 1000,
      downloadThroughput: 200 * 1024,
      uploadThroughput: 200 * 1024,
    });

    await page.goto(`${baseUrl}/login`);

    // 慢网络下最终（timeout 放宽）渲染出标题与提交按钮。
    await expect(page.getByRole('heading', { name: 'EWOH' })).toBeVisible({
      timeout: 30_000,
    });
    await expect(page.locator('button[type="submit"]')).toBeVisible();

    // 恢复网络，避免影响同工程后续用例。
    await client.send('Network.emulateNetworkConditions', {
      offline: false,
      latency: 0,
      downloadThroughput: -1,
      uploadThroughput: -1,
    });
  });
});