import React from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import { ErrorBoundary } from 'react-error-boundary';

import RoutesComponent from './app.tsx';
import './index.css';
import { createPortal } from 'react-dom';
import { Toaster } from '@client/src/components/ui/sonner';
import { AppContainer } from './lib/AppContainer';
import {
  captureUnhandledError,
  detectWhiteScreen,
  flush,
  installPagehideFlush,
  startWebVitalsCollection,
} from './lib/observability';
import { initSessionSecurity } from './lib/sessionSecurity';
import { applyContrastClass } from './lib/contrastMode';
import { toast } from 'sonner';
import { registerServiceWorker } from './lib/swRegistration';
import { openOfflineDb } from './lib/offlineDb';
import { clearTokens } from './lib/auth';

const CLIENT_BASE_PATH = process.env.CLIENT_BASE_PATH || '/';

const MainApp = () => {
  return (
    <BrowserRouter basename={CLIENT_BASE_PATH}>
      <AppContainer>
        <ErrorBoundary
          fallbackRender={({ error, resetErrorBoundary }) => (
            <div className="flex min-h-screen items-center justify-center bg-[hsl(220_14%_96%)] p-6">
              <div className="rounded-lg border border-red-200 bg-white p-6 text-center">
                <p className="text-sm font-semibold text-red-700">页面加载失败</p>
                <p className="mt-2 max-w-md text-xs text-[hsl(218_10%_42%)]">
                  {error instanceof Error ? error.message : '未知错误'}
                </p>
                <button
                  type="button"
                  onClick={resetErrorBoundary}
                  className="mt-4 rounded-lg bg-[hsl(221_83%_53%)] px-3 py-2 text-sm font-medium text-white hover:opacity-90"
                >
                  重试
                </button>
              </div>
            </div>
          )}
        >
          <RoutesComponent />
          {createPortal(<Toaster />, document.body)}
        </ErrorBoundary>
      </AppContainer>
    </BrowserRouter>
  );
};

// Service Worker 注册与更新体验：新版本可用时提示用户，支持「稍后更新」与
// 「安全更新」。安全更新前会先保存草稿，并在存在未保存草稿/未同步操作时
// 展示影响、拒绝强制刷新（纯逻辑见 client/src/lib/swRegistration.ts）。
if (typeof navigator !== 'undefined' && 'serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    const sw = registerServiceWorker({
      onUpdateAvailable(/* version */) {
        toast('新版本可用', {
          description: '是否立即更新？更新前会先保存草稿。',
          action: {
            label: '安全更新',
            onClick: () => {
              void sw.safeUpdate().then((decision) => {
                if (!decision.applied) {
                  toast('暂无法立即更新', { description: decision.reason });
                }
              });
            },
          },
          cancel: {
            label: '稍后更新',
            // 点击即关闭提示；waiting worker 保持 idle，下次完整刷新时再接管。
            onClick: () => undefined,
          },
        });
      },
      async getPendingWork() {
        try {
          const db = await openOfflineDb();
          const [drafts, pending] = await Promise.all([
            db.drafts.count(),
            db.pendingActions.count(),
          ]);
          db.close();
          return { drafts, pendingActions: pending };
        } catch {
          return { drafts: 0, pendingActions: 0 };
        }
      },
    });
    // 供后续手动触发（如设置面板）复用同一控制器。
    (window as unknown as { __ewohSwUpdate?: typeof sw }).__ewohSwUpdate = sw;
  });
}

// Wave W8「可观测性 / 安全」— 低风险全局接线：
// 未处理异常采集、Web Vitals 采集、空闲会话计时重置（用户活动时重置）。
window.addEventListener('error', (event) => {
  captureUnhandledError(event.error ?? event.message, 'window.error');
});
window.addEventListener('unhandledrejection', (event) => {
  captureUnhandledError(event.reason, 'unhandledrejection');
});
startWebVitalsCollection();
// 会话安全：空闲计时随用户活动重置；收到其它标签页登出广播时同步退出（清令牌并回登录页）。
initSessionSecurity({
  onRemoteLogout() {
    clearTokens();
    const base = CLIENT_BASE_PATH || '/';
    if (!window.location.pathname.startsWith(`${base}login`)) {
      window.location.assign(`${base}login`);
    }
  },
});

// 工业 UX：高对比模式（prefers-contrast: more）→ 为根元素切换 high-contrast 类。
// 状态/危险信息同时用图标与文字表达，不只依靠颜色（见 ux009-uxindustrial 浏览器测试）。
{
  const mql = window.matchMedia('(prefers-contrast: more)');
  applyContrastClass(mql);
  const onContrastChange = (): void => {
    applyContrastClass(mql);
  };
  if (mql.addEventListener) {
    mql.addEventListener('change', onContrastChange);
  } else {
    mql.addListener(onContrastChange);
  }
}

// 前端指标真正进入后端：页面隐藏时 sendBeacon 投递 + 周期性冲刷 + 重连时补投。
installPagehideFlush();
const METRICS_FLUSH_INTERVAL_MS = 15_000;
const metricsTimer = window.setInterval(() => {
  void flush();
}, METRICS_FLUSH_INTERVAL_MS);
window.addEventListener('online', () => {
  void flush();
});
// 页面卸载时清理定时器，避免泄漏。
window.addEventListener('beforeunload', () => {
  window.clearInterval(metricsTimer);
});

createRoot(document.getElementById('root')!).render(<MainApp />);

// 挂载后做一次白屏检测（纯观测，不干预渲染）。
requestAnimationFrame(() => {
  detectWhiteScreen(document);
});
