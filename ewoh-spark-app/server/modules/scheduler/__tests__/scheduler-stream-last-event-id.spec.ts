/* P2 收尾：SSE Last-Event-ID 增量续传接线测试（controller stream() 层）。
 *
 * replaySince 纯函数已在 phase2-realtime.spec.ts 覆盖（重放/缺口/幂等过滤），
 * 本 spec 覆盖 controller 接线：
 *   a) 带 Last-Event-ID 且无缺口 → 先收到重放增量事件（sequence 升序），再接实时事件；
 *   b) 带 Last-Event-ID 但有缺口/客户端超前 → 收到 resync 事件（含 currentSequence/reason）；
 *   c) 无 Last-Event-ID（首次连接）→ 无重放、无 resync（与历史行为等价），实时订阅照常；
 *   d) 非法 Last-Event-ID → 视为首次连接（无重放）。
 */
/// <reference types="jest" />
import { Subject } from 'rxjs';
import type { MessageEvent } from '@nestjs/common';
import { SchedulerController } from '../scheduler.controller';
import { SchedulerService } from '../scheduler.service';
import { SchedulerStreamService } from '../scheduler-stream.service';
import type { SchedulingEvent } from '@shared/api.interface';

function makeEvent(sequence: number, extra: Partial<SchedulingEvent> = {}): SchedulingEvent {
  return {
    eventId: `evt-${sequence}`,
    eventType: 'plan.created',
    entityId: 'PLAN-1',
    version: 1,
    sequence,
    payload: { planId: 'PLAN-1' },
    sourceTs: new Date().toISOString(),
    serverTs: new Date().toISOString(),
    ...extra,
  };
}

interface ControllerHarness {
  controller: SchedulerController;
  streamSvc: {
    start: jest.Mock;
    events: jest.Mock;
    replaySince: jest.Mock;
  };
  subject: Subject<SchedulingEvent>;
}

function makeHarness(): ControllerHarness {
  const subject = new Subject<SchedulingEvent>();
  const streamSvc = {
    start: jest.fn().mockResolvedValue(undefined),
    events: jest.fn(() => subject.asObservable()),
    replaySince: jest.fn(),
  };
  const controller = new SchedulerController(
    {} as unknown as SchedulerService,
    streamSvc as unknown as SchedulerStreamService,
    {} as never,
    {} as never,
    {} as never, // conflictService
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
  );
  return { controller, streamSvc, subject };
}

/** 等待微任务 + 宏任务清空，使 replaySince promise 与订阅回调执行完毕。 */
async function flush(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

function schedulingEvents(messages: MessageEvent[]): SchedulingEvent[] {
  return messages
    .filter((m) => m.type === 'scheduling.event')
    .map((m) => JSON.parse(String(m.data)) as SchedulingEvent);
}

describe('SchedulerController SSE Last-Event-ID 增量续传（P2 收尾）', () => {
  it('a) 带 last-event-id 且无缺口 → 先收到重放增量事件，再接实时事件（不丢不重）', async () => {
    const { controller, streamSvc, subject } = makeHarness();
    streamSvc.replaySince.mockResolvedValue({
      events: [makeEvent(6), makeEvent(7)],
      resyncNeeded: false,
      gap: false,
      currentSequence: 7,
    });

    const collected: MessageEvent[] = [];
    const sub = controller.stream('5').subscribe((m) => collected.push(m));
    await flush();

    // 重放增量事件先到达（sequence 升序），无 resync。
    expect(streamSvc.replaySince).toHaveBeenCalledWith(5, 5);
    expect(collected.some((m) => m.type === 'resync')).toBe(false);
    expect(schedulingEvents(collected).map((e) => e.sequence)).toEqual([6, 7]);

    // 实时事件（重放之后到达）按序追加，不重复。
    subject.next(makeEvent(8));
    await flush();
    expect(schedulingEvents(collected).map((e) => e.sequence)).toEqual([6, 7, 8]);

    // 事件携带 SSE id = sequence（客户端据此续传）。
    const first = collected.find((m) => m.type === 'scheduling.event');
    expect(first?.id).toBe('6');
    sub.unsubscribe();
  });

  it('b) 带 last-event-id 但有缺口 → 收到 resync 事件（含 currentSequence/原因），不发重放', async () => {
    const { controller, streamSvc } = makeHarness();
    streamSvc.replaySince.mockResolvedValue({
      events: [],
      resyncNeeded: true,
      gap: true,
      currentSequence: 42,
    });

    const collected: MessageEvent[] = [];
    const sub = controller.stream('5').subscribe((m) => collected.push(m));
    await flush();

    expect(streamSvc.replaySince).toHaveBeenCalledWith(5, 5);
    const resync = collected.find((m) => m.type === 'resync');
    expect(resync).toBeDefined();
    const data = JSON.parse(String(resync?.data)) as { currentSequence: number; reason: string };
    expect(data.currentSequence).toBe(42);
    expect(data.reason).toContain('gap');
    // resync 事件本身带 id = currentSequence（客户端可据此重置游标）。
    expect(resync?.id).toBe('42');
    // 缺口下不发送增量重放事件。
    expect(schedulingEvents(collected)).toHaveLength(0);
    sub.unsubscribe();
  });

  it('b2) 带 last-event-id 但客户端超前 → 收到 resync（reason=client ahead）', async () => {
    const { controller, streamSvc } = makeHarness();
    streamSvc.replaySince.mockResolvedValue({
      events: [],
      resyncNeeded: true,
      gap: false,
      currentSequence: 10,
    });

    const collected: MessageEvent[] = [];
    const sub = controller.stream('99').subscribe((m) => collected.push(m));
    await flush();

    const resync = collected.find((m) => m.type === 'resync');
    expect(resync).toBeDefined();
    const data = JSON.parse(String(resync?.data)) as { reason: string };
    expect(data.reason).toContain('ahead');
    sub.unsubscribe();
  });

  it('c) 无 last-event-id（首次连接）→ 不调用 replaySince、无 resync，实时订阅照常（与现状等价）', async () => {
    const { controller, streamSvc, subject } = makeHarness();

    const collected: MessageEvent[] = [];
    const sub = controller.stream(undefined).subscribe((m) => collected.push(m));
    await flush();

    expect(streamSvc.replaySince).not.toHaveBeenCalled();
    expect(collected.some((m) => m.type === 'resync')).toBe(false);
    expect(schedulingEvents(collected)).toHaveLength(0);

    // 实时事件照常推送。
    subject.next(makeEvent(1));
    await flush();
    expect(schedulingEvents(collected).map((e) => e.sequence)).toEqual([1]);
    sub.unsubscribe();
  });

  it('d) 非法 last-event-id（非数字/负数）→ 视为首次连接，无重放', async () => {
    const { controller, streamSvc } = makeHarness();
    const collected: MessageEvent[] = [];

    const sub1 = controller.stream('abc').subscribe((m) => collected.push(m));
    await flush();
    expect(streamSvc.replaySince).not.toHaveBeenCalled();
    sub1.unsubscribe();

    const sub2 = controller.stream('-3').subscribe((m) => collected.push(m));
    await flush();
    expect(streamSvc.replaySince).not.toHaveBeenCalled();
    sub2.unsubscribe();
  });

  it('所有连接都会启动轮询（start 被调用）', async () => {
    const { controller, streamSvc } = makeHarness();
    streamSvc.replaySince.mockResolvedValue({
      events: [],
      resyncNeeded: false,
      gap: false,
      currentSequence: 0,
    });

    const sub1 = controller.stream('0').subscribe(() => undefined);
    const sub2 = controller.stream(undefined).subscribe(() => undefined);
    await flush();
    expect(streamSvc.start).toHaveBeenCalledTimes(2);
    sub1.unsubscribe();
    sub2.unsubscribe();
  });
});
