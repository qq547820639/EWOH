import path from 'path';
import { defineConfig } from '@lark-apaas/fullstack-vite-preset';

/**
 * 手工 chunk 拆分（UX-008 / Task 11 性能与可复现性）。
 *
 * 目标：把重 vendor 库从入口 main chunk 中拆出，避免首屏一次加载过大的 JS，
 * 并消除构建时 "chunk larger than 800kB" 告警。heavy 模块（three.js / recharts /
 * cesium 等）已由 app.tsx 的 React.lazy 路由级懒加载，不进入首屏；这里仅横向拆分
 * 常驻在入口 chunk 里的框架/库。
 *
 * 注意：manualChunks 需要与 rollup 的 tree-shaking 并存，仅按模块路径前缀归类，
 * 不强制合并，避免造成重复模块。
 */
function manualChunks(idOrModule: { id: string } | string): string | undefined {
  const id = typeof idOrModule === 'string' ? idOrModule : idOrModule.id;
  if (!id || !id.includes('node_modules')) return undefined;

  // React 生态（不拆 react/react-dom 与业务耦合的小工具，保持单一 vendor-react）
  if (/node_modules[\\/](react|react-dom|react-router|react-router-dom|scheduler|scheduler\/)/.test(id)) {
    return 'vendor-react';
  }
  // 状态/数据层
  if (/node_modules[\\/](@tanstack|zustand|@reduxjs|react-redux|react-query|immer|use-sync-external-store)/.test(id)) {
    return 'vendor-state';
  }
  // 富文本编辑与代码高亮（tiptap + shiki 体积大）
  if (/node_modules[\\/](@tiptap|shiki|@shikijs|lowlight|highlight\.js|markdown-it|rehype|remark|hast-|unist-)/.test(id)) {
    return 'vendor-editor';
  }
  // 动画库
  if (/node_modules[\\/](framer-motion|motion|gsap|@emotion)/.test(id)) {
    return 'vendor-anim';
  }
  // 通用工具与表单
  if (/node_modules[\\/](lodash|date-fns|dayjs|zod|ajv|clsx|class-variance-authority|tailwind-merge|radix-ui|@radix-ui|cmdk|sonner|vaul|@hookform|react-hook-form|@tanstack\/react-form)/.test(id)) {
    return 'vendor-ui';
  }
  return undefined;
}

export default defineConfig({
  base: process.env.EWOH_DEPLOY_TARGET === 'standalone' ? '/' : undefined,
  resolve: {
    alias: {
      '@': path.resolve(__dirname, 'client/src'),
    },
  },
  build: {
    chunkSizeWarningLimit: 1200,
    rollupOptions: {
      output: {
        manualChunks,
        // 确定性构建（TR-11.1）：入口 chunk 使用稳定文件名（不带内容哈希），
        // 打破「入口 ↔ 懒加载路由 chunk」之间的循环内容哈希引用。若不固定入口名，
        // Rollup 在计算循环 chunk 的 content hash 时解析顺序不确定，会导致两次相同
        // 源码构建产生不同的 chunk 文件名与聚合校验和。入口由 index.html 指向，
        // 其版本由构建版本号/缓存资源决定；路由 chunk 仍保留内容哈希做缓存失效。
        entryFileNames: 'assets/[name].js',
        chunkFileNames: 'assets/[name]-[hash].js',
        assetFileNames: 'assets/[name]-[hash][extname]',
      },
    },
  },
});