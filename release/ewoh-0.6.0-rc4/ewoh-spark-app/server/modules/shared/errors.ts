import { HttpException, HttpStatus } from '@nestjs/common';

export interface ApiErrorPayload {
  error: {
    code: string;
    message: string;
    details?: unknown;
    timestamp?: number;
  };
}

export function buildErrorPayload(code: string, message: string, details?: unknown): ApiErrorPayload {
  return {
    error: {
      code,
      message,
      details: details ?? {},
      timestamp: Date.now(),
    },
  };
}

export class StateNotAllowedException extends HttpException {
  constructor(message = 'State transition not allowed', details?: unknown) {
    super(buildErrorPayload('STATE_NOT_ALLOWED', message, details), HttpStatus.CONFLICT);
  }
}
