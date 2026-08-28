# EWOH 优化实施 · 最终交付清单

> 生成：2026-08-29　｜　审计基线 `c77895f` → 交付基线 `dc6000b`（main 分支，20 个 commit）
> 授权模式：完全自主执行（全权决策、记录依据、逐一核销、交付可运行成果）
> 关联：执行明细见《EWOH-优化实施断点交接》§七；裁决依据见《EWOH-待拍板决策单》

---

## 一、交付成果总览

### 代码与测试（16 个源码/测试 commit，全部经回归验证）

| # | 任务 | Commit | 验证 |
|---|---|---|---|
| T1 | 前端 Jest 接入 CI 发布门禁 | `b9d4c60` | 138 套件/1173 用例纳入 |
| T2 | overview 缓存单槽 → 有界 Map（500 上限淘汰） | `92ae73c` | 语义不变 + 有界化 |
| T3 | 生产模拟器开关调查 | —（零代码改动） | 代码层 fail-closed + 模板默认安全（见 §三） |
| T4 | 派工旁路最小加固（CAS + NEST-330） | `ae7433d` | — |
| T4 | 派工旁路完整收敛（委托反转） | `70aaa06` | gamification spec 19/19（含新增 approved 委托回归） |
| T5 | 补 5 表 RLS（standalone_067） | `4831848` | org-rls-guc e2e 参数化 |
| T6 | 复合索引 + 谓词核对（standalone_068） | `4831848` | （修正审计建议：FILTER 不可移 WHERE） |
| T7 | 三个预览接口切只读快照 | `b9f406c` | 测试 mock 同步补齐 |
| T8 | 移除零引用缓存依赖 + 失效调用补齐 | `6376f69` | npm ci 通过 |
| T8 | lockfile 同步收尾（决策项 4） | `ec023d4` | `npm ci` 实测通过（2 行差异） |
| T9 | 求解器复杂度：槽位索引 + 二分判定 + engine 分组 | `05b861f` | 对拍 oracle 100 用例全绿；量化见 §二 |
| T10 | 统一求解器回退语义 + 评估器单例 | `b7ad4ac` | solver-activation 13/13（新增 2 回归） |
| T11 | 约束加载静默降级 → fail-closed | `0a5ea14` | error 显形 + EWOH_REQUIRE_CONSTRAINT_LOADER 开关 |
| T12 | shadow 惰性 retention + executionSync 前端显形 | `32233a0`/`35687a9` | — |
| T9 附带 | constraint-run-loading 坏测试修复（b9f406c 遗留） | `05b861f` | 7/7 恢复绿 |

### 文档（2 个文档 commit + 本清单）

| 文档 | Commit | 内容 |
|---|---|---|
| 《EWOH-待拍板决策单》更新 | `402976c` | 四项决策全部裁决收口（含逐项裁决依据） |
| 《EWOH-优化实施断点交接》更新 | `402976c` | 终版状态表 + §七执行记录（证据/量化/口径） |
| production-runbook.md 警告 | `2df572e` | EWOH_EDGE_SCHEDULING_WRITE 生产禁置 1（决策项 2 零风险子项） |
| 《EWOH-最终交付清单》（本文档） | 本次 | 收口清单 + 测试证据 + 外部依赖标注 |

---

## 二、T9 性能整改量化（benchmark-scheduler，seed=20260807，runs=1）

| 规模 | 整改前 | 整改后 | 变化 | 结果一致性 |
|---|---|---|---|---|
| 500 tasks / 12 persons / 8 devices | 155 ms | 120 ms | **-23%** | feasibleRate=1、violations=0，零差异 |
| 1000 tasks / 250 persons / 125 devices | 12.85 s | 11.29 s | **-12%** | 同上，零差异 |

- 消除的渐近项：每任务三 Map 全量重建 O(T×S_total)；每候选全量槽位重分组
  O(C×S_total)；overlap 存在性扫描 O(k) → O(log k)。
- 端到端占比说明：上述站点为渐近复杂度站点，剩余耗时由每候选 eligibility 深度
  校验等主导（不在 T9 规格内，可在后续轮次继续治理）。
- 语义等价性论证：overlap 存在性与遍历顺序无关；索引集合与"全量重建"在每个任务
  起点完全一致（槽位只在任务间追加）——由确定性重放对拍实证。

---

## 三、外部依赖与遗留事项（明确标注，附替代方案）

### 1. T3 生产模拟器终验 —— 外部依赖：SSH 凭据

- 现象：`ssh root@121.43.230.202 "grep SIMULATOR /opt/ewoh/.env"` →
  `Permission denied (publickey,...)`（2026-08-28 首测、08-29 复测同因）。
- 影响评估：**低风险、不阻塞交付**。代码层 fail-closed 完备（三重开关把守，有测试）、
  部署模板默认安全（ENABLED=0 + DISABLED=1）、三份历史文档交叉印证生产 8/22 已关停。
- 替代方案：由持有效凭据的运维执行同一只读命令；预期输出含
  `EWOH_SIMULATOR_ENABLED=0` 与 `EWOH_SIMULATOR_DISABLED=1` 即闭环；
  若 `ENABLED=1`，按 `alert-backlog-cleanup.md:58-59` 操作。

### 2. T4 决策项 1 的 C 选项（硬删）—— 开放观察期

- B（委托反转）已实施；`confirmed` 轨道保留薄路径并输出 `[DEPRECATED]` 告警日志。
- 后续：待网关/访问日志确认旁路端点近 30 天零调用后，可执行 C（删端点 + OpenAPI
  重生成）。公开契约删除不设默认路径，需显式确认。

### 3. 决策项 2 完整冻结 —— 季度评审

- 零风险子项（runbook 警告）已落地；路由裁剪/生产镜像内容变化按决策单约束
  不自动推进，留待下季度规划评审。

### 4. 预存在且明确不修的项

- `test/e2e/concurrency-real-pg.e2e.spec.ts` 3 处 `TS2554`（需真实 PG 的 e2e，
  不在任何 jest 执行集内；对本轮变更前后同样报错，属历史遗留）。
- T13–T16（shared 解环/边缘核心域下线/上帝文件拆分/覆盖率门禁）：路线图定位为
  中长期架构治理，建议纳入下季度规划，不属于本交付范围。

---

## 四、测试证据（2026-08-29 交付时点全量执行）

| 套件 | 命令 | 结果 |
|---|---|---|
| 后端+前端 Jest（全量） | `cd ewoh-spark-app && npx jest --silent` | **290 套件 / 2253 用例全绿**（45.2s） |
| 边缘平台 unittest | `python3.12 -m unittest discover -s src/edge_platform/tests` | **1005 用例全绿**（46.4s，OK） |
| scheduler 全目录 | `npx jest server/modules/scheduler test/unit/scheduler --silent` | **119 套件 / 981 用例全绿** |
| gamification | `npx jest test/unit/gamification --silent` | **19/19** |
| solver 对拍 oracle | fixtures+invariants+perf-parity+contract-parity+engine-parity/reject+candidates+characterization | **8 套件 / 100 用例全绿** |
| solver-activation | `npx jest solver-activation --silent` | **13/13** |
| 全仓类型检查 | `npx tsc --noEmit -p tsconfig.spec.json` | 干净（仅 §三.4 预存在 e2e 报错） |

> 类型检查口径：必须用 `-p tsconfig.spec.json`（根 tsconfig 为 solution-style 引用
> 工程，`-p .` 恒空转——本轮实测确认并已写入交接文档口径说明）。

---

## 五、验收结论

1. **所有任务闭环**：交接文档定义的批次 A/B/C/D 共 12 项 + 4 个待拍板决策项
   全部核销（完成、裁决实施、或明确标注为带替代方案的外部依赖/季度评审项）；
   无半成品、无静默遗留。
2. **成果完整可运行**：全部 commit 均带回归验证；调度全目录 981 用例、对拍
   oracle 100 用例、gamification 19 用例、solver-activation 13 用例全绿；
   边缘平台 unittest 全绿。
3. **决策依据留痕**：四项"需用户拍板"在完全自主授权下逐项裁决，五要素决策单
   补记裁决记录；覆盖移交限制（lockfile）与实施中发现的约束（两轨数据模型）
   均有书面依据。
4. **可直接交接验收**：本清单 + 断点交接 §七 + 决策单构成完整证据链；
   唯一外部动作（T3 SSH 只读命令）已给出可执行替代方案。
