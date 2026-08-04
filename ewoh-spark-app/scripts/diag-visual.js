/**
 * W2 视觉资源链诊断脚本。
 * 启动静态服务器，加载登录页/指挥中心，报告：
 *  - stylesheet 数量与内容
 *  - 关键元素 computed style（是否应用了 Tailwind/design token）
 *  - 资源 404 / console error / 未处理异常
 *  - 页面截图
 * 用法：node scripts/diag-visual.js
 */
const { chromium } = require('@playwright/test');
const path = require('node:path');
const { startStaticServer, openSession, mockApi, ROLES } = require('../test/browser/ux009-fixtures');

const DASHBOARD_MOCK = {
  'GET /api/dashboard/overview': {
    deviceTotal: 12, deviceOnline: 9, eventOpen: 2, eventCritical: 1,
    avgLoad: 62, workerCount: 8,
  },
  'GET /api/dashboard/events': [],
};

async function main() {
  const server = await startStaticServer();
  const baseUrl = server.baseUrl;
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });

  const consoleErrors = [];
  const pageErrors = [];
  const failedRequests = [];
  page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text()); });
  page.on('pageerror', (e) => pageErrors.push(String(e)));
  page.on('requestfailed', (r) => failedRequests.push(`${r.url()} :: ${r.failure()?.errorText}`));
  page.on('response', (r) => { if (r.status() >= 400) failedRequests.push(`${r.status()} ${r.url()}`); });

  const report = {};

  try {
    // 登录页
    await page.goto(`${baseUrl}/login`);
    await page.waitForSelector('form', { timeout: 15000 });
    await page.waitForTimeout(500);
    report.login = await page.evaluate(() => {
      const sheets = [...document.styleSheets].map((s) => s.href || 'inline');
      const body = getComputedStyle(document.body);
      const btn = document.querySelector('button');
      const btnStyle = btn ? getComputedStyle(btn) : null;
      return {
        stylesheetCount: sheets.length,
        stylesheets: sheets,
        bodyBg: body.backgroundColor,
        bodyFont: body.fontFamily,
        bodyColor: body.color,
        btn: btnStyle ? { bg: btnStyle.backgroundColor, radius: btnStyle.borderRadius, h: btnStyle.height } : null,
        rootHtml: document.querySelector('#root')?.innerHTML.slice(0, 300) || 'EMPTY',
      };
    });
    await page.screenshot({ path: path.resolve(__dirname, '..', 'output', 'diag-login.png') });

    // 指挥中心
    const newPage = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    newPage.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text()); });
    newPage.on('pageerror', (e) => pageErrors.push(String(e)));
    newPage.on('requestfailed', (r) => failedRequests.push(`${r.url()} :: ${r.failure()?.errorText}`));
    newPage.on('response', (r) => { if (r.status() >= 400) failedRequests.push(`${r.status()} ${r.url()}`); });

    await mockApi(newPage, DASHBOARD_MOCK);
    await openSession(newPage, baseUrl, ROLES.dispatcher, '/command-center');
    try {
      await newPage.waitForSelector('h1', { timeout: 15000 });
    } catch (e) {
      report.commandCenterHtml = await newPage.evaluate(() => document.querySelector('#root')?.innerHTML.slice(0, 800) || 'EMPTY ROOT');
      throw e;
    }
    await newPage.waitForTimeout(500);
    report.commandCenter = await newPage.evaluate(() => {
      const sheets = [...document.styleSheets].map((s) => s.href || 'inline');
      const h1 = document.querySelector('h1');
      const h1Style = h1 ? getComputedStyle(h1) : null;
      return {
        stylesheetCount: sheets.length,
        h1: h1Style ? { fontSize: h1Style.fontSize, fontWeight: h1Style.fontWeight, color: h1Style.color } : null,
        bodyBg: getComputedStyle(document.body).backgroundColor,
      };
    });
    await newPage.screenshot({ path: path.resolve(__dirname, '..', 'output', 'diag-command-center.png') });
  } catch (e) {
    report.fatal = e.message;
  }

  report.consoleErrors = consoleErrors;
  report.pageErrors = pageErrors;
  report.failedRequests = failedRequests;

  console.log(JSON.stringify(report, null, 2));
  await browser.close();
  await server.close();
}

main().catch((e) => { console.error('FATAL:', e.message); process.exit(1); });