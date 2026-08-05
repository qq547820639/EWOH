import { renderToStaticMarkup } from 'react-dom/server';
import Timeline, {
  serializeTimelineEvents,
  exportTimelineCsv,
  exportTimelineJson,
} from './Timeline';
import type { TimelineEvent } from '../lib/timelineModel';

const ev = (over: Partial<TimelineEvent> & { id: string }): TimelineEvent => ({
  timestamp: '2026-01-01T00:00:00Z',
  actor: 'system',
  source: 'alert',
  objectType: 'alert',
  objectId: over.id,
  action: 'triggered',
  previousState: null,
  currentState: 'open',
  correlationId: null,
  causationId: null,
  evidence: [],
  credibility: { sourceType: 'real', decisionAuthorized: true },
  permissionVisibility: 'visible',
  ...over,
});

describe('Timeline (统一对象时间线组件)', () => {
  it('renders unified events with anchor link, source badge and audit export', () => {
    const markup = renderToStaticMarkup(
      <Timeline
        events={[ev({ id: 'evt-1', title: '设备过载', severity: 'L2', evidence: [{ id: 'e1', ref: 'rec-1' }] })]}
      />,
    );
    expect(markup).toContain('id="tl-evt-1"');
    expect(markup).toContain('href="#tl-evt-1"');
    expect(markup).toContain('设备过载');
    expect(markup).toContain('告警');
    expect(markup).toContain('导出 CSV');
    expect(markup).toContain('导出 JSON');
    expect(markup).toContain('证据（1）');
  });

  it('renders empty state when no events', () => {
    const markup = renderToStaticMarkup(<Timeline events={[]} />);
    expect(markup).toContain('暂无时间线事件');
  });

  it('renders expanded evidence when controlled expandedIds provided', () => {
    const markup = renderToStaticMarkup(
      <Timeline
        events={[
          ev({
            id: 'evt-2',
            evidence: [{ id: 'e1', type: 'telemetry', label: '负荷', ref: '0.95' }],
          }),
        ]}
        expandedIds={['evt-2']}
      />,
    );
    expect(markup).toContain('负荷');
    expect(markup).toContain('0.95');
  });
});

describe('Timeline audit export helpers', () => {
  const single = [ev({ id: 'evt-x', title: '过载', severity: 'L2' })];

  it('serializeTimelineEvents flattens fields', () => {
    const rows = serializeTimelineEvents(single);
    expect(rows[0].id).toBe('evt-x');
    expect(rows[0].title).toBe('过载');
    expect(rows[0].evidenceCount).toBe(0);
  });

  it('exportTimelineCsv emits header + row', () => {
    const csv = exportTimelineCsv(single);
    expect(csv.split('\n')[0]).toContain('id,timestamp,actor');
    expect(csv).toContain('evt-x');
    expect(csv).toContain('过载');
  });

  it('exportTimelineJson emits parseable JSON', () => {
    const json = exportTimelineJson(single);
    const parsed = JSON.parse(json);
    expect(parsed[0].id).toBe('evt-x');
  });
});
