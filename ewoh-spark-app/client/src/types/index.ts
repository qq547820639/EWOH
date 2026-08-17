// client/src/types/index.ts

// CLI-608~611：原 ./common 的 IUserProfile/IUserStatus/IFileAttachment 与
// Window 增强均为零引用死类型（与 UserContext/FileUpload 契约形状不一致），已删除。
export * from './ewoh';
// 由 openapi/ewoh.yaml 与 openapi/work-orchestration.yaml 生成的契约类型。
// 生成命令：npm run gen:openapi（见 scripts/gen-openapi.js）。
export type { components as OpenAPIComponents, paths as OpenAPIPaths } from './openapi';
export type { components as WorkOrchestrationComponents } from './work-orchestration';
