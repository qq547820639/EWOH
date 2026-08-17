// server/auth.js — API 统一鉴权中间件（v1.1.0 加固，设计决策 D1）
//
// 背景：v1.0 的 /api 路由（含 POST /api/events/:event_id/handle）全站无鉴权，
// 任何人可修改事件状态（走读报告 H3）。本中间件统一收敛：
//
// 规则：
//   - 写操作（POST/PUT/PATCH/DELETE）必须携带有效凭证，否则 401（fail-closed）；
//   - 读操作（GET/HEAD/OPTIONS）R2-FSH-002 起默认同样必须鉴权（fail-closed，
//     防审计日志/工人身份/健康遥测被未授权抓取）；仅
//     FEISHU_REQUIRE_AUTH_FOR_READS=false 可显式放宽为无凭证读放行，
//     放宽模式下仍施加 IP 级读限流；
//   - 凭证支持两种：Authorization: Bearer <token> 或 X-API-Key: <token>；
//   - token 来自 FEISHU_API_TOKEN 环境变量（生产必须配置）；
//     token 未配置时：读/写操作一律拒绝（fail-closed，防止"忘了配密钥就裸奔"）；
//   - 使用 timingSafeEqual 常量时间比较，防时序侧信道；
//   - FS-010：写操作（及读鉴权路径）token 校验失败计入内存限流
//     （IP+token 失败计数），达阈值后返回 429，缓解暴力枚举。
//
// 用途：在 /api 路由上挂 `app.use('/api', require('./auth').apiAuth, createApiRouter(db))`。
// webhook 端点（/webhook/card）仍走 security.verifyWebhookRequest 的飞书验签，不受本中间件影响。

const crypto = require('crypto');
const ratelimit = require('./ratelimit');

// 读取 API token（环境变量唯一来源；不读配置文件，避免密钥进 JSON 落盘）
function getApiToken() {
  const t = process.env.FEISHU_API_TOKEN;
  return t && t.trim() ? t.trim() : '';
}

// 常量时间比较（长度不同直接 false，避免泄露长度）
function safeEqual(a, b) {
  const ba = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  if (ba.length !== bb.length) return false;
  return crypto.timingSafeEqual(ba, bb);
}

// 从请求提取凭证 token；两种格式都支持
function extractToken(req) {
  const auth = req.headers['authorization'] || '';
  if (auth.startsWith('Bearer ')) {
    return auth.slice(7).trim();
  }
  const apiKey = req.headers['x-api-key'];
  if (apiKey) return String(apiKey).trim();
  return '';
}

// 判定是否为写方法
function isWriteMethod(method) {
  return method === 'POST' || method === 'PUT' || method === 'PATCH' || method === 'DELETE';
}

// R2-FSH-002：读操作鉴权默认收紧（fail-closed）。此前默认放行 GET 导致
// /api/audit（审计 detail 含客户端 IP）、/api/events/:id（工人健康关联 evidence）、
// /api/devices（工人姓名-设备映射）等 PII/运维数据可被任何触达端口的调用方
// 无限制翻页抓取。现读端点与写端点复用同一凭证机制（FEISHU_API_TOKEN +
// timingSafeEqual + recordSuccess/recordFailure 失败计数限流）。
// 仅 FEISHU_REQUIRE_AUTH_FOR_READS=false 可显式放宽（遗留演示语义），
// 放宽模式下仍对无凭证读施加 IP 级读限流（scope 'api-read'）。
// 豁免清单：无——/api 下全部端点均返回业务/PII 数据；无敏感数据的存活/就绪
// 探针位于 /health/live 与 /health/ready（挂在根 app，不经过本中间件，
// 见 server/health.js），因此本中间件不设任何读豁免路径。
function readsRelaxed() {
  return (process.env.FEISHU_REQUIRE_AUTH_FOR_READS || '').trim().toLowerCase() === 'false';
}

// 统一的凭证校验 + 限流（读写共用，R2-FSH-002 收敛重复逻辑）
function enforceToken(req, res, next, rlKey, token, provided, opLabel) {
  if (!token) {
    return res.status(503).json({
      error: {
        code: 'AUTH_NOT_CONFIGURED',
        message: `FEISHU_API_TOKEN 未配置，拒绝所有${opLabel}（fail-closed）`,
      },
    });
  }
  if (ratelimit.isBlocked(rlKey)) {
    return res.status(429).json({
      error: { code: 'RATE_LIMITED', message: 'too many failed attempts, retry later' },
    });
  }
  if (!provided || !safeEqual(provided, token)) {
    ratelimit.recordFailure(rlKey);
    return res.status(401).json({
      error: { code: 'UNAUTHORIZED', message: 'invalid or missing API token' },
    });
  }
  ratelimit.recordSuccess(rlKey);
  return next();
}

// Express 中间件：挂载于 /api 前缀之前
function apiAuth(req, res, next) {
  const token = getApiToken();
  const provided = extractToken(req);
  // FS-010：写操作（及默认收紧下的读操作）按 IP+token 失败计数限流
  const rlKey = ratelimit.key('api', req.ip, provided);

  if (isWriteMethod(req.method)) {
    // 写操作：fail-closed
    return enforceToken(req, res, next, rlKey, token, provided, '写操作');
  }

  // R2-FSH-002：读操作默认与写操作同一 fail-closed 鉴权（无豁免路径，理由见 readsRelaxed 注释）
  if (!readsRelaxed()) {
    return enforceToken(req, res, next, rlKey, token, provided, '读操作');
  }

  // 显式放宽模式（FEISHU_REQUIRE_AUTH_FOR_READS=false，遗留演示语义）：
  // 无凭证读放行，但计入 IP 级读限流（R2-FSH-002：防脚本高频抓取）；
  // 携带凭证则仍按同一校验执行（错误凭证 fail-closed 401）。
  const readKey = ratelimit.key('api-read', req.ip, provided);
  if (ratelimit.isBlocked(readKey)) {
    return res.status(429).json({
      error: { code: 'RATE_LIMITED', message: 'read rate limit exceeded, retry later' },
    });
  }
  if (provided) {
    if (token && safeEqual(provided, token)) {
      ratelimit.recordSuccess(readKey);
      return next();
    }
    ratelimit.recordFailure(readKey);
    return res.status(401).json({
      error: { code: 'UNAUTHORIZED', message: 'invalid or missing API token' },
    });
  }
  ratelimit.recordFailure(readKey); // 无凭证读访问计入读限流计数（阈值见 ratelimit.limitFor）
  return next();
}

// 供测试直接调用
apiAuth.getApiToken = getApiToken;
apiAuth.safeEqual = safeEqual;
apiAuth.extractToken = extractToken;
apiAuth.isWriteMethod = isWriteMethod;

module.exports = { apiAuth, getApiToken, safeEqual, extractToken, isWriteMethod };
