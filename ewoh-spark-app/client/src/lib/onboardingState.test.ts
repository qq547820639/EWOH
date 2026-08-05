import {
  ONBOARDING_VERSION,
  completeFlowStep,
  completeOnboardingStep,
  dismissOnboarding,
  isFlowComplete,
  nextIncompleteStep,
  readOnboarding,
  reopenOnboarding,
  shouldShowOnboarding,
  skipFlow,
} from './onboardingState';

function createMemoryStorage(): Storage {
  const values = new Map<string, string>();
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => void values.set(key, value),
    removeItem: (key: string) => void values.delete(key),
    clear: () => values.clear(),
    key: (index: number) => Array.from(values.keys())[index] ?? null,
    get length() {
      return values.size;
    },
  };
}

describe('onboardingState（首次使用 localStorage dismissed 状态逻辑）', () => {
  let storage: Storage;

  beforeEach(() => {
    storage = createMemoryStorage();
  });

  it('新用户（无记录）应显示引导', () => {
    expect(shouldShowOnboarding('user-1', ONBOARDING_VERSION, storage)).toBe(
      true,
    );
  });

  it('跳过（dismiss）后用当前版本不再显示，但保留后续可重开', () => {
    dismissOnboarding('user-1', ONBOARDING_VERSION, storage);
    expect(shouldShowOnboarding('user-1', ONBOARDING_VERSION, storage)).toBe(
      false,
    );
    // 重开后再次显示
    reopenOnboarding('user-1', storage);
    expect(shouldShowOnboarding('user-1', ONBOARDING_VERSION, storage)).toBe(
      true,
    );
  });

  it('版本号隔离：用户在旧版本跳过，升级到新版本后会重新弹出', () => {
    dismissOnboarding('user-1', '0.9.0', storage);
    expect(shouldShowOnboarding('user-1', '0.9.0', storage)).toBe(false);
    expect(shouldShowOnboarding('user-1', ONBOARDING_VERSION, storage)).toBe(
      true,
    );
  });

  it('同一版本不会每次登录都弹：再次查询仍为 false（不会重复弹出）', () => {
    dismissOnboarding('user-1', ONBOARDING_VERSION, storage);
    expect(shouldShowOnboarding('user-1', ONBOARDING_VERSION, storage)).toBe(
      false,
    );
    expect(shouldShowOnboarding('user-1', ONBOARDING_VERSION, storage)).toBe(
      false,
    );
  });

  it('按用户隔离：不同 userId 的 dismissed 状态互不影响', () => {
    dismissOnboarding('user-1', ONBOARDING_VERSION, storage);
    expect(shouldShowOnboarding('user-1', ONBOARDING_VERSION, storage)).toBe(
      false,
    );
    expect(shouldShowOnboarding('other-user', ONBOARDING_VERSION, storage)).toBe(
      true,
    );
  });

  it('completeFlowStep 记录进度用于续做，全部完成后自动 dismissed', () => {
    const steps = ['connect_device', 'publish_template', 'install_scenario', 'run_first_task'];
    for (const step of steps) {
      completeFlowStep('onboarding', 'user-1', step, ONBOARDING_VERSION, storage);
    }
    const prefs = readOnboarding('user-1', storage);
    expect(prefs.completedSteps.sort()).toEqual([...steps].sort());
    expect(prefs.dismissedVersion).toBe(ONBOARDING_VERSION);
    expect(shouldShowOnboarding('user-1', ONBOARDING_VERSION, storage)).toBe(
      false,
    );
  });

  it('部分完成时仍显示引导且 nextIncompleteStep 指向第一个未完成步骤', () => {
    completeOnboardingStep('user-1', 'connect_device', ONBOARDING_VERSION, storage);
    const prefs = readOnboarding('user-1', storage);
    expect(prefs.completedSteps).toEqual(['connect_device']);
    // 未全部完成 → 仍显示
    expect(shouldShowOnboarding('user-1', ONBOARDING_VERSION, storage)).toBe(
      true,
    );
    expect(nextIncompleteStep('onboarding', prefs.completedSteps)).toBe(
      'publish_template',
    );
  });

  it('isFlowComplete 依版本对应的步骤集合判定', () => {
    expect(
      isFlowComplete('onboarding', ['connect_device', 'publish_template', 'install_scenario'], ONBOARDING_VERSION),
    ).toBe(false);
    expect(
      isFlowComplete('fiveMinute', ['understand', 'connect', 'configure', 'execute', 'close_loop'], ONBOARDING_VERSION),
    ).toBe(true);
  });

  it('skipFlow 保留进度（可重开续做），而 completeFlow 标记完成', () => {
    const skipped = skipFlow('onboarding', 'user-1', ONBOARDING_VERSION, storage);
    expect(skipped.skipped).toBe(true);
    expect(shouldShowOnboarding('user-1', ONBOARDING_VERSION, storage)).toBe(
      false,
    );
    const reopened = reopenOnboarding('user-1', storage);
    expect(reopened.skipped).toBe(true);
    expect(shouldShowOnboarding('user-1', ONBOARDING_VERSION, storage)).toBe(
      true,
    );
  });

  it('读取损坏的存储内容时安全回退为空状态并显示引导', () => {
    storage.setItem('ewoh.onboarding.user-1', '{not json');
    expect(readOnboarding('user-1', storage)).toMatchObject({
      completedSteps: [],
      dismissedVersion: null,
    });
    expect(shouldShowOnboarding('user-1', ONBOARDING_VERSION, storage)).toBe(
      true,
    );
  });
});