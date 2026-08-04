# EWOH Final 6.1 深化迭代 Spec

## Why

当前 `main`（HEAD `6e6a67f`，发布候选 `0.6.0-rc4`）已具备高度完整的本地独立验证能力：Work Graph、Gate Engine、资源注册、交接服务、因果执行控制台、移动 E-SOP、质量追溯、ERP 映射、工厂 Profile、复制 TCK、PWA、离线重试与本地门禁均已实现。上一迭代（`latest-head-audit-and-deepening`）已闭环并推进到 `main`。

本迭代的目标不是重复这些骨架，而是把 EWOH 从「本地独立验证高度完整的候选平台」推进到「事实一致、生产可验证、现场易用、可真实跨厂复制、可由伙伴交付」的版本。**不以新增页面数量衡量进度**，以真实差距的消除、可验证的部署/持久化/协作闭环、以及 UX 的工业化深度为准。

## 不可违反的边界（Invariants）

1. `.codex/artifacts` 与版本化仓库文件仍是编排状态的权威事实源；控制台数据库与缓存不得成为第二事实源。
2. 不得放宽组织隔离、`org_id` 过滤、RLS、审计、CODEOWNERS、资源锁与人工批准边界。
3. AI 不得自行批准 G10-G13，不得执行不可逆生产操作，不得承担实时安全控制。
4. 所有终端业务数据访问继续通过 NestJS；不得让前端、飞书应用或控制台绕过统一 API。
5. 不得为单一客户修改核心契约或建立长期客户分支；差异必须进入 Profile / Mapping / Connector / Template / Policy / Scenario Pack。
6. 不得伪造 Docker / Kubernetes / 设备 / ERP / 真实工厂 / 人工签署证据；环境不可用时标记 `BLOCKED` 并输出所需外部条件。
7. 实现 Agent 不得自验其高风险任务；必须安排独立验证 Agent。
8. 不得仅更新 Markdown 宣布完成；每个 Done 必须绑定代码、测试、提交、环境指纹与独立验证证据。
9. 不复制 ERP 财务总账、采购结算或会计能力。
10. 所有写接口默认 fail-closed，必须显式配置可写模式与授权。

## What Changes

最终交付物《Final 6.1 权威事实与用户体验差距报告》+ 一套 P0/P1 任务实现。阶段划分：

- **Phase 0（只读审计）**：只读对账权威制品与既有门禁，输出差距报告；本阶段不得改码。
- **Phase 1（F61-01 单一事实源语义一致性）**：版本化 JSON Schema、跨文件语义规则、`audit-repo-facts.js --strict` 非零退出。
- **Phase 2（F61-02 持久化/事务/多实例）**：领域状态从内存迁到可靠存储，真实 HTTP + PostgreSQL E2E。
- **Phase 3（F61-03 真实 GitHub 协作闭环）**：Task 与 Issue/PR/CI/Gate/Release 双向同步，正式语义化 Tag + GitHub Release。
- **Phase 4（F61-04 生产部署与升级门禁）**：CI 真实构建镜像、临时 PostgreSQL/Compose E2E、k3d/kind 集群安装/升级/回滚/备份恢复。
- **Phase 5（F61-05 控制台 UX 深化）**：阻塞解释、关键路径影响分析、多视图、证据体验、批准体验、交接体验。
- **Phase 6（F61-06 移动离线工业化）**：IndexedDB/OPFS、图片压缩/EXIF 清理/分片续传、真实扫码、冲突与恢复。
- **Phase 7（F61-07 统一错误/表单校验/数据来源）**：统一错误契约、字段级错误、数据来源标识全页面覆盖。
- **Phase 8（F61-08 测试/安全/性能/可观测性）**：多浏览器+无障碍、视觉回归、负载/Soak/故障注入、teardown 扫描、统一 traceId、SLO/告警。
- **Phase 9（F61-09 工厂复制工具链）**：Profile 版本 Diff、Mapping 预览/覆盖检查、连接器录制/脱敏/重放、现场准备向导。
- **Phase 10（F61-10 仓库/交付状态自然语言对话）**：只读 NL 查询层，证据链引用，G10-G13 永远人类决策。
- **Phase 11（独立验证与最终结论）**：全量门禁重跑、独立验证 Agent 复核、A–E 结论与外部阻塞清单。

## Impact

- **Affected specs / capabilities**：Work Graph、Gate Engine、Resource Registry、Handoff Service、因果执行控制台、移动工作台、工厂复制、发布/部署、错误契约、数据来源词汇。
- **Affected code（主要目录）**：
  - `ewoh-spark-app/apps/server`、`ewoh-spark-app/apps/client`（后端/前端）
  - `tools/work-indexer`、`tools/work-console`、`tools/git-sync`、`tools/gate-engine`、`tools/resource-registry`、`tools/handoff-service`、`tools/factory-replication`
  - `scripts/audit-repo-facts.js`、`scripts/standalone-check.sh`、`scripts/pilot-readiness-check.sh`
  - `.codex/artifacts/*`（作为权威事实源被解析/校验，不承担持久化真源）
  - `contracts/*`、`openapi/*`、`db/*`、`deploy/*`、`release/*`
  - `ewoh-feishu-app/*`、`src/edge_platform/*`（Python 侧仅按需加固，不重写）

## ADDED Requirements

### Requirement: 单一事实源语义一致性（F61-01）
服务/工具 SHALL 为 state、phase、task、gate、risk、decision、evidence、release manifest 提供版本化 JSON Schema，并对 Markdown 提供规范化解析或生成式视图。`audit-repo-facts.js --strict` SHALL 在出现语义冲突时返回非零退出码。

#### Scenario: 8 类漂移被门禁捕获
- **WHEN** 制造 ≥8 类漂移夹具（任务全 Done 但章节 In Progress、Gate 未 Passed 却声明 Completed、风险修复进代码而未复核、测试/路由/表数/版本过期、planned_next 指向已完成任务、evidence 依赖不匹配等）
- **THEN** `audit-repo-facts.js --strict` 全数发现并返回非零退出码；真实仓库零未豁免冲突。

### Requirement: 持久化/事务/多实例正确性（F61-02）
领域事实（任务、交接、资源锁、Git 操作、证据、工厂复制状态）SHALL 迁移到可靠存储，提供乐观锁、唯一约束或幂等键、事务原子性、锁的过期/续租/释放/断链恢复、离线重放不重复创建。

#### Scenario: 服务重启与并发
- **WHEN** 创建状态后重启服务、两个实例并发写同一对象、事务中途失败、锁持有者异常退出、离线操作重放
- **THEN** 状态持久存在、无重复执行/丢失更新、无部分写入、锁可恢复、不重复创建业务对象；以真实 HTTP + PostgreSQL E2E 验证，不以单元测试替代。

### Requirement: 真实 GitHub 协作闭环与正式发布（F61-03）
Task/Work Package 与 GitHub Issue、分支、PR、CI、Review、Gate、Release 双向同步；支持 dry-run、幂等键、重试、指数退避、速率限制、权限最小化、冲突对账与审计；远程不可用时保留离线文件模式，恢复后安全补同步。SHALL 创建正式语义化 Tag 与 GitHub Release，包含不可变构建物、SHA256、SBOM、依赖/许可证清单、构建来源与提交 SHA、迁移/回滚说明、已知风险、门禁证据链接。不得自动合并高风险 PR。

### Requirement: 生产部署与升级门禁（F61-04）
CI 中真实构建 Python、NestJS、React、连接器镜像；启动临时 PostgreSQL 与 Compose 运行真实 E2E；在 k3d/kind 或等价临时集群执行 Helm lint/template、全新安装、readiness/liveness、数据库迁移、上一版本升级、回滚、备份恢复、Pod 重建与节点中断恢复、配置缺失与凭据错误诊断。输出可审计部署证据。外部生产凭据/设备/人工签署不可用时，Gate 保持 Pending，不得伪造通过。

### Requirement: 因果执行控制台 UX 深化（F61-05）
基于现有控制台增强，不推倒重写。SHALL 提供「为什么阻塞」解释（上游阻塞项/缺失过期证据/受影响 Gate/可解除人/推荐下一步）、关键路径与影响分析（关键路径/阻塞传播/最长等待/返工环/到期风险/影响预览）、图形可用性（图/表/时间线等价视图、保存筛选图层、Mini-map/搜索/聚焦/返回、大图虚拟化/增量渲染、聚类/边聚合/渐进展开、252/1000/5000 工作项性能基准、键盘导航与无障碍列表视图）、证据体验（commit/环境/验证人/时间/有效期、新旧 Diff、失效原因、一键补救任务、不得自签）、批准体验（范围/条件/有效期/风险变化/回滚点/双重确认/条件批准与撤销/并发修改检测）、交接体验（必填上下文包/未决问题/责任边界/接收确认/未确认交接不得关闭原任务）。

### Requirement: 移动作业与离线能力工业化（F61-06）
关键离线队列从 localStorage/Data URL 升级到 IndexedDB 或 OPFS；离线项具备唯一操作 ID、业务幂等键、顺序依赖、重试次数、下次重试时间、错误原因、冲突状态、用户可见恢复操作。图片证据支持客户端压缩、尺寸/格式限制、EXIF/位置清理、内容哈希去重、分片与断点续传、网络恢复后台同步、配额提醒、上传取消/重试、服务端 MIME 嗅探/恶意文件检查/访问控制。增加真实扫码（摄像头/手电筒/震动或声音确认/离线物料设备字典/错码重复码过期码提示）。优化一线交互（大触控/单手/弱网离线可见/未同步退出保护/暂停恢复准确步骤/高风险二次确认）。SHALL 验证飞书、PWA、手机、工业平板使用同一状态机。

### Requirement: 统一错误、表单验证与数据来源体验（F61-07）
所有 API 统一返回 `errorCode/message/fieldErrors/requestId/retryable/suggestedAction/文档参考`；消除手工单条字符串校验；UI 把字段错误放到对应控件；可重试错误提供安全重试、不可重试明确下一步；用户可复制 requestId 但不暴露内部堆栈/SQL/路径/敏感标识。SHALL 将数据来源标识（REAL/SIMULATED/CONTROLLED/REPLAY/CACHED/STALE/OFFLINE）扩展到全部页面，显示最后更新时间、来源系统、工厂、环境与新鲜度；禁止在同一指标中静默混合模拟与真实数据。

### Requirement: 测试、安全、性能、可观测性深化（F61-08）
测试覆盖管理员/主管/操作员/验证者/只读角色，覆盖审批/条件批准/交接/资源锁/离线重放/照片证据/Git 同步/工厂复制；在 Chromium/Firefox/WebKit/移动尺寸运行；axe 无障碍扫描覆盖关键页面；增加视觉回归、契约模糊测试、属性测试、迁移兼容测试。性能建立符合真实业务比例的负载模型，覆盖遥测/快照/回放/任务图/照片上传/批量同步/ERP 连接器，测量 p50/p95/p99、错误率、DB 池、队列深度、内存、CPU、事件循环延迟；执行 soak/峰值突发/依赖降速；前端 bundle budget、Web Vitals、大图渲染预算。安全增加 secret scan、依赖扫描、容器扫描、SBOM、构建签名、来源证明；验证附件访问/对象级授权/组织隔离/临时 URL/保留期限；对 Agent 工具权限、Git 写操作、生产资源锁、批准 API 做威胁建模；所有越权/证据篡改/重放/跨组织请求有负向测试。可观测性贯通 Python Edge/NestJS/连接器/数据库/前端统一 traceId；指标带 org/factory/environment/connector 受控标签；建立 SLO/错误预算/告警/运行手册/证据链接；避免日志无限基数与敏感数据。

### Requirement: 真实工厂复制工具链（F61-09）
Factory Profile 提供版本 Diff、继承来源、覆盖项、冲突项、回滚；Mapping 提供样例数据预览、字段覆盖率、类型/单位/枚举检查、dry-run；自动计算「需求由模板满足的比例」但允许人工复核，不伪造 80%；支持连接器流量录制、脱敏、夹具生成、离线重放、契约漂移检查；现场准备向导区分「代码已具备/配置已完成/外部条件缺失/人工待签署/现场真实验证通过」。第二、第三工厂真实证据必须由独立验证者签署。

### Requirement: 仓库与交付状态自然语言对话（F61-10）
基于 Work Graph、Gate Engine、Evidence Index、Risk Register、Release Manifest 提供只读 NL 查询层。SHALL 回答诸如「现在真正阻塞交付的三件事」「为什么 G10 不能通过」「哪些测试是旧提交产生的」「哪些风险没有 Owner」「第二工厂还缺什么」「哪些任务 Done 但 Gate 证据不足」「生成安全任务包」「比较两版本/两工厂/两环境」。每个结论附带文件路径、工作项 ID、证据 ID、commit SHA、环境；区分事实/推断/建议；证据不足时回答「不知道/证据不足」；默认只读；任何写入/创建/重试/批准/Git 操作必须展示预览并经过权限检查；G10-G13 永远人类决策；敏感内容最小权限与字段脱敏。

### Requirement: 只读审计与差距报告（Phase 0）
SHALL 先执行只读审计，输出《Final 6.1 权威事实与用户体验差距报告》，覆盖：真实版本/路由/数据库对象/测试/工作项/证据/Gate 状态；已实现能力；Done/Gate/风险/CHANGELOG/state.json 语义冲突；内存状态/Stub/临时适配器/localStorage/Data URL/仅本地夹具；生产环境/真实工厂/真实 ERP/GitHub 远程同步/人工批准无法由代码自证事项；按 P0/P1/P2 给出任务/依赖/Owner/代码所有权/验收/回滚。未完成报告前不得大规模改码。

## REMOVED Requirements
无（本迭代不删除既有能力，只深化与加固）。

## 验收命令（最终验收）
- `npm run typecheck`、`npm run lint`、`npm run test:server`、`npm run test:client`、`npm run test:e2e`、`npm run test:browser`、`npm run test:browser:visual`
- `bash scripts/standalone-check.sh`、`bash scripts/pilot-readiness-check.sh`
- `node scripts/audit-repo-facts.js --strict`、`node tools/work-indexer/index.js --root . --strict --invariants`、`node tools/work-console/index.js --root . --output output/work-console.json --strict`
- 新增：镜像构建检查、Compose 真启动、Kubernetes/Helm 安装/升级/回滚、数据库迁移与恢复、多实例与重启持久性、移动离线/照片/冲突、多浏览器与无障碍、长时间负载与故障注入、正式 Release/SBOM/签名验证。

## 最终结论尺度
仅根据真实证据作结论。明确回答：Local Standalone Ready / Pilot Ready / Production Ready / Scale Ready 各是否成立。只要 G10-G13、真实第二/第三工厂、伙伴交付或生产 SLO 尚未完成，不得宣称「全部完成」或「没有继续优化空间」。