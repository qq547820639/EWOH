import { BadRequestException, NotFoundException } from '@nestjs/common';
import { rethrowWithGuard, rethrowWithLog, type ServiceLogger } from './rethrow-with-log';

function makeLogger() {
  const calls: { level: 'error' | 'warn'; context: string; error: unknown }[] = [];
  const logger: ServiceLogger = {
    error: (context: string, error?: unknown) => {
      calls.push({ level: 'error', context, error });
      return undefined as never;
    },
    warn: (context: string, error?: unknown) => {
      calls.push({ level: 'warn', context, error });
      return undefined as never;
    },
  };
  return { logger, calls };
}

describe('rethrowWithLog', () => {
  it('记录 error 日志后原样重抛同一个对象引用', () => {
    const { logger, calls } = makeLogger();
    const boom = new Error('db down');

    let thrown: unknown = null;
    try {
      rethrowWithLog(logger, 'getEntities 失败', boom);
    } catch (e) {
      thrown = e;
    }

    // 原样重抛：引用不变（包装会改变 HTTP 状态码）
    expect(thrown).toBe(boom);
    expect(calls).toHaveLength(1);
    expect(calls[0].level).toBe('error');
    expect(calls[0].context).toBe('getEntities 失败');
    expect(calls[0].error).toBe(boom);
  });

  it('不吞异常：一定抛出，不会静默返回', () => {
    const { logger } = makeLogger();
    expect(() => rethrowWithLog(logger, 'x 失败', new Error('e'))).toThrow('e');
  });

  it('isExpected=true 时跳过日志但仍原样重抛', () => {
    const { logger, calls } = makeLogger();
    const nf = new NotFoundException('设备不存在');

    expect(() => rethrowWithLog(logger, 'getDevice 失败', nf, { isExpected: true })).toThrow(
      NotFoundException,
    );
    expect(calls).toHaveLength(0);
  });

  it('isExpected=false（默认）时记录日志', () => {
    const { logger, calls } = makeLogger();
    expect(() =>
      rethrowWithLog(logger, 'getDevice 失败', new Error('x'), { isExpected: false }),
    ).toThrow();
    expect(calls).toHaveLength(1);
  });
});

describe('rethrowWithGuard', () => {
  it('命中守卫异常时跳过日志', () => {
    const { logger, calls } = makeLogger();
    expect(() =>
      rethrowWithGuard(logger, 'update 失败', new NotFoundException('无'), NotFoundException),
    ).toThrow(NotFoundException);
    expect(calls).toHaveLength(0);
  });

  it('未命中守卫时记录日志并重抛', () => {
    const { logger, calls } = makeLogger();
    const boom = new Error('db down');
    let thrown: unknown = null;
    try {
      rethrowWithGuard(logger, 'update 失败', boom, NotFoundException);
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBe(boom);
    expect(calls).toHaveLength(1);
    expect(calls[0].context).toBe('update 失败');
  });

  it('等价于原「if instanceof 守卫 + log + throw」三行语义', () => {
    const { logger, calls } = makeLogger();
    // BadRequest 属预期内 → 不记日志
    expect(() =>
      rethrowWithGuard(logger, 'x 失败', new BadRequestException('参数错'), BadRequestException),
    ).toThrow(BadRequestException);
    expect(calls).toHaveLength(0);
  });

  it('支持多类型守卫（等价于 `A || B` 守卫）', () => {
    const { logger, calls } = makeLogger();
    // 命中列表中的第二个类型
    expect(() =>
      rethrowWithGuard(
        logger,
        'dispatchPlan 失败',
        new NotFoundException('方案不存在'),
        BadRequestException,
        NotFoundException,
      ),
    ).toThrow(NotFoundException);
    expect(calls).toHaveLength(0);
  });

  it('多类型守卫全部未命中时记录日志', () => {
    const { logger, calls } = makeLogger();
    expect(() =>
      rethrowWithGuard(
        logger,
        'dispatchPlan 失败',
        new Error('db down'),
        BadRequestException,
        NotFoundException,
      ),
    ).toThrow();
    expect(calls).toHaveLength(1);
  });

  it('空守卫列表等价于无守卫（总是记录）', () => {
    const { logger, calls } = makeLogger();
    expect(() => rethrowWithGuard(logger, 'x 失败', new Error('e'))).toThrow();
    expect(calls).toHaveLength(1);
  });
});
