/* ERP/MES 能力主数据导入适配器测试（NO-26a）。
 *
 * 这个适配器是外部系统进入平台的**唯一批量写入口**，因此每条安全语义都必须钉死：
 *   1. 未知来源 / 缺 sourceRef / 空 declarations / 超量 → 显式拒绝（fail-closed）；
 *   2. 字段缺失不猜（可用 fieldMap 指定外部字段名）；
 *   3. 设备必须在**本租户**台账内（外部系统不能凭空造设备）；
 *   4. 能力名必须在词表内，词表外给出"疑似笔误"；
 *   5. **人工停用永远优先**（导入不复活，如实回报谁/何时/为何停用）；
 *   6. 幂等：同一 source+sourceRef 重复导入 → unchanged（不重复写、不重复审计失真）；
 *   7. dry-run 只预览不写库，但仍完整跑校验与冲突判定；
 *   8. 所有路径都写审计（preview 也留痕，且明确标注 dryRun）。
 */
/// <reference types="jest" />
import { BadRequestException, UnauthorizedException } from '@nestjs/common';
import { MasterDataImportService } from '@server/modules/master-data/master-data-import.service';
import { ewohDevice, ewohDeviceCapability } from '@server/database/schema';

const ORG = '11111111-1111-4111-8111-111111111111';
const ACTOR = { userId: 'device.ops', primaryOrgId: ORG, roles: ['device_ops'] } as never;

interface MockOptions {
  devices?: string[];
  /** deviceId → deviceCategory（类别一致性提示用）。 */
  categories?: Record<string, string>;
  ledger?: Array<Record<string, unknown>>;
}

function createDbMock(opts: MockOptions = {}) {
  const inserts: Array<Record<string, unknown>> = [];
  const conflicts: Array<Record<string, unknown>> = [];
  const db = {
    select: jest.fn(() => ({
      from: jest.fn((table: unknown) => ({
        where: jest.fn(() => {
          if (table === ewohDevice) {
            return Promise.resolve(
              (opts.devices ?? []).map((deviceId) => ({
                deviceId,
                deviceCategory: opts.categories?.[deviceId] ?? null,
              })),
            );
          }
          return Promise.resolve(opts.ledger ?? []);
        }),
      })),
    })),
    insert: jest.fn(() => ({
      values: jest.fn((values: Record<string, unknown>) => {
        inserts.push(values);
        return {
          onConflictDoUpdate: jest.fn((input: Record<string, unknown>) => {
            conflicts.push(input);
            return Promise.resolve();
          }),
        };
      }),
    })),
  };
  return { db, inserts, conflicts };
}

const auditMock = () => ({ appendAuditLog: jest.fn(async () => undefined) });

function service(opts: MockOptions = {}) {
  const { db, inserts, conflicts } = createDbMock(opts);
  const audit = auditMock();
  return {
    svc: new MasterDataImportService(db as never, audit as never),
    inserts,
    conflicts,
    audit,
  };
}

const declaration = (deviceId: string, capabilityKey: string) => ({ deviceId, capabilityKey });

describe('主数据导入 · 输入 fail-closed', () => {
  it('缺 org 上下文 → 401（不接受全局导入）', async () => {
    const { svc } = service();
    await expect(
      svc.importCapabilities({ source: 'erp', sourceRef: 'X', declarations: [declaration('D-1', 'exo-lift')] }, undefined),
    ).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('未知来源 → 400（来源是封闭注册表，防止伪造 ERP 行）', async () => {
    const { svc } = service();
    await expect(
      svc.importCapabilities(
        { source: 'excel_macro', sourceRef: 'X', declarations: [declaration('D-1', 'exo-lift')] },
        ACTOR,
      ),
    ).rejects.toThrow(/source 必须是已登记来源/);
  });

  it('缺 sourceRef → 400（幂等与追溯都依赖它）', async () => {
    const { svc } = service();
    await expect(
      svc.importCapabilities({ source: 'erp', declarations: [declaration('D-1', 'exo-lift')] }, ACTOR),
    ).rejects.toThrow(/sourceRef 必填/);
  });

  it('空数组 / 超量 → 400（不静默接受空批次，也不让一次请求拖垮写路径）', async () => {
    const { svc } = service();
    await expect(
      svc.importCapabilities({ source: 'erp', sourceRef: 'X', declarations: [] }, ACTOR),
    ).rejects.toThrow(/非空数组/);
    await expect(
      svc.importCapabilities(
        {
          source: 'erp',
          sourceRef: 'X',
          declarations: Array.from({ length: 501 }, (_, i) => declaration(`D-${i}`, 'exo-lift')),
        },
        ACTOR,
      ),
    ).rejects.toThrow(/最多 500 条/);
  });
});

describe('主数据导入 · 逐行判定', () => {
  it('新声明 → applied，写入台账并带来源（channel/source/sourceRef/importedAt/importedBy）', async () => {
    const { svc, inserts, audit } = service({ devices: ['EXO-1'] });
    const result = await svc.importCapabilities(
      { source: 'erp', sourceRef: 'BATCH-1', declarations: [declaration('EXO-1', 'exo-lift')] },
      ACTOR,
      { at: new Date('2026-09-12T10:00:00.000Z') },
    );

    expect(result.totals).toMatchObject({ declarations: 1, applied: 1, updated: 0, unchanged: 0 });
    expect(result.rows[0]).toMatchObject({ outcome: 'applied', detail: expect.stringContaining('主数据导入') });
    expect(inserts).toHaveLength(1);
    expect(inserts[0]).toMatchObject({ orgId: ORG, deviceId: 'EXO-1', capabilityKey: 'exo-lift', status: 'active' });
    expect((inserts[0].capabilityValue as Record<string, unknown>).provenance).toMatchObject({
      channel: 'master_data',
      source: 'erp',
      sourceRef: 'BATCH-1',
      importedBy: 'device.ops',
    });
    expect(audit.appendAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'master_data.capability.import', orgId: ORG }),
    );
  });

  it('人工停用的能力**绝不**被导入复活，并回报停用留痕（原则 4/7）', async () => {
    const { svc, inserts, conflicts } = service({
      devices: ['EXO-1'],
      ledger: [
        {
          deviceId: 'EXO-1',
          capabilityKey: 'exo-lift',
          status: 'disabled',
          capabilityValue: {
            lifecycle: { action: 'disable', operator: 'admin', reason: '助力模块待检修', at: '2026-09-11T08:00:00.000Z' },
          },
        },
      ],
    });
    const result = await svc.importCapabilities(
      { source: 'erp', sourceRef: 'BATCH-2', declarations: [declaration('EXO-1', 'exo-lift')] },
      ACTOR,
    );

    expect(result.rows[0].outcome).toBe('skipped_human_disabled');
    expect(result.rows[0].detail).toContain('admin');
    expect(result.rows[0].detail).toContain('助力模块待检修');
    expect(result.warnings.join(' ')).toContain('主数据不得覆盖人工安全决定');
    // 一行都不写（既不 insert 也不 update）
    expect(inserts).toHaveLength(0);
    expect(conflicts).toHaveLength(0);
  });

  it('词表外能力名 → skipped + 疑似笔误提示；设备不在台账 → skipped（不创建设备）', async () => {
    const { svc, inserts } = service({ devices: ['EXO-1'] });
    const result = await svc.importCapabilities(
      {
        source: 'mes',
        sourceRef: 'BATCH-3',
        declarations: [declaration('EXO-1', 'exo_lift'), declaration('GHOST-1', 'exo-lift')],
      },
      ACTOR,
    );

    expect(result.rows[0]).toMatchObject({ outcome: 'skipped_unknown_capability' });
    expect(result.rows[0].detail).toContain('是否指 exo-lift');
    expect(result.rows[1]).toMatchObject({ outcome: 'skipped_unknown_device' });
    expect(inserts).toHaveLength(0);
    expect(result.warnings).toHaveLength(2);
  });

  it('幂等：同一 source+sourceRef 重复导入 → unchanged（不重复写）', async () => {
    const { svc, inserts, conflicts } = service({
      devices: ['EXO-1'],
      ledger: [
        {
          deviceId: 'EXO-1',
          capabilityKey: 'exo-lift',
          status: 'active',
          capabilityValue: { provenance: { channel: 'master_data', source: 'erp', sourceRef: 'BATCH-4' } },
        },
      ],
    });
    const result = await svc.importCapabilities(
      { source: 'erp', sourceRef: 'BATCH-4', declarations: [declaration('EXO-1', 'exo-lift')] },
      ACTOR,
    );

    expect(result.rows[0].outcome).toBe('unchanged');
    expect(inserts).toHaveLength(0);
    expect(conflicts).toHaveLength(0);
  });

  it('能力超出设备类别的标准能力集 → 写入但明确提示核对主数据（非阻断）', async () => {
    const { svc } = service({ devices: ['CAM-1'], categories: { 'CAM-1': 'camera' } });
    const result = await svc.importCapabilities(
      { source: 'erp', sourceRef: 'BATCH-CAT', declarations: [declaration('CAM-1', 'vacuum')] },
      ACTOR,
    );
    expect(result.rows[0].outcome).toBe('applied');
    expect(result.rows[0].detail).toContain('不在设备类别「camera」的标准能力集内');
    expect(result.warnings.join(' ')).toContain('超出设备类别的标准能力集');
  });

  it('同设备已有其它来源的声明 → updated（刷新来源与描述，状态保持原值）', async () => {
    const { svc, inserts, conflicts } = service({
      devices: ['EXO-1'],
      ledger: [
        {
          deviceId: 'EXO-1',
          capabilityKey: 'exo-lift',
          status: 'active',
          capabilityValue: { provenance: { channel: 'ingest', source: 'edge', sourceRef: 'auto' } },
        },
      ],
    });
    const result = await svc.importCapabilities(
      { source: 'erp', sourceRef: 'BATCH-5', declarations: [declaration('EXO-1', 'exo-lift')] },
      ACTOR,
    );

    expect(result.rows[0].outcome).toBe('updated');
    expect(inserts).toHaveLength(1);
    expect(conflicts).toHaveLength(1);
    // 冲突更新**不得**触碰 status（否则人工停用会被导入复活）
    const setClause = (conflicts[0] as { set: Record<string, unknown> }).set;
    expect(setClause).not.toHaveProperty('status');
  });

  it('字段映射：外部字段名不叫 deviceId/capabilityKey 时用 fieldMap；缺字段如实跳过', async () => {
    const { svc } = service({ devices: ['EXO-1'] });
    const mapped = await svc.importCapabilities(
      {
        source: 'mes',
        sourceRef: 'BATCH-6',
        fieldMap: { deviceId: 'EquipmentCode', capabilityKey: 'AbilityCode' },
        declarations: [
          { EquipmentCode: 'EXO-1', AbilityCode: 'exo-lift' },
          { EquipmentCode: 'EXO-1' },
        ],
      },
      ACTOR,
    );

    expect(mapped.rows[0]).toMatchObject({ deviceId: 'EXO-1', capabilityKey: 'exo-lift', outcome: 'applied' });
    expect(mapped.rows[1]).toMatchObject({ outcome: 'skipped_missing_field' });
    expect(mapped.rows[1].detail).toContain('AbilityCode');
  });
});

describe('主数据导入 · dry-run 与审计', () => {
  it('dry-run 不写库，但结果与审计预览留痕（dryRun=true 明确标注）', async () => {
    const { svc, inserts, conflicts, audit } = service({ devices: ['EXO-1'] });
    const result = await svc.importCapabilities(
      { source: 'erp', sourceRef: 'BATCH-7', declarations: [declaration('EXO-1', 'exo-lift')] },
      ACTOR,
      { dryRun: true },
    );

    expect(result.dryRun).toBe(true);
    expect(result.totals.applied).toBe(1); // 预览说清"会新增 1 条"
    expect(inserts).toHaveLength(0);
    expect(conflicts).toHaveLength(0);
    expect(audit.appendAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'master_data.capability.import.preview',
        metadata: expect.objectContaining({ dryRun: true, source: 'erp', sourceRef: 'BATCH-7' }),
      }),
    );
  });

  it('未知来源在 dry-run 同样被拒（预览不是绕过校验的通道）', async () => {
    const { svc } = service();
    await expect(
      svc.importCapabilities(
        { source: 'unknown', sourceRef: 'X', declarations: [declaration('D-1', 'exo-lift')] },
        ACTOR,
        { dryRun: true },
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
  });
});
