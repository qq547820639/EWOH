/* channel-dispatcher.service.spec.ts — 通知推送派发器（R-58/ADR-037 + R-62/ADR-041）。 */
import {
  buildLarkMessage,
  ChannelDispatcherService,
  dispatchIntervalMs,
  larkWebhookUrl,
} from '../../../server/modules/notification/channel-dispatcher.service';
import type { SmtpConnector } from '../../../server/modules/notification/email-transport';
import { ewohNotification } from '@server/database/schema';

const ORIGINAL_LARK_ENV = process.env.EWOH_LARK_WEBHOOK_URL;
const ORIGINAL_INTERVAL_ENV = process.env.EWOH_NOTIFICATION_DISPATCH_INTERVAL_MS;
const SMTP_KEYS = ['EWOH_SMTP_HOST', 'EWOH_SMTP_PORT', 'EWOH_SMTP_SECURE', 'EWOH_SMTP_USER', 'EWOH_SMTP_PASS', 'EWOH_SMTP_FROM', 'EWOH_SMTP_TO'];
const ORIGINAL_SMTP: Record<string, string | undefined> = {};
for (const key of SMTP_KEYS) ORIGINAL_SMTP[key] = process.env[key];

afterEach(() => {
  if (ORIGINAL_LARK_ENV === undefined) delete process.env.EWOH_LARK_WEBHOOK_URL;
  else process.env.EWOH_LARK_WEBHOOK_URL = ORIGINAL_LARK_ENV;
  if (ORIGINAL_INTERVAL_ENV === undefined) delete process.env.EWOH_NOTIFICATION_DISPATCH_INTERVAL_MS;
  else process.env.EWOH_NOTIFICATION_DISPATCH_INTERVAL_MS = ORIGINAL_INTERVAL_ENV;
  for (const key of SMTP_KEYS) {
    if (ORIGINAL_SMTP[key] === undefined) delete process.env[key];
    else process.env[key] = ORIGINAL_SMTP[key];
  }
});

function row(overrides: Record<string, unknown> = {}) {
  return {
    notificationId: 'NTF-1',
    channel: 'lark',
    status: 'pending',
    title: '安灯 线边缺料',
    body: '设备 EXO-1 安灯已开',
    severity: 'high',
    externalRef: 'ANDON-1',
    scheduledAt: null,
    createdAt: new Date('2026-08-16T08:00:00Z'),
    ...overrides,
  };
}

function makeDb(rows: unknown[], updates: Array<Record<string, unknown>>) {
  const returning = jest.fn() as jest.Mock;
  returning.mockResolvedValue(rows);
  const limit = jest.fn() as jest.Mock;
  limit.mockResolvedValue(rows);
  const orderBy = jest.fn(() => ({ limit })) as jest.Mock;
  const where = jest.fn(() => ({ orderBy })) as jest.Mock;
  const selectFrom = jest.fn(() => ({ where })) as jest.Mock;
  const updateReturning = jest.fn(async () => [{ notificationId: 'NTF-1' }]) as jest.Mock;
  const updateWhere = jest.fn(() => ({ returning: updateReturning })) as jest.Mock;
  const updateSet = jest.fn((setValues: Record<string, unknown>) => {
    updates.push(setValues);
    return { where: updateWhere };
  }) as jest.Mock;
  return {
    db: {
      select: jest.fn(() => ({ from: selectFrom })),
      update: jest.fn(() => ({ set: updateSet })),
    },
    spies: { returning, limit, orderBy, where, selectFrom, updateSet, updateWhere, updateReturning },
  };
}

describe('buildLarkMessage（纯函数）', () => {
  it('安灯事实渲染（title/deviceId/severity/body/externalRef）', () => {
    const message = buildLarkMessage({
      notificationId: 'NTF-1',
      title: '安灯 线边缺料',
      body: '设备 EXO-1 安灯已开',
      severity: 'high',
      externalRef: 'ANDON-1',
    });
    expect(message.msg_type).toBe('text');
    expect(message.content.text).toContain('【EWOH 通知】安灯 线边缺料');
    expect(message.content.text).toContain('严重度：high');
    expect(message.content.text).toContain('设备 EXO-1 安灯已开');
    expect(message.content.text).toContain('关联：ANDON-1');
  });
});

describe('env 配置读取', () => {
  it('未配置 webhook → null（渠道显式禁用）', () => {
    delete process.env.EWOH_LARK_WEBHOOK_URL;
    expect(larkWebhookUrl()).toBeNull();
  });

  it('配置 webhook → 返回去空白地址', () => {
    process.env.EWOH_LARK_WEBHOOK_URL = ' https://open.feishu.cn/hook/x ';
    expect(larkWebhookUrl()).toBe('https://open.feishu.cn/hook/x');
  });

  it('派发间隔：合法值生效，非法/缺失回退默认 15000', () => {
    process.env.EWOH_NOTIFICATION_DISPATCH_INTERVAL_MS = '3000';
    expect(dispatchIntervalMs()).toBe(3000);
    process.env.EWOH_NOTIFICATION_DISPATCH_INTERVAL_MS = '500';
    expect(dispatchIntervalMs()).toBe(15000);
    delete process.env.EWOH_NOTIFICATION_DISPATCH_INTERVAL_MS;
    expect(dispatchIntervalMs()).toBe(15000);
  });
});

describe('ChannelDispatcherService.dispatchPending', () => {
  it('未配置 webhook → 跳过（claimed=0，不投递不写库）', async () => {
    delete process.env.EWOH_LARK_WEBHOOK_URL;
    const updates: Array<Record<string, unknown>> = [];
    const { db } = makeDb([], updates);
    const transport = jest.fn();
    const service = new ChannelDispatcherService(db as never, transport);
    const summary = await service.dispatchPending();
    expect(summary).toEqual({ claimed: 0, sent: 0, failed: 0 });
    expect(transport).not.toHaveBeenCalled();
  });

  it('投递成功 → status=sent + sentAt + errorMessage 清空（CAS 命中）', async () => {
    process.env.EWOH_LARK_WEBHOOK_URL = 'https://hook/x';
    const updates: Array<Record<string, unknown>> = [];
    const { db } = makeDb([row()], updates);
    const transport = jest.fn(async (_message: unknown, url: string) => {
      expect(url).toBe('https://hook/x');
    });
    const service = new ChannelDispatcherService(db as never, transport);
    const summary = await service.dispatchPending();
    expect(summary).toEqual({ claimed: 1, sent: 1, failed: 0 });
    expect(updates[0]).toMatchObject({ status: 'sent', errorMessage: null });
    expect(updates[0].sentAt).toBeInstanceOf(Date);
  });

  it('投递失败 → status=failed + errorMessage 显式（§33 不静默吞异常）', async () => {
    process.env.EWOH_LARK_WEBHOOK_URL = 'https://hook/x';
    const updates: Array<Record<string, unknown>> = [];
    const { db } = makeDb([row()], updates);
    const transport = jest.fn(async () => {
      throw new Error('lark_webhook_http_500');
    });
    const service = new ChannelDispatcherService(db as never, transport);
    const summary = await service.dispatchPending();
    expect(summary).toEqual({ claimed: 1, sent: 0, failed: 1 });
    expect(updates[0]).toMatchObject({ status: 'failed', errorMessage: 'lark_webhook_http_500' });
  });

  it('CAS 未命中（他实例已投递）→ 不重复投递不计数 sent', async () => {
    process.env.EWOH_LARK_WEBHOOK_URL = 'https://hook/x';
    const updates: Array<Record<string, unknown>> = [];
    const { db, spies } = makeDb([row()], updates);
    spies.updateReturning.mockResolvedValue([]); // 0 rows = 已被他人 claim
    const transport = jest.fn().mockResolvedValue(undefined);
    const service = new ChannelDispatcherService(db as never, transport);
    const summary = await service.dispatchPending();
    expect(summary).toEqual({ claimed: 1, sent: 0, failed: 0 });
  });

  it('每行独立失败语义：一行失败不影响其余行投递', async () => {
    process.env.EWOH_LARK_WEBHOOK_URL = 'https://hook/x';
    const updates: Array<Record<string, unknown>> = [];
    const { db } = makeDb(
      [row({ notificationId: 'NTF-1' }), row({ notificationId: 'NTF-2' })],
      updates,
    );
    let call = 0;
    const transport = jest.fn(async () => {
      call += 1;
      if (call === 1) throw new Error('boom');
    });
    const service = new ChannelDispatcherService(db as never, transport);
    const summary = await service.dispatchPending();
    expect(summary).toEqual({ claimed: 2, sent: 1, failed: 1 });
    expect(updates.map((u) => u.status)).toEqual(['failed', 'sent']);
  });

  it('只领取已启用推送渠道且 status=pending 的通知（封闭渠道注册表）', async () => {
    process.env.EWOH_LARK_WEBHOOK_URL = 'https://hook/x';
    const updates: Array<Record<string, unknown>> = [];
    const { db, spies } = makeDb([], updates);
    const transport = jest.fn().mockResolvedValue(undefined);
    const service = new ChannelDispatcherService(db as never, transport);
    await service.dispatchPending();
    const whereCall = spies.where.mock.calls[0]?.[0];
    expect(whereCall).toBeDefined();
    expect(spies.selectFrom.mock.calls[0]?.[0]).toBe(ewohNotification);
  });

  it('R-62：email 渠道投递（注入 SMTP 连接器，lark 未配置仅 email 启用）', async () => {
    delete process.env.EWOH_LARK_WEBHOOK_URL;
    process.env.EWOH_SMTP_HOST = 'smtp.example.com';
    process.env.EWOH_SMTP_FROM = 'ewoh@factory.example';
    process.env.EWOH_SMTP_TO = 'lead@factory.example';
    const updates: Array<Record<string, unknown>> = [];
    const { db } = makeDb([row({ channel: 'email', notificationId: 'NTF-E1' })], updates);
    const connector: SmtpConnector = jest.fn(async () => {
      return {
        tlsActive: true,
        command: jest.fn(async (_cmd: string, allow: number[]) => allow[0]) as never,
        writeData: jest.fn(async () => undefined) as never,
        startTls: jest.fn(async () => undefined) as never,
        close: jest.fn(),
      };
    }) as unknown as SmtpConnector;
    const service = new ChannelDispatcherService(db as never, jest.fn(), connector);
    const summary = await service.dispatchPending();
    expect(summary).toEqual({ claimed: 1, sent: 1, failed: 0 });
    expect(connector).toHaveBeenCalled();
    expect(updates[0]).toMatchObject({ status: 'sent' });
  });

  it('R-62：email 未配置 → 渠道禁用（不领取 email 行）', async () => {
    delete process.env.EWOH_LARK_WEBHOOK_URL;
    delete process.env.EWOH_SMTP_HOST;
    const updates: Array<Record<string, unknown>> = [];
    const { db } = makeDb([row({ channel: 'email' })], updates);
    const connector = jest.fn() as unknown as SmtpConnector;
    const service = new ChannelDispatcherService(db as never, jest.fn(), connector);
    const summary = await service.dispatchPending();
    expect(summary).toEqual({ claimed: 0, sent: 0, failed: 0 });
    expect(connector).not.toHaveBeenCalled();
  });

  it('R-62：混合渠道逐行独立投递（lark 失败不影响 email 行）', async () => {
    process.env.EWOH_LARK_WEBHOOK_URL = 'https://hook/x';
    process.env.EWOH_SMTP_HOST = 'smtp.example.com';
    process.env.EWOH_SMTP_FROM = 'ewoh@factory.example';
    process.env.EWOH_SMTP_TO = 'lead@factory.example';
    const updates: Array<Record<string, unknown>> = [];
    const { db } = makeDb(
      [
        row({ channel: 'lark', notificationId: 'NTF-L1' }),
        row({ channel: 'email', notificationId: 'NTF-E1' }),
      ],
      updates,
    );
    const larkTransport = jest.fn(async () => {
      throw new Error('lark_webhook_http_500');
    });
    const connector: SmtpConnector = jest.fn(async () => ({
      tlsActive: true,
      command: jest.fn(async (_cmd: string, allow: number[]) => allow[0]) as never,
      writeData: jest.fn(async () => undefined) as never,
      startTls: jest.fn(async () => undefined) as never,
      close: jest.fn(),
    })) as unknown as SmtpConnector;
    const service = new ChannelDispatcherService(db as never, larkTransport, connector);
    const summary = await service.dispatchPending();
    expect(summary).toEqual({ claimed: 2, sent: 1, failed: 1 });
    expect(updates.map((u) => u.status)).toEqual(['failed', 'sent']);
  });

  it('in-process 防重叠：并发第二次调用直接跳过', async () => {
    process.env.EWOH_LARK_WEBHOOK_URL = 'https://hook/x';
    const updates: Array<Record<string, unknown>> = [];
    const { db, spies } = makeDb([row()], updates);
    let release: () => void = () => undefined;
    spies.limit.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = () => resolve([row()]);
        }),
    );
    const transport = jest.fn().mockResolvedValue(undefined);
    const service = new ChannelDispatcherService(db as never, transport);
    const first = service.dispatchPending();
    const second = await service.dispatchPending();
    expect(second).toEqual({ claimed: 0, sent: 0, failed: 0 });
    release();
    await first;
  });
});
