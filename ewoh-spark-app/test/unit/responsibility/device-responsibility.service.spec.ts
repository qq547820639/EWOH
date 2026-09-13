/* 设备责任人服务（NO-49a）。
 *
 * 钉死：设备必须在本租户台账（否则 404，不建影子设备）；同一职责换人 = 旧行停用 + 新行启用
 * （历史保留、审计留痕）；同人重复设置幂等；收回不存在 → 409；org 缺失显式 400；
 * 提醒收件人解析 = 责任人（点名到人）+ **无账号绑定如实报缺口**（受控函数反查账号）。
 */
/// <reference types="jest" />
import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';
import { ewohDevice, ewohDeviceResponsibility, ewohShift } from '@server/database/schema';
import { DeviceResponsibilityService } from '../../../server/modules/responsibility/device-responsibility.service';
import { makeConditionMatcher } from '../../helpers/drizzle-fake-matcher';

const ORG = '11111111-1111-4111-8111-111111111111';
const ACTOR = { userId: 'lead.chen', primaryOrgId: ORG, roles: ['workshop_lead'] } as never;

function createHarness(
  options: {
    deviceInLedger?: boolean;
    /** 台账里存在的设备号（默认只有 EXO-1）。 */
    devices?: string[];
    accounts?: Array<{ username: string; person_id: string }>;
    /** 在 UPDATE 真正执行前触发一次（模拟"读过之后、写之前被别人改掉"的并发窗口）。 */
    beforeUpdate?: () => void;
    /** NO-52a：一条责任关系都没登记的设备（coverage 的 uncovered 计数）。 */
    uncoveredDevices?: Array<{ device_id: string }>;
  } = {},
) {
  const rows: Array<Record<string, unknown>> = [];
  const audits: Array<Record<string, unknown>> = [];
  let nextId = 1;
  const matches = makeConditionMatcher({
    id: 'id',
    org_id: 'orgId',
    device_id: 'deviceId',
    person_id: 'personId',
    responsibility: 'responsibility',
    // NO-51a：班次维度也是查询条件的一部分（漏映射会让条件静默失效）
    shift_id: 'shiftId',
    active: 'active',
  });
  const ledgerDeviceIds = options.devices ?? (options.deviceInLedger === false ? [] : ['EXO-1']);
  const rowsForTable = (table: unknown) =>
    table === ewohDevice
      ? ledgerDeviceIds.map((deviceId, index) => ({ id: `dev-${index + 1}`, orgId: ORG, deviceId }))
      : rows;
  const db = {
    select: () => ({
      from: (table: unknown) => ({
        where: (cond: unknown) => ({
          limit: async () => rowsForTable(table).filter((r) => matches(cond, r)),
        }),
      }),
    }),
    insert: (table: unknown) => ({
      values: (row: Record<string, unknown>) => ({
        returning: async () => {
          const stored = { id: `row-${nextId++}`, active: true, ...row };
          if (table === ewohDeviceResponsibility) rows.push(stored);
          return [stored];
        },
      }),
    }),
    // `where()` 的返回值既要支持 `.returning()`，也要**可 await**：
    // 真实 drizzle 的 builder 是可 thenable 的，若替身只提供 returning，
    // "忘记链 returning 的写操作"会在测试里静默变成空操作（实测踩过）。
    update: (table: unknown) => ({
      set: (patch: Record<string, unknown>) => ({
        where: (cond: unknown) => {
          const run = async () => {
            if (options.beforeUpdate) {
              const hook = options.beforeUpdate;
              options.beforeUpdate = undefined;
              hook();
            }
            const hit = rowsForTable(table).filter((r) => matches(cond, r));
            for (const r of hit) Object.assign(r, patch);
            return hit.map((r) => ({ ...r }));
          };
          return {
            returning: run,
            then: (resolve: (value: unknown) => void) => resolve(run()),
          };
        },
      }),
    }),
    execute: jest.fn(async (query: unknown) => {
      // 两条原始 SQL：person→账号反查 / 无责任关系设备清单
      const text = JSON.stringify(query ?? {});
      if (text.includes('ewoh_device_responsibility')) return options.uncoveredDevices ?? [];
      return options.accounts ?? [];
    }),
    transaction: jest.fn(async (fn: (tx: unknown) => Promise<unknown>) => fn(db)),
  };
  const audit = {
    appendAuditLog: jest.fn(async (entry: Record<string, unknown>) => {
      audits.push(entry);
    }),
  };
  /**
   * NO-51a：当前班次判定改为"读班次表 + 共享纯函数 resolveShiftAt"（避免模块环）。
   * 这里通过 db select 返回班次行；默认返回空 → 班次未知（只按全天兜底）。
   */
  const shiftRows: Array<Record<string, unknown>> = [];
  const dbWithShifts = {
    ...db,
    select: jest.fn((...args: unknown[]) => {
      const base = (db as { select: (...a: unknown[]) => unknown }).select(...args);
      return {
        from: (table: unknown) => {
          if (table === ewohShift) {
            return { where: () => ({ limit: async () => shiftRows }) };
          }
          return (base as { from: (t: unknown) => unknown }).from(table);
        },
      };
    }),
  };
  const service = new DeviceResponsibilityService(dbWithShifts as never, audit as never);
  return { service, rows, audits, db: dbWithShifts, shifts: { rows: shiftRows } };
}

describe('DeviceResponsibilityService（NO-49a）', () => {
  it('org 缺失 → 400（不跨租户写）', async () => {
    const { service } = createHarness();
    await expect(
      service.setResponsibility('', { deviceId: 'EXO-1', personId: 'p1', responsibility: 'owner' }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('设备不在本租户台账 → 404（不建影子设备）', async () => {
    const { service } = createHarness({ deviceInLedger: false });
    await expect(
      service.setResponsibility(ORG, { deviceId: 'NOT-IN-LEDGER', personId: 'p1', responsibility: 'owner' }),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('非法职责 → 400（封闭词表）', async () => {
    const { service } = createHarness();
    await expect(
      service.setResponsibility(ORG, { deviceId: 'EXO-1', personId: 'p1', responsibility: 'chief' }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('首次设置：写入规范人员身份（person:<uuid>）+ 审计留痕', async () => {
    const { service, rows, audits } = createHarness();
    const record = await service.setResponsibility(
      ORG,
      { deviceId: 'EXO-1', personId: '63000000-0000-4000-8000-000000000001', responsibility: 'owner' },
      ACTOR,
    );
    expect(record).toMatchObject({
      deviceId: 'EXO-1',
      personId: 'person:63000000-0000-4000-8000-000000000001',
      responsibility: 'owner',
      active: true,
    });
    expect(rows).toHaveLength(1);
    expect(audits[0]).toMatchObject({
      action: 'device.responsibility.set',
      entityId: 'EXO-1',
      before: { personId: null, active: false },
      after: { responsibility: 'owner', personId: 'person:63000000-0000-4000-8000-000000000001' },
    });
  });

  it('同人重复设置同一职责 → 幂等（不产生新历史行、不写多余审计）', async () => {
    const { service, rows, audits } = createHarness();
    await service.setResponsibility(ORG, { deviceId: 'EXO-1', personId: 'p1', responsibility: 'owner' }, ACTOR);
    await service.setResponsibility(ORG, { deviceId: 'EXO-1', personId: 'person:p1', responsibility: 'owner' }, ACTOR);
    expect(rows).toHaveLength(1);
    expect(audits).toHaveLength(1);
  });

  it('换人：旧行置 active=false（带停用时间）+ 新行启用（历史保留）', async () => {
    const { service, rows } = createHarness();
    await service.setResponsibility(ORG, { deviceId: 'EXO-1', personId: 'p1', responsibility: 'owner' }, ACTOR);
    await service.setResponsibility(ORG, { deviceId: 'EXO-1', personId: 'p2', responsibility: 'owner' }, ACTOR);
    expect(rows).toHaveLength(2);
    const deactivated = rows.find((r) => r.personId === 'person:p1');
    const active = rows.find((r) => r.personId === 'person:p2');
    expect(deactivated).toMatchObject({ active: false, deactivatedBy: 'lead.chen' });
    expect(deactivated?.deactivatedAt).toBeInstanceOf(Date);
    expect(active).toMatchObject({ active: true });
    // 不同职责互不影响（owner 与 operator 各自一位）
    await service.setResponsibility(ORG, { deviceId: 'EXO-1', personId: 'p3', responsibility: 'operator' }, ACTOR);
    expect(rows.filter((r) => r.active === true)).toHaveLength(2);
  });

  it('收回不存在的职责 → 409（不静默当成功）', async () => {
    const { service } = createHarness();
    await expect(
      service.clearResponsibility(ORG, { deviceId: 'EXO-1', responsibility: 'maintainer' }, ACTOR),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  it('收回：停用当前 active 行 + 审计', async () => {
    const { service, rows, audits } = createHarness();
    await service.setResponsibility(ORG, { deviceId: 'EXO-1', personId: 'p1', responsibility: 'owner' }, ACTOR);
    const result = await service.clearResponsibility(ORG, { deviceId: 'EXO-1', responsibility: 'owner' }, ACTOR);
    expect(result).toMatchObject({ cleared: true, deviceId: 'EXO-1', responsibility: 'owner' });
    expect(rows[0]).toMatchObject({ active: false });
    expect(audits.map((a) => a.action)).toEqual([
      'device.responsibility.set',
      'device.responsibility.clear',
    ]);
  });

  it('提醒收件人解析：责任人已绑定账号 → 点名到人（按账号稳定排序）', async () => {
    const { service } = createHarness({
      accounts: [
        { username: 'worker.zhangwei', person_id: 'p1' },
        { username: 'worker.li', person_id: 'p2' },
      ],
    });
    await service.setResponsibility(ORG, { deviceId: 'EXO-1', personId: 'p1', responsibility: 'owner' });
    await service.setResponsibility(ORG, { deviceId: 'EXO-1', personId: 'p2', responsibility: 'operator' });
    const plan = await service.resolveAlertRecipients(ORG, 'EXO-1');
    expect(plan.dedupedUserIds).toEqual(['worker.li', 'worker.zhangwei']);
    expect(plan.unresolved).toEqual([]);
    expect(plan.uncovered).toBe(false);
  });

  it('提醒收件人解析：责任人没有绑定账号 → 如实报缺口（不假装通知到了）', async () => {
    const { service } = createHarness({ accounts: [{ username: 'worker.zhangwei', person_id: 'p1' }] });
    await service.setResponsibility(ORG, { deviceId: 'EXO-1', personId: 'p1', responsibility: 'owner' });
    await service.setResponsibility(ORG, { deviceId: 'EXO-1', personId: 'p9', responsibility: 'maintainer' });
    const plan = await service.resolveAlertRecipients(ORG, 'EXO-1');
    expect(plan.dedupedUserIds).toEqual(['worker.zhangwei']);
    expect(plan.unresolved).toEqual([{ personId: 'person:p9', responsibility: 'maintainer' }]);
  });

  it('没有登记责任关系 → uncovered（提醒走角色兜底）', async () => {
    const { service } = createHarness();
    const plan = await service.resolveAlertRecipients(ORG, 'EXO-1');
    expect(plan).toMatchObject({ dedupedUserIds: [], unresolved: [], uncovered: true });
  });

  it('缺少 org/设备号时解析不抛错、返回 uncovered（提醒侧不因缺数据而 500）', async () => {
    const { service } = createHarness();
    expect(await service.resolveAlertRecipients('', 'EXO-1')).toMatchObject({ uncovered: true });
    expect(await service.resolveAlertRecipients(ORG, '')).toMatchObject({ uncovered: true });
  });
});

describe('DeviceResponsibilityService · 并发与缺口（NO-49a）', () => {
  it('并发换人：读过之后旧行被别人停用 → CAS 未命中即 409（不静默继续、不产生双 active）', async () => {
    let harness: ReturnType<typeof createHarness> | null = null;
    harness = createHarness({
      // 模拟并发窗口：SELECT 已经读到旧行，UPDATE 之前旧行被别的请求停用
      beforeUpdate: () => {
        const row = harness?.rows[0];
        if (row) {
          row.active = false;
          row.deactivatedAt = new Date();
        }
      },
    });
    const { service, rows, db } = harness;
    await service.setResponsibility(ORG, { deviceId: 'EXO-1', personId: 'p1', responsibility: 'owner' }, ACTOR);
    await expect(
      service.setResponsibility(ORG, { deviceId: 'EXO-1', personId: 'p2', responsibility: 'owner' }, ACTOR),
    ).rejects.toBeInstanceOf(ConflictException);
    // 没有产生第二位 active 责任人
    expect(rows.filter((r) => r.active === true)).toHaveLength(0);
    expect(db.transaction).toHaveBeenCalled();
  });
});

/* ── NO-51a：班次责任人（本班优先、全天兜底、他班缺口）────────────────── */

describe('DeviceResponsibilityService · 班次维度（NO-51a）', () => {
  it('set 带 shiftId：同一职责的"本班"与"全天"是两条独立责任关系', async () => {
    const { service, rows } = createHarness();
    await service.setResponsibility(
      ORG,
      { deviceId: 'EXO-1', personId: 'pAll', responsibility: 'owner' },
      ACTOR,
    );
    await service.setResponsibility(
      ORG,
      { deviceId: 'EXO-1', personId: 'pA', responsibility: 'owner', shiftId: 'SHIFT-A' },
      ACTOR,
    );
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.shiftId).sort()).toEqual(['', 'SHIFT-A']);
    // 换人只影响**同一班次**那一条
    await service.setResponsibility(
      ORG,
      { deviceId: 'EXO-1', personId: 'pA2', responsibility: 'owner', shiftId: 'SHIFT-A' },
      ACTOR,
    );
    expect(rows.filter((r) => r.active === true)).toHaveLength(2);
    expect(rows.find((r) => r.personId === 'person:pA')?.active).toBe(false);
    expect(rows.find((r) => r.personId === 'person:pAll')?.active).toBe(true);
  });

  it('解析收件人：本班责任人优先，全天责任人兜底，他班只进缺口', async () => {
    const { service, shifts } = createHarness({
      accounts: [
        { username: 'worker.a', person_id: 'pA' },
        { username: 'worker.b', person_id: 'pB' },
        { username: 'lead.all', person_id: 'pAll' },
      ],
    });
    // 当前时刻落在 SHIFT-A 内（00:00–23:59 全天覆盖，避免依赖运行时刻）
    shifts.rows.push({
      shiftId: 'SHIFT-A', name: '白班', code: 'A', startTime: '00:00', endTime: '23:59',
      crossesMidnight: false, active: true,
    });
    await service.setResponsibility(ORG, { deviceId: 'EXO-1', personId: 'pA', responsibility: 'owner', shiftId: 'SHIFT-A' });
    await service.setResponsibility(ORG, { deviceId: 'EXO-1', personId: 'pB', responsibility: 'owner', shiftId: 'SHIFT-B' });
    await service.setResponsibility(ORG, { deviceId: 'EXO-1', personId: 'pAll', responsibility: 'maintainer' });

    const plan = await service.resolveAlertRecipients(ORG, 'EXO-1');
    expect(plan.shiftId).toBe('SHIFT-A');
    expect(plan.shiftUnknown).toBe(false);
    expect(plan.dedupedUserIds).toEqual(['lead.all', 'worker.a']);
    expect(plan.users.find((u) => u.recipientId === 'worker.a')?.matchedBy).toBe('current_shift');
    expect(plan.outOfShift).toEqual([{ personId: 'person:pB', responsibility: 'owner', shiftId: 'SHIFT-B' }]);
  });

  it('当前班次解析失败/不在任何班次内 → 只按全天兜底且 shiftUnknown=true（不猜默认班）', async () => {
    const { service } = createHarness({ accounts: [{ username: 'worker.a', person_id: 'pA' }] });
    await service.setResponsibility(ORG, { deviceId: 'EXO-1', personId: 'pA', responsibility: 'owner', shiftId: 'SHIFT-A' });
    const plan = await service.resolveAlertRecipients(ORG, 'EXO-1');
    expect(plan.shiftId).toBeNull();
    expect(plan.shiftUnknown).toBe(true);
    expect(plan.dedupedUserIds).toEqual([]);
    expect(plan.uncovered).toBe(true);
    expect(plan.outOfShift.map((o) => o.personId)).toEqual(['person:pA']);
  });

  it('班次域抛错不阻塞提醒（按全天兜底并标注 shiftUnknown）', async () => {
    const { service, shifts } = createHarness({ accounts: [{ username: 'lead.all', person_id: 'pAll' }] });
    // 班次行缺 startTime/endTime → resolveShiftAt 不匹配任何班次（等价"班次不可用/未知"）
    shifts.rows.push({ shiftId: 'BROKEN', name: '坏班次', startTime: '', endTime: '', crossesMidnight: false, active: true });
    await service.setResponsibility(ORG, { deviceId: 'EXO-1', personId: 'pAll', responsibility: 'owner' });
    const plan = await service.resolveAlertRecipients(ORG, 'EXO-1');
    expect(plan.shiftUnknown).toBe(true);
    expect(plan.dedupedUserIds).toEqual(['lead.all']);
  });
});

/* ── NO-52a：交接班前的责任人核对（coverage）──────────────────────────── */

describe('DeviceResponsibilityService · 责任人核对（NO-52a）', () => {
  it('给定班次：本班/全天算覆盖，只有他班算缺口；缺 agent 设备单列 uncovered', async () => {
    const { service } = createHarness({
      devices: ['EXO-1', 'EXO-2', 'EXO-3'],
      uncoveredDevices: [{ device_id: 'CAM-1' }, { device_id: 'CAM-2' }],
    });
    await service.setResponsibility(ORG, { deviceId: 'EXO-1', personId: 'pDay', responsibility: 'owner', shiftId: 'SHIFT-DAY' });
    await service.setResponsibility(ORG, { deviceId: 'EXO-2', personId: 'pAll', responsibility: 'owner' });
    await service.setResponsibility(ORG, { deviceId: 'EXO-3', personId: 'pNight', responsibility: 'owner', shiftId: 'SHIFT-NIGHT' });

    const snapshot = await service.coverageForShift(ORG, { shiftId: 'SHIFT-DAY' });
    expect(snapshot).toMatchObject({
      shiftId: 'SHIFT-DAY',
      shiftUnknown: false,
      total: 3,
      covered: 2,
      gaps: 1,
      uncovered: 2,
    });
    // 缺口设备排最前（交接时要先看到它）
    expect(snapshot.devices[0]?.deviceId).toBe('EXO-3');
    expect(snapshot.devices[0]?.outOfShift.map((o) => o.shiftId)).toEqual(['SHIFT-NIGHT']);
    expect(snapshot.notes.join('')).toContain('不要求已绑定登录账号');
  });

  it('不传 shiftId → 按当前班次判定；班次表为空则如实标注 shiftUnknown', async () => {
    const { service } = createHarness();
    await service.setResponsibility(ORG, { deviceId: 'EXO-1', personId: 'pDay', responsibility: 'owner', shiftId: 'SHIFT-DAY' });
    const snapshot = await service.coverageForShift(ORG, {});
    expect(snapshot.shiftUnknown).toBe(true);
    expect(snapshot.covered).toBe(0);
    expect(snapshot.gaps).toBe(1);
  });

  it('缺 org 上下文 → 400（不跨租户核对）', async () => {
    const { service } = createHarness();
    await expect(service.coverageForShift('')).rejects.toBeInstanceOf(BadRequestException);
  });
});
