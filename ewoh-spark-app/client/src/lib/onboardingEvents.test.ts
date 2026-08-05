import {
  clearBuffer,
  getBuffer,
  resetApiStats,
  resetSyncStats,
} from './observability';
import {
  reportOnboardingEvent,
  trackFirstTaskAbandoned,
  trackFirstTaskCompleted,
} from './onboardingEvents';

describe('onboardingEvents（匿名产品事件，不采集业务内容）', () => {
  beforeEach(() => {
    clearBuffer();
    resetApiStats();
    resetSyncStats();
  });

  it('上报首个任务完成率事件，且只含枚举字段', () => {
    trackFirstTaskCompleted({ flow: 'fiveMinute', role: 'dispatcher' });
    const record = getBuffer().find(
      (m) => m.name === 'uwax.onboarding.first_task.completed',
    );
    expect(record).toBeDefined();
    expect(record!.value).toBe(1);
    expect(record!.tags).toMatchObject({
      flow: 'fiveMinute',
      role: 'dispatcher',
      completed: true,
    });
  });

  it('上报放弃事件并携带枚举化的放弃步骤与原因', () => {
    trackFirstTaskAbandoned({
      flow: 'onboarding',
      step: 'publish_template',
      reason: 'connection_interrupted',
    });
    const record = getBuffer().find(
      (m) => m.name === 'uwax.onboarding.first_task.abandoned',
    );
    expect(record).toBeDefined();
    expect(record!.tags).toMatchObject({
      step: 'publish_template',
      reason: 'connection_interrupted',
    });
  });

  it('绝不把业务内容（订单/工厂名/用户名）写入事件标签', () => {
    reportOnboardingEvent('onboarding.abandoned', {
      flow: 'onboarding',
      step: 'connect_device',
      reason: 'no_devices',
    });
    const serialized = JSON.stringify(getBuffer());
    // 只有结构化枚举，不应包含任何疑似业务/敏感关键词
    for (const forbidden of ['order', 'factoryName', 'token', 'secret', 'userId']) {
      expect(serialized.toLowerCase()).not.toContain(forbidden);
    }
  });

  it('不传可选字段时不下发对应标签', () => {
    reportOnboardingEvent('onboarding.shown');
    const record = getBuffer().find(
      (m) => m.name === 'uwax.onboarding.onboarding.shown',
    );
    expect(record).toBeDefined();
    expect(record!.tags).toBeUndefined();
  });
});