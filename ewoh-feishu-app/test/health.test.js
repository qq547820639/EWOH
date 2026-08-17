// server/health.test.js — Task 16.1 健康检查端点测试（node:test + 真实 HTTP server）
// 覆盖：
//   - GET /health/live 恒 200 {status:'live'}（进程存活探针）
//   - GET /health/ready 飞书健康（已配置 + 熔断关闭 + 最近同步成功）→ 200 {status:'ready'}
//   - GET /health/ready 飞书不可用（未配置 / 熔断打开 / 最近同步失败）→ 503 {status:'not_ready'}
//   - FS-012：探针 HTTP 响应仅状态位（status + feishu），不暴露内部错误串；
//     完整诊断字段（reason/lastSyncError/circuitOpen 等）改为直接断言 readyStatus()
//     进程内返回值（增强：字段仍被验证，只是不经 HTTP 暴露）。
// 运行：node --test test/health.test.js

'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

const dbm = require('../server/db');
const health = require('../server/health');
const feishu = require('../server/feishu');

// 构造最小 Express app（复用 health.registerHealthRoutes，与 index.js 装配一致；
// 健康探针免鉴权，不挂 /api 的 apiAuth）
function buildApp(db) {
  const express = require('express');
  const app = express();
  app.use(express.json({ limit: '1mb' }));
  health.registerHealthRoutes(app);
  return app;
}

// 启动真实 HTTP server，返回 { baseUrl, close }
async function startServer(app, t) {
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  t.after(() => new Promise((resolve) => server.close(resolve)));
  return { baseUrl: `http://127.0.0.1:${port}` };
}

// JSON 请求封装
async function httpJson(baseUrl, method, urlPath) {
  const res = await fetch(`${baseUrl}${urlPath}`, { method });
  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch (_) { json = text; }
  return { status: res.status, body: json };
}

function tmpDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ewoh-health-'));
  t.after(() => {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) { /* ignore */ }
  });
  return dir;
}

// 预置飞书"健康"状态：已配置 + 熔断关闭 + 最近一次同步成功
function setFeishuHealthy() {
  health.setFeishuState({
    configured: true,
    initError: null,
    lastSyncAt: new Date().toISOString(),
    lastSyncOk: true,
    lastSyncError: null,
  });
  feishu.__test.setBreakerOpenUntil(0);
}

// FS-012：探针响应只允许携带状态位字段
function assertProbeShape(body, expectedStatus, expectedFeishu) {
  assert.strictEqual(body.status, expectedStatus);
  assert.strictEqual(body.feishu, expectedFeishu);
  assert.deepStrictEqual(
    Object.keys(body).sort(),
    ['feishu', 'status'],
    'FS-012：/health/ready 响应仅状态位，不得暴露内部诊断字段'
  );
}

test('健康：/health/live 恒 200 {status:live}', async (t) => {
  const dir = tmpDir(t);
  const db = dbm.initDatabase(path.join(dir, 'feishu.db'));
  const app = buildApp(db);
  const { baseUrl } = await startServer(app, t);

  const res = await httpJson(baseUrl, 'GET', '/health/live');
  assert.strictEqual(res.status, 200);
  assert.deepStrictEqual(res.body, { status: 'live' });
});

test('健康：/health/ready 飞书健康 → 200 {status:ready, feishu:healthy}', async (t) => {
  const dir = tmpDir(t);
  const db = dbm.initDatabase(path.join(dir, 'feishu.db'));
  const app = buildApp(db);
  const { baseUrl } = await startServer(app, t);
  t.after(() => feishu.__test.reset());

  setFeishuHealthy();
  const res = await httpJson(baseUrl, 'GET', '/health/ready');
  assert.strictEqual(res.status, 200);
  assertProbeShape(res.body, 'ready', 'healthy');
  // 诊断 detail 在进程内 readyStatus() 完整保留
  const detail = health.readyStatus();
  assert.strictEqual(detail.localApi, 'healthy');
  assert.strictEqual(detail.configured, true);
  assert.strictEqual(detail.circuitOpen, false);
});

test('健康：/health/ready 未配置飞书 → 503，响应不含内部 reason', async (t) => {
  const dir = tmpDir(t);
  const db = dbm.initDatabase(path.join(dir, 'feishu.db'));
  const app = buildApp(db);
  const { baseUrl } = await startServer(app, t);
  t.after(() => feishu.__test.reset());

  health.__test.reset(); // configured=false
  feishu.__test.reset(); // 熔断关闭（排除熔断因素，单独验证"未配置"）
  const res = await httpJson(baseUrl, 'GET', '/health/ready');
  assert.strictEqual(res.status, 503);
  assertProbeShape(res.body, 'not_ready', 'unavailable');
  // reason 仅在进程内 readyStatus() 提供，不经 HTTP 暴露
  assert.match(health.readyStatus().reason, /not configured/);
});

test('健康：/health/ready 熔断打开 → 503，响应不含内部 reason', async (t) => {
  const dir = tmpDir(t);
  const db = dbm.initDatabase(path.join(dir, 'feishu.db'));
  const app = buildApp(db);
  const { baseUrl } = await startServer(app, t);
  t.after(() => feishu.__test.reset());

  setFeishuHealthy();
  feishu.__test.setBreakerOpenUntil(Date.now() + 60000); // 熔断打开 60s
  const res = await httpJson(baseUrl, 'GET', '/health/ready');
  assert.strictEqual(res.status, 503);
  assertProbeShape(res.body, 'not_ready', 'unavailable');
  assert.strictEqual(health.readyStatus().circuitOpen, true);
  assert.match(health.readyStatus().reason, /circuit breaker open/);
});

test('健康：/health/ready 最近同步失败 → 503，响应不含 lastSyncError', async (t) => {
  const dir = tmpDir(t);
  const db = dbm.initDatabase(path.join(dir, 'feishu.db'));
  const app = buildApp(db);
  const { baseUrl } = await startServer(app, t);
  t.after(() => feishu.__test.reset());

  // 已配置 + 熔断关闭，但最近一次同步失败（如无 base_token / 查询失败）
  health.setFeishuState({
    configured: true,
    initError: null,
    lastSyncAt: new Date().toISOString(),
    lastSyncOk: false,
    lastSyncError: 'no base_token',
  });
  feishu.__test.reset();
  const res = await httpJson(baseUrl, 'GET', '/health/ready');
  assert.strictEqual(res.status, 503);
  assertProbeShape(res.body, 'not_ready', 'unavailable');
  // 错误细节仅在进程内 readyStatus()，不进探针响应
  assert.strictEqual(health.readyStatus().lastSyncOk, false);
  assert.match(health.readyStatus().reason, /sync failed/);
});

test('健康：/health/ready 最近同步成功可恢复 200（失败→成功状态迁移）', async (t) => {
  const dir = tmpDir(t);
  const db = dbm.initDatabase(path.join(dir, 'feishu.db'));
  const app = buildApp(db);
  const { baseUrl } = await startServer(app, t);
  t.after(() => feishu.__test.reset());

  // 先失败
  health.setFeishuState({
    configured: true,
    lastSyncAt: new Date().toISOString(),
    lastSyncOk: false,
    lastSyncError: 'no base_token',
  });
  feishu.__test.reset();
  const resFail = await httpJson(baseUrl, 'GET', '/health/ready');
  assert.strictEqual(resFail.status, 503);

  // 下一次同步成功（recordFeishuSync 语义）后恢复 ready
  health.recordFeishuSync(true, null);
  const resOk = await httpJson(baseUrl, 'GET', '/health/ready');
  assert.strictEqual(resOk.status, 200);
  assert.strictEqual(resOk.body.status, 'ready');
  assert.strictEqual(resOk.body.feishu, 'healthy');
});
