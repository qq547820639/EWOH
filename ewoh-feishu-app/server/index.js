// server/index.js — 应用入口
// 初始化 DB → 挂载中间件与 /api 路由 → 按配置启动模拟器 → 监听端口
//
// 安全（P0-SEC-001/002/003）：
//   - Webhook 写操作（acknowledge/resolve/escalate）必须验签（token + timestamp + replay）；
//   - Simulator 默认关闭（FEISHU_SIMULATOR_ENABLED=false）；NODE_ENV=production 时强制禁用，
//     除非同时设置 ALLOW_SIMULATOR_IN_PRODUCTION=true；
//   - CORS 使用显式 allowlist（FEISHU_CORS_ORIGINS），禁止 wildcard + credentials。

const path = require('path');
const express = require('express');

const dbm = require('./db');
const { startSimulator, stopSimulator } = require('./simulator');
const { evaluateRules } = require('./rules');
const { createApiRouter } = require('./api');
const { apiAuth } = require('./auth');
const middleware = require('./middleware');
const { createWebhookCardHandler } = require('./webhook');
const feishu = require('./feishu');
const sync = require('./sync');
const health = require('./health');

// 初始化数据库（建表 + 预置设备/规则）
const db = dbm.initDatabase();

// 全量同步定时器（30s 一次），退出时 clearInterval
const SYNC_ALL_INTERVAL_MS = 30000;
let syncAllTimer = null;

function runSyncAllToFeishu() {
  Promise.resolve(sync.syncAllToFeishu(db)).catch((e) =>
    console.error('[sync] syncAllToFeishu 异常:', e.message)
  );
}

// 飞书集成初始化（v1.1.0 加固：延迟到 HTTP 服务启动后执行，避免 lark-cli 调用阻塞 listen）
// P1-2（2026-08-09）：larkCli 已异步化（execFile + 并发上限 + 熔断），不再同步阻塞事件循环；
// 仍保持"先起服务、再后台初始化集成"，保证 API 始终可用（集成失败仅降级，不影响平台本体）。
function initFeishuIntegration() {
  // 启动时加载飞书配置 + 首次同步 3 台预置设备到多维表格 + 启动事件状态轮询（失败不阻断）
  const feishuConfig = feishu.loadConfig();
  if (feishuConfig) {
    health.setFeishuState({ configured: true, initError: null });
    console.log(`[feishu] 配置已加载，chat_id=${feishuConfig.chat_id}（base_token 已加载，不打印敏感值）`);
    for (const dev of dbm.listDevices(db)) {
      Promise.resolve(sync.syncDevice(dev)).catch((e) =>
        console.error('[feishu] 首次设备同步失败:', e.message)
      );
    }
    // 启动飞书侧事件状态变更轮询（每 60s 拉取 handled/closed 记录回写本地）
    try {
      sync.startEventStatusPolling(db);
    } catch (e) {
      console.error('[feishu] 启动事件状态轮询失败:', e.message);
    }
    // 全量数据定时同步：启动时立即跑一次，之后每 30s 跑一次
    runSyncAllToFeishu();
    syncAllTimer = setInterval(runSyncAllToFeishu, SYNC_ALL_INTERVAL_MS);
    if (syncAllTimer.unref) syncAllTimer.unref();
    console.log(`[sync] 全量同步定时器已启动，间隔 ${SYNC_ALL_INTERVAL_MS}ms`);
  } else {
    console.warn('[feishu] 未加载到配置，飞书集成将降级（仅 console.error，不阻断）');
    health.setFeishuState({ configured: false, initError: 'feishu-config.json 未加载' });
  }
}

// 创建 Express 应用
// FS-007/013/014/001：安全头 + x-powered-by 禁用 + trust proxy + CORS 头补齐 +
// rawBody 捕获统一收敛到 middleware.configureApp（与集成测试共用同一装配）
const app = express();
middleware.configureApp(app);

// 静态文件（前端）
app.use(express.static(path.join(__dirname, '..', 'public')));

// 挂载 /api 路由（v1.1.0 D1：统一鉴权中间件，写操作 fail-closed；FS-010 限流）
app.use('/api', apiAuth, createApiRouter(db));

// 根路径健康检查
app.get('/', (req, res) => {
  res.json({ name: 'EWOH 外骨骼监督平台', status: 'running', api: '/api/status' });
});

// 健康检查（Task 16.1）：
//   - /health/live  恒 200（进程存活探针）
//   - /health/ready 本地 API + 飞书集成均可用 → 200；否则 503
// 探针免鉴权；不改变 / 与 /api/status 既有行为
health.registerHealthRoutes(app);

// ---- 模拟器（P0-SEC-002）：默认关闭（实现移至 middleware.js，FS-018 供测试直测） ----
if (middleware.simulatorEnabled()) {
  // 启动模拟器：每帧生成遥测后立即评估规则，触发的事件写入 events 表
  startSimulator(db, (frame) => {
    try {
      // 遥测帧入缓冲区（5s 批量同步到多维表格，不每帧调 lark-cli）
      sync.syncTelemetry(frame);
      const newEvents = evaluateRules(db, frame);
      if (newEvents.length > 0) {
        for (const ev of newEvents) {
          console.log(`[rules] 触发事件 ${ev.event_code} [${ev.event_type}] 设备=${ev.device_id} event_id=${ev.event_id}`);
        }
      }
    } catch (e) {
      console.error('[rules] 评估出错:', e.message);
    }
  });
} else {
  console.log('[simulator] 模拟器未启用（FEISHU_SIMULATOR_ENABLED 未开启）');
}

// 飞书卡片按钮回调端点（挂在根 app，不在 /api 路由下）
// payload 仅支持事件订阅信封 { header: { token, event_id, create_time }, event: {...} }
// L1 对齐：旧格式 { open_id, action: {...} } 已不再支持——写操作必须通过验签
//（token/timestamp/签名/重放四道校验），旧格式缺少 header.token 必然 401，
// 不提供无验签的旧格式兼容路径（P0-SEC-001 安全边界）。
// FS-009：handler 实现收敛到 server/webhook.js（含 FS-004/005/010/011 修复），
// 生产入口与集成测试共用同一实现，消除测试副本漂移。
app.post('/webhook/card', createWebhookCardHandler(db));

// FS-007：自定义错误中间件（兜底未知异常，对外通用文案，详情仅日志）
app.use(middleware.errorHandler);

// 监听端口（先启动 HTTP，飞书集成延迟到 setImmediate 执行，不阻塞服务可用性）
const PORT = process.env.PORT || 3000;
const server = app.listen(PORT, () => {
  console.log(`[EWOH] 后端服务已启动: http://localhost:${PORT}`);
  console.log(`[EWOH] API 状态: http://localhost:${PORT}/api/status`);
  // v1.1.0：HTTP 就绪后再初始化飞书集成（lark-cli 同步调用不阻塞 listen）
  setImmediate(initFeishuIntegration);
});

// 优雅退出：停止模拟器 → 停止轮询 → flush 遥测缓冲 → 关闭 HTTP → 关闭 DB
async function shutdown(signal) {
  console.log(`\n[EWOH] 收到 ${signal}，正在关闭...`);
  stopSimulator();
  // 停止全量同步定时器
  if (syncAllTimer) {
    clearInterval(syncAllTimer);
    syncAllTimer = null;
    console.log('[sync] 全量同步定时器已停止');
  }
  // 停止飞书侧事件状态轮询定时器
  try {
    sync.stopEventStatusPolling();
  } catch (e) {
    console.error('[sync] stopEventStatusPolling 失败:', e.message);
  }
  // flush 遥测缓冲到飞书多维表格（失败不阻断退出）
  try {
    await sync.flushTelemetry();
  } catch (e) {
    console.error('[sync] flushTelemetry 失败:', e.message);
  }
  // P2-10：等待在途 lark-cli 子进程排空（有界 2s），避免退出时打断进行中的飞书调用；
  // 超时未排空则由下方 1.5s 兜底强制退出。
  try {
    await feishu.waitForCliIdle(2000);
  } catch (e) {
    console.error('[feishu] 等待 lark-cli 排空异常:', e.message);
  }
  server.close(() => {
    try {
      db.close();
    } catch (e) {
      // 忽略关闭异常
    }
    console.log('[EWOH] 已关闭，再见。');
    process.exit(0);
  });
  // 兜底：1.5s 后强制退出
  setTimeout(() => process.exit(0), 1500).unref();
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

module.exports = { app, server, db };
