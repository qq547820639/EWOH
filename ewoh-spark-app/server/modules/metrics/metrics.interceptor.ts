import {
  CallHandler,
  ExecutionContext,
  HttpException,
  Injectable,
  NestInterceptor,
} from '@nestjs/common';
import { Observable, tap } from 'rxjs';
import { MetricsService } from './metrics.service';

/** 客户端中途断连（无 finish）时的记录状态码（nginx 惯例语义）。 */
const STATUS_CLIENT_CLOSED = 499;

@Injectable()
export class MetricsInterceptor implements NestInterceptor {
  constructor(private readonly metrics: MetricsService) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    if (context.getType() !== 'http') {
      return next.handle();
    }
    const request = context.switchToHttp().getRequest<{
      method: string;
      path: string;
      route?: { path?: string };
    }>();
    const response = context.switchToHttp().getResponse<{
      statusCode: number;
      on?: (event: string, listener: () => void) => void;
    }>();
    // NEST-416：仅路由模板进计数键；原始 path（404/参数化路径）交由
    // MetricsService 归一为 'unmatched'（固定基数）。
    const route = request.route?.path ?? 'unmatched';
    this.metrics.beginRequest();

    // P2（2026-08-19 审计）：tap.next 时刻 Express 尚未写入最终状态码——
    // response.statusCode 仍是默认 200，POST 端点的 201 全部被记成 200。
    // 真实响应（有 on）改挂 'finish' 事件：此时状态码为最终值（成功路径
    // 的 @HttpCode 与异常过滤器写入的码均已落盘），SSE 长连接也在流真正
    // 结束时结束计时。'close' 兜底客户端断连（finish 不触发）。
    if (typeof response.on === 'function') {
      let ended = false;
      const endOnce = (status: number) => {
        if (ended) return;
        ended = true;
        this.metrics.endRequest(request.method, route, status);
      };
      response.on('finish', () => endOnce(response.statusCode ?? 200));
      response.on('close', () =>
        endOnce(
          response.statusCode && response.statusCode !== 200
            ? response.statusCode
            : STATUS_CLIENT_CLOSED,
        ),
      );
      return next.handle();
    }

    // mock response（无 on，如单测替身）：保留 tap 时刻直读语义。
    return next.handle().pipe(
      tap({
        next: () => this.metrics.endRequest(request.method, route, response.statusCode ?? 200),
        // NEST-429：error 路径此时 response.statusCode 仍是默认 200——
        // 从异常对象取真实状态码（HttpException.getStatus，其余 500）。
        error: (error: unknown) =>
          this.metrics.endRequest(
            request.method,
            route,
            error instanceof HttpException
              ? error.getStatus()
              : (response.statusCode && response.statusCode !== 200
                ? response.statusCode
                : 500),
          ),
      }),
    );
  }
}
