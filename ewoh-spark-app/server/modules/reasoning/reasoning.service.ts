import { Injectable, Logger, BadRequestException, Inject } from '@nestjs/common';
import { DRIZZLE_DATABASE, type PostgresJsDatabase } from '@lark-apaas/fullstack-nestjs-core';
import { and, desc, eq, gte } from 'drizzle-orm';
import { ewohEnvironment } from '@server/database/schema';
import {
  validateReasoningTrace,
  evaluateReasoningRules,
  REASONING_ENGINE_VERSION,
  REASONING_RULE_IDS,
  TRACE_FACT_KINDS,
  type ReasoningFact,
} from '@shared/reasoning-trace';
import { isCanonicalIdentity } from '@shared/identity';
import { InferenceResultService } from '../inference/inference.service';
import { LearningProposalService } from '../learning/learning-proposal.service';
import { WorldStateSnapshotService } from '../scheduler/world-state.service';
import { MaterialsService } from '../materials/materials.service';
import { PerceptionFusionService } from '../perception/perception-fusion.service';
import { collectMaterialFacts } from '@shared/material-inventory';
import {
  OBSERVATION_LIMITS,
  collectResourceFacts,
  projectObservationFacts,
  type EnvironmentReadingInput,
  type ObservationEvidence,
  type SkippedObservation,
} from '@shared/observation-facts';
import { randomUUID } from 'node:crypto';
import type { OrgContext } from '../shared/org-context.interceptor';

export interface EvaluateReasoningInput {
  traceId?: string | null;
  snapshotVersion: number;
  facts: Array<{
    subjectId: string;
    kind: string;
    values: Record<string, number | boolean>;
    evidenceIds: string[];
  }>;
  eventIds?: string[];
  window?: { from?: string; to?: string } | null;
}

export interface ReasoningRuleDefinition {
  ruleId: string;
  name: string;
  factKind: string;
  severity: string;
  trigger: string;
}

const RULE_DEFINITIONS: ReasoningRuleDefinition[] = [
  { ruleId: 'rule:worker-overload', name: '人员过载', factKind: 'person', severity: 'high', trigger: 'workload ≥ 0.8 且 (fatigue ≥ 0.7 或 ergonomicRisk ≥ 0.7)' },
  { ruleId: 'rule:exo-low-battery', name: '外骨骼低电量', factKind: 'exo', severity: 'high', trigger: 'batteryPct < 20' },
  { ruleId: 'rule:machine-vibration-risk', name: '设备振动风险', factKind: 'machine', severity: 'critical', trigger: 'vibrationExceeded = true' },
  { ruleId: 'rule:material-shortage', name: '物料短缺', factKind: 'material', severity: 'high', trigger: 'inventory < minThreshold' },
  { ruleId: 'rule:station-quality-blocked', name: '工位质量封锁', factKind: 'station', severity: 'critical', trigger: 'qualityBlocked = true' },
  { ruleId: 'rule:andon-escalation', name: '安灯升级', factKind: 'alert', severity: 'high', trigger: 'andonRaised = true 且 unacknowledgedMinutes > 15' },
];

/**
 * 工业推理引擎（ADR-020 / NO-08b，Level 4 独立工业推理层）。
 *
 * - 确定性规则评估（shared/reasoning-trace.ts evaluateReasoningRules，
 *   §18：explanation 来自事实模板渲染——LLM 只允许翻译不允许编造）；
 * - 输入 fail-closed：未知 fact kind / 非规范身份 / 空证据链 → 拒绝整次评估；
 * - trace 契约自检（validateReasoningTrace）违规绝不返回（§33）；
 * - 每条结论以 L4 InferenceResult 落账（ADR-019 台账复用，modelId=
 *   reasoning:{ruleId}、inputVersion=snapshot-v{n}——结论行 + 规则版本 +
 *   快照版本 = 可重建审计链）；评估响应返回每结论 inferenceId（可追溯）；
 * - 落账失败 logger 留痕不阻断评估响应（结论主契约不被审计旁路阻断，
 *   与 ADR-019 决策 6 同语义）。
 */
@Injectable()
export class ReasoningService {
  private readonly logger = new Logger(ReasoningService.name);

  constructor(
    private readonly inferenceService: InferenceResultService,
    private readonly learningProposalService: LearningProposalService,
    private readonly worldStateSnapshotService: WorldStateSnapshotService,
    @Inject(DRIZZLE_DATABASE) private readonly db: PostgresJsDatabase,
    private readonly materialsService?: MaterialsService,
    /**
     * NO-58b：感知融合建议门控。可选装配——缺装配时**不注入门控**（事实照旧评估），
     * 但调用方必须知道"没有门控"不等于"允许强建议"（结论里 `perceptionGate` 为 null）。
     */
    private readonly perceptionFusionService?: PerceptionFusionService,
  ) {}

  /**
   * NO-25a：**从实时世界模型评估**（不需要调用方手供事实）。
   *
   * 补上"感知 → 理解/预测"之间缺失的一环：
   *   1. 取权威世界模型快照（调度/地图同一份）+ 本租户最近的环境读数
   *      （`ewoh_environment`，观测能力 `observe.*` 的落库处）；
   *   2. `projectObservationFacts` 把读数投影成机器类事实（新鲜度/置信度/
   *      能力声明三道闸，不合格的进 `skipped` 且写明原因）；
   *   3. `collectResourceFacts` 把世界模型列（人员负荷/电量/工位质量/告警）
   *      投影成资源类事实；
   *   4. 走与 `evaluate` **完全相同**的规则评估 + 契约自检 + L4 落账路径。
   *
   * 返回值同时给出**依据**（每条事实的来源、阈值、观测时间、数据质量）与
   * **未采用的数据**（skipped）——现场要能判断"这个结论为什么出现/为什么没出现"。
   */
  async evaluateLive(actor?: OrgContext): Promise<{
    trace: Record<string, unknown>;
    inferenceIds: Array<{ conclusionId: string; inferenceId: string }>;
    facts: Array<{ subjectId: string; kind: string; values: Record<string, number | boolean>; evidenceIds: string[] }>;
    evidence: ObservationEvidence[];
    skipped: SkippedObservation[];
    limits: { vibrationMmPerSec: number; freshnessMs: number; minDataConfidence: number };
    snapshotVersion: number;
    readingsConsidered: number;
    generatedAt: string;
  }> {
    const orgId = actor?.primaryOrgId?.trim();
    if (!orgId) {
      throw new BadRequestException('orgId 缺失：实时推理评估必须带租户上下文');
    }
    const generatedAt = new Date();
    const snapshot = await this.worldStateSnapshotService.buildSnapshotReadOnly(
      actor as OrgContext,
    );
    const readings = await this.recentEnvironmentReadings(orgId, generatedAt);
    const projected = projectObservationFacts({
      snapshot,
      readings,
      nowMs: generatedAt.getTime(),
    });
    const resourceFacts = collectResourceFacts(snapshot);
    // NO-27a：物料库存来自 ERP 出站事件的投影（没有物料事件 → 不产出物料事实）
    const materialFacts = await this.collectMaterialFactsSafe(actor);
    const facts = await this.attachPerceptionGates(
      [...resourceFacts.facts, ...projected.facts, ...materialFacts.facts],
      actor,
    );
    const skipped = [...projected.skipped, ...resourceFacts.skipped, ...materialFacts.skipped];
    const snapshotVersion = this.toContractSnapshotVersion(snapshot?.worldVersion);
    // 没有事实时也如实评估（结论为空 = 当前没有规则命中）："现在没有风险"本身是
    // 有价值的信息，不编造一条占位事实、也不抛错。
    const base = await this.evaluate(
      {
        traceId: `rt-live-${randomUUID()}`,
        snapshotVersion,
        facts,
      },
      orgId,
    );
    return {
      ...base,
      facts,
      evidence: projected.evidence,
      skipped,
      limits: projected.limits,
      snapshotVersion,
      readingsConsidered: readings.length,
      generatedAt: generatedAt.toISOString(),
    };
  }

  /**
   * 物料事实（NO-27a）：库存投影失败不阻断整次评估——如实降级为"物料未参与判定"。
   *
   * 为什么不让它抛：库存读面依赖 ERP 事件表，一次查询失败不应该让"设备振动风险"
   * 这类无关结论也一起消失；但降级必须**可见**（写进 skipped 而不是静默）。
   */
  private async collectMaterialFactsSafe(actor?: OrgContext): Promise<ReturnType<typeof collectMaterialFacts>> {
    if (!this.materialsService) {
      return {
        facts: [],
        skipped: [
          {
            sensorId: 'materials',
            subjectId: null,
            field: 'inventory',
            reason: 'material_source_unavailable',
            detail: '物料服务未装配：本次评估不包含物料短缺判定',
          },
        ],
      };
    }
    try {
      const projection = await this.materialsService.getInventory(actor);
      const result = collectMaterialFacts(projection);
      const unparsable = projection.unparsable ?? [];
      return {
        facts: result.facts,
        skipped: [
          ...result.skipped,
          ...unparsable.map((item) => ({
            sensorId: item.eventId,
            subjectId: null,
            field: 'inventory',
            reason: 'unparsable_material_movement' as const,
            detail: `${item.type}: ${item.reason}`,
          })),
        ],
      };
    } catch (error) {
      this.logger.error(`物料事实投影失败（本次不判定物料短缺）：${String(error)}`);
      return {
        facts: [],
        skipped: [
          {
            sensorId: 'materials',
            subjectId: null,
            field: 'inventory',
            reason: 'material_projection_failed',
            detail: `物料库存投影失败，本次不判定物料短缺：${String(error).slice(0, 160)}`,
          },
        ],
      };
    }
  }

  /**
   * 快照版本 → 推理契约要求的**非负整数**。
   *
   * `worldVersion` 是 32 位哈希（可能为负），而 `snapshotVersion` 在推理契约里必须
   * 是非负整数（实测：负值直接 400，实时评估整条链路不可用）。这里做**同一数值的
   * 无符号重解释**（`>>> 0`）——确定性、双射、不编造新数值；非整数/缺失一律 0，
   * 表示"无版本信息"而不是假装有。
   */
  private toContractSnapshotVersion(raw: unknown): number {
    if (typeof raw !== 'number' || !Number.isInteger(raw)) return 0;
    return raw >>> 0;
  }

  /** 只读事实视图：不落账、不评估，供 UI/排障看"世界模型当前能推出哪些事实"。 */
  async listLiveFacts(actor?: OrgContext): Promise<{
    facts: Array<{ subjectId: string; kind: string; values: Record<string, number | boolean>; evidenceIds: string[] }>;
    evidence: ObservationEvidence[];
    skipped: SkippedObservation[];
    limits: { vibrationMmPerSec: number; freshnessMs: number; minDataConfidence: number };
    snapshotVersion: number;
    readingsConsidered: number;
    generatedAt: string;
  }> {
    const orgId = actor?.primaryOrgId?.trim();
    if (!orgId) {
      throw new BadRequestException('orgId 缺失：事实视图必须带租户上下文');
    }
    const generatedAt = new Date();
    const snapshot = await this.worldStateSnapshotService.buildSnapshotReadOnly(
      actor as OrgContext,
    );
    const readings = await this.recentEnvironmentReadings(orgId, generatedAt);
    const projected = projectObservationFacts({ snapshot, readings, nowMs: generatedAt.getTime() });
    const resourceFacts = collectResourceFacts(snapshot);
    const materialFacts = await this.collectMaterialFactsSafe(actor);
    return {
      facts: [...resourceFacts.facts, ...projected.facts, ...materialFacts.facts],
      evidence: projected.evidence,
      skipped: [...projected.skipped, ...resourceFacts.skipped, ...materialFacts.skipped],
      limits: projected.limits,
      snapshotVersion: this.toContractSnapshotVersion(snapshot?.worldVersion),
      readingsConsidered: readings.length,
      generatedAt: generatedAt.toISOString(),
    };
  }

  /**
   * 最近环境读数（org 作用域，窗口内按时间倒序取有界条数）。
   *
   * 有界：传感器长期运行会积累海量行；投影只需要"最近的一批"，
   * 因此按 `ts >= now - freshnessMs` 过滤并限量（与投影的新鲜度窗口同源）。
   */
  private async recentEnvironmentReadings(
    orgId: string,
    now: Date,
  ): Promise<EnvironmentReadingInput[]> {
    const since = new Date(now.getTime() - OBSERVATION_LIMITS.freshnessMs);
    const rows = await this.db
      .select({
        sensorId: ewohEnvironment.sensorId,
        entityId: ewohEnvironment.entityId,
        temperature: ewohEnvironment.temperature,
        vibration: ewohEnvironment.vibration,
        noise: ewohEnvironment.noise,
        airQuality: ewohEnvironment.airQuality,
        ts: ewohEnvironment.ts,
        sourceType: ewohEnvironment.sourceType,
        dataConfidence: ewohEnvironment.dataConfidence,
      })
      .from(ewohEnvironment)
      // 用列类型感知的 gte（裸 sql 模板里的 Date 参数会被当成未知类型，
      // 实测 PostgreSQL 直接报 Failed query——时间窗比较必须走 drizzle 操作符）
      .where(and(eq(ewohEnvironment.orgId, orgId), gte(ewohEnvironment.ts, since)))
      .orderBy(desc(ewohEnvironment.ts))
      .limit(500);
    return rows.map((row) => ({
      sensorId: String(row.sensorId),
      entityId: row.entityId ?? null,
      temperature: row.temperature === null ? null : Number(row.temperature),
      vibration: row.vibration === null ? null : Number(row.vibration),
      noise: row.noise === null ? null : Number(row.noise),
      airQuality: row.airQuality === null ? null : Number(row.airQuality),
      ts: row.ts instanceof Date ? row.ts.toISOString() : String(row.ts),
      sourceType: row.sourceType ?? null,
      dataConfidence: row.dataConfidence === null ? null : Number(row.dataConfidence),
    }));
  }

  /**
   * 给事实注入感知建议门控（NO-58b）。
   *
   * 只对有融合快照的主体注入；**没有快照的主体保持 `perceptionGate=null`**
   * （"未评估"不等于"可以强建议"，调用方按自己的缺省语义处理，平台不替它猜）。
   */
  private async attachPerceptionGates(
    facts: ReasoningFact[],
    actor: OrgContext | undefined,
  ): Promise<ReasoningFact[]> {
    if (!this.perceptionFusionService || !actor?.primaryOrgId) return facts;
    const subjectIds = [...new Set(facts.map((fact) => fact.subjectId))];
    if (subjectIds.length === 0) return facts;
    try {
      const gates = await this.perceptionFusionService.latestGates(actor, subjectIds);
      if (gates.size === 0) return facts;
      return facts.map((fact) => {
        const gate = gates.get(fact.subjectId);
        return gate ? { ...fact, perceptionGate: gate } : fact;
      });
    } catch (error) {
      // 门控读取失败 → 不注入（如实降级）；结论里 perceptionGate 为 null，调用方可见。
      this.logger.warn(
        `感知门控读取失败（不注入，结论照旧产出）：${error instanceof Error ? error.message : String(error)}`,
      );
      return facts;
    }
  }

  async evaluate(input: EvaluateReasoningInput, orgId: string): Promise<{
    trace: Record<string, unknown>;
    inferenceIds: Array<{ conclusionId: string; inferenceId: string }>;
    ledgerFailures: Array<{ conclusionId: string; ruleId: string; error: string }>;
  }> {
    if (!orgId?.trim()) {
      throw new BadRequestException('orgId 缺失：推理评估必须带租户上下文');
    }
    if (!Number.isInteger(input.snapshotVersion) || input.snapshotVersion < 0) {
      throw new BadRequestException('snapshotVersion 必须为非负整数');
    }
    if (!Array.isArray(input.facts)) {
      throw new BadRequestException('facts 必须为数组');
    }
    const mappedFacts: ReasoningFact[] = input.facts.map((f) => this.validateFact(f));
    const facts = await this.attachPerceptionGates(mappedFacts, {
      userId: 'reasoning',
      primaryOrgId: orgId,
    } as OrgContext);
    const eventIds = input.eventIds ?? [];
    if (eventIds.some((e) => typeof e !== 'string' || !isCanonicalIdentity(e))) {
      throw new BadRequestException('eventIds 必须是规范身份数组');
    }
    const traceId = input.traceId && input.traceId !== ''
      ? input.traceId
      : `rt-${randomUUID()}`;
    // ADR-026 反馈腿激活面：本租户 approved 提案的阈值覆盖（人审激活，
    // 绝不隐式自动执行；无 approved 提案 = 引擎内置常量）。
    const thresholds = await this.learningProposalService.getActiveThresholds(orgId);
    const conclusions = evaluateReasoningRules(traceId, facts, thresholds);
    const trace: Record<string, unknown> = {
      traceId,
      engineVersion: REASONING_ENGINE_VERSION,
      factsRef: { snapshotVersion: input.snapshotVersion, eventIds },
      conclusions,
      auditTrail: true,
    };
    const errors = validateReasoningTrace(trace);
    if (errors.length > 0) {
      // 引擎输出违反自身契约——绝不返回（fail-closed，防内部缺陷外泄为事实）
      throw new BadRequestException(`推理轨迹违反契约: ${errors.join(', ')}`);
    }
    const inferenceIds: Array<{ conclusionId: string; inferenceId: string }> = [];
    const ledgerFailures: Array<{ conclusionId: string; ruleId: string; error: string }> = [];
    const window = input.window ?? {};
    const tsStart = window.from ?? new Date().toISOString();
    const tsEnd = window.to ?? new Date().toISOString();
    for (const conclusion of conclusions) {
      try {
        const result = await this.inferenceService.recordInferenceResult(
          {
            subjectId: conclusion.subjectId,
            level: 'L4_industrial_reasoning',
            modelId: `reasoning:${conclusion.ruleId}`,
            modelVersion: REASONING_ENGINE_VERSION,
            inputVersion: `snapshot-v${input.snapshotVersion}`,
            label: conclusion.explanation,
            confidence: conclusion.confidence,
            oodIndicator: { flag: false, reasons: [] },
            dataQuality: 'good',
            evidence: { tsStart, tsEnd, isRule: true },
          },
          orgId,
        );
        inferenceIds.push({
          conclusionId: conclusion.conclusionId,
          inferenceId: String((result.record as Record<string, unknown>).inferenceId),
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        this.logger.error(`推理结论落账失败 ${conclusion.ruleId}: ${message}`);
        ledgerFailures.push({
          conclusionId: conclusion.conclusionId,
          ruleId: conclusion.ruleId,
          error: message,
        });
      }
    }
    return { trace, inferenceIds, ledgerFailures };
  }

  listRules(): ReasoningRuleDefinition[] {
    return RULE_DEFINITIONS;
  }

  /** 输入事实校验（fail-closed：拒绝而非猜测）。 */
  private validateFact(f: EvaluateReasoningInput['facts'][number]): ReasoningFact {
    if (typeof f !== 'object' || f === null) {
      throw new BadRequestException('fact 必须为对象');
    }
    if (typeof f.subjectId !== 'string' || !isCanonicalIdentity(f.subjectId)) {
      throw new BadRequestException('fact.subjectId 必须是规范身份');
    }
    if (!(TRACE_FACT_KINDS as readonly string[]).includes(f.kind)) {
      throw new BadRequestException(`unknown_fact_kind:${f.kind}`);
    }
    if (typeof f.values !== 'object' || f.values === null || Array.isArray(f.values)) {
      throw new BadRequestException('fact.values 必须为对象');
    }
    if (!Array.isArray(f.evidenceIds) || f.evidenceIds.length === 0
      || f.evidenceIds.some((e) => typeof e !== 'string' || !isCanonicalIdentity(e))) {
      throw new BadRequestException('fact.evidenceIds 必须为非空规范身份数组（§3 证据链）');
    }
    return {
      subjectId: f.subjectId,
      kind: f.kind,
      values: f.values,
      evidenceIds: f.evidenceIds,
    };
  }
}
