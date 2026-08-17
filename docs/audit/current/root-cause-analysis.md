# Root Cause Analysis — 二轮审计根因聚类与系统性观察

> 生成时间：2026-08-18
> 数据来源：`findings.jsonl`（325 条；其中 185 条含非空 `root_cause` 字段，其余 140 条以 `problem`/`description` 字段兜底聚类——方法透明声明，脚本可复现）。
> 状态底数：FIXED 189 / DISPOSITIONED 136；按严重度 P0 1（已修）/ P1 33（已修）/ P2 108（104 修 + 4 裁决）/ P3 183（51 修 + 132 裁决）。
> 聚类方法：对每条发现的根因文本按"缺陷直接表现"做首要归类（关键词优先级：租户→schema/契约→幂等/CAS→注入/鉴权→测试卫生→fail-open→ID→性能→扩散遗留），存在交叉的以首要语义归入单一类，不重复计数。

---

## 1. 根因聚类 Top 模式（325 条首要归类）

| # | 根因模式 | 条数 | 占比 | 代表性 ID |
|---|----------|------|------|-----------|
| 1 | **租户/org 谓词或归属缺失**（读面无 orgCondition、写面不注入 orgId、全局唯一键覆盖跨租户、幂等/凭证层无 org 维度） | 75 | 23% | R2-SSV-01（策略版本激活可改写他租户行归属）、R2-SNZ-011（personnel 全端点零谓词）、R2-SAM-002（mobile 透传缺失+mes fail-open）、R2-SDB-006（幂等表 GLOBAL）、R2-SOP-003（entityId 全局唯一） |
| 2 | **schema↔迁移/契约双口径漂移**（手维护 schema.ts 与迁移不同步、契约 const 与实例矛盾、状态集/注册表多处手写、端点与 spec 漂移） | 58 | 17% | R2-SDB-001/002/003（schema.ts 漂移三连）、R2-CNT-001（versionMonotonicity 双口径）、R2-ESC-002（confirm 白名单与转移表两处演化）、R2-SCH-011（锁定状态集三方漂移）、R2-DBM-002（迁移未接 runner） |
| 3 | **check-then-act / 幂等 TOCTOU / CAS 缺失 / 事务边界**（读-判-写、无 RETURNING 校验、多写路径半状态） | 52 | 16% | R2-SDB-005（幂等读-判-写）、R2-SSV-10/11（policy/conflict 无 CAS）、R2-SSV-03（shadow plan 两步分离）、R2-SAM-005（session terminate 无 CAS）、R2-SCH-014（replan 双事务半状态） |
| 4 | **注入/XSS/SSRF/鉴权越权**（标识符拼接、innerHTML、重定向 SSRF、CRLF、身份断言、自批审批） | 32 | 9% | R2-SCR-005（备份 manifest SQL 注入）、R2-EDM-02（SSRF）、R2-EDM-03（XSS）、R2-SNZ-006（邮件头注入）、R2-ECO-001（body.endedBy 身份断言）、R2-SMI-003（审批图信任客户端） |
| 5 | **测试恒真/弱断言/测试卫生**（every(()=>true)、500=PASS、fake 忽略 WHERE、角色 403 冒充租户、断言错误行为） | 31 | 9% | R2-APT-001/002（golden-path-verify 恒真）、R2-APT-006（viewer 403 冒充隔离）、R2-APT-007（browser chain 恒真）、R2-SPT-003（fake-db 忽略 where）、R2-SCH-017 注（既有测试断言错误行为 risk>0→'high'） |
| 6 | **ID/随机性/哈希**（Date.now+Math.random、djb2 32-bit、跨语言 ID 不可对账） | 22 | 6% | R2-SSV-06（conflictId djb2 双事实源）、R2-SSV-20（ID 簇非密码学）、R2-SHR-001（conclusionId 跨语言不可对账）、R2-CC1-6（Math.random 身份） |
| 7 | **fail-open / 静默失败 / 伪造兜底**（异常吞掉无日志、缺省放行、(0,0) 伪造位置、空壳兜底） | 13 | 4% | R2-ESC-004（坏时间戳伪造归属）、R2-ESC-003（缺坐标用 (0,0) 伪造）、R2-ESC-006（吞异常无留痕）、R2-SOP-001（org 缺失写 'default' 共享 org）、R2-ESC-020（空快照空壳方案） |
| 8 | **纯扩散遗留**（无具体面，仅"修复未扩散"叙事） | 11 | 3% | R2-EDM-01（EDGE-207 引入回归）、R2-CNT-002（reopen 未同步 terminal）、R2-INF-003（双源清单漏更） |
| 9 | **性能/复杂度/扫描面**（O(V²)、全表扫、无 limit、嵌套线性查找） | 5 | 1% | R2-SCH-005（MILP O(V²)+无时限）、R2-SCH-012（A* 线性扫描）、R2-SNZ-014（replay 无界）、R2-SSV-23（decision-history 全量内存分页） |
| — | 未归入上述模式的零散项（UI 交互卫生、文档口径、环境配置类，多为 P3 DISPOSITIONED） | 26 | 8% | R2-CC1-5、R2-CP2-008、R2-INF-006、R2-TOL-001 等 |

> 注：占比分母为 325 全量；模式间存在真实交叉（见 §2 模式⑥），首要归类不重复计数，故各行合计=325。

---

## 2. 系统性观察（跨切面模式）

### 模式①：既有修复未横向扩散（跨切面最大公约数）

**56 条**发现的根因文本明确指向"旧修复（NEST-xxx/EDGE-xxx/CLI-xxx/SCR-xxx 等）只覆盖发现列举点，同型位点遗漏"（root_cause/problem 同时命中旧修复 ID + 扩散词的脚本统计）。域分布 Top：server-ops 9、client-pages-2 6、scripts 6、server-am 5、server-biz 5、scheduler-core 4。

代表：R2-SAM-001（"NEST-407 修复只覆盖 list 面，写转移面 ack 遗漏 org 谓词"）、R2-SAM-003（"NEST-205 只修复 ewohDevice，ewohSpatialEntity 同型未跟进"）、R2-SOP-022（"NEST-204 修复未覆盖 environment（原发现仅列举 camera/spatial/location）"）、R2-SBZ-005（"NEST-309 修复范围不完整"）。
**本轮修复方式**：同类合并修复（R2-SOP-003 与 R2-SAM-003 同源同修）+ 横向扫描核验（R2-CP2-003"全仓 grep toLocaleString 核验无遗漏"）+ 新增结构门禁防再发（§3）。

### 模式②：手工维护的 schema.ts 与迁移漂移

**7 条**直接命中（R2-SDB-001/002/003、R2-SOP-014、R2-DBM-002/003 + R2-SNZ-014 相关），全部 FIXED。root_cause 原话："『auto generated, do not edit』文件的手工增量维护遗漏"（R2-SDB-001）、"该文件多数段由平台 codegen 维护，手工调度段漏同步"（R2-SDB-002）、"新增迁移时只落了 SQL 文件，未按四步登记流程接入 runner"（R2-DBM-002）。
**修复方式**：逐表对账（15 表 orgId NOT NULL 全量核对）+ 058/059 runner 接入 + manifest 登记补全；空库链路执行验证 ENVIRONMENT_BLOCKED（见 `test-report.md`）。

### 模式③：check-then-act 幂等与 CAS 缺失

**52 条**（16%）。子形态：无状态谓词的 UPDATE（R2-SSV-11 conflict、R2-SAM-010 quality）、无 RETURNING 校验的 CAS（R2-SSV-05）、读-判-写幂等（R2-SDB-005）、多写半状态（R2-SSV-03 shadow plan、R2-SCH-014 replan 双事务、R2-SAM-008 七处事件非同事务）。
**修复方式**：占位式 exactly-once（INSERT pending onConflictDoNullthing + awaitSettled 轮询）、UPDATE...RETURNING 单语句状态机、事务归并（runInTransaction 嵌套复用）；R2-SAM-008 剩余四处经 SYSTEMIC_REFACTOR_RULING 裁决不批量改写（事件消费方幂等回读兜底）。

### 模式④：测试恒真断言与"断言错误行为"

**31 条**（9%）+ 若干既有测试因错误行为被更新（R2-SCH-017 notes："唯一因断言错误行为而更新的既有测试"——原用例断言 risk>0→'high' 折叠行为即发现认定的错误行为）。子形态：every((a)=>true)（R2-APT-001）、500=PASS（R2-APT-002）、角色 403 冒充租户隔离（R2-APT-006）、fake 忽略 WHERE（R2-SPT-001/002/011 一族，TEST_HYGIENE_ACCEPTED 裁决 7 项）。
**修复方式**：真实断言改写（assignments 非空+契约字段、409/404 仅带合法业务原因通过）、fake-db where 谓词语义实现（R2-SPT-003，104 套件 818 用例含零漂移门禁）、伪隔离用例改同角色跨 org。

### 模式⑤：租户谓词作为第一大缺陷面

**75 条**（23%）——接近四分之一。分布横跨 9+ 域（scheduler-svc/ops/am/biz/nz/db/misc + edge），说明多租户改造（GUC/RLS 域）后的长尾扩散是本轮最大缺陷源。修复统一收敛为 orgCondition/requireOrgId 双辅助模式 + 复合唯一迁移（059/060）+ 每修复点负例用例（详见 `tenant-isolation-report.md`）。

### 模式⑥：双事实源/双口径

**58 条**（17%）的底层共性是同一语义存在 ≥2 份手写事实源：const 文本 vs 实例数据（R2-CNT-001）、转移表 vs 白名单（R2-ESC-002）、三个手写状态集（R2-SCH-011）、djb2 vs SHA-256（R2-SSV-06）、TS vs Python 字段校验（R2-SHR 系 11 条）。修复范式分三类：**单一事实源收敛**（TaskLifecycle.TASK_LOCKED_STATUSES、conflictSeedHash 唯一实现）、**结构门禁**（world_state_const_vs_rules_self_consistent、state_machine_terminal_no_outgoing_edge 覆盖 7 个 yaml）、**跨语言仲裁**（audit-domain-contracts 584/584、audit-identity-contracts、audit-event-envelope 24/24）。

### 模式⑦：安全缺陷的集中形态

**32 条**（9%）中注入类（SQL/SSRF/XSS/CRLF）与鉴权类（身份断言、审批人客户端指定、roles 数组混用致 fail-open 死代码）各半；**5 项 P1 全部与"已认证即可写高敏事实/审批"相关**（与 arch-edge-agent 底稿共性根因判断一致："机器闸门完备，人审与角色强约束停留在 ANY_AUTHENTICATED_ROLES 粒度"）——本轮以 R2-SMI-001（P0 审批链）、R2-SMI-003（审批图服务端化）、R2-SBZ-003（learning @Roles）、R2-SAM-002（mobile 透传）收口（详见 `security-report.md`）。

---

## 3. 修复方式与根因的映射小结

| 根因模式 | 主修复范式 | 防再发机制 |
|---|---|---|
| 租户谓词缺失（75） | orgCondition/requireOrgId 统一模式 + 复合唯一迁移（059/060） | 每修复点跨租户负例用例；audit-org-predicates 静态扫描（主线 1） |
| schema/契约漂移（58） | 逐表对账 + 单一事实源收敛 | 2 个新结构门禁 + runner 四步登记 + openapi:no-drift |
| 幂等/CAS（52） | 占位式 exactly-once + RETURNING 单语句状态机 + 事务归并 | 既有 golden-workflow CAS 不变量 + r2-ssv-regression spec |
| 注入/鉴权（32） | 白名单/fixed-IP/esc()/timingSafeEqual/服务端审批图 | 主线 2/3/4 门禁（GET 鉴权矩阵/SSRF 面/XSS sink） |
| 测试卫生（31） | 真实断言 + fake where 语义 | golden 零漂移门禁；伪隔离清单禁止引用 |
| ID/随机性（22） | randomUUID 统一 + SHA-256 单实现 | 契约 spec 断言 |
| fail-open（13） | fail-closed 化（401/400/403/503 显式拒绝） | 状态机/守卫 spec |

**一句话总结**：本轮缺陷的根因分布呈"租户谓词（23%）+ 双口径漂移（17%）+ 幂等竞态（16%）"三足鼎立，三者合计过半且相互交织（56 条明确由旧修复扩散不足触发）；修复普遍采用"统一辅助模式/单一事实源 + 结构门禁 + 负例用例"三件套，而非逐点补丁——这也是本轮新增 2 个契约结构门禁、3 个迁移、1 个共享约束编译器的直接动因。
