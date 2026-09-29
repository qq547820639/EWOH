/**
 * CSET-01 的常驻位点：守卫强度普查（`scripts/chain-baseline/status-write-guard-census.cjs`）的
 * set 侧判据在 V284 之前漏认**简写属性**，使站点从分母整条消失。该尺自己的 `--self-test` 不算
 * 防回归位点（fix-sites 的 V116 判据），所以这里从测试面把它钉住：谁把这一支改回去，这里就红。
 */
const { classifySource } = require('../../../../scripts/chain-baseline/status-write-guard-census.cjs');

const TABLES = new Set(['ewohControlCommand']);

describe('status-write-guard-census set 侧判据（CSET-01）', () => {
  it('CSET-01 简写属性 `.set({ status })` 必须算状态写者，且守卫形状照旧判', () => {
    const src = `db.update(ewohControlCommand).set({ status, updatedAt: new Date() })
      .where(and(eq(ewohControlCommand.requestId, id), eq(ewohControlCommand.status, expected)));`;
    const sites = classifySource(src, 'cset-shorthand.ts', TABLES);
    expect(sites).toHaveLength(1);
    expect(sites[0].writesStatus).toBe('yes');
    expect(sites[0].guard).toBe('state-guard');
    expect(sites[0].valueShape).toBe('input-ref');
  });

  it('CSET-01 反向：只简写非状态列时不得算状态写者（否则分母被内存字段灌水）', () => {
    const src = `db.update(ewohControlCommand).set({ orgId }).where(eq(requestId, id));`;
    const sites = classifySource(src, 'cset-nonstatus.ts', TABLES);
    expect(sites).toHaveLength(1);
    expect(sites[0].writesStatus).toBe('no');
  });
});
