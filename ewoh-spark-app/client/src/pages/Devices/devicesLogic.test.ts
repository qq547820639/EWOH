/**
 * devicesLogic.test.ts — Devices 数据页纯逻辑测试（ADR-083，§17/§33）。
 */
import {
  buildCapabilityViews,
  capabilityActionLabel,
  disabledDaysFor,
  DISABLED_REVIEW_THRESHOLD_DAYS,
  formatCapabilityLifecycle,
  hasRegisteredLocation,
  isDataStale,
  buildDeviceSearchQuery,
  buildBatteryChartData,
  buildEntityNameMap,
  formatDeviceCategory,
  hasBatteryReading,
  CATEGORY_FILTER_OPTIONS,
  SOURCE_LABELS,
  describeRestoreApprovalStatus,
  describeApprovalFreshness,
  describeRestoreRejection,
  isRestoreApprovalGateError,
  restoreRequiresSafetyApproval,
} from './devicesLogic';
import type { DeviceInfo } from '@shared/api.interface';

describe('devicesLogic', () => {
  // batteryColor 的测试已随死函数删除（2026-09-01：全仓零生产调用）。

  describe('isDataStale', () => {
    it('returns false when dataUpdatedAt is 0 (never fetched)', () => {
      expect(isDataStale(0)).toBe(false);
    });

    it('returns false when data is fresh', () => {
      expect(isDataStale(Date.now())).toBe(false);
    });

    it('returns true when data is older than staleMs', () => {
      expect(isDataStale(Date.now() - 120000)).toBe(true);
    });

    it('respects custom staleMs', () => {
      expect(isDataStale(Date.now() - 5000, 10000)).toBe(false);
      expect(isDataStale(Date.now() - 15000, 10000)).toBe(true);
    });
  });

  describe('buildDeviceSearchQuery', () => {
    it('includes orderby always', () => {
      const q = buildDeviceSearchQuery({ orderby: 'batteryDesc' });
      expect(q.orderby).toBe('batteryDesc');
    });

    it('includes keyword when non-empty', () => {
      const q = buildDeviceSearchQuery({ orderby: 'deviceId', keyword: '  EXO  ' });
      expect(q.keyword).toBe('EXO');
    });

    it('excludes empty keyword', () => {
      const q = buildDeviceSearchQuery({ orderby: 'deviceId', keyword: '  ' });
      expect(q.keyword).toBeUndefined();
    });

    it('maps onlineFilter to boolean', () => {
      expect(buildDeviceSearchQuery({ orderby: 'deviceId', onlineFilter: 'online' }).online).toBe(true);
      expect(buildDeviceSearchQuery({ orderby: 'deviceId', onlineFilter: 'offline' }).online).toBe(false);
      expect(buildDeviceSearchQuery({ orderby: 'deviceId', onlineFilter: 'all' }).online).toBeUndefined();
    });

    it('includes battery range when set', () => {
      const q = buildDeviceSearchQuery({ orderby: 'deviceId', batteryMin: '20', batteryMax: '80' });
      expect(q.batteryMin).toBe(20);
      expect(q.batteryMax).toBe(80);
    });

    it('excludes empty battery range', () => {
      const q = buildDeviceSearchQuery({ orderby: 'deviceId', batteryMin: '', batteryMax: '' });
      expect(q.batteryMin).toBeUndefined();
      expect(q.batteryMax).toBeUndefined();
    });

    it('includes sourceType when not all', () => {
      expect(buildDeviceSearchQuery({ orderby: 'deviceId', sourceFilter: 'simulated' }).sourceType).toBe('simulated');
      expect(buildDeviceSearchQuery({ orderby: 'deviceId', sourceFilter: 'all' }).sourceType).toBeUndefined();
    });
  });

  describe('buildBatteryChartData', () => {
    it('transforms devices to chart data', () => {
      const devices = [
        { deviceId: 'D1', batteryPct: 80, online: true },
        { deviceId: 'D2', batteryPct: 30, online: false },
      ] as unknown as DeviceInfo[];
      const data = buildBatteryChartData(devices);
      expect(data).toEqual([
        { name: 'D1', battery: 80, online: true },
        { name: 'D2', battery: 30, online: false },
      ]);
    });

    it('returns empty array for empty input', () => {
      expect(buildBatteryChartData([])).toEqual([]);
    });
  });

  describe('buildEntityNameMap', () => {
    it('maps both entityId and id to name', () => {
      const entities = [
        { entityId: 'E1', id: 'uuid-1', name: 'Zone A' },
        { entityId: 'E2', id: 'uuid-2', name: 'Zone B' },
      ];
      const m = buildEntityNameMap(entities);
      expect(m.get('E1')).toBe('Zone A');
      expect(m.get('uuid-1')).toBe('Zone A');
      expect(m.get('E2')).toBe('Zone B');
    });
  });

  describe('SOURCE_LABELS', () => {
    it('covers known source types', () => {
      expect(SOURCE_LABELS.real).toBe('真实');
      expect(SOURCE_LABELS.simulated).toBe('仿真');
      expect(Object.keys(SOURCE_LABELS)).toContain('controlled_test');
    });
  });

  /* ------------------------------------------------------------------
   * 感知层设备入台账（2026-09-10）：类别必须可判定，电量必须区分
   * "没有电池"与"电量低"——把 NULL 显示成 0% 是把不适用伪装成告警。
   * ------------------------------------------------------------------ */
  describe('设备类别', () => {
    it('词表内类别显示中文名', () => {
      expect(formatDeviceCategory('exoskeleton')).toBe('外骨骼');
      expect(formatDeviceCategory('environment_sensor')).toBe('环境传感器');
      expect(formatDeviceCategory('camera')).toBe('摄像头');
      expect(formatDeviceCategory('location_tag')).toBe('定位标签');
    });

    it('未知/历史脏值显示"未知类别"，绝不猜一个相近类别', () => {
      expect(formatDeviceCategory(null)).toBe('未知类别');
      expect(formatDeviceCategory(undefined)).toBe('未知类别');
      expect(formatDeviceCategory('')).toBe('未知类别');
      expect(formatDeviceCategory('robot_arm')).toBe('未知类别');
    });

    it('过滤选项覆盖全部词表 + 显式未知（前端只提供可判定选项）', () => {
      const values = CATEGORY_FILTER_OPTIONS.map((o) => o.value);
      expect(values[0]).toBe('all');
      expect(values).toEqual([
        'all',
        'exoskeleton',
        'environment_sensor',
        'camera',
        'location_tag',
        // NO-59b：执行机构（AGV/PLC）进入设备类别词表 → 设备页可按类别筛选
        'agv',
        'unknown',
      ]);
      expect(CATEGORY_FILTER_OPTIONS.every((o) => o.label.length > 0)).toBe(true);
    });
  });

  describe('搜索查询拼装（含类别）', () => {
    it('categoryFilter=all 不传；具体类别透传', () => {
      expect(
        buildDeviceSearchQuery({ orderby: 'deviceId', categoryFilter: 'all' }).category,
      ).toBeUndefined();
      expect(
        buildDeviceSearchQuery({ orderby: 'deviceId', categoryFilter: 'location_tag' }).category,
      ).toBe('location_tag');
    });
  });

  describe('电量读数', () => {
    it('有读数才算电量（含 0% 是真实读数）', () => {
      expect(hasBatteryReading(0)).toBe(true);
      expect(hasBatteryReading(42)).toBe(true);
      expect(hasBatteryReading(100)).toBe(true);
    });

    it('无读数（没有电池的设备）为 false → UI 显示"不适用"而不是低电量告警', () => {
      expect(hasBatteryReading(null)).toBe(false);
      expect(hasBatteryReading(undefined)).toBe(false);
      expect(hasBatteryReading(Number.NaN)).toBe(false);
    });
  });

  /* ------------------------------------------------------------------
   * 能力模型与空间身份（2026-09-10）：能力必须可解释、停用不隐藏、
   * 词表外键原样展示；位置未登记必须显式（不显示空白）。
   * ------------------------------------------------------------------ */
  describe('设备能力视图', () => {
    const cap = (over: Record<string, unknown> = {}) => ({
      name: 'observe.temperature',
      key: 'observe.temperature',
      kind: 'device_capability',
      providerType: 'device',
      mode: 'observation',
      capabilityId: 'cap:device:env-1:observe.temperature',
      label: '环境温度',
      status: 'active',
      fields: ['temperature_c'],
      grantedAt: '2026-09-10T12:00:00.000Z',
      registered: true,
      ...over,
    });

    it('词表内能力给出中文名 + 权威 kind/mode 标签', () => {
      const views = buildCapabilityViews([cap()] as never);
      expect(views).toEqual([
        expect.objectContaining({
          name: 'observe.temperature',
          label: '环境温度',
          kindLabel: '设备能力',
          modeLabel: '观测',
          note: null,
        }),
      ]);
    });

    it('外骨骼能力展示为"外骨骼能力"（kind 来自权威契约，不由前端猜）', () => {
      const views = buildCapabilityViews([
        cap({ name: 'interact.assist', key: 'interact.assist', kind: 'exo_capability', mode: 'interaction', label: '助力交互' }),
      ] as never);
      expect(views[0].kindLabel).toBe('外骨骼能力');
      expect(views[0].modeLabel).toBe('交互');
    });

    it('停用能力不隐藏，而是显式标出状态', () => {
      const views = buildCapabilityViews([cap({ status: 'retired' })] as never);
      expect(views[0].note).toContain('retired');
      expect(views[0].note).toContain('不计入可用能力');
    });

    it('词表外能力名原样展示并标注未登记（不猜含义、不丢弃事实）', () => {
      const views = buildCapabilityViews([
        cap({ name: 'observe.custom_flux', key: 'observe.custom_flux', label: 'observe.custom_flux', registered: false }),
      ] as never);
      expect(views[0].name).toBe('observe.custom_flux');
      expect(views[0].note).toContain('未登记能力名');
    });

    it('生效中/已停用有明确状态标签与 effective 标记（不靠颜色暗示）', () => {
      const active = buildCapabilityViews([cap()] as never)[0];
      expect(active.effective).toBe(true);
      expect(active.statusLabel).toBe('生效中');

      const disabled = buildCapabilityViews([cap({ status: 'disabled' })] as never)[0];
      expect(disabled.effective).toBe(false);
      expect(disabled.statusLabel).toBe('已停用');
      expect(disabled.note).toContain('不计入可用能力');
    });

    it('人工停用留痕渲染为"谁/何时/为什么"，形状不全则不显示（不半截渲染）', () => {
      const withLifecycle = buildCapabilityViews([
        cap({
          status: 'disabled',
          lifecycle: {
            action: 'disable',
            operator: 'admin',
            reason: '该设备实际未装温度传感器',
            at: '2026-09-11T02:00:00.000Z',
            previousStatus: 'active',
          },
        }),
      ] as never)[0];
      expect(withLifecycle.lifecycleNote).toContain('人工停用');
      expect(withLifecycle.lifecycleNote).toContain('admin');
      expect(withLifecycle.lifecycleNote).toContain('该设备实际未装温度传感器');

      const broken = buildCapabilityViews([
        cap({ status: 'disabled', lifecycle: { action: 'disable' } as never }),
      ] as never)[0];
      expect(broken.lifecycleNote).toBeNull();
      // 自动声明的能力不带人工留痕（不冒充"人工确认过"）
      expect(buildCapabilityViews([cap()] as never)[0].lifecycleNote).toBeNull();
      // 纯函数直测：时间非法时原样展示 at（不伪造时间）
      expect(
        formatCapabilityLifecycle({
          action: 'restore',
          operator: 'ops',
          reason: '已修复',
          at: 'not-a-time',
          previousStatus: 'disabled',
        }),
      ).toContain('not-a-time');
    });

    it('长期停用提示复核（避免设备被悄悄永久排除在派工之外）', () => {
      const now = Date.parse('2026-09-20T00:00:00.000Z');
      const fresh = buildCapabilityViews(
        [
          cap({
            status: 'disabled',
            lifecycle: {
              action: 'disable',
              operator: 'admin',
              reason: '临时停用',
              at: '2026-09-19T00:00:00.000Z',
              previousStatus: 'active',
            },
          }),
        ] as never,
        now,
      )[0];
      expect(fresh.disabledDays).toBe(1);
      expect(fresh.needsReview).toBe(false);

      const stale = buildCapabilityViews(
        [
          cap({
            status: 'disabled',
            lifecycle: {
              action: 'disable',
              operator: 'admin',
              reason: '待修',
              at: '2026-09-01T00:00:00.000Z',
              previousStatus: 'active',
            },
          }),
        ] as never,
        now,
      )[0];
      expect(stale.disabledDays).toBeGreaterThanOrEqual(DISABLED_REVIEW_THRESHOLD_DAYS);
      expect(stale.needsReview).toBe(true);

      // 生效中的能力不算停用天数；留痕时间非法也不猜
      expect(disabledDaysFor('active', null, now)).toBeNull();
      expect(disabledDaysFor('disabled', { action: 'disable', operator: 'a', reason: 'r', at: 'bad', previousStatus: 'active' }, now)).toBeNull();
      expect(disabledDaysFor('disabled', null, now)).toBeNull();
    });

    it('安全等级可见且带行动含义（NO-19a：放宽高风险需安全负责人确认）', () => {
      const views = buildCapabilityViews([
        cap({ name: 'exo-lift', key: 'exo-lift', label: '助力提升' }),
        cap({ name: 'observe.temperature', key: 'observe.temperature', label: '环境温度' }),
        cap({ name: 'custom.magic_lift', key: 'custom.magic_lift', label: 'custom.magic_lift', registered: false }),
      ] as never);
      const byName = (n: string) => views.find((v) => v.name === n)!;
      expect(byName('exo-lift').risk).toBe('high');
      expect(byName('exo-lift').riskLabel).toContain('安全负责人确认');
      expect(byName('observe.temperature').risk).toBe('low');
      expect(byName('observe.temperature').riskLabel).toBe('低风险');
      // 未登记能力名 → 不假装低风险
      expect(byName('custom.magic_lift').risk).toBeNull();
      expect(byName('custom.magic_lift').riskLabel).toContain('未登记风险等级');
    });

    it('停用/恢复动作与可操作性（词表外能力名不允许恢复，与后端 fail-closed 同口径）', () => {
      const active = buildCapabilityViews([cap()] as never)[0];
      expect(capabilityActionLabel(active)).toEqual({ action: 'disable', label: '停用', blockedReason: null });

      const disabled = buildCapabilityViews([cap({ status: 'disabled' })] as never)[0];
      expect(capabilityActionLabel(disabled)).toEqual({ action: 'restore', label: '恢复', blockedReason: null });

      const unregistered = buildCapabilityViews([
        cap({ name: 'legacy.magic', key: 'legacy.magic', status: 'disabled', registered: false }),
      ] as never)[0];
      expect(unregistered.restorable).toBe(false);
      expect(capabilityActionLabel(unregistered).blockedReason).toContain('词表');
    });

    it('无能力数据 → 空数组（UI 显示"尚未登记能力"，不是空白）', () => {
      expect(buildCapabilityViews(null)).toEqual([]);
      expect(buildCapabilityViews(undefined)).toEqual([]);
      expect(buildCapabilityViews([])).toEqual([]);
    });
  });

  describe('空间位置登记状态', () => {
    it('有空间实体或父节点 → 已登记', () => {
      expect(hasRegisteredLocation('D-1', null)).toBe(true);
      expect(hasRegisteredLocation('D-1', 'ST-1')).toBe(true);
      expect(hasRegisteredLocation(undefined, 'ST-1')).toBe(true);
    });

    it('两者皆无 → 未登记（UI 必须显示"位置未登记"）', () => {
      expect(hasRegisteredLocation(undefined, null)).toBe(false);
      expect(hasRegisteredLocation(null, undefined)).toBe(false);
    });
  });

  // NO-21b：高风险能力"恢复"属执行边界变更，现场只能发起，必须由安全管理员放行。
  describe('恢复高风险能力的审批前置（与后端闸门同口径）', () => {
    it('高风险 + 未生效 + 可恢复 → 需要审批', () => {
      expect(restoreRequiresSafetyApproval({ risk: 'high', effective: false, restorable: true })).toBe(true);
    });

    it('中/低风险、已生效（=停用动作）、词表外能力 → 都不走审批前置', () => {
      expect(restoreRequiresSafetyApproval({ risk: 'medium', effective: false, restorable: true })).toBe(false);
      expect(restoreRequiresSafetyApproval({ risk: 'low', effective: false, restorable: true })).toBe(false);
      expect(restoreRequiresSafetyApproval({ risk: 'high', effective: true, restorable: true })).toBe(false);
      expect(restoreRequiresSafetyApproval({ risk: 'high', effective: false, restorable: false })).toBe(false);
      expect(restoreRequiresSafetyApproval({ risk: null, effective: false, restorable: true })).toBe(false);
    });

    it('只认后端稳定码：别的 409（如 APPROVAL_INVALID）不得被当成"请去申请审批"', () => {
      const axiosLike = (message: string, code?: string) => ({
        message,
        response: { data: { message, ...(code ? { error: { code, message } } : {}) } },
      });
      expect(
        isRestoreApprovalGateError(
          axiosLike('HIGH_RISK_CAPABILITY_RESTORE_REQUIRES_APPROVAL：恢复高风险能力（exo-lift）需安全管理员审批'),
        ),
      ).toBe(true);
      expect(isRestoreApprovalGateError(axiosLike('conflict', 'HIGH_RISK_CAPABILITY_RESTORE_REQUIRES_APPROVAL'))).toBe(true);
      expect(isRestoreApprovalGateError('HIGH_RISK_CAPABILITY_RESTORE_REQUIRES_APPROVAL')).toBe(true);
      expect(isRestoreApprovalGateError(axiosLike('APPROVAL_INVALID：审批对象不是该设备能力'))).toBe(false);
      expect(isRestoreApprovalGateError(axiosLike('HIGH_RISK_CAPABILITY_RELAXATION_REQUIRES_APPROVAL'))).toBe(false);
      expect(isRestoreApprovalGateError(null)).toBe(false);
      expect(isRestoreApprovalGateError({})).toBe(false);
    });

    it('审批状态文案如实说明"还在等谁 / 已通过 / 已驳回"，未知状态不放行', () => {
      expect(
        describeRestoreApprovalStatus('pending', [
          { role: 'safety_admin', status: 'pending' },
          { role: 'workshop_lead', status: 'approved' },
        ]),
      ).toEqual({ approved: false, label: '审批进行中，等待：安全管理员' });
      expect(describeRestoreApprovalStatus('approved', [{ role: 'safety_admin', status: 'approved' }])).toEqual({
        approved: true,
        label: '审批已通过，可执行恢复',
      });
      expect(describeRestoreApprovalStatus('rejected', null).approved).toBe(false);
      expect(describeRestoreApprovalStatus('rejected', null).label).toContain('驳回');
      const unknown = describeRestoreApprovalStatus(null, null);
      expect(unknown.approved).toBe(false);
      expect(unknown.label).toContain('未知');
    });
  });

  // NO-22a：授权有时效、且一次决定只放行一次——三类拒绝的"下一步"必须不同。
  describe('授权时效与消耗（NO-22a）', () => {
    const NOW = Date.parse('2026-09-11T12:00:00.000Z');

    it('时效文案：24 小时内显示剩余时间，超期显示已过期', () => {
      const fresh = describeApprovalFreshness(new Date(NOW - 3 * 3_600_000).toISOString(), NOW);
      expect(fresh.valid).toBe(true);
      expect(fresh.label).toContain('剩余有效期约 21 小时');
      const stale = describeApprovalFreshness(new Date(NOW - 25 * 3_600_000).toISOString(), NOW);
      expect(stale.valid).toBe(false);
      expect(stale.label).toContain('已过期');
      // 缺时间 ≠ 有效（不猜）
      expect(describeApprovalFreshness(null, NOW)).toEqual({
        valid: false,
        label: '缺少通过时间（无法判断时效）',
      });
      expect(describeApprovalFreshness('not-a-date', NOW).valid).toBe(false);
    });

    it('三类拒绝给出不同的下一步（去申请 / 重新申请 / 重新申请）', () => {
      expect(
        describeRestoreRejection('HIGH_RISK_CAPABILITY_RESTORE_REQUIRES_APPROVAL：恢复高风险能力（exo-lift）'),
      ).toMatchObject({ kind: 'approval_required' });
      expect(
        describeRestoreRejection('APPROVAL_INVALID：审批已超出有效期（通过于 2026-09-10，有效期 24 小时）'),
      ).toMatchObject({ kind: 'approval_stale' });
      expect(
        describeRestoreRejection('APPROVAL_INVALID：审批缺少通过时间（无法判断时效）'),
      ).toMatchObject({ kind: 'approval_stale' });
      expect(
        describeRestoreRejection('APPROVAL_ALREADY_CONSUMED：该审批已用于本设备的这次恢复'),
      ).toMatchObject({ kind: 'approval_consumed' });
      expect(describeRestoreRejection('网络错误')).toEqual({ kind: 'other', nextStep: null });
      // axios 形态（后端错误体嵌在 response.data.error）
      expect(
        describeRestoreRejection({
          message: 'Request failed with status code 409',
          response: { data: { error: { code: 'CONFLICT', message: 'APPROVAL_ALREADY_CONSUMED：…' } } },
        }),
      ).toMatchObject({ kind: 'approval_consumed' });
      // 过期/已消耗都要重新申请（不能提示"继续用这个号"）
      expect(describeRestoreRejection('APPROVAL_ALREADY_CONSUMED：x').nextStep).toContain('重新申请');
      expect(describeRestoreRejection('APPROVAL_INVALID：审批已超出有效期').nextStep).toContain('重新申请');
    });
  });
});
