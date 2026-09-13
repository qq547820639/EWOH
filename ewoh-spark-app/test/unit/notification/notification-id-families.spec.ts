/* 通知号"族"契约门禁（NO-47a）。
 *
 * 双向门禁（任何一边漂移都失败）：
 *   1. **源码 → 族表**：`server/` 里出现的每个 `NTF-` 字面量前缀都必须在
 *      `NOTIFICATION_ID_FAMILIES` 登记（新写入方不许悄悄用未登记的通知号形态）；
 *   2. **族表 → 分类器**：每个族都能被 `classifyNotificationKind` 归到一个已登记类型，
 *      且类型不是 `other`/`unknown`；
 *   3. **类型 → 族**：每个已登记类型都至少被一个族覆盖（不许再有"死词表"——
 *      实测发现 `andon` 曾经登记了却没有任何写入方产生）。
 *
 * 背景（为什么值得一条门禁）：通知号同时是幂等键与治理度量的分类依据。
 * 随机 id 既不幂等、也无法归类；而未登记的前缀会让度量里出现永远为 0 的"干净"假象。
 */
/// <reference types="jest" />
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import {
  NOTIFICATION_ID_FAMILIES,
  NOTIFICATION_KINDS,
  classifyNotificationKind,
} from '@shared/notification-metrics';

const SERVER_DIR = join(process.cwd(), 'server');

function listSourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      out.push(...listSourceFiles(full));
      continue;
    }
    if (!entry.endsWith('.ts')) continue;
    if (entry.endsWith('.spec.ts')) continue;
    out.push(full);
  }
  return out;
}

/** 提取源码里所有 `NTF-` 开头的字面量前缀（模板串或普通字符串）。 */
function collectIdPrefixes(): Array<{ file: string; prefix: string }> {
  const found: Array<{ file: string; prefix: string }> = [];
  for (const file of listSourceFiles(SERVER_DIR)) {
    const text = readFileSync(file, 'utf8');
    // `NTF-...` 直到遇到模板插值 `${`、反引号、引号或空白为止
    const regex = /NTF-[A-Za-z0-9_-]*/g;
    for (const match of text.match(regex) ?? []) {
      found.push({ file: file.slice(SERVER_DIR.length + 1), prefix: match });
    }
  }
  return found;
}

describe('通知号族契约（NOTIFICATION_ID_FAMILIES）', () => {
  it('server 源码里的每个 NTF- 字面量前缀都已登记（无未登记形态）', () => {
    const registered = NOTIFICATION_ID_FAMILIES.map((f) => f.prefix);
    const unregistered = collectIdPrefixes().filter(
      (entry) => !registered.some((prefix) => entry.prefix.startsWith(prefix)),
    );
    expect(
      unregistered.map((entry) => `${entry.file}: ${entry.prefix}`),
    ).toEqual([]);
  });

  it('每个族的每个样本都能被分类器归到声明的类型（不是 other/unknown）', () => {
    for (const family of NOTIFICATION_ID_FAMILIES) {
      for (const sample of family.samples) {
        const kind = classifyNotificationKind(sample.id);
        expect({ id: sample.id, kind }).toEqual({ id: sample.id, kind: sample.kind });
        expect(kind).not.toBe('other');
        expect(kind).not.toBe('unknown');
        expect(NOTIFICATION_KINDS).toContain(kind);
      }
    }
  });

  it('每个已登记类型都有族样本覆盖（不许存在不可达的"死词表"）', () => {
    const covered = new Set(
      NOTIFICATION_ID_FAMILIES.flatMap((family) => family.samples.map((sample) => sample.kind)),
    );
    // other/unknown 是兜底类型，不要求有族
    const expected = NOTIFICATION_KINDS.filter((kind) => kind !== 'other' && kind !== 'unknown');
    const uncovered = expected.filter((kind) => !covered.has(kind));
    expect(uncovered).toEqual([]);
  });

  it('族前缀互不前缀重叠（避免分类歧义）', () => {
    const prefixes = NOTIFICATION_ID_FAMILIES.map((f) => f.prefix);
    for (const a of prefixes) {
      for (const b of prefixes) {
        if (a === b) continue;
        expect(a.startsWith(b)).toBe(false);
      }
    }
  });
});
