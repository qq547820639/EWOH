/* duration-model-training.service.ts — 经验时长模型训练/激活闭环（NO-13g / ADR-056，§10/§12/§33）。
 *
 * 唯一权威写路径：真实执行反馈（ewoh_scheduling_feedback.actual_start/
 * actual_end）→ trainDurationModel → ewoh_model_registry 落版（supersede
 * 旧 active）+ 内存 provider 刷新。样本不足 → 显式 not_enough_data（不落版、
 * 不伪造，§33）；幂等（同一训练数据 → 同一模型，版本号由注册表递增）。
 */
import { Inject, Injectable, Logger, BadRequestException } from '@nestjs/common';
import { DRIZZLE_DATABASE, type PostgresJsDatabase } from '@lark-apaas/fullstack-nestjs-core';
import { and, desc, eq, inArray, isNotNull, like } from 'drizzle-orm';
import { ewohSchedulingFeedback, ewohProductionTask, ewohModelRegistry } from '@server/database/schema';
import {
  DURATION_MODEL_MIN_SAMPLES,
  durationModelVersion,
  isEmpiricalModelId,
  orgIdFromModelId,
  orgModelId,
  orgTaskTypeModelId,
  trainDurationModel,
  type DurationModel,
} from './empirical-duration-model';
import { PREDICTION_PROVIDER, type EmpiricalDurationPredictionProvider } from './empirical-duration-prediction-provider';
import {
  evaluateTrainingSample,
  TRAINING_REJECTION_LABELS,
  type TrainingRejectionReason,
} from './training-sample-eligibility';

/** NO-13r / ADR-067：per-taskType 分组训练结果（显式 skipped 不落版）。 */
export interface TaskTypeRetrainEntry {
  taskType: string;
  ok: boolean;
  model: DurationModel | null;
  version: string | null;
  notEnoughDataReason?: string;
}

/** 训练样本资格摘要（对应 GET predictions/task-duration/samples）。 */
export interface TrainingSampleSummary {
  orgId: string;
  sampleLimit: number;
  totalFeedbackRows: number;
  /** 通过行级标记（real + eligible + 有 provenance）的行数。 */
  flaggedEligible: number;
  /** 训练实际可用样本数（额外通过独立设备回执证据校验）。 */
  trainable: number;
  minSamplesRequired: number;
  fullyTrained: boolean;
  rejected: Partial<Record<TrainingRejectionReason, number>>;
  rejectedLabels: Record<string, string>;
  /** 资格策略标识：只有独立设备回执可训练生产模型。 */
  eligibilityPolicy: string;
}

export interface RetrainSummary {
  ok: boolean;
  model: DurationModel | null;
  version: string | null;
  /** 显式缺口（样本不足/无数据/失败）；ok=true 时为空。 */
  notEnoughDataReason?: string;
  /** NO-13r / ADR-067：per-taskType 分组结果（additive）。 */
  perTaskType?: TaskTypeRetrainEntry[];
}

@Injectable()
export class DurationModelTrainingService {
  private readonly logger = new Logger(DurationModelTrainingService.name);

  constructor(
    @Inject(DRIZZLE_DATABASE) private readonly db: PostgresJsDatabase,
    @Inject(PREDICTION_PROVIDER) private readonly provider: EmpiricalDurationPredictionProvider,
  ) {}

  /** 从本租户真实执行反馈加载时长样本 + 任务类型事实（actual_end − actual_start；
   *  两者缺一不可，§21 时间语义；org_id 过滤 §15/§16 租户隔离；taskType 来自
   *  ewoh_production_task 登记事实）。 */
  private async loadSamplesWithTaskType(
    orgId: string,
    limit = 2000,
  ): Promise<Array<{ taskType: string | null; duration: number }>> {
    const rows = await this.db
      .select()
      .from(ewohSchedulingFeedback)
      .where(and(
        eq(ewohSchedulingFeedback.orgId, orgId),
        eq(ewohSchedulingFeedback.receiptSource, 'real'),
        eq(ewohSchedulingFeedback.productionTrainingEligible, true),
        isNotNull(ewohSchedulingFeedback.provenanceJson),
        isNotNull(ewohSchedulingFeedback.actualStart),
        isNotNull(ewohSchedulingFeedback.actualEnd),
      ))
      .orderBy(desc(ewohSchedulingFeedback.updatedAt))
      .limit(limit);
    const taskIds = [...new Set(rows.map((r) => r.taskId).filter((id): id is string => Boolean(id)))];
    const taskRows = taskIds.length > 0
      ? await this.db
          .select()
          .from(ewohProductionTask)
          .where(inArray(ewohProductionTask.id, taskIds))
      : [];
    const typeById = new Map<string, string>();
    for (const task of taskRows) {
      if (task.taskType) typeById.set(task.id, task.taskType);
    }
    const samples: Array<{ taskType: string | null; duration: number }> = [];
    for (const row of rows) {
      // Revalidate the persisted evidence at training time. Flags are derived
      // metadata and may be stale or forged by old writers; only the canonical
      // independent device receipt lineage can enter production training.
      // 资格判定走共享纯函数（与资格统计同源；两处各写一份必然漂移，
      // 会让界面显示"可训练 N 条"而训练报样本不足）。
      const verdict = evaluateTrainingSample(row);
      if (!verdict.trainable || verdict.durationMs == null) continue;
      samples.push({ taskType: row.taskId ? (typeById.get(row.taskId) ?? null) : null, duration: verdict.durationMs });
    }
    return samples;
  }

  /**
   * 训练样本资格摘要（学习控制台用）。
   *
   * 为什么需要它：重训只回一句 "retrain_not_enough_data: ..." 时，用户无法知道
   * 是"没有真实回执"、"有真实回执但缺独立设备证据"，还是"设备证据与执行事实不一致"。
   * 这三者的处置完全不同。本摘要按**稳定枚举原因**给出可解释的计数，
   * 并明确区分两级资格（行级标记 vs 独立设备回执证据）——模拟/人工回执
   * 永远不计入可训练样本，这是设计边界而非缺陷。
   */
  async summarizeTrainingSamples(orgId: string, limit = 2000): Promise<TrainingSampleSummary> {
    const scoped = eq(ewohSchedulingFeedback.orgId, orgId);
    const rows = await this.db
      .select()
      .from(ewohSchedulingFeedback)
      .where(scoped)
      .orderBy(desc(ewohSchedulingFeedback.updatedAt))
      .limit(limit);

    const rejected: Partial<Record<TrainingRejectionReason, number>> = {};
    let trainable = 0;
    let flaggedEligible = 0;
    for (const row of rows) {
      if (row.receiptSource === 'real' && row.productionTrainingEligible === true && row.provenanceJson) {
        flaggedEligible += 1;
      }
      const verdict = evaluateTrainingSample(row);
      if (verdict.trainable) {
        trainable += 1;
        continue;
      }
      const reason = verdict.reason ?? 'flags_not_eligible';
      rejected[reason] = (rejected[reason] ?? 0) + 1;
    }

    return {
      orgId,
      /** 参与统计的反馈行上限（超出部分不参与，避免无界扫描）。 */
      sampleLimit: limit,
      totalFeedbackRows: rows.length,
      /** 通过行级标记的行数——**不等于**可训练数（还需独立设备证据）。 */
      flaggedEligible,
      /** 训练实际可用的样本数（与 retrain 的输入完全一致）。 */
      trainable,
      minSamplesRequired: DURATION_MODEL_MIN_SAMPLES,
      fullyTrained: trainable >= DURATION_MODEL_MIN_SAMPLES,
      rejected,
      rejectedLabels: Object.fromEntries(
        Object.keys(rejected).map((k) => [k, TRAINING_REJECTION_LABELS[k as TrainingRejectionReason]]),
      ),
      eligibilityPolicy: 'independent-device-receipt-required',
    };
  }

  /** 注册表落版（每 modelId 独立版本链：supersede 旧 active + 版本递增）。 */
  private async persistModel(
    modelId: string,
    model: DurationModel,
    cardExtras: Record<string, unknown> = {},
  ): Promise<string> {
    const existing = await this.db
      .select()
      .from(ewohModelRegistry)
      .where(eq(ewohModelRegistry.modelId, modelId))
      .orderBy(desc(ewohModelRegistry.version));
    let maxVersion = 0;
    for (const row of existing) {
      const parsed = Number(String(row.version).replace('empirical-v', ''));
      if (Number.isFinite(parsed) && parsed > maxVersion) maxVersion = parsed;
    }
    const nextVersion = maxVersion + 1;
    const version = durationModelVersion(nextVersion);
    const now = new Date();
    for (const row of existing) {
      if (row.status !== 'active') continue;
      await this.db
        .update(ewohModelRegistry)
        .set({ status: 'superseded', updatedAt: now })
        .where(eq(ewohModelRegistry.id, row.id));
    }
    await this.db.insert(ewohModelRegistry).values({
      modelId,
      // ADR-075：model registry 行归属注入（001 ewoh_org_visible RLS 对齐；
      // org 事实 = R-91 modelId org 命名空间唯一来源，§3 不新建第二来源）。
      orgId: orgIdFromModelId(modelId),
      modelName: 'Task Duration Empirical Model',
      version,
      type: 'statistical/duration',
      status: 'active',
      cardJson: {
        n: model.count,
        medianMs: model.medianMs,
        p90Ms: model.p90Ms,
        spreadMs: model.spreadMs,
        minSamples: 5,
        trainedAt: now.toISOString(),
        dataSource: 'ewoh_scheduling_feedback.actual_start/actual_end',
        ...cardExtras,
      },
      createdAt: now,
      updatedAt: now,
    });
    return version;
  }

  /** 训练 + 注册表落版（supersede 旧 active）+ 内存刷新。NO-13u / ADR-070：
   *  训练租户作用域（orgId 强制，缺失显式 400；跨租户聚合 v1 显式 OFF）。 */
  async retrain(orgId: string): Promise<RetrainSummary> {
    if (!orgId?.trim()) {
      throw new BadRequestException('orgId 缺失：模型训练必须租户作用域（§15/§16，ADR-070）');
    }
    try {
      const entries = await this.loadSamplesWithTaskType(orgId.trim());
      const allSamples = entries.map((e) => e.duration);
      const trained = trainDurationModel(allSamples);
      if (!trained.model) {
        this.logger.warn(`duration model retrain skipped: ${trained.notEnoughDataReason}`);
        return { ok: false, model: null, version: null, notEnoughDataReason: trained.notEnoughDataReason };
      }
      // org 全局模型（modelId = task-duration-empirical:<orgId>）。
      const globalVersion = await this.persistModel(orgModelId(orgId.trim()), trained.model, { orgId: orgId.trim() });

      // per-taskType 分组训练（org 命名空间；分组样本不足 → 显式 skipped 不落版）。
      const groups = new Map<string, number[]>();
      for (const entry of entries) {
        if (!entry.taskType) continue; // 无任务类型事实仅计入 org 全局
        const list = groups.get(entry.taskType) ?? [];
        list.push(entry.duration);
        groups.set(entry.taskType, list);
      }
      const perTaskType: TaskTypeRetrainEntry[] = [];
      const taskTypeEntries = new Map<string, { model: DurationModel; registryVersion: number }>();
      for (const [taskType, samples] of groups) {
        const grouped = trainDurationModel(samples);
        if (!grouped.model) {
          perTaskType.push({
            taskType,
            ok: false,
            model: null,
            version: null,
            notEnoughDataReason: grouped.notEnoughDataReason,
          });
          continue;
        }
        const version = await this.persistModel(
          orgTaskTypeModelId(orgId.trim(), taskType),
          grouped.model,
          { orgId: orgId.trim(), taskType },
        );
        perTaskType.push({ taskType, ok: true, model: grouped.model, version });
        taskTypeEntries.set(taskType, {
          model: grouped.model,
          registryVersion: Number(version.replace('empirical-v', '')) || 1,
        });
      }

      this.provider.refreshForOrg(
        orgId.trim(),
        trained.model,
        Number(globalVersion.replace('empirical-v', '')) || 1,
        taskTypeEntries,
      );
      this.logger.log(
        `duration model retrained: ${globalVersion} org=${orgId.trim()} n=${trained.model.count} medianMs=${trained.model.medianMs} perTaskType=${perTaskType.filter((e) => e.ok).length}/${groups.size}`,
      );
      return { ok: true, model: trained.model, version: globalVersion, perTaskType };
    } catch (err) {
      this.logger.error(`duration model retrain failed: ${err instanceof Error ? err.message : String(err)}`);
      return {
        ok: false,
        model: null,
        version: null,
        notEnoughDataReason: `retrain_failed:${err instanceof Error ? err.message : String(err)}`,
      };
    }
  }

  /**
   * 启动时回填：注册表 → 本租户经验模型（org 命名空间）→ 最新 active 重建。
   * NEST-046 修复（2026-08-17）：SQL 层按 org 命名空间前缀过滤（LIKE
   * 'orgModelPrefix%'，走 modelId 索引）——原全表扫描后 JS 过滤在大注册表
   * （多租户模型累积）下加载全部无关行。
   */
  async hydrateFromRegistry(orgId: string): Promise<void> {
    if (!orgId?.trim()) return;
    try {
      const orgPrefix = `${orgModelId(orgId.trim())}`;
      const rows = await this.db
        .select()
        .from(ewohModelRegistry)
        .where(like(ewohModelRegistry.modelId, `${orgPrefix}%`))
        .orderBy(desc(ewohModelRegistry.version));
      const empirical = rows.filter(
        (r) => isEmpiricalModelId(r.modelId) && orgIdFromModelId(r.modelId) === orgId.trim(),
      );
      let globalModel: DurationModel | null = null;
      let globalVersion = 0;
      const taskTypeEntries = new Map<string, { model: DurationModel; registryVersion: number }>();
      for (const row of empirical) {
        if (row.status !== 'active' || !row.cardJson) continue;
        const card = row.cardJson as Record<string, unknown>;
        const model: DurationModel = {
          medianMs: Number(card.medianMs),
          p90Ms: Number(card.p90Ms),
          count: Number(card.n),
          spreadMs: Number(card.spreadMs),
        };
        if (![model.medianMs, model.p90Ms, model.count, model.spreadMs].every(Number.isFinite)) continue;
        const versionNumber = Number(String(row.version).replace('empirical-v', ''));
        const entry = { model, registryVersion: Number.isFinite(versionNumber) ? versionNumber : 1 };
        if (row.modelId === orgModelId(orgId.trim())) {
          if (globalModel == null) {
            globalModel = model;
            globalVersion = entry.registryVersion;
          }
          continue;
        }
        const taskType = row.modelId.slice(orgModelId(orgId.trim()).length + 1);
        if (taskType && !taskTypeEntries.has(taskType)) {
          taskTypeEntries.set(taskType, entry);
        }
      }
      // 仅当存在可回填模型时刷新（避免无谓刷新/删除；无 active → 保持现状）。
      if (globalModel || taskTypeEntries.size > 0) {
        this.provider.refreshForOrg(orgId.trim(), globalModel, globalVersion, taskTypeEntries);
      }
    } catch (err) {
      this.logger.warn(`duration model hydrate failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}
