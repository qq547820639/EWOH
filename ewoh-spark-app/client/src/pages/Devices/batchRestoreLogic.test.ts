/**
 * batchRestoreLogic.test.ts — 批量恢复的纯逻辑（NO-23a）。
 *
 * 钉死的语义（每条都对应现场会踩的坑）：
 *   1. 只有"被人为停用"的能力才进批次（设备没有该能力 ≠ 待恢复）；
 *   2. 缺业务设备号的设备无法恢复 → 单独计数如实告知（数据缺口不得静默吞掉）；
 *   3. 高风险批次排前面（更需要审批、也更该优先处置），同批内停用最久优先；
 *   4. 部分成功必须明说，并指出失败项未消耗审批额度、可直接重试；
 *   5. 失败文案分三类（无审批/已过期或已消耗/其他），未知错误不编原因。
 */
/// <reference types="jest" />
import type { WorldStateSnapshot } from '@shared/scheduler';
import {
  describeBatchRestoreFailure,
  groupRestorableCapabilities,
  sortedDeviceIds,
  summarizeRestoreOutcome,
} from './batchRestoreLogic';

const NOW = Date.parse('2026-09-12T10:00:00.000Z');
const daysAgo = (days: number) => new Date(NOW - days * 86_400_000).toISOString();

function device(overrides: Record<string, unknown>) {
  return {
    id: `uuid-${overrides.deviceId ?? 'x'}`,
    name: String(overrides.deviceId ?? 'x'),
    status: 'active',
    healthStatus: null,
    skills: [],
    certifications: [],
    loadLevel: 0,
    fatigueLevel: 0,
    stationId: null,
    zoneId: null,
    x: null,
    y: null,
    ...overrides,
  };
}

function snapshot(devices: Array<Record<string, unknown>>): WorldStateSnapshot {
  return {
    snapshotVersion: 'test',
    ts: new Date(NOW).toISOString(),
    worldVersion: 1,
    entityVersions: {},
    reservations: [],
    devices: devices as never,
    tasks: [],
    personnel: [],
  } as unknown as WorldStateSnapshot;
}

describe('groupRestorableCapabilities', () => {
  it('按能力聚合被人为停用的设备，并带上停用留痕与已停用天数', () => {
    const { groups, missingDeviceIdCount } = groupRestorableCapabilities(
      snapshot([
        device({
          deviceId: 'EXO-1',
          disabledCapabilities: ['exo-lift'],
          disabledCapabilityLifecycle: [
            { name: 'exo-lift', operator: 'admin', reason: '助力模块待检修', at: daysAgo(3) },
          ],
          dataQuality: 'FRESH',
        }),
        device({
          deviceId: 'EXO-2',
          disabledCapabilities: ['exo-lift'],
          disabledCapabilityLifecycle: [
            { name: 'exo-lift', operator: 'worker.li', reason: '电池鼓包', at: daysAgo(9) },
          ],
        }),
      ]),
      { nowMs: NOW },
    );

    expect(missingDeviceIdCount).toBe(0);
    expect(groups).toHaveLength(1);
    expect(groups[0]).toMatchObject({
      capability: 'exo-lift',
      risk: 'high',
      requiresApproval: true,
    });
    // 停用最久优先（避免设备被悄悄永久排除在派工之外）
    expect(groups[0].devices.map((d) => d.deviceId)).toEqual(['EXO-2', 'EXO-1']);
    expect(groups[0].devices[0]).toMatchObject({
      operator: 'worker.li',
      reason: '电池鼓包',
      disabledDays: 9,
    });
  });

  it('高风险批次优先于低风险；同风险按设备数量排序', () => {
    const { groups } = groupRestorableCapabilities(
      snapshot([
        device({
          deviceId: 'ENV-1',
          disabledCapabilities: ['observe.temperature'],
          disabledCapabilityLifecycle: [{ name: 'observe.temperature', operator: 'a', reason: 'r', at: daysAgo(1) }],
        }),
        device({
          deviceId: 'EXO-1',
          disabledCapabilities: ['exo-lite'],
          disabledCapabilityLifecycle: [{ name: 'exo-lite', operator: 'a', reason: 'r', at: daysAgo(1) }],
        }),
        device({
          deviceId: 'CRANE-1',
          disabledCapabilities: ['crane'],
          disabledCapabilityLifecycle: [{ name: 'crane', operator: 'a', reason: 'r', at: daysAgo(1) }],
        }),
      ]),
      { nowMs: NOW },
    );

    expect(groups.map((g) => g.capability)).toEqual(['crane', 'exo-lite', 'observe.temperature']);
    const exoLite = groups.find((g) => g.capability === 'exo-lite')!;
    expect(exoLite.requiresApproval).toBe(false);
    expect(exoLite.risk).toBe('medium');
  });

  it('缺业务设备号的设备无法恢复 → 单独计数（数据缺口不得静默消失）', () => {
    const { groups, missingDeviceIdCount } = groupRestorableCapabilities(
      snapshot([
        device({
          deviceId: undefined,
          disabledCapabilities: ['exo-lift'],
          disabledCapabilityLifecycle: [{ name: 'exo-lift', operator: 'a', reason: 'r', at: daysAgo(1) }],
        }),
        device({
          deviceId: 'EXO-1',
          disabledCapabilities: ['exo-lift'],
          disabledCapabilityLifecycle: [{ name: 'exo-lift', operator: 'a', reason: 'r', at: daysAgo(1) }],
        }),
      ]),
      { nowMs: NOW },
    );

    expect(missingDeviceIdCount).toBe(1);
    expect(groups[0].devices.map((d) => d.deviceId)).toEqual(['EXO-1']);
  });

  it('留痕缺失 / 停用时间为空 → 如实留 null（不猜天数、不编操作人）', () => {
    const { groups } = groupRestorableCapabilities(
      snapshot([device({ deviceId: 'EXO-3', disabledCapabilities: ['exo-lift'] })]),
      { nowMs: NOW },
    );
    expect(groups[0].devices[0]).toMatchObject({
      operator: null,
      reason: null,
      at: null,
      disabledDays: null,
    });
  });

  it('空快照 / 无停用能力 → 空批次（UI 显示"没有需要恢复的对象"）', () => {
    expect(groupRestorableCapabilities(null).groups).toEqual([]);
    expect(groupRestorableCapabilities(snapshot([])).groups).toEqual([]);
    expect(
      groupRestorableCapabilities(snapshot([device({ deviceId: 'EXO-1', capabilities: ['exo-lift'] })])).groups,
    ).toEqual([]);
  });
});

describe('summarizeRestoreOutcome', () => {
  it('全部成功 / 部分成功 / 全部失败三态文案不同（部分执行必须明说）', () => {
    const ok = [1, 2].map((i) => ({ deviceId: `D-${i}`, ok: true, message: null }));
    const partial = [...ok, { deviceId: 'D-3', ok: false, message: '审批已过期', status: 409 }];
    const failed = [{ deviceId: 'D-1', ok: false, message: 'x', status: 409 }];

    expect(summarizeRestoreOutcome(ok)).toMatchObject({ succeeded: 2, failed: 0, partial: false });
    expect(summarizeRestoreOutcome(ok).label).toContain('全部成功');

    const p = summarizeRestoreOutcome(partial);
    expect(p).toMatchObject({ succeeded: 2, failed: 1, partial: true, allFailed: false });
    expect(p.label).toContain('部分成功');
    // 失败项未消耗审批额度（服务端消耗与写入同事务）——这是可照做的承诺，必须出现在文案里
    expect(p.label).toContain('未消耗审批额度');
    expect(p.failures.map((f) => f.deviceId)).toEqual(['D-3']);

    const f = summarizeRestoreOutcome(failed as never);
    expect(f).toMatchObject({ succeeded: 0, failed: 1, allFailed: true });
    expect(f.label).toContain('全部失败');

    expect(summarizeRestoreOutcome([]).label).toContain('没有需要恢复的设备');
  });
});

describe('describeBatchRestoreFailure', () => {
  it('审批类拒绝 → 现场可照做的下一步（去申请 / 重新申请）', () => {
    expect(
      describeBatchRestoreFailure('HIGH_RISK_CAPABILITY_RESTORE_REQUIRES_APPROVAL：恢复高风险能力（exo-lift）'),
    ).toContain('请先申请安全审批');
    expect(describeBatchRestoreFailure('APPROVAL_INVALID：审批已超出有效期')).toContain('重新申请');
    expect(describeBatchRestoreFailure('APPROVAL_ALREADY_CONSUMED：该审批已用于本设备的这次恢复')).toContain(
      '重新申请审批',
    );
  });

  it('axios 形态取服务端 message；什么都没有时如实说"未返回原因"', () => {
    expect(
      describeBatchRestoreFailure({
        message: 'Request failed with status code 500',
        response: { data: { message: '设备能力状态变更未生效（并发冲突），请重试并复核当前状态' } },
      }),
    ).toContain('并发冲突');
    expect(describeBatchRestoreFailure({})).toContain('失败原因未返回');
    expect(describeBatchRestoreFailure(new Error(''))).toContain('失败原因未返回');
  });
});

describe('sortedDeviceIds', () => {
  it('排序去重（与服务端审批指纹同一口径）', () => {
    expect(sortedDeviceIds(['EXO-2', 'EXO-1', 'EXO-2', ' '])).toEqual(['EXO-1', 'EXO-2']);
  });
});
