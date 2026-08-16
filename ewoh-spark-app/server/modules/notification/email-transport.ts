// email-transport.ts — 邮件推送渠道（R-62 / ADR-041，andon-loop 收口，§20）。
//
// 标准库最小 SMTP 客户端（RFC 5321 子集：EHLO / AUTH LOGIN / MAIL FROM /
// RCPT TO / DATA / QUIT，无新依赖）——真实投递实现，非 mock。
// 传输形态 v2（ADR-046）：无凭据 = 明文（内网中继）；带凭据 =
// 优先 STARTTLS 升级（587 常用）——服务器不支持 STARTTLS 且带凭据 →
// 显式 smtp_auth_requires_tls（绝不明文传凭据）；secure=true = 隐式
// TLS（465）直连。AUTH LOGIN 仅在 TLS 保护下发送。
//
// 语义边界（§33/§20 对齐）：
// - 未配置（EWOH_SMTP_HOST/FROM/TO 任一缺失）→ 邮件渠道显式禁用
//   （isEmailPushEnabled=false，不建 doomed 行）；
// - 凭据安全 fail-closed：AUTH 仅在 TLS（STARTTLS 成功或隐式 TLS）后发送；
//   无 TLS 且带凭据 → 显式错误 smtp_auth_requires_tls（绝不明文传凭据）；
// - SMTP 拒绝（5xx）→ 显式抛错（smtp_rejected_<code>），派发器写 failed +
//   errorMessage；人工重试走既有 retry 端点；
// - 投递状态仍落权威通知行（pending→sent/failed，CAS）——本文件只管
//   协议层，不碰状态。
import { connect as tlsConnect, type TLSSocket } from 'node:tls';
import { connect as netConnect, type Socket } from 'node:net';

export interface EmailConfig {
  host: string;
  port: number;
  /** 隐式 TLS（465 端口常用）；false = 明文连接 + 机会式 STARTTLS。 */
  secure: boolean;
  user: string | null;
  pass: string | null;
  from: string;
  to: string[];
}

/** SMTP 会话连接（真实实现见 realSmtpConnector；测试注入 fake 锁定协议序）。 */
export interface SmtpConnection {
  /** 发送命令（自动补 CRLF）并读取回复；返回状态码；期望码不符 → 抛错。 */
  command(cmd: string, allowCodes: number[]): Promise<number>;
  /** 原始数据行（DATA 内容，无协议层校验）。 */
  writeData(line: string): Promise<void>;
  /** 是否处于 TLS 保护之下（STARTTLS 成功或隐式 TLS）。 */
  tlsActive: boolean;
  /** STARTTLS 升级（服务器已回 220 后调用）；升级失败 → 显式抛错。 */
  startTls(): Promise<void>;
  close(): void;
}

export interface SmtpConnector {
  (config: EmailConfig): Promise<SmtpConnection>;
}

export const SMTP_TIMEOUT_MS = 10_000;

export function emailConfig(): EmailConfig | null {
  const host = (process.env.EWOH_SMTP_HOST ?? '').trim();
  const rawPort = (process.env.EWOH_SMTP_PORT ?? '').trim();
  const port = rawPort === '' ? 587 : Number(rawPort);
  const secure = (process.env.EWOH_SMTP_SECURE ?? '').trim() === '1' ||
    (process.env.EWOH_SMTP_SECURE ?? '').trim().toLowerCase() === 'true';
  const user = (process.env.EWOH_SMTP_USER ?? '').trim() || null;
  const pass = (process.env.EWOH_SMTP_PASS ?? '').trim() || null;
  const from = (process.env.EWOH_SMTP_FROM ?? '').trim();
  const to = (process.env.EWOH_SMTP_TO ?? '')
    .split(',')
    .map((r) => r.trim())
    .filter((r) => r !== '');
  if (!host || !from || to.length === 0) return null;
  if (!Number.isInteger(port) || port < 1 || port > 65535) return null;
  return { host, port, secure, user, pass, from, to };
}

export function isEmailPushEnabled(): boolean {
  return emailConfig() != null;
}

export interface EmailMessage {
  from: string;
  to: string[];
  subject: string;
  text: string;
}

export interface NotificationLike {
  notificationId: string;
  title: string;
  body: string | null;
  severity: string;
  externalRef: string | null;
  deviceId?: string | null;
}

/** 邮件消息体（纯函数，node 可测）：通知事实渲染，无 LLM 编造。 */
export function buildEmailMessage(
  notification: NotificationLike,
  config: EmailConfig,
): EmailMessage {
  const lines = [`【EWOH 通知】${notification.title}`];
  if (notification.deviceId) lines.push(`设备：${notification.deviceId}`);
  lines.push(`严重度：${notification.severity}`);
  if (notification.body) lines.push(notification.body);
  if (notification.externalRef) lines.push(`关联：${notification.externalRef}`);
  return {
    from: config.from,
    to: config.to,
    subject: `[EWOH] ${notification.title}`,
    text: lines.join('\n'),
  };
}

/**
 * SMTP 投递会话（RFC 5321 子集）：
 * greeting → EHLO →（凭据 + 明文 → STARTTLS 升级 → 重新 EHLO；升级
 * 失败且带凭据 → smtp_auth_requires_tls 显式）→（凭据时 AUTH LOGIN，
 * 仅 TLS 后）→ MAIL FROM → 逐个 RCPT TO → DATA → 正文+CRLF.CRLF →
 * QUIT。无凭据明文投递（内网中继）合法。
 * 任何 5xx → smtp_rejected_<code> 显式抛错（§33 不静默）。
 */
export async function sendEmail(
  config: EmailConfig,
  message: EmailMessage,
  connector: SmtpConnector = realSmtpConnector,
): Promise<void> {
  const conn = await connector(config);
  try {
    await conn.command(`EHLO ewoh-notifier`, [250]);
    if (config.user && !conn.tlsActive) {
      // ADR-046：机会式 STARTTLS（587 常用）——服务器不支持/升级失败 →
      // 显式 smtp_auth_requires_tls（绝不明文传凭据，§33）。
      try {
        await conn.command('STARTTLS', [220]);
        await conn.startTls();
        await conn.command(`EHLO ewoh-notifier`, [250]);
      } catch (error) {
        throw new Error(
          error instanceof Error && error.message === 'smtp_rejected_502'
            ? 'smtp_auth_requires_tls'
            : `smtp_starttls_failed:${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
    if (config.user) {
      if (!conn.tlsActive) {
        throw new Error('smtp_auth_requires_tls');
      }
      await conn.command('AUTH LOGIN', [334]);
      await conn.command(Buffer.from(config.user).toString('base64'), [334]);
      await conn.command(Buffer.from(config.pass ?? '').toString('base64'), [235]);
    }
    await conn.command(`MAIL FROM:<${message.from}>`, [250]);
    for (const rcpt of message.to) {
      await conn.command(`RCPT TO:<${rcpt}>`, [250, 251]);
    }
    await conn.command('DATA', [354]);
    const headerLines = [
      `From: ${message.from}`,
      `To: ${message.to.join(', ')}`,
      `Subject: ${message.subject}`,
      'Content-Type: text/plain; charset=utf-8',
      '',
    ];
    for (const line of headerLines) await conn.writeData(line);
    for (const line of message.text.split('\n')) {
      await conn.writeData(line.startsWith('.') ? `.${line}` : line);
    }
    await conn.writeData('.');
    await conn.command('QUIT', [221]);
  } finally {
    conn.close();
  }
}

/** 真实连接器：明文 net 连接（默认）或隐式 TLS（secure=true）。 */
export const realSmtpConnector: SmtpConnector = async (config) => {
  let socket: Socket = config.secure
    ? (tlsConnect({ host: config.host, port: config.port, servername: config.host }) as unknown as Socket)
    : netConnect({ host: config.host, port: config.port });
  let buffer = '';
  let closed = false;
  let tlsActive = config.secure;
  const waiters: string[] = [];
  let currentWaiter: ((line: string) => void) | null = null;
  let errorReject: ((error: Error) => void) | null = null;
  let closeReject: ((error: Error) => void) | null = null;

  const attach = (sock: Socket) => {
    sock.setTimeout(SMTP_TIMEOUT_MS, () => sock.destroy(new Error('smtp_timeout')));
    sock.setEncoding('utf8');
    sock.on('data', (chunk: string) => {
      buffer += chunk;
      let idx = buffer.indexOf('\n');
      while (idx >= 0) {
        const line = buffer.slice(0, idx).replace(/\r$/, '');
        buffer = buffer.slice(idx + 1);
        if (currentWaiter) {
          const w = currentWaiter;
          currentWaiter = null;
          w(line);
        } else {
          waiters.push(line);
        }
        idx = buffer.indexOf('\n');
      }
    });
    sock.on('error', (err) => {
      errorReject?.(err instanceof Error ? err : new Error(String(err)));
      errorReject = null;
    });
    sock.on('close', () => {
      closeReject?.(new Error('smtp_connection_closed'));
      closeReject = null;
    });
  };
  attach(socket);
  const nextLine = (): Promise<string> => {
    if (waiters.length > 0) return Promise.resolve(waiters.shift() as string);
    return new Promise<string>((resolve, reject) => {
      currentWaiter = resolve;
      errorReject = reject;
      closeReject = reject;
    });
  };
  const writeRaw = (data: string): Promise<void> =>
    new Promise((resolve, reject) => socket.write(data, (err) => (err ? reject(err) : resolve())));

  const command = async (cmd: string, allowCodes: number[]): Promise<number> => {
    if (closed) throw new Error('smtp_connection_closed');
    await writeRaw(`${cmd}\r\n`);
    // 读多行回复（250-... 至 250 ... 终止）
    let line = await nextLine();
    let code = Number(line.slice(0, 3));
    let guard = 0;
    while (line.length >= 4 && line[3] === '-' && guard < 100) {
      line = await nextLine();
      code = Number(line.slice(0, 3));
      guard += 1;
    }
    if (!allowCodes.includes(code)) {
      throw new Error(`smtp_rejected_${code}`);
    }
    return code;
  };
  const writeData = async (line: string): Promise<void> => {
    await writeRaw(`${line}\r\n`);
  };
  const conn: SmtpConnection = {
    command,
    writeData,
    tlsActive,
    startTls: async () => {
      if (closed) throw new Error('smtp_connection_closed');
      if (tlsActive) throw new Error('smtp_already_tls');
      // 升级为 TLS（复用既有 TCP socket；serverName 校验主机身份）。
      socket.removeAllListeners('data');
      const tlsSocket = tlsConnect({
        socket,
        servername: config.host,
      }) as unknown as Socket;
      tlsSocket.setTimeout(SMTP_TIMEOUT_MS, () => tlsSocket.destroy(new Error('smtp_timeout')));
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('smtp_starttls_timeout')), SMTP_TIMEOUT_MS);
        tlsSocket.once('secureConnect', () => {
          clearTimeout(timer);
          resolve();
        });
        tlsSocket.once('error', (err) => {
          clearTimeout(timer);
          reject(err instanceof Error ? err : new Error(String(err)));
        });
      });
      socket = tlsSocket;
      attach(socket);
      tlsActive = true;
      conn.tlsActive = true;
    },
    close: () => {
      closed = true;
      socket.destroy();
    },
  };
  await nextLine(); // 消费服务器 greeting（220）
  return conn;
};
