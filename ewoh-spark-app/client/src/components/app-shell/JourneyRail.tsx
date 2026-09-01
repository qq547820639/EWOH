import type { ReactElement } from 'react';
import { Check } from 'lucide-react';

/**
 * Journey Rail 流程带（OD-8）。
 *
 * 常驻页面顶部，让用户任何时候都知道「我在哪、已完成什么、下一步去哪」——
 * 直接对应 UX 架构诊断中 B1（页面群岛，23/25 页面零出链）与 B4（终态无出口）。
 *
 * 组件保持通用：不 import 任何 pages 层类型，步骤由调用方派生后传入。
 *
 * 无障碍与工业适配：
 *   - `aria-current="step"` 标注当前环节；
 *   - 触控目标 min-h-11（44px，工业手套场景，横切 X-4）；
 *   - 未到达的环节 disabled，不产生死链；
 *   - 状态三重编码（图标 / 文字 / 颜色），不依赖颜色单通道。
 */

export interface JourneyRailStep {
  key: string;
  label: string;
  state: 'done' | 'current' | 'todo';
  /** 可回溯到的路由；`todo` 环节应为 undefined。 */
  route?: string;
}

export interface JourneyRailProps {
  steps: JourneyRailStep[];
  onNavigate?: (route: string) => void;
  ariaLabel?: string;
}

const NUM_CLASS: Record<JourneyRailStep['state'], string> = {
  done: 'border-risk-normal-border bg-risk-normal-soft text-risk-normal-foreground',
  current: 'border-primary bg-primary text-primary-foreground',
  todo: 'border-border bg-muted text-muted-foreground',
};

const LABEL_CLASS: Record<JourneyRailStep['state'], string> = {
  done: 'border-transparent text-foreground',
  current: 'border-primary font-medium text-primary',
  todo: 'border-transparent text-muted-foreground',
};

export function JourneyRail({
  steps,
  onNavigate,
  ariaLabel = '流程进度',
}: JourneyRailProps): ReactElement {
  return (
    <nav aria-label={ariaLabel} className="-mx-1 overflow-x-auto pb-1">
      <ol className="flex min-w-max items-stretch">
        {steps.map((step, index) => {
          const clickable = Boolean(step.route) && step.state !== 'todo';
          return (
            <li key={step.key} className="flex items-stretch">
              {index > 0 ? (
                <span
                  className="mx-1 h-px w-4 shrink-0 self-center bg-border"
                  aria-hidden="true"
                />
              ) : null}
              <button
                type="button"
                disabled={!clickable}
                aria-current={step.state === 'current' ? 'step' : undefined}
                onClick={() => {
                  if (clickable && step.route) onNavigate?.(step.route);
                }}
                className={`flex min-h-11 items-center gap-2 whitespace-nowrap border-b-2 px-3 text-[13px] transition-colors ${
                  LABEL_CLASS[step.state]
                } ${clickable ? 'hover:text-foreground' : 'cursor-default'}`}
              >
                <span
                  className={`flex size-[22px] shrink-0 items-center justify-center rounded-full border text-[11px] font-medium ${NUM_CLASS[step.state]}`}
                  aria-hidden="true"
                >
                  {step.state === 'done' ? <Check className="size-3" /> : index + 1}
                </span>
                {step.label}
              </button>
            </li>
          );
        })}
      </ol>
    </nav>
  );
}
