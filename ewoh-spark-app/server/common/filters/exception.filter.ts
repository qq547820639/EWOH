import {
  ExceptionFilter,
  Catch,
  ArgumentsHost,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import type { Request, Response } from 'express';
import { BusinessException } from '../interfaces/exception.interface';
import { HTTP_STATUS_TO_RESPONSE_CODE_MAP, ResponseCode } from '../constants/api_response_code';
import type { ApiErrorResponse } from '../interfaces/api_response.interface';

const RETRYABLE_STATUSES = new Set<number>([
  HttpStatus.TOO_MANY_REQUESTS,
  HttpStatus.INTERNAL_SERVER_ERROR,
  HttpStatus.BAD_GATEWAY,
  HttpStatus.SERVICE_UNAVAILABLE,
  HttpStatus.GATEWAY_TIMEOUT,
]);

function recommendedActionForStatus(status: number): string {
  if (status === HttpStatus.BAD_REQUEST || status === HttpStatus.UNPROCESSABLE_ENTITY) {
    return '请检查请求参数后重试';
  }
  if (status === HttpStatus.UNAUTHORIZED) {
    return '请重新登录后重试';
  }
  if (status === HttpStatus.FORBIDDEN) {
    return '请联系管理员开通权限';
  }
  if (status === HttpStatus.NOT_FOUND) {
    return '请确认资源 ID 或筛选条件';
  }
  if (status === HttpStatus.CONFLICT) {
    return '请检查数据冲突并刷新后操作';
  }
  if (status === HttpStatus.TOO_MANY_REQUESTS) {
    return '请稍后重试';
  }
  if (status >= 500) {
    return '请稍后重试；如持续失败请联系管理员';
  }
  return '请检查操作后重试';
}

function resolveRequestId(
  request: Request & { id?: string },
  response: Response,
): string {
  const traceHeader = request.headers?.['x-trace-id'];
  const requestHeader = request.headers?.['x-request-id'];
  const responseTrace =
    typeof response.getHeader === 'function'
      ? response.getHeader('x-trace-id')
      : undefined;
  const headerValue =
    typeof responseTrace === 'string'
      ? responseTrace
      : typeof traceHeader === 'string'
        ? traceHeader
        : typeof requestHeader === 'string'
          ? requestHeader
          : undefined;
  const candidate = typeof headerValue === 'string' && headerValue.trim() ? headerValue : request.id;
  const requestId = candidate && String(candidate).trim() ? String(candidate).trim() : randomUUID();
  if (typeof response.setHeader === 'function') {
    response.setHeader('x-request-id', requestId);
  }
  return requestId;
}

// 全局异常过滤器，用于捕获所有未处理的异常
@Catch()
export class GlobalExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger(GlobalExceptionFilter.name);

  catch(exception: unknown, host: ArgumentsHost) {
    const ctx = host.switchToHttp();
    const response = ctx.getResponse<Response>();
    const request = ctx.getRequest<Request & { id?: string }>();

    // 如果响应头已发送，则不处理
    if (response.headersSent) {
      return;
    }
    const requestId = resolveRequestId(request, response);

    let errorResponse: Omit<ApiErrorResponse, 'httpStatus'>;
    let httpStatus: HttpStatus;

    if (exception instanceof BusinessException) {
      // 业务异常
      httpStatus = exception.httpStatus;
      errorResponse = this.withRequestContext(
        {
          code: exception.code,
          message: exception.message,
          details: exception.details,
          fieldErrors: exception.fieldErrors,
          timestamp: Date.now(),
        },
        requestId,
        httpStatus,
      );
    } else if (exception instanceof HttpException) {
      // HTTP异常
      httpStatus = exception.getStatus() as HttpStatus;
      const exceptionResponse = exception.getResponse();
      const structuredResponse = this.extractStructuredResponse(exceptionResponse);

      if (structuredResponse) {
        errorResponse = this.withRequestContext(
          structuredResponse.error as Omit<
            ApiErrorResponse['error'],
            'requestId' | 'retryable' | 'recommendedAction' | 'errorCode'
          >,
          requestId,
          httpStatus,
        );
      } else {
        const mappedCode = HTTP_STATUS_TO_RESPONSE_CODE_MAP[httpStatus];
        errorResponse = this.withRequestContext(
          {
            code: mappedCode ?? (httpStatus >= 500 ? ResponseCode.INTERNAL_ERROR : ResponseCode.BAD_REQUEST),
            message:
              typeof exceptionResponse === 'string' ? exceptionResponse : exception.message,
            details:
              typeof exceptionResponse === 'string' ? exceptionResponse : undefined,
            timestamp: Date.now(),
          },
          requestId,
          httpStatus,
        );
      }
    } else if (
      typeof exception === 'object' &&
      exception !== null &&
      (exception as { code?: unknown }).code === '22P02'
    ) {
      // Postgres invalid_text_representation：路径/查询参数与列类型不匹配（最常见是非法 UUID）
      // 与「合法 UUID 但记录不存在」走同一条 not-found 语义，避免 500 噪声
      httpStatus = HttpStatus.NOT_FOUND;
      errorResponse = this.withRequestContext(
        {
          code: ResponseCode.NOT_FOUND,
          message: '资源不存在',
          details: 'Invalid identifier or input type',
          timestamp: Date.now(),
        },
        requestId,
        httpStatus,
      );
    } else {
      // 未知异常
      httpStatus = HttpStatus.INTERNAL_SERVER_ERROR;
      const error = exception instanceof Error ? exception : undefined;
      this.logger.error('Unhandled request error', error?.stack);
      const exposeDiagnostics = process.env.NODE_ENV !== 'production';
      const cause = error?.cause;
      errorResponse = this.withRequestContext(
        {
          code: ResponseCode.INTERNAL_ERROR,
          message: '服务器内部错误',
          details:
            exposeDiagnostics && error?.message ? error.message : 'Unhandled server error',
          ...(exposeDiagnostics && error?.stack ? { stack: error.stack } : {}),
          ...(exposeDiagnostics && cause
            ? { cause: cause instanceof Error ? cause.message : String(cause) }
            : {}),
          timestamp: Date.now(),
        },
        requestId,
        httpStatus,
      );
    }

    response.status(httpStatus).json(errorResponse);
  }

  private withRequestContext(
    error: Omit<
      ApiErrorResponse['error'],
      'requestId' | 'retryable' | 'recommendedAction' | 'errorCode'
    >,
    requestId: string,
    httpStatus: number,
  ): Omit<ApiErrorResponse, 'httpStatus'> {
    return {
      error: {
        ...error,
        errorCode: error.code,
        requestId,
        retryable: RETRYABLE_STATUSES.has(httpStatus),
        recommendedAction: recommendedActionForStatus(httpStatus),
      },
    };
  }

  private extractStructuredResponse(
    value: unknown,
  ): Omit<ApiErrorResponse, 'httpStatus'> | undefined {
    if (typeof value !== 'object' || value === null) {
      return undefined;
    }
    const error = (value as { error?: unknown }).error;
    if (typeof error !== 'object' || error === null) {
      return undefined;
    }
    const candidate = error as { code?: unknown; message?: unknown };
    if (typeof candidate.code !== 'string' || typeof candidate.message !== 'string') {
      return undefined;
    }
    return value as Omit<ApiErrorResponse, 'httpStatus'>;
  }
}
