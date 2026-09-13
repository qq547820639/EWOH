import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { DRIZZLE_DATABASE, type PostgresJsDatabase } from '@lark-apaas/fullstack-nestjs-core';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { ewohDevice, ewohDeviceResponsibility, ewohShift } from '@server/database/schema';
import {
  ALL_SHIFT,
  summarizeResponsibilityCoverage,
  type ResponsibilityCoverageSnapshot,
  DEVICE_RESPONSIBILITY_KINDS,
  barePersonRef,
  isDeviceResponsibilityKind,
  planResponsibilityRecipients,
  type AlertRecipientPlan,
  type DeviceResponsibilityFact,
  type DeviceResponsibilityKind,
} from '@shared/device-responsibility';
import { normalizePersonRef } from '@shared/identity';
import { resolveShiftAt, type ShiftDefinition } from '@shared/shift';
import type { OrgContext } from '../shared/org-context.interceptor';
import { AuditService } from '../shared/audit.service';

/**
 * 设备责任人台账（NO-49a）。
 *
 * 为什么存在：安灯/升级提醒一直发到**固定角色**，"这台设备是谁的"这个车间基本事实
 * 在平台里没有位置——结果是谁都收到、常常没人真去。本服务提供：
 *   · 责任关系读写（同一设备同一职责同时**只有一位** active，换人保留历史）；
 *   · **提醒收件人解析**：责任关系 + 人员→账号绑定（受控函数 078）→
 *     "点名到人" 的收件人 + **无账号绑定的缺口清单**（不假装通知到了）。
 *
 * 边界：
 *   · 设备必须是**本租户台账里的设备**（拿不到就 404，不猜、不建影子设备）；
 *   · `device_id` 用业务设备号（与安灯/遥测同一 id 空间）；
 *   · 人员身份统一成 `person:<uuid>` 规范形态（ADR-006）；
 *   · 每次变更写审计（谁在何时把哪台设备的哪个职责交给了谁/收回了）。
 */
export interface DeviceResponsibilityRecord {
  deviceId: string;
  personId: string;
  responsibility: DeviceResponsibilityKind;
  /** 适用班次；空串 = 全天（NO-51a）。 */
  shiftId: string;
  active: boolean;
  note: string | null;
  activatedAt: string | null;
  deactivatedAt: string | null;
}

@Injectable()
export class DeviceResponsibilityService {
  /**
   * 说明（NO-51a/NO-52a）：当前班次判定用"读班次表 + 共享纯函数 resolveShiftAt"，
   * **不注入 ShiftService**——否则 Shift→Responsibility→Shift 会成模块环。
   */
  constructor(
    @Inject(DRIZZLE_DATABASE) private readonly db: PostgresJsDatabase,
    private readonly auditService: AuditService,
  ) {}

  private requireOrgId(actor?: OrgContext): string {
    const orgId = (actor?.primaryOrgId ?? '').trim();
    if (!orgId) throw new BadRequestException('org 上下文缺失：设备责任人必须带租户上下文');
    return orgId;
  }

  /** 设备必须在本租户台账里（否则 404：不猜设备、也不建影子设备）。 */
  private async assertDeviceInLedger(orgId: string, deviceId: string): Promise<void> {
    const rows = await this.db
      .select({ id: ewohDevice.id })
      .from(ewohDevice)
      .where(and(eq(ewohDevice.orgId, orgId), eq(ewohDevice.deviceId, deviceId)))
      .limit(1);
    if (rows.length === 0) {
      throw new NotFoundException(`device_not_found:${deviceId}（该设备不在本租户台账，无法登记责任人）`);
    }
  }

  async list(
    orgId: string,
    filter: { deviceId?: string; deviceIds?: string[]; personId?: string; activeOnly?: boolean } = {},
  ): Promise<DeviceResponsibilityRecord[]> {
    if (!orgId?.trim()) throw new BadRequestException('orgId 缺失：设备责任人查询必须带租户上下文');
    const conditions = [eq(ewohDeviceResponsibility.orgId, orgId)];
    if (filter.deviceId) conditions.push(eq(ewohDeviceResponsibility.deviceId, filter.deviceId));
    if (filter.deviceIds && filter.deviceIds.length > 0) {
      conditions.push(inArray(ewohDeviceResponsibility.deviceId, [...filter.deviceIds]));
    }
    if (filter.personId) {
      const ref = normalizePersonRef(filter.personId);
      // 裸 id 与 person: 前缀等价：两种写法都要能查到（存量行可能存的是裸 id）
      conditions.push(
        inArray(ewohDeviceResponsibility.personId, [
          filter.personId,
          ref ?? filter.personId,
          `person:${ref ?? filter.personId}`,
        ]),
      );
    }
    if (filter.activeOnly !== false) conditions.push(eq(ewohDeviceResponsibility.active, true));
    const rows = await this.db
      .select()
      .from(ewohDeviceResponsibility)
      .where(and(...conditions))
      .limit(500);
    return rows.map((row) => ({
      deviceId: row.deviceId,
      personId: row.personId,
      responsibility: row.responsibility as DeviceResponsibilityKind,
      shiftId: String(row.shiftId ?? ''),
      active: row.active === true,
      note: row.note ?? null,
      activatedAt: row.activatedAt ? new Date(row.activatedAt).toISOString() : null,
      deactivatedAt: row.deactivatedAt ? new Date(row.deactivatedAt).toISOString() : null,
    }));
  }

  /**
   * 批量读（台账页面用）：可传设备号清单；**不接受跨租户**（org 一律来自调用者上下文）。
   * 不传清单 = 本租户全部 active 责任关系（上限 500 行，够页面用；超出由调用方分页）。
   */
  async listForDevices(
    orgId: string,
    deviceIds: readonly string[] = [],
    filter: { activeOnly?: boolean } = {},
  ): Promise<DeviceResponsibilityRecord[]> {
    return this.list(orgId, { ...(deviceIds.length > 0 ? { deviceIds: [...deviceIds] } : {}), activeOnly: filter.activeOnly });
  }

  /**
   * 设置责任人（同一职责换人 = 旧行停用 + 新行启用，同一事务；历史保留）。
   *
   * 幂等语义：把**同一个人**再设一次同一职责 → 不改动、直接返回现状（不产生无意义历史行）。
   */
  async setResponsibility(
    orgId: string,
    input: {
      deviceId: string;
      personId: string;
      responsibility: string;
      /** 适用班次（ewoh_shift.shift_id）；缺省/空串 = 全天（NO-51a）。 */
      shiftId?: string;
      note?: string;
    },
    actor?: OrgContext,
  ): Promise<DeviceResponsibilityRecord> {
    if (!orgId?.trim()) throw new BadRequestException('orgId 缺失：设备责任人写入必须带租户上下文');
    const deviceId = String(input?.deviceId ?? '').trim();
    if (deviceId === '') throw new BadRequestException('deviceId 必填');
    if (!isDeviceResponsibilityKind(input?.responsibility)) {
      throw new BadRequestException(
        `bad_responsibility:${String(input?.responsibility ?? '')}（只支持 ${DEVICE_RESPONSIBILITY_KINDS.join('/')}）`,
      );
    }
    const ref = normalizePersonRef(input?.personId);
    if (!ref) throw new BadRequestException('personId 必填（规范人员身份：person:<uuid> 或裸 uuid）');
    const personId = `person:${ref}`;
    const responsibility = input.responsibility;
    const shiftId = String(input.shiftId ?? '').trim() || ALL_SHIFT;
    await this.assertDeviceInLedger(orgId, deviceId);

    const now = new Date();
    const record = await this.db.transaction(async (tx) => {
      const [existing] = await tx
        .select()
        .from(ewohDeviceResponsibility)
        .where(
          and(
            eq(ewohDeviceResponsibility.orgId, orgId),
            eq(ewohDeviceResponsibility.deviceId, deviceId),
            eq(ewohDeviceResponsibility.responsibility, responsibility),
            // 班次维度：同一职责的"本班"与"全天"是两条独立责任关系（NO-51a）
            eq(ewohDeviceResponsibility.shiftId, shiftId),
            eq(ewohDeviceResponsibility.active, true),
          ),
        )
        .limit(1);
      if (existing && existing.personId === personId) {
        // 幂等：同一个人重复设置同一职责 → 不改动（也无需写审计）
        return existing;
      }
      if (existing) {
        // CAS：只停用"仍然 active"的旧行，并**检查影响行数**——并发下若已被别人换掉，
        // 这里必须显式冲突（而不是继续插入造成"同一职责两位 active"的假象）。
        const deactivated = await tx
          .update(ewohDeviceResponsibility)
          .set({
            active: false,
            deactivatedAt: now,
            deactivatedBy: actor?.userId ?? null,
            updatedAt: now,
          })
          .where(
            and(
              eq(ewohDeviceResponsibility.orgId, orgId),
              eq(ewohDeviceResponsibility.id, existing.id),
              eq(ewohDeviceResponsibility.active, true),
            ),
          )
          .returning({ id: ewohDeviceResponsibility.id });
        if (deactivated.length === 0) {
          throw new ConflictException(
            `responsibility_changed_concurrently:${deviceId}/${responsibility}（责任人刚被他人改动，请刷新后重试）`,
          );
        }
      }
      const [inserted] = await tx
        .insert(ewohDeviceResponsibility)
        .values({
          orgId,
          deviceId,
          personId,
          responsibility,
          shiftId,
          active: true,
          note: input.note?.trim() || null,
          activatedAt: now,
          updatedAt: now,
          createdBy: actor?.userId ?? null,
        })
        .returning();
      await this.auditService.appendAuditLog({
        actorId: actor?.userId ?? 'system',
        orgId,
        action: 'device.responsibility.set',
        entityType: 'device',
        entityId: deviceId,
        before: existing
          ? { responsibility, personId: existing.personId, active: true }
          : { responsibility, personId: null, active: false },
        after: { responsibility, personId, active: true, note: input.note ?? null },
      });
      return inserted;
    });

    return {
      deviceId: record.deviceId,
      personId: record.personId,
      responsibility: record.responsibility as DeviceResponsibilityKind,
      shiftId: String(record.shiftId ?? ''),
      active: record.active === true,
      note: record.note ?? null,
      activatedAt: record.activatedAt ? new Date(record.activatedAt).toISOString() : null,
      deactivatedAt: record.deactivatedAt ? new Date(record.deactivatedAt).toISOString() : null,
    };
  }

  /** 收回某职责（停用当前 active 行；本来就没有 → 409，不静默当成功）。 */
  async clearResponsibility(
    orgId: string,
    input: { deviceId: string; responsibility: string; shiftId?: string; reason?: string },
    actor?: OrgContext,
  ): Promise<{ cleared: true; deviceId: string; responsibility: DeviceResponsibilityKind }> {
    if (!orgId?.trim()) throw new BadRequestException('orgId 缺失：设备责任人写入必须带租户上下文');
    const deviceId = String(input?.deviceId ?? '').trim();
    if (deviceId === '') throw new BadRequestException('deviceId 必填');
    if (!isDeviceResponsibilityKind(input?.responsibility)) {
      throw new BadRequestException(`bad_responsibility:${String(input?.responsibility ?? '')}`);
    }
    const now = new Date();
    const cleared = await this.db.transaction(async (tx) => {
      const rows = await tx
        .update(ewohDeviceResponsibility)
        .set({
          active: false,
          deactivatedAt: now,
          deactivatedBy: actor?.userId ?? null,
          updatedAt: now,
        })
        .where(
          and(
            eq(ewohDeviceResponsibility.orgId, orgId),
            eq(ewohDeviceResponsibility.deviceId, deviceId),
            eq(ewohDeviceResponsibility.responsibility, input.responsibility),
            eq(ewohDeviceResponsibility.shiftId, String(input.shiftId ?? '').trim() || ALL_SHIFT),
            eq(ewohDeviceResponsibility.active, true),
          ),
        )
        .returning();
      if (rows.length === 0) {
        throw new ConflictException(
          `no_active_responsibility:${deviceId}/${input.responsibility}（当前没有这位责任人，无需收回）`,
        );
      }
      await this.auditService.appendAuditLog({
        actorId: actor?.userId ?? 'system',
        orgId,
        action: 'device.responsibility.clear',
        entityType: 'device',
        entityId: deviceId,
        before: { responsibility: input.responsibility, personId: rows[0]?.personId ?? null, active: true },
        after: { responsibility: input.responsibility, personId: null, active: false, reason: input.reason ?? null },
      });
      return rows.length;
    });
    return { cleared: true, deviceId, responsibility: input.responsibility };
  }

  /**
   * 解析"这台设备的提醒该点名给谁"。
   *
   * person → 登录账号的反查必须走受控函数（运行角色对 `ewoh_user` 没有任何直接授权，
   * 直查会 `permission denied`——NO-37a 实测）。查不到的**如实进 unresolved**。
   */
  /**
   * 交接班前的"责任人核对"（NO-52a）：给定班次下，哪些设备本班没人负责。
   *
   * 与提醒路由同一口径（本班优先、全天兜底、他班只报缺口），但**不要求已绑定账号**——
   * 这里回答"有没有人负责"，账号缺口由提醒链路的 `unresolved` 回答（两处口径不同，
   * 页面与文档都写清楚，避免"看板说有人、提醒发不到"的错觉）。
   */
  async coverageForShift(
    orgId: string,
    options: { shiftId?: string | null; at?: Date } = {},
  ): Promise<ResponsibilityCoverageSnapshot> {
    if (!orgId?.trim()) {
      throw new BadRequestException('orgId 缺失：责任人核对必须带租户上下文');
    }
    const shiftId =
      options.shiftId === undefined
        ? await this.resolveCurrentShiftId(orgId, options.at ?? new Date())
        : options.shiftId === null
          ? null
          : String(options.shiftId).trim() || null;

    // 本租户全部 active 责任关系（上限 1000：够交接班核对；超出由页面按设备过滤）
    const rows = await this.db
      .select()
      .from(ewohDeviceResponsibility)
      .where(and(eq(ewohDeviceResponsibility.orgId, orgId), eq(ewohDeviceResponsibility.active, true)))
      .limit(1000);
    const byDevice = new Map<string, DeviceResponsibilityFact[]>();
    for (const row of rows) {
      const deviceId = String(row.deviceId ?? '').trim();
      if (deviceId === '') continue;
      const list = byDevice.get(deviceId) ?? [];
      list.push({
        deviceId,
        personId: row.personId,
        responsibility: row.responsibility as DeviceResponsibilityKind,
        shiftId: String(row.shiftId ?? ''),
      });
      byDevice.set(deviceId, list);
    }

    // 一条责任关系都没登记的设备（更宽的缺口）：与设备台账 join，如实计数
    const uncoveredRows = (await this.db.execute(sql`
      SELECT d.device_id AS device_id
      FROM "ewoh_device" d
      WHERE d.org_id = ${orgId}
        AND NOT EXISTS (
          SELECT 1 FROM "ewoh_device_responsibility" r
          -- 类型说明：ewoh_device.org_id 是 **uuid**（身份域），
          -- ewoh_device_responsibility.org_id 是 **varchar(255)**（业务域，与既有表约定一致）。
          -- 不加 ::text 会直接报 operator does not exist: character varying = uuid（实测）。
          WHERE r.org_id = d.org_id::text AND r.device_id = d.device_id AND r.active
        )
      LIMIT 500
    `)) as unknown as Array<{ device_id?: string | null }>;

    return summarizeResponsibilityCoverage(byDevice, {
      shiftId,
      uncoveredDeviceIds: uncoveredRows
        .map((row) => String(row.device_id ?? '').trim())
        .filter((id) => id !== ''),
    });
  }

  /**
   * 当前班次（NO-51a）：
   *   · 传了 `shiftId` 用它；传 null 表示"明确未知"（不猜）；
   *   · 不传则按班次定义判定；**解析失败/不在任何班次内 → null（显式未知）**，
   *     此时路由只按"全天责任人"兜底并标注 `shiftUnknown`（不猜一个默认班）。
   *
   * 实现：直接读班次表 + **共享纯函数** `resolveShiftAt`（与班次域同一口径）。
   * 不注入 ShiftService 的原因：ShiftModule 反过来要依赖本模块做交接核对，
   * 注入会形成模块环（NO-52a）。
   */
  async resolveCurrentShiftId(orgId: string, at: Date = new Date()): Promise<string | null> {
    if (!orgId?.trim()) return null;
    try {
      const rows = await this.db
        .select()
        .from(ewohShift)
        .where(and(eq(ewohShift.orgId, orgId), eq(ewohShift.active, true)))
        .limit(50);
      const shifts: ShiftDefinition[] = rows.map((row) => ({
        shiftId: row.shiftId,
        name: row.name,
        code: row.code ?? null,
        startTime: String(row.startTime ?? ''),
        endTime: String(row.endTime ?? ''),
        crossesMidnight: row.crossesMidnight === true,
        active: row.active === true,
        leadUserId: row.leadUserId ?? null,
        description: row.description ?? null,
      }));
      const resolved = resolveShiftAt(shifts, at);
      const shiftId = String(
        (resolved as { current?: { shiftId?: string } | null } | null)?.current?.shiftId ?? '',
      ).trim();
      return shiftId === '' ? null : shiftId;
    } catch {
      // 班次数据不可用不阻塞提醒：按"全天兜底 + shiftUnknown"处理（如实标注）
      return null;
    }
  }

  async resolveAlertRecipients(
    orgId: string,
    deviceId: string,
    options: { shiftId?: string | null; at?: Date } = {},
  ): Promise<AlertRecipientPlan> {
    if (!orgId?.trim() || !deviceId?.trim()) {
      return {
        users: [],
        dedupedUserIds: [],
        unresolved: [],
        uncovered: true,
        shiftId: null,
        shiftUnknown: true,
        outOfShift: [],
      };
    }
    const rows = await this.db
      .select()
      .from(ewohDeviceResponsibility)
      .where(
        and(
          eq(ewohDeviceResponsibility.orgId, orgId),
          eq(ewohDeviceResponsibility.deviceId, deviceId),
          eq(ewohDeviceResponsibility.active, true),
        ),
      )
      .limit(20);
    const facts: DeviceResponsibilityFact[] = rows.map((row) => ({
      deviceId: row.deviceId,
      personId: row.personId,
      responsibility: row.responsibility as DeviceResponsibilityKind,
      shiftId: String(row.shiftId ?? ''),
    }));
    const shiftId =
      options.shiftId === undefined
        ? await this.resolveCurrentShiftId(orgId, options.at ?? new Date())
        : options.shiftId === null
          ? null
          : String(options.shiftId).trim() || null;
    if (facts.length === 0) {
      return {
        users: [],
        dedupedUserIds: [],
        unresolved: [],
        uncovered: true,
        shiftId,
        shiftUnknown: shiftId === null,
        outOfShift: [],
      };
    }
    const personKeys = [...new Set(facts.map((fact) => barePersonRef(fact.personId)).filter((p) => p !== ''))];
    const accountByPerson = new Map<string, string>();
    if (personKeys.length > 0) {
      const accounts = (await this.db.execute(sql`
        SELECT username, person_id
        FROM "ewoh_find_active_users_by_person"(${orgId}::uuid, ${sql.raw(
          `ARRAY[${personKeys.map((p) => `'${p.replace(/'/g, "''")}'`).join(',')}]::text[]`,
        )})
      `)) as unknown as Array<{ username?: string | null; person_id?: string | null }>;
      for (const account of accounts) {
        const person = barePersonRef(account.person_id ?? '');
        const username = String(account.username ?? '').trim();
        if (person !== '' && username !== '') accountByPerson.set(person, username);
      }
    }
    return planResponsibilityRecipients(facts, accountByPerson, { currentShiftId: shiftId });
  }
}
