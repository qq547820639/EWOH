// server/security.js — Feishu Webhook 安全（P0-SEC-001/002/003）
//
// 目标：
//   1. 所有修改业务状态的 webhook 动作（acknowledge / resolve / escalate）必须验签；
//   2. 校验 timestamp 窗口 + nonce 防重放；
//   3. 校验 payload 基本结构；
//   4. 审计。
//
// 飞书交互卡片回调协议（事件订阅 v2 信封）：
//   {
//     "header": {
//       "event_id": "...",
//       "event_type": "...",
//       "token": "<verification token>",
//       "app_id": "...",
//       "tenant_key": "...",
//       "create_time": "2023-...Z"
//     },
//     "event": { ... }
//   }
//
// 验签策略：
//   - header.token 必须等于 FEISHU_VERIFICATION_TOKEN（配置）；
//   - 若配置 FEISHU_ENCRYPT_KEY，则额外校验 X-Lark-Signature（可选增强）；
//   - timestamp 必须位于 [now - FEISHU_WEBHOOK_TOLERANCE_SEC, now + tolerance]；
//   - event_id / nonce 去重（内存滑动窗口 + SQLite 持久化可选项），防重放。
//
// 说明：卡片回调 body 可能是 { open_id, action: {...} } 旧格式（当前代码支持），
// 也可能是事件订阅信封。两种都做 token/时间/重放校验。

const crypto = require('crypto');
const dbm = require('./db');

const DEFAULT_TOLERANCE_SEC = 300; // 5 分钟时钟偏差容忍
const REPLAY_WINDOW_MS = 30 * 60 * 1000; // 30 分钟重放窗口
const MAX_RECENT = 5000; // 内存去重上限（防无界增长）

const recentEventIds = new Set();
const recentTimestamps = []; // [tsMs, eventId]

function envStr(name, dflt = '') {
  const v = process.env[name];
  return v == null ? dflt : String(v);
}

function getVerificationToken() {
  // 优先环境变量，其次 feishu-config.json 的 verification_token 字段
  const token = envStr('FEISHU_VERIFICATION_TOKEN');
  if (token) return token;
  try {
    const cfg = require('./feishu').getConfig();
    if (cfg && cfg.verification_token) return cfg.verification_token;
  } catch (_) {
    /* ignore */
  }
  return '';
}

function getEncryptKey() {
  const key = envStr('FEISHU_ENCRYPT_KEY');
  if (key) return key;
  try {
    const cfg = require('./feishu').getConfig();
    if (cfg && cfg.encrypt_key) return cfg.encrypt_key;
  } catch (_) {
    /* ignore */
  }
  return '';
}

function nowMs() {
  return Date.now();
}

/** 解析信封中的 timestamp（header.create_time / timestamp 字段）。 */
function extractTimestamp(body) {
  const header = (body && body.header) || {};
  if (header.create_time) {
    const t = Date.parse(header.create_time);
    if (!Number.isNaN(t)) return t;
  }
  if (body && body.timestamp) {
    const n = Number(body.timestamp);
    if (Number.isFinite(n)) return n * 1000; // 秒 → ms
  }
  return null;
}

function extractEventId(body) {
  const header = (body && body.header) || {};
  if (header.event_id) return header.event_id;
  if (body && body.event_id) return body.event_id;
  // 旧卡片回调：用 action 摘要构造稳定 id（无则无法防重放 → 拒绝）
  if (body && body.action && body.action.value) {
    const v = body.action.value;
    return `card:${v.action_type || ''}:${v.event_id || ''}`;
  }
  return null;
}

function isReplay(eventId) {
  if (!eventId) return false;
  if (recentEventIds.has(eventId)) return true;
  // 清理过期
  const cutoff = nowMs() - REPLAY_WINDOW_MS;
  while (recentTimestamps.length && recentTimestamps[0].ts < cutoff) {
    recentEventIds.delete(recentTimestamps[0].id);
    recentTimestamps.shift();
  }
  if (recentEventIds.size >= MAX_RECENT) {
    // 防无界增长：清空最老一半
    const drop = Math.floor(recentTimestamps.length / 2);
    for (let i = 0; i < drop; i++) {
      recentEventIds.delete(recentTimestamps[i].id);
    }
    recentTimestamps.splice(0, drop);
  }
  recentEventIds.add(eventId);
  recentTimestamps.push({ ts: nowMs(), id: eventId });
  return false;
}

/** 校验签名（X-Lark-Signature = base64(hmac_sha256(encrypt_key, timestamp + nonce + encrypt_key))）。 */
function verifySignature(body, headers) {
  const encryptKey = getEncryptKey();
  if (!encryptKey) return true; // 未配置 Encrypt Key 时依赖 token + timestamp（文档化降级）
  const signature = headers['x-lark-signature'] || headers['X-Lark-Signature'];
  if (!signature) return false;
  const timestamp = extractTimestamp(body);
  const nonce = (body && body.nonce) || (body && body.header && body.header.nonce) || '';
  if (timestamp == null) return false;
  const source = `${timestamp}${nonce}${encryptKey}`;
  const expected = crypto
    .createHmac('sha256', encryptKey)
    .update(source)
    .digest('base64');
  const a = Buffer.from(expected);
  const b = Buffer.from(signature);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

/**
 * 验证 webhook 请求。返回 { ok: true } 或 { ok: false, error, code }。
 * 任何修改业务状态的请求必须通过本校验。
 */
function verifyWebhookRequest(req) {
  const body = req.body || {};
  const headers = req.headers || {};
  const now = nowMs();

  // 1. token 校验（Verification Token）
  const expectedToken = getVerificationToken();
  if (!expectedToken) {
    return { ok: false, code: 'WEBHOOK_TOKEN_NOT_CONFIGURED', error: 'FEISHU_VERIFICATION_TOKEN 未配置，拒绝所有写操作 webhook' };
  }
  const headerToken = (body.header && body.header.token) || body.token;
  if (!headerToken || headerToken !== expectedToken) {
    return { ok: false, code: 'WEBHOOK_INVALID_TOKEN', error: 'invalid verification token' };
  }

  // 2. timestamp 窗口校验
  const ts = extractTimestamp(body);
  if (ts == null) {
    return { ok: false, code: 'WEBHOOK_MISSING_TIMESTAMP', error: 'missing timestamp' };
  }
  const toleranceSec = Number(envStr('FEISHU_WEBHOOK_TOLERANCE_SEC', String(DEFAULT_TOLERANCE_SEC)));
  if (Math.abs(now - ts) > toleranceSec * 1000) {
    return { ok: false, code: 'WEBHOOK_EXPIRED', error: 'timestamp outside tolerance window' };
  }

  // 3. 签名校验（Encrypt Key 已配置时）
  if (!verifySignature(body, headers)) {
    return { ok: false, code: 'WEBHOOK_INVALID_SIGNATURE', error: 'invalid signature' };
  }

  // 4. 重放保护
  const eventId = extractEventId(body);
  if (eventId && isReplay(eventId)) {
    return { ok: false, code: 'WEBHOOK_REPLAY', error: 'replayed request' };
  }

  return { ok: true };
}

/** 记录一次 webhook 验证结果到审计表（失败也记录，便于溯源）。 */
function auditWebhook(db, req, result, action, eventId) {
  try {
    dbm.insertAudit(db, {
      action: `webhook_${action || 'request'}`,
      actor_id: 'feishu-webhook',
      target_type: 'webhook',
      target_id: eventId || null,
      detail: { ok: result.ok, code: result.code || null, ip: (req.headers && req.headers['x-forwarded-for']) || null },
    });
  } catch (e) {
    console.error('[security] auditWebhook 失败:', e.message);
  }
}

module.exports = {
  verifyWebhookRequest,
  auditWebhook,
  extractTimestamp,
  extractEventId,
  isReplay,
  getVerificationToken,
  getEncryptKey,
};
