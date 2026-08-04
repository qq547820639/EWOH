/**
 * UX-009 端到端体验测试矩阵 —— 视觉质量门禁。
 *
 * 与 ux009-visual.spec.js（像素级 `toHaveScreenshot` 回归，需 EWOH_VISUAL=1）不同，
 * 本用例是「视觉质量门禁」：在“生产构建 CSS 正确加载”的前提下，验证：
 *   1. 页面加载了真实的外链 CSS（非 inline），即 Tailwind/主题样式已就位；
 *   2. 关键组件（登录页提交按钮、指挥中心 h1、移动工作台 h1）的 computed style
 *      已应用设计系统（非浏览器默认样式），证明 CSS 真正作用到 DOM；
 *   3. 阻断静态资源 404（.js/.css/.svg/.png/.woff 等）；
 *   4. 阻断 console error；
 *   5. 阻断未处理异常（pageerror）。
 *
 * 说明：mockApi 未匹配的 API 会返回 404（设计行为），故仅阻断「静态资源」的 404，
 *       不阻断 API 404。本用例默认运行（无需环境变量），作为 CI 质量门禁。
 *
 * 运行方式：
 *   npx playwright test --config playwright.config.ts --grep "UX-009/VisualGate"
 * 依赖：`dist/client` 构建产物已存在（否则可先 `npm run build:client:standalone`）。
 */
const { test, expect } = require('@playwright/test');
const {
  ROLES,
  startStaticServer,
  openSession,
  mockApi,
} = require('./ux009-fixtures');

test.use({ serviceWorkers: 'block' });

const DASHBOARD_MOCK = {
  'GET /api/dashboard/overview': {
    deviceTotal: 12,
    deviceOnline: 9,
    eventOpen: 2,
    eventCritical: 1,
    avgLoad: 62,
    workerCount: 8,
  },
  'GET /api/dashboard/events': [],
};

/** 判断是否为静态资源请求（非 API）。 */
function isStaticResource(url) {
  return /\.(js|css|svg|png|jpe?g|gif|webp|ico|woff2?|ttf|eot|map|webmanifest)$/i.test(url);
}

/**
 * 为 page 注册视觉质量门禁监听，返回问题收集数组。
 * 三类问题：
 *   - 静态资源 4xx/5xx（资源缺失，直接阻断）
 *   - console error（阻断；如需容忍已知噪音，可在下方过滤）
 *   - 未处理异常 pageerror（阻断）
 */
function installGateListeners(page) {
  const issues = [];
  page.on('response', (res) => {
    if (res.status() >= 400 && isStaticResource(res.url())) {
      issues.push(`静态资源 ${res.status()} ${res.url()}`);
    }
  });
  page.on('console', (msg) => {
    if (msg.type() === 'error') {
      // 已知可容忍噪音在此过滤（当前无）；若真实构建出现无害噪音，可在此处按前缀放行并注释说明。
      issues.push(`console error: ${msg.text()}`);
    }
  });
  page.on('pageerror', (err) => {
    issues.push(`pageerror: ${err.message}`);
  });
  return issues;
}

/**
 * 断言页面加载了至少 1 个真实外链 CSS（href 非空且以 .css 结尾），
 * 且存在非 inline 的样式表（即样式确实来自独立 CSS 文件而非内联 <style>）。
 */
async function expectExternalStylesheet(page) {
  const info = await page.evaluate(() => {
    const sheets = Array.from(document.styleSheets);
    const external = sheets.filter((s) => s.href && /\.css$/i.test(s.href));
    // 非 inline 样式表：ownerNode 为 <link>（inline 的 <style> 其 ownerNode.tagName === 'STYLE'）
    const hasNonInline = sheets.some((s) => s.ownerNode && s.ownerNode.tagName === 'LINK');
    return { external: external.length, hasNonInline };
  });
  expect(info.external, '页面应加载至少 1 个真实 CSS 文件').toBeGreaterThanOrEqual(1);
  expect(info.hasNonInline, '页面应存在非 inline 的样式表（来自独立 CSS 文件）').toBe(true);
}

/** 读取 h1 的 computed style（fontWeight / fontSize）。 */
async function readH1Style(page) {
  return page.locator('h1').evaluate((el) => {
    const s = getComputedStyle(el);
    return { fontWeight: s.fontWeight, fontSize: s.fontSize };
  });
}

test.describe('UX-009/VisualGate', () => {
  let server;
  let baseUrl;

  test.beforeAll(async () => {
    server = await startStaticServer();
    baseUrl = server.baseUrl;
  });

  test.afterAll(async () => {
    await server.close();
  });

  test('登录页视觉质量门禁', async ({ page }) => {
    const issues = installGateListeners(page);
    await page.goto(`${baseUrl}/login`);

    const submit = page.locator('form button[type="submit"]');
    await expect(submit).toBeVisible();
    await expectExternalStylesheet(page);

    // 提交按钮背景色应来自主题工具类（bg-[hsl(221_83%_53%)]），非默认透明/白色。
    const bg = await submit.evaluate((el) => getComputedStyle(el).backgroundColor);
    expect(bg, `提交按钮背景色应非默认透明/白色，实际: ${bg}`).not.toBe('rgba(0, 0, 0, 0)');
    expect(bg, `提交按钮背景色应非默认白色，实际: ${bg}`).not.toBe('rgb(255, 255, 255)');

    expect(issues, issues.join('\n')).toEqual([]);
  });

  test('指挥中心视觉质量门禁', async ({ page }) => {
    const issues = installGateListeners(page);
    await mockApi(page, DASHBOARD_MOCK);
    await openSession(page, baseUrl, ROLES.dispatcher, '/command-center');

    await expect(page.locator('h1')).toHaveText('指挥中心');
    await expectExternalStylesheet(page);

    // 指挥中心 h1 使用 text-2xl font-bold → 24px / 700，非浏览器默认 h1（2em / bold）。
    const style = await readH1Style(page);
    expect(style.fontSize, `指挥中心 h1 fontSize 应为 24px，实际: ${style.fontSize}`).toBe('24px');
    expect(style.fontWeight, `指挥中心 h1 fontWeight 应为 700，实际: ${style.fontWeight}`).toBe('700');

    expect(issues, issues.join('\n')).toEqual([]);
  });

  test('移动工作台视觉质量门禁', async ({ page }) => {
    const issues = installGateListeners(page);
    await mockApi(page, { 'GET /api/mobile/workbench': [] });
    await openSession(page, baseUrl, ROLES.worker, '/mobile-workbench');

    await expect(page.locator('h1')).toHaveText('移动工作台');
    await expectExternalStylesheet(page);

    // 移动工作台 h1 同样使用 text-2xl font-bold → 24px / 700。
    const style = await readH1Style(page);
    expect(style.fontSize, `移动工作台 h1 fontSize 应为 24px，实际: ${style.fontSize}`).toBe('24px');
    expect(style.fontWeight, `移动工作台 h1 fontWeight 应为 700，实际: ${style.fontWeight}`).toBe('700');

    expect(issues, issues.join('\n')).toEqual([]);
  });
});