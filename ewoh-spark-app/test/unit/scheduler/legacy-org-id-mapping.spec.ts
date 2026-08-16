/* legacy-org-id-mapping.spec.ts — Legacy 受管表 org_id 映射漂移闭合（ADR-075 / NO-13z，§3/§15）。
 *
 * 001 ewoh_org_visible RLS 覆盖 49 张受管表；schema.ts 必须逐表映射 org_id，
 * 否则应用写路径产生 NULL org 行（生产 RLS WITH CHECK 拒绝）且读回为空。
 * 本 spec 锁定 17 张历史漂移表的映射（列名 org_id、类型 varchar 可空）——
 * 映射回退即漂移信号。
 */
import {
  ewohAiSuggestion,
  ewohProductionTask,
  ewohTaskTemplate,
  ewohTaskStep,
  ewohDeviceConfig,
  ewohDeviceBinding,
  ewohOrganization,
  ewohEnvironment,
  ewohModelRegistry,
  ewohScheduleAudit,
  ewohEventChain,
  ewohTopology,
  ewohTelemetry,
  ewohFactoryTemplate,
  ewohFactoryProfile,
  ewohAssetPackage,
  ewohDevice,
} from '@server/database/schema';

const DRIFTED = [
  ['ewoh_ai_suggestion', ewohAiSuggestion],
  ['ewoh_production_task', ewohProductionTask],
  ['ewoh_task_template', ewohTaskTemplate],
  ['ewoh_task_step', ewohTaskStep],
  ['ewoh_device_config', ewohDeviceConfig],
  ['ewoh_device_binding', ewohDeviceBinding],
  ['ewoh_organization', ewohOrganization],
  ['ewoh_environment', ewohEnvironment],
  ['ewoh_model_registry', ewohModelRegistry],
  ['ewoh_schedule_audit', ewohScheduleAudit],
  ['ewoh_event_chain', ewohEventChain],
  ['ewoh_topology', ewohTopology],
  ['ewoh_telemetry', ewohTelemetry],
  ['ewoh_factory_template', ewohFactoryTemplate],
  ['ewoh_factory_profile', ewohFactoryProfile],
  ['ewoh_asset_package', ewohAssetPackage],
  ['ewoh_device', ewohDevice],
] as const;

describe('Legacy 受管表 org_id 映射（ADR-075 / NO-13z）', () => {
  it.each(DRIFTED)('%s → schema.ts 映射 org_id（varchar 可空，RLS ewoh_org_visible 对齐）', (_phys, table) => {
    const col = (table as unknown as { orgId?: { name: string; notNull: boolean; dataType: string } }).orgId;
    expect(col).toBeDefined();
    expect(col?.name).toBe('org_id');
    expect(col?.notNull).toBe(false);
    expect(col?.dataType).toBe('string');
  });

  it('17 张漂移表全部锁定（映射数量不缩水）', () => {
    expect(DRIFTED).toHaveLength(17);
  });
});

import {
  ewohControlRequest,
  ewohControlCommand,
  ewohControlResult,
} from '@server/database/schema';

describe('控制面三表 org_id 映射（ADR-077 / NO-13ab：raw-SQL public 硬编码修复）', () => {
  it.each([
    ['ewoh_control_request', ewohControlRequest],
    ['ewoh_control_command', ewohControlCommand],
    ['ewoh_control_result', ewohControlResult],
  ] as const)('%s → schema.ts 映射 org_id（NOT NULL，GUC default fail-closed）', (_phys, table) => {
    const col = (table as unknown as { orgId?: { name: string; notNull: boolean; dataType: string } }).orgId;
    expect(col).toBeDefined();
    expect(col?.name).toBe('org_id');
    expect(col?.notNull).toBe(true);
    expect(col?.dataType).toBe('string');
  });
});
