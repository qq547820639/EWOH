/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unused-vars */
/** auto generated, do not edit */
/**
 * org_id 列类型策略（NEST-502/512 裁决，2026-08-17，最小破坏方案；
 * R2-SDB-004 修正登记，2026-08-17）：
 * 事实源 = db/migrations/standalone_*.sql 迁移链（legacy 001/002 已 DEPRECATED
 * 冻结，不构成事实源）。本文件为迁移链的 Drizzle 映射，drizzle-kit push 不用于
 * 生产建库（生产只经迁移链）；类型/约束漂移以迁移链为准并在 db/verify/ 对账。
 * 实际分布（按迁移链终态对账，修正此前“仅 4 张 uuid”的错误陈述）：
 *  - standalone_001 基线创建/补列的表 org_id = uuid（多含 GUC DEFAULT
 *    nullif(current_setting('app.current_org_id', true), '')::uuid）：
 *    scheduler_config / notification / world_snapshot / world_delta_log /
 *    audit_log / control_request / control_command / control_result /
 *    knowledge_entry / asset_package / factory_template / factory_profile /
 *    event / event_chain / device / device_binding / device_config /
 *    environment / model_registry / production_task / spatial_entity /
 *    telemetry / topology / world_state / organization 等（全量清单见
 *    standalone_001_schema.sql）。
 *  - standalone_004/005/006/0xx 后续链新增的表 org_id = varchar(255)
 *    （域表/调度域/workbench/agent 域，含 057 收紧 NOT NULL 的 15 张调度表）。
 * RLS 侧配套：standalone_057 提供 ewoh_org_visible(text) 重载——varchar 列的
 * policy 走 text 版直等比较，uuid 列继续走 uuid 版函数；两版语义一致，
 * varchar 列不再做 ::uuid 强制 cast（非 UUID 值运行时抛错的根因已消除）。
 * 残余已知漂移（登记，非本文件可单方收敛）：ai_suggestion / production_task /
 * schedule_task 等部分 varchar 映射与 standalone_001 的 uuid 列存在类型学
 * 漂移——TS 侧 string 类型不受影响；列级类型对账（ALTER TYPE 收敛或
 * dual-map codegen）需 ADR 立项后另行实施，禁止在本文件内单方改型造成
 * push 误判。
 */
import { sql } from 'drizzle-orm';
import { boolean, index, integer, jsonb, numeric, pgTable, real, text, uniqueIndex, uuid, varchar, customType, bigint, doublePrecision } from "drizzle-orm/pg-core"

export const customTimestamptz = customType<{
  data: Date;
  driverData: string;
  config: { precision?: number };
}>({
  dataType(config) {
    const precision = typeof config?.precision !== 'undefined'
      ? ` (${config.precision})`
      : '';
    return `timestamptz${precision}`;
  },
  toDriver(value: Date | string | number) {
    if (value == null) return value as any;
    if (typeof value === 'number') return new Date(value).toISOString();
    if (typeof value === 'string') return value;
    if (value instanceof Date) return value.toISOString();
    throw new Error('Invalid timestamp value');
  },
  fromDriver(value: string | Date): Date {
    if (value instanceof Date) return value;
    return new Date(value);
  },
});

export const userProfile = customType<{
  data: string;
  driverData: string;
}>({
  dataType() {
    return 'user_profile';
  },
  toDriver(value: string) {
    return sql`ROW(${value})::user_profile`;
  },
  fromDriver(value: string) {
    const [userId] = value.slice(1, -1).split(',');
    return userId.trim();
  },
});

export type FileAttachment = {
  bucket_id: string;
  file_path: string;
};

export const fileAttachment = customType<{
  data: FileAttachment;
  driverData: string;
}>({
  dataType() {
    return 'file_attachment';
  },
  toDriver(value: FileAttachment) {
    return sql`ROW(${value.bucket_id},${value.file_path})::file_attachment`;
  },
  fromDriver(value: string): FileAttachment {
    const [bucketId, filePath] = value.slice(1, -1).split(',');
    return { bucket_id: bucketId.trim(), file_path: filePath.trim() };
  },
});

/**
 * NEST-517 加固（2026-08-17）：仅用于 userProfile/fileAttachment 自定义类型的
 * sql.raw 数组拼接。除单引号转义外，显式拒绝反斜杠输入——当前提是
 * standard_conforming_strings=on（PG 默认，反斜杠无转义义）；若集群被改为
 * off（escape string syntax），反斜杠可逃逸字面量。拒绝而非转义是保守选择：
 * 平台 user id / bucket 路径不应包含反斜杠。
 */
export function escapeLiteral(str: string): string {
  if (str.includes('\\')) {
    throw new Error(`escapeLiteral: input contains backslash (rejected, NEST-517): ${str.slice(0, 32)}`);
  }
  return "'" + str.replace(/'/g, "''") + "'";
}

export const userProfileArray = customType<{
  data: string[];
  driverData: string;
}>({
  dataType() {
    return 'user_profile[]';
  },
  toDriver(value: string[]) {
    if (!value || value.length === 0) {
      return sql`'{}'::user_profile[]`;
    }
    const elements = value.map(id => `ROW(${escapeLiteral(id)})::user_profile`).join(',');
    return sql.raw(`ARRAY[${elements}]::user_profile[]`);
  },
  fromDriver(value: string): string[] {
    if (!value || value === '{}') return [];
    const inner = value.slice(1, -1);
    const matches = inner.match(/\([^)]*\)/g) || [];
    return matches.map(m => m.slice(1, -1).split(',')[0].trim());
  },
});

export const fileAttachmentArray = customType<{
  data: FileAttachment[];
  driverData: string;
}>({
  dataType() {
    return 'file_attachment[]';
  },
  toDriver(value: FileAttachment[]) {
    if (!value || value.length === 0) {
      return sql`'{}'::file_attachment[]`;
    }
    const elements = value.map(f =>
      `ROW(${escapeLiteral(f.bucket_id)},${escapeLiteral(f.file_path)})::file_attachment`
    ).join(',');
    return sql.raw(`ARRAY[${elements}]::file_attachment[]`);
  },
  fromDriver(value: string): FileAttachment[] {
    if (!value || value === '{}') return [];
    const inner = value.slice(1, -1);
    const matches = inner.match(/\([^)]*\)/g) || [];
    return matches.map(m => {
      const [bucketId, filePath] = m.slice(1, -1).split(',');
      return { bucket_id: bucketId.trim(), file_path: filePath.trim() };
    });
  },
});

export const ewohAiSuggestion = pgTable("ewoh_ai_suggestion", {
  id: uuid("id").primaryKey().defaultRandom(),
  suggestionId: varchar("suggestion_id", { length: 255 }).notNull().unique(),
  // 列宽与 DB 对齐（2026-08-19 审计 P1 契约对齐）：title 500 由
  // standalone_063 拓宽（input.problem 可超 255）；其余三列回填 DB 实况 255。
  title: varchar("title", { length: 500 }),
  suggestionType: varchar("suggestion_type", { length: 255 }),
  status: varchar("status", { length: 255 }).default('not_generated'),
  relatedEventId: varchar("related_event_id", { length: 255 }),
  relatedTaskId: varchar("related_task_id", { length: 255 }),
  inputSummary: text("input_summary"),
  content: text("content"),
  riskAssessment: text("risk_assessment"),
  aiLevel: varchar("ai_level", { length: 255 }).default('A2'),
  triggeredBy: varchar("triggered_by", { length: 255 }),
  /**
   * @type { planTitle: string; planSummary: string; strategy: string; riskLevel: string; affectedPersons: string; taskAssignments: string; resourceChanges: string; estimatedCompletion: string; capacityImpact: string; riskAssessment: string; uncertainty: string; failureConditions: string; confirmationItems: string }
   */
  planContent: jsonb("plan_content"),
  adoptedAt: customTimestamptz("adopted_at", { precision: 3 }),
  // System field: Creation time (auto-filled, do not modify)
  createdAt: customTimestamptz("_created_at", { precision: 3 }).notNull().default(sql`CURRENT_TIMESTAMP`),
  // System field: Creator (auto-filled, do not modify)
  createdBy: userProfile("_created_by").default(sql`CASE
    WHEN (current_setting('app.user_id'::text, true) = ''::text) THEN NULL`),
  // System field: Update time (auto-filled, do not modify)
  updatedAt: customTimestamptz("_updated_at", { precision: 3 }).notNull().default(sql`CURRENT_TIMESTAMP`),
  // System field: Updater (auto-filled, do not modify)
  updatedBy: userProfile("_updated_by").default(sql`CASE
    WHEN (current_setting('app.user_id'::text, true) = ''::text) THEN NULL`),
  /** 组织归属（ADR-075：001 ewoh_org_visible RLS 对齐；null=存量/legacy 行）。 */
  orgId: varchar("org_id", { length: 255 }),
}, (table) => [
  uniqueIndex("ewoh_ai_suggestion_suggestion_id_key").on(table.suggestionId),
  index("idx_ewoh_ai_suggestion_status").on(table.status),
]);

export const ewohProductionTask = pgTable("ewoh_production_task", {
  id: uuid("id").primaryKey().defaultRandom(),
  title: varchar("title", { length: 500 }).notNull(),
  description: text("description"),
  taskType: varchar("task_type", { length: 50 }).notNull(),
  priority: varchar("priority", { length: 50 }).notNull().default('medium'),
  status: varchar("status", { length: 50 }).notNull().default('draft'),
  assigneeId: varchar("assignee_id", { length: 255 }),
  deviceId: varchar("device_id", { length: 255 }),
  spatialEntityId: varchar("spatial_entity_id", { length: 255 }),
  planStart: customTimestamptz("plan_start", { precision: 3 }),
  planEnd: customTimestamptz("plan_end", { precision: 3 }),
  progress: integer("progress").default(0),
  source: varchar("source", { length: 50 }).default('manual'),
  /**
   * @type { string[] }
   */
  predecessorIds: jsonb("predecessor_ids"),
  /**
   * @type { string[] }
   */
  requiredSkills: jsonb("required_skills"),
  /**
   * @type { string[] }
   */
  requiredCertifications: jsonb("required_certifications"),
  // --- TaskRequirement 领域列 (standalone_016_task_requirement, Phase 1 / P1-TREQ) ---
  /**
   * 设备能力需求（jsonb string[]）：TaskRequirement 业务事实，
   * 替代 taskType 白名单派生（world-state deriveRequiredDeviceCapabilities）。
   * backfill 旧值由运行时标记 derived；真实写入值不再派生。
   * @type { string[] }
   */
  requiredDeviceCapabilities: jsonb("required_device_capabilities").default([]),
  /**
   * 候选工位（jsonb string[]）：Task.candidateStations。
   * @type { string[] }
   */
  candidateStations: jsonb("candidate_stations").default([]),
  // --- 调度领域模型新列 (standalone_012_domain_columns, Phase 1 / P1-T1) ---
  /** 基础优先级（业务真实值，不再从 title/taskType 猜测）。 */
  basePriority: varchar("base_priority", { length: 50 }),
  /** 最早开始时间（epoch ms）。 */
  earliestStartMs: bigint("earliest_start_ms", { mode: 'number' }),
  /** 最晚完成时间（epoch ms）。 */
  latestFinishMs: bigint("latest_finish_ms", { mode: 'number' }),
  /** 安全关键任务真实标记（替代 deriveSafetyCritical 白名单派生）。 */
  safetyCritical: boolean("safety_critical").notNull().default(false),
  /** 是否可抢占（替代固定 false）。 */
  preemptible: boolean("preemptible").notNull().default(false),
  /** 技能匹配语义 ALL/ANY（缺省 ALL）。 */
  skillMatchMode: varchar("skill_match_mode", { length: 10 }).default('ALL'),
  /** 生产影响度 0..1（替代 deriveProductionImpact）。 */
  productionImpact: real("production_impact").default(0),
  /** 下游影响度 0..1。 */
  downstreamImpact: real("downstream_impact").default(0),
  /**
   * 工位能力需求（jsonb string[]）。
   * @type { string[] }
   */
  requiredStationCapabilities: jsonb("required_station_capabilities").default([]),
  /**
   * 偏好资源（jsonb string[]）。
   * @type { string[] }
   */
  preferredResources: jsonb("preferred_resources").default([]),
  /**
   * 排除资源（jsonb string[]）。
   * @type { string[] }
   */
  excludedResources: jsonb("excluded_resources").default([]),
  /** 业务版本：每次关键修改自增，用于快照新鲜度判断。 */
  version: integer("version").default(1),
  // System field: Creation time (auto-filled, do not modify)
  createdAt: customTimestamptz("_created_at", { precision: 3 }).notNull().default(sql`CURRENT_TIMESTAMP`),
  // System field: Creator (auto-filled, do not modify)
  createdBy: userProfile("_created_by").default(sql`CASE
    WHEN (current_setting('app.user_id'::text, true) = ''::text) THEN NULL`),
  // System field: Update time (auto-filled, do not modify)
  updatedAt: customTimestamptz("_updated_at", { precision: 3 }).notNull().default(sql`CURRENT_TIMESTAMP`),
  // System field: Updater (auto-filled, do not modify)
  updatedBy: userProfile("_updated_by").default(sql`CASE
    WHEN (current_setting('app.user_id'::text, true) = ''::text) THEN NULL`),
  /** 组织归属（ADR-075：001 ewoh_org_visible RLS 对齐；null=存量/legacy 行）。 */
  orgId: varchar("org_id", { length: 255 }),
}, (table) => [
  index("idx_ewoh_production_task_status").on(table.status),
  index("idx_ewoh_production_task_assignee").on(table.assigneeId),
  index("idx_ewoh_production_task_type").on(table.taskType),
]);

export const ewohScheduleTask = pgTable("ewoh_schedule_task", {
  id: uuid("id").primaryKey().defaultRandom(),
  scheduleTaskId: varchar("schedule_task_id", { length: 255 }).notNull().unique(),
  templateId: varchar("template_id", { length: 255 }),
  title: varchar("title", { length: 255 }).notNull(),
  description: text("description"),
  status: varchar("status", { length: 50 }).notNull().default('draft'),
  priority: varchar("priority", { length: 50 }).notNull().default('medium'),
  source: varchar("source", { length: 50 }).notNull().default('manual'),
  planStart: customTimestamptz("plan_start", { precision: 3 }),
  planEnd: customTimestamptz("plan_end", { precision: 3 }),
  actualStart: customTimestamptz("actual_start", { precision: 3 }),
  actualEnd: customTimestamptz("actual_end", { precision: 3 }),
  parentTaskId: varchar("parent_task_id", { length: 255 }),
  approvalId: varchar("approval_id", { length: 255 }),
  suggestionId: varchar("suggestion_id", { length: 255 }),
  sessionId: varchar("session_id", { length: 255 }),
  isSimulation: boolean("is_simulation").notNull().default(false),
  progress: integer("progress").notNull().default(0),
  deletedAt: customTimestamptz("deleted_at", { precision: 3 }),
  orgId: varchar("org_id", { length: 255 }),
  createdAt: customTimestamptz("_created_at", { precision: 3 }).notNull().default(sql`CURRENT_TIMESTAMP`),
  createdBy: uuid("_created_by"),
  updatedAt: customTimestamptz("_updated_at", { precision: 3 }).notNull().default(sql`CURRENT_TIMESTAMP`),
  updatedBy: uuid("_updated_by"),
}, (table) => [
  index("idx_ewoh_schedule_task_status").on(table.status),
  index("idx_ewoh_schedule_task_source").on(table.source),
  index("idx_ewoh_schedule_task_org_status").on(table.orgId, table.status),
  index("idx_ewoh_schedule_task_org_priority").on(table.orgId, table.priority),
  index("idx_ewoh_schedule_task_org_updated").on(table.orgId, table.updatedAt),
  index("idx_ewoh_schedule_task_org_key").on(table.orgId, table.scheduleTaskId),
]);

export const ewohScheduleTaskStep = pgTable("ewoh_schedule_task_step", {
  id: uuid("id").primaryKey().defaultRandom(),
  stepId: varchar("step_id", { length: 255 }).notNull().unique(),
  scheduleTaskId: varchar("schedule_task_id", { length: 255 }).notNull(),
  stepNo: integer("step_no").notNull(),
  name: varchar("name", { length: 255 }).notNull(),
  instruction: text("instruction"),
  status: varchar("status", { length: 50 }).notNull().default('pending'),
  plannedStart: customTimestamptz("planned_start", { precision: 3 }),
  plannedEnd: customTimestamptz("planned_end", { precision: 3 }),
  actualStart: customTimestamptz("actual_start", { precision: 3 }),
  actualEnd: customTimestamptz("actual_end", { precision: 3 }),
  assignedPersonId: varchar("assigned_person_id", { length: 255 }),
  assignedDeviceId: varchar("assigned_device_id", { length: 255 }),
  spatialEntityId: varchar("spatial_entity_id", { length: 255 }),
  progress: integer("progress").notNull().default(0),
  resultJson: jsonb("result_json"),
  parentStepId: varchar("parent_step_id", { length: 255 }),
  orgId: varchar("org_id", { length: 255 }),
  createdAt: customTimestamptz("_created_at", { precision: 3 }).notNull().default(sql`CURRENT_TIMESTAMP`),
  createdBy: uuid("_created_by"),
  updatedAt: customTimestamptz("_updated_at", { precision: 3 }).notNull().default(sql`CURRENT_TIMESTAMP`),
  updatedBy: uuid("_updated_by"),
}, (table) => [
  index("idx_ewoh_schedule_task_step_status").on(table.status),
  index("idx_ewoh_schedule_task_step_org_status").on(table.orgId, table.status),
  index("idx_ewoh_schedule_task_step_org_assignee").on(table.orgId, table.assignedPersonId),
]);

export const ewohResourcePreorder = pgTable("ewoh_resource_preorder", {
  id: uuid("id").primaryKey().defaultRandom(),
  /** 组织归属（ADR-075：001 ewoh_org_visible RLS 对齐；null=存量/legacy 行）。 */
  orgId: varchar("org_id", { length: 255 }),
  preorderId: varchar("preorder_id", { length: 255 }).notNull().unique(),
  resourceType: varchar("resource_type", { length: 100 }).notNull(),
  resourceId: varchar("resource_id", { length: 255 }).notNull(),
  quantity: numeric("quantity", { precision: 18, scale: 4 }).notNull().default('0'),
  reservedQty: numeric("reserved_qty", { precision: 18, scale: 4 }).notNull().default('0'),
  issuedQty: numeric("issued_qty", { precision: 18, scale: 4 }).notNull().default('0'),
  consumedQty: numeric("consumed_qty", { precision: 18, scale: 4 }).notNull().default('0'),
  returnedQty: numeric("returned_qty", { precision: 18, scale: 4 }).notNull().default('0'),
  unit: varchar("unit", { length: 50 }),
  batchNo: varchar("batch_no", { length: 255 }),
  taskId: varchar("task_id", { length: 255 }),
  taskStepId: varchar("task_step_id", { length: 255 }),
  status: varchar("status", { length: 50 }).notNull().default('pending'),
  priority: integer("priority").notNull().default(0),
  startTime: customTimestamptz("start_time", { precision: 3 }).notNull().default(sql`CURRENT_TIMESTAMP`),
  endTime: customTimestamptz("end_time", { precision: 3 }),
  createdAt: customTimestamptz("_created_at", { precision: 3 }).notNull().default(sql`CURRENT_TIMESTAMP`),
  createdBy: uuid("_created_by"),
  updatedAt: customTimestamptz("_updated_at", { precision: 3 }).notNull().default(sql`CURRENT_TIMESTAMP`),
  updatedBy: uuid("_updated_by"),
}, (table) => [
  index("idx_ewoh_resource_preorder_org").on(table.orgId),
  index("idx_ewoh_resource_preorder_org_status").on(table.orgId, table.status),
]);

export const ewohResourceBinding = pgTable("ewoh_resource_binding", {
  id: uuid("id").primaryKey().defaultRandom(),
  bindingId: varchar("binding_id", { length: 255 }).notNull().unique(),
  bindingType: varchar("binding_type", { length: 100 }).notNull(),
  resourceType: varchar("resource_type", { length: 100 }).notNull(),
  resourceId: varchar("resource_id", { length: 255 }).notNull(),
  targetType: varchar("target_type", { length: 100 }).notNull(),
  targetId: varchar("target_id", { length: 255 }).notNull(),
  startTime: customTimestamptz("start_time", { precision: 3 }).notNull().default(sql`CURRENT_TIMESTAMP`),
  endTime: customTimestamptz("end_time", { precision: 3 }),
  reason: text("reason"),
  status: varchar("status", { length: 50 }).notNull().default('active'),
  operatorId: varchar("operator_id", { length: 255 }),
  quantity: numeric("quantity", { precision: 18, scale: 4 }).notNull().default('0'),
  version: integer("version").notNull().default(1),
  orgId: varchar("org_id", { length: 255 }),
  createdAt: customTimestamptz("_created_at", { precision: 3 }).notNull().default(sql`CURRENT_TIMESTAMP`),
  createdBy: uuid("_created_by"),
  updatedAt: customTimestamptz("_updated_at", { precision: 3 }).notNull().default(sql`CURRENT_TIMESTAMP`),
  updatedBy: uuid("_updated_by"),
}, (table) => [
  index("idx_ewoh_resource_binding_target").on(table.targetId),
  index("idx_ewoh_resource_binding_org_status").on(table.orgId, table.status),
  index("idx_ewoh_resource_binding_org_start").on(table.orgId, table.startTime),
  index("idx_ewoh_resource_binding_org_key").on(table.orgId, table.bindingId),
]);

export const ewohTaskTemplate = pgTable("ewoh_task_template", {
  id: uuid("id").primaryKey().defaultRandom(),
  templateId: varchar("template_id", { length: 255 }).notNull().unique(),
  name: varchar("name", { length: 255 }).notNull(),
  taskType: varchar("task_type", { length: 100 }).notNull(),
  description: text("description"),
  priority: varchar("priority", { length: 50 }).notNull().default('medium'),
  estimatedDurationSec: integer("estimated_duration_sec"),
  riskLevel: varchar("risk_level", { length: 50 }).notNull().default('low'),
  status: varchar("status", { length: 50 }).notNull().default('active'),
  version: integer("version").notNull().default(1),
  deletedAt: customTimestamptz("deleted_at", { precision: 3 }),
  createdAt: customTimestamptz("_created_at", { precision: 3 }).notNull().default(sql`CURRENT_TIMESTAMP`),
  createdBy: uuid("_created_by"),
  updatedAt: customTimestamptz("_updated_at", { precision: 3 }).notNull().default(sql`CURRENT_TIMESTAMP`),
  updatedBy: uuid("_updated_by"),
  /** 组织归属（ADR-075：001 ewoh_org_visible RLS 对齐；null=存量/legacy 行）。 */
  orgId: varchar("org_id", { length: 255 }),
});

export const ewohTaskStep = pgTable("ewoh_task_step", {
  id: uuid("id").primaryKey().defaultRandom(),
  stepId: varchar("step_id", { length: 255 }).notNull().unique(),
  templateId: varchar("template_id", { length: 255 }).notNull(),
  stepNo: integer("step_no").notNull(),
  name: varchar("name", { length: 255 }).notNull(),
  instruction: text("instruction"),
  durationSec: integer("duration_sec"),
  status: varchar("status", { length: 50 }).notNull().default('active'),
  createdAt: customTimestamptz("_created_at", { precision: 3 }).notNull().default(sql`CURRENT_TIMESTAMP`),
  createdBy: uuid("_created_by"),
  updatedAt: customTimestamptz("_updated_at", { precision: 3 }).notNull().default(sql`CURRENT_TIMESTAMP`),
  updatedBy: uuid("_updated_by"),
  /** 组织归属（ADR-075：001 ewoh_org_visible RLS 对齐；null=存量/legacy 行）。 */
  orgId: varchar("org_id", { length: 255 }),
});

export const ewohDeviceConfig = pgTable("ewoh_device_config", {
  id: uuid("id").primaryKey().defaultRandom(),
  deviceId: varchar("device_id", { length: 255 }).notNull().unique(),
  deviceType: varchar("device_type", { length: 100 }),
  manufacturer: varchar("manufacturer", { length: 255 }),
  serialNumber: varchar("serial_number", { length: 255 }),
  installDate: customTimestamptz("install_date", { precision: 3 }),
  ownerId: varchar("owner_id", { length: 255 }),
  /**
   * @type { protocol?: string; address?: string; samplingRate?: number }
   */
  accessConfig: jsonb("access_config"),
  /**
   * @type { thresholds?: Record<string, number>; alertRules?: Record<string, unknown> }
   */
  runConfig: jsonb("run_config"),
  description: text("description"),
  // System field: Creation time (auto-filled, do not modify)
  createdAt: customTimestamptz("_created_at", { precision: 3 }).notNull().default(sql`CURRENT_TIMESTAMP`),
  // System field: Creator (auto-filled, do not modify)
  createdBy: userProfile("_created_by").default(sql`CASE
    WHEN (current_setting('app.user_id'::text, true) = ''::text) THEN NULL`),
  // System field: Update time (auto-filled, do not modify)
  updatedAt: customTimestamptz("_updated_at", { precision: 3 }).notNull().default(sql`CURRENT_TIMESTAMP`),
  // System field: Updater (auto-filled, do not modify)
  updatedBy: userProfile("_updated_by").default(sql`CASE
    WHEN (current_setting('app.user_id'::text, true) = ''::text) THEN NULL`),
  /** 组织归属（ADR-075：001 ewoh_org_visible RLS 对齐；null=存量/legacy 行）。 */
  orgId: varchar("org_id", { length: 255 }),
}, (table) => [
  uniqueIndex("ewoh_device_config_device_id_key").on(table.deviceId),
]);

export const ewohDeviceBinding = pgTable("ewoh_device_binding", {
  id: uuid("id").primaryKey().defaultRandom(),
  deviceId: varchar("device_id", { length: 255 }).notNull(),
  bindingType: varchar("binding_type", { length: 50 }).notNull(),
  targetId: varchar("target_id", { length: 255 }).notNull(),
  targetType: varchar("target_type", { length: 50 }).notNull(),
  startTime: customTimestamptz("start_time", { precision: 3 }).notNull().default(sql`CURRENT_TIMESTAMP`),
  expectedEndTime: customTimestamptz("expected_end_time", { precision: 3 }),
  actualEndTime: customTimestamptz("actual_end_time", { precision: 3 }),
  reason: text("reason"),
  status: varchar("status", { length: 50 }).default('active'),
  operatorId: varchar("operator_id", { length: 255 }),
  // System field: Creation time (auto-filled, do not modify)
  createdAt: customTimestamptz("_created_at", { precision: 3 }).notNull().default(sql`CURRENT_TIMESTAMP`),
  // System field: Creator (auto-filled, do not modify)
  createdBy: userProfile("_created_by").default(sql`CASE
    WHEN (current_setting('app.user_id'::text, true) = ''::text) THEN NULL`),
  // System field: Update time (auto-filled, do not modify)
  updatedAt: customTimestamptz("_updated_at", { precision: 3 }).notNull().default(sql`CURRENT_TIMESTAMP`),
  // System field: Updater (auto-filled, do not modify)
  updatedBy: userProfile("_updated_by").default(sql`CASE
    WHEN (current_setting('app.user_id'::text, true) = ''::text) THEN NULL`),
  /** 组织归属（ADR-075：001 ewoh_org_visible RLS 对齐；null=存量/legacy 行）。 */
  orgId: varchar("org_id", { length: 255 }),
}, (table) => [
  index("idx_ewoh_device_binding_device").on(table.deviceId),
  index("idx_ewoh_device_binding_target").on(table.targetId),
  index("idx_ewoh_device_binding_status").on(table.status),
]);

export const ewohPersonnel = pgTable("ewoh_personnel", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: varchar("name", { length: 255 }).notNull(),
  employeeNo: varchar("employee_no", { length: 255 }).notNull().unique(),
  orgId: varchar("org_id", { length: 255 }),
  teamName: varchar("team_name", { length: 255 }),
  position: varchar("position", { length: 255 }),
  /**
   * @type { skills: string[] }
   */
  skills: jsonb("skills"),
  /**
   * @type { string[] }
   */
  certifications: jsonb("certifications"),
  /** 业务版本：人员状态/位置等关键变化自增，用于快照新鲜度判断。 */
  version: integer("version").default(1),
  status: varchar("status", { length: 50 }).default('available'),
  healthStatus: varchar("health_status", { length: 50 }).default('normal'),
  /**
   * @type { loadLevel: number; fatigueLevel: number; postureRisk: string }
   */
  currentLoad: jsonb("current_load"),
  spatialEntityId: varchar("spatial_entity_id", { length: 255 }),
  // --- 调度领域模型新列 (standalone_012_domain_columns, Phase 1 / P1-T1) ---
  /** 班次。 */
  shift: varchar("shift", { length: 100 }),
  /** 当前负载 0..1（currentLoad jsonb 之外的独立数值列）。 */
  workload: real("workload"),
  /** 当前任务 id。 */
  currentTaskId: varchar("current_task_id", { length: 255 }),
  /**
   * 证书到期平行列（决策 D-A）：对象数组 [{ name, expiresAtMs }]，与 certifications string[] 并行，
   * 不破坏现有 API 形状；资格判定读取该列。
   * @type { Array<{ name: string; expiresAtMs: number | null }> }
   */
  certificationExpiry: jsonb("certification_expiry").default([]),
  // System field: Creation time (auto-filled, do not modify)
  createdAt: customTimestamptz("_created_at", { precision: 3 }).notNull().default(sql`CURRENT_TIMESTAMP`),
  // System field: Creator (auto-filled, do not modify)
  createdBy: userProfile("_created_by").default(sql`CASE
    WHEN (current_setting('app.user_id'::text, true) = ''::text) THEN NULL`),
  // System field: Update time (auto-filled, do not modify)
  updatedAt: customTimestamptz("_updated_at", { precision: 3 }).notNull().default(sql`CURRENT_TIMESTAMP`),
  // System field: Updater (auto-filled, do not modify)
  updatedBy: userProfile("_updated_by").default(sql`CASE
    WHEN (current_setting('app.user_id'::text, true) = ''::text) THEN NULL`),
}, (table) => [
  index("idx_ewoh_personnel_org").on(table.orgId),
  index("idx_ewoh_personnel_status").on(table.status),
  uniqueIndex("ewoh_personnel_employee_no_key").on(table.employeeNo),
  index("idx_ewoh_personnel_current_task").on(table.currentTaskId),
]);

export const ewohOrganization = pgTable("ewoh_organization", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: varchar("name", { length: 255 }).notNull(),
  orgType: varchar("org_type", { length: 50 }).notNull(),
  parentId: varchar("parent_id", { length: 255 }),
  description: text("description"),
  status: varchar("status", { length: 50 }).default('active'),
  // System field: Creation time (auto-filled, do not modify)
  createdAt: customTimestamptz("_created_at", { precision: 3 }).notNull().default(sql`CURRENT_TIMESTAMP`),
  // System field: Creator (auto-filled, do not modify)
  createdBy: userProfile("_created_by").default(sql`CASE
    WHEN (current_setting('app.user_id'::text, true) = ''::text) THEN NULL`),
  // System field: Update time (auto-filled, do not modify)
  updatedAt: customTimestamptz("_updated_at", { precision: 3 }).notNull().default(sql`CURRENT_TIMESTAMP`),
  // System field: Updater (auto-filled, do not modify)
  updatedBy: userProfile("_updated_by").default(sql`CASE
    WHEN (current_setting('app.user_id'::text, true) = ''::text) THEN NULL`),
  /** 组织归属（ADR-075：001 ewoh_org_visible RLS 对齐；null=存量/legacy 行）。 */
  orgId: varchar("org_id", { length: 255 }),
}, (table) => [
  index("idx_ewoh_organization_parent").on(table.parentId),
  index("idx_ewoh_organization_type").on(table.orgType),
]);

export const ewohSchedulerConfig = pgTable("ewoh_scheduler_config", {
  id: uuid("id").primaryKey().defaultRandom(),
  configKey: varchar("config_key", { length: 255 }).notNull(),
  /**
   * @type { weights?: { w1_output: number; w2_on_time: number; w3_safety_risk: number; w4_body_load: number; w5_move_distance: number; w6_changeover_cost: number }, history?: Array<{ before: Record<string, number>; after: Record<string, number>; operator: string; reason: string; at: string }> }
   */
  configValue: jsonb("config_value").notNull(),
  updatedBy: varchar("updated_by", { length: 255 }),
  orgId: uuid("org_id").notNull().default(sql`nullif(current_setting('app.current_org_id', true), '')::uuid`),
  // System field: Creation time (auto-filled, do not modify)
  createdAt: customTimestamptz("_created_at", { precision: 3 }).notNull().default(sql`CURRENT_TIMESTAMP`),
  // System field: Update time (auto-filled, do not modify)
  updatedAt: customTimestamptz("_updated_at", { precision: 3 }).notNull().default(sql`CURRENT_TIMESTAMP`),
}, (table) => [
  index("idx_ewoh_scheduler_config_org").on(table.orgId),
  uniqueIndex("uq_ewoh_scheduler_config_org_key").on(table.orgId, table.configKey),
]);

export const ewohEnvironment = pgTable("ewoh_environment", {
  id: uuid("id").primaryKey().defaultRandom(),
  sensorId: varchar("sensor_id", { length: 255 }).notNull(),
  entityId: varchar("entity_id", { length: 255 }),
  temperature: real("temperature"),
  vibration: real("vibration"),
  noise: real("noise"),
  airQuality: real("air_quality"),
  ts: customTimestamptz("ts", { precision: 6 }).notNull().default(sql`CURRENT_TIMESTAMP`),
  sourceType: varchar("source_type", { length: 50 }).default('simulated'),
  recordId: varchar("record_id", { length: 64 }),
  dataConfidence: real("data_confidence").default(1.0),
  // System field: Creation time (auto-filled, do not modify)
  createdAt: customTimestamptz("_created_at", { precision: 6 }).notNull().default(sql`CURRENT_TIMESTAMP`),
  // System field: Update time (auto-filled, do not modify)
  updatedAt: customTimestamptz("_updated_at", { precision: 6 }).notNull().default(sql`CURRENT_TIMESTAMP`),
  /** 组织归属（ADR-075：001 ewoh_org_visible RLS 对齐；null=存量/legacy 行）。 */
  orgId: varchar("org_id", { length: 255 }),
}, (table) => [
  index("idx_ewoh_environment_sensor_ts").on(table.sensorId, table.ts),
]);

export const ewohModelRegistry = pgTable("ewoh_model_registry", {
  id: uuid("id").primaryKey().defaultRandom(),
  modelId: varchar("model_id", { length: 255 }).notNull().unique(),
  modelName: varchar("model_name", { length: 255 }).notNull(),
  version: varchar("version", { length: 50 }).notNull(),
  type: varchar("type", { length: 100 }).notNull(),
  status: varchar("status", { length: 50 }).default('active'),
  cardJson: jsonb("card_json"),
  // System field: Creation time (auto-filled, do not modify)
  createdAt: customTimestamptz("_created_at", { precision: 6 }).notNull().default(sql`CURRENT_TIMESTAMP`),
  // System field: Update time (auto-filled, do not modify)
  updatedAt: customTimestamptz("_updated_at", { precision: 6 }).notNull().default(sql`CURRENT_TIMESTAMP`),
  /** 组织归属（ADR-075：001 ewoh_org_visible RLS 对齐；null=存量/legacy 行）。 */
  orgId: varchar("org_id", { length: 255 }),
}, (table) => [
  uniqueIndex("ewoh_model_registry_model_id_key").on(table.modelId),
]);

export const ewohScheduleAudit = pgTable("ewoh_schedule_audit", {
  id: uuid("id").primaryKey().defaultRandom(),
  auditId: varchar("audit_id", { length: 255 }).notNull().unique(),
  planId: varchar("plan_id", { length: 255 }).notNull(),
  action: varchar("action", { length: 100 }).notNull(),
  operator: varchar("operator", { length: 255 }),
  reason: text("reason"),
  createdAt: customTimestamptz("created_at", { precision: 6 }).default(sql`CURRENT_TIMESTAMP`),
  // System field: Update time (auto-filled, do not modify)
  updatedAt: customTimestamptz("_updated_at", { precision: 6 }).notNull().default(sql`CURRENT_TIMESTAMP`),
  /** 组织归属（ADR-075：001 ewoh_org_visible RLS 对齐；null=存量/legacy 行）。 */
  orgId: varchar("org_id", { length: 255 }),
}, (table) => [
  uniqueIndex("ewoh_schedule_audit_audit_id_key").on(table.auditId),
  index("idx_ewoh_schedule_audit_plan").on(table.planId),
]);

export const ewohSchedulePlan = pgTable("ewoh_schedule_plan", {
  id: uuid("id").primaryKey().defaultRandom(),
  planId: varchar("plan_id", { length: 255 }).notNull().unique(),
  planName: varchar("plan_name", { length: 255 }).notNull(),
  strategy: varchar("strategy", { length: 100 }).notNull(),
  status: varchar("status", { length: 50 }).default('shadow'),
  taktImprovement: real("takt_improvement").default(0),
  highLoadPersons: integer("high_load_persons").default(0),
  lowBatteryRisk: integer("low_battery_risk").default(0),
  affectedPersons: integer("affected_persons").default(0),
  metricsJson: jsonb("metrics_json"),
  reason: text("reason"),
  createdAt: customTimestamptz("created_at", { precision: 6 }).default(sql`CURRENT_TIMESTAMP`),
  // B5 审批独立性（standalone_069）：方案生成操作者；NULL=存量/legacy 行（回避校验放行）。
  createdBy: varchar("created_by", { length: 255 }),
  confirmedBy: varchar("confirmed_by", { length: 255 }),
  confirmedAt: customTimestamptz("confirmed_at", { precision: 6 }),
  confirmReason: text("confirm_reason"),
  // --- Scheduling V2 fields (standalone_006) ---
  version: integer("version").notNull().default(1),
  snapshotVersion: varchar("snapshot_version", { length: 255 }),
  triggerType: varchar("trigger_type", { length: 100 }),
  triggerEntityId: varchar("trigger_entity_id", { length: 255 }),
  /**
   * @type { Record<string, unknown> }
   */
  baselineDeltaJson: jsonb("baseline_delta_json"),
  /**
   * @type { Array<Record<string, unknown>> }
   */
  violationsJson: jsonb("violations_json"),
  supersededBy: varchar("superseded_by", { length: 255 }),
  // --- Scheduling V2 full persistence (standalone_007) ---
  /** 求解所用策略版本（对应 SchedulingPolicy.version）。 */
  policyVersion: integer("policy_version"),
  /** 求解器版本（对应 SchedulingPolicy.solverVersion）。 */
  solverVersion: varchar("solver_version", { length: 100 }),
  // --- Solver 激活阶梯持久化（standalone_030_solver_activation，Task A / P0） ---
  /** 实际使用的求解器状态（OPTIMAL/FEASIBLE/HEURISTIC/FALLBACK/TIMEOUT/UNAVAILABLE）。 */
  solverStatus: varchar("solver_status", { length: 32 }),
  /** 回退/降级原因（如 worker 不可达、超时、production_not_gated；无回退为 NULL）。 */
  fallbackReason: text("fallback_reason"),
  /** 求解时间窗（分钟）。 */
  horizonMinutes: integer("horizon_minutes"),
  /**
   * @type { Record<string, unknown> }
   */
  scoreBreakdownJson: jsonb("score_breakdown_json"),
  /**
   * 方案实际使用的目标权重快照（standalone_014_policy_weights，Phase 2 / P2-T2；确定性 replay）。
   * @type { { lateness: number; travel: number; wait: number; workload: number; station: number; change: number; risk: number; energy: number } | null }
   */
  weightsJson: jsonb("weights_json"),
  /**
   * Shadow Plan 标识（standalone_020_policy_lifecycle）：服务端 hard guard——
   * shadow plan 不可 approve/dispatch/reserve（不靠前端隐藏按钮）。
   */
  isShadow: boolean("is_shadow").notNull().default(false),
  /** 生成该 Shadow Plan 的策略版本。 */
  shadowPolicyVersion: integer("shadow_policy_version"),
  // --- AI 调度说明层 (standalone_064, 2026-08-21) ---
  /** AI（LLM）或规则模板生成的自然语言调度说明（面向班组长/调度员解读方案）。 */
  aiNarration: text("ai_narration"),
  /** 说明来源：llm | rule_fallback（LLM 不可用/超时/失败时规则模板兜底）。 */
  narrationSource: varchar("narration_source", { length: 32 }),
  // --- Command Map 增量 (standalone_023, Phase 0 / P0-2) ---
  /**
   * 求解所用 effective constraints 快照（确定性 replay + 审计）。
   * @type { Array<Record<string, unknown>> }
   */
  constraintsJson: jsonb("constraints_json").notNull().default([]),
  /** constraints 稳定哈希（键排序 JSON 序列化 → SHA-256；replay 校验）。 */
  effectiveConstraintsHash: varchar("effective_constraints_hash", { length: 64 }),
  /**
   * NO-12y / ADR-048：Canonical DecisionRecord[]（ADR-047 契约形态，standalone_050）——
   * persistPlan 唯一投影点写入；决策历史单一事实源（§12/§18）。
   * @type { Array<Record<string, unknown>> | null }
   */
  decisionRecordsJson: jsonb("decision_records_json"),
  /** 租户归属（standalone_057 起 NOT NULL，存量 NULL 行已回填默认 org；RLS org 隔离）。 */
  orgId: varchar("org_id", { length: 255 }).notNull(),
  // System field: Update time (auto-filled, do not modify)
  updatedAt: customTimestamptz("_updated_at", { precision: 6 }).notNull().default(sql`CURRENT_TIMESTAMP`),
}, (table) => [
  uniqueIndex("ewoh_schedule_plan_plan_id_key").on(table.planId),
  index("idx_ewoh_schedule_plan_status").on(table.status),
  index("idx_ewoh_schedule_plan_snapshot").on(table.snapshotVersion),
  index("idx_ewoh_schedule_plan_trigger").on(table.triggerType, table.triggerEntityId),
  index("idx_schedule_plan_constraint_hash").on(table.effectiveConstraintsHash),
]);

export const ewohEventChain = pgTable("ewoh_event_chain", {
  id: uuid("id").primaryKey().defaultRandom(),
  eventId: varchar("event_id", { length: 255 }).notNull(),
  parentEventId: varchar("parent_event_id", { length: 255 }),
  causalType: varchar("causal_type", { length: 100 }).default('triggered'),
  description: text("description"),
  createdAt: customTimestamptz("created_at", { precision: 6 }).default(sql`CURRENT_TIMESTAMP`),
  // System field: Update time (auto-filled, do not modify)
  updatedAt: customTimestamptz("_updated_at", { precision: 6 }).notNull().default(sql`CURRENT_TIMESTAMP`),
  /** 组织归属（ADR-075：001 ewoh_org_visible RLS 对齐；null=存量/legacy 行）。 */
  orgId: varchar("org_id", { length: 255 }),
}, (table) => [
  index("idx_ewoh_event_chain_event").on(table.eventId),
  index("idx_ewoh_event_chain_parent").on(table.parentEventId),
]);

export const ewohWorldState = pgTable("ewoh_world_state", {
  id: uuid("id").primaryKey().defaultRandom(),
  entityId: varchar("entity_id", { length: 255 }).notNull(),
  stateJson: jsonb("state_json").notNull(),
  ts: customTimestamptz("ts", { precision: 6 }).notNull().default(sql`CURRENT_TIMESTAMP`),
  orgId: varchar("org_id", { length: 255 }),
  // System field: Creation time (auto-filled, do not modify)
  createdAt: customTimestamptz("_created_at", { precision: 6 }).notNull().default(sql`CURRENT_TIMESTAMP`),
  // System field: Update time (auto-filled, do not modify)
  updatedAt: customTimestamptz("_updated_at", { precision: 6 }).notNull().default(sql`CURRENT_TIMESTAMP`),
}, (table) => [
  index("idx_ewoh_world_state_entity_ts").on(table.entityId, table.ts),
  index("idx_ewoh_world_state_org_ts").on(table.orgId, table.ts),
]);

export const ewohTopology = pgTable("ewoh_topology", {
  id: uuid("id").primaryKey().defaultRandom(),
  fromEntity: varchar("from_entity", { length: 255 }).notNull(),
  toEntity: varchar("to_entity", { length: 255 }).notNull(),
  relation: varchar("relation", { length: 100 }).notNull().default('adjacent'),
  distance: real("distance").default(0),
  // System field: Creation time (auto-filled, do not modify)
  createdAt: customTimestamptz("_created_at", { precision: 6 }).notNull().default(sql`CURRENT_TIMESTAMP`),
  // System field: Update time (auto-filled, do not modify)
  updatedAt: customTimestamptz("_updated_at", { precision: 6 }).notNull().default(sql`CURRENT_TIMESTAMP`),
  /** 组织归属（ADR-075：001 ewoh_org_visible RLS 对齐；null=存量/legacy 行）。 */
  orgId: varchar("org_id", { length: 255 }),
}, (table) => [
  index("idx_ewoh_topology_from").on(table.fromEntity),
]);

export const ewohSpatialEntity = pgTable("ewoh_spatial_entity", {
  id: uuid("id").primaryKey().defaultRandom(),
  entityId: varchar("entity_id", { length: 255 }).notNull(),
  entityType: varchar("entity_type", { length: 100 }).notNull(),
  parentId: varchar("parent_id", { length: 255 }),
  name: varchar("name", { length: 255 }).notNull(),
  x: real("x").default(0),
  y: real("y").default(0),
  yaw: real("yaw").default(0),
  bboxW: real("bbox_w").default(0),
  bboxH: real("bbox_h").default(0),
  status: varchar("status", { length: 100 }).default('active'),
  sourceType: varchar("source_type", { length: 50 }).default('seed'),
  confidence: real("confidence").default(1.0),
  version: integer("version").default(1),
  extra: jsonb("extra"),
  // --- 调度领域模型新列 (standalone_012_domain_columns, Phase 1 / P1-T1) ---
  /** 工位容量（替代 extra.capacity 非正式字段）。 */
  capacity: integer("capacity"),
  /**
   * 工位队列（jsonb string[]）。
   * @type { string[] }
   */
  queue: jsonb("queue").default([]),
  /**
   * 工位可用窗口（jsonb [{ startMs, endMs }]）。
   * @type { Array<{ startMs: number; endMs: number }> }
   */
  availableWindows: jsonb("available_windows").default([]),
  orgId: varchar("org_id", { length: 255 }),
  // --- Command Map 增量 (standalone_023, Phase 0 / P0-3) ---
  /** 坐标类型：FACTORY_CARTESIAN / WGS84 / UNKNOWN。 */
  coordinateType: varchar("coordinate_type", { length: 20 }).notNull().default("FACTORY_CARTESIAN"),
  /** FACTORY_CARTESIAN 楼层标识（WGS84 为 null）。 */
  floorId: varchar("floor_id", { length: 100 }),
  // System field: Creation time (auto-filled, do not modify)
  createdAt: customTimestamptz("_created_at", { precision: 6 }).notNull().default(sql`CURRENT_TIMESTAMP`),
  // System field: Update time (auto-filled, do not modify)
  updatedAt: customTimestamptz("_updated_at", { precision: 6 }).notNull().default(sql`CURRENT_TIMESTAMP`),
}, (table) => [
  // R2-SOP-003/R2-SAM-003（standalone_059）：entityId 单列唯一 → (org_id, entity_id)
  // 租户复合唯一（跨租户可复用同一 entity_id；同 org 内唯一）。
  uniqueIndex("uq_ewoh_spatial_entity_org_entity").on(table.orgId, table.entityId),
  index("idx_ewoh_spatial_entity_type").on(table.entityType),
  index("idx_ewoh_spatial_entity_parent").on(table.parentId),
  index("idx_ewoh_spatial_entity_org_type").on(table.orgId, table.entityType),
  index("idx_ewoh_spatial_entity_org_status").on(table.orgId, table.status),
]);

export const ewohTelemetry = pgTable("ewoh_telemetry", {
  id: uuid("id").primaryKey().defaultRandom(),
  deviceId: varchar("device_id", { length: 255 }).notNull(),
  entityId: varchar("entity_id", { length: 180 }),
  ts: customTimestamptz("ts", { precision: 6 }).notNull(),
  pitchDeg: real("pitch_deg"),
  loadScore: real("load_score"),
  fatigueTrend: real("fatigue_trend"),
  batteryPct: integer("battery_pct"),
  qualityStatus: varchar("quality_status", { length: 255 }),
  sourceType: varchar("source_type", { length: 50 }).default('simulated'),
  recordId: varchar("record_id", { length: 64 }),
  ingestedAt: customTimestamptz("ingested_at", { precision: 6 }).default(sql`CURRENT_TIMESTAMP`),
  rawRef: varchar("raw_ref", { length: 128 }),
  jointAngles: jsonb("joint_angles"),
  angularVelocityDps: real("angular_velocity_dps"),
  assistLevel: real("assist_level"),
  torqueNm: real("torque_nm"),
  cumulativeLoadScore: real("cumulative_load_score"),
  temperatureC: real("temperature_c"),
  faultCode: varchar("fault_code", { length: 100 }),
  packetLossPct: real("packet_loss_pct").default(0),
  dataConfidence: real("data_confidence").default(1.0),
  dataQuality: varchar("data_quality", { length: 20 }).default('good'),
  // System field: Creation time (auto-filled, do not modify)
  createdAt: customTimestamptz("_created_at", { precision: 6 }).notNull().default(sql`CURRENT_TIMESTAMP`),
  // System field: Update time (auto-filled, do not modify)
  updatedAt: customTimestamptz("_updated_at", { precision: 6 }).notNull().default(sql`CURRENT_TIMESTAMP`),
  /** 组织归属（ADR-075：001 ewoh_org_visible RLS 对齐；null=存量/legacy 行）。 */
  orgId: varchar("org_id", { length: 255 }),
}, (table) => [
  index("idx_ewoh_telemetry_device_ts").on(table.deviceId, table.ts),
  index("idx_ewoh_telemetry_entity_id").on(table.entityId),
  index("idx_telemetry_source").on(table.sourceType),
  index("idx_telemetry_record").on(table.recordId),
]);

export const ewohEvent = pgTable("ewoh_event", {
  id: uuid("id").primaryKey().defaultRandom(),
  eventId: varchar("event_id", { length: 255 }).notNull().unique(),
  deviceId: varchar("device_id", { length: 255 }),
  eventCode: varchar("event_code", { length: 255 }),
  eventType: varchar("event_type", { length: 255 }),
  severity: varchar("severity", { length: 255 }),
  title: varchar("title", { length: 500 }),
  status: varchar("status", { length: 255 }).default('open'),
  createdAt: customTimestamptz("created_at", { precision: 6 }),
  handlerAction: text("handler_action"),
  sourceType: varchar("source_type", { length: 50 }).default('simulated'),
  triggerRecordId: varchar("trigger_record_id", { length: 64 }),
  /**
   * 证据快照（触发时关键指标）
   */
  evidenceJson: jsonb("evidence_json"),
  /** Event Envelope 字段（standalone_066, ADR-009/§5）：全链路强制。 */
  /** 事件发生时间（ADR-009 occurredAt；边缘设备时钟；NULL=边缘未上行）。 */
  occurredAt: customTimestamptz("occurred_at", { precision: 6 }),
  /** 事件观察时间（ADR-009 observedAt；边缘接收时间）。 */
  observedAt: customTimestamptz("observed_at", { precision: 6 }),
  /** 云端接收时间（ADR-009 receivedAt；ingest 写入时 now()）。 */
  receivedAt: customTimestamptz("received_at", { precision: 6 }),
  /** 引起本事件的事件 ID（ADR-009 causationId；因果链追踪）。 */
  causationId: varchar("causation_id", { length: 255 }),
  /** 关联事件组 ID（ADR-009 correlationId；同一流程所有事件共享）。 */
  correlationId: varchar("correlation_id", { length: 255 }),
  /** 事件置信度（ADR-009 confidence；0-1 范围；NULL=未声明）。 */
  confidence: numeric("confidence", { precision: 5, scale: 4 }),
  /** 事件模式版本（ADR-009 schemaVersion；1.0.0）。 */
  schemaVersion: varchar("schema_version", { length: 50 }),
  orgId: varchar("org_id", { length: 255 }),
  // System field: Update time (auto-filled, do not modify)
  updatedAt: customTimestamptz("_updated_at", { precision: 6 }).notNull().default(sql`CURRENT_TIMESTAMP`),
}, (table) => [
  uniqueIndex("ewoh_event_event_id_key").on(table.eventId),
  index("idx_ewoh_event_status").on(table.status),
  index("idx_ewoh_event_created_at").on(table.createdAt),
  index("idx_event_source").on(table.sourceType),
  index("idx_ewoh_event_org_status").on(table.orgId, table.status),
  index("idx_ewoh_event_org_type").on(table.orgId, table.eventType),
  index("idx_ewoh_event_org_created").on(table.orgId, table.createdAt),
  index("idx_ewoh_event_org_key").on(table.orgId, table.eventId),
]);

export const ewohFactoryTemplate = pgTable("ewoh_factory_template", {
  id: uuid("id").primaryKey().defaultRandom(),
  templateId: varchar("template_id", { length: 255 }).notNull().unique(),
  name: varchar("name", { length: 255 }).notNull(),
  industry: varchar("industry", { length: 100 }),
  version: varchar("version", { length: 50 }).notNull(),
  parentTemplateId: varchar("parent_template_id", { length: 255 }),
  inheritanceOrder: integer("inheritance_order").notNull().default(0),
  lifecycleStatus: varchar("lifecycle_status", { length: 50 }).notNull().default('draft'),
  configJson: jsonb("config_json").notNull().default({}),
  manifestJson: jsonb("manifest_json").notNull().default({}),
  compatibleCore: varchar("compatible_core", { length: 100 }),
  publishedAt: customTimestamptz("published_at", { precision: 3 }),
  deletedAt: customTimestamptz("deleted_at", { precision: 3 }),
  createdAt: customTimestamptz("_created_at", { precision: 3 }).notNull().default(sql`CURRENT_TIMESTAMP`),
  createdBy: uuid("_created_by"),
  updatedAt: customTimestamptz("_updated_at", { precision: 3 }).notNull().default(sql`CURRENT_TIMESTAMP`),
  updatedBy: uuid("_updated_by"),
  /** 组织归属（ADR-075：001 ewoh_org_visible RLS 对齐；null=存量/legacy 行）。 */
  orgId: varchar("org_id", { length: 255 }),
}, (table) => [
  index("idx_ewoh_factory_template_lifecycle").on(table.lifecycleStatus),
]);

export const ewohFactoryProfile = pgTable("ewoh_factory_profile", {
  id: uuid("id").primaryKey().defaultRandom(),
  profileId: varchar("profile_id", { length: 255 }).notNull().unique(),
  factoryName: varchar("factory_name", { length: 255 }).notNull(),
  templateId: varchar("template_id", { length: 255 }).notNull(),
  configJson: jsonb("config_json").notNull().default({}),
  status: varchar("status", { length: 50 }).notNull().default('draft'),
  installedAt: customTimestamptz("installed_at", { precision: 3 }),
  deletedAt: customTimestamptz("deleted_at", { precision: 3 }),
  createdAt: customTimestamptz("_created_at", { precision: 3 }).notNull().default(sql`CURRENT_TIMESTAMP`),
  createdBy: uuid("_created_by"),
  updatedAt: customTimestamptz("_updated_at", { precision: 3 }).notNull().default(sql`CURRENT_TIMESTAMP`),
  updatedBy: uuid("_updated_by"),
  /** 组织归属（ADR-075：001 ewoh_org_visible RLS 对齐；null=存量/legacy 行）。 */
  orgId: varchar("org_id", { length: 255 }),
}, (table) => [
  index("idx_ewoh_factory_profile_status").on(table.status),
]);

export const ewohAssetPackage = pgTable("ewoh_asset_package", {
  id: uuid("id").primaryKey().defaultRandom(),
  packageId: varchar("package_id", { length: 255 }).notNull().unique(),
  packageType: varchar("package_type", { length: 50 }).notNull(),
  name: varchar("name", { length: 255 }).notNull(),
  version: varchar("version", { length: 50 }).notNull(),
  manifestJson: jsonb("manifest_json").notNull().default({}),
  status: varchar("status", { length: 50 }).notNull().default('draft'),
  publishedAt: customTimestamptz("published_at", { precision: 3 }),
  deletedAt: customTimestamptz("deleted_at", { precision: 3 }),
  createdAt: customTimestamptz("_created_at", { precision: 3 }).notNull().default(sql`CURRENT_TIMESTAMP`),
  createdBy: uuid("_created_by"),
  updatedAt: customTimestamptz("_updated_at", { precision: 3 }).notNull().default(sql`CURRENT_TIMESTAMP`),
  updatedBy: uuid("_updated_by"),
  /** 组织归属（ADR-075：001 ewoh_org_visible RLS 对齐；null=存量/legacy 行）。 */
  orgId: varchar("org_id", { length: 255 }),
}, (table) => [
  index("idx_ewoh_asset_package_type").on(table.packageType, table.status),
]);

export const ewohNotification = pgTable("ewoh_notification", {
  id: uuid("id").primaryKey().defaultRandom(),
  orgId: uuid("org_id"),
  notificationId: varchar("notification_id", { length: 255 }).notNull().unique(),
  recipientType: varchar("recipient_type", { length: 50 }).notNull(),
  recipientId: varchar("recipient_id", { length: 255 }).notNull(),
  channel: varchar("channel", { length: 100 }).notNull(),
  title: varchar("title", { length: 255 }).notNull(),
  body: text("body"),
  severity: varchar("severity", { length: 50 }).notNull().default('info'),
  status: varchar("status", { length: 50 }).notNull().default('pending'),
  scheduledAt: customTimestamptz("scheduled_at", { precision: 3 }),
  sentAt: customTimestamptz("sent_at", { precision: 3 }),
  readAt: customTimestamptz("read_at", { precision: 3 }),
  externalRef: varchar("external_ref", { length: 255 }),
  errorMessage: text("error_message"),
  createdAt: customTimestamptz("_created_at", { precision: 3 }).notNull().default(sql`CURRENT_TIMESTAMP`),
  updatedAt: customTimestamptz("_updated_at", { precision: 3 }).notNull().default(sql`CURRENT_TIMESTAMP`),
}, (table) => [
  index("idx_ewoh_notification_status").on(table.status),
]);

/**
 * Agent 命令审批台账（standalone_049，ADR-039 / NO-12p，§11 + ADR-030 决策 4 收口）。
 * Agent 待批命令跨重启持久化：propose 落 pending 行 → resolve 经 CAS
 * （WHERE status='pending' RETURNING）写 approved/rejected/expired +
 * resolved_at/resolved_by/resolution_json——审批不因进程重启消失或失效
 * （§20 可靠性 + §33 过期显式不静默）。
 */
export const ewohAgentApproval = pgTable("ewoh_agent_approval", {
  id: uuid("id").primaryKey().defaultRandom(),
  orgId: varchar("org_id", { length: 255 }).notNull(),
  approvalId: varchar("approval_id", { length: 255 }).notNull(),
  agentId: varchar("agent_id", { length: 255 }).notNull(),
  command: varchar("command", { length: 255 }).notNull(),
  /**
   * @type { Record<string, unknown> }
   */
  payloadJson: jsonb("payload_json").notNull().default({}),
  /**
   * @type { string[] }
   */
  rolesJson: jsonb("roles_json").notNull().default([]),
  status: varchar("status", { length: 20 }).notNull().default('pending'),
  createdAt: customTimestamptz("created_at", { precision: 3 }).notNull().default(sql`CURRENT_TIMESTAMP`),
  resolvedAt: customTimestamptz("resolved_at", { precision: 3 }),
  resolvedBy: varchar("resolved_by", { length: 255 }),
  /**
   * @type { Record<string, unknown> }
   */
  resolutionJson: jsonb("resolution_json"),
  /**
   * NO-13j / ADR-059（standalone_052 原地加固）：agent_approval 决策记录
   * （ADR-047 契约形态 DecisionRecord，resolveRow 唯一权威写路径；
   * NULL=存量未投影行，additive）。
   * @type { Record<string, unknown> | null }
   */
  decisionJson: jsonb("decision_json"),
  updatedAt: customTimestamptz("_updated_at", { precision: 3 }).notNull().default(sql`CURRENT_TIMESTAMP`),
}, (table) => [
  index("idx_ewoh_agent_approval_status").on(table.status),
]);

export const ewohDevice = pgTable("ewoh_device", {
  id: uuid("id").primaryKey().defaultRandom(),
  // R2-SOP-014：单列 .unique() 已由 057 迁移改为 (org_id, device_id) 复合唯一
  //（见下方 uq_ewoh_device_org_device），移除漂移的单列声明。
  deviceId: varchar("device_id", { length: 255 }).notNull(),
  workerName: varchar("worker_name", { length: 255 }),
  deviceModel: varchar("device_model", { length: 255 }),
  batteryPct: integer("battery_pct").default(100),
  online: boolean("online").default(false),
  lastTelemetryAt: customTimestamptz("last_telemetry_at", { precision: 6 }),
  sourceType: varchar("source_type", { length: 50 }).default('simulated'),
  firmwareVersion: varchar("firmware_version", { length: 100 }),
  hardwareVersion: varchar("hardware_version", { length: 100 }),
  protocolVersion: varchar("protocol_version", { length: 50 }),
  temperatureC: real("temperature_c"),
  faultCode: varchar("fault_code", { length: 100 }),
  lastRawRef: varchar("last_raw_ref", { length: 128 }),
  // --- 调度领域模型新列 (standalone_012_domain_columns, Phase 1 / P1-T1) ---
  /**
   * 真实能力集合（jsonb string[]，替代型号白名单派生）。
   * @type { string[] }
   */
  capabilities: jsonb("capabilities").default([]),
  /** 设备自身位置（毫米坐标，替代借用人员坐标）。 */
  locationLat: real("location_lat"),
  locationLng: real("location_lng"),
  /** 位置更新时间。 */
  locationUpdatedAt: customTimestamptz("location_updated_at", { precision: 6 }),
  /** 位置置信度 0..1。 */
  locationConfidence: real("location_confidence").default(0),
  /** 遥测更新时间。 */
  telemetryUpdatedAt: customTimestamptz("telemetry_updated_at", { precision: 6 }),
  /**
   * 设备可用窗口（jsonb [{ startMs, endMs }]，替代恒空）。
   * @type { Array<{ startMs: number; endMs: number }> }
   */
  availableWindows: jsonb("available_windows").default([]),
  // --- Command Map 增量 (standalone_027_resource_time_windows, Phase 1 / P1-A) ---
  /** 维护开始时间（epoch ms；null=无维护计划）。 */
  maintenanceStartMs: bigint("maintenance_start_ms", { mode: 'number' }),
  /** 维护结束时间（epoch ms；null=无维护计划）。 */
  maintenanceEndMs: bigint("maintenance_end_ms", { mode: 'number' }),
  // --- Command Map 增量 (standalone_023, Phase 0 / P0-3) ---
  /** 设备位置坐标类型：FACTORY_CARTESIAN / WGS84 / UNKNOWN（location_lat/lng 语义）。 */
  locationCoordinateType: varchar("location_coordinate_type", { length: 20 }).notNull().default("FACTORY_CARTESIAN"),
  // System field: Creation time (auto-filled, do not modify)
  createdAt: customTimestamptz("_created_at", { precision: 6 }).notNull().default(sql`CURRENT_TIMESTAMP`),
  // System field: Update time (auto-filled, do not modify)
  updatedAt: customTimestamptz("_updated_at", { precision: 6 }).notNull().default(sql`CURRENT_TIMESTAMP`),
  /** 组织归属（ADR-075：001 ewoh_org_visible RLS 对齐；null=存量/legacy 行）。 */
  orgId: varchar("org_id", { length: 255 }),
}, (table) => [
  // NEST-205 配套（standalone_057）：deviceId 单列唯一 → (org_id, device_id)
  // 租户复合唯一（跨租户可复用同一 device_id；同 org 内唯一）。
  uniqueIndex("uq_ewoh_device_org_device").on(table.orgId, table.deviceId),
  index("idx_ewoh_device_online").on(table.online),
]);

// --- F61-02 domain persistence tables (manually maintained, NOT synced from platform) ---

export const ewohResourceLocks = pgTable("ewoh_resource_locks", {
  id: uuid("id").primaryKey().defaultRandom(),
  orgId: varchar("org_id", { length: 255 }).notNull(),
  resourceKey: varchar("resource_key", { length: 255 }).notNull(),
  resourceId: varchar("resource_id", { length: 255 }).notNull(),
  holder: varchar("holder", { length: 255 }).notNull(),
  purpose: text("purpose"),
  acquiredAt: customTimestamptz("acquired_at", { precision: 3 }).notNull().default(sql`CURRENT_TIMESTAMP`),
  expiresAt: customTimestamptz("expires_at", { precision: 3 }),
  renewedAt: customTimestamptz("renewed_at", { precision: 3 }),
  active: boolean("active").notNull().default(true),
  version: integer("version").notNull().default(1),
  createdAt: customTimestamptz("_created_at", { precision: 3 }).notNull().default(sql`CURRENT_TIMESTAMP`),
  updatedAt: customTimestamptz("_updated_at", { precision: 3 }).notNull().default(sql`CURRENT_TIMESTAMP`),
}, (table) => [
  uniqueIndex("uq_ewoh_resource_locks_org_key").on(table.orgId, table.resourceKey),
  index("idx_ewoh_resource_locks_holder").on(table.holder),
  index("idx_ewoh_resource_locks_active").on(table.active),
]);

export const ewohHandoffs = pgTable("ewoh_handoffs", {
  id: uuid("id").primaryKey().defaultRandom(),
  handoffId: varchar("handoff_id", { length: 255 }).notNull().unique(),
  fromActor: varchar("from_actor", { length: 255 }).notNull(),
  toActor: varchar("to_actor", { length: 255 }).notNull(),
  scope: varchar("scope", { length: 500 }).notNull(),
  contextPack: text("context_pack"),
  acceptance: text("acceptance"),
  /**
   * @type { string[] }
   */
  openQuestions: jsonb("open_questions"),
  state: varchar("state", { length: 50 }).notNull().default('open'),
  createdAt: customTimestamptz("created_at", { precision: 3 }).notNull().default(sql`CURRENT_TIMESTAMP`),
  acceptedAt: customTimestamptz("accepted_at", { precision: 3 }),
  closedAt: customTimestamptz("closed_at", { precision: 3 }),
  updatedAt: customTimestamptz("_updated_at", { precision: 3 }).notNull().default(sql`CURRENT_TIMESTAMP`),
}, (table) => [
  index("idx_ewoh_handoffs_state").on(table.state),
  index("idx_ewoh_handoffs_to_actor").on(table.toActor),
]);

export const ewohGitSyncState = pgTable("ewoh_git_sync_state", {
  id: uuid("id").primaryKey().defaultRandom(),
  syncId: varchar("sync_id", { length: 255 }).notNull().unique(),
  lastSyncAt: customTimestamptz("last_sync_at", { precision: 3 }),
  lastSyncSha: varchar("last_sync_sha", { length: 64 }),
  lastSyncStatus: varchar("last_sync_status", { length: 50 }),
  /**
   * @type { unknown }
   */
  conflicts: jsonb("conflicts"),
  createdAt: customTimestamptz("created_at", { precision: 3 }).notNull().default(sql`CURRENT_TIMESTAMP`),
  updatedAt: customTimestamptz("_updated_at", { precision: 3 }).notNull().default(sql`CURRENT_TIMESTAMP`),
});

export const ewohEvidenceMetadata = pgTable("ewoh_evidence_metadata", {
  id: uuid("id").primaryKey().defaultRandom(),
  evidenceId: varchar("evidence_id", { length: 255 }).notNull().unique(),
  workItemId: varchar("work_item_id", { length: 255 }),
  commitSha: varchar("commit_sha", { length: 64 }),
  envFingerprint: varchar("env_fingerprint", { length: 255 }),
  verifier: varchar("verifier", { length: 255 }),
  producedAt: customTimestamptz("produced_at", { precision: 3 }),
  expiresAt: customTimestamptz("expires_at", { precision: 3 }),
  result: varchar("result", { length: 50 }),
  checksum: varchar("checksum", { length: 128 }),
  createdAt: customTimestamptz("_created_at", { precision: 3 }).notNull().default(sql`CURRENT_TIMESTAMP`),
  updatedAt: customTimestamptz("_updated_at", { precision: 3 }).notNull().default(sql`CURRENT_TIMESTAMP`),
}, (table) => [
  index("idx_ewoh_evidence_metadata_work_item").on(table.workItemId),
]);

export const ewohFactoryReplicationSessions = pgTable("ewoh_factory_replication_sessions", {
  id: uuid("id").primaryKey().defaultRandom(),
  sessionId: varchar("session_id", { length: 255 }).notNull().unique(),
  orgId: varchar("org_id", { length: 255 }),
  factoryId: varchar("factory_id", { length: 255 }).notNull(),
  step: varchar("step", { length: 100 }),
  status: varchar("status", { length: 50 }).notNull().default('running'),
  progress: integer("progress").notNull().default(0),
  startedAt: customTimestamptz("started_at", { precision: 3 }).notNull().default(sql`CURRENT_TIMESTAMP`),
  finishedAt: customTimestamptz("finished_at", { precision: 3 }),
  outputEvidenceId: varchar("output_evidence_id", { length: 255 }),
  createdAt: customTimestamptz("_created_at", { precision: 3 }).notNull().default(sql`CURRENT_TIMESTAMP`),
  updatedAt: customTimestamptz("_updated_at", { precision: 3 }).notNull().default(sql`CURRENT_TIMESTAMP`),
}, (table) => [
  index("idx_ewoh_factory_replication_sessions_factory").on(table.factoryId),
  index("idx_ewoh_factory_replication_sessions_status").on(table.status),
]);

export const ewohIdempotencyKeys = pgTable("ewoh_idempotency_keys", {
  id: uuid("id").primaryKey().defaultRandom(),
  idempotencyKey: varchar("idempotency_key", { length: 500 }).notNull(),
  scope: varchar("scope", { length: 100 }).notNull().default('default'),
  /**
   * @type { unknown }
   */
  response: jsonb("response"),
  // R2-SDB-006（standalone_060）：租户维度——(scope, key) 键空间跨租户共享会
  // 回放他租户响应；DB 层 DEFAULT 取 app.current_org_id GUC，无 GUC 上下文
  // 回退默认 org（与 057 存量回填口径一致）。RLS idempotency_org_isolation。
  orgId: varchar("org_id", { length: 255 }).notNull().default(sql`COALESCE(NULLIF(current_setting('app.current_org_id', true), ''), '00000000-0000-4000-8000-000000000001')`),
  createdAt: customTimestamptz("_created_at", { precision: 3 }).notNull().default(sql`CURRENT_TIMESTAMP`),
  updatedAt: customTimestamptz("_updated_at", { precision: 3 }).notNull().default(sql`CURRENT_TIMESTAMP`),
}, (table) => [
  uniqueIndex("uq_ewoh_idempotency_keys_org_scope_key").on(table.orgId, table.scope, table.idempotencyKey),
]);

export const ewohSavedViews = pgTable("saved_views", {
  id: uuid("id").primaryKey().defaultRandom(),
  organizationId: varchar("organization_id", { length: 255 }).notNull(),
  ownerUserId: varchar("owner_user_id", { length: 255 }).notNull(),
  name: varchar("name", { length: 255 }).notNull(),
  workbench: varchar("workbench", { length: 50 }).notNull(),
  listKey: varchar("list_key", { length: 100 }),
  schemaVersion: integer("schema_version").notNull().default(1),
  /**
   * @type { Record<string, unknown> }
   */
  filterJson: jsonb("filter_json"),
  /**
   * @type { Record<string, unknown> }
   */
  sortJson: jsonb("sort_json"),
  /**
   * @type { string[] }
   */
  visibleColumns: jsonb("visible_columns"),
  /**
   * @type { string[] }
   */
  columnOrder: jsonb("column_order"),
  density: varchar("density", { length: 20 }),
  isDefault: boolean("is_default").notNull().default(false),
  createdAt: customTimestamptz("created_at", { precision: 3 }).notNull().default(sql`CURRENT_TIMESTAMP`),
  updatedAt: customTimestamptz("updated_at", { precision: 3 }).notNull().default(sql`CURRENT_TIMESTAMP`),
  deletedAt: customTimestamptz("deleted_at", { precision: 3 }),
}, (table) => [
  index("idx_saved_views_org_owner").on(table.organizationId, table.ownerUserId),
  index("idx_saved_views_org_name").on(table.organizationId, table.name),
  uniqueIndex("uq_saved_views_default").on(table.organizationId, table.ownerUserId, table.workbench, table.listKey).where(sql`${table.isDefault} AND ${table.deletedAt} IS NULL`),
  // SQL-009（standalone_057）：软删排除的同名视图唯一键 (org, owner, workbench, name)。
  uniqueIndex("uq_saved_views_org_owner_name").on(table.organizationId, table.ownerUserId, table.workbench, table.name).where(sql`${table.deletedAt} IS NULL`),
]);

export const ewohWorkbenchExportTask = pgTable("workbench_export_tasks", {
  id: uuid("id").primaryKey().defaultRandom(),
  taskId: varchar("task_id", { length: 255 }).notNull(),
  organizationId: varchar("organization_id", { length: 255 }).notNull(),
  ownerUserId: varchar("owner_user_id", { length: 255 }).notNull(),
  role: varchar("role", { length: 50 }).notNull(),
  listKey: varchar("list_key", { length: 100 }).notNull(),
  /**
   * @type { Record<string, unknown> }
   */
  filterJson: jsonb("filter_json"),
  /**
   * @type { Record<string, unknown> }
   */
  sortJson: jsonb("sort_json"),
  /**
   * @type { string[] }
   */
  columnsJson: jsonb("columns_json"),
  status: varchar("status", { length: 20 }).notNull().default('queued'),
  progress: integer("progress").notNull().default(0),
  processed: integer("processed").notNull().default(0),
  total: integer("total").notNull().default(0),
  error: text("error"),
  idempotencyKey: varchar("idempotency_key", { length: 255 }),
  attempts: integer("attempts").notNull().default(0),
  nextRetryAt: customTimestamptz("next_retry_at", { precision: 3 }),
  claimedBy: varchar("claimed_by", { length: 255 }),
  claimedAt: customTimestamptz("claimed_at", { precision: 3 }),
  startedAt: customTimestamptz("started_at", { precision: 3 }),
  finishedAt: customTimestamptz("finished_at", { precision: 3 }),
  expiresAt: customTimestamptz("expires_at", { precision: 3 }),
  downloadUrl: text("download_url"),
  fileSize: bigint("file_size", { mode: 'number' }),
  rowCount: bigint("row_count", { mode: 'number' }),
  createdAt: customTimestamptz("created_at", { precision: 3 }).notNull().default(sql`CURRENT_TIMESTAMP`),
  updatedAt: customTimestamptz("updated_at", { precision: 3 }).notNull().default(sql`CURRENT_TIMESTAMP`),
}, (table) => [
  index("idx_workbench_export_tasks_status_retry").on(table.status, table.nextRetryAt),
  index("idx_workbench_export_tasks_org_owner").on(table.organizationId, table.ownerUserId),
  index("idx_workbench_export_tasks_idem").on(table.idempotencyKey),
  // SQL-009（standalone_057）：task_id / idempotency_key 单列唯一 →
  // (organization_id, task_id) / (organization_id, idempotency_key)（部分唯一，
  // idempotency_key IS NOT NULL）；跨租户可复用同 task_id / idempotency_key。
  uniqueIndex("uq_workbench_export_tasks_org_task").on(table.organizationId, table.taskId),
  uniqueIndex("uq_workbench_export_tasks_org_idem").on(table.organizationId, table.idempotencyKey).where(sql`${table.idempotencyKey} IS NOT NULL`),
]);

// --- Scheduling V2 domain tables (standalone_006) ---

export const ewohSchedulingRun = pgTable("ewoh_scheduling_run", {
  id: uuid("id").primaryKey().defaultRandom(),
  runId: varchar("run_id", { length: 255 }).notNull(),
  triggerType: varchar("trigger_type", { length: 100 }),
  triggerEntityId: varchar("trigger_entity_id", { length: 255 }),
  status: varchar("status", { length: 50 }).notNull().default('queued'),
  snapshotVersion: varchar("snapshot_version", { length: 255 }),
  /**
   * @type { string[] }
   */
  planIds: jsonb("plan_ids"),
  error: text("error"),
  /** 失败原因（替代仅日志，供审计追溯；standalone_012_domain_columns）。 */
  failureReason: text("failure_reason"),
  // --- Solver 激活阶梯持久化（standalone_030_solver_activation，Task A / P0） ---
  /** 运行所用求解器状态（随方案求解写入；succeeded 后回填）。 */
  solverStatus: varchar("solver_status", { length: 32 }),
  /** 运行所用求解器回退/降级原因（无回退为 NULL）。 */
  fallbackReason: text("fallback_reason"),
  /** 租户归属（standalone_057 起 NOT NULL，存量 NULL 行已回填默认 org；RLS org 隔离）。 */
  orgId: varchar("org_id", { length: 255 }).notNull(),
  createdAt: customTimestamptz("_created_at", { precision: 3 }).notNull().default(sql`CURRENT_TIMESTAMP`),
  updatedAt: customTimestamptz("_updated_at", { precision: 3 }).notNull().default(sql`CURRENT_TIMESTAMP`),
}, (table) => [
  // NEST/SQL-013（standalone_057）：run_id 单列唯一 → (org_id, run_id) 复合唯一。
  uniqueIndex("uq_ewoh_scheduling_run_org_run_id").on(table.orgId, table.runId),
  index("idx_ewoh_scheduling_run_status").on(table.status),
  index("idx_ewoh_scheduling_run_trigger").on(table.triggerType, table.triggerEntityId),
  index("idx_ewoh_scheduling_run_org_status").on(table.orgId, table.status),
]);

export const ewohSchedulingPlanAssignment = pgTable("ewoh_scheduling_plan_assignment", {
  id: uuid("id").primaryKey().defaultRandom(),
  assignmentId: varchar("assignment_id", { length: 255 }).notNull(),
  planId: varchar("plan_id", { length: 255 }).notNull(),
  taskId: varchar("task_id", { length: 255 }),
  personId: varchar("person_id", { length: 255 }),
  deviceId: varchar("device_id", { length: 255 }),
  stationId: varchar("station_id", { length: 255 }),
  zoneId: varchar("zone_id", { length: 255 }),
  plannedStart: customTimestamptz("planned_start", { precision: 3 }),
  plannedEnd: customTimestamptz("planned_end", { precision: 3 }),
  routeId: varchar("route_id", { length: 255 }),
  status: varchar("status", { length: 50 }).notNull().default('proposed'),
  /**
   * @type { { reasons?: string[]; alternatives?: Array<Record<string, unknown>> } }
   */
  explanationJson: jsonb("explanation_json"),
  // --- Scheduling V2 assignment detail (standalone_007) ---
  /** 路线 ETA（秒），来自与地图一致的 route graph。 */
  etaSeconds: real("eta_seconds"),
  /** 路线距离（米）。 */
  distanceMeters: real("distance_meters"),
  /** 路线风险摘要。 */
  riskLevel: varchar("risk_level", { length: 50 }),
  /**
   * @type { Record<string, unknown> }
   */
  scoreBreakdownJson: jsonb("score_breakdown_json"),
  /**
   * 可解释决策轨迹（DecisionTrace）：选中依据、候选与排除原因、策略/求解器/快照版本。
   * @type { import('@shared/api.interface').DecisionTrace | null }
   */
  decisionTraceJson: jsonb("decision_trace_json"),
  version: integer("version").notNull().default(1),
  reason: text("reason"),
  /** 租户归属（standalone_057 起 NOT NULL，存量 NULL 行已回填默认 org；RLS org 隔离）。 */
  orgId: varchar("org_id", { length: 255 }).notNull(),
  createdBy: varchar("created_by", { length: 255 }),
  createdAt: customTimestamptz("_created_at", { precision: 3 }).notNull().default(sql`CURRENT_TIMESTAMP`),
  updatedAt: customTimestamptz("_updated_at", { precision: 3 }).notNull().default(sql`CURRENT_TIMESTAMP`),
}, (table) => [
  // NEST/SQL-014（standalone_057）：assignment_id 单列唯一 → (org_id, assignment_id)。
  uniqueIndex("uq_ewoh_scheduling_plan_assignment_org_assignment").on(table.orgId, table.assignmentId),
  index("idx_ewoh_scheduling_plan_assignment_plan").on(table.planId),
  index("idx_ewoh_scheduling_plan_assignment_task").on(table.taskId),
  index("idx_ewoh_scheduling_plan_assignment_person").on(table.personId),
  index("idx_ewoh_scheduling_plan_assignment_device").on(table.deviceId),
  index("idx_ewoh_scheduling_plan_assignment_status").on(table.status),
]);

export const ewohSchedulingConstraint = pgTable("ewoh_scheduling_constraint", {
  id: uuid("id").primaryKey().defaultRandom(),
  constraintId: varchar("constraint_id", { length: 255 }).notNull(),
  planId: varchar("plan_id", { length: 255 }),
  taskId: varchar("task_id", { length: 255 }),
  type: varchar("type", { length: 50 }).notNull(),
  /**
   * @type { Record<string, unknown> }
   */
  valueJson: jsonb("value_json"),
  active: boolean("active").notNull().default(true),
  createdBy: varchar("created_by", { length: 255 }),
  createdAt: customTimestamptz("_created_at", { precision: 3 }).notNull().default(sql`CURRENT_TIMESTAMP`),
  updatedAt: customTimestamptz("_updated_at", { precision: 3 }).notNull().default(sql`CURRENT_TIMESTAMP`),
  // --- Command Map 增量 (standalone_023, Phase 0 / P0-2) ---
  /** 约束生效起始（epoch ms；null=立即生效）。 */
  validFromMs: bigint("valid_from_ms", { mode: "number" }),
  /** 约束失效时间（epoch ms；求解前过滤依据）。 */
  expiresAtMs: bigint("expires_at_ms", { mode: "number" }),
  /** 租户归属（standalone_057 起 NOT NULL，存量 NULL 行已回填默认 org；RLS org 隔离）。 */
  orgId: varchar("org_id", { length: 255 }).notNull(),
  /** 约束来源：manual / system / auto（审计区分 operator/system context）。 */
  source: varchar("source", { length: 20 }).notNull().default("manual"),
  /** 软删除时间（显式 deactivate 时写）。 */
  deactivatedAt: customTimestamptz("deactivated_at", { precision: 6 }),
  /** 软删除操作人。 */
  deactivatedBy: varchar("deactivated_by", { length: 255 }),
}, (table) => [
  // NEST/SQL-015（standalone_057）：constraint_id 单列唯一 → (org_id, constraint_id)。
  uniqueIndex("uq_ewoh_scheduling_constraint_org_constraint").on(table.orgId, table.constraintId),
  index("idx_ewoh_scheduling_constraint_plan").on(table.planId),
  index("idx_ewoh_scheduling_constraint_task").on(table.taskId),
  index("idx_ewoh_scheduling_constraint_type").on(table.type),
  index("idx_constraint_org_active").on(table.orgId, table.active),
  index("idx_constraint_expiry").on(table.expiresAtMs),
]);

export const ewohWorldStateSnapshot = pgTable("ewoh_world_state_snapshot", {
  id: uuid("id").primaryKey().defaultRandom(),
  snapshotVersion: varchar("snapshot_version", { length: 255 }).notNull().unique(),
  snapshotJson: jsonb("snapshot_json").notNull(),
  /** 租户血缘（standalone_057 补列，GLOBAL_SHARED：仅记录不隔离）。 */
  orgId: varchar("org_id", { length: 255 }),
  createdAt: customTimestamptz("created_at", { precision: 3 }),
  updatedAt: customTimestamptz("_updated_at", { precision: 3 }).notNull().default(sql`CURRENT_TIMESTAMP`),
}, (table) => [
  uniqueIndex("ewoh_world_state_snapshot_snapshot_version_key").on(table.snapshotVersion),
  index("idx_ewoh_world_state_snapshot_org").on(table.orgId),
]);

// --- 世界状态游标 / 增量日志 / 快照版本计数器 ---
// 物理列与 db/migrations/standalone_001_schema.sql（ewoh_world_snapshot / ewoh_world_delta_log）
// 及 db/migrations/standalone_031_snapshot_version_counter.sql（ewoh_snapshot_version_counter）对齐。

export const ewohWorldSnapshotCursor = pgTable("ewoh_world_snapshot", {
  id: uuid("id").primaryKey().defaultRandom(),
  orgId: uuid("org_id").default(sql`nullif(current_setting('app.current_org_id', true), '')::uuid`),
  snapshotVersion: bigint("snapshot_version", { mode: "number" }).notNull(),
  snapshotType: varchar("snapshot_type", { length: 50 }).notNull().default("full"),
  payload: jsonb("payload").notNull(),
  entityCount: integer("entity_count").notNull().default(0),
  checksum: varchar("checksum", { length: 128 }),
  sourceType: varchar("source_type", { length: 50 }).notNull().default("simulated"),
  snapshotCreatedAt: customTimestamptz("created_at", { precision: 6 }).notNull().default(sql`CURRENT_TIMESTAMP`),
  createdAt: customTimestamptz("_created_at", { precision: 6 }).notNull().default(sql`CURRENT_TIMESTAMP`),
  updatedAt: customTimestamptz("_updated_at", { precision: 6 }).notNull().default(sql`CURRENT_TIMESTAMP`),
  createdBy: uuid("_created_by"),
  updatedBy: uuid("_updated_by"),
}, (table) => [
  index("idx_ewoh_world_snapshot_org").on(table.orgId),
  uniqueIndex("uq_ewoh_world_snapshot_org_version").on(
    sql`coalesce(${table.orgId}, '00000000-0000-4000-8000-000000000000'::uuid)`,
    table.snapshotVersion,
  ),
]);

export const ewohWorldDeltaLog = pgTable("ewoh_world_delta_log", {
  id: uuid("id").primaryKey().defaultRandom(),
  orgId: uuid("org_id").default(sql`nullif(current_setting('app.current_org_id', true), '')::uuid`),
  seq: bigint("seq", { mode: "number" }).generatedAlwaysAsIdentity().unique().notNull(),
  snapshotVersion: bigint("snapshot_version", { mode: "number" }).notNull(),
  entityType: varchar("entity_type", { length: 100 }).notNull(),
  entityId: varchar("entity_id", { length: 255 }).notNull(),
  deltaType: varchar("delta_type", { length: 50 }).notNull(),
  payload: jsonb("payload"),
  beforeJson: jsonb("before_json"),
  occurredAt: customTimestamptz("occurred_at", { precision: 6 }).notNull().default(sql`CURRENT_TIMESTAMP`),
  sourceType: varchar("source_type", { length: 50 }).notNull().default("simulated"),
  createdAt: customTimestamptz("_created_at", { precision: 6 }).notNull().default(sql`CURRENT_TIMESTAMP`),
  updatedAt: customTimestamptz("_updated_at", { precision: 6 }).notNull().default(sql`CURRENT_TIMESTAMP`),
  createdBy: uuid("_created_by"),
  updatedBy: uuid("_updated_by"),
}, (table) => [
  index("idx_ewoh_world_delta_org_seq").on(table.orgId, table.seq),
  index("idx_ewoh_world_delta_version_seq").on(table.snapshotVersion, table.seq),
]);

export const ewohSnapshotVersionCounter = pgTable("ewoh_snapshot_version_counter", {
  day: varchar("day", { length: 8 }).primaryKey(),
  lastSeq: integer("last_seq").notNull().default(0),
  createdAt: customTimestamptz("created_at", { precision: 6 }).notNull().default(sql`now()`),
  updatedAt: customTimestamptz("_updated_at", { precision: 6 }).notNull().default(sql`now()`),
});

// --- Canonical Industrial Identity（ADR-006 / NO-02b，standalone_032_identity_mapping）---
// 手工对齐 db/migrations/standalone_032_identity_mapping.sql（与 031 同纪律：
// gen:db-schema 再生成前保持同步）。TENANT_SCOPED：RLS 策略
// identity_mapping_org_isolation 在 DB 层强制（org_id 与 app.current_org_id 比较）。

export const ewohIdentityMapping = pgTable("ewoh_identity_mapping", {
  id: uuid("id").primaryKey().defaultRandom(),
  orgId: varchar("org_id", { length: 255 }).notNull(),
  mappingId: varchar("mapping_id", { length: 180 }).notNull(),
  version: integer("version").notNull().default(1),
  sourceSystem: varchar("source_system", { length: 64 }).notNull(),
  sourceId: varchar("source_id", { length: 255 }).notNull(),
  sourceIdKind: varchar("source_id_kind", { length: 64 }),
  targetEntityId: varchar("target_entity_id", { length: 180 }).notNull(),
  targetKind: varchar("target_kind", { length: 32 }).notNull(),
  authority: varchar("authority", { length: 20 }).notNull().default("registration"),
  status: varchar("status", { length: 20 }).notNull().default("active"),
  recordedAt: customTimestamptz("recorded_at", { precision: 6 }).notNull().default(sql`now()`),
  validFrom: customTimestamptz("valid_from", { precision: 6 }),
  validTo: customTimestamptz("valid_to", { precision: 6 }),
  evidenceId: varchar("evidence_id", { length: 255 }),
  createdAt: customTimestamptz("_created_at", { precision: 6 }).notNull().default(sql`CURRENT_TIMESTAMP`),
  updatedAt: customTimestamptz("_updated_at", { precision: 6 }).notNull().default(sql`CURRENT_TIMESTAMP`),
  createdBy: uuid("_created_by"),
  updatedBy: uuid("_updated_by"),
}, (table) => [
  uniqueIndex("uq_ewoh_identity_mapping_source").on(table.orgId, table.sourceSystem, table.sourceId),
  uniqueIndex("uq_ewoh_identity_mapping_id").on(table.orgId, table.mappingId),
  index("idx_ewoh_identity_mapping_target").on(table.targetEntityId),
  index("idx_ewoh_identity_mapping_status").on(table.orgId, table.status),
]);

// --- Maintenance / Quality 领域 (standalone_034, ADR-010 / NO-05b) ---
// 手工对齐 db/migrations/standalone_034_maintenance_quality.sql（与 031/032 同纪律）。
// TENANT_SCOPED：RLS 策略在 DB 层强制（org_id 与 app.current_org_id 比较）。

export const ewohMaintenanceCondition = pgTable("ewoh_maintenance_condition", {
  id: uuid("id").primaryKey().defaultRandom(),
  orgId: varchar("org_id", { length: 255 }).notNull(),
  conditionId: varchar("condition_id", { length: 180 }).notNull(),
  subjectEntityId: varchar("subject_entity_id", { length: 180 }).notNull(),
  subjectKind: varchar("subject_kind", { length: 32 }).notNull(),
  conditionType: varchar("condition_type", { length: 32 }).notNull(),
  severity: varchar("severity", { length: 16 }).notNull(),
  status: varchar("status", { length: 32 }).notNull().default("detected"),
  dueAt: customTimestamptz("due_at", { precision: 6 }),
  detectedAt: customTimestamptz("detected_at", { precision: 6 }).notNull().default(sql`now()`),
  resolvedAt: customTimestamptz("resolved_at", { precision: 6 }),
  workOrderRef: varchar("work_order_ref", { length: 255 }),
  evidenceId: varchar("evidence_id", { length: 255 }),
  createdAt: customTimestamptz("_created_at", { precision: 6 }).notNull().default(sql`CURRENT_TIMESTAMP`),
  updatedAt: customTimestamptz("_updated_at", { precision: 6 }).notNull().default(sql`CURRENT_TIMESTAMP`),
  createdBy: uuid("_created_by"),
  updatedBy: uuid("_updated_by"),
}, (table) => [
  uniqueIndex("uq_ewoh_mc_org_id").on(table.orgId, table.conditionId),
  index("idx_ewoh_mc_subject").on(table.subjectEntityId),
  index("idx_ewoh_mc_status").on(table.orgId, table.status),
  index("idx_ewoh_mc_due").on(table.orgId, table.dueAt),
]);

export const ewohQualityFinding = pgTable("ewoh_quality_finding", {
  id: uuid("id").primaryKey().defaultRandom(),
  orgId: varchar("org_id", { length: 255 }).notNull(),
  findingId: varchar("finding_id", { length: 180 }).notNull(),
  findingType: varchar("finding_type", { length: 32 }).notNull(),
  severity: varchar("severity", { length: 16 }).notNull(),
  status: varchar("status", { length: 32 }).notNull().default("open"),
  disposition: varchar("disposition", { length: 16 }),
  links: jsonb("links").notNull().default([]),
  detectedAt: customTimestamptz("detected_at", { precision: 6 }).notNull().default(sql`now()`),
  dispositionedAt: customTimestamptz("dispositioned_at", { precision: 6 }),
  evidenceId: varchar("evidence_id", { length: 255 }),
  createdAt: customTimestamptz("_created_at", { precision: 6 }).notNull().default(sql`CURRENT_TIMESTAMP`),
  updatedAt: customTimestamptz("_updated_at", { precision: 6 }).notNull().default(sql`CURRENT_TIMESTAMP`),
  createdBy: uuid("_created_by"),
  updatedBy: uuid("_updated_by"),
}, (table) => [
  uniqueIndex("uq_ewoh_qf_org_id").on(table.orgId, table.findingId),
  index("idx_ewoh_qf_status").on(table.orgId, table.status),
]);

// --- Work Order 领域 (standalone_035, ADR-012 / NO-05e-b) ---
// 手工对齐 db/migrations/standalone_035_work_order.sql（与 031/032/034 同纪律）。
// TENANT_SCOPED：RLS work_order_org_isolation 在 DB 层强制（org_id 与
// app.current_org_id 比较）。

export const ewohWorkOrder = pgTable("ewoh_work_order", {
  id: uuid("id").primaryKey().defaultRandom(),
  orgId: varchar("org_id", { length: 255 }).notNull(),
  workOrderId: varchar("work_order_id", { length: 180 }).notNull(),
  workOrderType: varchar("work_order_type", { length: 32 }).notNull(),
  originKind: varchar("origin_kind", { length: 32 }).notNull(),
  originId: varchar("origin_id", { length: 180 }).notNull(),
  subjectEntityId: varchar("subject_entity_id", { length: 180 }).notNull(),
  subjectKind: varchar("subject_kind", { length: 32 }).notNull(),
  severity: varchar("severity", { length: 16 }).notNull(),
  status: varchar("status", { length: 32 }).notNull().default("created"),
  scheduledFor: customTimestamptz("scheduled_for", { precision: 6 }),
  completedAt: customTimestamptz("completed_at", { precision: 6 }),
  cancelledReason: varchar("cancelled_reason", { length: 255 }),
  externalRef: varchar("external_ref", { length: 255 }),
  evidenceId: varchar("evidence_id", { length: 255 }),
  createdAt: customTimestamptz("_created_at", { precision: 6 }).notNull().default(sql`CURRENT_TIMESTAMP`),
  updatedAt: customTimestamptz("_updated_at", { precision: 6 }).notNull().default(sql`CURRENT_TIMESTAMP`),
  createdBy: uuid("_created_by"),
  updatedBy: uuid("_updated_by"),
}, (table) => [
  uniqueIndex("uq_ewoh_wo_org_id").on(table.orgId, table.workOrderId),
  index("idx_ewoh_wo_subject").on(table.subjectEntityId),
  index("idx_ewoh_wo_status").on(table.orgId, table.status),
  index("idx_ewoh_wo_origin").on(table.orgId, table.originKind, table.originId),
]);

// --- Edge→Cloud 事件上行传输级幂等去重台账 (standalone_036, ADR-009 / NO-04b) ---
// 去重键 (org_id, source, event_id)：同租户同来源同事件 ID 只落一次；
// is_late/clock_drift 时间语义随台账落库（ADR-009 全链路可审计）。

export const ewohIngestEventDedup = pgTable("ewoh_ingest_event_dedup", {
  id: uuid("id").primaryKey().defaultRandom(),
  orgId: varchar("org_id", { length: 255 }).notNull(),
  source: varchar("source", { length: 255 }).notNull(),
  eventId: varchar("event_id", { length: 255 }).notNull(),
  eventType: varchar("event_type", { length: 128 }),
  occurredAt: customTimestamptz("occurred_at", { precision: 6 }),
  receivedAt: customTimestamptz("received_at", { precision: 6 }).notNull().default(sql`CURRENT_TIMESTAMP`),
  isLate: boolean("is_late").notNull().default(false),
  clockDrift: boolean("clock_drift").notNull().default(false),
  createdAt: customTimestamptz("_created_at", { precision: 6 }).notNull().default(sql`CURRENT_TIMESTAMP`),
  updatedAt: customTimestamptz("_updated_at", { precision: 6 }).notNull().default(sql`CURRENT_TIMESTAMP`),
}, (table) => [
  uniqueIndex("uq_ewoh_ingest_event_dedup").on(table.orgId, table.source, table.eventId),
  index("idx_ewoh_ingest_event_dedup_org_time").on(table.orgId, table.receivedAt),
]);

// --- Agent Manifest 注册表 (standalone_037, ADR-016 / NO-06b) ---
// 注册唯一入口：validateAgentManifest 契约校验 fail-closed 后落库；
// manifestJson 为完整清单快照（审计）；L4 自治等级由 DB CHECK 兜底排除（§2）。

export const ewohAgentManifest = pgTable("ewoh_agent_manifest", {
  id: uuid("id").primaryKey().defaultRandom(),
  orgId: varchar("org_id", { length: 255 }).notNull(),
  agentId: varchar("agent_id", { length: 180 }).notNull(),
  name: varchar("name", { length: 255 }).notNull(),
  version: integer("version").notNull().default(1),
  role: varchar("role", { length: 64 }).notNull(),
  purpose: text("purpose").notNull(),
  allowedTools: jsonb("allowed_tools").notNull(),
  readScope: jsonb("read_scope").notNull(),
  writeScope: jsonb("write_scope").notNull(),
  autonomousLevel: varchar("autonomous_level", { length: 8 }).notNull(),
  riskLevel: varchar("risk_level", { length: 16 }).notNull(),
  status: varchar("status", { length: 20 }).notNull().default('registered'),
  manifestJson: jsonb("manifest_json").notNull(),
  createdAt: customTimestamptz("_created_at", { precision: 6 }).notNull().default(sql`CURRENT_TIMESTAMP`),
  updatedAt: customTimestamptz("_updated_at", { precision: 6 }).notNull().default(sql`CURRENT_TIMESTAMP`),
  createdBy: uuid("_created_by"),
  updatedBy: uuid("_updated_by"),
}, (table) => [
  uniqueIndex("uq_ewoh_agent_manifest").on(table.orgId, table.agentId),
  index("idx_ewoh_agent_manifest_role").on(table.orgId, table.role),
  index("idx_ewoh_agent_manifest_status").on(table.orgId, table.status),
]);

// --- AgentTask 编排注册表 (standalone_038, ADR-017 / NO-06f) ---
// 创建唯一入口：validateAgentTask 契约校验 fail-closed 后落库；
// 状态推进唯一写者 = AgentOrchestratorService（状态机 + CAS），DB CHECK 守护枚举。

export const ewohAgentTask = pgTable("ewoh_agent_task", {
  id: uuid("id").primaryKey().defaultRandom(),
  orgId: varchar("org_id", { length: 255 }).notNull(),
  taskId: varchar("task_id", { length: 180 }).notNull(),
  name: varchar("name", { length: 255 }).notNull(),
  version: integer("version").notNull().default(1),
  kind: varchar("kind", { length: 24 }).notNull(),
  assignedRole: varchar("assigned_role", { length: 64 }).notNull(),
  assigneeAgentId: varchar("assignee_agent_id", { length: 180 }),
  dependencies: jsonb("dependencies").notNull(),
  priority: varchar("priority", { length: 16 }).notNull(),
  status: varchar("status", { length: 24 }).notNull().default('created'),
  dueTime: customTimestamptz("due_time", { precision: 6 }),
  budget: jsonb("budget").notNull(),
  correlationId: varchar("correlation_id", { length: 255 }),
  inputContract: jsonb("input_contract"),
  outputContract: jsonb("output_contract"),
  taskJson: jsonb("task_json").notNull(),
  createdAt: customTimestamptz("_created_at", { precision: 6 }).notNull().default(sql`CURRENT_TIMESTAMP`),
  updatedAt: customTimestamptz("_updated_at", { precision: 6 }).notNull().default(sql`CURRENT_TIMESTAMP`),
  createdBy: uuid("_created_by"),
  updatedBy: uuid("_updated_by"),
}, (table) => [
  uniqueIndex("uq_ewoh_agent_task").on(table.orgId, table.taskId),
  index("idx_ewoh_agent_task_role_status").on(table.orgId, table.assignedRole, table.status),
  index("idx_ewoh_agent_task_due").on(table.orgId, table.dueTime),
]);

// --- Knowledge Entry 运行时硬化 (standalone_039, ADR-018 Amendment 1 / NO-07b) ---
// 五层 scope：global/industry = 共享层（哨兵 org 00000000-0000-4000-8000-000000000000）；
// customer/factory/private_operational = 租户层（真实 org）。
// RLS knowledge_entry_service_all 强制租户行隔离 + 共享行全租户可读；
// 契约校验（validateKnowledgeEntry）为写入唯一入口；创建幂等（org_id, entry_id）。

export const ewohKnowledgeEntry = pgTable("ewoh_knowledge_entry", {
  id: uuid("id").primaryKey().defaultRandom(),
  orgId: uuid("org_id").notNull(),
  entryId: varchar("entry_id", { length: 255 }).notNull(),
  baseId: varchar("base_id", { length: 255 }),
  title: varchar("title", { length: 255 }).notNull(),
  summary: text("summary").notNull(),
  body: text("body").notNull(),
  tags: jsonb("tags").notNull().default([]),
  sourceType: varchar("source_type", { length: 50 }).notNull().default('manual'),
  checksum: varchar("checksum", { length: 128 }),
  kind: varchar("kind", { length: 24 }).notNull().default('process_knowledge'),
  scope: varchar("scope", { length: 24 }).notNull().default('factory'),
  status: varchar("status", { length: 50 }).notNull().default('draft'),
  version: integer("version").notNull().default(1),
  sourceEvidenceIds: jsonb("source_evidence_ids").notNull().default([]),
  relatedEntityIds: jsonb("related_entity_ids").notNull().default([]),
  provenance: jsonb("provenance"),
  verifiedBy: varchar("verified_by", { length: 180 }),
  validFrom: customTimestamptz("valid_from", { precision: 6 }).notNull().default(sql`now()`),
  validTo: customTimestamptz("valid_to", { precision: 6 }),
  auditTrail: boolean("audit_trail").notNull().default(true),
  legacyWithoutEvidence: boolean("legacy_without_evidence").notNull().default(false),
  deletedAt: customTimestamptz("deleted_at", { precision: 6 }),
  createdAt: customTimestamptz("_created_at", { precision: 6 }).notNull().default(sql`CURRENT_TIMESTAMP`),
  updatedAt: customTimestamptz("_updated_at", { precision: 6 }).notNull().default(sql`CURRENT_TIMESTAMP`),
  createdBy: uuid("_created_by"),
  updatedBy: uuid("_updated_by"),
}, (table) => [
  uniqueIndex("uq_ewoh_knowledge_entry").on(table.orgId, table.entryId),
  index("idx_ewoh_knowledge_entry_scope_org").on(table.scope, table.orgId),
  index("idx_ewoh_knowledge_entry_kind").on(table.orgId, table.kind, table.status),
]);

// --- 云侧推理结果台账 (standalone_040, ADR-019 / NO-08a) ---
// Canonical InferenceResult（ADR-013）审计台账：写入唯一入口
// InferenceResultService.recordInferenceResult（契约校验 fail-closed）；
// 唯一 (org_id, inference_id) 幂等重放；TENANT_SCOPED RLS。

export const ewohInferenceResult = pgTable("ewoh_inference_result", {
  id: uuid("id").primaryKey().defaultRandom(),
  orgId: varchar("org_id", { length: 255 }).notNull(),
  inferenceId: varchar("inference_id", { length: 180 }).notNull(),
  subjectId: varchar("subject_id", { length: 180 }).notNull(),
  level: varchar("level", { length: 32 }).notNull(),
  modelId: varchar("model_id", { length: 180 }).notNull(),
  modelVersion: varchar("model_version", { length: 64 }).notNull(),
  inputVersion: varchar("input_version", { length: 64 }).notNull(),
  label: varchar("label", { length: 255 }).notNull(),
  confidence: doublePrecision("confidence").notNull(),
  oodFlag: boolean("ood_flag").notNull().default(false),
  oodReasons: jsonb("ood_reasons").notNull().default([]),
  dataQuality: varchar("data_quality", { length: 16 }).notNull(),
  evidenceTsStart: customTimestamptz("evidence_ts_start", { precision: 6 }).notNull(),
  evidenceTsEnd: customTimestamptz("evidence_ts_end", { precision: 6 }).notNull(),
  evidenceIsRule: boolean("evidence_is_rule").notNull(),
  resultJson: jsonb("result_json").notNull(),
  createdAt: customTimestamptz("_created_at", { precision: 6 }).notNull().default(sql`CURRENT_TIMESTAMP`),
  updatedAt: customTimestamptz("_updated_at", { precision: 6 }).notNull().default(sql`CURRENT_TIMESTAMP`),
  createdBy: uuid("_created_by"),
  updatedBy: uuid("_updated_by"),
}, (table) => [
  uniqueIndex("uq_ewoh_inference_result").on(table.orgId, table.inferenceId),
  index("idx_ewoh_inference_result_level").on(table.orgId, table.level),
  index("idx_ewoh_inference_result_subject").on(table.orgId, table.subjectId),
  index("idx_ewoh_inference_result_window").on(table.orgId, table.evidenceTsStart, table.evidenceTsEnd),
]);

// --- 学习评估台账 (standalone_041, ADR-021 / NO-09a, Phase 12) ---
// 每 (org, 周期) 七项学习指标快照；写入唯一入口 LearningService.evaluate
// （契约校验 fail-closed）；evalId 确定性推导幂等重评估；TENANT_SCOPED RLS。
// 观测层：绝不自动回写生产规则（§2）。

export const ewohLearningEvaluation = pgTable("ewoh_learning_evaluation", {
  id: uuid("id").primaryKey().defaultRandom(),
  orgId: varchar("org_id", { length: 255 }).notNull(),
  evalId: varchar("eval_id", { length: 180 }).notNull(),
  evaluationType: varchar("evaluation_type", { length: 16 }).notNull(),
  periodStart: customTimestamptz("period_start", { precision: 6 }).notNull(),
  periodEnd: customTimestamptz("period_end", { precision: 6 }).notNull(),
  engineVersion: varchar("engine_version", { length: 32 }).notNull(),
  metricsJson: jsonb("metrics_json").notNull(),
  basisJson: jsonb("basis_json").notNull(),
  resultJson: jsonb("result_json").notNull(),
  createdAt: customTimestamptz("_created_at", { precision: 6 }).notNull().default(sql`CURRENT_TIMESTAMP`),
  updatedAt: customTimestamptz("_updated_at", { precision: 6 }).notNull().default(sql`CURRENT_TIMESTAMP`),
  createdBy: uuid("_created_by"),
  updatedBy: uuid("_updated_by"),
}, (table) => [
  uniqueIndex("uq_ewoh_learning_evaluation").on(table.orgId, table.evalId),
  index("idx_ewoh_learning_evaluation_period").on(table.orgId, table.periodStart, table.periodEnd),
]);

// --- 全链路 trace span 台账 (standalone_042, ADR-022 / NO-10a) ---
// HTTP traceId = §19 correlation id；追踪索引（TTL 由 service 层 bounded）；
// org_id lineage（可空）；可见性 = trace_span_org_or_global 策略。

export const ewohTraceSpan = pgTable("ewoh_trace_span", {
  id: uuid("id").primaryKey().defaultRandom(),
  traceId: varchar("trace_id", { length: 64 }).notNull(),
  spanId: varchar("span_id", { length: 64 }).notNull(),
  path: varchar("path", { length: 255 }).notNull(),
  method: varchar("method", { length: 16 }).notNull(),
  statusCode: integer("status_code").notNull(),
  durationMs: integer("duration_ms").notNull(),
  startedAt: customTimestamptz("started_at", { precision: 6 }).notNull(),
  finishedAt: customTimestamptz("finished_at", { precision: 6 }).notNull(),
  error: text("error"),
  orgId: varchar("org_id", { length: 255 }),
  requestUser: varchar("request_user", { length: 128 }),
  createdAt: customTimestamptz("_created_at", { precision: 6 }).notNull().default(sql`CURRENT_TIMESTAMP`),
  updatedAt: customTimestamptz("_updated_at", { precision: 6 }).notNull().default(sql`CURRENT_TIMESTAMP`),
}, (table) => [
  uniqueIndex("uq_ewoh_trace_span").on(table.traceId, table.spanId),
  index("idx_ewoh_trace_span_trace").on(table.traceId, table.startedAt),
]);

// --- Dead Letter 终态台账 (standalone_043, ADR-024 / NO-11a) ---
// 永久失败消息的失败证据 + 人审重放状态机；写入唯一入口
// DeadLetterService.record（契约校验 fail-closed）；TENANT_SCOPED RLS。

export const ewohDeadLetter = pgTable("ewoh_dead_letter", {
  id: uuid("id").primaryKey().defaultRandom(),
  orgId: varchar("org_id", { length: 255 }).notNull(),
  letterId: varchar("letter_id", { length: 180 }).notNull(),
  sourceId: varchar("source_id", { length: 128 }).notNull(),
  reason: varchar("reason", { length: 32 }).notNull(),
  attempts: integer("attempts").notNull(),
  status: varchar("status", { length: 16 }).notNull(),
  envelopeJson: jsonb("envelope_json").notNull(),
  correlationId: varchar("correlation_id", { length: 128 }),
  discardedReason: text("discarded_reason"),
  recordJson: jsonb("record_json").notNull(),
  createdAt: customTimestamptz("_created_at", { precision: 6 }).notNull().default(sql`CURRENT_TIMESTAMP`),
  updatedAt: customTimestamptz("_updated_at", { precision: 6 }).notNull().default(sql`CURRENT_TIMESTAMP`),
  createdBy: uuid("_created_by"),
  updatedBy: uuid("_updated_by"),
}, (table) => [
  uniqueIndex("uq_ewoh_dead_letter").on(table.orgId, table.letterId),
  index("idx_ewoh_dead_letter_status").on(table.orgId, table.status),
  index("idx_ewoh_dead_letter_source").on(table.orgId, table.sourceId),
]);

// --- Digital Twin 仿真运行台账 (standalone_044, ADR-025 / NO-12a) ---
// §13 三层强制：契约面 isSimulation=true + 表级 CHECK is_simulation=true +
// 服务层绝不写生产 World State 表；completed 必须 results、failed 必须理由。
// 写入唯一入口 SimulationService.run（契约校验 fail-closed）；TENANT_SCOPED RLS。

export const ewohSimulationRun = pgTable("ewoh_simulation_run", {
  id: uuid("id").primaryKey().defaultRandom(),
  orgId: varchar("org_id", { length: 255 }).notNull(),
  runId: varchar("run_id", { length: 180 }).notNull(),
  kind: varchar("kind", { length: 32 }).notNull(),
  status: varchar("status", { length: 16 }).notNull(),
  isSimulation: boolean("is_simulation").notNull().default(true),
  baseRefJson: jsonb("base_ref_json").notNull(),
  parametersJson: jsonb("parameters_json").notNull(),
  resultsJson: jsonb("results_json"),
  failureReason: text("failure_reason"),
  engineVersion: varchar("engine_version", { length: 32 }).notNull(),
  recordJson: jsonb("record_json").notNull(),
  createdAt: customTimestamptz("_created_at", { precision: 6 }).notNull().default(sql`CURRENT_TIMESTAMP`),
  updatedAt: customTimestamptz("_updated_at", { precision: 6 }).notNull().default(sql`CURRENT_TIMESTAMP`),
  createdBy: uuid("_created_by"),
  updatedBy: uuid("_updated_by"),
}, (table) => [
  uniqueIndex("uq_ewoh_simulation_run").on(table.orgId, table.runId),
  index("idx_ewoh_simulation_run_status").on(table.orgId, table.status),
  index("idx_ewoh_simulation_run_kind").on(table.orgId, table.kind),
]);

// --- 学习提案台账 (standalone_045, ADR-026 / NO-12b) ---
// 学习回路 v2 反馈腿：策略(规则阈值)更新提案。影子评估前置 +
// 人审激活阶梯（§2 绝不隐式自动执行）+ 回滚/拒绝理由强制（§33）。
// 写入唯一入口 LearningProposalService（契约校验 fail-closed）；TENANT_SCOPED RLS。

// --- 外骨骼会话台账 (standalone_046, ADR-032 / §7) ---
// §7：绑定是显式、临时且可审计的 Session；部分唯一索引机器强制
// 一台外骨骼同时一个 active 会话；ended/aborted 必须 actual_end_at。

export const ewohExoSession = pgTable("ewoh_exo_session", {
  id: uuid("id").primaryKey().defaultRandom(),
  orgId: varchar("org_id", { length: 255 }).notNull(),
  sessionId: varchar("session_id", { length: 255 }).notNull(),
  exoId: varchar("exo_id", { length: 255 }).notNull(),
  personId: varchar("person_id", { length: 255 }).notNull(),
  status: varchar("status", { length: 16 }).notNull(),
  startedAt: customTimestamptz("started_at", { precision: 3 }).notNull(),
  expectedEndAt: customTimestamptz("expected_end_at", { precision: 3 }),
  actualEndAt: customTimestamptz("actual_end_at", { precision: 3 }),
  endedBy: varchar("ended_by", { length: 255 }),
  reason: text("reason"),
  operatorId: varchar("operator_id", { length: 255 }),
  recordJson: jsonb("record_json").notNull(),
  createdAt: customTimestamptz("_created_at", { precision: 3 }).notNull().default(sql`CURRENT_TIMESTAMP`),
  updatedAt: customTimestamptz("_updated_at", { precision: 3 }).notNull().default(sql`CURRENT_TIMESTAMP`),
  createdBy: uuid("_created_by"),
  updatedBy: uuid("_updated_by"),
}, (table) => [
  uniqueIndex("uq_ewoh_exo_session").on(table.orgId, table.sessionId),
  uniqueIndex("uq_ewoh_exo_session_active_exo").on(table.orgId, table.exoId).where(sql`${table.status} = 'active'`),
  index("idx_ewoh_exo_session_status").on(table.orgId, table.status),
  index("idx_ewoh_exo_session_person").on(table.orgId, table.personId),
]);

// --- 外骨骼配置台账 (standalone_051, ADR-051/ADR-052 / §7) ---
// Support Mode / Assist Profile / Fit / Calibration 配置事实；
// kind/status 按 kind/support_mode/判定事实/时间 CHECK 在迁移层兜底，
// 服务层 validateExoConfig 契约门 fail-closed（§31 共享实现）。

export const ewohExoConfig = pgTable("ewoh_exo_config", {
  id: uuid("id").primaryKey().defaultRandom(),
  orgId: varchar("org_id", { length: 255 }).notNull(),
  configId: varchar("config_id", { length: 255 }).notNull(),
  kind: varchar("kind", { length: 32 }).notNull(),
  exoId: varchar("exo_id", { length: 255 }).notNull(),
  status: varchar("status", { length: 32 }).notNull(),
  supportMode: varchar("support_mode", { length: 32 }),
  vendorModeName: varchar("vendor_mode_name", { length: 255 }),
  parametersJson: jsonb("parameters_json"),
  effectiveFrom: customTimestamptz("effective_from", { precision: 3 }),
  effectiveTo: customTimestamptz("effective_to", { precision: 3 }),
  supersededBy: varchar("superseded_by", { length: 255 }),
  setBy: varchar("set_by", { length: 255 }),
  personId: varchar("person_id", { length: 255 }),
  fittedAt: customTimestamptz("fitted_at", { precision: 3 }),
  fitter: varchar("fitter", { length: 255 }),
  measuredValuesJson: jsonb("measured_values_json"),
  calibrationKind: varchar("calibration_kind", { length: 32 }),
  result: varchar("result", { length: 32 }),
  calibratedAt: customTimestamptz("calibrated_at", { precision: 3 }),
  calibratedBy: varchar("calibrated_by", { length: 255 }),
  nextDueAt: customTimestamptz("next_due_at", { precision: 3 }),
  recordJson: jsonb("record_json").notNull(),
  createdAt: customTimestamptz("_created_at", { precision: 3 }).notNull().default(sql`CURRENT_TIMESTAMP`),
  updatedAt: customTimestamptz("_updated_at", { precision: 3 }).notNull().default(sql`CURRENT_TIMESTAMP`),
  createdBy: uuid("_created_by"),
  updatedBy: uuid("_updated_by"),
}, (table) => [
  uniqueIndex("uq_ewoh_exo_config").on(table.orgId, table.configId),
  index("idx_ewoh_exo_config_exo").on(table.orgId, table.exoId, table.kind),
  index("idx_ewoh_exo_config_active_profile").on(table.orgId, table.exoId, table.supportMode)
    .where(sql`${table.kind} = 'assist_profile' AND ${table.status} = 'active'`),
]);

// --- 结果标注台账 (standalone_047, ADR-034 / §10 Level 7) ---
// Decision→Outcome 结构化事实（学习回路模型腿的真值来源前置）；
// judged_by 非空（判定事实完整）+ measured 度量快照可空（显式不携带）。

export const ewohOutcomeAnnotation = pgTable("ewoh_outcome_annotation", {
  id: uuid("id").primaryKey().defaultRandom(),
  orgId: varchar("org_id", { length: 255 }).notNull(),
  annotationId: varchar("annotation_id", { length: 255 }).notNull(),
  targetType: varchar("target_type", { length: 32 }).notNull(),
  targetId: varchar("target_id", { length: 255 }).notNull(),
  outcomeKind: varchar("outcome_kind", { length: 32 }).notNull(),
  judgedBy: varchar("judged_by", { length: 255 }).notNull(),
  judgedAt: customTimestamptz("judged_at", { precision: 3 }).notNull(),
  measuredJson: jsonb("measured_json"),
  comment: text("comment"),
  recordJson: jsonb("record_json").notNull(),
  createdAt: customTimestamptz("_created_at", { precision: 3 }).notNull().default(sql`CURRENT_TIMESTAMP`),
  updatedAt: customTimestamptz("_updated_at", { precision: 3 }).notNull().default(sql`CURRENT_TIMESTAMP`),
  createdBy: uuid("_created_by"),
  updatedBy: uuid("_updated_by"),
}, (table) => [
  uniqueIndex("uq_ewoh_outcome_annotation").on(table.orgId, table.annotationId),
  index("idx_ewoh_outcome_annotation_target").on(table.orgId, table.targetType, table.targetId),
  index("idx_ewoh_outcome_annotation_kind").on(table.orgId, table.outcomeKind),
]);

export const ewohLearningProposal = pgTable("ewoh_learning_proposal", {
  id: uuid("id").primaryKey().defaultRandom(),
  orgId: varchar("org_id", { length: 255 }).notNull(),
  proposalId: varchar("proposal_id", { length: 180 }).notNull(),
  kind: varchar("kind", { length: 32 }).notNull(),
  status: varchar("status", { length: 24 }).notNull(),
  ruleId: varchar("rule_id", { length: 64 }).notNull(),
  parameter: varchar("parameter", { length: 32 }).notNull(),
  baselineValue: doublePrecision("baseline_value").notNull(),
  candidateValue: doublePrecision("candidate_value").notNull(),
  shadowEvalJson: jsonb("shadow_eval_json"),
  approvedBy: varchar("approved_by", { length: 128 }),
  approvedAt: customTimestamptz("approved_at", { precision: 6 }),
  rejectedBy: varchar("rejected_by", { length: 128 }),
  rejectedReason: text("rejected_reason"),
  rolledBackBy: varchar("rolled_back_by", { length: 128 }),
  rolledBackReason: text("rolled_back_reason"),
  evaluationRefJson: jsonb("evaluation_ref_json"),
  recordJson: jsonb("record_json").notNull(),
  /**
   * NO-13n / ADR-063（standalone_053 原地加固）：learning_proposal_activation
   * 决策记录（ADR-047 契约形态 DecisionRecord，approve/reject/rollback 与状态
   * 终态同 UPDATE 原子写入；NULL=存量未投影行，additive）。
   * @type { Record<string, unknown> | null }
   */
  decisionJson: jsonb("decision_json"),
  createdAt: customTimestamptz("_created_at", { precision: 6 }).notNull().default(sql`CURRENT_TIMESTAMP`),
  updatedAt: customTimestamptz("_updated_at", { precision: 6 }).notNull().default(sql`CURRENT_TIMESTAMP`),
  createdBy: uuid("_created_by"),
  updatedBy: uuid("_updated_by"),
}, (table) => [
  uniqueIndex("uq_ewoh_learning_proposal").on(table.orgId, table.proposalId),
  index("idx_ewoh_learning_proposal_status").on(table.orgId, table.status),
  index("idx_ewoh_learning_proposal_rule").on(table.orgId, table.ruleId),
]);

// --- Conflict Lifecycle 持久化 (standalone_013, Phase 3 / P3-T1) ---

export const ewohSchedulingConflict = pgTable("ewoh_scheduling_conflict", {
  id: uuid("id").primaryKey().defaultRandom(),
  /** 内容种子哈希稳定 id（跨推导归并键）。 */
  conflictId: varchar("conflict_id", { length: 255 }).notNull(),
  type: varchar("type", { length: 50 }).notNull(),
  severity: varchar("severity", { length: 20 }).notNull(),
  scope: varchar("scope", { length: 20 }).notNull(),
  /** OPEN/ACKNOWLEDGED/RESOLVED/SUPPRESSED。 */
  status: varchar("status", { length: 20 }).notNull().default('OPEN'),
  /**
   * @type { string[] }
   */
  taskIds: jsonb("task_ids").notNull().default([]),
  /**
   * @type { string[] }
   */
  resourceIds: jsonb("resource_ids").notNull().default([]),
  resourceId: varchar("resource_id", { length: 255 }),
  resourceType: varchar("resource_type", { length: 50 }),
  planId: varchar("plan_id", { length: 255 }),
  snapshotVersion: varchar("snapshot_version", { length: 255 }),
  message: text("message").notNull(),
  resolution: varchar("resolution", { length: 255 }),
  /**
   * @type { Record<string, unknown> }
   */
  data: jsonb("data"),
  detectedAt: customTimestamptz("detected_at", { precision: 6 }).notNull().default(sql`CURRENT_TIMESTAMP`),
  acknowledgedBy: varchar("acknowledged_by", { length: 255 }),
  acknowledgedAt: customTimestamptz("acknowledged_at", { precision: 6 }),
  resolvedBy: varchar("resolved_by", { length: 255 }),
  resolvedAt: customTimestamptz("resolved_at", { precision: 6 }),
  suppressUntil: customTimestamptz("suppress_until", { precision: 6 }),
  /** 租户归属（standalone_057 起 NOT NULL，存量 NULL 行已回填默认 org；RLS org 隔离）。 */
  orgId: varchar("org_id", { length: 255 }).notNull(),
  createdAt: customTimestamptz("_created_at", { precision: 3 }).notNull().default(sql`CURRENT_TIMESTAMP`),
  updatedAt: customTimestamptz("_updated_at", { precision: 3 }).notNull().default(sql`CURRENT_TIMESTAMP`),
}, (table) => [
  // NEST/SQL-021（standalone_057）：conflict_id 单列唯一 → (org_id, conflict_id)。
  uniqueIndex("uq_ewoh_scheduling_conflict_org_conflict").on(table.orgId, table.conflictId),
  index("idx_ewoh_scheduling_conflict_status").on(table.status, table.detectedAt),
  index("idx_ewoh_scheduling_conflict_type").on(table.type),
  index("idx_ewoh_scheduling_conflict_org").on(table.orgId),
  index("idx_ewoh_scheduling_conflict_plan").on(table.planId),
]);

// --- RouteCostMatrix 落库缓存 (standalone_015, Phase 2 / P2-T1, 决策 D-D) ---
export const ewohRouteCostMatrix = pgTable("ewoh_route_cost_matrix", {
  id: uuid("id").primaryKey().defaultRandom(),
  matrixId: varchar("matrix_id", { length: 255 }).notNull(),
  taskId: varchar("task_id", { length: 255 }).notNull(),
  snapshotVersion: varchar("snapshot_version", { length: 255 }).notNull(),
  policyVersion: integer("policy_version"),
  solverVersion: varchar("solver_version", { length: 100 }),
  /**
   * 全键唯一索引维度（standalone_026）：路由图版本，与 travel-cost 逻辑缓存 key 对齐。
   * @type { string | null }
   */
  routeGraphVersion: varchar("route_graph_version", { length: 255 }),
  /**
   * 全键唯一索引维度（standalone_026）：候选集合确定性哈希，与逻辑缓存 key 对齐。
   * @type { string | null }
   */
  candidateSetHash: varchar("candidate_set_hash", { length: 64 }),
  /**
   * CandidateRouteCost[] jsonb 数组。
   * @type { Array<Record<string, unknown>> }
   */
  candidatesJson: jsonb("candidates_json").notNull().default([]),
  generatedAt: customTimestamptz("generated_at", { precision: 6 }).notNull().default(sql`CURRENT_TIMESTAMP`),
  /** 租户归属（standalone_057 起 NOT NULL，存量 NULL 行已回填默认 org；RLS org 隔离）。 */
  orgId: varchar("org_id", { length: 255 }).notNull(),
  createdAt: customTimestamptz("_created_at", { precision: 3 }).notNull().default(sql`CURRENT_TIMESTAMP`),
  updatedAt: customTimestamptz("_updated_at", { precision: 3 }).notNull().default(sql`CURRENT_TIMESTAMP`),
}, (table) => [
  // NEST/SQL-022（standalone_057）：matrix_id 单列唯一 → (org_id, matrix_id)。
  uniqueIndex("uq_ewoh_route_cost_matrix_org_matrix").on(table.orgId, table.matrixId),
  uniqueIndex("uq_ewoh_route_cost_matrix_task_snapshot").on(table.taskId, table.snapshotVersion),
  index("idx_ewoh_route_cost_matrix_task").on(table.taskId),
  index("idx_ewoh_route_cost_matrix_snapshot").on(table.snapshotVersion),
]);

export const ewohRouteNode = pgTable("ewoh_route_node", {
  id: uuid("id").primaryKey().defaultRandom(),
  nodeId: varchar("node_id", { length: 255 }).notNull(),
  nodeType: varchar("node_type", { length: 50 }),
  x: real("x"),
  y: real("y"),
  floor: varchar("floor", { length: 50 }),
  stationId: varchar("station_id", { length: 255 }),
  zoneId: varchar("zone_id", { length: 255 }),
  /** 租户归属（standalone_057 起 NOT NULL，存量 NULL 行已回填默认 org；RLS org 隔离）。 */
  orgId: varchar("org_id", { length: 255 }).notNull(),
  createdAt: customTimestamptz("_created_at", { precision: 3 }).notNull().default(sql`CURRENT_TIMESTAMP`),
  updatedAt: customTimestamptz("_updated_at", { precision: 3 }).notNull().default(sql`CURRENT_TIMESTAMP`),
}, (table) => [
  // NEST/SQL-017（standalone_057）：node_id 单列唯一 → (org_id, node_id) 复合唯一。
  uniqueIndex("uq_ewoh_route_node_org_node").on(table.orgId, table.nodeId),
  index("idx_ewoh_route_node_station").on(table.stationId),
  index("idx_ewoh_route_node_zone").on(table.zoneId),
  index("idx_ewoh_route_node_org").on(table.orgId),
]);

export const ewohRouteEdge = pgTable("ewoh_route_edge", {
  id: uuid("id").primaryKey().defaultRandom(),
  edgeId: varchar("edge_id", { length: 255 }).notNull(),
  fromNodeId: varchar("from_node_id", { length: 255 }),
  toNodeId: varchar("to_node_id", { length: 255 }),
  distanceMeters: real("distance_meters"),
  expectedTimeSeconds: real("expected_time_seconds"),
  direction: varchar("direction", { length: 20 }),
  capacity: integer("capacity"),
  riskLevel: varchar("risk_level", { length: 50 }),
  status: varchar("status", { length: 50 }).notNull().default('open'),
  /**
   * @type { string[] }
   */
  accessibleFor: jsonb("accessible_for"),
  /** 租户归属（standalone_057 起 NOT NULL，存量 NULL 行已回填默认 org；RLS org 隔离）。 */
  orgId: varchar("org_id", { length: 255 }).notNull(),
  createdAt: customTimestamptz("_created_at", { precision: 3 }).notNull().default(sql`CURRENT_TIMESTAMP`),
  updatedAt: customTimestamptz("_updated_at", { precision: 3 }).notNull().default(sql`CURRENT_TIMESTAMP`),
}, (table) => [
  // NEST/SQL-017（standalone_057）：edge_id 单列唯一 → (org_id, edge_id)。
  uniqueIndex("uq_ewoh_route_edge_org_edge").on(table.orgId, table.edgeId),
  index("idx_ewoh_route_edge_from").on(table.fromNodeId),
  index("idx_ewoh_route_edge_to").on(table.toNodeId),
  index("idx_ewoh_route_edge_status").on(table.status),
  index("idx_ewoh_route_edge_org").on(table.orgId),
]);

export const ewohAssignmentEvent = pgTable("ewoh_assignment_event", {
  id: uuid("id").primaryKey().defaultRandom(),
  eventId: varchar("event_id", { length: 255 }).notNull().unique(),
  assignmentId: varchar("assignment_id", { length: 255 }),
  taskId: varchar("task_id", { length: 255 }),
  personId: varchar("person_id", { length: 255 }),
  deviceId: varchar("device_id", { length: 255 }),
  fromStatus: varchar("from_status", { length: 50 }),
  toStatus: varchar("to_status", { length: 50 }),
  actor: varchar("actor", { length: 255 }),
  reason: text("reason"),
  /**
   * @type { Record<string, unknown> }
   */
  payloadJson: jsonb("payload_json"),
  /**
   * 租户归属（NEST-501 修复，2026-08-17，standalone_028 已加列）：列由派生
   * 触发器 trg_assignment_event_derive_org 从归属 assignment/plan 推导
   * （DERIVED_TENANT_OWNERSHIP，ADR-004——RLS 关闭的全局审计流，可空=归属
   * 不可解析时的诚实值）。
   */
  orgId: varchar("org_id", { length: 255 }),
  createdAt: customTimestamptz("created_at", { precision: 3 }),
  updatedAt: customTimestamptz("_updated_at", { precision: 3 }).notNull().default(sql`CURRENT_TIMESTAMP`),
}, (table) => [
  uniqueIndex("ewoh_assignment_event_event_id_key").on(table.eventId),
  index("idx_ewoh_assignment_event_assignment").on(table.assignmentId),
  index("idx_ewoh_assignment_event_task").on(table.taskId),
  index("idx_ewoh_assignment_event_org").on(table.orgId),
]);

/** 资源预占（ResourceReservation）：reserve/renew/release/expire，唯一约束防双重占用。 */
export const ewohResourceReservation = pgTable("ewoh_resource_reservation", {
  id: uuid("id").primaryKey().defaultRandom(),
  reservationId: varchar("reservation_id", { length: 255 }).notNull().unique(),
  resourceType: varchar("resource_type", { length: 50 }).notNull(),
  resourceId: varchar("resource_id", { length: 255 }).notNull(),
  assignmentId: varchar("assignment_id", { length: 255 }),
  planId: varchar("plan_id", { length: 255 }),
  taskId: varchar("task_id", { length: 255 }),
  startMs: bigint("start_ms", { mode: "number" }).notNull(),
  endMs: bigint("end_ms", { mode: "number" }).notNull(),
  status: varchar("status", { length: 50 }).notNull().default('reserved'),
  version: integer("version").notNull().default(1),
  /** 租户归属（standalone_057 起 NOT NULL，存量 NULL 行已回填默认 org；RLS org 隔离）。 */
  orgId: varchar("org_id", { length: 255 }).notNull(),
  createdBy: varchar("created_by", { length: 255 }),
  createdAt: customTimestamptz("created_at", { precision: 3 }).notNull().default(sql`CURRENT_TIMESTAMP`),
  updatedAt: customTimestamptz("_updated_at", { precision: 3 }).notNull().default(sql`CURRENT_TIMESTAMP`),
}, (table) => [
  uniqueIndex("ewoh_resource_reservation_reservation_id_key").on(table.reservationId),
  index("idx_ewoh_resource_reservation_resource").on(table.resourceType, table.resourceId),
  index("idx_ewoh_resource_reservation_plan").on(table.planId),
  index("idx_ewoh_resource_reservation_task").on(table.taskId),
  // NEST-521（2026-08-17，standalone_057 同步）：补 org 维度索引，与其他
  // 调度表 idx_xxx_org_* 口径一致（RLS org 过滤走索引）。
  index("idx_ewoh_resource_reservation_org").on(table.orgId),
]);

/** Outbox：可靠领域事件，先写 outbox 再发布，保证 dispatch 与事件一致。 */
export const ewohOutbox = pgTable("ewoh_outbox", {
  id: uuid("id").primaryKey().defaultRandom(),
  eventId: varchar("event_id", { length: 255 }).notNull().unique(),
  eventType: varchar("event_type", { length: 100 }).notNull(),
  entityId: varchar("entity_id", { length: 255 }).notNull(),
  entityType: varchar("entity_type", { length: 100 }),
  entityVersion: integer("entity_version"),
  // F2 修复：DB DEFAULT 与迁移 standalone_011_outbox_sequence.sql 对齐
  // （nextval('ewoh_outbox_sequence_seq')），避免 drizzle-kit push 把默认值改回 0
  // 破坏 sequence 原子生成。
  sequence: bigint("sequence", { mode: "number" }).notNull().default(sql`nextval('ewoh_outbox_sequence_seq')`),
  status: varchar("status", { length: 50 }).notNull().default('pending'),
  payloadJson: jsonb("payload_json"),
  orgId: varchar("org_id", { length: 255 }),
  /** 统一 Envelope 关联 ID（standalone_021_sse_envelope）：run/plan/execution 全链路。 */
  correlationId: varchar("correlation_id", { length: 255 }),
  createdAt: customTimestamptz("created_at", { precision: 3 }).notNull().default(sql`CURRENT_TIMESTAMP`),
  publishedAt: customTimestamptz("published_at", { precision: 3 }),
}, (table) => [
  uniqueIndex("ewoh_outbox_event_id_key").on(table.eventId),
  index("idx_ewoh_outbox_correlation").on(table.correlationId),
  index("idx_ewoh_outbox_status").on(table.status),
  index("idx_ewoh_outbox_entity").on(table.entityId),
]);

/** 版本化调度策略配置（SchedulingPolicyConfig），集中所有调度参数。 */
export const ewohSchedulingPolicy = pgTable("ewoh_scheduling_policy", {
  id: uuid("id").primaryKey().defaultRandom(),
  configVersion: integer("config_version").notNull(),
  configJson: jsonb("config_json").notNull(),
  /**
   * 完整 8 权重权威对象（standalone_014_policy_weights，Phase 2 / P2-T2；缺省用默认常量）。
   * @type { { lateness: number; travel: number; wait: number; workload: number; station: number; change: number; risk: number; energy: number } | null }
   */
  weightsJson: jsonb("weights_json"),
  active: boolean("active").notNull().default(true),
  /**
   * 策略状态机（standalone_020_policy_lifecycle）：DRAFT/SHADOW/ACTIVE/ARCHIVED。
   * 迁移语义：active=true → ACTIVE；active=false → ARCHIVED。新流程显式设置中间态。
   * @type { 'DRAFT' | 'SHADOW' | 'ACTIVE' | 'ARCHIVED' }
   */
  status: varchar("status", { length: 20 }).notNull().default('DRAFT'),
  /**
   * NO-13o / ADR-064（standalone_054 原地加固）：policy_activation 决策记录
   * （ADR-047 契约形态 DecisionRecord，active 翻转/直接保存激活与状态同写
   * 原子写入；NULL=存量未投影行，additive）。
   * @type { Record<string, unknown> | null }
   */
  decisionJson: jsonb("decision_json"),
  /** 租户归属（standalone_057 起 NOT NULL，存量 NULL 行已回填默认 org；RLS org 隔离）。 */
  orgId: varchar("org_id", { length: 255 }).notNull(),
  updatedBy: varchar("updated_by", { length: 255 }),
  createdAt: customTimestamptz("_created_at", { precision: 3 }).notNull().default(sql`CURRENT_TIMESTAMP`),
  updatedAt: customTimestamptz("_updated_at", { precision: 3 }).notNull().default(sql`CURRENT_TIMESTAMP`),
}, (table) => [
  index("idx_ewoh_scheduling_policy_org").on(table.orgId),
  index("idx_ewoh_scheduling_policy_active").on(table.active),
  index("idx_ewoh_scheduling_policy_status").on(table.status),
  // 同一 org 同一 ACTIVE 唯一（020 uq_ewoh_scheduling_policy_org_active）
  uniqueIndex("uq_ewoh_scheduling_policy_org_active").on(table.orgId, table.status)
    .where(sql`status = 'ACTIVE'`),
]);

/** 持久化重排触发（ReplanTrigger）：orgId+triggerType+entityId+eventVersion 幂等去重。 */
export const ewohReplanTrigger = pgTable("ewoh_replan_trigger", {
  id: uuid("id").primaryKey().defaultRandom(),
  triggerKey: varchar("trigger_key", { length: 512 }).notNull().unique(),
  orgId: varchar("org_id", { length: 255 }).notNull(),
  triggerType: varchar("trigger_type", { length: 100 }).notNull(),
  entityId: varchar("entity_id", { length: 255 }).notNull(),
  // C10（2026-08-19 审计）：int4 → bigint——手动触发用时间戳作 eventVersion，
  // 生产 DB 已热修 bigint，schema/迁移链原仍为 int4（新环境重建必失配）。
  eventVersion: bigint("event_version", { mode: "number" }).notNull().default(0),
  status: varchar("status", { length: 50 }).notNull().default('processed'),
  runId: varchar("run_id", { length: 255 }),
  createdAt: customTimestamptz("_created_at", { precision: 3 }).notNull().default(sql`CURRENT_TIMESTAMP`),
}, (table) => [
  uniqueIndex("ewoh_replan_trigger_trigger_key_key").on(table.triggerKey),
  index("idx_ewoh_replan_trigger_org_type").on(table.orgId, table.triggerType),
]);

/** 调度反馈（SchedulingFeedback，Task 7）：观测型 planned-vs-actual 执行数据，仅用于离线评估/参数对比/回归，不参与生产调度。 */
export const ewohSchedulingFeedback = pgTable("ewoh_scheduling_feedback", {
  id: uuid("id").primaryKey().defaultRandom(),
  feedbackId: varchar("feedback_id", { length: 255 }).notNull(),
  runId: varchar("run_id", { length: 255 }),
  planId: varchar("plan_id", { length: 255 }).notNull(),
  taskId: varchar("task_id", { length: 255 }),
  assignmentId: varchar("assignment_id", { length: 255 }),
  plannedStart: customTimestamptz("planned_start", { precision: 3 }),
  actualStart: customTimestamptz("actual_start", { precision: 3 }),
  plannedEnd: customTimestamptz("planned_end", { precision: 3 }),
  actualEnd: customTimestamptz("actual_end", { precision: 3 }),
  plannedTravel: real("planned_travel"),
  actualTravel: real("actual_travel"),
  plannedWait: real("planned_wait"),
  actualWait: real("actual_wait"),
  /**
   * @type { { personId?: string | null; deviceId?: string | null; stationId?: string | null } | null }
   */
  originalResourceJson: jsonb("original_resource_json"),
  /**
   * @type { { personId?: string | null; deviceId?: string | null; stationId?: string | null } | null }
   */
  actualResourceJson: jsonb("actual_resource_json"),
  replanCount: integer("replan_count").notNull().default(0),
  conflictCount: integer("conflict_count").notNull().default(0),
  overrideCount: integer("override_count").notNull().default(0),
  solverRuntime: real("solver_runtime"),
  solverFallback: boolean("solver_fallback").notNull().default(false),
  /** 审批结果：true=approved, false=rejected, null=未决。 */
  accepted: boolean("accepted"),
  ts: customTimestamptz("ts", { precision: 3 }).notNull().default(sql`CURRENT_TIMESTAMP`),
  /** 租户归属（standalone_057 起 NOT NULL，存量 NULL 行已回填默认 org；RLS org 隔离）。 */
  orgId: varchar("org_id", { length: 255 }).notNull(),
  createdAt: customTimestamptz("_created_at", { precision: 3 }).notNull().default(sql`CURRENT_TIMESTAMP`),
  updatedAt: customTimestamptz("_updated_at", { precision: 3 }).notNull().default(sql`CURRENT_TIMESTAMP`),
}, (table) => [
  // NEST/SQL-020（standalone_057）：feedback_id 单列唯一 → (org_id, feedback_id)。
  uniqueIndex("uq_ewoh_scheduling_feedback_org_feedback").on(table.orgId, table.feedbackId),
  index("idx_ewoh_scheduling_feedback_plan").on(table.planId),
  index("idx_ewoh_scheduling_feedback_assignment").on(table.assignmentId),
  index("idx_ewoh_scheduling_feedback_task").on(table.taskId),
  index("idx_ewoh_scheduling_feedback_ts").on(table.ts),
]);

export const predictionShadowObservation = pgTable("prediction_shadow_observation", {
  id: uuid("id").primaryKey().defaultRandom(),
  orgId: varchar("org_id", { length: 255 }),
  predictionType: varchar("prediction_type", { length: 100 }).notNull(),
  entityId: varchar("entity_id", { length: 255 }),
  taskId: varchar("task_id", { length: 255 }),
  correlationId: varchar("correlation_id", { length: 255 }),
  executionId: varchar("execution_id", { length: 255 }),
  prediction: doublePrecision("prediction").notNull(),
  baseline: doublePrecision("baseline"),
  actual: doublePrecision("actual"),
  confidence: doublePrecision("confidence"),
  modelVersion: varchar("model_version", { length: 100 }),
  policyVersion: integer("policy_version"),
  snapshotVersion: varchar("snapshot_version", { length: 100 }),
  createdAt: customTimestamptz("created_at", { precision: 3 }).notNull().default(sql`CURRENT_TIMESTAMP`),
  actualAt: customTimestamptz("actual_at", { precision: 3 }),
  absoluteError: doublePrecision("absolute_error"),
  relativeError: doublePrecision("relative_error"),
}, (table) => [
  index("idx_prediction_shadow_observation_org_created").on(table.orgId, table.createdAt),
  index("idx_prediction_shadow_observation_correlation").on(table.correlationId),
  index("idx_prediction_shadow_observation_task").on(table.taskId),
]);

// table aliases
export const ewohAiSuggestionTable = ewohAiSuggestion;
export const ewohDeviceTable = ewohDevice;
export const ewohDeviceBindingTable = ewohDeviceBinding;
export const ewohDeviceConfigTable = ewohDeviceConfig;
export const ewohEnvironmentTable = ewohEnvironment;
export const ewohEventTable = ewohEvent;
export const ewohEventChainTable = ewohEventChain;
export const ewohNotificationTable = ewohNotification;
export const ewohFactoryTemplateTable = ewohFactoryTemplate;
export const ewohFactoryProfileTable = ewohFactoryProfile;
export const ewohAssetPackageTable = ewohAssetPackage;
export const ewohModelRegistryTable = ewohModelRegistry;
export const ewohOrganizationTable = ewohOrganization;
export const ewohPersonnelTable = ewohPersonnel;
export const ewohProductionTaskTable = ewohProductionTask;
export const ewohScheduleTaskTable = ewohScheduleTask;
export const ewohScheduleTaskStepTable = ewohScheduleTaskStep;
export const ewohResourcePreorderTable = ewohResourcePreorder;
export const ewohResourceBindingTable = ewohResourceBinding;
export const ewohTaskTemplateTable = ewohTaskTemplate;
export const ewohTaskStepTable = ewohTaskStep;
export const ewohScheduleAuditTable = ewohScheduleAudit;
export const ewohSchedulePlanTable = ewohSchedulePlan;
export const ewohSchedulerConfigTable = ewohSchedulerConfig;
export const ewohSpatialEntityTable = ewohSpatialEntity;
export const ewohTelemetryTable = ewohTelemetry;
export const ewohTopologyTable = ewohTopology;
export const ewohWorldStateTable = ewohWorldState;
export const ewohSavedViewsTable = ewohSavedViews;
export const ewohWorkbenchExportTaskTable = ewohWorkbenchExportTask;
export const ewohSchedulingRunTable = ewohSchedulingRun;
export const ewohSchedulingPlanAssignmentTable = ewohSchedulingPlanAssignment;
export const ewohSchedulingConstraintTable = ewohSchedulingConstraint;
export const ewohWorldStateSnapshotTable = ewohWorldStateSnapshot;
export const ewohRouteNodeTable = ewohRouteNode;
export const ewohRouteEdgeTable = ewohRouteEdge;
export const ewohAssignmentEventTable = ewohAssignmentEvent;
export const ewohResourceReservationTable = ewohResourceReservation;
export const ewohOutboxTable = ewohOutbox;
export const ewohSchedulingPolicyTable = ewohSchedulingPolicy;
export const ewohReplanTriggerTable = ewohReplanTrigger;
export const ewohSchedulingFeedbackTable = ewohSchedulingFeedback;

// ============================================================================
// Phase 4 / P4-EXEC：正式执行领域（standalone_018_execution_feedback）
// ============================================================================

/** 正式执行记录：Plan Assignment → Execution（planned vs actual + deviation）。 */
export const ewohSchedulingExecution = pgTable("ewoh_scheduling_execution", {
  id: uuid("id").primaryKey().defaultRandom(),
  executionId: varchar("execution_id", { length: 255 }).notNull(),
  /** 租户归属（standalone_057 起 NOT NULL，存量 NULL 行已回填默认 org；RLS org 隔离）。 */
  orgId: varchar("org_id", { length: 255 }).notNull(),
  runId: varchar("run_id", { length: 255 }),
  planId: varchar("plan_id", { length: 255 }).notNull(),
  assignmentId: varchar("assignment_id", { length: 255 }).notNull(),
  taskId: varchar("task_id", { length: 255 }).notNull(),
  personId: varchar("person_id", { length: 255 }),
  deviceId: varchar("device_id", { length: 255 }),
  stationId: varchar("station_id", { length: 255 }),
  plannedStartAt: customTimestamptz("planned_start_at", { precision: 3 }),
  plannedEndAt: customTimestamptz("planned_end_at", { precision: 3 }),
  actualStartAt: customTimestamptz("actual_start_at", { precision: 3 }),
  actualEndAt: customTimestamptz("actual_end_at", { precision: 3 }),
  plannedTravelMs: bigint("planned_travel_ms", { mode: 'number' }),
  actualTravelMs: bigint("actual_travel_ms", { mode: 'number' }),
  plannedDistanceM: doublePrecision("planned_distance_m"),
  actualDistanceM: doublePrecision("actual_distance_m"),
  plannedWaitingMs: bigint("planned_waiting_ms", { mode: 'number' }),
  actualWaitingMs: bigint("actual_waiting_ms", { mode: 'number' }),
  status: varchar("status", { length: 50 }).notNull().default('PLANNED'),
  deviationType: varchar("deviation_type", { length: 100 }),
  deviationReason: text("deviation_reason"),
  snapshotVersion: varchar("snapshot_version", { length: 255 }),
  policyVersion: integer("policy_version"),
  solverVersion: varchar("solver_version", { length: 100 }),
  source: varchar("source", { length: 50 }).notNull().default('feedback'),
  createdAt: customTimestamptz("_created_at", { precision: 3 }).notNull().default(sql`CURRENT_TIMESTAMP`),
  updatedAt: customTimestamptz("_updated_at", { precision: 3 }).notNull().default(sql`CURRENT_TIMESTAMP`),
}, (table) => [
  index("idx_ewoh_scheduling_execution_org").on(table.orgId),
  index("idx_ewoh_scheduling_execution_plan").on(table.planId),
  index("idx_ewoh_scheduling_execution_assignment").on(table.assignmentId),
  index("idx_ewoh_scheduling_execution_task").on(table.taskId),
  index("idx_ewoh_scheduling_execution_status").on(table.status),
  // NEST/SQL-023（standalone_057）：execution_id/assignment_id 单列唯一 → 复合
  // (org_id, execution_id) / (org_id, assignment_id)。
  uniqueIndex("uq_ewoh_scheduling_execution_org_execution").on(table.orgId, table.executionId),
  uniqueIndex("uq_ewoh_scheduling_execution_org_assignment").on(table.orgId, table.assignmentId),
]);

// ============================================================================
// Phase 4 / P4-KPI+P4-REPLAY（standalone_019_kpi_replay）
// ============================================================================

/** 生产 KPI 聚合缓存（Delivery/Resources/Stability/Solver/DataQuality）。 */
export const ewohSchedulingKpi = pgTable("ewoh_scheduling_kpi", {
  id: uuid("id").primaryKey().defaultRandom(),
  kpiId: varchar("kpi_id", { length: 255 }).notNull(),
  /** 租户归属（standalone_057 起 NOT NULL，存量 NULL 行已回填默认 org；RLS org 隔离）。 */
  orgId: varchar("org_id", { length: 255 }).notNull(),
  periodStart: customTimestamptz("period_start", { precision: 3 }).notNull(),
  periodEnd: customTimestamptz("period_end", { precision: 3 }).notNull(),
  kpiJson: jsonb("kpi_json").notNull().default({}),
  source: varchar("source", { length: 50 }).notNull().default('aggregate'),
  createdAt: customTimestamptz("_created_at", { precision: 3 }).notNull().default(sql`CURRENT_TIMESTAMP`),
  updatedAt: customTimestamptz("_updated_at", { precision: 3 }).notNull().default(sql`CURRENT_TIMESTAMP`),
}, (table) => [
  // NEST/SQL-024（standalone_057）：kpi_id 单列唯一 → (org_id, kpi_id)。
  uniqueIndex("uq_ewoh_scheduling_kpi_org_kpi").on(table.orgId, table.kpiId),
  uniqueIndex("uq_ewoh_scheduling_kpi_org_period").on(table.orgId, table.periodStart, table.periodEnd),
  index("idx_ewoh_scheduling_kpi_org").on(table.orgId),
]);

/** Policy Replay 记录（deterministic replay 结果持久化）。 */
export const ewohPolicyReplay = pgTable("ewoh_policy_replay", {
  id: uuid("id").primaryKey().defaultRandom(),
  replayId: varchar("replay_id", { length: 255 }).notNull(),
  /** 租户归属（standalone_057 起 NOT NULL，存量 NULL 行已回填默认 org；RLS org 隔离）。 */
  orgId: varchar("org_id", { length: 255 }).notNull(),
  candidatePolicyVersion: integer("candidate_policy_version").notNull(),
  baselinePolicyVersion: integer("baseline_policy_version").notNull(),
  solverVersion: varchar("solver_version", { length: 100 }),
  snapshotVersion: varchar("snapshot_version", { length: 255 }),
  snapshotSet: jsonb("snapshot_set").default([]),
  seed: integer("seed"),
  status: varchar("status", { length: 50 }).notNull().default('COMPLETED'),
  aggregateKpisJson: jsonb("aggregate_kpis_json").default({}),
  perRunResultsJson: jsonb("per_run_results_json").default([]),
  failuresJson: jsonb("failures_json").default([]),
  startedAt: customTimestamptz("started_at", { precision: 3 }).notNull().default(sql`CURRENT_TIMESTAMP`),
  completedAt: customTimestamptz("completed_at", { precision: 3 }),
  createdAt: customTimestamptz("_created_at", { precision: 3 }).notNull().default(sql`CURRENT_TIMESTAMP`),
}, (table) => [
  // NEST/SQL-027（standalone_057）：replay_id 单列唯一 → (org_id, replay_id)。
  uniqueIndex("uq_ewoh_policy_replay_org_replay").on(table.orgId, table.replayId),
  index("idx_ewoh_policy_replay_candidate").on(table.candidatePolicyVersion),
  index("idx_ewoh_policy_replay_org").on(table.orgId),
]);

// ============================================================================
// Phase 4 / P4-GATE：策略生命周期（standalone_020_policy_lifecycle）
// ============================================================================

/** 策略激活审计（operator/reason/before/after/gate/rollback target）。 */
export const ewohPolicyActivation = pgTable("ewoh_policy_activation", {
  id: uuid("id").primaryKey().defaultRandom(),
  activationId: varchar("activation_id", { length: 255 }).notNull(),
  /** 租户归属（standalone_057 起 NOT NULL，存量 NULL 行已回填默认 org；RLS org 隔离）。 */
  orgId: varchar("org_id", { length: 255 }).notNull(),
  policyVersion: integer("policy_version").notNull(),
  beforeVersion: integer("before_version"),
  afterVersion: integer("after_version"),
  operator: varchar("operator", { length: 255 }).notNull(),
  reason: text("reason"),
  gateResultJson: jsonb("gate_result_json").default({}),
  rollbackTarget: integer("rollback_target"),
  status: varchar("status", { length: 50 }).notNull().default('ACTIVATED'),
  createdAt: customTimestamptz("_created_at", { precision: 3 }).notNull().default(sql`CURRENT_TIMESTAMP`),
}, (table) => [
  // NEST/SQL-025（standalone_057）：activation_id 单列唯一 → (org_id, activation_id)。
  uniqueIndex("uq_ewoh_policy_activation_org_activation").on(table.orgId, table.activationId),
  index("idx_ewoh_policy_activation_policy").on(table.policyVersion),
  index("idx_ewoh_policy_activation_org").on(table.orgId),
]);

export const ewohSchedulingExecutionTable = ewohSchedulingExecution;
export const ewohSchedulingKpiTable = ewohSchedulingKpi;
export const ewohPolicyReplayTable = ewohPolicyReplay;
export const ewohPolicyActivationTable = ewohPolicyActivation;


// ===== Control plane（ADR-077 / NO-13ab：raw-SQL public 硬编码修复 + org 归属）=====
export const ewohControlRequest = pgTable("ewoh_control_request", {
  id: uuid("id").primaryKey().defaultRandom(),
  /** 组织归属（001：NOT NULL DEFAULT current GUC；写侧 ctx 注入，缺省省略由 DB 填充——GUC 空则显式失败 fail-closed）。 */
  orgId: uuid("org_id").notNull().default(sql`nullif(current_setting('app.current_org_id', true), '')::uuid`),
  requestId: varchar("request_id", { length: 255 }).notNull().unique(),
  deviceId: varchar("device_id", { length: 255 }).notNull(),
  controlType: varchar("control_type", { length: 100 }).notNull(),
  /**
   * @type { string[] }
   */
  commandKeys: jsonb("command_keys").notNull().default(sql`'[]'::jsonb`),
  status: varchar("status", { length: 50 }).notNull().default('draft'),
  idempotencyKey: varchar("idempotency_key", { length: 255 }),
  requestedBy: varchar("requested_by", { length: 255 }),
  approvedBy: varchar("approved_by", { length: 255 }),
  approvedAt: customTimestamptz("approved_at", { precision: 6 }),
  reason: text("reason"),
  riskLevel: varchar("risk_level", { length: 50 }).notNull().default('normal'),
  requiresSecondaryConfirm: boolean("requires_secondary_confirm").notNull().default(true),
  deadline: customTimestamptz("deadline", { precision: 6 }),
  requestedAt: customTimestamptz("requested_at", { precision: 6 }).notNull().default(sql`CURRENT_TIMESTAMP`),
  completedAt: customTimestamptz("completed_at", { precision: 6 }),
  createdAt: customTimestamptz("_created_at", { precision: 6 }).notNull().default(sql`CURRENT_TIMESTAMP`),
  updatedAt: customTimestamptz("_updated_at", { precision: 6 }).notNull().default(sql`CURRENT_TIMESTAMP`),
});

export const ewohControlCommand = pgTable("ewoh_control_command", {
  id: uuid("id").primaryKey().defaultRandom(),
  /** 组织归属（与请求行 org 同源，§3 单一事实源）。 */
  orgId: uuid("org_id").notNull().default(sql`nullif(current_setting('app.current_org_id', true), '')::uuid`),
  commandId: varchar("command_id", { length: 255 }).notNull().unique(),
  requestId: varchar("request_id", { length: 255 }).notNull(),
  rootCommandId: varchar("root_command_id", { length: 255 }).notNull(),
  attemptNo: integer("attempt_no").notNull().default(1),
  commandKey: varchar("command_key", { length: 255 }).notNull(),
  /**
   * @type { Record<string, unknown> | null }
   */
  payload: jsonb("payload"),
  status: varchar("status", { length: 50 }).notNull().default('pending'),
  sentAt: customTimestamptz("sent_at", { precision: 6 }),
  responseAt: customTimestamptz("response_at", { precision: 6 }),
  /**
   * @type { Record<string, unknown> | null }
   */
  responseJson: jsonb("response_json"),
  errorCode: varchar("error_code", { length: 100 }),
  errorMessage: text("error_message"),
  idempotencyKey: varchar("idempotency_key", { length: 255 }),
  createdAt: customTimestamptz("_created_at", { precision: 6 }).notNull().default(sql`CURRENT_TIMESTAMP`),
  updatedAt: customTimestamptz("_updated_at", { precision: 6 }).notNull().default(sql`CURRENT_TIMESTAMP`),
}, (table) => [
  // NEST-425 配套（standalone_058）：并发重试的 attemptNo 唯一
  // （同 request + commandKey 维度；application 层 max+1 子查询原子生成）。
  uniqueIndex("uq_ewoh_control_command_attempt").on(
    table.requestId,
    table.commandKey,
    table.attemptNo,
  ),
]);

export const ewohControlResult = pgTable("ewoh_control_result", {
  id: uuid("id").primaryKey().defaultRandom(),
  /** 组织归属（与请求行 org 同源）。 */
  orgId: uuid("org_id").notNull().default(sql`nullif(current_setting('app.current_org_id', true), '')::uuid`),
  resultId: varchar("result_id", { length: 255 }).notNull().unique(),
  requestId: varchar("request_id", { length: 255 }).notNull(),
  commandId: varchar("command_id", { length: 255 }).notNull(),
  resultType: varchar("result_type", { length: 100 }).notNull(),
  resultCode: varchar("result_code", { length: 100 }),
  /**
   * @type { Record<string, unknown> | null }
   */
  resultJson: jsonb("result_json"),
  success: boolean("success").notNull().default(false),
  completedAt: customTimestamptz("completed_at", { precision: 6 }).notNull().default(sql`CURRENT_TIMESTAMP`),
  operatorId: varchar("operator_id", { length: 255 }),
  createdAt: customTimestamptz("_created_at", { precision: 6 }).notNull().default(sql`CURRENT_TIMESTAMP`),
  updatedAt: customTimestamptz("_updated_at", { precision: 6 }).notNull().default(sql`CURRENT_TIMESTAMP`),
});


// ===== 审计日志（ADR-078 / NO-13ac：raw-SQL public 硬编码修复）=====
export const ewohAuditLog = pgTable("ewoh_audit_log", {
  id: uuid("id").primaryKey().defaultRandom(),
  orgId: uuid("org_id").default(sql`nullif(current_setting('app.current_org_id', true), '')::uuid`),
  auditSeq: bigint("audit_seq", { mode: 'number' }).notNull(),
  actorId: varchar("actor_id", { length: 255 }).notNull(),
  action: varchar("action", { length: 100 }).notNull(),
  entityType: varchar("entity_type", { length: 255 }).notNull(),
  entityId: varchar("entity_id", { length: 255 }).notNull(),
  beforeJson: jsonb("before_json"),
  afterJson: jsonb("after_json"),
  reason: text("reason"),
  clientIp: varchar("client_ip", { length: 64 }),
  requestId: varchar("request_id", { length: 128 }),
  riskLevel: varchar("risk_level", { length: 50 }).notNull().default('normal'),
  isHighRisk: boolean("is_high_risk").notNull().default(false),
  occurredAt: customTimestamptz("occurred_at", { precision: 6 }).notNull().default(sql`CURRENT_TIMESTAMP`),
  chainSeq: bigint("chain_seq", { mode: 'number' }).notNull(),
  prevHash: varchar("prev_hash", { length: 64 }).notNull().default('0'.repeat(64)),
  hash: varchar("hash", { length: 64 }).notNull(),
  createdAt: customTimestamptz("_created_at", { precision: 6 }).notNull().default(sql`CURRENT_TIMESTAMP`),
  updatedAt: customTimestamptz("_updated_at", { precision: 6 }).notNull().default(sql`CURRENT_TIMESTAMP`),
});

/**
 * NEST-513 标注（2026-08-17）：以下 managed 表（schema-manifest.yaml 登记）由
 * standalone_001/005 创建并有 RLS/CHECK/唯一约束（DB 层强制），但当前无任何
 * server 服务消费，故本文件**有意不提供** Drizzle 映射（避免无人维护的死映射
 * 与 001 列定义漂移；审计建议「补齐或标注未使用」二选一，此处选标注）：
 *   ewoh_system_config / ewoh_knowledge_base / ewoh_event_rule /
 *   ewoh_event_action / ewoh_event_subscription / ewoh_skill / ewoh_role /
 *   ewoh_person_skill / ewoh_person_role / ewoh_device_capability /
 *   ewoh_spatial_relation / ewoh_spatial_hierarchy / ewoh_model_asset /
 *   ewoh_model_binding / ewoh_workstation / ewoh_workstation_device /
 *   ewoh_workstation_person / ewoh_workstation_skill /
 *   ewoh_workstation_relation / ewoh_task_skill_req / ewoh_schedule_assignment。
 * 首个消费这些表的功能落地时，必须按 db/migrations/standalone_001_schema.sql
 * 的列定义补 pgTable 映射并同步本标注清单。
 */
