import {
  HttpException,
  HttpStatus,
  type ValidationError,
  ValidationPipe,
} from '@nestjs/common';

export function mapValidationErrors(
  errors: ValidationError[],
): Record<string, string[]> {
  const fieldErrors: Record<string, string[]> = {};
  const walk = (items: ValidationError[], prefix = '') => {
    for (const item of items) {
      const key = prefix ? `${prefix}.${item.property}` : item.property;
      if (item.constraints) {
        fieldErrors[key] = Object.values(item.constraints);
      }
      if (item.children?.length) {
        walk(item.children, key);
      }
    }
  };
  walk(errors);
  return fieldErrors;
}

export function createValidationExceptionFactory() {
  return (errors: ValidationError[]) => {
    const fieldErrors = mapValidationErrors(errors);
    return new HttpException(
      {
        error: {
          code: 'VALIDATION_ERROR',
          message: '请求参数校验失败',
          fieldErrors,
          timestamp: Date.now(),
        },
      },
      HttpStatus.UNPROCESSABLE_ENTITY,
    );
  };
}

export function createEwohValidationPipe(): ValidationPipe {
  return new ValidationPipe({
    whitelist: false,
    transform: true,
    forbidUnknownValues: true,
    exceptionFactory: createValidationExceptionFactory(),
  });
}
