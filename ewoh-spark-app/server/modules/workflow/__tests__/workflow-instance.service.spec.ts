/* WorkflowInstanceService fail-closed 回归（R2-SNZ-003，收敛 NEST-625）。
 *
 * 原先 list/advance 的 orgCond 判定为 `isGlobalAdmin || !primaryOrgId →
 * undefined`（fail-open）：无租户上下文的请求可见/可操作全部租户的工作流
 * 实例；start() 的 orgId 缺省时省略写入。现对齐仓库 fail-closed 模式：
 * global_admin 放行，否则缺租户一律 400，非 global 强制本租户谓词。
 */
/// <reference types="jest" />
import { BadRequestException } from '@nestjs/common';
import { WorkflowInstanceService } from '../workflow-instance.service';
import { WorkflowService } from '../workflow.service';

const ORG_A = 'org-a';
const ORG_B = 'org-b';

function leafValues(cond: unknown): Array<string | number> {
  const out: Array<string | number> = [];
  const seen = new WeakSet<object>();
  (function walk(node: unknown) {
    if (node == null || typeof node !== 'object') return;
    if (seen.has(node as object)) return;
    seen.add(node as object);
    if (Array.isArray(node)) {
      for (const el of node) {
        // 嵌套 sql 模板的数字字面量以裸值出现在 chunks 数组（字符串裸值
        // 是 SQL 定界符如 "("，不可收集）。
        if (typeof el === 'number') out.push(el);
        else walk(el);
      }
      return;
    }
    for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
      if (key === 'value' && (typeof value === 'string' || typeof value === 'number')) {
        out.push(value);
      } else {
        walk(value);
      }
    }
  })(cond);
  return out;
}

interface InstanceRow {
  orgId: string;
  configKey: string;
  configValue: Record<string, unknown> | null;
  updatedBy: string | null;
  updatedAt: Date;
}

function instanceRow(overrides: Partial<InstanceRow> = {}): InstanceRow {
  return {
    orgId: ORG_A,
    configKey: 'workflow.wf1.entity-1',
    configValue: {
      workflowId: 'wf1',
      entityId: 'entity-1',
      currentStep: 'start',
      status: 'active',
      history: [],
    },
    updatedBy: 'user-1',
    updatedAt: new Date('2026-08-16T10:00:00Z'),
    ...overrides,
  };
}

function createWorkflowDb(rows: InstanceRow[]) {
  const whereLeaves: Array<Array<string | number>> = [];
  const thenable = (data: unknown[]) => ({
    then: (resolve: (v: unknown[]) => void) => resolve(data),
    orderBy: jest.fn(() => thenable(data)),
  });
  const db = {
    select: jest.fn(() => ({
      from: jest.fn(() => ({
        where: jest.fn((cond: unknown) => {
          const leaves = leafValues(cond);
          whereLeaves.push(leaves);
          const matched = rows.filter((r) => {
            const vals = [r.orgId, r.configKey];
            return leaves.every((leaf) => {
              const text = String(leaf);
              if (text.includes('%')) {
                const prefix = text.replace(/%/g, '');
                return vals.some((v) => v.startsWith(prefix));
              }
              return vals.includes(text);
            });
          });
          return thenable(matched);
        }),
      })),
    })),
    insert: jest.fn(() => ({
      values: jest.fn(() => ({
        onConflictDoUpdate: jest.fn(() => ({
          returning: jest.fn(async () => [instanceRow()]),
        })),
      })),
    })),
    update: jest.fn(() => ({
      set: jest.fn(() => ({
        where: jest.fn(() => ({
          returning: jest.fn(async () => [instanceRow()]),
        })),
      })),
    })),
  };
  return { db, whereLeaves };
}

function actor(overrides: Record<string, unknown> = {}) {
  return {
    userId: 'user-1',
    primaryOrgId: ORG_A,
    roles: ['dispatcher'],
    isGlobalAdmin: false,
    ...overrides,
  };
}

function createService(db: unknown) {
  const workflowService = {
    validate: (workflow: unknown) => ({
      ...(workflow as Record<string, unknown>),
      start: 'start',
    }),
    advance: () => ({
      currentActionAllowed: true,
      allowedNextSteps: [{ name: 'step-2', action: 'go' }],
    }),
  };
  return new WorkflowInstanceService(
    workflowService as unknown as WorkflowService,
    db as never,
    { appendAuditLog: jest.fn(async () => undefined) } as never,
  );
}

describe('WorkflowInstanceService（R2-SNZ-003 fail-closed / NEST-625 收敛）', () => {
  it('list：缺租户 400（原先 fail-open 放行 = 全租户实例可见）', async () => {
    const { db } = createWorkflowDb([]);
    const service = createService(db);
    await expect(service.list(undefined)).rejects.toBeInstanceOf(BadRequestException);
    await expect(service.list(actor({ primaryOrgId: '' }))).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });

  it('list：非 global 仅见本租户实例；查询谓词含 org 值', async () => {
    const { db, whereLeaves } = createWorkflowDb([
      instanceRow({ configKey: 'workflow.wf1.e1' }),
      instanceRow({ configKey: 'workflow.wf2.e2', orgId: ORG_B }),
    ]);
    const service = createService(db);
    const rows = await service.list(actor());
    expect(rows).toHaveLength(1);
    expect(rows[0]?.key).toBe('workflow.wf1.e1');
    expect(whereLeaves[0]).toContain(ORG_A);
  });

  it('list：global_admin 放行（跨租户可见，与 RLS 例外一致）', async () => {
    const { db } = createWorkflowDb([
      instanceRow({ configKey: 'workflow.wf1.e1' }),
      instanceRow({ configKey: 'workflow.wf2.e2', orgId: ORG_B }),
    ]);
    const service = createService(db);
    const rows = await service.list(actor({ isGlobalAdmin: true }));
    expect(rows).toHaveLength(2);
  });

  it('advance：缺租户 400（原先可跨租户推进实例）', async () => {
    const { db } = createWorkflowDb([]);
    const service = createService(db);
    await expect(
      service.advance('workflow.wf1.e1', { roles: ['dispatcher'] }, undefined),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('advance：他租户 key → 404 语义（谓词过滤后不可见）', async () => {
    const { db } = createWorkflowDb([
      instanceRow({ configKey: 'workflow.wf1.e1', orgId: ORG_B }),
    ]);
    const service = createService(db);
    await expect(
      service.advance('workflow.wf1.e1', { roles: ['dispatcher'] }, actor()),
    ).rejects.toThrow('not found');
  });

  it('start：缺租户 400（原先省略 orgId 写入，orgId NOT NULL 裸 23502）', async () => {
    const { db } = createWorkflowDb([]);
    const service = createService(db);
    await expect(
      service.start({ workflow: { workflowId: 'wf1', steps: [] }, entityId: 'e1' }, undefined),
    ).rejects.toBeInstanceOf(BadRequestException);
  });
});
