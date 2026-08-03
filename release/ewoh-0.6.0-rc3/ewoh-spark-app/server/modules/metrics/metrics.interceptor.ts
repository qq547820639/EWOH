import {
  CallHandler,
  ExecutionContext,
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
    const route = request.route?.path ?? request.path ?? 'unknown';
    this.metrics.beginRequest();
    return next.handle().pipe(
      tap({
        next: () => this.metrics.endRequest(request.method, route, response.statusCode ?? 200),
        error: () => this.metrics.endRequest(request.method, route, response.statusCode ?? 500),
      }),
    );
  }
}
