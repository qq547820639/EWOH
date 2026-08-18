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
        events={[ev({ id: 'evt-1', title: '设备过载', severity: 'high', evidence: [{ id: 'e1', ref: 'rec-1' }] })]}
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

  it('R2-CC2-002: 事件卡片/节点描边使用语义令牌（无字面 bg-card/ring-white，dark 主题可读）', () => {
    const markup = renderToStaticMarkup(
      <Timeline events={[ev({ id: 'evt-token' })]} />,
    );
    expect(markup).toContain('bg-card');
    expect(markup).toContain('ring-background');
    expect(markup).not.toContain('bg-card');
    expect(markup).not.toContain('ring-white');
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

  it('CLI-301: renders safe https evidence url as link but degrades javascript: to plain text', () => {
    const markup = renderToStaticMarkup(
      <Timeline
        events={[
          ev({
            id: 'evt-xss',
            evidence: [
              { id: 'e-safe', url: 'https://example.com/evidence/1' },
              { id: 'e-evil', url: 'javascript:alert(1)' },
              { id: 'e-data', url: 'data:text/html,<script>alert(2)</script>' },
            ],
          }),
        ]}
        expandedIds={['evt-xss']}
      />,
    );
    // 安全 https 链接正常渲染为 <a href>
    expect(markup).toContain('href="https://example.com/evidence/1"');
    // 危险 scheme 不渲染为可点击链接，降级为纯文本展示
    expect(markup).not.toContain('href="javascript:');
    expect(markup).not.toContain('href="data:');
    expect(markup).toContain('javascript:alert(1)');
    expect(markup).toContain('查看');
  });
});

describe('Timeline audit export helpers', () => {
  const single = [ev({ id: 'evt-x', title: '过载', severity: 'high' })];

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
