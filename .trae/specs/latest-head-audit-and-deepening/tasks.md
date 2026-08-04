# Tasks

> 基于最新 HEAD（`e33b83d`，分支 `main`）执行「代码完成度独立审计 + 产品化深化 + 用户体验优化」。
> 先只读审计（Phase 0），再权威制品一致性（Phase 1）、因果控制台深化（Phase 2）、UX 统一（Phase 3）、场景包/连接器（Phase 4）、生产工程（Phase 5）、独立验证与最终结论（Phase 6）。
> 边界：先审计后改码；不伪造证据；不得静默改冻结契约；实现 Agent 不得自批高风险；最终结论 A–E 五档选一。
> 状态：全部 6 个 Phase 已实施、验证并推送至 `main`（HEAD `e33b83d`）。跟踪文件在复核时同步为实际完成状态。

## Phase 0：独立完成度审计（先于任何修改）
- [x] Task 0.1: 记录执行环境与仓库指纹
  - [x] 0.1.1 记录仓库地址、当前分支、HEAD SHA、检查时间
  - [x] 0.1.2 记录 OS / Node / Python / 数据库 / 容器 / 依赖版本
  - [x] 0.1.3 记录可用环境与不可用环境
- [x] Task 0.2: 只读核对权威制品
  - [x] 0.2.1 根 README、CHANGELOG
  - [x] 0.2.2 .codex/artifacts（state/task-board/task-graph/agent-registry/gates/risk-register/decision-log/contracts/work/evidence）
  - [x] 0.2.3 OpenAPI、数据库 Schema Manifest、DDL 生成器、迁移
  - [x] 0.2.4 后端/前端/飞书应用/边缘平台/部署/测试目录遍历
- [x] Task 0.3: 运行可执行验证并保留日志
  - [x] 0.3.1 全新工作区安装依赖
  - [x] 0.3.2 编译、Lint、类型检查、单元测试
  - [x] 0.3.3 启动真实后端/前端/数据库（非 Stub）
  - [x] 0.3.4 后端集成测试、真实 HTTP + PostgreSQL E2E
  - [x] 0.3.5 前端 Playwright 测试
  - [x] 0.3.6 飞书与移动工作台关键流程测试
- [x] Task 0.4: 验证 OpenAPI 与数据库
  - [x] 0.4.1 路由实现覆盖、DTO 与 Schema 一致、codegen 无未提交差异
  - [x] 0.4.2 受管表数量、51 表口径对账、全新安装/增量升级/回滚/备份恢复/RLS 与 org_id 隔离
- [x] Task 0.5: 验证边缘能力（真实/受控/模拟适配器边界、断网、重连、积压、重放、幂等、限流）
- [x] Task 0.6: 搜索并列出 TODO/FIXME/临时 Stub/Mock 生产路径/空 catch/未处理 Promise/硬编码 ID/前端假数据/未实现按钮/无后端接口页面/无页面入口接口
- [x] Task 0.7: 对 T101–T114 逐项判定为 Verified Complete / Implemented but Unverified / Partial / Missing / Blocked by External Validation
- [x] Task 0.8: 产出并提交 `docs/reviews/LATEST_HEAD_AUDIT.md`（含执行环境/HEAD/实际命令/通过失败跳过/代码与测试证据路径/Gate 状态/权威制品冲突/未完成任务/高中低风险/建议实施顺序）

## Phase 1：权威制品一致性 + Work Graph
- [x] Task 1.1: 建立版本化 Work Graph JSON Schema
- [x] Task 1.2: 建立制品路径注册表
- [x] Task 1.3: 为 Markdown/JSON/YAML 制品建立解析器与版本转换器
- [x] Task 1.4: 自动对账（README/CHANGELOG/state/task-board/task-graph/gates/contracts/OpenAPI/DB Manifest/Evidence）
- [x] Task 1.5: 对账失败时 CLI 非零退出，输出 Diff 与修复建议（禁止自动静默修复权威源）
- [x] Task 1.6: 校验接入本地 pre-commit 与 CI
- [x] Task 1.7: Evidence 结构完整性（workItemId/commitSha/environment/dependencyFingerprint/result/producedAt/expiresAt/verifier/checksum）
- [x] Task 1.8: 验收——所有权威制品 100% 可解析、无未批准冲突、CI 阻断过期证据/错误依赖/不一致 Gate、生成冲突报告与机器可读 JSON（reconcile 当前 5/6 PASS，唯一 FAIL 为已知缺口：9 个 open 任务缺证据/未标记 Blocked，见审计报告 §18）

## Phase 2：深化因果执行控制台
- [x] Task 2.1: 项目/客户/工厂/版本/当前 Gate 切换
- [x] Task 2.2: 人类团队与 Agent 泳道
- [x] Task 2.3: 任务/Gate/决策/风险/交接节点
- [x] Task 2.4: 条件依赖/证据依赖/审批依赖/异常回流/版本派生边
- [x] Task 2.5: 关键路径与阻塞传播
- [x] Task 2.6: 「为什么被阻塞」自然语言解释
- [x] Task 2.7: 节点证据抽屉（输入/输出/Git Diff/PR/CI/测试/日志/环境/验证人/证据有效期/回滚点）
- [x] Task 2.8: Agent 视图（状态/能力/工具权限/任务负载/失败率/代码所有权/预算并发）
- [x] Task 2.9: 资源视图（数据库/环境/设备/数据集/目录/许可证/预算/资源锁）
- [x] Task 2.10: 权限视图（CODEOWNERS/临时授权/越权尝试/高风险操作审批）
- [x] Task 2.11: Handoff（fromActor/toActor/scope/contextPack/openQuestions/acceptance）
- [x] Task 2.12: 批准/条件批准/驳回/撤销/补救/责任移交
- [x] Task 2.13: UI 状态修改生成可审计事件或 Git 提交；先只读，再受控写回；高风险写入由人类 Owner 批准

## Phase 3：用户体验统一
- [x] Task 3.1: 统一术语/状态机/权限/状态颜色/操作结果
- [x] Task 3.2: 建立共享设计 Token 与组件 Schema
- [x] Task 3.3: 每个页面完整处理九态（Loading/Empty/Partial/Denied/Offline/Conflict/Expired/Failure/Retry/Success）
- [x] Task 3.4: 错误提示含发生了什么/为什么/数据是否已保存/下一步/可否重试或回滚
- [x] Task 3.5: 角色化「下一步行动」首页（操作员/班组长/质量员/设备员/工艺员/工厂管理者/实施人员/项目 Owner）
- [x] Task 3.6: 全局搜索与命令面板（任务/人员/设备/工单/批次/告警/证据/Gate）
- [x] Task 3.7: 关键对象统一时间线/状态历史/责任人/关联证据
- [x] Task 3.8: 因果图缩放/聚焦关键路径/折叠低优先级/保存个人视图/大图虚拟化/键盘导航/高对比度
- [x] Task 3.9: 移动 E-SOP 深化（扫码优先/单手/大触控/工业手套/离线缓存/同步状态/冲突可解释/步骤签收/附件/质检/异常/外骨骼确认）
- [x] Task 3.10: 禁止静默覆盖解决离线冲突
- [x] Task 3.11: 首次使用引导/示例工厂/演示数据/角色化 Quick Start
- [x] Task 3.12: 响应式/可访问性/中文排版/超长文本测试
- [x] Task 3.13: 前端性能基线并防回归
- [x] Task 3.14: 产出 `docs/product/UX_DEEPENING_BACKLOG.md`（每项含角色/问题/当前行为/目标行为/页面/API 或状态机依赖/优先级/验收/Playwright 场景/前后对比截图）

## Phase 4：场景包与连接器深化
- [x] Task 4.1: Order-to-Delivery（订单导入/工单工序映射/交付预测/延期风险/生产进度/状态回写）
- [x] Task 4.2: 移动 E-SOP（版本化 SOP/扫码上下文/步骤签收/报工/质检/异常/附件/离线重放）
- [x] Task 4.3: 质量追溯（检验方案/首检/巡检/终检/缺陷/处置/一次通过率/Pareto/批次序列追溯/世界回放）
- [x] Task 4.4: 库存与采购协同（库存余额/批次/在途/预占/领料/退料/短缺风险）
- [x] Task 4.5: 设备与 OEE（能力曲线/停机原因/损失 Pareto/工序设备人员联合分析）
- [x] Task 4.6: ERP/MRP/WMS 连接器统一实现（Canonical Model/映射模板/游标/幂等/重放/补偿/死信/限流/数据质量/可观测性/Connector TCK）
- [x] Task 4.7: 核心服务不得引入客户名称/客户专属字段判断/长期客户分支

## Phase 5：生产工程深化
- [x] Task 5.1: 全新环境可重复安装
- [x] Task 5.2: Docker Compose 与 Kubernetes 部署一致性
- [x] Task 5.3: 数据库升级/回滚/备份/恢复演练
- [x] Task 5.4: 边缘断网/重连/积压/重放/远程升级
- [x] Task 5.5: 监控/Tracing/业务指标/告警降噪
- [x] Task 5.6: 生产 SLO/错误预算/容量基线
- [x] Task 5.7: SBOM/依赖扫描/镜像签名/供应链安全
- [x] Task 5.8: 密钥/权限/审计/数据脱敏
- [x] Task 5.9: 长时间稳定性与大规模数据测试
- [x] Task 5.10: 批量升级/灰度/暂停/回滚
- [x] Task 5.11: 所有生产操作提供 Runbook 与可验证回滚点

## Phase 6：独立验证与最终结论
- [x] Task 6.1: 独立验证 Agent 复核（不做自签）
- [x] Task 6.2: 逐项核对 Done 定义（12 条）
- [x] Task 6.3: 输出最终结论（A–E 五档选一，附证据）
- [x] Task 6.4: 输出实施过的提交与 PR、测试与 Evidence 索引、Gate 状态、是否具备进入生产与真实多工厂复制条件

# Task Dependencies
- Task 0.1..0.8（审计）优先于一切修改
- Task 1.x 依赖 Task 0.8（审计报告）
- Task 2.x 依赖 Task 1.x（一致性基础）
- Task 3.x 依赖 Task 2.x（控制台数据源）
- Task 4.x / 5.x 可与 3.x 并行（独立模块）
- Task 6.x 依赖全部实施完成
- 高风险任务（权威制品对账、因果控制台写回、连接器、生产工程）由独立验证 Agent 复核，不由实现 Agent 自签