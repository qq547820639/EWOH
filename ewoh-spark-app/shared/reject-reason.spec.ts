/* 拒绝/冲突原因词表与文案（`shared/reject-reason.ts`）。
 *
 * 为什么需要这组测试：2026-09-11 审计发现两处真实缺陷——
 *   1. eligibility 实际产出 30 个原因键，而声明的联合类型只有 22 个（维护/质量封锁、
 *      连续负荷、设备故障等 8 个键在类型之外，靠 `as` 断言掩盖）→ 类型说谎；
 *   2. 同一个键在 5 张前端映射表里有 3 种中文，且部分键没有文案 → 现场看到英文键。
 * 本测试把"词表 ↔ 文案 ↔ 真实产出方"三者钉死，防止再次漂移。
 */
/// <reference types="jest" />
import * as fs from 'fs';
import * as path from 'path';
import {
  CANDIDATE_REJECT_REASONS,
  SOFT_CONSTRAINT_LABELS,
  TRACE_SOFT_COST_LABELS,
  CONFLICT_TYPE_LABELS,
  HARD_CONSTRAINT_LABELS,
  REJECT_REASON_LABELS,
  conflictTypeLabel,
  isRegisteredReason,
  rejectReasonLabel,
} from './reject-reason';

/**
 * 读取某个源文件（相对仓库根）并**去掉注释**，用于扫描真实产出的原因键。
 *
 * 去注释是必需的：守卫本身就会在代码注释里写出 `reasons.push('key')` 这类示例，
 * 不去注释会把示例当成真实产出（2026-09-11 实测：新增注释后守卫误报 `key` 未登记）。
 */
function readSource(relPath: string): string {
  return fs
    .readFileSync(path.resolve(__dirname, '..', relPath), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');
}

describe('拒绝原因词表（CANDIDATE_REJECT_REASONS）', () => {
  it('每个原因键都有非空中文文案（Record 已在编译期穷尽，这里防运行时漏项）', () => {
    for (const reason of CANDIDATE_REJECT_REASONS) {
      const label = REJECT_REASON_LABELS[reason];
      expect(typeof label).toBe('string');
      expect(label.trim().length).toBeGreaterThan(0);
      // 文案不能等于键本身（那就是没翻译）
      expect(label).not.toBe(reason);
    }
  });

  it('词表无重复键，且解析器能把每个键解析成对应文案', () => {
    expect(new Set(CANDIDATE_REJECT_REASONS).size).toBe(CANDIDATE_REJECT_REASONS.length);
    for (const reason of CANDIDATE_REJECT_REASONS) {
      expect(rejectReasonLabel(reason)).toBe(REJECT_REASON_LABELS[reason]);
      expect(isRegisteredReason(reason)).toBe(true);
    }
  });

  /* 真实漂移点：eligibility 用 `reasons.push('x')` 产出键。任何产出的键都必须
   * 已在词表登记并有文案——这正是本轮修掉的缺陷（8 个键未登记）。 */
  it('eligibility 实际产出的每个键都已登记（防词表再次落后于实现）', () => {
    const source = readSource('server/modules/scheduler/eligibility.service.ts');
    const emitted = [...source.matchAll(/reasons\.push\('([a-z_]+)'\)/g)].map((m) => m[1]);
    expect(emitted.length).toBeGreaterThan(20);
    const unregistered = [...new Set(emitted)].filter((key) => !isRegisteredReason(key));
    expect(unregistered).toEqual([]);
    for (const key of new Set(emitted)) {
      expect(rejectReasonLabel(key)).not.toContain('未登记原因');
    }
  });

  /* 求解器 violations 的 type/reason 也是现场可见码：新增而未登记 → 冲突层显示
   * "未登记原因（X）"。这里扫描三套求解器源码，把"码 ⊂ 词表"钉死。 */
  /* 漂移守卫：候选引擎实际写入的 softCosts 键（camelCase）必须都已登记，
   * 否则指挥地图成本段会显示"未登记原因（latenessMs）"。 */
  it('决策痕迹 softCosts 的真实键都已登记（扫描候选引擎源码）', () => {
    const engine = readSource('server/modules/scheduler/candidate-engine.service.ts');
    const block = /softCosts:\s*\{([\s\S]*?)\}/.exec(engine);
    expect(block).not.toBeNull();
    // 只取**属性名**（行首/`, {` 之后的标识符），不要把简写值（`latenessMs: lateMs`）当键
    const keys = [...block![1].matchAll(/(?:^|[{,])\s*([A-Za-z_$][\w$]*)\s*[,:]/g)].map((m) => m[1]);
    expect(keys.length).toBeGreaterThan(3);
    const unregistered = keys.filter((key) => !isRegisteredReason(key));
    expect(unregistered).toEqual([]);
    for (const [key, label] of Object.entries(TRACE_SOFT_COST_LABELS)) {
      expect(rejectReasonLabel(key)).toBe(label);
      expect(label).not.toBe(key);
    }
  });

  it('软约束/成本项全部有可读文案（指挥地图成本段不再显示裸键）', () => {
    for (const [key, label] of Object.entries(SOFT_CONSTRAINT_LABELS)) {
      expect(label.trim().length).toBeGreaterThan(0);
      expect(label).not.toBe(key);
      expect(rejectReasonLabel(key)).toBe(label);
    }
    // 漂移守卫：服务端声明的软约束集合必须都在词表内
    const constraints = readSource('server/modules/scheduler/constraints.ts');
    const declared = [...constraints.matchAll(/^\s*'([A-Z_]+)',?$/gm)].map((m) => m[1]);
    const unregistered = [...new Set(declared)].filter((code) => !isRegisteredReason(code));
    expect(unregistered).toEqual([]);
  });

  it('求解器违反项的类型/原因码都已登记（含大小写混用与 snake 变体）', () => {
    const solverFiles = [
      'server/modules/scheduler/rule-based-scheduling-solver.ts',
      'server/modules/scheduler/heuristic-scheduling-solver.ts',
      'server/modules/scheduler/milp-scheduling-solver.ts',
      'server/modules/scheduler/cp-sat-scheduling-solver.ts',
    ];
    const codes = new Set<string>();
    for (const file of solverFiles) {
      const source = readSource(file);
      for (const m of source.matchAll(/type:\s*'([A-Za-z_]+)'/g)) codes.add(m[1]);
      for (const m of source.matchAll(/reason:\s*'([A-Za-z_]+)'/g)) codes.add(m[1]);
    }
    expect(codes.size).toBeGreaterThan(3);
    const unregistered = [...codes].filter((code) => !isRegisteredReason(code));
    expect(unregistered).toEqual([]);
  });

  it('候选引擎与冲突服务产出的拒绝/冲突键也已登记', () => {
    const engine = readSource('server/modules/scheduler/candidate-engine.service.ts');
    const engineKeys = [...engine.matchAll(/reasons\.push\('([a-z_]+)'\)/g)].map((m) => m[1]);
    for (const key of new Set(engineKeys)) {
      expect(isRegisteredReason(key)).toBe(true);
    }
    const conflict = readSource('server/modules/scheduler/conflict.service.ts');
    const conflictKeys = [...conflict.matchAll(/'(battery_unknown|low_battery|device_offline|resource_stale|double_booking|predecessor_violation|forbidden_zone|blocked_route|reservation_conflict|reservation_expiring|perception_inconsistent)'/g)]
      .map((m) => m[1]);
    expect(conflictKeys.length).toBeGreaterThan(0);
    for (const key of new Set(conflictKeys)) {
      expect(isRegisteredReason(key)).toBe(true);
    }
  });
});

describe('拒绝原因文案解析（rejectReasonLabel）', () => {
  it('未知键显式暴露为"未登记原因（key）"，绝不静默返回裸键或假装已知', () => {
    expect(rejectReasonLabel('some_future_reason')).toBe('未登记原因（some_future_reason）');
    expect(isRegisteredReason('some_future_reason')).toBe(false);
  });

  it('空原因有明确文案（不显示空白）', () => {
    expect(rejectReasonLabel('   ')).toBe('未提供原因');
  });

  it('历史键（重命名前）仍能显示中文，读旧数据不退化', () => {
    // device_data_unavailable 是 battery_unknown 的旧名（2026-09-11 重命名）
    expect(rejectReasonLabel('device_data_unavailable')).toBe(CONFLICT_TYPE_LABELS.battery_unknown);
    expect(rejectReasonLabel('unavailable')).toBe(REJECT_REASON_LABELS.person_unavailable);
    expect(rejectReasonLabel('low_battery')).toBe('电量低于下限');
  });

  it('电量"未知"与"不足"是两条不同文案（数据缺口 ≠ 事实）', () => {
    expect(rejectReasonLabel('battery_unknown')).not.toBe(rejectReasonLabel('battery_low'));
    expect(rejectReasonLabel('battery_unknown')).toContain('未知');
  });

  it('两个词表里同义的键必须逐字一致（同一含义不能有两种说法）', () => {
    // 键名相同 → 文案必须相同
    const overlap = Object.keys(CONFLICT_TYPE_LABELS).filter(
      (key) => key in REJECT_REASON_LABELS,
    );
    expect(overlap.length).toBeGreaterThanOrEqual(3);
    for (const key of overlap) {
      expect(CONFLICT_TYPE_LABELS[key as keyof typeof CONFLICT_TYPE_LABELS]).toBe(
        REJECT_REASON_LABELS[key as keyof typeof REJECT_REASON_LABELS],
      );
    }
    // 键名不同但含义相同（冲突词表沿用历史拼写）→ 文案同样必须一致
    const sameMeaningPairs: Array<[keyof typeof CONFLICT_TYPE_LABELS, keyof typeof REJECT_REASON_LABELS]> = [
      ['low_battery', 'battery_low'],
      ['predecessor_violation', 'predecessor_pending'],
      ['station_capacity', 'station_capacity_exceeded'],
      ['forbidden_zone', 'zone_forbidden'],
      ['safety_block', 'safety_blocked'],
      ['blocked_route', 'route_infeasible'],
      ['resource_stale', 'stale_data'],
    ];
    for (const [conflictKey, rejectKey] of sameMeaningPairs) {
      expect(CONFLICT_TYPE_LABELS[conflictKey]).toBe(REJECT_REASON_LABELS[rejectKey]);
    }
  });

  it('决策痕迹硬约束键（UPPER_SNAKE）可读', () => {
    expect(rejectReasonLabel('MIN_BATTERY')).toBe(HARD_CONSTRAINT_LABELS.MIN_BATTERY);
    expect(rejectReasonLabel('REQUIRED_SKILL')).toBe('缺少技能');
  });

  it('冲突类型键可读，且 conflictTypeLabel 与统一解析器一致', () => {
    for (const [type, label] of Object.entries(CONFLICT_TYPE_LABELS)) {
      expect(conflictTypeLabel(type)).toBe(label);
      expect(label.trim().length).toBeGreaterThan(0);
    }
  });
});
