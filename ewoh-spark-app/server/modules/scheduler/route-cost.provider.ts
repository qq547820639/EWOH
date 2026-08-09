/* RouteCostProvider 兼容薄封装（Phase 2 / P2-T1）。
 *
 * 实现已演进至 travel-cost.service.ts（TravelCostService：estimate 显式携带
 * fallbackReason/dataQuality + RouteCostMatrix 构建 + 决策 D-D 落库缓存）。
 * 本文件保留类名导出，使既有 import { RouteCostProvider } 与 DI 注入保持不变
 * （公开 API 不变）；scheduler.module 注册的是 TravelCostService（同一类）。
 */
export {
  TravelCostService as RouteCostProvider,
  type RouteCost,
} from './travel-cost.service';
