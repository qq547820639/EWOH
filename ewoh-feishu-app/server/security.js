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
// 验签策略（FS-001/002/003 修复后）：
//   - header.token 必须等于 FEISHU_VERIFICATION_TOKEN（配置），
//     常量时间比较 crypto.timingSafeEqual（FS-003）；
//   - FEISHU_ENCRYPT_KEY 未配置时 fail-closed 直接拒绝并记录日志（FS-002，
//     此前"未配置即放行"的降级路径已移除）；
//   - 签名算法对照飞书开放平台事件订阅协议（URL 验证与事件推送同一规则）：
//       X-Lark-Signature = hex( SHA256( timestamp + nonce + encrypt_key + body ) )
//     其中 timestamp / nonce 取自请求头 X-Lark-Request-Timestamp /
//     X-Lark-Request-Nonce 的原文，body 为**原始请求体字符串**（raw body），
//     参与拼接的是请求体字节本身而非解析后的对象（FS-001：纳入 raw body）。
//     签名以 hex 小写比较，使用 timingSafeEqual。
//     （实现依据：飞书开放平台《事件订阅》文档公开的签名校验规则；本仓库
//     测试环境无法访问真实飞书文档，按公开常识实现并在此标注依据。）
//   - timestamp 必须位于 [now - FEISHU_WEBHOOK_TOLERANCE_SEC, now + tolerance]；
//   - event_id / nonce 去重（内存滑动窗口），防重放。
//
// 说明：卡片回调 body 可能是 { open_id, action: {...} } 旧格式（当前代码支持），
// 也可能是事件订阅信封。两种都做 token/时间/签名/重放校验。

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

// 常量时间字符串比较（长度不同直接 false，不泄露长度信息）
function safeEqualStr(a, b) {
  const ba = Buffer.from(String(a), 'utf8');
  const bb = Buffer.from(String(b), 'utf8');
  if (ba.length !== bb.length) return false;
  return crypto.timingSafeEqual(ba, bb);
}

/** 解析信封中的 timestamp（header.create_time / timestamp 字段），返回 ms。 */
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

/** 请求时间戳（ms）：优先 X-Lark-Request-Timestamp 请求头（飞书推送标准头，
 * 秒/毫秒自适应），回退 body 内 create_time / timestamp 字段。 */
function extractRequestTimestampMs(body, headers) {
  const ht = headers && headers['x-lark-request-timestamp'];
  if (ht != null && String(ht).trim() !== '') {
    const n = Number(ht);
    if (Number.isFinite(n) && n > 0) {
      return n > 1e12 ? n : n * 1000; // 13 位按毫秒，其余按秒
    }
    return null;
  }
  return extractTimestamp(body);
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
  return recentEventIds.has(eventId);
}

/** 记录已成功处理的事件 id（重放窗口内防重放）。
 * v1.1.1 修复：仅业务处理成功后标记。此前"验证通过即标记"会导致
 * 业务失败（unknown action / already closed / not found）后 30 分钟内的
 * 合法重试被 WEBHOOK_REPLAY 401 拦截（应返回业务幂等结果而非 401）。
 * FS-005：调用方必须传 header.event_id（与 extractEventId 同源），
 * 不得传业务 value.event_id（两键不一致会使内存重放保护失效）。 */
function markReplayHandled(eventId) {
  if (!eventId) return;
  // 清理过期（保持窗口有界）
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
}

/** 校验签名（FS-001：飞书事件订阅协议）。
 * X-Lark-Signature = hex( sha256( X-Lark-Request-Timestamp + X-Lark-Request-Nonce
 *                                  + encrypt_key + rawBody ) )
 * - timestamp / nonce 用请求头原文参与拼接（不猜测秒/毫秒，按飞书推送原样）；
 * - rawBody 为原始请求体字符串（由 express.json verify 钩子挂到 req.rawBody）；
 * - hex 小写、timingSafeEqual 比较。 */
function verifySignature(rawBody, headers) {
  const encryptKey = getEncryptKey();
  if (!encryptKey) return false; // fail-closed 由调用方先行拦截，双保险
  const signature = headers['x-lark-signature'];
  if (!signature || typeof signature !== 'string') return false;
  const timestamp = headers['x-lark-request-timestamp'];
  const nonce = headers['x-lark-request-nonce'];
  if (timestamp == null || nonce == null || rawBody == null) return false;
  const source = `${timestamp}${nonce}${encryptKey}${rawBody}`;
  const expected = crypto.createHash('sha256').update(source, 'utf8').digest('hex');
  return safeEqualStr(expected, String(signature).trim().toLowerCase());
}

/**
 * 验证 webhook 请求。返回 { ok: true } 或 { ok: false, error, code }。
 * 任何修改业务状态的请求必须通过本校验。
 */
function verifyWebhookRequest(req) {
  const body = (req && req.body) || {};
  const headers = (req && req.headers) || {};
  const now = nowMs();

  // 1. token 校验（Verification Token，FS-003：常量时间比较）
  const expectedToken = getVerificationToken();
  if (!expectedToken) {
    return { ok: false, code: 'WEBHOOK_TOKEN_NOT_CONFIGURED', error: 'FEISHU_VERIFICATION_TOKEN 未配置，拒绝所有写操作 webhook' };
  }
  const headerToken = (body.header && body.header.token) || body.token;
  if (!headerToken || !safeEqualStr(headerToken, expectedToken)) {
    return { ok: false, code: 'WEBHOOK_INVALID_TOKEN', error: 'invalid verification token' };
  }

  // 2. Encrypt Key fail-closed（FS-002：未配置即拒绝，不再降级放行）
  const encryptKey = getEncryptKey();
  if (!encryptKey) {
    console.error('[security] FEISHU_ENCRYPT_KEY 未配置：按 fail-closed 拒绝 webhook（FS-002），请配置后重试');
    return { ok: false, code: 'WEBHOOK_ENCRYPT_KEY_NOT_CONFIGURED', error: 'FEISHU_ENCRYPT_KEY not configured (fail-closed)' };
  }

  // 3. timestamp 窗口校验（请求头 X-Lark-Request-Timestamp 优先）
  const ts = extractRequestTimestampMs(body, headers);
  if (ts == null) {
    return { ok: false, code: 'WEBHOOK_MISSING_TIMESTAMP', error: 'missing timestamp' };
  }
  const toleranceSec = Number(envStr('FEISHU_WEBHOOK_TOLERANCE_SEC', String(DEFAULT_TOLERANCE_SEC)));
  if (Math.abs(now - ts) > toleranceSec * 1000) {
    return { ok: false, code: 'WEBHOOK_EXPIRED', error: 'timestamp outside tolerance window' };
  }

  // 4. 签名校验（FS-001：sha256(ts + nonce + key + rawBody)，raw body 参与）
  if (!verifySignature(req && req.rawBody, headers)) {
    return { ok: false, code: 'WEBHOOK_INVALID_SIGNATURE', error: 'invalid signature' };
  }

  // 5. 重放保护（只检查不标记：标记延迟到业务成功后，避免失败重试被 401 拦截）
  const eventId = extractEventId(body);
  if (eventId && isReplay(eventId)) {
    return { ok: false, code: 'WEBHOOK_REPLAY', error: 'replayed request' };
  }

  return { ok: true, eventId };
}

/** 记录一次 webhook 验证结果到审计表（失败也记录，便于溯源）。
 * FS-013：客户端 IP 取 req.ip（需在 Express 配置 trust proxy 后由框架
 * 解析 X-Forwarded-For；不再直接读取可伪造的原始 header）。 */
function auditWebhook(db, req, result, action, eventId) {
  try {
    dbm.insertAudit(db, {
      action: `webhook_${action || 'request'}`,
      actor_id: 'feishu-webhook',
      target_type: 'webhook',
      target_id: eventId || null,
      detail: { ok: result.ok, code: result.code || null, ip: (req && req.ip) || null },
    });
  } catch (e) {
    console.error('[security] auditWebhook 失败:', e.message);
  }
}

module.exports = {
  verifyWebhookRequest,
  auditWebhook,
  extractTimestamp,
  extractRequestTimestampMs,
  extractEventId,
  isReplay,
  markReplayHandled,
  getVerificationToken,
  getEncryptKey,
  safeEqualStr,
};
