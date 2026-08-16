import { createHash } from 'node:crypto';

/**
 * NO-05e（ADR-012）：EWOH 内部工单 ID 确定性推导。
 *
 * 内部 ID 由 EWOH 生成（sha256(originKind:originId) 前 12 hex），跨重试/跨实例
 * 稳定且幂等；第三方工单号（MES 工单号）仅作 evidence alias（ADR-006 原则：
 * 第三方 ID 不进内部 ID）。
 */
export function deriveWorkOrderId(originKind: string, originId: string): string {
  return `wo:${createHash('sha256')
    .update(`${originKind}:${originId}`)
    .digest('hex')
    .slice(0, 12)}`;
}
