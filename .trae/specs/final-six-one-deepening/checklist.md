# Checklists: EWOH Final 6.1 深化迭代

## Phase 0：只读审计与差距报告
- [x] 执行环境与仓库基线已记录（HEAD SHA / 版本 / 环境可用性）
- [x] 权威制品目录已对账（README/CHANGELOG/state/task-board/gates/contracts/evidence）
- [x] 既有门禁脚本已运行并保留日志（standalone / pilot-readiness / audit-repo-facts / work-indexer / work-console）
- [x] 已静态扫描内存/Stub/localStorage/Data URL/仅本地夹具实现
- [x] 《Final 6.1 权威事实与用户体验差距报告》已产出至 `docs/reviews/FINAL_SIX_ONE_AUDIT.md`
- [x] 差距报告已由独立验证 Agent 复核

## Phase 1：F61-01 单一事实源语义一致性
- [x] 版本化 JSON Schema 已建立（state/task/gate/risk/decision/evidence/release）
- [x] 规范化 Markdown 解析器已实现并输出结构化 JSON
- [x] 跨文件语义规则已实现（Done/In Progress 冲突、Gate 未通过但 Completed、风险未复核、计数过期、planned_next 指向已完成、evidence 失效）
- [x] `audit-repo-facts.js --strict` 语义冲突返回非零退出码
- [x] ≥10 类漂移夹具均能被发现（实际 13 类，含 no-self-exemption）
- [x] 真实仓库零未豁免冲突
- [x] 独立验证 Agent 已复核（R-a/R-b/R1/R-c/R2 全修复，允许进入 F61-02）

## Phase 2：F61-02 持久化、事务和多实例正确性（目标：`F61-02 Code Complete / Runtime Verification Blocked`）
- [x] 进程内单例存储清单已产出
### 2.A 完整数据库制品
- [x] 6 张领域表的迁移 SQL 已补齐（独立可执行、re-entrant、与 Drizzle Schema 一致）
- [x] 索引/唯一约束/外键/乐观锁版本列已实现
- [x] 可逆回滚脚本已提供（`DROP IF EXISTS` 守护）
- [x] 迁移计划已接线（`run_migrations.js` FILES + 命令 + verify）
- [x] 数据库清单与迁移顺序已同步（`schema-manifest.yaml`）
- [x] 旧文件/内存数据迁移工具已提供（幂等/dry-run）
- [x] 重复执行安全性检查通过
### 2.B 运行时服务切换
- [x] 六类领域事实均使用数据库（资源锁/交接/Git 同步/Evidence/工厂复制/幂等）
- [x] 进程内 Map/数组/JSON 不再作为领域事实源（仅缓存/导入/灾备副本）
### 2.C 事务边界
- [x] 复合操作进入显式事务，中途失败无部分写入（5 类反模式被测试覆盖）
### 2.D 多实例正确性
- [x] 不依赖进程内 Map；DB 唯一约束竞争锁；version CAS；DB 时间
- [x] 续租验证 holder+version；释放验证 holder；过期锁可安全接管
- [x] 重复请求单一业务结果；并发冲突返回明确错误
### 2.E 代码层测试
- [x] 无环境单元/契约/存储适配器测试全部通过（`domain-persistence.service.spec.ts` 29 项全绿，含 StatefulDb 无 PostgreSQL 场景 1/2/5/6/7/8/9/10）
- [x] 真实 HTTP + PostgreSQL E2E 测试代码完整且标记 `BLOCKED_BY_ENVIRONMENT`（`f61-02-persistence.e2e.spec.ts`，不伪造、不静默跳过）
### 2.F CI 环境验证入口
- [x] GitHub Actions PostgreSQL Service Container 工作流完整（迁移/E2E/双实例并发/升级回滚/日志 artifact）
### 2.G 收口与独立审查
- [ ] Spec/Tasks/Checklist/风险/证据已同步；最终报告明确 `F61-02 Code Complete / Runtime Verification Blocked`
- [ ] 独立代码审查通过并推送 main

## Phase 3：F61-03 真实 GitHub 协作闭环和正式发布
- [ ] Task ↔ Issue 双向同步已实现（含 dry-run/幂等/重试/限流）
- [ ] PR ↔ 工作项/证据/Gate 同步已实现
- [ ] 离线模式与补同步已实现
- [ ] 正式语义化 Tag + GitHub Release 已创建（含 SHA256/SBOM/许可证/迁移回滚/风险/门禁证据）
- [ ] 高风险 PR 不自动合并，保留人工 Review 和 Gate
- [ ] 独立验证 Agent 已复核

## Phase 4：F61-04 生产部署与升级门禁
- [ ] CI 真实构建 Python/NestJS/React/连接器镜像
- [ ] 临时 PostgreSQL + Compose 真实 E2E 已运行
- [ ] k3d/kind 集群安装/升级/回滚/备份恢复/Pod 重建/节点中断已验证
- [ ] 配置缺失与凭据错误诊断已验证
- [ ] 可审计部署证据已输出
- [ ] 外部凭据/设备/人工签署缺失时 Gate 保持 Pending、不伪造
- [ ] 独立验证 Agent 已复核

## Phase 5：F61-05 因果执行控制台 UX 深化
- [ ] 「为什么阻塞」解释面板已实现
- [ ] 关键路径与影响分析已实现
- [ ] 图/表/时间线三视图 + 迷你图/搜索/聚焦/虚拟化/聚类/性能基准已实现
- [ ] 键盘导航与无障碍列表视图已实现
- [ ] 证据体验（Diff/失效原因/补救任务/禁止自签）已实现
- [ ] 批准体验（范围/条件/有效期/双重确认/撤销/并发检测）已实现
- [ ] 交接体验（必填上下文包/接收确认/未确认不关闭）已实现
- [ ] 前端单元测试 + 视觉回归测试通过
- [ ] 独立验证 Agent 已复核

## Phase 6：F61-06 移动作业与离线能力工业化
- [ ] 离线队列已从 localStorage 升级到 IndexedDB/OPFS
- [ ] 离线项元数据（操作 ID/幂等键/重试/错误原因/冲突状态）已实现
- [ ] 图片证据（压缩/EXIF 清理/去重/分片续传/后台同步/配额/服务端检查）已实现
- [ ] 真实扫码（摄像头/手电筒/震动/离线字典/错码提示）已实现
- [ ] 一线交互优化（大触控/单手/离线可见/退出保护/二次确认）已实现
- [ ] 飞书/PWA/手机/工业平板同一状态机已验证
- [ ] E2E 测试覆盖离线队列/图片上传/扫码
- [ ] 独立验证 Agent 已复核

## Phase 7：F61-07 统一错误、表单验证和数据来源体验
- [ ] 手工单条字符串校验已消除
- [ ] 所有 API 统一错误响应格式（errorCode/message/fieldErrors/requestId/retryable/suggestedAction）
- [ ] UI 字段错误显示在对应控件
- [ ] 可重试/不可重试错误处理正确，requestId 可复制但不泄露内部信息
- [ ] 数据来源标识扩展到全部页面（REAL/SIMULATED/CONTROLLED/REPLAY/CACHED/STALE/OFFLINE）
- [ ] 无静默混合模拟与真实数据
- [ ] 单元测试覆盖错误格式转换
- [ ] 独立验证 Agent 已复核

## Phase 8：F61-08 测试、安全、性能和可观测性深化
- [ ] 浏览器测试覆盖多角色/多流程/多浏览器/移动尺寸
- [ ] axe 无障碍扫描覆盖关键页面
- [ ] 视觉回归/契约模糊/属性/迁移兼容测试已加入
- [ ] 负载模型性能测试（p50/p95/p99/soak/突发/降速）已执行
- [ ] 前端 bundle budget / Web Vitals / 大图渲染预算已建立
- [ ] 安全扫描（secret/依赖/容器/镜像签名/SBOM）与负向越权测试已加入
- [ ] 统一 traceId + 受控标签指标 + SLO/告警/运行手册已建立
- [ ] 独立验证 Agent 已复核

## Phase 9：F61-09 真实工厂复制工具链
- [ ] Factory Profile 版本 Diff/继承/覆盖/冲突/回滚已实现
- [ ] Mapping 预览/字段覆盖/类型单位枚举检查/dry-run 已实现
- [ ] 需求满足比例自动计算且允许人工复核，不伪造
- [ ] 连接器流量录制/脱敏/夹具生成/离线重放/契约漂移检测已实现
- [ ] 现场准备向导状态机已实现
- [ ] 第二/第三工厂证据由独立验证者签署
- [ ] 独立验证 Agent 已复核

## Phase 10：F61-10 仓库和交付状态自然语言对话
- [ ] 只读 NL 查询层已实现（Work Graph/Gate/Evidence/Risk/Release）
- [ ] 结论附带文件路径/工作项 ID/证据 ID/commit SHA/environment
- [ ] 区分事实/推断/建议，证据不足时回答不知/证据不足
- [ ] 写入操作必须预览 + 权限检查 + 人工批准
- [ ] G10-G13 永远人类决策，敏感内容脱敏
- [ ] 核心查询场景已覆盖并有测试
- [ ] 独立验证 Agent 已复核

## Phase 11：独立验证与最终验收
- [ ] 全部门禁命令重跑通过（typecheck/lint/test:server/test:client/test:e2e/test:browser/test:browser:visual/standalone/pilot/audit-repo-facts/work-indexer/work-console）
- [ ] 新增检查通过（镜像构建/Compose/K8s Helm/迁移恢复/多实例持久性/移动离线/多浏览器无障碍/负载故障注入/Release SBOM）
- [ ] 独立验证 Agent 逐项验证 P0/P1 验收条件
- [ ] 最终输出已包含：仓库基线/已实现能力/任务代码变更/契约变化/测试与证据/UX 对比/性能安全无障碍/风险与 Owner/外部阻塞/Gate 状态变化/回滚方案
- [ ] 明确结论：Local Standalone Ready / Pilot Ready / Production Ready / Scale Ready 各判定