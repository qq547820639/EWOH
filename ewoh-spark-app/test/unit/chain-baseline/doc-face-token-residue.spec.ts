/**
 * FMTLK-01 的常驻位点：`scripts/chain-baseline/doc-face-reconciliation.cjs` 的「未渲染词元」判据
 * 在 V317 只认 at 成对（`@@name@@` 与半渲染 `@name@`），因此**结构性看不见** Python 格式串那一族
 * ——状态件里 V112 落盘的 8 个 `%(name)s` 与《基线》§七 的 1 个就这么活了约 200 轮，
 * 而 `chain-baseline-doc-face` 每轮都报「残留词元 0 处」（同族还有 V260 自述过的 `%d` 那档）。
 *
 * 量具自己的 `--self-test` 不算防回归位点（fix-sites 的 V116 判据），所以从测试面把它钉住：
 * 谁把这两族形状从 `RESIDUE_RES` 里改回去，这里就红。
 *
 * 两支用例都只吃**合成文本**：真实三件产物的当期内容会随轮次变，把断言绑在它上面
 * 等于把用例绑在机器状态上（先例见 recorder-preflight.spec.ts 头部那条教训）。
 */
const { unrenderedTokens } = require('../../../../scripts/chain-baseline/doc-face-reconciliation.cjs');

describe('记账残留词元判据的三族形状（FMTLK-01）', () => {
  it('FMTLK-01 命名式 `%(name)s` 与位置式 `%d` 没渲染就落盘，必须各自被点名', () => {
    const hits = unrenderedTokens('对账——spec %(dir_files)s、实到 %(executed)s；'
      + '另有未格式化的 %d 与 %02s 各一处。\n');
    expect(hits).toContain('%(dir_files)s');
    expect(hits).toContain('%(executed)s');
    expect(hits).toContain('%d');
    expect(hits).toContain('%02s');
    // 同形状重复出现只列一条：hits 是**形状集**，不是 occurrence 计数
    expect(unrenderedTokens('%d 与 %d 与 %d').length).toBe(1);
    expect(hits.length).toBe(4);
  });

  it('FMTLK-01 反向：at 成对与半渲染照旧开火，而反引号里的逐字引用与 `%%` 转义不得算残留', () => {
    expect(unrenderedTokens('更正为 @@a_total@@ 张，另一处写着 @orph_n@。')).toEqual(
      expect.arrayContaining(['@@a_total@@', '@orph_n@']));
    expect(unrenderedTokens('登记文本逐字写着 `%(orph_n)s`、`%d` 与 `@@x@@` 这三种形状。')).toEqual([]);
    expect(unrenderedTokens('覆盖率 100%% 与 %%s 这类转义写法不是残留。')).toEqual([]);
    expect(unrenderedTokens('普通句子：门禁 27 条主线，全部通过。')).toEqual([]);
    // 读不到必须是 null（不可判），不能折成"干净"
    expect(unrenderedTokens(null)).toBeNull();
  });
});
