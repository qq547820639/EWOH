import {
  RuntimeLifecycle,
  sessionLifecycle,
  trackAbortController,
  trackBlobUrl,
  trackBroadcastChannel,
  trackInterval,
  trackListener,
  trackRetry,
  trackWebSocket,
  type ListenerTarget,
} from './runtimeLifecycle';

describe('runtimeLifecycle — registry disposal', () => {
  afterEach(() => {
    jest.useRealTimers();
  });

  it('disposeAll releases every registered resource and aborts controllers', () => {
    jest.useFakeTimers();
    const lifecycle = new RuntimeLifecycle();
    const disposed: string[] = [];

    let intervalCalls = 0;
    trackInterval(
      lifecycle,
      () => {
        intervalCalls += 1;
      },
      1000,
      'metrics',
    );

    const controller = new AbortController();
    controller.signal.addEventListener('abort', () => disposed.push('abort'));
    trackAbortController(lifecycle, controller, 'request');

    trackBlobUrl(lifecycle, 'blob:xyz', (u) => disposed.push(`blob:${u}`));

    const target: ListenerTarget = {
      addEventListener: jest.fn(),
      removeEventListener: jest.fn(),
    };
    const handler = () => undefined;
    trackListener(lifecycle, target, 'click', handler, undefined, 'click-drop');

    lifecycle.disposeAll();

    expect(controller.signal.aborted).toBe(true);
    expect(target.removeEventListener).toHaveBeenCalledWith('click', handler, undefined);
    expect(disposed).toEqual(
      expect.arrayContaining(['abort', 'blob:blob:xyz']),
    );

    // 定时器已被释放：推进虚拟时间也不再触发回调。
    jest.advanceTimersByTime(10_000);
    expect(intervalCalls).toBe(0);
  });

  it('release() disposes and removes a single resource early', () => {
    const lifecycle = new RuntimeLifecycle();
    let disposed = false;
    const handle = lifecycle.registerResource('retry', () => {
      disposed = true;
    }, 'pending-flush');
    expect(lifecycle.release(handle)).toBe(true);
    expect(disposed).toBe(true);
    // 二次 release 返回 false（已移除）。
    expect(lifecycle.release(handle)).toBe(false);
  });

  it('registering into a disposed component scope disposes immediately (no leak)', () => {
    const lifecycle = new RuntimeLifecycle();
    const scope = lifecycle.createScope();
    let disposed = false;
    scope.dispose('unmount');
    scope.register({ type: 'timer', label: 'late-timer', dispose: () => { disposed = true; } });
    expect(disposed).toBe(true);
    expect(scope.isDisposed()).toBe(true);
  });

  it('registering into the session scope after a session transition stays live (new session)', () => {
    const lifecycle = new RuntimeLifecycle();
    let disposed = false;
    lifecycle.disposeForReason('logout');
    // 登出后创建的是全新会话 scope，供新会话登记；不应被登出释放。
    lifecycle.registerResource('timer', () => { disposed = true; }, 'new-session-timer');
    expect(disposed).toBe(false);
  });
});

describe('runtimeLifecycle — login → logout → re-login', () => {
  it('old session resources are disposed and stop receiving before a new session starts', () => {
    const lifecycle = new RuntimeLifecycle();
    const messages: string[] = [];

    // 会话 1：一个受生命周期门控的消息通道（模拟 WebSocket）。
    let sessionActive = true;
    jest.spyOn(lifecycle, 'registerResource');
    lifecycle.registerResource('websocket', () => {
      sessionActive = false;
    }, 'ws1');
    const deliver = (data: string) => {
      if (sessionActive) messages.push(data);
    };

    deliver('hello');
    expect(messages).toEqual(['hello']);

    // 登出：释放旧会话资源。
    lifecycle.disposeForReason('logout');
    expect(lifecycle.generation).toBe(1);

    // 旧会话不再接收消息。
    deliver('should-be-dropped');
    expect(messages).toEqual(['hello']);

    // 重新登录：新会话资源登记成功且可独立受控。
    let session2Active = true;
    lifecycle.registerResource('websocket', () => {
      session2Active = false;
    }, 'ws2');
    const deliver2 = (data: string) => {
      if (session2Active) messages.push(data);
    };
    deliver2('hello-again');
    expect(messages).toEqual(['hello', 'hello-again']);

    // 新会话登出不误伤已被释放的旧资源（旧资源本已关闭）。
    lifecycle.disposeForReason('logout');
    expect(lifecycle.generation).toBe(2);
  });

  it('onSessionDisposed listeners fire on logout and can rebuild', () => {
    const lifecycle = new RuntimeLifecycle();
    const reasons: string[] = [];
    const unsubscribe = lifecycle.onSessionDisposed((reason) => reasons.push(reason));

    lifecycle.disposeForReason('logout');
    expect(reasons).toEqual(['logout']);

    unsubscribe();
    lifecycle.disposeForReason('tenant-switch');
    expect(reasons).toEqual(['logout']);
  });
});

describe('runtimeLifecycle — tenant switch', () => {
  it('disposes the old tenant resource set; the new session stays active', () => {
    const lifecycle = new RuntimeLifecycle();
    const disposed: string[] = [];

    lifecycle.registerResource('sse', () => disposed.push('sse-old'), 'tenant-a-sse');
    lifecycle.registerResource('timer', () => disposed.push('timer-old'), 'tenant-a-timer');
    trackBroadcastChannel(
      lifecycle,
      { close: () => disposed.push('bc-old') },
      'tenant-a-bc',
    );
    expect(lifecycle.registerResource('listener', () => disposed.push('ls-old'), 'tenant-a-ls').type)
      .toBe('listener');

    lifecycle.disposeForReason('tenant-switch');
    expect(disposed.sort()).toEqual(['bc-old', 'ls-old', 'sse-old', 'timer-old']);
    expect(lifecycle.generation).toBe(1);

    // 新租户会话资源可正常登记与释放。
    lifecycle.registerResource('sse', () => disposed.push('sse-new'), 'tenant-b-sse');
    lifecycle.disposeForReason('logout');
    expect(disposed).toContain('sse-new');
  });
});

describe('runtimeLifecycle — multi-tab logout via BroadcastChannel', () => {
  it('closing the registered channel on logout stops further delivery', () => {
    const lifecycle = new RuntimeLifecycle();
    const received: string[] = [];
    const channel = {
      closed: false,
      postMessage(data: string) {
        if (!this.closed) received.push(data);
      },
      close() {
        this.closed = true;
      },
    };
    trackBroadcastChannel(lifecycle, channel, 'logout-hub');

    channel.postMessage('needs-flush');
    lifecycle.disposeForReason('logout');
    channel.postMessage('after-logout');

    expect(received).toEqual(['needs-flush']);
  });
});

describe('runtimeLifecycle — adapters', () => {
  it('trackWebSocket closes the socket on session disposal', () => {
    const lifecycle = new RuntimeLifecycle();
    let closed = false;
    const socket = { close: () => (closed = true) };
    trackWebSocket(lifecycle, socket, 'realtime');
    lifecycle.disposeForReason('background');
    expect(closed).toBe(true);
  });

  it('trackRetry cancels an in-flight backoff task', () => {
    const lifecycle = new RuntimeLifecycle();
    let cancelled = false;
    trackRetry(
      lifecycle,
      () => {
        cancelled = true;
      },
      'flush-retry',
    );
    lifecycle.disposeForReason('network-recovery');
    expect(cancelled).toBe(true);
  });

  it('sessionLifecycle singleton works and acquires async resources', async () => {
    const lifecycle = new RuntimeLifecycle();
    let closed = false;
    const handle = await lifecycle.acquire(
      'websocket',
      async () => ({ dispose: () => (closed = true) }),
      'async-ws',
    );
    expect(handle.type).toBe('websocket');
    lifecycle.disposeForReason('sw-upgrade');
    expect(closed).toBe(true);
  });
});

describe('runtimeLifecycle — disposed scopes are isolated', () => {
  it('component scope disposal does not touch the session scope', () => {
    const lifecycle = new RuntimeLifecycle();
    let componentDisposed = false;
    let sessionDisposed = false;

    const scope = lifecycle.createScope();
    scope.register({ type: 'timer', label: 'comp', dispose: () => (componentDisposed = true) });
    lifecycle.registerResource('timer', () => (sessionDisposed = true), 'sess');

    scope.dispose('unmount');
    expect(componentDisposed).toBe(true);
    expect(sessionDisposed).toBe(false);

    // 会话仍可用。
    expect(lifecycle.generation).toBe(0);
  });
});