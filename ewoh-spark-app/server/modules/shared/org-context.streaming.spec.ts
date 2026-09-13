import { Writable } from 'node:stream';
import { Observable, firstValueFrom, lastValueFrom, toArray } from 'rxjs';
import { AiController } from '../ai/ai.controller';
import { FileController } from '../files/file.controller';
import { OperationsController } from '../operations/operations.controller';
import {
  OrgContextInterceptor,
  isStreamingHandler,
} from './org-context.interceptor';

/**
 * 流式豁免元数据键：这里刻意写**契约字面量**而不是复用实现导出的常量，
 * 这样本文件在修复前也能编译并通过"行为断言失败"暴露缺陷，而不是编译不过。
 */
const STREAMING_METADATA = 'ewoh:streaming-response';

const ORG_CONTEXT = { userId: 'user-1', primaryOrgId: 'org-root' };

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

/** 用 @StreamingResponse() 同款元数据标记一个 handler（元数据挂在 handler 函数上）。 */
function streamingHandlerContext(userContext: unknown = ORG_CONTEXT) {
  const handler = function stream() {
    /* noop */
  };
  Reflect.defineMetadata(STREAMING_METADATA, true, handler);
  return {
    getType: () => 'http',
    getHandler: () => handler,
    switchToHttp: () => ({ getRequest: () => ({ userContext }) }),
  } as never;
}

function plainHandlerContext(request: { userContext?: unknown } = { userContext: ORG_CONTEXT }) {
  return {
    getType: () => 'http',
    getHandler: () => function plain() {
      /* noop */
    },
    switchToHttp: () => ({ getRequest: () => request }),
  } as never;
}

/** 记录"请求事务当前是否打开 / 被调用了几次"，模拟真实 RequestDatabaseContext。 */
function txTracker() {
  const state = { open: false, calls: 0 };
  const runInTransaction = jest.fn(
    async (_settings: unknown, operation: () => Promise<unknown>) => {
      state.open = true;
      state.calls += 1;
      try {
        return await operation();
      } finally {
        state.open = false;
      }
    },
  );
  return { state, runInTransaction };
}

/** 一个把响应保持在打开状态（客户端还没收完）的 Express 替身。 */
function stalledResponse() {
  const res = new Writable({
    // 永远不调用 callback：客户端连接保持打开，模拟长流未结束。
    write() {
      /* noop */
    },
  }) as Writable & { setHeader: () => void; flushHeaders: () => void };
  res.setHeader = () => undefined;
  res.flushHeaders = () => undefined;
  return res;
}

function httpHandlerContext(handler: unknown, request: unknown) {
  return {
    getType: () => 'http',
    getHandler: () => handler,
    switchToHttp: () => ({
      getRequest: () => request,
      getResponse: () => stalledResponse(),
    }),
  } as never;
}

describe('OrgContextInterceptor — 流式端点豁免（H：流期间不持有请求事务）', () => {
  it('流式 handler 在流仍打开期间不持有请求事务（runInTransaction 不被调用）', async () => {
    const { state, runInTransaction } = txTracker();
    const interceptor = new OrgContextInterceptor({ runInTransaction } as never);
    const started = deferred();
    const release = deferred();
    const stream$ = new Observable<string>((subscriber) => {
      subscriber.next('event-a');
      started.resolve();
      void release.promise.then(() => {
        subscriber.next('event-b');
        subscriber.complete();
      });
    });

    const result = lastValueFrom(
      interceptor
        .intercept(streamingHandlerContext(), { handle: () => stream$ } as never)
        .pipe(toArray()),
    );

    await started.promise;
    // 关键不变量：增量已经推给客户端、流还没结束时，拦截器不得持有请求级事务。
    expect(runInTransaction).not.toHaveBeenCalled();
    expect(state.open).toBe(false);

    release.resolve();
    await expect(result).resolves.toEqual(['event-a', 'event-b']);
    expect(runInTransaction).not.toHaveBeenCalled();
  });

  it('@Sse 端点仍直通（原有行为不回退）', async () => {
    const { runInTransaction } = txTracker();
    const interceptor = new OrgContextInterceptor({ runInTransaction } as never);
    const handler = function sse() {
      /* noop */
    };
    Reflect.defineMetadata('__sse__', true, handler);

    const result = await firstValueFrom(
      interceptor.intercept(
        {
          getType: () => 'http',
          getHandler: () => handler,
          switchToHttp: () => ({ getRequest: () => ({ userContext: ORG_CONTEXT }) }),
        } as never,
        { handle: () => new Observable((s) => { s.next('a'); s.next('b'); s.complete(); }) } as never,
      ),
    );

    expect(result).toBe('a');
    expect(runInTransaction).not.toHaveBeenCalled();
  });

  it('非流式 handler 仍然走请求事务并下发 org GUC（豁免没有扩大化）', async () => {
    const { runInTransaction } = txTracker();
    const interceptor = new OrgContextInterceptor({ runInTransaction } as never);

    const result = await lastValueFrom(
      interceptor.intercept(
        plainHandlerContext(),
        { handle: () => new Observable((s) => { s.next('ok'); s.complete(); }) } as never,
      ),
    );

    expect(result).toBe('ok');
    expect(runInTransaction).toHaveBeenCalledTimes(1);
    expect(runInTransaction).toHaveBeenCalledWith(
      expect.arrayContaining([{ name: 'app.current_org_ids', value: 'org-root' }]),
      expect.any(Function),
    );
  });

  it('无 userContext 的请求仍不做事务（不改动既有分支）', async () => {
    const { runInTransaction } = txTracker();
    const interceptor = new OrgContextInterceptor({ runInTransaction } as never);

    await lastValueFrom(
      interceptor.intercept(
        plainHandlerContext({}),
        { handle: () => new Observable((s) => { s.next('ok'); s.complete(); }) } as never,
      ),
    );

    expect(runInTransaction).not.toHaveBeenCalled();
  });
});

describe('OrgContextInterceptor — 真实端点的流式标记', () => {
  it('手写 @Res() 的 AI 流式端点被标记为流式', () => {
    expect(isStreamingHandler(AiController.prototype.chat)).toBe(true);
    expect(isStreamingHandler(AiController.prototype.suggestionStream)).toBe(true);
  });

  it('下载类 @Res() 端点不标记：handler 在 pipe 开始后立即返回，事务早已提交', () => {
    // 独立复核结论（2026-08-18）：这两个端点虽然手写 @Res()，但 handler 把
    // Readable pipe 给响应后立刻 return，拦截器的 lastValueFrom 随即 resolve →
    // 事务在流还在传输时就已经提交，不存在"整条流持有事务"的问题。
    // 用探针实测过：流未结束（writableEnded=false）而 tx 已关闭。
    expect(isStreamingHandler(FileController.prototype.download)).toBe(false);
    expect(isStreamingHandler(OperationsController.prototype.downloadExport)).toBe(false);
  });

  it('非函数 handler 一律不视为流式（防御 Reflect 元数据查询）', () => {
    expect(isStreamingHandler(undefined)).toBe(false);
    expect(isStreamingHandler('not-a-function')).toBe(false);
  });
});

describe('AiController /api/ai/chat — 长回答不再占满连接池', () => {
  function chatController(aiService: unknown, runInTransaction: unknown) {
    return new AiController(aiService as never, {} as never, {
      runInTransaction,
    } as never);
  }

  it('LLM 流打开期间不持有请求事务；建立步的租户事务在首个增量后已提交', async () => {
    const { state, runInTransaction } = txTracker();
    const firstChunkSent = deferred();
    const release = deferred();
    const aiService = {
      chatWithContextStream: async function* () {
        yield { delta: 'a' };
        firstChunkSent.resolve();
        await release.promise; // LLM 长时间思考：流保持打开
        yield { delta: 'b' };
      },
      getArkModel: async () => 'model-x',
    };
    const controller = chatController(aiService, runInTransaction);
    const interceptor = new OrgContextInterceptor({ runInTransaction } as never);
    const res = stalledResponse();

    const done = lastValueFrom(
      interceptor.intercept(
        httpHandlerContext(AiController.prototype.chat, {
          userContext: ORG_CONTEXT,
        }),
        {
          handle: () =>
            new Observable((subscriber) => {
              void controller
                .chat({ question: '设备负荷如何？' }, res as never, {
                  userContext: ORG_CONTEXT,
                })
                .then(
                  (value) => {
                    subscriber.next(value);
                    subscriber.complete();
                  },
                  (error) => subscriber.error(error),
                );
            }),
        } as never,
      ),
    );

    await firstChunkSent.promise;
    // 建立步（collectSystemContext 的 RLS 读）确实在租户事务里跑过——租户收敛没被削弱。
    expect(runInTransaction).toHaveBeenCalledTimes(1);
    // 但流还开着时事务已经提交，连接已经还给池子。
    expect(state.open).toBe(false);

    release.resolve();
    await done;
    expect(state.calls).toBe(1);
    expect(state.open).toBe(false);
  });

  it('流中途失败时仍会关闭生成器（不改手写推进会漏掉 for await 的 return）', async () => {
    const { runInTransaction } = txTracker();
    let returned = false;
    const generator = {
      calls: 0,
      async next(): Promise<IteratorResult<{ delta: string }>> {
        this.calls += 1;
        if (this.calls === 1) {
          return { done: false, value: { delta: 'a' } };
        }
        throw new Error('Ark 流中断');
      },
      async return(): Promise<IteratorResult<{ delta: string }>> {
        returned = true;
        return { done: true, value: undefined };
      },
      [Symbol.asyncIterator]() {
        return this;
      },
    };
    const controller = chatController(
      { chatWithContextStream: () => generator, getArkModel: async () => 'm' },
      runInTransaction,
    );
    const interceptor = new OrgContextInterceptor({ runInTransaction } as never);

    await lastValueFrom(
      interceptor.intercept(
        httpHandlerContext(AiController.prototype.chat, { userContext: ORG_CONTEXT }),
        {
          handle: () =>
            new Observable((subscriber) => {
              void controller
                .chat({ question: 'q' }, stalledResponse() as never, {
                  userContext: ORG_CONTEXT,
                })
                .then(
                  (value) => {
                    subscriber.next(value);
                    subscriber.complete();
                  },
                  (error) => subscriber.error(error),
                );
            }),
        } as never,
      ),
    );

    // 生成器被关闭 → 内层 Ark 流的 reader.releaseLock() 才会执行。
    expect(returned).toBe(true);
  });
});
