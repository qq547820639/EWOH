import { ForbiddenException } from '@nestjs/common';
import { SchedulerService } from '../scheduler.service';

/**
 * 现场作业台投影（`GET /api/scheduler/field/my-work`）。
 *
 * 这两个不变量决定了现场闭环对真正的现场人员是否可用：
 *  1. 范围**只能**来自签名令牌里的账号↔人员绑定（ctx.personId），不接受客户端
 *     传入 personId——否则任何工人都能读他人工作；
 *  2. 未绑定人员必须 403 fail-closed，而不是返回空列表：空列表会被现场人员
 *     读成"我没有任务"，而事实是"系统不知道你是谁"。
 */
describe('SchedulerService.myFieldWork（现场作业台投影）', () => {
  /**
   * 只暴露 myFieldWork 依赖的 queryService.executionList。
   *
   * 用原型构造而非 `new SchedulerService(...)`：该服务构造器有二十余个可选依赖，
   * 逐个列举既噪声大又会在构造器演进时无谓失败；被测行为只依赖 queryService。
   */
  function makeService(executionPersonName?: string | null) {
    const calls: Array<Record<string, unknown>> = [];
    const queryService = {
      executionList: jest.fn(async (query: Record<string, unknown>) => {
        calls.push(query);
        return {
          executions: [{ executionId: 'EXEC-1', assignmentId: 'ASG-1', personName: executionPersonName ?? null }],
          total: 1,
        };
      }),
    };
    const service = Object.create(SchedulerService.prototype) as SchedulerService;
    (service as unknown as { queryService: unknown }).queryService = queryService;
    return { service, calls };
  }

  const boundActor = {
    userId: 'acct-1', primaryOrgId: 'org-1',
    personId: '63000000-0000-4000-8000-000000000001', roles: ['worker'],
  };

  it('已绑定人员：按绑定人员过滤，并回传权威 personId', async () => {
    const { service, calls } = makeService();
    const result = await service.myFieldWork(boundActor);
    expect(result.personId).toBe(boundActor.personId);
    expect(result.total).toBe(1);
    expect(calls[0]).toMatchObject({ personId: boundActor.personId });
  });

  it('personName：db 句柄不可用时退回执行记录回填值；解析不到如实为 null（不伪造）', async () => {
    const withName = await makeService('张伟').service.myFieldWork(boundActor);
    expect(withName.personName).toBe('张伟');

    const withoutName = await makeService(null).service.myFieldWork(boundActor);
    expect(withoutName.personName).toBeNull();
  });

  it('未绑定人员：403 fail-closed，且不发出任何查询（不返回空列表充数）', async () => {
    const { service, calls } = makeService();
    await expect(service.myFieldWork({ ...boundActor, personId: null }))
      .rejects.toBeInstanceOf(ForbiddenException);
    expect(calls).toHaveLength(0);
  });

  it('personId 为空白字符串同样视为未绑定（不当作有效身份）', async () => {
    const { service, calls } = makeService();
    await expect(service.myFieldWork({ ...boundActor, personId: '   ' }))
      .rejects.toBeInstanceOf(ForbiddenException);
    expect(calls).toHaveLength(0);
  });

  it('缺少认证上下文（无 userId / 无 org）：403，不放行任何范围', async () => {
    const { service, calls } = makeService();
    await expect(service.myFieldWork(undefined)).rejects.toBeInstanceOf(ForbiddenException);
    await expect(service.myFieldWork({ primaryOrgId: 'org-1' } as never))
      .rejects.toBeInstanceOf(ForbiddenException);
    expect(calls).toHaveLength(0);
  });

  it('范围不可被调用方扩大：即使 actor 上挂了其它 id 字段，也只按 personId 过滤', async () => {
    const { service, calls } = makeService();
    await service.myFieldWork({
      ...boundActor,
      // 攻击者可能塞进上下文的额外字段；它们不得影响查询范围。
      userId: 'somebody-else',
      accessibleOrgIds: ['org-1', 'org-2'],
      isGlobalAdmin: false,
    } as never);
    expect(calls[0]).toMatchObject({ personId: boundActor.personId });
    expect(calls[0]).not.toHaveProperty('accessibleOrgIds');
  });
});
