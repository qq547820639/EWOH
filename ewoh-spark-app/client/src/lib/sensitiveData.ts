/**
 * Wave W8「安全」— 离线缓存中的敏感数据脱敏与过期。
 *
 * 现状：离线缓存（IndexedDB 的 pendingActions / drafts / attachments）与
 * localStorage 中的动作体未加密存储（见 offlineDb.ts）。本模块不引入无服务端支持
 * 的重型加密，而是提供轻量防御：在同步/上报敏感字段前做脱敏，并为敏感缓存记录
 * 提供过期判定，降低敏感数据长期滞留的风险。
 *
 * 更强保护（传输/落盘加密）需服务端配合，见报告中的安全建议。
 */

export const SENSITIVE_FIELD_PATTERNS: RegExp[] = [
  /token/i,
  /password/i,
  /passwd/i,
  /secret/i,
  /credential/i,
  /authorization/i,
  /api[_-]?key/i,
  /access[_-]?token/i,
  /refresh[_-]?token/i,
  /client[_-]?secret/i,
];

/** 判断某个字段名是否属于敏感字段（如 token / password / secret）。 */
export function isSensitiveKey(key: string): boolean {
  return SENSITIVE_FIELD_PATTERNS.some((pattern) => pattern.test(key));
}

const MASK = '***REDACTED***';

/** 对单个值脱敏：字符串/数字/布尔统一替换为掩码。 */
export function redactValue(_value: unknown): unknown {
  return MASK;
}

/**
 * 递归脱敏一条记录：敏感键的值替换为掩码，普通对象/数组递归处理。
 * 不原地修改，返回新对象。
 */
export function redactSensitiveFields(
  record: unknown,
  depth = 0,
): unknown {
  if (depth > 6) return record;
  if (Array.isArray(record)) {
    return record.map((item) => redactSensitiveFields(item, depth + 1));
  }
  if (record && typeof record === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(record)) {
      if (isSensitiveKey(key)) {
        out[key] = redactValue(value);
      } else {
        out[key] = redactSensitiveFields(value, depth + 1);
      }
    }
    return out;
  }
  return record;
}

// ---- 过期 ----

/** 计算一个缓存记录的绝对过期时间点（epoch ms）。 */
export function expiresAt(
  maxAgeMs: number,
  now: number = Date.now(),
): number {
  return now + maxAgeMs;
}

/** 判断缓存记录是否已过期（按 createdAt/updatedAt 判定）。 */
export function isRecordExpired(
  record: { createdAt?: string; updatedAt?: string },
  maxAgeMs: number,
  now: number = Date.now(),
): boolean {
  if (maxAgeMs <= 0) return false;
  const raw = record.updatedAt ?? record.createdAt;
  if (!raw) return false;
  const at = Date.parse(raw);
  if (Number.isNaN(at)) return false;
  return now - at >= maxAgeMs;
}