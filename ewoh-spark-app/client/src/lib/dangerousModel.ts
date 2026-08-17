/**
 * 危险操作状态机（纯逻辑，node 可测，无 React/DOM）。
 *
 * 覆盖工业工作台对危险操作（清空/删除/批量取消/导出等不可逆动作）的完整保障闭环：
 *   影响预览 → 二次确认 → 幂等提交 → 操作结果 → 可撤销窗口 → 审计记录。
 *
 * 该模型与 `api/operations.ts` 的 previewDangerousImpact / confirmDangerous /
 * undoDangerous 一一对应，但把「UI 会话内的状态迁移」建模为可重放的 reducer，
 * 便于单测覆盖非法迁移（未确认就执行、已撤销后再次撤销等）。
 */

export type DangerousActionKind =
  | 'transfer'
  | 'approve'
  | 'delete'
  | 'cancel'
  | 'resolve';

export interface DangerousImpact {
  action: DangerousActionKind;
  targetType: string;
  targetId: string;
  summary: string;
  affectedCount: number;
  irreversible: boolean;
  requiresConfirmation: boolean;
}

export type DangerousPhase =
  | 'idle'
  | 'previewing'
  | 'confirm'
  | 'confirming'
  | 'executed'
  | 'undone'
  | 'failed';

export interface DangerousState {
  phase: DangerousPhase;
  /** 影响预览（二次确认所需的事实依据）。 */
  impact: DangerousImpact | null;
  /** 幂等键：同一操作+同一目标确定生成，防重复提交。 */
  idempotencyKey: string | null;
  /** 确认成功后的 actionId（用于撤销）。 */
  actionId: string | null;
  /** 补偿方式（undo / restore / noop）。 */
  compensation: { kind: 'undo' | 'restore' | 'noop'; description: string } | null;
  /** 可撤销窗口（确认成功时刻 + 窗口时长，毫秒 epoch）。 */
  undoDeadline: number | null;
  /** 审计记录（每次操作结果累计）。 */
  audit: AuditRecord[];
  /** 最近一次错误信息。 */
  error: string | null;
}

export interface AuditRecord {
  at: string;
  event: string;
  action: DangerousActionKind | null;
  targetType: string | null;
  targetId: string | null;
  actionId: string | null;
  idempotencyKey: string | null;
  detail: string;
}

/** 可撤销窗口时长（ms）。 */
export const UNDO_WINDOW_MS = 5 * 60 * 1000;

/**
 * CLI-517：幂等键哈希从 FNV-1a 32 位改为同步 SHA-256。
 * 保留确定性（同输入同输出——preview 与 confirm、网络重试需得到相同键），
 * 同时把碰撞空间从 2^32 提升到 2^256，消除"不同操作碰撞后被误去重"。
 */
const SHA256_K = [
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
];

function sha256Hex(message: string): string {
  const bytes = new TextEncoder().encode(message);
  const l = bytes.length;
  const total = (((l + 8) >> 6) + 1) << 6;
  const padded = new Uint8Array(total);
  padded.set(bytes);
  padded[l] = 0x80;
  const dv = new DataView(padded.buffer);
  dv.setUint32(total - 8, Math.floor((l * 8) / 0x100000000));
  dv.setUint32(total - 4, (l * 8) >>> 0);

  let h0 = 0x6a09e667, h1 = 0xbb67ae85, h2 = 0x3c6ef372, h3 = 0xa54ff53a;
  let h4 = 0x510e527f, h5 = 0x9b05688c, h6 = 0x1f83d9ab, h7 = 0x5be0cd19;
  const w = new Uint32Array(64);
  const rotr = (x: number, n: number) => (x >>> n) | (x << (32 - n));

  for (let offset = 0; offset < total; offset += 64) {
    for (let i = 0; i < 16; i += 1) w[i] = dv.getUint32(offset + i * 4);
    for (let i = 16; i < 64; i += 1) {
      const s0 = rotr(w[i - 15], 7) ^ rotr(w[i - 15], 18) ^ (w[i - 15] >>> 3);
      const s1 = rotr(w[i - 2], 17) ^ rotr(w[i - 2], 19) ^ (w[i - 2] >>> 10);
      w[i] = (w[i - 16] + s0 + w[i - 7] + s1) >>> 0;
    }
    let a = h0, b = h1, c = h2, d = h3, e = h4, f = h5, g = h6, h = h7;
    for (let i = 0; i < 64; i += 1) {
      const S1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
      const ch = (e & f) ^ (~e & g);
      const t1 = (h + S1 + ch + SHA256_K[i] + w[i]) >>> 0;
      const S0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
      const maj = (a & b) ^ (a & c) ^ (b & c);
      const t2 = (S0 + maj) >>> 0;
      h = g; g = f; f = e; e = (d + t1) >>> 0;
      d = c; c = b; b = a; a = (t1 + t2) >>> 0;
    }
    h0 = (h0 + a) >>> 0; h1 = (h1 + b) >>> 0; h2 = (h2 + c) >>> 0; h3 = (h3 + d) >>> 0;
    h4 = (h4 + e) >>> 0; h5 = (h5 + f) >>> 0; h6 = (h6 + g) >>> 0; h7 = (h7 + h) >>> 0;
  }
  return [h0, h1, h2, h3, h4, h5, h6, h7]
    .map((x) => x.toString(16).padStart(8, '0'))
    .join('');
}

/**
 * 生成危险操作的幂等键：同一操作 + 同一目标（含目标类型/ID）必然得到相同键，
 * 防止重复点击/网络重试造成重复提交或重复撤销。
 */
export function createDangerIdempotencyKey(
  action: DangerousActionKind,
  targetType: string,
  targetId: string,
): string {
  return sha256Hex(`danger:${action}:${targetType}:${targetId}`);
}

export type DangerousAction =
  | { type: 'preview'; idempotencyKey: string }
  | { type: 'preview-success'; impact: DangerousImpact }
  | { type: 'preview-fail'; error: string }
  | { type: 'confirm' }
  | { type: 'confirm-success'; actionId: string; compensation: { kind: 'undo' | 'restore' | 'noop'; description: string }; now?: number }
  | { type: 'confirm-fail'; error: string }
  | { type: 'undo' }
  | { type: 'undo-success'; now?: number }
  | { type: 'undo-fail'; error: string }
  | { type: 'reset' };

export const DANGEROUS_IDLE: DangerousState = {
  phase: 'idle',
  impact: null,
  idempotencyKey: null,
  actionId: null,
  compensation: null,
  undoDeadline: null,
  audit: [],
  error: null,
};

function audit(
  record: AuditRecord,
  state: DangerousState,
): DangerousState {
  return { ...state, audit: [...state.audit, record] };
}

/** 判定某次操作结果是否仍处于可撤销窗口内。 */
export function isUndoable(
  undoDeadline: number | null,
  now = Date.now(),
): boolean {
  return undoDeadline !== null && now < undoDeadline;
}

/**
 * 危险操作状态迁移。不变量：
 * - 只有 `confirm` 阶段可执行 `confirm`；只有 `executed` 且未撤销才可 `undo`
 *   （时间窗口由调用方依据 `canUndo` 把关，undo-success 后进入 `undone` 即不可再撤销）。
 * - 幂等键在 `preview` 时确定，全程不变。
 */
export function dangerousReducer(
  state: DangerousState,
  action: DangerousAction,
): DangerousState {
  switch (action.type) {
    case 'preview':
      return {
        ...state,
        phase: 'previewing',
        idempotencyKey: action.idempotencyKey,
        impact: null,
        actionId: null,
        compensation: null,
        undoDeadline: null,
        error: null,
      };
    case 'preview-success':
      return audit(
        {
          at: new Date().toISOString(),
          event: 'impact-previewed',
          action: action.impact.action,
          targetType: action.impact.targetType,
          targetId: action.impact.targetId,
          actionId: null,
          idempotencyKey: state.idempotencyKey,
          detail: action.impact.summary,
        },
        {
          ...state,
          phase: action.impact.requiresConfirmation ? 'confirm' : 'executed',
          impact: action.impact,
          error: null,
        },
      );
    case 'preview-fail':
      return { ...state, phase: 'failed', error: action.error };
    case 'confirm':
      // 仅当已展示影响预览（confirm 阶段）且操作要求确认时才允许执行。
      if (state.phase !== 'confirm' || !state.impact) return state;
      return { ...state, phase: 'confirming' };
    case 'confirm-success':
      if (state.phase !== 'confirming') return state;
      const nowMs = action.now ?? Date.now();
      return audit(
        {
          at: new Date().toISOString(),
          event: 'confirmed',
          action: state.impact?.action ?? null,
          targetType: state.impact?.targetType ?? null,
          targetId: state.impact?.targetId ?? null,
          actionId: action.actionId,
          idempotencyKey: state.idempotencyKey,
          detail: '二次确认通过',
        },
        {
          ...state,
          phase: 'executed',
          actionId: action.actionId,
          compensation: action.compensation,
          undoDeadline: state.impact?.irreversible ? null : nowMs + UNDO_WINDOW_MS,
          error: null,
        },
      );
    case 'confirm-fail':
      return { ...state, phase: 'failed', error: action.error };
    case 'undo':
      // 仅校验状态合法性：已执行且存在 actionId。可撤销「时间窗口」由调用方
      // 依据 canUndo（可传入显式 now）在派发前把关，避免把真实时钟耦合进纯状态机。
      if (state.phase !== 'executed' || !state.actionId) {
        return state;
      }
      return { ...state, phase: 'confirming' };
    case 'undo-success': {
      if (state.phase !== 'confirming') return state;
      return audit(
        {
          at: new Date().toISOString(),
          event: 'undone',
          action: state.impact?.action ?? null,
          targetType: state.impact?.targetType ?? null,
          targetId: state.impact?.targetId ?? null,
          actionId: state.actionId,
          idempotencyKey: state.idempotencyKey,
          detail: '撤销成功',
        },
        { ...state, phase: 'undone', undoDeadline: null, error: null },
      );
    }
    case 'undo-fail':
      return { ...state, phase: 'failed', error: action.error };
    case 'reset':
      return DANGEROUS_IDLE;
    default:
      return state;
  }
}

/** 当前阶段对应的中文提示文案（供 UI 展示）。 */
export function dangerousPhaseLabel(phase: DangerousPhase): string {
  switch (phase) {
    case 'idle':
      return '';
    case 'previewing':
      return '正在评估影响…';
    case 'confirm':
      return '请二次确认该操作';
    case 'confirming':
      return '正在执行…';
    case 'executed':
      return '操作已执行';
    case 'undone':
      return '操作已撤销';
    case 'failed':
      return '操作失败';
    default:
      return '';
  }
}

/** 是否可展示『撤销』入口（已执行、可补偿、且在窗口内）。 */
export function canUndo(state: DangerousState, now = Date.now()): boolean {
  return (
    state.phase === 'executed' &&
    state.compensation !== null &&
    state.actionId !== null &&
    isUndoable(state.undoDeadline, now)
  );
}