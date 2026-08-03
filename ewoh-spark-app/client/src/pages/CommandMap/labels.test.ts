import { fitLabel, truncateLabel } from './labels';

describe('map label helpers', () => {
  it('truncates long labels with an ellipsis', () => {
    expect(truncateLabel('一号工位装配区', 5)).toBe('一号工位…');
    expect(truncateLabel('短名称', 8)).toBe('短名称');
  });

  it('hides labels when the box is too small', () => {
    expect(fitLabel('一号工位装配区', 8, 11)).toBeNull();
  });

  it('fits labels proportionally to box width', () => {
    const label = fitLabel('一号工位装配区', 40, 11);
    expect(label).not.toBeNull();
    expect(label!.length).toBeLessThan('一号工位装配区'.length);
  });
});
