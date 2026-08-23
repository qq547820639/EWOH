/**
 * systemLogic.ts — System 数据页纯逻辑层（ADR-089，§17/§33）。
 *
 * 从 System.tsx（819 行）提取，不含 React/Query/DOM 依赖，node 测试成立。
 */

// ── 常量 ─────────────────────────────────────────────────────────────────

/** 敏感配置键正则（CLI-210 脱敏兜底）。 */
export const SENSITIVE_CONFIG_KEY_RE = /(secret|token|password|api[-_]?key|credential)/i;

/** 参数类型枚举。 */
export const PARAMETER_TYPES = ['string', 'number', 'integer', 'boolean', 'json'] as const;

// ── 纯函数 ───────────────────────────────────────────────────────────────

/** 时间格式化（zh-CN，null/undefined → '—'）。 */
export function formatSystemTime(value: string | null | undefined): string {
  if (!value) return '—';
  return new Date(value).toLocaleString('zh-CN', {
    timeZone: 'Asia/Shanghai',
    hour12: false,
  });
}

/** 按类型解析参数原始值（number/integer/boolean/json/string）。 */
export function parseParameterValue(type: string, raw: string): unknown {
  if (type === 'number') {
    const value = Number(raw);
    return Number.isFinite(value) ? value : raw;
  }
  if (type === 'integer') {
    const value = Number(raw);
    return Number.isInteger(value) ? value : raw;
  }
  if (type === 'boolean') {
    return raw === 'true';
  }
  if (type === 'json') {
    try {
      return JSON.parse(raw);
    } catch {
      return raw;
    }
  }
  return raw;
}

/** CLI-210：递归脱敏敏感配置值（secret/token/password/api_key/credential）。 */
export function redactConfigValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redactConfigValue);
  if (value && typeof value === 'object') {
    const result: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      result[key] = SENSITIVE_CONFIG_KEY_RE.test(key) ? '[REDACTED]' : redactConfigValue(item);
    }
    return result;
  }
  return value;
}

/** 参数状态标签。 */
export const PARAMETER_STATUS_LABEL: Record<string, string> = {
  active: '生效中',
  draft: '草稿',
  retired: '已退役',
  pending_approval: '待审批',
};

/** 参数状态中文标签（未知回退原始值）。 */
export function parameterStatusLabel(status: string | null | undefined): string {
  if (!status) return '—';
  return PARAMETER_STATUS_LABEL[status] ?? status;
}
