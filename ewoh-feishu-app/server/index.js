// server/index.js — 应用入口
// 初始化 DB → 挂载中间件与 /api 路由 → 启动模拟器（每秒生成遥测 + 评估规则）→ 监听端口

const path = require('path');
const express = require('express');
const cors = require('cors');

const dbm = require('./db');
const { startSimulator, stopSimulator } = require('./simulator');
const { evaluateRules } = require('./rules');
const { createApiRouter } = require('./api');
const feishu = require('./feishu');
const sync = require('./sync');
const events = require('./events');

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

// 启动时加载飞书配置 + 首次同步 3 台预置设备到多维表格 + 启动事件状态轮询（失败不阻断）
const feishuConfig = feishu.loadConfig();
if (feishuConfig) {
  console.log(`[feishu] 配置已加载，chat_id=${feishuConfig.chat_id}, base_token=${feishuConfig.base_token}`);
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
}

// 创建 Express 应用
const app = express();
app.use(cors());
app.use(express.json());

// 静态文件（前端）
app.use(express.static(path.join(__dirname, '..', 'public')));

// 挂载 /api 路由
app.use('/api', createApiRouter(db));

// 根路径健康检查
app.get('/', (req, res) => {
  res.json({ name: 'EWOH 外骨骼监督平台', status: 'running', api: '/api/status' });
});

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

// 飞书卡片按钮回调端点（挂在根 app，不在 /api 路由下）
// payload: { open_id, action: { value: { action_type, event_id } } }
app.post('/webhook/card', (req, res) => {
  try {
    const body = req.body || {};
    const openId = body.open_id || (body.operator && body.operator.open_id) || 'unknown';
    const value = (body.action && body.action.value) || {};
    const actionType = value.action_type;
    const eventId = value.event_id;

    if (!actionType || !eventId) {
      return res.json({ ok: false, error: 'missing action_type or event_id' });
    }

    const event = events.getEvent(db, eventId);
    if (!event) {
      return res.json({ ok: false, error: `event not found: ${eventId}` });
    }
    // 补充 worker_name 供卡片展示
    const dev = dbm.getDevice(db, event.device_id);
    if (dev) event.worker_name = dev.worker_name;

    const cfg = feishu.getConfig();
    const chatId = cfg && cfg.chat_id;
    const messageId = event.evidence && event.evidence.feishu_message_id;

    let label;
    if (actionType === 'acknowledge') {
      events.handleEvent(db, eventId, { handler_id: openId, action: 'acknowledge' });
      label = '已确认';
    } else if (actionType === 'resolve') {
      events.handleEvent(db, eventId, { handler_id: openId, action: 'resolve' });
      label = '已解决';
    } else if (actionType === 'escalate') {
      try {
        feishu.createApproval(event);
      } catch (e) {
        console.error('[webhook] createApproval 失败:', e.message);
      }
      events.handleEvent(db, eventId, { handler_id: openId, action: 'escalate' });
      label = '已上报（审批中）';
    } else {
      return res.json({ ok: false, error: `unknown action_type: ${actionType}` });
    }

    // 更新原卡片为"已处置"状态（best-effort，失败靠跟进消息兜底）
    try {
      const card = feishu.buildHandledCard(event, label);
      feishu.updateCardMessage(messageId, card);
    } catch (e) {
      console.error('[webhook] updateCardMessage 失败:', e.message);
    }

    // 发送跟进文本消息到群聊
    try {
      if (chatId) {
        feishu.sendFollowupMessage(
          chatId,
          `✅ 事件处置通知\n事件: ${event.title || '-'}\n设备: ${event.device_id}\n处置人: ${openId}\n结果: ${label}`
        );
      }
    } catch (e) {
      console.error('[webhook] sendFollowupMessage 失败:', e.message);
    }

    res.json({ ok: true });
  } catch (e) {
    console.error('[webhook] /webhook/card 处理异常:', e.message);
    res.status(500).json({ ok: false, error: e.message });
  }
});

// 监听端口
const PORT = process.env.PORT || 3000;
const server = app.listen(PORT, () => {
  console.log(`[EWOH] 后端服务已启动: http://localhost:${PORT}`);
  console.log(`[EWOH] API 状态: http://localhost:${PORT}/api/status`);
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
