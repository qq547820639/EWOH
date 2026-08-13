/* P1-1：Task DAG 传递下游阻塞闭包回归测试。 */
/// <reference types="jest" />
import { computeBlockingReach } from '../task-dag';

function t(id: string, predecessorIds: string[] = []) {
  return { id, predecessorIds };
}

describe('task-dag computeBlockingReach（传递下游可达数）', () => {
  it('链 A→B→C：可达数 2/1/0', () => {
    const reach = computeBlockingReach([
      t('A'),
      t('B', ['A']),
      t('C', ['B']),
    ]);
    expect(reach.get('A')).toBe(2);
    expect(reach.get('B')).toBe(1);
    expect(reach.get('C')).toBe(0);
  });

  it('菱形 A→B、A→C、B→D、C→D：A=3、B=1、C=1、D=0', () => {
    const reach = computeBlockingReach([
      t('A'),
      t('B', ['A']),
      t('C', ['A']),
      t('D', ['B', 'C']),
    ]);
    expect(reach.get('A')).toBe(3);
    expect(reach.get('B')).toBe(1);
    expect(reach.get('C')).toBe(1);
    expect(reach.get('D')).toBe(0);
  });

  it('环 A↔B：不无限递归、结果确定且非负', () => {
    const reach = computeBlockingReach([t('A', ['B']), t('B', ['A'])]);
    expect(reach.get('A')).toBeGreaterThanOrEqual(0);
    expect(reach.get('B')).toBeGreaterThanOrEqual(0);
    // 确定性：重复计算一致。
    expect(computeBlockingReach([t('A', ['B']), t('B', ['A'])])).toEqual(reach);
  });

  it('无依赖任务全部为 0', () => {
    const reach = computeBlockingReach([t('X'), t('Y'), t('Z')]);
    expect(reach.get('X')).toBe(0);
    expect(reach.get('Y')).toBe(0);
    expect(reach.get('Z')).toBe(0);
  });

  it('多前驱归并：A 阻塞 B、C 均依赖 A', () => {
    const reach = computeBlockingReach([t('A'), t('B', ['A']), t('C', ['A'])]);
    expect(reach.get('A')).toBe(2);
    expect(reach.get('B')).toBe(0);
    expect(reach.get('C')).toBe(0);
  });
});
