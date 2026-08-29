// PlanStatusStepper.tsx — 方案状态流转指示（值班员一眼看到方案卡点）。
//
// 纯展示组件：状态→步骤映射全部来自 planStatusStepVM（不重算任何业务状态机）。

import { Fragment } from 'react';
import type { PlanStatus } from '@shared/scheduler';
import { cn } from '@client/src/lib/utils';
import { PLAN_STATUS_LABELS, planStatusSteps } from '../vm/planStatusStepVM';

const STEP_CLS: Record<string, string> = {
  done: 'border-risk-normal/30 bg-risk-normal/15 text-risk-normal-foreground',
  current: 'border-risk-offline/40 bg-risk-offline/15 text-risk-offline-foreground',
  todo: 'border-white/10 bg-card/5 text-white/40',
};

export function PlanStatusStepper({ status }: { status: PlanStatus }): React.ReactElement {
  const steps = planStatusSteps(status);
  return (
    <div
      className="flex items-center gap-1"
      data-testid="plan-status-stepper"
      aria-label={`方案状态：${PLAN_STATUS_LABELS[status] ?? status}`}
    >
      {steps.map((step, i) => (
        <Fragment key={step.key}>
          {i > 0 && (
            <span
              aria-hidden="true"
              className={cn(
                'h-px w-4',
                step.state !== 'todo' ? 'bg-risk-normal/60' : 'bg-card/15',
              )}
            />
          )}
          <span
            className={cn(
              'flex items-center gap-1 rounded border px-1.5 py-0.5 text-[9px] leading-4',
              STEP_CLS[step.state],
            )}
          >
            {step.state === 'done' && <span aria-hidden="true">✓</span>}
            {step.label}
          </span>
        </Fragment>
      ))}
    </div>
  );
}
