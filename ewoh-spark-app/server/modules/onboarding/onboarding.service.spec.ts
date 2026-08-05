import {
  BadRequestException,
  ForbiddenException,
  ServiceUnavailableException,
} from '@nestjs/common';
import {
  OnboardingService,
  SAMPLE_FACTORY_DEV_TOKEN,
  SAMPLE_FACTORY_PREFIX,
  SAMPLE_FACTORY_TOKEN_ENV,
  assertSampleFactoryGuard,
  ensureSampleFactoryName,
  resolveSampleFactoryGuardToken,
} from './onboarding.service';
import type { ScaleService } from '../scale/scale.service';
import type { AuditService } from '../shared/audit.service';

function createService(scale: Partial<ScaleService>) {
  const audit = { appendAuditLog: jest.fn().mockResolvedValue(undefined) } as unknown as AuditService;
  const service = new OnboardingService(
    scale as unknown as ScaleService,
    audit,
  );
  return { service, audit };
}

describe('样例工厂守卫纯函数（sample factory guard logic）', () => {
  afterEach(() => {
    delete process.env[SAMPLE_FACTORY_TOKEN_ENV];
    delete process.env.NODE_ENV;
  });

  it('生产环境未配置 token 时返回 BLOCKED（GUARD_TOKEN_NOT_CONFIGURED）', () => {
    const env = { NODE_ENV: 'production' } as NodeJS.ProcessEnv;
    expect(resolveSampleFactoryGuardToken(env)).toBeNull();
    expect(assertSampleFactoryGuard('anything', env)).toEqual({
      ok: false,
      reason: 'GUARD_TOKEN_NOT_CONFIGURED',
    });
  });

  it('非生产环境缺少显式 token 时允许内置开发 token', () => {
    const env = { NODE_ENV: 'development' } as NodeJS.ProcessEnv;
    expect(resolveSampleFactoryGuardToken(env)).toBe(SAMPLE_FACTORY_DEV_TOKEN);
    expect(assertSampleFactoryGuard(SAMPLE_FACTORY_DEV_TOKEN, env)).toEqual({
      ok: true,
    });
  });

  it('显式配置 token 后必须精确匹配，否则返回 GUARD_TOKEN_MISMATCH', () => {
    const env = {
      NODE_ENV: 'production',
      [SAMPLE_FACTORY_TOKEN_ENV]: 'secret-token',
    } as NodeJS.ProcessEnv;
    expect(assertSampleFactoryGuard('wrong', env)).toEqual({
      ok: false,
      reason: 'GUARD_TOKEN_MISMATCH',
    });
    expect(assertSampleFactoryGuard('secret-token', env)).toEqual({ ok: true });
  });

  it('ensureSampleFactoryName 强制演示前缀，防止污染生产工厂', () => {
    expect(ensureSampleFactoryName('')).toBe(
      `${SAMPLE_FACTORY_PREFIX}样例工厂`,
    );
    expect(ensureSampleFactoryName(`${SAMPLE_FACTORY_PREFIX}演示A`)).toBe(
      `${SAMPLE_FACTORY_PREFIX}演示A`,
    );
    expect(() => ensureSampleFactoryName('真实生产工厂')).toThrow(
      BadRequestException,
    );
  });
});

describe('OnboardingService 样例工厂 init/clear 守卫', () => {
  afterEach(() => {
    delete process.env[SAMPLE_FACTORY_TOKEN_ENV];
    delete process.env.NODE_ENV;
  });

  it('init 时 token 不匹配 → ForbiddenException（BLOCKED），不触碰数据库', async () => {
    const installGoldenFactory = jest.fn();
    const { service } = createService({
      installGoldenFactory,
      isDatabaseAvailable: jest.fn().mockResolvedValue(true),
    });
    await expect(
      service.sampleFactoryInit({ token: 'wrong', factoryName: 'x' }),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(installGoldenFactory).not.toHaveBeenCalled();
  });

  it('init 时数据库不可用 → ServiceUnavailableException（DATABASE_UNAVAILABLE），不假装成功', async () => {
    const installGoldenFactory = jest.fn();
    const { service } = createService({
      installGoldenFactory,
      isDatabaseAvailable: jest.fn().mockResolvedValue(false),
    });
    await expect(
      service.sampleFactoryInit({ token: SAMPLE_FACTORY_DEV_TOKEN }),
    ).rejects.toBeInstanceOf(ServiceUnavailableException);
    expect(installGoldenFactory).not.toHaveBeenCalled();
  });

  it('init 成功时在演示前缀下创建数据并记录审计', async () => {
    process.env.NODE_ENV = 'development';
    const installGoldenFactory = jest.fn().mockResolvedValue({
      factoryName: `${SAMPLE_FACTORY_PREFIX}样例工厂`,
      profileId: 'PRF-demo-1',
      templateId: 'TPL-demo-1',
      reused: false,
    });
    const { service, audit } = createService({
      installGoldenFactory,
      isDatabaseAvailable: jest.fn().mockResolvedValue(true),
    });
    const result = await service.sampleFactoryInit({
      token: SAMPLE_FACTORY_DEV_TOKEN,
    });
    expect(result.status).toBe('created');
    expect(installGoldenFactory).toHaveBeenCalledWith(
      expect.objectContaining({
        factoryName: `${SAMPLE_FACTORY_PREFIX}样例工厂`,
      }),
      undefined,
    );
    expect(audit.appendAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'scale.sample_factory.init' }),
    );
  });

  it('init 拒绝非演示前缀的工厂名', async () => {
    const installGoldenFactory = jest.fn();
    const { service } = createService({
      installGoldenFactory,
      isDatabaseAvailable: jest.fn().mockResolvedValue(true),
    });
    await expect(
      service.sampleFactoryInit({
        token: SAMPLE_FACTORY_DEV_TOKEN,
        factoryName: 'line-1',
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(installGoldenFactory).not.toHaveBeenCalled();
  });

  it('clear 时数据库不可用 → ServiceUnavailableException', async () => {
    const { service } = createService({
      isDatabaseAvailable: jest.fn().mockResolvedValue(false),
      clearDemoProfiles: jest.fn(),
    });
    await expect(
      service.sampleFactoryClear({ token: SAMPLE_FACTORY_DEV_TOKEN }),
    ).rejects.toBeInstanceOf(ServiceUnavailableException);
  });

  it('clear 仅清理演示前缀数据并返回移除数量', async () => {
    process.env.NODE_ENV = 'development';
    const clearDemoProfiles = jest.fn().mockResolvedValue({
      removed: 2,
      profileIds: ['PRF-demo-1', 'PRF-demo-2'],
    });
    const { service } = createService({
      isDatabaseAvailable: jest.fn().mockResolvedValue(true),
      clearDemoProfiles,
    });
    const result = await service.sampleFactoryClear({
      token: SAMPLE_FACTORY_DEV_TOKEN,
    });
    expect(result.status).toBe('cleared');
    expect(result.removed).toBe(2);
    // 必须用演示前缀调用清理，绝不触碰生产数据
    expect(clearDemoProfiles).toHaveBeenCalledWith(
      SAMPLE_FACTORY_PREFIX,
      undefined,
    );
  });

  it('status 在数据库不可用时报告 BLOCKED/DATABASE_UNAVAILABLE', async () => {
    const isDatabaseAvailable = jest.fn().mockResolvedValue(false);
    const { service } = createService({ isDatabaseAvailable });
    const status = await service.sampleFactoryStatus();
    expect(status.status).toBe('BLOCKED');
    expect(status.reason).toBe('DATABASE_UNAVAILABLE');
    expect(status.demoProfileCount).toBe(0);
  });
});