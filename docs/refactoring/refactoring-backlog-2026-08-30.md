# EWOH 重构要点清单（2026-08-30）

> 排序原则：回归风险防护价值 × 变更频率 × 收益/成本比。每项含位置/问题/收益/操作。
> 执行约束：每项独立成 PR，先补特征测试再动手；不与功能变更混批。

---

## P0-1 错误消息三元表达式抽取为统一工具

- **位置**：`err instanceof Error ? err.message : String(err)/undefined` 全仓 **119 处**（client 34 个页面文件 + server 多模块）
- **问题**：同一防御性三元在 119 处复制；`errorContract.ts` 的 `parseError`（分类/脱敏/requestId/中文文案）仅 2 个文件消费——精心设计的错误契约被 151 处裸 `toast.error` 绕过，脱敏策略存在被新代码绕过的持续风险
- **收益**：脱敏/文案单点收敛；错误展示行为全站一致；新增页面不可能再绕过契约
- **操作**：① `lib/errorContract.ts` 导出 `errorMessage(err, fallback?)`；② codemod 逐文件替换三元为该函数；③ `onError` 样板替换为 `mutationErrorToast('操作名')` helper；④ ESLint `no-restricted-syntax` 禁止新写裸三元（防回潮）

## P0-2 状态徽章映射统一（9 处重复 → 1）

- **位置**：`ScheduleDialogs.statusBadgeClass`、`SolverStatusChain.STEP_CLASSES`、`DecisionCockpit` 状态色表、`DataFreshnessBadge.FRESHNESS_STATUS_CLASSES`、`DataSourceBadge`、`PlanStatusStepper`、`ExecutionDeviationList`、`ResourcePoolPanel`、`Timeline` —— 9 个文件各自维护「状态 → `bg-risk-*/20 text-risk-*-foreground border-*`」映射
- **问题**：同语义映射 9 份拷贝；2026-08-29 对比度修复被迫全库替换 75 处即是此结构的直接代价；新增状态需改 9 处，遗漏即样式漂移
- **收益**：新增/调整状态色改 1 处生效全站；对比度审计从「全库扫描」降为「单文件」
- **操作**：① 新建 `lib/statusTone.ts`：`type Tone = 'normal'|'degraded'|'offline'|'blocked'|'conflict'|'unknown'` + `toneBadgeClass(tone)` 与 `toneTextClass(tone)`；② 9 个文件改引用（机械映射搬运）；③ `lint-design-tokens` 增规则：禁在 pages/ 内硬编码 `bg-risk-`/`text-risk-` 组合

## P0-3 时间格式化工具统一（12+ 处重复 → 1）

- **位置**：`formatTime`/`toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false })` 在 Timeline、Scale、Scheduling、WorkOrchestration×4、commandCenterLogic、credibility、appContext 等 **12+ 文件**重复定义
- **问题**：时区策略硬编码 12 份；「3s 前」相对时间各页自行拼装；测试各测各的
- **收益**：时区/格式策略单点；未来 i18n 改 1 处；删除约 150 行重复
- **操作**：`lib/datetime.ts` 导出 `formatTime / formatDateTime / formatRelative`（dayjs 已在依赖）；逐文件替换；`no-restricted-syntax` 禁新增裸 `toLocaleString('zh-CN'`

## P1-4 scale.service.ts 按域拆分（43 方法巨石）

- **位置**：`server/modules/scale/scale.service.ts`（55.7KB / **43 个方法**）
- **问题**：单一 service 承载工厂模板/连接器/字段映射/影子运行/Fleet 升级回滚等多个域；任何一域改动都要重读 55KB；测试文件同样巨型
- **收益**：域内改动脉络清晰；测试按域拆分；为后续工厂复制功能扩展提供落点
- **操作**：沿用 scheduler 模块已验证的 Strangler 模式——`scale-*.service.ts` 组合件 + 门面 service 手工装配；先拆「Fleet 升级回滚」与「字段映射」两个最独立域

## P1-5 heuristic-scheduling-solver 拆分（81KB 单类）

- **位置**：`server/modules/scheduler/heuristic-scheduling-solver.ts`（81.4KB，`HeuristicSchedulingSolver` + `CompactRejectBuffer`，16 方法）
- **问题**：确定性贪心核心 + 多目标评分 + 候选池消费 + 拒绝缓冲全部内联；Golden TCK 已锁行为，但可读性影响求解参数调优与 CP-SAT parity 维护
- **收益**：评分函数独立后可单测热路径；parity 对齐时差异定位从 81KB 缩到评分模块
- **操作**：抽 `solver/scoring.ts`（scoreBreakdown 计算）、`solver/candidate-filter.ts`（资格过滤消费）、`CompactRejectBuffer` 移独立文件；类对外接口不变（Golden TCK 作回归闸）

## P1-6 scheduler.service 装配模式收尾

- **位置**：`server/modules/scheduler/scheduler.service.ts`（408 行，构造函数内 **8 个 `new`**）+ 已拆出的 9 个组合件
- **问题**：Strangler 重构完成一半——逻辑已拆件，但装配中心仍在构造函数内手工初始化，组合件间依赖关系不可见、测试需真实宿主
- **收益**：组合件可独立测试；新增组合件不再触碰宿主构造函数
- **操作**：装配改 `providers` 工厂 token（每件一个 `useFactory`），或至少抽 `buildSchedulerComponents(deps)` 纯函数；ESLint 例外注释（2026-08-29 已加）随重构更新

## P1-7 work-orchestration.service 按域拆分

- **位置**：`server/modules/work-orchestration/work-orchestration.service.ts`（52.1KB）同时承载 gates / handoffs / git-sync / site-readiness 四域
- **问题**：四域路由共用一个 service，域间无边界；`52` 行 controller 注入点集中
- **收益**：域边界清晰；handoffs/gates 各自演进不互扰
- **操作**：同 P1-4 模式；controller 保持路由聚合，service 按域委托

## P2-8 生成物移出源码扫描路径

- **位置**：`client/src/types/openapi.d.ts`（**634KB**）、`server/database/schema.ts`（142.8KB，`gen:db-schema` 生成）
- **问题**：生成物与手写源码同目录；每次 tsc/eslint 全量扫描 78 万行生成代码；grep 证据被淹没（本次重构审计中反复出现）
- **收益**：扫描提速、审计信噪比提升、防止误手改生成物
- **操作**：生成物移 `generated/` 目录 + tsconfig `exclude`/eslint `ignorePatterns`；`gen:openapi`/`gen:db-schema` 输出路径同步更新

## P2-9 invalidateQueries 失效编排收敛（82 处散点）

- **位置**：`queryClient.invalidateQueries({ queryKey: ... })` 全 client **82 处**；「workbench + order 双失效」成对模式散布
- **问题**：失效组合靠记忆复制；漏失效即「改了不刷新」类缺陷
- **收益**：失效组合语义化（`invalidateAfterStepTransition(queryClient, orderId)`）；成对关系单点维护
- **操作**：`hooks/queryKeys.ts` 内按域导出失效组合函数；mobile 域先行试点

## P2-10 Operations 七 tab 拆组件文件

- **位置**：`pages/Operations/Operations.tsx`（46.1KB，7 tab 条件渲染同文件）
- **问题**：URL 同步已落地（本轮），但 7 个 tab 的 JSX/mutation 仍同文件，单文件持续膨胀
- **收益**：按 tab 懒加载（bundle 减重）；各 tab 独立演进
- **操作**：每 tab 一文件 + `lazy` 路由级分包（`Devices` 426KB chunk 已是前车之鉴）

## P2-11 CommandMapShell / FactoryMap 分帧

- **位置**：`CommandMapShell.tsx`（48.6KB）/ `FactoryMap.tsx`（48.6KB）
- **问题**：壳层 + 5 workspace + 顶栏 + 帮助对话框同文件；地图渲染层与业务状态耦合
- **收益**：渲染层（FactoryMap）可与业务壳并行演进；workspace 懒加载边界更干净
- **操作**：优先抽 TopBar/帮助对话框/快捷键处理三块（与地图无状态纠缠的低风险部分）

---

## 执行建议

1. **批次策略**：P0-1/2/3 为机械替换类，可合并一个批次（预计 1-2 天 + 全量回归）；P1 各项独立 PR 串行。
2. **回归闸**：每批次跑 `type:check + jest(2253/1183) + eslint + audit-regression-gates + UX E2E 矩阵`（全部现成）。
3. **不建议动的**：`scheduler.service.ts` 的手工组合模式本身（Strangler 有意为之）、`schema.ts` 内容（生成物只挪不改）、Golden TCK 锁定的求解行为。
