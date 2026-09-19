import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  HttpException,
  Inject,
  Injectable,
  InternalServerErrorException,
  Logger,
  NotFoundException,
  Optional,
} from '@nestjs/common';
import { DRIZZLE_DATABASE, type PostgresJsDatabase } from '@lark-apaas/fullstack-nestjs-core';
import {
  ACTUATOR_COMMAND_KEYS,
  ACTUATOR_COMMAND_PRIORITY,
  ACTUATOR_HIGH_RISK_COMMANDS,
  ACTUATOR_SAFETY_COMMANDS,
  UNKNOWN_COMMAND_PRIORITY,
  actuatorCommandPriority,
  actuatorCommandPriorityLabel,
  isActuatorCommandKey,
} from '@shared/actuator';
import { createFingerprintSigner } from './authorization-fingerprint';
import { insertDeterministicNotifications } from '../notification/deterministic-notifications';
import { eq, and, asc, desc, gte, inArray, isNull, lt, or, sql } from 'drizzle-orm';
import {
  ewohControlRequest,
  ewohControlCommand,
  ewohControlResult,
  ewohDeviceConfig,
  ewohControlBacklogSnapshot,
} from '@server/database/schema';
import { AuditService, type AuditLogEntry } from '../shared/audit.service';
import type { OrgContext } from '../shared/org-context.interceptor';
import { assertTenantVisible } from '../scheduler/plan-tenant-guard';
import { buildGucSettings } from '../shared/org-context.interceptor';
import { ApprovalPersistenceService } from '../approval/approval-persistence.service';
import {
  RequestDatabaseContext,
  type TransactionSettingLike,
} from '../../database/request-database-context';
import { verifyApprovalFreshness } from '@shared/capability-requirements';

export type AttemptStatus =
  | 'pending'
  | 'sent'
  | 'gateway_received'
  | 'executed'
  | 'failed'
  | 'expired'
  /** NO-62a：投递前授权复核未通过 → 命令被平台撤回（**未投给设备**）。 */
  | 'revoked';

export interface ControlAttempt {
  attemptId: string;
  commandKey: string;
  attemptNo: number;
  status: AttemptStatus;
  receipt?: Record<string, unknown>;
  /** 命令参数（NO-60a；如 AGV 的目标工位）——下发时落库，读面与边缘网关都从这里取。 */
  payload?: Record<string, unknown> | null;
}

export interface ControlRequest {
  id: string;
  deviceId: string;
  idempotencyKey: string;
  commandKeys: string[];
  attempts: ControlAttempt[];
  createdAt: string;
  /** 组织归属（ADR-077；读回 Fact，null=legacy 行）。 */
  orgId?: string | null;
  /** R2-SMI-001：持久化行状态（created/pending_approval/approved/…/revoked）。 */
  status?: string;
  /**
   * NO-62a：风险等级（high = 需要审批）。**授权复核的判定基准**：下发时与投递/确认/回执
   * 时必须用同一个口径，否则高危请求的第二条命令会因"下发时没算审批实例号"而与
   * 复核指纹不符（本轮实测到的真实缺陷）。
   */
  riskLevel?: string | null;
}

/**
 * 平台既有的通用设备高危命令（legacy：急停/载人移动类）。**不在执行机构契约里**
 * （`shared/actuator.ts` 只管 AGV/PLC 那一族），但又确实是"会让人或设备动起来"的动作，
 * 所以单独列一份并并入 {@link HIGH_RISK_COMMAND_KEYS}。
 */
const LEGACY_HIGH_RISK_COMMAND_KEYS = [
  'emergency_stop',
  'e_stop',
  'estop',
  'emergency_brake',
  'move_to',
  'carry_move',
] as const;

/**
 * R2-SMI-001（INV-005）：高危物理指令集合——急停/载人移动类命令进入
 * pending_approval 审批链后才允许下发。普通启停（start/stop）保持直发。
 */
export const HIGH_RISK_COMMAND_KEYS: ReadonlySet<string> = new Set([
  ...LEGACY_HIGH_RISK_COMMAND_KEYS,
  // NO-60a：执行机构（AGV/PLC）高危命令直接取自**共享契约**（`shared/actuator.ts`
  // 与边缘 Python 常量逐项对账过）。此前平台与边缘各有一份高危词表：
  // 平台不知道 `dispatch_task` 属于高危 → 一条会让设备在共享空间动起来的命令
  // 可以绕过审批直达设备。两处同源后不会再漂移（原则 3/4：执行边界必须统一）。
  ...ACTUATOR_HIGH_RISK_COMMANDS,
]);

/**
 * F1（控制面硬化）：**平台接受的命令键词表**（封闭词表）。
 *
 * 为什么必须有它：`createRequest` 原来只校验 commandKeys 非空，任何字符串都能进来
 * （例如 `open_interlock`）。后果有两层：
 *   1. **定级失真**——`classifyControlRisk` 是黑名单式（只把已知高危键判 high），
 *      自定义键落 'normal' → 该请求不进审批链，可直发设备；
 *   2. **假动作**——边缘适配器对词表外的键一律 `unknown_command_key`
 *      （`src/edge_platform/edge/adapters/actuator/protocol.py` 的 `ACTUATOR_COMMANDS`），
 *      一条词表外的命令**永远不会被执行**；但它会走完创建/下发/投递/回执全流程，
 *      页面与审计里看起来"发过一条命令"，现场却只看到一个不动的设备。
 *
 * 词表构成：共享执行机构契约 `ACTUATOR_COMMAND_KEYS`（与边缘 Python 逐项对账，
 * 由 `shared/actuator.spec.ts` 锁定）+ legacy 高危键 + 通用启停 `start`
 * （平台既有调用方/单测/e2e 在用，删掉会让现场既有单子被 400 拒绝）。
 *
 * 纪律：新增命令键必须**先**在共享契约里登记，再进这里——不允许"调用方随手传一个键"。
 */
export const PLATFORM_COMMAND_KEYS: ReadonlySet<string> = new Set([
  ...ACTUATOR_COMMAND_KEYS,
  ...LEGACY_HIGH_RISK_COMMAND_KEYS,
  'start',
]);

/**
 * F1：是否为平台接受的命令键。
 *
 * 执行机构家族复用共享契约的 `isActuatorCommandKey`（单一事实源，避免平台再抄一份
 * 词表）；legacy/通用键查平台词表。
 */
export function isPlatformCommandKey(value: unknown): boolean {
  return isActuatorCommandKey(value) || PLATFORM_COMMAND_KEYS.has(String(value ?? ''));
}

/**
 * R2-SMI-001：按命令键风险分级（任一高危键 → 整单高危）。
 *
 * F1（fail-closed）：**词表外的键一律按 high 处理**——黑名单式分级对新增/拼错/伪造的键
 * 天然 fail-open（`open_interlock` 落 'normal' = 免审批直达设备），而定级错误的代价是
 * "一条没有授权链的命令投到设备上"。未知键在 `createRequest` 已被拒绝（见那里），
 * 这里兜住的是**存量行**与**投递路径上的复核**：词表会演进（NO-60a 刚并入执行机构
 * 高危命令），落库那一刻的定级不能当成永远正确。
 */
export function classifyControlRisk(commandKeys: string[]): 'high' | 'normal' {
  const keys = Array.isArray(commandKeys) ? commandKeys : [];
  if (keys.some((key) => !isPlatformCommandKey(key))) {
    return 'high';
  }
  return keys.some((key) => HIGH_RISK_COMMAND_KEYS.has(String(key)))
    ? 'high'
    : 'normal';
}

interface ControlRequestRow {
  request_id: string;
  device_id: string;
  command_keys: unknown;
  idempotency_key: string | null;
  status: string;
  requested_at: unknown;
  org_id?: string | null;
  /** NO-62a：风险等级（high → 授权复核必须找到有效审批实例）。 */
  risk_level?: string | null;
}

interface ControlCommandRow {
  command_id: string;
  request_id: string;
  root_command_id: string;
  attempt_no: number;
  command_key: string;
  status: string;
  sent_at: unknown;
  response_at: unknown;
  response_json: unknown;
  error_code: string | null;
  error_message: string | null;
}

let seq = 0;

function nextId(prefix: string): string {
  seq += 1;
  return `${prefix}-${Date.now()}-${seq}`;
}

export function aggregateControlStatus(attempts: ControlAttempt[]): string {
  const latest = new Map<string, ControlAttempt>();
  for (const attempt of attempts) {
    const existing = latest.get(attempt.commandKey);
    if (!existing || attempt.attemptNo > existing.attemptNo) {
      latest.set(attempt.commandKey, attempt);
    }
  }
  const statuses = Array.from(latest.values()).map((attempt) => attempt.status);
  if (statuses.length === 0) {
    return 'created';
  }
  if (statuses.some((status) => status === 'expired')) {
    return 'timeout';
  }
  if (statuses.every((status) => status === 'executed')) {
    return 'executed';
  }
  if (statuses.every((status) => status === 'failed')) {
    return 'failed';
  }
  // NO-62a：投递前复核撤回的命令不是"失败"——它**从未投给设备**，
  // 与"设备执行失败"是两件事（原则 6：失败/未执行/被撤回必须可区分）。
  if (statuses.every((status) => status === 'revoked')) {
    return 'revoked';
  }
  if (
    statuses.some((status) => status === 'executed') &&
    statuses.some((status) => status === 'failed' || status === 'revoked')
  ) {
    return 'partial_success';
  }
  if (
    statuses.some((status) => status === 'revoked') &&
    !statuses.some((status) => status === 'executed' || status === 'sent' || status === 'gateway_received')
  ) {
    return 'failed';
  }
  return 'pending_gateway';
}

const TERMINAL_REQUEST_STATUSES = new Set(['executed', 'failed', 'timeout', 'revoked']);
/**
 * R2-SMI-009（修正）：sendCommand/receiveReceipt 的行状态守卫排除 'failed'——
 * control.yaml aggregation.retry_new_attempt:true 允许 latest attempt 全败后
 * 同 request 重发新 attempt（重发后聚合写回 pending_gateway）。'failed' 行
 * 状态不得阻断重试通道；executed/timeout/revoked 仍 fail-closed。
 */
const NON_RETRYABLE_REQUEST_STATUSES = new Set(['executed', 'timeout', 'revoked']);
/**
 * NO-62a：**投递前授权复核失败 → 命令撤回**的封闭原因词表。
 * 与 `db/migrations/standalone_093_control_command_authorization.sql` 的
 * CHECK 约束逐项一致（词表漂移会让合法原因被 DB 拒绝，属于契约缺陷）。
 *
 * 为什么需要逐项区分：页面/运维要能区分"审批过期""审批被撤销""授权范围被改写"
 * "审批实例缺失"——都叫"投递失败"现场就无法处置（原则 5/6/7）。
 */
export const CONTROL_REVOKE_REASONS = [
  'authorization_expired',
  'authorization_revoked',
  'approval_missing',
  'approval_not_granted',
  'fingerprint_mismatch',
  // NO-65a：命令带签名指纹但本实例没有密钥 → 无法验证 → 显式拒绝（不退回无密钥校验）。
  'fingerprint_key_missing',
  'request_terminal',
  'device_org_mismatch',
] as const;
export type ControlRevokeReason = (typeof CONTROL_REVOKE_REASONS)[number];

/** 原因 → 现场可读说明（页面/日志/提醒同源）。 */
export const CONTROL_REVOKE_REASON_LABELS: Readonly<Record<ControlRevokeReason, string>> = {
  authorization_expired: '授权已超出有效期（需重新审批后再下发）',
  authorization_revoked: '控制请求已被撤销',
  approval_missing: '审批实例缺失或审批模块不可用（无法证明授权，拒绝投递）',
  approval_not_granted: '审批未通过（驳回/取消/绕过），命令不得投给设备',
  fingerprint_mismatch: '授权范围与命令内容不一致（请求/设备/命令/参数被改写，或签名不符）',
  fingerprint_key_missing: '命令带签名指纹但本实例未配置密钥（无法验证签名）',
  request_terminal: '控制请求已进入终态',
  device_org_mismatch: '命令与请求的租户归属不一致',
};

/**
 * NO-62a：投递前授权复核结论（单一形状；`ok=false` 时 reason/detail 必有值）。
 */
export interface DeliveryAuthorizationVerdict {
  ok: boolean;
  /** 复核通过时的授权范围指纹；拒绝时为空串（不伪造）。 */
  fingerprint: string;
  approvalInstanceId: string | null;
  reason: ControlRevokeReason | null;
  detail: string | null;
}

/** 投递扫描上限（一次轮询最多检视的待投递命令数；超出显式标记 truncated）。 */
const PENDING_SCAN_CAP = 500;

/**
 * NO-65b：**在飞运动命令**（已投给设备但还没有执行结果）的封闭词表。
 *
 * 为什么需要"投递闸门"：`sendCommand` 侧已经禁止同一命令键并发下发
 * （`IN_FLIGHT_ATTEMPT_STATUSES`），但**不同命令键之间**没有约束——一台正在搬运的 AGV
 * 可以同时收到第二条 `dispatch_task`（不同 requestId），平台侧看起来完全合法，
 * 现场却是"一台车接两个活"。设备侧的状态机会拒绝其中一条（`not_moving` 之类），
 * 但那要等命令**已经投到设备上**才发生；正确做法是**平台投递前就不发**。
 */
export const MOTION_COMMAND_KEYS: ReadonlySet<string> = new Set(['dispatch_task', 'resume']);

/**
 * NO-67b：**单设备投递配额**（每分钟）——防止一次轮询把设备/网关压垮。
 *
 * 现场语义：一台 AGV/PLC 的控制通道吞吐有限（现场总线、WiFi、PLC 扫描周期）；
 * 平台侧"有多少投多少"会把设备打爆（表现为设备侧丢帧/拒绝/超时，而不是平台报错）。
 * 配额按**设备**计，窗口 60s；**安全动作（stop）永不受配额约束**（与排队闸门同一条纪律）。
 *
 * 计量口径：`authorization_verified_at`（投递前复核通过 = 真正投出去的时刻），
 * 不是 `sent_at`（下发时刻）——否则"下发很多但一台设备只投一条"会被误算成超配额。
 * `<= 0` = 不限（显式关闭，不是"忘了配"）。
 */
export function controlDeliveryQuotaPerMinute(): number {
  const raw = Number(process.env.EWOH_CONTROL_DELIVERY_QUOTA_PER_MINUTE ?? 60);
  return Number.isFinite(raw) ? Math.trunc(raw) : 60;
}
/**
 * NO-74c：**运动类命令的更严配额**（每分钟，按设备）。
 *
 * 运动命令（dispatch_task/resume）驱动物理动作，误发/连发的现场代价远高于读类命令；
 * 默认取通用配额的**一半**（≤0 = 关闭运动配额，只受通用配额约束）。
 */
export function controlDeliveryQuotaPerMinuteMotion(): number {
  const raw = Number(
    process.env.EWOH_CONTROL_DELIVERY_QUOTA_PER_MINUTE_MOTION
      ?? Math.max(1, Math.floor(controlDeliveryQuotaPerMinute() / 2)),
  );
  return Number.isFinite(raw) ? Math.trunc(raw) : Math.max(1, Math.floor(controlDeliveryQuotaPerMinute() / 2));
}
/** 配额窗口（ms）。 */
const DELIVERY_QUOTA_WINDOW_MS = 60 * 1000;
/** 安全动作（永不受排队/配额约束）：与共享契约 `ACTUATOR_SAFETY_COMMANDS` 同源。 */
const SAFETY_COMMAND_KEYS: ReadonlySet<string> = new Set(ACTUATOR_SAFETY_COMMANDS);

/**
 * "设备正在忙"的判定口径 = **已投到设备**（`gateway_received`，网关已确认投递）
 * 且尚未回执终态的运动命令。
 *
 * 为什么不含 `sent`：`sent` 表示"命令还没到设备"——它正是我们**即将投递**的东西；
 * 把它算作"在飞"会导致闸门把候选命令自己当成占用者（首版实现的真实缺陷，
 * 由单测抓出：`ids` 里同时出现占用者与候选）。
 */
const DEVICE_BUSY_COMMAND_STATUSES = ['gateway_received'];

/** 命令参数上限（字节，序列化后）：只允许执行必需信息，防止把业务上下文塞进命令面。 */
const COMMAND_PAYLOAD_MAX_BYTES = 4096;
const NO_FURTHER_ACTION_STATUSES = new Set(['executed', 'timeout']);
const IN_FLIGHT_ATTEMPT_STATUSES = new Set(['pending', 'sent', 'gateway_received']);

@Injectable()
export class ControlService {
  private readonly logger = new Logger(ControlService.name);
  /**
   * NO-65a：命令授权指纹的签发/复核器。
   *
   * 配了密钥 → v2（HMAC-SHA256，边缘可验证，防伪造）；
   * 没配 → v1（一致性指纹）并**如实告警**（不静默降级成"看起来安全"）。
   */
  private readonly fingerprintSigner = createFingerprintSigner(
    process.env.EWOH_CONTROL_FINGERPRINT_SECRET,
    // NO-66b：轮换窗口——复核接受上一把密钥（签发只用当前密钥）。
    process.env.EWOH_CONTROL_FINGERPRINT_SECRET_PREVIOUS,
  );
  /** 告警只打一次（进程级：测试会反复实例化服务，逐实例告警会刷屏）。 */
  private static fingerprintSchemeWarned = false;
  /** NO-67c：轮换窗口提示只打一次。 */
  private static rotationWindowWarned = false;
  /**
   * NO-78a：积压快照缓存（按租户分桶；短 TTL）。
   *
   * 为什么缓存：快照是工作台/看板的实时数据源，可能被高频轮询；判定查询是
   * 全表扫（500 行上限）。5s TTL 让"实时"与"不 hammer 数据库"兼得——
   * 巡检（sweep）**不走缓存**（写提醒的动作每次都要真实执行）。
   */
  private static snapshotCache = new Map<
    string,
    { data: Awaited<ReturnType<ControlService['getDeliveryBacklogSnapshot']>>; expiresAt: number }
  >();
  private static snapshotCacheTtlMs(): number {
    const raw = Number(process.env.EWOH_CONTROL_BACKLOG_SNAPSHOT_TTL_MS ?? 5_000);
    return Number.isFinite(raw) && raw >= 0 ? Math.trunc(raw) : 5_000;
  }

  constructor(
    @Inject(DRIZZLE_DATABASE) private readonly db: PostgresJsDatabase,
    @Optional() private readonly auditService?: AuditService,
    @Optional() private readonly approvalService?: ApprovalPersistenceService,
    /**
     * NO-62a：拒绝路径上的撤回/留痕必须**脱离请求事务**提交——
     * 请求事务在抛 409 时会整体回滚（实测：撤回写入被 409 带走）。
     * 缺省（单测替身）时退回普通写入：单测里没有请求事务，不存在回滚窗口。
     */
    @Optional() private readonly requestDatabaseContext?: RequestDatabaseContext,
  ) {}

  async createRequest(input: {
    deviceId: string;
    commandKeys: string[];
    idempotencyKey: string;
  }, actor?: OrgContext): Promise<ControlRequest> {
    if (!input.deviceId?.trim() || !input.commandKeys?.length || !input.idempotencyKey?.trim()) {
      throw new BadRequestException('deviceId, commandKeys and idempotencyKey are required');
    }
    // F1：命令键必须落在**平台词表**内，否则拒绝创建（fail-closed）。
    //
    // 为什么选"拒绝创建"而不是"按高危处理"：词表外的键**注定执行不了**（边缘适配器
    // 一律 `unknown_command_key`，不碰设备）。按高危处理仍会把请求落库、拉起一条审批链、
    // 占用审批人力，批完再被设备拒绝——现场白跑一圈；拒绝在入口处，调用方立刻知道
    // "这个键平台不认"，也不会留下一条永远到不了设备的单子（原则 6/7：别让假动作发生）。
    const unknownCommandKeys = input.commandKeys.filter((key) => !isPlatformCommandKey(key));
    if (unknownCommandKeys.length > 0) {
      throw new BadRequestException(
        `未知 commandKey：${unknownCommandKeys.join(', ')}`
          + '（平台命令词表之外的命令键一律拒绝创建；新增命令键须先在共享执行机构契约中登记）',
      );
    }
    const existing = await this.findByIdempotencyKey(input.idempotencyKey, actor);
    if (existing) {
      return existing;
    }
    // R2-SMI-001：按命令风险分级——高危单进 pending_approval 审批链。
    const risk = classifyControlRisk(input.commandKeys);
    const approvalRequired = risk === 'high';
    // R2-SMI-002：目标设备租户归属断言——已注册设备的 org 必须与发起方
    // 一致（global_admin 显式豁免；未注册设备无 org 事实可断言，网关投递
    // 自然失败，不额外放行跨租户物理面）。
    await this.assertDeviceInOrg(
      input.deviceId,
      actor?.primaryOrgId,
      actor?.isGlobalAdmin === true,
    );
    const request: ControlRequest = {
      id: nextId('ctl'),
      deviceId: input.deviceId,
      idempotencyKey: input.idempotencyKey,
      commandKeys: [...input.commandKeys],
      attempts: [],
      createdAt: new Date().toISOString(),
    };
    try {
      // ADR-077：drizzle 类型安全路径（消除 public. 硬编码）；org 缺省省略
      // 列由 DB GUC default 填充（GUC 空 → NOT NULL 显式失败，fail-closed §33）。
      const [row] = await this.db
        .insert(ewohControlRequest)
        .values({
          requestId: request.id,
          deviceId: request.deviceId,
          controlType: 'device_command',
          commandKeys: request.commandKeys,
          status: approvalRequired ? 'pending_approval' : 'created',
          idempotencyKey: request.idempotencyKey,
          requestedBy: actor?.userId,
          riskLevel: risk,
          ...(actor?.primaryOrgId ? { orgId: actor.primaryOrgId } : {}),
        })
        .returning();
      const createdRequest = this.mapRequest(this.rowFromSelect(row), [], row.orgId);
      if (approvalRequired) {
        // R2-SMI-001（INV-005）：联动 approval 域创建审批实例（角色由
        // APPROVAL_ROLE_POLICY 服务端映射，R2-SMI-003）。审批模块缺失时
        // fail-closed——高危单宁可不创建也不绕过审批。
        if (!this.approvalService) {
          throw new InternalServerErrorException(
            'high-risk control request requires the approval module (INV-005)',
          );
        }
        await this.approvalService.createApproval(
          // roles 仅展示性输入：审批图由服务端按 entityType 映射（R2-SMI-003）。
          { entityType: 'control_request', entityId: createdRequest.id, roles: [] },
          actor,
        );
      }
      await this.recordAudit(
        {
          action: 'control.create',
          entityType: 'control_request',
          entityId: createdRequest.id,
          before: null,
          after: {
            deviceId: createdRequest.deviceId,
            commandKeys: createdRequest.commandKeys,
            idempotencyKey: createdRequest.idempotencyKey,
            status: approvalRequired ? 'pending_approval' : 'created',
            riskLevel: risk,
          },
          // R2-SMI-001：高危创建审计标 risk。
          risk: approvalRequired,
        },
        actor,
      );
      return createdRequest;
    } catch (error) {
      if (this.isUniqueViolation(error)) {
        const concurrent = await this.findByIdempotencyKey(input.idempotencyKey, actor);
        if (concurrent) {
          return concurrent;
        }
      }
      // 审批联动的业务异常（如 org 缺失 401）原样上抛，不吞成 500。
      if (error instanceof HttpException) {
        throw error;
      }
      this.throwPersistence('create control request', error);
    }
  }

  async sendCommand(
    requestId: string,
    commandKey: string,
    actor?: OrgContext,
    payload?: Record<string, unknown>,
  ): Promise<ControlRequest> {
    const requestRow = await this.getRequest(requestId, actor);
    // R2-SMI-009（修正）：行状态 'failed' 放行重试（retry_new_attempt 契约）。
    if (NON_RETRYABLE_REQUEST_STATUSES.has(requestRow.status ?? '')) {
      throw new BadRequestException(
        `Cannot send command on terminal request ${requestId}`,
      );
    }
    const requestStatus = aggregateControlStatus(requestRow.attempts);
    if (NO_FURTHER_ACTION_STATUSES.has(requestStatus)) {
      throw new BadRequestException(
        `Cannot send command on terminal request ${requestId}`,
      );
    }
    if (!requestRow.commandKeys.includes(commandKey)) {
      throw new BadRequestException(`Unknown commandKey ${commandKey}`);
    }
    const latestAttempt = [...requestRow.attempts]
      .filter((attempt) => attempt.commandKey === commandKey)
      .sort((a, b) => b.attemptNo - a.attemptNo)[0];
    if (latestAttempt && IN_FLIGHT_ATTEMPT_STATUSES.has(latestAttempt.status)) {
      throw new BadRequestException(
        `Attempt already in flight for commandKey ${commandKey}`,
      );
    }
    // R2-SMI-001：审批闸门——pending_approval 请求必须等审批实例 approved
    //（control.yaml pending_approval→approved，role:approver）才允许下发。
    const approvalGate = await this.ensureApprovedForSend(requestRow, actor);
    const rowStatusBeforeSend = approvalGate.status;
    // R2-SMI-002：下发前复核目标设备租户归属（以发起方/请求行 org 断言）。
    await this.assertDeviceInOrg(
      requestRow.deviceId,
      actor?.primaryOrgId ?? requestRow.orgId,
      actor?.isGlobalAdmin === true,
    );
    // NO-60a：命令参数（执行机构要"去哪"这类信息）随命令落库，由边缘网关在 pending
    // 轮询里取走。校验 fail-closed：形状非法/超长/缺必需参数一律 400，绝不发一条
    // "参数说不清"的命令给设备（原则 4/6：设备动作必须可追溯、可解释）。
    const commandPayload = this.validateCommandPayload(commandKey, payload);
    // NO-62a：把"这条命令到底被授权做了什么"固化成指纹（请求/设备/命令/审批实例/参数）。
    // 投递前复核会重算同一个指纹——审批之后任何一项被改写都对不上（fail-closed）。
    const commandAuthorizationFingerprint = this.fingerprintSigner.sign({
      requestId,
      deviceId: requestRow.deviceId,
      commandKey,
      approvalInstanceId: approvalGate.approvalInstanceId,
      payload: commandPayload ?? null,
    });
    // NO-67c：**轮换窗口必须是有期限的**——只要 `_PREVIOUS` 还在，被替换掉的旧密钥就仍然可用。
    // 平台无法替运维判断"在飞命令是否已清零"，因此这里只做一次醒目提示（不阻断启动）。
    if (
      String(process.env.EWOH_CONTROL_FINGERPRINT_SECRET_PREVIOUS ?? '').trim() !== ''
      && !ControlService.rotationWindowWarned
    ) {
      ControlService.rotationWindowWarned = true;
      this.logger.warn(
        '授权指纹处于**密钥轮换窗口**（EWOH_CONTROL_FINGERPRINT_SECRET_PREVIOUS 已设置）：'
          + '复核会同时接受上一把密钥。请在飞命令清零后**立即移除该变量并重启**'
          + '（窗口越短越好；留在配置里 = 被替换掉的旧密钥一直可用）。'
          + '在飞计数见设备抽屉「执行边界」面板或 control/commands/pending 的 queued/inFlight。',
      );
    }
    if (
      this.fingerprintSigner.scheme === 'fnv1a64:v1'
      && !ControlService.fingerprintSchemeWarned
    ) {
      ControlService.fingerprintSchemeWarned = true;
      this.logger.warn(
        '授权指纹使用 v1（无密钥一致性校验）：未配置 EWOH_CONTROL_FINGERPRINT_SECRET，'
          + '任何持有边缘 ingest key 的一方都能算出"看起来对"的指纹——生产环境请配置密钥启用 hmac-sha256:v2',
      );
    }
    const attemptNo =
      requestRow.attempts.filter((attempt) => attempt.commandKey === commandKey).length + 1;
    const commandId = nextId('att');
    const rootCommandId =
      requestRow.attempts.find((attempt) => attempt.commandKey === commandKey)?.attemptId ??
      commandId;
    // ADR-077：命令行归属 = 请求行 org（§3 单一事实源）。
    const cmdOrg = requestRow.orgId ?? actor?.primaryOrgId ?? null;
    const isHighRisk = classifyControlRisk(requestRow.commandKeys) === 'high';
    try {
      // NEST-425：attemptNo 由 DB 侧子查询原子生成（max+1），配合
      // standalone_058 唯一约束 (request_id, command_key, attempt_no)——
      // 并发 send 同 commandKey 的重复序号在 DB 层显式冲突（23505），
      // 不再依赖内存 filter.length+1 的读-算-写窗口。
      await this.db.insert(ewohControlCommand).values({
        commandId,
        requestId,
        rootCommandId,
        attemptNo: sql`(select coalesce(max(${ewohControlCommand.attemptNo}), 0) + 1
                        from ${ewohControlCommand}
                        where ${ewohControlCommand.requestId} = ${requestId}
                          and ${ewohControlCommand.commandKey} = ${commandKey})`,
        commandKey,
        status: 'sent',
        sentAt: new Date(),
        payload: commandPayload,
        authorizationFingerprint: commandAuthorizationFingerprint,
        authorizationVerifiedAt: new Date(),
        idempotencyKey: requestRow.idempotencyKey,
        ...(cmdOrg ? { orgId: cmdOrg } : {}),
      });
    } catch (error) {
      if (this.isUniqueViolation(error)) {
        throw new ConflictException(
          `Concurrent send for commandKey ${commandKey} on request ${requestId}`,
        );
      }
      throw error;
    }
    const attempt: ControlAttempt = {
      attemptId: commandId,
      commandKey,
      attemptNo,
      status: 'sent',
    };
    await this.updateRequestStatus(
      requestId,
      aggregateControlStatus([...requestRow.attempts, attempt]),
      requestRow.orgId,
      // R2-SMI-009：以读回的行状态为 CAS 前值（审批通过后为 'approved'）。
      rowStatusBeforeSend,
    );
    await this.recordAudit(
      {
        action: 'control.command.send',
        entityType: 'control_command',
        entityId: commandId,
        before: {
          requestId,
          commandKey,
          previousAttemptCount: requestRow.attempts.length,
        },
        after: {
          commandKey,
          attemptNo,
          status: 'sent',
          // 参数一并入审计（设备动作的"为什么/去哪"必须可追溯）
          payload: commandPayload,
        },
        // R2-SMI-001：高危指令下发审计标 risk:true。
        risk: isHighRisk,
      },
      actor,
    );
    return this.getRequest(requestId, actor);
  }

  /**
   * 命令参数校验（NO-60a）：形状/大小/按命令的必需字段。
   *
   * 只做**形状与必需性**校验，不替现场决定业务语义（目标工位是否存在由执行侧
   * 与调度侧负责）。未知命令键的参数一律拒绝——避免"看起来发出去了"。
   */
  private validateCommandPayload(
    commandKey: string,
    payload?: Record<string, unknown>,
  ): Record<string, unknown> | null {
    const required: Record<string, string[]> = { dispatch_task: ['targetStationId'] };
    const needsFields = (required[commandKey] ?? []).length > 0;
    // 必需参数的命令**不能没有 payload**：`dispatch_task` 不说去哪就不是一条可执行命令
    // （此前"payload 为空直接放行"会让命令发出去却谁也不知道该去哪 —— 由单测抓出）。
    if (payload == null) {
      if (needsFields) {
        throw new BadRequestException(
          `commandKey ${commandKey} 需要 payload.${required[commandKey][0]}（非空字符串）`,
        );
      }
      return null;
    }
    if (typeof payload !== 'object' || Array.isArray(payload)) {
      throw new BadRequestException('payload 必须是 JSON 对象');
    }
    const serialized = JSON.stringify(payload);
    if (serialized.length > COMMAND_PAYLOAD_MAX_BYTES) {
      throw new BadRequestException(
        `payload 过大（>${COMMAND_PAYLOAD_MAX_BYTES} 字节）：命令参数应只带执行必需信息`,
      );
    }
    for (const field of required[commandKey] ?? []) {
      const value = (payload as Record<string, unknown>)[field];
      if (typeof value !== 'string' || value.trim() === '') {
        throw new BadRequestException(`commandKey ${commandKey} 需要 payload.${field}（非空字符串）`);
      }
    }
    return payload;
  }

  /**
   * R2-SMI-001：审批闸门。非 pending_approval 请求直接放行；pending_approval
   * 请求按 (control_request, requestId) 查最近审批实例：
   *   - approved → CAS 落 approved（approver 角色的落地点）并放行；
   *   - 其余（pending/rejected/cancelled/expired/bypassed/缺失）→ 403/409 fail-closed。
   * 返回闸门通过后的当前行状态（作为后续状态写回的 CAS 前值）+ 放行的审批实例号
   * （NO-62a：审批实例号进入**授权范围指纹**，投递时据此复核"还是不是这张审批"）。
   */
  private async ensureApprovedForSend(
    request: ControlRequest,
    actor?: OrgContext,
  ): Promise<{ status: string; approvalInstanceId: string | null }> {
    // NO-62a：判定基准与**投递/确认/回执复核**完全一致（risk_level=high 或
    // 仍待审批）。此前只看 `status !== 'pending_approval'` 就短路返回，
    // 于是"已 CAS 成 approved 的高危请求"在下发第二条命令时不算审批实例号，
    // 投递复核却按高危口径重算 → 指纹必然不符（真实缺陷，本轮单测抓到）。
    const requiresApproval =
      String(request.riskLevel ?? '') === 'high' || request.status === 'pending_approval';
    if (!requiresApproval) {
      return { status: request.status ?? 'created', approvalInstanceId: null };
    }
    if (!this.approvalService) {
      throw new InternalServerErrorException(
        `Control request ${request.id} awaits approval but the approval module is unavailable`,
      );
    }
    const instance = await this.approvalService.findLatestForEntity(
      'control_request',
      request.id,
      actor,
    );
    if (!instance) {
      // 数据不一致（审批实例缺失）：fail-closed，绝不放行。
      throw new ConflictException(
        `Approval instance missing for pending_approval request ${request.id}`,
      );
    }
    if (instance.status !== 'approved') {
      throw new ForbiddenException(
        `Control request ${request.id} awaits approval (approval status: ${instance.status})`,
      );
    }
    // NO-31a：**审批时效**同样适用于控制类审批。
    // 这张审批可能是在很久以前批的（例如半年前演练时开的），而控制请求一直挂在
    // pending_approval；"当时同意"不等于"现在同意"——现场条件、人员、设备状态都可能已变。
    // 缺失通过时间同样拒绝（无法判断时效的凭证不算有效凭证）。
    const freshness = verifyApprovalFreshness(
      { status: instance.status, approvedAt: instance.approvedAt ?? null },
    );
    if (!freshness.ok) {
      throw new ConflictException(
        `APPROVAL_INVALID：${freshness.reason ?? '审批时效校验未通过'}` +
          `（控制请求 ${request.id} 的审批必须是有效期内通过的；请重新发起并完成审批后再下发）`,
      );
    }
    if (request.status === 'pending_approval') {
      const rows = await this.db
        .update(ewohControlRequest)
        .set({
          status: 'approved',
          approvedAt: new Date(),
          approvedBy: instance.steps.find((step) => step.status === 'approved')
            ? actor?.userId ?? 'approver'
            : 'approver',
        })
        .where(
          and(
            eq(ewohControlRequest.requestId, request.id),
            eq(ewohControlRequest.status, 'pending_approval'),
            ...(request.orgId ? [eq(ewohControlRequest.orgId, request.orgId)] : []),
          ),
        )
        .returning({ requestId: ewohControlRequest.requestId });
      if (!rows || rows.length === 0) {
        throw new ConflictException('STATE_CONFLICT');
      }
    }
    return {
      status: 'approved',
      approvalInstanceId: String(instance.id ?? '') || null,
    };
  }

  /**
   * R2-SMI-002：设备租户归属断言。设备已注册（ewoh_device_config 有行且带
   * org）时，org 必须与发起方一致，否则 404（反枚举）；未注册/NULL org
   * legacy 设备行与无 org 上下文的内部可信流放行（RLS 继续兜底）。
   */
  private async assertDeviceInOrg(
    deviceId: string,
    expectedOrgId: string | null | undefined,
    isGlobalAdmin = false,
  ): Promise<void> {
    const expectedOrg = expectedOrgId?.trim() || null;
    if (!expectedOrg || isGlobalAdmin) {
      return;
    }
    const [device] = await this.db
      .select({ orgId: ewohDeviceConfig.orgId })
      .from(ewohDeviceConfig)
      .where(eq(ewohDeviceConfig.deviceId, deviceId))
      .limit(1);
    if (device?.orgId && device.orgId !== expectedOrg) {
      throw new NotFoundException(`Device ${deviceId} not found`);
    }
  }

  async receiveReceipt(
    requestId: string,
    commandKey: string,
    result: 'executed' | 'failed',
    receipt?: Record<string, unknown>,
    actor?: OrgContext,
  ): Promise<ControlRequest> {
    // F3：`result` 是人面入参（HTTP body），而 TS 的联合类型在运行时**不存在**
    // （server 侧 tsconfig.node.json 还是 strict:false，NestJS 的 @Body 也是内联接口、
    // 没有 DTO 校验管道）。不显式校验就能把任意字符串写进
    // `ewoh_control_command.status` 与 `ewoh_control_result.result_code`——两列都没有
    // CHECK 约束兜底。最坏的一条：`result='revoked'` 会把一条在飞命令伪装成
    // "平台已因授权复核撤回"，此后 `ackCommand` 永远拒绝它的投递确认、聚合状态也被改写。
    // 机器面 `receiveReceiptByCommandId` 早已显式校验，这里补齐**同一口径**。
    if (result !== 'executed' && result !== 'failed') {
      throw new BadRequestException("result 必须是 'executed' 或 'failed'");
    }
    // NEST-423：读回带 actor（org 守卫；NULL legacy 行放行与getRequest一致）。
    const request = await this.getRequest(requestId, actor);
    // R2-SMI-009（修正）：行状态 'failed' 放行重试回执（retry_new_attempt 契约）。
    if (NON_RETRYABLE_REQUEST_STATUSES.has(request.status ?? '')) {
      throw new BadRequestException(
        `Cannot record receipt on terminal request ${requestId}`,
      );
    }
    const requestStatus = aggregateControlStatus(request.attempts);
    if (NO_FURTHER_ACTION_STATUSES.has(requestStatus)) {
      throw new BadRequestException(
        `Cannot record receipt on terminal request ${requestId}`,
      );
    }
    // R2-SMI-002：回执路径同样断言设备归属（请求行 org）。
    await this.assertDeviceInOrg(
      request.deviceId,
      request.orgId ?? actor?.primaryOrgId,
      actor?.isGlobalAdmin === true,
    );
    const latest = [...request.attempts]
      .filter((attempt) => attempt.commandKey === commandKey)
      .sort((a, b) => b.attemptNo - a.attemptNo)[0];
    if (!latest) {
      throw new BadRequestException(`No attempt for commandKey ${commandKey}`);
    }
    if (latest.status === 'executed' || latest.status === 'failed') {
      throw new BadRequestException(
        `Duplicate receipt for commandKey ${commandKey}`,
      );
    }
    const receiptJson = receipt ?? {};
    await this.db
      .update(ewohControlCommand)
      .set({
        status: result,
        responseAt: new Date(),
        responseJson: receiptJson,
        errorCode: result === 'failed' ? 'COMMAND_FAILED' : null,
        errorMessage: result === 'failed' ? 'Command failed' : null,
      })
      .where(
        and(
          eq(ewohControlCommand.requestId, requestId),
          eq(ewohControlCommand.commandId, latest.attemptId),
        ),
      );
    // ADR-077：回执行归属 = 请求行 org。
    await this.db.insert(ewohControlResult).values({
      resultId: nextId('res'),
      requestId,
      commandId: latest.attemptId,
      resultType: 'command_receipt',
      resultCode: result,
      resultJson: receiptJson,
      success: result === 'executed',
      ...(request.orgId ? { orgId: request.orgId } : {}),
    });
    const updatedAttempts = request.attempts.map((attempt) =>
      attempt.attemptId === latest.attemptId
        ? { ...attempt, status: result, receipt }
        : attempt,
    );
    await this.updateRequestStatus(
      requestId,
      aggregateControlStatus(updatedAttempts),
      request.orgId,
      // R2-SMI-009：以读回的行状态为 CAS 前值。
      request.status ?? undefined,
    );
    return this.getRequest(requestId);
  }

  async revoke(requestId: string, actor?: OrgContext): Promise<ControlRequest> {
    const request = await this.getRequest(requestId, actor);
    const status = aggregateControlStatus(request.attempts);
    // NEST-424：control.yaml terminal 含 partial_success——mixed 结果的请求
    // 已有命令执行成功，revoke 不再把 partial_success 当可撤销状态放行。
    if (
      TERMINAL_REQUEST_STATUSES.has(request.status ?? '') ||
      ['executed', 'failed', 'timeout', 'partial_success'].includes(status)
    ) {
      throw new BadRequestException(`Cannot revoke terminal request ${requestId}`);
    }
    await this.db
      .update(ewohControlCommand)
      .set({ status: 'failed', responseAt: new Date(), errorMessage: 'revoked by operator' })
      .where(
        and(
          eq(ewohControlCommand.requestId, requestId),
          inArray(ewohControlCommand.status, ['pending', 'sent', 'gateway_received']),
        ),
      );
    const revokedAttempts = request.attempts.map((attempt) =>
      attempt.status === 'pending' || attempt.status === 'sent' || attempt.status === 'gateway_received'
        ? { ...attempt, status: 'failed' as const }
        : attempt,
    );
    // R2-SMI-001：control.yaml non_executing→revoked 终态——尚未向网关发出
    // 任何命令的请求（created/pending_approval/approved）撤销后落 revoked，
    // 不再回退为 'created'；已有 in-flight 命令的撤销维持聚合语义（failed）。
    const nextStatus =
      request.attempts.length === 0 ? 'revoked' : aggregateControlStatus(revokedAttempts);
    await this.updateRequestStatus(
      requestId,
      nextStatus,
      request.orgId,
      // R2-SMI-009：以读回的行状态为 CAS 前值。
      request.status ?? undefined,
    );
    await this.recordAudit(
      {
        action: 'control.revoke',
        entityType: 'control_request',
        entityId: requestId,
        before: { status: request.status ?? status },
        after: { status: nextStatus },
      },
      actor,
    );
    return this.getRequest(requestId, actor);
  }

  async getRequest(requestId: string, actor?: OrgContext): Promise<ControlRequest> {
    const rows = await this.db
      .select({
        requestId: ewohControlRequest.requestId,
        deviceId: ewohControlRequest.deviceId,
        commandKeys: ewohControlRequest.commandKeys,
        idempotencyKey: ewohControlRequest.idempotencyKey,
        status: ewohControlRequest.status,
        requestedAt: ewohControlRequest.requestedAt,
        orgId: ewohControlRequest.orgId,
        riskLevel: ewohControlRequest.riskLevel,
      })
      .from(ewohControlRequest)
      .where(eq(ewohControlRequest.requestId, requestId));
    const row = rows[0];
    if (!row) {
      throw new NotFoundException(`Control request ${requestId} not found`);
    }
    // ADR-077：读面 org 守卫（org 匹配或 NULL legacy 放行，跨租户 404）。
    assertTenantVisible(row.orgId, actor, `Control request ${requestId}`);
    const commandRows = await this.db
      .select({
        commandId: ewohControlCommand.commandId,
        requestId: ewohControlCommand.requestId,
        rootCommandId: ewohControlCommand.rootCommandId,
        attemptNo: ewohControlCommand.attemptNo,
        commandKey: ewohControlCommand.commandKey,
        status: ewohControlCommand.status,
        sentAt: ewohControlCommand.sentAt,
        responseAt: ewohControlCommand.responseAt,
        responseJson: ewohControlCommand.responseJson,
        payload: ewohControlCommand.payload,
        errorCode: ewohControlCommand.errorCode,
        errorMessage: ewohControlCommand.errorMessage,
      })
      .from(ewohControlCommand)
      .where(eq(ewohControlCommand.requestId, requestId))
      .orderBy(desc(ewohControlCommand.attemptNo));
    return this.mapRequest(
      {
        request_id: row.requestId,
        device_id: row.deviceId,
        command_keys: row.commandKeys,
        idempotency_key: row.idempotencyKey,
        status: row.status,
        requested_at: row.requestedAt,
        org_id: row.orgId,
        risk_level: row.riskLevel,
      },
      commandRows.map((command) => ({
        attemptId: command.commandId,
        commandKey: command.commandKey,
        attemptNo: Number(command.attemptNo),
        status: command.status as AttemptStatus,
        receipt: this.asReceipt(command.responseJson),
        payload: this.asPayload(command.payload),
      })),
      row.orgId,
    );
  }

  /**
   * NO-62a：复核拒绝的统一构造。
   *
   * 为什么不用可辨识联合（`{ok:true}|{ok:false}`）：本工程 server 侧
   * `tsconfig.node.json` 为 `strict:false`（`strictNullChecks` 关闭），TS 会把
   * `true`/`false` 字面量归一成 `boolean`，联合**不再可辨识** → `if (!v.ok)` 收窄失效
   * （实测 TS2339）。所以这里用"可空字段 + 单一形状"，把判定显式写成数据。
   */
  private denyDelivery(reason: ControlRevokeReason, detail: string): DeliveryAuthorizationVerdict {
    return { ok: false, reason, detail, fingerprint: '', approvalInstanceId: null };
  }

  /** NO-68a：投递 SLA（命令下发后多久没投出去算积压），可用 env 覆盖。 */
  static deliverySlaMs(): number {
    const raw = Number(process.env.EWOH_CONTROL_DELIVERY_SLA_MS ?? 5 * 60 * 1000);
    return Number.isFinite(raw) && raw > 0 ? Math.trunc(raw) : 5 * 60 * 1000;
  }

  /**
   * NO-68a：待投递积压的租户清单（后台提醒 worker 用）。
   *
   * 只能走受控 SECURITY DEFINER 函数（`ewoh_control_pending_orgs`，standalone_096）：
   * 后台没有 GUC → 直接查业务表被 RLS 全挡 → 表现为"worker 静默 0 条"（本仓库已多次踩到）。
   */
  async listOrgsWithPendingCommands(): Promise<string[]> {
    const rows = (await this.db.execute(sql`
      SELECT org_id FROM ewoh_control_pending_orgs()
    `)) as unknown as Array<{ org_id?: string | null }>;
    return rows
      .map((row) => String(row.org_id ?? '').trim())
      .filter((orgId) => orgId !== '');
  }

  /**
   * NO-68a：**投递积压巡检**——把"命令下发后迟迟没投给设备"变成一条叫到人的提醒。
   *
   * 为什么需要它（闭环缺口）：`pending`/人面读面都只在**有人看**的时候显示积压；
   * 网关掉线、指纹两侧密钥不配对、配额打满、设备一直忙……这些情况下命令会静静地躺在
   * `sent`，现场只会觉得"设备怎么不动"，运维也不知道该去看什么（原则 5/7）。
   *
   * 语义（只写提醒 + 审计，绝不改命令/设备事实——巡检是只读的）：
   *   · 逐设备聚合"超过 SLA 仍未交付"的命令（`status='sent'` 且 `sent_at < now-SLA`）；
   *   · 按设备发**确定性提醒**（同一设备同一积压只提醒一次，靠 notificationId 幂等）；
   *   · 提醒内容带：设备号、积压条数、最久等待时长、最早一条的命令键 —— 现场可照着查；
   *   · 交付过的命令（`delivered_at` 非空）不计入积压：它已经到网关了，问题在设备侧。
   */
  /** NO-70a：升级倍数（积压超过 N 倍 SLA → 升级给生产管理者），可用 env 覆盖。 */
  static backlogEscalationMultiplier(): number {
    const raw = Number(process.env.EWOH_CONTROL_BACKLOG_ESCALATION_MULTIPLIER ?? 3);
    return Number.isFinite(raw) && raw > 0 ? raw : 3;
  }

  /** NO-77a：积压判定的**唯一实现**（巡检与只读快照共用，不许两套口径漂移）。 */
  private async collectBacklogRows(orgId: string): Promise<{
    rows: Array<{
      commandId: string;
      commandKey: string;
      sentAt: Date | null;
      deliveredAt: Date | null;
      orgId: string | null;
      deviceId: string | null;
      status: string | null;
    }>;
    slaMs: number;
    escalationMultiplier: number;
  }> {
    const backlogStatuses = ['sent', 'gateway_received'];
    const slaMs = ControlService.deliverySlaMs();
    const cutoff = new Date(Date.now() - slaMs);
    const rows = await this.db
      .select({
        commandId: ewohControlCommand.commandId,
        commandKey: ewohControlCommand.commandKey,
        sentAt: ewohControlCommand.sentAt,
        deliveredAt: ewohControlCommand.deliveredAt,
        orgId: ewohControlCommand.orgId,
        deviceId: ewohControlRequest.deviceId,
        status: ewohControlCommand.status,
      })
      .from(ewohControlCommand)
      .innerJoin(
        ewohControlRequest,
        eq(ewohControlCommand.requestId, ewohControlRequest.requestId),
      )
      .where(and(
        inArray(ewohControlCommand.status, backlogStatuses),
        lt(ewohControlCommand.sentAt, cutoff),
        // `gateway_received`（已交付）不算"未交付积压"；`sent` 只有在确实未交付时才算。
        or(
          and(eq(ewohControlCommand.status, 'sent'), isNull(ewohControlCommand.deliveredAt)),
          eq(ewohControlCommand.status, 'gateway_received'),
        ),
        or(eq(ewohControlCommand.orgId, orgId), isNull(ewohControlCommand.orgId)),
      ))
      .orderBy(asc(ewohControlCommand.sentAt))
      .limit(500);
    return { rows, slaMs, escalationMultiplier: ControlService.backlogEscalationMultiplier() };
  }

  /**
   * NO-77a：**投递积压实时快照**（只读）——两次巡检之间积压也必须可见、可数。
   *
   * 巡检（sweep）的产出是提醒（有节拍）；快照回答"**现在**积压多少、在哪些设备、
   * 最久等多久、几台已升级"——看板/工作台按它展示，不依赖"恰好有人跑过巡检"。
   * 判定与 sweep 同一实现（`collectBacklogRows`），绝不两套口径。
   */
  async getDeliveryBacklogSnapshot(actor: OrgContext): Promise<{
    slaMs: number;
    escalationMultiplier: number;
    totals: {
      devices: number;
      commands: number;
      undelivered: number;
      receivedNotExecuted: number;
      escalatedDevices: number;
      oldestWaitingMs: number | null;
    };
    devices: Array<{
      deviceId: string;
      commands: number;
      undelivered: number;
      receivedNotExecuted: number;
      oldestWaitingMs: number;
      escalated: boolean;
    }>;
    checkedAt: string;
  }> {
    const orgId = String(actor?.primaryOrgId ?? '').trim();
    if (orgId === '') throw new BadRequestException('getDeliveryBacklogSnapshot: 缺少租户上下文');
    // NO-78a：TTL 缓存命中直接返回（容量收敛防泄漏：仅保留最近 64 个租户）。
    const ttlMs = ControlService.snapshotCacheTtlMs();
    const cached = ControlService.snapshotCache.get(orgId);
    if (ttlMs > 0 && cached && cached.expiresAt > Date.now()) {
      return cached.data;
    }
    const { rows, slaMs, escalationMultiplier } = await this.collectBacklogRows(orgId);
    const now = Date.now();
    const byDevice = new Map<string, typeof rows>();
    for (const row of rows) {
      const deviceId = String(row.deviceId ?? '');
      if (deviceId === '') continue;
      const list = byDevice.get(deviceId) ?? [];
      list.push(row);
      byDevice.set(deviceId, list);
    }
    const devices = [...byDevice.entries()]
      .map(([deviceId, commands]) => {
        const undelivered = commands.filter((c) => c.deliveredAt == null).length;
        const oldest = commands[0];
        const ageMs = oldest?.sentAt
          ? Math.max(0, now - new Date(oldest.sentAt as unknown as string).getTime())
          : 0;
        return {
          deviceId,
          commands: commands.length,
          undelivered,
          receivedNotExecuted: commands.length - undelivered,
          oldestWaitingMs: ageMs,
          escalated: ageMs >= escalationMultiplier * slaMs,
        };
      })
      .sort((a, b) => b.oldestWaitingMs - a.oldestWaitingMs);
    const total = (pick: (d: (typeof devices)[number]) => number) =>
      devices.reduce((acc, d) => acc + pick(d), 0);
    const snapshot = {
      slaMs,
      escalationMultiplier,
      totals: {
        devices: devices.length,
        commands: total((d) => d.commands),
        undelivered: total((d) => d.undelivered),
        receivedNotExecuted: total((d) => d.receivedNotExecuted),
        escalatedDevices: devices.filter((d) => d.escalated).length,
        oldestWaitingMs: devices.length > 0 ? devices[0].oldestWaitingMs : null,
      },
      devices,
      checkedAt: new Date().toISOString(),
    };
    if (ttlMs > 0) {
      if (ControlService.snapshotCache.size >= 64) {
        const oldestKey = ControlService.snapshotCache.keys().next().value;
        if (oldestKey !== undefined) ControlService.snapshotCache.delete(oldestKey);
      }
      ControlService.snapshotCache.set(orgId, {
        data: snapshot,
        expiresAt: Date.now() + ttlMs,
      });
    }
    return snapshot;
  }

  /**
   * NO-91a：积压**历史序列**（最近在前）——趋势可见，漂移早发现。
   */
  async getDeliveryBacklogHistory(
    actor: OrgContext,
    limit = 24,
  ): Promise<{
    slaMs: number;
    escalationMultiplier: number;
    snapshots: Array<{
      checkedAt: string;
      commands: number;
      undelivered: number;
      receivedNotExecuted: number;
      escalatedDevices: number;
    }>;
  }> {
    const orgId = String(actor?.primaryOrgId ?? '').trim();
    if (orgId === '') throw new BadRequestException('getDeliveryBacklogHistory: 缺少租户上下文');
    const bounded = Math.min(Math.max(Number(limit) || 24, 1), 96);
    const rows = await this.db
      .select()
      .from(ewohControlBacklogSnapshot)
      .where(or(eq(ewohControlBacklogSnapshot.orgId, orgId), isNull(ewohControlBacklogSnapshot.orgId)))
      .orderBy(desc(ewohControlBacklogSnapshot.createdAt))
      .limit(bounded);
    return {
      slaMs: ControlService.deliverySlaMs(),
      escalationMultiplier: ControlService.backlogEscalationMultiplier(),
      snapshots: rows.map((row) => {
        const totals = (row.totals ?? {}) as Record<string, number>;
        return {
          checkedAt: row.createdAt ? this.toIso(row.createdAt) : '',
          commands: Number(totals.commands ?? 0),
          undelivered: Number(totals.undelivered ?? 0),
          receivedNotExecuted: Number(totals.receivedNotExecuted ?? 0),
          escalatedDevices: Number(totals.escalatedDevices ?? 0),
        };
      }),
    };
  }

  async sweepDeliveryBacklog(ctx: OrgContext): Promise<{
    scanned: number;
    devicesWithBacklog: number;
    escalatedDevices: number;
    created: number;
    duplicates: number;
    slaMs: number;
    escalationMultiplier: number;
    notificationIds: string[];
  }> {
    const orgId = String(ctx?.primaryOrgId ?? '').trim();
    if (orgId === '') throw new BadRequestException('sweepDeliveryBacklog: 缺少租户上下文');
    // NO-77a：判定与快照共用同一实现（collectBacklogRows）——巡检与看板永不两套口径。
    const { rows, slaMs, escalationMultiplier } = await this.collectBacklogRows(orgId);
    const byDevice = new Map<string, typeof rows>();
    for (const row of rows) {
      const deviceId = String(row.deviceId ?? '');
      if (deviceId === '') continue;
      const list = byDevice.get(deviceId) ?? [];
      list.push(row);
      byDevice.set(deviceId, list);
    }
    let created = 0;
    let duplicates = 0;
    let escalatedDevices = 0;
    const notificationIds: string[] = [];
    const now = Date.now();
    for (const [deviceId, commands] of byDevice) {
      const oldest = commands[0];
      const ageMs = oldest?.sentAt
        ? Math.max(0, now - new Date(oldest.sentAt as unknown as string).getTime())
        : 0;
      const waitedMinutes = Math.max(1, Math.round(ageMs / 60_000));
      // NO-70a：积压年龄超过 N 倍 SLA → **升级**给生产管理者（复用安灯 SLA 升级语义：
      // 一级没人处置/处置不动 → 按倍数升级到上一级，避免"提醒躺着没人管"）。
      const escalated = ageMs >= escalationMultiplier * slaMs;
      const undelivered = commands.filter((c) => c.deliveredAt == null).length;
      const receivedNotExecuted = commands.length - undelivered;
      const result = await insertDeterministicNotifications(this.db as never, {
        orgId,
        externalRef: deviceId,
        prefix: `NTF-CTRL-${deviceId}-`,
        bucket: escalated ? 'delivery_backlog_escalated' : 'delivery_backlog',
        recipients: [
          { recipientType: 'role', recipientId: 'dispatcher' },
          { recipientType: 'role', recipientId: 'workshop_lead' },
          { recipientType: 'role', recipientId: 'device_ops' },
          // NO-70a：升级时**加发**生产管理者（不替换原有收件人——值班仍要看到）。
          ...(escalated ? [{ recipientType: 'role' as const, recipientId: 'production_manager' }] : []),
        ],
        title: escalated
          ? `【升级】控制命令积压超 ${escalationMultiplier} 倍 SLA：${deviceId}`
          : '控制命令积压：下发后迟迟未投递到设备',
        body:
          `设备 ${deviceId} 有 ${commands.length} 条命令积压`
          + `（未交付 ${undelivered} 条；已投未回执 ${receivedNotExecuted} 条），`
          + `最久已等待约 ${waitedMinutes} 分钟`
          + `（SLA ${Math.round(slaMs / 60_000)} 分钟，最早一条 ${oldest?.commandKey ?? '未知命令'}）。`
          + '常见原因：网关掉线 / 指纹密钥两侧不配对（revoked_reason=fingerprint_key_missing）/ '
          + '投递配额用尽（deferred reason=quota）/ 设备一直忙（reason=device_busy）。'
          + '请在设备详情「执行边界」面板核对后处置。'
          + (escalated ? '【已升级至生产管理者：积压超过 3 倍 SLA，请管理层跟进。】' : ''),
        severity: escalated ? 'critical' : 'high',
      });
      created += result.created;
      duplicates += result.duplicates;
      notificationIds.push(...result.notificationIds);
      if (escalated) escalatedDevices += 1;
    }
    // NO-91a：落**历史快照**（趋势可见，漂移早发现）——与提醒同节拍（每次巡检一条）。
    try {
      await this.db.insert(ewohControlBacklogSnapshot).values({
        orgId,
        slaMs,
        escalationMultiplier,
        totals: {
          devices: byDevice.size,
          commands: rows.length,
          undelivered: [...byDevice.values()].reduce(
            (acc, cmds) => acc + cmds.filter((c) => c.deliveredAt == null).length,
            0,
          ),
          receivedNotExecuted: [...byDevice.values()].reduce(
            (acc, cmds) => acc + cmds.filter((c) => c.deliveredAt != null).length,
            0,
          ),
          escalatedDevices,
          oldestWaitingMs: rows.length > 0 && rows[0].sentAt
            ? Math.max(0, now - new Date(rows[0].sentAt as unknown as string).getTime())
            : 0,
        },
        devices: [...byDevice.entries()].map(([devId, cmds]) => ({
          deviceId: devId,
          commands: cmds.length,
          escalated: cmds[0]?.sentAt
            ? (now - new Date(cmds[0].sentAt as unknown as string).getTime()) >= escalationMultiplier * slaMs
            : false,
        })),
      });
    } catch (error) {
      // 快照落库失败不阻断提醒/审计（趋势是增强）；但必须留痕不静默
      this.logger?.warn?.(
        `积压历史快照落库失败（不影响提醒与审计）：${error instanceof Error ? error.message : String(error)}`,
      );
    }

    await this.recordAudit(
      {
        action: 'control.delivery_backlog_sweep',
        entityType: 'control_command',
        entityId: 'delivery-backlog',
        before: { slaMs },
        after: {
          scanned: rows.length,
          devicesWithBacklog: byDevice.size,
          escalatedDevices,
          created,
          duplicates,
          escalationMultiplier,
        },
      },
      ctx,
    );
    return {
      scanned: rows.length,
      devicesWithBacklog: byDevice.size,
      escalatedDevices,
      created,
      duplicates,
      slaMs,
      escalationMultiplier,
      notificationIds,
    };
  }

  /**
   * NO-66a：**人面执行边界读面**——"这台设备的控制命令现在处于什么状态、为什么"。
   *
   * 为什么需要它：平台已经记录了命令的完整生命周期（下发/投递确认/执行回执/授权复核撤回/
   * 未授权执行/一车一活排队/指纹方案），但**现场人看不到**——只有网关（机器身份）能读
   * `pending`。于是"设备为什么不动""为什么这条命令被拒"只能靠翻库或问工程师，
   * 违背原则 5/6（状态与理由必须对现场可见）。
   *
   * 只读；租户隔离与 `pending` 同口径：显式 org 谓词 + actor 过滤（NULL legacy 行放行，
   * 与既有控制读面一致），**RLS 作为第二道**（人面请求走在 GUC 事务里）。
   */
  async listDeviceCommands(
    deviceId: string,
    opts: { limit?: number } = {},
    actor?: OrgContext,
  ): Promise<{
    deviceId: string;
    commands: Array<{
      commandId: string;
      requestId: string;
      commandKey: string;
      attemptNo: number;
      status: string;
      /** 现场可读的投递态：awaiting_delivery / queued_device_busy / gateway_received / 终态 */
      deliveryState: string;
      /** NO-81a：排队原因（device_busy = 一车一活；quota = 配额用尽；null = 未排队）。 */
      queuedReason: 'device_busy' | 'quota' | null;
      /** NO-67b：平台把命令交给网关的时刻（NULL = 从未交付；与"授权复核通过"是两个事实）。 */
      deliveredAt: string | null;
      deliveryNote: string | null;
      sentAt: string | null;
      responseAt: string | null;
      revokedReason: string | null;
      revokedReasonLabel: string | null;
      fingerprintScheme: string;
      fingerprintVerified: boolean;
      /** 投递确认事实（网关 ack）。 */
      ack: { delivered: boolean; reason: string | null; at: string | null } | null;
      /** 执行回执事实（设备执行结果）。 */
      receipt: { result: string | null; at: string | null } | null;
      /** 违规/拒绝留痕（delivery_rejected / authorization_violation）。 */
      violations: Array<{ resultType: string; resultCode: string | null; at: string | null }>;
      executable: boolean;
    }>;
    summary: {
      inFlight: number;
      queued: number;
      awaitingDelivery: number;
      revoked: number;
      busyBlocker: string | null;
      /** NO-68a：未交付命令里最久的等待时长（null = 没有待投递命令）。 */
      oldestWaitingMs?: number | null;
      /** NO-68a：超过投递 SLA 仍未交付的命令数（>0 = 该设备存在投递积压）。 */
      overdue?: number;
      /** NO-68a：当前投递 SLA（ms），供页面判断"算不算积压"。 */
      deliverySlaMs?: number;
      /** NO-81a：排队原因计数（device_busy / quota）——现场要知道在等什么。 */
      queuedReasons?: { device_busy: number; quota: number };
      /** NO-67b：本设备投递配额现状（perMinute<=0 = 不限；remaining=null 表示不限）。 */
      quota?: { perMinute: number; usedInWindow: number; remaining: number | null };
    };
    checkedAt: string;
  }> {
    const wanted = String(deviceId ?? '').trim();
    if (wanted === '') throw new BadRequestException('deviceId 必填');
    const limit = Math.min(Math.max(Number(opts.limit) || 30, 1), 100);
    const tenant = actor?.primaryOrgId ?? null;
    const rows = await this.db
      .select({
        commandId: ewohControlCommand.commandId,
        requestId: ewohControlCommand.requestId,
        commandKey: ewohControlCommand.commandKey,
        attemptNo: ewohControlCommand.attemptNo,
        status: ewohControlCommand.status,
        sentAt: ewohControlCommand.sentAt,
        responseAt: ewohControlCommand.responseAt,
        responseJson: ewohControlCommand.responseJson,
        revokedReason: ewohControlCommand.revokedReason,
        revokedAt: ewohControlCommand.revokedAt,
        errorCode: ewohControlCommand.errorCode,
        errorMessage: ewohControlCommand.errorMessage,
        authorizationFingerprint: ewohControlCommand.authorizationFingerprint,
        authorizationVerifiedAt: ewohControlCommand.authorizationVerifiedAt,
        deliveredAt: ewohControlCommand.deliveredAt,
        orgId: ewohControlCommand.orgId,
        requestDeviceId: ewohControlRequest.deviceId,
      })
      .from(ewohControlCommand)
      .innerJoin(
        ewohControlRequest,
        eq(ewohControlCommand.requestId, ewohControlRequest.requestId),
      )
      .where(and(
        eq(ewohControlRequest.deviceId, wanted),
        tenant === null
          ? sql`true`
          : or(eq(ewohControlCommand.orgId, tenant), isNull(ewohControlCommand.orgId)),
      ))
      .orderBy(desc(ewohControlCommand.sentAt))
      .limit(limit);
    // 违规/拒绝留痕：一次查完（避免逐条 N+1）。
    const commandIds = rows.map((row) => String(row.commandId));
    const violationRows = commandIds.length === 0
      ? []
      : await this.db
          .select({
            commandId: ewohControlResult.commandId,
            resultType: ewohControlResult.resultType,
            resultCode: ewohControlResult.resultCode,
            completedAt: ewohControlResult.completedAt,
            resultJson: ewohControlResult.resultJson,
            success: ewohControlResult.success,
          })
          .from(ewohControlResult)
          .where(inArray(ewohControlResult.commandId, commandIds))
          .orderBy(desc(ewohControlResult.completedAt));
    const resultsByCommand = new Map<string, typeof violationRows>();
    for (const row of violationRows) {
      const key = String(row.commandId);
      const list = resultsByCommand.get(key) ?? [];
      list.push(row);
      resultsByCommand.set(key, list);
    }
    // NO-67b：配额现状（与投递闸门同一计量口径：delivered_at + 60s 窗口；
    // 页面口径为**只读近似**——网关轮询时的 CAS 扣减不在此处）。
    const quotaPerMinute = controlDeliveryQuotaPerMinute();
    const quotaUsed = quotaPerMinute > 0
      ? rows.filter((row) => row.deliveredAt
          && this.toIso(row.deliveredAt) >= new Date(Date.now() - DELIVERY_QUOTA_WINDOW_MS).toISOString())
          .length
      : 0;
    // 一车一活：与投递闸门**同一口径**（设备忙 → 排队），不另写一套判定。
    const busyRow = rows.find(
      (row) => DEVICE_BUSY_COMMAND_STATUSES.includes(String(row.status))
        && MOTION_COMMAND_KEYS.has(String(row.commandKey)),
    );
    const busyBlocker = busyRow
      ? `${String(busyRow.commandKey)}:${String(busyRow.commandId)}`
      : null;
    const commands = rows.map((row) => {
      const status = String(row.status ?? '');
      const key = String(row.commandKey);
      const results = resultsByCommand.get(String(row.commandId)) ?? [];
      const ackRow = results.find((r) => String(r.resultType) === 'gateway_ack');
      const receiptRow = results.find((r) => String(r.resultType) === 'command_receipt');
      const violations = results
        .filter((r) => ['delivery_rejected', 'authorization_violation'].includes(String(r.resultType)))
        .map((r) => ({
          resultType: String(r.resultType),
          resultCode: r.resultCode ? String(r.resultCode) : null,
          at: r.completedAt ? this.toIso(r.completedAt) : null,
        }));
      const busyQueued = status === 'sent'
        && MOTION_COMMAND_KEYS.has(key)
        && busyBlocker !== null
        && busyBlocker !== `${key}:${String(row.commandId)}`;
      // NO-81a：排队原因细分——运动命令被"一车一活"挡（device_busy）；其余普通命令
      // 在配额用尽时被"限流"挡（quota）。两者都不是失败，但**解除条件不同**
      // （前者等设备空下来，后者等下一分钟窗口），现场要知道自己在等什么。
      // 页面口径为只读近似（未含网关 CAS 扣减）；安全动作（stop）永不因配额排队。
      const quotaRemainingNow = quotaPerMinute > 0
        ? Math.max(0, quotaPerMinute - quotaUsed)
        : null;
      const quotaQueued = status === 'sent'
        && !SAFETY_COMMAND_KEYS.has(key)
        && !busyQueued
        && quotaRemainingNow !== null
        && quotaRemainingNow <= 0;
      const queuedReason: 'device_busy' | 'quota' | null = busyQueued
        ? 'device_busy'
        : quotaQueued
          ? 'quota'
          : null;
      const deliveryState = busyQueued
        ? 'queued_device_busy'
        : quotaQueued
          ? 'queued_quota'
          : status === 'sent'
            ? 'awaiting_delivery'
            : status;
      const fingerprint = String(row.authorizationFingerprint ?? '');
      const ackJson = ackRow?.resultJson && typeof ackRow.resultJson === 'object'
        ? (ackRow.resultJson as Record<string, unknown>)
        : null;
      return {
        commandId: String(row.commandId),
        requestId: String(row.requestId),
        commandKey: key,
        attemptNo: Number(row.attemptNo),
        status,
        deliveryState,
        queuedReason,
        deliveryNote: quotaQueued
          ? '投递配额本分钟已用尽，等待下一分钟窗口（限流 ≠ 失败）'
          : busyQueued
            ? `设备正在执行 ${busyBlocker}，本条按"一车一活"排队（暂缓 ≠ 失败）`
            : status === 'revoked'
            ? row.errorMessage
              ? String(row.errorMessage)
              : CONTROL_REVOKE_REASON_LABELS[
                  (String(row.revokedReason ?? '') as ControlRevokeReason)
                ] ?? null
            : null,
        sentAt: row.sentAt ? this.toIso(row.sentAt) : null,
        deliveredAt: row.deliveredAt ? this.toIso(row.deliveredAt) : null,
        responseAt: row.responseAt ? this.toIso(row.responseAt) : null,
        revokedReason: row.revokedReason ? String(row.revokedReason) : null,
        revokedReasonLabel: row.revokedReason
          ? CONTROL_REVOKE_REASON_LABELS[String(row.revokedReason) as ControlRevokeReason] ?? null
          : null,
        fingerprintScheme: fingerprint.startsWith('hmac-sha256:v2:')
          ? 'hmac-sha256:v2'
          : fingerprint === ''
            ? 'none'
            : 'fnv1a64:v1',
        // "验过"= 平台复核通过并落过时间；v1 行的核对是同一字段（一致性核对）。
        fingerprintVerified: Boolean(row.authorizationVerifiedAt),
        ack: ackRow
          ? {
              delivered: Boolean(ackRow.success),
              reason: ackJson && ackJson.reason ? String(ackJson.reason) : null,
              at: ackRow.completedAt ? this.toIso(ackRow.completedAt) : null,
            }
          : null,
        receipt: receiptRow
          ? {
              result: receiptRow.resultCode ? String(receiptRow.resultCode) : null,
              at: receiptRow.completedAt ? this.toIso(receiptRow.completedAt) : null,
            }
          : null,
        violations,
        executable: ['sent', 'gateway_received'].includes(status),
      };
    });
    return {
      deviceId: wanted,
      commands,
      summary: {
        inFlight: commands.filter((c) => c.status === 'gateway_received').length,
        queued: commands.filter((c) => c.deliveryState === 'queued_device_busy').length,
        awaitingDelivery: commands.filter((c) => c.deliveryState === 'awaiting_delivery').length,
        revoked: commands.filter((c) => c.status === 'revoked').length,
        busyBlocker,
        // NO-68a：投递老化——"没人看的时候积压是否存在"必须能从读面直接回答。
        oldestWaitingMs: (() => {
          const waits = commands
            .filter((c) => c.status === 'sent' && c.sentAt)
            .map((c) => Date.now() - new Date(String(c.sentAt)).getTime())
            .filter((ms) => Number.isFinite(ms) && ms >= 0);
          return waits.length > 0 ? Math.max(...waits) : null;
        })(),
        overdue: commands.filter(
          (c) => c.status === 'sent'
            && c.sentAt
            && Date.now() - new Date(String(c.sentAt)).getTime() >= ControlService.deliverySlaMs(),
        ).length,
        deliverySlaMs: ControlService.deliverySlaMs(),
        queuedReasons: {
          device_busy: commands.filter((c) => c.queuedReason === 'device_busy').length,
          quota: commands.filter((c) => c.queuedReason === 'quota').length,
        },
        quota: {
          perMinute: quotaPerMinute,
          usedInWindow: quotaUsed,
          remaining: quotaPerMinute > 0 ? Math.max(0, quotaPerMinute - quotaUsed) : null,
        },
      },
      checkedAt: new Date().toISOString(),
    };
  }

  /**
   * NO-62a：**投递前授权复核**（对单条命令）。
   *
   * 为什么必须在投递路径上再验一次：平台原来只在**人工下发**那一步校验审批
   * （`ensureApprovedForSend`）。命令落成 `sent` 之后，网关轮询只检查"请求行是否终态"
   * ——于是「审批通过 → 下发 → 网关投递」之间若审批被撤销/过期、或授权范围被改写，
   * 命令照样会投到 AGV 上执行：授权链在投递路径上是 **fail-open** 的（原则 4/8）。
   *
   * 复核项（任一不过 → 拒绝投递并撤回命令）：
   *   1. 请求行状态：`revoked` → authorization_revoked；其它终态 → request_terminal；
   *   2. 租户归属：命令行 org 必须与请求行 org 一致（device_org_mismatch）；
   *   3. 需要审批的高危请求：审批实例必须存在（approval_missing）、已通过
   *      （approval_not_granted）、在有效期内（authorization_expired）。
   *      「高危」的判定 = 请求行 risk_level（创建时冻结）**或当前词表对本条命令键的定级**
   *      （F2：词表演进后，冻结值可能已经过时，见下方 reclassifiedHigh）；
   *   4. 授权范围指纹：请求/设备/命令/审批实例/参数重算的指纹必须与下发时一致
   *      （fingerprint_mismatch）。缺失指纹的存量行允许补写（迁移语义），
   *      但一旦写过就不允许再变。
   */
  private async verifyDeliveryAuthorization(
    request: {
      requestId: string;
      deviceId: string;
      status: string;
      riskLevel: string | null;
      orgId: string | null;
    },
    command: {
      commandKey: string;
      payload: Record<string, unknown> | null;
      orgId: string | null;
      authorizationFingerprint: string | null;
    },
    actor?: OrgContext,
  ): Promise<DeliveryAuthorizationVerdict> {
    const scopeOf = (approvalInstanceId: string | null) => ({
      requestId: request.requestId,
      deviceId: request.deviceId,
      commandKey: command.commandKey,
      approvalInstanceId,
      payload: command.payload ?? null,
    });
    const fingerprintOf = (approvalInstanceId: string | null) =>
      this.fingerprintSigner.sign(scopeOf(approvalInstanceId));
    const status = String(request.status ?? '');
    if (status === 'revoked') {
      return this.denyDelivery('authorization_revoked', CONTROL_REVOKE_REASON_LABELS.authorization_revoked);
    }
    if (TERMINAL_REQUEST_STATUSES.has(status)) {
      return this.denyDelivery(
        'request_terminal',
        `控制请求已终态（${status}）：${CONTROL_REVOKE_REASON_LABELS.request_terminal}`,
      );
    }
    if (command.orgId && request.orgId && String(command.orgId) !== String(request.orgId)) {
      return this.denyDelivery(
        'device_org_mismatch',
        `${CONTROL_REVOKE_REASON_LABELS.device_org_mismatch}（命令 ${command.orgId}；请求 ${request.orgId}）`,
      );
    }
    // 需要审批的判定以请求行 risk_level 为准（高危单在创建时落 high），
    // pending_approval 一律按"需要审批"处理（fail-closed，不因为状态机没走完就跳过）。
    //
    // F2：**投递前还要按当前词表复核一遍本条命令的风险等级**。理由：`risk_level` 是
    // **创建那一刻冻结**的值，而词表会演进（NO-60a 刚把 dispatch_task/resume/clear_fault
    // 并入高危）——只信那个冻结值，词表升级前创建的行就会永远以 'normal' 免审批投递，
    // 授权链在投递路径上重新变成 fail-open。复核口径 = 当前词表对本条命令键的分级。
    //
    // 为什么只看**本条命令键**而不是整张请求的键列表：安全动作（stop）必须始终可投递，
    // 不能因为同一张单子里还夹着一条高危命令，就把急停一起卡在投递口
    // （与 NO-62b"安全动作插队"同一条纪律）。
    const reclassifiedHigh = classifyControlRisk([command.commandKey]) === 'high';
    const requiresApproval =
      String(request.riskLevel ?? '') === 'high'
      || status === 'pending_approval'
      || reclassifiedHigh;
    let approvalInstanceId: string | null = null;
    if (requiresApproval) {
      if (!this.approvalService) {
        return this.denyDelivery('approval_missing', '审批模块不可用：无法证明授权，拒绝投递');
      }
      const instance = await this.approvalService.findLatestForEntity(
        'control_request',
        request.requestId,
        actor,
      );
      if (!instance) {
        return this.denyDelivery(
          'approval_missing',
          `控制请求 ${request.requestId} 找不到审批实例：${CONTROL_REVOKE_REASON_LABELS.approval_missing}`,
        );
      }
      if (instance.status !== 'approved') {
        return this.denyDelivery(
          instance.status === 'expired' ? 'authorization_expired' : 'approval_not_granted',
          `审批实例状态为 ${instance.status}：${CONTROL_REVOKE_REASON_LABELS.approval_not_granted}`,
        );
      }
      const freshness = verifyApprovalFreshness({
        status: instance.status,
        approvedAt: instance.approvedAt ?? null,
      });
      if (!freshness.ok) {
        return this.denyDelivery(
          'authorization_expired',
          `${freshness.reason ?? CONTROL_REVOKE_REASON_LABELS.authorization_expired}`,
        );
      }
      approvalInstanceId = String((instance as { id?: string }).id ?? '') || null;
    }
    // NO-65a：按**已存指纹的方案**复核（v2 需密钥；缺密钥 → 显式拒绝，不退回 v1）。
    const verdict = this.fingerprintSigner.verify(
      command.authorizationFingerprint,
      scopeOf(approvalInstanceId),
    );
    if (!verdict.ok) {
      const reason = verdict.reason ?? 'fingerprint_mismatch';
      return this.denyDelivery(
        reason,
        `${CONTROL_REVOKE_REASON_LABELS[reason] ?? reason}：${verdict.detail ?? ''}`,
      );
    }
    return {
      ok: true,
      reason: null,
      detail: null,
      fingerprint: verdict.expected,
      approvalInstanceId,
    };
  }

  /**
   * NO-62a：撤回一条未投递的命令（复核未通过）——**写事实、写审计、写提醒**。
   *
   * 关键语义：撤回 ≠ 失败。命令从未投给设备，所以它不是"设备执行失败"，
   * 也不能让请求看起来"已尝试执行"（原则 6）。撤回后请求聚合状态由
   * `aggregateControlStatus` 依据 `revoked` 尝试推导（全撤回 → revoked）。
   */
  private async revokeUndeliveredCommand(
    command: { commandId: string; requestId: string; commandKey: string; attemptNo: number; orgId: string | null },
    reason: ControlRevokeReason,
    detail: string,
    actor?: OrgContext,
  ): Promise<void> {
    // NO-62a：撤回是**安全决策**，必须比"返回 409"活得更久。
    // 实测缺陷：ack 路径上"撤回 → 抛 409"时，请求事务回滚把撤回写入一起带走，
    // 命令留在 sent，下一轮轮询还会把它投给设备（fail-open 复现）。
    // 因此这里整体放到独立事务里提交（无 requestDatabaseContext 替身时退回同事务）。
    const settings = this.detachedGucSettings(command.orgId, actor);
    if (this.requestDatabaseContext && settings.length > 0) {
      await this.requestDatabaseContext.runDetachedTransaction(
        settings,
        async () => this.revokeUndeliveredCommandWrites(command, reason, detail, actor),
      );
      return;
    }
    if (this.requestDatabaseContext && settings.length === 0) {
      // 无租户归属（legacy NULL-org 行）：独立事务没有 GUC → RLS 会拒绝写入。
      // 如实降级为同事务写入并留痕——不假装"已经独立提交"。
      this.logger.warn(
        `revoke ${command.commandId} 缺少租户归属：撤回写入与请求事务同生共死（无法独立提交）`,
      );
    }
    await this.revokeUndeliveredCommandWrites(command, reason, detail, actor);
  }

  /**
   * 撤回的 GUC 设置：直接用**权威实现** `buildGucSettings`（org + org 列表 + 用户 +
   * 全局管理员），不手写设置名——实测教训：手写时漏了 `app.current_org_ids`
   * （RLS 的 `ewoh_org_visible()` 读的就是它），独立事务里的写入被 RLS 拒绝成 500。
   */
  private detachedGucSettings(
    orgId: string | null,
    actor?: OrgContext,
  ): TransactionSettingLike[] {
    const org = String(orgId ?? actor?.primaryOrgId ?? '').trim();
    if (!org) return [];
    return buildGucSettings({
      userId: actor?.userId ?? 'system',
      primaryOrgId: org,
      accessibleOrgIds:
        actor?.accessibleOrgIds && actor.accessibleOrgIds.length > 0
          ? actor.accessibleOrgIds
          : [org],
      isGlobalAdmin: actor?.isGlobalAdmin === true,
    } as OrgContext);
  }

  /** 撤回的写入体（命令行 + 结果行 + 审计 + 提醒 + 请求聚合状态）。 */
  private async revokeUndeliveredCommandWrites(
    command: { commandId: string; requestId: string; commandKey: string; attemptNo: number; orgId: string | null },
    reason: ControlRevokeReason,
    detail: string,
    actor?: OrgContext,
  ): Promise<void> {
    const now = new Date();
    await this.db
      .update(ewohControlCommand)
      .set({
        status: 'revoked',
        revokedReason: reason,
        revokedAt: now,
        responseAt: now,
        errorCode: 'AUTHORIZATION_REVOKED',
        errorMessage: detail.slice(0, 500),
      })
      .where(and(
        eq(ewohControlCommand.commandId, command.commandId),
        eq(ewohControlCommand.status, 'sent'),
      ));
    await this.db.insert(ewohControlResult).values({
      resultId: nextId('res'),
      requestId: command.requestId,
      commandId: command.commandId,
      resultType: 'delivery_rejected',
      resultCode: reason,
      resultJson: {
        reason,
        label: CONTROL_REVOKE_REASON_LABELS[reason],
        detail,
        commandKey: command.commandKey,
        attemptNo: command.attemptNo,
        rejectedAt: now.toISOString(),
      },
      success: false,
      ...(command.orgId ? { orgId: command.orgId } : {}),
    });
    await this.recordAudit(
      {
        action: 'control.command.delivery_rejected',
        entityType: 'control_command',
        entityId: command.commandId,
        before: { status: 'sent' },
        after: { status: 'revoked', reason, detail, requestId: command.requestId },
        risk: true,
      },
      actor,
    );
    try {
      await insertDeterministicNotifications(this.db as never, {
        orgId: command.orgId,
        externalRef: command.commandId,
        prefix: `NTF-CTRL-${command.commandId}-`,
        bucket: 'delivery_revoked',
        recipients: [
          { recipientType: 'role', recipientId: 'workshop_lead' },
          { recipientType: 'role', recipientId: 'dispatcher' },
        ],
        title: '控制命令被拒绝投递（授权复核未通过）',
        body:
          `命令 ${command.commandKey}（请求 ${command.requestId}）未能投给设备：` +
          `${CONTROL_REVOKE_REASON_LABELS[reason]}（原因码 ${reason}）。` +
          `详情：${detail}`,
        severity: 'high',
      });
    } catch (err) {
      // 提醒失败不影响"命令已撤回"这一事实（撤回已在上面落库），但要留痕。
      this.logger.warn(
        `delivery_revoked notification failed for ${command.commandId}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    const latest = await this.getRequestOrNull(command.requestId, actor);
    if (latest) {
      await this.updateRequestStatus(
        command.requestId,
        aggregateControlStatus(latest.attempts),
        latest.orgId ?? undefined,
        latest.status ?? undefined,
      );
    }
  }

  /**
   * NO-62a：风险等级取自**已经过租户守卫的请求读回**（`getRequest` → `mapRequest.riskLevel`）。
   *
   * 为什么不单独查一行：那条独立查询既绕开了 `assertTenantVisible`（org 谓词审计当场报
   * `org_predicate` 违规），又多一次往返。读不到（缺字段的 legacy 行）→ `'high'`
   * （fail-closed：无法证明"不需要审批"就按需要审批处理）。
   */
  private riskLevelOf(request: { riskLevel?: string | null }): string {
    return request.riskLevel ? String(request.riskLevel) : 'high';
  }

  /** 读请求（不存在返回 null；用于撤回后的聚合状态回写，不抛 404）。 */
  private async getRequestOrNull(
    requestId: string,
    actor?: OrgContext,
  ): Promise<ControlRequest | null> {
    try {
      return await this.getRequest(requestId, actor);
    } catch {
      return null;
    }
  }

  /**
   * NO-60a / NO-62a / NO-62b：边缘网关**待投递命令**读面（poll 式下行）。
   *
   * 为什么用轮询而不是平台主动推：工厂边缘通常在内网/NAT 后，平台无法直连；
   * 轮询 + 幂等 ack 是可在现场落地的下行方式，且**不引入新基础设施**。
   *
   * 返回条件（缺一不可）：本租户 + 目标设备匹配 + 命令状态 `sent`（尚未被网关接收）
   * + 请求行非终态 + **投递前授权复核通过**（NO-62a）。每条命令带**平台签发的授权号**
   * `control:<requestId>`（高危命令在边缘侧的授权闸门由此满足，且可回溯到审批过的请求）。
   *
   * 排序（NO-62b）：按**命令优先级**（`stop` 安全停机最先）再按 `sentAt`。
   * 此前一律 `sentAt ASC + limit`：一条排队中的急停会被前面几十条搬运命令挤出窗口，
   * 现场按下急停却要等搬运命令投完才生效——排序在这里是安全语义，不是体验优化。
   *
   * 副作用（唯一一处非只读）：复核未通过的命令会被**撤回**（`status='revoked'` +
   * 原因 + 结果行 + 审计 + 提醒）。撤回的是"尚未投给设备"的命令，不是设备事实。
   */
  async listPendingCommands(
    deviceId: string,
    opts: { limit?: number } = {},
    actor?: OrgContext,
  ): Promise<{
    deviceId: string;
    commands: Array<{
      commandId: string;
      requestId: string;
      commandKey: string;
      attemptNo: number;
      authorizationRef: string;
      /** NO-62a：授权范围指纹（边缘侧原样回传，平台据此发现"执行的东西被换过"）。 */
      authorizationFingerprint: string;
      /**
       * NO-65a：**可验证的授权范围**（请求/设备/命令/审批实例）——边缘据此重算材料
       * 并验证 HMAC 签名（缺了它边缘无法重建材料，只能"盲信"指纹）。
       */
      authorizationScope: {
        requestId: string;
        deviceId: string;
        commandKey: string;
        approvalInstanceId: string | null;
      };
      /** NO-62b：投递优先级（越小越先；stop=0）。 */
      priority: number;
      priorityLabel: string;
      payload: Record<string, unknown> | null;
      sentAt: string | null;
      orgId: string | null;
    }>;
    /** NO-62b：待投递积压（本设备、本租户、投递前未复核的全部 sent 命令数）。 */
    queued: number;
    /** 本轮被撤回（复核未通过）的命令数——现场必须看得见"有命令被拦下了"。 */
    revoked: number;
    /**
     * NO-65b：本轮**因设备仍在执行上一条运动命令而暂缓投递**的命令（含原因）。
     * 暂缓 ≠ 失败：命令保持 `sent`，设备空下来后下一轮照常投递（幂等由平台保证）。
     */
    deferred: Array<{ commandId: string; commandKey: string; reason: string; blockedBy: string }>;
    /**
     * NO-67b：本设备投递配额现状（`perMinute <= 0` = 不限）。
     * `usedInWindow` = **本轮开始前**窗口内已投递条数（不含本轮即将投出的）；
     * `remaining` = 本轮还能投几条（null = 不限；0 = 已用尽，后续命令排队到下一分钟）。
     * NO-74c：`motion*` 三元组为运动类命令（dispatch_task/resume）的更严配额，同口径。
     */
    quota: {
      perMinute: number;
      usedInWindow: number;
      remaining: number | null;
      motionPerMinute: number;
      motionUsedInWindow: number;
      motionRemaining: number | null;
    };
    oldestSentAt: string | null;
    /** 待投递命令数超过扫描上限（true = 计数是下界，不是精确值）。 */
    truncated: boolean;
    checkedAt: string;
  }> {
    const wanted = String(deviceId ?? '').trim();
    if (wanted === '') throw new BadRequestException('deviceId 必填');
    const limit = Math.min(Math.max(Number(opts.limit) || 20, 1), 100);
    // NO-62b：SQL 侧按优先级排序（共享词表单一事实源生成 CASE），
    // 否则"按 sentAt 取前 N 条"会把晚到的 stop 挡在窗口之外。
    const priorityCase = sql`case ${ewohControlCommand.commandKey} ${sql.join(
      Object.entries(ACTUATOR_COMMAND_PRIORITY).map(
        ([key, priority]) => sql`when ${key} then ${priority}`,
      ),
      sql` `,
    )} else ${UNKNOWN_COMMAND_PRIORITY} end`;
    const rows = await this.db
      .select({
        commandId: ewohControlCommand.commandId,
        requestId: ewohControlCommand.requestId,
        commandKey: ewohControlCommand.commandKey,
        attemptNo: ewohControlCommand.attemptNo,
        status: ewohControlCommand.status,
        sentAt: ewohControlCommand.sentAt,
        payload: ewohControlCommand.payload,
        orgId: ewohControlCommand.orgId,
        authorizationFingerprint: ewohControlCommand.authorizationFingerprint,
        requestStatus: ewohControlRequest.status,
        requestDeviceId: ewohControlRequest.deviceId,
        requestRiskLevel: ewohControlRequest.riskLevel,
        requestOrgId: ewohControlRequest.orgId,
      })
      .from(ewohControlCommand)
      .innerJoin(
        ewohControlRequest,
        eq(ewohControlCommand.requestId, ewohControlRequest.requestId),
      )
      .where(and(
        eq(ewohControlRequest.deviceId, wanted),
        eq(ewohControlCommand.status, 'sent'),
      ))
      .orderBy(priorityCase, asc(ewohControlCommand.sentAt))
      .limit(PENDING_SCAN_CAP);
    const tenant = actor?.primaryOrgId ?? null;
    const visible = rows
      // 租户隔离：网关只能看到自己租户的命令（无 actor → 内部可信流，RLS 兜底）
      .filter((row) => tenant === null || row.orgId === null || String(row.orgId) === tenant);
    // NO-65b：设备当前**在飞的运动命令**（sent/gateway_received）——用于"一车一活"投递闸门。
    // 注意查询口径：按**设备**（不是 requestId）跨全部请求查，否则"另一张单子派的活"看不见。
    const inFlightMotion = await this.db
      .select({
        commandId: ewohControlCommand.commandId,
        commandKey: ewohControlCommand.commandKey,
      })
      .from(ewohControlCommand)
      .innerJoin(
        ewohControlRequest,
        eq(ewohControlCommand.requestId, ewohControlRequest.requestId),
      )
      .where(and(
        eq(ewohControlRequest.deviceId, wanted),
        inArray(ewohControlCommand.status, DEVICE_BUSY_COMMAND_STATUSES),
        inArray(ewohControlCommand.commandKey, [...MOTION_COMMAND_KEYS]),
      ))
      .orderBy(asc(ewohControlCommand.sentAt))
      .limit(5);
    // NO-67b：本设备最近 60s 投出去的条数（按"投递前复核通过时刻"计）。
    const quotaPerMinute = controlDeliveryQuotaPerMinute();
    const quotaPerMinuteMotion = controlDeliveryQuotaPerMinuteMotion();
    const windowStart = new Date(Date.now() - DELIVERY_QUOTA_WINDOW_MS);
    // 需要按命令类别分桶计数（NO-74c）：运动类吃更严的 motion 配额，其余吃通用配额。
    const needWindow = quotaPerMinute > 0 || quotaPerMinuteMotion > 0;
    const deliveredRecently = needWindow
      ? await this.db
          .select({
            commandId: ewohControlCommand.commandId,
            commandKey: ewohControlCommand.commandKey,
          })
          .from(ewohControlCommand)
          .innerJoin(
            ewohControlRequest,
            eq(ewohControlCommand.requestId, ewohControlRequest.requestId),
          )
          .where(and(
            eq(ewohControlRequest.deviceId, wanted),
            gte(ewohControlCommand.deliveredAt, windowStart),
          ))
          .limit(1000)
      : [];
    const usedInWindow = deliveredRecently.length;
    const usedMotionInWindow = deliveredRecently.filter((row) =>
      MOTION_COMMAND_KEYS.has(String(row.commandKey)),
    ).length;
    let quotaRemaining = quotaPerMinute > 0
      ? Math.max(0, quotaPerMinute - usedInWindow)
      : Number.POSITIVE_INFINITY;
    let quotaMotionRemaining = quotaPerMinuteMotion > 0
      ? Math.max(0, quotaPerMinuteMotion - usedMotionInWindow)
      : Number.POSITIVE_INFINITY;
    const inFlightMotionIds = new Set(inFlightMotion.map((row) => String(row.commandId)));
    const inFlightBy = inFlightMotion[0]
      ? `${String(inFlightMotion[0].commandKey)}:${String(inFlightMotion[0].commandId)}`
      : null;
    const deferred: Array<{ commandId: string; commandKey: string; reason: string; blockedBy: string }> = [];
    const verified: Array<{
      commandId: string;
      requestId: string;
      commandKey: string;
      attemptNo: number;
      authorizationRef: string;
      authorizationFingerprint: string;
      authorizationScope: {
        requestId: string;
        deviceId: string;
        commandKey: string;
        approvalInstanceId: string | null;
      };
      priority: number;
      priorityLabel: string;
      payload: Record<string, unknown> | null;
      sentAt: string | null;
      orgId: string | null;
      hadStoredFingerprint: boolean;
    }> = [];
    let revoked = 0;
    for (const row of visible) {
      const payload = this.asPayload(row.payload);
      const verification = await this.verifyDeliveryAuthorization(
        {
          requestId: String(row.requestId),
          deviceId: String(row.requestDeviceId ?? wanted),
          status: String(row.requestStatus ?? ''),
          riskLevel: row.requestRiskLevel ? String(row.requestRiskLevel) : null,
          orgId: row.requestOrgId ? String(row.requestOrgId) : null,
        },
        {
          commandKey: String(row.commandKey),
          payload,
          orgId: row.orgId ? String(row.orgId) : null,
          authorizationFingerprint: row.authorizationFingerprint
            ? String(row.authorizationFingerprint)
            : null,
        },
        actor,
      );
      if (!verification.ok) {
        revoked += 1;
        await this.revokeUndeliveredCommand(
          {
            commandId: String(row.commandId),
            requestId: String(row.requestId),
            commandKey: String(row.commandKey),
            attemptNo: Number(row.attemptNo),
            orgId: row.orgId ? String(row.orgId) : null,
          },
          verification.reason ?? 'approval_not_granted',
          verification.detail ?? CONTROL_REVOKE_REASON_LABELS.approval_not_granted,
          actor,
        );
        continue;
      }
      // 投递闸门：设备上已有在飞的运动命令，且本条也是运动命令（且不是它自己）→ 暂缓。
      // 安全动作（stop/pause/return_to_dock/clear_fault）**永不暂缓**：降险与停机必须能插队。
      const key = String(row.commandKey);
      if (
        MOTION_COMMAND_KEYS.has(key)
        && inFlightBy !== null
        && !inFlightMotionIds.has(String(row.commandId))
      ) {
        deferred.push({
          commandId: String(row.commandId),
          commandKey: key,
          reason: 'device_busy',
          blockedBy: inFlightBy,
        });
        continue;
      }
      // NO-67b/NO-74c：配额闸门。**安全动作插队且不占配额**（停机不能被吞吐限制卡住）；
      // 运动类吃更严的 motion 配额，其余吃通用配额；本分钟用尽后显式排队（`reason: quota`）。
      const motionQuotaBlocked = MOTION_COMMAND_KEYS.has(key) && quotaMotionRemaining <= 0;
      const generalQuotaBlocked = !SAFETY_COMMAND_KEYS.has(key) && quotaRemaining <= 0;
      if (!SAFETY_COMMAND_KEYS.has(key) && (motionQuotaBlocked || generalQuotaBlocked)) {
        deferred.push({
          commandId: String(row.commandId),
          commandKey: key,
          reason: 'quota',
          blockedBy: motionQuotaBlocked
            ? `quota-motion:${quotaPerMinuteMotion}/min`
            : `quota:${quotaPerMinute}/min`,
        });
        continue;
      }
      if (!SAFETY_COMMAND_KEYS.has(key) && Number.isFinite(quotaRemaining)) {
        quotaRemaining -= 1;
      }
      if (!SAFETY_COMMAND_KEYS.has(key) && MOTION_COMMAND_KEYS.has(key) && Number.isFinite(quotaMotionRemaining)) {
        quotaMotionRemaining -= 1;
      }
      verified.push({
        commandId: String(row.commandId),
        requestId: String(row.requestId),
        commandKey: String(row.commandKey),
        attemptNo: Number(row.attemptNo),
        authorizationRef: `control:${row.requestId}`,
        authorizationFingerprint: verification.fingerprint,
        authorizationScope: {
          requestId: String(row.requestId),
          deviceId: String(row.requestDeviceId ?? wanted),
          commandKey: String(row.commandKey),
          approvalInstanceId: verification.approvalInstanceId,
        },
        priority: actuatorCommandPriority(row.commandKey),
        priorityLabel: actuatorCommandPriorityLabel(row.commandKey),
        payload,
        sentAt: row.sentAt ? this.toIso(row.sentAt) : null,
        orgId: row.orgId ? String(row.orgId) : null,
        hadStoredFingerprint: Boolean(row.authorizationFingerprint),
      });
    }
    // NO-62b：内存侧再排一次（SQL 的 CASE 已排序，这里是**同源同序的复核**）——
    // 单测/替身无法观测 SQL ORDER BY，把顺序做成函数可验证的输出，
    // 顺序错了在测试里立刻可见，而不是靠"读 SQL 觉得对"。
    verified.sort((left, right) => {
      if (left.priority !== right.priority) return left.priority - right.priority;
      const leftAt = left.sentAt ?? '';
      const rightAt = right.sentAt ?? '';
      return leftAt < rightAt ? -1 : leftAt > rightAt ? 1 : 0;
    });
    // F4（控制面硬化）：投递事实的写入必须是**条件更新（CAS）+ status 守卫**，
    // 配额计数与"真的投出去了几条"必须同源。原来的写法是"读回 sent 行 → 无条件 UPDATE"：
    //   · 无 status 守卫：这一轮 poll 读到的 sent 行，在写之前可能已被并发 ack/回执/撤回
    //     改成 gateway_received/revoked；无条件写会把"已交付/已撤回"的命令再盖一次投递章
    //     （撤回行被污染成"交付过"，现场事实直接错）；
    //   · 无 CAS：两个并发 poll 各自读到同一批 sent 行、各自把 delivered_at 写成 now()、
    //     各自按"本轮新投递"扣配额 → 同一分钟能投出 2× 配额（配额形同虚设）。
    // 现在的口径：**只有把 delivered_at 从窗口外推进到窗口内的那一次才算"新投递"**（CAS 命中），
    // 配额只按命中次数扣。未命中的两种情形分开处理：
    //   · 状态已被并发改写（不再是 sent）→ 本轮**不返回**该命令（避免重复执行同一动作）；
    //   · 本窗口内已投过、网关还没 ack → 仍返回（边缘是 at-least-once：丢包靠下一轮重投恢复，
    //     见 `control_downlink.py` 的诚实边界 3），但**不重复占配额**。
    let chargedInWindow = 0;
    let chargedMotionInWindow = 0;
    const deliverable: typeof verified = [];
    for (const item of verified.slice(0, limit)) {
      const claimedAt = new Date();
      const claimed = (await this.db
        .update(ewohControlCommand)
        .set({
          authorizationVerifiedAt: claimedAt,
          // NO-67b：**交付时刻**（投递路径唯一写入点）——配额与页面按它计。
          deliveredAt: claimedAt,
          ...(item.hadStoredFingerprint ? {} : { authorizationFingerprint: item.authorizationFingerprint }),
        })
        .where(and(
          eq(ewohControlCommand.commandId, item.commandId),
          // 守卫：只有仍是"待投递"的行才配写投递事实。
          eq(ewohControlCommand.status, 'sent'),
          // CAS：本窗口内已投过的不再重复计（并发 poll 只有一个能命中）。
          or(
            isNull(ewohControlCommand.deliveredAt),
            lt(ewohControlCommand.deliveredAt, windowStart),
          ),
        ))
        .returning({ commandId: ewohControlCommand.commandId })) as Array<{ commandId: string }>;
      if (!claimed || claimed.length === 0) {
        const [fresh] = await this.db
          .select({ status: ewohControlCommand.status })
          .from(ewohControlCommand)
          .where(eq(ewohControlCommand.commandId, item.commandId))
          .limit(1);
        if (String(fresh?.status ?? '') !== 'sent') {
          // 并发改写：这条已经不是"待投递"了，本轮绝不能把它投给网关。
          continue;
        }
      } else if (!SAFETY_COMMAND_KEYS.has(item.commandKey)) {
        chargedInWindow += 1;
        if (MOTION_COMMAND_KEYS.has(item.commandKey)) chargedMotionInWindow += 1;
      }
      deliverable.push(item);
    }
    const commands = deliverable.map(({ hadStoredFingerprint: _drop, ...item }) => item);
    const sentTimes = visible
      .map((row) => (row.sentAt ? this.toIso(row.sentAt) : null))
      .filter((value): value is string => Boolean(value))
      .sort();
    return {
      deviceId: wanted,
      commands,
      queued: visible.length,
      revoked,
      deferred,
      quota: {
        perMinute: quotaPerMinute,
        usedInWindow,
        // F4：remaining 按**本窗口真正新投出去的条数**（CAS 命中数）扣，
        // 不用循环里那个"预计要投几条"的预扣值——否则并发/重投会让页面上的剩余配额说谎。
        remaining: quotaPerMinute > 0
          ? Math.max(0, quotaPerMinute - usedInWindow - chargedInWindow)
          : null,
        // NO-74c：运动类同口径（CAS 命中数扣减，页面不撒谎）。
        motionPerMinute: quotaPerMinuteMotion,
        motionUsedInWindow: usedMotionInWindow,
        motionRemaining: quotaPerMinuteMotion > 0
          ? Math.max(0, quotaPerMinuteMotion - usedMotionInWindow - chargedMotionInWindow)
          : null,
      },
      oldestSentAt: sentTimes[0] ?? null,
      truncated: rows.length >= PENDING_SCAN_CAP,
      checkedAt: new Date().toISOString(),
    };
  }

  /**
   * NO-60a：边缘网关按 `commandId` 回执执行结果。
   *
   * 为什么需要：执行回执原来只有人面路径（`POST /api/control/requests/:id/receipts`，
   * 要 Bearer 用户令牌）——机器身份（边缘网关）拿不到，结果就是"命令执行了但平台没记录"
   * （本轮 e2e 实测：终态停在 gateway_received）。这里按 commandId 定位请求与命令键，
   * 复用同一套校验与落库（幂等/终态/租户/`ewoh_control_result`），不另写一份。
   */
  async receiveReceiptByCommandId(
    commandId: string,
    result: 'executed' | 'failed',
    receipt?: Record<string, unknown>,
    actor?: OrgContext,
  ): Promise<ControlRequest> {
    const wanted = String(commandId ?? '').trim();
    if (wanted === '') throw new BadRequestException('commandId 必填');
    if (result !== 'executed' && result !== 'failed') {
      throw new BadRequestException("result 必须是 'executed' 或 'failed'");
    }
    const rows = await this.db
      .select({
        requestId: ewohControlCommand.requestId,
        commandKey: ewohControlCommand.commandKey,
        orgId: ewohControlCommand.orgId,
        attemptNo: ewohControlCommand.attemptNo,
        status: ewohControlCommand.status,
        payload: ewohControlCommand.payload,
        authorizationFingerprint: ewohControlCommand.authorizationFingerprint,
        revokedReason: ewohControlCommand.revokedReason,
      })
      .from(ewohControlCommand)
      .where(eq(ewohControlCommand.commandId, wanted))
      .limit(1);
    const row = rows[0];
    if (!row) throw new NotFoundException(`Command ${commandId} not found`);
    const tenant = actor?.primaryOrgId ?? null;
    if (tenant !== null && row.orgId !== null && String(row.orgId) !== tenant) {
      throw new NotFoundException(`Command ${commandId} not found`);
    }
    // NO-62a：**回执前复核授权**，识别"未授权执行"。
    //
    // 语义取舍（原则 7：事实不能被静默改写）：设备真的动了，这条事实**必须记录**
    // （拒绝回执会让现场事实消失，比记录一条违规更糟）。但"执行了"与"被授权执行"
    // 是两件事——若命令已被撤回或复核不通过，这里额外落一条
    // `authorization_violation` 结果 + 审计 + 提醒，绝不把它当成一次正常执行。
    const requestRow = await this.getRequest(String(row.requestId), actor);
    const verdict = await this.verifyDeliveryAuthorization(
      {
        requestId: String(row.requestId),
        deviceId: String(requestRow.deviceId ?? ''),
        status: String(requestRow.status ?? ''),
        riskLevel: this.riskLevelOf(requestRow),
        orgId: requestRow.orgId ?? null,
      },
      {
        commandKey: String(row.commandKey),
        payload: this.asPayload(row.payload),
        orgId: row.orgId ? String(row.orgId) : null,
        authorizationFingerprint: row.authorizationFingerprint
          ? String(row.authorizationFingerprint)
          : null,
      },
      actor,
    );
    const revokedAtDelivery = String(row.status ?? '') === 'revoked';
    const violation = result === 'executed' && (revokedAtDelivery || !verdict.ok);
    if (violation) {
      await this.recordUnauthorizedExecution(
        {
          commandId: wanted,
          requestId: String(row.requestId),
          commandKey: String(row.commandKey),
          attemptNo: Number(row.attemptNo),
          orgId: row.orgId ? String(row.orgId) : null,
        },
        revokedAtDelivery
          ? `命令已于投递前被撤回（${row.revokedReason ?? 'unknown'}），设备仍然执行`
          : verdict.detail ?? CONTROL_REVOKE_REASON_LABELS.approval_not_granted,
        receipt,
        actor,
      );
    }
    const updated = await this.receiveReceipt(
      String(row.requestId),
      String(row.commandKey),
      result,
      receipt,
      actor,
    );
    if (violation) {
      await this.updateRequestStatus(
        String(row.requestId),
        aggregateControlStatus(updated.attempts),
        updated.orgId ?? undefined,
        updated.status ?? undefined,
      );
    }
    return updated;
  }

  /**
   * NO-62a：记录一次**未授权执行**（事实保留 + 违规显式化）。
   *
   * 为什么单独一条结果行而不是改回执内容：回执行描述"设备做了什么"，
   * 这一行描述"这次执行违反了授权边界"——两者都必须可独立检索与审计（原则 6）。
   */
  private async recordUnauthorizedExecution(
    command: { commandId: string; requestId: string; commandKey: string; attemptNo: number; orgId: string | null },
    detail: string,
    receipt: Record<string, unknown> | undefined,
    actor?: OrgContext,
  ): Promise<void> {
    const now = new Date();
    await this.db.insert(ewohControlResult).values({
      resultId: nextId('res'),
      requestId: command.requestId,
      commandId: command.commandId,
      resultType: 'authorization_violation',
      resultCode: 'unauthorized_execution',
      resultJson: {
        detail,
        commandKey: command.commandKey,
        attemptNo: command.attemptNo,
        receipt: receipt ?? {},
        detectedAt: now.toISOString(),
      },
      success: false,
      ...(command.orgId ? { orgId: command.orgId } : {}),
    });
    await this.recordAudit(
      {
        action: 'control.command.unauthorized_execution',
        entityType: 'control_command',
        entityId: command.commandId,
        before: { authorized: false },
        after: { executed: true, detail, requestId: command.requestId },
        risk: true,
      },
      actor,
    );
    try {
      await insertDeterministicNotifications(this.db as never, {
        orgId: command.orgId,
        externalRef: command.commandId,
        prefix: `NTF-CTRL-${command.commandId}-`,
        bucket: 'unauthorized_execution',
        recipients: [
          { recipientType: 'role', recipientId: 'safety_admin' },
          { recipientType: 'role', recipientId: 'workshop_lead' },
        ],
        title: '设备在授权失效后仍被执行（未授权执行）',
        body:
          `命令 ${command.commandKey}（请求 ${command.requestId}）在执行时已无有效授权，` +
          `但设备已执行：${detail}。请立即核实现场状态并复盘授权链。`,
        severity: 'critical',
      });
    } catch (err) {
      this.logger.warn(
        `unauthorized_execution notification failed for ${command.commandId}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  /**
   * NO-60a：边缘网关**投递确认**（ack）。状态机 `pending_gateway → gateway_received`
   * （contracts/state-machines/control.yaml）；未投递成功 → `failed` + 原因。
   *
   * 幂等（边缘 at-least-once）：已 ack 过同一命令 → 返回当前状态 + `alreadyAcked: true`，
   * **不报错、不重复写结果行**；已进入终态（executed/…）→ 409（不许把终态改回去）。
   * 无论接受还是拒绝都写 `ewoh_control_result`（resultType=gateway_ack）与审计。
   */
  async ackCommand(
    commandId: string,
    input: { delivered: boolean; reason?: string; details?: Record<string, unknown> },
    actor?: OrgContext,
  ): Promise<{ commandId: string; status: string; alreadyAcked: boolean; requestId: string }> {
    const wanted = String(commandId ?? '').trim();
    if (wanted === '') throw new BadRequestException('commandId 必填');
    const delivered = input?.delivered === true;
    if (!delivered && !String(input?.reason ?? '').trim()) {
      // 未投递必须给原因：否则平台只知道"没送到"，不知道为什么（原则 7）
      throw new BadRequestException('delivered=false 时必须给 reason');
    }
    const rows = await this.db
      .select({
        commandId: ewohControlCommand.commandId,
        requestId: ewohControlCommand.requestId,
        commandKey: ewohControlCommand.commandKey,
        attemptNo: ewohControlCommand.attemptNo,
        status: ewohControlCommand.status,
        orgId: ewohControlCommand.orgId,
        payload: ewohControlCommand.payload,
        authorizationFingerprint: ewohControlCommand.authorizationFingerprint,
        revokedReason: ewohControlCommand.revokedReason,
      })
      .from(ewohControlCommand)
      .where(eq(ewohControlCommand.commandId, wanted))
      .limit(1);
    const row = rows[0];
    if (!row) throw new NotFoundException(`Command ${commandId} not found`);
    const tenant = actor?.primaryOrgId ?? null;
    if (tenant !== null && row.orgId !== null && String(row.orgId) !== tenant) {
      throw new NotFoundException(`Command ${commandId} not found`);
    }
    const current = String(row.status ?? '');
    if (current === 'gateway_received' || current === 'executed' || current === 'failed') {
      if (current === 'gateway_received') {
        return { commandId: wanted, status: current, alreadyAcked: true, requestId: String(row.requestId) };
      }
      throw new ConflictException(
        `Command ${commandId} 已进入终态 ${current}：不接受网关确认回退状态`,
      );
    }
    if (current === 'revoked') {
      // NO-62a：复核未通过已被平台撤回——网关**不得**再把"已投递"写回来。
      throw new ConflictException(
        `Command ${commandId} 已因授权复核未通过被撤回（${row.revokedReason ?? 'unknown'}），不接受投递确认`,
      );
    }
    if (current !== 'sent') {
      throw new ConflictException(`Command ${commandId} 当前状态 ${current} 不可确认投递（仅 sent 可）`);
    }
    // NO-62a：投递瞬间**再复核一次授权**。只信"平台记录过授权"是不够的：
    // 审批可能在 `sent → ack` 这段窗口里被撤销/过期/改写（网关轮询间隔内完全可能）。
    // 复核未通过且网关声称"已投递" → 撤回命令并 409，绝不把一次失效授权记成正常投递。
    if (delivered) {
      const requestRow = await this.getRequest(String(row.requestId), actor);
      const verdict = await this.verifyDeliveryAuthorization(
        {
          requestId: String(row.requestId),
          deviceId: String(requestRow.deviceId ?? ''),
          status: String(requestRow.status ?? ''),
          riskLevel: this.riskLevelOf(requestRow),
          orgId: requestRow.orgId ?? null,
        },
        {
          commandKey: String(row.commandKey),
          payload: this.asPayload(row.payload),
          orgId: row.orgId ? String(row.orgId) : null,
          authorizationFingerprint: row.authorizationFingerprint
            ? String(row.authorizationFingerprint)
            : null,
        },
        actor,
      );
      // NO-62a：网关**原样回传**的授权指纹必须与平台复核出的指纹一致。
      // 不一致说明网关执行的不是被授权的那条命令（换了设备/工位/命令）——
      // 与"授权过期"是两件事，单独给 fingerprint_mismatch。
      const echoed =
        input?.details && typeof input.details === 'object'
          ? String((input.details as Record<string, unknown>).authorizationFingerprint ?? '').trim()
          : '';
      const echoedMismatch = echoed !== '' && echoed !== verdict.fingerprint;
      if (!verdict.ok || echoedMismatch) {
        const reason = !verdict.ok ? (verdict.reason ?? 'approval_not_granted') : 'fingerprint_mismatch';
        const detail = !verdict.ok
          ? verdict.detail ?? CONTROL_REVOKE_REASON_LABELS.approval_not_granted
          : `${CONTROL_REVOKE_REASON_LABELS.fingerprint_mismatch}` +
            `（网关回传 ${echoed.slice(0, 16)}；平台复核 ${verdict.fingerprint.slice(0, 16)}）`;
        await this.revokeUndeliveredCommand(
          {
            commandId: wanted,
            requestId: String(row.requestId),
            commandKey: String(row.commandKey),
            attemptNo: Number(row.attemptNo),
            orgId: row.orgId ? String(row.orgId) : null,
          },
          reason,
          detail,
          actor,
        );
        throw new ConflictException(
          `Command ${commandId} 投递被拒：${detail}（原因码 ${reason}）`,
        );
      }
    }
    const nextStatus = delivered ? 'gateway_received' : 'failed';
    const details = input?.details && typeof input.details === 'object' ? input.details : {};
    const acked = await this.db
      .update(ewohControlCommand)
      .set({
        status: nextStatus,
        responseAt: new Date(),
        responseJson: { ...details, delivered, reason: input.reason ?? null },
        errorCode: delivered ? null : 'GATEWAY_REJECTED',
        errorMessage: delivered ? null : String(input.reason ?? '').slice(0, 500),
      })
      .where(and(
        eq(ewohControlCommand.commandId, wanted),
        eq(ewohControlCommand.status, 'sent'),
      ))
      .returning({ commandId: ewohControlCommand.commandId });
    if (!acked || acked.length === 0) {
      // F4（与投递 CAS 同一条纪律）：条件 UPDATE 0 行命中 = 读-改-写窗口内命令已被
      // 并发改写（投递前复核撤回 / 执行回执 / 另一网关 ack）。此时绝不能把"没生效的
      // 确认"当成功返回，更不能继续写 gateway_ack 结果行——那会把一条已撤回/已终态的
      // 命令污染成"网关确认过投递"（实测复现：并发撤回后 ack 仍返回
      // gateway_received 并落 delivered 结果行，现场事实直接错）。边缘契约把 409
      // 定义为"本轮 ack 未被接受，不得回执执行成功"（control_downlink.py），显式
      // 冲突正是边缘侧预期的失败形态。
      const [fresh] = await this.db
        .select({ status: ewohControlCommand.status })
        .from(ewohControlCommand)
        .where(eq(ewohControlCommand.commandId, wanted))
        .limit(1);
      throw new ConflictException(
        `Command ${wanted} 状态已并发变为 ${String(fresh?.status ?? 'unknown')}，投递确认未被接受`,
      );
    }
    await this.db.insert(ewohControlResult).values({
      resultId: nextId('res'),
      requestId: String(row.requestId),
      commandId: wanted,
      resultType: 'gateway_ack',
      resultCode: delivered ? 'delivered' : 'rejected',
      resultJson: { delivered, reason: input.reason ?? null, ...details },
      success: delivered,
      ...(row.orgId ? { orgId: String(row.orgId) } : {}),
    });
    await this.recordAudit(
      {
        action: 'control.command.ack',
        entityType: 'control_command',
        entityId: wanted,
        before: { status: current, requestId: String(row.requestId) },
        after: {
          status: nextStatus,
          delivered,
          reason: input.reason ?? null,
          requestId: String(row.requestId),
        },
        risk: true,
      },
      actor,
    );
    return { commandId: wanted, status: nextStatus, alreadyAcked: false, requestId: String(row.requestId) };
  }

  async getStatus(requestId: string, actor?: OrgContext): Promise<{ request: ControlRequest; status: string }> {
    const request = await this.getRequest(requestId, actor);
    return { request, status: aggregateControlStatus(request.attempts) };
  }

  private async findByIdempotencyKey(
    idempotencyKey: string,
    actor?: OrgContext,
  ): Promise<ControlRequest | null> {
    const rows = await this.db
      .select({
        requestId: ewohControlRequest.requestId,
        deviceId: ewohControlRequest.deviceId,
        commandKeys: ewohControlRequest.commandKeys,
        idempotencyKey: ewohControlRequest.idempotencyKey,
        status: ewohControlRequest.status,
        requestedAt: ewohControlRequest.requestedAt,
        orgId: ewohControlRequest.orgId,
      })
      .from(ewohControlRequest)
      .where(
        and(
          eq(ewohControlRequest.idempotencyKey, idempotencyKey),
          ...(actor?.primaryOrgId
            ? [eq(ewohControlRequest.orgId, actor.primaryOrgId)]
            : []),
        ),
      )
      .orderBy(desc(ewohControlRequest.requestedAt))
      .limit(1);
    const row = rows[0];
    if (!row) return null;
    assertTenantVisible(row.orgId, actor, `Control request ${row.requestId}`);
    return this.mapRequest(
      {
        request_id: row.requestId,
        device_id: row.deviceId,
        command_keys: row.commandKeys,
        idempotency_key: row.idempotencyKey,
        status: row.status,
        requested_at: row.requestedAt,
        org_id: row.orgId,
      },
      [],
      row.orgId,
    );
  }

  /**
   * R2-SMI-009：请求行状态写回带行级 CAS——WHERE 追加 eq(status, 聚合前
   * 行状态)，0 行命中抛 409（并发回执/撤销/下发互相覆盖时显式冲突，
   * 调用方/客户端重读重算，而非静默回退为过时聚合值）。
   */
  private async updateRequestStatus(
    requestId: string,
    status: string,
    orgId?: string | null,
    expectedStatus?: string,
  ): Promise<void> {
    const rows = await this.db
      .update(ewohControlRequest)
      .set({ status, updatedAt: new Date() })
      .where(
        and(
          eq(ewohControlRequest.requestId, requestId),
          ...(orgId ? [eq(ewohControlRequest.orgId, orgId)] : []),
          ...(expectedStatus
            ? [eq(ewohControlRequest.status, expectedStatus)]
            : []),
        ),
      )
      .returning({ requestId: ewohControlRequest.requestId });
    if (expectedStatus && (!rows || rows.length === 0)) {
      throw new ConflictException('STATE_CONFLICT');
    }
  }

  private rowFromSelect(row: unknown): ControlRequestRow {
    const r = row as {
      requestId: string;
      deviceId: string;
      commandKeys: unknown;
      idempotencyKey: string | null;
      status: string;
      requestedAt: unknown;
      orgId?: string | null;
    };
    return {
      request_id: r.requestId,
      device_id: r.deviceId,
      command_keys: r.commandKeys,
      idempotency_key: r.idempotencyKey,
      status: r.status,
      requested_at: r.requestedAt,
      org_id: r.orgId,
    };
  }

  private mapRequest(
    row: ControlRequestRow,
    attempts: ControlAttempt[] = [],
    orgId?: string | null,
  ): ControlRequest {
    return {
      id: row.request_id,
      deviceId: row.device_id,
      idempotencyKey: row.idempotency_key ?? '',
      commandKeys: this.parseJsonArray(row.command_keys),
      attempts,
      createdAt: this.toIso(row.requested_at),
      // ADR-077：org 归属读回（additive；null=legacy 行）。
      orgId: orgId ?? row.org_id ?? null,
      // R2-SMI-001：持久化行状态读回（pending_approval/approved/revoked 等）。
      status: row.status,
      // NO-62a：风险等级读回（授权复核的统一判定基准）。
      riskLevel: row.risk_level ?? null,
    };
  }

  private parseJsonArray(value: unknown): string[] {
    const parsed = this.parseJson(value);
    return Array.isArray(parsed) ? parsed.map(String) : [];
  }

  private parseJson(value: unknown): unknown {
    if (typeof value === 'string') {
      try {
        return JSON.parse(value);
      } catch {
        return value;
      }
    }
    return value;
  }

  /** 命令参数读回（JSON 对象才算参数；非法/空 → undefined，不猜）。 */
  private asPayload(value: unknown): Record<string, unknown> | null {
    const parsed = this.parseJson(value);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
    return null;
  }

  private asReceipt(value: unknown): Record<string, unknown> | undefined {
    const parsed = this.parseJson(value);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : undefined;
  }

  private toIso(value: unknown): string {
    if (value instanceof Date) {
      return value.toISOString();
    }
    if (typeof value === 'string' || typeof value === 'number') {
      return new Date(value).toISOString();
    }
    return new Date().toISOString();
  }

  private isUniqueViolation(error: unknown): boolean {
    return (error as { code?: string })?.code === '23505';
  }

  private async recordAudit(
    entry: Omit<AuditLogEntry, 'actorId' | 'orgId'>,
    actor?: OrgContext,
  ): Promise<void> {
    if (!this.auditService) {
      return;
    }
    await this.auditService.appendAuditLog({
      actorId: actor?.userId ?? 'system',
      orgId: actor?.primaryOrgId ?? '',
      ...entry,
    });
  }

  private throwPersistence(context: string, error: unknown): never {
    this.logger.error(
      `${context} failed`,
      error instanceof Error ? error : new Error(String(error)),
    );
    throw new InternalServerErrorException(`${context} failed`);
  }
}
