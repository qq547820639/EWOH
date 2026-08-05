// client/src/types/index.ts

// 导出其他类型
export * from './common';
export * from './ewoh';
// 由 openapi/ewoh.yaml 与 openapi/work-orchestration.yaml 生成的契约类型。
// 生成命令：npm run gen:openapi（见 scripts/gen-openapi.js）。
export type { components as OpenAPIComponents, paths as OpenAPIPaths } from './openapi';
export type { components as WorkOrchestrationComponents } from './work-orchestration';
