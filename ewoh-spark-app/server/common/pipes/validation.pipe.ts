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
    // NEST-510 修复（2026-08-17）：whitelist+forbidNonWhitelisted 收敛 mass
    // assignment 面——未知属性不再透传到 DTO 实例（原 whitelist:false 会把
    // 非声明字段原样保留在 transformed 对象上）。
    whitelist: true,
    forbidNonWhitelisted: true,
    transform: true,
    forbidUnknownValues: true,
    exceptionFactory: createValidationExceptionFactory(),
  });
}
