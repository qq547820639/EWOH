/**
 * 查询参数边界清洗（query param clamping）——跨端单一事实源。
 *
 * ## 为什么存在
 * `Math.min(Math.max(1, Math.trunc(x)), 500)` 这一 limit 清洗表达式曾在 5 个
 * service 中逐字重复（organization / oee / agent-orchestrator / timeline /
 * dashboard），上限常量 500 更是在其中 4 处硬编码为字面量。任何一处漏改上限或
 * 漏掉 `Math.trunc` 都会静默改变 API 行为，且无法被类型系统捕获。
 *
 * ## 语义契约：与历史实现逐位等价（含病态输入）
 * 本模块刻意**不修复**历史实现在 `NaN` / `±Infinity` 下的行为，而是逐位复刻：
 *
 * | 输入      | 历史内联表达式结果 | 本模块结果 |
 * |-----------|------------------|-----------|
 * | `NaN`     | `NaN`（透传给驱动层）| `NaN`（一致）|
 * | `+Infinity` | `500`（上限截断）| `500`（一致）|
 * | `-Infinity` | `1`（下限抬升） | `1`（一致）  |
 *
 * 理由：这些值在当前调用链上不可达——各 controller 在进入 service 前已用
 * `Number.isFinite` 过滤（如 `agent.controller.ts` 的 `listTasks`）。若在此处
 * "顺手修正" NaN 行为，会让本模块与调用方的既有防护产生语义分叉，反而更难推理。
 * NaN 防护应作为调用方的显式契约保留，而非隐藏在截断函数里。
 *
 * 另注 `??` 与 `Number.isFinite` 的区别：历史表达式用 `v ?? fb`，只对
 * `null`/`undefined` 生效；本模块的入参类型已收窄为 `number | undefined`，
 * 二者语义等价（`NaN` 在两侧都走"非空"分支）。
 *
 * ## 与其他分页工具的边界（三者语义不同，不可互换）
 * - 本模块：**静默截断**，非法值不报错。
 * - `server/modules/dashboard/dashboard.service.ts` 的 `parseLimitParam` /
 *   `parsePageParam`：**非法值抛 BadRequestException**（400）。
 * - `server/modules/shared/pagination.ts` 的 `parseCursorQuery`：静默回退默认值。
 *
 * 选哪个取决于接口契约要求，不取决于代码简洁。
 */

/** 列表查询默认上限，与历史各 service 的硬编码 500 保持一致。 */
export const MAX_LIST_LIMIT = 500;

/** 事件时间窗上限：7 天（168h）。事件表高写入量，无窗全表扫描在峰值会拖垮平台。 */
export const MAX_EVENT_WINDOW_HOURS = 168;

/** 事件时间窗缺省值：24h。 */
export const DEFAULT_EVENT_WINDOW_HOURS = 24;

/**
 * 清洗列表 limit：截断小数、下限 1、上限 `max`（默认 {@link MAX_LIST_LIMIT}）。
 *
 * 缺省（`undefined`）走 `fallback`。`NaN` / `±Infinity` 按历史语义透传
 * （详见文件头"语义契约"表）。
 *
 * @param value 原始值（来自已通过 `Number.isFinite` 过滤的 query 或 DTO）
 * @param fallback `value` 为 `undefined` 时的缺省值
 * @param max 上限
 */
export function clampListLimit(
  value: number | undefined,
  fallback: number,
  max: number = MAX_LIST_LIMIT,
): number {
  return Math.min(Math.max(1, Math.trunc(value ?? fallback)), max);
}

/**
 * 清洗列表 offset：截断小数、下限 0。无上限（总页数由调用方控制）。
 *
 * @param value 原始值
 */
export function clampListOffset(value: number | undefined): number {
  return Math.max(0, Math.trunc(value ?? 0));
}

/**
 * 清洗事件查询时间窗（小时）：缺省 {@link DEFAULT_EVENT_WINDOW_HOURS}，
 * clamp 到 `[1, MAX_EVENT_WINDOW_HOURS]`。
 *
 * @param hours 原始小时数
 * @param fallback `hours` 为 `undefined` 时的缺省值
 */
export function clampEventWindowHours(
  hours: number | undefined,
  fallback: number = DEFAULT_EVENT_WINDOW_HOURS,
): number {
  const resolved = hours != null && Number.isFinite(hours) ? Math.trunc(hours) : fallback;
  return Math.min(Math.max(resolved, 1), MAX_EVENT_WINDOW_HOURS);
}
