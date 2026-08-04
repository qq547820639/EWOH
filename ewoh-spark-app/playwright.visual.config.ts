import { defineConfig } from '@playwright/test';
import base from './playwright.config';

/**
 * 视觉回归专用配置：复用主配置，但将截图基线单独存放于 `test/browser/snapshots/visual`，
 * 并设置更宽松的像素容差（避免低端平板/字体渲染差异导致误报）。
 *
 * 使用：
 *   npm run test:browser:visual -- --update-snapshots   # 首次生成基线
 *   npm run test:browser:visual                          # 对比回归
 */
export default defineConfig({
  ...base,
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