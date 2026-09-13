/**
 * 设备执行事实接入（`device_receipt` 唯一写入方）单测。
 *
 * 这个 spec 锁定的**不是**"接口能跑通"，而是**防伪造不变量**：
 * 一条现场回执能否成为**生产训练样本**，取决于它的来源标签；而来源标签只能由
 * 机器身份（带 org 绑定的 ingest key）写出，且即便如此，仍要过
 * `receiptProvenance` / `evaluateTrainingSample` 的独立判定。
 *
 * 因此本文件里的后半段（"即便写入成功也仍不可训练"）比前半段更重要：
 * 它是"没有为了让模型能训练而放宽那道门"的可执行证据。
 */
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { DeviceExecutionReceiptService } from '../device-execution-receipt.service';
import { ewohSchedulingExecution } from '@server/database/schema';
import { makeConditionMatcher } from '../../../../test/helpers/drizzle-fake-matcher';
import {
  DEVICE_RECEIPT_SOURCE,
  receiptProvenance,
  type ReceiptFact,
} from '../../scheduler/execution-receipt-provenance';
import { evaluateTrainingSample } from '../../scheduler/prediction/training-sample-eligibility';

const ORG = 'ORG-1';
const DEVICE = 'exo-1';
const ASSIGNMENT = 'ASG-1';

/** 绑定了 org 的机器身份上下文（IngestGuard 正常路径）。 */
const BOUND_CTX = {
  userId: 'ingest',
  primaryOrgId: ORG,
  accessibleOrgIds: [ORG],
  isGlobalAdmin: false,
  ingestKeyBoundOrgId: ORG,
} as never;

/** legacy 无绑定 key：org 由客户端自报 —— 必须被拒。 */
const UNBOUND_CTX = {
  userId: 'ingest',
  primaryOrgId: ORG,
  accessibleOrgIds: [ORG],
  isGlobalAdmin: false,
  ingestKeyBoundOrgId: null,
} as never;

function makeFakeDb(rows: Array<Record<string, unknown>>) {
  const updates: Array<Record<string, unknown>> = [];
  return {
    updates,
    select: () => ({
      from: () => ({
        where: () => ({
          // 服务层用 SELECT ... FOR UPDATE 串行化两条写路径（读-改-写竞态）。
          for: () => ({
            limit: async () => rows,
          }),
        }),
      }),
    }),
    update: () => {
      const set = (values: Record<string, unknown>) => {
        const where = () => {
          updates.push(values);
          // 服务层以 returning 命中行数判定 CAS 是否生效（0 行 = 并发冲突）。
          return {
            returning: async () => [{ id: 'uuid-1' }],
          };
        };
        return { where };
      };
      return { set };
    },
  };
}

function makeService(rows: Array<Record<string, unknown>>) {
  const db = makeFakeDb(rows);
  const audit = { appendAuditLog: jest.fn().mockResolvedValue(undefined) };
  const ctx = { runInTransaction: async (_guc: unknown, fn: () => Promise<unknown>) => fn() };
  const service = new DeviceExecutionReceiptService(
    db as never,
    ctx as never,
    audit as never,
  );
  return { service, db, audit };
}

function executionRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'uuid-1',
    executionId: 'EXE-1',
    orgId: ORG,
    assignmentId: ASSIGNMENT,
    deviceId: DEVICE,
    status: 'DISPATCHED',
    source: 'dispatch',
    actualStartAt: null,
    actualEndAt: null,
    ...overrides,
  };
}

function fact(overrides: Record<string, unknown> = {}) {
  return {
    deviceId: DEVICE,
    assignmentId: ASSIGNMENT,
    actualStartAt: '2026-09-13T08:00:00.000Z',
    status: 'STARTED' as const,
    ...overrides,
  } as never;
}

describe('DeviceExecutionReceiptService（device_receipt 唯一写入方）', () => {
  it('带 org 绑定的 key：写入成功且来源为 device_receipt', async () => {
    const { service, db, audit } = makeService([executionRow()]);
    const result = await service.recordFact(fact(), BOUND_CTX);

    expect(result.source).toBe(DEVICE_RECEIPT_SOURCE);
    expect(result.status).toBe('STARTED');
    expect(db.updates).toHaveLength(1);
    expect(db.updates[0].source).toBe('device_receipt');
    // 设备测得的开始时间被如实落库（不是服务端补的时间）。
    expect((db.updates[0].actualStartAt as Date).toISOString()).toBe('2026-09-13T08:00:00.000Z');
    expect(audit.appendAuditLog).toHaveBeenCalledTimes(1);
  });

  it('**legacy 无绑定 key 一律拒绝**（防"客户端自报租户"产出可训练来源）', async () => {
    const { service, db } = makeService([executionRow()]);
    await expect(service.recordFact(fact(), UNBOUND_CTX)).rejects.toBeInstanceOf(ForbiddenException);
    expect(db.updates).toHaveLength(0);
  });

  it('key 绑定 org 与请求租户不一致 → 拒绝', async () => {
    const { service } = makeService([executionRow()]);
    const mismatched = { ...(BOUND_CTX as Record<string, unknown>), primaryOrgId: 'ORG-2' } as never;
    await expect(service.recordFact(fact(), mismatched)).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('未知 assignment → 404（设备事实不创建计划）', async () => {
    const { service, db } = makeService([]);
    await expect(service.recordFact(fact(), BOUND_CTX)).rejects.toBeInstanceOf(NotFoundException);
    expect(db.updates).toHaveLength(0);
  });

  it('执行行未绑定设备 → 403（缺数据不是放行理由）', async () => {
    const { service } = makeService([executionRow({ deviceId: null })]);
    await expect(service.recordFact(fact(), BOUND_CTX)).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('设备不得替他人背书：上报设备 ≠ 执行行设备 → 403', async () => {
    const { service, db } = makeService([executionRow()]);
    await expect(
      service.recordFact(fact({ deviceId: 'exo-other' }), BOUND_CTX),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(db.updates).toHaveLength(0);
  });

  it('缺 actualStartAt → 400（服务端不代填测量时间）', async () => {
    const { service, db } = makeService([executionRow()]);
    await expect(
      service.recordFact(fact({ actualStartAt: undefined }), BOUND_CTX),
    ).rejects.toBeInstanceOf(BadRequestException);
    await expect(
      service.recordFact(fact({ actualStartAt: 'not-a-time' }), BOUND_CTX),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(db.updates).toHaveLength(0);
  });

  it('status=COMPLETED 必须带 actualEndAt，且 end 不得早于 start', async () => {
    const { service } = makeService([executionRow()]);
    await expect(
      service.recordFact(fact({ status: 'COMPLETED' }), BOUND_CTX),
    ).rejects.toBeInstanceOf(BadRequestException);
    await expect(
      service.recordFact(
        fact({ status: 'COMPLETED', actualEndAt: '2026-09-13T07:00:00.000Z' }),
        BOUND_CTX,
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('status 词表外 → 400（不猜设备状态）', async () => {
    const { service } = makeService([executionRow()]);
    await expect(
      service.recordFact(fact({ status: 'FINISHED' }), BOUND_CTX),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('执行行已处于终态 → 400（不再接受设备事实）', async () => {
    const { service, db } = makeService([executionRow({ status: 'COMPLETED' })]);
    await expect(service.recordFact(fact(), BOUND_CTX)).rejects.toBeInstanceOf(BadRequestException);
    expect(db.updates).toHaveLength(0);
  });

  it('人工暂停（PAUSED）后的执行行仍接受设备测得的 COMPLETED（与 HTTP 状态机 PAUSED→COMPLETED 同源）', async () => {
    // 真实缺陷：词表曾写成 ['PLANNED','DISPATCHED','STARTED','IN_PROGRESS']——
    // IN_PROGRESS 在全仓不存在（真实机器是 PAUSED），PAUSED 缺失 → 人工经 HTTP 回执
    // 暂停后，设备测得的完成事实永远被 400 拒收，测量凭空丢失。
    const { service, db } = makeService([executionRow({ status: 'PAUSED' })]);
    const result = await service.recordFact(
      fact({
        status: 'COMPLETED',
        actualEndAt: '2026-09-13T09:00:00.000Z',
      }),
      BOUND_CTX,
    );
    expect(result.status).toBe('COMPLETED');
    expect(db.updates).toHaveLength(1);
    expect(db.updates[0].source).toBe('device_receipt');
  });
});

/**
 * 读-改-写竞态回归（2026-09-13 对抗式自查实测复现）：
 * at-least-once 桥的乱序/重试帧 + 两条写路径并发时，读快照（可推进）与写入之间
 * 并发事务可能已把执行行推进到终态——此前的无条件 UPDATE 会把 COMPLETED 覆盖回
 * STARTED（状态回退 + 训练证据消失）。修复 = SELECT FOR UPDATE + UPDATE 带状态
 * 守卫（CAS），0 行命中显式 409。
 */
describe('DeviceExecutionReceiptService 读-改-写竞态（CAS 守卫）', () => {
  const EXEC_COLS: Record<string, string> = {
    id: 'id',
    status: 'status',
    org_id: 'orgId',
    assignment_id: 'assignmentId',
  };

  /** 条件感知假库：update 真正求值 where；onBeforeUpdate 模拟并发事务先行提交。 */
  function makeRacingDb(seed: {
    row: Record<string, unknown>;
    onBeforeUpdate?: () => void;
  }) {
    const row = seed.row;
    const updates: Array<Record<string, unknown>> = [];
    const matches = makeConditionMatcher(EXEC_COLS);
    const db = {
      select: () => ({
        from: () => ({
          where: () => ({
            for: () => ({
              limit: async () => [row],
            }),
          }),
        }),
      }),
      insert: () => ({
        values: async (v: Record<string, unknown>) => v,
      }),
      update: () => {
        const set = (values: Record<string, unknown>) => {
          const where = (cond: unknown) => {
            seed.onBeforeUpdate?.();
            const hit = [row].filter((candidate) => matches(cond, candidate));
            for (const candidate of hit) Object.assign(candidate, values);
            updates.push(values);
            return {
              returning: async () => hit.map((candidate) => ({ id: candidate.id })),
            };
          };
          return { where };
        };
        return { set };
      },
      execute: async () => undefined,
    };
    return { db, updates, row };
  }

  it('迟到的 STARTED 不得把并发已 COMPLETED 的执行行改回 STARTED（0 行命中 → 409）', async () => {
    let racing: ReturnType<typeof makeRacingDb>;
    racing = makeRacingDb({
      row: executionRow(),
      // 并发事务（COMPLETED 回执）恰在本事务的 UPDATE 求值前提交。
      onBeforeUpdate: () => {
        racing.row.status = 'COMPLETED';
        racing.row.actualEndAt = new Date('2026-09-13T09:00:00.000Z');
      },
    });
    const audit = { appendAuditLog: jest.fn().mockResolvedValue(undefined) };
    const ctx = { runInTransaction: async (_g: unknown, fn: () => Promise<unknown>) => fn() };
    const service = new DeviceExecutionReceiptService(
      racing.db as never,
      ctx as never,
      audit as never,
    );
    await expect(
      service.recordFact(fact({ status: 'STARTED' }), BOUND_CTX),
    ).rejects.toBeInstanceOf(ConflictException);
    // 状态没有被回退：仍是并发事务写入的 COMPLETED。
    expect(racing.row.status).toBe('COMPLETED');
  });
});

/**
 * **关键不变量**：设备事实写入**并不**自动让它可训练。
 *
 * 这是"没有为了让模型能训练而放宽门禁"的可执行证据——写入来源只是必要条件，
 * 判定权仍在 `receiptProvenance` / `evaluateTrainingSample` 手里。
 */
describe('device_receipt 写入 ≠ 可训练（防伪造不变量）', () => {
  // 注意两套词表不要混：**方案**状态是小写（approved/dispatched/…），
  // **执行行**状态是大写（PLANNED/STARTED/COMPLETED）。真实系统里两者不同源。
  const base: ReceiptFact = {
    orgId: ORG,
    planId: 'PLAN-1',
    taskId: 'TASK-1',
    assignmentId: ASSIGNMENT,
    executionId: 'EXE-1',
    deviceId: DEVICE,
    isShadow: false,
    createdBy: 'admin',
    confirmedBy: 'approver.li',
    confirmedAt: '2026-09-13T07:00:00.000Z',
    actualStartAt: '2026-09-13T08:00:00.000Z',
    actualEndAt: '2026-09-13T09:00:00.000Z',
    triggerType: 'MANUAL',
  };

  function provenanceWith(overrides: {
    plan?: Partial<ReceiptFact>;
    task?: Partial<ReceiptFact>;
    device?: Partial<ReceiptFact>;
    execution?: Partial<ReceiptFact>;
  }) {
    const plan: ReceiptFact = { ...base, status: 'approved', ...overrides.plan };
    const task: ReceiptFact = { ...base, id: 'TASK-1', source: 'real', ...overrides.task };
    const device: ReceiptFact = { ...base, id: DEVICE, sourceType: 'real', ...overrides.device };
    const execution: ReceiptFact = { ...base, status: 'COMPLETED', ...overrides.execution };
    return receiptProvenance({
      orgId: ORG,
      plan,
      task,
      device,
      execution,
      // 设备行在 HTTP 应用之前就已持久化为 device_receipt + COMPLETED。
      persistedExecution: { ...execution, source: DEVICE_RECEIPT_SOURCE },
    });
  }

  it('全链 real 时，来源为 real 且获准训练（这条路径此前不可达）', () => {
    const result = provenanceWith({});
    expect(result.source).toBe('real');
    expect(result.productionTrainingEligible).toBe(true);
  });

  it('设备来源为 simulated → 即便写了 device_receipt 也**不可训练**', () => {
    const result = provenanceWith({ device: { sourceType: 'simulated' } });
    expect(result.source).toBe('simulated');
    expect(result.productionTrainingEligible).toBe(false);
  });

  it('任务来源为 simulated → 不可训练', () => {
    const result = provenanceWith({ task: { source: 'simulated' } });
    expect(result.productionTrainingEligible).toBe(false);
  });

  it('方案为 shadow → 不可训练', () => {
    const result = provenanceWith({ plan: { isShadow: true } });
    expect(result.productionTrainingEligible).toBe(false);
  });

  it('审批人 = 生成人（非独立审批）→ 不可训练', () => {
    const result = provenanceWith({ plan: { confirmedBy: 'admin' } });
    expect(result.productionTrainingEligible).toBe(false);
  });

  it('方案未处于可训练状态（draft）→ 不可训练', () => {
    const result = provenanceWith({ plan: { status: 'draft' } });
    expect(result.productionTrainingEligible).toBe(false);
  });

  it('样本资格判定独立于行级标记：provenance 非 real 时不可训练', () => {
    const verdict = evaluateTrainingSample({
      receiptSource: 'real',
      productionTrainingEligible: true,
      provenanceJson: {
        policy: 'receipt-provenance-v1',
        source: 'simulated',
        independentReceipt: { policy: 'persisted-device-receipt-v1', source: 'device_receipt' },
      },
      actualStart: new Date('2026-09-13T08:00:00.000Z'),
      actualEnd: new Date('2026-09-13T09:00:00.000Z'),
    });
    expect(verdict.trainable).toBe(false);
    expect(verdict.reason).toBe('provenance_policy_mismatch');
  });
});

describe('device_receipt 只由本路径产出（写入面收敛）', () => {
  it('schema 中 ewoh_scheduling_execution 的 source 默认值不是 device_receipt', () => {
    // 锁住"默认值不会意外产出 device_receipt"——默认应为非设备来源。
    const column = (ewohSchedulingExecution as unknown as {
      source?: { default?: unknown; hasDefault?: boolean };
    }).source;
    expect(column).toBeDefined();
    expect(String((column as { default?: unknown })?.default ?? '')).not.toContain(DEVICE_RECEIPT_SOURCE);
  });

  it('**静态扫描**：整个 server 源码里 device_receipt 字面量只出现在允许的写入/定义面', () => {
    // 为什么值得一条静态守卫：`device_receipt` 是"这条回执能否成为生产训练样本"的
    // 总开关。一旦有人在别处（例如某个 HTTP 回执适配器里"顺手"写上它），
    // 防伪造不变量就会静默失效——而那不会让任何既有测试变红。
    // 因此把"允许出现的位置"写成显式白名单：新增写入点必须**显式**修改本清单，
    // 于是它必然经过一次人工评审，而不是悄悄溜进去。
    const { readdirSync, readFileSync, statSync } = require('node:fs') as typeof import('node:fs');
    const { join } = require('node:path') as typeof import('node:path');

    const ALLOWED = [
      // 来源常量定义（`DEVICE_RECEIPT_SOURCE`）+ 资格判定的读侧。
      'scheduler/execution-receipt-provenance.ts',
      // 训练样本资格判定的读侧（比对 evidence.source）。
      'scheduler/prediction/training-sample-eligibility.ts',
      // **唯一写入方**。
      'ingest/device-execution-receipt.service.ts',
    ];
    const root = join(__dirname, '..', '..');
    const hits: string[] = [];
    const walk = (dir: string) => {
      for (const entry of readdirSync(dir)) {
        const full = join(dir, entry);
        if (statSync(full).isDirectory()) {
          if (entry === '__tests__' || entry === 'node_modules') continue;
          walk(full);
          continue;
        }
        if (!entry.endsWith('.ts') || entry.endsWith('.spec.ts')) continue;
        const rel = full.slice(root.length + 1);
        if (ALLOWED.includes(rel)) continue;
        const text = readFileSync(full, 'utf8');
        // 只在**代码**里找字面量（注释里提到它是允许的：注释是解释，不是写入面）。
        const codeOnly = text
          .replace(/\/\*[\s\S]*?\*\//g, '')
          .replace(/^\s*\/\/.*$/gm, '');
        if (codeOnly.includes(`'${DEVICE_RECEIPT_SOURCE}'`) || codeOnly.includes(`"${DEVICE_RECEIPT_SOURCE}"`)) {
          hits.push(rel);
        }
      }
    };
    walk(root);

    expect(hits).toEqual([]);
  });
});
