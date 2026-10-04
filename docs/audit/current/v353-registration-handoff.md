# V353 登记单（本轮的取证与批次件）

> 这份件开头写过"本轮不能 mint"。**该前提已在同一轮内被推翻**：带服务重放跑通了（第 4 遍 rc=2、第 5 遍见下），
> 台账按原计划一次改完。本件保留的原因是它记着**为什么一度判不可 mint**、以及两处被实测反驳的自述——
> 那些是取证，不是待办。

## 一、本轮已落地（都已进 git，不在台账里）

| 产物 | 状态 |
|---|---|
| `scripts/chain-baseline/refactor-backlog-reconcile.cjs` | 判据自测 15/15；四源分母现算 185/12/6/12；跨源判重两轴门槛；引用落点 AST 判 |
| `scripts/chain-baseline/backlog-premise-probe.cjs` | 判据自测 16/16；租户面九档互斥；注入式正向对照开火（A=2/B=1/他org=0/残留 0） |
| `Makefile` | 新增两个复算入口目标（分母现抽 ⇒ 执行面读数从 56 变 57，两件都落「无人跑」桶，未接共享门禁） |
| `verify.sh` rebuild 档 | 构建前 `rm -rf dist`（整份，不是只清 `dist/server`）＋构建后裸别名自检；`EWOH_SKIP_BUILD=1` 档显式不判 |
| `verify.sh` 启动档 | 显式 `EWOH_DEPLOY_TARGET=standalone`——**定性＝对干净克隆的预防性加固**，见 §二末段 |
| `docs/reading-log.md` | §0 口径与分母定案；§1 调度域（含新增 §1.9 约束四消费面矩阵）；§2 控制域；§3 六条欠账与两处自我更正 |
| `docs/refactoring/unified-backlog-2026-10-04.md` | 四源对账主表 |

## 二、C 段那一次"链看起来坏了"：两个成因要分开记

**现象**（第 4 遍带服务全量重放，`tmp/v353-replay4.log`，rc=2，「有 4 项未通过（SKIP 也计入未通过）」）：
A 全新链 105/105、B 约束层 2,832 行、D **139 passed/139 total**、D2 **139 passed/139 total**、D3 逐套件静态可注册数与实到数对上（33 spec＋3 条静默占位已点名）、边缘关停 3 passed；
未通过的 4 项**全部落在 C 段**：golden 18 PASS/1 SKIP（共 19，账面 22）、wave 2 PASS/1 SKIP（共 3，账面 12）、receipt 3 PASS/1 SKIP（共 4，账面 19）、fault-replan 15 PASS/**1 FAIL**/2 SKIP（账面 18）。

**成因一＝陈旧产物冒充"已重建"（已修，`ARUN-01`）**。取证三步（命令读数）：
1. `dist/server` 里 **18 个文件**保留裸 `require("@server/...")`，另 **89 个**用相对路径 ⇒ 不是全量现象；
2. `rm -rf dist/server` 后重建 **rc=0 但无产出**（`nest-cli.json:6 deleteOutDir:false` ＋ `dist/tsconfig.node.tsbuildinfo` 增量 ⇒ tsc 判定无变化、完全不 emit）；
3. `rm -rf dist`（整份）后重建 ⇒ 裸别名 **0**、`main.js` 在位。
**修法落点是整份 `dist`**——只删 `dist/server` 会更糟（第 2 步就是那条路的实测结果）。第 4 遍的 D/D2 各 139 全绿就是这一修的背书：D 段子进程跑的正是 `dist/server/**`。

**成因二＝ENV-02 复发（已按 §5.3ad 的既有入口复位，不开新行）**。C 段四项同源的取证在场景日志里自报：
`wave.log` 的 SKIP 文本逐个列出扫描面——6 个候选方案**全部 `待派工=0/0`、首条违规 `infeasible:no_eligible_resource`**，并直接给出复位命令；
`golden.log` 同一形状（"候选方案均无可用 assignment（含等待冷却后重试）"）。这与 V79/V80 那两轮的取证逐字同形（状态件 `env02_solver_premise`/`v80_env02_falsified`），
"基线可消耗、但不可复位"那一半 V81 已固化成入口，所以本轮做的是**用它**：`chain-baseline-rebuild REBUILD=1` → `chain-baseline-seed`，
两声 rc=0、迁移链 verify 105/105（`tmp/v353-reset.log`），随后第 5 遍重放为背书链。
顺带一次**反向对照白送**：复位入口自己拒过一次——在重放还在飞时跑它，输出 `失败: 另一次重放正在运行（pid=93950）——复位会把它的数据抽掉` ⇒ 三层护栏里"不许同时动数据"这层当场开火，不是纸面判据。

**已证伪的一处自述（诚信条款）**：启动档那条注释起初写"此前只靠未入库的 `.env.local-standalone` 提供该变量 ⇒ 干净克隆上后端 exit 1、本段退 3（V353 实测）"。
实测 `grep -c EWOH_DEPLOY_TARGET ewoh-spark-app/.env.local-standalone` → **1**（值 `EWOH_DEPLOY_TARGET=standalone`；该文件 2,853 字节、`.gitignore:83`）⇒ 本机从来没靠它缺位失败过；
我自己那次冒烟失败是因为**没 source 那个文件**。所以该处定性＝**对干净克隆的预防性加固**，注释已按此改写，登记行不得把它写成 V353 的成因。

## 三、待登记的 4 条开放行（行文本已按红线写好：不出现 `make <目标>` 形状、条目正文不写 `scripts/` 全路径）

| 编号 | 优先级 | 内容（§5.4 第 3 格） | 证据（§5.4 第 4 格） | 归属桶 |
|---|---|---|---|---|
| `ARUN-01` | P2（工具链·陈旧 dist 产物冒充"已重建"，本轮已修但缺常驻位点） | `verify.sh` rebuild 档此前不删产物目录，`deleteOutDir:false` ＋ 增量 tsbuildinfo 使"重建"可以不重新 emit ⇒ 旧形状文件残留（实测 18 个裸 `@server/*`、另 89 个正常，干净重建后 0），C 段后端 MODULE_NOT_FOUND 退 3。本轮修法＝rebuild 前整份删 `dist`（只删 `dist/server` 会更糟：tsbuildinfo 还在，tsc 判定无变化而完全不 emit）＋构建后自检裸别名（`EWOH_SKIP_BUILD=1` 档不判）。余下两问：①要不要把它做成可 require 的常驻控制（自检是 bash 判据，jest 覆盖不到）；②陈旧产物具体来源未定位（未读 stamp 与构建历史）⇒ 不得写成某轮引入的回归 | 已证实(实测 V353)：三步取证读数（18 vs 89；只删 `dist/server` 后 rc=0 无产出；整份删后裸别名 0）＋双向对照（植入 1 ⇒ 点名，还原 ⇒ 0）；修法背书＝整份删后那一遍 D 与 D2 各 139 passed/139 total（子进程跑的正是 `dist/server/**`）| E |
| `RECON-01` | P2（台账面·四源清单互不引用已由量具接管） | 四源分母与 7 对跨源重复进表；**欠覆盖四项如实登记**：roadmap 的 C 级在表格里未进判重、提示词阶段表未按项拆、241 对 ambiguous 未逐对人工分档、08-30 清单 P0-3 疑似已闭未判。接不接共享门禁属动严度 ⇒ 不代断 | 已证实(实测 V353)：判据自测 15/15；分母 185/12/6/12 现算；`str.count` 六个头条符号在基线 0 命中 | C |
| `LGAP-01` | P2（门禁可信度·覆盖账本三处失明） | ①差集尺的「审阅写在旧内容上」档比的是**同一行内**两个字段、从不与磁盘内容比 ⇒ 真语料恒 0，而严格校验面与自述面差 46；②105 处申报区间形状非法（结构上不可核）；③150 个活跃文件未入账（`AUDLEDGER-01` 同族，139→140→150）。它的 11 条自测全绿与"看不见"同时成立——注入臂用的是合成行 | 已证实(实测 V353)：`stats` 与 python 独立复算同为 2,880/666；自述面 712 ⇒ 差 46；`invalid_review_ranges` 105；未入账 150 | C |
| `PREM-01` | P2（数据面口径·A3/A5 的更正） | ①`resource_type` 是**四张表共用列名、两套词表**：契约注册表六值（`person/device/station/tool/material/vehicle`）与 `ewoh_resource_binding` 现值（`bom_item/fixture`）不同源 ⇒ 直接加 CHECK 今天在 binding 打死 5 行；②`ewoh_handoffs`／`ewoh_git_sync_state`／`ewoh_evidence_metadata` 三表同缺 `org_id` 列且无 policy ⇒ "全租户可读"要改档为"写侧从不落租户 + 该表被两道门禁口径同时排除"；③`roadmap` A4 那三个字段名在任何 DDL/代码/契约里零命中，真丢的是 `is_rule`/`inference_ms`/`data_quality`/`level`/`ood_indicator` | 已证实(实测 V353)：探针双臂读数＋注入式正向对照开火；`DDL 004:44-58` 与 `pipeline.py:470-492`／`storage.py:689` 逐行读；未证实＝真现网库行数（只有本地基线库证据） | A（三条都要拍口径） |
| `CSTR-01` | P1（产品语义·硬约束词表有三处互不同源的消费面，追踪面按注册表谎报） | 注册表自称"启发式求解器真实执行的硬约束集合"共 19 类，但实际消费分三面且都不闭合：编译层只 6 类、生产 heuristic 的本地 switch 只 9 类、CP-SAT 侧只 6 类；其中 `PERSON_AVAILABLE`/`DEVICE_AVAILABLE`/`RESOURCE_TIME_WINDOW`/`NO_DOUBLE_BOOKING`/`STATION_CAPABILITY` 五类除词表与注册表自身外**全仓零消费者**（那五个维度确有另一根轴的实现＝按资源数据在候选层过滤，但**约束实例携带的参数无人读**）。跨进程那一面更硬：请求侧确实把 `constraints` 连同每条的 `supported` 标记发出并注释"不支持的约束显式标记，不静默忽略"，而 Worker 侧 `SolverRequest` 无该字段、`from_dict` 只按声明键取数 ⇒ 整个数组无声消失、`supported` 是死载荷（同函数对**项内**未知键会 TypeError→400→熔断，只漏顶层，故非整体宽容）。后果：决策追踪恒报 19 类＝注册表全量，与本次实际消费面无关；`checkConstraintSupported` 只看是否在注册表 ⇒ 那五类永远判"支持"，不进 `unsupported_constraint` violation ⇒ 从写入到追踪全程无人报 | 已证实(源码·本人复核 V353)：`shared/scheduler.ts:465-466`、`cp-sat-scheduling-solver.ts:803-808`/`:600-633` default break、`contract.py:136-159`＋`from_dict:161-192`、`constraints.ts:16-59`（19/13 与注释原话）、`constraint-compiler.ts:167/181/194/202/215/226`、`heuristic-scheduling-solver.ts:337-344`（不支持才记 violation）/`:344-391`（10 case＋switch 外的 MANUAL_BOOST）/`:1513` `traceExt.hardConstraints=[…注册表]`；零消费者由全仓枚举取得（排除测试与产物目录，分母自报）。**未证实**：约束写入路径是否按注册表校验类型 ⇒ 客户端能否真提交这五类未读，已定位的注册表读侧两处只判 hard 标记不校验取值域 | A（词表要么接上消费者、要么删声明，属产品拍） |
| `PACK-01` | P1（发布物·明文口令进发布包＋打包工序自我嵌套） | 两条独立泄漏路径都在 `package-release.sh`：`:44` 用 `rsync -a scripts/` **整目录**搬走 ⇒ 被 gitignore 的运维脚本（含明文口令）直接进包；`:56` 把 `output/` 搬进 `${OUT}`，而 `${OUT}` 本身就在 `output/release-bundles/` 下（`:7`）且 `:14` 刚 `rm -rf "$OUT"` ⇒ rsync 边走边读，把半成品树复制进自己的 `output/` 子树，**恰好嵌套 1 层**（内层 4,390 文件 vs 外层 8,776，内层缺收尾件；`SHA256SUMS.txt:6041` 与 `:7430` 两处哈希相同 `0cfd321b…` ⇒ 逐字节同源；139M 包里 70M 是自拷贝）。`:69` 的守卫只查 `.env`，认不得私钥头与该脚本名 | 已证实(实测 V353，本人复算)：口令面 tracked `git grep -F` 于 HEAD **0 文件 0 行**、历史面 `-S` **0 commit**（581 commits／8 refs）＋64 个不可达 blob 逐个 **0 命中** ⇒ 无历史可改写；工作树 6 个命中文件**全部 git-ignored**＝源 1＋包内副本 2＋本地记忆 3 文件 4 行。**roadmap A2 的"扩散面 6 处"若指入库面则不成立**（第一遍我用 BRE 匹配，口令里的 `*` 被当量词 ⇒ 产物面/记忆面假 0，改 `-F` 才是上述读数）。未证实＝真 ECS 主机侧状态（属主线下） | A（改白名单动发布完整性契约，属主拍；口令轮换属线下） |

## 四、成对计数增量（一次改完，别逐处字面替换）

以状态件数组长度为真值源，本轮元组（**6 行新开、0 闭合**）：
`fixed 92 不变｜open 101→107｜§5.4 185→191 行｜闭 85 不变｜开 100→106｜链级 spec/passed 一字不动（本轮零常驻用例，但 passed 读数按第 5 遍背书链复引）｜门禁 27 条主线不动（未接）｜单测 418/3696 不动（本轮零单元用例）｜执行面分母 55→57（两件新量具，收尾现抽复算，不抄此数）`
归属桶加总必须 = 106：`A 60→63、B 3、C 20→22、D 6、E 11→12`（PREM-01/CSTR-01/PACK-01→A，RECON-01/LGAP-01→C，ARUN-01→E）。
必须同批改的站点：状态件 `findings.open`（6 条新条目，正文以编号开头）、`fixed_count_note` **首条就地改**（N/M/R 三项＋那句"§5.4 登记表 R 行"）、
`current_status` **整段 prepend**（第一段必须带 `pilot_through_V353…`／`_fixed_`／`_open_`／`chain_specs_33_139_`／`gates_27_mainlines_` 四组 token，散文段只能放第二段之后）、`verification_state` 新键、
`decision_log` 追加、`next_entrypoint` 第一项＝「把 ARUN-01 的裸别名自检做成可 require 的常驻控制；CSTR-01 那五类词表要么接消费者要么删声明」。
《基线》：新增 §5.3 空号小节（插在 `### 5.4` 之前，取号现算不抄）、§5.4 加 6 行、§六「链级缺陷修复数」格＝已闭＋复算轮次、§七 末行 V353、速览 prepend（四格逐个与产物对账）；
裁决包：`§5.4 R 行（C 闭 / O 开）`、`findings N fixed / M open` 括号链前置本轮段。
本轮 mint 与背书读数的引用口径：**只引第 5 遍（复位后那一遍）的汇总行**；第 4 遍 rc=2 的降级读数按 ENV-02 复发记进 §七 文字，不进 §六/速览的 passed 格。

## 五、§1/§2 里标 `走读定位(待复核)` 的条目，提升为登记行前必须逐条回读

`heuristic:1212-1245` 内联路径未透传可用窗、`bookedStationCounts` 无人读、`:666-668` 事件无任务 scope、
`work-orchestration` 6 对 Durable/legacy、`controller.ts:16` 守卫在位——**五支**。
本轮我只复核了：约束 switch 形状、`LOCKED_ASSIGNMENT` 分支、`ws:761/644/671`、`plan:1386-1389/898-912/956-973`、
`control:1057-1065/2268-2282`、`storage:689` 与 `pipeline:470-492`、DDL `004`、`ledger-gap:36-37`、`stats` 双源同数。

## 六、批次执行记录（本轮已落台账，这段是"第一轮判红→定源→改对"的取证）

执行序：`EWOH_DRY=1` 排练（红两轮：ANSI 色码使 C 段一条都匹配不到；全文 `@@` 断言过宽——《基线》本有 5 处合法 `@@`，断言应只落本轮载荷）→ mint（rc=0，1557 文件，HEAD `ae4c3a98`）→ 落盘 → `chain-baseline-consistency`。

第一轮判红 9 项，逐条定源（**原告都是尺子，不是文档写错**的有 2 项）：

| 判红 | 定源 | 修法 |
|---|---|---|
| 6 条开放行"在 §5.4 没有行"＋行数/开放数三处抄件仍判 185/100 | **量具选错形状**：`artifact-consistency.cjs:50` 的 `ROW_RE` 只吃 `^\|\s*(?:~~)?\*{0,2}ID` —— **反引号不在文法里**。我把行首写成 `` | `ARUN-01` | `` ⇒ 行在磁盘上、在尺子眼里隐形，六个编号一起"没有行" | 六行行首改裸编号（既有 185 行本来就是裸编号，反引号只出现在正文引用里） |
| "指向不存在小节的引用：0, 1.9" | §5.3na 用 `§0`／`§1.9` 指**别册**（reading-log）的小节，尺子按本文小节表判 | 改成"第 0 节／第 1.9 节"字样，`§` 只留给本文 |
| "文档点名但仓库找不到：main.js" | ARUN-01 行写裸文件名 `` `main.js` ``，既有行文用的是全路径 `dist/server/main.js` | 补全路径 |
| §六「后端单测 3696/3696 vs 实测 3731/3731」 | **本轮自己的漏项**：§6.1 那格另有一处"当期读数"抄件，我只改了 §六 修复数格里的那一处单测数 | 更新为 V353 归档 `unit-20261004-095853.log` 的 421/3731 并写明增量成因 |
| §6.2 桶表未列 6 项、加总 100≠106 | **本轮自己的漏项**：A/C/E 三行的数量列＋条目列＋§6.2 顶部叙事行是第三处抄件 | 三行分别 60→63／20→22／11→12 并把编号追加进条目列；加总由脚本现算＝106 才落盘 |

复跑 `chain-baseline-consistency` ⇒ **✅ 无漂移 rc=0**。

一处**数字移动但不归本轮**：全量后端单测 418/3696 → **421/3731**（+3 套件／+35 例）。**按提交日期归因是错的**（`cc58772f` 的 commit 时间晚于 V352 归档，但它那 17 份 spec 早在归档里就存在）。改用两棵树逐文件比：`git ls-tree` 的 `test/unit` 面 149→150，两遍归档的逐套件 PASS 行差集只多 `test/unit/scheduler/active-plan-strategy-scope.spec.ts`（提交 `0922b695`）；全仓 `*.spec.ts` 464→474（`7d0754a4` 等并发提交）。⇒ 已核到的只有 +1 份 spec，余 +2 套件／+35 例 **未定位**（没逐档比对 runner 语料集），台账四处都按"未定位"写而不写成已归因。本轮零用例改动——已在 §六、§6.1、§七、速览、`fixed_count_note` 五处同批改写并写明归因，不写成"本轮涨了 35 例"。
