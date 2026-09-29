/**
 * 推广三判据复算入口（V309）的常驻位点。
 *
 * 为什么要有：三判据是试点的**放行条件**（维护成本↓／语义没丢／恢复↑）。只要有一轴的分母变成 0
 * 或解析不到，"三条都成立"就退化成一句主观话。这里把"轴不能空转"钉成断言，并用合成夹具证明
 * 检测器真能分辨"没有写点"与"有写点但集合读不出"（V296 的三成因纪律）。
 */
import { execFileSync } from 'node:child_process';
import * as fs from 'fs';
import * as path from 'node:path';

const REPO = path.resolve(__dirname, '../../../..');
const mod = require(path.join(REPO, 'scripts/chain-baseline/promotion-readings.cjs'));

describe('推广三判据读数不许空转（PRD-01）', () => {
  it('PRD-01 三轴各自的分母必须非空且互相自洽', () => {
    const sources: Array<[string, string]> = [];
    const walk = (d: string) => {
      for (const e of fs.readdirSync(d, { withFileTypes: true })) {
        const p = path.join(d, e.name);
        if (e.isDirectory()) { if (e.name !== '__tests__' && e.name !== 'node_modules') walk(p); continue; }
        if (e.name.endsWith('.ts') && !e.name.endsWith('.d.ts') && !e.name.endsWith('.spec.ts')) {
          sources.push([path.relative(REPO, p), fs.readFileSync(p, 'utf8')]);
        }
      }
    };
    walk(path.join(REPO, 'ewoh-spark-app/server'));
    const a = mod.axesFromSources(sources);
    // 分母只含"这张表真的有状态列"的那些；无状态列的表要被**显式剔出并点名**，
    // 不能让它以"集合为空"的形式混进缺口（V310 前它就被记成过 9/10 的缺口）。
    expect(a.rows.length).toBe(10);
    expect(a.totalTables).toBe(9);
    expect(a.noStatusColTables).toEqual(['ewohControlResult']);
    expect(a.tablesWithSet).toBe(a.totalTables);
    // 三种成因必须分开计，且**只统计进了分母的表**——被"没有状态列"排除的表不能又冒进"集合为空"那一档
    const scored = a.rows.filter((r: any) => r.hasStatusColumn !== false);
    const noWrites = scored.filter((r: any) => r.noWrites).map((r: any) => r.table);
    const hasWritesEmpty = scored.filter((r: any) => !r.noWrites && r.writable.length === 0).map((r: any) => r.table);
    expect(noWrites.length + hasWritesEmpty.length).toBe(a.totalTables - a.tablesWithSet);
    expect(a.noWritesTables).toEqual(noWrites);   // 模块自己算的那一份必须与逐行分类一致
    // 轴③两半都得能解析出来（跑真尺子）
    const m = mod.machineAxis();
    expect(m.error).toBeUndefined();
    expect(m.blocks).toBeGreaterThan(0);
    expect(m.pollBound + m.waitOnly + m.single).toBe(m.blocks);
    const g = mod.gridAxis();
    expect(g.rows).toBe(18);
    expect(Object.values(g.v166).reduce((x: number, y: number) => x + y, 0)).toBe(18);
    expect(Object.values(g.strict).reduce((x: number, y: number) => x + y, 0)).toBe(18);
  });

  it('PRD-01 清单漏网检测必须真能开火：用 schema 里真实存在的那张表做反证', () => {
    // 关键：夹具表名必须**真在** schema 的状态表集合里，否则"报了 0 张"是白捡的绿（第一版就犯过这个错）。
    const all = mod.statusTablesInSchema();
    expect(all.length).toBeGreaterThan(50);
    const victim = all.includes('ewohSchedulingPolicy') ? 'ewohSchedulingPolicy' : all[0];
    const src: Array<[string, string]> = [['server/modules/control/x.ts',
      `async function f(db) { await db.update(${victim}).set({ status: 'open' }).where(eq(id, 1)); }`]];
    const missed = mod.orphanStatusTables(src, [['ewohAgentTask', null]]);
    expect(missed.some(([x]: [string, number]) => x === victim)).toBe(true);
    const listed = mod.orphanStatusTables(src, [[victim, null]]);
    expect(listed.length).toBe(0);
    // 只读不写（没碰 status 列）的表不许算成漏网
    expect(mod.orphanStatusTables([['server/modules/control/y.ts',
      `db.update(${victim}).set({ note: 'x' })`]], [['ewohAgentTask', null]]).length).toBe(0);
  });

  it('PRD-01 检测器必须能分辨：合成语料里"无写点"与"集合为空"给出不同读数', () => {
    const withWrite = [[
      'a.ts',
      "async function f(db) { await db.update(ewohAgentTask).set({ status: 'created' }).where(eq(id, 1)); }",
    ]];
    const a1 = mod.axesFromSources(withWrite, [['ewohAgentTask', null]], () => null);
    expect(a1.rows[0].noWrites).toBe(false);
    expect(a1.rows[0].writable).toEqual(['created']);
    const a2 = mod.axesFromSources([['a.ts', 'export const x = 1;']], [['ewohAgentTask', null]], () => null);
    expect(a2.rows[0].noWrites).toBe(true);
    expect(a2.tablesWithSet).toBe(0);   // 有状态列但读不出 ⇒ 是真缺口，不会被"无状态列"抹掉
    // 轴③解析失败的形状必须是"不可判"，不能读成 0 块＝通过
    expect(mod.machineAxis().blocks).toBeGreaterThan(0);
  });

  it('PRD-01 轴②的词表归属只认绑定件；不可判既不折算成判定，也不拿最近邻当归属', () => {
    const facts = [['ewohAgentTask', 'hand.yaml']];
    const declared = (f: string) => (f === 'hand.yaml' ? new Set(['created']) : new Set(['a', 'b']));
    const src = [['a.ts', "async function f(db) { await db.update(ewohAgentTask).set({ status: 'created' }).where(eq(id, 1)); }"]];
    const one = (b: any, bindingOf: any = new Map([['ewohAgentTask', b]])) =>
      mod.axesFromSources(src, facts, declared, bindingOf).rows[0];
    // ① 绑定件说 bound → 判定档，词表取绑定件那份，**手挂那份只报分歧**
    const bound = one({ status: 'bound', vocabulary: 'agent-task.yaml', db_vs_contract: 'db-equals-contract' });
    expect(bound.grade).toBe('差集可算');
    expect(bound.judged).toBe(true);
    expect(bound.contract).toBe('agent-task.yaml');
    expect(bound.contractFrom).toBe('绑定件');
    expect(bound.handMountedVsArtifact).toBe('hand.yaml≠绑定件 agent-task.yaml');
    // ② partial 仍是判定档，但档名要把"契约欠词"写出来（WDRV-01 那族欠账就在这档）
    expect(one({ status: 'partial', vocabulary: 'x.yaml', db_vs_contract: 'no-db-check' }).grade)
      .toBe('差集可算·契约欠词');
    // ③④⑤ 三档不可判：词表退回**手挂那一份**算诊断差集，绝不把最近邻／被否证那份当归属
    const amb = one({ status: 'ambiguous', vocabulary: 'c.yaml', candidates: ['c.yaml', 'd.yaml'] });
    expect([amb.judged, amb.diagnostic, amb.contract, amb.contractFrom])
      .toEqual([false, true, 'hand.yaml', '手挂·诊断']);
    const un = one({ status: 'unbound', vocabulary: null, nearest: { vocabulary: 'plan.yaml', coverage: 0.429 } });
    expect([un.judged, un.diagnostic, un.contract, un.contractFrom])
      .toEqual([false, true, 'hand.yaml', '手挂·诊断']);
    const nar = one({ status: 'bound', vocabulary: 'approval.yaml', db_vs_contract: 'db-narrower' });
    expect([nar.judged, nar.diagnostic, nar.grade]).toEqual([false, true, '不可判·库否证主体']);
    // ⑥ 绑定件读不到 ⇒ 整轴退回手挂并点名，不许读成"没有差集"或"没有缺口"
    const noFile = one(undefined as any, null);
    expect(noFile.grade).toBe('不可判·没有绑定件（按手挂）');
    expect(noFile.contract).toBe('hand.yaml');
    expect(noFile.contractFrom).toBe('手挂（没有绑定件）');
    // ⑦ 真语料（喂两支合成写点）：判定档与不可判档必须同时成立，且 plan 那张的最近邻是别的主体（分歧要点名）
    const realSrc = [['server/modules/control/r.ts',
      "db.update(ewohControlCommand).set({ status: 'expired' });\n"
      + "db.update(ewohControlCommand).set({ status: 'sent' });"]];
    const real = mod.axesFromSources(realSrc, [['ewohSchedulePlan', 'plan.yaml'], ['ewohControlCommand', 'control.yaml']],
      mod.declaredStates);
    const byTable: any = {};
    for (const r of real.rows) byTable[r.table] = r;
    expect(byTable.ewohControlCommand.grade).toBe('差集可算·契约欠词');
    expect(byTable.ewohControlCommand.writerNotDeclared).toEqual(['expired', 'sent']);
    expect(byTable.ewohSchedulePlan.judged).toBe(false);
    expect(byTable.ewohSchedulePlan.writable).toEqual([]);            // 合成语料里没写方案表 ⇒ 空是"没写点"，不是"没缺口"
    expect(byTable.ewohSchedulePlan.contract).toBe('plan.yaml');      // 诊断仍按人认的那份，不被 approval.yaml 顶掉
    expect(byTable.ewohSchedulePlan.handMountedVsArtifact).toContain('approval.yaml');
  });
});
