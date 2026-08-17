# Final Assessment — 二轮全仓逐行审计 + 架构收敛 + 全量回归 终评

> 生成时间：2026-08-18
> 基线：HEAD `58b7819e`（main，2026-08-17，第一轮 950 项整改完成点）
> 本文回答本轮 Spec §39 的 20 个问题；全部结论引自本目录真实证据（findings.jsonl / fixlog / 各专项报告 / 本机复跑输出），无虚构数字。

---

## Q1 本轮审计覆盖了多少文件？覆盖是否完备？

`file-ledger.jsonl` 登记**活跃工程文件 2095 个、总计 399,261 行，reviewed=true 2095/2095**，active_unread_files=0、partial_review_files=0（`coverage-report.md`）。排除项（release/、delivery/、output/、node_modules、lock、二进制、codegen 产物、docs/、流程制品）均声明并核对了生产引用边界（见 Q17）。

## Q2 本轮新发现多少项？分级与终态分布？

`findings.jsonl` 共 **325 条**：P0 1 / P1 33 / P2 108 / P3 183。
终态：**FIXED 189（P0 1 + P1 33 + P2 104 + P3 51）、DISPOSITIONED 136（P2 4 + P3 132）**，无 OPEN 遗留（脚本统计，见 `root-cause-analysis.md` 头部口径）。

## Q3 P0/P1 是否全部关闭？关闭证据是什么？

是。P0 1/1（R2-SMI-001 高危物理指令审批链缺失，接入 ApprovalPersistenceService + control.service.spec 用例）；P1 33/33 FIXED（DBM-001 探针 org_id、SBZ-001/002/003 角色面、APT-006/007 攻击测试真实断言、ECO-001 身份断言、SNZ-006 邮件头注入、EDM-01 时间戳、ESC-001 CP-SAT 系数等），证据逐条登记于 `parts/fixlog-p1-closeout.jsonl` 及各域 fixlog 的 tests 字段。

## Q4 第一轮 950 项旧发现的回归验证结论？

`old-finding-regression.yaml` 逐项标记终态：Critical/High 全量逐项源码复验。本轮新发现的 325 条中，**56 条根因明确指向"旧修复未横向扩散"**（同型位点遗漏，如 NEST-407/205/204/309 修复只覆盖发现列举点）——这些即是旧整改的真实回归面，已同型合并修复并加结构门禁防再发（`root-cause-analysis.md` §2 模式①）。

## Q5 根因层面最重要的结论是什么？

三足鼎立：**租户/org 谓词缺失 75 条（23%）+ schema/契约双口径漂移 58 条（17%）+ check-then-act 幂等/CAS/事务边界 52 条（16%）**，合计过半且相互交织；其次为注入/鉴权 32（9%）、测试恒真 31（9%）、ID/随机性 22（6%）、fail-open 13（4%）。修复统一采用"单一事实源/辅助模式收敛 + 结构门禁 + 负例用例"三件套，而非逐点补丁（`root-cause-analysis.md`）。

## Q6 World Kernel 的权威源/投影终态？

**7 张事实表 authoritative + 三链路投影（project/projectForSnapshot/adapter）+ A3 唯一物化快照**的既定形态保留，未合并为单 Kernel（arch-world 升格建议属系统性重构，裁决不在本轮安全范围，`architecture-after.md` §1.1）。本轮收敛的是租户面 split-brain 8 处：投影维护/质量附着 org 过滤（R2-SSV-04）、适配器 ctx 透传（R2-SSV-22）、事件链/回放谓词与上界（R2-SNZ-001/014）、模拟器行归属（R2-SNZ-004）、spatial_entity 复合唯一（R2-SOP-003，059 迁移）、锁定状态集单一事实源（R2-SCH-011）。

## Q7 Decision Kernel 是否提升为独立域？

**维持 Scheduler 私有托管的既定裁决**（读面治理落地：R2-SSV-23 扫描上界 500；写入语义经 R2-SCH-014 事务归并进一步闭合；域提升迁移未执行）。九要素缺口（outcomeRef 8/8、policyVersion 7/8、evidence 2/8）如实保留（`architecture-after.md` §2）。

## Q8 Event Backbone 是否抽出共享骨干？

**未抽取，维持 Scheduler 垄断的既定裁决**（outbox→pg_notify→SSE；NOTIFY 仅 wake-up + 2s 轮询兜底的设计被底稿判定正确）。本轮落地骨干可靠性/租户修复 5 项：冷启动游标对齐（R2-SSV-21）、policy rollback 对称留痕（R2-SSV-24）、DataQualityAlert org fail-closed（R2-SOP-002）、执行回填 CAS+RETURNING（R2-SSV-05）、conflictId SHA-256 单实现（R2-SSV-06）（`architecture-after.md` §3）。

## Q9 Scheduler 四求解器 Hard Constraint 语义一致性结论？

Golden TCK 双运行时仲裁通过：**`make scheduler-golden` 6 passed（求解段 4 场景 + 工作流段不变量）+ `make contract-golden` 330 passed**。约束族覆盖技能/证书、人员可用、连续负荷、安全/维护/质量封锁（未知严重度 fail-closed）、设备能力、禁入区、重复预订；一致性机制为"TS heuristic 产解 + Python 标准库独立仲裁对同一世界状态各自判定"。CP-SAT worker 因 ortools 未部署默认 OFF（feature-status.yaml 如实登记）（`scheduler-conformance-report.md`）。

## Q10 架构不变量 INV-001~012 落地状态？

以测试/门禁/裁决三形态落地：本轮 P0（R2-SMI-001 审批链，INV-005）、Agent 旁路关闭（R2-SBZ-002）、租户行 NOT NULL/复合唯一（057/059/060，INV-004）、Derived 自称 authoritative 类双口径收敛（world_state_const_vs_rules 门禁）、过期快照禁派工（TASK_LOCKED_STATUSES 单源）等均有对应 FIXED 项与用例；`make audit-regression-gates` 十条主线门禁（本机复跑 ✅ 全绿）承载防回归。个别不变量的运行时 e2e 证据受环境限制（Q15）。

## Q11 数据库迁移链验证到什么程度？

静态全绿：runner 四步登记完备（058/059/060 接入 FILES/命令映射/verify）、`migration-fresh-install-check` 顺序校验通过、`node --check` SYNTAX_OK、schema.ts↔迁移逐表对账（15 表 orgId NOT NULL 15/15）。**真实空库 fresh/upgrade/rollback 执行为 ENVIRONMENT_BLOCKED（本机无 PostgreSQL）**，由 CI 与 db/verify 结构断言补偿（`test-report.md` §3）。

## Q12 租户隔离攻击矩阵的结论与残留缺口？

Org B/Viewer/GlobalAdmin/匿名 × 读写 12 攻击面矩阵：**写面应用层谓词全覆盖且跨租户路径均有负例用例**（调度域 SSV 系、资源 SNZ-009/010、ingest SOP 系、幂等 SDB-006）；读面行为级证据集中在 control、feature-flags/config、scheduler constraints、files/workbench、world。**如实声明的缺口**：RLS 行为级 e2e 仅 1 张表（org-rls-guc），其余 48 张受管表靠机制级+谓词级+verify 三层补偿；MES/ERP/OEE/scale 无跨租户 e2e；browser 层零租户覆盖（`tenant-isolation-report.md` §2/§3/§7）。

## Q13 安全面（AuthN/AuthZ + Web/API 攻击面）终态？

专批 5 项 + 散项全 FIXED：SQL 注入标识符白名单（R2-SCR-005）、SSRF 固定 IP 直连+逐跳复检（R2-EDM-02，8 用例）、边缘 8 处 innerHTML 统一 esc()（R2-EDM-03）、飞书读端点 fail-closed 鉴权（R2-FSH-002，86/86）、consent 强制+交叉校验（R2-EDM-06）；角色面 @Roles 收敛（learning/mes/model/frontend-metrics）、mobile 透传+mes fail-closed（R2-SAM-002/R2-SNZ-012）、审批图服务端化（R2-SMI-001/003）。残留：Control 回执绑定设备凭证（协议面，未关闭）、Edge 上行桥批量失效（已文档化待修）——均如实登记非本轮范围（`security-report.md`）。

## Q14 全量回归的真实结果？

本机复跑（2026-08-18，收敛后终态）：
- **Python**：unittest 979 OK；pytest 契约 681 passed/11 skipped；golden 330+6；状态机 5；production-smoke 11。
- **TS**：`npx tsc -b` 0 错误；client Jest 127 suites/1022 tests 全过；**server Jest 290 suites/2247 tests 全过（含此前唯一失败的 openapi-route-parity，本轮补 ewoh.yaml 端点 + gen:openapi 再生成后 6/6）**。
- **门禁**：lint / truth-check（24/24 envelope + 584/584 domain）/ audit-regression-gates 十条 / contract 族 / scheduler-golden / openapi:no-drift 全绿（`test-report.md`）。

## Q15 哪些验证受环境阻塞（ENVIRONMENT_BLOCKED）？

bandit（本机未装，CI 有）、迁移链真实空库执行（需 EWOH_PG_URL）、跨租户 TCK（需 E2E 库）、Playwright 4 spec（需浏览器+真实后端）、Jest e2e 8 spec（需真实 PG）、ortools CP-SAT 真实求解（默认 OFF）、runtime-gates/perf/soak（需 CI 集群）。全部如实登记，**未记 pass、未转述未执行数字**（`test-report.md` §3）。

## Q16 P2/P3 中 136 项 DISPOSITIONED 的裁决依据是否可审计？

是。`p2p3-dispositions.md` 逐条登记裁决类型与理由（SYSTEMIC_REFACTOR_RULING 系统性重构不宜单迭代批改、TEST_HYGIENE_ACCEPTED 假库语义豁免、WONT_FIX 低风险文档/口径类等），与 findings.jsonl 的 status=DISPOSITIONED 逐条对应，可脚本对账。

## Q17 release/、delivery/、output/ 的生产引用与版本边界是否核查？

**核查结论：无生产代码路径引用三者**。全仓 grep 命中仅为（a）docstring 注释引用 delivery/07 规则文档（src/edge_platform/services.py 人工溯源注释，运行时不读取该文件，规则已内化为代码常量）；（b）"release/allocate" 等动词字面误命中；（c）Makefile truth-check 的 output/ 生成物（evidence-manifest 等，脚本自身产物）。release/ 目录为 ewoh-0.6.0-rc1..rc4 四份快照 + SBOM，与当前 version.json `0.6.0-rc4` 边界一致；三者均列入 file-ledger 排除声明（`coverage-report.md`）。

## Q18 project-state / capability-matrix / feature-status 是否仅凭真实证据更新？

是。更新原则：Implemented/Tested/Deployable/ProductionEnabled 严格分离；无生产运行证据不改 production 状态；CP-SAT 保持 default OFF、ORTHO 环境依赖如实登记（本轮更新动作见 Q20 提交清单；feature-status 生成门禁 `truth-feature-status.js` 含 openapi_no_drift 检查，复跑通过）。

## Q19 本轮未关闭/遗留项清单（下一轮输入）？

1. **Decision 域提升**（迁 server/modules/decision/，三步迁移路径备查 arch-decision §6.2）；
2. **Event Backbone 抽共享骨干**（envelope 覆盖率 44%/37.5% 结构面）；
3. **World A4 空转协议面拆除 / WS- 版本双分配器 / 端点重名异义**（arch-world 迁移路径 1/4/6）；
4. R2-SSV-23 PARTIALLY_FIXED（decision-history 服务端分页需契约+索引迁移，DEFERRED）；
5. Control 回执设备凭证绑定、Edge 上行桥缓冲上界（协议/产品面）；
6. RLS 行为级 e2e 从 1 表扩到 48 表、MES/ERP/scale 跨租户 e2e、browser 层租户覆盖（测试债）；
7. ENVIRONMENT_BLOCKED 项（Q15）在 CI 环境的真实执行。

## Q20 总体结论：本轮目标是否达成？

**达成**。（1）二轮逐行审计 2095 文件全覆盖、325 新发现全部闭环（FIXED 189 + 可审计裁决 136，无 OPEN）；（2）P0/P1 100% 关闭且旧发现扩散面（56 条）同型收口；（3）租户/幂等/双口径三大根因族以"模式收敛+结构门禁+负例用例"系统性修复（新增 3 个迁移、2 个契约结构门禁、10 条主线防回归门禁）；（4）全量回归在本机可执行范围内全绿（Python 979+681+341、TS 0 err + 3269 Jest tests、openapi/no-drift、truth 584/584）；（5）15 份交付报告齐全且口径互相可对账。系统向 Factory Embodied Intelligence Operating System 的闭环收敛了一轮可信的一步；剩余为明确登记的架构债与环境债，无未知风险项。

---

### 交付物索引（docs/audit/current/）

file-ledger.jsonl · findings.jsonl（325）· old-finding-regression.yaml · coverage-report.md · repository-truth.md · architecture-before.md · architecture-after.md · root-cause-analysis.md · refactor-report.md · scheduler-conformance-report.md · tenant-isolation-report.md · security-report.md · contract-parity-report.md · test-report.md · p2p3-dispositions.md · **final-assessment.md**（本文）
