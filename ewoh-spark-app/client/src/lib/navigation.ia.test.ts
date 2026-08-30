import { defaultLandingPath, getVisibleNavGroups, navGroups, pageFunctionEntries } from './navigation';

describe('navigation IA（UX-IA-2026-08）', () => {
  it('采用 5 组任务域结构且组名不重复', () => {
    const labels = navGroups.map((group) => group.label);
    expect(labels).toEqual([
      '驾驶舱',
      '调度与执行',
      '作业现场',
      '资源与资产',
      '仿真与治理',
    ]);
    expect(new Set(labels).size).toBe(labels.length);
  });

  it('单组条目不超过 6（Miller 7±2 上界）', () => {
    const oversized = navGroups
      .filter((group) => group.items.length > 6)
      .map((group) => `${group.label}:${group.items.length} 项`);
    expect(oversized).toEqual([]);
  });

  it('组名与组内项不重名（历史缺陷回归锚点）', () => {
    const duplicates: string[] = [];
    for (const group of navGroups) {
      for (const item of group.items) {
        if (item.label === group.label) {
          duplicates.push(`${group.label} → ${item.label}`);
        }
      }
    }
    expect(duplicates).toEqual([]);
  });

  it('指挥地图位于驾驶舱组首位（全角色核心入口不再埋入基础设施）', () => {
    const cockpit = navGroups.find((group) => group.label === '驾驶舱');
    expect(cockpit?.items[0]?.to).toBe('/command-map');
    const infra = navGroups.find((group) => group.label === '基础设施');
    expect(infra).toBeUndefined();
  });

  it('权限矩阵保持重构前不变（关键路径抽查）', () => {
    const paths = navGroups.flatMap((group) => group.items.map((item) => item.to));
    const required = [
      '/command-center',
      '/mobile-workbench',
      '/operations',
      '/scale',
      '/scheduling',
      '/alerts',
    ];
    const missing = required.filter((path) => !paths.includes(path));
    expect(missing).toEqual([]);
  });

  it('页面内功能直达条目均为真实导航项且目标页面存在', () => {
    const paths = new Set(navGroups.flatMap((group) => group.items.map((item) => item.to)));
    const dangling = pageFunctionEntries
      .filter((entry) => !paths.has(entry.to.split('?')[0]))
      .map((entry) => `${entry.label} → ${entry.to}`);
    expect(dangling).toEqual([]);
  });

  describe('defaultLandingPath 按角色分流', () => {
    it('一线作业角色直达移动工作台', () => {
      expect(defaultLandingPath(['worker'])).toBe('/mobile-workbench');
      expect(defaultLandingPath(['device_ops'])).toBe('/mobile-workbench');
    });

    it('管理角色直达指挥地图', () => {
      expect(defaultLandingPath(['global_admin'])).toBe('/command-map');
      expect(defaultLandingPath(['workshop_lead'])).toBe('/command-map');
    });

    it('其余角色回退指挥中心；无角色安全回退', () => {
      expect(defaultLandingPath(['safety_admin'])).toBe('/command-center');
      expect(defaultLandingPath(['dispatcher'])).toBe('/command-center');
      expect(defaultLandingPath([])).toBe('/command-center');
      expect(defaultLandingPath(null)).toBe('/command-center');
    });
  });

  it('global_admin 视角各组合计仍不超过 6 组（信息密度回归锚点）', () => {
    const groups = getVisibleNavGroups(['global_admin']);
    expect(groups.length).toBeLessThanOrEqual(6);
  });
});
