/**
 * TGTSH-01 的常驻位点：目标态集合尺（`scripts/chain-baseline/status-target-states.cjs`）的 set 侧
 * 判据在 V287 之前只认 `key: value` 与 `...spread`，漏认**简写属性** `.set({ status })`
 * ⇒ 站点被判成"这条链不改状态列"而整条从分母消失（看不见，不是看见"非字面量"）。
 * V284 已在守卫尺（status-write-guard-census）上修过同一形状，本尺当时没同步。
 * 该尺自己的 `--self-test` 不算防回归位点（fix-sites 的 V116 判据），所以这里从测试面把它钉住：
 * 谁把这一支改回去，这里就红。
 */
const { collect } = require('../../../../scripts/chain-baseline/status-target-states.cjs');
const { FACTS } = require('../../../../scripts/chain-baseline/status-write-guard-census.cjs');

const TABLES = new Set(FACTS.map(([k]: [string, unknown]) => k));

describe('status-target-states set 侧简写判据（TGTSH-01）', () => {
  it('TGTSH-01 简写 `.set({ status })` 必须算状态写者并记成非字面量，不得整条消失', () => {
    const src = 'async function f(db, status, before) { await db.update(ewohProductionTask)'
      + '.set({ status }).where(and(eq(ewohProductionTask.id, 1), eq(ewohProductionTask.status, before))); }';
    const bucket = collect([['tgtsh.ts', src]], TABLES).byTable.get('ewohProductionTask');
    expect(bucket).toBeDefined();
    // 值给不出（是变量）⇒ 不入集合，但站点必须留下 nonliteral 一条；旧尺这里连 bucket 都不会出现
    expect(bucket!.direct.size).toBe(0);
    expect(bucket!.nonliteral).toBe(1);
  });

  it('TGTSH-01 反向：只简写非状态列时不得进目标态集合（否则分母被内存字段灌水）', () => {
    const src = 'async function g(db, assignee) { await db.update(ewohProductionTask)'
      + '.set({ assignee }).where(eq(ewohProductionTask.id, 1)); }';
    expect(collect([['tgtsh2.ts', src]], TABLES).byTable.has('ewohProductionTask')).toBe(false);
  });
});

/**
 * VIA-01 的常驻位点：V288 之前本尺只登记"整块 set 是变量"的入口，`.set({ status: 形参 })`
 * 这一族从没挂过入口 ⇒ 调用侧的字面量永远收不回（实物：agent-orchestrator 的 transition、
 * control.service 的 transitionCommand）。回收口径刻意收窄到"定义该方法的类体内的 this.<name>()"。
 */
describe('类方法入口的调用侧回收（VIA-01）', () => {
  const SAME_CLASS = 'class Agent {\n'
    + "  async run(x) { await this.transition('a', 'b', 'in_progress', ['created'], x); }\n"
    + '  private async transition(o, t, target, from, actor) { await db.update(ewohAgentTask)'
    + '.set({ status: target }).where(and(eq(ewohAgentTask.taskId, t), eq(ewohAgentTask.status, from[0]))).returning(); }\n'
    + '}\n'
    + "class Other { async go() { await this.transition('x', 'y', 'NOT-A-STATE', 'w', 'v'); }\n"
    + '  private transition(a, b, c, d, e) { return 0; } }';

  it('VIA-01 同类 this.<method>() 传的字面必须进目标态集合，并留类名痕迹', () => {
    const bucket = collect([['via1.ts', SAME_CLASS]], TABLES).byTable.get('ewohAgentTask');
    expect(bucket).toBeDefined();
    expect(bucket!.via.has('in_progress')).toBe(true);
    // V289：回收必须绑到"供给状态列的那个实参位"——同一次调用里的 'a'/'b' 是 orgId/taskId，不是状态。
    // 这条断言在 V288 的实现上是红的（当时扫全部实参），由 V289 的绑定修复转绿。
    expect([...bucket!.via.keys()].sort()).toEqual(['in_progress']);
    // 痕迹必须点名是哪个类的哪个方法——否则读者无法复核值是从哪处调用收来的
    expect([...bucket!.via.get('in_progress')!].every((s: string) => /#Agent$/.test(s))).toBe(true);
  });

  it('VIA-01 反向：别的类同名方法的调用点不得吸进来（跨类误收＝集合灌水）', () => {
    const bucket = collect([['via2.ts', SAME_CLASS]], TABLES).byTable.get('ewohAgentTask');
    expect(bucket!.via.has('NOT-A-STATE')).toBe(false);
  });
});

/**
 * CAL-01 的常驻位点：V296 给本尺加的第三档回收——值不写在调用点，而写在**同文件顶层被调函数**的
 * `return` 字面量里。实物是 `ControlService#updateRequestStatus` 的 `status` 形参由
 * `aggregateControlStatus` 供给（`ewoh-spark-app/server/modules/control/control.service.ts:200-239`），
 * V296 之前 `ewohControlRequest` 的目标态集合只读得到 `{approved}` 一个（V291 登记的跨过程下界）。
 * 类型档实测不可用：该函数签名写死 `: string`，10 个调用点的 TypeChecker 读数全是 `string`
 * （取证 `tmp/v296-typechecker-probe.log`），所以只能读 return 语句本身。
 * 本尺自己的 `--self-test` 不算防回归位点（V116 判据），故从测试面钉住开火侧与不开火侧各一支。
 */
describe('被调函数 return 字面量的回收（CAL-01）', () => {
  const ENTRY = 'class T { async run(v) { await this.setIt(%CALL%, v); }\n'
    + '  private async setIt(s, x) { await db.update(ewohAgentTask).set({ status: s })'
    + '.where(eq(ewohAgentTask.id, 1)).returning(); } }';

  it('CAL-01 同文件纯字面量返回的被调函数必须把值收进集合，痕迹要点名被调函数', () => {
    const src = "function pick(v) { if (v) return 'alpha'; return 'beta'; }\n"
      + ENTRY.replace('%CALL%', 'pick(v)');
    const bucket = collect([['cal1.ts', src]], TABLES).byTable.get('ewohAgentTask');
    expect(bucket).toBeDefined();
    expect([...bucket!.via.keys()].sort()).toEqual(['alpha', 'beta']);
    expect([...bucket!.via.get('alpha')!].every((s: string) => /pick\(\) ← /.test(s))).toBe(true);
  });

  it('CAL-01 反向：被调函数只要有一条 return 不是字面量，整条不得跟（半字面量函数被当成可回收）', () => {
    const src = "function leak(v) { if (v) return 'gamma'; return v.other; }\n"
      + ENTRY.replace('%CALL%', 'leak(v)');
    const bucket = collect([['cal2.ts', src]], TABLES).byTable.get('ewohAgentTask');
    expect(bucket).toBeDefined();
    expect(bucket!.via.has('gamma')).toBe(false);
  });

  // V296 复核顶出的第二条路：顶层函数入口（harvestCallers）此前没有跨文件夹具，
  // 五支控制全在类方法那一路 ⇒ 补一正一反，反向那支没有正向撑着就是恒真。
  const FN_ENTRY = 'async function ent(p, db) { await db.update(ewohAgentTask).set({ status: p })'
    + '.where(eq(ewohAgentTask.id, 1)).returning(); }\n'
    + "await ent(externalP('x'), db);";

  it('CAL-01 顶层函数入口那条路：同文件被调函数的字面量必须收得回，痕迹同时点名两层', () => {
    const src = "function externalP(v) { return 'ext'; }\n" + FN_ENTRY;
    const bucket = collect([['cal3.ts', src]], TABLES).byTable.get('ewohAgentTask');
    expect(bucket!.via.has('ext')).toBe(true);
    expect([...bucket!.via.get('ext')!].every((s: string) => /externalP\(\) ← ent\(\)/.test(s))).toBe(true);
  });

  it('CAL-01 顶层函数入口那条路反向：被调函数住在别的文件时不得收（跨文件同名不猜）', () => {
    const bucket = collect([
      ['cal4def.ts', "function externalP(v) { return 'ext2'; }"],
      ['cal4use.ts', FN_ENTRY],
    ], TABLES).byTable.get('ewohAgentTask');
    expect(bucket!.via.has('ext2')).toBe(false);
  });
});

/**
 * ARW-01 的常驻位点：V298 修的上溯洞——入口归属以前遇到匿名回调就 `break`，
 * 于是写在 `db.transaction(async (tx) => …)` 体内的状态列 UPDATE **连入口都不登记**，
 * 那张表的目标态集合在度量里读成空（实物：`agent.service.ts` 的 `resolveRow`，
 * 三个调用侧字面量 approved/rejected/expired 从未被收进集合）。
 * 本尺自己的 `--self-test` 不算防回归位点（V116 判据），故从测试面钉住开火侧与"不许凭空造入口"侧各一支。
 */
describe('事务回调体内的写点仍归外层具名入口（ARW-01）', () => {
  const IN_TX = 'class A {\n'
    + "  async go(x) { await this.resolveRow('a1', 'o', 'approved', x); }\n"
    + '  private async resolveRow(id, org, status, actor) { await this.db.transaction(async (tx) => {\n'
    + '    await tx.update(ewohAgentApproval).set({ status })'
    + '.where(eq(ewohAgentApproval.id, id)).returning(); }); } }';

  it('ARW-01 事务箭头回调体内的 .set({ status }) 必须归到外层方法，调用侧字面量收得回', () => {
    const bucket = collect([['arw1.ts', IN_TX]], TABLES).byTable.get('ewohAgentApproval');
    expect(bucket).toBeDefined();
    expect([...bucket!.via.keys()].sort()).toEqual(['approved']);
    expect([...bucket!.via.get('approved')!].every((s: string) => /#A$/.test(s))).toBe(true);
  });

  it('ARW-01 反向：匿名回调没有具名外层时不得凭空登记入口（值来自外层变量则只留非字面量）', () => {
    const src = 'let st;\nawait db.transaction(async (tx) => {\n'
      + '  await tx.update(ewohAgentApproval).set({ status: st }).where(eq(id, 1)); });';
    const bucket = collect([['arw2.ts', src]], TABLES).byTable.get('ewohAgentApproval');
    expect(bucket).toBeDefined();
    expect(bucket!.via.size).toBe(0);
    expect(bucket!.nonliteral).toBeGreaterThan(0);
  });
});

/**
 * CNT-01 的常驻位点：V299 的第四档——状态列的值被提成"全扫描面唯一的 const 字符串字面量"。
 * 先量后收的读数（《基线》§5.3n5）：链上 22 处"值不是字面量"的写点里只有 1 处属这一档
 * （`dispatch-coordinator.service.ts:640` 的 `TASK_PRE_DISPATCH_STATUS` = `pending_dispatch`，
 * 定义在 `task-lifecycle.ts:69`），⇒ 收益一处、假阳性面 0。
 * 三条边界各配一支控制：同名两处撤销、let／var 不解、被形参遮蔽不解。
 */
describe('具名 const 字面量的解引用（CNT-01）', () => {
  it('CNT-01 唯一 const 字面量必须解得回，痕迹点名常量名·值·定义位置', () => {
    const src = "const K1 = 'pending_dispatch';\n"
      + 'async function f(db) { await db.update(ewohProductionTask)'
      + '.set({ status: K1 }).where(eq(id, 1)); }';
    const bucket = collect([['cnt1.ts', src]], TABLES).byTable.get('ewohProductionTask');
    expect(bucket).toBeDefined();
    expect([...bucket!.via.keys()]).toEqual(['pending_dispatch']);
    expect([...bucket!.via.get('pending_dispatch')!].every((s: string) => /const K1 = 'pending_dispatch' @ cnt1\.ts:1/.test(s))).toBe(true);
  });

  it('INS-01 INSERT 的 .values() 侧必须计入可写集合（单对象与数组两种形）', () => {
    const single = collect([['ins1.ts', "async function f(db) { await db.insert(ewohAgentTask)"
      + ".values({ status: 'created', id: 1 }); }"]], TABLES).byTable.get('ewohAgentTask');
    expect([...single!.direct].sort()).toEqual(['created']);
    expect(single!.insertN).toBe(1);
    const arr = collect([['ins2.ts', "async function g(db) { await db.insert(ewohAgentTask)"
      + ".values([{ status: 'pending' }, { status: 'failed' }]); }"]], TABLES).byTable.get('ewohAgentTask');
    expect([...arr!.direct].sort()).toEqual(['failed', 'pending']);
  });

  it('INS-01 反向：不碰状态列的 INSERT 与被形参遮蔽的标识符，都不许造出目标态', () => {
    const noCol = collect([['ins3.ts', "async function h(db) { await db.insert(ewohAgentTask)"
      + ".values({ resultType: 'x' }); }"]], TABLES).byTable.get('ewohAgentTask');
    expect(noCol!.direct.size).toBe(0);
    const shadow = collect([['ins4.ts', "const S = 'queued';\n"
      + 'async function k(db, S) { await db.insert(ewohAgentTask).values({ status: S }); }']],
      TABLES).byTable.get('ewohAgentTask');
    expect(shadow!.direct.has('queued')).toBe(false);
  });

  it('CNT-01 反向：同名 const 出现两次、或值来自 let（可再赋值），都不得解引用', () => {
    const dup = "const K3 = 'gamma';\n"
      + 'async function h(db) { await db.update(ewohProductionTask).set({ status: K3 }); }\n'
      + "async function h2(db) { const K3 = 'delta'; await db.update(ewohAgentTask).set({ status: K3 }); }";
    const b1 = collect([['cnt2.ts', dup]], TABLES).byTable.get('ewohProductionTask');
    expect(b1!.via.has('gamma')).toBe(false);
    expect(b1!.nonliteral).toBeGreaterThan(0);
    const mutable = "let LV = 'reassignable';\n"
      + 'async function m(db) { await db.update(ewohProductionTask)'
      + '.set({ status: LV }).where(eq(id, 1)); LV = \'other\'; }';
    const b2 = collect([['cnt3.ts', mutable]], TABLES).byTable.get('ewohProductionTask');
    expect(b2!.via.size).toBe(0);
  });
});
