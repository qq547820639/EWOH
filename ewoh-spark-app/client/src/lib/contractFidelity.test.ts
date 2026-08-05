/**
 * contractFidelity.test.ts
 *
 * Wave W4 "OpenAPI 与前后端契约自动化" — 契约类型保真测试。
 * 覆盖：错误契约（errorContract）、分页、取消（AbortSignal）、幂等键、
 * 附件、离线同步类型。能使用生成契约类型（components['schemas']）的地方
 * 一律使用生成类型，业务运行时逻辑复用现有模块（errorContract / offlineQueue）。
 */
import type { components } from '../types/openapi';
import { parseError } from './errorContract';
import {
  PENDING_ACTION_STATUSES,
  type PendingMobileAction,
  type PendingActionStatus,
} from './offlineQueue';
import type { StoredPendingAction } from './offlineDb';

describe('错误契约（ErrorResponse ↔ parseError）', () => {
  it('parseError 解析的结果与生成契约 ErrorResponse.error 对齐', () => {
    const errorBody: components['schemas']['ErrorResponse']['error'] = {
      code: 'BUSINESS_VALIDATION',
      errorCode: 'BUSINESS_VALIDATION',
      message: '工单号不能为空',
      requestId: 'req-contract-1',
      retryable: false,
      recommendedAction: '请补充工单号',
    };
    const parsed = parseError({
      response: { status: 422, data: { error: errorBody } },
    });
    expect(parsed.kind).toBe('validation');
    expect(parsed.code).toBe('BUSINESS_VALIDATION');
    expect(parsed.requestId).toBe('req-contract-1');
    expect(parsed.recommendedAction).toBe('请补充工单号');
  });

  it('契约声明 ErrorResponse.error.retryable 为布尔，可用于幂等重试决策', () => {
    const errorBody: components['schemas']['ErrorResponse']['error'] = {
      code: 'SERVER_ERROR',
      errorCode: 'SERVER_ERROR',
      message: '服务器内部错误',
      requestId: 'req-2',
      retryable: true,
      recommendedAction: '请稍后重试',
    };
    expect(typeof errorBody.retryable).toBe('boolean');
    expect(errorBody.retryable).toBe(true);
  });
});

describe('分页（CursorPage）', () => {
  it('CursorPage 契约类型可承载分页结果', () => {
    const page: components['schemas']['CursorPage'] = {
      items: [],
      nextCursor: 'cursor-abc',
      hasMore: true,
    };
    expect(page.items).toHaveLength(0);
    expect(page.hasMore).toBe(true);
    expect(page.nextCursor).toBe('cursor-abc');
  });

  it('无下一页时 nextCursor 可为 null 且 hasMore 为 false', () => {
    const lastPage: components['schemas']['CursorPage'] = {
      items: [],
      nextCursor: null,
      hasMore: false,
    };
    expect(lastPage.nextCursor).toBeNull();
    expect(lastPage.hasMore).toBe(false);
  });
});

describe('取消（AbortSignal）', () => {
  it('AbortSignal 可被构造并用于取消语义', () => {
    const controller = new AbortController();
    const signal: AbortSignal = controller.signal;
    expect(signal.aborted).toBe(false);
    controller.abort();
    expect(signal.aborted).toBe(true);
  });

  it('契约分页/请求请求体可在取消场景下与 AbortSignal 组合', () => {
    // 类型级：一个携带 signal 的请求参数变量可被 AbortController.signal 赋值。
    const params: { signal?: AbortSignal; idempotencyKey?: string } = {};
    const controller = new AbortController();
    params.signal = controller.signal;
    params.idempotencyKey = 'req-key-1';
    expect(params.signal).toBe(controller.signal);
    expect(params.idempotencyKey).toBe('req-key-1');
  });
});

describe('幂等键（idempotencyKey）', () => {
  it('契约 MesForceResolveRequest 声明可选 idempotencyKey', () => {
    const req: components['schemas']['MesForceResolveRequest'] = {
      resolution: 'local',
      idempotencyKey: 'resolve-wo-1',
      action: 'complete',
    };
    expect(req.idempotencyKey).toBe('resolve-wo-1');
    // 幂等键可缺省（离线提交时后端去重依据）。
    const withoutKey: components['schemas']['MesForceResolveRequest'] = {
      resolution: 'server',
    };
    expect(withoutKey.idempotencyKey).toBeUndefined();
  });

  it('离线排队动作具备移动端同步所需的最小字段', () => {
    const action: PendingMobileAction = {
      id: 'act-1',
      type: 'transition',
      orderId: 'WO-1',
      stepId: 'S2',
      action: 'complete',
      queuedAt: '2026-08-05T00:00:00Z',
      status: 'queued',
    };
    expect(action.type).toBe('transition');
    expect(action.status).toBe('queued');
  });
});

describe('附件（FileUpload / PendingMobileAction.attachment）', () => {
  it('契约 FileUpload 类型可承载上传文件字段', () => {
    const upload: components['schemas']['FileUpload'] = {
      file: 'data:image/png;base64,AAAA',
      note: '异常照片',
    };
    expect(upload.file).toContain('data:image/png');
    expect(upload.note).toBe('异常照片');
  });

  it('离线同步附件携带 name/contentType/dataUrl', () => {
    const action: PendingMobileAction = {
      id: 'act-2',
      type: 'inspection',
      orderId: 'WO-2',
      stepId: 'S1',
      attachment: {
        name: 'photo.png',
        contentType: 'image/png',
        dataUrl: 'data:image/png;base64,BBBB',
      },
      queuedAt: '2026-08-05T00:00:00Z',
      status: 'local',
    };
    expect(action.attachment?.contentType).toBe('image/png');
    expect(action.attachment?.name).toBe('photo.png');
  });
});

describe('离线同步类型（PendingMobileAction / PendingActionStatus）', () => {
  it('状态枚举覆盖本地排队 → 同步 → 冲突的完整生命周期', () => {
    expect(PENDING_ACTION_STATUSES).toEqual(
      expect.arrayContaining(['local', 'queued', 'syncing', 'synced', 'failed', 'conflict']),
    );
    const status: PendingActionStatus = 'conflict';
    expect(PENDING_ACTION_STATUSES).toContain(status);
  });

  it('离线同步动作可携带幂等键以支持后端安全重投（#9）', () => {
    const stored: StoredPendingAction = {
      key: 'k-9',
      id: 'act-3',
      type: 'transition',
      orderId: 'WO-3',
      stepId: 'S4',
      idempotencyKey: 'idem-wo-3-s4',
      queuedAt: '2026-08-05T00:00:00Z',
      status: 'synced',
    };
    expect(stored.idempotencyKey).toBe('idem-wo-3-s4');
    expect(stored.status).toBe('synced');
  });
});