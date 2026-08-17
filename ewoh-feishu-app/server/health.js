// server/health.js — 健康检查 / 就绪判定（Task 16.1）
// 区分「本地 API 健康」与「飞书集成健康」：
//   - 本地 API 健康 = 进程存活 + HTTP 服务能响应（能收到请求即天然成立，无需额外状态）；
//   - 飞书集成可用 = configured=true（initFeishuIntegration 成功加载配置）
//     && 熔断未打开（复用 feishu.js 熔断状态，getFeishuStatus）
//     && 最近一次同步未失败（sync.js 每次全量/轮询同步结果回写）。
//
// 端点：
//   - GET /health/live  → 恒 200 {status:'live'}（进程存活探针）
//   - GET /health/ready → 本地健康且飞书可用 → 200 {status:'ready', feishu:'healthy'}；
//                         否则 503 {status:'not_ready', feishu:'unavailable'}。
//                         FS-012：HTTP 响应仅状态位，内部错误串不经探针暴露
//                         （完整诊断信息见进程内 readyStatus()）。

const feishu = require('./feishu');

// 模块级集成状态（由 index.js 的 initFeishuIntegration 与 sync.js 同步结果回写；
// 测试可直接注入以模拟各状态）
const state = {
  feishu: {
    configured: false,   // feishu-config.json 是否加载成功（init 时写入）
    initError: null,     // initFeishuIntegration 阶段错误信息
    lastSyncAt: null,    // 最近一次同步（全量/轮询）时间 ISO；null=尚无同步
    lastSyncOk: null,    // 最近一次同步是否成功；null=尚无同步
    lastSyncError: null, // 最近一次同步错误信息
  },
};

// 更新飞书集成状态（initFeishuIntegration 调用；测试注入）
function setFeishuState(partial) {
  Object.assign(state.feishu, partial || {});
}

// 记录一次同步结果（sync.js 每次全量同步/轮询结束调用）
function recordFeishuSync(ok, error) {
  state.feishu.lastSyncAt = new Date().toISOString();
  state.feishu.lastSyncOk = !!ok;
  state.feishu.lastSyncError = ok ? null : (error || null);
}

// 飞书集成当前是否可用
function isFeishuAvailable() {
  const s = state.feishu;
  if (!s.configured) return false;
  if (feishu.getFeishuStatus().circuitOpen) return false;
  if (s.lastSyncAt != null && s.lastSyncOk === false) return false;
  return true;
}

// 不可用原因（供 503 响应携带，便于排查）
function feishuUnavailableReason() {
  const s = state.feishu;
  if (!s.configured) return 'feishu not configured (feishu-config.json 未加载)';
  if (feishu.getFeishuStatus().circuitOpen) return 'feishu circuit breaker open (lark-cli 连续失败)';
  if (s.lastSyncAt != null && s.lastSyncOk === false) {
    return `last feishu sync failed: ${s.lastSyncError || 'unknown error'}`;
  }
  return 'feishu unavailable';
}

// GET /health/live：进程存活即 200
function liveStatus() {
  return { status: 'live' };
}

// GET /health/ready：本地健康 + 飞书可用 → 200；否则 503
// 完整 detail（含 lastSyncError / lastFeishuError / reason 等内部诊断信息）
// 仅供进程内诊断与测试断言（readyStatus()），不经 HTTP 暴露。
function readyStatus() {
  const breaker = feishu.getFeishuStatus();
  const detail = {
    localApi: 'healthy',
    configured: state.feishu.configured,
    circuitOpen: breaker.circuitOpen,
    lastSyncAt: state.feishu.lastSyncAt,
    lastSyncOk: state.feishu.lastSyncOk,
    lastSyncError: state.feishu.lastSyncError,
    lastFeishuError: breaker.lastError,
  };
  if (isFeishuAvailable()) {
    return { status: 'ready', ...detail, feishu: 'healthy' };
  }
  return { status: 'not_ready', ...detail, feishu: 'unavailable', reason: feishuUnavailableReason() };
}

// 挂载健康检查路由（index.js 与测试复用；不经过 /api 鉴权，探针免认证）
function registerHealthRoutes(app) {
  app.get('/health/live', (req, res) => {
    res.json(liveStatus());
  });
  // FS-012：探针 HTTP 响应仅返回状态位（status + feishu 健康），
  // 不回传内部错误串（lastSyncError / lastFeishuError / reason），
  // 避免未认证调用方借探针枚举内部异常细节。
  app.get('/health/ready', (req, res) => {
    const s = readyStatus();
    res.status(s.status === 'ready' ? 200 : 503).json({ status: s.status, feishu: s.feishu });
  });
}

module.exports = {
  liveStatus,
  readyStatus,
  setFeishuState,
  recordFeishuSync,
  isFeishuAvailable,
  registerHealthRoutes,
  // 测试钩子（node --test 用；生产路径不受影响）
  __test: {
    reset() {
      state.feishu.configured = false;
      state.feishu.initError = null;
      state.feishu.lastSyncAt = null;
      state.feishu.lastSyncOk = null;
      state.feishu.lastSyncError = null;
    },
  },
};
