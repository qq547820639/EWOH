import { Logger } from '@nestjs/common';

/**
 * 「记日志后原样重抛」的错误收尾工具——跨 service 单一事实源。
 *
 * ## 为什么存在
 * 后端曾有大量形如
 * ```ts
 * } catch (error) {
 *   this.logger.error('getEntities 失败', error);
 *   throw error;
 * }
 * ```
 * 的样板。它不是纯冗余：重抛意味着 HTTP 状态码与异常对象完全不变，
 * try/catch 的唯一价值就是那条日志。因此本工具收敛的**只是日志语句本身**，
 * 而非删除错误处理——删除会丢掉可观测性，且会让「错误发生」与「错误被吞」
 * 在代码上不可区分。
 *
 * ## 为什么不使用全局 ExceptionFilter / 拦截器（业界常见方案）
 * 本项目已注册 `GlobalExceptionFilter`（见 `app.module.ts` 的 `APP_FILTER`），
 * 它已在请求边界统一记录。再叠一层全局日志会**重复记录**同一异常。
 * 且这些日志携带业务上下文（如 `bindDevice 失败 deviceId=xxx`），
 * 请求边界拿不到方法级信息。故选择显式的点状收敛。
 *
 * ## 语义契约
 * - **原样重抛**：不改写、不包装异常对象。调用方（Nest 异常过滤器）依赖
 *   原始错误上的 `getStatus()`，包装会改变对外 HTTP 状态码。
 * - 返回类型为 `never`：类型层面确保调用点无法「记录后忘记重抛」。
 */
export type ServiceLogger = Pick<Logger, 'error' | 'warn'>;

/**
 * 记录一条错误日志并原样重抛。
 *
 * @param logger 目标 logger（通常是 service 内的 `this.logger`）
 * @param context 日志上下文，如 `` `getEntity 失败 entityId=${id}` ``
 * @param error 捕获到的异常
 * @param options `isExpected: true` 表示预期内业务异常（如 404/400），
 *   此时**跳过日志**直接重抛，避免正常业务分支污染错误日志。
 *   默认为 false（即记录）。
 * @throws 与传入 `error` 完全相同的对象引用
 */
export function rethrowWithLog(
  logger: ServiceLogger,
  context: string,
  error: unknown,
  options: { isExpected?: boolean } = {},
): never {
  if (!options.isExpected) logger.error(context, error);
  throw error;
}

/**
 * `rethrowWithLog` 的守卫变体：命中任一指定异常类型时视为预期内业务异常，
 * 跳过日志直接重抛。
 *
 * 用于「404/400 属于正常业务分支，不该刷错误日志」的场景，
 * 等价于原先的
 * ```ts
 * if (error instanceof NotFoundException || error instanceof BadRequestException) throw error;
 * this.logger.error('xxx 失败', error);
 * throw error;
 * ```
 *
 * @param expected 预期内异常构造函数列表（可传多个，对应 `A || B` 守卫）
 */
export function rethrowWithGuard(
  logger: ServiceLogger,
  context: string,
  error: unknown,
  ...expected: ReadonlyArray<abstract new (...args: never[]) => Error>
): never {
  return rethrowWithLog(logger, context, error, {
    isExpected: expected.some((ctor) => error instanceof ctor),
  });
}
