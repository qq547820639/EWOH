/* ExecutionBoundaryPanel 渲染 smoke（NO-66a，§17/§33 同款零网络做法）。
 *
 * 契约：状态逐条区分（在飞/排队/撤回/失败）、授权可信度（方案 + 是否复核）分开显示、
 * 违规留痕单列、空态与错误态都显式（不显示"一切正常"的假状态）。
 */
import { renderToStaticMarkup } from 'react-dom/server';

jest.mock('lucide-react', () =>
  new Proxy(
    {},
    {
      get: (_: unknown, key: string) => {
        const Icon = (props: Record<string, unknown>) =>
          // eslint-disable-next-line @typescript-eslint/no-var-requires
          require('react').createElement('span', { 'data-icon': key, ...props });
        Icon.displayName = key;
        return Icon;
      },
    },
  ),
);

const mockState: { data: unknown; isLoading: boolean; isError: boolean; error: unknown } = {
  data: undefined,
  isLoading: false,
  isError: false,
  error: null,
};
jest.mock('@tanstack/react-query', () => ({
  useQuery: () => mockState,
}));
// api 层用 import.meta（Vite）→ node 环境无法解析，按仓库既有做法整体 mock。
jest.mock('../../api/control', () => ({ getDeviceExecutionBoundary: jest.fn() }));

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { ExecutionBoundaryPanel } = require('./ExecutionBoundaryPanel');

const SNAPSHOT = {
  deviceId: 'AGV-01',
  checkedAt: '2026-09-12T10:00:00.000Z',
  summary: { inFlight: 1, queued: 1, awaitingDelivery: 0, revoked: 1, busyBlocker: 'dispatch_task:att-1' },
  commands: [
    {
      commandId: 'att-1',
      requestId: 'ctl-1',
      commandKey: 'dispatch_task',
      attemptNo: 1,
      status: 'gateway_received',
      deliveryState: 'gateway_received',
      deliveryNote: null,
      sentAt: '2026-09-12T09:59:00.000Z',
      responseAt: null,
      revokedReason: null,
      revokedReasonLabel: null,
      fingerprintScheme: 'hmac-sha256:v2',
      fingerprintVerified: true,
      ack: { delivered: true, reason: null, at: '2026-09-12T09:59:10.000Z' },
      receipt: null,
      violations: [],
      executable: true,
    },
    {
      commandId: 'att-2',
      requestId: 'ctl-2',
      commandKey: 'dispatch_task',
      attemptNo: 1,
      status: 'sent',
      deliveryState: 'queued_device_busy',
      deliveryNote: '设备正在执行 dispatch_task:att-1，本条按"一车一活"排队（暂缓 ≠ 失败）',
      sentAt: '2026-09-12T09:59:30.000Z',
      responseAt: null,
      revokedReason: null,
      revokedReasonLabel: null,
      fingerprintScheme: 'hmac-sha256:v2',
      fingerprintVerified: false,
      ack: null,
      receipt: null,
      violations: [],
      executable: true,
    },
    {
      commandId: 'att-3',
      requestId: 'ctl-3',
      commandKey: 'dispatch_task',
      attemptNo: 1,
      status: 'revoked',
      deliveryState: 'revoked',
      deliveryNote: '授权范围与命令内容不一致（请求/设备/命令/参数被改写，或签名不符）',
      sentAt: '2026-09-12T09:58:00.000Z',
      responseAt: null,
      revokedReason: 'fingerprint_mismatch',
      revokedReasonLabel: '授权范围与命令内容不一致（请求/设备/命令/参数被改写，或签名不符）',
      fingerprintScheme: 'hmac-sha256:v2',
      fingerprintVerified: false,
      ack: null,
      receipt: null,
      violations: [{ resultType: 'delivery_rejected', resultCode: 'fingerprint_mismatch', at: '2026-09-12T09:58:05.000Z' }],
      executable: false,
    },
    {
      // F-02：`expired` 自本轮起才真正可达（巡检是它的唯一 writer）
      commandId: 'att-4',
      requestId: 'ctl-4',
      commandKey: 'dispatch_task',
      attemptNo: 1,
      status: 'expired',
      deliveryState: 'expired',
      deliveryNote: '超过授权有效期仍未收到设备回执，命令不再视为在飞（过期 ≠ 失败）',
      sentAt: '2026-09-11T09:00:00.000Z',
      responseAt: null,
      revokedReason: null,
      revokedReasonLabel: null,
      fingerprintScheme: 'hmac-sha256:v2',
      fingerprintVerified: true,
      ack: null,
      receipt: null,
      violations: [],
      executable: false,
    },
  ],
};

describe('ExecutionBoundaryPanel（NO-66a）', () => {
  beforeEach(() => {
    mockState.data = SNAPSHOT;
    mockState.isLoading = false;
    mockState.isError = false;
    mockState.error = null;
  });

  it('状态逐条区分：在飞 / 排队（设备忙）/ 已撤回 + 队列摘要', () => {
    const markup = renderToStaticMarkup(<ExecutionBoundaryPanel deviceId="AGV-01" />);
    expect(markup).toContain('执行边界');
    expect(markup).toContain('在飞 1');
    expect(markup).toContain('排队 1');
    expect(markup).toContain('已撤回 1');
    expect(markup).toContain('已投递未回执');
    expect(markup).toContain('排队（设备忙）');
    expect(markup).toContain('一车一活');
  });

  it('授权可信度：方案与"是否复核"分开显示（不把"没验过"渲染成已验证）', () => {
    const markup = renderToStaticMarkup(<ExecutionBoundaryPanel deviceId="AGV-01" />);
    // att-1 已验签、att-2 未验签 —— 两种文案都必须出现
    expect(markup).toContain('签名指纹已验签（HMAC-SHA256）');
    expect(markup).toContain('签名指纹未验签');
  });

  it('违规留痕单列：投递被拒并撤回（含原因码）', () => {
    const markup = renderToStaticMarkup(<ExecutionBoundaryPanel deviceId="AGV-01" />);
    expect(markup).toContain('投递被拒并撤回（fingerprint_mismatch）');
  });

  it('F-02 过期终态可见：expired 渲染成"已超时"+ 过期说明（既不当失败也不当在飞）', () => {
    const markup = renderToStaticMarkup(<ExecutionBoundaryPanel deviceId="AGV-01" />);
    expect(markup).toContain('已超时');
    expect(markup).toContain('过期 ≠ 失败');
  });

  it('空列表显式说明（无命令 ≠ 设备正常）', () => {
    mockState.data = { ...SNAPSHOT, commands: [], summary: { inFlight: 0, queued: 0, awaitingDelivery: 0, revoked: 0, busyBlocker: null } };
    const markup = renderToStaticMarkup(<ExecutionBoundaryPanel deviceId="AGV-01" />);
    expect(markup).toContain('该设备当前没有控制命令记录');
    expect(markup).toContain('无命令 ≠ 设备正常');
  });

  it('读失败显式报错（不显示"一切正常"的假状态）', () => {
    mockState.data = undefined;
    mockState.isError = true;
    mockState.error = new Error('HTTP 403');
    const markup = renderToStaticMarkup(<ExecutionBoundaryPanel deviceId="AGV-01" />);
    expect(markup).toContain('执行边界读取失败');
    expect(markup).toContain('HTTP 403');
  });

  it('NO-68a：投递积压（超 SLA）在面板上直接可见，带最久等待与 SLA', () => {
    mockState.data = {
      ...SNAPSHOT,
      summary: { ...SNAPSHOT.summary, overdue: 2, oldestWaitingMs: 12 * 60_000, deliverySlaMs: 5 * 60_000 },
    };
    const markup = renderToStaticMarkup(<ExecutionBoundaryPanel deviceId="AGV-01" />);
    expect(markup).toContain('投递积压 2 条');
    expect(markup).toContain('最久等待 12 分钟');
    expect(markup).toContain('超过 SLA 5 分钟');
  });

  it('NO-67b：配额徽章显示"窗口内已投 / 上限"并在用尽时说明排队不是失败', () => {
    mockState.data = {
      ...SNAPSHOT,
      summary: { ...SNAPSHOT.summary, quota: { perMinute: 3, usedInWindow: 3, remaining: 0 } },
    };
    const markup = renderToStaticMarkup(<ExecutionBoundaryPanel deviceId="AGV-01" />);
    expect(markup).toContain('窗口内已投 3 / 上限 3 每分钟');
    expect(markup).toContain('命令排队到下一分钟，不是失败');
  });

  it('未授权执行单独提示为安全事件（不混在"失败"里）', () => {
    mockState.data = {
      ...SNAPSHOT,
      commands: [
        {
          ...SNAPSHOT.commands[0],
          commandId: 'att-9',
          status: 'executed',
          deliveryState: 'executed',
          violations: [{ resultType: 'authorization_violation', resultCode: 'unauthorized_execution', at: '2026-09-12T09:57:00.000Z' }],
        },
      ],
    };
    const markup = renderToStaticMarkup(<ExecutionBoundaryPanel deviceId="AGV-01" />);
    expect(markup).toContain('未授权执行');
    expect(markup).toContain('按安全事件处置');
  });
});
