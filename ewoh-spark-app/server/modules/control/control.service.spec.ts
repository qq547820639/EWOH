/**
 * R2-SMI-001/002/009 单测：control 高危物理指令审批链（INV-005）、
 * deviceId 租户归属断言、请求行状态 CAS。
 *
 * 复用 §31 fake-control-db 假库（devices 种子 + update returning），
 * approval 联动以 stub 注入（审批域自身行为在 approval 模块 spec 锁定）。
 */
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import {
  ControlService,
  HIGH_RISK_COMMAND_KEYS,
  classifyControlRisk,
  isPlatformCommandKey,
} from './control.service';
import {
  ACTUATOR_COMMAND_KEYS,
  ACTUATOR_HIGH_RISK_COMMANDS,
  authorizationFingerprint,
} from '@shared/actuator';
import {
  ewohControlRequest,
  ewohControlCommand,
  ewohControlResult,
} from '@server/database/schema';
import { makeControlDb } from '../../../test/helpers/fake-control-db';
import { makeConditionMatcher } from '../../../test/helpers/drizzle-fake-matcher';
import type { ApprovalInstance } from '@shared/api.interface';

const ACTOR = { userId: 'u1', primaryOrgId: 'ORG-1', roles: ['dispatcher'] } as never;
const ACTOR_ORG2 = { userId: 'u2', primaryOrgId: 'ORG-2', roles: ['dispatcher'] } as never;
const GLOBAL_ADMIN = {
  userId: 'g1',
  primaryOrgId: 'ORG-1',
  roles: ['global_admin'],
  isGlobalAdmin: true,
} as never;

function requestSeed(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    requestId: 'ctl-1',
    deviceId: 'exo-1',
    commandKeys: ['emergency_stop'],
    idempotencyKey: 'idem-1',
    status: 'pending_approval',
    requestedAt: '2026-08-03T00:00:00.000Z',
    orgId: 'ORG-1',
    ...overrides,
  };
}

function approvalInstance(
  status: ApprovalInstance['status'],
  overrides: Partial<ApprovalInstance> = {},
): ApprovalInstance {
  return {
    id: 'appr-1',
    entityType: 'control_request',
    entityId: 'ctl-1',
    status,
    steps: [{ id: 'step-1', role: 'safety_admin', status: 'approved' }],
    createdAt: '2026-08-03T00:00:00.000Z',
    // NO-31a：控制类审批也要有时效——已通过的实例必须带通过时间（否则闸门拒绝）
    ...(status === 'approved' ? { approvedAt: new Date().toISOString() } : {}),
    ...overrides,
  };
}

/** approval 联动 stub：createApproval 记录调用，findLatestForEntity 返回预置实例。 */
function makeApprovalStub(instance: ApprovalInstance | null) {
  return {
    createApproval: jest.fn(async () => approvalInstance('pending')),
    findLatestForEntity: jest.fn(async () => instance),
  };
}

function makeAuditStub() {
  const logs: Array<Record<string, unknown>> = [];
  return {
    logs,
    stub: {
      appendAuditLog: jest.fn(async (entry: Record<string, unknown>) => {
        logs.push(entry);
      }),
    },
  };
}

describe('classifyControlRisk（R2-SMI-001 风险分级）', () => {
  it('急停/载人移动类 → high；普通启停 → normal', () => {
    expect(classifyControlRisk(['emergency_stop'])).toBe('high');
    expect(classifyControlRisk(['start', 'carry_move'])).toBe('high');
    expect(classifyControlRisk(['start', 'stop'])).toBe('normal');
    expect(classifyControlRisk([])).toBe('normal');
  });

  it('执行机构高危命令与共享契约同源（NO-60a）：dispatch_task/resume/clear_fault 都进审批链', () => {
    for (const key of ['dispatch_task', 'resume', 'clear_fault']) {
      expect(classifyControlRisk([key])).toBe('high');
    }
    // 平台高危集合必须包含共享契约里的每一条（边缘与平台不得各写一份）
    for (const key of ACTUATOR_HIGH_RISK_COMMANDS) {
      expect(HIGH_RISK_COMMAND_KEYS.has(key)).toBe(true);
    }
    // 安全动作 stop 仍为普通（边缘侧也不需要授权号）
    expect(classifyControlRisk(['stop'])).toBe('normal');
  });

  // ── F1：白名单式分级（词表外的键不许静默落 'normal'）──────────────────────
  it('F1 词表外的命令键 → 按 high 处理（黑名单分级对未知键是 fail-open）', () => {
    // 真实缺陷：`open_interlock` 这类自定义键不在 HIGH_RISK 黑名单里 → 'normal' →
    // 免审批直达设备。fail-closed 后未知键一律按高危（且创建入口已直接拒绝）。
    expect(classifyControlRisk(['open_interlock'])).toBe('high');
    expect(classifyControlRisk(['start', 'open_interlock'])).toBe('high');
    // 词表内的键不受影响：普通键仍 normal，高危键仍 high
    expect(classifyControlRisk(['start', 'stop'])).toBe('normal');
    expect(classifyControlRisk(['pause', 'return_to_dock'])).toBe('normal');
  });

  it('F1 平台词表覆盖共享执行机构契约的每一条（白名单不漏，否则合法命令被 400）', () => {
    for (const key of ACTUATOR_COMMAND_KEYS) {
      expect(isPlatformCommandKey(key)).toBe(true);
    }
    // 既有通用设备键（现场存量单子/单测/e2e 在用）必须继续被接受
    for (const key of ['start', 'emergency_stop', 'carry_move']) {
      expect(isPlatformCommandKey(key)).toBe(true);
    }
    expect(isPlatformCommandKey('open_interlock')).toBe(false);
    expect(isPlatformCommandKey('')).toBe(false);
  });
});

describe('R2-SMI-001：高危指令审批链（INV-005）', () => {
  it('高危 createRequest → pending_approval + riskLevel=high + 联动创建审批实例', async () => {
    const { db, inserts } = makeControlDb();
    const approval = makeApprovalStub(approvalInstance('pending'));
    const service = new ControlService(db as never, undefined, approval as never);

    const created = await service.createRequest(
      { deviceId: 'exo-1', commandKeys: ['emergency_stop'], idempotencyKey: 'idem-1' },
      ACTOR,
    );

    expect(created.status).toBe('pending_approval');
    const requestInsert = inserts.find((i) => i.table === ewohControlRequest);
    expect(requestInsert?.row.status).toBe('pending_approval');
    expect(requestInsert?.row.riskLevel).toBe('high');
    expect(approval.createApproval).toHaveBeenCalledWith(
      expect.objectContaining({ entityType: 'control_request', entityId: created.id }),
      ACTOR,
    );
  });

  it('普通 createRequest → created，不创建审批实例', async () => {
    const { db, inserts } = makeControlDb();
    const approval = makeApprovalStub(null);
    const service = new ControlService(db as never, undefined, approval as never);

    const created = await service.createRequest(
      { deviceId: 'exo-1', commandKeys: ['start'], idempotencyKey: 'idem-2' },
      ACTOR,
    );

    expect(created.status).toBe('created');
    expect(inserts.find((i) => i.table === ewohControlRequest)?.row.status).toBe('created');
    expect(approval.createApproval).not.toHaveBeenCalled();
  });

  it('审批未通过 → sendCommand 403，命令不落库', async () => {
    const { db, inserts } = makeControlDb({ requests: [requestSeed()] });
    const approval = makeApprovalStub(approvalInstance('pending'));
    const service = new ControlService(db as never, undefined, approval as never);

    await expect(service.sendCommand('ctl-1', 'emergency_stop', ACTOR)).rejects.toBeInstanceOf(
      ForbiddenException,
    );
    expect(approval.findLatestForEntity).toHaveBeenCalledWith('control_request', 'ctl-1', ACTOR);
    expect(inserts.find((i) => i.table === ewohControlCommand)).toBeUndefined();
  });

  it('审批 rejected → sendCommand 403（fail-closed，拒绝/取消/过期同样不放行）', async () => {
    const { db } = makeControlDb({ requests: [requestSeed()] });
    const service = new ControlService(
      db as never,
      undefined,
      makeApprovalStub(approvalInstance('rejected')) as never,
    );
    await expect(service.sendCommand('ctl-1', 'emergency_stop', ACTOR)).rejects.toBeInstanceOf(
      ForbiddenException,
    );
  });

  it('审批实例缺失（数据不一致）→ sendCommand 409 fail-closed', async () => {
    const { db } = makeControlDb({ requests: [requestSeed()] });
    const service = new ControlService(
      db as never,
      undefined,
      makeApprovalStub(null) as never,
    );
    await expect(service.sendCommand('ctl-1', 'emergency_stop', ACTOR)).rejects.toBeInstanceOf(
      ConflictException,
    );
  });

  it('审批 approved → CAS 落 approved 后放行下发，随后聚合 pending_gateway', async () => {
    const { db, updates } = makeControlDb({ requests: [requestSeed()] });
    const approval = makeApprovalStub(approvalInstance('approved'));
    const service = new ControlService(db as never, undefined, approval as never);

    const result = await service.sendCommand('ctl-1', 'emergency_stop', ACTOR);

    expect(result.attempts).toHaveLength(1);
    expect(result.attempts[0].status).toBe('sent');
    // 状态写回序列：pending_approval → approved（闸门 CAS）→ pending_gateway（聚合）。
    const statusWrites = updates
      .filter((u) => u.table === ewohControlRequest)
      .map((u) => u.set.status);
    expect(statusWrites).toEqual(['approved', 'pending_gateway']);
  });

  it('高危创建/下发审计标 risk:true，普通创建 risk:false', async () => {
    // fake select 忽略 where：幂等查询会命中既有行，高危/普通各用独立假库。
    const audit = makeAuditStub();
    const highDb = makeControlDb();
    const highService = new ControlService(
      highDb.db as never,
      audit.stub as never,
      makeApprovalStub(approvalInstance('approved')) as never,
    );
    const high = await highService.createRequest(
      { deviceId: 'exo-1', commandKeys: ['emergency_stop'], idempotencyKey: 'idem-h' },
      ACTOR,
    );
    await highService.sendCommand(high.id, 'emergency_stop', ACTOR);

    const normalDb = makeControlDb();
    const normalService = new ControlService(normalDb.db as never, audit.stub as never);
    await normalService.createRequest(
      { deviceId: 'exo-1', commandKeys: ['start'], idempotencyKey: 'idem-n' },
      ACTOR,
    );

    const createEntries = audit.logs.filter((e) => e.action === 'control.create');
    expect(createEntries[0]?.risk).toBe(true);
    expect(createEntries[1]?.risk).toBe(false);
    const sendEntry = audit.logs.find((e) => e.action === 'control.command.send');
    expect(sendEntry?.risk).toBe(true);
  });

  it('未进入执行的请求 revoke → revoked 终态；revoked 后 sendCommand 拒绝', async () => {
    const { db } = makeControlDb({ requests: [requestSeed()] });
    const service = new ControlService(
      db as never,
      undefined,
      makeApprovalStub(approvalInstance('pending')) as never,
    );

    const revoked = await service.revoke('ctl-1', ACTOR);
    expect(revoked.status).toBe('revoked');

    await expect(service.sendCommand('ctl-1', 'emergency_stop', ACTOR)).rejects.toThrow(
      /terminal request/,
    );
    await expect(service.revoke('ctl-1', ACTOR)).rejects.toBeInstanceOf(BadRequestException);
  });

  it('审批模块缺失时高危创建 fail-closed（InternalServerError）', async () => {
    const { db } = makeControlDb();
    const service = new ControlService(db as never);
    await expect(
      service.createRequest(
        { deviceId: 'exo-1', commandKeys: ['emergency_stop'], idempotencyKey: 'idem-x' },
        ACTOR,
      ),
    ).rejects.toThrow(/approval module/);
  });

  // ── F1：命令键白名单（词表外的键拒绝创建，而不是"看起来发出去了"）──────────
  it('F1 词表外的命令键 → 400 拒绝创建，不落库也不拉起审批链', async () => {
    const { db, inserts } = makeControlDb();
    const approval = makeApprovalStub(approvalInstance('pending'));
    const service = new ControlService(db as never, undefined, approval as never);

    await expect(
      service.createRequest(
        { deviceId: 'exo-1', commandKeys: ['open_interlock'], idempotencyKey: 'idem-f1' },
        ACTOR,
      ),
    ).rejects.toBeInstanceOf(BadRequestException);

    expect(inserts.find((i) => i.table === ewohControlRequest)).toBeUndefined();
    expect(approval.createApproval).not.toHaveBeenCalled();
  });

  it('F1 共享执行机构词表里的每条命令键都允许创建（白名单与边缘同源）', async () => {
    const { db, inserts } = makeControlDb();
    const service = new ControlService(
      db as never,
      undefined,
      makeApprovalStub(approvalInstance('pending')) as never,
    );

    for (const key of ACTUATOR_COMMAND_KEYS) {
      const created = await service.createRequest(
        { deviceId: 'exo-1', commandKeys: [key], idempotencyKey: `idem-vocab-${key}` },
        ACTOR,
      );
      expect(created.id).toBeTruthy();
      expect(created.commandKeys).toEqual([key]);
    }
    expect(inserts.filter((i) => i.table === ewohControlRequest))
      .toHaveLength(ACTUATOR_COMMAND_KEYS.length);
  });
});

describe('R2-SMI-002：deviceId 租户归属断言', () => {
  const OWN_DEVICE = { deviceId: 'exo-1', orgId: 'ORG-1' };
  const FOREIGN_DEVICE = { deviceId: 'exo-foreign', orgId: 'ORG-2' };

  it('设备注册在他租户 → createRequest 404（反枚举），请求行不落库', async () => {
    const { db, inserts } = makeControlDb({ devices: [FOREIGN_DEVICE] });
    const service = new ControlService(
      db as never,
      undefined,
      makeApprovalStub(approvalInstance('pending')) as never,
    );

    await expect(
      service.createRequest(
        { deviceId: 'exo-foreign', commandKeys: ['start'], idempotencyKey: 'idem-f' },
        ACTOR,
      ),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(inserts.find((i) => i.table === ewohControlRequest)).toBeUndefined();
  });

  it('设备属本租户 → 放行', async () => {
    const { db } = makeControlDb({ devices: [OWN_DEVICE] });
    const service = new ControlService(db as never);
    const created = await service.createRequest(
      { deviceId: 'exo-1', commandKeys: ['start'], idempotencyKey: 'idem-o' },
      ACTOR,
    );
    expect(created.deviceId).toBe('exo-1');
  });

  it('global_admin 显式豁免跨租户设备', async () => {
    const { db } = makeControlDb({ devices: [FOREIGN_DEVICE] });
    const service = new ControlService(db as never);
    const created = await service.createRequest(
      { deviceId: 'exo-foreign', commandKeys: ['start'], idempotencyKey: 'idem-g' },
      GLOBAL_ADMIN,
    );
    expect(created.deviceId).toBe('exo-foreign');
  });

  it('sendCommand 复核设备归属：他租户设备 → 404', async () => {
    const { db } = makeControlDb({
      requests: [requestSeed({ deviceId: 'exo-foreign', status: 'created', commandKeys: ['start'] })],
      devices: [FOREIGN_DEVICE],
    });
    const service = new ControlService(
      db as never,
      undefined,
      makeApprovalStub(approvalInstance('approved')) as never,
    );

    await expect(service.sendCommand('ctl-1', 'start', ACTOR_ORG2)).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  it('未注册设备无 org 事实 → 不额外阻断（网关投递自然失败）', async () => {
    const { db } = makeControlDb();
    const service = new ControlService(db as never);
    const created = await service.createRequest(
      { deviceId: 'exo-unregistered', commandKeys: ['start'], idempotencyKey: 'idem-u' },
      ACTOR,
    );
    expect(created.status).toBe('created');
  });
});

describe('R2-SMI-009：请求行状态 CAS', () => {
  it('UPDATE 命中 0 行（并发覆盖）→ 409 STATE_CONFLICT', async () => {
    const requestRow = requestSeed({ status: 'created', commandKeys: ['start'] });
    const q = (rows: unknown[]) => {
      const p: any = Promise.resolve(rows);
      p.where = () => p;
      p.orderBy = () => p;
      p.limit = () => p;
      return p;
    };
    const db = {
      select: jest.fn(() => ({
        from: jest.fn((table: unknown) =>
          q(table === ewohControlRequest ? [requestRow] : []),
        ),
      })),
      insert: jest.fn(() => ({
        values: jest.fn(() => ({
          returning: jest.fn().mockResolvedValue([{}]),
        })),
      })),
      update: jest.fn(() => ({
        set: jest.fn(() => ({
          where: jest.fn(() => ({
            // CAS 未命中：0 行。
            returning: jest.fn().mockResolvedValue([]),
          })),
        })),
      })),
    };
    const service = new ControlService(db as never);
    await expect(service.sendCommand('ctl-1', 'start', ACTOR)).rejects.toBeInstanceOf(
      ConflictException,
    );
  });

  // ── NO-31a：控制类审批的时效（与能力闸门同一实现）───────────────────────
  it('审批通过时间过久 → 409 APPROVAL_INVALID（半年前的"同意"不等于现在的同意）', async () => {
    const staleInstance = approvalInstance('approved', {
      approvedAt: new Date(Date.now() - 25 * 3_600_000).toISOString(),
    });
    const { db } = makeControlDb({ requests: [requestSeed()] });
    const service = new ControlService(db as never, undefined, makeApprovalStub(staleInstance) as never);
    const error = await service.sendCommand('ctl-1', 'emergency_stop', ACTOR).catch((e) => e);
    expect(error).toBeInstanceOf(ConflictException);
    expect(String(error.message)).toContain('APPROVAL_INVALID');
    expect(String(error.message)).toContain('超出有效期');
  });

  it('审批缺少通过时间 → 409（无法判断时效的凭证不算有效凭证）', async () => {
    const noTime = approvalInstance('approved', { approvedAt: undefined });
    const { db } = makeControlDb({ requests: [requestSeed()] });
    const service = new ControlService(db as never, undefined, makeApprovalStub(noTime) as never);
    const error = await service.sendCommand('ctl-1', 'emergency_stop', ACTOR).catch((e) => e);
    expect(String(error.message)).toContain('缺少通过时间');
  });

  it('有效期内通过的审批 → 放行（时效闸门不误伤正常流程）', async () => {
    const fresh = approvalInstance('approved', {
      approvedAt: new Date(Date.now() - 60_000).toISOString(),
    });
    const { db } = makeControlDb({ requests: [requestSeed()] });
    const service = new ControlService(db as never, undefined, makeApprovalStub(fresh) as never);
    await expect(service.sendCommand('ctl-1', 'emergency_stop', ACTOR)).resolves.toBeTruthy();
  });
});

describe('NO-60a：边缘网关命令面（payload / pending / ack）', () => {
  const APPROVED = () =>
    makeApprovalStub(approvalInstance('approved'));

  function serviceWith(seed: Record<string, unknown> = {}) {
    const fake = makeControlDb({
      requests: [requestSeed({ status: 'approved', commandKeys: ['dispatch_task'], ...seed })],
    });
    const service = new ControlService(fake.db as never, undefined, APPROVED() as never);
    return { ...fake, service };
  }

  it('dispatch_task 缺 targetStationId → 400（命令参数不允许"说不清去哪"）', async () => {
    const { service } = serviceWith();
    await expect(
      service.sendCommand('ctl-1', 'dispatch_task', ACTOR),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('payload 非对象 / 超长 → 400（只允许执行必需信息）', async () => {
    const { service } = serviceWith();
    await expect(
      service.sendCommand('ctl-1', 'dispatch_task', ACTOR, { targetStationId: 'ST-1', extra: { deep: 1 } })
        .then(() => service.sendCommand('ctl-1', 'dispatch_task', ACTOR, [] as never)),
    ).rejects.toBeInstanceOf(BadRequestException);
    const big = { targetStationId: 'ST-1', blob: 'x'.repeat(5000) };
    await expect(
      service.sendCommand('ctl-1', 'dispatch_task', ACTOR, big),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('payload 落库并随命令读回（边缘网关据此执行）', async () => {
    const { service, inserts } = serviceWith();
    await service.sendCommand('ctl-1', 'dispatch_task', ACTOR, { targetStationId: 'ST-9', taskId: 'T-9' });
    const cmd = inserts.find((i) => i.table === ewohControlCommand);
    expect(cmd?.row.payload).toMatchObject({ targetStationId: 'ST-9', taskId: 'T-9' });
    const request = await service.getRequest('ctl-1');
    const attempt = request.attempts.find((a) => a.commandKey === 'dispatch_task');
    expect(attempt?.payload).toMatchObject({ targetStationId: 'ST-9' });
  });

  it('pending 只返回 sent 状态命令，并签发平台授权号 control:<requestId>', async () => {
    const { service } = serviceWith();
    await service.sendCommand('ctl-1', 'dispatch_task', ACTOR, { targetStationId: 'ST-9' });
    const pending = await service.listPendingCommands('exo-1', {}, ACTOR);
    expect(pending.deviceId).toBe('exo-1');
    expect(pending.commands).toHaveLength(1);
    expect(pending.commands[0]).toMatchObject({
      requestId: 'ctl-1',
      commandKey: 'dispatch_task',
      authorizationRef: 'control:ctl-1',
      payload: { targetStationId: 'ST-9' },
    });
  });

  it('deviceId 不匹配 / 终端请求 → 不给命令（网关拿不到别人的活）', async () => {
    const { service } = serviceWith();
    await service.sendCommand('ctl-1', 'dispatch_task', ACTOR, { targetStationId: 'ST-9' });
    expect((await service.listPendingCommands('other-device', {}, ACTOR)).commands).toHaveLength(0);
  });

  it('ack delivered=true → gateway_received + 结果行 + 审计', async () => {
    const { service, inserts, updates } = serviceWith();
    await service.sendCommand('ctl-1', 'dispatch_task', ACTOR, { targetStationId: 'ST-9' });
    const commandId = inserts.filter((i) => i.table === ewohControlCommand).slice(-1)[0]?.row.commandId as string;

    const ack = await service.ackCommand(commandId, { delivered: true }, ACTOR);

    expect(ack).toMatchObject({ status: 'gateway_received', alreadyAcked: false, requestId: 'ctl-1' });
    const result = inserts.find((i) => i.table === ewohControlResult);
    expect(result?.row).toMatchObject({ resultType: 'gateway_ack', resultCode: 'delivered', success: true });
    expect(updates.some((u) => u.set.status === 'gateway_received')).toBe(true);
  });

  it('ack delivered=false 必须给原因（否则平台只知道"没送到"不知道为什么）', async () => {
    const { service, inserts } = serviceWith();
    await service.sendCommand('ctl-1', 'dispatch_task', ACTOR, { targetStationId: 'ST-9' });
    const commandId = inserts.filter((i) => i.table === ewohControlCommand).slice(-1)[0]?.row.commandId as string;
    await expect(service.ackCommand(commandId, { delivered: false }, ACTOR))
      .rejects.toBeInstanceOf(BadRequestException);
    const ack = await service.ackCommand(commandId, { delivered: false, reason: 'authorization_required' }, ACTOR);
    expect(ack.status).toBe('failed');
  });

  it('重复 ack → alreadyAcked（幂等，不重复写结果行）；终态不可回退', async () => {
    const { service, inserts, resultRows } = serviceWith();
    await service.sendCommand('ctl-1', 'dispatch_task', ACTOR, { targetStationId: 'ST-9' });
    const commandId = inserts.filter((i) => i.table === ewohControlCommand).slice(-1)[0]?.row.commandId as string;
    await service.ackCommand(commandId, { delivered: true }, ACTOR);
    const before = resultRows.length;
    const again = await service.ackCommand(commandId, { delivered: true }, ACTOR);
    expect(again.alreadyAcked).toBe(true);
    expect(resultRows.length).toBe(before);
  });

  it('未知 commandId → 404（不静默成功）', async () => {
    const { service } = serviceWith();
    await expect(service.ackCommand('att-nope', { delivered: true }, ACTOR))
      .rejects.toBeInstanceOf(NotFoundException);
  });
});

describe('NO-60a：网关按 commandId 回执（机器身份，走同一套校验）', () => {
  it('executed → 命令/请求状态落终态，结果行 resultType=command_receipt', async () => {
    const fake = makeControlDb({
      requests: [requestSeed({ status: 'approved', commandKeys: ['dispatch_task'] })],
    });
    const service = new ControlService(fake.db as never, undefined, makeApprovalStub(approvalInstance('approved')) as never);
    await service.sendCommand('ctl-1', 'dispatch_task', ACTOR, { targetStationId: 'ST-9' });
    const commandId = fake.inserts.filter((i) => i.table === ewohControlCommand).slice(-1)[0]?.row.commandId as string;
    await service.ackCommand(commandId, { delivered: true }, ACTOR);

    const request = await service.receiveReceiptByCommandId(
      commandId, 'executed', { deviceId: 'AGV-1', adapterAccepted: true }, ACTOR,
    );

    const attempt = request.attempts.find((a) => a.commandKey === 'dispatch_task');
    expect(attempt?.status).toBe('executed');
    const receiptRow = fake.inserts.filter((i) => i.table === ewohControlResult).slice(-1)[0]?.row;
    expect(receiptRow).toMatchObject({ resultType: 'command_receipt', resultCode: 'executed', success: true });
  });

  it('未知 commandId → 404；跨租户 → 404（不泄露别的租户的命令）', async () => {
    const fake = makeControlDb({
      requests: [requestSeed({ status: 'approved', commandKeys: ['dispatch_task'], orgId: 'ORG-1' })],
    });
    const service = new ControlService(fake.db as never, undefined, makeApprovalStub(approvalInstance('approved')) as never);
    await service.sendCommand('ctl-1', 'dispatch_task', ACTOR, { targetStationId: 'ST-9' });
    const commandId = fake.inserts.filter((i) => i.table === ewohControlCommand).slice(-1)[0]?.row.commandId as string;

    await expect(service.receiveReceiptByCommandId('att-nope', 'executed', {}, ACTOR))
      .rejects.toBeInstanceOf(NotFoundException);
    await expect(service.receiveReceiptByCommandId(commandId, 'executed', {}, ACTOR_ORG2))
      .rejects.toBeInstanceOf(NotFoundException);
  });

  it('非法 result → 400（只允许 executed/failed，不许自造状态）', async () => {
    const fake = makeControlDb({
      requests: [requestSeed({ status: 'approved', commandKeys: ['dispatch_task'] })],
    });
    const service = new ControlService(fake.db as never, undefined, makeApprovalStub(approvalInstance('approved')) as never);
    await service.sendCommand('ctl-1', 'dispatch_task', ACTOR, { targetStationId: 'ST-9' });
    const commandId = fake.inserts.filter((i) => i.table === ewohControlCommand).slice(-1)[0]?.row.commandId as string;
    await expect(service.receiveReceiptByCommandId(commandId, 'cancelled' as never, {}, ACTOR))
      .rejects.toBeInstanceOf(BadRequestException);
  });
});

/**
 * NO-62a：**投递前授权复核**（授权链在投递/确认/回执三条路径上都是 fail-closed）。
 *
 * 背景（真实缺陷）：平台原来只在**人工下发**那一步校验审批；命令落成 `sent` 之后
 * 网关轮询只看"请求行是否终态"——审批在"下发 → 投递"窗口内被撤销/过期/改写，
 * 命令照样会投到 AGV 上执行。这些用例锁定的就是这条 fail-open 通道。
 */
describe('NO-62a：投递前授权复核（指纹 / 审批时效 / 撤回 / 未授权执行）', () => {
  function commandSeed(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return {
      commandId: 'att-seed-1',
      requestId: 'ctl-1',
      rootCommandId: 'att-seed-1',
      attemptNo: 1,
      commandKey: 'dispatch_task',
      status: 'sent',
      sentAt: '2026-08-03T00:00:00.000Z',
      payload: { targetStationId: 'ST-1' },
      orgId: 'ORG-1',
      authorizationFingerprint: null,
      ...overrides,
    };
  }

  function serviceWith(
    approval: ApprovalInstance | null,
    seed: { requests?: unknown[]; commands?: unknown[] } = {},
  ) {
    const fake = makeControlDb({
      requests: [
        requestSeed({ status: 'approved', commandKeys: ['dispatch_task'], ...(seed.requests?.[0] as object ?? {}) }),
        ...(seed.requests ?? []).slice(1),
      ],
      commands: seed.commands ?? [],
    });
    const audit = makeAuditStub();
    const service = new ControlService(
      fake.db as never,
      audit.stub as never,
      makeApprovalStub(approval) as never,
    );
    return { ...fake, service, audit };
  }

  it('下发时落库的授权指纹 = 共享契约对（请求/设备/命令/审批实例/参数）的计算值', async () => {
    const { service, inserts } = serviceWith(approvalInstance('approved', { id: 'appr-9' }));
    await service.sendCommand('ctl-1', 'dispatch_task', ACTOR, { targetStationId: 'ST-9' });
    const cmd = inserts.find((i) => i.table === ewohControlCommand)?.row;
    expect(cmd?.authorizationFingerprint).toBe(
      authorizationFingerprint({
        requestId: 'ctl-1',
        deviceId: 'exo-1',
        commandKey: 'dispatch_task',
        approvalInstanceId: 'appr-9',
        payload: { targetStationId: 'ST-9' },
      }),
    );
    expect(cmd?.authorizationVerifiedAt).toBeInstanceOf(Date);
  });

  it('授权指纹随审批实例走：换一张审批实例 → 指纹必须变（不许"有审批就算过"）', async () => {
    const first = serviceWith(approvalInstance('approved', { id: 'appr-1' }));
    await first.service.sendCommand('ctl-1', 'dispatch_task', ACTOR, { targetStationId: 'ST-9' });
    const second = serviceWith(approvalInstance('approved', { id: 'appr-2' }));
    await second.service.sendCommand('ctl-1', 'dispatch_task', ACTOR, { targetStationId: 'ST-9' });
    expect(first.inserts.find((i) => i.table === ewohControlCommand)?.row.authorizationFingerprint)
      .not.toBe(second.inserts.find((i) => i.table === ewohControlCommand)?.row.authorizationFingerprint);
  });

  it('投递排序：安全停机（stop）插队到发起搬运（dispatch_task）之前，即使它更晚下发', async () => {
    const { service } = serviceWith(approvalInstance('approved'), {
      commands: [
        commandSeed({ commandId: 'att-dispatch', commandKey: 'dispatch_task', sentAt: '2026-08-03T00:00:00.000Z' }),
        commandSeed({ commandId: 'att-stop', commandKey: 'stop', sentAt: '2026-08-03T00:09:00.000Z', payload: null }),
      ],
    });
    const pending = await service.listPendingCommands('exo-1', {}, ACTOR);
    expect(pending.commands.map((c) => c.commandId)).toEqual(['att-stop', 'att-dispatch']);
    expect(pending.commands[0]).toMatchObject({ priority: 0, priorityLabel: '安全优先' });
    expect(pending.commands[1]).toMatchObject({ priority: 5, priorityLabel: '发起搬运' });
    expect(pending.queued).toBe(2);
    expect(pending.oldestSentAt).toBe('2026-08-03T00:00:00.000Z');
    expect(pending.truncated).toBe(false);
  });

  it('审批超出有效期 → 命令被**撤回**（不投递）+ 结果行/审计/提醒都留痕', async () => {
    const expired = approvalInstance('approved', { approvedAt: '2020-01-01T00:00:00.000Z' });
    const { service, inserts, resultRows, audit } = serviceWith(expired, {
      commands: [commandSeed({ authorizationFingerprint: 'deadbeefdeadbeef' })],
    });
    const pending = await service.listPendingCommands('exo-1', {}, ACTOR);
    expect(pending.commands).toHaveLength(0);
    expect(pending.revoked).toBe(1);
    const rejection = resultRows.find((r) => (r as Record<string, unknown>).resultType === 'delivery_rejected');
    expect(rejection).toMatchObject({ resultCode: 'authorization_expired', success: false });
    expect(audit.logs.some((l) => l.action === 'control.command.delivery_rejected')).toBe(true);
    expect(inserts.some((i) => String(i.row.notificationId ?? '').startsWith('NTF-CTRL-att-seed-1-delivery_revoked')))
      .toBe(true);
  });

  it('授权范围被改写（指纹不符）→ 撤回并给出 fingerprint_mismatch（不静默投递）', async () => {
    const { service, resultRows } = serviceWith(approvalInstance('approved'), {
      commands: [commandSeed({ authorizationFingerprint: 'deadbeefdeadbeef' })],
    });
    const pending = await service.listPendingCommands('exo-1', {}, ACTOR);
    expect(pending.commands).toHaveLength(0);
    expect(pending.revoked).toBe(1);
    expect(resultRows.find((r) => (r as Record<string, unknown>).resultType === 'delivery_rejected'))
      .toMatchObject({ resultCode: 'fingerprint_mismatch' });
  });

  it('审批被撤销后网关才 ack"已投递" → 409 且命令落 revoked（不记成正常投递）', async () => {
    const state: { instance: ApprovalInstance | null } = { instance: approvalInstance('approved') };
    const fake = makeControlDb({
      requests: [requestSeed({ status: 'approved', commandKeys: ['dispatch_task'] })],
    });
    const service = new ControlService(
      fake.db as never,
      makeAuditStub().stub as never,
      { createApproval: jest.fn(), findLatestForEntity: jest.fn(async () => state.instance) } as never,
    );
    await service.sendCommand('ctl-1', 'dispatch_task', ACTOR, { targetStationId: 'ST-9' });
    const commandId = fake.inserts.filter((i) => i.table === ewohControlCommand).slice(-1)[0]?.row.commandId as string;

    // 审批在网关轮询窗口内被撤销
    state.instance = approvalInstance('cancelled');
    await expect(service.ackCommand(commandId, { delivered: true }, ACTOR))
      .rejects.toBeInstanceOf(ConflictException);

    const request = await service.getRequest('ctl-1');
    expect(request.attempts.find((a) => a.commandKey === 'dispatch_task')?.status).toBe('revoked');
    expect(request.status).toBe('revoked');
    // 已撤回的命令不接受任何投递确认回退
    await expect(service.ackCommand(commandId, { delivered: true }, ACTOR))
      .rejects.toBeInstanceOf(ConflictException);
  });

  it('ack 路径的撤回在**独立事务**里提交（409 回滚也带不走安全决策）', async () => {
    // 真实缺陷（本轮 e2e 抓到的）：OrgContextInterceptor 把请求包在事务里，
    // "撤回 → 抛 409"会让撤回写入随请求事务一起回滚 → 命令留在 sent，
    // 下一轮轮询还会把它投给设备（fail-open 复现）。
    const fake = makeControlDb({
      requests: [requestSeed({ status: 'approved', commandKeys: ['dispatch_task'], riskLevel: 'high' })],
    });
    const detachedCalls: string[] = [];
    const requestDatabaseContext = {
      runInTransaction: jest.fn(async (_guc: unknown, cb: () => Promise<void>) => {
        await cb();
      }),
      runDetachedTransaction: jest.fn(
        async (guc: Array<{ name: string; value: string }>, cb: (db: unknown) => Promise<void>) => {
          detachedCalls.push(guc.map((g) => `${g.name}=${g.value}`).join(','));
          await cb(fake.db);
        },
      ),
    };
    const service = new ControlService(
      fake.db as never,
      makeAuditStub().stub as never,
      makeApprovalStub(approvalInstance('approved')) as never,
      requestDatabaseContext as never,
    );
    await service.sendCommand('ctl-1', 'dispatch_task', ACTOR, { targetStationId: 'ST-9' });
    const commandId = fake.inserts.filter((i) => i.table === ewohControlCommand).slice(-1)[0]?.row.commandId as string;
    // 请求在投递窗口内进入终态 → ack 复核拒绝
    await fake.db && (fake.requestRows as Array<Record<string, unknown>>)
      .forEach((row) => { row.status = 'executed'; });

    await expect(service.ackCommand(commandId, { delivered: true }, ACTOR))
      .rejects.toBeInstanceOf(ConflictException);

    expect(requestDatabaseContext.runDetachedTransaction).toHaveBeenCalledTimes(1);
    // GUC 必须用权威口径（含 app.current_org_ids——漏它会被 RLS 拒绝）
    expect(detachedCalls[0]).toContain('app.current_org_id=ORG-1');
    expect(detachedCalls[0]).toContain('app.current_org_ids=ORG-1');
    // 撤回与留痕真的写了
    expect((fake.commandRows as Array<Record<string, unknown>>)
      .some((row) => row.commandId === commandId && row.status === 'revoked')).toBe(true);
    expect(fake.resultRows.some((r) => (r as Record<string, unknown>).resultType === 'delivery_rejected')).toBe(true);
  });

  it('F2 词表演进前创建的行（risk_level 冻结为 normal 的 dispatch_task）→ 投递前按当前词表复核，拒绝投递并撤回', async () => {
    // 真实缺口：risk_level 是**创建那一刻**算出来的。NO-60a 把 dispatch_task/resume/clear_fault
    // 并入高危词表之前落库的行是 'normal'，只信这个冻结值 → 该命令永远免审批投递
    // （授权链在投递路径上 fail-open）。这里断言投递前按**当前**词表重新定级。
    const { service, resultRows } = serviceWith(null, {
      requests: [{ status: 'created', riskLevel: 'normal' }],
      commands: [commandSeed({ commandId: 'att-stale-normal', authorizationFingerprint: null })],
    });

    const pending = await service.listPendingCommands('exo-1', {}, ACTOR);

    expect(pending.commands).toHaveLength(0);
    expect(pending.revoked).toBe(1);
    expect(resultRows.find((r) => (r as Record<string, unknown>).resultType === 'delivery_rejected'))
      .toMatchObject({ resultCode: 'approval_missing' });
  });

  it('F2 安全动作不被同单高危命令连坐：请求 risk_level=normal 时 stop 仍可投递', async () => {
    // 判级只看**本条命令键**：整单重算高危会把急停一起卡在投递口（与 NO-62b 同一条纪律）。
    // approval=null：若实现改成"按整张请求的键列表重算"，stop 会被判需要审批而无人可查
    // → 撤回 → 本用例立刻失败。
    const { service } = serviceWith(null, {
      requests: [{ status: 'created', riskLevel: 'normal' }],
      commands: [
        commandSeed({ commandId: 'att-stop-now', commandKey: 'stop', payload: null, authorizationFingerprint: null }),
      ],
    });

    const pending = await service.listPendingCommands('exo-1', {}, ACTOR);

    expect(pending.commands.map((c) => c.commandId)).toEqual(['att-stop-now']);
    expect(pending.revoked).toBe(0);
  });

  it('NO-65b 投递闸门：设备在搬一个活时，第二条运动命令暂缓投递（一车一活）', async () => {
    // 现场语义：一台正在搬运的 AGV 不该同时收到第二条 dispatch_task。
    // 命令层已禁止**同一命令键**并发下发，但不同 requestId 的第二条搬运不会被拦——
    // 那要等命令投到设备上才由设备拒绝（太晚）。闸门放在平台投递前。
    const { service } = serviceWith(approvalInstance('approved'), {
      commands: [
        commandSeed({ commandId: 'att-busy', commandKey: 'dispatch_task', status: 'gateway_received' }),
        commandSeed({ commandId: 'att-second', commandKey: 'dispatch_task', status: 'sent' }),
      ],
    });
    const pending = await service.listPendingCommands('exo-1', {}, ACTOR);
    expect(pending.commands.map((c) => c.commandId)).not.toContain('att-second');
    expect(pending.deferred).toEqual([
      expect.objectContaining({ commandId: 'att-second', commandKey: 'dispatch_task', reason: 'device_busy' }),
    ]);
    expect(String(pending.deferred[0].blockedBy)).toContain('att-busy');
  });

  it('NO-65b 安全动作永不被暂缓（停止/暂停必须能插队）', async () => {
    const { service } = serviceWith(approvalInstance('approved'), {
      commands: [
        commandSeed({ commandId: 'att-busy', commandKey: 'dispatch_task', status: 'gateway_received' }),
        commandSeed({ commandId: 'att-stop-now', commandKey: 'stop', status: 'sent', payload: null }),
      ],
    });
    const pending = await service.listPendingCommands('exo-1', {}, ACTOR);
    expect(pending.commands.map((c) => c.commandId)).toContain('att-stop-now');
    expect(pending.deferred).toEqual([]);
  });

  it('NO-65b 设备空下来后暂缓自动解除（暂缓 ≠ 失败，命令保持 sent）', async () => {
    const { service, commandRows } = serviceWith(approvalInstance('approved'), {
      commands: [
        commandSeed({ commandId: 'att-busy', commandKey: 'dispatch_task', status: 'gateway_received' }),
        commandSeed({ commandId: 'att-second', commandKey: 'dispatch_task', status: 'sent' }),
      ],
    });
    const before = await service.listPendingCommands('exo-1', {}, ACTOR);
    expect(before.commands.map((c) => c.commandId)).not.toContain('att-second');
    // 上一条执行完成（回执/终态）→ 设备空下来
    (commandRows as Array<Record<string, unknown>>)
      .filter((row) => row.commandId === 'att-busy')
      .forEach((row) => { row.status = 'executed'; });
    const after = await service.listPendingCommands('exo-1', {}, ACTOR);
    expect(after.commands.map((c) => c.commandId)).toContain('att-second');
    expect(after.deferred).toEqual([]);
  });

  it('NO-68a 投递积压巡检：超过 SLA 仍未交付 → 按设备发确定性提醒（幂等）+ 审计', async () => {
    const old = new Date(Date.now() - 30 * 60_000); // 30 分钟前下发（SLA 默认 5 分钟）
    const fake = makeControlDb({
      requests: [requestSeed({ status: 'approved', commandKeys: ['dispatch_task'], riskLevel: 'high' })],
      commands: [
        commandSeed({ commandId: 'att-stuck', commandKey: 'dispatch_task', status: 'sent', sentAt: old, payload: null }),
        // 已交付的不算积压（问题在设备侧，不在投递）
        commandSeed({ commandId: 'att-delivered', commandKey: 'pause', status: 'sent', sentAt: old, deliveredAt: new Date(), payload: null }),
      ],
    });
    const audit = makeAuditStub();
    const service = new ControlService(
      fake.db as never,
      audit.stub as never,
      makeApprovalStub(approvalInstance('approved')) as never,
    );
    const result = await service.sweepDeliveryBacklog(ACTOR);

    expect(result.scanned).toBe(1);
    expect(result.devicesWithBacklog).toBe(1);
    expect(result.created).toBeGreaterThan(0);
    expect(result.slaMs).toBeGreaterThan(0);
    expect(
      fake.notificationRows.some((row) =>
        String((row as Record<string, unknown>).notificationId ?? '').includes('delivery_backlog'),
      ),
    ).toBe(true);
    // 提醒内容必须能照着排障（设备/条数/原因清单）
    const notification = fake.notificationRows.find((row) =>
      String((row as Record<string, unknown>).notificationId ?? '').includes('delivery_backlog'),
    ) as Record<string, unknown>;
    expect(String(notification?.body ?? '')).toContain('30');
    expect(String(notification?.body ?? '')).toContain('执行边界');
    expect(audit.logs.some((log) => log.action === 'control.delivery_backlog_sweep')).toBe(true);
  });

  it('NO-68a 投递积压巡检：没有积压时不发提醒（不制造噪音）', async () => {
    const { service } = serviceWith(approvalInstance('approved'), {
      commands: [commandSeed({
        commandId: 'att-fresh',
        commandKey: 'pause',
        status: 'sent',
        // 刚下发（默认 seed 的 sentAt 是历史固定时间，会被正确判成积压）
        sentAt: new Date(),
        payload: null,
      })],
    });
    const result = await service.sweepDeliveryBacklog(ACTOR);
    expect(result.devicesWithBacklog).toBe(0);
    expect(result.created).toBe(0);
  });

  it('NO-68a 人面读面给出投递老化：最久等待 + 超 SLA 条数（没人看时也能被问出来）', async () => {
    const old = new Date(Date.now() - 12 * 60_000);
    const { service } = serviceWith(approvalInstance('approved'), {
      commands: [
        commandSeed({ commandId: 'att-old', commandKey: 'pause', status: 'sent', sentAt: old, payload: null }),
        commandSeed({ commandId: 'att-new', commandKey: 'pause', status: 'sent', sentAt: new Date(), payload: null }),
      ],
    });
    const view = await service.listDeviceCommands('exo-1', {}, ACTOR);
    expect(Number(view.summary.oldestWaitingMs)).toBeGreaterThan(11 * 60_000);
    expect(view.summary.overdue).toBe(1);
    expect(Number(view.summary.deliverySlaMs)).toBeGreaterThan(0);
  });

  it('NO-66a 人面读面：在飞/排队/撤回/验签结论都能被现场看到（不是只有网关能读）', async () => {
    const { service } = serviceWith(approvalInstance('approved'), {
      commands: [
        commandSeed({
          commandId: 'att-inflight',
          commandKey: 'dispatch_task',
          status: 'gateway_received',
          authorizationFingerprint: 'hmac-sha256:v2:0123456789abcdef0123456789abcdef',
          authorizationVerifiedAt: new Date(),
        }),
        commandSeed({ commandId: 'att-queued', commandKey: 'dispatch_task', status: 'sent' }),
        commandSeed({
          commandId: 'att-revoked',
          commandKey: 'resume',
          status: 'revoked',
          revokedReason: 'fingerprint_mismatch',
          errorMessage: '授权范围与命令内容不一致',
        }),
      ],
    });
    const view = await service.listDeviceCommands('exo-1', {}, ACTOR);
    expect(view.deviceId).toBe('exo-1');
    label: {
      // 在飞（已投递未回执）
      const inflight = view.commands.find((c) => c.commandId === 'att-inflight');
      expect(inflight?.deliveryState).toBe('gateway_received');
      expect(inflight?.fingerprintScheme).toBe('hmac-sha256:v2');
      expect(inflight?.fingerprintVerified).toBe(true);
      // 排队（设备忙）——与投递闸门同一口径，且给出占用者
      const queued = view.commands.find((c) => c.commandId === 'att-queued');
      expect(queued?.deliveryState).toBe('queued_device_busy');
      expect(String(queued?.deliveryNote)).toContain('一车一活');
      // 被撤回：原因码 + 现场可读说明
      const revoked = view.commands.find((c) => c.commandId === 'att-revoked');
      expect(revoked?.revokedReason).toBe('fingerprint_mismatch');
      expect(String(revoked?.revokedReasonLabel)).toContain('授权范围');
      expect(view.summary.inFlight).toBe(1);
      expect(view.summary.queued).toBe(1);
      expect(view.summary.revoked).toBe(1);
      expect(view.summary.busyBlocker).toContain('att-inflight');
      break label;
    }
  });

  it('NO-66a 人面读面：空设备返回空列表（不伪造"一切正常"的假状态）', async () => {
    const { service } = serviceWith(approvalInstance('approved'));
    const view = await service.listDeviceCommands('exo-none', {}, ACTOR);
    expect(view.commands).toEqual([]);
    expect(view.summary).toMatchObject({ inFlight: 0, queued: 0, revoked: 0, busyBlocker: null });
  });

  it('NO-67b 投递配额：本分钟用尽后普通命令排队（reason=quota），安全动作插队且不占配额', async () => {
    // 配额设为 1/min：第一条普通命令可投，第二条排队，`stop` 永远能过。
    const prev = process.env.EWOH_CONTROL_DELIVERY_QUOTA_PER_MINUTE;
    process.env.EWOH_CONTROL_DELIVERY_QUOTA_PER_MINUTE = '1';
    try {
      const { service } = serviceWith(approvalInstance('approved'), {
        commands: [
          commandSeed({ commandId: 'att-p1', commandKey: 'pause', status: 'sent', payload: null }),
          commandSeed({ commandId: 'att-p2', commandKey: 'pause', status: 'sent', payload: null }),
          commandSeed({ commandId: 'att-s1', commandKey: 'stop', status: 'sent', payload: null }),
        ],
      });
      const first = await service.listPendingCommands('exo-1', {}, ACTOR);
      // 配额 1：一条普通命令进入投递窗口，其余普通命令排队；stop 不受配额约束
      expect(first.commands.map((c) => c.commandId)).toContain('att-s1');
      expect(first.quota).toMatchObject({ perMinute: 1, remaining: 0 });
      const quotaDeferred = first.deferred.filter((d) => d.reason === 'quota');
      expect(quotaDeferred).toHaveLength(1);
      expect(String(quotaDeferred[0].blockedBy)).toContain('quota:1/min');
    } finally {
      if (prev === undefined) delete process.env.EWOH_CONTROL_DELIVERY_QUOTA_PER_MINUTE;
      else process.env.EWOH_CONTROL_DELIVERY_QUOTA_PER_MINUTE = prev;
    }
  });

  it('NO-67b 配额为 0/负 = 显式关闭（remaining=null，不排队）', async () => {
    const prev = process.env.EWOH_CONTROL_DELIVERY_QUOTA_PER_MINUTE;
    process.env.EWOH_CONTROL_DELIVERY_QUOTA_PER_MINUTE = '0';
    try {
      const { service } = serviceWith(approvalInstance('approved'), {
        commands: [
          commandSeed({ commandId: 'att-u1', commandKey: 'pause', status: 'sent', payload: null }),
          commandSeed({ commandId: 'att-u2', commandKey: 'pause', status: 'sent', payload: null }),
        ],
      });
      const pending = await service.listPendingCommands('exo-1', {}, ACTOR);
      expect(pending.commands).toHaveLength(2);
      expect(pending.deferred.filter((d) => d.reason === 'quota')).toHaveLength(0);
      expect(pending.quota).toMatchObject({ perMinute: 0, remaining: null });
    } finally {
      if (prev === undefined) delete process.env.EWOH_CONTROL_DELIVERY_QUOTA_PER_MINUTE;
      else process.env.EWOH_CONTROL_DELIVERY_QUOTA_PER_MINUTE = prev;
    }
  });

  it('设备真的动了但授权已失效 → 回执**照记**（事实不丢）+ 额外落未授权执行违规', async () => {
    const { service, resultRows, audit, inserts } = serviceWith(approvalInstance('approved'), {
      commands: [commandSeed({ status: 'revoked', revokedReason: 'authorization_expired', authorizationFingerprint: 'x' })],
    });
    const request = await service.receiveReceiptByCommandId('att-seed-1', 'executed', { adapterAccepted: true }, ACTOR);
    expect(request.attempts.find((a) => a.commandKey === 'dispatch_task')?.status).toBe('executed');
    expect(resultRows.some((r) => (r as Record<string, unknown>).resultType === 'command_receipt')).toBe(true);
    expect(resultRows.find((r) => (r as Record<string, unknown>).resultType === 'authorization_violation'))
      .toMatchObject({ resultCode: 'unauthorized_execution', success: false });
    expect(audit.logs.some((l) => l.action === 'control.command.unauthorized_execution')).toBe(true);
    expect(inserts.some((i) => String(i.row.notificationId ?? '').includes('unauthorized_execution'))).toBe(true);
  });
});

/**
 * F3：**人面回执的 result 必须是封闭词表**。
 *
 * 背景（真实缺口）：`receiveReceipt` 的 `result: 'executed' | 'failed'` 只是 TS 类型，
 * 运行时不存在；server 侧 strict:false + `@Body()` 内联接口（没有 DTO 校验管道），
 * 于是任意字符串都能写进 `ewoh_control_command.status` 与 `ewoh_control_result.result_code`
 * ——两列都没有 CHECK 约束。`result='revoked'` 最毒：一条在飞命令会被伪装成
 * "平台已因授权复核撤回"，此后 ackCommand 永远拒绝它的投递确认、聚合状态也被改写。
 * 机器面 `receiveReceiptByCommandId` 早有同样的校验，这些用例锁的是**同一口径**。
 */
describe('F3：人面回执 result 枚举校验（与机器面同一口径）', () => {
  function seededReceiptDb() {
    return makeControlDb({
      requests: [{
        requestId: 'ctl-1',
        deviceId: 'exo-1',
        commandKeys: ['start'],
        idempotencyKey: 'idem-1',
        status: 'created',
        requestedAt: '2026-08-03T00:00:00.000Z',
        orgId: 'ORG-1',
        riskLevel: 'normal',
      }],
      commands: [{
        commandId: 'att-1',
        requestId: 'ctl-1',
        rootCommandId: 'att-1',
        attemptNo: 1,
        commandKey: 'start',
        status: 'sent',
        sentAt: '2026-08-03T00:00:00.000Z',
        payload: null,
        orgId: 'ORG-1',
        authorizationFingerprint: null,
      }],
    });
  }

  it("result='revoked'（词表外的值）→ 400，不写命令状态、不写结果行", async () => {
    const { db, updates, inserts, commandRows } = seededReceiptDb();
    const service = new ControlService(db as never);

    await expect(
      service.receiveReceipt('ctl-1', 'start', 'revoked' as never, {}),
    ).rejects.toBeInstanceOf(BadRequestException);

    expect(updates.filter((u) => u.table === ewohControlCommand)).toHaveLength(0);
    expect(inserts.filter((i) => i.table === ewohControlResult)).toHaveLength(0);
    // 命令事实未被改写（仍是在飞，不是"平台已撤回"）
    expect((commandRows as Array<Record<string, unknown>>)[0]?.status).toBe('sent');
  });

  it("result='executed' 仍照常落库（枚举校验不误伤正常回执）", async () => {
    const { db, inserts } = seededReceiptDb();
    const service = new ControlService(db as never);

    const request = await service.receiveReceipt('ctl-1', 'start', 'executed', { ok: true });

    expect(request.attempts.find((a) => a.commandKey === 'start')?.status).toBe('executed');
    expect(inserts.filter((i) => i.table === ewohControlResult)).toHaveLength(1);
  });
});

/**
 * F4：投递事实的写入 = 条件更新（CAS + status 守卫），配额与"真的投出去了几条"同源。
 *
 * 背景（真实缺口）：原来每次轮询都无条件 `UPDATE ... SET delivered_at = now()`：
 *   · 并发 ack/回执/撤回已把命令改走状态后，这一轮仍会写上"已交付"（撤回行被污染）；
 *   · 两个并发 poll 各自读同一批 sent 行、各自把 delivered_at 写一遍、各自扣配额
 *     → 同一分钟投出 2× 配额（配额形同虚设）。
 * 下面用"CAS 未命中（0 行）"的替身模拟真实条件更新的两种未命中分支。
 */
describe('F4：投递写入的 CAS 与配额自洽', () => {
  function deliveryDb(commands: Array<Record<string, unknown>>) {
    return makeControlDb({
      requests: [requestSeed({
        status: 'created',
        commandKeys: ['pause'],
        riskLevel: 'normal',
      })],
      commands,
    });
  }

  function deliverySeed(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return {
      commandId: 'att-1',
      requestId: 'ctl-1',
      rootCommandId: 'att-1',
      attemptNo: 1,
      commandKey: 'pause',
      status: 'sent',
      sentAt: '2026-08-03T00:00:00.000Z',
      payload: null,
      orgId: 'ORG-1',
      authorizationFingerprint: null,
      ...overrides,
    };
  }

  /** 把命令表的 UPDATE 换成"CAS 未命中"（0 行）；`concurrentStatus` 模拟并发改写先落地。 */
  function stubClaimMiss(
    fake: { db: any; commandRows: unknown[] },
    opts: { concurrentStatus?: string } = {},
  ): void {
    const original = fake.db.update;
    fake.db.update = jest.fn((table: unknown) => {
      if (table !== ewohControlCommand) return original(table);
      return {
        set: jest.fn(() => ({
          where: jest.fn(() => {
            if (opts.concurrentStatus) {
              for (const row of fake.commandRows as Array<Record<string, unknown>>) {
                row.status = opts.concurrentStatus;
              }
            }
            return { returning: jest.fn().mockResolvedValue([]) };
          }),
        })),
      };
    });
  }

  it('CAS 未命中且状态已被并发改写（revoked）→ 本轮不返回该命令（不重复执行已作废的动作）', async () => {
    const fake = deliveryDb([deliverySeed({ commandId: 'att-race' })]);
    stubClaimMiss(fake, { concurrentStatus: 'revoked' });
    const service = new ControlService(fake.db as never);

    const pending = await service.listPendingCommands('exo-1', {}, ACTOR);

    expect(pending.commands).toHaveLength(0);
    expect(pending.queued).toBe(1);
  });

  it('CAS 未命中但仍是 sent（本窗口内已投过、网关还没 ack）→ 仍返回（at-least-once），但不重复占配额', async () => {
    const prev = process.env.EWOH_CONTROL_DELIVERY_QUOTA_PER_MINUTE;
    process.env.EWOH_CONTROL_DELIVERY_QUOTA_PER_MINUTE = '2';
    try {
      const fake = deliveryDb([
        // 本窗口内已交付过一次（delivered_at 在 60s 窗口内）
        deliverySeed({ commandId: 'att-redeliver', deliveredAt: new Date() }),
        deliverySeed({ commandId: 'att-fresh', sentAt: '2026-08-03T00:01:00.000Z' }),
      ]);
      stubClaimMiss(fake);
      const service = new ControlService(fake.db as never);

      const pending = await service.listPendingCommands('exo-1', {}, ACTOR);

      // 重投照发（边缘丢包靠重投恢复），但只有**真的新投出去**的那次才占配额：
      // usedInWindow=1（窗口内已投过 1 条）+ 本轮 CAS 命中 0 条 → remaining = 2-1-0 = 1。
      expect(pending.commands.map((c) => c.commandId)).toEqual(['att-redeliver']);
      expect(pending.quota).toMatchObject({ perMinute: 2, usedInWindow: 1, remaining: 1 });
    } finally {
      if (prev === undefined) delete process.env.EWOH_CONTROL_DELIVERY_QUOTA_PER_MINUTE;
      else process.env.EWOH_CONTROL_DELIVERY_QUOTA_PER_MINUTE = prev;
    }
  });

  it('CAS 命中（首次投递）→ 照常扣配额（守卫不误伤正常投递）', async () => {
    const prev = process.env.EWOH_CONTROL_DELIVERY_QUOTA_PER_MINUTE;
    process.env.EWOH_CONTROL_DELIVERY_QUOTA_PER_MINUTE = '2';
    try {
      const { service } = (() => {
        const fake = deliveryDb([
          deliverySeed({ commandId: 'att-a' }),
          deliverySeed({ commandId: 'att-b', sentAt: '2026-08-03T00:01:00.000Z' }),
        ]);
        return { service: new ControlService(fake.db as never) };
      })();

      const pending = await service.listPendingCommands('exo-1', {}, ACTOR);

      expect(pending.commands.map((c) => c.commandId)).toEqual(['att-a', 'att-b']);
      expect(pending.quota).toMatchObject({ perMinute: 2, usedInWindow: 0, remaining: 0 });
    } finally {
      if (prev === undefined) delete process.env.EWOH_CONTROL_DELIVERY_QUOTA_PER_MINUTE;
      else process.env.EWOH_CONTROL_DELIVERY_QUOTA_PER_MINUTE = prev;
    }
  });
});

/**
 * ack 的投递确认写入与 F4 投递 CAS 同一条纪律：条件 UPDATE 0 行命中 = 读-改-写
 * 窗口内命令已被并发改写（投递前复核撤回 / 回执 / 另一网关 ack）。修复前这里
 * 会把"没生效的确认"当成功返回（status='gateway_received'）并落 gateway_ack
 * 'delivered' 结果行——把已撤回的命令污染成"网关确认过投递"（实测复现）。
 * 边缘契约（control_downlink.py）把 409 定义为"本轮 ack 未被接受，不得回执执行
 * 成功"，显式冲突正是边缘侧预期的失败形态。
 */
describe('F4：ackCommand 的 CAS 未命中必须显式冲突（不撒谎的 ack）', () => {
  const ACK_COLS: Record<string, string> = {
    request_id: 'requestId',
    command_id: 'commandId',
    device_id: 'deviceId',
    status: 'status',
    org_id: 'orgId',
    idempotency_key: 'idempotencyKey',
  };

  /** 条件感知假库：update 真正求值 where；onBeforeUpdate 模拟并发写先行提交。 */
  function makeRacingDb(seed: {
    request: Record<string, unknown>;
    command: Record<string, unknown>;
    onBeforeUpdate?: () => void;
  }) {
    const commandRow = { ...seed.command };
    const requestRow = { ...seed.request };
    const resultRows: Array<Record<string, unknown>> = [];
    const matches = makeConditionMatcher(ACK_COLS);
    const rowsFor = (table: unknown): Array<Record<string, unknown>> =>
      table === ewohControlRequest
        ? [requestRow]
        : table === ewohControlCommand
          ? [commandRow]
          : [];
    const chain = (rows: Array<Record<string, unknown>>): any => {
      const q: any = Promise.resolve(rows);
      q.where = (cond: unknown) => chain(rows.filter((row) => matches(cond, row)));
      q.innerJoin = () => q(rows);
      q.orderBy = () => q;
      q.limit = () => q;
      return q;
    };
    return {
      db: {
        select: () => ({ from: (table: unknown) => chain(rowsFor(table)) }),
        insert: () => ({
          values: (row: Record<string, unknown>) => {
            resultRows.push(row);
            return Promise.resolve([row]);
          },
        }),
        update: () => {
          const set = (patch: Record<string, unknown>) => {
            const where = (cond: unknown) => {
              seed.onBeforeUpdate?.();
              // 命令行走命令守卫条件；请求行（聚合状态回写）走请求条件。
              const tableRows = patch.commandId !== undefined || patch.status !== undefined
                ? [commandRow]
                : [requestRow];
              const hit = tableRows.filter((row) => matches(cond, row));
              for (const row of hit) Object.assign(row, patch);
              return { returning: async () => hit.map((row) => ({ ...row })) };
            };
            return { where };
          };
          return { set };
        },
        execute: async () => undefined,
      },
      commandRow,
      resultRows,
    };
  }

  it('并发撤回后 ack delivered=true → 409，不写 gateway_ack 结果行（不假装投递成功）', async () => {
    const fingerprint = authorizationFingerprint({
      requestId: 'ctl-1',
      deviceId: 'exo-1',
      commandKey: 'stop',
      approvalInstanceId: null,
      payload: null,
    });
    let racing: ReturnType<typeof makeRacingDb>;
    racing = makeRacingDb({
      request: requestSeed({
        commandKeys: ['stop'],
        status: 'created',
        riskLevel: 'normal',
      }),
      command: {
        commandId: 'att-1',
        requestId: 'ctl-1',
        rootCommandId: 'att-1',
        attemptNo: 1,
        commandKey: 'stop',
        status: 'sent',
        sentAt: '2026-08-03T00:00:00.000Z',
        orgId: 'ORG-1',
        payload: null,
        authorizationFingerprint: fingerprint,
      },
      onBeforeUpdate: () => {
        racing.commandRow.status = 'revoked';
        racing.commandRow.revokedReason = 'authorization_revoked';
      },
    });
    const service = new ControlService(racing.db as never);

    await expect(service.ackCommand('att-1', { delivered: true }, ACTOR))
      .rejects.toBeInstanceOf(ConflictException);
    // 命令事实保持并发事务写入的终态，且没有"网关已投递"的假结果行。
    expect(racing.commandRow.status).toBe('revoked');
    expect(racing.resultRows).toHaveLength(0);
  });
});
