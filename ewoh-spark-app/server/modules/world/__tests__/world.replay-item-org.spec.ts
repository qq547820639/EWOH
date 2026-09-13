/// <reference types="jest" />
/* 回归（FR4 对抗审查 2026-09-13）：回放标注事件必须跟随**源事件的租户**归属。
 *
 * 缺陷：createReplayItem 里 `orgId = actor?.primaryOrgId ?? source.orgId ?? null`——
 * 派生事件（REPLAY_*）与因果链行落在**操作者的** org，而不是源事件的 org。
 * global_admin 跨租户检索时（orgCondition 对 admin 放行），对 org-B 的事件
 * 建回放标注会写进 admin 自己的 org-A：org-B 的用户看不到本方事件的标注，
 * 且 getEventChain（org-B 谓词）枚举不到这条 derived_from_replay 链节点——
 * 派生事实与源事实在租户维度上永久脱钩。非 admin 路径两者恒相等（查询已按
 * org 过滤），行为不变。
 */
/// <reference types="jest" />
import { WorldService } from '../world.service';

function createReplayDb() {
  const inserted: Array<Record<string, unknown>> = [];
  const sourceEvent = {
    id: 'row-1',
    eventId: 'evt-src',
    orgId: 'org-b',
    deviceId: 'dev-1',
    title: '源事件',
    severity: 'high',
  };
  const db = {
    select: jest.fn(() => ({
      from: jest.fn(() => ({
        // createReplayItem 的源事件查询直接 await where() 结果（无 limit）
        where: jest.fn(() => Promise.resolve([sourceEvent])),
      })),
    })),
    insert: jest.fn(() => ({
      values: jest.fn((v: Record<string, unknown>) => {
        inserted.push(v);
        return Promise.resolve();
      }),
    })),
  };
  const audit = { appendAuditLog: jest.fn(() => Promise.resolve()) };
  return { db, audit, inserted };
}

describe('WorldService.createReplayItem：派生事件跟随源事件租户', () => {
  it('global_admin 对他租户事件建标注 → 事件与因果链行归属源事件 org（而非操作者 org）', async () => {
    const { db, audit, inserted } = createReplayDb();
    const service = new WorldService(db as never, audit as never);
    await service.createReplayItem(
      { eventId: 'evt-src', kind: 'issue', title: '复核' },
      { userId: 'admin-1', primaryOrgId: 'org-a', isGlobalAdmin: true } as never,
    );
    const eventRow = inserted.find((v) => v.eventCode === 'REPLAY_ISSUE');
    const chainRow = inserted.find((v) => v.causalType === 'derived_from_replay');
    expect(eventRow).toBeDefined();
    expect(chainRow).toBeDefined();
    expect(eventRow?.orgId).toBe('org-b');
    expect(chainRow?.orgId).toBe('org-b');
  });

  it('本租户事件：归属不变（操作者 org 与源事件 org 相同）', async () => {
    const { db, audit, inserted } = createReplayDb();
    const service = new WorldService(db as never, audit as never);
    await service.createReplayItem(
      { eventId: 'evt-src', kind: 'evidence' },
      { userId: 'u1', primaryOrgId: 'org-b', isGlobalAdmin: false } as never,
    );
    const eventRow = inserted.find((v) => v.eventCode === 'REPLAY_EVIDENCE');
    expect(eventRow?.orgId).toBe('org-b');
  });
});
