import { BadRequestException } from '@nestjs/common';
import { WorkbenchNowService } from '../../../server/modules/dashboard/workbench-now.service';

/**
 * 回归护栏（2026-09-13）：`/api/dashboard/now` 首版有两个"读不到就静默降级"的缺陷——
 *   1. severity 取自 `evidence_json->>'severity'`（规则引擎从不写该字段）→ 恒为 medium，
 *      critical 优先级 1 永不生效；
 *   2. event_type 过滤里 `QualityFindingCreated` 不是目录内类型（实为 QualityFindingDetected），
 *      且漏掉规则引擎实际产生的 4 类异常 → 面板几乎恒空。
 * 这两类缺陷都不会报错，只会"看起来没数据"，因此必须用测试钉住 SQL 文本与优先级映射。
 */
describe('WorkbenchNowService', () => {
  function makeDb(anomalyRows: unknown[], notificationRows: unknown[]) {
    const calls: string[] = [];
    const execute = jest
      .fn()
      .mockImplementationOnce(async (query) => {
        calls.push(JSON.stringify(query));
        return anomalyRows;
      })
      .mockImplementationOnce(async (query) => {
        calls.push(JSON.stringify(query));
        return notificationRows;
      });
    return { db: { execute }, calls };
  }

  it('拒绝缺少租户上下文的调用（不静默返回空列表）', async () => {
    const { db } = makeDb([], []);
    const service = new WorkbenchNowService(db as never);
    await expect(service.getNow(undefined)).rejects.toBeInstanceOf(BadRequestException);
  });

  it('按 severity 列排优先级：critical=1 / high=2，并输出真实严重度', async () => {
    const { db } = makeDb(
      [
        {
          event_id: 'EVT-H',
          title: '设备离线',
          device_id: 'EXO-104',
          severity: 'high',
          created_at: '2026-09-13T01:00:00.000Z',
        },
        {
          event_id: 'EVT-C',
          title: '负载峰值',
          device_id: 'EXO-106',
          severity: 'critical',
          created_at: '2026-09-13T02:00:00.000Z',
        },
      ],
      [],
    );
    const service = new WorkbenchNowService(db as never);
    const result = await service.getNow({ primaryOrgId: 'org-1' } as never);

    expect(result.items.map((i) => i.ref)).toEqual(['EVT-C', 'EVT-H']);
    expect(result.items[0].priority).toBe(1);
    expect(result.items[0].severity).toBe('critical');
    expect(result.items[1].priority).toBe(2);
    expect(result.items[1].severity).toBe('high');
  });

  it('异常查询读 severity/device_id 列而非 evidence_json，且类型白名单取自事件目录', async () => {
    const { db, calls } = makeDb(
      [{ event_id: 'EVT-1', title: 't', device_id: 'EXO-1', severity: 'critical', created_at: 'd' }],
      [],
    );
    const service = new WorkbenchNowService(db as never);
    await service.getNow({ primaryOrgId: 'org-1' } as never);

    const anomalySql = calls[0];
    expect(anomalySql).not.toContain("evidence_json->>'severity'");
    for (const eventType of [
      'AndonRaised',
      'DeviceOffline',
      'QualityFindingDetected',
      'DeviceLowBattery',
      'WorkerHighLoad',
      'WorkerPostureRisk',
      'DataDegraded',
    ]) {
      expect(anomalySql).toContain(eventType);
    }
    // 目录里不存在的类型名不得出现
    expect(anomalySql).not.toContain('QualityFindingCreated');
  });
});
