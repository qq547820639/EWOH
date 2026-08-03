# EWOH 最新版代码能力与差距审计报告

审计日期：2026-08-04
分支：`codex/ewoh-iteration-2026-08-04`
HEAD：`a4aa9daf3cb4f2b93752d229dd38469088ed7b84`
审计方式：只读代码核对 + 仓库事实源门禁 + OpenAPI/Work Graph/Gate 审计 + 三路并行 Agent 盘点；
未修改代码前完成本报告。

## 1. 基线核验（真实运行结果）

| 门禁 | 结果 |
|------|------|
| `node scripts/audit-repo-facts.js --strict` | 33/33 通过 |
| `node scripts/audit-openapi-routes.js --strict` | 232/232 控制器操作与 OpenAPI 一致，0 未实现 |
| `node tools/work-indexer/index.js --strict` | 232 节点、22 边、48 Agent、89 证据、14 Gate、0 冲突 |
| `node tools/gate-engine/index.js` | 14 Gate，0 人工批准，G10-G13 共 4 项要求人工批准 |
| 现有证据 | 76 个服务端 Jest 套件 / 362 测试、13 个客户端套件 / 42 测试、29/29 HTTP+PostgreSQL E2E、真实 PG 17 迁移/RLS/审计/回滚均已在现有证据中记录 |

结论：仓库主体实现程度很高，不是空壳；但审计发现多类“代码存在但行为未闭环”或“数据模型/契约已声明但解析器/服务未执行”的 P0 缺口。

## 2. 权威制品冲突清单

| 冲突 | 现状 | 处置 |
|------|------|------|
| `output/git-sync.json` 的 `headSha=3a56152` | 落后于 HEAD `a4aa9da` | 本次实施完成后重新生成并纳入门禁 |
| Work Graph Schema 已声明 `commitSha/environment/expiresAt/verifier` | `tools/work-indexer` 从未填充这些字段，证据文件也没有机器可读元数据 | 本次实施补齐证据绑定与失效逻辑 |
| 测试基线声明 `perf-smoke` 存在 | 根目录无 `scripts/perf-smoke.js`（应用内 `ewoh-spark-app/scripts/perf-smoke.js` 存在） | 后续把根目录命令与文档统一，避免歧义 |

除上述外，README、CHANGELOG、Task Board、Gates、OpenAPI、Schema Manifest、Release Manifest 在现有门禁下保持一致。

## 3. 已完整实现能力（摘要）

- Standalone NestJS 云产品：JWT/RBAC、Rate Limit、S3/本地文件、审计链、真实 PostgreSQL 迁移/RLS/回滚。
- MES 生产执行闭环：工单/工序/投料/质检/移动端状态流转。
- OEE/安灯、ERP 连接器、质量追溯图、移动工作台。
- 规模化复制内核：Factory Template/Profile/Asset、Fleet Rings、Golden Factory、映射注册与 TCK。
- 编排控制平面：Work Graph、Gate Engine、资源锁、交接、Git Sync 计划、场地就绪、React 因果 DAG。
- 统一错误契约、请求追踪、数据来源词汇、PWA、离线照片队列。

## 4. 部分实现或仅有骨架

### 4.1 移动 E-SOP / 一线作业

| 能力 | 状态 | 关键代码 | 缺口 |
|------|------|----------|------|
| 工作台人员过滤 | 部分实现 | `ewoh-spark-app/server/modules/mobile/mobile.service.ts:15` | `personId` 只判空，未按 `assigned_person_id` 过滤 |
| 工作台组织过滤 | 部分实现 | 同上 | Drizzle schema 未暴露 `org_id`，Service 层无显式 org 谓词 |
| 扫码识别 | 部分实现 | `mobile.service.ts:32` | 只接受 orderId，不支持工位/设备/工序/物料/批次 |
| SOP 版本 | 未实现 | `mes.service.ts:117` | 只有自由文本 `instruction`，无版本/生效期/差异/旧版本规则 |
| 步骤签收/强制步骤 | 未实现 | `mes.service.ts:43,320` | 无签名、无强制确认门禁 |
| 工具/物料确认与附件持久化 | 部分实现 | `mes.service.ts:341` | 客户端上传附件引用，服务端 `pause` 丢弃 `attachments` |
| 报工良品/不良/返工/部分报工 | 部分实现 | `mes.service.ts:320` | 只存 quantity/note；无幂等键，离线重放冲突无处理 |
| 首检/巡检/终检与检验方案 | 部分实现 | `mes.service.ts:448` | 无检验阶段、方案匹配、缺陷处置/返工/放行 |
| 异常附件/自动分派/责任与进度 | 部分实现 | `mobile.service.ts`, `mes.service.ts:341` | 仅图片；无视频/语音、自动上下文、分派、进度与影响 |
| 离线队列状态 | 部分实现 | `client/src/lib/offlineQueue.ts` | 无 local/queued/syncing/synced/failed/conflict 状态，失败即中断 |
| 一线角色访问 | 部分实现 | `mobile.controller.ts:15` | `worker` 角色未获准进入移动工作台 |

### 4.2 Work Graph / Gate / 控制台

| 能力 | 状态 | 关键代码 | 缺口 |
|------|------|----------|------|
| 一致性 CLI 不变量 | 部分实现 | `tools/work-indexer/index.js:573` | strict 只检查缺失必需制品，不检查孤立节点/环/无 Owner/重复 ID/非法状态 |
| 证据绑定 | 仅接口 | `contracts/work/work-graph.schema.json:209`, `tools/work-indexer/index.js:377` | schema 有字段，解析器不填充；无 buildVersion/dependencyVersion/testTime/envFingerprint |
| 证据失效 | 未实现 | `tools/work-indexer/index.js:377` | 不比较 HEAD/环境指纹/过期时间，旧证据继续显示 passed |
| 增量索引 | 未实现 | `tools/work-indexer/index.js:498` | 每次全量重读；`output/git-sync.json` 已落后 HEAD |
| 双向追踪链 | 部分实现 | `tools/work-indexer/index.js:545`, `tools/git-sync/index.js` | 89 条证据只有 1 条证据边；无 commit/PR/CI/test 节点 |
| Gate 批准守卫 | 部分实现 | `tools/gate-engine/index.js:43` | approved 可覆盖 blocked/pending 基线；未阻止对失败 Gate 批准 |
| 高风险批准 UX | 部分实现 | `client/.../WorkOrchestration.tsx:629,699` | 单键/批量一键批准，无 reason/source/二次确认，可批量批准 G10-G13 |
| 写操作审计字段 | 部分实现 | `work-orchestration.service.ts:547` | Gate 决定缺 reason/source；资源锁缺 source |
| Work Console CLI | 未实现 | 无 `tools/work-console/` | Agent Registry 已声明该工具，目录与命令不存在 |
| 时间轴回放/图 Diff/个人视图/依赖变更请求 | 未实现 | `WorkOrchestration.tsx:56` | 无 API 与 UI |

### 4.3 Factory Profile / 连接器 / 世界模型 / 运维

| 能力 | 状态 | 关键代码 | 缺口 |
|------|------|----------|------|
| 第二/三工厂无分叉安装 | 已完整实现 | `scale.service.ts:1153` | 无缺口 |
| 工厂实施 F0-F6 向导 | 部分实现 | `onboarding.service.ts:148` | F0 空操作；F2/F3 只计数不真执行安装 |
| 映射向导/Dry Run/预检 | 未实现 | `scale.service.ts:430,745` | 只有注册/一致性，无样本转换、错误定位 |
| Fleet 回滚 | 部分实现 | `scale.service.ts:904` | 只翻转状态，不恢复配置/重装包 |
| 统一世界回放时间轴 | 部分实现 | `world.service.ts:155`, `TimelinePanel.tsx:47` | 只含事件，缺任务/设备/人员/物料/质检/审批/控制/回滚 |
| 告警事发前后对比 | 未实现 | `CommandMap.tsx:300` | 无 alert->snapshot->before/during/after |
| 从回放创建问题/任务/证据 | 未实现 | 无 | 无 API/UI |
| 慢查询检测 | 未实现 | 无 | 无 statement_timeout/慢日志/指标 |
| 边缘 Trace 传播 | 部分实现 | `tracing.interceptor.ts:30`, `edge_to_spark.py:286` | 边缘桥未传 `x-trace-id` |
| 前端懒加载/虚拟化/分页 | 部分实现 | `client/src/app.tsx:3`, `CommandMap.tsx:253` | 路由静态加载；大列表非虚拟化；固定页大小无分页控件 |

## 5. P0 Backlog（本次实施）

| ID | 缺口 | 优先级 | 建议 Owner | 建议写入范围 |
|----|------|--------|-----------|---------------|
| P0-01 | 移动工作台按人员与组织过滤 | P0 | 移动体验 Agent | `server/modules/mobile`, `server/database/schema.ts`, mobile tests |
| P0-02 | 扫码类型识别（工单/工序/设备/物料/批次） | P0 | 移动体验 Agent | `mobile.service.ts`, `client/src/pages/MobileWorkbench` |
| P0-03 | 异常附件服务端持久化 | P0 | 移动体验 Agent | `mes.service.ts` pause resultJson |
| P0-04 | 离线队列状态机与冲突可见性 | P0 | 移动体验 Agent | `client/src/lib/offlineQueue.ts`, MobileWorkbench |
| P0-05 | 证据绑定元数据 + 过期/失效 | P0 | 契约/编排 Agent | `contracts/work`, `tools/work-indexer`, OpenAPI, client types |
| P0-06 | Work Graph 一致性不变量 CLI | P0 | 编排后端 Agent | `tools/work-indexer`, `scripts/audit-work-graph-contracts.js` |
| P0-07 | `tools/work-console` 一键阻塞诊断 CLI | P0 | 编排后端 Agent | 新建 `tools/work-console/`, standalone-check, CI |

## 6. P1/P2 Backlog（后续波次）

P1：

- Onboarding F2/F3 真执行安装；F0 接场地就绪。
- Mapping Dry Run/预检/错误定位。
- Fleet 真回滚（配置恢复 + 包重装 + 审计）。
- 统一世界回放时间轴、告警前后对比、从回放建任务/证据。
- 慢查询检测、Trace 传播到边缘、根目录 perf-smoke 命令。
- Gate 批准守卫（失败 Gate 禁止批准）、批准 reason/source、高风险二次确认。
- 双向 task/commit/PR/CI/test/gate 追踪链。
- 前端路由懒加载、大列表虚拟化、分页控件。

P2：

- 映射幂等 upsert、嵌套配置 Diff、环境迁移、实施报告生成、差异建议引擎。
- 世界快照版本接入回放 UI、模型/坐标校准 API。
- Work Console 时间轴回放、图 Diff、个人视图、依赖变更请求。
- 资源锁 CLI 写操作、交接链接工作项、Git Sync 真实应用按钮。
- 指标直方图/错误率、缓存边界策略、日志脱敏补全、键盘操作地图画布。

## 7. 结论

当前仓库已达到“可运行、可测试、可审计”的 RC4 候选水平，但尚未达到目标文件中描述的
“移动端不绕过安全/质检/审计、编排控制台可追溯、旧证据自动失效”的完整 P0 验收标准。
本报告发布后的同一迭代已实际关闭 P0-01 至 P0-07：移动工作台人员/组织过滤、
扫码识别、附件持久化、离线队列状态机、证据绑定与失效、图不变量、Work Console CLI
均已实现并通过测试。验证结果：server Jest 78 套件 / 375 测试，client 13 套件 /
46 测试，typecheck/lint/build 通过，repo-facts 33/33，OpenAPI 232/232，
work graph contract 20/20，invariants 0 冲突，work-console strict 通过。
剩余 P1/P2（SOP 版本管理、质检方案、统一世界回放、Onboarding 真执行、真回滚等）
在后续波次继续实施。
