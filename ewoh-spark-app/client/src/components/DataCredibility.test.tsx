import { renderToStaticMarkup } from 'react-dom/server';
import { DataCredibility } from './DataCredibility';

const FRESH = new Date(Date.now() - 60_000).toISOString();

describe('DataCredibility (UX-001 结构化可信度摘要)', () => {
  it('renders source, collection/sync times, completeness, confidence and decision flag', () => {
    const markup = renderToStaticMarkup(
      <DataCredibility
        info={{
          sourceType: 'real',
          collectedAt: FRESH,
          lastSyncedAt: FRESH,
          completeness: 1,
          confidence: 0.95,
        }}
      />,
    );
    expect(markup).toContain('真机');
    expect(markup).toContain('采集时间');
    expect(markup).toContain('最近同步');
    expect(markup).toContain('完整性');
    expect(markup).toContain('置信度');
    expect(markup).toContain('100%');
    expect(markup).toContain('95%');
    expect(markup).toContain('可用于决策');
    expect(markup).toContain('>是<');
  });

  it('surfaces stale / offline-cache / simulated-replay / non-decision-eligible states', () => {
    const markup = renderToStaticMarkup(
      <DataCredibility
        maxAgeMs={5 * 60_000}
        info={{
          sourceType: 'replayed',
          collectedAt: '2020-01-01T00:00:00Z',
          lastSyncedAt: '2020-01-01T00:00:00Z',
          isOfflineCache: true,
          isSimulatedOrReplay: true,
          completeness: 0.5,
          confidence: 0.4,
        }}
      />,
    );
    expect(markup).toContain('回放');
    expect(markup).toContain('离线缓存');
    expect(markup).toContain('模拟/回放');
    expect(markup).toContain('（已过期）');
    expect(markup).toContain('>否<');
  });

  it('renders placeholder dashes when optional fields are absent', () => {
    const markup = renderToStaticMarkup(<DataCredibility info={{}} />);
    expect(markup).toContain('—');
  });
});