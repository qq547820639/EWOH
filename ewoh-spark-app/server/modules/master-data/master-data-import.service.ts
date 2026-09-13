import {
  BadRequestException,
  Inject,
  Injectable,
  Logger,
  UnauthorizedException,
} from '@nestjs/common';
import { DRIZZLE_DATABASE, type PostgresJsDatabase } from '@lark-apaas/fullstack-nestjs-core';
import { and, eq, inArray } from 'drizzle-orm';
import { ewohDevice, ewohDeviceCapability } from '@server/database/schema';
import { AuditService } from '../shared/audit.service';
import type { OrgContext } from '../shared/org-context.interceptor';
import { DEVICE_CAPABILITY_SPECS, capabilitiesForCategory, toCapabilityRecord } from '@shared/device-capability';
import { suggestSimilarCapabilityNames } from '@shared/capability-requirements';
import { validateCapability } from '@shared/capability';

/**
 * ERP / MES 能力主数据导入适配器（NO-26a）。
 *
 * 为什么需要它：设备"能做什么"目前只有两条来源——自动化摄入（按类别推导）与人工
 * 单点登记/停用。真实工厂里这份清单通常来自 **ERP/MES 主数据**（设备台账、工位
 * 能力表），而现场既不可能逐台手点，也不应该让外部系统直接写库。本适配器提供一条
 * **受控的批量入口**：
 *
 *   1. 只接受**已登记**的能力名（词表外的名称拒绝写入，并给出"疑似笔误"建议）；
 *   2. 只处理**本租户已存在**的设备（外部系统不能凭空造设备）；
 *   3. 写入前逐条过权威能力契约（kind/providerType/subject/evidence fail-closed）；
 *   4. **人工停用永远优先**：外部导入不会把被人工停用的能力复活（原则 4/7），
 *      而是如实报告"跳过：该能力已被人为停用（谁/何时/为何）"；
 *   5. 幂等：同一来源（source + sourceRef）重复导入 → `unchanged`，不重复写、
 *      不重复审计失真；
 *   6. **dry-run**：先看"会发生什么"再决定是否落库（原则 5：影响面可见）；
 *   7. 全过程审计（含 dry-run 预览），并保留来源（channel/source/sourceRef/importedAt/
 *      importedBy），使台账每一行都能回答"这是谁在什么时候从哪个系统带进来的"。
 */

/** 允许的来源系统（封闭注册表：未知来源 fail-closed，防止"有人手工伪造 ERP 行"）。 */
export const MASTER_DATA_SOURCES = ['erp', 'mes', 'wms', 'manual_file'] as const;
export type MasterDataSource = (typeof MASTER_DATA_SOURCES)[number];

/** 单次导入的声明条数上限（防止一次请求拖垮写路径）。 */
export const MAX_IMPORT_DECLARATIONS = 500;

export interface MasterDataDeclarationInput {
  deviceId?: unknown;
  capabilityKey?: unknown;
}

/** 外部系统字段名映射（ERP/MES 字段命名五花八门，映射由调用方显式给出）。 */
export interface MasterDataFieldMap {
  deviceId?: string;
  capabilityKey?: string;
}

export interface MasterDataImportInput {
  source?: unknown;
  sourceRef?: unknown;
  declarations?: unknown;
  fieldMap?: MasterDataFieldMap | null;
}

export type MasterDataRowOutcome =
  | 'applied'
  | 'updated'
  | 'unchanged'
  | 'skipped_human_disabled'
  | 'skipped_unknown_device'
  | 'skipped_unknown_capability'
  | 'skipped_contract_violation'
  | 'skipped_missing_field';

export interface MasterDataRowResult {
  deviceId: string;
  capabilityKey: string;
  outcome: MasterDataRowOutcome;
  /** 现场可读说明（为什么跳过/改了什么）。 */
  detail: string;
}

export interface MasterDataImportResult {
  source: MasterDataSource;
  sourceRef: string;
  dryRun: boolean;
  importedAt: string;
  importedBy: string;
  totals: Record<MasterDataRowOutcome, number> & { declarations: number };
  rows: MasterDataRowResult[];
  /** 面向现场的提示（如"3 条被跳过：责任在人不在系统"）。 */
  warnings: string[];
}

@Injectable()
export class MasterDataImportService {
  private readonly logger = new Logger(MasterDataImportService.name);

  constructor(
    @Inject(DRIZZLE_DATABASE) private readonly db: PostgresJsDatabase,
    private readonly auditService: AuditService,
  ) {}

  private requireOrgId(actor?: OrgContext): string {
    const orgId = actor?.primaryOrgId?.trim();
    if (!orgId) {
      throw new UnauthorizedException('org 上下文缺失：主数据导入必须带租户上下文');
    }
    return orgId;
  }

  private requireSource(raw: unknown): MasterDataSource {
    const source = String(raw ?? '').trim().toLowerCase();
    if (!(MASTER_DATA_SOURCES as readonly string[]).includes(source)) {
      throw new BadRequestException(
        `source 必须是已登记来源之一（${MASTER_DATA_SOURCES.join(' / ')}）；收到「${String(raw ?? '')}」`,
      );
    }
    return source as MasterDataSource;
  }

  /**
   * 字段映射：把外部行转成 `{deviceId, capabilityKey}`。
   *
   * 缺字段**不猜**（不做"取第一个字符串"之类的启发式）：如实记为
   * `skipped_missing_field`，让对接方去修数据。
   */
  private mapDeclaration(
    raw: unknown,
    fieldMap: MasterDataFieldMap | null | undefined,
    index: number,
  ): { deviceId: string; capabilityKey: string } | { missing: MasterDataRowResult } {
    const deviceField = fieldMap?.deviceId?.trim() || 'deviceId';
    const capabilityField = fieldMap?.capabilityKey?.trim() || 'capabilityKey';
    const record = (raw ?? {}) as Record<string, unknown>;
    const deviceId = String(record[deviceField] ?? '').trim();
    const capabilityKey = String(record[capabilityField] ?? '').trim();
    if (!deviceId || !capabilityKey) {
      return {
        missing: {
          deviceId: deviceId || `(第 ${index + 1} 行)`,
          capabilityKey: capabilityKey || '—',
          outcome: 'skipped_missing_field',
          detail: `缺少字段 ${!deviceId ? deviceField : capabilityField}（外部字段名可用 fieldMap 指定）`,
        },
      };
    }
    return { deviceId, capabilityKey };
  }

  /**
   * 预览/执行导入。
   *
   * `dryRun=true` 时**不写任何库**，但仍完整跑一遍校验与冲突判定，返回同样的
   * 逐行结果——现场据此判断"这批主数据会不会覆盖人工决定"。
   */
  async importCapabilities(
    input: MasterDataImportInput,
    actor: OrgContext | undefined,
    options: { dryRun?: boolean; at?: Date } = {},
  ): Promise<MasterDataImportResult> {
    const orgId = this.requireOrgId(actor);
    const source = this.requireSource(input.source);
    const sourceRef = String(input.sourceRef ?? '').trim();
    if (!sourceRef) {
      throw new BadRequestException('sourceRef 必填（外部系统的批次号/单据号，用于幂等与追溯）');
    }
    if (!Array.isArray(input.declarations) || input.declarations.length === 0) {
      throw new BadRequestException('declarations 必须为非空数组');
    }
    if (input.declarations.length > MAX_IMPORT_DECLARATIONS) {
      throw new BadRequestException(
        `单次导入最多 ${MAX_IMPORT_DECLARATIONS} 条声明（收到 ${input.declarations.length}）；请分批`,
      );
    }
    const at = options.at ?? new Date();
    const dryRun = options.dryRun === true;
    const importedBy = (actor?.userId ?? '').trim() || 'system';

    // 1) 字段映射 + 形状校验（不猜字段）
    const mapped: Array<{ index: number; deviceId: string; capabilityKey: string }> = [];
    // 结果按**输入顺序**回填：对接方拿到的 rows 与它交上来的清单逐行对应，
    // 否则"第 7 行被跳过"这类结论无法与源文件对齐（实测踩过）。
    const rowResults: Array<MasterDataRowResult | null> = new Array(
      input.declarations.length,
    ).fill(null);
    input.declarations.forEach((declaration, index) => {
      const result = this.mapDeclaration(declaration, input.fieldMap, index);
      if ('missing' in result) rowResults[index] = result.missing;
      else mapped.push({ index, ...result });
    });

    // 2) 设备存在性（本租户内；外部系统不能凭空造设备）
    const deviceIds = [...new Set(mapped.map((m) => m.deviceId))];
    const deviceRows = deviceIds.length > 0
      ? await this.db
          .select({ deviceId: ewohDevice.deviceId, deviceCategory: ewohDevice.deviceCategory })
          .from(ewohDevice)
          .where(and(eq(ewohDevice.orgId, orgId), inArray(ewohDevice.deviceId, deviceIds)))
      : [];
    const knownDevices = new Set(deviceRows.map((row) => String(row.deviceId)));
    const categoryByDevice = new Map(
      deviceRows.map((row) => [String(row.deviceId), (row.deviceCategory ?? '') as string]),
    );

    // 3) 现有人工决定（停用/留痕）与既有行：人工停用优先，导入绝不复活
    const ledgerRows = deviceIds.length > 0
      ? await this.db
          .select()
          .from(ewohDeviceCapability)
          .where(and(eq(ewohDeviceCapability.orgId, orgId), inArray(ewohDeviceCapability.deviceId, deviceIds)))
      : [];
    const ledgerIndex = new Map<string, (typeof ledgerRows)[number]>();
    for (const row of ledgerRows) {
      ledgerIndex.set(`${row.deviceId}::${row.capabilityKey}`, row);
    }

    const writes: Array<{ deviceId: string; capabilityKey: string; specKey: string }> = [];
    /** 超出设备类别标准能力集的声明（**结构化计数**，不靠匹配提示文案）。 */
    const outsideCategoryRows: string[] = [];
    for (const declaration of mapped) {
      const { deviceId, capabilityKey } = declaration;
      const push = (row: MasterDataRowResult) => {
        rowResults[declaration.index] = row;
      };
      if (!knownDevices.has(deviceId)) {
        push({
          deviceId,
          capabilityKey,
          outcome: 'skipped_unknown_device',
          detail: '本租户没有该设备（主数据导入不创建设备，请先在台账登记）',
        });
        continue;
      }
      const spec = DEVICE_CAPABILITY_SPECS[capabilityKey];
      if (!spec) {
        const similar = suggestSimilarCapabilityNames(capabilityKey, Object.keys(DEVICE_CAPABILITY_SPECS));
        push({
          deviceId,
          capabilityKey,
          outcome: 'skipped_unknown_capability',
          detail:
            `能力名不在词表内（开放词表只接受已登记名称）` +
            (similar.length > 0 ? `；疑似笔误：是否指 ${similar.join(' / ')}？` : ''),
        });
        continue;
      }
      const existing = ledgerIndex.get(`${deviceId}::${capabilityKey}`);
      if (existing && String(existing.status) !== 'active') {
        const lifecycle = (existing.capabilityValue ?? {}) as { lifecycle?: Record<string, unknown> };
        const operator = lifecycle.lifecycle?.operator ?? '未知操作人';
        const reason = lifecycle.lifecycle?.reason ?? '未记录理由';
        const when = lifecycle.lifecycle?.at ?? '时间未记录';
        push({
          deviceId,
          capabilityKey,
          outcome: 'skipped_human_disabled',
          detail: `该能力已被人为停用（${operator} · ${when} · ${reason}）：导入不覆盖人工决定，如需恢复请走审批`,
        });
        continue;
      }
      const existingProvenance = existing
        ? ((existing.capabilityValue ?? {}) as { provenance?: Record<string, unknown> }).provenance
        : null;
      const sameProvenance =
        existingProvenance?.channel === 'master_data' &&
        String(existingProvenance?.source ?? '') === source &&
        String(existingProvenance?.sourceRef ?? '') === sourceRef;
      if (existing && sameProvenance) {
        push({
          deviceId,
          capabilityKey,
          outcome: 'unchanged',
          detail: `同一批次（${source}:${sourceRef}）已导入过：不重复写入`,
        });
        continue;
      }
      // 4) 权威契约校验（fail-closed：不合规就不写）
      const record = toCapabilityRecord({
        deviceId,
        category: spec.providerType === 'exo' ? 'exoskeleton' : null,
        name: capabilityKey,
        mode: spec.mode,
        label: spec.label,
        fields: spec.fields,
        grantedAt: at.toISOString(),
      });
      const errors = validateCapability(record);
      if (errors.length > 0) {
        push({
          deviceId,
          capabilityKey,
          outcome: 'skipped_contract_violation',
          detail: `能力记录违反权威契约（拒绝写入）：${errors.join(', ')}`,
        });
        continue;
      }
      writes.push({ deviceId, capabilityKey, specKey: capabilityKey });
      // 非阻断提示（原则 5）：该能力不在设备类别的标准能力集内时，大概率是主数据错误
      // （例如给摄像头声明 vacuum）。不阻断——主数据可能确实为特殊设备做了扩展——
      // 但必须让操作员看见，而不是悄悄写进去。
      const standardKeys = capabilitiesForCategory(categoryByDevice.get(deviceId));
      const outsideCategory = standardKeys.length > 0 && !standardKeys.includes(capabilityKey);
      if (outsideCategory) outsideCategoryRows.push(`${deviceId}:${capabilityKey}`);
      push({
        deviceId,
        capabilityKey,
        outcome: existing ? 'updated' : 'applied',
        detail:
          (existing
            ? '刷新来源与描述（能力状态保持原值）'
            : '新增能力声明（来源：主数据导入）') +
          (outsideCategory
            ? `；注意：该能力不在设备类别「${categoryByDevice.get(deviceId) || '未登记'}」的标准能力集内，请核对主数据`
            : ''),
      });
    }

    const rows: MasterDataRowResult[] = rowResults.filter(
      (row): row is MasterDataRowResult => row !== null,
    );
    const totals = rows.reduce(
      (acc, row) => {
        acc[row.outcome] = (acc[row.outcome] ?? 0) + 1;
        return acc;
      },
      {
        applied: 0,
        updated: 0,
        unchanged: 0,
        skipped_human_disabled: 0,
        skipped_unknown_device: 0,
        skipped_unknown_capability: 0,
        skipped_contract_violation: 0,
        skipped_missing_field: 0,
      } as Record<MasterDataRowOutcome, number>,
    );

    if (!dryRun && writes.length > 0) {
      for (const write of writes) {
        const spec = DEVICE_CAPABILITY_SPECS[write.specKey];
        const record = toCapabilityRecord({
          deviceId: write.deviceId,
          category: spec.providerType === 'exo' ? 'exoskeleton' : null,
          name: write.specKey,
          mode: spec.mode,
          label: spec.label,
          fields: spec.fields,
          grantedAt: at.toISOString(),
        });
        await this.db
          .insert(ewohDeviceCapability)
          .values({
            orgId,
            capabilityId: record.capabilityId,
            deviceId: write.deviceId,
            capabilityType: record.kind,
            capabilityKey: write.specKey,
            capabilityValue: {
              mode: spec.mode,
              label: spec.label,
              fields: [...spec.fields],
              subject: record.subject,
              providerType: record.providerType,
              evidence: record.evidence,
              provenance: {
                channel: 'master_data',
                source,
                sourceRef,
                importedAt: at.toISOString(),
                importedBy,
              },
            },
            compatible: true,
            version: 1,
            status: 'active',
            effectiveFrom: at,
          })
          .onConflictDoUpdate({
            target: [
              ewohDeviceCapability.orgId,
              ewohDeviceCapability.deviceId,
              ewohDeviceCapability.capabilityKey,
            ],
            set: {
              // 只刷新来源与权威描述；status 保持原值（人工停用不被导入复活）
              capabilityType: record.kind,
              capabilityId: record.capabilityId,
              updatedAt: at,
              capabilityValue: {
                mode: spec.mode,
                label: spec.label,
                fields: [...spec.fields],
                subject: record.subject,
                providerType: record.providerType,
                evidence: record.evidence,
                provenance: {
                  channel: 'master_data',
                  source,
                  sourceRef,
                  importedAt: at.toISOString(),
                  importedBy,
                },
              },
            },
          });
      }
    }

    const warnings: string[] = [];
    if (outsideCategoryRows.length > 0) {
      warnings.push(
        `${outsideCategoryRows.length} 条声明超出设备类别的标准能力集（已写入，请核对主数据是否正确）：` +
          `${outsideCategoryRows.slice(0, 5).join('、')}${outsideCategoryRows.length > 5 ? ' 等' : ''}`,
      );
    }
    if (totals.skipped_human_disabled > 0) {
      warnings.push(
        `${totals.skipped_human_disabled} 条被跳过：相关能力已被人为停用（主数据不得覆盖人工安全决定）`,
      );
    }
    if (totals.skipped_unknown_capability > 0) {
      warnings.push(`${totals.skipped_unknown_capability} 条能力名不在词表内（含疑似笔误提示）`);
    }
    if (totals.skipped_unknown_device > 0) {
      warnings.push(`${totals.skipped_unknown_device} 条设备不在本租户台账（未创建任何设备）`);
    }

    const result: MasterDataImportResult = {
      source,
      sourceRef,
      dryRun,
      importedAt: at.toISOString(),
      importedBy,
      totals: { ...totals, declarations: input.declarations.length },
      rows,
      warnings,
    };

    // 审计：dry-run 也留痕（"谁在什么时候预览了哪批主数据"同样需要可追溯），
    // 但明确标注 dryRun，避免事后被误读为真的改了台账。
    await this.auditService.appendAuditLog({
      actorId: importedBy,
      orgId,
      action: dryRun ? 'master_data.capability.import.preview' : 'master_data.capability.import',
      entityType: 'device_capability',
      entityId: `${source}:${sourceRef}`,
      before: {},
      after: {
        applied: totals.applied,
        updated: totals.updated,
        unchanged: totals.unchanged,
        skipped:
          totals.skipped_human_disabled +
          totals.skipped_unknown_device +
          totals.skipped_unknown_capability +
          totals.skipped_contract_violation +
          totals.skipped_missing_field,
      },
      metadata: {
        source,
        sourceRef,
        dryRun,
        declarations: input.declarations.length,
        appliedRows: rows.filter((r) => r.outcome === 'applied').slice(0, 50),
      },
      reason: `主数据导入（${source}:${sourceRef}）`,
    });

    if (!dryRun) {
      this.logger.log(
        `主数据导入 ${source}:${sourceRef} applied=${totals.applied} updated=${totals.updated} ` +
          `unchanged=${totals.unchanged} skipped=${result.totals.declarations - totals.applied - totals.updated - totals.unchanged}`,
      );
    }
    return result;
  }
}
