/**
 * TS e2e 全局环境前置（setupFiles：在任何被测模块 import 之前执行）。
 *
 * 为什么必须在 setupFiles：IngestGuard 等组件在**模块加载期**读取环境配置——
 * 各 spec 在 beforeAll 里 process.env 赋值对它们太晚（2026-09-16 fresh-runtime
 * 库实测：/api/ingest/* 稳定 401 INGEST_API_KEY_NOT_CONFIGURED）。
 *
 * 值域与 test/helpers/e2e-app.ts 的接线同源（legacy 无绑定模式：org 取
 * X-Org-Id 头；insecure dev 模式允许无 key 请求——仅非 production）。
 */
process.env.INGEST_API_KEY = process.env.INGEST_API_KEY || 'e2e-ingest-key';
process.env.INGEST_RATE_LIMIT = process.env.INGEST_RATE_LIMIT || '100000';
process.env.INGEST_INSECURE_DEV_MODE = process.env.INGEST_INSECURE_DEV_MODE || 'true';
process.env.EWOH_SIMULATOR_DISABLED = process.env.EWOH_SIMULATOR_DISABLED || '1';
