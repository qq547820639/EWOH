/* Dashboard 查询参数清洗测试（NEST-347/348/349，2026-08-17 审计整改）。
 *
 * 钉死：limit NaN/负数拒绝、上限钳制；batteryMin/Max NaN 拒绝；
 * page/pageSize NaN 拒绝。防止 gte(col, NaN) 未定义行为与 1e9 全表拉取。
 */
/// <reference types="jest" />
import { BadRequestException } from '@nestjs/common';
import {
  parseLimitParam,
  parseBatteryParam,
  parsePageParam,
  normalizePagination,
  MAX_LIST_LIMIT,
} from './dashboard.service';

describe('dashboard 查询参数清洗（NEST-347/348/349）', () => {
  it('limit：缺省回退、NaN 拒绝、上限钳制', () => {
    expect(parseLimitParam(undefined, 50)).toBe(50);
    expect(parseLimitParam('', 50)).toBe(50);
    expect(parseLimitParam('100')).toBe(100);
    // 超大值钳到上限，不再全表拉取。
    expect(parseLimitParam('1000000000')).toBe(MAX_LIST_LIMIT);
    // NaN / 非法值显式拒绝。
    expect(() => parseLimitParam('abc')).toThrow(BadRequestException);
    expect(() => parseLimitParam('12abc')).toThrow(BadRequestException);
    expect(() => parseLimitParam('-5')).toThrow(BadRequestException);
    expect(() => parseLimitParam('0')).toThrow(BadRequestException);
  });

  it('batteryMin/Max：NaN 拒绝（不再把 NaN 传给 gte/lte）', () => {
    expect(parseBatteryParam(undefined, 'batteryMin')).toBeUndefined();
    expect(parseBatteryParam('', 'batteryMax')).toBeUndefined();
    expect(parseBatteryParam('30', 'batteryMin')).toBe(30);
    expect(() => parseBatteryParam('abc', 'batteryMin')).toThrow(BadRequestException);
    expect(() => parseBatteryParam('NaN', 'batteryMax')).toThrow(BadRequestException);
  });

  it('page：NaN / 非正数拒绝', () => {
    expect(parsePageParam(undefined)).toBe(1);
    expect(parsePageParam('3')).toBe(3);
    expect(() => parsePageParam('x')).toThrow(BadRequestException);
    expect(() => parsePageParam('0')).toThrow(BadRequestException);
  });

  it('normalizePagination：pageSize 上限 100', () => {
    expect(normalizePagination(1, 20)).toEqual({ page: 1, pageSize: 20 });
    expect(normalizePagination(2, 100000).pageSize).toBe(100);
    expect(normalizePagination(0, 0)).toEqual({ page: 1, pageSize: 1 });
  });
});
