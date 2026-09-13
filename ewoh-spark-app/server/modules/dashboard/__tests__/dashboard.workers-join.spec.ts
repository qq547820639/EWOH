/* DashboardService.getWorkers 回归测试（NEST 跟进）。
 *
 * 缺陷：遥测 1 小时窗过滤（gte(ewoh_telemetry.ts, now()-1h)）被放在 **WHERE**
 * 而不是 LEFT JOIN 的 **ON** 里——对左表行，NULL.ts >= … 恒 NULL，行被过滤，
 * LEFT JOIN 退化成 INNER JOIN：最近 1 小时没有遥测的设备（离线/停报）从
 * "人员负荷"看板整行消失，而不是以 avgLoad=0/telemetryCount=0 如实呈现
 * （服务里 coalesce(...,0) 与 telemetryCount 字段本身证明了"保留零遥测行"的原意）。
 *
 * 断言方式：fake db 捕获 join ON 与 WHERE 的 drizzle 条件，经 PgDialect
 * 反序列化为 SQL 文本检查谓词落点（不依赖真实 PG）。
 */
/// <reference types="jest" />
import { PgDialect } from 'drizzle-orm/pg-core';
import type { SQL } from 'drizzle-orm';
import { DashboardService } from '../dashboard.service';

const ORG_A = 'org-a';

function createDb() {
  const captured: { joinOn: SQL[]; wheres: SQL[] } = { joinOn: [], wheres: [] };
  const rows: Array<Record<string, unknown>> = [];
  // getWorkers 链：select(...).from(device).leftJoin(telemetry, on).where(w).groupBy(...)
  const db = {
    select: jest.fn(() => ({
      from: jest.fn(() => ({
        leftJoin: jest.fn((_table: unknown, on: SQL) => {
          captured.joinOn.push(on);
          return {
            where: jest.fn((w: SQL | undefined) => {
              if (w) captured.wheres.push(w);
              return {
                groupBy: jest.fn(async () => rows),
              };
            }),
          };
        }),
      })),
    })),
  };
  const service = new DashboardService(db as never, { appendAuditLog: jest.fn() } as never);
  return { captured, service };
}

function toSql(dialect: PgDialect, cond: SQL | undefined): string {
  return cond ? dialect.sqlToQuery(cond).sql : '';
}

describe('DashboardService.getWorkers（遥测时间窗必须落在 JOIN ON，而非 WHERE）', () => {
  it('LEFT JOIN 语义保留：1h 窗在 ON 里；WHERE 不引用 ewoh_telemetry', async () => {
    const { captured, service } = createDb();
    await service.getWorkers({ userId: 'u', primaryOrgId: ORG_A } as never);
    const dialect = new PgDialect();
    expect(captured.joinOn).toHaveLength(1);
    const onSql = toSql(dialect, captured.joinOn[0]);
    // ON = device_id 相等 + 遥测时间窗（两个谓词都在 ON 里）。
    expect(onSql).toContain('"ewoh_telemetry"."device_id" = "ewoh_device"."device_id"');
    expect(onSql).toContain('"ewoh_telemetry"."ts" >= now()');
    const whereSql = captured.wheres.map((w) => toSql(dialect, w)).join(' and ');
    // WHERE 只保留租户谓词——不再出现遥测列（否则 LEFT JOIN 退化为 INNER JOIN）。
    expect(whereSql).not.toContain('ewoh_telemetry');
    expect(whereSql).toContain('org_id');
  });
});
