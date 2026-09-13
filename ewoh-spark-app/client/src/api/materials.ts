import { axiosForBackend } from '../lib/http';
import type {
  MaterialBalance,
  MaterialDemandProjection,
  MaterialImpactRow,
  MaterialInventoryProjection,
} from '@shared/material-inventory';

/**
 * 物料库存读面（NO-27a / NO-28a）。
 *
 * 响应同时给出：物料余额（带证据事件 id）、未完工订单需求与缺口影响面、
 * 未声明 BOM 口径/数据非法的订单、以及无法解析的历史载荷——缺口必须看得见。
 */
export interface MaterialInventoryResponse extends MaterialInventoryProjection {
  scannedEvents: number;
  movementEvents: number;
  scannedOrders: number;
  impact: MaterialImpactRow[];
  demand: MaterialDemandProjection;
  /** NO-29a：库存全量聚合声明与订单扫描是否触顶（缺口必须看得见）。 */
  aggregationComplete?: boolean;
  aggregationNote?: string;
  ordersTruncated?: boolean;
}

export async function getMaterialInventory(): Promise<
  MaterialInventoryResponse & { balances: MaterialBalance[] }
> {
  const res = await axiosForBackend({ url: '/api/materials/inventory', method: 'GET' });
  return res.data;
}

export async function getMaterialMovementTypes(): Promise<{ types: string[] }> {
  const res = await axiosForBackend({ url: '/api/materials/movement-types', method: 'GET' });
  return res.data;
}
