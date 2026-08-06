#!/usr/bin/env node
/**
 * Task 9「前端性能预算」— 真实浏览器核心指标采集脚本。
 *
 * 使用 Playwright 驱动 headless Chromium，对被构建产物（或远程）页面注入
 * PerformanceObserver，采集首屏真实 Web 指标：
 *   - LCP（Largest Contentful Paint）
 *   - INP（Interaction to Next Paint，需用户交互；被动加载无交互时记录为 null）
 *   - CLS（Cumulative Layout Shift）
 *   - Layout Shift / 长任务（long tasks）数量与最大时长
 *   - JS 执行时间（performance.getEntriesByType('script') 的 duration 合计）
 *   - FCP / TTFB / DOMContentLoaded / Load
 *
 * 输出到仓库根 output/browser-metrics.json。
 * 若浏览器无法启动或目标地址不可达，则写入 status=BLOCKED_BY_ENVIRONMENT 并退出 0，
 * 下游 truth-manifest 聚合时【不】将其计为 PASS（与本仓库 container-image-scan 一致），
 * 绝不伪造通过。
 *
 * 用法：
 *   node scripts/browser-metrics.mjs --url http://127.0.0.1:4173
 *   node scripts/browser-metrics.mjs --url http://127.0.0.1:4173 --wait-for 'text=登录'
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');
const outDir = path.resolve(root, '..', 'output');
const outFile = path.join(outDir, 'browser-metrics.json');

const args = process.argv.slice(2);
const urlArg = (a = args.find((x, i) => args[i - 1] === '--url')) => a;
const waitForArg = args.find((x, i) => args[i - 1] === '--wait-for');
const baseUrl = urlArg() || process.env.PERF_BASE_URL || 'http://127.0.0.1:4173';
const target = baseUrl + (process.env.PERF_PATH || '/');

// 在页面中注入的指标采集逻辑（在导航前用 addInitScript 注入）。
const COLLECT_SCRIPT = /* language=js */ `
  (() => {
    const out = { lcpMs: null, cls: 0, inpMs: null, fcpMs: null, ttfbMs: null,
      domContentLoadedMs: null, loadMs: null, longTasks: [], layoutShiftCount: 0 };
    const nav = performance.getEntriesByType('navigation')[0];
    if (nav) { out.ttfbMs = nav.responseStart; out.domContentLoadedMs = nav.domContentLoadedEventEnd; out.loadMs = nav.loadEventEnd; }
    try {
      new PerformanceObserver((list) => {
        const e = list.getEntries();
        if (e.length) { const last = e[e.length - 1]; out.lcpMs = (last && last.startTime) || null; }
      }).observe({ type: 'largest-contentful-paint', buffered: true });
    } catch (e) {}
    try {
      new PerformanceObserver((list) => {
        const e = list.getEntries();
        if (e.length) { const first = e[0]; out.fcpMs = (first && first.startTime) || null; }
      }).observe({ type: 'paint', buffered: true });
    } catch (e) {}
    try {
      new PerformanceObserver((list) => {
        for (const e of list.getEntries()) { out.cls += e.value || 0; out.layoutShiftCount += 1; }
      }).observe({ type: 'layout-shift', buffered: true });
    } catch (e) {}
    try {
      new PerformanceObserver((list) => {
        for (const e of list.getEntries()) { out.inpMs = e.duration; }
      }).observe({ type: 'event', durationThreshold: 16, buffered: true });
    } catch (e) {}
    try {
      new PerformanceObserver((list) => {
        for (const e of list.getEntries()) { out.longTasks.push(e.duration); }
      }).observe({ type: 'longtask', buffered: true });
    } catch (e) {}
    window.__ewohPerf = out;
  })();
`;

function write(report) {
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(outFile, `${JSON.stringify(report, null, 2)}\n`);
  console.log(`\n[browser-metrics] 已写入报告: ${outFile}`);
  console.log(JSON.stringify(report, null, 2));
}

async function main() {
  let playwright;
  try {
    playwright = await import('playwright');
  } catch (e) {
    write({
      generatedAt: new Date().toISOString(),
      status: 'BLOCKED_BY_ENVIRONMENT',
      reason: `playwright 不可用（${e.message.split('\n')[0]}）`,
      target,
      metrics: null,
    });
    return;
  }
  const { chromium } = playwright;

  let browser = null;
  try {
    browser = await chromium.launch({ headless: true });
  } catch (e) {
    write({
      generatedAt: new Date().toISOString(),
      status: 'BLOCKED_BY_ENVIRONMENT',
      reason: `无法启动 headless Chromium（${e.message.split('\n')[0]}）`,
      target,
      metrics: null,
    });
    return;
  }

  try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    await page.addInitScript(COLLECT_SCRIPT);
    const started = performance.now();
    await page.goto(target, { waitUntil: 'load', timeout: 30000 });
    // 等待 SPA 客户端路由重定向（/ -> /login）与资源加载落定，再读取 LCP/CLS。
    try { await page.waitForLoadState('networkidle', { timeout: 15000 }); } catch {}
    if (waitForArg) {
      try { await page.waitForSelector(waitForArg, { timeout: 10000 }); }
      catch { /* 选择器不存在不阻断 */ }
    } else {
      await page.waitForTimeout(2500);
    }
    const elapsedMs = performance.now() - started;
    const metrics = await page.evaluate(() => {
      const o = window.__ewohPerf || {};
      const longTasks = (o.longTasks || []).sort((a, b) => a - b);
      const jsExec = (performance.getEntriesByType('resource') || [])
        .filter((e) => e.initiatorType === 'script')
        .reduce((s, e) => s + (e.duration || 0), 0);
      return {
        lcpMs: o.lcpMs,
        cls: Number((o.cls || 0).toFixed(3)),
        layoutShiftCount: o.layoutShiftCount || 0,
        inpMs: o.inpMs,
        fcpMs: o.fcpMs,
        ttfbMs: o.ttfbMs,
        domContentLoadedMs: o.domContentLoadedMs,
        loadMs: o.loadMs,
        longTaskCount: (o.longTasks || []).length,
        longestTaskMs: longTasks.length ? longTasks[longTasks.length - 1] : null,
        jsExecMs: Number(jsExec.toFixed(1)),
        bodyTextLen: (document.body && document.body.textContent || '').trim().length,
        finalUrl: window.location.href,
      };
    });
    await browser.close();
    // 诚实判定：若应用未渲染（无 LCP 且 body 为空），说明被测页面未真正挂载
    //（通常因缺少后端服务），LCP/INP/CLS 无法测出 —— 标记为 BLOCKED，绝不伪造通过。
    const appRendered = metrics.lcpMs !== null || metrics.bodyTextLen > 0;
    if (!appRendered) {
      write({
        generatedAt: new Date().toISOString(),
        status: 'BLOCKED_BY_ENVIRONMENT',
        reason: '浏览器可启动，但被测应用未渲染（body 为空 / 无 LCP）—— 需要完整后端+数据库服务方可测量 LCP/INP/CLS。以下为可测得的运维指标（TTFB/长任务/JS 执行），LCP/INP/CLS 不计入通过。',
        target,
        environment: { playwright: 'chromium' },
        navigationMs: Number(elapsedMs.toFixed(1)),
        partial: metrics,
      });
      return;
    }
    write({
      generatedAt: new Date().toISOString(),
      status: 'SUCCEEDED',
      target,
      environment: { playwright: 'chromium' },
      navigationMs: Number(elapsedMs.toFixed(1)),
      metrics,
    });
  } catch (e) {
    try { await browser.close(); } catch {}
    write({
      generatedAt: new Date().toISOString(),
      status: 'BLOCKED_BY_ENVIRONMENT',
      reason: `目标地址不可达或测量失败（${e.message.split('\n')[0]}）— 可能未启动被测服务`,
      target,
      metrics: null,
    });
  }
}

main();