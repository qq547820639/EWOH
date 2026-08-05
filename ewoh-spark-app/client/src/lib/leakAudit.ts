/**
 * 泄漏回归审计（纯逻辑 + 测试辅助）。
 *
 * 针对长时间运行页面（角色工作台、指挥中心等）最容易产生的泄漏做可测试断言：
 *   1. 定时器（setTimeout/setInterval）
 *   2. 事件监听器（window/document 等）
 *   3. Object URL / Blob URL（下载、预览）
 *   4. 会话/组件 scope
 *
 * 核心约定：资源统一经 `runtimeLifecycle` 登记；组件卸载/会话转换后 `dispose`。
 * 测试用 `leakAudit.test.ts` 注入可控的定时器/监听器/URL stub，断言「清理函数被调用、
 * 计时器不再触发、监听器被移除、URL 被 revoke」。
 */

/** 一个可登记的网关注入点（供测试注入 stub 计数）。 */
export interface LeakRegistry {
  activeTimers: () => number;
  activeListeners: () => number;
  pendingBlobUrls: () => number;
}

/** 断言给定 scope 的全部资源已释放（归零且 disposed）。用于卸载后的回归测试。 */
export function assertScopeFreed(scope: {
  size: number;
  isDisposed(): boolean;
}): void {
  if (scope.size !== 0 || !scope.isDisposed()) {
    throw new Error(
      `泄漏：scope 未完全释放（size=${scope.size}, disposed=${scope.isDisposed()}）`,
    );
  }
}

/**
 * 断言在某次「注册 + 清理」周期后，网关各资源计数都归零。
 * registry 由测试注入真实 RuntimeLifecycle 资源或 stub 计数。
 */
export function assertNoLeaks(
  registry: LeakRegistry,
  run: () => void,
  cleanup: () => void,
): void {
  run();
  cleanup();
  const leaks = {
    timers: registry.activeTimers(),
    listeners: registry.activeListeners(),
    blobUrls: registry.pendingBlobUrls(),
  };
  const flagged = Object.entries(leaks)
    .filter(([, value]) => value !== 0)
    .map(([key, value]) => `${key}=${value}`);
  if (flagged.length > 0) {
    throw new Error(`泄漏：清理后仍有存活资源（${flagged.join(', ')}）`);
  }
}