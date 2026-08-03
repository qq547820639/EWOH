import { BadRequestException, Injectable } from '@nestjs/common';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import Ajv from 'ajv';
import { load } from 'js-yaml';

export interface PolicyRule {
  field: string;
  operator: string;
  value: unknown;
}

export interface Policy {
  policyId: string;
  version: string;
  description?: string;
  effect: 'allow' | 'deny' | 'warn';
  rules: PolicyRule[];
}

@Injectable()
export class PolicyService {
  private readonly schema: Record<string, unknown>;

  constructor() {
    const candidates = [
      resolve(process.cwd(), 'contracts/policy/policy-schema.json'),
      resolve(process.cwd(), '../contracts/policy/policy-schema.json'),
    ];
    const file = candidates.find((candidate) => existsSync(candidate));
    if (!file) {
      throw new Error('policy schema contract not found');
    }
    this.schema = JSON.parse(readFileSync(file, 'utf8')) as Record<
      string,
      unknown
    >;
  }

  validate(policy: unknown): Policy {
    const ajv = new Ajv({ allErrors: true, strict: false });
    const valid = ajv.validate(this.schema, policy);
    if (!valid) {
      throw new BadRequestException(
        'policy does not conform to ewoh:///policy/v1',
      );
    }
    return policy as Policy;
  }

  getExample(): Policy {
    const candidates = [
      resolve(
        process.cwd(),
        'contracts/policy/examples/operator-safety.yaml',
      ),
      resolve(
        process.cwd(),
        '../contracts/policy/examples/operator-safety.yaml',
      ),
    ];
    const file = candidates.find((candidate) => existsSync(candidate));
    if (!file) {
      throw new Error('policy example contract not found');
    }
    return load(readFileSync(file, 'utf8')) as Policy;
  }

  private resolvePath(context: Record<string, unknown>, path: string): unknown {
    return path.split('.').reduce<unknown>((current, segment) => {
      if (current === null || current === undefined) {
        return undefined;
      }
      if (Array.isArray(current) && /^\d+$/.test(segment)) {
        return current[Number(segment)];
      }
      if (typeof current === 'object') {
        return (current as Record<string, unknown>)[segment];
      }
      return undefined;
    }, context);
  }

  private matches(rule: PolicyRule, context: Record<string, unknown>): boolean {
    const actual = this.resolvePath(context, rule.field);
    switch (rule.operator) {
      case 'eq':
        return actual === rule.value;
      case 'neq':
        return actual !== rule.value;
      case 'gt':
        return Number(actual) > Number(rule.value);
      case 'gte':
        return Number(actual) >= Number(rule.value);
      case 'lt':
        return Number(actual) < Number(rule.value);
      case 'lte':
        return Number(actual) <= Number(rule.value);
      case 'in':
        return Array.isArray(rule.value) && rule.value.includes(actual);
      case 'not_in':
        return !(Array.isArray(rule.value) && rule.value.includes(actual));
      case 'exists':
        return rule.value === true ? actual !== undefined : actual === undefined;
      default:
        return false;
    }
  }

  evaluate(policyInput: unknown, context: Record<string, unknown>) {
    const policy = this.validate(policyInput);
    const reasons: string[] = [];
    const matched = policy.rules.every((rule) => {
      const ok = this.matches(rule, context);
      reasons.push(`${rule.field} ${rule.operator} ${ok ? 'matched' : 'failed'}`);
      return ok;
    });
    return {
      policyId: policy.policyId,
      version: policy.version,
      effect: policy.effect,
      matched,
      decision: matched ? policy.effect : 'allow',
      reasons,
    };
  }
}
