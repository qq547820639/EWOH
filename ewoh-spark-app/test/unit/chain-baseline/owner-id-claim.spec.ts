/**
 * 量具"归属声明"的编号必须真实存在（V345，OWNID-01 的常驻位点）。
 *
 * 存在理由：`Makefile` 的 `chain-baseline-alias-sync` help 一度写着「ALIAS-01 的机械半」，而 `ALIAS-01`
 * 在登记册、状态件、裁决包里一处都不存在（真归属行是 `ENTAX-01`）。既有判据核的是"§5.4 行 ↔ findings"
 * 与"小节引用是否指空"与"点名的文件是否存在"——没有任何一条把**编号**当被声明物来核，所以这句指空
 * 的话能一路绿。本用例钉判据本身有牙：悬空必须开火、在册不开火、引号里的引用不开火，并钉真树当期零悬空。
 */
import * as path from 'path';

const REPO = path.resolve(__dirname, '../../../..');
const owner = require(path.join(REPO, 'scripts/chain-baseline/owner-id-claims.cjs'));

describe('量具归属声明指空机检（OWNID-01）', () => {
  it('OWNID-01 真树上每条"某编号的机械半/常驻位点"都要指到在册编号', () => {
    const faces = owner.collectFaces(REPO);
    const names = Object.keys(faces);
    // 分母自证：面清单空掉时 offenders 恒为 0，那条断言就成了永真 ⇒ 先钉扫描面数量级
    expect(names.length).toBeGreaterThanOrEqual(30);
    const doc = require('fs').readFileSync(path.join(REPO, 'docs/audit/current/chain-behavior-baseline.md'), 'utf8');
    const st = JSON.parse(require('fs').readFileSync(path.join(REPO, '.codex/artifacts/chain-behavior-baseline-state.json'), 'utf8'));
    const ids = new Set<string>();
    for (const k of ['fixed', 'open']) {
      for (const e of st.findings[k]) {
        const m = String(e).match(/^[A-Z][A-Za-z0-9]*(?:-[A-Za-z0-9]+)*/);
        if (m) ids.add(m[0]);
      }
    }
    for (const l of doc.split('\n')) {
      const m = /^\|\s*(?:~~)?\*{0,2}([A-Z][A-Za-z0-9]*(?:-[A-Za-z0-9]+)*)/.exec(l);
      if (m) ids.add(m[1]);
    }
    expect(owner.offenders(faces, ids)).toEqual([]);
    // 在册声明确实被扫到（0 声明的"全绿"与"没东西可判"必须能分开）
    const claims = names.reduce((a, k) => a + owner.claimsIn(faces[k]).length, 0);
    expect(claims).toBeGreaterThan(0);
  });

  it('OWNID-01 判据形状：悬空开火、在册不开火、引号里的引用不开火、同一面多处逐条数', () => {
    const ids = new Set(['ENTAX-01']);
    expect(owner.offenders({ Makefile: '## 新量具（V9，ZED-01 的机械半）' }, ids).map((x) => x.id)).toEqual(['ZED-01']);
    expect(owner.offenders({ Makefile: '## 新量具（V9，ENTAX-01 的机械半）' }, ids)).toEqual([]);
    expect(owner.offenders({ 'a.cjs': '注释里写着「ZED-01 的机械半」这句被引用的原话' }, ids))
      .toEqual([]);
    expect(owner.offenders({ Makefile: 'ENTAX-01 的机械半 与 GHOST-09 的位点' }, ids).map((x) => x.id))
      .toEqual(['GHOST-09']);
    // 非归属句式不进分母（ADR 文档号、NestJS 诊断码、量具自测夹具假编号都靠这条不被误伤）
    expect(owner.claimsIn('ADR-004 的机制说明；TS18003 报错；AAA-01 的夹具').length).toBe(0);
  });
});
