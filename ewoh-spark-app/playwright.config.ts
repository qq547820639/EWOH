import { defineConfig, devices } from '@playwright/test';

/**
 * UX-007/UX-0011 跨浏览器 + 工业无障碍浏览器矩阵。
 *
 * 显式多工程矩阵：
 *   - chromium / firefox / webkit：桌面 1440x900 跨浏览器
 *   - mobile-chromium：手机 390x844（isMobile + hasTouch）
 *   - industrial-tablet：工业平板/触控 1024x768（hasTouch:true）
 *   - reduced-motion：1280x720 + prefers-reduced-motion: reduce（低性能/动画减弱）
 *
 * testDir 保持 ./test/browser，既有 UX-009 用例继续在本矩阵下运行。
 * 视觉回归请使用 playwright.visual.config.ts（单工程，避免多工程基线冲突）。
 */
export default defineConfig({
  testDir: './test/browser',
  timeout: 120_000,
  fullyParallel: false,
  workers: 1,
  reporter: [['list']],
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
    {
      name: 'firefox',
      use: { ...devices['Desktop Firefox'] },
    },
    {
      name: 'webkit',
      use: { ...devices['Desktop Safari'] },
    },
    {
      name: 'mobile-chromium',
      use: {
        ...devices['Pixel 7'],
        viewport: { width: 390, height: 844 },
      },
    },
    {
      name: 'industrial-tablet',
      use: {
        browserName: 'chromium',
        viewport: { width: 1024, height: 768 },
        hasTouch: true,
        isMobile: false,
      },
    },
    {
      name: 'reduced-motion',
      use: {
        browserName: 'chromium',
        viewport: { width: 1280, height: 720 },
        reducedMotion: 'reduce',
      },
    },
  ],
  use: {
    headless: true,
  },
});