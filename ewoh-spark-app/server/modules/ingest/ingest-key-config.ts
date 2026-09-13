/**
 * Ingest 接入密钥配置解析（单一事实源）
 *
 * 背景（P1-INGEST-002 / R2-SOP-004）：接入密钥存在三种配置形态：
 *   1. `INGEST_API_KEY_<ORG_ID>=<key>` —— 每个组织一把 key（推荐）；
 *   2. `INGEST_API_KEYS` / `INGEST_API_KEY_MAP` —— JSON `{"<key>": "<orgId>"}`；
 *   3. legacy 全局 `INGEST_API_KEY` —— 配了 `EWOH_INGEST_ORG_ID` 则绑定该
 *      org，否则为无绑定 key（回退客户端自报 X-Org-Id）。
 *
 * 历史缺陷：`IngestGuard` 认全部三种形态，而 `IngestModule` 启动门禁只检查
 * legacy 全局 key。结果是"按官方推荐配置 per-key 绑定"的生产部署在启动时
 * 直接失败——安全配置反而无法启动。两个检查点各写一份解析逻辑必然再次漂移，
 * 因此本模块是唯一解析入口：guard（请求期鉴权）与 module（启动期 fail-closed）
 * 都只能通过这里判断"是否已配置接入密钥"。
 *
 * 解析失败（JSON 非法）不静默降级为"未配置"就结束：调用方通过 `errors`
 * 决定启动期拒绝。运行期 guard 保持 fail-closed 拒绝请求。
 */

/** key→org 绑定表；值为 null 表示 legacy 无绑定 key。 */
export type IngestKeyBindings = Map<string, string | null>;

export interface IngestKeyConfiguration {
  /** 解析出的 key→org 绑定（含 legacy key，值为 null 表示未绑定）。 */
  bindings: IngestKeyBindings;
  /** legacy 全局 key（已 trim），未配置为 undefined。 */
  legacyKey?: string;
  /** 是否存在任何可用接入密钥；等价于 `bindings.size > 0`。 */
  configured: boolean;
  /** 配置解析错误（如 JSON 映射非法），启动门禁据此 fail-closed。 */
  errors: string[];
}

const JSON_MAP_NAMES = ['INGEST_API_KEYS', 'INGEST_API_KEY_MAP'] as const;
/** 本体与别名的 key 名，不参与 `INGEST_API_KEY_<ORG_ID>` 后缀扫描。 */
const RESERVED_NAMES = new Set<string>(['INGEST_API_KEY', ...JSON_MAP_NAMES]);

/**
 * 解析当前进程环境中的接入密钥配置。纯函数，便于测试与两处调用点复用。
 */
export function resolveIngestKeyConfiguration(
  env: NodeJS.ProcessEnv | Record<string, string | undefined> = process.env,
): IngestKeyConfiguration {
  const bindings: IngestKeyBindings = new Map();
  const errors: string[] = [];

  // 绑定去重：同一 key 值出现**两个不同 org**（典型是两个 org 复制了同一把密钥）
  // 绝不能静默取后者——Map 覆盖会让其中一个租户的设备数据全部写进另一个租户，
  // 且无任何报错（跨租户写入 + 静默，最坏的组合）。这里保留**先到**的绑定并对
  // 冲突显式报错：production 启动门禁据此 fail-closed，请求期 guard 也打 error。
  const bind = (key: string, orgId: string, source: string): void => {
    const existing = bindings.get(key);
    if (existing != null && existing !== orgId) {
      errors.push(
        `${source} 的密钥值与已绑定 org "${existing}" 的密钥重复（冲突 org "${orgId}"）：`
          + '同一把密钥不得绑定多个 org，已忽略后者',
      );
      return;
    }
    if (existing == null) bindings.set(key, orgId);
  };

  // 形态 1：INGEST_API_KEY_<ORG_ID>
  for (const [name, value] of Object.entries(env)) {
    if (!value || RESERVED_NAMES.has(name)) continue;
    const matched = /^INGEST_API_KEY_(.+)$/.exec(name);
    if (!matched) continue;
    const orgId = matched[1].trim();
    if (!orgId) {
      errors.push(`${name} 的 org 后缀为空，已忽略`);
      continue;
    }
    bind(value, orgId, name);
  }

  // 形态 2：JSON 映射
  for (const mapName of JSON_MAP_NAMES) {
    const raw = env[mapName]?.trim();
    if (!raw) continue;
    try {
      const parsed: unknown = JSON.parse(raw);
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        errors.push(`${mapName} 必须是 JSON 对象 {"<key>": "<orgId>"}`);
        continue;
      }
      for (const [key, orgId] of Object.entries(parsed as Record<string, unknown>)) {
        if (!key || typeof orgId !== 'string' || !orgId.trim()) {
          errors.push(`${mapName} 中 ${JSON.stringify(key)} 的 org 绑定非法，已忽略`);
          continue;
        }
        bind(key, orgId.trim(), mapName);
      }
    } catch (error) {
      errors.push(
        `${mapName} JSON 解析失败：${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  // 形态 3：legacy 全局 key
  const legacyKey = env.INGEST_API_KEY?.trim();
  if (legacyKey && !bindings.has(legacyKey)) {
    bindings.set(legacyKey, env.EWOH_INGEST_ORG_ID?.trim() || null);
  }

  return { bindings, legacyKey: legacyKey || undefined, configured: bindings.size > 0, errors };
}

/**
 * 启动期门禁：production 必须存在可用接入密钥，且配置本身可解析。
 * 返回错误列表（空数组表示通过），由调用方决定如何抛出，避免此处耦合 Nest。
 */
export function validateIngestKeyConfiguration(
  isProduction: boolean,
  env: NodeJS.ProcessEnv | Record<string, string | undefined> = process.env,
): string[] {
  const { configured, errors } = resolveIngestKeyConfiguration(env);
  const problems = [...errors];
  if (isProduction && !configured) {
    problems.push(
      '未配置任何接入密钥：production 环境必须配置 INGEST_API_KEY_<ORG_ID>（推荐，按组织绑定）'
        + ' 或 INGEST_API_KEYS JSON 映射，或 legacy INGEST_API_KEY',
    );
  }
  return problems;
}
