/* MobileWorkbench 离线入队失败的假确认测试（攻击面 b：重复提交/队列完整性）。
 *
 * 不变量：离线时提交动作，只有当动作**确实写入了待同步队列**才允许提示
 * 「已加入待同步队列，联网后自动提交」。入队本身可能失败（IndexedDB 被禁用/
 * 隐私模式、附件配额已满、附件压缩失败、IDB 事务中止）——此时动作既没有发出
 * 也没有排队，用户却被告知"已排队"，联网后也永远不会提交：操作被静默丢弃。
 * 必须显式报错（toast.error），且不得给出任何"已加入队列"的确认。
 */
import { renderToStaticMarkup } from 'react-dom/server';
import { createElement } from 'react';

const toastMock = {
  info: jest.fn(),
  error: jest.fn(),
  success: jest.fn(),
  warning: jest.fn(),
};
jest.mock('sonner', () => ({
  toast: {
    info: (...args: unknown[]) => toastMock.info(...args),
    error: (...args: unknown[]) => toastMock.error(...args),
    success: (...args: unknown[]) => toastMock.success(...args),
    warning: (...args: unknown[]) => toastMock.warning(...args),
  },
}));

jest.mock('lucide-react', () =>
  new Proxy(
    {},
    {
      get: (_: unknown, key: string) => {
        const Icon = (props: Record<string, unknown>) =>
          createElement('span', { 'data-icon': key, ...props });
        Icon.displayName = key;
        return Icon;
      },
    },
  ),
);

const mockQueueTransition = jest.fn();
const mockQueueInspection = jest.fn();

jest.mock('./useOfflineWorkbench', () => ({
  useOfflineWorkbench: () => ({
    ready: true,
    // 离线：提交走 queueTransition/queueInspection 路径。
    isOnline: false,
    syncing: false,
    authPaused: false,
    pendingActions: [],
    pendingCount: 0,
    lastSyncAt: null,
    drafts: null,
    queueTransition: mockQueueTransition,
    queueInspection: mockQueueInspection,
    retryPending: jest.fn(),
    batchRetry: jest.fn(),
    discardPending: jest.fn(),
    resolveConflict: jest.fn(),
    recordAudit: jest.fn(),
    refreshPending: jest.fn(),
    exportOffline: jest.fn(),
    recoverOffline: jest.fn(),
    clearOfflineData: jest.fn(),
  }),
}));

jest.mock('./useMobileScanner', () => ({
  useMobileScanner: () => ({
    scanInput: '',
    setScanInput: jest.fn(),
    scanMutation: { isPending: false },
    handleScan: jest.fn(),
    cameraInputRef: { current: null },
    handleCameraCapture: jest.fn(),
    supportsCamera: false,
  }),
}));

jest.mock('./useMobileException', () => ({
  useMobileException: () => ({
    exceptionOpen: {},
    exceptionNote: {},
    exceptionFile: {},
    qcOpen: {},
    qcResult: {},
    qcNote: {},
    setExceptionOpen: jest.fn(),
    setExceptionNote: jest.fn(),
    setExceptionFile: jest.fn(),
    setQcOpen: jest.fn(),
    setQcResult: jest.fn(),
    setQcNote: jest.fn(),
    saveDraft: jest.fn(),
    clearExceptionAfterPause: jest.fn(),
    handleException: jest.fn(),
    handleInspect: jest.fn(),
  }),
}));

jest.mock('./useNetworkState', () => ({
  useNetworkState: () => ({
    isOnline: false,
    quality: 'offline',
    isSlow: false,
    isStale: false,
    syncFailed: false,
  }),
}));

jest.mock('./useOfflineSettings', () => ({
  useOfflineSettings: () => ({
    settings: {},
    update: jest.fn(),
    reset: jest.fn(),
  }),
}));

jest.mock('./OfflineStatusBar', () => ({ OfflineStatusBar: () => null }));
jest.mock('./PendingQueuePanel', () => ({ PendingQueuePanel: () => null }));

// StepCard 替身：捕获 props 并在渲染时触发一次 onAction('start')，
// 从而同步走到 submitTransition 的离线入队分支。
const stepCardProps: Array<Record<string, unknown>> = [];
let actionFired = false;
jest.mock('./StepCard', () => ({
  StepCard: (props: Record<string, unknown>) => {
    stepCardProps.push(props);
    if (!actionFired) {
      actionFired = true;
      (props.onAction as (action: string, body?: Record<string, unknown>) => void)('start');
    }
    return null;
  },
}));

jest.mock('../../components/QueryState', () => ({
  __esModule: true,
  default: (props: { children?: unknown }) => props.children ?? null,
}));

const WORKBENCH_STEPS = [
  {
    stepId: 'S1',
    scheduleTaskId: 'WO-1',
    stepNo: 1,
    name: '装配',
    status: 'pending',
    assignedPersonId: 'u-1',
    assignedDeviceId: null,
    spatialEntityId: null,
    progress: null,
    actualStart: null,
    resultJson: null,
  },
];

const ORDER = {
  workOrder: { scheduleTaskId: 'WO-1', title: '工单1', status: 'in_progress', progress: 10 },
  steps: WORKBENCH_STEPS,
  materials: [],
};

jest.mock('@tanstack/react-query', () => ({
  useQueryClient: () => ({ invalidateQueries: jest.fn(), setQueryData: jest.fn() }),
  useQuery: (options: { queryKey: readonly unknown[] }) => {
    const isOrder = JSON.stringify(options.queryKey).includes('mobile-order');
    return {
      data: isOrder ? ORDER : WORKBENCH_STEPS,
      isLoading: false,
      isFetching: false,
      isError: false,
      error: null,
      refetch: jest.fn(),
      dataUpdatedAt: Date.now(),
    };
  },
  useMutation: () => ({ mutate: jest.fn(), isPending: false, error: null, variables: undefined }),
}));

jest.mock('../../api/mobile', () => ({
  getWorkbench: jest.fn(),
  getMobileOrder: jest.fn(),
  scanWorkbench: jest.fn(),
  transitionMobileStep: jest.fn(),
  inspectMobileStep: jest.fn(),
}));

jest.mock('../../lib/auth', () => ({
  getAuthUser: () => ({ userId: 'u-1', username: 'worker-1', roles: ['worker'], orgId: 'org-1' }),
}));

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { default: MobileWorkbench } = require('./MobileWorkbench');

describe('MobileWorkbench · 离线入队失败不得假确认', () => {
  beforeEach(() => {
    toastMock.info.mockClear();
    toastMock.error.mockClear();
    toastMock.success.mockClear();
    toastMock.warning.mockClear();
    stepCardProps.length = 0;
    actionFired = false;
    mockQueueTransition.mockReset();
    mockQueueInspection.mockReset();
  });

  it('入队成功时提示"已加入待同步队列"', async () => {
    mockQueueTransition.mockResolvedValueOnce(undefined);
    renderToStaticMarkup(<MobileWorkbench />);
    await new Promise((resolve) => setImmediate(resolve));
    expect(mockQueueTransition).toHaveBeenCalledWith(
      expect.objectContaining({ orderId: 'WO-1', stepId: 'S1', action: 'start' }),
    );
    const infoCalls = toastMock.info.mock.calls.map((call) => String(call[0]));
    expect(infoCalls.some((text) => text.includes('已加入待同步队列'))).toBe(true);
  });

  it('入队失败（IndexedDB 不可用/配额满）时必须报错，不得提示已加入队列', async () => {
    // 例：隐私模式打开 IndexedDB 失败 → useOfflineWorkbench 的 dbRef 为 null →
    // queueTransition 抛 '离线存储不可用'。动作既未发出也未排队。
    mockQueueTransition.mockRejectedValueOnce(new Error('离线存储不可用'));
    renderToStaticMarkup(<MobileWorkbench />);
    await new Promise((resolve) => setImmediate(resolve));

    expect(mockQueueTransition).toHaveBeenCalled();
    const infoCalls = toastMock.info.mock.calls.map((call) => String(call[0]));
    expect(
      infoCalls.some((text) => text.includes('已加入待同步队列')),
    ).toBe(false);
    expect(toastMock.error).toHaveBeenCalled();
  });
});
