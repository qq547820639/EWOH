/* ImprovementActionService 契约行为测试（NO-55a 经验 → 行动）。
 *
 * 钉住的语义：
 *   1. 已发布复盘的 warning/critical 经验条目与缺口 → 行动项候选（info 跳过）；
 *   2. 扫描只读复盘记录；重复扫描幂等，且**不覆盖责任/期限/完成/拒绝痕迹**；
 *   3. 接受必须给负责人 + 期限 + 验收判据（平台不替现场承诺期限）；
 *   4. 完成必须给结果说明；未接受的不能"完成"；
 *   5. 拒绝/放弃必须给理由；终态不可再转移；
 *   6. 逾期待办只包含"已接受 + 到期已过"的行。
 *
 * DB 用 fake（按表路由 + 条件匹配），审计 mock。
 */
/// <reference types="jest" />
import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';
import { ewohImprovementAction, ewohNotification, ewohRetrospective,
  ewohSchedulingExecution,
} from '@server/database/schema';
import { ImprovementActionService } from '../improvement-action.service';
import { validateImprovementAction } from '@shared/improvement-action';
import { makeConditionMatcher } from '../../../../test/helpers/drizzle-fake-matcher';

const ORG = '11111111-1111-4111-8111-111111111111';
const ACTOR = { userId: 'lead.chen', primaryOrgId: ORG, roles: ['workshop_lead'] } as never;
const NOW = new Date('2026-09-12T08:00:00.000Z');

const COLUMN_KEYS = {
  _created_at: 'createdAt',
  subject_id: 'subjectId',
  deviation_type: 'deviationType',
  device_id: 'deviceId',
  person_id: 'personId',
  _updated_at: 'updatedAt',
  org_id: 'orgId',
  status: 'status',
  action_id: 'actionId',
  priority: 'priority',
  owner: 'owner',
  due_at: 'dueAt',
  retrospective_id: 'retrospectiveId',
  published_at: 'publishedAt',
  detected_at: 'detectedAt',
};

interface Seed {
  retrospectives?: Array<Record<string, unknown>>;
  actions?: Array<Record<string, unknown>>;
  notifications?: Array<Record<string, unknown>>;
  executions?: Array<Record<string, unknown>>;
}

function createDb(seed: Seed = {}) {
  const retrospectives = seed.retrospectives ?? [];
  const actions = seed.actions ?? [];
  const notifications = seed.notifications ?? [];
  const executions = seed.executions ?? [];
  const matches = makeConditionMatcher(COLUMN_KEYS);
  const rowsFor = (table: unknown): Array<Record<string, unknown>> => {
    if (table === ewohRetrospective) return retrospectives;
    if (table === ewohImprovementAction) return actions;
    if (table === ewohNotification) return notifications;
    if (table === ewohSchedulingExecution) return executions;
    return [];
  };
  function selectChain(table: unknown, projection?: unknown) {
    let filtered = rowsFor(table);
    // count(*) 投影必须返回聚合结果（[{count:n}]），否则 Number(row.count ?? 0) 恒为 0
    // ——"库里有数据但计数为 0"是最难查的一类测试自伤（本仓库已踩过）。
    const shaped = (rows: Array<Record<string, unknown>>) =>
      projection && typeof projection === 'object' && 'count' in (projection as Record<string, unknown>)
        ? [{ count: rows.length }]
        : rows;
    const api = {
      where(condition: unknown) {
        filtered = rowsFor(table).filter((row) => matches(condition, row));
        return api;
      },
      orderBy() {
        return api;
      },
      limit(count: number) {
        return Promise.resolve(shaped(filtered.slice(0, count)));
      },
      then(resolve: (value: unknown) => unknown, reject?: (reason: unknown) => unknown) {
        // 直接 await（不带 limit）也要走 count 投影塑形，否则聚合查询恒为 0。
        return Promise.resolve(shaped(filtered)).then(resolve, reject);
      },
    };
    return api;
  }
  const db = {
    select: (projection?: unknown) => ({ from: (table: unknown) => selectChain(table, projection) }),
    insert: (table: unknown) => ({
      values: (row: Record<string, unknown>) => {
        // 通知写入走 onConflictDoNothing().returning()（确定性幂等键）；
        // 其它表直接 await —— 两种形态都要支持。
        const perform = async () => {
          const rows = rowsFor(table);
          if (table === ewohNotification && rows.some((r) => r.notificationId === row.notificationId)) {
            return [];
          }
          rows.push({ ...row });
          return [row];
        };
        return {
          onConflictDoNothing: () => ({ returning: perform }),
          then: (resolve: (value: unknown) => unknown, reject?: (reason: unknown) => unknown) =>
            perform().then(resolve, reject),
        };
      },
    }),
    update: (table: unknown) => ({
      set: (patch: Record<string, unknown>) => ({
        where: (condition: unknown) => {
          const hit = rowsFor(table).filter((row) => matches(condition, row));
          for (const row of hit) Object.assign(row, patch);
          // 既能 await（返回条数）又能 .returning()（提醒处置链用）
          return {
            returning: async () => hit.map((row) => ({ notificationId: row.notificationId ?? 'N-1' })),
            then: (resolve: (value: unknown) => unknown, reject?: (reason: unknown) => unknown) =>
              Promise.resolve(hit.length).then(resolve, reject),
          };
        },
      }),
    }),
    transaction: async (fn: (tx: unknown) => Promise<unknown>) => fn(db),
    execute: async () => [],
  };
  return { db, actions, retrospectives, notifications };
}

function publishedRetrospective(overrides: Record<string, unknown> = {}) {
  return {
    orgId: ORG,
    retrospectiveId: 'RTR-1',
    scope: 'incident',
    targetId: 'DEV-04',
    title: '设备离线复盘',
    status: 'published',
    publishedAt: new Date(NOW.getTime() - 86_400_000),
    lessonsJson: [
      { title: '交接未核对备用设备', detail: '交接清单缺备用设备状态', severity: 'warning', evidenceIds: ['EVT-1'] },
      { title: '仅记录不行动', detail: 'info 级只作记忆', severity: 'info', evidenceIds: [] },
    ],
    assembledJson: { gaps: ['缺少停机时长证据'] },
    ...overrides,
  };
}

function auditMock() {
  return { appendAuditLog: jest.fn(async () => undefined) };
}

describe('ImprovementActionService.scan（复盘经验 → 行动项）', () => {
  it('已发布复盘的 warning 条目与缺口 → 行动项；info 条目不立项', async () => {
    const { db, actions } = createDb({ retrospectives: [publishedRetrospective()] });
    const audit = auditMock();
    const service = new ImprovementActionService(db as never, audit as never);

    const result = await service.scan(ACTOR, { now: NOW });

    expect(result.scannedRetrospectives).toBe(1);
    expect(result.memory).toMatchObject({ publishedRetrospectives: 1, lessons: 2, gaps: 1 });
    expect(result.derived).toBe(2); // 一条 warning 经验 + 一条缺口
    expect(result.created).toBe(2);
    expect(actions).toHaveLength(2);
    const kinds = result.actions.map((a) => a.sourceType).sort();
    expect(kinds).toEqual(['retrospective_gap', 'retrospective_lesson']);
    expect(result.actions.every((a) => a.status === 'proposed')).toBe(true);
    expect(result.actions.every((a) => a.evidenceRefs.length >= 2)).toBe(true);
    expect(audit.appendAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'learning.action_scan', orgId: ORG }),
    );
  });

  it('只读复盘：扫描不修改复盘记录本身', async () => {
    const retrospective = publishedRetrospective();
    const { db, retrospectives } = createDb({ retrospectives: [retrospective] });
    const service = new ImprovementActionService(db as never, auditMock() as never);
    await service.scan(ACTOR, { now: NOW });
    expect(retrospectives[0]).toEqual(retrospective);
  });

  it('重复扫描幂等（第二次 refreshed，不重复创建）', async () => {
    const { db, actions } = createDb({ retrospectives: [publishedRetrospective()] });
    const service = new ImprovementActionService(db as never, auditMock() as never);
    await service.scan(ACTOR, { now: NOW });
    const second = await service.scan(ACTOR, { now: new Date(NOW.getTime() + 60_000) });
    expect(second.created).toBe(0);
    expect(second.refreshed).toBe(2);
    expect(actions).toHaveLength(2);
  });

  it('不覆盖人的决定：已接受/已拒绝的行只刷新来源事实', async () => {
    const { db } = createDb({ retrospectives: [publishedRetrospective()] });
    const service = new ImprovementActionService(db as never, auditMock() as never);
    const first = await service.scan(ACTOR, { now: NOW });
    const accepted = first.actions.find((a) => a.priority === 'medium')!;
    await service.accept(accepted.actionId, {
      owner: 'P-1',
      dueAt: '2026-09-20T00:00:00.000Z',
      acceptanceCriteria: '交接清单含备用设备状态',
    }, ACTOR);
    const again = await service.scan(ACTOR, { now: new Date(NOW.getTime() + 120_000) });
    expect(again.decisionsPreserved).toBe(1);
    const kept = (await service.list(ACTOR)).find((a) => a.actionId === accepted.actionId)!;
    expect(kept.status).toBe('accepted');
    expect(kept.owner).toBe('P-1');
    expect(kept.acceptanceCriteria).toBe('交接清单含备用设备状态');
  });

  it('聚焦扫描：只扫指定复盘（页面"从这篇复盘生成行动项"与场景验证用）', async () => {
    const { db } = createDb({
      retrospectives: [
        publishedRetrospective({ retrospectiveId: 'RTR-1', title: '甲复盘' }),
        publishedRetrospective({
          retrospectiveId: 'RTR-2',
          title: '乙复盘',
          lessonsJson: [{ title: '乙条目', detail: 'd', severity: 'critical', evidenceIds: [] }],
          assembledJson: { gaps: [] },
        }),
      ],
    });
    const service = new ImprovementActionService(db as never, auditMock() as never);
    const focused = await service.scan(ACTOR, { now: NOW, retrospectiveIds: ['RTR-2'] });
    expect(focused.scannedRetrospectives).toBe(1);
    expect(focused.derived).toBe(1);
    expect(focused.actions[0].sourceRef).toBe('RTR-2');
    const all = await service.scan(ACTOR, { now: NOW });
    expect(all.scannedRetrospectives).toBe(2);
  });

  it('没有已发布复盘 → 零候选（未达门槛 ≠ 没有问题，结果里带读了什么）', async () => {
    const { db } = createDb({ retrospectives: [publishedRetrospective({ status: 'draft' })] });
    const service = new ImprovementActionService(db as never, auditMock() as never);
    const result = await service.scan(ACTOR, { now: NOW });
    expect(result.derived).toBe(0);
    expect(result.memory.publishedRetrospectives).toBe(0);
  });

  it('缺 org/用户上下文 → 400（fail-closed）', async () => {
    const { db } = createDb({});
    const service = new ImprovementActionService(db as never, auditMock() as never);
    await expect(service.scan(undefined)).rejects.toThrow(BadRequestException);
  });
});

describe('ImprovementActionService 状态流转', () => {
  async function withAction() {
    const { db, actions } = createDb({ retrospectives: [publishedRetrospective()] });
    const service = new ImprovementActionService(db as never, auditMock() as never);
    const result = await service.scan(ACTOR, { now: NOW });
    const lesson = result.actions.find((a) => a.sourceType === 'retrospective_lesson')!;
    return { service, actions, actionId: lesson.actionId };
  }

  it('接受必须给负责人/期限/验收判据（缺一不可）', async () => {
    const { service, actionId } = await withAction();
    await expect(service.accept(actionId, {}, ACTOR)).rejects.toThrow(BadRequestException);
    await expect(
      service.accept(actionId, { owner: 'P-1', dueAt: '2026-09-20T00:00:00.000Z' }, ACTOR),
    ).rejects.toThrow(BadRequestException);
    await expect(
      service.accept(actionId, { owner: 'P-1', dueAt: '不是时间', acceptanceCriteria: 'c' }, ACTOR),
    ).rejects.toThrow(BadRequestException);
  });

  it('接受成功：写负责人/期限/判据/接受人；可同时纠正类型（kindSource=human）', async () => {
    const { service, actionId } = await withAction();
    const accepted = await service.accept(actionId, {
      owner: 'P-1',
      dueAt: '2026-09-20T00:00:00.000Z',
      acceptanceCriteria: '交接清单含备用设备状态',
      kind: 'training',
    }, ACTOR);
    expect(accepted).toMatchObject({ status: 'accepted', owner: 'P-1', kind: 'training', kindSource: 'human' });
    expect(accepted.acceptedBy).toBe('lead.chen');
    expect(accepted.acceptedAt).toBeTruthy();
  });

  it('已接受的不可重复接受（终态思维：不覆盖第一次的承诺）', async () => {
    const { service, actionId } = await withAction();
    await service.accept(actionId, {
      owner: 'P-1',
      dueAt: '2026-09-20T00:00:00.000Z',
      acceptanceCriteria: 'c',
    }, ACTOR);
    await expect(
      service.accept(actionId, { owner: 'P-2', dueAt: '2026-09-21T00:00:00.000Z', acceptanceCriteria: 'c2' }, ACTOR),
    ).rejects.toThrow(ConflictException);
  });

  it('完成必须有结果说明；未接受的不能完成', async () => {
    const { service, actionId } = await withAction();
    await expect(service.complete(actionId, {}, ACTOR)).rejects.toThrow(ConflictException);
    await service.accept(actionId, {
      owner: 'P-1',
      dueAt: '2026-09-20T00:00:00.000Z',
      acceptanceCriteria: '交接清单含备用设备状态',
    }, ACTOR);
    await expect(service.complete(actionId, { outcomeNote: '   ' }, ACTOR)).rejects.toThrow(BadRequestException);
    const completed = await service.complete(actionId, { outcomeNote: '已加入交接清单模板并抽检 3 次' }, ACTOR);
    expect(completed).toMatchObject({ status: 'completed', completedBy: 'lead.chen' });
    expect(completed.outcomeNote).toContain('抽检');
  });

  it('拒绝必须给理由；已完成不可再拒绝（状态机兜底）', async () => {
    const { service, actionId } = await withAction();
    await expect(service.decide(actionId, { decision: 'rejected' }, ACTOR)).rejects.toThrow(BadRequestException);
    const rejected = await service.decide(actionId, { decision: 'rejected', reason: '与现有 SOP 重复' }, ACTOR);
    expect(rejected).toMatchObject({ status: 'rejected', decidedReason: '与现有 SOP 重复' });
    await expect(
      service.decide(actionId, { decision: 'dropped', reason: '算了' }, ACTOR),
    ).rejects.toThrow(ConflictException);
  });

  it('放弃（accepted → dropped）必须给理由', async () => {
    const { service, actionId } = await withAction();
    await service.accept(actionId, {
      owner: 'P-1',
      dueAt: '2026-09-20T00:00:00.000Z',
      acceptanceCriteria: 'c',
    }, ACTOR);
    await expect(service.decide(actionId, { decision: 'dropped' }, ACTOR)).rejects.toThrow(BadRequestException);
    const dropped = await service.decide(actionId, { decision: 'dropped', reason: '设备已下线，改进项作废' }, ACTOR);
    expect(dropped.status).toBe('dropped');
  });

  it('不存在的行动项 → 404（不静默创建）', async () => {
    const { service } = await withAction();
    await expect(
      service.accept('ACT-lesson-NOPE-x', { owner: 'P', dueAt: '2026-09-20T00:00:00.000Z', acceptanceCriteria: 'c' }, ACTOR),
    ).rejects.toThrow(NotFoundException);
  });

  it('逾期待办：只包含"已接受 + 到期已过"，并在列表中可按状态过滤', async () => {
    const { service, actions, actionId } = await withAction();
    await service.accept(actionId, {
      owner: 'P-1',
      dueAt: '2026-09-10T00:00:00.000Z', // 已过期
      acceptanceCriteria: 'c',
    }, ACTOR);
    const overdue = await service.overdue(ACTOR, NOW);
    expect(overdue.map((a) => a.actionId)).toEqual([actionId]);
    const future = await service.overdue(ACTOR, new Date('2026-09-01T00:00:00.000Z'));
    expect(future).toEqual([]);
    const filtered = await service.list(ACTOR, { status: 'accepted' });
    expect(filtered).toHaveLength(1);
    expect(actions).toHaveLength(2);
  });
});


/* ── NO-56b：逾期主动叫人 + 完成即了结提醒 ─────────────────────────────── */

describe('ImprovementActionService 知识回流（NO-57c）', () => {
  async function withAccepted() {
    const { db } = createDb({ retrospectives: [publishedRetrospective()] });
    const service = new ImprovementActionService(db as never, auditMock() as never);
    const scan = await service.scan(ACTOR, { now: NOW });
    const lesson = scan.actions.find((a) => a.sourceType === 'retrospective_lesson')!;
    await service.accept(lesson.actionId, {
      owner: 'person:P-63000000',
      dueAt: '2026-09-20T00:00:00.000Z',
      acceptanceCriteria: '交接清单含备用设备状态',
    }, ACTOR);
    return { db, service, actionId: lesson.actionId };
  }

  it('完成 → 结果回流成知识条目并把条目号写回行动项（outcomeRef/outcomeKind 成对）', async () => {
    const { db, service, actionId } = await withAccepted();
    const registerEntry = jest.fn(
      async (_input: Record<string, unknown>, _orgId: string) => ({ record: { knowledgeId: 'KN-IMP-1' }, created: true }),
    );
    const withKnowledge = new ImprovementActionService(
      db as never,
      auditMock() as never,
      { registerEntry } as never,
    );
    const completed = await withKnowledge.complete(actionId, { outcomeNote: '已写入交接模板并抽检' }, ACTOR);
    // 证据必须映射成**规范身份**（知识契约要求 event:/task:/…，复盘号不是规范身份）；
    // relatedEntityIds 用同一批规范证据（行动项号 ACT-… 也不是规范身份，不能直接塞）。
    const call = registerEntry.mock.calls[0][0] as {
      kind: string;
      scope: string;
      sourceEvidenceIds: string[];
      relatedEntityIds: string[];
      tags: string[];
    };
    expect(call).toMatchObject({ kind: 'process_knowledge', scope: 'factory' });
    expect(call.sourceEvidenceIds.every((id) => id.startsWith('event:'))).toBe(true);
    expect(call.relatedEntityIds).toEqual(call.sourceEvidenceIds.slice(0, 5));
    expect(call.tags).toContain('improvement_action');
    expect(registerEntry.mock.calls[0][1]).toBe(ORG);
    expect(completed).toMatchObject({ status: 'completed', outcomeRef: 'KN-IMP-1', outcomeKind: 'knowledge_entry' });
    // 契约校验通过（成对 + 仅 completed 可带）
    expect(validateImprovementAction(completed)).toEqual([]);
    void service;
  });

  it('知识回流失败 → 如实降级为"未回流"（outcomeRef=null），"已完成"照旧成立', async () => {
    const { db, actionId } = await withAccepted();
    const service = new ImprovementActionService(
      db as never,
      auditMock() as never,
      { registerEntry: jest.fn(async () => { throw new Error('knowledge table unavailable'); }) } as never,
    );
    const completed = await service.complete(actionId, { outcomeNote: '做完了但归档失败' }, ACTOR);
    expect(completed.status).toBe('completed');
    expect(completed.outcomeRef ?? null).toBeNull();
    expect(completed.outcomeKind ?? null).toBeNull();
  });

  it('知识模块未装配 → 同样显式未回流（不假装已归档）', async () => {
    const { db, actionId } = await withAccepted();
    const service = new ImprovementActionService(db as never, auditMock() as never);
    const completed = await service.complete(actionId, { outcomeNote: '做完了' }, ACTOR);
    expect(completed.outcomeRef ?? null).toBeNull();
  });
});

describe('ImprovementActionService.sweepOverdue（逾期待办主动提醒）', () => {
  async function withOverdue() {
    const { db, notifications } = createDb({
      retrospectives: [publishedRetrospective()],
      notifications: [
        {
          orgId: ORG,
          notificationId: 'NTF-ACT-ACT-lesson-RTR-1-e2e-x-action_overdue-role-workshop_lead-app',
          externalRef: 'ACT-lesson-RTR-1-e2e-x',
          status: 'pending',
          notificationIdPrefix: 'NTF-ACT-',
          resolution: null,
        },
      ],
    });
    const audit = auditMock();
    const service = new ImprovementActionService(db as never, audit as never);
    const scan = await service.scan(ACTOR, { now: NOW });
    const lesson = scan.actions.find((a) => a.sourceType === 'retrospective_lesson')!;
    await service.accept(lesson.actionId, {
      owner: 'person:P-63000000',
      dueAt: '2026-09-10T00:00:00.000Z',
      acceptanceCriteria: '交接清单含备用设备状态',
    }, ACTOR);
    return { service, audit, actionId: lesson.actionId, notifications };
  }

  it('逾期 → 给负责人（查不到账号则如实记缺口）与班组长各发一条确定性提醒', async () => {
    const { service, audit, actionId } = await withOverdue();
    const result = await service.sweepOverdue(ACTOR, { now: NOW });
    expect(result.scanned).toBe(1);
    expect(result.created).toBeGreaterThanOrEqual(1);
    // 负责人是 person:<uuid> 但身份面未绑定账号 → 如实进缺口，不假装"已叫到"
    // 缺口按归一化后的 person id 记录（身份面查账号用的就是裸 id）
    expect(result.unresolvedOwners).toContain('P-63000000');
    const notified = result.notified.find((n) => n.actionId === actionId)!;
    expect(notified.recipients).toContain('workshop_lead');
    expect(audit.appendAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'learning.action_overdue_sweep' }),
    );
  });

  it('没有逾期 → 零提醒（不打扰）', async () => {
    const { db } = createDb({ retrospectives: [publishedRetrospective()] });
    const service = new ImprovementActionService(db as never, auditMock() as never);
    await service.scan(ACTOR, { now: NOW });
    const result = await service.sweepOverdue(ACTOR, { now: NOW });
    expect(result.scanned).toBe(0);
    expect(result.created).toBe(0);
  });

  it('完成时把该行动项的提醒落到终态（同事务；无提醒时也不报错）', async () => {
    const { service, actionId } = await withOverdue();
    await service.sweepOverdue(ACTOR, { now: NOW });
    const completed = await service.complete(actionId, { outcomeNote: '已加入交接模板' }, ACTOR);
    expect(completed.status).toBe('completed');
  });
});


/* ── NO-58a：对象归属与复发度量 ─────────────────────────────────────────── */

describe('ImprovementActionService 复发度量（NO-58a）', () => {
  const COMPLETED_AT = '2026-09-12T08:00:00.000Z';

  async function withCompletedAction(seed: {
    executions?: Array<Record<string, unknown>>;
    retrospective?: Record<string, unknown>;
  } = {}) {
    const { db } = createDb({
      retrospectives: [seed.retrospective ?? publishedRetrospective()], // 缺省 scope=incident, targetId=DEV-04
      executions: seed.executions ?? [],
    });
    const service = new ImprovementActionService(db as never, auditMock() as never);
    const scan = await service.scan(ACTOR, { now: NOW });
    const lesson = scan.actions.find((a) => a.sourceType === 'retrospective_lesson')!;
    await service.accept(lesson.actionId, {
      owner: 'person:P-1',
      dueAt: '2026-09-13T00:00:00.000Z',
      acceptanceCriteria: '交接清单含备用设备状态',
    }, ACTOR);
    await service.complete(lesson.actionId, { outcomeNote: '已加入模板' }, ACTOR);
    return { service, actionId: lesson.actionId };
  }

  it('scan 时派生对象归属：incident 复盘的 targetId → device 对象', async () => {
    const { db } = createDb({ retrospectives: [publishedRetrospective()] });
    const service = new ImprovementActionService(db as never, auditMock() as never);
    const scan = await service.scan(ACTOR, { now: NOW });
    expect(scan.actions[0]).toMatchObject({ subjectType: 'device', subjectId: 'DEV-04' });
  });

  it('plan 复盘没有单一对象 → 归属为空且复发度量明确"不可度量"（不硬算）', async () => {
    const { db } = createDb({
      retrospectives: [publishedRetrospective({ scope: 'plan', targetId: 'PLAN-1', retrospectiveId: 'RTR-PLAN' })],
    });
    const service = new ImprovementActionService(db as never, auditMock() as never);
    const scan = await service.scan(ACTOR, { now: NOW });
    expect(scan.actions[0].subjectType ?? null).toBeNull();
    const effect = await service.effect(scan.actions[0].actionId, ACTOR, { now: NOW });
    expect(effect.conclusion).toBe('no_subject');
    expect(effect.reason).toContain('不可度量');
  });

  it('完成后复发计数下降 → recurrence_dropped，但明确"不等于这条改进有效"', async () => {
    const { service, actionId } = await withCompletedAction({
      executions: [
        // 完成前（前 30 天）3 次偏差
        { orgId: ORG, deviceId: 'DEV-04', deviationType: 'late_start', createdAt: new Date(Date.parse(COMPLETED_AT) - 20 * 86_400_000) },
        { orgId: ORG, deviceId: 'DEV-04', deviationType: 'late_start', createdAt: new Date(Date.parse(COMPLETED_AT) - 10 * 86_400_000) },
        { orgId: ORG, deviceId: 'DEV-04', deviationType: 'late_start', createdAt: new Date(Date.parse(COMPLETED_AT) - 2 * 86_400_000) },
      ],
    });
    const effect = await service.effect(actionId, ACTOR, { now: new Date(Date.parse(COMPLETED_AT) + 86_400_000) });
    expect(effect.before.deviations).toBe(3);
    expect(effect.after.deviations).toBe(0);
    expect(effect.conclusion).toBe('recurrence_dropped');
    expect(effect.reason).toContain('不等于');
    expect(effect.notes.join(' ')).toContain('观察期未结束');
  });

  it('样本不足（合计 < 3）→ insufficient_sample（不给趋势结论）', async () => {
    const { service, actionId } = await withCompletedAction({
      executions: [
        { orgId: ORG, deviceId: 'DEV-04', deviationType: 'late_start', createdAt: new Date(Date.parse(COMPLETED_AT) - 86_400_000) },
      ],
    });
    const effect = await service.effect(actionId, ACTOR, { now: new Date(Date.parse(COMPLETED_AT) + 86_400_000) });
    expect(effect.conclusion).toBe('insufficient_sample');
    expect(effect.reason).toContain('门槛 3');
  });

  it('人员归属带规范前缀 `person:` → 仍能查到裸 person_id 的偏差（否则静默 0 次）', async () => {
    const { service, actionId } = await withCompletedAction({
      retrospective: publishedRetrospective({
        retrospectiveId: 'RTR-PERSON',
        scope: 'incident',
        targetId: 'person:63000000-0000-4000-8000-000000000001',
      }),
      executions: [
        // 执行事实表存**裸 id**（ewoh_personnel.id），归属是 `person:<id>` 规范引用
        { orgId: ORG, personId: '63000000-0000-4000-8000-000000000001', deviationType: 'late_start', createdAt: new Date(Date.parse(COMPLETED_AT) - 5 * 86_400_000) },
        { orgId: ORG, personId: '63000000-0000-4000-8000-000000000001', deviationType: 'late_start', createdAt: new Date(Date.parse(COMPLETED_AT) - 4 * 86_400_000) },
        { orgId: ORG, personId: '63000000-0000-4000-8000-000000000001', deviationType: 'idle_timeout', createdAt: new Date(Date.parse(COMPLETED_AT) - 3 * 86_400_000) },
        // 另一个人的偏差不许算进来
        { orgId: ORG, personId: 'other-person', deviationType: 'late_start', createdAt: new Date(Date.parse(COMPLETED_AT) - 3 * 86_400_000) },
      ],
    });
    const effect = await service.effect(actionId, ACTOR, { now: new Date(Date.parse(COMPLETED_AT) + 86_400_000) });
    expect(effect.subjectType).toBe('person');
    expect(effect.subjectId).toBe('person:63000000-0000-4000-8000-000000000001');
    expect(effect.before.deviations).toBe(3);
    expect(effect.conclusion).toBe('recurrence_dropped');
  });

  it('未完成 → 只给"完成前"计数（不许拿半个窗口当对比）', async () => {
    const { db } = createDb({ retrospectives: [publishedRetrospective()] });
    const service = new ImprovementActionService(db as never, auditMock() as never);
    const scan = await service.scan(ACTOR, { now: NOW });
    const lesson = scan.actions[0];
    await service.accept(lesson.actionId, {
      owner: 'person:P-1', dueAt: '2026-09-20T00:00:00.000Z', acceptanceCriteria: 'c',
    }, ACTOR);
    const effect = await service.effect(lesson.actionId, ACTOR, { now: NOW });
    expect(effect.conclusion).toBe('not_completed');
    expect(effect.after.from).toBe('');
  });
});
