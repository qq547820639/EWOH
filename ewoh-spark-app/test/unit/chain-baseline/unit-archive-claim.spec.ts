/**
 * 「§六 点名的单测归档与它旁边抄的读数同源」这条判据的常驻位点（V351，UARCH-01）。
 *
 * 存在理由：一致性尺子原先只把文档抄的 `后端单测 N/M` 与"最新一份含汇总行的 unit 日志"对账，
 * **文档里写死的那个归档文件名从来没人核**。V350 有活例：那一格抄 417/3694（V348/V349 两遍的数），
 * 点名却是 V347 那一遍的归档——四条收尾门禁全绿，按名去翻证据的人只会翻到旧树读数。
 * 这里 require 尺子同源的纯形状件，正反各断一支（尺子的 `--self-test` 不读这份文件，也不算位点）。
 */
import * as path from 'path';

const REPO = path.resolve(__dirname, '../../../..');
const claim = require(path.join(REPO, 'scripts/chain-baseline/unit-archive-claim.cjs'));

describe('单测归档定名同源判据（UARCH-01）', () => {
  const sec = (tests: number, suites: number, archive: string) =>
    `| 业务语义没有丢失 | **当期读数（V351，同一份定稿树：后端单测 ${tests}/${tests} 通过**（${suites} 套件，rc=0，归档 \`${archive}\`；备注）|`;
  const log = (tests: number, suites: number) =>
    `Test Suites: ${suites} passed, ${suites} total | Tests:       ${tests} passed, ${tests} total\n`;

  it('UARCH-01 点名的归档必须与抄的三个数同源：最新一份相符而点名那份不符 ⇒ 必须判违规（旧判据看不见这一档）', () => {
    const c = claim.parseUnitClaim(sec(3694, 417, 'unit-20260101-000001.log'));
    expect(c).toEqual({ tests: 3694, total: 3694, suites: 417, archive: 'unit-20260101-000001.log' });
    const named = claim.checkUnitArchiveClaim(c, log(3689, 416), ['unit-20260101-000001.log', 'unit-20260102-000002.log']);
    expect(named.verdict).toBe('违规');
    expect(named.issues.join('\n')).toContain('点名的 unit-20260101-000001.log 汇总行是 3689/3689');
    expect(named.issues.join('\n')).toContain('点名的 unit-20260101-000001.log 自报 416 个套件通过');
    // 同一份文档，点名换成相符的那一份 ⇒ 必须一致（否则上面三条是永真）
    const c2 = claim.parseUnitClaim(sec(3694, 417, 'unit-20260102-000002.log'));
    expect(claim.checkUnitArchiveClaim(c2, log(3694, 417), ['unit-20260101-000001.log', 'unit-20260102-000002.log']).verdict)
      .toBe('一致');
  });

  it('UARCH-01 第三态不许并档：点名不在产物集里＝违规，产物集为空＝不可判，读不到汇总行＝违规而不是"没这条判据"', () => {
    const two = ['unit-20260101-000001.log', 'unit-20260102-000002.log'];
    const ghost = claim.checkUnitArchiveClaim(claim.parseUnitClaim(sec(3694, 417, 'unit-20269999-999999.log')), null, two);
    expect(ghost.verdict).toBe('违规');
    expect(ghost.issues.join('\n')).toContain('不在产物集里');
    const empty = claim.checkUnitArchiveClaim(claim.parseUnitClaim(sec(3694, 417, two[0])), null, []);
    expect(empty.verdict).toBe('不可判');
    expect(empty.issues).toEqual([]);
    const noSum = claim.checkUnitArchiveClaim(claim.parseUnitClaim(sec(3694, 417, two[0])), 'no summary here\n', two);
    expect(noSum.verdict).toBe('违规');
    expect(noSum.issues.join('\n')).toContain('读不到');
    // 文档没写成可核对形式 ⇒ 本判据不判，交给尺子那条「未写成可核对形式」
    expect(claim.checkUnitArchiveClaim(null, log(1, 1), two)).toEqual({ verdict: '不可判', issues: [] });
    expect(claim.parseUnitClaim('| 这格还没写成可核对形式 |')).toBeNull();
  });
});
