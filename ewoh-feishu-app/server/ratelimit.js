// server/ratelimit.js — 简单内存失败计数限流（FS-010）
//
// 目标：缓解 /api 写操作与 /webhook 的暴力破解（token 枚举 / 签名爆破）。
// 策略（两级计数，key = `<scope>|<ip>|<tokenHash>`）：
//   - token 级：同一 (ip, token) 组合在窗口内失败次数达阈值 → 封禁该 key；
//   - IP 级：同一 (scope, ip) 下全部失败（含换 token 枚举）累计达阈值 →
//     封禁该 IP（防止攻击者每次换 token 绕开 token 级计数）；
//   - 任一级达阈值即返回 blocked（429），窗口滚动清理；
//   - 认证成功（recordSuccess）清除该 (scope, ip) 的全部失败计数
//     （合法客户端不受历史失败影响；token 以 sha256 前 16 hex 参与，不落明文）；
//   - 纯内存实现，单实例模型（与 README 部署约束一致），桶数有界。
// 环境变量：
//   - FEISHU_RATELIMIT_MAX_FAILURES（默认 20）：窗口内允许的最大失败次数
//   - FEISHU_RATELIMIT_WINDOW_SEC（默认 300）：计数窗口秒数

const crypto = require('crypto');

const buckets = new Map(); // key -> { count, windowStartMs }

function maxFailures() {
  const n = parseInt(process.env.FEISHU_RATELIMIT_MAX_FAILURES, 10);
  return Number.isFinite(n) && n > 0 ? n : 20;
}

function windowMs() {
  const n = parseInt(process.env.FEISHU_RATELIMIT_WINDOW_SEC, 10);
  return (Number.isFinite(n) && n > 0 ? n : 300) * 1000;
}

/** 构造限流 key：IP + 凭证摘要（不含明文 token）。 */
function key(scope, ip, token) {
  const tokenHash = crypto
    .createHash('sha256')
    .update(String(token || ''), 'utf8')
    .digest('hex')
    .slice(0, 16);
  return `${scope}|${ip || 'unknown'}|${tokenHash}`;
}

// IP 级聚合 key（scope|ip|*）
function ipKeyOf(k) {
  const parts = String(k).split('|');
  return `${parts[0]}|${parts[1]}|*`;
}

function bucketBlocked(k) {
  const b = buckets.get(k);
  if (!b) return false;
  if (Date.now() - b.windowStartMs >= windowMs()) {
    buckets.delete(k);
    return false;
  }
  return b.count >= maxFailures();
}

/** 该 key 当前是否已被封禁（token 级或 IP 级任一达阈值）。 */
function isBlocked(k) {
  return bucketBlocked(k) || bucketBlocked(ipKeyOf(k));
}

function incrFailure(k) {
  const now = Date.now();
  let b = buckets.get(k);
  if (!b || now - b.windowStartMs >= windowMs()) {
    b = { count: 0, windowStartMs: now };
    buckets.set(k, b);
  }
  b.count += 1;
}

/** 记录一次认证失败（token 级 + IP 级同时计数）。 */
function recordFailure(k) {
  incrFailure(k);
  incrFailure(ipKeyOf(k));
  // 有界清理：桶数超上限时清掉最老一半（防内存膨胀）
  if (buckets.size > 10000) {
    const entries = [...buckets.entries()].sort((x, y) => x[1].windowStartMs - y[1].windowStartMs);
    for (let i = 0; i < Math.floor(entries.length / 2); i += 1) buckets.delete(entries[i][0]);
  }
}

/** 认证成功：清除该 (scope, ip) 的全部失败计数（含历史错误 token 的桶）。 */
function recordSuccess(k) {
  const parts = String(k).split('|');
  const prefix = `${parts[0]}|${parts[1]}|`;
  for (const bk of [...buckets.keys()]) {
    if (bk.startsWith(prefix)) buckets.delete(bk);
  }
}

/** 测试钩子：清空全部计数。 */
function reset() {
  buckets.clear();
}

module.exports = { key, isBlocked, recordFailure, recordSuccess, reset };
