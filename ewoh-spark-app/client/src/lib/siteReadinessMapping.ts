/**
 * UX-005 映射与导入 —— 纯前端逻辑（无网络依赖，便于单元测试）。
 *
 * - 映射规则模型（与后端 scale dry-run 的 manifest.rules 形态一致）
 * - 字段变换（trim/upper/lower/number/string/default）
 * - 本地 Dry Run
 * - 导入前后差异预览（本地解析，标注为本地预览）
 *
 * 注意：本模块不引入 http，避免在 node 测试环境加载 auth/axios 依赖。
 * 后端 dry-run 调用见 ./siteReadinessBackend.ts。
 */

export interface MappingRule {
  from: string;
  to: string;
  transform?: string;
  required?: boolean;
}

export interface SiteReadinessMappingConfig {
  rules: MappingRule[];
  updatedAt: string;
}

export const MAPPING_STORAGE_KEY = 'ewoh.siteReadiness.mapping.v1';
export const IMPORT_PREVIEW_STORAGE_KEY = 'ewoh.siteReadiness.importPreview.v1';

export const DEFAULT_MAPPING_RULES: MappingRule[] = [
  { from: 'order_no', to: 'erpOrderId', transform: 'trim', required: true },
  { from: 'device_no', to: 'deviceId', transform: 'trim', required: true },
  { from: 'org', to: 'organization', transform: 'upper', required: false },
  { from: 'id', to: 'identity', transform: 'trim', required: false },
];

/* ------------------------------------------------------------------ */
/* localStorage 安全读写（node 测试环境无 localStorage）                */
/* ------------------------------------------------------------------ */

function readStorage<T>(key: string, fallback: T): T {
  if (typeof localStorage === 'undefined') return fallback;
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return fallback;
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

export function loadMappingConfig(): SiteReadinessMappingConfig {
  return readStorage<SiteReadinessMappingConfig>(MAPPING_STORAGE_KEY, {
    rules: DEFAULT_MAPPING_RULES,
    updatedAt: '',
  });
}

export function saveMappingConfig(config: SiteReadinessMappingConfig): void {
  if (typeof localStorage === 'undefined') return;
  try {
    localStorage.setItem(MAPPING_STORAGE_KEY, JSON.stringify(config));
  } catch {
    // 存储失败静默忽略（如隐私模式）。
  }
}

/* ------------------------------------------------------------------ */
/* JSON 路径读写与字段变换（与后端语义一致）                            */
/* ------------------------------------------------------------------ */

export function readJsonPath(obj: Record<string, unknown>, path: string): unknown {
  const segments = path.split('.');
  let current: unknown = obj;
  for (const segment of segments) {
    if (current === null || typeof current !== 'object') return undefined;
    current = (current as Record<string, unknown>)[segment];
  }
  return current;
}

export function writeJsonPath(
  obj: Record<string, unknown>,
  path: string,
  value: unknown,
): void {
  const segments = path.split('.');
  let current = obj;
  for (let i = 0; i < segments.length - 1; i += 1) {
    const segment = segments[i];
    const next = current[segment];
    if (next === null || typeof next !== 'object') {
      current[segment] = {};
    }
    current = current[segment] as Record<string, unknown>;
  }
  current[segments[segments.length - 1]] = value;
}

export function applyMappingTransform(
  value: unknown,
  transform?: string,
): { value: unknown; error?: string } {
  if (!transform) return { value };
  const [name, ...args] = transform.split(':');
  switch (name.toLowerCase()) {
    case 'trim':
      return {
        value: typeof value === 'string' ? value.trim() : value,
      };
    case 'upper':
      return {
        value: typeof value === 'string' ? value.toUpperCase() : value,
      };
    case 'lower':
      return {
        value: typeof value === 'string' ? value.toLowerCase() : value,
      };
    case 'number':
      return {
        value: Number.isNaN(Number(value)) ? undefined : Number(value),
        error: Number.isNaN(Number(value))
          ? `value is not numeric for transform ${transform}`
          : undefined,
      };
    case 'string':
      return { value: String(value ?? '') };
    case 'default':
      return {
        value: value === undefined || value === null ? args.join(':') : value,
      };
    default:
      return { value, error: `unsupported transform ${name}` };
  }
}

/* ------------------------------------------------------------------ */
/* Dry Run                                                             */
/* ------------------------------------------------------------------ */

export interface DryRunError {
  code: string;
  sourceField: string;
  targetField: string;
  transform?: string;
  message: string;
}

export interface DryRunResult {
  passed: boolean;
  ruleCount: number;
  mapped: Record<string, unknown>;
  errors: DryRunError[];
}

/** 本地 Dry Run 逻辑：与后端 applyMappingTransform 语义对齐，用于演示。 */
export function runMappingDryRun(
  sample: Record<string, unknown>,
  rules: MappingRule[],
): DryRunResult {
  const mapped: Record<string, unknown> = {};
  const errors: DryRunError[] = [];
  rules.forEach((rule) => {
    const sourceValue = readJsonPath(sample, rule.from);
    if (sourceValue === undefined && rule.required) {
      errors.push({
        code: 'REQUIRED_FIELD_MISSING',
        sourceField: rule.from,
        targetField: rule.to,
        transform: rule.transform,
        message: `required source field ${rule.from} is missing`,
      });
      return;
    }
    const transformed = applyMappingTransform(sourceValue, rule.transform);
    if (transformed.error) {
      errors.push({
        code: 'TRANSFORM_ERROR',
        sourceField: rule.from,
        targetField: rule.to,
        transform: rule.transform,
        message: transformed.error,
      });
      return;
    }
    writeJsonPath(mapped, rule.to, transformed.value);
  });
  return {
    passed: errors.length === 0,
    ruleCount: rules.length,
    mapped,
    errors,
  };
}

/* ------------------------------------------------------------------ */
/* 导入前后差异预览                                                     */
/* ------------------------------------------------------------------ */

export interface ImportPreviewRow {
  index: number;
  before: Record<string, unknown>;
  after: Record<string, unknown>;
  changed: boolean;
}

export interface ImportPreview {
  rows: ImportPreviewRow[];
  recordCount: number;
  changedCount: number;
  error?: string;
}

/** 解析一段待导入文本（JSON 对象或数组）。 */
export function parseImportText(text: string): {
  records: Record<string, unknown>[];
  error?: string;
} {
  try {
    const parsed: unknown = JSON.parse(text);
    if (Array.isArray(parsed)) {
      return {
        records: parsed.filter(
          (item): item is Record<string, unknown> =>
            item !== null && typeof item === 'object' && !Array.isArray(item),
        ),
      };
    }
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return { records: [parsed as Record<string, unknown>] };
    }
    return { records: [], error: '待导入数据需为 JSON 对象或数组' };
  } catch (error) {
    return {
      records: [],
      error: error instanceof Error ? error.message : 'JSON 解析失败',
    };
  }
}

/** 对每条记录应用映射规则，生成导入前/后差异预览（本地预览，非真实导入）。 */
export function buildImportPreview(
  text: string,
  rules: MappingRule[],
): ImportPreview {
  const { records, error } = parseImportText(text);
  if (error) return { rows: [], recordCount: 0, changedCount: 0, error };

  const rows: ImportPreviewRow[] = records.map((before, index) => {
    const preview: Record<string, unknown> = { ...before };
    rules.forEach((rule) => {
      const sourceValue = readJsonPath(before, rule.from);
      const transformed = applyMappingTransform(sourceValue, rule.transform);
      if (transformed.error) return;
      writeJsonPath(preview, rule.to, transformed.value);
    });
    const changed = JSON.stringify(preview) !== JSON.stringify(before);
    return { index, before, after: preview, changed };
  });

  return {
    rows,
    recordCount: records.length,
    changedCount: rows.filter((row) => row.changed).length,
  };
}

export function saveImportPreview(preview: ImportPreview): void {
  if (typeof localStorage === 'undefined') return;
  try {
    localStorage.setItem(IMPORT_PREVIEW_STORAGE_KEY, JSON.stringify(preview));
  } catch {
    // 忽略写入失败。
  }
}

export function loadImportPreview(): ImportPreview | null {
  return readStorage<ImportPreview | null>(IMPORT_PREVIEW_STORAGE_KEY, null);
}