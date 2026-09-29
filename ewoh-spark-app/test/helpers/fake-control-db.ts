/**
 * fake-control-db.ts — ControlService drizzle 链式假库（ADR-077，§31 单一测试助手）。
 *
 * 供 control.service.spec 与 scenario-packages.spec（SP-04）共用：
 * insert（三表行收集 + 回读）/ select（行回读，忽略条件）/ update
 * （patch 收集 + 命令/请求行回写，receipts/revoke 终态读回依赖；
 * R2-SMI-009：update 链尾提供 returning 以支持请求行 CAS 写回）。
 * select 链尾另有 `.for()`（RVAGG 行锁 `SELECT ... FOR UPDATE`）：按表分派、不消费调用次序，
 * 所以 `lockRequestRow` 多发的这次 select 不会吃掉本该给别的查询的行集。
 */
import {
  ewohControlRequest,
  ewohControlCommand,
  ewohControlResult,
  ewohDeviceConfig,
  ewohNotification,
} from '@server/database/schema';
import { makeConditionMatcher } from './drizzle-fake-matcher';
import { ACTUATOR_HIGH_RISK_COMMANDS } from '@shared/actuator';

/**
 * NO-62a：请求行 `risk_level` 的替身口径 = 真实 `createRequest` 的分级依据
 * （`classifyControlRisk`：命令里含任一高危命令 → high）。
 * 替身不能默认 'normal'——那会让"高危命令必须复核审批"在单测里永远走不到。
 */
function riskLevelOf(row: Record<string, unknown>): string {
  const keys = Array.isArray(row.commandKeys) ? (row.commandKeys as unknown[]) : [];
  return keys.some((key) => (ACTUATOR_HIGH_RISK_COMMANDS as readonly string[]).includes(String(key)))
    ? 'high'
    : 'normal';
}

export interface FakeControlDb {
  db: unknown;
  inserts: Array<{ table: unknown; row: Record<string, unknown> }>;
  updates: Array<{ table: unknown; set: Record<string, unknown>; cond: unknown }>;
  requestRows: unknown[];
  commandRows: unknown[];
  resultRows: unknown[];
  deviceRows: unknown[];
  /** NO-62a：授权复核拒绝/未授权执行写出的确定性提醒行。 */
  notificationRows: unknown[];
}

/**
 * NO-60a：`innerJoin` 支持（真实查询是 control_command ⨝ control_request）。
 *
 * 以 `request_id` 为连接键把两侧行合并，并显式补上服务层用到的投影别名
 * （`requestStatus` / `requestDeviceId`）——替身必须镜像**查询投影**形状，
 * 否则断言读到 undefined 却"通过"（本仓库反复踩过的替身失真）。
 */
function makeJoinChain(
  base: Array<Record<string, unknown>>,
  rowsFor: (table: unknown) => Array<Record<string, unknown>>,
) {
  return (rightTable: unknown, _cond?: unknown) => {
    const rightRows = rowsFor(rightTable);
    const joined: Array<Record<string, unknown>> = [];
    for (const left of base) {
      const right = rightRows.find((row) => String(row.requestId) === String(left.requestId));
      if (!right) continue; // inner join：右侧缺失即整行丢弃
      joined.push({
        ...right,
        ...left,
        requestStatus: right.status,
        requestDeviceId: right.deviceId,
        // NO-62a：投递前授权复核要读请求行风险等级与归属（同一 join 投影）。
        requestRiskLevel: right.riskLevel,
        requestOrgId: right.orgId,
      });
    }
    const matches = makeConditionMatcher(CONTROL_COLUMN_KEYS);
    const chain = (rows: Array<Record<string, unknown>>): any => {
      const q: any = Promise.resolve(rows);
      // join 之后再 where：条件必须真正生效（服务层就是 join → where 的顺序）
      q.where = (cond: unknown) => chain(rows.filter((row) => matches(cond, row)));
      // RVAGG 行锁：`SELECT ... FOR UPDATE/SHARE` 的锁子句不改变结果集——PostgreSQL 只是在
      // 返回命中行之前排队等锁。所以这一环必须原样把当前行集交回下游（可继续 .limit()、可
      // await），不能给空数组：空数组会让"拿锁后读到的行"在替身里凭空消失。
      q.for = (_lockType?: unknown) => q;
      q.orderBy = () => q;
      q.limit = () => q;
      return q;
    };
    return chain(joined);
  };
}

/** 条件匹配用的列名 → 行字段（未登记的列会让 matcher 抛错，显式暴露替身缺口）。 */
const CONTROL_COLUMN_KEYS: Record<string, string> = {
  request_id: 'requestId',
  command_id: 'commandId',
  device_id: 'deviceId',
  command_key: 'commandKey',
  attempt_no: 'attemptNo',
  status: 'status',
  org_id: 'orgId',
  sent_at: 'sentAt',
  // NO-60a：幂等键查询条件（此前漏登记 → where 生效后"同 idempotencyKey 复用原请求行"
  // 直接失效，被 test/unit/control 与 scenario-packages 两个 spec 抓出）。
  idempotency_key: 'idempotencyKey',
  root_command_id: 'rootCommandId',
  response_at: 'responseAt',
  result_id: 'resultId',
  result_type: 'resultType',
  // NO-62a：授权证据列（复核/撤回写回与读回）。
  authorization_fingerprint: 'authorizationFingerprint',
  // NO-67b：交付时刻（配额计量列）。
  delivered_at: 'deliveredAt',
  revoked_reason: 'revokedReason',
  risk_level: 'riskLevel',
};

export function makeControlDb(seed: {
  requests?: unknown[];
  commands?: unknown[];
  devices?: unknown[];
} = {}): FakeControlDb {
  // 真实列 risk_level NOT NULL DEFAULT 'normal'：种子行缺省补默认值，
  // 否则 NO-62a 投递归一（缺失 → 按高危 fail-closed）会把普通命令误判成"待审批"。
  const requestRows: unknown[] = (seed.requests ?? []).map((row) =>
    (row as Record<string, unknown>)?.riskLevel == null
      ? { ...(row as Record<string, unknown>), riskLevel: riskLevelOf(row as Record<string, unknown>) }
      : row,
  );
  const commandRows: unknown[] = [...(seed.commands ?? [])];
  const resultRows: unknown[] = [];
  const deviceRows: unknown[] = [...(seed.devices ?? [])];
  const notificationRows: unknown[] = [];
  const inserts: Array<{ table: unknown; row: Record<string, unknown> }> = [];
  const updates: Array<{ table: unknown; set: Record<string, unknown>; cond: unknown }> = [];
  const db = {
    insert: jest.fn((table: unknown) => ({
      values: jest.fn((row: Record<string, unknown>) => {
        if (table === ewohControlCommand) {
          // NEST-425：attemptNo 由 DB 子查询原子生成（max+1）——fake 落库前
          // 求值为同 (requestId, commandKey) 既有最大序号 + 1（SQL 对象不可比
          // 较，直接存储会让 latest-attempt 聚合/排序失效）。
          if (row.attemptNo != null && typeof row.attemptNo !== 'number') {
            const siblings = (commandRows as Array<Record<string, unknown>>).filter(
              (r) => r.requestId === row.requestId && r.commandKey === row.commandKey,
            );
            const maxNo = siblings.reduce(
              (max, r) => Math.max(max, Number(r.attemptNo) || 0),
              0,
            );
            row = { ...row, attemptNo: maxNo + 1 };
          }
        }
        inserts.push({ table, row });
        if (table === ewohControlRequest) {
          requestRows.push(row.riskLevel == null ? { ...row, riskLevel: riskLevelOf(row) } : row);
        }
        if (table === ewohControlCommand) commandRows.push(row);
        if (table === ewohControlResult) resultRows.push(row);
        if (table === ewohNotification) notificationRows.push(row);
        const returning = jest.fn().mockResolvedValue([row]);
        // NO-62a：确定性提醒走 insert().values().onConflictDoNothing().returning()
        // （幂等写），替身必须镜像这条链，否则"提醒是否真的写出"不可测。
        return { returning, onConflictDoNothing: jest.fn(() => ({ returning })) };
      }),
    })),
    select: jest.fn(() => ({
      from: jest.fn((table: unknown) => {
        const rowsFor = (t: unknown): Array<Record<string, unknown>> =>
          t === ewohControlRequest
            ? (requestRows as Array<Record<string, unknown>>)
            : t === ewohControlCommand
              ? (commandRows as Array<Record<string, unknown>>)
              : t === ewohControlResult
                ? (resultRows as Array<Record<string, unknown>>)
                : t === ewohDeviceConfig
                  ? (deviceRows as Array<Record<string, unknown>>)
                  : [];
        // NO-60a：where 条件真正生效（列名 → 行字段），否则"按设备/状态过滤"这类
        // 断言在替身上永远为真——"路径不可测"是本仓库反复踩过的坑。
        const matches = makeConditionMatcher(CONTROL_COLUMN_KEYS);
        const chain = (rows: Array<Record<string, unknown>>): any => {
          const q: any = Promise.resolve(rows);
          q.where = (cond: unknown) => chain(rows.filter((row) => matches(cond, row)));
          q.innerJoin = makeJoinChain(rows, rowsFor);
          // RVAGG 行锁（`lockRequestRow` = `SELECT ... FOR UPDATE`）：锁子句不改变结果集，
          // PostgreSQL 只是在返回命中行之前排队等锁 ⇒ 这一环原样把当前行集交回下游
          // （可继续 .limit()、可 await）。返回空数组会让"锁后读到的行"凭空消失，
          // 让依赖锁后真值的聚合在替身里静默失真。
          q.for = (_lockType?: unknown) => q;
          q.orderBy = () => q;
          q.limit = () => q;
          return q;
        };
        return chain(rowsFor(table));
      }),
    })),
    update: jest.fn((table: unknown) => ({
      set: jest.fn((patch: Record<string, unknown>) => ({
        where: jest.fn((cond: unknown) => {
          updates.push({ table, set: patch, cond });
          if (table === ewohControlCommand) {
            for (const row of commandRows as Record<string, unknown>[]) {
              Object.assign(row, patch);
            }
          }
          if (table === ewohControlRequest) {
            for (const row of requestRows as Record<string, unknown>[]) {
              Object.assign(row, patch);
            }
          }
          if (table === ewohNotification) {
            for (const row of notificationRows as Record<string, unknown>[]) {
              Object.assign(row, patch);
            }
          }
          // R2-SMI-009：CAS 写回经 returning 取命中行（fake 不解释 where，
          // 恒回一行命中——0 行冲突路径由专用断言覆盖）。
          return {
            returning: jest.fn().mockResolvedValue([{ requestId: 'fake-row' }]),
          };
        }),
      })),
    })),
  };
  return { db, inserts, updates, requestRows, commandRows, resultRows, deviceRows, notificationRows };
}
