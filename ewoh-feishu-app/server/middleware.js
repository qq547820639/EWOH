// server/middleware.js — HTTP 装配共享层（index.js 生产入口与测试共用；FS-007/009/013/014/018）
//
// 职责（一次性收敛，供两处装配避免漂移）：
//   - resolveCorsOrigins / simulatorEnabled：导出真实实现供测试直接测（FS-018，
//     此前 security.test.js 用局部变量重演 env 判断，测不到真实函数）；
//   - configureApp：安全头（手工补齐，等价 helmet 最小集，FS-007）+
//     disable x-powered-by + trust proxy（FS-013）+ CORS（allowedHeaders 补
//     Authorization/X-API-Key，FS-014）+ JSON 解析挂 rawBody（FS-001 签名需要）；
//   - securityHeaders / errorHandler：安全头与自定义错误中间件。
//
// 说明：不引入 helmet 依赖（本应用零构建依赖链，手工补等价安全头）；
// CSP 允许 style 'unsafe-inline'（public/js/app.js 使用内联 style 属性渲染
// 电池条/图表色块，脚本均为外链同源）。

const cors = require('cors');
const express = require('express');

// P0-SEC-003：CORS 显式 allowlist。默认仅本地开发源；配置 FEISHU_CORS_ORIGINS 指定。
function resolveCorsOrigins() {
  const raw = (process.env.FEISHU_CORS_ORIGINS || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  if (raw.includes('*')) {
    throw new Error('FEISHU_CORS_ORIGINS 不得包含 *（与 credentials 冲突）');
  }
  // 默认：仅本地前端（端口 3000 由本服务自身 + 常见本地端口）
  const defaults = ['http://localhost:3000', 'http://127.0.0.1:3000'];
  const origins = raw.length > 0 ? raw : defaults;
  console.log(`[cors] 允许来源: ${origins.join(', ')}`);
  return origins;
}

// ---- 模拟器开关（P0-SEC-002）：默认关闭 ----
function simulatorEnabled() {
  const raw = (process.env.FEISHU_SIMULATOR_ENABLED || '').trim().toLowerCase();
  const enabled = raw === 'true' || raw === '1' || raw === 'yes';
  if (!enabled) return false;
  const isProd = (process.env.NODE_ENV || '').trim().toLowerCase() === 'production';
  if (isProd) {
    const allow = (process.env.ALLOW_SIMULATOR_IN_PRODUCTION || '').trim().toLowerCase();
    if (allow !== 'true' && allow !== '1') {
      console.error('[simulator] NODE_ENV=production 且未设置 ALLOW_SIMULATOR_IN_PRODUCTION=true，拒绝启动模拟器');
      return false;
    }
    console.warn('[simulator] 警告：production 环境显式允许模拟器（ALLOW_SIMULATOR_IN_PRODUCTION=true）');
  }
  return true;
}

// 安全响应头（FS-007：手工补齐 helmet 最小集）
function securityHeaders(req, res, next) {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Content-Security-Policy',
    "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'");
  next();
}

// 统一装配（生产 index.js 与集成测试共用同一套中间件，防止装配漂移）
function configureApp(app) {
  // FS-007：隐藏框架指纹
  app.disable('x-powered-by');

  // FS-013：仅在显式配置 FEISHU_TRUST_PROXY 时信任代理头，
  // 之后 req.ip 由 Express 解析 X-Forwarded-For（左值不可伪造前缀）。
  const tp = (process.env.FEISHU_TRUST_PROXY || '').trim();
  if (tp === 'true' || tp === '1') {
    app.set('trust proxy', 1);
    console.log('[http] trust proxy 已启用（FEISHU_TRUST_PROXY），req.ip 取 X-Forwarded-For 最右侧可信值');
  } else if (/^\d+$/.test(tp)) {
    app.set('trust proxy', parseInt(tp, 10));
    console.log(`[http] trust proxy 已启用（${tp} 跳）`);
  } else if (tp === 'loopback') {
    app.set('trust proxy', 'loopback');
    console.log('[http] trust proxy 已启用（仅回环）');
  }

  app.use(securityHeaders);
  app.use(
    cors({
      origin: resolveCorsOrigins(),
      methods: ['GET', 'POST', 'OPTIONS'],
      // FS-014：补齐 auth.js 实际读取的凭证头与飞书签名三头
      allowedHeaders: [
        'Content-Type',
        'Authorization',
        'X-API-Key',
        'X-Lark-Signature',
        'X-Lark-Request-Timestamp',
        'X-Lark-Request-Nonce',
      ],
      credentials: true,
    })
  );
  // FS-001：签名覆盖原始请求体 —— verify 钩子把原始字节挂到 req.rawBody
  //（注意 body-parser verify 回调签名为 (req, res, buf, encoding)）
  app.use(
    express.json({
      limit: process.env.FEISHU_BODY_LIMIT || '1mb',
      verify: (req, res, buf, encoding) => {
        req.rawBody = buf.toString(encoding);
      },
    })
  );
  return app;
}

// 自定义错误中间件（FS-007/011：兜底未知异常，对外通用文案，详情仅日志）
// eslint-disable-next-line no-unused-vars
function errorHandler(err, req, res, next) {
  console.error('[http] unhandled error:', err && err.stack ? err.stack : err);
  if (res.headersSent) return next(err);
  res.status(500).json({ ok: false, error: 'internal server error' });
}

module.exports = {
  resolveCorsOrigins,
  simulatorEnabled,
  securityHeaders,
  configureApp,
  errorHandler,
};
