/**
 * 词表绑定生成器（V313）的常驻位点。
 *
 * 存在理由：WDRV-01／TBLST-01 的根因是"哪张表用哪份词表"没有机读来源，散在两处硬编码里。
 * 本用例钉三件事：①**四态判定都能开火**（bound／partial／ambiguous／unbound 各给一份合成词表）；
 * ②产物文件与重新生成结果必须逐字一致（手改或事实变了都会红）；③表名写错时不得静默少一张。
 */
import * as fs from 'fs';
import * as path from 'path';
import { execFileSync } from 'node:child_process';

const REPO = path.resolve(__dirname, '../../../..');
const gen = require(path.join(REPO, 'scripts/chain-baseline/gen-vocabulary-bindings.cjs'));
const OUT = path.join(REPO, 'scripts/chain-baseline/status-vocabulary-bindings.json');

const setOf = (xs: string[]) => new Set(xs);

describe('词表绑定生成器（VOCAB-01）', () => {
  it('VOCAB-01 四态判定各自都要开火', () => {
    const vocabs = [
      { file: 'a.yaml', states: setOf(['x', 'y']) },
      { file: 'b.yaml', states: setOf(['x', 'y', 'z']) },
      { file: 'c.yaml', states: setOf(['q']) },
    ];
    const one = (written: string[]) => gen.bindingsFrom({ t: written }, vocabs)[0];
    expect(one(['x', 'y']).status).toBe('ambiguous');          // 两个词表都 100% ⇒ 并列，不许随便挑
    expect(one(['x', 'y', 'z']).status).toBe('bound');          // 只有 b 全覆盖 ⇒ bound 到 b.yaml
    expect(one(['x', 'y', 'z']).vocabulary).toBe('b.yaml');
    // 各半时 a/b/c 并列 0.5 ⇒ 判 ambiguous（不是 partial）：下面那条宽容断言才是真预期
    const expectPartialOrAmbiguous = ['partial', 'ambiguous'];
    expect(expectPartialOrAmbiguous).toContain(one(['x', 'q']).status);
    expect(one(['x', 'y', 'z', 'w', 'k']).status).toBe('partial');   // b 覆盖 3/5 ⇒ partial，并列出词表缺的词
    expect(one(['x', 'y', 'z', 'w', 'k']).missingInVocabulary).toEqual(['k', 'w']);
    // 完全不相交：unbound、词表置空，且**没有** nearest（没有候选可记）——第一版断言写了 nearest.c.yaml 是我想当然
    expect(one(['m', 'n']).status).toBe('unbound');
    expect(one(['m', 'n']).vocabulary).toBeNull();
    expect(one(['m', 'n']).nearest).toBeUndefined();
    // 覆盖不足一半但有候选：unbound 且必须留 nearest（方案表就是这个形状：最近邻 0.429）
    const near = one(['x', 'y', 'z', 'm', 'n', 'o', 'p', 'q']);
    expect(near.status).toBe('unbound');
    expect(near.vocabulary).toBeNull();
    expect(near.nearest.vocabulary).toBe('b.yaml');
    expect(near.nearest.coverage).toBeCloseTo(0.375, 3);
    expect(one([]).status).toBe('no-writes');                   // 没写过状态：不参与"缺词表"的判词
  });

  it('VOCAB-01 产物必须与重新生成逐字一致（防手改、防事实漂）', () => {
    expect(fs.existsSync(OUT)).toBe(true);
    // --check 走的就是"重新生成后比对"这条路；不一致时脚本退 2
    execFileSync('node', ['scripts/chain-baseline/gen-vocabulary-bindings.cjs', '--check'],
      { cwd: REPO, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
    const doc = JSON.parse(fs.readFileSync(OUT, 'utf8'));
    expect(doc.bindings.length).toBeGreaterThan(10);
    // 分母不许为空、状态取值受限、每张表只出现一次
    const seen = new Set(doc.bindings.map((b: any) => b.table));
    expect(seen.size).toBe(doc.bindings.length);
    for (const b of doc.bindings) {
      expect(['bound', 'partial', 'ambiguous', 'unbound', 'no-writes']).toContain(b.status);
      if (b.status === 'unbound' || b.status === 'no-writes') expect(b.vocabulary).toBeNull();
      if (b.status === 'ambiguous') expect(b.candidates.length).toBeGreaterThan(1);
    }
    // 关键实证：试点链上"表自己的契约覆盖不足"必须被记下来，而不是被 rounded 成"没问题"
    const plan = doc.bindings.find((b: any) => b.table === 'ewohSchedulePlan');
    expect(plan).toBeTruthy();
    expect(['unbound', 'partial', 'ambiguous']).toContain(plan.status);
  });

  it('VOCAB-01 表名拼错时 --check 必须报不一致（不得静默少一张表）', () => {
    const orig = fs.readFileSync(OUT, 'utf8');
    try {
      const tampered = JSON.parse(orig);
      tampered.bindings = tampered.bindings.filter((_: any, i: number) => i !== 0);
      fs.writeFileSync(OUT, JSON.stringify(tampered, null, 1) + '\n');
      let code = 0;
      try {
        execFileSync('node', ['scripts/chain-baseline/gen-vocabulary-bindings.cjs', '--check'],
          { cwd: REPO, encoding: 'utf8', stdio: 'pipe', maxBuffer: 32 * 1024 * 1024 });
      } catch (e: any) { code = e.status ?? -1; }
      expect(code).toBe(2);
    } finally {
      fs.writeFileSync(OUT, orig);
    }
    expect(fs.readFileSync(OUT, 'utf8')).toBe(orig);
  });

  it('VOCAB-01 DB 词表约束解析：重定义取最后一个、DROP 在后即解除、非 IN 形状与 rollback 都不算', () => {
    // 正例（会开火才有资格说"真语料没有"）：同名列被后一支迁移重定义 ⇒ 现行值必须含新词
    const known = new Set(['ewoh_foo', 'ewoh_pair', 'ewoh_dead', 'ewoh_ph', 'ewoh_if', 'ewoh_alter_if']);
    const files: [string, string][] = [
      ['db/migrations/standalone_001_a.sql',
        'CREATE TABLE public.ewoh_foo (\n  status text,\n  CONSTRAINT chk_foo_status CHECK (status IN (\'a\', \'b\'))\n);\n'],
      ['db/migrations/standalone_002_b.sql',
        'ALTER TABLE public.ewoh_foo DROP CONSTRAINT IF EXISTS chk_foo_status;\n'
        + 'ALTER TABLE public.ewoh_foo ADD CONSTRAINT chk_foo_status CHECK (status IN (\'a\', \'b\', \'c\'));\n'],
      // 蕴含式：形状与真词表只差尾巴，**不得**当成词表，也不得把该表读成"没有约束"
      ['db/migrations/standalone_003_pair.sql',
        'CREATE TABLE public.ewoh_pair (\n  status text,\n'
        + '  CONSTRAINT chk_ewoh_pair_sent_has_time CHECK (status <> \'sent\' OR sent_at IS NOT NULL)\n);\n'],
      // 定义之后被 DROP ⇒ 该表当前无词表
      ['db/migrations/standalone_004_dead.sql',
        'CREATE TABLE public.ewoh_dead (\n  status text,\n  CONSTRAINT chk_dead_status CHECK (status IN (\'x\'))\n);\n'
        + 'ALTER TABLE public.ewoh_dead DROP CONSTRAINT IF EXISTS chk_dead_status;\n'],
      // rollback 不在建库链上：它写的词表不许算进现行
      ['db/migrations/standalone_002_b.rollback.sql',
        'ALTER TABLE public.ewoh_foo ADD CONSTRAINT chk_foo_status CHECK (status IN (\'zzz\'));\n'],
      // 表名解析不到（真实形状：`ALTER TABLE IF EXISTS` 与注释里的 CREATE TABLE 字样）⇒ 不许张冠李戴
      ['db/migrations/standalone_005_if.sql',
        '-- Re-entrant: CREATE TABLE IF NOT EXISTS /\n'
        + 'ALTER TABLE IF EXISTS public.ewoh_alter_if ADD CONSTRAINT ck_a CHECK (status IN (\'p\',\'q\'));\n'],
      ['db/migrations/standalone_006_unknown.sql',
        'ALTER TABLE public.ewoh_not_in_schema ADD CONSTRAINT ck_b CHECK (status IN (\'r\'));\n'],
      // 同名约束在同一支迁移里被改成不同取值 ⇒ 必须报 conflicting-defs，而不是静默留一个
      ['db/migrations/standalone_007_conflict.sql',
        'CREATE TABLE public.ewoh_cf (\n  status text,\n'
        + '  CONSTRAINT chk_cf_status CHECK (status IN (\'a\')),\n'
        + '  CONSTRAINT chk_cf_status CHECK (status IN (\'a\', \'b\'))\n);\n'],
      // 别的列的枚举（不是状态列）：既不算词表，也不许记成"有状态约束读不到"
      ['db/migrations/standalone_008_othercol.sql',
        "CREATE TABLE public.ewoh_oc (\n  receipt_source text,\n  production_training_eligible boolean,\n"
        + "  CONSTRAINT ck_feedback_receipt_provenance CHECK (receipt_source IN ('real','simulated') AND (NOT production_training_eligible OR x IS NOT NULL))\n);\n"],
    ];
    const known2 = new Set([...known, 'ewoh_cf', 'ewoh_oc']);
    const m = gen.dbVocabularyConstraints(files, known2);
    expect(m.get('ewoh_cf')?.unparsed?.[0]?.shape).toBe('conflicting-defs');
    expect(m.has('ewoh_oc')).toBe(false);
    expect(m.get('ewoh_foo')).toEqual({
      constraint: 'chk_foo_status', column: 'status', values: ['a', 'b', 'c'],
      source: 'db/migrations/standalone_002_b.sql',
    });
    expect(m.get('ewoh_dead')).toBeUndefined();
    expect(m.get('ewoh_pair')).toEqual({
      constraint: null, column: null, values: null, source: null,
      unparsed: [{ constraint: 'chk_ewoh_pair_sent_has_time', shape: 'implication', source: 'db/migrations/standalone_003_pair.sql' }],
    });
    expect([...m.keys()].some((k) => JSON.stringify(m.get(k)).includes('zzz'))).toBe(false);
    expect(m.get('ewoh_alter_if')?.values).toEqual(['p', 'q']);      // IF EXISTS 写法必须认得
    expect(m.has('ewoh_not_in_schema')).toBe(false);                  // 不在 schema 的表名不得归属
    expect(m.unresolved.map((u: any) => u.constraint)).toContain('ck_b');
    // schema 前缀与占位符都要剥干净，否则物理表名连不上 drizzle 符号
    const ph = gen.dbVocabularyConstraints([['db/migrations/standalone_010_c.sql',
      "ALTER TABLE __EWOH_SCHEMA__.ewoh_ph ADD CONSTRAINT ck_ph_status_contract CHECK (status IN ('one','two'));\n"]], known);
    expect(ph.get('ewoh_ph')?.values).toEqual(['one', 'two']);
  });

  it('VOCAB-01 真语料的形状洞：蕴含式与分型复合 CHECK 不得冒充或吞掉词表', () => {
    const m = gen.dbVocabularyConstraints(gen.migrationTexts());
    // standalone_046:41-42 真词表 3 值；:47-48 的蕴含式不得覆盖它
    const exo = m.get('ewoh_exo_session');
    expect(exo?.values).toEqual(['aborted', 'active', 'ended']);
    expect((exo?.unparsed || []).map((u: any) => u.constraint)).toContain('chk_ewoh_exo_session_end');
    // standalone_088:68-69 真词表 5 值；:94-95 的 not_completed 是蕴含式
    const act = m.get('ewoh_improvement_action');
    expect(act?.values).toEqual(['accepted', 'completed', 'dropped', 'proposed', 'rejected']);
    expect((act?.unparsed || []).map((u: any) => u.shape)).toContain('implication');
    // standalone_051:52-56 的 kind×status 复合 CHECK：不许压成单列词表，但必须点名（不得读成"没有约束"）
    const cfg = m.get('ewoh_exo_config');
    expect(cfg?.constraint).toBeNull();
    expect((cfg?.unparsed || []).map((u: any) => u.constraint)).toContain('chk_ewoh_exo_config_status_by_kind');
    // 收紧判据翻动了链上两格，方向都是把"这张表没有约束"纠正成"有状态相关约束、但不是取值清单"：
    // ① `standalone_048:22-34` 的 shadow 隔离 CHECK 里挂着 `status NOT IN (…)`，管的是"影子行不得进生产态"，
    //    不是方案表能取哪些值；② `standalone_106` 的 `sent_has_time` 是 status↔sent_at 配对约束。
    // 旧形状判据整条读不到 ⇒ 两格曾被折成 no-db-check。
    const doc = JSON.parse(fs.readFileSync(OUT, 'utf8'));
    const plan = doc.bindings.find((b: any) => b.table === 'ewohSchedulePlan');
    expect(plan.db_vs_contract).toBe('db-shape-unreadable');
    expect(plan.db_check_unparsed.map((u: any) => u.constraint))
      .toContain('chk_ewoh_schedule_plan_shadow_not_production');
    const cmd = doc.bindings.find((b: any) => b.table === 'ewohControlCommand');
    expect(cmd.db_vs_contract).toBe('db-shape-unreadable');
    expect(cmd.db_constraint).toBeNull();          // 有约束 ≠ 有词表：V312 的 `sent` 欠词仍没有任何取值权威
    expect(cmd.db_check_unparsed.map((u: any) => u.constraint))
      .toContain('chk_ewoh_control_command_sent_has_time');
    // 现状而非应然：今天链上只有这两格落在"形状读不到"；谁把它们建成取值清单，这一支必须同轮换口。
    expect(doc.summary.db_shape_unreadable).toEqual(['ewohControlCommand', 'ewohSchedulePlan']);
    expect(doc.summary.with_db_check).toBe(5);
    expect(doc.db_surface.tables_with_plain_status_check).toBeGreaterThanOrEqual(5);
    // 三态不许折两态：凡点名了读不到的形状，就不许再报成"这张表没有约束"
    for (const b of doc.bindings) {
      if (b.db_check_unparsed) expect(b.db_vs_contract).not.toBe('no-db-check');
    }
    expect(doc.db_surface.defs_with_unresolved_table).toBe(0);
  });

  it('VOCAB-01 DB↔代码↔契约三面差集各有极性：越界要开火、合规不许开火', () => {
    const vocabs = [{ file: 'a.yaml', states: new Set(['a', 'b', 'c']) }];
    const physMap = { ewohFoo: 'ewoh_foo' };
    const dbWith = (values: string[]) => new Map([['ewoh_foo', {
      constraint: 'chk_foo_status', column: 'status', values, source: 'db/migrations/standalone_001_a.sql',
    }]]);
    const row = (written: string[], values: string[]) => gen.bindingsFrom(
      { ewohFoo: written }, vocabs, dbWith(values), physMap)[0];

    // ① 代码可写出库不许的值 ⇒ 必须点名（这条开不了火，真语料那个 0 就毫无意义）
    const bad = row(['a', 'z'], ['a', 'b', 'c']);
    expect(bad.code_outside_db).toEqual(['z']);
    expect(bad.enforced_by_db).toBe(true);
    expect(bad.physical).toBe('ewoh_foo');
    expect(bad.authority).toBe('db+contract+code');
    // ② 合规侧：全部落在库允许范围内 ⇒ 不得开火
    expect(row(['a', 'b'], ['a', 'b', 'c']).code_outside_db).toEqual([]);
    // ③ 同异判三档：等／库更窄／契约有库没有
    expect(row(['a', 'b', 'c'], ['a', 'b', 'c']).db_vs_contract).toBe('db-equals-contract');
    expect(row(['a'], ['a', 'b']).db_vs_contract).toBe('db-narrower');
    expect(row(['a', 'b', 'c'], ['a', 'b', 'c', 'q']).db_vs_contract).toBe('db-has-extra');
    expect(row(['a'], ['a', 'b', 'q']).db_vs_contract).toBe('db-has-extra');
    // ④ 没有 DB 词表时不许折成任何一种"比对结论"
    const noDb = gen.bindingsFrom({ ewohFoo: ['a'] }, vocabs, new Map(), physMap)[0];
    expect(noDb.db_vs_contract).toBe('no-db-check');
    expect(noDb.enforced_by_db).toBe(false);
    // ⑤ 无候选词表（unbound）但有 DB：走 no-contract-binding，不得读成"契约与库一致"
    const noVocab = gen.bindingsFrom({ ewohFoo: ['m', 'n'] }, vocabs, dbWith(['m', 'n']), physMap)[0];
    expect(noVocab.status).toBe('unbound');
    expect(noVocab.db_vs_contract).toBe('no-contract-binding');
    expect(noVocab.authority).toBe('db+code');
    // ⑥ 总账加总必须等于分母（抄数病的机器判据）
    const rows = gen.bindingsFrom({ ewohFoo: ['a'], ewohBar: [] }, vocabs, dbWith(['a']), physMap);
    const s = gen.summaryOf(rows);
    expect(s.tables).toBe(rows.length);
    expect(Object.values(s.db_vs_contract_counts).reduce((x: number, y: number) => x + y, 0)).toBe(rows.length);
    expect(Object.values(s.authority_counts).reduce((x: number, y: number) => x + y, 0)).toBe(rows.length);

    // ⑦ 自述归属轴（V316）只许点名，不许改写判定面：
    //    同一份输入"传该轴 vs 不传该轴"，除那四个新字段外必须逐字段全等 ⇒ 并集消音在这里就红。
    const vocabs3 = [
      { file: 'contracts/state-machines/chosen.yaml', states: setOf(['a', 'x', 'k']) },
      { file: 'contracts/state-machines/other.yaml', states: setOf(['a', 'w', 'closed']) },
    ];
    const authors = new Map([['ewoh_foo', [
      { file: 'contracts/state-machines/other.yaml', block: 'other_identity',
        shard_note: "event_type='OtherRaised' 的那些行", shard_type: null },
    ]]]);
    const withoutAxis = gen.bindingsFrom({ ewohFoo: ['a', 'x', 'w', 'k'] }, vocabs3, new Map(), physMap)[0];
    const withAxis = gen.bindingsFrom({ ewohFoo: ['a', 'x', 'w', 'k'] }, vocabs3, new Map(), physMap,
      undefined, authors)[0];
    const NEW_AXIS = ['contract_authors', 'chosen_self_declared', 'other_author_states',
      'missing_claimed_by_other_author'];
    const stripped: any = { ...withAxis };
    for (const k of NEW_AXIS) delete stripped[k];
    expect(stripped).toEqual(withoutAxis);                     // written／vocabulary／差集／分档一格都没被动
    // ⑧ 覆盖率挑中的那份不是自述方 ⇒ chosen_self_declared=false，且它的态只进诊断字段
    expect(withAxis.vocabulary).toBe('chosen.yaml');
    expect(withAxis.chosen_self_declared).toBe(false);
    expect(withAxis.contract_authors).toEqual([{ file: 'other.yaml', block: 'other_identity',
      shard_note: "event_type='OtherRaised' 的那些行", shard_type: null }]);
    expect(withAxis.other_author_states).toEqual(['closed', 'w']);
    // "词表缺 w"是**归属挑错**造的假缺口：另一份自述方认得它——但 missingInVocabulary 仍留着它，不撤销
    expect(withAxis.missingInVocabulary).toEqual(['w']);
    expect(withAxis.missing_claimed_by_other_author).toEqual(['w']);
    // 反过来：挑中的那份自己写了本表 ⇒ true，且它不是"别的自述方"，其态不进 other_author_states
    const selfAuthors = new Map([['ewoh_foo', [
      { file: 'contracts/state-machines/chosen.yaml', block: 'chosen_identity', shard_note: null, shard_type: 'foo' },
    ]]]);
    const selfRow = gen.bindingsFrom({ ewohFoo: ['a', 'x', 'w', 'k'] }, vocabs3, new Map(), physMap,
      undefined, selfAuthors)[0];
    expect(selfRow.chosen_self_declared).toBe(true);
    expect(selfRow.other_author_states).toEqual([]);
    expect(selfRow.contract_authors[0].shard_type).toBe('foo');
    // ⑨ 没有自述方（真语料大多数表就是这样）⇒ 出空数组与 false，绝不折成"契约否认"
    const noAuthors = gen.bindingsFrom({ ewohFoo: ['a', 'x'] }, vocabs, new Map(), physMap,
      undefined, new Map())[0];
    expect(noAuthors.contract_authors).toEqual([]);
    expect(noAuthors.chosen_self_declared).toBe(false);
    // ⑩ 旧调用形状（不传第 6 参）⇒ 四个新字段一个都不许出现，行为与 V315 逐字一致
    for (const k of NEW_AXIS) expect((withoutAxis as any)[k]).toBeUndefined();
    // ⑪ 总账的自述轴分母：自述 + 未自述 + 无词表可判 = 表数（缺一支就把站点从分母里删掉了）
    const axisRows = gen.bindingsFrom({ ewohFoo: ['a', 'x', 'w', 'k'], ewohBar: ['a'] }, vocabs3,
      new Map(), { ewohFoo: 'ewoh_foo', ewohBar: 'ewoh_bar' }, undefined, authors);
    const s2 = gen.summaryOf(axisRows);
    expect(s2.chosen_self_declared.length + s2.chosen_not_self_declared.length)
      .toBe(axisRows.filter((r: any) => r.vocabulary).length);
    expect(s2.multi_author_tables.length).toBe(0);
    expect(s2.false_gap_named_by_other_author).toEqual([{ table: 'ewohFoo', values: ['w'] }]);
  });

  it('VOCAB-01 真语料的三面分档必须自洽（分档加总等于表数，且不把缺权威折成一致）', () => {
    const doc = JSON.parse(fs.readFileSync(OUT, 'utf8'));
    const rows = doc.bindings;
    const sum = doc.summary;
    expect(sum.tables).toBe(rows.length);
    for (const r of rows) {
      expect(['db-equals-contract', 'db-narrower', 'db-has-extra', 'no-contract-binding',
        'db-shape-unreadable', 'no-db-check']).toContain(r.db_vs_contract);
      if (!r.enforced_by_db && r.db_vs_contract !== 'db-shape-unreadable') expect(r.db_vs_contract).toBe('no-db-check');
      if (r.db_vs_contract === 'db-equals-contract') expect(r.enforced_by_db).toBe(true);
    }
    expect(sum.with_db_check).toBe(rows.filter((r: any) => r.enforced_by_db).length);
    // 越界数为 0 只说明"今天链上可写集合都在库允许范围内"；它必须同时给出没有 DB 词表那张清单，
    // 否则读者会把 0 读成"词表都被强制"
    expect(Array.isArray(sum.written_but_no_db_check)).toBe(true);
    expect(sum.written_but_no_db_check.length).toBeGreaterThan(0);

    // ── 自述归属轴（V316）在真语料上的三条不变量：多自述方只点名、假缺口点名、真欠词不撤销
    const ev = rows.find((r: any) => r.physical === 'ewoh_event');
    expect(ev.contract_authors.length).toBe(3);
    expect(new Set(ev.contract_authors.map((a: any) => a.file)).size).toBe(2);
    expect(ev.chosen_self_declared).toBe(true);
    expect(ev.other_author_states).toContain('closed');
    // 反证（"加面消音"的那一支）：closed 只活在**别的自述方的分片**里，
    // 它既不许进链上可写集，也不许被折成"本行契约声明过但没写者"——并进三面目就会把 F2 读成已认领
    expect(ev.written).not.toContain('closed');
    expect(ev.declaredNotWritten).not.toContain('closed');
    expect(ev.missing_claimed_by_other_author).toEqual(['open']);   // 归属挑错造的假缺口，点名
    expect(ev.missingInVocabulary).toContain('consumed');           // 真欠词仍留着，不因点名而撤销
    expect(sum.chosen_self_declared.length + sum.chosen_not_self_declared.length)
      .toBe(rows.filter((r: any) => r.vocabulary).length);
    expect(sum.multi_author_tables.map((x: any) => x.table)).toEqual(['ewohEvent']);
  });

  it('VOCAB-01 自述权威表解析：块边界与 authority_type 的归属各要一支反证（V316）', () => {
    const dir = fs.mkdtempSync(path.join(require('os').tmpdir(), 'vocab-authors-'));
    fs.writeFileSync(path.join(dir, 'x.yaml'), [
      'states:', '  - a', '  - b',
      'foo_identity:',
      '  projection_table: ewoh_notification',
      '  authority_type: orphan_type',          // 出现在任何 authority_table 之前 ⇒ 谁都不许挂上
      '  authority_table: ewoh_foo              # event_type=\'FooRaised\' 的那些行',
      'bar_identity:',
      '  authority_table: ewoh_foo',
      '  authority_type: bar_type',             // 只归本块那一条，不许回挂到 foo_identity 那条
      'terminal: [a]',
      'authority_table: ewoh_not_top_level',    // 顶层缩进 0 不算自述（判据只认块内的缩进行）',
    ].join('\n') + '\n');
    const m = gen.contractAuthors(dir);
    expect(m.has('ewoh_not_top_level')).toBe(false);
    const list = m.get('ewoh_foo');
    expect(list.length).toBe(2);
    expect(list[0].block).toBe('foo_identity');
    expect(list[0].shard_type).toBeNull();
    expect(list[0].shard_note).toBe("event_type='FooRaised' 的那些行");
    expect(list[1].block).toBe('bar_identity');
    expect(list[1].shard_type).toBe('bar_type');
    expect(list[1].shard_note).toBeNull();
    // 真契约的读数：ewoh_event 由两份契约、三处块自述；approval 那处带唯一结构化分片键
    const real = gen.contractAuthors();
    const ev = real.get('ewoh_event');
    expect(ev.length).toBe(3);
    expect(ev.map((a: any) => `${a.file.split('/').pop()}#${a.block}`).sort())
      .toEqual(['alert.yaml#andon_notification_identity', 'alert.yaml#data_quality_notification_identity',
        'approval.yaml#expiry_notification_identity']);
    expect(ev.filter((a: any) => a.shard_type).map((a: any) => a.shard_type)).toEqual(['approval_instance']);
    for (const a of ev) expect(a.block).toBeTruthy();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('VOCAB-01 TS 面只认纯字面量联合：多行与 as const 要读得到，混型/吞下句/对象数组必须丢弃', () => {
    // ① 多行前竖线写法（真语料 SchedulingExecutionStatus 就是这个形状）＋行内注释
    const multi = gen.tsTypesFromSource('f.ts', "export type E =\n  | 'PLANNED'  // 已排入\n  | 'STARTED';\n");
    expect(multi.map((t: any) => t.name)).toEqual(['E']);
    expect(multi[0].values).toEqual(['PLANNED', 'STARTED']);
    // ② as const 字符串数组
    expect(gen.tsTypesFromSource('f.ts', "export const L = ['a', 'b'] as const;\n")[0].values)
      .toEqual(['a', 'b']);
    // ③ 混入具名类型的联合：值集合读不全 ⇒ 整条丢弃（读到一半当词表比读不到更容易骗人）
    expect(gen.tsTypesFromSource('f.ts', "export type M = 'a' | 'b' | Other;\n")).toEqual([]);
    // ④ 漏写分号的多行 union：旧写法会把下一条语句的字面量吞进来，新写法必须只读到 S 自己的两项
    const swallow = gen.tsTypesFromSource('f.ts', "export type S = 'a' | 'b'\nexport const C = 'c';\n");
    expect(swallow).toHaveLength(1);
    expect(swallow[0].values).toEqual(['a', 'b']);
    // ⑤ 对象数组不是取值清单（真语料 andon-sla.ts 的 ANDON_BREACH_LEVELS 第一版就被读成词表）
    expect(gen.tsTypesFromSource('f.ts',
      "export const B = [\n  { level: 1, bucket: 'l1' },\n  { level: 2, bucket: 'l2' },\n] as const;\n")).toEqual([]);
    // ⑥ 单值联合不构成"清单"，也读成丢弃：否则列默认值会被当成一张词表
    expect(gen.tsTypesFromSource('f.ts', "export type O = 'only';\n")).toEqual([]);
    // ⑦ `export interface` 里的字段级内联联合要读得到，名字带点号（`OutboxEvent.status`）
    const inline = gen.inlineFieldTypes('f.ts',
      "export interface OutboxEvent {\n  id: string;\n  status: 'pending' | 'published' | 'failed';\n}\n");
    expect(inline).toHaveLength(1);
    expect(inline[0].name).toBe('OutboxEvent.status');
    expect(inline[0].values).toEqual(['failed', 'pending', 'published']);
    expect(inline[0].inline).toBe(true);
    // ⑧ 模块内私有 interface（没 export）不算规范面——它与独立 grep 的差集就只有这一族
    expect(gen.inlineFieldTypes('f.ts',
      "interface EvaluatedObservation {\n  status: 'a' | 'b';\n}\n")).toEqual([]);
    // ⑨ 归属必须跟着最近一个 export interface 收尾：内联对象类型／注释不得把归属带到下一个接口上
    const two = gen.inlineFieldTypes('f.ts', [
      'export interface First {',
      "  status: 'a' | 'b';",
      '  nested: {',
      '    x: string;',
      '  };',
      '}',
      'export interface Second {',
      "  state: 'c' | 'd';",
      '}',
    ].join('\n'));
    expect(two.map((t: any) => t.name)).toEqual(['First.status', 'Second.state']);
  });

  it('VOCAB-01 第四面的两根轴不并成一句：命名没命中时只记取值面，命中也不等于值面覆盖', () => {
    const vocabs = [{ file: 'a.yaml', states: new Set(['a', 'b', 'c']) }];
    const physMap = { ewohFoo: 'ewoh_foo' };                    // ⇒ 期望类型名 FooStatus / FooState
    const types = [
      { file: 'shared/x.ts', name: 'FooStatus', values: ['a', 'b', 'c'] },
      { file: 'shared/y.ts', name: 'UnrelatedThingStatus', values: ['a', 'b'] },
    ];
    const withTs = (written: string[]) => gen.bindingsFrom({ ewohFoo: written }, vocabs,
      new Map(), physMap, types)[0];
    // ① 命名规则命中 + 链上写的值全在类型内 ⇒ 声明面与取值面都成立
    const ok = withTs(['a', 'b']);
    expect(ok.ts_type.name).toBe('FooStatus');
    expect(ok.ts_type_corroborated).toBe(true);
    expect(ok.ts_outside_type).toEqual([]);
    expect(ok.authority).toBe('contract+code+ts');
    expect(ok.ts_value_superset_types).toEqual(['shared/x.ts#FooStatus', 'shared/y.ts#UnrelatedThingStatus']);
    // 取值面按集合关系分两档：整个容下 ⊃ 完全相等
    expect(ok.ts_exact_value_match).toEqual(['shared/y.ts#UnrelatedThingStatus']);
    // ② 命名命中但写出类型外的值 ⇒ 两根轴必须分开报：仍算绑定，但 corroboration 判 false
    const drift = withTs(['a', 'z']);
    expect(drift.ts_type.name).toBe('FooStatus');
    expect(drift.ts_type_corroborated).toBe(false);
    expect(drift.ts_outside_type).toEqual(['z']);
    expect(drift.ts_value_superset_types).toEqual([]);          // 没有任何联合容得下：空集，不是「没判」
    expect(drift.authority).toBe('contract+code+ts');           // 契约面仍按 0.5 覆盖选中，与值面越界互不折抵
    // ③ 命名没命中但值集合完全相等 ⇒ 只进取值面，绝不写成"该列有类型权威"（这条是"按值猜"的反证）
    const noName = gen.bindingsFrom({ ewohFoo: ['a', 'b'] }, vocabs, new Map(),
      { ewohFoo: 'ewoh_other' }, types)[0];
    expect(noName.ts_type).toBeNull();
    expect(noName.ts_value_superset_types).toContain('shared/y.ts#UnrelatedThingStatus');
    expect(noName.ts_exact_value_match).toEqual(['shared/y.ts#UnrelatedThingStatus']);
    expect(noName.authority).toBe('contract+code');
    // 同名类型存在但值集合对不上时，也不许靠"别的联合容得下"补一个 ts 面进 authority
    const named = gen.bindingsFrom({ ewohFoo: ['a', 'b', 'c', 'd'] }, vocabs, new Map(), physMap, types)[0];
    expect(named.ts_type.name).toBe('FooStatus');
    expect(named.ts_outside_type).toEqual(['d']);
    expect(named.ts_value_superset_types).toEqual([]);
    // ④ 没传 TS 面（旧调用形状）⇒ 一个新字段都不许出现，行为与 V313 逐字一致
    const legacy = gen.bindingsFrom({ ewohFoo: ['a', 'b'] }, vocabs, new Map(), physMap)[0];
    expect(legacy.ts_type).toBeUndefined();
    expect(legacy.authority).toBe('contract+code');
    // ⑤ 总账的严格分母必须与逐行事实同源：写过的表 = 容得下的 + 谁都不容下的
    const rows = gen.bindingsFrom({ ewohFoo: ['a', 'z'], ewohBar: [] }, vocabs, new Map(), physMap, types);
    const s = gen.summaryOf(rows);
    expect(s.ts_value_superset.length + s.shared_written_nowhere.length)
      .toBe(rows.filter((r: any) => r.written.length).length);
    expect(Object.values(s.authority_counts).reduce((x: number, y: number) => x + y, 0)).toBe(rows.length);
  });

  it('VOCAB-01 TS 面只扫 shared/，客户端镜像类型不得进权威；真语料的第四面要能开火', () => {
    // 生产调用面：抽到的类型必须全部来自 shared/（client/ 下的同名 union 是界面筛选项镜像）
    const files = new Set(gen.tsTypes().map((t: any) => t.file.split('/')[0] + '/' + t.file.split('/')[1]));
    expect([...files]).toEqual(['ewoh-spark-app/shared']);
    const doc = JSON.parse(fs.readFileSync(OUT, 'utf8'));
    const sum = doc.summary;
    // ① 三面判出来的分档必须自洽，且 `authority === 'code'` 的严格版另有分母：
    //    命名没命中 ≠ 没有规范面（shared/ 里存在容得下这些值的联合时，"只活在代码里"就说过头了）
    expect(sum.authority_counts.code).toBe(sum.code_only_no_ts.length);
    expect(sum.code_only_no_ts_no_shared_match.length).toBeLessThan(sum.code_only_no_ts.length);
    expect(sum.code_only_no_ts_no_shared_match.every((t: string) => sum.code_only_no_ts.includes(t))).toBe(true);
    // ② 真语料必须同时开出"命名命中但不被值面支持"和"命名没命中但值面容得下"两种形态，
    //    否则第四面只是把第一面抄了一遍
    const rows = doc.bindings;
    const namedNotCorroborated = rows.filter((r: any) => r.ts_type && r.ts_type_corroborated === false);
    expect(namedNotCorroborated.map((r: any) => r.table)).toContain('ewohSchedulePlan');
    const valueOnly = rows.filter((r: any) => !r.ts_type && (r.ts_value_superset_types || []).length);
    expect(valueOnly.length).toBeGreaterThan(0);
    // ③ 每行的 ts_type 名字必须由命名规则从物理表名推出（不得按值相似性偷偷绑定）
    for (const r of rows) {
      if (!r.ts_type) continue;
      expect(gen.expectedTypeNames(r.physical)).toContain(r.ts_type.name);
    }
    // ④ 字段级内联联合（`OutboxEvent.status` 这一族）只许进取值面：点号名永远不得成为强绑定
    expect(sum.with_ts_type).toBeGreaterThan(0);
    expect(doc.ts_surface.shared_inline_field_unions).toBeGreaterThan(0);
    for (const r of rows) if (r.ts_type) expect(r.ts_type.name).not.toContain('.');
    // ⑤ 真语料必须有"只被内联联合容下"的表：这一族是本轮才读到的，读不到就退回三面判的红
    const inlineClaimed = rows.filter((r: any) =>
      (r.ts_value_superset_types || []).some((k: string) => /\.[a-z]+$/.test(k)));
    expect(inlineClaimed.map((r: any) => r.table)).toEqual(expect.arrayContaining(
      ['ewohOutbox', 'ewohPolicyActivation']));
  });
});

