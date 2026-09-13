/**
 * P1-INGEST-002 回归：接入密钥的"已配置"判定必须在启动门禁与请求期 guard 之间一致。
 *
 * 历史缺陷：`IngestModule` 只检查 legacy 全局 `INGEST_API_KEY`，而 `IngestGuard`
 * 支持 `INGEST_API_KEY_<ORG_ID>` 与 `INGEST_API_KEYS` JSON 映射。按官方推荐
 * 配置 per-key 绑定的生产部署因此启动即失败——最安全的配置反而不可用。
 * 本测试锁定：任一被 guard 接受的配置形态，启动门禁都必须放行；非法配置
 * 必须拒绝启动，而不是留到请求期。
 */
import { validateIngestKeyConfiguration, resolveIngestKeyConfiguration } from '../ingest-key-config';

/** 测试触及的全部密钥相关环境变量；额外扫描前缀以覆盖动态命名（含空白后缀）。 */
const MANAGED = [
  'INGEST_API_KEY',
  'INGEST_API_KEYS',
  'INGEST_API_KEY_MAP',
  'INGEST_API_KEY_ORG_A',
  'INGEST_API_KEY_ORG_B',
  'EWOH_INGEST_ORG_ID',
];

/** 与本主题相关的全部环境变量名（固定清单 + 任意 INGEST_API_KEY 前缀变量）。 */
function relatedEnvNames(): string[] {
  const names = new Set(MANAGED);
  for (const name of Object.keys(process.env)) {
    if (name.startsWith('INGEST_API_KEY')) names.add(name);
  }
  return [...names];
}

describe('ingest 接入密钥配置（启动门禁 ↔ 请求期 guard 一致）', () => {
  let saved: Map<string, string | undefined>;

  beforeEach(() => {
    saved = new Map();
    // 先记录再清除，确保动态命名的变量也被隔离与还原。
    for (const name of relatedEnvNames()) {
      saved.set(name, process.env[name]);
      delete process.env[name];
    }
  });

  afterEach(() => {
    for (const name of relatedEnvNames()) {
      if (!saved.has(name)) delete process.env[name];
    }
    for (const [name, value] of saved) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  });

  it('production 未配置任何密钥时拒绝启动，并给出可执行的配置方式', () => {
    const problems = validateIngestKeyConfiguration(true);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain('INGEST_API_KEY_<ORG_ID>');
  });

  it('非 production 未配置密钥不阻断启动（请求期仍 fail-closed）', () => {
    expect(validateIngestKeyConfiguration(false)).toEqual([]);
    expect(resolveIngestKeyConfiguration().configured).toBe(false);
  });

  it('per-key 绑定（INGEST_API_KEY_<ORG_ID>）即视为已配置——安全推荐配置必须能启动', () => {
    process.env.INGEST_API_KEY_ORG_A = 'key-org-a';
    const config = resolveIngestKeyConfiguration();
    expect(config.configured).toBe(true);
    expect(config.bindings.get('key-org-a')).toBe('ORG_A');
    expect(validateIngestKeyConfiguration(true)).toEqual([]);
  });

  it('JSON 映射即视为已配置', () => {
    process.env.INGEST_API_KEYS = JSON.stringify({ 'key-json': 'org-json' });
    expect(validateIngestKeyConfiguration(true)).toEqual([]);
    expect(resolveIngestKeyConfiguration().bindings.get('key-json')).toBe('org-json');
  });

  it('legacy 全局 key 仍向后兼容', () => {
    process.env.INGEST_API_KEY = 'legacy-key';
    expect(validateIngestKeyConfiguration(true)).toEqual([]);
    // 无 EWOH_INGEST_ORG_ID → 无绑定（值 null），走客户端自报 org 的 legacy 路径。
    expect(resolveIngestKeyConfiguration().bindings.get('legacy-key')).toBeNull();
  });

  it('JSON 映射非法时拒绝启动，且不会被误判为"已配置"', () => {
    process.env.INGEST_API_KEYS = '{not-json';
    const problems = validateIngestKeyConfiguration(true);
    expect(problems).toHaveLength(2);
    expect(problems[0]).toContain('JSON 解析失败');
    expect(problems[1]).toContain('未配置任何接入密钥');

    process.env.INGEST_API_KEY_ORG_A = 'key-org-a';
    // per-key 生效时仅剩解析错误，仍需拒绝启动：静默忽略非法映射会隐藏运维错误。
    const withFallback = validateIngestKeyConfiguration(true);
    expect(withFallback).toHaveLength(1);
    expect(withFallback[0]).toContain('JSON 解析失败');
  });

  it('JSON 映射非法值被记录而不是静默丢弃', () => {
    process.env.INGEST_API_KEYS = JSON.stringify({ 'key-a': '', '': 'org-b' });
    const config = resolveIngestKeyConfiguration();
    expect(config.configured).toBe(false);
    expect(config.errors).toHaveLength(2);
  });

  it('org 后缀为空白字符的 INGEST_API_KEY_ 被记录为配置错误（不静默当作未配置）', () => {
    process.env['INGEST_API_KEY_   '] = 'key-blank-org';
    const config = resolveIngestKeyConfiguration();
    expect(config.configured).toBe(false);
    expect(config.errors.some((error) => error.includes('org 后缀为空'))).toBe(true);
  });

  it('裸 INGEST_API_KEY_（无后缀）既不是 per-key 也不是 legacy，安全忽略且不崩溃', () => {
    process.env.INGEST_API_KEY_ = 'key-no-suffix';
    const config = resolveIngestKeyConfiguration();
    expect(config.configured).toBe(false);
    expect(config.errors).toEqual([]);
  });

  it('多组织各自绑定互不覆盖，同一 key 以最后一次写入为准', () => {
    process.env.INGEST_API_KEY_ORG_A = 'key-a';
    process.env.INGEST_API_KEY_ORG_B = 'key-b';
    const config = resolveIngestKeyConfiguration();
    expect(config.bindings.get('key-a')).toBe('ORG_A');
    expect(config.bindings.get('key-b')).toBe('ORG_B');
    expect(config.bindings.size).toBe(2);
  });

  it('两个 org 配了同一把密钥 → 冲突显式报错（不静默塌缩成单 org 跨租户写入口）', () => {
    // 真实缺陷：Map 覆盖会让其中一个租户的设备数据全部写进另一个租户，且
    // errors 为空（启动门禁不拦、运行期无告警）。修复 = 保留先到绑定 + 冲突报错。
    process.env.INGEST_API_KEY_ORG_A = 'same-secret';
    process.env.INGEST_API_KEY_ORG_B = 'same-secret';
    const config = resolveIngestKeyConfiguration();
    expect(config.errors).toHaveLength(1);
    expect(config.errors[0]).toContain('同一把密钥不得绑定多个 org');
    // 绑定确定性保留先到的 ORG_A（跨形式重跑结果稳定，不依赖 env 遍历顺序的运气）。
    expect(config.bindings.get('same-secret')).toBe('ORG_A');
    // production 启动门禁据此 fail-closed（配置错误必须可见）。
    const problems = validateIngestKeyConfiguration(true);
    expect(problems.some((problem) => problem.includes('同一把密钥不得绑定多个 org'))).toBe(true);
  });

  it('JSON 映射与 per-key env 的同 key 冲突同样报错；同 key 同 org 幂等不报错', () => {
    process.env.INGEST_API_KEY_ORG_A = 'key-shared';
    process.env.INGEST_API_KEYS = JSON.stringify({ 'key-shared': 'ORG_B' });
    const conflict = resolveIngestKeyConfiguration();
    expect(conflict.errors).toHaveLength(1);
    expect(conflict.errors[0]).toContain('ORG_B');

    const same = resolveIngestKeyConfiguration({
      INGEST_API_KEY_ORG_A: 'key-1',
      INGEST_API_KEYS: JSON.stringify({ 'key-1': 'ORG_A' }),
    });
    expect(same.errors).toEqual([]);
    expect(same.bindings.get('key-1')).toBe('ORG_A');
  });
});
