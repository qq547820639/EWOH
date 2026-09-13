/* 数据质量人工确认契约测试（standalone_076，DR-4 闭环第②步）：
 * verdict 词表 + 判定人必填（服务端会话语义）+ 时间合法。 */
import {
  validateDataQualityConfirmation,
  type DataQualityConfirmation,
} from '../../../shared/data-quality-confirmation';
import { ewohDataQualityConfirmation, ewohNotification } from '@server/database/schema';
import { DataQualityService } from '../../../server/modules/data-quality/data-quality.service';
import { makeConditionMatcher } from '../../helpers/drizzle-fake-matcher';

function base(): DataQualityConfirmation {
  return {
    eventId: 'EVT-1',
    verdict: 'confirmed',
    confirmedBy: 'user-1',
    confirmedAt: '2026-09-11T08:30:00Z',
  };
}

describe('validateDataQualityConfirmation', () => {
  it('合法确认（confirmed / contested）通过', () => {
    expect(validateDataQualityConfirmation(base())).toEqual([]);
    expect(validateDataQualityConfirmation({ ...base(), verdict: 'contested' })).toEqual([]);
  });

  it('verdict 词表外值 fail-closed（不收 maybe/unknown）', () => {
    expect(
      validateDataQualityConfirmation({ ...base(), verdict: 'maybe' as never }),
    ).toEqual(['unknown_verdict']);
  });

  it('判定人缺失被拒绝（判定事实完整）', () => {
    expect(
      validateDataQualityConfirmation({ ...base(), confirmedBy: '' }),
    ).toEqual(['judger_required']);
  });

  it('事件 id / 时间非法被拒绝', () => {
    expect(validateDataQualityConfirmation({ ...base(), eventId: '' })).toEqual(['bad_event_id']);
    expect(
      validateDataQualityConfirmation({ ...base(), confirmedAt: 'not-a-time' }),
    ).toEqual(['bad_confirmed_at']);
  });

  it('note 非字符串被拒绝（可选字段仍需类型正确）', () => {
    expect(
      validateDataQualityConfirmation({ ...base(), note: 42 as never }),
    ).toEqual(['bad_note']);
  });
});

/* ── NO-53a：人工判定 → "待核实提醒"处置终态（同事务）──────────────────── */

describe('数据质量判定与提醒终态（NO-53a）', () => {
  const ORG = '11111111-1111-4111-8111-111111111111';
  const ACTOR = { userId: 'lead.chen', primaryOrgId: ORG, roles: ['workshop_lead'] } as never;

  /** 假 DB：事件表（源事件 + 引用它的 open 告警）+ 确认表 + 通知表。 */
  function harness() {
    const events = [
      { eventId: 'EVT-SRC-1', eventType: 'DataQualityAlert', orgId: ORG, status: 'open', evidenceJson: { sourceEventId: 'EVT-SRC-1' }, deviceId: 'EXO-1', createdAt: new Date(), title: 't', severity: 'high' },
    ];
    const confirmations: Array<Record<string, unknown>> = [];
    const notifications = [
      { notificationId: 'NTF-DQ-EVT-SRC-1-quality_alert-role-workshop_lead-app', orgId: ORG, externalRef: 'EVT-SRC-1', status: 'pending', resolution: null },
    ];
    let nextId = 1;
    const matches = makeConditionMatcher({
      id: 'id', org_id: 'orgId', event_id: 'eventId', external_ref: 'externalRef',
      notification_id: 'notificationId', event_type: 'eventType', status: 'status',
      resolution: 'resolution',
    });
    const rowsFor = (table: unknown) =>
      table === ewohDataQualityConfirmation ? confirmations : table === ewohNotification ? notifications : events;
    const db = {
      select: () => ({
        from: (table: unknown) => ({
          where: (cond: unknown) => ({
            limit: async () => rowsFor(table).filter((r) => matches(cond, r)),
          }),
        }),
      }),
      insert: (table: unknown) => ({
        values: (row: Record<string, unknown>) => ({
          returning: async () => {
            const stored = { id: `row-${nextId++}`, ...row };
            if (table === ewohDataQualityConfirmation) confirmations.push(stored);
            return [stored];
          },
        }),
      }),
      update: (table: unknown) => ({
        set: (patch: Record<string, unknown>) => ({
          where: (cond: unknown) => ({
            returning: async () => {
              const hit = rowsFor(table).filter((r) => matches(cond, r));
              for (const r of hit) Object.assign(r, patch);
              return hit.map((r) => ({ ...r }));
            },
          }),
        }),
      }),
      transaction: async (fn: (tx: unknown) => Promise<unknown>) => fn(db),
    };
    const audit = { appendAuditLog: jest.fn(async () => undefined) };
    const transitionAlert = jest.fn(async () => ({ eventId: 'x', status: 'resolved' }));
    const service = new DataQualityService(db as never, audit as never, { transitionAlert } as never);
    return { service, notifications, confirmations, transitionAlert };
  }

  it('confirm=confirmed → 同源告警的"待核实提醒"落在 data_quality_confirmed', async () => {
    const { service, notifications } = harness();
    const result = (await service.confirm({ eventId: 'EVT-SRC-1', verdict: 'confirmed', note: '现场核对无误' }, ACTOR)) as {
      resolvedNotificationCount: number;
    };
    expect(result.resolvedNotificationCount).toBeGreaterThanOrEqual(1);
    expect(notifications[0]).toMatchObject({
      status: 'resolved',
      resolution: 'data_quality_confirmed',
      resolvedBy: 'lead.chen',
      resolutionRef: 'EVT-SRC-1',
    });
  });

  it('confirm=contested → 处置码区分"数据不可信"（不是"没事"）', async () => {
    const { service, notifications } = harness();
    await service.confirm({ eventId: 'EVT-SRC-1', verdict: 'contested', note: '读数明显异常' }, ACTOR);
    expect(notifications[0]).toMatchObject({ status: 'resolved', resolution: 'data_quality_contested' });
  });

  it('幂等：重复判定不重复处置（已终态不覆盖第一次依据）', async () => {
    const { service, notifications } = harness();
    await service.confirm({ eventId: 'EVT-SRC-1', verdict: 'confirmed' }, ACTOR);
    const second = (await service.confirm({ eventId: 'EVT-SRC-1', verdict: 'contested' }, ACTOR)) as {
      resolvedNotificationCount: number;
    };
    // 第二次是改判：确认行被覆盖，但提醒已是终态 → 不再产生处置动作
    expect(second.resolvedNotificationCount).toBe(0);
    expect(notifications[0]).toMatchObject({ resolution: 'data_quality_confirmed' });
  });
});

/* ── NO-53a：confirmed 必须了结"人直接判定的那条告警" ─────────────────── */

describe('confirmed 的告警了结口径（NO-53a）', () => {
  const ORG = '22222222-2222-4222-8222-222222222222';
  const ACTOR = { userId: 'lead.chen', primaryOrgId: ORG, roles: ['workshop_lead'] } as never;

  function harness(target: Record<string, unknown>) {
    const events = [
      { eventId: 'EVT-A', eventType: 'DataQualityAlert', orgId: ORG, status: 'open', evidenceJson: {}, deviceId: 'EXO-1', createdAt: new Date(), title: 't', severity: 'high', ...target },
    ];
    const matches = makeConditionMatcher({ event_id: 'eventId', org_id: 'orgId', event_type: 'eventType', status: 'status', id: 'id' });
    const db = {
      select: () => ({
        from: () => ({
          where: (cond: unknown) => ({
            limit: async () => events.filter((r) => matches(cond, r)),
          }),
        }),
      }),
      insert: () => ({ values: () => ({ returning: async () => [{ id: 'row-1' }] }) }),
      update: () => ({ set: () => ({ where: () => ({ returning: async () => [] }) }) }),
      transaction: async (fn: (tx: unknown) => Promise<unknown>) => fn(db),
    };
    const audit = { appendAuditLog: jest.fn(async () => undefined) };
    // 假状态机：只接受 ADR-031 的合法链，跳步即抛（与真 AlertService 同样 fail-closed）
    const CHAIN: Record<string, [string, string]> = {
      acknowledge: ['open', 'acknowledged'],
      process: ['acknowledged', 'processing'],
      close: ['processing', 'closed'],
    };
    const transitionAlert = jest.fn(async (_id: string, action: string) => {
      const step = CHAIN[action];
      if (!step || events[0].status !== step[0]) {
        throw new Error(`Transition ${action} not allowed from ${events[0].status}`);
      }
      events[0].status = step[1];
      return { eventId: 'EVT-A', status: step[1] };
    });
    const service = new DataQualityService(db as never, audit as never, { transitionAlert } as never);
    return { service, transitionAlert, events };
  }

  it('人直接在告警上判定 confirmed → 该告警被了结（最短路径不残留 open）', async () => {
    const { service, transitionAlert } = harness({});
    const result = (await service.confirm({ eventId: 'EVT-A', verdict: 'confirmed' }, ACTOR)) as {
      linkedAlertsResolved: number;
    };
    expect(transitionAlert.mock.calls.map((c) => c[1])).toEqual(['acknowledge', 'process', 'close']);
    expect(result.linkedAlertsResolved).toBe(1);
  });

  it('contested → 不关告警（数据不可信必须继续可见）', async () => {
    const { service, transitionAlert } = harness({});
    await service.confirm({ eventId: 'EVT-A', verdict: 'contested' }, ACTOR);
    expect(transitionAlert).not.toHaveBeenCalled();
  });

  it('告警已 closed → 重复判定不重复 transition（幂等，不覆盖终态）', async () => {
    const { service, transitionAlert } = harness({ status: 'closed' });
    const result = (await service.confirm({ eventId: 'EVT-A', verdict: 'confirmed' }, ACTOR)) as {
      linkedAlertsResolved: number;
    };
    expect(transitionAlert).not.toHaveBeenCalled();
    expect(result.linkedAlertsResolved).toBe(0);
  });

  it('判定对象不是告警（源事件）→ 不误关自己（只有引用它的告警才联动）', async () => {
    const { service, transitionAlert } = harness({ eventType: 'ExoskeletonTelemetry' });
    const result = (await service.confirm({ eventId: 'EVT-A', verdict: 'confirmed' }, ACTOR)) as {
      linkedAlertsResolved: number;
    };
    expect(transitionAlert).not.toHaveBeenCalled();
    expect(result.linkedAlertsResolved).toBe(0);
  });
});
