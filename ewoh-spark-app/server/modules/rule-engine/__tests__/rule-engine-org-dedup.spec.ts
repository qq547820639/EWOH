/// <reference types="jest" />
/* 回归（UR4 对抗审查 2026-09-13）：规则引擎进程内去重键必须带租户维度。
 *
 * 场景：ewoh_device 唯一键为 (org_id, device_id)（standalone_057 迁移），
 * 同名 device_id 可跨租户存在。原 dedupKey = `${eventCode}:${deviceId}`
 * 不含 org——org-A 的 LOW_BATTERY 触发后，30s 进程内窗口内 org-B 同名
 * 设备的告警被静默吞掉（安全事件丢失；hasRecentEvent 的 DB 查询是按
 * org 过滤的，进程内缓存必须同口径）。
 */
import { RuleEngineService } from '../rule-engine.service';

function makeHarness() {
  const inserted: Array<Record<string, unknown>> = [];
  const db = {
    select: jest.fn(() => ({
      from: jest.fn(() => ({
        where: jest.fn(() => ({
          // hasRecentEvent：永远查无近期事件——抑制只可能来自进程内缓存。
          limit: jest.fn().mockResolvedValue([]),
        })),
      })),
    })),
    insert: jest.fn(() => ({
      values: jest.fn((v: Record<string, unknown>) => {
        inserted.push(v);
        return Promise.resolve();
      }),
    })),
  };
  const service = new RuleEngineService(db as never);
  return { service, inserted };
}

describe('rule-engine 进程内去重键的租户作用域', () => {
  it('同 device_id 不同 org：第二个租户的告警不被跨租户抑制', async () => {
    const { service } = makeHarness();
    const first = await service.evaluate({
      deviceId: 'exo-9',
      batteryPct: 5,
      orgId: 'org-a',
      sourceType: 'real',
      recordId: 'r1',
    });
    const second = await service.evaluate({
      deviceId: 'exo-9',
      batteryPct: 5,
      orgId: 'org-b',
      sourceType: 'real',
      recordId: 'r2',
    });
    expect(first).toBe(1);
    expect(second).toBe(1);
  });

  it('同 org 30s 窗口内重复遥测：进程内去重仍然生效（不回归）', async () => {
    const { service, inserted } = makeHarness();
    await service.evaluate({
      deviceId: 'exo-9',
      batteryPct: 5,
      orgId: 'org-a',
      sourceType: 'real',
      recordId: 'r1',
    });
    const again = await service.evaluate({
      deviceId: 'exo-9',
      batteryPct: 5,
      orgId: 'org-a',
      sourceType: 'real',
      recordId: 'r2',
    });
    expect(again).toBe(0);
    // 仅首帧落库（ewoh_event + ewoh_event_chain 各一行），重复帧不写。
    expect(inserted).toHaveLength(2);
  });

  it('无 org（legacy/sim 路径）与有 org 互不抑制', async () => {
    const { service } = makeHarness();
    const legacy = await service.evaluate({
      deviceId: 'exo-9',
      batteryPct: 5,
      sourceType: 'simulated',
      recordId: 'r1',
    });
    const scoped = await service.evaluate({
      deviceId: 'exo-9',
      batteryPct: 5,
      orgId: 'org-a',
      sourceType: 'real',
      recordId: 'r2',
    });
    expect(legacy).toBe(1);
    expect(scoped).toBe(1);
  });
});
