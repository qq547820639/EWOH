import {
  EXPORT_IDLE,
  exportIsBusy,
  exportRecordReducer,
  exportReducer,
  exportStatusLabel,
} from './workbenchExport';

describe('workbenchExport (导出状态机)', () => {
  describe('exportReducer', () => {
    it('start moves to queued with 0 progress', () => {
      expect(exportReducer(EXPORT_IDLE, { type: 'start' })).toEqual({
        status: 'queued',
        progress: 0,
      });
    });

    it('tick updates progress while running', () => {
      const state = exportReducer(
        { status: 'running', progress: 10 },
        { type: 'tick', status: 'running', progress: 45 },
      );
      expect(state).toEqual({ status: 'running', progress: 45 });
    });

    it('terminal states ignore further ticks (防轮询竞态覆盖)', () => {
      const succeeded = exportReducer(
        { status: 'succeeded', progress: 100 },
        { type: 'tick', status: 'running', progress: 50 },
      );
      expect(succeeded.status).toBe('succeeded');
      const failed = exportReducer(
        { status: 'failed', progress: 0 },
        { type: 'tick', status: 'running', progress: 30 },
      );
      expect(failed.status).toBe('failed');
    });

    it('reset returns to idle', () => {
      expect(exportReducer({ status: 'succeeded', progress: 100 }, { type: 'reset' })).toEqual(
        EXPORT_IDLE,
      );
    });
  });

  describe('exportRecordReducer (多列表导出状态表)', () => {
    it('start/tick per listKey and reset-all', () => {
      let state = exportRecordReducer({}, { type: 'start', listKey: 'a' });
      state = exportRecordReducer(state, {
        type: 'tick',
        listKey: 'a',
        status: 'running',
        progress: 20,
      });
      expect(state.a).toEqual({ status: 'running', progress: 20 });
      expect(exportRecordReducer(state, { type: 'reset-all' })).toEqual({});
    });

    it('tick on an unknown list treats it as idle then transitions', () => {
      const state = exportRecordReducer(
        {},
        { type: 'tick', listKey: 'b', status: 'succeeded', progress: 100 },
      );
      expect(state.b.status).toBe('succeeded');
    });
  });

  describe('exportIsBusy / exportStatusLabel', () => {
    it('treats queued and running as busy', () => {
      expect(exportIsBusy({ status: 'queued', progress: 0 })).toBe(true);
      expect(exportIsBusy({ status: 'running', progress: 10 })).toBe(true);
      expect(exportIsBusy({ status: 'succeeded', progress: 100 })).toBe(false);
      expect(exportIsBusy({ status: 'idle', progress: 0 })).toBe(false);
    });

    it('maps every status to a non-empty Chinese label', () => {
      for (const status of ['idle', 'queued', 'running', 'succeeded', 'failed', 'expired']) {
        expect(exportStatusLabel(status as never).length).toBeGreaterThan(0);
      }
    });
  });
});