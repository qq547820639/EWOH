import { BadRequestException, Injectable } from '@nestjs/common';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import Ajv from 'ajv';
import { load } from 'js-yaml';

export interface WorkflowStep {
  name: string;
  action: string;
  allowedRoles: string[];
  next: string[];
}

export interface Workflow {
  workflowId: string;
  version: string;
  description?: string;
  start: string;
  steps: WorkflowStep[];
}

@Injectable()
export class WorkflowService {
  private readonly schema: Record<string, unknown>;

  constructor() {
    const candidates = [
      resolve(process.cwd(), 'contracts/workflow/workflow-schema.json'),
      resolve(process.cwd(), '../contracts/workflow/workflow-schema.json'),
    ];
    const file = candidates.find((candidate) => existsSync(candidate));
    if (!file) {
      throw new Error('workflow schema contract not found');
    }
    this.schema = JSON.parse(readFileSync(file, 'utf8')) as Record<
      string,
      unknown
    >;
  }

  validate(workflow: unknown): Workflow {
    const ajv = new Ajv({ allErrors: true, strict: false });
    const valid = ajv.validate(this.schema, workflow);
    if (!valid) {
      throw new BadRequestException(
        'workflow does not conform to ewoh:///workflow/v1',
      );
    }
    return workflow as Workflow;
  }

  getExample(): Workflow {
    const candidates = [
      resolve(
        process.cwd(),
        'contracts/workflow/examples/mes-execution.yaml',
      ),
      resolve(
        process.cwd(),
        '../contracts/workflow/examples/mes-execution.yaml',
      ),
    ];
    const file = candidates.find((candidate) => existsSync(candidate));
    if (!file) {
      throw new Error('workflow example contract not found');
    }
    return load(readFileSync(file, 'utf8')) as Workflow;
  }

  advance(
    workflowInput: unknown,
    currentStep: string,
    roles: string[],
  ) {
    const workflow = this.validate(workflowInput);
    const step = workflow.steps.find((candidate) => candidate.name === currentStep);
    if (!step) {
      throw new BadRequestException(`workflow step ${currentStep} not found`);
    }
    const currentActionAllowed = step.allowedRoles.some((role) =>
      roles.includes(role),
    );
    const allowedNextSteps = step.next
      .map((name) => workflow.steps.find((candidate) => candidate.name === name))
      .filter(
        (candidate): candidate is WorkflowStep =>
          Boolean(candidate) &&
          candidate.allowedRoles.some((role) => roles.includes(role)),
      )
      .map((candidate) => ({ name: candidate.name, action: candidate.action }));
    return {
      workflowId: workflow.workflowId,
      version: workflow.version,
      currentStep,
      currentActionAllowed,
      allowedNextSteps,
    };
  }
}
