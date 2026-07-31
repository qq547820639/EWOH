// server/api.js — Express 路由
// 暴露 /api 下全部 REST 端点，统一响应格式 {data, total} / {error:{code,message}}

const express = require('express');
const dbm = require('./db');
const events = require('./events');
const feishu = require('./feishu');

// 解析遥测行的 gyro_dps JSON
function parseTelemetryRow(row) {
  if (!row) return row;
  return { ...row, gyro_dps: dbm.safeParse(row.gyro_dps) };
}

// 解析分页参数
function parsePaging(query) {
  let limit = parseInt(query.limit, 10);
  let offset = parseInt(query.offset, 10);
  if (!Number.isFinite(limit) || limit < 0) limit = 100;
  if (!Number.isFinite(offset) || offset < 0) offset = 0;
  if (limit > 1000) limit = 1000;
  return { limit, offset };
}

// 统一成功响应
function ok(res, data, total) {
  const body = { data };
  if (total !== undefined) body.total = total;
  res.json(body);
}

// 统一错误响应
function fail(res, status, code, message) {
  res.status(status).json({ error: { code, message } });
}

// 包装异步/同步 handler，统一捕获异常
function wrap(fn) {
  return (req, res) => {
    try {
      const result = fn(req, res);
      if (result && typeof result.catch === 'function') {
        result.catch((e) => {
          console.error('[api] handler error:', e);
          fail(res, 500, 'INTERNAL', e.message || '内部错误');
        });
      }
    } catch (e) {
      console.error('[api] handler error:', e);
      fail(res, 500, 'INTERNAL', e.message || '内部错误');
    }
  };
}

// 创建并返回挂载到 /api 的 Router
function createApiRouter(db) {
  const router = express.Router();

  // -------- 系统状态 --------
  router.get('/status', wrap((req, res) => {
    const stats = dbm.getSystemStats(db);
    // 事件按 event_code 分组统计
    const byCode = db.prepare(
      'SELECT event_code, COUNT(*) AS c FROM events GROUP BY event_code'
    ).all();
    const deviceStats = db.prepare(
      'SELECT device_id, COUNT(*) AS open_events FROM events WHERE status = ? GROUP BY device_id'
    ).all('open');
    ok(res, {
      ...stats,
      events_by_code: byCode.reduce((m, r) => { m[r.event_code] = r.c; return m; }, {}),
      open_events_by_device: deviceStats.reduce((m, r) => { m[r.device_id] = r.open_events; return m; }, {}),
      server_time: new Date().toISOString(),
    });
  }));

  // -------- 设备列表 --------
  router.get('/devices', wrap((req, res) => {
    const rows = dbm.listDevices(db).map((d) => ({ ...d, online: !!d.online }));
    ok(res, rows, rows.length);
  }));

  // -------- 单设备详情 --------
  router.get('/devices/:device_id', wrap((req, res) => {
    const row = dbm.getDevice(db, req.params.device_id);
    if (!row) return fail(res, 404, 'NOT_FOUND', `设备不存在: ${req.params.device_id}`);
    ok(res, { ...row, online: !!row.online });
  }));

  // -------- 设备健康 --------
  router.get('/devices/:device_id/health', wrap((req, res) => {
    const deviceId = req.params.device_id;
    const device = dbm.getDevice(db, deviceId);
    if (!device) return fail(res, 404, 'NOT_FOUND', `设备不存在: ${deviceId}`);
    const latest = dbm.getLatestTelemetryByDevice(db, deviceId);
    const lastTelemetryAt = device.last_telemetry_at || (latest && latest.ts);
    const stale = lastTelemetryAt
      ? Date.now() - new Date(lastTelemetryAt).getTime() > 10000
      : true;
    ok(res, {
      device_id: deviceId,
      worker_name: device.worker_name,
      online: !!device.online,
      battery_pct: device.battery_pct,
      last_telemetry_at: lastTelemetryAt,
      stale, // 超过 10s 未通信视为失联
      packet_loss_pct: 0, // 模拟环境无丢包
      latest_telemetry: latest ? parseTelemetryRow(latest) : null,
    });
  }));

  // -------- 各设备最新一帧（需在 /telemetry/:device 之前注册） --------
  router.get('/telemetry/latest', wrap((req, res) => {
    const rows = dbm.getLatestTelemetryAll(db).map(parseTelemetryRow);
    ok(res, rows, rows.length);
  }));

  // -------- 遥测数据列表 --------
  router.get('/telemetry', wrap((req, res) => {
    const { limit, offset } = parsePaging(req.query);
    const deviceId = req.query.device_id;
    const rows = dbm.listTelemetry(db, { device_id: deviceId, limit, offset }).map(parseTelemetryRow);
    let total;
    if (deviceId) {
      total = db.prepare('SELECT COUNT(*) AS c FROM telemetry WHERE device_id = ?').get(deviceId).c;
    } else {
      total = db.prepare('SELECT COUNT(*) AS c FROM telemetry').get().c;
    }
    ok(res, rows, total);
  }));

  // -------- 事件列表 --------
  router.get('/events', wrap((req, res) => {
    const { limit, offset } = parsePaging(req.query);
    const { rows, total } = events.listEvents(db, {
      status: req.query.status,
      device_id: req.query.device_id,
      limit,
      offset,
    });
    ok(res, rows, total);
  }));

  // -------- 事件详情 --------
  router.get('/events/:event_id', wrap((req, res) => {
    const row = events.getEvent(db, req.params.event_id);
    if (!row) return fail(res, 404, 'NOT_FOUND', `事件不存在: ${req.params.event_id}`);
    ok(res, row);
  }));

  // -------- 事件处置 --------
  router.post('/events/:event_id/handle', wrap((req, res) => {
    const { handler_id, action, comment } = req.body || {};
    if (!action) return fail(res, 400, 'BAD_REQUEST', '缺少 action 参数');
    let row;
    try {
      row = events.handleEvent(db, req.params.event_id, { handler_id, action, comment });
    } catch (e) {
      return fail(res, 400, 'BAD_REQUEST', e.message);
    }
    if (!row) return fail(res, 404, 'NOT_FOUND', `事件不存在: ${req.params.event_id}`);
    ok(res, row);
  }));

  // -------- 规则列表 --------
  router.get('/rules', wrap((req, res) => {
    const rows = dbm.listRules(db);
    ok(res, rows, rows.length);
  }));

  // -------- 审计日志 --------
  router.get('/audit', wrap((req, res) => {
    const { limit, offset } = parsePaging(req.query);
    const action = req.query.action;
    const rows = dbm.listAudit(db, { action, limit, offset });
    const total = dbm.countAudit(db, { action });
    ok(res, rows, total);
  }));

  // -------- 飞书班次报告 --------
  router.get('/feishu/report', wrap((req, res) => {
    const stats = dbm.getSystemStats(db);
    const { rows: eventList } = events.listEvents(db, { limit: 200 });
    // 处置率
    const total = stats.events.total || 0;
    const handled = (stats.events.handled || 0) + (stats.events.closed || 0);
    const handleRate = total > 0 ? Math.round((handled / total) * 100) : 0;
    const reportStats = { ...stats, handle_rate: handleRate, generated_at: new Date().toISOString() };

    const doc = feishu.createReportDoc(reportStats, eventList);
    if (doc.error) {
      console.error('[api] 生成班次报告失败:', doc.error);
    }
    ok(res, {
      url: doc.url,
      doc_token: doc.doc_token,
      stats: reportStats,
      event_count: eventList.length,
    });
  }));

  return router;
}

module.exports = { createApiRouter };
