import {
  CallHandler,
  ExecutionContext,
  HttpException,
  Injectable,
  NestInterceptor,
} from '@nestjs/common';
import { Observable, tap } from 'rxjs';
import { MetricsService } from './metrics.service';

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
    const response = context.switchToHttp().getResponse<{ statusCode: number }>();
    // NEST-416：仅路由模板进计数键；原始 path（404/参数化路径）交由
    // MetricsService 归一为 'unmatched'（固定基数）。
    const route = request.route?.path ?? 'unmatched';
    this.metrics.beginRequest();
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
