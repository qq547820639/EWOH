# EWOH 下一阶段实施计划（v0.7 完成之后）

> 制定日期：2026-08-08 | 基线：main@a4154af
> 前置已完成：仓库走读 · 飞书加固 v1.1.0 · 智能调度 v0.7 全五批 · AI 修复 · 边缘 H2/RLS/verify 治理收敛
> 走读 H1-H4 全部闭环（H1 修正为误判、H2 修复、H3/H4 飞书加固中修复）

---

## 一、当前状态盘点

| 域 | 状态 |
|----|------|
| 智能调度四批（A 数据/B 事件/C 前端/D 反馈） | ✅ 已推送 |
| Batch 5-9（权重/SSE/能力/级联/熔断/CP-SAT worker/治理） | ✅ 已推送 |
| 边缘 H2 遥测帧对齐 + RLS 缓解 + verify 去硬编码 + 迁移基线 | ✅ 已推送（a4154af） |
| 飞书侧车 v1.1.0 | ✅ 已推送 |
| AI 接入修复 | ✅ 已推送 |

---

## 二、剩余工作全景（按域）

### 2.1 调度闭环补全（P1）

| # | 项 | 现状证据 | 说明 |
|---|----|----------|------|
| S1 | **TASK_CREATED/TASK_UPDATED 接线** | `task.service.ts` 无事件注入 | 任务创建/更新 → `injectSchedulingEvent`（fire-and-forget），任务变更自动触发重排 |
| S2 | **影子评估自动化** | policy compare 已有（人工触发） | 定期/每 N 次 run 自动对比候选策略与活跃策略的 KPI，输出评估报告 |
| S3 | **resource.state_changed SSE** | 有意暂缓（事件风暴） | 需节流策略（合并窗口/限频），接入地图资源实时层 |
| S4 | **移动端/边缘回填调用方** | `recordActuals` 端点已就绪 | 依赖业务侧（移动端排期） |
| S5 | **CP-SAT worker 生产部署** | Dockerfile + compose 已就绪 | 外部环境依赖（服务器 + 构建镜像） |

### 2.2 前端体验深化（P1/P2）

| # | 项 | 现状 | 说明 |
|---|----|------|------|
| F1 | **组件拆分**：CommandMap 902 行 / FactoryMap 1328 行 | 走读 H5 | 拆状态机（useReducer）+ 分层组件（Layout/Layers/Overlay） |
| F2 | **bundle 预算验证** | bundle-budget.mjs 已存在 | 跑 `npm run build:prod:standalone` + 预算门禁（首屏 <460kB） |
| F3 | **地图执行偏差图层** | IntelligenceLayers 骨架有，数据源已就绪 | execution.deviation 已推送，消费到图层渲染 |
| F4 | **冲突中心 → 地图高亮** | onLocateEntity 已接线 | 补地图侧高亮样式 + 自动聚焦 |

### 2.3 工程治理收尾（P2）

| # | 项 | 现状证据 | 说明 |
|---|----|----------|------|
| G1 | **OPEN-DECISIONS 登记册** | docs/decisions/ 不存在 | 按规范创建，登记 RLS 覆盖策略、CP-SAT 启用、lark-cli 异步化三个未决项 |
| G2 | **verify 其余硬编码** | workbench (2,6,1) / scheduling 计数 | 与 G5 同法从 manifest 派生 |
| G3 | **SECURITY.md 边界补充** | 全局表未声明 | 补充 world_state_snapshot/outbox 为"全局共享表"边界说明 |
| G4 | **route-manifest CI 门禁** | 已入库未接 CI | audit-openapi-routes 接入 CI 工作流 |
| G5 | **ADR 补充** | 多批次决策无 ADR | 权重收敛/事件级联/CP-SAT worker 三条 ADR（MADR 格式） |

### 2.4 飞书侧车（P3，外部依赖）

| # | 项 | 说明 |
|---|----|------|
| FEA1 | 多实例支持 | PostgreSQL/Redis 迁移规划（webhook_dedup 单写限制） |
| FEA2 | 真实飞书联调 | lark-cli 授权 + Base 表权限（外部环境） |

---

## 三、分阶段实施计划

### Batch 10：调度闭环补全 + 前端深化（P1，后端为主）

**目标**：任务写路径接入事件驱动；前端组件拆分降低维护成本。

| 步骤 | 内容 | 影响范围 | 验证门禁 |
|------|------|----------|----------|
| 10.1 | **TASK_CREATED/UPDATED 接线**：TaskService 创建/更新后 fire-and-forget 调 `injectSchedulingEvent`（可选注入，避免 TaskModule→SchedulerModule 循环？**需验证依赖图**：TaskModule 是叶子，SchedulerModule imports TaskModule——反向注入会成环。**裁定**：在 TaskController 层注入，或经事件注入端点 HTTP 调用） | task 模块 + 事件注入 | type:check + jest |
| 10.2 | **影子评估自动化**：SchedulerService 每 N 次 run 后调用 comparePolicyVersion（已有）→ 落评估记录 | scheduler.service + 测试 | jest（policy-version） |
| 10.3 | **CommandMap 状态机化**：mode/level/replayMode 三态收敛为 useReducer（消除手写 effect 联动） | CommandMap.tsx | type:check + 前端测试 |
| 10.4 | **FactoryMap 分层拆分**：拆 StaticLayer/EntityLayer/ScheduleOverlay（只拆渲染函数，不改变行为） | FactoryMap.tsx | type:check + 视觉回归 |
| 10.5 | **bundle 预算验证**：构建 + 预算门禁 | client | build:prod:standalone + bundle-budget |

**提交**：`feat(scheduler): task-write event wiring + shadow eval` / `refactor(command-map): state machine + layer split`

### Batch 11：工程治理收尾（P2，低风险纯文档/脚本）

**目标**：补齐工程纪律资产（OPEN-DECISIONS/ADR/安全边界），消除剩余硬编码。

| 步骤 | 内容 | 影响范围 | 验证门禁 |
|------|------|----------|----------|
| 11.1 | 创建 `docs/decisions/OPEN-DECISIONS.md`，登记 3 个未决项（RLS 覆盖/CP-SAT 启用/lark-cli 异步化） | docs | 无（文档） |
| 11.2 | verify workbench/scheduling 期望值从 manifest 派生（G5 同法） | run_migrations.js | node --check |
| 11.3 | SECURITY.md 补充全局共享表边界声明 | SECURITY.md | 无（文档） |
| 11.4 | 三条 ADR（权重收敛/事件级联/CP-SAT worker） | docs/decisions | 无（文档） |
| 11.5 | CI 工作流接入 audit-openapi-routes + truth-check | .github/workflows | 触发验证 |

**提交**：`docs(governance): OPEN-DECISIONS + ADRs + security boundaries` / `chore(ci): route audit gate` / `refactor(db): manifest-driven verify expectations`

### Batch 12：外部依赖与收尾（P3，按条件启）

| 项 | 前置条件 |
|----|----------|
| CP-SAT worker 生产部署 | 服务器环境（docker compose -f deploy/cloud/docker-compose.standalone.yml --profile optional up -d cpsat） |
| 移动端回填接入 | 移动端排期（recordActuals 端点已就绪） |
| 飞书真实联调 | lark-cli 授权 + Base 表权限 |
| resource.state_changed SSE | 节流方案设计（合并窗口）后实施 |
| 飞书多实例 | 部署规模决策（PostgreSQL/Redis） |

---

## 四、依赖与优先级

```
Batch 10（P1，后端能力 + 前端结构）→ Batch 11（P2，纯文档/脚本，可与 10 并行）
Batch 12（P3，全部外部依赖，随时按条件启）
```

**关键风险**：
- 10.1 的 TaskModule→SchedulerModule 循环依赖：**已预判**，备选方案（controller 层接线/HTTP 调用）需实施时验证
- 10.3/10.4 前端拆分：只拆不改行为，靠 type:check + 前端 23 tests + 视觉回归守护
- 11.2 verify 派生：与 G5 同模式，已有一致实现参考

## 五、完成标准（DoD）

- [ ] 代码/文档变更完成，模块职责清晰
- [ ] type:check（node + app）全绿
- [ ] 相关 jest 测试全绿（新增 + 既有无回归）
- [ ] OpenAPI 路由零漂移（新增端点时）
- [ ] 独立 commit + push
