/* AgentOrchestratorService 回归测试（ADR-017 / NO-06f）。
 *
 * 覆盖已修复缺陷：completeTask 带 outcomeJson 时原先用 {taskId,status,outcomeJson}
 * **整体覆盖** taskJson——任务契约记录（name/kind/assignedRole/dependencies/budget…）
 * 全部丢失，读面（listTasks.task）只剩残缺形状。修复后在既有 taskJson 上合并
 * outcome（保留原记录 + status 同步 + outcomeJson 附加）。
 */
/// <reference types="jest" />
import { BadRequestException } from '@nestjs/common';
import { AgentOrchestratorService } from '../agent-orchestrator.service';

const ORG_A = 'org-a';

function taskRow(overrides: Record<string, unknown> = {}) {
  const taskJson = {
    taskId: 'task:t1',
    name: '巡检任务',
    version: 1,
    kind: 'analysis',
    assignedRole: 'FactorySupervisor',
    dependencies: [],
    inputContract: { schemaRef: 'catalog://in' },
    outputContract: { schemaRef: 'catalog://out' },
    priority: 'medium',
    createdAt: new Date().toISOString(),
    budget: { maxSteps: 8, maxTokens: 20000, maxDurationSec: 300 },
    status: 'created',
    auditTrail: true,
  };
  return {
    id: '00000000-0000-4000-8000-0000000000a1',
    orgId: ORG_A,
    taskId: 'task:t1',
    name: '巡检任务',
    version: 1,
    kind: 'analysis',
    assignedRole: 'FactorySupervisor',
    assigneeAgentId: null,
    dependencies: [],
    priority: 'medium',
    status: 'in_progress',
    dueTime: null,
    budget: taskJson.budget,
    correlationId: null,
    inputContract: taskJson.inputContract,
    outputContract: taskJson.outputContract,
    taskJson,
    createdAt: new Date(),
    ...overrides,
  };
}

/** 条件宽松匹配：按值前缀归类（org- → orgId、task: → taskId），
 * 其余字符串值（status 等值 CAS）在本用例矩阵内不参与过滤——
 * 状态合法性由服务层 allowedFrom 守卫先行保证。 */
function matches(cond: unknown, row: Record<string, unknown>): boolean {
  const orgIds = new Set<string>();
  const taskIds = new Set<string>();
  const walk = (node: unknown, seen: WeakSet<object>): void => {
    if (node == null || typeof node !== 'object' || seen.has(node as object)) return;
    seen.add(node as object);
    if (Array.isArray(node)) {
      node.forEach((x) => walk(x, seen));
      return;
    }
    for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
      if (key === 'value' && typeof value === 'string') {
        if (value.startsWith('org-')) orgIds.add(value);
        else if (value.startsWith('task:')) taskIds.add(value);
      } else {
        walk(value, seen);
      }
    }
  };
  walk(cond, new WeakSet());
  if (orgIds.size > 0 && !orgIds.has(String(row.orgId))) return false;
  if (taskIds.size > 0 && !taskIds.has(String(row.taskId))) return false;
  return true;
}

function createDb(rows: Array<Record<string, unknown>>) {
  const state = { rows: [...rows] };
  const db = {
    select: jest.fn(() => ({
      from: jest.fn(() => ({
        where: jest.fn((cond: unknown) => {
          const hit = state.rows.filter((r) => matches(cond, r));
          // promise（thenable）+ 可选链：transition 的 select 不带 limit，
          // 直接 await where 结果。
          const result = Promise.resolve(hit) as Promise<Array<Record<string, unknown>>> & {
            limit: (n: number) => Promise<Array<Record<string, unknown>>>;
            orderBy: () => { limit: () => Promise<Array<Record<string, unknown>>> };
          };
          result.limit = jest.fn(async () => hit.slice(0, 1));
          result.orderBy = jest.fn(() => ({ limit: jest.fn(async () => hit) }));
          return result;
        }),
      })),
    })),
    update: jest.fn(() => ({
      set: jest.fn((patch: Record<string, unknown>) => ({
        where: jest.fn((cond: unknown) => {
          const hit = state.rows.filter((r) => matches(cond, r));
          for (const r of hit) Object.assign(r, patch);
          return { returning: jest.fn(async () => hit.map((r) => ({ taskId: r.taskId }))) };
        }),
      })),
    })),
  };
  const auditService = { appendAuditLog: jest.fn(async () => ({})) };
  const service = new AgentOrchestratorService(db as never, auditService as never);
  return { db, state, service, auditService };
}

// 状态机约束：in_progress→completed 仅 agent 角色可执行（SH-005）。
const AGENT_ACTOR = { userId: 'agent:runtime', roles: ['agent'] };

describe('AgentOrchestratorService completeTask（taskJson 合并回归）', () => {
  it('complete 带 outcomeJson：taskJson 保留原任务契约字段并合并 outcome/status', async () => {
    const { state, service } = createDb([taskRow()]);
    const outcomeJson = { summary: '已完成巡检', findings: 2 };
    await service.completeTask(
      ORG_A,
      'task:t1',
      { status: 'completed', outcomeJson },
      AGENT_ACTOR,
    );
    const row = state.rows[0] as Record<string, unknown>;
    const taskJson = row.taskJson as Record<string, unknown>;
    // 原契约字段不再丢失（原先整行被 {taskId,status,outcomeJson} 覆盖）。
    expect(taskJson.name).toBe('巡检任务');
    expect(taskJson.kind).toBe('analysis');
    expect(taskJson.assignedRole).toBe('FactorySupervisor');
    expect(taskJson.budget).toEqual({ maxSteps: 8, maxTokens: 20000, maxDurationSec: 300 });
    // 结果与终态同步写入。
    expect(taskJson.status).toBe('completed');
    expect(taskJson.outcomeJson).toEqual(outcomeJson);
  });

  it('complete 不带 outcomeJson：taskJson 保持原样（只有列状态推进）', async () => {
    const { state, service } = createDb([taskRow()]);
    await service.completeTask(ORG_A, 'task:t1', { status: 'completed' }, AGENT_ACTOR);
    const row = state.rows[0] as Record<string, unknown>;
    expect((row.taskJson as Record<string, unknown>).name).toBe('巡检任务');
    expect(row.status).toBe('completed');
  });

  it('in_progress 之外不可 complete（状态机 fail-closed 不变）', async () => {
    const { service } = createDb([taskRow({ status: 'created' })]);
    await expect(
      service.completeTask(ORG_A, 'task:t1', { status: 'completed' }, AGENT_ACTOR),
    ).rejects.toBeInstanceOf(BadRequestException);
  });
});
