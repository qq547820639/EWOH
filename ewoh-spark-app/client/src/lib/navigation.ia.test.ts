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

  it('工厂运行台位于驾驶舱组首位（全局默认入口与导航一致）', () => {
    const cockpit = navGroups.find((group) => group.label === '驾驶舱');
    expect(cockpit?.items[0]?.to).toBe('/factory-operations');
    expect(cockpit?.items.some((item) => item.to === '/command-map')).toBe(true);
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

    it('管理角色直达工厂运行台', () => {
      expect(defaultLandingPath(['global_admin'])).toBe('/factory-operations');
    });

    it('班组长直达班次工作台（FE-2：工厂运行台的主查询不放行班组长，落地即 403）', () => {
      expect(defaultLandingPath(['workshop_lead'])).toBe('/shift-workbench');
    });

    it('只读访客直达实时风险（FE-2：viewer 的唯一只读落点，侧栏不再为空）', () => {
      expect(defaultLandingPath(['viewer'])).toBe('/reasoning');
      // 多角色时高级角色优先：viewer 只是兜底，不抢占一线/管理角色的任务域。
      expect(defaultLandingPath(['worker', 'viewer'])).toBe('/mobile-workbench');
    });

    it('其余管理角色与无角色均回退工厂运行台', () => {
      expect(defaultLandingPath(['safety_admin'])).toBe('/factory-operations');
      expect(defaultLandingPath(['dispatcher'])).toBe('/factory-operations');
      expect(defaultLandingPath([])).toBe('/factory-operations');
      expect(defaultLandingPath(null)).toBe('/factory-operations');
    });
  });

  it('global_admin 视角各组合计仍不超过 6 组（信息密度回归锚点）', () => {
    const groups = getVisibleNavGroups(['global_admin']);
    expect(groups.length).toBeLessThanOrEqual(6);
  });
});
