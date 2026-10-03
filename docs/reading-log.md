# 精读日志（reading log）

> 本文件是 `docs/long-cycle-implementation-prompt.md` 第六部分要求的交付件：每阶段完成后按
> 「职责／入口／数据流／异常分支／未解疑点」五要素入档。文中所有数字一律标「本轮现算」并附取数命令，
> 不抄任何历史快照。轮次：V353（2026-10-04）。

---

## §0 审阅口径与分母定案

### 0.1 `reviewed=true` 的机器定义（读 `scripts/audit-file-ledger.js` 原文，非推测）

| 失效原因 | 判据（读到的实际比较式） | 位置 |
|---|---|---|
| `not_reviewed` | `row?.reviewed !== true` | `scripts/audit-file-ledger.js:288` |
| `missing_review_hash` / `stale_review_hash` | `reviewed_sha256` 必须是 64 位 hex，且必须等于**当前内容** sha | `:289-290` |
| `stale_inventory_hash` | 账本里的 `content_sha256` 必须等于当前内容 sha | `:291` |
| `stale_line_count` | 账本里的 `line_count` 必须等于当前行数 | `:292` |
| `invalid_review_ranges` | 区间必须是 `[start,end]` 整数对、`1≤start≤end≤line_count` | `:293` + `validateRanges` `:262-282` |
| `incomplete_review_ranges` | 区间并集覆盖行数 `covered` 必须**恰好等于** `line_count` | `:294` + `:281` |
| `new_file_missing_from_ledger` | 现扫到但账本无该行 | `:287` |

**口径结论**：这里的「逐行读完」不是主观描述，而是「当前内容 sha 一致 ＋ 申报的审阅行区间并集覆盖文件每一行」。
`cmdGenerate` 每次都会用 `validateReview(old, base).verified` 重算 `reviewed`（`:367`），
所以**产品代码一改，旧的「已读完」标记就机械失效**——这是设计而非事故。
`merge` 侧同样硬拒：`reviewed=true` 但区间不全覆盖 ⇒ 抛错（`:414-416`）。

### 0.2 2026-08-18 → 09-21 的 `reviewed` 骤降：定案为**过期＋扩面，不是撤回**

一手读数（逐份 `git show` 后按 JSON 解析，非文本匹配）：

| 提交 | 日期 | 账本条目 | `reviewed` | 已读行数 |
|---|---|---|---|---|
| `0c0bf0c2` | 2026-08-18 | 2,095 | 2,095 | 399,261 |
| `ff361548` | 2026-09-21 | 2,722 | 597 | 113,250 |
| `c4133284` | 2026-09-21 | 2,722 | 629 | 124,976 |
| `7d0754a4` | 2026-09-29 | 2,730 | 712 | 145,758 |

三条独立证据支持「过期＋扩面」：
1. `docs/audit/current/final-assessment.md:11` 自述当时是「2095 个、399,261 行、reviewed=true 2095/2095、active_unread_files=0」——那是**当时内容**下的真读数，不是虚报；
2. 工具在 `generate` 时按 0.1 判据把内容变过的标记机械判回 false（`audit-file-ledger.js:367`、`:284-296`）；
3. 分母同期从 2,095 扩到 2,722→2,730→**本轮现扫 2,880**（新增文件先不入账，见 0.3 的 150 处）。

**推论（也是本文件给后续所有轮次的纪律）**：任何「全仓已逐行读完」的历史读数都不可继承；
今天的读数必须由 0.3 的命令现取。

### 0.3 当期分母（两个独立来源同数 ⇒ 可入门禁）

来源一：工具自身（只读子命令，`report` 会写 `coverage-report.md` 故未用）
```
$ node scripts/audit-file-ledger.js stats
total=2880 reviewed=666 unreviewed=2214 missing=0        # rc=0
```

来源二：本轮独立复算（python 逐文件重算 sha256 与行区间并集，**不复用工具代码**）
```
active=2880 verified=666 unverified=2214
total_lines=612315 verified_lines=119328 未过校验行数=492987
```
两来源一致 ⇒ 「活跃工程文件 2,880 个 / 612,315 行，其中经严格口径确认逐行读完 **666 个 / 119,328 行**」为当期真值。

其余三面（各自口径不同，不得混用）：

| 口径 | 分子 | 分母 | 说明 |
|---|---|---|---|
| 账本自述面（不做内容校验） | `reviewed=true` 712 | 条目 2,730 | 其中 **46 处已过期**（0.4 的 sha/行数不符者） |
| 账本记录行数面 | 未读 417,380 | 未读 2,018 | 账本里的 `line_count` 本身有 112 处过期（0.5） |
| 磁盘面 | 未读 420,953 | 未读 2,018 | 按磁盘重算行数 |
| **严格校验面（权威）** | 未过校验 2,214 | 活跃 2,880 / 492,987 行 | 0.1 的机器口径 |

**未入账读数**：`new_file_missing_from_ledger = 150` —— 现扫 2,880 与账本 2,730 之差。
这与登记册已开放的 `AUDLEDGER-01` 同族（V346 记 139、V348 记 140、本轮 **150**，仍在涨，仍开放）。

### 0.4 失效原因分布（本轮现算；一文件可同时命中多因，故 Σ > 文件数，不可当分母用）

`not_reviewed 2018` · `missing_review_hash 2011` · `incomplete_review_ranges 1048` ·
`stale_inventory_hash 119` · `stale_line_count 112` · `invalid_review_ranges 105` ·
`new_file_missing_from_ledger 150` · `stale_review_hash 53`

新读数一条：`invalid_review_ranges = 105` —— 这 105 个文件申报的审阅区间**形状本身非法**
（端点越界／非整数），即其「读完」主张在当前口径下结构上不可核验。此前各轮速览未见此读数被单独报过。

### 0.5 账本↔磁盘 `line_count` 漂移（112 处，节选）

| 文件 | 账本 | 磁盘 |
|---|---|---|
| `ewoh-spark-app/server/modules/control/control.service.ts` | 2,853 | **3,273** |
| `contracts/state-machines/alert.yaml` | 18 | 223 |
| `contracts/state-machines/plan.yaml` | 20 | 187 |
| `Makefile` | 255 | 536 |
| `scripts/audit-state-machine-roles.js` | 199 | 542 |
| `scripts/audit-scheduler-transactions.js` | 161 | 427 |
| `ewoh-spark-app/test/e2e/pg-temporary-failure.e2e.spec.ts` | 252 | 1,282 |
| `ewoh-spark-app/server/modules/scheduler/replan-coordinator.service.ts` | 1,178 | 1,394 |

⇒ 凡引用 `control.service.ts` 行数者，**3,273 是磁盘值、2,853 是账本过期值**；
`ewoh-spark-app/docs/refactoring-roadmap.md` 用的 3,273 与磁盘一致，无需更正。

### 0.6 对本轮更早一次对外读数的自我修正（诚信条款）

同一日更早一轮，我用「账本自述面」报过「未读 2,018 文件 / 417,380 行（磁盘 420,953）」并据此估过耗时。
按 0.1 的机器口径重算，**未过校验的逐行覆盖应为 2,214 文件 / 492,987 行**；
早前读数只在「不校验 sha 与行区间」这一面成立。据此，全仓逐字覆盖的工作量比早前的估算
多约 **18%（行数）/ 10%（文件数）**，档位结论不变、数字作废重取。

### 0.7 选型复核补齐（上一轮标「未本轮核验」的那一格）

`ewoh-spark-app/node_modules/typescript/LICENSE.txt` 前 3 行原文：`Apache License` / `Version 2.0, January 2004`
⇒ 树内 `typescript@5.9.2`（实测 `require('./ewoh-spark-app/node_modules/typescript/package.json').version`）
许可证为 Apache-2.0，与「不新增依赖、复用树内编译器 API」的决策相容。

### 0.8 对账来源增至四个

除 `ewoh-spark-app/docs/refactoring-roadmap.md`（21 项）、`docs/long-cycle-implementation-prompt.md`（阶段 0-5／Q1-Q7）、
《链级行为基线》§5.4（当期 185 行＝85 闭／100 开）之外，本轮发现**第四份清单**：
`docs/refactoring/refactoring-backlog-2026-08-30.md`（91 行，P0-1~P1-6 等）。
其中 P0-3「时间格式统一（12+ 文件）」疑似已在后续轮次完成（提交 `48adfeba`、`f570b902` 均为
`refactor(client): 时间…对齐 intl 共享常量`）——**此处只登记线索，判定交给 §1 的量具与判重，不在本文下结论**。

### 0.9 未解疑点（本轮未确认）

1. 105 处 `invalid_review_ranges` 是记账格式演进的遗留还是写入方 bug——未读第二遍审计的输入件生产者，**未定案**。
2. 46 处「账本仍写 `reviewed=true` 但内容已变」为何没被 `generate` 刷掉——推测是 09-29 之后未再跑 `generate`，
   属**推测，未核实**（无命令读数支持）。
3. 150 处未入账文件的域分布未读——§1 量具会按域输出，再定。

---

*§1（调度域精读）与 §2（控制域精读）由后台精读代理回传后经主理人逐条重读原文再入档；未入档前不得引用。*
