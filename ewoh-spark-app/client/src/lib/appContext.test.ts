import {
  APP_CONTEXT_STORAGE_KEY,
  APP_VERSION,
  DEFAULT_APP_CONTEXT,
  FAVORITES_STORAGE_KEY,
  MAX_RECENT,
  RECENT_ACCESS_STORAGE_KEY,
  clearRecentAccess,
  formatDataFreshness,
  isFavorite,
  readAppContext,
  readFavorites,
  readRecentAccess,
  recordRecentAccess,
  resolveBreadcrumb,
  resolveNavLabel,
  toggleFavorite,
  writeAppContext,
  type AppContextStorage,
} from './appContext';

function createMemoryStorage(): AppContextStorage {
  const map = new Map<string, string>();
  return {
    getItem: (key) => map.get(key) ?? null,
    setItem: (key, value) => map.set(key, value),
    removeItem: (key) => map.delete(key),
  };
}

describe('appContext 上下文读写', () => {
  it('无存储时返回默认上下文', () => {
    const storage = createMemoryStorage();
    expect(readAppContext(storage)).toEqual(DEFAULT_APP_CONTEXT);
  });

  it('写入后可读回，损坏数据回退默认值', () => {
    const storage = createMemoryStorage();
    writeAppContext({ ...DEFAULT_APP_CONTEXT, orgId: 'org-2', env: 'staging' }, storage);
    const read = readAppContext(storage);
    expect(read.orgId).toBe('org-2');
    expect(read.env).toBe('staging');

    storage.setItem(APP_CONTEXT_STORAGE_KEY, '{not-json');
    expect(readAppContext(storage)).toEqual(DEFAULT_APP_CONTEXT);
  });

  it('版本号与默认组织/环境符合约定', () => {
    expect(APP_VERSION).toBe('0.6.0-rc4');
    expect(DEFAULT_APP_CONTEXT.orgId).toBe('default-factory');
    expect(DEFAULT_APP_CONTEXT.env).toBe('production');
  });
});

describe('最近访问', () => {
  it('记录去重并置顶', () => {
    const storage = createMemoryStorage();
    recordRecentAccess('/a', 'A', storage);
    recordRecentAccess('/b', 'B', storage);
    recordRecentAccess('/a', 'A', storage);
    const entries = readRecentAccess(storage);
    expect(entries.map((e) => e.path)).toEqual(['/a', '/b']);
  });

  it('截断到 MAX_RECENT', () => {
    const storage = createMemoryStorage();
    for (let i = 0; i < MAX_RECENT + 3; i += 1) {
      recordRecentAccess(`/p${i}`, `P${i}`, storage);
    }
    expect(readRecentAccess(storage)).toHaveLength(MAX_RECENT);
  });

  it('清空最近访问', () => {
    const storage = createMemoryStorage();
    recordRecentAccess('/a', 'A', storage);
    clearRecentAccess(storage);
    expect(storage.getItem(RECENT_ACCESS_STORAGE_KEY)).toBeNull();
  });
});

describe('收藏视图', () => {
  it('切换收藏状态并持久化', () => {
    const storage = createMemoryStorage();
    expect(isFavorite('/devices', storage)).toBe(false);
    const first = toggleFavorite('/devices', storage);
    expect(first.isFavorite).toBe(true);
    expect(first.favorites).toContain('/devices');
    expect(isFavorite('/devices', storage)).toBe(true);

    const second = toggleFavorite('/devices', storage);
    expect(second.isFavorite).toBe(false);
    expect(second.favorites).not.toContain('/devices');
  });

  it('损坏的收藏数据回退为空数组', () => {
    const storage = createMemoryStorage();
    storage.setItem(FAVORITES_STORAGE_KEY, '[]');
    expect(readFavorites(storage)).toEqual([]);
  });
});

describe('面包屑与路由映射', () => {
  it('反向映射已知路由为分组 + 页面', () => {
    const crumbs = resolveBreadcrumb('/devices');
    expect(crumbs.map((c) => c.label)).toEqual(['态势感知', '设备中心']);
    expect(crumbs[crumbs.length - 1].to).toBe('/devices');
  });

  it('未知路由回退为首页', () => {
    const crumbs = resolveBreadcrumb('/unknown');
    expect(crumbs).toEqual([{ label: '首页', to: '/command-center' }]);
  });

  it('resolveNavLabel 返回页面名或 null', () => {
    expect(resolveNavLabel('/alerts')).toBe('风险告警');
    expect(resolveNavLabel('/nope')).toBeNull();
  });
});

describe('数据新鲜度格式化', () => {
  it('刚更新返回「刚刚」、非法时间返回「未知」', () => {
    expect(formatDataFreshness(new Date().toISOString())).toBe('刚刚');
    expect(formatDataFreshness('not-a-date')).toBe('未知');
  });
});