/**
 * 统一前端资源生命周期管理（Task 6）。
 *
 * 集中登记并清理会话/组件/页面级的前端资源：BroadcastChannel、WebSocket、
 * SSE（EventSource）、Service Worker 消息监听、定时器（setInterval/setTimeout）、
 * 重试/退避任务、AbortController、IndexedDB 连接、Blob URL、document/window
 * 事件监听器。
 *
 * 任一会话转换（组件卸载、登出、令牌过期、租户切换、角色切换、页面进入后台、
 * 网络恢复、Service Worker 升级）都可对旧会话资源做统一释放，避免旧会话继续
 * 接收消息或写入数据。核心不变量：一次 dispose 只释放当前代（generation）登记
 * 的资源；新会话在全新的 scope 上继续登记，互不泄漏。
 *
 * 设计约定：
 * - `RuntimeLifecycle` 维护一个「会话 scope」用于登记会话级资源；`createScope()`
 *   产出可独立释放的组件/页面 scope（由 React hook 在卸载时释放）。
 * - `disposeForReason(reason)` 释放当前会话 scope、递增 generation、触发
 *   `onSessionDisposed` 监听，并新建一个空的会话 scope 供新会话登记。
 * - 单个资源释放失败绝不影响其余资源的释放（逐项 try/catch）。
 */

import { useEffect, useRef } from 'react';

export type ResourceType =
  | 'broadcast'
  | 'websocket'
  | 'sse'
  | 'sw-message'
  | 'timer'
  | 'retry'
  | 'abort'
  | 'idb'
  | 'blob'
  | 'listener';

export type Disposer = () => void;

/** 登记在生命周期管理器中的资源句柄。 */
export interface ResourceHandle {
  readonly type: ResourceType;
  /** 只读诊断标签（如 `metrics-timer`、`offline-flush-leader`）。 */
  readonly label?: string;
  readonly dispose: Disposer;
}

export type DisposeReason =
  | 'unmount'
  | 'logout'
  | 'token-expired'
  | 'tenant-switch'
  | 'role-switch'
  | 'background'
  | 'network-recovery'
  | 'sw-upgrade'
  | 'all';

/** 一份可独立成组释放的资源集合（会话/组件/页面）。 */
export interface Scope {
  /** 当前登记的存活资源数。 */
  readonly size: number;
  isDisposed(): boolean;
  /** 登记一个资源；若 scope 已被释放则立即释放该资源（防泄漏）。 */
  register(handle: ResourceHandle): ResourceHandle;
  /** 提前释放单个资源，返回是否确已移除。 */
  release(handle: ResourceHandle): boolean;
  /** 释放本 scope 的全部资源，返回触发原因。 */
  dispose(reason?: DisposeReason): DisposeReason;
}

/** 事件监听目标的最小接口（便于测试注入 stub）。 */
export interface ListenerTarget {
  addEventListener(
    type: string,
    handler: EventListenerOrEventListenerObject,
    options?: boolean | AddEventListenerOptions,
  ): void;
  removeEventListener(
    type: string,
    handler: EventListenerOrEventListenerObject,
    options?: boolean | EventListenerOptions,
  ): void;
}

function createScopeImpl(): Scope {
  const resources = new Set<ResourceHandle>();
  let disposed = false;
  return {
    get size() {
      return resources.size;
    },
    isDisposed() {
      return disposed;
    },
    register(handle: ResourceHandle): ResourceHandle {
      if (disposed) {
        // 释放后的 scope 上登记资源即视为「立即释放」，杜绝越过转换边界的泄漏。
        try {
          handle.dispose();
        } catch {
          // ignore
        }
        return handle;
      }
      resources.add(handle);
      return handle;
    },
    release(handle: ResourceHandle): boolean {
      if (!resources.delete(handle)) {
        return false;
      }
      try {
        handle.dispose();
      } catch {
        // ignore
      }
      return true;
    },
    dispose(reason: DisposeReason = 'all'): DisposeReason {
      if (disposed) {
        return reason;
      }
      disposed = true;
      for (const handle of resources) {
        try {
          handle.dispose();
        } catch {
          // 单个资源释放失败不得阻塞其余资源释放。
        }
      }
      resources.clear();
      return reason;
    },
  };
}

export class RuntimeLifecycle {
  private session: Scope;
  private readonly scopes = new Set<Scope>();
  private readonly sessionDisposedListeners = new Set<(reason: DisposeReason) => void>();
  private currentGeneration = 0;

  constructor() {
    this.session = createScopeImpl();
  }

  /** 当前会话代（generation）；每次会话释放后自增 1。 */
  get generation(): number {
    return this.currentGeneration;
  }

  /** 登记一个会话级资源（默认会话 scope）。 */
  registerResource(
    type: ResourceType,
    dispose: Disposer,
    label?: string,
  ): ResourceHandle {
    const handle: ResourceHandle = { type, label, dispose };
    return this.session.register(handle);
  }

  /** 登记一个已构造好的资源句柄到当前会话 scope。 */
  register(handle: ResourceHandle): ResourceHandle {
    return this.session.register(handle);
  }

  /**
   * 异步获取资源：先 `await setup()`，再把其释放函数登记进会话 scope。
   * 适合需要异步创建后才可知释放方式的资源（如等待 WebSocket open）。
   */
  async acquire<T extends { dispose: Disposer }>(
    type: ResourceType,
    setup: () => T | Promise<T>,
    label?: string,
  ): Promise<ResourceHandle> {
    const resource = await setup();
    const handle: ResourceHandle = {
      type,
      label,
      dispose: () => resource.dispose(),
    };
    return this.session.register(handle);
  }

  /** 提前释放单个会话级资源，返回是否确已移除。 */
  release(handle: ResourceHandle): boolean {
    return this.session.release(handle);
  }

  /**
   * 因某个会话转换统一释放当前会话资源，并新建一个空会话 scope 供新会话登记。
   * 触发 `onSessionDisposed` 监听（供外部重建资源）。
   */
  disposeForReason(reason: DisposeReason): void {
    this.session.dispose(reason);
    this.session = createScopeImpl();
    this.currentGeneration += 1;
    for (const listener of this.sessionDisposedListeners) {
      try {
        listener(reason);
      } catch {
        // ignore
      }
    }
  }

  /** 监听会话被释放（返回退订函数）。用于按需重建资源。 */
  onSessionDisposed(listener: (reason: DisposeReason) => void): () => void {
    this.sessionDisposedListeners.add(listener);
    return () => {
      this.sessionDisposedListeners.delete(listener);
    };
  }

  /** 创建一个可独立释放的组件/页面 scope（由调用方决定何时 dispose）。 */
  createScope(): Scope {
    const scope = createScopeImpl();
    this.scopes.add(scope);
    return scope;
  }

  /** 释放全部资源（会话 + 所有 scope），例如页面卸载时。 */
  disposeAll(): DisposeReason[] {
    const reasons: DisposeReason[] = [];
    for (const scope of [...this.scopes]) {
      reasons.push(scope.dispose('all'));
    }
    this.scopes.clear();
    reasons.push(this.session.dispose('all'));
    this.session = createScopeImpl();
    this.currentGeneration += 1;
    for (const listener of this.sessionDisposedListeners) {
      try {
        listener('all');
      } catch {
        // ignore
      }
    }
    return reasons;
  }
}

// ---- 便捷适配器：创建常见资源并自动登记到会话 scope ----

export function trackInterval(
  lifecycle: RuntimeLifecycle,
  callback: () => void,
  ms: number,
  label?: string,
): ResourceHandle {
  const id = setInterval(callback, ms);
  return lifecycle.registerResource('timer', () => clearInterval(id), label ?? 'interval');
}

export function trackTimeout(
  lifecycle: RuntimeLifecycle,
  callback: () => void,
  ms: number,
  label?: string,
): ResourceHandle {
  const id = setTimeout(callback, ms);
  return lifecycle.registerResource('timer', () => clearTimeout(id), label ?? 'timeout');
}

export function trackListener(
  lifecycle: RuntimeLifecycle,
  target: ListenerTarget,
  type: string,
  handler: EventListenerOrEventListenerObject,
  options?: boolean | AddEventListenerOptions,
  label?: string,
): ResourceHandle {
  target.addEventListener(type, handler, options);
  return lifecycle.registerResource(
    'listener',
    () => target.removeEventListener(type, handler, options),
    label ?? `listener:${type}`,
  );
}

export function trackBroadcastChannel<T extends { close(): void }>(
  lifecycle: RuntimeLifecycle,
  channel: T,
  label?: string,
): ResourceHandle {
  return lifecycle.registerResource('broadcast', () => channel.close(), label ?? 'broadcast');
}

export function trackWebSocket<T extends { close(): void }>(
  lifecycle: RuntimeLifecycle,
  socket: T,
  label?: string,
): ResourceHandle {
  return lifecycle.registerResource(
    'websocket',
    () => {
      try {
        socket.close();
      } catch {
        // 已关闭的 socket 忽略
      }
    },
    label ?? 'websocket',
  );
}

export function trackEventSource<T extends { close(): void }>(
  lifecycle: RuntimeLifecycle,
  source: T,
  label?: string,
): ResourceHandle {
  return lifecycle.registerResource('sse', () => source.close(), label ?? 'sse');
}

export function trackAbortController(
  lifecycle: RuntimeLifecycle,
  controller: AbortController,
  label?: string,
): ResourceHandle {
  return lifecycle.registerResource('abort', () => controller.abort(), label ?? 'abort');
}

export function trackBlobUrl(
  lifecycle: RuntimeLifecycle,
  url: string,
  revoke: (url: string) => void = (u) => URL.revokeObjectURL(u),
  label?: string,
): ResourceHandle {
  return lifecycle.registerResource('blob', () => revoke(url), label ?? 'blob-url');
}

export function trackIndexedDb<T extends { close(): void }>(
  lifecycle: RuntimeLifecycle,
  db: T,
  label?: string,
): ResourceHandle {
  return lifecycle.registerResource('idb', () => db.close(), label ?? 'indexeddb');
}

export function trackRetry(
  lifecycle: RuntimeLifecycle,
  cancel: () => void,
  label?: string,
): ResourceHandle {
  return lifecycle.registerResource('retry', cancel, label ?? 'retry');
}

// ---- React hook：组件卸载时释放本组件登记的资源 ----

export interface UseRuntimeLifecycleResult {
  register: (handle: ResourceHandle) => ResourceHandle;
  scope: Scope;
}

/**
 * 在组件内登记资源，组件卸载时统一释放（reason = 'unmount'）。返回的 `register`
 * 与组件级 scope 绑定；`register({ type, dispose })` 登记的资源在卸载、或显式
 * `scope.dispose()` 时释放。
 */
export function useRuntimeLifecycle(
  lifecycle: RuntimeLifecycle = sessionLifecycle,
): UseRuntimeLifecycleResult {
  const scopeRef = useRef<Scope | null>(null);
  if (scopeRef.current === null) {
    scopeRef.current = lifecycle.createScope();
  }
  useEffect(() => {
    // lifecycle 实例变化时重建 scope（常规用法为单例，不会变化）。
    if (scopeRef.current === null) {
      scopeRef.current = lifecycle.createScope();
    }
    const scope = scopeRef.current;
    return () => {
      scope.dispose('unmount');
    };
  }, [lifecycle]);

  return {
    register: (handle: ResourceHandle): ResourceHandle => {
      if (scopeRef.current === null) {
        scopeRef.current = lifecycle.createScope();
      }
      return scopeRef.current.register(handle);
    },
    scope: scopeRef.current!,
  };
}

/** 应用级单例：负责会话级资源的统一登记与释放。 */
export const sessionLifecycle = new RuntimeLifecycle();