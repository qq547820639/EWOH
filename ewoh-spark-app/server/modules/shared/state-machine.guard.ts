import 'reflect-metadata';
import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { StateNotAllowedException } from './errors';

export type StateMap = Record<string, readonly string[]>;

export interface StateMachineRequest {
  body?: Record<string, unknown>;
  query?: Record<string, unknown>;
  params?: Record<string, unknown>;
}

export interface StateMachineOptions {
  stateMap: StateMap;
  currentStatePath?: string;
  targetStatePath?: string;
  getCurrentState?: (request: StateMachineRequest) => string | undefined;
  getTargetState?: (request: StateMachineRequest) => string | undefined;
}

export const STATE_MACHINE_METADATA = 'ewoh:state-machine';

export function StateMachine(options: StateMachineOptions): MethodDecorator & ClassDecorator {
  return ((target: object, _propertyKey?: string | symbol, descriptor?: PropertyDescriptor) => {
    if (descriptor?.value) {
      Reflect.defineMetadata(STATE_MACHINE_METADATA, options, descriptor.value);
    } else {
      Reflect.defineMetadata(STATE_MACHINE_METADATA, options, target);
    }
  }) as MethodDecorator & ClassDecorator;
}

export function isTransitionAllowed(stateMap: StateMap, currentState: string, targetState: string): boolean {
  return (stateMap[currentState] ?? []).includes(targetState);
}

export function getByPath(root: unknown, path: string): unknown {
  let current: unknown = root;
  for (const part of path.split('.')) {
    if (current === null || typeof current !== 'object') {
      return undefined;
    }
    current = (current as Record<string, unknown>)[part];
  }
  return current;
}

@Injectable()
export class StateMachineGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const options = this.reflector.getAllAndOverride<StateMachineOptions>(STATE_MACHINE_METADATA, [
      context.getHandler(),
      context.getClass(),
    ]);

    if (!options) {
      return true;
    }

    const request = context.switchToHttp().getRequest<StateMachineRequest>();
    const currentState = this.readState(
      request,
      options.currentStatePath ?? 'body.currentState',
      options.getCurrentState,
    );
    const targetState = this.readState(
      request,
      options.targetStatePath ?? 'body.targetState',
      options.getTargetState,
    );

    if (
      !currentState ||
      !targetState ||
      !isTransitionAllowed(options.stateMap, currentState, targetState)
    ) {
      throw new StateNotAllowedException(
        `State transition ${currentState ?? '?'} -> ${targetState ?? '?'} is not allowed`,
      );
    }

    return true;
  }

  private readState(
    request: StateMachineRequest,
    path: string,
    custom?: (request: StateMachineRequest) => string | undefined,
  ): string | undefined {
    if (custom) {
      return custom(request);
    }

    const resolved = getByPath(request, path);
    if (resolved !== undefined && resolved !== null) {
      return String(resolved);
    }

    if (!path.includes('.')) {
      const found = request.body?.[path] ?? request.query?.[path] ?? request.params?.[path];
      if (found !== undefined && found !== null) {
        return String(found);
      }
    }

    return undefined;
  }
}
