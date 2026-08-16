/* scheduler-read-org-isolation.spec.ts — Scheduler 读面组织隔离第三波（ADR-073 / NO-13x，§15）。
 *
 * 覆盖：conflict list/detail（无 RLS 表，应用层唯一执行面）、feedback
 * list/deriveKpis、execution list、policy listVersions、policy activation
 * listActivations 的 org 条件注入（org 匹配或 NULL 存量，与 standalone_025
 * RLS 语义等价）与 org 来源（ctx 而非 query 参数）语义。
 */
import { NotFoundException } from '@nestjs/common';
import { ConflictService } from '../../../server/modules/scheduler/conflict.service';
import { SchedulingFeedbackService } from '../../../server/modules/scheduler/scheduling-feedback.service';
import { ExecutionService } from '../../../server/modules/scheduler/execution.service';
import { SchedulingPolicyService } from '../../../server/modules/scheduler/scheduling-policy.service';
import { PolicyActivationService } from '../../../server/modules/scheduler/policy-activation.service';
import { RoutingService } from '../../../server/modules/scheduler/routing.service';
import {
  ewohSchedulingConflict,
  ewohSchedulingFeedback,
  ewohSchedulingExecution,
  ewohSchedulingPolicy,
  ewohPolicyActivation,
  ewohRouteNode,
  ewohRouteEdge,
} from '@server/database/schema';

const ACTOR_ORG2 = { userId: 'u2', primaryOrgId: 'ORG-2' } as never;

/** 递归展开 drizzle SQL 对象为可断言文本（queryChunks → 列名/字面量）。 */
function flattenSQL(node: unknown): string {
  if (node == null) return '';
  if (Array.isArray(node)) return node.map(flattenSQL).join(' ');
  if (typeof node !== 'object') return String(node);
  const obj = node as Record<string, unknown>;
  if ('value' in obj) return String(obj.value);
  if ('queryChunks' in obj) {
    return ((obj.queryChunks as unknown[]) ?? []).map(flattenSQL).join(' ');
  }
  return '';
}

/** 深度搜索 SQL 树中是否引用了目标列实例。 */
function containsNode(node: unknown, target: unknown): boolean {
  if (node === target) return true;
  if (Array.isArray(node)) return node.some((n) => containsNode(n, target));
  if (node && typeof node === 'object' && 'queryChunks' in (node as object)) {
    return containsNode((node as { queryChunks: unknown }).queryChunks, target);
  }
  return false;
}

/** 捕获 where 条件的链式 db mock（where → orderBy → limit → offset 全链路可 await）。 */
function createCaptureDb() {
  const captured: Array<{ table: unknown; cond: unknown }> = [];
  const rowsFor = (_table: unknown): Array<Record<string, unknown>> => [];
  const db = {
    select: jest.fn(() => ({
      from: jest.fn((table: unknown) => {
        const q: any = Promise.resolve(rowsFor(table));
        q.orderBy = jest.fn(() => Promise.resolve(rowsFor(table)));
        q.where = (cond: unknown) => {
          captured.push({ table, cond });
          const w: any = Promise.resolve(rowsFor(table));
          w.orderBy = jest.fn(() => {
            const o: any = Promise.resolve(rowsFor(table));
            o.limit = jest.fn(() => {
              const l: any = Promise.resolve(rowsFor(table));
              l.offset = jest.fn().mockResolvedValue(rowsFor(table));
              return l;
            });
            return o;
          });
          w.limit = jest.fn(() => Promise.resolve(rowsFor(table)));
          return w;
        };
        return q;
      }),
    })),
  };
  return { db, captured };
}

function conflictConds(captured: Array<{ table: unknown; cond: unknown }>) {
  return captured.filter((c) => c.table === ewohSchedulingConflict).map((c) => c.cond);
}

describe('ConflictService 读面 org 条件（ADR-073：无 RLS 表应用层唯一执行面）', () => {
  function makeService(db: unknown) {
    const worldStateSnapshotService = {
      getCurrentWorldState: jest.fn().mockResolvedValue({
        tasks: [],
        reservations: [],
        persons: [],
        devices: [],
        routeStatus: [],
      }),
    };
    const policyService = { getConfig: jest.fn().mockRejectedValue(new Error('n/a')) };
    return new ConflictService(
      db as never,
      undefined as never,
      worldStateSnapshotService as never,
      policyService as never,
      undefined as never,
      undefined as never,
    );
  }

  it('listConflicts 有 actor → 落库行读取含 org 条件（org 匹配或 NULL 存量）', async () => {
    const { db, captured } = createCaptureDb();
    const service = makeService(db);
    await service.listConflicts({}, ACTOR_ORG2);
    const conds = conflictConds(captured);
    expect(conds.length).toBeGreaterThan(0);
    expect(containsNode(conds[0], ewohSchedulingConflict.orgId)).toBe(true);
    expect(flattenSQL(conds[0])).toContain('ORG-2');
  });

  it('listConflicts 无 actor → 落库行读取无 org 条件（内部可信流）', async () => {
    const { db, captured } = createCaptureDb();
    const service = makeService(db);
    await service.listConflicts({});
    expect(conflictConds(captured)[0]).toBeUndefined();
  });

  it('getConflictDetail 跨租户兜底行不可见 → NotFound（与不存在同语义）', async () => {
    const { db } = createCaptureDb();
    const service = makeService(db);
    await expect(service.getConflictDetail('C-1', ACTOR_ORG2)).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });
});

describe('SchedulingFeedbackService 读面 org 条件（ADR-073）', () => {
  it('list(orgId) / deriveKpis(orgId) → org 条件；无 orgId → 现状（RLS 兜底）', async () => {
    const { db, captured } = createCaptureDb();
    const service = new SchedulingFeedbackService(db as never, undefined as never);

    await service.list('ORG-2');
    const listCond = captured.find((c) => c.table === ewohSchedulingFeedback);
    expect(containsNode(listCond?.cond, ewohSchedulingFeedback.orgId)).toBe(true);
    expect(flattenSQL(listCond?.cond)).toContain('ORG-2');

    await service.deriveKpis('ORG-2');
    const kpiCond = captured
      .filter((c) => c.table === ewohSchedulingFeedback)
      .at(-1);
    expect(containsNode(kpiCond?.cond, ewohSchedulingFeedback.orgId)).toBe(true);

    await service.list();
    // 无 orgId 路径不追加 where 条件（现状全量，RLS 兜底）。
    const feedbackEntries = () =>
      captured.filter((c) => c.table === ewohSchedulingFeedback).length;
    const before = feedbackEntries();
    await service.list();
    expect(feedbackEntries()).toBe(before);
  });
});

describe('ExecutionService list org 条件（ADR-073）', () => {
  it('orgId 提供 → org 条件；缺失 → 现状', async () => {
    const { db, captured } = createCaptureDb();
    const service = new ExecutionService(db as never, undefined as never, undefined as never);

    await service.list({ orgId: 'ORG-2' });
    const withOrg = captured.find((c) => c.table === ewohSchedulingExecution);
    expect(containsNode(withOrg?.cond, ewohSchedulingExecution.orgId)).toBe(true);
    expect(flattenSQL(withOrg?.cond)).toContain('ORG-2');

    await service.list({});
    const noOrg = captured.filter((c) => c.table === ewohSchedulingExecution).at(-1);
    expect(noOrg?.cond).toBeUndefined();
  });
});

describe('SchedulingPolicyService listVersions org 条件（ADR-073）', () => {
  it('orgId 提供 → org 条件；缺失 → 现状', async () => {
    const { db, captured } = createCaptureDb();
    const service = new SchedulingPolicyService(db as never);

    await service.listVersions('ORG-2');
    const withOrg = captured.find((c) => c.table === ewohSchedulingPolicy);
    expect(containsNode(withOrg?.cond, ewohSchedulingPolicy.orgId)).toBe(true);
    expect(flattenSQL(withOrg?.cond)).toContain('ORG-2');

    await service.listVersions();
    // 无 orgId 路径不追加 where 条件（现状全量，RLS 兜底）。
    const policyEntries = () =>
      captured.filter((c) => c.table === ewohSchedulingPolicy).length;
    const before = policyEntries();
    await service.listVersions();
    expect(policyEntries()).toBe(before);
  });
});

describe('PolicyActivationService listActivations org 条件（ADR-073：org 来自 ctx）', () => {
  it('orgId 提供 → org 过滤；null（无认证上下文）→ 不过滤（controller 已废弃 query 参数来源）', async () => {
    const { db, captured } = createCaptureDb();
    const service = new PolicyActivationService(
      db as never,
      undefined as never,
      undefined as never,
      undefined as never,
      undefined as never,
    );

    await service.listActivations('ORG-2');
    const withOrg = captured.find((c) => c.table === ewohPolicyActivation);
    expect(containsNode(withOrg?.cond, ewohPolicyActivation.orgId)).toBe(true);
    expect(flattenSQL(withOrg?.cond)).toContain('ORG-2');

    await service.listActivations(null);
    const noOrg = captured.filter((c) => c.table === ewohPolicyActivation).at(-1);
    expect(noOrg?.cond).toBeUndefined();
  });
});

describe('RoutingService loadGraph org 条件（ADR-074 / standalone_056）', () => {
  function makeRoutingDb() {
    const captured: Array<{ table: unknown; cond: unknown }> = [];
    const db = {
      select: jest.fn(() => ({
        from: jest.fn((table: unknown) => {
          const q: any = Promise.resolve([]);
          q.where = (cond: unknown) => {
            captured.push({ table, cond });
            return Promise.resolve([]);
          };
          return q;
        }),
      })),
    };
    return { db, captured };
  }

  it('有 actor → 两表读取含 org 条件（org 匹配或 NULL 存量）', async () => {
    const { db, captured } = makeRoutingDb();
    const service = new RoutingService(db as never, undefined as never);
    await service.loadGraph(ACTOR_ORG2);
    const nodeCond = captured.find((c) => c.table === ewohRouteNode);
    const edgeCond = captured.find((c) => c.table === ewohRouteEdge);
    expect(nodeCond).toBeDefined();
    expect(edgeCond).toBeDefined();
    expect(containsNode(nodeCond?.cond, ewohRouteNode.orgId)).toBe(true);
    expect(containsNode(edgeCond?.cond, ewohRouteEdge.orgId)).toBe(true);
    expect(flattenSQL(nodeCond?.cond)).toContain('ORG-2');
  });

  it('无 actor → 两表读取无 where 条件（内部可信流，RLS 兜底）', async () => {
    const { db, captured } = makeRoutingDb();
    const service = new RoutingService(db as never, undefined as never);
    await service.loadGraph();
    expect(captured).toEqual([]);
  });
});
