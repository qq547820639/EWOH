import { BadRequestException } from '@nestjs/common';
import { AgentOrchestratorService } from '../../../server/modules/agent/agent-orchestrator.service';
import { ewohAgentTask, ewohEvent } from '@server/database/schema';

const TASK_ID = 'task:9f1c4a0e-5d0b-4f3a-9c1e-7d3b9a6f0a11';
const TASK_B = 'task:5c1b2a3d-1111-4222-8333-9a8b7c6d5e4f';

function makeTask(overrides: Record<string, unknown> = {}) {
  return {
    taskId: TASK_ID,
    name: '编排测试任务',
    version: 1,
    kind: 'execution',
    assignedRole: 'Logistics',
    dependencies: [],
    inputContract: { schemaRef: 'catalog://x' },
    outputContract: { schemaRef: 'catalog://y' },
    priority: 'medium',
    createdAt: '2026-08-16T08:00:00Z',
    budget: { maxSteps: 5, maxTokens: 10000, maxDurationSec: 300 },
    status: 'created',
    auditTrail: true,
    ...overrides,
  } as never;
}

const KNOWN_STATUSES = ['created', 'dispatched', 'in_progress', 'completed', 'failed', 'cancelled'];

function collectValues(node: unknown, taskIds: Set<string>, statuses: Set<string>, seen: WeakSet<object>): void {
  if (node == null || typeof node !== 'object') return;
  if (seen.has(node as object)) return;
  seen.add(node as object);
  if (Array.isArray(node)) {
    for (const x of node) collectValues(x, taskIds, statuses, seen);
    return;
  }
  // 仅收集 Param 包装 { value: '...' } 的实际值——列元数据（default 等）不在
  // 'value' 键下，不会被误收集为过滤条件。
  for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
    if (key === 'value' && typeof value === 'string') {
      if (value.startsWith('task:')) taskIds.add(value);
      if (KNOWN_STATUSES.includes(value)) statuses.add(value);
    } else {
      collectValues(value, taskIds, statuses, seen);
    }
  }
}

function matches(cond: unknown, row: Record<string, unknown>): boolean {
  const taskIds = new Set<string>();
  const statuses = new Set<string>();
  collectValues(cond, taskIds, statuses, new WeakSet());
  const myId = String(row.taskId);
  const myStatus = String(row.status);
  if (taskIds.size > 0 && !taskIds.has(myId)) return false;
  if (statuses.size > 0 && !statuses.has(myStatus)) return false;
  return true;
}

function createOrchestratorDb(presetRows: Array<Record<string, unknown>> = []) {
  const rows: Array<Record<string, unknown>> = [...presetRows];
  const events: Array<Record<string, unknown>> = [];
  function thenable(data: unknown[]): unknown {
    return {
      then: (resolve: (v: unknown[]) => void) => resolve(data),
      orderBy: jest.fn(() => thenable(data)),
      limit: jest.fn(() => thenable(data.slice(0, 100))),
    };
  }
  const db = {
    select: jest.fn(() => ({
      from: jest.fn(() => ({
        where: jest.fn((cond: unknown) => thenable(rows.filter((r) => matches(cond, r)))),
      })),
    })),
    insert: jest.fn((table: unknown) => ({
      values: jest.fn((row: Record<string, unknown>) => {
        if (table === ewohAgentTask) rows.push(row);
        if (table === ewohEvent) events.push(row);
        return { onConflictDoNothing: jest.fn(), returning: jest.fn(async () => [row]) };
      }),
    })),
    update: jest.fn((table: unknown) => ({
      set: jest.fn((patch: Record<string, unknown>) => ({
        where: jest.fn((cond: unknown) => ({
          returning: jest.fn(async () => {
            if (table !== ewohAgentTask) return [];
            // CAS 简化：按 where 条件匹配行（转移合法性已由服务层状态机判定）
            const matched = rows.filter((r) => matches(cond, r));
            for (const row of matched) Object.assign(row, patch);
            return matched.length > 0 ? [{ taskId: matched[0]?.taskId }] : [];
          }),
        })),
      })),
    })),
  };
  const audit = { appendAuditLog: jest.fn().mockResolvedValue(undefined) };
  const service = new AgentOrchestratorService(db as never, audit as never);
  return { db, audit, rows, events, service };
}

function rowOf(task: Record<string, unknown>, status = 'created'): Record<string, unknown> {
  return {
    orgId: 'ORG-1', taskId: task.taskId, name: task.name, version: task.version,
    kind: task.kind, assignedRole: task.assignedRole, dependencies: task.dependencies,
    priority: task.priority, status, taskJson: { ...task, status },
  };
}

describe('AgentOrchestratorService（NO-06f 编排引擎）', () => {
  it('创建：契约校验 fail-closed + 落库 + AgentTaskCreated 事件', async () => {
    const { rows, events, service } = createOrchestratorDb();
    const task = makeTask();
    await service.createTask('ORG-1', task);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.status).toBe('created');
    expect(events).toHaveLength(1);
    expect(events[0]?.eventType).toBe('AgentTaskCreated');
  });

  it('创建：契约非法（auditTrail=false）fail-closed 拒绝', async () => {
    const { rows, service } = createOrchestratorDb();
    await expect(
      service.createTask('ORG-1', makeTask({ auditTrail: false })),
    ).rejects.toThrow(/agent_task_invalid:audit_required/);
    expect(rows).toHaveLength(0);
  });

  it('创建：依赖环检测 fail-closed（task_graph_cycle）', async () => {
    // 预置 B 依赖 A；新建 A 依赖 B → 环
    const { service } = createOrchestratorDb([
      rowOf(makeTask({ taskId: TASK_B, dependencies: [TASK_ID] })),
    ]);
    await expect(
      service.createTask('ORG-1', makeTask({ dependencies: [TASK_B] })),
    ).rejects.toThrow(/task_graph_cycle/);
  });

  it('dispatch：依赖未 completed fail-closed 拒绝', async () => {
    const { service } = createOrchestratorDb([
      rowOf(makeTask({ dependencies: [TASK_B] }), 'created'),
      rowOf(makeTask({ taskId: TASK_B }), 'created'),
    ]);
    await expect(service.dispatchTask('ORG-1', TASK_ID)).rejects.toThrow(
      /dependency_not_completed/,
    );
  });

  it('dispatch：依赖全部 completed 放行（created→dispatched）', async () => {
    const { rows, service } = createOrchestratorDb([
      rowOf(makeTask({ dependencies: [TASK_B] }), 'created'),
      rowOf(makeTask({ taskId: TASK_B }), 'completed'),
    ]);
    const result = await service.dispatchTask('ORG-1', TASK_ID);
    expect(result.status).toBe('dispatched');
    expect(rows[0]?.status).toBe('dispatched');
  });

  it('非法转移 fail-closed（created→completed 不允许）', async () => {
    const { service } = createOrchestratorDb([rowOf(makeTask(), 'created')]);
    await expect(
      service.completeTask('ORG-1', TASK_ID, { status: 'completed' }),
    ).rejects.toThrow(/invalid_transition:created->completed/);
  });

  it('终态：in_progress→completed 落 AgentTaskCompleted 事件', async () => {
    const { events, service } = createOrchestratorDb([rowOf(makeTask(), 'in_progress')]);
    const result = await service.completeTask('ORG-1', TASK_ID, { status: 'completed' });
    expect(result.status).toBe('completed');
    expect(events).toHaveLength(1);
    expect(events[0]?.eventType).toBe('AgentTaskCompleted');
  });

  it('cancel：非终态可取消（in_progress→cancelled）', async () => {
    const { service } = createOrchestratorDb([rowOf(makeTask(), 'in_progress')]);
    const result = await service.cancelTask('ORG-1', TASK_ID);
    expect(result.status).toBe('cancelled');
  });

  it('并发预算：同角色活跃任务达上限 fail-closed 拒绝', async () => {
    const rows = Array.from({ length: 10 }, (_, i) =>
      rowOf(makeTask({ taskId: `task:pre-${i}` }), i % 2 === 0 ? 'created' : 'in_progress'),
    );
    const { service } = createOrchestratorDb(rows);
    await expect(service.createTask('ORG-1', makeTask())).rejects.toThrow(
      /concurrency_limit_exceeded:Logistics=10/,
    );
  });

  it('同版本幂等重创建（不重复落库）', async () => {
    const task = makeTask();
    const { rows, service } = createOrchestratorDb([rowOf(task)]);
    const result = await service.createTask('ORG-1', task);
    expect((result as Record<string, unknown>).taskId).toBe(TASK_ID);
    expect(rows).toHaveLength(1);
  });
});
