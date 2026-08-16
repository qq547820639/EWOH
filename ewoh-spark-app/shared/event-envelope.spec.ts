/* Canonical Event Envelope 契约一致性测试（TS 侧，ADR-009 / NO-04）。
 *
 * 与 tests/test_event_envelope.py 消费同一份共享向量（contracts/events/envelope-test-vectors.json），
 * 保证 Python/TS 语义逐项一致（§31）；eventType 交叉校验事件目录 x-event-types。
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { createRequire } from 'node:module';

import {
  ENVELOPE_CLOCK_DRIFT_TOLERANCE_MS,
  ENVELOPE_LATE_THRESHOLD_MS,
  envelopeDedupKey,
  envelopeSemantics,
  validateEventEnvelope,
} from './event-envelope';

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const requireFromApp = createRequire(path.join(REPO_ROOT, 'ewoh-spark-app', 'package.json'));

function loadCatalogTypes(): Set<string> {
  const yaml = requireFromApp('js-yaml');
  const catalog = yaml.load(
    fs.readFileSync(path.join(REPO_ROOT, 'contracts', 'events', 'event-catalog.yaml'), 'utf-8'),
  ) as { 'x-event-types': string[] };
  return new Set(catalog['x-event-types']);
}

interface EnvelopeCase {
  name: string;
  envelope: Record<string, unknown>;
  expect?: { clockDrift: boolean; isLate: boolean } | null;
  expectError: string | null;
}

const vectors = JSON.parse(
  fs.readFileSync(path.join(REPO_ROOT, 'contracts', 'events', 'envelope-test-vectors.json'), 'utf-8'),
) as { envelopes: EnvelopeCase[] };

describe('canonical event envelope（共享向量，跨语言一致性）', () => {
  it('容忍常量与契约一致', () => {
    const schema = JSON.parse(
      fs.readFileSync(path.join(REPO_ROOT, 'contracts', 'events', 'envelope.schema.json'), 'utf-8'),
    );
    expect(ENVELOPE_CLOCK_DRIFT_TOLERANCE_MS).toBe(schema.clockDriftToleranceMs);
    expect(ENVELOPE_LATE_THRESHOLD_MS).toBe(schema.lateThresholdMs);
  });

  it('向量 eventType 全部命中事件目录', () => {
    const known = loadCatalogTypes();
    for (const c of vectors.envelopes) {
      if (c.expectError === 'unknown_event_type') continue; // 负向控制除外
      if (c.envelope.eventType != null) {
        expect(known.has(String(c.envelope.eventType))).toBe(true);
      }
    }
  });

  it('envelopes 向量逐项一致', () => {
    const known = loadCatalogTypes();
    for (const c of vectors.envelopes) {
      const errors = validateEventEnvelope(c.envelope, known);
      if (c.expectError == null) {
        expect(errors).toEqual([]);
        if (c.expect != null) {
          expect(envelopeSemantics(c.envelope)).toEqual(c.expect);
        }
      } else {
        expect(errors[0]).toBe(c.expectError);
      }
    }
  });

  it('dedup 键稳定（幂等去重）', () => {
    expect(
      envelopeDedupKey({
        eventId: 'EVT-X',
        source: 'edge:ny-exo-a1',
      }),
    ).toBe('edge:ny-exo-a1|EVT-X');
  });
});
