/* 安灯通知创建助手（NO-47a）。
 *
 * 钉死：确定性通知号（可幂等、可分类）、桶区分（开灯 vs SLA 升级）、
 * 渠道策略（app 恒发；lark/email 仅配置时）、租户作用域与主事实引用、
 * 以及"幂等键"语义（同一安灯 + 同一桶 + 同一渠道只提醒一次）。
 */
/// <reference types="jest" />
import { andonNotificationPrefix, insertAndonNotifications } from '../../../server/modules/notification/andon-notifications';
import { classifyNotificationKind } from '@shared/notification-metrics';

interface InsertEntry {
  table: unknown;
  row: Record<string, unknown>;
  conflictTarget?: unknown;
}

function createDb() {
  const inserts: InsertEntry[] = [];
  const db = {
    insert: (table: unknown) => ({
      values: (row: Record<string, unknown>) => ({
        onConflictDoNothing: (options?: { target?: unknown }) => {
          inserts.push({ table, row, ...(options ? { conflictTarget: options.target } : {}) });
          // NO-48a：助手按返回行数区分"新建"与"幂等跳过"，替身需提供 returning 链。
          return { returning: async () => [row] };
        },
      }),
    }),
  };
  return { db: db as never, inserts };
}

describe('andonNotificationPrefix', () => {
  it('前缀包含清洗后的安灯事件号（脏字符不进入幂等键）', () => {
    expect(andonNotificationPrefix('ANDON-1')).toBe('NTF-ANDON-ANDON-1-');
    expect(andonNotificationPrefix('ANDON:1/2 3')).toBe('NTF-ANDON-ANDON123-');
  });
});

describe('insertAndonNotifications', () => {
  const originalEnv = { ...process.env };
  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it('确定性通知号 + externalRef 指向安灯主事实 + 未配置渠道时不写 doomed 行', async () => {
    delete process.env.EWOH_LARK_WEBHOOK_URL;
    delete process.env.EWOH_SMTP_HOST;
    const { db, inserts } = createDb();

    await insertAndonNotifications(db, 'org-1', {
      recipients: [{ recipientType: 'role', recipientId: 'dispatcher' }],
      externalRef: 'ANDON-1',
      title: '安灯 线边缺料',
      body: '设备 EXO-1 安灯已开',
      severity: 'high',
    });

    expect(inserts).toHaveLength(1);
    expect(inserts[0]?.row).toMatchObject({
      orgId: 'org-1',
      notificationId: 'NTF-ANDON-ANDON-1-raised-role-dispatcher-app',
      channel: 'app',
      recipientType: 'role',
      recipientId: 'dispatcher',
      status: 'pending',
      externalRef: 'ANDON-1',
    });
    // 幂等键：ON CONFLICT DO NOTHING 指向通知号唯一约束
    expect(inserts[0]?.conflictTarget).toBeDefined();
    // 可分类：治理度量能把它归到"安灯异常"，而不是"其它"
    expect(classifyNotificationKind(String(inserts[0]?.row.notificationId))).toBe('andon');
  });

  it('SLA 升级桶与开灯桶分开：同一安灯的两条提醒互不覆盖', async () => {
    delete process.env.EWOH_LARK_WEBHOOK_URL;
    delete process.env.EWOH_SMTP_HOST;
    const { db, inserts } = createDb();

    await insertAndonNotifications(db, 'org-1', {
      recipients: [{ recipientType: 'role', recipientId: 'dispatcher' }],
      externalRef: 'ANDON-2',
      title: '安灯 线边缺料',
      body: '开灯',
      severity: 'high',
    });
    await insertAndonNotifications(db, 'org-1', {
      recipients: [{ recipientType: 'role', recipientId: 'dispatcher' }],
      externalRef: 'ANDON-2',
      title: '安灯SLA升级 线边缺料',
      body: '超过 SLA',
      severity: 'high',
      bucket: 'sla_escalation',
    });

    const ids = inserts.map((entry) => String(entry.row.notificationId));
    expect(ids).toEqual([
      'NTF-ANDON-ANDON-2-raised-role-dispatcher-app',
      'NTF-ANDON-ANDON-2-sla_escalation-role-dispatcher-app',
    ]);
    expect(new Set(ids).size).toBe(2);
  });

  it('配置了 lark/email 时按渠道各建一条（同一桶、不同渠道后缀）', async () => {
    process.env.EWOH_LARK_WEBHOOK_URL = 'https://hook/x';
    process.env.EWOH_SMTP_HOST = 'smtp.example.com';
    process.env.EWOH_SMTP_FROM = 'ewoh@factory.example';
    process.env.EWOH_SMTP_TO = 'lead@factory.example';
    const { db, inserts } = createDb();

    await insertAndonNotifications(db, 'org-1', {
      recipients: [{ recipientType: 'role', recipientId: 'dispatcher' }],
      externalRef: 'ANDON-3',
      title: '安灯 线边缺料',
      body: '开灯',
      severity: 'high',
    });

    expect(inserts.map((entry) => entry.row.channel).sort()).toEqual(['app', 'email', 'lark']);
    expect(inserts.map((entry) => String(entry.row.notificationId)).sort()).toEqual([
      'NTF-ANDON-ANDON-3-raised-role-dispatcher-app',
      'NTF-ANDON-ANDON-3-raised-role-dispatcher-email',
      'NTF-ANDON-ANDON-3-raised-role-dispatcher-lark',
    ]);
  });

  it('orgId 为 null 时不抛错（存量无租户行的兼容），但 externalRef 必须保留', async () => {
    delete process.env.EWOH_LARK_WEBHOOK_URL;
    delete process.env.EWOH_SMTP_HOST;
    const { db, inserts } = createDb();

    await insertAndonNotifications(db, null, {
      recipients: [{ recipientType: 'role', recipientId: 'dispatcher' }],
      externalRef: 'ANDON-4',
      title: '安灯',
      body: '开灯',
      severity: 'high',
    });

    expect(inserts[0]?.row.orgId).toBeNull();
    expect(inserts[0]?.row.externalRef).toBe('ANDON-4');
  });
});
