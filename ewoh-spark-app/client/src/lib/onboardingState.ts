/**
 * 首次使用引导（first-use onboarding）与「5 分钟跑通首个闭环任务」引导的状态管理。
 *
 * 设计约定：
 * - 版本化：每次引导迭代都带一个 version。用户在当前版本完成或跳过（dismiss）后，
 *   记录 dismissedVersion = 当前版本；升级到新版本时会重新弹出（不会每个登录都弹）。
 * - 按用户隔离：localStorage key 以 userId 为粒度，不同用户互不影响。
 * - 可跳过 / 可续做 / 可重开：dismiss 即跳过；completedSteps 用于续做；reopen 恢复弹出。
 * - 纯函数：所有读写都接收 storage 参数（默认浏览器 localStorage），便于单测注入内存实现。
 */

export type FlowKind = 'onboarding' | 'fiveMinute';

/** 首次使用引导版本号。升版后已完成的用户会再次看到新版引导。 */
export const ONBOARDING_VERSION = '1.0.0';
/** 「5 分钟跑通首个闭环任务」引导版本号。 */
export const FIVE_MINUTE_VERSION = '1.0.0';

/** 首次使用引导的步骤 id（不同角色内容不同，但步骤 id 稳定，便于续做）。 */
export const ONBOARDING_STEP_IDS = [
  'connect_device',
  'publish_template',
  'install_scenario',
  'run_first_task',
] as const;
export type OnboardingStepId = (typeof ONBOARDING_STEP_IDS)[number];

/** 「5 分钟跑通首个闭环任务」引导的步骤 id。 */
export const FIVE_MINUTE_STEP_IDS = [
  'understand',
  'connect',
  'configure',
  'execute',
  'close_loop',
] as const;
export type FiveMinuteStepId = (typeof FIVE_MINUTE_STEP_IDS)[number];

export interface FlowPreferences {
  /** 用户已在该版本完成或跳过的引导版本号；与当前版本一致时不再自动弹出。 */
  dismissedVersion: string | null;
  /** 已完成的步骤 id（用于续做与进度展示）。 */
  completedSteps: string[];
  /** 用户是否显式跳过（不同于完成：跳过保留进度以便重开续做）。 */
  skipped: boolean;
  startedAt?: string;
  completedAt?: string;
  updatedAt?: string;
}

type StorageLike = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'> | null;

/** 每个用户/每种引导独立的存储 key。 */
export function flowStorageKey(kind: FlowKind, userId: string): string {
  return `ewoh.${kind}.${userId}`;
}

/** 默认空状态（首次使用该用户时）。 */
export function emptyFlowPreferences(): FlowPreferences {
  return {
    dismissedVersion: null,
    completedSteps: [],
    skipped: false,
  };
}

/** 读取用户引导偏好；缺失或损坏时返回空状态。 */
export function readFlow(
  kind: FlowKind,
  userId: string,
  storage: StorageLike = globalThis.localStorage,
): FlowPreferences {
  try {
    const raw = storage?.getItem(flowStorageKey(kind, userId));
    if (!raw) return emptyFlowPreferences();
    const parsed = JSON.parse(raw) as Partial<FlowPreferences>;
    return {
      skipped: Boolean(parsed.skipped),
      dismissedVersion:
        typeof parsed.dismissedVersion === 'string'
          ? parsed.dismissedVersion
          : null,
      completedSteps: Array.isArray(parsed.completedSteps)
        ? parsed.completedSteps
        : [],
      startedAt:
        typeof parsed.startedAt === 'string' ? parsed.startedAt : undefined,
      completedAt:
        typeof parsed.completedAt === 'string'
          ? parsed.completedAt
          : undefined,
      updatedAt:
        typeof parsed.updatedAt === 'string' ? parsed.updatedAt : undefined,
    };
  } catch {
    return emptyFlowPreferences();
  }
}

function writeFlow(
  kind: FlowKind,
  userId: string,
  prefs: FlowPreferences,
  storage: StorageLike = globalThis.localStorage,
): void {
  try {
    storage?.setItem(
      flowStorageKey(kind, userId),
      JSON.stringify({ ...prefs, updatedAt: new Date().toISOString() }),
    );
  } catch {
    // localStorage 不可用（隐私模式/容量）时静默降级：不崩溃，仅不持久化。
  }
}

/**
 * 是否应显示引导：当前版本未被该用户完成/跳过，即 dismissedVersion !== version。
 * 新版本（dismissedVersion 为旧版或空）会重新弹出，但同一版本不会每次登录都弹。
 */
export function shouldShowFlow(
  kind: FlowKind,
  userId: string,
  version: string,
  storage: StorageLike = globalThis.localStorage,
): boolean {
  const prefs = readFlow(kind, userId, storage);
  return prefs.dismissedVersion !== version;
}

/** 跳过引导（保留进度，方便用户重开续做）。 */
export function skipFlow(
  kind: FlowKind,
  userId: string,
  version: string,
  storage: StorageLike = globalThis.localStorage,
): FlowPreferences {
  const prefs = readFlow(kind, userId, storage);
  const next: FlowPreferences = {
    ...prefs,
    dismissedVersion: version,
    skipped: true,
  };
  writeFlow(kind, userId, next, storage);
  return next;
}

/** 完成引导（标记 dismissed，后续不再自动弹出）。 */
export function completeFlow(
  kind: FlowKind,
  userId: string,
  version: string,
  storage: StorageLike = globalThis.localStorage,
): FlowPreferences {
  const prefs = readFlow(kind, userId, storage);
  const next: FlowPreferences = {
    ...prefs,
    dismissedVersion: version,
    skipped: false,
    completedAt: new Date().toISOString(),
  };
  writeFlow(kind, userId, next, storage);
  return next;
}

/** 记录完成一个步骤（用于续做与进度展示）。 */
export function completeFlowStep(
  kind: FlowKind,
  userId: string,
  stepId: string,
  version: string,
  storage: StorageLike = globalThis.localStorage,
): FlowPreferences {
  const prefs = readFlow(kind, userId, storage);
  const startedAt = prefs.startedAt ?? new Date().toISOString();
  const completedSteps = prefs.completedSteps.includes(stepId)
    ? prefs.completedSteps
    : [...prefs.completedSteps, stepId];
  const next: FlowPreferences = {
    ...prefs,
    startedAt,
    completedSteps,
    // 记录步骤即视为曾参与；若全部步骤完成则自动视为完成。
    dismissedVersion:
      isFlowComplete(kind, completedSteps, version)
        ? version
        : prefs.dismissedVersion,
  };
  writeFlow(kind, userId, next, storage);
  return next;
}

/** 重开引导（清除 dismissed，用户可再次看到入口/弹窗）。 */
export function reopenFlow(
  kind: FlowKind,
  userId: string,
  storage: StorageLike = globalThis.localStorage,
): FlowPreferences {
  const prefs = readFlow(kind, userId, storage);
  const next: FlowPreferences = { ...prefs, dismissedVersion: null };
  writeFlow(kind, userId, next, storage);
  return next;
}

/** 重置引导（清空全部进度与该用户记录）。 */
export function resetFlow(
  kind: FlowKind,
  userId: string,
  storage: StorageLike = globalThis.localStorage,
): void {
  try {
    storage?.removeItem(flowStorageKey(kind, userId));
  } catch {
    // ignore
  }
}

/** 判断某组已完成步骤是否覆盖了该引导的全部步骤（依据版本对应的步骤集合）。 */
export function isFlowComplete(
  kind: FlowKind,
  completedSteps: string[],
  version: string,
): boolean {
  const stepIds =
    kind === 'onboarding'
      ? (ONBOARDING_STEP_IDS as readonly string[])
      : (FIVE_MINUTE_STEP_IDS as readonly string[]);
  return stepIds.every((id) => completedSteps.includes(id));
}

/** 当前应高亮/继续的步骤（第一个未完成的）。返回 null 表示全部完成。 */
export function nextIncompleteStep(
  kind: FlowKind,
  completedSteps: string[],
): string | null {
  const stepIds =
    kind === 'onboarding'
      ? (ONBOARDING_STEP_IDS as readonly string[])
      : (FIVE_MINUTE_STEP_IDS as readonly string[]);
  return stepIds.find((id) => !completedSteps.includes(id)) ?? null;
}

// ---- 便捷别名：首次使用引导 ----

export function readOnboarding(
  userId: string,
  storage: StorageLike = globalThis.localStorage,
): FlowPreferences {
  return readFlow('onboarding', userId, storage);
}

export function shouldShowOnboarding(
  userId: string,
  version: string = ONBOARDING_VERSION,
  storage: StorageLike = globalThis.localStorage,
): boolean {
  return shouldShowFlow('onboarding', userId, version, storage);
}

export function dismissOnboarding(
  userId: string,
  version: string = ONBOARDING_VERSION,
  storage: StorageLike = globalThis.localStorage,
): FlowPreferences {
  return skipFlow('onboarding', userId, version, storage);
}

export function completeOnboarding(
  userId: string,
  version: string = ONBOARDING_VERSION,
  storage: StorageLike = globalThis.localStorage,
): FlowPreferences {
  return completeFlow('onboarding', userId, version, storage);
}

export function completeOnboardingStep(
  userId: string,
  stepId: OnboardingStepId,
  version: string = ONBOARDING_VERSION,
  storage: StorageLike = globalThis.localStorage,
): FlowPreferences {
  return completeFlowStep('onboarding', userId, stepId, version, storage);
}

export function reopenOnboarding(
  userId: string,
  storage: StorageLike = globalThis.localStorage,
): FlowPreferences {
  return reopenFlow('onboarding', userId, storage);
}

// ---- 便捷别名：「5 分钟跑通首个闭环任务」 ----

export function readFiveMinute(
  userId: string,
  storage: StorageLike = globalThis.localStorage,
): FlowPreferences {
  return readFlow('fiveMinute', userId, storage);
}

export function shouldShowFiveMinute(
  userId: string,
  version: string = FIVE_MINUTE_VERSION,
  storage: StorageLike = globalThis.localStorage,
): boolean {
  return shouldShowFlow('fiveMinute', userId, version, storage);
}

export function dismissFiveMinute(
  userId: string,
  version: string = FIVE_MINUTE_VERSION,
  storage: StorageLike = globalThis.localStorage,
): FlowPreferences {
  return skipFlow('fiveMinute', userId, version, storage);
}

export function completeFiveMinuteStep(
  userId: string,
  stepId: FiveMinuteStepId,
  version: string = FIVE_MINUTE_VERSION,
  storage: StorageLike = globalThis.localStorage,
): FlowPreferences {
  return completeFlowStep('fiveMinute', userId, stepId, version, storage);
}

export function reopenFiveMinute(
  userId: string,
  storage: StorageLike = globalThis.localStorage,
): FlowPreferences {
  return reopenFlow('fiveMinute', userId, storage);
}