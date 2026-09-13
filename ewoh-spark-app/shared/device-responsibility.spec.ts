/* 设备责任人契约与"提醒该叫谁"判定（NO-49a）纯函数测试。
 *
 * 钉死：职责词表与文案（未登记原样透出）、人员身份归一（裸 id 与 person: 等价）、
 * 账号去重（同一账号只发一条，顺序稳定）、**无绑定账号如实报缺口**、无责任关系时 uncovered。
 */
/// <reference types="jest" />
import {
  DEVICE_RESPONSIBILITY_KINDS,
  barePersonRef,
  deviceResponsibilityLabel,
  isDeviceResponsibilityKind,
  planResponsibilityRecipients,
  summarizeResponsibilityCoverage,
} from './device-responsibility';

describe('职责词表', () => {
  it('三种职责都有中文文案，未登记值原样透出，空值说"未记录"', () => {
    for (const kind of DEVICE_RESPONSIBILITY_KINDS) {
      expect(deviceResponsibilityLabel(kind)).not.toBe(kind);
      expect(isDeviceResponsibilityKind(kind)).toBe(true);
    }
    expect(deviceResponsibilityLabel('supervisor_v2')).toBe('supervisor_v2');
    expect(deviceResponsibilityLabel(null)).toBe('未记录职责');
    expect(isDeviceResponsibilityKind('supervisor_v2')).toBe(false);
    expect(isDeviceResponsibilityKind(42)).toBe(false);
  });

  it('人员身份归一：裸 uuid 与 person: 前缀等价（ADR-006）', () => {
    expect(barePersonRef('person:63000000-0000-4000-8000-000000000001')).toBe(
      '63000000-0000-4000-8000-000000000001',
    );
    expect(barePersonRef(' 63000000-0000-4000-8000-000000000001 ')).toBe(
      '63000000-0000-4000-8000-000000000001',
    );
    expect(barePersonRef(null)).toBe('');
  });
});

describe('planResponsibilityRecipients', () => {
  const owner = { deviceId: 'EXO-1', personId: 'person:p1', responsibility: 'owner' as const };
  const operator = { deviceId: 'EXO-1', personId: 'person:p2', responsibility: 'operator' as const };

  it('有绑定账号 → 点名到人；账号按 id 稳定排序（幂等键稳定）', () => {
    const plan = planResponsibilityRecipients([operator, owner], new Map([
      ['p1', 'worker.zhangwei'],
      ['p2', 'worker.li'],
    ]));
    expect(plan.dedupedUserIds).toEqual(['worker.li', 'worker.zhangwei']);
    expect(plan.users[0]).toMatchObject({ recipientType: 'user', recipientId: 'worker.li', responsibility: 'operator' });
    expect(plan.unresolved).toEqual([]);
    expect(plan.uncovered).toBe(false);
  });

  it('人员 id 写法不同（裸 uuid vs person:）视为同一人，不重复计数', () => {
    const plan = planResponsibilityRecipients(
      [
        { deviceId: 'EXO-1', personId: 'p1', responsibility: 'owner' },
        { deviceId: 'EXO-1', personId: 'person:p1', responsibility: 'operator' },
      ],
      new Map([['p1', 'worker.zhangwei']]),
    );
    expect(plan.dedupedUserIds).toEqual(['worker.zhangwei']);
    expect(plan.unresolved).toEqual([]);
  });

  it('多职责共用同一账号 → 只发一条（不重复打扰）', () => {
    const plan = planResponsibilityRecipients([owner, operator], new Map([
      ['p1', 'lead.chen'],
      ['p2', 'lead.chen'],
    ]));
    expect(plan.dedupedUserIds).toEqual(['lead.chen']);
    expect(plan.users).toHaveLength(1);
  });

  it('**没有绑定账号 → 如实报缺口**（不假装通知到了）', () => {
    const plan = planResponsibilityRecipients([owner, operator], new Map([['p1', 'worker.zhangwei']]));
    expect(plan.dedupedUserIds).toEqual(['worker.zhangwei']);
    expect(plan.unresolved).toEqual([{ personId: 'person:p2', responsibility: 'operator' }]);
  });

  it('完全没有责任关系 → uncovered=true（提醒只能走角色兜底）', () => {
    const plan = planResponsibilityRecipients([], new Map());
    expect(plan).toMatchObject({ dedupedUserIds: [], unresolved: [], uncovered: true });
  });

  it('空人员 id 的行被忽略（脏数据不进收件人）', () => {
    const plan = planResponsibilityRecipients(
      [{ deviceId: 'EXO-1', personId: '   ', responsibility: 'owner' }],
      new Map([['', 'nobody']]),
    );
    expect(plan.dedupedUserIds).toEqual([]);
    expect(plan.unresolved).toEqual([]);
  });
});

/* ── NO-51a：班次维度（本班优先、全天兜底、他班只报缺口）──────────────── */

describe('planResponsibilityRecipients（班次维度）', () => {
  const aShift = { deviceId: 'EXO-1', personId: 'person:pA', responsibility: 'owner' as const, shiftId: 'SHIFT-A' };
  const bShift = { deviceId: 'EXO-1', personId: 'person:pB', responsibility: 'owner' as const, shiftId: 'SHIFT-B' };
  const allDay = { deviceId: 'EXO-1', personId: 'person:pAll', responsibility: 'maintainer' as const, shiftId: '' };

  it('本班责任人优先，并标明 matchedBy=current_shift', () => {
    const plan = planResponsibilityRecipients(
      [bShift, aShift],
      new Map([
        ['pA', 'worker.a'],
        ['pB', 'worker.b'],
      ]),
      { currentShiftId: 'SHIFT-A' },
    );
    expect(plan.dedupedUserIds).toEqual(['worker.a']);
    expect(plan.users[0]).toMatchObject({ matchedBy: 'current_shift', responsibility: 'owner' });
    // 别的班次的责任人**不发提醒**，但要报出来（现场要能发现"本班没人管"）
    expect(plan.outOfShift).toEqual([{ personId: 'person:pB', responsibility: 'owner', shiftId: 'SHIFT-B' }]);
    expect(plan.shiftId).toBe('SHIFT-A');
    expect(plan.shiftUnknown).toBe(false);
  });

  it('全天责任人兜底（不管当前班次是哪个），matchedBy=all_shift', () => {
    const plan = planResponsibilityRecipients([allDay], new Map([['pAll', 'lead.chen']]), {
      currentShiftId: 'SHIFT-A',
    });
    expect(plan.dedupedUserIds).toEqual(['lead.chen']);
    expect(plan.users[0]).toMatchObject({ matchedBy: 'all_shift' });
  });

  it('本班与全天并存 → 两个人都收（不同职责各有人）', () => {
    const plan = planResponsibilityRecipients(
      [aShift, allDay],
      new Map([
        ['pA', 'worker.a'],
        ['pAll', 'lead.chen'],
      ]),
      { currentShiftId: 'SHIFT-A' },
    );
    expect(plan.dedupedUserIds).toEqual(['lead.chen', 'worker.a']);
    expect(plan.users.map((u) => u.matchedBy).sort()).toEqual(['all_shift', 'current_shift']);
    expect(plan.outOfShift).toEqual([]);
  });

  it('当前班次未知（没有匹配到班次定义）→ 只按全天兜底并如实标注 shift_unknown', () => {
    const plan = planResponsibilityRecipients([aShift, allDay], new Map([
      ['pA', 'worker.a'],
      ['pAll', 'lead.chen'],
    ]), { currentShiftId: null });
    expect(plan.shiftId).toBeNull();
    expect(plan.shiftUnknown).toBe(true);
    expect(plan.dedupedUserIds).toEqual(['lead.chen']);
    expect(plan.users[0]).toMatchObject({ matchedBy: 'shift_unknown' });
    // 班次责任人在"班次未知"时不算本班，也不能悄悄当成责任人
    expect(plan.outOfShift.map((o) => o.personId)).toEqual(['person:pA']);
  });

  it('只有别的班次登记了责任人 → uncovered=true（本班确实没人负责，不是"有责任人"）', () => {
    const plan = planResponsibilityRecipients([bShift], new Map([['pB', 'worker.b']]), {
      currentShiftId: 'SHIFT-A',
    });
    expect(plan.dedupedUserIds).toEqual([]);
    expect(plan.uncovered).toBe(true);
    expect(plan.outOfShift).toHaveLength(1);
  });

  it('同一人同时是本班与全天责任人 → 只发一条（先到先得，标注本班）', () => {
    const plan = planResponsibilityRecipients(
      [
        { ...aShift, responsibility: 'operator' },
        { deviceId: 'EXO-1', personId: 'person:pA', responsibility: 'owner', shiftId: '' },
      ],
      new Map([['pA', 'worker.a']]),
      { currentShiftId: 'SHIFT-A' },
    );
    expect(plan.dedupedUserIds).toEqual(['worker.a']);
    expect(plan.users).toHaveLength(1);
    expect(plan.users[0]).toMatchObject({ matchedBy: 'current_shift', responsibility: 'operator' });
  });

  it('未传 currentShiftId（旧调用方）→ 行为与"全天责任人"一致（向后兼容）', () => {
    const plan = planResponsibilityRecipients([allDay], new Map([['pAll', 'lead.chen']]));
    expect(plan.dedupedUserIds).toEqual(['lead.chen']);
    expect(plan.shiftUnknown).toBe(true);
    expect(plan.users[0]).toMatchObject({ matchedBy: 'shift_unknown' });
  });
});

/* ── NO-52a：交接班前的责任人核对（覆盖率快照）────────────────────────── */

describe('summarizeResponsibilityCoverage', () => {
  const ownerAllDay = { deviceId: 'EXO-1', personId: 'person:pAll', responsibility: 'owner' as const, shiftId: '' };
  const ownerDay = { deviceId: 'EXO-1', personId: 'person:pDay', responsibility: 'owner' as const, shiftId: 'SHIFT-DAY' };
  const ownerNight = { deviceId: 'EXO-1', personId: 'person:pNight', responsibility: 'owner' as const, shiftId: 'SHIFT-NIGHT' };

  it('本班与全天都算覆盖；只有他班 → 缺口（现场要看到"本班没人"）', () => {
    const byDevice = new Map<string, Array<typeof ownerDay>>([
      ['EXO-1', [ownerDay]],
      ['EXO-2', [ownerAllDay]],
      ['EXO-3', [ownerNight]],
    ]);
    const snapshot = summarizeResponsibilityCoverage(byDevice as never, { shiftId: 'SHIFT-DAY' });
    expect(snapshot).toMatchObject({ shiftId: 'SHIFT-DAY', shiftUnknown: false, total: 3, covered: 2, gaps: 1 });
    // 缺口设备排在前面（页面第一眼看到要处理的）
    expect(snapshot.devices[0]?.deviceId).toBe('EXO-3');
    expect(snapshot.devices[0]).toMatchObject({ covered: false });
    expect(snapshot.devices[0]?.outOfShift.map((o) => o.shiftId)).toEqual(['SHIFT-NIGHT']);
    expect(snapshot.devices.find((d) => d.deviceId === 'EXO-2')?.holders[0]).toMatchObject({ matchedBy: 'all_shift' });
    expect(snapshot.devices.find((d) => d.deviceId === 'EXO-1')?.holders[0]).toMatchObject({ matchedBy: 'current_shift' });
  });

  it('班次未知 → 只按全天口径覆盖，且如实标注（不猜默认班）', () => {
    const byDevice = new Map<string, Array<typeof ownerDay | typeof ownerAllDay>>([
      ['EXO-1', [ownerDay]],
      ['EXO-2', [ownerAllDay]],
    ]);
    const snapshot = summarizeResponsibilityCoverage(byDevice as never, { shiftId: null });
    expect(snapshot.shiftUnknown).toBe(true);
    expect(snapshot.covered).toBe(1);
    expect(snapshot.gaps).toBe(1);
    expect(snapshot.notes.join('')).toContain('班次未知');
  });

  it('完全没有责任关系的设备单独计数（uncovered），不与"本班缺口"混为一谈', () => {
    const snapshot = summarizeResponsibilityCoverage(new Map(), {
      shiftId: 'SHIFT-DAY',
      uncoveredDeviceIds: ['CAM-1', 'CAM-2'],
    });
    expect(snapshot).toMatchObject({ total: 0, covered: 0, gaps: 0, uncovered: 2 });
    expect(snapshot.devices).toEqual([]);
  });

  it('同一设备多条责任关系：本班与全天都进 holders，他班进 outOfShift', () => {
    const byDevice = new Map<string, Array<typeof ownerDay>>([
      ['EXO-1', [ownerDay, ownerAllDay as never, ownerNight as never]],
    ]);
    const snapshot = summarizeResponsibilityCoverage(byDevice as never, { shiftId: 'SHIFT-DAY' });
    const device = snapshot.devices[0]!;
    expect(device.covered).toBe(true);
    expect(device.holders.map((h) => h.matchedBy).sort()).toEqual(['all_shift', 'current_shift']);
    expect(device.outOfShift.map((o) => o.personId)).toEqual(['person:pNight']);
  });

  it('口径说明逐条透出（页面直接展示，不在前端改写）', () => {
    const snapshot = summarizeResponsibilityCoverage(new Map(), { shiftId: 'SHIFT-DAY' });
    expect(snapshot.notes.length).toBeGreaterThanOrEqual(3);
    expect(snapshot.notes.join('')).toContain('不要求已绑定登录账号');
  });
});
