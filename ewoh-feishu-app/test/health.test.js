// server/health.test.js — Task 16.1 健康检查端点测试（node:test + 真实 HTTP server）
// 覆盖：
//   - GET /health/live 恒 200 {status:'live'}（进程存活探针）
//   - GET /health/ready 飞书健康（已配置 + 熔断关闭 + 最近同步成功）→ 200 {status:'ready'}
//   - GET /health/ready 飞书不可用（未配置 / 熔断打开 / 最近同步失败）→ 503 {status:'not_ready'}
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
  const cors = require('cors');
  const app = express();
  app.use(cors({ origin: ['http://localhost:3000'], methods: ['GET', 'POST', 'OPTIONS'], credentials: true }));
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
  assert.strictEqual(res.body.status, 'ready');
  assert.strictEqual(res.body.localApi, 'healthy');
  assert.strictEqual(res.body.feishu, 'healthy');
  assert.strictEqual(res.body.configured, true);
  assert.strictEqual(res.body.circuitOpen, false);
});

test('健康：/health/ready 未配置飞书 → 503 {status:not_ready, feishu:unavailable}', async (t) => {
  const dir = tmpDir(t);
  const db = dbm.initDatabase(path.join(dir, 'feishu.db'));
  const app = buildApp(db);
  const { baseUrl } = await startServer(app, t);
  t.after(() => feishu.__test.reset());

  health.__test.reset(); // configured=false
  feishu.__test.reset(); // 熔断关闭（排除熔断因素，单独验证"未配置"）
  const res = await httpJson(baseUrl, 'GET', '/health/ready');
  assert.strictEqual(res.status, 503);
  assert.strictEqual(res.body.status, 'not_ready');
  assert.strictEqual(res.body.localApi, 'healthy');
  assert.strictEqual(res.body.feishu, 'unavailable');
  assert.match(res.body.reason, /not configured/);
});

test('健康：/health/ready 熔断打开 → 503 {status:not_ready, feishu:unavailable}', async (t) => {
  const dir = tmpDir(t);
  const db = dbm.initDatabase(path.join(dir, 'feishu.db'));
  const app = buildApp(db);
  const { baseUrl } = await startServer(app, t);
  t.after(() => feishu.__test.reset());

  setFeishuHealthy();
  feishu.__test.setBreakerOpenUntil(Date.now() + 60000); // 熔断打开 60s
  const res = await httpJson(baseUrl, 'GET', '/health/ready');
  assert.strictEqual(res.status, 503);
  assert.strictEqual(res.body.status, 'not_ready');
  assert.strictEqual(res.body.localApi, 'healthy');
  assert.strictEqual(res.body.feishu, 'unavailable');
  assert.strictEqual(res.body.circuitOpen, true);
  assert.match(res.body.reason, /circuit breaker open/);
});

test('健康：/health/ready 最近同步失败 → 503 {status:not_ready, feishu:unavailable}', async (t) => {
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
  assert.strictEqual(res.body.status, 'not_ready');
  assert.strictEqual(res.body.localApi, 'healthy');
  assert.strictEqual(res.body.feishu, 'unavailable');
  assert.strictEqual(res.body.lastSyncOk, false);
  assert.match(res.body.reason, /sync failed/);
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
