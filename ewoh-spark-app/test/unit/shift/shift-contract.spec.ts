/* 班次域契约测试（standalone_074，DR-2）：共享纯函数 resolveShiftAt /
 * isWithinShiftWindow 的窗口判定语义（前后端同构口径的唯一事实源）。 */
import {
  isWithinShiftWindow,
  resolveShiftAt,
  type ShiftDefinition,
} from '../../../shared/shift';

function shift(partial: Partial<ShiftDefinition> & { shiftId: string; name: string }): ShiftDefinition {
  return {
    startTime: '08:00',
    endTime: '16:00',
    crossesMidnight: false,
    active: true,
    ...partial,
  };
}

describe('班次窗口判定（isWithinShiftWindow）', () => {
  it('普通窗口：包含 start、不包含 end（左闭右开）', () => {
    const day = shift({ shiftId: 'A', name: '早班' });
    expect(isWithinShiftWindow(day, '08:00')).toBe(true);
    expect(isWithinShiftWindow(day, '12:30')).toBe(true);
    expect(isWithinShiftWindow(day, '15:59')).toBe(true);
    expect(isWithinShiftWindow(day, '16:00')).toBe(false);
    expect(isWithinShiftWindow(day, '07:59')).toBe(false);
  });

  it('跨零点窗口：晚段与次日凌晨段都命中', () => {
    const night = shift({
      shiftId: 'N', name: '夜班', startTime: '22:00', endTime: '06:00', crossesMidnight: true,
    });
    expect(isWithinShiftWindow(night, '22:00')).toBe(true);
    expect(isWithinShiftWindow(night, '23:59')).toBe(true);
    expect(isWithinShiftWindow(night, '00:00')).toBe(true);
    expect(isWithinShiftWindow(night, '05:59')).toBe(true);
    expect(isWithinShiftWindow(night, '06:00')).toBe(false);
    expect(isWithinShiftWindow(night, '12:00')).toBe(false);
  });

  it('零长度窗口与非法时间被拒绝（不猜测）', () => {
    expect(isWithinShiftWindow(shift({ shiftId: 'X', name: 'x', startTime: '08:00', endTime: '08:00' }), '08:00')).toBe(false);
    expect(isWithinShiftWindow(shift({ shiftId: 'Y', name: 'y' }), 'bad-time')).toBe(false);
  });
});

describe('当前班次解析（resolveShiftAt）', () => {
  const early = shift({ shiftId: 'E', name: '早班', startTime: '08:00', endTime: '16:00' });
  const mid = shift({ shiftId: 'M', name: '中班', startTime: '16:00', endTime: '24:00' });
  const night = shift({ shiftId: 'N', name: '夜班', startTime: '22:00', endTime: '06:00', crossesMidnight: true });
  const shifts = [early, mid, night];

  it('10:00 → 早班，下一班中班', () => {
    const r = resolveShiftAt(shifts, new Date(2026, 8, 11, 10, 0));
    expect(r.current?.shiftId).toBe('E');
    expect(r.next?.shiftId).toBe('M');
  });

  it('20:00 → 中班，下一班夜班', () => {
    const r = resolveShiftAt(shifts, new Date(2026, 8, 11, 20, 0));
    expect(r.current?.shiftId).toBe('M');
    expect(r.next?.shiftId).toBe('N');
  });

  it('03:00 → 跨零点夜班（次日凌晨段），下一班早班', () => {
    const r = resolveShiftAt(shifts, new Date(2026, 8, 11, 3, 0));
    expect(r.current?.shiftId).toBe('N');
    expect(r.next?.shiftId).toBe('E');
  });

  it('窗口间隙（如 06:00–08:00 之间）→ current=null 显式未知，不猜默认班', () => {
    const r = resolveShiftAt(shifts, new Date(2026, 8, 11, 7, 0));
    expect(r.current).toBeNull();
    expect(r.next?.shiftId).toBe('E');
  });

  it('无班次定义 → current/next 均 null', () => {
    const r = resolveShiftAt([], new Date());
    expect(r.current).toBeNull();
    expect(r.next).toBeNull();
  });

  it('inactive 班次不参与解析', () => {
    const r = resolveShiftAt(
      [shift({ shiftId: 'E', name: '早班', active: false }), mid],
      new Date(2026, 8, 11, 9, 0),
    );
    expect(r.current).toBeNull();
  });
});
