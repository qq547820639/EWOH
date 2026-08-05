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
  startWebVitalsCollection,
} from './lib/observability';
import { initSessionSecurity } from './lib/sessionSecurity';

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

if (typeof navigator !== 'undefined' && 'serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').catch(() => {});
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
initSessionSecurity(); // 会话安全：空闲计时随用户活动重置

createRoot(document.getElementById('root')!).render(<MainApp />);

// 挂载后做一次白屏检测（纯观测，不干预渲染）。
requestAnimationFrame(() => {
  detectWhiteScreen(document);
});
