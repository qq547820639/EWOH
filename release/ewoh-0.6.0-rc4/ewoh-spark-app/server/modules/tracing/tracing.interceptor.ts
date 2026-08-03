import {
  CallHandler,
  ExecutionContext,
  Injectable,
  NestInterceptor,
} from '@nestjs/common';
import { randomBytes } from 'node:crypto';
import { catchError, defer, lastValueFrom, Observable, tap } from 'rxjs';
import { withRequestContext } from '../../common/request-context';
import { TracingService, type TraceRecord } from './tracing.service';

@Injectable()
export class TracingInterceptor implements NestInterceptor {
  constructor(private readonly tracingService: TracingService) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    if (context.getType() !== 'http') {
      return next.handle();
    }
    const http = context.switchToHttp();
    const request = http.getRequest<{
      method?: string;
      path?: string;
      route?: { path?: string };
    }>();
    const response = http.getResponse<{
      setHeader: (name: string, value: string) => void;
      statusCode?: number;
    }>();
    const traceId = randomBytes(16).toString('hex');
    const spanId = randomBytes(8).toString('hex');
    response.setHeader('x-trace-id', traceId);
    const startedAt = Date.now();
    const startedIso = new Date(startedAt).toISOString();
    const method = request.method ?? 'UNKNOWN';
    const path = request.route?.path ?? request.path ?? '';

    return defer(() =>
      withRequestContext({ requestId: traceId }, () =>
        lastValueFrom(
          next.handle().pipe(
            tap(() => {
              this.record(
                traceId,
                spanId,
                method,
                path,
                response.statusCode ?? 200,
                startedAt,
                startedIso,
              );
            }),
            catchError((error: unknown) => {
              const status =
                typeof (error as { status?: unknown })?.status === 'number'
                  ? Number((error as { status: unknown }).status)
                  : response.statusCode ?? 500;
              this.record(
                traceId,
                spanId,
                method,
                path,
                status,
                startedAt,
                startedIso,
                error instanceof Error
                  ? error.message
                  : error !== null && typeof error === 'object'
                    ? JSON.stringify(error)
                    : String(error),
              );
              throw error;
            }),
          ),
        ),
      ),
    );
  }

  private record(
    traceId: string,
    spanId: string,
    method: string,
    path: string,
    status: number,
    startedAt: number,
    startedIso: string,
    error?: string,
  ): void {
    const finishedAt = new Date().toISOString();
    const entry: TraceRecord = {
      traceId,
      spanId,
      method,
      path,
      status,
      durationMs: Date.now() - startedAt,
      startedAt: startedIso,
      finishedAt,
      error,
    };
    this.tracingService.record(entry);
  }
}
