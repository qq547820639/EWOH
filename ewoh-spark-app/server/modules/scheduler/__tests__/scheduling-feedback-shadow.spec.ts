/* R-3（2026-09-13）学习腿接线：采样腿 + 回填腿 + canary 自动回退 regression。
 *
 * 背景（全仓最高价值的缺口）：ShadowEvaluatorService.recordSample/backfillActual 在生产路径
 * 无任何调用方，SchedulingFeedbackService 注入了 shadowEvaluatorService 却零使用（死依赖），
 * prediction_shadow_observation 生产恒空、autoRollbackOn 永不触发。
 *
 * 本 spec 锁定的不变量：
 *  1) canary 缺省 0 → 采样腿/回填腿都不动作（不调用预测提供者、不写观测）——接线不得改变默认行为；
 *  2) canary>0 → 采样一条带稳定 correlationId 的观测（prediction=模型值，baseline=求解器实际时长）；
 *  3) recordActuals 命中真实回执后按同一 correlationId 精确回填 actual（actual_end − actual_start）；
 *  4) 回执未命中 / 缺 actualStart|actualEnd → 不回填（§33 不伪造 actual）；
 *  5) 误差超阈值 → canary 自动回退至 0；误差达标 → 不回退（阈值判定双向可触发）。
 */
/// <reference types="jest" />
import { SchedulingFeedbackService } from '../scheduling-feedback.service';
import { SchedulerEventApplicationService } from '../scheduler-event-application.service';
import { RequestDatabaseContext } from '@server/database/request-database-context';
import { ShadowEvaluatorService } from '../prediction/shadow-evaluator.service';
import { makeFakeDb, testOrgContext } from './dispatch-test-harness';

describe('SchedulingFeedbackService × Prediction Shadow Learning（R-3 学习腿接线）', () => {
  const planId = 'PLAN-FB-1';
  const assignmentId = 'ASG-FB-1';
  const taskId = 'TASK-FB-1';
  const CORRELATION_ID = `${planId}|${assignmentId}|${taskId}`;

  /** plannedEnd − plannedStart = 30min（求解器采用的确定性基线时长，ms）。 */
  const BASELINE_MS = 1_800_000;

  function seedPlan() {
    return {
      plans: [
        {
          planId,
          planName: '计划-shadow',
          strategy: 'scheduler-v2',
          status: 'dispatched',
          triggerEntityId: 'RUN-1',
          orgId: 'org1',
          snapshotVersion: 'ws-v9',
          policyVersion: 7,
          metricsJson: { solveDurationMs: 250, solverStatus: 'OPTIMAL' },
        },
      ],
      assignments: [
        {
          assignmentId,
          planId,
          taskId,
          personId: 'p1',
          deviceId: 'd1',
          stationId: 's1',
          plannedStart: new Date('2026-08-08T08:00:00.000Z'),
          plannedEnd: new Date('2026-08-08T08:30:00.000Z'),
          etaSeconds: 240,
        },
      ],
    };
  }

  /** 规范回执替身：默认命中 1 行（真实执行事实存在）。 */
  function makeReceiptService(matchedRows = 1) {
    return {
      applyFromActuals: jest.fn().mockResolvedValue({
        receipt: {
          matchedRows,
          advancedAssignments: matchedRows,
          advancedTaskSteps: 0,
          skips: matchedRows > 0 ? [] : ['receipt:not_matched'],
          policy: 'receipt-provenance-v1',
          source: 'unknown',
          productionTrainingEligible: false,
          reason: 'test',
          evidence: {},
        },
      }),
    };
  }

  function buildService(opts: {
    prediction?: number;
    modelVersion?: string;
    withShadow?: boolean;
    withProvider?: boolean;
    matchedRows?: number;
    seed?: Parameters<typeof makeFakeDb>[0];
  } = {}) {
    const { db, state } = makeFakeDb(opts.seed ?? seedPlan());
    const requestDatabaseContext = {
      runInTransaction: jest.fn(async (_guc: unknown, cb: () => Promise<void>) => {
        await cb();
      }),
    };
    const receiptService = makeReceiptService(opts.matchedRows ?? 1);
    const shadow = opts.withShadow === false ? undefined : new ShadowEvaluatorService();
    const provider =
      opts.withProvider === false
        ? undefined
        : {
            predictTaskDuration: jest.fn().mockResolvedValue({
              value: opts.prediction ?? 1_200_000,
              modelVersion: opts.modelVersion ?? 'empirical-v1',
              confidence: 0.9,
              source: 'ml',
            }),
          };
    const svc = new SchedulingFeedbackService(
      db,
      requestDatabaseContext as unknown as RequestDatabaseContext,
      shadow as never,
      undefined,
      receiptService as never,
      provider as never,
    );
    return { svc, db, state, receiptService, shadow, provider };
  }

  const ctx = testOrgContext();

  it('canary 缺省 0：不采样、不调用预测提供者（接线前行为逐字节一致）', async () => {
    const { svc, shadow, provider } = buildService();
    expect(shadow!.getCanaryFraction(ctx)).toBe(0);

    await svc.recordBaseline(planId, { runId: 'RUN-1' }, ctx);

    expect(shadow!.listSamples(ctx)).toHaveLength(0);
    expect(provider!.predictTaskDuration).not.toHaveBeenCalled();
  });

  it('canary>0：采样一条带稳定 correlationId 的观测（prediction=模型值，baseline=求解器实际时长）', async () => {
    const { svc, shadow, provider } = buildService();
    shadow!.setCanaryFraction(1, ctx);

    await svc.recordBaseline(planId, { runId: 'RUN-1' }, ctx);

    const samples = shadow!.listSamples(ctx);
    expect(samples).toHaveLength(1);
    expect(samples[0].correlationId).toBe(CORRELATION_ID);
    expect(samples[0].taskId).toBe(taskId);
    expect(samples[0].predictionType).toBe('task_duration');
    expect(samples[0].prediction).toBe(1_200_000);
    expect(samples[0].baseline).toBe(BASELINE_MS);
    expect(samples[0].modelVersion).toBe('empirical-v1');
    expect(samples[0].inputVersion).toBe('ws-v9');
    expect(samples[0].snapshotVersion).toBe('ws-v9');
    expect(samples[0].policyVersion).toBe(7);
    expect(samples[0].actual).toBeNull();
    // 预测提供者必须收到任务标识（否则模型分不出 org/任务语义）。
    expect(provider!.predictTaskDuration).toHaveBeenCalledWith(
      expect.objectContaining({ taskId, orgId: 'org1' }),
    );
  });

  it('回填腿：recordActuals 命中真实回执后按 correlationId 回填 actual 并算误差', async () => {
    const { svc, shadow } = buildService();
    shadow!.setCanaryFraction(1, ctx);
    await svc.recordBaseline(planId, { runId: 'RUN-1' }, ctx);

    // 实际比计划晚 2 分钟开始、晚 5 分钟结束 → 真实时长 33min = 1_980_000ms。
    await svc.recordActuals(
      {
        planId,
        assignmentId,
        taskId,
        actualStart: '2026-08-08T08:02:00.000Z',
        actualEnd: '2026-08-08T08:35:00.000Z',
      },
      ctx,
    );

    const [sample] = shadow!.listSamples(ctx);
    expect(sample.actual).toBe(1_980_000);
    expect(sample.absoluteError).toBe(Math.abs(1_200_000 - 1_980_000));
    expect(sample.relativeError).toBeCloseTo(780_000 / 1_980_000);
  });

  it('误差超阈值 → canary 自动回退至 0（advisory-only：只改采样比例）', async () => {
    const { svc, shadow } = buildService();
    // 0.7 > 种子归一值 0.641（correlationId 的确定性哈希）→ 本方案必被采样。
    shadow!.setCanaryFraction(0.7, ctx);
    await svc.recordBaseline(planId, { runId: 'RUN-1' }, ctx);
    expect(shadow!.getCanaryFraction(ctx)).toBe(0.7);
    expect(shadow!.listSamples(ctx)).toHaveLength(1);

    await svc.recordActuals(
      {
        planId,
        assignmentId,
        taskId,
        actualStart: '2026-08-08T08:00:00.000Z',
        actualEnd: '2026-08-08T08:30:00.000Z',
      },
      ctx,
    );

    // MAE=600_000ms ≫ autoRollbackOn.maxAbsoluteError(0.25，与样本同单位) → 回退。
    expect(shadow!.getCanaryFraction(ctx)).toBe(0);
    expect(shadow!.shouldSample(123, ctx)).toBe(false);
  });

  it('误差达标（预测=实际）→ 不回退，canary 保持（阈值判定双向）', async () => {
    const { svc, shadow } = buildService({ prediction: BASELINE_MS });
    shadow!.setCanaryFraction(0.7, ctx);
    await svc.recordBaseline(planId, { runId: 'RUN-1' }, ctx);

    await svc.recordActuals(
      {
        planId,
        assignmentId,
        taskId,
        actualStart: '2026-08-08T08:00:00.000Z',
        actualEnd: '2026-08-08T08:30:00.000Z',
      },
      ctx,
    );

    const agg = shadow!.aggregate(ctx);
    expect(agg.mae).toBe(0);
    expect(agg.coverage).toBe(1);
    expect(agg.fallbackRate).toBe(0);
    expect(shadow!.getCanaryFraction(ctx)).toBe(0.7);
  });

  it('采样判定由 shouldSample(稳定种子) 决定：canary=0.5 时同一方案不采样', async () => {
    const { svc, shadow, provider } = buildService();
    // 同一 correlationId 的种子归一值 0.641 ≥ 0.5 → 不采样（与 canary=0.7 的判定互补，
    // 证明采样比例是确定性函数而非随机噪声）。
    shadow!.setCanaryFraction(0.5, ctx);
    await svc.recordBaseline(planId, { runId: 'RUN-1' }, ctx);

    expect(shadow!.listSamples(ctx)).toHaveLength(0);
    expect(provider!.predictTaskDuration).not.toHaveBeenCalled();
  });

  it('缺 actualStart/actualEnd → 不回填（不补 0、不猜时长）', async () => {
    const { svc, shadow } = buildService();
    shadow!.setCanaryFraction(1, ctx);
    await svc.recordBaseline(planId, { runId: 'RUN-1' }, ctx);

    await svc.recordActuals({ planId, assignmentId, taskId }, ctx);

    expect(shadow!.listSamples(ctx)[0].actual).toBeNull();
    expect(shadow!.getCanaryFraction(ctx)).toBe(1);
  });

  it('回执未命中任何行 → 不回填（没有真实执行事实就不造 actual）', async () => {
    const { svc, shadow } = buildService({ matchedRows: 0 });
    shadow!.setCanaryFraction(1, ctx);
    await svc.recordBaseline(planId, { runId: 'RUN-1' }, ctx);

    await svc.recordActuals(
      {
        planId,
        assignmentId,
        taskId,
        actualStart: '2026-08-08T08:00:00.000Z',
        actualEnd: '2026-08-08T08:30:00.000Z',
      },
      ctx,
    );

    expect(shadow!.listSamples(ctx)[0].actual).toBeNull();
  });

  it('未注入 ShadowEvaluatorService 或预测提供者：反馈写入照常，绝不抛错', async () => {
    // 无 shadow 服务（既有直构组成）。
    const a = buildService({ withShadow: false });
    await expect(a.svc.recordBaseline(planId, { runId: 'RUN-1' }, ctx)).resolves.toBe(1);
    await expect(
      a.svc.recordActuals(
        {
          planId,
          assignmentId,
          actualStart: '2026-08-08T08:00:00.000Z',
          actualEnd: '2026-08-08T08:30:00.000Z',
        },
        ctx,
      ),
    ).resolves.toBeDefined();

    // 有 shadow 但无预测提供者：canary>0 也显式不采样（不伪造 prediction）。
    const b = buildService({ withProvider: false });
    b.shadow!.setCanaryFraction(1, ctx);
    await b.svc.recordBaseline(planId, { runId: 'RUN-1' }, ctx);
    expect(b.shadow!.listSamples(ctx)).toHaveLength(0);
  });

  it('预测提供者抛错 → 采样跳过，反馈基线写入不受影响', async () => {
    const { svc, shadow, provider } = buildService();
    shadow!.setCanaryFraction(1, ctx);
    provider!.predictTaskDuration.mockRejectedValueOnce(new Error('model down'));

    await expect(svc.recordBaseline(planId, { runId: 'RUN-1' }, ctx)).resolves.toBe(1);
    expect(shadow!.listSamples(ctx)).toHaveLength(0);
  });

  /**
   * 自查修正（2026-09-13）回归：分波派工下 recordBaseline 会被同一 plan 反复调用
   * （每波成功后一次，已派波次的 feedback 行走 update 分支）。采样只允许发生在
   * **首基线**——否则同一 correlationId 会被重复写入永远无法回填的开放样本
   * （一条回执只关一条，实测两波同一 assignment → 2 条样本），coverage 被钉在
   * ≤1/波数，canary 被迫回退。
   * 注：用单 assignment 方案——本 harness 的 fake select 不解析 WHERE 谓词，
   * 多 assignment 方案内第二条会误命中第一条刚插入的 feedback 行（替身局限，
   * 与被测的重复基线门控无关）。
   */
  it('同一 plan 重复基线（分波派工）：同一 assignment 仍只采一条样本', async () => {
    const { svc, shadow } = buildService();
    shadow!.setCanaryFraction(1, ctx);

    await svc.recordBaseline(planId, { runId: 'RUN-1' }, ctx); // 波 1
    await svc.recordBaseline(planId, { runId: 'RUN-1' }, ctx); // 波 2（重复基线）

    const samples = shadow!.listSamples(ctx);
    expect(samples).toHaveLength(1);
    expect(samples[0].correlationId).toBe(CORRELATION_ID);
  });

  /**
   * 自查修正（2026-09-13）回归：生产回执路径是
   * POST /feedback/actuals → SchedulerEventApplicationService.recordTaskActuals →
   * ExecutionReceiptApplicationService.applyFromActuals（**直达**，绕过本类
   * recordActuals）。该路径必须显式回调 backfillShadowActuals，否则生产回执永远
   * 不回填 shadow 样本（actual 恒 NULL，学习腿在采样腿接好的同时再次断链）。
   */
  it('生产回执路径（recordTaskActuals 直达规范回执服务）也触发 shadow 回填', async () => {
    const { svc, shadow } = buildService();
    const eventApp = new SchedulerEventApplicationService(
      undefined,
      undefined,
      undefined,
      undefined,
      undefined as never,
      undefined as never,
      undefined as never,
      undefined as never,
      svc as never,
      async () => {
        throw new Error('not used');
      },
      {
        applyFromActuals: jest.fn().mockResolvedValue({
          receipt: {
            matchedRows: 1,
            advancedAssignments: 1,
            advancedTaskSteps: 0,
            skips: [],
            policy: 'receipt-provenance-v1',
            source: 'manual_report',
            productionTrainingEligible: false,
            reason: 'test',
            evidence: {},
          },
        }),
      } as never,
    );
    shadow!.setCanaryFraction(1, ctx);
    await svc.recordBaseline(planId, { runId: 'RUN-1' }, ctx);

    await eventApp.recordTaskActuals(
      {
        planId,
        assignmentId,
        taskId,
        actualStart: '2026-08-08T08:02:00.000Z',
        actualEnd: '2026-08-08T08:35:00.000Z',
      },
      ctx,
    );

    const [sample] = shadow!.listSamples(ctx);
    expect(sample.actual).toBe(1_980_000);
  });
});
