import { createTranslator, interpolate, t, zhCN } from './i18n';

describe('interpolate', () => {
  it('replaces {var} placeholders with values', () => {
    expect(interpolate('节点数：{count}', { count: 42 })).toBe('节点数：42');
  });

  it('leaves unknown placeholders intact', () => {
    expect(interpolate('x {missing}', { other: 1 })).toBe('x {missing}');
  });

  it('returns template unchanged when no vars passed', () => {
    expect(interpolate('a {b}')).toBe('a {b}');
  });
});

describe('createTranslator', () => {
  it('returns the message for a known key', () => {
    expect(t('a11y.skipToContent')).toBe('跳到主内容');
  });

  it('falls back to the key when unknown', () => {
    expect(t('unknown.key')).toBe('unknown.key');
  });

  it('interpolates variables', () => {
    expect(t('a11y.graph.nodeCount', { count: 7 })).toBe('节点数：7');
  });

  it('supports a custom dictionary (e.g. future English translation)', () => {
    const en = createTranslator({ ...zhCN, 'a11y.skipToContent': 'Skip to content' });
    expect(en('a11y.skipToContent')).toBe('Skip to content');
  });
});