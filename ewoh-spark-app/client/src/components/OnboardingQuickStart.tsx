/**
 * 首次使用引导的轻量 UI：基于角色展示 Quick Start，并内置「5 分钟跑通首个闭环任务」
 * 清单。支持跳过 / 续做 / 重开，状态持久化在 localStorage（按用户 + 版本隔离），
 * 并上报匿名产品事件（见 onboardingEvents.ts）。
 *
 * 该组件为纯展示 + 状态衔接，不依赖具体业务页面的数据，可安全挂载在任意布局内
 * （例如在 AppShell 中按 shouldShowOnboarding 决定是否渲染）。
 */

import {
  Check,
  ChevronRight,
  CircleHelp,
  RotateCcw,
  X,
} from 'lucide-react';
import { Button } from './ui/button';
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from './ui/empty';
import {
  ONBOARDING_VERSION,
  completeOnboardingStep,
  dismissOnboarding,
  nextIncompleteStep,
  readOnboarding,
  reopenOnboarding,
  shouldShowOnboarding,
  type OnboardingStepId,
} from '@client/src/lib/onboardingState';
import {
  onboardingRoleKey,
  quickStartSteps,
  type OnboardingRoleKey,
} from '@client/src/lib/onboardingCatalog';
import {
  reportOnboardingEvent,
  trackFirstTaskCompleted,
} from '@client/src/lib/onboardingEvents';

/** 引导视图模式：角色 Quick Start 或 5 分钟闭环清单。 */
export type OnboardingView = 'quickstart' | 'fiveMinute';

export interface OnboardingQuickStartProps {
  /** 当前用户唯一标识（从 auth 上下文取得，如 userId）。 */
  userId: string;
  /** 当前用户角色列表（用于分角色 Quick Start 与漏斗统计）。 */
  roles?: string[];
  /** 初始视图。 */
  initialView?: OnboardingView;
  /** 关闭回调（父级据此卸载组件）。 */
  onClose?: () => void;
}

export const OnboardingQuickStart = ({
  userId,
  roles = [],
  onClose,
}: OnboardingQuickStartProps): React.ReactElement | null => {
  const prefs = readOnboarding(userId);
  const role: OnboardingRoleKey = onboardingRoleKey(roles);
  const steps = quickStartSteps(role);
  const remainder = nextIncompleteStep('onboarding', prefs.completedSteps);
  const resumeStep = remainder ?? steps[0].id;

  const stepById = (id: string) => steps.find((s) => s.id === id);

  const handleCompleteStep = (stepId: OnboardingStepId) => {
    completeOnboardingStep(userId, stepId, ONBOARDING_VERSION);
    reportOnboardingEvent('onboarding.step_completed', {
      flow: 'onboarding',
      step: stepId,
      role,
    });
    if (stepId === 'run_first_task') {
      trackFirstTaskCompleted({ flow: 'onboarding', role });
    }
  };

  const handleDismiss = () => {
    dismissOnboarding(userId, ONBOARDING_VERSION);
    reportOnboardingEvent('onboarding.dismissed', { flow: 'onboarding', role });
    onClose?.();
  };

  const handleReopen = () => {
    reopenOnboarding(userId);
  };

  const handleOpen = () => {
    if (!shouldShowOnboarding(userId, ONBOARDING_VERSION)) return null;
    reportOnboardingEvent('onboarding.shown', { flow: 'onboarding', role });
    return (
      <Empty data-role={role} data-resume-step={resumeStep}>
        <EmptyHeader>
          <EmptyMedia>
            <CircleHelp className="size-6" aria-hidden />
          </EmptyMedia>
          <EmptyTitle>{ROLE_LABEL[role]}快速上手</EmptyTitle>
          <EmptyDescription>
            从上次进度继续（{resumeStepLabel(resumeStep)}），或重新开始本引导。
          </EmptyDescription>
        </EmptyHeader>
        <EmptyContent>
          <ol className="w-full space-y-2 text-left">
            {steps.map((step) => {
              const done = prefs.completedSteps.includes(step.id);
              return (
                <li
                  key={step.id}
                  className={`flex items-center gap-2 rounded border p-2 text-sm ${
                    done ? 'border-emerald-200 bg-emerald-50' : ''
                  }`}
                >
                  <span className="shrink-0">
                    {done ? (
                      <Check className="size-4 text-emerald-600" aria-hidden />
                    ) : (
                      <ChevronRight className="size-4 text-muted-foreground" aria-hidden />
                    )}
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block font-medium">{step.state}</span>
                    <span className="block text-muted-foreground">
                      缺：{step.missing} 下一步：{step.nextAction}
                    </span>
                  </span>
                  {!done && (
                    <Button
                      type="button"
                      size="sm"
                      variant="outline"
                      onClick={() => handleCompleteStep(step.id)}
                    >
                      完成此步
                    </Button>
                  )}
                </li>
              );
            })}
          </ol>
          <div className="flex flex-wrap justify-end gap-2 pt-1">
            <Button
              type="button"
              size="sm"
              variant="ghost"
              onClick={handleReopen}
            >
              <RotateCcw className="size-3.5" />
              重开
            </Button>
            <Button
              type="button"
              size="sm"
              variant="outline"
              onClick={handleDismiss}
            >
              <X className="size-3.5" />
              跳过
            </Button>
          </div>
        </EmptyContent>
      </Empty>
    );
  };

  return handleOpen();
};

const ROLE_LABEL: Record<OnboardingRoleKey, string> = {
  admin: '管理员',
  dispatcher: '调度员',
  engineer: '工程师',
  field_worker: '现场作业员',
};

function resumeStepLabel(id: string): string {
  const map: Record<string, string> = {
    connect_device: '接入设备',
    publish_template: '发布模板',
    install_scenario: '安装场景',
    run_first_task: '跑通首个任务',
  };
  return map[id] ?? '接入设备';
}

export default OnboardingQuickStart;