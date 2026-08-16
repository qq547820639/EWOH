/* exo-config.spec.ts — Canonical Exo Configuration Model TS 实现（ADR-051 / NO-13b）。
 *
 * 与 contracts/exo/exo-config.test-vectors.json 共享向量语义
 * （audit-domain-contracts exo-config 域跨语言仲裁 + Golden 第 25 场景）。
 */
import {
  CALIBRATION_KINDS,
  EXO_CONFIG_KINDS,
  FIT_STATUSES,
  PROFILE_STATUSES,
  SUPPORT_MODES,
  validateExoConfig,
} from './exo-config';

function record(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    configId: 'exo-config:spec:1',
    kind: 'assist_profile',
    exoId: 'device:exo-1',
    tenantId: 't-org-1',
    status: 'active',
    supportMode: 'lift_assist',
    effectiveFrom: '2026-08-16T08:00:00Z',
    auditTrail: [{ actor: 'person:op-1', action: 'activated', at: '2026-08-16T08:00:00Z' }],
    ...overrides,
  };
}

describe('validateExoConfig（Canonical Exo Configuration Model）', () => {
  it('注册表形状：3 kind / 8 supportMode / 3 calibrationKind / 按 kind 状态封闭', () => {
    expect(EXO_CONFIG_KINDS).toHaveLength(3);
    expect(SUPPORT_MODES).toHaveLength(8);
    expect(CALIBRATION_KINDS).toHaveLength(3);
    expect(PROFILE_STATUSES).toHaveLength(3);
    expect(FIT_STATUSES).toHaveLength(4);
  });

  it('三类 kind 全部合法（active profile / fit / calibration）', () => {
    expect(validateExoConfig(record())).toEqual([]);
    expect(validateExoConfig(record({
      supportMode: 'vendor_specific',
      vendorModeName: 'NY-LIFT-3',
    }))).toEqual([]);
    expect(validateExoConfig(record({
      kind: 'fit',
      status: 'fitted',
      personId: 'person:p1',
      fittedAt: '2026-08-16T09:00:00Z',
      fitter: 'person:op-2',
    }))).toEqual([]);
    expect(validateExoConfig(record({
      kind: 'calibration',
      status: 'passed',
      calibrationKind: 'load_cell',
      result: 'passed',
      calibratedAt: '2026-08-16T10:00:00Z',
      calibratedBy: 'person:op-3',
    }))).toEqual([]);
  });

  it('封闭注册表：未知 kind/mode/calibrationKind/status → 显式拒绝', () => {
    expect(validateExoConfig(record({ kind: 'future' }))).toEqual(['unknown_kind']);
    expect(validateExoConfig(record({ supportMode: 'turbo' }))).toEqual(['unknown_support_mode']);
    expect(validateExoConfig(record({
      kind: 'calibration',
      status: 'passed',
      calibrationKind: 'gyro',
      result: 'passed',
      calibratedAt: '2026-08-16T10:00:00Z',
      calibratedBy: 'person:op-3',
    }))).toEqual(['unknown_calibration_kind']);
    expect(validateExoConfig(record({ status: 'fitted' }))).toEqual(['unknown_status']);
  });

  it('vendor_specific 显式桶：vendorModeName 必填（未知模式绝不静默改写）', () => {
    expect(validateExoConfig(record({ supportMode: 'vendor_specific' })))
      .toEqual(['vendor_mode_name_required']);
    expect(validateExoConfig(record({ supportMode: 'vendor_specific', vendorModeName: '  ' })))
      .toEqual(['vendor_mode_name_required']);
  });

  it('assist_profile 判定事实：assistLevel ∈[0,1] / torque ≥0 / superseded 必带 supersededBy', () => {
    expect(validateExoConfig(record({ parameters: { assistLevel: 1.7 } })))
      .toEqual(['bad_assist_level']);
    expect(validateExoConfig(record({ parameters: { torqueLimitNm: -1 } })))
      .toEqual(['bad_torque_limit']);
    expect(validateExoConfig(record({ status: 'superseded' })))
      .toEqual(['superseded_by_required']);
    expect(validateExoConfig(record({
      status: 'superseded',
      supersededBy: 'exo-config:other',
    }))).toEqual([]);
  });

  it('时间不倒退：effectiveTo/nextDueAt 不得早于起点', () => {
    expect(validateExoConfig(record({ effectiveTo: '2026-08-15T08:00:00Z' })))
      .toEqual(['time_order_violation']);
    expect(validateExoConfig(record({
      kind: 'calibration',
      status: 'passed',
      calibrationKind: 'zeroing',
      result: 'passed',
      calibratedAt: '2026-08-16T10:00:00Z',
      calibratedBy: 'person:op-3',
      nextDueAt: '2026-08-15T10:00:00Z',
    }))).toEqual(['time_order_violation']);
  });

  it('fit/calibration 判定事实完整（personId/fitter/result/calibratedBy）', () => {
    expect(validateExoConfig(record({
      kind: 'fit', status: 'fitted', fittedAt: '2026-08-16T09:00:00Z', fitter: 'person:op-2',
    }))).toEqual(['fit_person_required']);
    expect(validateExoConfig(record({
      kind: 'fit', status: 'fitted', personId: 'p1',
      fittedAt: '2026-08-16T09:00:00Z', fitter: 'person:op-2',
    }))).toEqual(['bad_person_id']);
    expect(validateExoConfig(record({
      kind: 'calibration', status: 'passed', calibrationKind: 'imu',
      calibratedAt: '2026-08-16T10:00:00Z', calibratedBy: 'person:op-3',
    }))).toEqual(['calibration_result_required']);
  });

  it('configId/exoId 规范前缀 + tenantId + auditTrail 强制（fail-closed）', () => {
    expect(validateExoConfig(record({ configId: 'cfg-1' }))).toEqual(['bad_config_id']);
    expect(validateExoConfig(record({ exoId: 'exo-1' }))).toEqual(['bad_exo_id']);
    expect(validateExoConfig(record({ tenantId: '' }))).toEqual(['bad_tenant']);
    expect(validateExoConfig(record({ auditTrail: [] }))).toEqual(['audit_required']);
    expect(validateExoConfig(null)).toEqual(['record_must_be_object']);
    expect(validateExoConfig({})).toEqual(['missing_field:configId']);
  });
});
