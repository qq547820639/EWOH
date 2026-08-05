/**
 * openapi.contract.test.ts
 *
 * Wave W4 "OpenAPI 与前后端契约自动化" 契约测试：
 *  1. 读取生成的 client/src/types/openapi.d.ts，断言关键契约类型命名导出存在，
 *     证明生成产物可解析、已与 OpenAPI spec 对齐。
 *  2. 类型级断言：重构后的 api/system.ts 类型来自生成契约，而非手写重复。
 *
 * 由 openapi/ewoh.yaml 生成。若类型漂移，npm run gen:openapi:check 会先失败。
 */
import * as fs from 'fs';
import * as path from 'path';
import type { components } from './openapi';
import {
  type FeatureFlagEvaluationResult,
  type SystemConfigRecord,
} from '../api/system';

const GENERATED_DTS = path.join(__dirname, 'openapi.d.ts');

describe('openapi.d.ts 生成契约', () => {
  let dts: string;

  beforeAll(() => {
    dts = fs.readFileSync(GENERATED_DTS, 'utf8');
  });

  it('生成文件非空且包含顶层命名导出', () => {
    expect(dts.length).toBeGreaterThan(1000);
    expect(dts).toContain('export interface components');
    expect(dts).toContain('export interface paths');
  });

  it.each([
    'SystemConfig',
    'SystemConfigList',
    'SetSystemConfigRequest',
    'FeatureFlag',
    'FeatureFlagEvaluation',
    'FeatureFlagEvaluateRequest',
    'ErrorResponse',
    'CursorPage',
    'AuthTokens',
    'LoginRequest',
    'FileUpload',
    'MesForceResolveRequest',
    'OperationsSummary',
    'HealthStatus',
  ])('包含契约 schema 命名导出：%s', (name) => {
    expect(dts).toContain(`${name}:`);
  });

  it('生成的 CursorPage 与分页契约对齐（items/nextCursor/hasMore）', () => {
    const m = dts.match(/CursorPage: \{([\s\S]*?)\n        \};/);
    expect(m).not.toBeNull();
    expect(m![1]).toContain('items');
    expect(m![1]).toContain('nextCursor');
    expect(m![1]).toContain('hasMore');
  });

  it('api/system.ts 的类型直接映射到生成契约 schema', () => {
    // 双向可赋值：SystemConfigRecord 与本契约的 SystemConfig 是同一形状。
    const _a: components['schemas']['SystemConfig'] = {} as SystemConfigRecord;
    const _b: SystemConfigRecord = {} as components['schemas']['SystemConfig'];
    const _c: components['schemas']['FeatureFlagEvaluation'] =
      {} as FeatureFlagEvaluationResult;
    const _d: FeatureFlagEvaluationResult =
      {} as components['schemas']['FeatureFlagEvaluation'];
  });

  it('SystemConfigRecord 可承载一个合法的 SystemConfig 对象', () => {
    const cfg: SystemConfigRecord = {
      id: 'cfg-1',
      configKey: 'theme',
      configValue: { dark: true },
      updatedBy: null,
      updatedAt: '2026-08-05T00:00:00Z',
    };
    expect(cfg.id).toBe('cfg-1');
    expect(cfg.configKey).toBe('theme');
  });

  it('FeatureFlagEvaluationResult 由契约的 FeatureFlagEvaluation 提供', () => {
    const result: FeatureFlagEvaluationResult = {
      key: 'new-dashboard',
      enabled: true,
      reason: 'rollout-10',
      variant: 'control',
      targetingApplied: false,
    };
    expect(result.enabled).toBe(true);
    const contract: components['schemas']['FeatureFlagEvaluation'] = result;
    expect(contract.key).toBe('new-dashboard');
  });
});