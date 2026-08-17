/* v0.7 B1：ingest 设备故障/离线转换 → DEVICE_OFFLINE 重排触发逻辑测试
 * 覆盖纯函数 IngestService.isFaultTransition：
 *   - 正常 → 携带故障码：转换发生（触发重排）
 *   - 已有故障码：不重复触发
 *   - 离线状态恢复（无故障码）：不触发
 *   - 首次接入（无既有行）：不触发
 */
/// <reference types="jest" />
import { IngestService } from '../ingest.service';

describe('v0.7 B1: isFaultTransition（设备离线转换判定）', () => {
  it('此前正常（无故障码且在线）+ 新帧带故障码 → 转换发生', () => {
    expect(IngestService.isFaultTransition(null, true, 'E1001')).toBe(true);
    expect(IngestService.isFaultTransition('', 1, 'E1001')).toBe(true);
  });

  it('此前已有故障码 + 新帧带故障码 → 不重复触发', () => {
    expect(IngestService.isFaultTransition('E1001', true, 'E1001')).toBe(false);
    expect(IngestService.isFaultTransition('E1001', false, 'E1002')).toBe(false);
  });

  it('此前在线但新帧无故障码 → 不触发', () => {
    expect(IngestService.isFaultTransition(null, true, null)).toBe(false);
    expect(IngestService.isFaultTransition(null, true, '')).toBe(false);
  });

  it('此前离线（online=false）→ 即使新帧带故障码也不视为"转换"（已离线）', () => {
    expect(IngestService.isFaultTransition(null, false, 'E1001')).toBe(false);
    expect(IngestService.isFaultTransition('', 0, 'E1001')).toBe(false);
  });

  it('首次接入（无既有行 → faultCode undefined / online undefined）→ 不触发', () => {
    expect(IngestService.isFaultTransition(undefined, undefined, 'E1001')).toBe(false);
  });
});

/* NEST-228：detectFaultTransition 的 DB 查询路径 + DEVICE_OFFLINE 重排触发。
 * fake db 侦测 ewohDevice select where；replanCoordinator 侦测 handleTrigger
 * 仅在“此前正常 + 新故障码”时被调用（fail-closed：查询异常不触发、不阻断）。
 */
describe('v0.7 B1: detectFaultTransition（DB 路径 + replan 触发）', () => {
  const ORG_CTX = {
    userId: 'ingest',
    primaryOrgId: 'org-1',
    accessibleOrgIds: ['org-1'],
    isGlobalAdmin: false,
  };

  function makeHarness(existingRow: Record<string, unknown> | null) {
    const handleTrigger = jest.fn().mockResolvedValue({ runId: 'run-1' });
    const rows = existingRow ? [existingRow] : [];
    // drizzle select().from().where().limit() 形态的链式 fake。
    const selectWhere = jest.fn(() => ({
      limit: jest.fn().mockResolvedValue(rows),
    }));
    const db = {
      select: jest.fn(() => ({
        from: jest.fn(() => ({ where: selectWhere })),
      })),
    };
    const service = new IngestService(
      db as never,
      {} as never,
      {} as never,
      {} as never,
      { handleTrigger } as never,
      {} as never,
    );
    return { service, handleTrigger, selectWhere };
  }

  it('此前正常 + 新故障码 → 查询既有状态并触发 DEVICE_OFFLINE 重排（带 org ctx）', async () => {
    const { service, handleTrigger } = makeHarness({ faultCode: null, online: true });
    await (service as unknown as {
      detectFaultTransition: (d: string, f: string, c: unknown) => Promise<void>;
    }).detectFaultTransition('exo-1', 'E1001', ORG_CTX);
    // fire-and-forget：flush 微任务队列后断言重排已被调用。
    await new Promise((resolve) => setImmediate(resolve));
    expect(handleTrigger).toHaveBeenCalledWith('DEVICE_OFFLINE', 'exo-1', ORG_CTX);
  });

  it('已有故障码 → 不触发重排', async () => {
    const { service, handleTrigger } = makeHarness({ faultCode: 'E1000', online: true });
    await (service as unknown as {
      detectFaultTransition: (d: string, f: string, c: unknown) => Promise<void>;
    }).detectFaultTransition('exo-1', 'E1002', ORG_CTX);
    await new Promise((resolve) => setImmediate(resolve));
    expect(handleTrigger).not.toHaveBeenCalled();
  });

  it('无既有行（首次接入）→ 不触发重排', async () => {
    const { service, handleTrigger } = makeHarness(null);
    await (service as unknown as {
      detectFaultTransition: (d: string, f: string, c: unknown) => Promise<void>;
    }).detectFaultTransition('exo-1', 'E1001', ORG_CTX);
    await new Promise((resolve) => setImmediate(resolve));
    expect(handleTrigger).not.toHaveBeenCalled();
  });
});
