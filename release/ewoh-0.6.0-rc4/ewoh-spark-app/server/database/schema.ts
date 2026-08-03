/* eslint-disable */
/** auto generated, do not edit */
import { sql } from 'drizzle-orm';
import { boolean, index, integer, jsonb, numeric, pgTable, real, text, uniqueIndex, uuid, varchar, customType } from "drizzle-orm/pg-core"

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

export function escapeLiteral(str: string): string {
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
  title: varchar("title", { length: 500 }),
  suggestionType: varchar("suggestion_type", { length: 50 }),
  status: varchar("status", { length: 50 }).default('not_generated'),
  relatedEventId: varchar("related_event_id", { length: 255 }),
  relatedTaskId: varchar("related_task_id", { length: 255 }),
  inputSummary: text("input_summary"),
  content: text("content"),
  riskAssessment: text("risk_assessment"),
  aiLevel: varchar("ai_level", { length: 10 }).default('A2'),
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
  createdAt: customTimestamptz("_created_at", { precision: 3 }).notNull().default(sql`CURRENT_TIMESTAMP`),
  createdBy: uuid("_created_by"),
  updatedAt: customTimestamptz("_updated_at", { precision: 3 }).notNull().default(sql`CURRENT_TIMESTAMP`),
  updatedBy: uuid("_updated_by"),
}, (table) => [
  index("idx_ewoh_schedule_task_status").on(table.status),
  index("idx_ewoh_schedule_task_source").on(table.source),
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
  createdAt: customTimestamptz("_created_at", { precision: 3 }).notNull().default(sql`CURRENT_TIMESTAMP`),
  createdBy: uuid("_created_by"),
  updatedAt: customTimestamptz("_updated_at", { precision: 3 }).notNull().default(sql`CURRENT_TIMESTAMP`),
  updatedBy: uuid("_updated_by"),
}, (table) => [
  index("idx_ewoh_schedule_task_step_status").on(table.status),
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
  createdAt: customTimestamptz("_created_at", { precision: 3 }).notNull().default(sql`CURRENT_TIMESTAMP`),
  createdBy: uuid("_created_by"),
  updatedAt: customTimestamptz("_updated_at", { precision: 3 }).notNull().default(sql`CURRENT_TIMESTAMP`),
  updatedBy: uuid("_updated_by"),
}, (table) => [
  index("idx_ewoh_resource_binding_target").on(table.targetId),
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
  status: varchar("status", { length: 50 }).default('available'),
  healthStatus: varchar("health_status", { length: 50 }).default('normal'),
  /**
   * @type { loadLevel: number; fatigueLevel: number; postureRisk: string }
   */
  currentLoad: jsonb("current_load"),
  spatialEntityId: varchar("spatial_entity_id", { length: 255 }),
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
  confirmedBy: varchar("confirmed_by", { length: 255 }),
  confirmedAt: customTimestamptz("confirmed_at", { precision: 6 }),
  confirmReason: text("confirm_reason"),
  // System field: Update time (auto-filled, do not modify)
  updatedAt: customTimestamptz("_updated_at", { precision: 6 }).notNull().default(sql`CURRENT_TIMESTAMP`),
}, (table) => [
  uniqueIndex("ewoh_schedule_plan_plan_id_key").on(table.planId),
  index("idx_ewoh_schedule_plan_status").on(table.status),
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
}, (table) => [
  index("idx_ewoh_event_chain_event").on(table.eventId),
  index("idx_ewoh_event_chain_parent").on(table.parentEventId),
]);

export const ewohWorldState = pgTable("ewoh_world_state", {
  id: uuid("id").primaryKey().defaultRandom(),
  entityId: varchar("entity_id", { length: 255 }).notNull(),
  stateJson: jsonb("state_json").notNull(),
  ts: customTimestamptz("ts", { precision: 6 }).notNull().default(sql`CURRENT_TIMESTAMP`),
  // System field: Creation time (auto-filled, do not modify)
  createdAt: customTimestamptz("_created_at", { precision: 6 }).notNull().default(sql`CURRENT_TIMESTAMP`),
  // System field: Update time (auto-filled, do not modify)
  updatedAt: customTimestamptz("_updated_at", { precision: 6 }).notNull().default(sql`CURRENT_TIMESTAMP`),
}, (table) => [
  index("idx_ewoh_world_state_entity_ts").on(table.entityId, table.ts),
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
}, (table) => [
  index("idx_ewoh_topology_from").on(table.fromEntity),
]);

export const ewohSpatialEntity = pgTable("ewoh_spatial_entity", {
  id: uuid("id").primaryKey().defaultRandom(),
  entityId: varchar("entity_id", { length: 255 }).notNull().unique(),
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
  // System field: Creation time (auto-filled, do not modify)
  createdAt: customTimestamptz("_created_at", { precision: 6 }).notNull().default(sql`CURRENT_TIMESTAMP`),
  // System field: Update time (auto-filled, do not modify)
  updatedAt: customTimestamptz("_updated_at", { precision: 6 }).notNull().default(sql`CURRENT_TIMESTAMP`),
}, (table) => [
  uniqueIndex("ewoh_spatial_entity_entity_id_key").on(table.entityId),
  index("idx_ewoh_spatial_entity_type").on(table.entityType),
  index("idx_ewoh_spatial_entity_parent").on(table.parentId),
]);

export const ewohTelemetry = pgTable("ewoh_telemetry", {
  id: uuid("id").primaryKey().defaultRandom(),
  deviceId: varchar("device_id", { length: 255 }).notNull(),
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
}, (table) => [
  index("idx_ewoh_telemetry_device_ts").on(table.deviceId, table.ts),
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
  // System field: Update time (auto-filled, do not modify)
  updatedAt: customTimestamptz("_updated_at", { precision: 6 }).notNull().default(sql`CURRENT_TIMESTAMP`),
}, (table) => [
  uniqueIndex("ewoh_event_event_id_key").on(table.eventId),
  index("idx_ewoh_event_status").on(table.status),
  index("idx_ewoh_event_created_at").on(table.createdAt),
  index("idx_event_source").on(table.sourceType),
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
}, (table) => [
  index("idx_ewoh_asset_package_type").on(table.packageType, table.status),
]);

export const ewohNotification = pgTable("ewoh_notification", {
  id: uuid("id").primaryKey().defaultRandom(),
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

export const ewohDevice = pgTable("ewoh_device", {
  id: uuid("id").primaryKey().defaultRandom(),
  deviceId: varchar("device_id", { length: 255 }).notNull().unique(),
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
  // System field: Creation time (auto-filled, do not modify)
  createdAt: customTimestamptz("_created_at", { precision: 6 }).notNull().default(sql`CURRENT_TIMESTAMP`),
  // System field: Update time (auto-filled, do not modify)
  updatedAt: customTimestamptz("_updated_at", { precision: 6 }).notNull().default(sql`CURRENT_TIMESTAMP`),
}, (table) => [
  uniqueIndex("ewoh_device_device_id_key").on(table.deviceId),
  index("idx_ewoh_device_online").on(table.online),
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
