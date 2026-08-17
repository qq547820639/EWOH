/* email-transport 头注入净化回归（R2-SNZ-006，闭合 NEST-620）。
 *
 * 安灯 title 上游用户可控（oee.openAndon body.title，trim 不剥 CRLF），
 * 原先 DATA 头部 From/To/Subject 直接拼接 + writeData 原样写出——
 * `title="x\r\nBcc: attacker@evil"` 可注入任意头。现：
 *  1) buildEmailMessage 的 subject 经 sanitizeHeaderValue 折叠 CRLF；
 *  2) sendEmail 对 from/to/subject 再次净化（直接调用方兜底）；
 *  3) writeData 行级剥离 CR/LF（最后一道闸）。
 */
/// <reference types="jest" />
import {
  buildEmailMessage,
  sanitizeHeaderValue,
  sendEmail,
  type EmailConfig,
  type SmtpConnection,
  type SmtpConnector,
} from '../email-transport';

const config: EmailConfig = {
  host: 'relay.internal',
  port: 25,
  secure: false,
  user: null,
  pass: null,
  from: 'ewoh@internal',
  to: ['ops@internal'],
};

function notificationOf(title: string) {
  return {
    notificationId: 'NTF-1',
    title,
    body: null,
    severity: 'high',
    externalRef: null,
  };
}

function fakeConnector(dataLines: string[]): SmtpConnector {
  const commands: string[] = [];
  const conn: SmtpConnection = {
    command: jest.fn(async (cmd: string) => {
      commands.push(cmd);
      return 250;
    }),
    writeData: jest.fn(async (line: string) => {
      dataLines.push(line);
    }),
    tlsActive: false,
    startTls: jest.fn(async () => undefined),
    close: jest.fn(),
  };
  return async () => conn;
}

describe('sanitizeHeaderValue（R2-SNZ-006）', () => {
  it('CR/LF/CRLF 全部折叠为单空格并去首尾空白', () => {
    expect(sanitizeHeaderValue('x\r\nBcc: a@evil')).toBe('x Bcc: a@evil');
    expect(sanitizeHeaderValue('a\rb\nc\r\n\r\nd')).toBe('a b c d');
    expect(sanitizeHeaderValue('  clean  ')).toBe('clean');
  });
});

describe('buildEmailMessage（R2-SNZ-006：恶意 title 不进头）', () => {
  it('subject 剥离注入载荷（"[EWOH] x Bcc: ..." 单行）', () => {
    const msg = buildEmailMessage(notificationOf('x\r\nBcc: attacker@evil'), config);
    expect(msg.subject).not.toMatch(/[\r\n]/);
    expect(msg.subject).toBe('[EWOH] x Bcc: attacker@evil');
  });
});

describe('sendEmail（R2-SNZ-006：writeData 层兜底）', () => {
  it('头部行不含 CR/LF——注入的 Bcc 头不可拆出', async () => {
    const dataLines: string[] = [];
    const malicious = {
      from: 'ewoh@internal\r\nBcc: attacker@evil',
      to: ['ops@internal', 'ops2@internal\r\nCc: x@evil'],
      subject: '[EWOH] x\r\nBcc: attacker@evil',
      text: 'body',
    };
    await sendEmail(config, malicious, fakeConnector(dataLines));
    for (const line of dataLines) {
      expect(line).not.toMatch(/[\r\n]/);
    }
    const subjectLine = dataLines.find((l) => l.startsWith('Subject:'));
    expect(subjectLine).toBe('Subject: [EWOH] x Bcc: attacker@evil');
    const fromLine = dataLines.find((l) => l.startsWith('From:'));
    expect(fromLine).toBe('From: ewoh@internal Bcc: attacker@evil');
    const toLine = dataLines.find((l) => l.startsWith('To:'));
    expect(toLine).toBe('To: ops@internal, ops2@internal Cc: x@evil');
    // 没有任何独立成行的注入头。
    expect(dataLines).not.toContain('Bcc: attacker@evil');
  });
});
