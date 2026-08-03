import { Reflector } from '@nestjs/core';
import {
  StateMachine,
  StateMachineGuard,
} from '../../../server/modules/shared/state-machine.guard';
import { StateNotAllowedException } from '../../../server/modules/shared/errors';

class AlertController {
  @StateMachine({
    stateMap: {
      open: ['acknowledged'],
      acknowledged: ['processing', 'reopened'],
    },
    currentStatePath: 'body.status',
    targetStatePath: 'body.targetState',
  })
  transition() {
    return true;
  }
}

function createContext(body: Record<string, unknown>) {
  return {
    getType: () => 'http',
    switchToHttp: () => ({
      getRequest: () => ({ body, query: {}, params: {} }),
    }),
    getHandler: () => AlertController.prototype.transition,
    getClass: () => AlertController,
  } as any;
}

describe('StateMachineGuard', () => {
  const guard = new StateMachineGuard(new Reflector());

  it('allows legal transitions', () => {
    expect(guard.canActivate(createContext({ status: 'open', targetState: 'acknowledged' }))).toBe(
      true,
    );
    expect(
      guard.canActivate(createContext({ status: 'acknowledged', targetState: 'processing' })),
    ).toBe(true);
  });

  it('rejects illegal transitions with 409 STATE_NOT_ALLOWED', () => {
    try {
      guard.canActivate(createContext({ status: 'open', targetState: 'processing' }));
      throw new Error('expected StateNotAllowedException');
    } catch (error) {
      expect(error).toBeInstanceOf(StateNotAllowedException);
      const httpError = error as StateNotAllowedException;
      expect(httpError.getStatus()).toBe(409);
      expect(httpError.getResponse()).toMatchObject({
        error: { code: 'STATE_NOT_ALLOWED' },
      });
    }
  });

  it('passes through handlers without state machine metadata', () => {
    const context = {
      getType: () => 'http',
      switchToHttp: () => ({ getRequest: () => ({ body: {} }) }),
      getHandler: () => () => undefined,
      getClass: () => class PlainController {},
    } as any;
    expect(guard.canActivate(context)).toBe(true);
  });
});
