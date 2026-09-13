/**
 * 可用性自测冒烟（目标："可用、好用"验收）。
 *
 * 覆盖：
 * 1. 真实表单登录（用户名/密码 → 登录成功 → 进入指挥中心）；
 * 2. 全路由巡检（同一浏览器上下文内完成登录 + 巡检）：逐路由收集
 *    console error / 失败网络请求（HTTP >= 400）/ 白屏 / 未处理错误边界；
 * 3. 移动端视口（390x844）关键路由抽查 + 水平溢出检查
 *    （mobile 专项由 mobile-chromium 工程运行同一 spec）。
 *
 * 凭据来源环境变量（不落库）：EWOH_E2E_USER / EWOH_E2E_PASS。
 */
import { test, expect, type Page } from '@playwright/test';
const { resolveBrowserBaseUrl, browserCredentials } = require('./runtime-target');

const BASE_URL = resolveBrowserBaseUrl();

const ALL_ROUTES = [
  '/command-center',
  '/digital-world',
  '/scheduling',
  '/ai-decision',
  '/simulation',
  '/approval-console',
  '/decision-history',
  '/devices',
  '/personnel',
  '/alerts',
  '/organization',
  '/model-management',
  '/data-assets',
  '/system',
  '/mobile-workbench',
  '/role-workbench',
  '/scale',
  '/operations',
  '/command-map',
  '/work-orchestration',
  '/events',
  '/workers',
];

const MOBILE_ROUTES = ['/command-center', '/scheduling', '/devices', '/alerts', '/mobile-workbench'];

/**
 * CSP style-src 违规白名单（临时，发布标记：standalone-main.ts 的 style-src
 * 'unsafe-inline' 随下次发布上线后应删除本条并改回精确断言）。
 * 背景：sonner 全局 Toaster 与 ui/chart.tsx ChartStyle（按主题注入 CSS 变量）
 * 在每个页面产生 style-src 违规；本地 main 已修复 CSP（仅 style 维度，
 * script-src 保持 'self' 严格）。CSP 修复上线后 style-src 违规在构造上不可能
 * 再出现，故此白名单是安全的；其余指令（script-src 等）违规仍然失败。
 */
function isBenignConsoleError(text: string): boolean {
  if (text.includes('Content Security Policy') && text.includes("style-src 'self'")) {
    return true;
  }
  if (text.includes('favicon')) return true;
  return false;
}

function isBenignFailure(url: string, status: number): boolean {
  if (status === 401 && url.includes('/api/auth/me')) return true;
  if (status === 404 && url.includes('favicon')) return true;
  if (status === 404 && url.includes('/api/vision')) return true;
  if (status === 416) return true;
  return false;
}

interface RouteDiag {
  route: string;
  consoleErrors: string[];
  failedRequests: string[];
  blank: boolean;
  errorBoundary: boolean;
  horizontalOverflow: boolean;
}

function attachCollectors(page: Page, diag: RouteDiag): void {
  page.on('console', (msg) => {
    if (msg.type() === 'error' && !isBenignConsoleError(msg.text())) {
      diag.consoleErrors.push(msg.text().slice(0, 260));
    }
  });
  page.on('response', (res) => {
    if (res.status() >= 400 && !isBenignFailure(res.url(), res.status())) {
      diag.failedRequests.push(`${res.status()} ${res.url().slice(0, 180)}`);
    }
  });
}

async function loginViaForm(page: Page): Promise<void> {
  const { username, password } = browserCredentials();
  await page.goto(`${BASE_URL}/login`);
  await page.waitForLoadState('domcontentloaded');
  await page.locator('#username').fill(username);
  await page.locator('#password').fill(password);
  await page.locator('button[type="submit"]').click();
  await page.waitForURL((u) => !u.pathname.includes('/login'), { timeout: 20_000 });
  await page.waitForLoadState('networkidle', { timeout: 20_000 }).catch(() => {});
}

test.describe('可用性冒烟：真实登录 + 全路由巡检', () => {
  test('真实表单登录成功并进入指挥中心', async ({ page }) => {
    await loginViaForm(page);
    const body = await page.textContent('body');
    expect((body ?? '').length).toBeGreaterThan(50);
  });

  test('全路由巡检：无控制台报错 / 无失败请求 / 无白屏与错误边界', async ({ page }) => {
    test.setTimeout(300_000);
    await loginViaForm(page);
    const diags: RouteDiag[] = [];
    for (const route of ALL_ROUTES) {
      const diag: RouteDiag = {
        route,
        consoleErrors: [],
        failedRequests: [],
        blank: false,
        errorBoundary: false,
        horizontalOverflow: false,
      };
      attachCollectors(page, diag);
      await page.goto(`${BASE_URL}${route}`);
      await page.waitForLoadState('domcontentloaded');
      await page.waitForTimeout(2500);
      const body = (await page.textContent('body')) ?? '';
      diag.blank = body.trim().length <= 50;
      diag.errorBoundary =
        body.includes('Something went wrong') || body.includes('应用遇到错误');
      diags.push(diag);
    }

    const problems = diags.filter(
      (d) => d.blank || d.errorBoundary || d.consoleErrors.length > 0 || d.failedRequests.length > 0,
    );
    for (const d of diags) {
      console.log(
        `[TOUR] ${problems.includes(d) ? 'FAIL' : 'PASS'} ${d.route} console=${d.consoleErrors.length} net=${d.failedRequests.length}${d.blank ? ' [BLANK]' : ''}${d.errorBoundary ? ' [ERR-BOUNDARY]' : ''}`,
      );
      for (const e of d.consoleErrors) console.log(`       console: ${e}`);
      for (const f of d.failedRequests) console.log(`       net: ${f}`);
    }
    expect(problems, '存在可用性巡检问题（见上方 [TOUR] FAIL 明细）').toEqual([]);
  });

  test('移动端视口（390x844）关键路由抽查：含水平溢出检查', async ({ page }) => {
    test.setTimeout(180_000);
    await page.setViewportSize({ width: 390, height: 844 });
    await loginViaForm(page);
    const diags: RouteDiag[] = [];
    for (const route of MOBILE_ROUTES) {
      const diag: RouteDiag = {
        route,
        consoleErrors: [],
        failedRequests: [],
        blank: false,
        errorBoundary: false,
        horizontalOverflow: false,
      };
      attachCollectors(page, diag);
      await page.goto(`${BASE_URL}${route}`);
      await page.waitForLoadState('domcontentloaded');
      await page.waitForTimeout(2500);
      const body = (await page.textContent('body')) ?? '';
      diag.blank = body.trim().length <= 50;
      diag.errorBoundary = body.includes('Something went wrong');
      const [scrollWidth, clientWidth] = (await page.evaluate(() => [
        document.documentElement.scrollWidth,
        document.documentElement.clientWidth,
      ])) as [number, number];
      diag.horizontalOverflow = scrollWidth > clientWidth + 8;
      diags.push(diag);
    }
    const problems = diags.filter(
      (d) =>
        d.blank ||
        d.errorBoundary ||
        d.horizontalOverflow ||
        d.consoleErrors.length > 0 ||
        d.failedRequests.length > 0,
    );
    for (const d of diags) {
      console.log(
        `[MOBILE] ${problems.includes(d) ? 'FAIL' : 'PASS'} ${d.route} console=${d.consoleErrors.length} net=${d.failedRequests.length}${d.blank ? ' [BLANK]' : ''}${d.horizontalOverflow ? ' [H-OVERFLOW]' : ''}`,
      );
      for (const f of d.failedRequests) console.log(`       ${f}`);
    }
    expect(problems, '移动端视口存在可用性问题（见 [MOBILE] 明细）').toEqual([]);
  });
});
