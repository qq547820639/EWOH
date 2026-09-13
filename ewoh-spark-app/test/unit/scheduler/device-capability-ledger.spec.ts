/* 设备能力台账读取与调度消费（NO-14f，ADR-043/ADR-044）。
 *
 * 为什么需要：能力台账（`ewoh_device_capability`）在第 9-10 轮建立后**没有任何
 * 消费方**；而调度侧的能力匹配读的是 `ewoh_device.capabilities` 列——实测该列
 * 全为空（`[]`），于是 `task.requiredDeviceCapabilities ⊆ device.capabilities`
 * 这条约束**永远匹配不到任何设备**。本测试把"台账 → 资源视图 → 调度可读"
 * 这条链钉死：
 *   1. 台账记录按契约形状读出（kind/name/subject/evidence/providerType）；
 *   2. 只收 `status='active'`；非设备 kind 显式记缺口而非静默进能力集；
 *   3. 契约不合法记录记缺口（不进能力集）；
 *   4. 缺租户上下文 → 显式缺口 + 空结果（绝不跨租户读）；
 *   5. 能力优先级：台账 > `ewoh_device.capabilities` 列 > 型号白名单派生。
 */
/// <reference types="jest" />
import {
  DEVICE_CAPABILITY_LEDGER_KINDS,
  deriveDeviceCapabilities,
  loadDeviceCapabilityLedger,
  resolveDeviceCapabilities,
} from '@server/modules/scheduler/device-capabilities';
import { ewohDeviceCapability } from '@server/database/schema';

const ORG = '11111111-1111-4111-8111-111111111111';

function ledgerRow(overrides: Record<string, unknown> = {}) {
  return {
    deviceId: 'ENV-1',
    capabilityId: 'cap:device:env-1:observe.temperature',
    capabilityType: 'device_capability',
    capabilityKey: 'observe.temperature',
    capabilityValue: {
      mode: 'observation',
      label: '环境温度',
      fields: ['temperature'],
      subject: 'device:env-1',
      providerType: 'device',
      evidence: ['temperature'],
    },
    effectiveFrom: new Date('2026-09-10T12:00:00.000Z'),
    ...overrides,
  };
}

function createDb(rows: Array<Record<string, unknown>>, captured: { where?: unknown } = {}) {
  const db = {
    select: jest.fn(() => ({
      from: jest.fn((table: unknown) => {
        if (table !== ewohDeviceCapability) return { where: jest.fn().mockResolvedValue([]) };
        return {
          where: jest.fn((cond: unknown) => {
            captured.where = cond;
            return Promise.resolve(rows);
          }),
        };
      }),
    })),
  };
  return db;
}

describe('设备能力台账读取（loadDeviceCapabilityLedger）', () => {
  it('台账行 → 契约记录 + 名称集（含 subject/evidence/providerType）', async () => {
    const db = createDb([ledgerRow()]);
    const ledgers = await loadDeviceCapabilityLedger(db as never, ORG, ['ENV-1']);
    const entry = ledgers.get('ENV-1');
    expect(entry?.names).toEqual(['observe.temperature']);
    expect(entry?.issues).toEqual([]);
    expect(entry?.records).toEqual([
      expect.objectContaining({
        capabilityId: 'cap:device:env-1:observe.temperature',
        kind: 'device_capability',
        name: 'observe.temperature',
        providerType: 'device',
        subject: 'device:env-1',
        evidence: ['temperature'],
        auditTrail: true,
      }),
    ]);
  });

  it('外骨骼能力（exo_capability）同样进入设备能力集（同一 provider 的能力）', async () => {
    const db = createDb([
      ledgerRow({
        deviceId: 'EXO-1',
        capabilityKey: 'interact.assist',
        capabilityType: 'exo_capability',
        capabilityValue: { providerType: 'exo', subject: 'exo:exo-1', evidence: ['load.assist_level'] },
      }),
    ]);
    const ledgers = await loadDeviceCapabilityLedger(db as never, ORG, ['EXO-1']);
    expect(DEVICE_CAPABILITY_LEDGER_KINDS).toContain('exo_capability');
    expect(ledgers.get('EXO-1')?.names).toEqual(['interact.assist']);
  });

  it('非设备 kind（skill/certification）不进能力集，但显式记缺口', async () => {
    const db = createDb([
      ledgerRow({ capabilityType: 'skill', capabilityKey: 'forklift' }),
      ledgerRow(),
    ]);
    const ledgers = await loadDeviceCapabilityLedger(db as never, ORG, ['ENV-1']);
    const entry = ledgers.get('ENV-1');
    expect(entry?.names).toEqual(['observe.temperature']);
    expect(entry?.issues).toEqual(['capability_ledger_unexpected_kind:skill:forklift']);
  });

  it('契约不合法记录记缺口且不进能力集（subject 形状非法）', async () => {
    const db = createDb([
      ledgerRow({ capabilityValue: { subject: 'not-a-subject', providerType: 'device' } }),
    ]);
    const ledgers = await loadDeviceCapabilityLedger(db as never, ORG, ['ENV-1']);
    const entry = ledgers.get('ENV-1');
    expect(entry?.names).toEqual([]);
    expect(entry?.issues[0]).toContain('capability_ledger_invalid');
  });

  it('缺租户上下文 → 显式缺口 + 空结果（绝不跨租户读）', async () => {
    const db = createDb([ledgerRow()]);
    const ledgers = await loadDeviceCapabilityLedger(db as never, '', ['ENV-1']);
    expect(ledgers.get('ENV-1')).toEqual({
      names: [],
      records: [],
      issues: ['capability_ledger_missing_org'],
      disabledNames: [],
      disabledLifecycle: [],
    });
    // 没有租户就不该发起查询
    expect(db.select).not.toHaveBeenCalled();
  });

  it('无设备 id → 空结果且不查询', async () => {
    const db = createDb([ledgerRow()]);
    const ledgers = await loadDeviceCapabilityLedger(db as never, ORG, []);
    expect(ledgers.size).toBe(0);
    expect(db.select).not.toHaveBeenCalled();
  });

  it('型号白名单派生仍作为最后兜底（未命中返回空，不误判）', () => {
    expect(deriveDeviceCapabilities('NyExo-A1 Pro')).toContain('exo-lift');
    expect(deriveDeviceCapabilities('ENV-SIM-1')).toEqual([]);
    expect(deriveDeviceCapabilities(null)).toEqual([]);
  });
});


describe('设备能力解析优先级（resolveDeviceCapabilities）', () => {
  const ledger = {
    names: ['observe.temperature'],
    records: [
      {
        capabilityId: 'cap:device:env-1:observe.temperature',
        kind: 'device_capability',
        name: 'observe.temperature',
        providerType: 'device',
        subject: 'device:ENV-1',
        evidence: ['temperature'],
        auditTrail: true,
      },
    ],
    issues: [], disabledNames: [], disabledLifecycle: [],
  };

  it('台账只含观测能力 → capabilities 为空（传感器不能执行任务，诚实）', () => {
    const resolved = resolveDeviceCapabilities({
      ledger,
      columnCapabilities: [],
      deviceModel: null,
    });
    expect(resolved.capabilities).toEqual([]);
    expect(resolved.observedCapabilities).toEqual(['observe.temperature']);
    expect(resolved.capabilityRecords).toHaveLength(1);
    expect(resolved.derivedFromModelWhitelist).toBe(false);
  });

  /* NO-14g 回归：台账目前只声明观测/交互维度。若把它当"覆盖"用，外骨骼的
   * 执行能力 `exo-lift`（来自型号白名单/列）会被抹掉，于是所有需要助力能力的
   * 任务永远无候选 → golden 路径派工失败（2026-09-10 实测）。执行能力必须取并集。 */
  it('执行能力 = 台账执行/交互 ∪ 列 ∪ 型号白名单（观测能力不挤掉 exo-lift）', () => {
    const resolved = resolveDeviceCapabilities({
      ledger: {
        names: ['observe.load', 'observe.battery', 'interact.assist'],
        records: [],
        issues: [], disabledNames: [], disabledLifecycle: [],
      },
      columnCapabilities: [],
      deviceModel: 'NyExo-A1 Pro',
    });
    expect(resolved.capabilities).toEqual(['exo-lift', 'interact.assist']);
    expect(resolved.observedCapabilities).toEqual(['observe.battery', 'observe.load']);
    // 台账已与列/白名单合并，不能因为"并集里含白名单项"就标记成纯派生
    expect(resolved.derivedFromModelWhitelist).toBe(false);
  });

  /* 人工决定优先于自动来源：型号白名单与列都只是"猜测/声明"，
   * 人明确停用过的能力必须从可用集里减掉——否则"停用"会被白名单悄悄加回来，
   * 现场以为已停用，调度却照旧按该能力派工（2026-09-11 e2e 实测）。 */
  it('人工停用优先于型号白名单与列（disabled 必须从可用集减掉）', () => {
    const resolved = resolveDeviceCapabilities({
      ledger: {
        names: [],
        records: [],
        issues: [],
        disabledNames: ['exo-lift'],
        disabledLifecycle: [
          { name: 'exo-lift', operator: 'admin', reason: '助力模块待修', at: '2026-09-11T02:00:00.000Z' },
        ],
      },
      columnCapabilities: ['exo-lift', 'vacuum'],
      deviceModel: 'NyExo-A1 Pro',
    });
    expect(resolved.capabilities).not.toContain('exo-lift');
    expect(resolved.capabilities).toContain('vacuum');
    expect(resolved.disabledCapabilities).toEqual(['exo-lift']);

    // 型号白名单单独提供时同样被减掉（列空 → 白名单兜底，但停用优先）
    const whitelistOnly = resolveDeviceCapabilities({
      ledger: {
        names: [],
        records: [],
        issues: [],
        disabledNames: ['exo-lift'],
        disabledLifecycle: [],
      },
      columnCapabilities: [],
      deviceModel: 'NyExo-A1 Pro',
    });
    expect(whitelistOnly.capabilities).not.toContain('exo-lift');
  });

  it('停用也作用于观测能力（观测集同样要减掉）', () => {
    const resolved = resolveDeviceCapabilities({
      ledger: {
        names: [],
        records: [],
        issues: [],
        disabledNames: ['observe.temperature'],
        disabledLifecycle: [],
      },
      columnCapabilities: [],
      deviceModel: null,
    });
    expect(resolved.observedCapabilities).toEqual([]);
    expect(resolved.capabilities).toEqual([]);
  });

  it('列与台账同名能力去重（并集不产生重复项）', () => {
    const resolved = resolveDeviceCapabilities({
      ledger: { names: ['interact.assist'], records: [], issues: [], disabledNames: [], disabledLifecycle: [] },
      columnCapabilities: ['interact.assist', 'exo-lift'],
      deviceModel: 'NyExo-A1',
    });
    expect(resolved.capabilities).toEqual(['exo-lift', 'interact.assist']);
  });

  /* 安全相关：显式登记的执行能力列非空时，型号字符串的猜测必须让位。
   * 型号里带 'exo' 的起重机若被补上 `exo-lift`，会被派去干助力的活。 */
  it('列非空 = 权威声明：型号白名单不参与（显式声明不被猜测稀释）', () => {
    const resolved = resolveDeviceCapabilities({
      ledger: { names: [], records: [], issues: [], disabledNames: [], disabledLifecycle: [] },
      columnCapabilities: ['crane'],
      deviceModel: 'NyExo-A1 Pro 吊装',
    });
    expect(resolved.capabilities).toEqual(['crane']);
    expect(resolved.derivedFromModelWhitelist).toBe(false);
  });

  it('列非空但仍与台账执行/交互能力取并集（两个显式来源不互相覆盖）', () => {
    const resolved = resolveDeviceCapabilities({
      ledger: { names: ['interact.assist'], records: [], issues: [], disabledNames: [], disabledLifecycle: [] },
      columnCapabilities: ['crane'],
      deviceModel: 'NyExo-A1 Pro',
    });
    expect(resolved.capabilities).toEqual(['crane', 'interact.assist']);
  });

  it('词表外能力名保守归入执行侧（可能正是调度要匹配的名字）', () => {
    const resolved = resolveDeviceCapabilities({
      ledger: { names: ['legacy.vacuum'], records: [], issues: [], disabledNames: [], disabledLifecycle: [] },
      columnCapabilities: [],
      deviceModel: null,
    });
    expect(resolved.capabilities).toEqual(['legacy.vacuum']);
    expect(resolved.observedCapabilities).toEqual([]);
  });

  /* NO-15b：缺失 ≠ 停用。被人工停用的能力必须作为**事实**保留下来
   * （否则解释会把"人停了它"误报成"设备没有这个能力"）。 */
  it('人工停用的能力不进可用集，但作为事实保留（含谁/何时/为什么）', async () => {
    const db = createDb([
      ledgerRow(),
      ledgerRow({
        capabilityKey: 'observe.vibration',
        capabilityId: 'cap:device:env-1:observe.vibration',
        status: 'disabled',
        capabilityValue: {
          mode: 'observation',
          label: '振动',
          fields: ['vibration'],
          subject: 'device:env-1',
          providerType: 'device',
          evidence: ['vibration'],
          lifecycle: {
            action: 'disable',
            operator: 'admin',
            reason: '现场核对：该传感器未安装',
            at: '2026-09-11T02:00:00.000Z',
            previousStatus: 'active',
          },
        },
      }),
    ]);
    const ledgers = await loadDeviceCapabilityLedger(db as never, ORG, ['ENV-1']);
    const entry = ledgers.get('ENV-1');
    // 可用能力只有 active 的那一个
    expect(entry?.names).toEqual(['observe.temperature']);
    expect(entry?.records.map((r) => r.name)).toEqual(['observe.temperature']);
    // 停用事实保留（名称 + 留痕）
    expect(entry?.disabledNames).toEqual(['observe.vibration']);
    expect(entry?.disabledLifecycle).toEqual([
      {
        name: 'observe.vibration',
        operator: 'admin',
        reason: '现场核对：该传感器未安装',
        at: '2026-09-11T02:00:00.000Z',
      },
    ]);
  });

  it('停用留痕形状不全 → 名称仍保留，留痕字段为 null（不半截渲染）', async () => {
    const db = createDb([
      ledgerRow({
        capabilityKey: 'observe.noise',
        capabilityId: 'cap:device:env-1:observe.noise',
        status: 'disabled',
        capabilityValue: {
          mode: 'observation',
          subject: 'device:env-1',
          providerType: 'device',
          lifecycle: { action: 'disable' },
        },
      }),
    ]);
    const entry = (await loadDeviceCapabilityLedger(db as never, ORG, ['ENV-1'])).get('ENV-1');
    expect(entry?.disabledNames).toEqual(['observe.noise']);
    expect(entry?.disabledLifecycle[0]).toEqual({
      name: 'observe.noise',
      operator: null,
      reason: null,
      at: null,
    });
  });

  it('解析结果透出停用事实（无停用则不带该字段，保持载荷精简）', () => {
    const withDisabled = resolveDeviceCapabilities({
      ledger: {
        names: ['observe.temperature'],
        records: [],
        issues: [],
        disabledNames: ['observe.vibration'],
        disabledLifecycle: [
          { name: 'observe.vibration', operator: 'admin', reason: '未安装', at: '2026-09-11T02:00:00.000Z' },
        ],
      },
      columnCapabilities: [],
      deviceModel: null,
    });
    expect(withDisabled.capabilities).toEqual([]);
    expect(withDisabled.disabledCapabilities).toEqual(['observe.vibration']);

    const withoutDisabled = resolveDeviceCapabilities({
      ledger: { names: [], records: [], issues: [], disabledNames: [], disabledLifecycle: [] },
      columnCapabilities: [],
      deviceModel: null,
    });
    expect(withoutDisabled.disabledCapabilities).toBeUndefined();
  });

  it('台账为空 → 回落到 ewoh_device.capabilities 列', () => {
    const resolved = resolveDeviceCapabilities({
      ledger: { names: [], records: [], issues: [], disabledNames: [], disabledLifecycle: [] },
      columnCapabilities: ['exo-lift'],
      deviceModel: 'NyExo-A1',
    });
    expect(resolved.capabilities).toEqual(['exo-lift']);
    expect(resolved.derivedFromModelWhitelist).toBe(false);
  });

  it('台账与列都为空 → 型号白名单兜底（显式标记 derived）', () => {
    const resolved = resolveDeviceCapabilities({
      ledger: { names: [], records: [], issues: [], disabledNames: [], disabledLifecycle: [] },
      columnCapabilities: [],
      deviceModel: 'NyExo-A1 Pro',
    });
    expect(resolved.capabilities).toEqual(['exo-lift']);
    expect(resolved.derivedFromModelWhitelist).toBe(true);
  });

  it('台账缺口随解析结果透出（任何优先级下都不静默）', () => {
    const resolved = resolveDeviceCapabilities({
      ledger: { names: [], records: [], issues: ['capability_ledger_unexpected_kind:skill:forklift'], disabledNames: [], disabledLifecycle: [] },
      columnCapabilities: [],
      deviceModel: null,
    });
    expect(resolved.capabilities).toEqual([]);
    expect(resolved.capabilityLedgerIssues).toEqual(['capability_ledger_unexpected_kind:skill:forklift']);
  });
});
