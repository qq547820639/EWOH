// parse-date-input.ts — 日期入参解析（审计 P1「Date 校验范式推广」，2026-08-19）。
//
// 背景：MES/ERP/OEE 等写路径此前直接 `new Date(body.x)`——非法字符串产生
// Invalid Date，直送 postgres 抛 22007 → 稳定 500（同一请求永远 500）。
// world.service 已有一处 Number.isNaN(getTime()) 校验范式，本助手将其推广
// 为共享工具：非法日期显式 400（fail-fast，语义可见），null/空串语义保持
// （可选字段缺省 → null）。
import { BadRequestException } from '@nestjs/common';

/**
 * 解析可选日期入参：
 * - null/undefined/空串 → null（可选字段缺省语义）；
 * - 合法日期字符串/Date → Date；
 * - 非法值 → BadRequestException 400（字段名进错误信息，不产生稳定 500）。
 */
export function parseDateInput(
  value: string | Date | null | undefined,
  field: string,
): Date | null {
  if (value == null || value === '') return null;
  const parsed = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    throw new BadRequestException(`${field} 不是合法日期：${JSON.stringify(String(value))}`);
  }
  return parsed;
}
