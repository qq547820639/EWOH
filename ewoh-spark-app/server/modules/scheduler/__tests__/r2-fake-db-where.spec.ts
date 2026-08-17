/* R2-SPT-003：dispatch-test-harness fake-db update() where 匹配语义单测。
 *
 * 原实现完全忽略 where 谓词（plans 恒改首行、其余表恒改全表），多行种子下
 * 条件更新与 CAS 语义失真。本文件用真实 drizzle 谓词对象验证：
 * - plans 按 where 定位目标行（多 plan 种子只改命中行）；
 * - assignments/tasks 按等值谓词只改命中行；
 * - and(eq, or(isNull, eq)) 嵌套谓词正确求值；
 * - 无命中返回空 returning（暴露 0 行分支）。
 */
/// <reference types="jest" />
import { and, eq, isNull, or } from 'drizzle-orm';
import {
  ewohSchedulePlan,
  ewohSchedulingPlanAssignment,
} from '@server/database/schema';
import { makeFakeDb } from './dispatch-test-harness';

describe('R2-SPT-003: fake-db update() where 匹配语义', () => {
  it('plans 多行种子：update where(and(planId, status)) 只改命中行（CAS 语义）', async () => {
    const { db, state } = makeFakeDb({
      plans: [
        { planId: 'PLAN-A', planName: 'a', strategy: 's', status: 'approved', version: 1 },
        { planId: 'PLAN-B', planName: 'b', strategy: 's', status: 'approved', version: 1 },
        { planId: 'PLAN-C', planName: 'c', strategy: 's', status: 'shadow', version: 1 },
      ],
    });
    const hit = await (db
      .update(ewohSchedulePlan)
      .set({ status: 'dispatched' })
      .where(
        and(eq(ewohSchedulePlan.planId, 'PLAN-B'), eq(ewohSchedulePlan.status, 'approved')),
      ) as unknown as { returning: () => Promise<unknown[]> }).returning();
    expect(hit).toHaveLength(1);
    expect(state.plans.get('PLAN-A')?.status).toBe('approved'); // 未命中行不被误改
    expect(state.plans.get('PLAN-B')?.status).toBe('dispatched');
    expect(state.plans.get('PLAN-C')?.status).toBe('shadow');
  });

  it('plans CAS：状态谓词不满足时 0 行命中（返回空，暴露并发冲突）', async () => {
    const { db, state } = makeFakeDb({
      plans: [
        { planId: 'PLAN-D', planName: 'd', strategy: 's', status: 'shadow', version: 1 },
      ],
    });
    const hit = await (db
      .update(ewohSchedulePlan)
      .set({ status: 'dispatched' })
      .where(
        and(eq(ewohSchedulePlan.planId, 'PLAN-D'), eq(ewohSchedulePlan.status, 'approved')),
      ) as unknown as { returning: () => Promise<unknown[]> }).returning();
    expect(hit).toHaveLength(0);
    expect(state.plans.get('PLAN-D')?.status).toBe('shadow'); // 状态不变
  });

  it('assignments 多行种子：update where(assignmentId) 只改命中行', async () => {
    const { db, state } = makeFakeDb({
      assignments: [
        { assignmentId: 'ASG-1', planId: 'PLAN-1', status: 'approved' },
        { assignmentId: 'ASG-2', planId: 'PLAN-1', status: 'approved' },
        { assignmentId: 'ASG-3', planId: 'PLAN-2', status: 'approved' },
      ],
    });
    const hit = await (db
      .update(ewohSchedulingPlanAssignment)
      .set({ status: 'dispatched' })
      .where(eq(ewohSchedulingPlanAssignment.assignmentId, 'ASG-2')) as unknown as {
      returning: () => Promise<unknown[]>;
    }).returning();
    expect(hit).toHaveLength(1);
    expect(state.assignments.map((a) => a.status)).toEqual([
      'approved',
      'dispatched',
      'approved',
    ]);
  });

  it('嵌套 or(isNull(orgId), eq(orgId)) 谓词正确求值（NULL 行命中）', async () => {
    const { db, state } = makeFakeDb({
      plans: [
        { planId: 'PLAN-N', planName: 'n', strategy: 's', status: 'approved', orgId: null },
        { planId: 'PLAN-O', planName: 'o', strategy: 's', status: 'approved', orgId: 'org-other' },
        { planId: 'PLAN-M', planName: 'm', strategy: 's', status: 'approved', orgId: 'org1' },
      ],
    });
    const hit = await (db
      .update(ewohSchedulePlan)
      .set({ status: 'dispatched' })
      .where(
        and(
          or(isNull(ewohSchedulePlan.orgId), eq(ewohSchedulePlan.orgId, 'org1')),
          eq(ewohSchedulePlan.status, 'approved'),
        ),
      ) as unknown as { returning: () => Promise<unknown[]> }).returning();
    expect(hit).toHaveLength(2); // NULL 行 + org1 行；org-other 行不可见
    expect(state.plans.get('PLAN-N')?.status).toBe('dispatched');
    expect(state.plans.get('PLAN-M')?.status).toBe('dispatched');
    expect(state.plans.get('PLAN-O')?.status).toBe('approved'); // 其他 org 不被触碰
  });

  it('无命中返回空 returning（0 行分支可被调用方校验）', async () => {
    const { db } = makeFakeDb({
      assignments: [{ assignmentId: 'ASG-X', planId: 'PLAN-X', status: 'approved' }],
    });
    const hit = await (db
      .update(ewohSchedulingPlanAssignment)
      .set({ status: 'cancelled' })
      .where(eq(ewohSchedulingPlanAssignment.assignmentId, 'ASG-NONE')) as unknown as {
      returning: () => Promise<unknown[]>;
    }).returning();
    expect(hit).toHaveLength(0);
  });
});
