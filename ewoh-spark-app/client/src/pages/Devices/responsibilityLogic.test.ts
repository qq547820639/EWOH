/* 设备责任人展示口径（NO-50a）纯函数测试。 */
/// <reference types="jest" />
import {
  buildDeviceResponsibilityView,
  buildResponsibilityViews,
  responsibilityLabel,
  uncoveredView,
} from './responsibilityLogic';
import type { DeviceResponsibilityRecord } from '@client/src/api/deviceResponsibility';

const fact = (overrides: Partial<DeviceResponsibilityRecord> = {}): DeviceResponsibilityRecord => ({
  deviceId: 'EXO-1',
  personId: 'person:p1',
  responsibility: 'owner',
  shiftId: '',
  active: true,
  note: null,
  activatedAt: '2026-09-12T00:00:00.000Z',
  deactivatedAt: null,
  ...overrides,
});

describe('responsibilityLabel', () => {
  it('三种职责有中文文案；未登记值原样透出', () => {
    expect(responsibilityLabel('owner')).toBe('设备责任人');
    expect(responsibilityLabel('operator')).toBe('操作责任人');
    expect(responsibilityLabel('maintainer')).toBe('维护责任人');
    expect(responsibilityLabel('chief')).toBe('chief');
  });
});

describe('buildDeviceResponsibilityView', () => {
  it('三种职责按固定顺序展示，空位保留（班组长要看得出哪个职责空着）', () => {
    const view = buildDeviceResponsibilityView('EXO-1', [fact()], new Map([['p1', '张三']]));
    expect(view.slots.map((s) => s.kind)).toEqual(['owner', 'operator', 'maintainer']);
    expect(view.slots[0]).toMatchObject({ personLabel: '张三（p1）', label: '设备责任人' });
    expect(view.slots[1]).toMatchObject({ personLabel: null, personId: null });
    expect(view.covered).toBe(1);
    expect(view.missing).toBe(2);
    expect(view.needsAttention).toBe(true);
    expect(view.uncovered).toBe(false);
  });

  it('解析不到姓名 → 显示人员 id（不猜名字）', () => {
    const view = buildDeviceResponsibilityView('EXO-1', [fact({ personId: 'person:unknown-9' })]);
    expect(view.slots[0]?.personLabel).toBe('unknown-9');
  });

  it('一条责任人 → "姓名（职责）"；多条 → "…等 N 项"', () => {
    const one = buildDeviceResponsibilityView('EXO-1', [fact()], new Map([['p1', '张三']]));
    expect(one.summaryLabel).toBe('张三（p1）（设备责任人）');
    const two = buildDeviceResponsibilityView(
      'EXO-1',
      [fact(), fact({ personId: 'person:p2', responsibility: 'operator' })],
      new Map([
        ['p1', '张三'],
        ['p2', '李四'],
      ]),
    );
    expect(two.summaryLabel).toBe('张三（p1）（设备责任人）等 2 项');
    expect(two.covered).toBe(2);
    expect(two.needsAttention).toBe(true);
  });

  it('完全没有责任人 → 明说"未登记责任人（提醒只能发到角色）"且 uncovered=true', () => {
    const view = buildDeviceResponsibilityView('EXO-1', []);
    expect(view.summaryLabel).toContain('未登记责任人');
    expect(view.summaryLabel).toContain('只能发到角色');
    expect(view.uncovered).toBe(true);
    expect(view.missing).toBe(3);
  });

  it('三条都登记 → 不再提示缺失', () => {
    const view = buildDeviceResponsibilityView(
      'EXO-1',
      [
        fact(),
        fact({ personId: 'p2', responsibility: 'operator' }),
        fact({ personId: 'p3', responsibility: 'maintainer' }),
      ],
      new Map([
        ['p1', '张三'],
        ['p2', '李四'],
        ['p3', '王五'],
      ]),
    );
    expect(view.covered).toBe(3);
    expect(view.missing).toBe(0);
    expect(view.needsAttention).toBe(false);
  });

  it('忽略已停用行与未登记职责（脏数据不进展示）', () => {
    const view = buildDeviceResponsibilityView('EXO-1', [
      fact({ active: false }),
      fact({ responsibility: 'chief' as never, personId: 'p9' }),
      fact({ personId: 'p1', responsibility: 'owner' }),
    ], new Map([['p1', '张三']]));
    expect(view.covered).toBe(1);
    expect(view.slots[0]?.personLabel).toBe('张三（p1）');
  });
});

describe('buildResponsibilityViews / uncoveredView', () => {
  it('按设备分组：一台设备多条职责聚合到同一视图', () => {
    const views = buildResponsibilityViews(
      [
        fact({ deviceId: 'EXO-1' }),
        fact({ deviceId: 'EXO-1', personId: 'p2', responsibility: 'operator' }),
        fact({ deviceId: 'ENV-1', personId: 'p3', responsibility: 'maintainer' }),
      ],
      new Map([
        ['p1', '张三'],
        ['p2', '李四'],
        ['p3', '王五'],
      ]),
    );
    expect(views.get('EXO-1')?.covered).toBe(2);
    expect(views.get('ENV-1')?.covered).toBe(1);
    expect(views.get('ENV-1')?.slots[2]?.personLabel).toBe('王五（p3）');
  });

  it('没有责任关系的设备用 uncoveredView（表格统一渲染"未登记"）', () => {
    expect(uncoveredView('CAM-1')).toMatchObject({ deviceId: 'CAM-1', covered: 0, uncovered: true });
  });
});

describe('班次维度展示（NO-51a）', () => {
  it('全天责任人显示"全天"；班次责任人显示"班次 <id>"', () => {
    const view = buildDeviceResponsibilityView(
      'EXO-1',
      [
        fact({ responsibility: 'owner', shiftId: '' }),
        fact({ personId: 'person:p2', responsibility: 'operator', shiftId: 'SHIFT-NIGHT' }),
      ],
      new Map([
        ['p1', '张三'],
        ['p2', '李四'],
      ]),
    );
    expect(view.slots[0]?.shiftLabel).toBe('全天');
    expect(view.slots[1]?.shiftLabel).toBe('班次 SHIFT-NIGHT');
    // 汇总里只有"班次维度"非全天的那条才带班次后缀（全天不加噪）
    expect(view.summaryLabel).toContain('设备责任人');
    expect(view.summaryLabel).not.toContain('全天');
  });

  it('单条班次责任人 → 汇总带班次标签（现场要知道这人是哪个班的）', () => {
    const view = buildDeviceResponsibilityView(
      'EXO-1',
      [fact({ responsibility: 'owner', shiftId: 'SHIFT-NIGHT' })],
      new Map([['p1', '张三']]),
    );
    expect(view.summaryLabel).toContain('班次 SHIFT-NIGHT');
  });
});
