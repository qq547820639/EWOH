/**
 * NEST-434（2026-08-17 审计整改 W3）：平台保留哨兵 org 常量统一登记。
 *
 * 背景：knowledge.PLATFORM_SHARED_ORG_ID 与 ark.GLOBAL_ORG_SENTINEL 是两个
 * 语义重叠但值不同的“平台保留 org”，散落在各模块内各自定义，易混用。
 *
 * 终态裁决：保留两个哨兵值不合并——DB 层已有历史数据落在两个值上
 * （schema.ts knowledge_entry 唯一索引 coalesce 用 …4000-8000-…；AI 配置行
 * 落全零哨兵），合并值需数据迁移（W1 域 standalone_057 已收口，不再追加）。
 * 本文件作为唯一登记处，各模块从这里取值并注释语义，防止第三处哨兵再冒出。
 */

/**
 * 平台共享层哨兵（ADR-018 Amendment 1 决策 2）：
 * knowledge_entry 的 global/industry 共享层条目归属；与
 * schema.ts 的 `coalesce(org_id, '00000000-0000-4000-8000-000000000000'::uuid)`
 * 以及 standalone_057 恢复的 ewoh_org_select 共享层读 policy 对齐。
 */
export const PLATFORM_SHARED_ORG_ID = '00000000-0000-4000-8000-000000000000';

/**
 * AI 全局配置哨兵：ewoh_scheduler_config 的 `ai.provider.ark` 行归属
 * （系统级共享 AI 凭据，不按租户隔离；全零 UUID 保证 ON CONFLICT 正常工作）。
 */
export const AI_GLOBAL_ORG_SENTINEL = '00000000-0000-0000-0000-000000000000';
