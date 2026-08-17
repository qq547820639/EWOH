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
  classifyControlRisk,
} from './control.service';
import {
  ewohControlRequest,
  ewohControlCommand,
} from '@server/database/schema';
import { makeControlDb } from '../../../test/helpers/fake-control-db';
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

function approvalInstance(status: ApprovalInstance['status']): ApprovalInstance {
  return {
    id: 'appr-1',
    entityType: 'control_request',
    entityId: 'ctl-1',
    status,
    steps: [{ id: 'step-1', role: 'safety_admin', status: 'approved' }],
    createdAt: '2026-08-03T00:00:00.000Z',
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
});
