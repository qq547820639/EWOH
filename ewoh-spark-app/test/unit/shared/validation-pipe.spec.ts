import { HttpException, HttpStatus, type ValidationError } from '@nestjs/common';
import { IsNotEmpty } from 'class-validator';
import {
  createEwohValidationPipe,
  createValidationExceptionFactory,
  mapValidationErrors,
} from '../../../server/common/pipes/validation.pipe';

class SampleDto {
  @IsNotEmpty()
  name!: string;
}

describe('validation pipe contract', () => {
  it('maps top-level class-validator constraints into fieldErrors', () => {
    const errors = [
      {
        property: 'deviceId',
        constraints: { isNotEmpty: 'deviceId should not be empty' },
      },
      {
        property: 'quantity',
        constraints: { isInt: 'quantity must be an integer' },
      },
    ] as ValidationError[];

    expect(mapValidationErrors(errors)).toEqual({
      deviceId: ['deviceId should not be empty'],
      quantity: ['quantity must be an integer'],
    });
  });

  it('flattens nested validation errors with dot paths', () => {
    const errors = [
      {
        property: 'pose',
        children: [
          {
            property: 'trunk_pitch_deg',
            constraints: { isNumber: 'trunk_pitch_deg must be a number' },
          },
        ],
      },
    ] as unknown as ValidationError[];

    expect(mapValidationErrors(errors)).toEqual({
      'pose.trunk_pitch_deg': ['trunk_pitch_deg must be a number'],
    });
  });

  it('produces a structured 422 HttpException with fieldErrors', () => {
    const factory = createValidationExceptionFactory();
    const exception = factory([
      {
        property: 'result',
        constraints: { isEnum: 'result must be one of pass, fail, rework' },
      },
    ] as ValidationError[]) as HttpException;

    expect(exception.getStatus()).toBe(HttpStatus.UNPROCESSABLE_ENTITY);
    const response = exception.getResponse() as {
      error: { code: string; fieldErrors: Record<string, string[]> };
    };
    expect(response.error.code).toBe('VALIDATION_ERROR');
    expect(response.error.fieldErrors.result).toEqual([
      'result must be one of pass, fail, rework',
    ]);
  });

  it('leaves plain-object bodies untouched (no DTO metadata)', async () => {
    const pipe = createEwohValidationPipe();
    const body = { orderId: 'WO-1', quantity: 3 };
    await expect(
      pipe.transform(body, { type: 'body', metatype: Object }),
    ).resolves.toEqual(body);
  });

  it('validates decorated DTOs and maps field errors end to end', async () => {
    const pipe = createEwohValidationPipe();
    await expect(
      pipe.transform({ name: '' }, { type: 'body', metatype: SampleDto }),
    ).rejects.toMatchObject({
      status: HttpStatus.UNPROCESSABLE_ENTITY,
      response: {
        error: {
          code: 'VALIDATION_ERROR',
          fieldErrors: { name: expect.any(Array) },
        },
      },
    });
  });
});
