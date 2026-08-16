/* email-transport.spec.ts — 邮件推送渠道协议层（R-62 / ADR-041）。 */
import {
  buildEmailMessage,
  emailConfig,
  isEmailPushEnabled,
  sendEmail,
  type EmailConfig,
  type SmtpConnection,
} from '../../../server/modules/notification/email-transport';

const SMTP_ENV_KEYS = [
  'EWOH_SMTP_HOST', 'EWOH_SMTP_PORT', 'EWOH_SMTP_SECURE',
  'EWOH_SMTP_USER', 'EWOH_SMTP_PASS', 'EWOH_SMTP_FROM', 'EWOH_SMTP_TO',
] as const;

const ORIGINAL_ENV: Record<string, string | undefined> = {};
for (const key of SMTP_ENV_KEYS) ORIGINAL_ENV[key] = process.env[key];

afterEach(() => {
  for (const key of SMTP_ENV_KEYS) {
    if (ORIGINAL_ENV[key] === undefined) delete process.env[key];
    else process.env[key] = ORIGINAL_ENV[key];
  }
});

function fakeConnection(options: { startTlsFlips?: boolean } = {}): {
  conn: SmtpConnection;
  calls: string[];
  data: string[];
} {
  const calls: string[] = [];
  const data: string[] = [];
  const conn: SmtpConnection = {
    tlsActive: false,
    command: jest.fn(async (cmd: string, allow: number[]) => {
      calls.push(cmd);
      return allow[0]; // 回放第一个允许码（服务器正常应答）
    }) as unknown as SmtpConnection['command'],
    writeData: jest.fn(async (line: string) => {
      data.push(line);
    }) as unknown as SmtpConnection['writeData'],
    startTls: jest.fn(async () => {
      if (options.startTlsFlips) {
        (conn as { tlsActive: boolean }).tlsActive = true;
      }
    }) as unknown as SmtpConnection['startTls'],
    close: jest.fn(),
  };
  return { conn, calls, data };
}

const CONFIG: EmailConfig = {
  host: 'smtp.example.com',
  port: 587,
  secure: false,
  user: null,
  pass: null,
  from: 'ewoh@factory.example',
  to: ['lead@factory.example'],
};

describe('emailConfig / isEmailPushEnabled（配置解析）', () => {
  it('host/from/to 任一缺失 → 渠道显式禁用（null）', () => {
    delete process.env.EWOH_SMTP_HOST;
    delete process.env.EWOH_SMTP_FROM;
    delete process.env.EWOH_SMTP_TO;
    expect(emailConfig()).toBeNull();
    expect(isEmailPushEnabled()).toBe(false);
  });

  it('完整配置 → 解析（port 缺省 587；secure/凭据可选）', () => {
    process.env.EWOH_SMTP_HOST = 'smtp.example.com';
    process.env.EWOH_SMTP_FROM = 'ewoh@factory.example';
    process.env.EWOH_SMTP_TO = 'a@x.com, b@x.com ';
    delete process.env.EWOH_SMTP_PORT;
    delete process.env.EWOH_SMTP_SECURE;
    const config = emailConfig();
    expect(config).not.toBeNull();
    expect(config?.port).toBe(587);
    expect(config?.secure).toBe(false);
    expect(config?.to).toEqual(['a@x.com', 'b@x.com']);
    expect(isEmailPushEnabled()).toBe(true);
  });

  it('secure=true + 凭据 → 隐式 TLS 形态（AUTH 可用）', () => {
    process.env.EWOH_SMTP_HOST = 'smtp.example.com';
    process.env.EWOH_SMTP_FROM = 'ewoh@factory.example';
    process.env.EWOH_SMTP_TO = 'a@x.com';
    process.env.EWOH_SMTP_SECURE = 'true';
    process.env.EWOH_SMTP_USER = 'ewoh';
    process.env.EWOH_SMTP_PASS = 'secret';
    const config = emailConfig();
    expect(config?.secure).toBe(true);
    expect(config?.user).toBe('ewoh');
  });

  it('非法 port → 禁用（fail-closed 不猜）', () => {
    process.env.EWOH_SMTP_HOST = 'smtp.example.com';
    process.env.EWOH_SMTP_FROM = 'ewoh@factory.example';
    process.env.EWOH_SMTP_TO = 'a@x.com';
    process.env.EWOH_SMTP_PORT = 'not-a-port';
    expect(emailConfig()).toBeNull();
  });
});

describe('buildEmailMessage（纯函数）', () => {
  it('通知事实渲染（subject/body/severity/externalRef）', () => {
    const message = buildEmailMessage({
      notificationId: 'NTF-1',
      title: '安灯 线边缺料',
      body: '设备 device:exo-1 安灯已开',
      severity: 'high',
      externalRef: 'ANDON-1',
    }, CONFIG);
    expect(message.subject).toBe('[EWOH] 安灯 线边缺料');
    expect(message.from).toBe('ewoh@factory.example');
    expect(message.to).toEqual(['lead@factory.example']);
    expect(message.text).toContain('【EWOH 通知】安灯 线边缺料');
    expect(message.text).toContain('严重度：high');
    expect(message.text).toContain('关联：ANDON-1');
  });
});

describe('sendEmail（SMTP 会话协议）', () => {
  it('无凭据投递：EHLO → MAIL → RCPT* → DATA → 正文 → QUIT', async () => {
    const { conn, calls, data } = fakeConnection();
    await sendEmail(CONFIG, buildEmailMessage({
      notificationId: 'NTF-1', title: '安灯', body: 'body', severity: 'high', externalRef: null,
    }, CONFIG), async () => conn);
    expect(calls[0]).toBe('EHLO ewoh-notifier');
    expect(calls[1]).toBe('MAIL FROM:<ewoh@factory.example>');
    expect(calls[2]).toBe('RCPT TO:<lead@factory.example>');
    expect(calls[3]).toBe('DATA');
    expect(data).toContain('Subject: [EWOH] 安灯');
    expect(data).toContain('【EWOH 通知】安灯');
    expect(data[data.length - 1]).toBe('.');
    expect(calls[calls.length - 1]).toBe('QUIT');
  });

  it('带凭据 + 隐式 TLS 连接 → AUTH LOGIN 序列（base64 凭据，无 STARTTLS）', async () => {
    const { conn, calls } = fakeConnection();
    (conn as { tlsActive: boolean }).tlsActive = true;
    const authConfig = { ...CONFIG, secure: true, user: 'ewoh', pass: 'secret' };
    await sendEmail(authConfig, buildEmailMessage({
      notificationId: 'NTF-1', title: '安灯', body: null, severity: 'high', externalRef: null,
    }, authConfig), async () => conn);
    expect(calls[1]).toBe('AUTH LOGIN');
    expect(calls[2]).toBe(Buffer.from('ewoh').toString('base64'));
    expect(calls[3]).toBe(Buffer.from('secret').toString('base64'));
    expect(calls[4]).toBe('MAIL FROM:<ewoh@factory.example>');
  });

  it('带凭据 + 服务器不支持 STARTTLS → 显式 smtp_auth_requires_tls（绝不明文传凭据）', async () => {
    const { conn, calls } = fakeConnection();
    (conn.command as jest.Mock).mockImplementation(async (cmd: string, allow: number[]) => {
      calls.push(cmd);
      if (cmd === 'STARTTLS') throw new Error('smtp_rejected_502');
      return allow[0];
    });
    const authConfig = { ...CONFIG, user: 'ewoh', pass: 'secret' };
    await expect(sendEmail(authConfig, buildEmailMessage({
      notificationId: 'NTF-1', title: '安灯', body: null, severity: 'high', externalRef: null,
    }, authConfig), async () => conn)).rejects.toThrow('smtp_auth_requires_tls');
    expect(calls).not.toContain('AUTH LOGIN');
  });

  it('带凭据 + STARTTLS 升级成功 → 重新 EHLO 后 AUTH LOGIN（ADR-046）', async () => {
    const { conn, calls } = fakeConnection({ startTlsFlips: true });
    const authConfig = { ...CONFIG, user: 'ewoh', pass: 'secret' };
    await sendEmail(authConfig, buildEmailMessage({
      notificationId: 'NTF-1', title: '安灯', body: null, severity: 'high', externalRef: null,
    }, authConfig), async () => conn);
    expect(calls[0]).toBe('EHLO ewoh-notifier');
    expect(calls[1]).toBe('STARTTLS');
    expect(calls[2]).toBe('EHLO ewoh-notifier'); // 升级后重新 EHLO
    expect(calls[3]).toBe('AUTH LOGIN');
    expect(calls[4]).toBe(Buffer.from('ewoh').toString('base64'));
  });

  it('无凭据明文 → 不尝试 STARTTLS（内网中继合法路径不变）', async () => {
    const { conn, calls } = fakeConnection();
    await sendEmail(CONFIG, buildEmailMessage({
      notificationId: 'NTF-1', title: '安灯', body: null, severity: 'high', externalRef: null,
    }, CONFIG), async () => conn);
    expect(calls).not.toContain('STARTTLS');
    expect(calls[0]).toBe('EHLO ewoh-notifier');
    expect(calls[1]).toBe('MAIL FROM:<ewoh@factory.example>');
  });

  it('SMTP 拒绝（RCPT 550）→ smtp_rejected_550 显式抛错', async () => {
    const { conn } = fakeConnection();
    const original = conn.command as jest.Mock;
    original.mockImplementation(async (cmd: string, allow: number[]) => {
      if (cmd.startsWith('RCPT')) throw new Error('smtp_rejected_550');
      return 250;
    });
    await expect(sendEmail(CONFIG, buildEmailMessage({
      notificationId: 'NTF-1', title: '安灯', body: null, severity: 'high', externalRef: null,
    }, CONFIG), async () => conn)).rejects.toThrow('smtp_rejected_550');
  });

  it('正文行首 . 转义（SMTP dot-stuffing）', async () => {
    const { conn, data } = fakeConnection();
    await sendEmail(CONFIG, buildEmailMessage({
      notificationId: 'NTF-1', title: '安灯', body: '.hidden', severity: 'high', externalRef: null,
    }, CONFIG), async () => conn);
    expect(data).toContain('..hidden');
  });
});
