// server/auth.js — API 统一鉴权中间件（v1.1.0 加固，设计决策 D1）
//
// 背景：v1.0 的 /api 路由（含 POST /api/events/:event_id/handle）全站无鉴权，
// 任何人可修改事件状态（走读报告 H3）。本中间件统一收敛：
//
// 规则：
//   - 写操作（POST/PUT/PATCH/DELETE）必须携带有效凭证，否则 401（fail-closed）；
//   - 读操作（GET/HEAD/OPTIONS）默认放行（监督平台展示语义），
//     可通过 FEISHU_REQUIRE_AUTH_FOR_READS=true 收紧为同样必须鉴权；
//   - 凭证支持两种：Authorization: Bearer <token> 或 X-API-Key: <token>；
//   - token 来自 FEISHU_API_TOKEN 环境变量（生产必须配置）；
//     token 未配置时：写操作一律拒绝（fail-closed，防止"忘了配密钥就裸奔"），
//     读操作放行但打印一次告警日志；
//   - 使用 timingSafeEqual 常量时间比较，防时序侧信道。
//
// 用途：在 /api 路由上挂 `app.use('/api', require('./auth').apiAuth, createApiRouter(db))`。
// webhook 端点（/webhook/card）仍走 security.verifyWebhookRequest 的飞书验签，不受本中间件影响。

const crypto = require('crypto');

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

// Express 中间件：挂载于 /api 前缀之前
function apiAuth(req, res, next) {
  const token = getApiToken();
  const provided = extractToken(req);

  if (isWriteMethod(req.method)) {
    // 写操作：fail-closed
    if (!token) {
      return res.status(503).json({
        error: {
          code: 'AUTH_NOT_CONFIGURED',
          message: 'FEISHU_API_TOKEN 未配置，拒绝所有写操作（fail-closed）',
        },
      });
    }
    if (!provided || !safeEqual(provided, token)) {
      return res.status(401).json({
        error: { code: 'UNAUTHORIZED', message: 'invalid or missing API token' },
      });
    }
    return next();
  }

  // 读操作：默认放行；FEISHU_REQUIRE_AUTH_FOR_READS=true 时收紧
  const requireReads = (process.env.FEISHU_REQUIRE_AUTH_FOR_READS || '').trim().toLowerCase() === 'true';
  if (requireReads) {
    if (!token) {
      return res.status(503).json({
        error: { code: 'AUTH_NOT_CONFIGURED', message: 'FEISHU_API_TOKEN 未配置，读操作被收紧配置拒绝（fail-closed）' },
      });
    }
    if (!provided || !safeEqual(provided, token)) {
      return res.status(401).json({
        error: { code: 'UNAUTHORIZED', message: 'invalid or missing API token' },
      });
    }
  } else if (!token) {
    // 仅提示一次，避免刷屏
    if (!apiAuth._warnedNoToken) {
      apiAuth._warnedNoToken = true;
      console.warn('[auth] FEISHU_API_TOKEN 未配置：写操作已被拒绝（fail-closed），读操作放行。生产环境请务必配置。');
    }
  }

  return next();
}

// 供测试直接调用
apiAuth.getApiToken = getApiToken;
apiAuth.safeEqual = safeEqual;
apiAuth.extractToken = extractToken;
apiAuth.isWriteMethod = isWriteMethod;

module.exports = { apiAuth, getApiToken, safeEqual, extractToken, isWriteMethod };
