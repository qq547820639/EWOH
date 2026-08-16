import {
  Injectable,
  Inject,
  Logger,
  NotFoundException,
  BadRequestException,
  ConflictException,
} from '@nestjs/common';
import {
  DRIZZLE_DATABASE,
  type PostgresJsDatabase,
} from '@lark-apaas/fullstack-nestjs-core';
import { and, desc, eq } from 'drizzle-orm';
import { ewohProductionTask } from '@server/database/schema';
import { isValidUuid } from '@server/common/uuid';
import { AuditService } from '../shared/audit.service';
import type { OrgContext } from '../shared/org-context.interceptor';

export interface CreateTaskDto {
  title: string;
  taskType: string;
  priority?: string;
  description?: string;
  assigneeId?: string;
  deviceId?: string;
  spatialEntityId?: string;
  planStart?: string;
  planEnd?: string;
}

// A1（任务写路径事件接线）：TaskModule 保持依赖叶子（不 import SchedulerModule），
// 通过回调注册表把任务写事件暴露给调度侧。TaskSchedulingBridge（scheduler 模块）
// 在启动时注册回调 → injectSchedulingEvent，避免 TaskModule→SchedulerModule 循环依赖。
export type TaskEventTrigger = 'TASK_CREATED' | 'TASK_UPDATED';
export type TaskEventListener = (
  taskId: string,
  trigger: TaskEventTrigger,
  actor?: OrgContext,
) => void;

export interface TaskActionTransition {
  action: string;
  from: string;
  to: string;
}

/**
 * Canonical Execution Model 任务状态机运行时消费面（ADR-049 / NO-12z，§3/§31）。
 *
 * 单一事实源 = contracts/state-machines/task.yaml；本表为其 TS 消费面，
 * 由 test/unit/task/task-state-machine-contract.spec.ts 逐条锁步
 * （显式转换 + 穷举负例 + 检查器负测试）——修改本表必须同步契约，
 * 漂移在构建期显式暴露（§31 单一语义，无第二事实源）。
 */
export const TASK_ACTIONS: TaskActionTransition[] = [
  { action: 'submit', from: 'draft', to: 'pending_confirm' },
  { action: 'request_approval', from: 'pending_confirm', to: 'pending_approval' },
  { action: 'skip_approval', from: 'pending_confirm', to: 'pending_dispatch' },
  { action: 'approve', from: 'pending_approval', to: 'pending_dispatch' },
  { action: 'reject', from: 'pending_approval', to: 'draft' },
  { action: 'dispatch', from: 'pending_dispatch', to: 'dispatched' },
  { action: 'receive', from: 'dispatched', to: 'received' },
  { action: 'start', from: 'received', to: 'executing' },
  { action: 'pause', from: 'executing', to: 'paused' },
  { action: 'resume', from: 'paused', to: 'executing' },
  { action: 'exception', from: 'executing', to: 'exception' },
  { action: 'resolve', from: 'exception', to: 'executing' },
  { action: 'complete', from: 'executing', to: 'completed' },
];

/** 契约 any_non_terminal → cancelled 的非终态集合（task.yaml 锁步）。 */
export const TASK_NON_TERMINAL = [
  'draft',
  'pending_confirm',
  'pending_approval',
  'pending_dispatch',
  'dispatched',
  'received',
  'executing',
  'paused',
  'exception',
] as const;

/** 契约 terminal 集合（task.yaml 锁步）。 */
export const TASK_TERMINAL = ['completed', 'cancelled'] as const;

export function nextTaskStatus(current: string, action: string): string | null {
  if (action === 'cancel') {
    return (TASK_NON_TERMINAL as readonly string[]).includes(current)
      ? 'cancelled'
      : null;
  }
  for (const transition of TASK_ACTIONS) {
    if (transition.action === action && transition.from === current) {
      return transition.to;
    }
  }
  return null;
}

/**
 * 最短合法动作链（ADR-050 / NO-13a，与边缘 shortest_task_path 同语义，
 * §31：双实现各自锁步于同一契约图 task.yaml）。
 *
 * 返回从 current 到 target 的最短 action 序列（BFS）；不可达 → null；
 * current == target → []（已一致，no-op）。
 */
export function taskActionPath(current: string, target: string): string[] | null {
  if (current === target) return [];
  const edges = new Map<string, Array<{ to: string; action: string }>>();
  for (const t of TASK_ACTIONS) {
    if (!edges.has(t.from)) edges.set(t.from, []);
    edges.get(t.from)!.push({ to: t.to, action: t.action });
  }
  const queue: string[] = [current];
  const prev = new Map<string, { state: string; action: string } | null>([
    [current, null],
  ]);
  while (queue.length > 0) {
    const state = queue.shift()!;
    if (state === target) break;
    for (const edge of edges.get(state) ?? []) {
      if (prev.has(edge.to)) continue;
      prev.set(edge.to, { state, action: edge.action });
      queue.push(edge.to);
    }
  }
  if (!prev.has(target)) return null;
  const actions: string[] = [];
  let cursor = prev.get(target);
  while (cursor != null) {
    actions.unshift(cursor.action);
    cursor = prev.get(cursor.state);
  }
  return actions;
}

@Injectable()
export class TaskService {
  private readonly logger = new Logger(TaskService.name);
  private readonly taskListeners = new Set<TaskEventListener>();

  constructor(
    @Inject(DRIZZLE_DATABASE) private readonly db: PostgresJsDatabase,
    private readonly auditService: AuditService,
  ) {}

  /** A1：注册任务写事件监听（调度桥接用）；fire-and-forget，监听器异常不影响任务主流程。 */
  onTaskEvent(fn: TaskEventListener): void {
    this.taskListeners.add(fn);
  }

  private emitTaskEvent(taskId: string, trigger: TaskEventTrigger, actor?: OrgContext): void {
    for (const fn of this.taskListeners) {
      try {
        fn(taskId, trigger, actor);
      } catch (e) {
        this.logger.warn(
          `task event listener failed: ${e instanceof Error ? e.message : String(e)}`,
        );
      }
    }
  }

  async listTasks() {
    return this.db
      .select()
      .from(ewohProductionTask)
      .orderBy(desc(ewohProductionTask.createdAt));
  }

  async getTask(id: string) {
    if (!isValidUuid(id)) {
      throw new NotFoundException(`Task ${id} not found`);
    }
    const [row] = await this.db
      .select()
      .from(ewohProductionTask)
      .where(eq(ewohProductionTask.id, id));
    if (!row) {
      throw new NotFoundException(`Task ${id} not found`);
    }
    return row;
  }

  async createTask(body: CreateTaskDto) {
    if (!body.title?.trim() || !body.taskType?.trim()) {
      throw new BadRequestException('title and taskType are required');
    }
    const [row] = await this.db
      .insert(ewohProductionTask)
      .values({
        title: body.title.trim(),
        taskType: body.taskType.trim(),
        priority: body.priority ?? 'medium',
        description: body.description ?? null,
        assigneeId: body.assigneeId ?? null,
        deviceId: body.deviceId ?? null,
        spatialEntityId: body.spatialEntityId ?? null,
        planStart: body.planStart ? new Date(body.planStart) : null,
        planEnd: body.planEnd ? new Date(body.planEnd) : null,
        status: 'draft',
        source: 'manual',
      })
      .returning();
    // A1：任务创建成功 → 通知调度桥（fire-and-forget，触发事件驱动重排）
    this.emitTaskEvent(row.id, 'TASK_CREATED');
    return row;
  }

  async transitionTaskState(id: string, action: string, actor?: OrgContext) {
    const task = await this.getTask(id);
    const status = nextTaskStatus(task.status, action);
    if (!status) {
      throw new BadRequestException(
        `Transition ${action} not allowed from ${task.status}`,
      );
    }
    const before = task.status;
    const [row] = await this.db
      .update(ewohProductionTask)
      .set({ status })
      .where(
        and(
          eq(ewohProductionTask.id, id),
          eq(ewohProductionTask.status, before),
        ),
      )
      .returning();
    if (!row) {
      throw new ConflictException('STATE_CONFLICT');
    }
    await this.auditService.appendAuditLog({
      actorId: actor?.userId ?? 'system',
      orgId: actor?.primaryOrgId ?? '',
      action: `task.${action}`,
      entityType: 'production_task',
      entityId: row.id,
      before: { status: before },
      after: { status: row.status },
    });
    // A1：任务状态变更成功 → 通知调度桥（TASK_UPDATED，触发事件驱动重排）
    this.emitTaskEvent(row.id, 'TASK_UPDATED', actor);
    return row;
  }
}
