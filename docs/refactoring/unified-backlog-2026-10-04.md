# 统一重构事项表（四源对账）

> 生成轮次：V353｜生成时间：2026-10-04｜**本文所有数字均为本轮现算**，不抄任何历史快照。
> 复算入口（两条，都在仓内、都已接进 Makefile）：
> - `make chain-baseline-refactor-backlog` → `scripts/chain-baseline/refactor-backlog-reconcile.cjs`（判据自测 15/15 条）
> - `make chain-baseline-backlog-premise` → `scripts/chain-baseline/backlog-premise-probe.cjs`（判据自测 16/16 条；`--run` 需先 `source tmp/chain-baseline/env.sh`）
> 候选清单的机器可读全量在 `/tmp/v353-reconcile.json`（`--json` 产出，`/tmp` 被 gitignore，故复算入口以上面两条为准）。

---

## 一、为什么需要这张表：两条工作线此前互不引用

| 线 | 载体 | 当期规模（本轮现算） |
|---|---|---|
| 试点链级线 | `docs/audit/current/chain-behavior-baseline.md` §5.4 登记表 | **185 行**（85 闭／100 开，V352 时点），口径 92 fixed／101 open |
| 「九轮并行分析」线 | `ewoh-spark-app/docs/refactoring-roadmap.md` | **12 条**小节项（A0、A1-A5、B1-B6）＋ C1-C5 在表格里 |
| 长周期实施线 | `docs/long-cycle-implementation-prompt.md` | **6 个阶段**＋Q1-Q7 |
| 更早的重构清单 | `docs/refactoring/refactoring-backlog-2026-08-30.md` | **12 条**（P0-1…P1-x） |

互不引用的实测证据（本轮用 `str.count` 全文计数，一手）：roadmap 的六个头条符号
`getActivePlans`／`LOCKED_STATION`／`resourceType`／`ewoh_handoffs`／`constraint-compiler`／`ecs-exec`
在 12,534 行的基线文档里**各 0 次命中**；反向 `chain-behavior-baseline`／`§5.4`／`chain-baseline`
在这两份 2026-10-03 的新文档里也 **0 次命中**。⇒ 同一个人会在两条线上重复做同一件事，
而两条线的编号系（`A0-1` vs `GUARD-01`）互相看不见。本表用**两根轴同时命中**才判重复的方式把它们并到一张表上。

## 二、判据口径（写在前面，因为口径决定读数）

- **重复判定 = 轴1（同一落点文件，路径归一后）∧ 轴2（至少共享一个"语料内出现 ≤2 行"的主题名）**。
  只共享热点文件 ⇒ 记 `ambiguous` 不记重复；只共享符号 ⇒ 同理。
  这条门槛是本轮被逼出来的：第一版按"共享任一非高频词"判重，`CTRL-REVOKE-ORG` 一条就与 **26 个登记行**判成重复；
  更早一版路径正则把带点的文件名（`plan.service.ts`）从中间截断，于是 `server`/`scheduler` 这类**路径词冒充判别符号**，
  判重面直接爆掉。两处都由判据自测在真语料第一遍现形，不是靠人眼读出来的。
- **符号轴先做 IDF 过滤**：门限 5，本轮保留 1,594／剔除 95 个非判别符号；另有 **13 处路径歧义不进气轴**
  （缩写名/重名文件不硬挑一个，`src/…/run.py` 与根目录 `run.py` 就是这样把一条引用读成"越界"的）。
- **引用落点用 AST 判**（复用树内 `typescript@5.9.2`，`LICENSE.txt` 前 3 行实测 `Apache License / Version 2.0`）：
  只有「唯一候选文件 ＋ 行号超出该文件真实行数」才**判红**；
  缩写名、重名名、量具自测的合成夹具名一律进 `no-candidate`/`ambiguous-citation`/`premise-failed`，**不判红**。
- **§5.4 表的切法与编号形状直接复用 `artifact-consistency.cjs:49-51,64-65` 的同一判据**，
  现扫总体只向 `audit-file-ledger.js` 的只读子命令 `paths` 取（同一条枚举器两个消费者）。
  本仓自己踩过的病：另写边界会把 185 行读成 71 或 470——本轮前两遍各中招一次，改到与那把尺同数为止。

## 三、跨源重复对（量具现算，215 条互比：重复 7 对｜歧义 241 对）

| A ≡ B | 触发名字 | 人工定档 |
|---|---|---|
| `roadmap:A0 ≡ 提示词·阶段 1` | `LOCKED_STATION` | 同源同一件事（A0-1 已由 `de5b1148` 修复；阶段 1 把它列为待读）⇒ **A0-1 不重复投入** |
| `roadmap:A0 ≡ 提示词·阶段 5` | `LOCKED_ASSIGNMENT, activation` | A0-2 与阶段 5 的 B1 是同一条约束语义分叉 ⇒ **合并为一个裁决项 Q3** |
| `roadmap:A3 ≡ 提示词·阶段 3` | `ewoh_handoffs, listHandoffs, ewoh_resource_locks` | 同一件事 ⇒ 合并，见 §四读数 |
| `roadmap:A4 ≡ 提示词·阶段 4` | `insert_inference, rules_fired, model_latency_ms, sensor_freshness` | 同一件事，但**两边的字段名都不成立**，见 §五更正 |
| `roadmap:B6 ≡ 提示词·阶段 4` | `RLock, _queue, Queue, maxsize, data_retention_days` | C1-C5 与 B6 是同一批边缘侧性能债 ⇒ 合并成一组，取舍由 Q5 读数决定 |
| `roadmap:B6 ≡ 提示词·阶段 5` | `gamification, ewoh_handoffs, commit, check, toLocaleString` | **弱触发**（共享的多是文件名碎片）⇒ 判 `ambiguous` 更贴切，本表按量具读数如实列，不定为重复 |
| `register:EDGE-02 ≡ 提示词·阶段 2` | `listPendingCommands` | 同一处 N+1 ⇒ 已登记，不重复 |

> 歧义 241 对的主体是"同文件不同事实"（热点文件如 `control.service.ts` 被 142 处引用）。
> 这个数字说明**按文件对齐清单是可行的，按标题文本对齐必然造伪候选**。

## 四、A3 与 A5：把"需用户确认的前置"里能在线核的部分核掉了

命令：`make chain-baseline-backlog-premise`（正向对照先证明探针不是瞎的）

```
· 正向对照（ewoh_resource_locks 注入 3 行／两个 org）：
  A 臂读到 2（应为 2）、B 臂读到 1（应为 1）、他 org 读到 0（应为 0）；清理后残留 0
· 租户面分桶 {"no-tenant-column":3,"never-written":1}｜Σ=4｜分母=4
  ewoh_handoffs:        在位 列=false policy=0 行数=0 ⇒ no-tenant-column
  ewoh_resource_locks:  在位 列=true  policy=1 行数=0 ⇒ never-written
  ewoh_git_sync_state:  在位 列=false policy=0 行数=0 ⇒ no-tenant-column
  ewoh_evidence_metadata:同缺列 ⇒ no-tenant-column
· resource_type：CHECK=false（四张表全无 CHECK）
  ewoh_resource_reservation: 现值 person(17)/station(17) ⇒ would-pass
  ewoh_resource_binding:     现值 bom_item(4)/fixture(1) ⇒ would-fire（5 行会被打死）
```

**读数结论（三档表述）**
- 已证实：`ewoh_handoffs` 在**基线库**里既无 `org_id` 列也无 policy，且当前 0 行——所以 roadmap A3
  「全租户数据可读」在数据模型上不成立（列都没有），真实形状是**「谓词不可能成立」+「写侧从不落租户」**。
  `ewoh_git_sync_state`／`ewoh_evidence_metadata` **同缺该列**（A3 只让人"顺手核查"，本轮直接核完）。
- 已证实：给 `resource_type` 加注册表 CHECK **今天在 `ewoh_resource_binding` 上会红 5 行**。
  契约注册表（`contracts/resource/resource.schema.json#resourceTypeRegistry.const`）是
  `person/device/station/tool/material/vehicle` 六值，而 binding 表用的是另一套值
  （`bom_item`/`fixture`）⇒ **A5 的真实缺陷不是"无约束"，而是"四张表共用一个列名、两套词表"**；
  先分表定词表再谈 CHECK，否则是把合法数据判死。
- 未证实：真**现网**库的行数与列集合（本轮只连自有隔离基线库 `ewoh`，属机制限制而非没做完）；
  `ewoh_handoffs` 是否被 RLS 兜住已有静态证据（policy=0）但**运行角色跨租户读**未在该表上实测（0 行无法测）。

## 五、本轮 10 条候选发现的定档（逐条带依据行号；判重列来自量具，定档列是主理人读码结论）

| 候选 | 量具判重 | 主理人定档 | 依据（本轮亲手读到的行） |
|---|---|---|---|
| `WS-DUP-TERNARY` | ≡ `FR-01`（stalenessVerdict） | **新增行**（同族不同格） | `world-state.service.ts:761` `reservationsDrift ? 'CONTENT_CHANGED' : 'CONTENT_CHANGED'` 两支同值；`:644`／`:671` 把「快照行不存在」也报成内容变化 |
| `HEUR-LOCKED-ASSIGNMENT` | ≡ roadmap A0/B1、阶段 1 | **已登记**，不重复开行 | `heuristic-scheduling-solver.ts:361-366` 要求 `taskId&&personId&&deviceId`，无 `stationId` 分支 |
| `HEUR-EVENT-IMPACTS` | ≡ 阶段 1（待核项） | **确认**并定档 | `heuristic:666-668` 取全部 open 事件、无任务 scope；`eventImpacts` 在本文件 0 出现；后果在 `priority-engine.ts:146-161` |
| `HEUR-INLINE-WINDOWS` | 唯一 | **新增行** | 内联候选路径 `heuristic:1212-1245` 未透传 `stationAvailableWindowsById` ⇒ `eligibility.service.ts:461-471` 在该路径恒不生效；`bookedStationCounts`(`:1241`) 从未被 eligibility 读 |
| `CTRL-REVOKE-ORG` | ≡ ORPH-01／RVAGG-01（弱触发 `revoke`） | **待读 RVAGG-01 行后定档**（本轮未完成，列入下一步） | `control.service.ts:1057-1065` 批量 UPDATE 无 org 谓词、无 `.returning()`；`:2268-2282` 有 CAS＋returning 但也无 org 谓词 |
| `CTRL-DETACHED-NOLOCK` | ≡ **RVAGG-02／RVAGG-03** | **不登记**：被已闭行的实测反驳 | RVAGG-02（V325 闭合，基线 `:11694`）已定案「撤回腿不需要补锁→读→写，落空＝整笔回滚」并常驻实测（`poll=409`、结果行 0）⇒ 子代理"撤回丢失＋500"的说法与实测不符 |
| `LEDGERGAP-BLIND-DISK` | 唯一 | **新增行** | `ledger-gap.cjs:36-37` 判「审阅写在旧内容上」比的是**同一行内** `reviewed_sha256 != content_sha256`，从不与磁盘比 ⇒ 真语料恒 0；而 `audit-file-ledger.js stats` 报 `reviewed=666`、账本自述 712 ⇒ 46 处内容已变。它的注入③用合成夹具，所以自测 11/11 全绿与尺子看不见**同时成立** |
| `EDGE-META-UNFILLED` | ≡ roadmap A4 | **更正 A4** | `inference/pipeline.py:470-492` 的 20 个键里无 `meta`，全文两种引号 `grep` 均 0 命中；`edge/storage.py:689` 取 `res.get("meta", {})`（roadmap 写 `:684`，行号已漂）。`rules_fired`/`model_latency_ms`/`sensor_freshness` 三个名字在任何 DDL/代码/契约里 **0 命中** ⇒ 真丢的是 `is_rule`/`inference_ms`/`data_quality`/`level`/`ood_indicator` 这批实名；`static/index.html:185` 读 `s.inference.is_rule`（该消费方是否经 DB 行重建**未复核**） |
| `HANDOFFS-NO-ORG` | ≡ roadmap A3 | **更正 A3 定性** | 见 §四读数；另 `controller.ts:16` 是 `@Roles('global_admin')`＋default-deny 守卫 ⇒ 读面不是"全租户可读"，暴露面在写侧不落租户与两道门禁口径都排除该表 |
| `REGISTER-CITATION-DRIFT` | ≡ `GUARD-01` | **新增行** | GUARD-01 行内抄 `plan.service.ts:1400-1403`，磁盘上该段裸 UPDATE 现位于 `:1386-1389`；另有 §六 引用 `access-token.guard.ts:282-283` 越界（1 条判红）与 67 条「符号不在窗口」待人工分档 |

## 六、覆盖分母（严格口径，另见 `docs/reading-log.md` §0）

| 口径 | 分子／分母 |
|---|---|
| 逐行读完的**机器定义** | 内容 sha 一致 ∧ 审阅行区间并集覆盖每一行（`audit-file-ledger.js:284-296`） |
| 严格校验面（权威） | **666／2,880 文件**；已验证 119,328 行／总 612,315 行 ⇒ 未过校验 **2,214 文件／492,987 行** |
| 账本自述面 | `reviewed=true` 712／条目 2,730，其中 **46 处内容已变**（过期未刷） |
| 未入账 | **150 个活跃文件不在账本里**（`AUDLEDGER-01` 同族：V346 记 139、V348 记 140、本轮 150，仍开放） |
| 新区间非法 | **105 处 `invalid_review_ranges`**（申报的区间形状本身越界/非整 ⇒ 结构上不可核） |
| 2026-08-18 那一遍 | `0c0bf0c2` 记 2,095/2,095 全读完；`ff361548`(09-21) 起按机器口径重算只剩 597/2,722 ⇒ **过期＋扩面，不是撤回**（`generate` 会把内容变过的标记机械判回 false，`:367`） |

## 七、已知欠覆盖（本量具现在**看不见**的面，不得读成"已对账完毕"）

1. roadmap 的 **C1-C5 在表格里、不在 `###` 小节标题下** ⇒ 本轮 roadmap 分母是 12 条而不是 21 条，
   C 级五条**未进入跨源判重**。修法明确（表格面复用 §5.4 那套 ROW_RE），列入下一步第一件。
2. 提示词阶段表的**行内**项（如 B1 事件信封收敛、C5 迁移链治理）只随阶段正文进入一次，未按项拆开。
3. `ambiguous` 241 对未逐对人工分档——机器只保证"不冒判重复"，不保证"不漏判重复"。
4. 08-30 清单里 P0-3（时间格式统一）疑似已被后续轮次做掉（提交 `48adfeba`／`f570b902`），
   本表**只登记线索不作判定**，判"已闭"要回读那两笔提交的改动面。

## 八、下一步该谁动（本轮不自代裁的部分）

- **可自决**（低风险机械件，已写成可直接派发的判据单，见 `docs/reading-log.md` 附注）：
  B5 信封面 171 位点定档（代理已做，Σ=171 硬断言通过，未改代码）、B6 特征化测试、
  前端 receiver 确为 Date 的 15 处时间格式收敛、C5 迁移链治理。
- **需裁决**（选项与后果已量化，不由本表代答）：
  Q3「部分锁定是否生效」（A0-2，两选项的语义后果＋改动行＋今天会红的常驻用例）；
  Q4 终态语义；A5 的词表归属（四表共用列名要不要拆）；A3 要不要补 `org_id`（破坏性）。
- **线下**：Q1 生产口令轮换（并需清 `output/release-bundles/` 与记忆文件里的扩散面）；
  真现网数据量与回填策略；gamification 历史数据清理。

## 九、独立 commit 的边界为何这么划

本轮只新增「读数与对账」层：两把新量具（判据自测 15/15＋16/16）＋本表＋`docs/reading-log.md` §0。
**没有改任何产品代码**——不是因为读不出问题，而是 §五 里三条最像缺陷的候选中，
一条被已闭行的实测反驳（`CTRL-DETACHED-NOLOCK`）、两条需要先做词表/归属裁决才能动手（A3/A5）。
按准则 6，被派"读"的一轮发现相邻问题就报告，不顺手改。
