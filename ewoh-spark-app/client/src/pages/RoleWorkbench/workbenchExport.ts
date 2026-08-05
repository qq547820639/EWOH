import type { WorkbenchExportStatus } from '../../api/operations';

/**
 * 角色工作台「导出任务」状态机（纯函数，node 可测，无 React/DOM）。
 *
 * 导出是异步任务：创建后进入 queued/running，轮询更新进度，最终 succeeded/failed/expired。
 * 本模块用 reducer 收敛所有状态迁移，避免在组件内散落 setState 分支，并可被单测覆盖
 * 非法迁移（如 failed 后再 running）。
 */

/** 单个列表的导出任务状态。 */
export interface ExportState {
  status: WorkbenchExportStatus | 'idle';
  progress: number;
}

export type ExportAction =
  | { type: 'start' }
  | { type: 'tick'; status: WorkbenchExportStatus; progress: number }
  | { type: 'reset' };

export const EXPORT_IDLE: ExportState = { status: 'idle', progress: 0 };

const TERMINAL: ReadonlySet<WorkbenchExportStatus | 'idle'> = new Set<
  WorkbenchExportStatus | 'idle'
>(['succeeded', 'failed', 'expired']);

/** 导出任务是否仍在进行中（可展示进度）。 */
export function exportIsBusy(state: ExportState): boolean {
  return state.status === 'queued' || state.status === 'running';
}

/** 导出任务的中文展示文案。 */
export function exportStatusLabel(status: WorkbenchExportStatus | 'idle'): string {
  switch (status) {
    case 'queued':
    case 'running':
      return '导出中';
    case 'succeeded':
      return '导出完成';
    case 'failed':
      return '导出失败';
    case 'expired':
      return '导出已过期';
    case 'idle':
      return '未开始';
    default:
      return '';
  }
}

/**
 * 导出状态迁移。终端状态（succeeded/failed/expired）不接受后续 tick，保持原值，
 * 防止轮询竞态把已完成/已失败的任务覆盖回 running。
 */
export function exportReducer(
  state: ExportState,
  action: ExportAction,
): ExportState {
  switch (action.type) {
    case 'reset':
      return EXPORT_IDLE;
    case 'start':
      return { status: 'queued', progress: 0 };
    case 'tick': {
      if (TERMINAL.has(state.status)) {
        return state;
      }
      return { status: action.status, progress: action.progress };
    }
    default:
      return state;
  }
}

export type ExportRecordAction =
  | { type: 'start'; listKey: string }
  | { type: 'tick'; listKey: string; status: WorkbenchExportStatus; progress: number }
  | { type: 'reset-all' };

/** 多列表导出状态表 reducer：按 listKey 分桶，复用 exportReducer 的状态迁移。 */
export function exportRecordReducer(
  state: Record<string, ExportState>,
  action: ExportRecordAction,
): Record<string, ExportState> {
  switch (action.type) {
    case 'reset-all':
      return {};
    case 'start':
      return { ...state, [action.listKey]: { status: 'queued', progress: 0 } };
    case 'tick': {
      const current = state[action.listKey] ?? EXPORT_IDLE;
      return {
        ...state,
        [action.listKey]: exportReducer(current, {
          type: 'tick',
          status: action.status,
          progress: action.progress,
        }),
      };
    }
    default:
      return state;
  }
}