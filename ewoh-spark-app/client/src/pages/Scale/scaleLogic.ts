/**
 * scaleLogic.ts — Scale 数据页纯逻辑层（ADR-088，§17/§33）。
 *
 * 从 Scale.tsx（861 行）提取，不含 React/Query/DOM 依赖，node 测试成立。
 * workflowRoles.ts 已单独提取（R2-CP2-006），不在此模块。
 */

// ── 类型 ─────────────────────────────────────────────────────────────────

export type DiffCategory = 'general' | 'configuration' | 'process' | 'behavior';

// ── 常量 ─────────────────────────────────────────────────────────────────

/** 差异类别选项。 */
export const DIFF_CATEGORY_OPTIONS: ReadonlyArray<{ value: DiffCategory; label: string }> = [
  { value: 'general', label: '通用' },
  { value: 'configuration', label: '配置' },
  { value: 'process', label: '流程' },
  { value: 'behavior', label: '行为' },
];

// ── 纯函数 ───────────────────────────────────────────────────────────────

/** 时间格式化（zh-CN，null/undefined → '—'）。 */
export function formatScaleTime(value: string | null | undefined): string {
  if (!value) return '—';
  return new Date(value).toLocaleString('zh-CN', {
    timeZone: 'Asia/Shanghai',
    hour12: false,
  });
}

/** JSON 安全解析（失败回退原始字符串）。 */
export function parseJsonValue(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

/** 差异类别中文标签（未知回退原始值）。 */
export function diffCategoryLabel(value: string): string {
  const opt = DIFF_CATEGORY_OPTIONS.find((o) => o.value === value);
  return opt?.label ?? value;
}

/** 工厂名称校验（非空、长度限制）。 */
export function isValidFactoryName(name: string): boolean {
  const trimmed = name.trim();
  return trimmed.length > 0 && trimmed.length <= 100;
}

/** 差异值序列化（对象→JSON 字符串，字符串直通）。 */
export function serializeDiffValue(value: unknown): string {
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}
