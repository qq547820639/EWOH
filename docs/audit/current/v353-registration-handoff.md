# V353 登记单（本轮未写台账的交接件）

> 为什么单开这份：本轮**改到了重放覆盖集内的文件**（`Makefile` ＋ 两把新量具），而带服务重放在本机起不来（见下），
> 因此按试点纪律**不能 mint、也不能引任何 passed 读数记账**。台账（《基线》§5.4／§六／§七／速览、状态件、裁决包）
> 本轮**一字未动**——成对计数站点共十余处，必须一次改完，半改必红。这份是"下一轮照抄即可"的登记单。

## 一、本轮已落地（都已进 git，不在台账里）

| 产物 | 状态 |
|---|---|
| `scripts/chain-baseline/refactor-backlog-reconcile.cjs` | 判据自测 15/15；四源分母现算 185/12/6/12；跨源判重两轴门槛；引用落点 AST 判 |
| `scripts/chain-baseline/backlog-premise-probe.cjs` | 判据自测 16/16；租户面九档互斥；注入式正向对照开火（A=2/B=1/他org=0/残留 0） |
| `Makefile` | 新增两个复算入口目标（分母现抽 ⇒ 执行面读数从 56 变 57，两件都落「无人跑」桶，未接共享门禁） |
| `docs/reading-log.md` | §0 口径与分母定案；§1 调度域；§2 控制域；§3 欠账 |
| `docs/refactoring/unified-backlog-2026-10-04.md` | 四源对账主表 |

## 二、阻断项（本轮实测，须登记为开放行）

- C 段被测后端**起不来**：`tmp/chain-baseline/build.log` 显示构建成功，但 `dist/server/**` 里 **18 个文件保留裸别名**
  `require("@server/...")`（另 89 个文件已重写成相对路径），`main.js`/`standalone-main.ts` 里没有任何
  `-r tsconfig-paths/register` 或别名引导，仓内也没有 `@server` 的 node_modules 垫片 ⇒
  `node dist/server/main.js` 在 `app.module → dashboard.module → dashboard.service:13` 处 `MODULE_NOT_FOUND`，
  `/health/ready` 30s 内不就绪，`verify.sh` 按设计退 **3＝不可用**（不是链跑红）。
- 本轮为把重放跑完，在**仓外可回滚位**加了垫片：`ewoh-spark-app/node_modules/@server -> ../dist/server`
  （`node_modules` 被 `.gitignore:59` 忽略、不在重放覆盖集内、下次 `pnpm install` 会消失）。
  **撤销**：`rm ewoh-spark-app/node_modules/@server`。这条垫片只是"让背书能跑"，不是修法——
  真修是把那 18 个文件的别名重写补上或给启动加别名注册，二者都改构建/启动面，须属主拍。
- 历史疑点（未解）：V352 的速览自称"带服务全量重放 D 与 D2 各 139 passed、复铸 rc=0"，
  说明当时后端能起。我没找出当时与现在的差别在哪（未读 stamp 与 dist 的历史），
  因此**不得**把这条写成"回归"，只能写成"当前树实测不可用，历史能用的成因未定位"。

## 三、待登记的 4 条开放行（行文本已按红线写好：不出现 `make <目标>` 形状、条目正文不写 `scripts/` 全路径）

| 编号 | 优先级 | 内容（§5.4 第 3 格） | 证据（§5.4 第 4 格） | 归属桶 |
|---|---|---|---|---|
| `ARUN-01` | P1（工具链·带服务重放不可用） | 内容见 §二第 1 条；要裁的是两条修法择一：①补齐构建的别名重写覆盖那 18 个文件；②给被测入口注册运行时别名解析。两者都改构建/启动面，不改产品行为，但会让所有跑重放的人的结果形状变化 ⇒ 不代断 | 已证实(实测 V353)：`verify.sh` C 段退 3；`server.log` 的 `MODULE_NOT_FOUND` requireStack 五项；`grep -rl` 计数 18 裸别名 vs 89 相对；垫片注入后解析到 `dist/server/database/schema.js` 反证成因 | E（本轮无可指位点，且判据未接主线） |
| `RECON-01` | P2（台账面·四源清单互不引用已由量具接管） | 四源分母与 7 对跨源重复进表；**欠覆盖四项如实登记**：roadmap 的 C 级在表格里未进判重、提示词阶段表未按项拆、241 对 ambiguous 未逐对人工分档、08-30 清单 P0-3 疑似已闭未判。接不接共享门禁属动严度 ⇒ 不代断 | 已证实(实测 V353)：判据自测 15/15；分母 185/12/6/12 现算；`str.count` 六个头条符号在基线 0 命中 | C |
| `LGAP-01` | P2（门禁可信度·覆盖账本三处失明） | ①差集尺的「审阅写在旧内容上」档比的是**同一行内**两个字段、从不与磁盘内容比 ⇒ 真语料恒 0，而严格校验面与自述面差 46；②105 处申报区间形状非法（结构上不可核）；③150 个活跃文件未入账（`AUDLEDGER-01` 同族，139→140→150）。它的 11 条自测全绿与"看不见"同时成立——注入臂用的是合成行 | 已证实(实测 V353)：`stats` 与 python 独立复算同为 2,880/666；自述面 712 ⇒ 差 46；`invalid_review_ranges` 105；未入账 150 | C |
| `PREM-01` | P2（数据面口径·A3/A5 的更正） | ①`resource_type` 是**四张表共用列名、两套词表**：契约注册表六值（`person/device/station/tool/material/vehicle`）与 `ewoh_resource_binding` 现值（`bom_item/fixture`）不同源 ⇒ 直接加 CHECK 今天在 binding 打死 5 行；②`ewoh_handoffs`／`ewoh_git_sync_state`／`ewoh_evidence_metadata` 三表同缺 `org_id` 列且无 policy ⇒ "全租户可读"要改档为"写侧从不落租户 + 该表被两道门禁口径同时排除"；③`roadmap` A4 那三个字段名在任何 DDL/代码/契约里零命中，真丢的是 `is_rule`/`inference_ms`/`data_quality`/`level`/`ood_indicator` | 已证实(实测 V353)：探针双臂读数＋注入式正向对照开火；`DDL 004:44-58` 与 `pipeline.py:470-492`／`storage.py:689` 逐行读；未证实＝真现网库行数（只有本地基线库证据） | A（三条都要拍口径） |

## 四、成对计数增量（一次改完，别逐处字面替换）

以状态件数组长度为真值源，本轮元组应为：
`fixed 92 不变｜open 101→105｜§5.4 185→189 行｜闭 85 不变｜开 100→104｜链级 spec/passed 一字不动（本轮零常驻用例）｜门禁 27 条主线不动（未接）｜单测 418/3696 不动（本轮零单元用例）`
归属桶加总必须 = 104：`A 60→61、C 20→22、E 11→12、B 3、D 6`（ARUN-01→E、RECON-01→C、LGAP-01→C、PREM-01→A）。
必须同批改的站点：状态件 `findings.open`（4 条新条目，正文含编号）、`fixed_count_note` **首条就地改**、
`current_status` **整段 prepend**（第一段必须带四组 token，散文段只能放第二段之后）、`verification_state` 新键、
`decision_log` 追加、`next_entrypoint` 第一项＝「mint 前置：修 ARUN-01 或续用垫片跑完带服务全量重放」；
《基线》：新增 §5.3 空号小节（插在 `### 5.4` 之前）、§5.4 加 4 行、§六「N 项已闭」格、§七 末行 V353、速览 prepend；
裁决包：`§5.4 R 行（C 闭 / O 开）`、`findings N fixed / M open` 括号链前置本轮段。
并须在本轮速览与 §七 行明写：**「本轮判据改动在覆盖集内、未 mint ⇒ `chain-baseline-freshness` 判红属正确语义，不是回归」**。

## 五、§1/§2 里标 `走读定位(待复核)` 的条目，提升为登记行前必须逐条回读

`heuristic:1212-1245` 内联路径未透传可用窗、`bookedStationCounts` 无人读、`:666-668` 事件无任务 scope、
`work-orchestration` 6 对 Durable/legacy、`controller.ts:16` 守卫在位——**五支**。
本轮我只复核了：约束 switch 形状、`LOCKED_ASSIGNMENT` 分支、`ws:761/644/671`、`plan:1386-1389/898-912/956-973`、
`control:1057-1065/2268-2282`、`storage:689` 与 `pipeline:470-492`、DDL `004`、`ledger-gap:36-37`、`stats` 双源同数。
