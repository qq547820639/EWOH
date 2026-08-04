# Tasks: EWOH Final 6.1 深化迭代

基线：当前 `main` HEAD `6e6a67f`（`0.6.0-rc4`）；所有骨架已实现，不重复开发。

---

## Phase 0：只读审计与差距报告（必须先完成，后改码）
- [x] Task 0.1: 执行环境与基线记录
  - [x] 记录仓库地址、分支、HEAD SHA、检查时间
  - [x] 记录 OS / Node / Python / PostgreSQL / Docker / 依赖版本
  - [x] 记录可用环境与不可用环境（本机 / CI）
- [x] Task 0.2: 对账权威制品目录
  - [x] README.md / CHANGELOG.md / package.json / release/* / openapi/* / database/* / scripts/* / tools/* / apps/server/* / apps/client/* / ewoh-feishu-app/*
  - [x] `.codex/artifacts/state.json` / phase-state.md / task-board.md / task-graph.md / gates.md / risk-register.md / decision-log.md / contracts/* / work/* / evidence/*
- [x] Task 0.3: 运行既有门禁脚本并保留日志
  - [x] `bash scripts/standalone-check.sh`
  - [x] `bash scripts/pilot-readiness-check.sh`
  - [x] `node scripts/audit-repo-facts.js --strict`
  - [x] `node tools/work-indexer/index.js --root . --strict --invariants`
  - [x] `node tools/work-console/index.js --root . --output output/work-console.json --strict`
- [x] Task 0.4: 静态扫描内存/Stub/临时实现
  - [x] 搜索 apps/server、tools 中 Map/Set/数组/模块变量/进程内单例作为领域事实存储的代码
  - [x] 标记 localStorage/Data URL/仅本地夹具/Stub 适配器位置与数量
- [x] Task 0.5: 产出《Final 6.1 权威事实与用户体验差距报告》`docs/reviews/FINAL_SIX_ONE_AUDIT.md`
  - [x] 当前真实版本、路由、数据库对象、测试、工作项、证据、Gate 状态
  - [x] 已实现能力清单（禁止重复开发）
  - [x] Done/Gate/Risk/CHANGELOG/state.json 语义冲突
  - [x] 仍使用内存/Stub/临时适配器/localStorage/Data URL 的实现清单
  - [x] 生产环境/真实工厂/真实 ERP/GitHub 远程同步/人工批准无法由代码自证的事项
  - [x] P0/P1/P2 任务、依赖、Owner、代码所有权、验收条件、回滚方案
- [x] Task 0.6: 由独立验证 Agent 复核差距报告与语义冲突清单

## Phase 1：F61-01 单一事实源语义一致性
- [x] Task 1.1: 为 state/phase/task/gate/risk/decision/evidence/release 建立版本化 JSON Schema
  - [x] `contracts/artifact-schemas/state.schema.json`
  - [x] `contracts/artifact-schemas/task-board.schema.json`
  - [x] `contracts/artifact-schemas/gate.schema.json`
  - [x] `contracts/artifact-schemas/risk.schema.json`
  - [x] `contracts/artifact-schemas/decision.schema.json`
  - [x] `contracts/artifact-schemas/evidence.schema.json`
  - [x] `contracts/artifact-schemas/release-manifest.schema.json`
- [x] Task 1.2: 建立规范化 Markdown 解析器（front matter + 内容）
  - [x] 统一 front matter 字段规范（workItemId/gateId/commitSha/branch/buildVersion/envFingerprint/testTime/verifier/expiresAt/result）
  - [x] 输出结构化 JSON 以便工具对账
- [x] Task 1.3: 实现跨文件语义规则
  - [x] 任务全部 Done 但章节仍显示 In Progress → 失败
  - [x] Gate 未 Passed → 禁止发布状态为 Completed/Scale Ready → 失败
  - [x] 风险对应修复已进入代码但风险未复核 → 告警
  - [x] 测试数量/路由数量/表数量/版本号过期 → 失败
  - [x] `planned_next` 指向已完成任务 → 失败
  - [x] Evidence 的 commit/environment/dependency 或 `expiresAt` 不匹配 → 自动失效
- [x] Task 1.4: 扩展 `scripts/audit-repo-facts.js --strict` → 语义冲突返回非零退出码
  - [x] 控制台只展示源文件解析结果；任何写入必须生成可追踪 Git Diff 或签名事件
- [x] Task 1.5: 创建至少 10 类漂移夹具验证检测能力（实际 13 类，含 no-self-exemption）
- [x] Task 1.6: 验收 → 真实仓库零未豁免冲突
- [x] Task 1.7: 独立验证 Agent 复核语义规则与检测能力
  - [x] 13 条规则注册于 RULE_META / ALL_RULES
  - [x] 7 个 schema 版本化（$id: ewoh:///artifact/<name>/v1）
  - [x] strict 模式任一未豁免冲突即非零
  - [x] 13 个漂移夹具逐一真实触发目标规则（含 fixture-13 no-self-exemption）
  - [x] 上一轮缺陷 R-a/R-b/R1/R-c/R2 全部修复
  - [x] 9 类真实仓库冲突 9/9 修复
  - [x] --fix 边界正确（仅 head-consistency / task-section-status 可自动修复）
  - [x] 结论：允许进入 F61-02（`docs/reviews/F61-01_INDEPENDENT_VERIFICATION.md`）

## Phase 2：F61-02 持久化、事务和多实例正确性
> 完成标准（用户 2026-08-05）：最终状态为 **`F61-02 Code Complete / Runtime Verification Blocked`**。代码层全部闭环前不启动 F61-03。

- [x] Task 2.1: 静态扫描并列出进程内单例存储清单
  - [x] `apps/server`、`tools` 中 Map/Set/数组/模块变量/进程内变量
  - [x] 标记哪些需要持久化（任务、交接、资源锁、Git 操作、证据、工厂复制状态）

### 2.A 完整数据库制品
- [x] Task 2.2: 补齐 6 张领域表的迁移 SQL（`db/migrations/*.sql`，独立可执行，re-entrant）
  - [x] `db/migrations/standalone_004_ewoh_domain.sql`（或等价增量迁移）：`ewoh_resource_locks` / `ewoh_handoffs` / `ewoh_git_sync_state` / `ewoh_evidence_metadata` / `ewoh_factory_replication_sessions` / `ewoh_idempotency_keys`
  - [x] 每表：主键、业务唯一约束、外键（如适用）、乐观锁 `version` 列、`_created_at`/`_updated_at`
  - [x] 索引（holder/active/state/to_actor/work_item/factory/status/scope）
  - [x] 与 `server/database/schema.ts` 现有 F61-02 表定义一致
- [x] Task 2.3: 可逆回滚脚本
  - [x] `db/migrations/standalone_004_ewoh_domain.rollback.sql`：`DROP TABLE IF EXISTS` 逆序 + `IF EXISTS` 守护
- [x] Task 2.4: 迁移计划接线（`db/runner/run_migrations.js`）
  - [x] 在 `FILES` 增加 `standalone_domain` / `standalone_domain_rollback` 项
  - [x] 增加 `--apply-standalone-domain` / `--rollback-standalone-domain` / `--plan-standalone-domain` 命令
  - [x] 增加 verify 查询（`db/verify/standalone_004_verify.sql`）校验 6 表存在
- [x] Task 2.5: 数据库清单与迁移顺序同步（`db/contracts/schema-manifest.yaml`）
  - [x] 6 张领域表加入 `managed_tables`（domain/org_id_policy/status/capability_mapping）
  - [x] 更新 `managed_count` / `physical_create_count` 等汇总
- [x] Task 2.6: 旧文件/内存数据迁移工具
  - [x] `scripts/migrate-domain-state.js`（或等价）：从 `.codex/artifacts/work/*`、内存导出、JSON 快照导入 6 表
  - [x] 幂等/去重（`ON CONFLICT`），dry-run 模式
- [x] Task 2.7: 重复执行安全性检查
  - [x] 迁移/回滚脚本二次执行不报错、不损坏数据（`CREATE IF NOT EXISTS` / `DROP IF EXISTS` / `ON CONFLICT`）
  - [x] 契约测试验证（`test/contract/*` 或 `scripts/` 新增）

### 2.B 运行时服务切换
- [x] Task 2.8: 资源锁运行时完整切换（获取/续租/释放/过期回收/持有者异常恢复）
  - [x] `WorkOrchestrationService` 资源锁路径全部走 `DomainPersistenceService`（DB 唯一约束竞争、版本 CAS、DB 时间）
  - [x] 移除进程内 `locks` Map 作为事实源（仅保留缓存/降级回退）
- [x] Task 2.9: 交接运行时切换（创建/接受/关闭/未确认阻断）
  - [x] `handoff-service` 或 `WorkOrchestrationService.createHandoff` 走 `ewoh_handoffs` 持久化
  - [x] 未确认交接阻断原任务关闭
- [x] Task 2.10: Git 同步运行时切换（游标/提交 SHA/冲突/失败补偿）
  - [x] `git-sync` 状态写入 `ewoh_git_sync_state`
- [x] Task 2.11: Evidence 运行时切换（登记/更新/失效/校验和/验证者）
  - [x] 证据元数据写入 `ewoh_evidence_metadata`
- [x] Task 2.12: 工厂复制会话运行时切换（创建/步骤推进/进度/结束/输出证据）
  - [x] 会话状态写入 `ewoh_factory_replication_sessions`
- [x] Task 2.13: 幂等操作运行时切换（离线重放/重复请求/连接器回调/Git 操作）
  - [x] `DbIdempotencyStore` 全面生效；`InMemoryIdempotencyStore` 仅作回退

### 2.C 事务边界
- [x] Task 2.14: 复合操作进入显式事务（`db.transaction`）
  - [x] 获取锁 + 登记审计；创建交接 + 转移责任；接受交接 + 更新原任务状态
  - [x] Git 同步状态更新 + 登记证据；复制步骤推进 + 生成 Evidence
  - [x] 幂等键登记 + 业务对象创建；失败补偿 + 状态回滚
  - [x] 中途失败无部分写入（锁存在但审计缺失等 5 类反模式被测试覆盖）

### 2.D 多实例正确性
- [x] Task 2.15: 多实例并发设计落地
  - [x] 不依赖进程内 Map；DB 唯一约束竞争锁；`version`/条件更新 CAS
  - [x] 时间判断用 DB 时间（`now()`），非应用时钟
  - [x] 续租验证 holder+version；释放验证 holder；过期锁可安全接管
  - [x] 重复请求单一业务结果；并发冲突返回明确错误

### 2.E 代码层测试
- [x] Task 2.16: 无环境单元/契约/存储适配器测试
  - [x] 状态重启持久、双实例并发生成唯一 lock、过期锁恢复、非持有者不能续租/释放
  - [x] 乐观锁版本冲突、唯一约束冲突、事务失败无部分写入
  - [x] 同一幂等键只生成一个对象、离线重放不重复创建
  - [x] 交接/Git/Evidence/复制会话持久化恢复
- [x] Task 2.17: 真实 HTTP + PostgreSQL E2E 测试代码（标记 `BLOCKED_BY_ENVIRONMENT`）
  - [x] 新增 `test/e2e/f61-02-persistence.e2e.spec.ts`：重启持久性/双实例并发/事务中途失败/锁恢复/离线重放
  - [x] 标记 `BLOCKED_BY_ENVIRONMENT`，不伪造通过、不静默跳过

### 2.F CI 环境验证入口
- [x] Task 2.18: GitHub Actions PostgreSQL 验证工作流
  - [x] `.github/workflows/` PostgreSQL Service Container job（`standalone.yml` `postgres:17-alpine` + health check）
  - [x] 应用迁移（`run_migrations.js --apply-standalone --apply-standalone-domain`）
  - [x] 升级/回滚/重放验证（apply→verify→rollback→re-apply→re-apply→verify + `migrate-domain-state.js --dry-run`）
  - [x] 双实例并发测试（`scripts/verify-domain-concurrency.js`：唯一约束竞争/版本 CAS/holder 校验/过期锁接管/重入安全）
  - [x] 运行真实 HTTP E2E（`test:e2e`，经 `EWOH_E2E_RUNTIME_DATABASE_URL` 绑定 Service Container）
  - [x] 保存测试日志/数据库版本/提交 SHA 为 artifact（`f61-02-ci-evidence`）

### 2.G 收口与独立审查
- [ ] Task 2.19: Spec/Tasks/Checklist/风险/证据同步 + 最终报告
  - [ ] 更新 `docs/reviews/F61-02_*` 证据与诚实边界
  - [ ] 更新 `CHANGELOG.md` / `.codex/artifacts/phase-state.md` / 风险登记
  - [ ] 明确结论 **`F61-02 Code Complete / Runtime Verification Blocked`**
- [ ] Task 2.20: 独立代码审查（不依赖 E2E 环境的静态/契约层复核）
  - [ ] 独立 Agent 复核迁移/事务/多实例正确性；修复后复验
  - [ ] 提交并推送 main（`LOCAL_HEAD == ORIGIN_MAIN`）

## Phase 3：F61-03 真实 GitHub 协作闭环和正式发布
- [ ] Task 3.1: 实现 Task ↔ GitHub Issue 双向映射与同步
  - [ ] Task 状态同步到 Issue labels/milestones/comments
  - [ ] Issue 评论/状态变更同步回本地 Task 记录
  - [ ] dry-run 模式预览变更，不实际调用 GitHub API
  - [ ] 幂等键/重试/指数退避/速率限制/权限最小化
- [ ] Task 3.2: 实现 PR ↔ 工作项/证据/Gate 同步
  - [ ] PR 链接关联到对应 Task
  - [ ] CI 状态同步到 Gate 检查项
  - [ ] Review 批准/请求变更同步到 Gate 决策
- [ ] Task 3.3: 离线模式与补同步
  - [ ] 远程不可用时保留离线文件记录
  - [ ] 恢复联网后安全补同步，不覆盖人工修改
  - [ ] 冲突对账机制
- [ ] Task 3.4: GitHub Release 自动生成与发布
  - [ ] 包含不可变构建物
  - [ ] SHA256 校验和
  - [ ] SBOM（软件物料清单）
  - [ ] 依赖与许可证清单
  - [ ] 构建来源与提交 SHA
  - [ ] 数据库迁移与回滚说明
  - [ ] 已知风险
  - [ ] 门禁证据链接
- [ ] Task 3.5: 验证：不自动合并高风险 PR → 必须保留人工 Review 和 Gate
- [ ] Task 3.6: 独立验证 Agent 复核 GitHub 同步与发布流程

## Phase 4：F61-04 生产部署与升级门禁
- [ ] Task 4.1: 在 CI 中真正构建 Python/NestJS/React/连接器镜像
  - [ ] 更新 GitHub Actions `standalone.yml` 增加镜像构建步骤
  - [ ] 输出镜像摘要与大小
- [ ] Task 4.2: 启动临时 PostgreSQL + Compose 环境运行真实 E2E
  - [ ] 在 CI 中 spin up 容器
  - [ ] 运行完整 E2E 测试套件
  - [ ] 验证 readiness/liveness probes
- [ ] Task 4.3: 在 k3d/kind 临时集群执行安装/升级/回滚测试
  - [ ] Helm lint/template 检查
  - [ ] 全新安装 → 验证 Pod 启动/就绪/数据库迁移
  - [ ] 从上一版本升级 → 验证数据迁移与应用启动
  - [ ] 回滚到上一版本 → 验证数据回滚与应用恢复
  - [ ] 备份恢复测试
  - [ ] Pod 重建 → 验证持久化数据不丢失
  - [ ] 节点中断 → 验证应用恢复
  - [ ] 配置缺失/凭据错误 → 验证失败诊断可读
- [ ] Task 4.4: 输出可审计部署证据到 `output/deployment-evidence/`
- [ ] Task 4.5: 验证：外部凭据/设备/人工签署缺失时 Gate 保持 Pending，不伪造通过
- [ ] Task 4.6: 独立验证 Agent 复核部署门禁

## Phase 5：F61-05 因果执行控制台 UX 深化
- [ ] Task 5.1: 「为什么阻塞」解释面板
  - [ ] 显示上游阻塞项列表
  - [ ] 显示缺失/过期证据
  - [ ] 显示受影响 Gate
  - [ ] 显示可解除阻塞的人或 Agent
  - [ ] 推荐的下一项安全操作
- [ ] Task 5.2: 关键路径与影响分析
  - [ ] 计算并高亮关键路径
  - [ ] 显示阻塞传播范围
  - [ ] 显示最长等待路径
  - [ ] 检测返工环
  - [ ] 计算到期风险
  - [ ] 修改某节点后预览影响范围
- [ ] Task 5.3: 图形可用性改进
  - [ ] 图/表/时间线三种等价视图切换
  - [ ] 保存筛选和图层视图到本地存储
  - [ ] Mini-map + 搜索聚焦 + 返回上一步
  - [ ] 大图虚拟化或增量渲染
  - [ ] 节点聚类/边聚合/渐进展开
  - [ ] 252/1000/5000 工作项性能基准测试记录
  - [ ] 键盘导航 + 屏幕阅读器可访问的列表替代视图
- [ ] Task 5.4: 证据体验增强
  - [ ] 显示 commit/environment/verifier/producedAt/expiresAt
  - [ ] 新旧证据 Diff 对比
  - [ ] 解释证据为什么失效
  - [ ] 一键创建补救任务
  - [ ] 强制验证：不允许实现 Agent 签署自己的高风险证据
- [ ] Task 5.5: 批准体验增强
  - [ ] 显示批准范围/条件/有效期
  - [ ] 风险变化提示
  - [ ] 回滚点展示
  - [ ] 双重确认对话框
  - [ ] 支持条件批准与撤销
  - [ ] 并发修改检测与告警
- [ ] Task 5.6: 交接体验增强
  - [ ] 必填上下文包清单
  - [ ] 未决问题列表
  - [ ] 责任边界展示
  - [ ] 接收确认按钮/状态
  - [ ] 未确认交接 → 禁止关闭原任务
- [ ] Task 5.7: 前端单元测试 + 视觉回归测试
- [ ] Task 5.8: 独立验证 Agent 复核 UX 功能与可访问性

## Phase 6：F61-06 移动作业与离线能力工业化
- [ ] Task 6.1: 离线队列存储升级：localStorage → IndexedDB
  - [ ] 保留 API 契约不变，底层存储替换
  - [ ] 数据迁移：已有 localStorage 数据迁移到 IndexedDB
  - [ ] 单元测试覆盖迁移
- [ ] Task 6.2: 增强离线项元数据
  - [ ] 唯一操作 ID
  - [ ] 业务幂等键
  - [ ] 顺序依赖
  - [ ] 重试次数
  - [ ] 下一次重试时间
  - [ ] 错误原因
  - [ ] 冲突状态
  - [ ] 用户可见恢复操作入口
- [ ] Task 6.3: 图片证据工业化处理
  - [ ] 客户端压缩
  - [ ] 尺寸和格式限制
  - [ ] EXIF / GPS / 位置敏感信息清理
  - [ ] 内容哈希去重
  - [ ] 分片上传 + 断点续传
  - [ ] 网络恢复后后台同步
  - [ ] 存储配额不足提醒
  - [ ] 上传取消与重试
  - [ ] 服务端：MIME 嗅探 + 恶意文件检查 + 访问控制
- [ ] Task 6.4: 真实扫码功能
  - [ ] 二维码/条码摄像头实时扫描
  - [ ] 手电筒开关
  - [ ] 成功后震动或声音确认
  - [ ] 离线物料/设备字典缓存
  - [ ] 错码/重复码/过期码提示
- [ ] Task 6.5: 一线交互优化
  - [ ] 大触控区按钮
  - [ ] 单手操作流程优化
  - [ ] 弱网/离线状态持续可见
  - [ ] 未同步任务退出保护
  - [ ] 暂停后恢复到准确步骤
  - [ ] 所有高风险操作二次确认
- [ ] Task 6.6: 验证飞书/PWA/手机/工业平板使用同一状态机，无分叉实现
- [ ] Task 6.7: E2E 测试覆盖离线队列、图片上传、扫码流程
- [ ] Task 6.8: 独立验证 Agent 复核移动离线能力

## Phase 7：F61-07 统一错误、表单验证和数据来源体验
- [ ] Task 7.1: 盘点所有 Controller/Service，消除手工单条字符串校验
  - [ ] 使用 `class-validator` 装饰器替代手工校验
  - [ ] 统一校验错误格式
- [ ] Task 7.2: 统一所有 API 错误响应格式
  - [ ] `errorCode` - 机器可读错误码
  - [ ] `message` - 用户可读消息
  - [ ] `fieldErrors` - 字段级错误（field → message）
  - [ ] `requestId` - 请求关联 ID
  - [ ] `retryable` - 是否可重试
  - [ ] `suggestedAction` - 推荐用户操作
  - [ ] `documentationUrl` - 文档链接
- [ ] Task 7.3: UI 错误呈现改进
  - [ ] 字段错误显示在对应控件旁，不只是弹出 Toast
  - [ ] 可重试错误提供安全重试按钮
  - [ ] 不可重试错误明确说明下一步
  - [ ] 用户可复制 requestId，但不暴露内部堆栈/SQL/路径/敏感标识
- [ ] Task 7.4: 数据来源标识扩展到全部页面
  - [ ] 所有数据卡片/表格/图表显示来源标签：REAL/SIMULATED/CONTROLLED/REPLAY/CACHED/STALE/OFFLINE
  - [ ] 显示最后更新时间、来源系统、工厂、环境、新鲜度
  - [ ] 禁止在同一指标中静默混合模拟数据与真实生产数据
- [ ] Task 7.5: 单元测试覆盖错误格式转换与字段映射
- [ ] Task 7.6: 独立验证 Agent 复核统一错误体验

## Phase 8：F61-08 测试、安全、性能和可观测性深化
- [ ] Task 8.1: 扩展浏览器测试覆盖
  - [ ] 覆盖管理员/主管/操作员/验证者/只读角色
  - [ ] 覆盖审批/条件批准/交接/资源锁/离线重放/照片证据/Git 同步/工厂复制
  - [ ] 在 Chromium/Firefox/WebKit 运行（Playwright）
  - [ ] 在移动尺寸运行
- [ ] Task 8.2: 无障碍测试
  - [ ] axe 扫描覆盖全部关键页面
  - [ ] 修复高优先级无障碍问题
- [ ] Task 8.3: 增加测试类型
  - [ ] 视觉回归测试
  - [ ] 契约模糊测试
  - [ ] 属性测试
  - [ ] 迁移兼容测试
- [ ] Task 8.4: 性能负载测试
  - [ ] 建立符合真实业务比例的负载模型
  - [ ] 覆盖遥测写入/世界快照/回放/任务图/照片上传/批量同步/ERP 连接器
  - [ ] 测量 p50/p95/p99/错误率/DB 池/队列深度/内存/CPU/事件循环延迟
  - [ ] 长时间 soak test
  - [ ] 峰值突发测试
  - [ ] 依赖系统降速测试
  - [ ] 前端：建立 bundle budget / Web Vitals / 大图渲染预算
- [ ] Task 8.5: 安全深化
  - [ ] CI 增加 secret scan、依赖扫描、容器扫描
  - [ ] SBOM 生成与依赖清单验证
  - [ ] 构建签名与来源证明
  - [ ] 验证附件访问 / 对象级授权 / 组织隔离 / 临时 URL / 保留期限
  - [ ] Agent 工具权限 / Git 写操作 / 生产资源锁 / 批准 API 威胁建模
  - [ ] 负向测试：越权/证据篡改/重放/跨组织请求
- [ ] Task 8.6: 可观测性深化
  - [ ] 打通 Python Edge / NestJS / 连接器 / 数据库 / 前端 统一 traceId
  - [ ] 指标带 org/factory/environment/connector 受控标签
  - [ ] 建立 SLO / 错误预算 / 告警规则 / 运行手册 / 证据链接
  - [ ] 避免日志中无限基数与敏感数据
- [ ] Task 8.7: 独立验证 Agent 复核测试/安全/性能/可观测性

## Phase 9：F61-09 P1 真实工厂复制工具链
- [ ] Task 9.1: Factory Profile 版本 Diff 与回滚
  - [ ] 版本 Diff UI：显示继承来源 / 覆盖项 / 冲突项
  - [ ] 支持回滚到上一版本
- [ ] Task 9.2: Mapping 预览与验证
  - [ ] 样例数据预览
  - [ ] 字段覆盖率计算
  - [ ] 类型/单位/枚举一致性检查
  - [ ] dry-run 模式不修改数据库
- [ ] Task 9.3: 自动计算需求满足比例，允许人工复核，不伪造结果
- [ ] Task 9.4: 连接器流量录制与重放
  - [ ] 支持流量录制
  - [ ] 自动脱敏
  - [ ] 生成测试夹具
  - [ ] 离线重放验证契约一致性
  - [ ] 契约漂移检测
- [ ] Task 9.5: 现场准备向导状态机
  - [ ] 明确区分：代码已具备 / 配置已完成 / 外部条件缺失 / 人工待签署 / 现场真实验证通过
  - [ ] 每步输出可追踪证据
- [ ] Task 9.6: 验证第二/第三工厂证据必须由独立验证者签署，不允许自签
- [ ] Task 9.7: 独立验证 Agent 复核工厂复制工具链

## Phase 10：F61-10 P1 仓库和交付状态自然语言对话
- [ ] Task 10.1: 基于 Work Graph/Gate Engine/Evidence Index/Risk Register/Release Manifest 建立只读查询层
  - [ ] 语义解析：理解用户问题意图
  - [ ] 从权威文件中检索相关事实
  - [ ] 每个结论附带文件路径/工作项 ID/证据 ID/commit SHA/environment
  - [ ] 明确区分事实/推断/建议
  - [ ] 证据不足时回答「不知道/证据不足」，不编造
- [ ] Task 10.2: API 与 UI
  - [ ] `POST /api/work/console/query` NL 查询接口
  - [ ] 前端查询面板与结果展示
  - [ ] 默认只读
  - [ ] 写入操作（创建任务/重试/批准/Git）必须预览 + 权限检查 + 人工批准
- [ ] Task 10.3: 权限与脱敏
  - [ ] G10-G13 永远要求人类 Owner 决策，AI 不批准
  - [ ] 敏感内容字段脱敏，遵循最小权限
- [ ] Task 10.4: 支持查询场景
  - [ ] 现在真正阻塞交付的三件事是什么？
  - [ ] 为什么 G10 不能通过？
  - [ ] 哪些测试是旧提交产生的？
  - [ ] 哪些风险没有 Owner？
  - [ ] 哪个 Agent 负载最高或发生越权？
  - [ ] 第二工厂还缺什么？
  - [ ] 哪些任务虽然 Done，但 Gate 证据不足？
  - [ ] 生成解除某个阻塞项的安全任务包
  - [ ] 比较两个版本/两个工厂/两个环境的差异
- [ ] Task 10.5: 单元测试 + E2E 测试覆盖核心查询场景
- [ ] Task 10.6: 独立验证 Agent 复核自然语言对话能力与边界合规

## Phase 11：独立验证与最终验收
- [ ] Task 11.1: 重新运行所有门禁命令
  - [ ] `npm run typecheck`
  - [ ] `npm run lint`
  - [ ] `npm run test:server`
  - [ ] `npm run test:client`
  - [ ] `npm run test:e2e`
  - [ ] `npm run test:browser`
  - [ ] `npm run test:browser:visual`
  - [ ] `bash scripts/standalone-check.sh`
  - [ ] `bash scripts/pilot-readiness-check.sh`
  - [ ] `node scripts/audit-repo-facts.js --strict`
  - [ ] `node tools/work-indexer/index.js --root . --strict --invariants`
  - [ ] `node tools/work-console/index.js --root . --output output/work-console.json --strict`
  - [ ] 新增检查：镜像构建 / Compose 启动 / Kubernetes Helm / 迁移恢复 / 多实例持久性 / 移动离线 / 多浏览器无障碍 / 负载故障注入 / Release SBOM
- [ ] Task 11.2: 独立验证 Agent 逐项验证 P0/P1 任务验收条件
- [ ] Task 11.3: 输出最终结论
  - [ ] 实际阅读和验证过的仓库基线
  - [ ] 已实现能力（不包装旧功能）
  - [ ] 每个任务的代码变更和文件列表
  - [ ] 数据库/API/状态机/UI 契约变化
  - [ ] 所有测试命令、真实结果、环境指纹、证据路径
  - [ ] UX 前后对比及关键页面截图
  - [ ] 性能、无障碍、安全结果
  - [ ] 已解决风险、仍开放风险及 Owner
  - [ ] 外部阻塞项：真实设备/ERP/工厂/Kubernetes/凭据/人工签署
  - [ ] Gate 状态变化及批准人
  - [ ] 回滚方案
  - [ ] 明确结论：Local Standalone Ready / Pilot Ready / Production Ready / Scale Ready

---

# Task Dependencies
- Phase 0（0.1–0.6）优先于一切代码修改
- Task 1.x（F61-01）依赖 Task 0.5（差距报告）
- Task 2.x（F61-02）依赖 Task 1.x（语义一致性基础）
- Task 3.x（F61-03）可与 Task 2.x 并行
- Task 4.x（F61-04）可与 Task 3.x 并行
- Task 5.x（F61-05）依赖 Task 1.x（Work Graph 解析）
- Task 6.x（F61-06）可与 Task 5.x 并行
- Task 7.x（F61-07）可与 Task 5.x/6.x 并行
- Task 8.x（F61-08）依赖前面所有功能实现
- Task 9.x/10.x（P1）依赖 P0 全部完成
- Task 11.x（最终验收）依赖 P0/P1 全部完成
- 高风险任务（语义一致性、持久化、GitHub 同步、部署门禁、UX 深化、移动离线、错误统一、测试安全、工厂复制、NL 查询）均要求独立验证 Agent 复核，不由实现 Agent 自签
