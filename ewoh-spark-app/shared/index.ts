/**
 * 前后端共享契约 barrel（P2-SHARED-001 渐进迁移第一步）。
 *
 * 现状：全部类型集中在 `api.interface.ts`（约 2045 行 / 129 个 type-interface）。
 * 迁移策略：保持 `@shared/api.interface` 与 `@shared` 两条 import 路径同时可用，
 * 后续按域拆分为 shared/auth, shared/world, shared/scheduler 等子模块时，
 * 仅需更新本 barrel（及各子模块的 index.ts），**不改动任何 importer**。
 */
export * from './api.interface';
