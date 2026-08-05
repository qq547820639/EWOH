import { defineConfig, devices } from '@playwright/test';
import base from './playwright.config';

/**
 * 视觉回归专用配置：复用主配置，但将截图基线单独存放于 `test/browser/snapshots/visual`，
 * 并设置统一的像素容差（避免低端平板/字体渲染差异导致误报）。
 *
 * [视觉基线策略（重要）]
 *  - 主金基线（canonical golden）= Linux 桌面 Chromium。CI 在 Linux 上生成与对比基线，
 *    文件名带平台后缀（snapshotPathTemplate 的 `{platform}`，Linux 下为 `-linux`）。
 *  - 本地 macOS 开发者可生成带本平台后缀的基线（`-darwin`）做本地自检，但不得覆盖
 *    Linux 基线；合并/发布以 Linux Chromium 基线为准。
 *  - 容差策略：maxDiffPixelRatio/timeout 等只做「抗平台渲染抖动」的合理设置，
 *    禁止无限抬高容差来掩盖真实回归；若出现真实像素回归，应修复代码而非放宽容差。
 *  - 基础容差：maxDiffPixelRatio 0.02 / maxDiffPixels 200（渲染/抗锯齿差异），
 *    动画已禁用、caret 已隐藏。
 *
 * 使用：
 *   # CI / Linux：生成或刷新 Linux Chromium 金基线
 *   npm run test:browser:visual -- --update-snapshots
 *   # 对比回归
 *   npm run test:browser:visual
 */
export default defineConfig({
  ...base,
  // 视觉回归仅在单工程（桌面 Chromium）下运行，避免多工程矩阵互相覆盖基线截图。
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],
  testMatch: /ux009-visual\.spec\.js/,
  expect: {
    toHaveScreenshot: {
      maxDiffPixelRatio: 0.02,
      maxDiffPixels: 200,
      animations: 'disabled',
      caret: 'hide',
    },
  },
  snapshotPathTemplate:
    '{testDir}/snapshots/{testFilePath}/{arg}-{platform}{ext}',
});