// server/webhook.js — /webhook/card 卡片回调处理器（FS-009：生产入口与测试共用单一实现）
//
// 从 index.js 原位抽取为工厂 createWebhookCardHandler(db)，消除测试中的
// 复制版 handler 漂移（原 test/integration.test.js 内联副本缺 createApproval /
// markReplayHandled / updateCard 等行为）。
//
// 本版本同时落实：
//   - FS-004：event not-found 分支回滚 webhook_dedup 记录（否则合法重试被误判 duplicated）；
//   - FS-005：重放标记统一使用 header.event_id（verifyWebhookRequest 返回值），
//     不再使用业务 value.event_id（两键不同源会使内存重放保护失效）；
//   - FS-010：验签失败计入限流（IP+token 失败计数），成功清除；
//   - FS-011：兜底 500 不回传 e.message，对外通用文案，详情仅日志。
//
// payload 仅支持事件订阅信封 { header: { token, event_id, create_time }, event: {...} }
// L1 对齐：旧格式 { open_id, action: {...} } 已不再支持——写操作必须通过验签
//（token/timestamp/签名/重放四道校验），旧格式缺少 header.token 必然 401，
// 不提供无验签的旧格式兼容路径（P0-SEC-001 安全边界）。

const dbm = require('./db');
const events = require('./events');
const feishu = require('./feishu');
const security = require('./security');
const ratelimit = require('./ratelimit');

function createWebhookCardHandler(db) {
  return async (req, res) => {
    const body = req.body || {};
    const value = (body.action && body.action.value) || {};
    const actionType = value.action_type;
    // 业务事件 ID（处置目标）：卡片 value 优先，回退信封 header
    const eventId = value.event_id || (body.header && body.header.event_id);

    // FS-010：先查限流（同 IP+token 组合失败达阈值 → 429）
    const rlKey = ratelimit.key('webhook', req.ip, (body.header && body.header.token) || body.token || '');
    if (ratelimit.isBlocked(rlKey)) {
      return res.status(429).json({ ok: false, error: 'too many failed attempts, retry later' });
    }

    // P0-SEC-001：验签（token + timestamp + 签名 + 重放保护）——写操作必须通过
    const result = security.verifyWebhookRequest(req);
    if (!result.ok) {
      ratelimit.recordFailure(rlKey);
      // FS-005：审计与日志统一用 header.event_id（result.eventId 与 extractEventId 同源）
      security.auditWebhook(db, req, result, actionType, result.eventId || eventId);
      return res.status(401).json({ ok: false, error: result.error, code: result.code });
    }
    ratelimit.recordSuccess(rlKey);
    // 重放保护键（FS-005）：必须用 header.event_id，与验签侧 extractEventId 一致
    const replayEventId = result.eventId;
    security.auditWebhook(db, req, { ok: true }, actionType, replayEventId);

    try {
      if (!actionType || !eventId) {
        return res.json({ ok: false, error: 'missing action_type or event_id' });
      }

      // v1.1.0 D3：业务幂等 —— 同一事件同一处置动作只执行一次。
      // 飞书卡片回调对同一事件可能重复推送（不同 event_id 的卡片回调、网络重试等），
      // 幂等键 (event_id, action_type) 由 webhook_dedup 表唯一约束保证。
      const dedup = dbm.tryAcquireWebhookDedup(db, {
        event_id: eventId,
        action_type: actionType,
        actor_id: body.open_id || (body.operator && body.operator.open_id) || 'unknown',
        result: { status: 'processing' },
      });
      if (dedup.error) {
        return res.json({ ok: false, error: dedup.error });
      }
      if (dedup.duplicated) {
        // 已处理过：返回幂等命中（200），不重复执行处置动作
        return res.json({ ok: true, duplicated: true, event_id: eventId, action: actionType });
      }

      const event = events.getEvent(db, eventId);
      if (!event) {
        // FS-004：not-found 时回滚 dedup 记录，允许后续带正确数据的重试
        dbm.deleteWebhookDedup(db, eventId, actionType);
        return res.json({ ok: false, error: `event not found: ${eventId}` });
      }
      // 补充 worker_name 供卡片展示
      const dev = dbm.getDevice(db, event.device_id);
      if (dev) event.worker_name = dev.worker_name;

      const cfg = feishu.getConfig();
      const chatId = cfg && cfg.chat_id;
      const messageId = event.evidence && event.evidence.feishu_message_id;
      const openId = body.open_id || (body.operator && body.operator.open_id) || 'unknown';

      let label;
      try {
        if (actionType === 'acknowledge') {
          events.handleEvent(db, eventId, { handler_id: openId, action: 'acknowledge' });
          label = '已确认';
        } else if (actionType === 'resolve') {
          events.handleEvent(db, eventId, { handler_id: openId, action: 'resolve' });
          label = '已解决';
        } else if (actionType === 'escalate') {
          try {
            await feishu.createApproval(event);
          } catch (e) {
            console.error('[webhook] createApproval 失败:', e.message);
          }
          events.handleEvent(db, eventId, { handler_id: openId, action: 'escalate' });
          label = '已上报（审批中）';
        } else {
          dbm.deleteWebhookDedup(db, eventId, actionType);
          return res.status(400).json({ ok: false, error: `unknown action_type: ${actionType}` });
        }
      } catch (e) {
        // 处置失败：删除幂等记录，允许重试（否则会永久拦截）
        dbm.deleteWebhookDedup(db, eventId, actionType);
        const isClosedViolation = String(e.message || '').includes('already closed');
        // 业务校验错误（events.js 自产文案）按原样返回供调用方纠错；非业务异常走 400 兜底
        return res.status(isClosedViolation ? 409 : 400).json({ ok: false, error: e.message });
      }

      // 处置成功：更新幂等记录结果（审计/溯源）
      dbm.updateWebhookDedupResult(db, eventId, actionType, { status: 'done', label, at: new Date().toISOString() });

      // 更新原卡片为"已处置"状态（best-effort，失败靠跟进消息兜底）
      try {
        const card = feishu.buildHandledCard(event, label);
        await feishu.updateCardMessage(messageId, card);
      } catch (e) {
        console.error('[webhook] updateCardMessage 失败:', e.message);
      }

      // 发送跟进文本消息到群聊
      try {
        if (chatId) {
          await feishu.sendFollowupMessage(
            chatId,
            `✅ 事件处置通知\n事件: ${event.title || '-'}\n设备: ${event.device_id}\n处置人: ${openId}\n结果: ${label}`
          );
        }
      } catch (e) {
        console.error('[webhook] sendFollowupMessage 失败:', e.message);
      }

      // v1.1.1：业务处置成功后标记重放已处理（失败时允许合法重试，不被 401 拦截）
      // FS-005：统一使用 header.event_id
      security.markReplayHandled(replayEventId);

      res.json({ ok: true });
    } catch (e) {
      // 兜底：未知异常不记录 dedup（下次可重试），仅记录错误
      // FS-011：对外通用文案，详情仅日志（不泄露内部异常细节）
      console.error('[webhook] /webhook/card 处理异常:', e && e.stack ? e.stack : e);
      res.status(500).json({ ok: false, error: 'internal server error' });
    }
  };
}

module.exports = { createWebhookCardHandler };
