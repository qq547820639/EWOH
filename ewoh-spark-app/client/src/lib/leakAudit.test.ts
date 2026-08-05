import {
  RuntimeLifecycle,
  trackBlobUrl,
  trackInterval,
  trackListener,
  trackTimeout,
} from './runtimeLifecycle';
import { assertNoLeaks, assertScopeFreed } from './leakAudit';

/**
 * 泄漏回归测试：断言长时间运行页面最常见的资源在「卸载/会话转换」后都被清理。
 * 覆盖 定时器 / 事件监听器 / Object URL / 会话 scope。
 */

/** 一个可记录 add/remove 调用的事件目标 stub。 */
class ListenerStub {
  added = 0;
  removed = 0;
  addEventListener(_type?: string, _fn?: () => void): void {
    this.added += 1;
  }
  removeEventListener(_type?: string, _fn?: () => void): void {
    this.removed += 1;
  }
}

describe('leakAudit: 定时器清理', () => {
  beforeEach(() => {
    jest.useFakeTimers();
  });
  afterEach(() => {
    jest.useRealTimers();
  });

  it('clearTimeout 后定时器回调不再触发', () => {
    const lifecycle = new RuntimeLifecycle();
    const callback = jest.fn();
    const handle = trackTimeout(lifecycle, callback, 1000);
    jest.advanceTimersByTime(500);
    expect(callback).not.toHaveBeenCalled();

    lifecycle.release(handle);
    jest.advanceTimersByTime(5000);
    expect(callback).not.toHaveBeenCalled();
  });

  it('disposeForReason 清理 interval，避免重复轮询', () => {
    const lifecycle = new RuntimeLifecycle();
    const callback = jest.fn();
    trackInterval(lifecycle, callback, 100);
    lifecycle.disposeForReason('unmount');
    jest.advanceTimersByTime(5000);
    expect(callback).not.toHaveBeenCalled();
    // 会话 scope 已重置：disposeForReason 后进入新一代，且新会话 scope 为空可继续登记。
    expect(lifecycle.generation).toBe(1);
    expect(lifecycle.createScope().size).toBe(0);
  });

  it('assertNoLeaks 判定定时器泄漏', () => {
    const lifecycle = new RuntimeLifecycle();
    let active = 0;
    const registry = {
      activeTimers: () => active,
      activeListeners: () => 0,
      pendingBlobUrls: () => 0,
    };
    const run = () => {
      trackInterval(lifecycle, jest.fn(), 100);
      active += 1;
    };
    const cleanup = () => {
      lifecycle.disposeForReason('unmount');
      active = 0;
    };
    expect(() => assertNoLeaks(registry, run, cleanup)).not.toThrow();
  });
});

describe('leakAudit: 事件监听器清理', () => {
  it('dispose 后监听器被移除', () => {
    const lifecycle = new RuntimeLifecycle();
    const target = new ListenerStub();
    trackListener(lifecycle, target, 'scroll', jest.fn());
    trackListener(lifecycle, target, 'resize', jest.fn());
    expect(target.added).toBe(2);

    lifecycle.disposeForReason('unmount');
    expect(target.removed).toBe(2);
  });

  it('组件 scope dispose 释放其登记的监听器', () => {
    const lifecycle = new RuntimeLifecycle();
    const scope = lifecycle.createScope();
    const target = new ListenerStub();
    scope.register({
      type: 'listener',
      label: 'scroll',
      dispose: () => target.removeEventListener(),
    });
    scope.dispose('unmount');
    expect(target.removed).toBe(1);
    assertScopeFreed(scope);
  });
});

describe('leakAudit: Object URL / Blob URL 清理', () => {
  it('scope 释放时 revoke 已登记的 blob URL', () => {
    const lifecycle = new RuntimeLifecycle();
    const scope = lifecycle.createScope();
    const revoked: string[] = [];
    scope.register({
      type: 'blob',
      label: 'export-download',
      dispose: () => revoked.push('blob:export'),
    });
    expect(revoked).toHaveLength(0);
    scope.dispose('unmount');
    expect(revoked).toEqual(['blob:export']);
  });

  it('trackBlobUrl 使用注入的 revoke 收集器', () => {
    const lifecycle = new RuntimeLifecycle();
    const revoked: string[] = [];
    trackBlobUrl(lifecycle, 'blob:url-1', (url) => revoked.push(url));
    lifecycle.disposeForReason('unmount');
    expect(revoked).toEqual(['blob:url-1']);
  });
});

describe('leakAudit: 会话 scope 释放', () => {
  it('assertScopeFreed 在资源未清理时抛错', () => {
    const scope = { size: 1, isDisposed: () => false };
    expect(() => assertScopeFreed(scope)).toThrow(/泄漏/);
  });

  it('disposeAll 释放全部 scope 与会话资源', () => {
    const lifecycle = new RuntimeLifecycle();
    const timerCb = jest.fn();
    trackTimeout(lifecycle, timerCb, 1000);
    lifecycle.createScope();
    jest.useFakeTimers();
    lifecycle.disposeAll();
    jest.advanceTimersByTime(5000);
    expect(timerCb).not.toHaveBeenCalled();
    jest.useRealTimers();
  });
});