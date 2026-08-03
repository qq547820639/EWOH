# Tasks

> 基于 `0.6.0-rc4` 真实代码执行"代码深化、工业用户体验产品化和真实试点准备"迭代。
> 先只读审计（Phase 0），再 P0（UX-001..005）、P1（UX-006..010），最后独立验证与验收（Phase 4）。
> 边界：先审计后改码；不伪造证据；G10-G13 不标记 Passed；保持 C1-C9/RLS/审计链/状态机/安全边界；实现 Agent 不得自我验证高风险项。

## Phase 0：只读审计（先于任何大规模修改）
- [ ] Task 0.1: 审计仓库事实与产物
  - [ ] 0.1.1 读取 README / CHANGELOG / release manifest（`docs/delivery/release-manifest.yaml`、`release/ewoh-0.6.0-rc4/`）
  - [ ] 0.1.2 读取 `.codex/artifacts` 下 state.json / task-board.md / task-graph.md / gates.md / agent-registry.md / decision-log.md / risk-register.md / contracts / work-packages / evidence
  - [ ] 0.1.3 读取 OpenAPI（`openapi/ewoh.yaml`、`work-orchestration.yaml`）、DB 生成器/迁移/RLS/回滚脚本
  - [ ] 0.1.4 读取 `WorkOrchestration.tsx`、`RoleWorkbench.tsx`、`MobileWorkbench.tsx`、Layout/路由/设计系统/错误处理/API client
  - [ ] 0.1.5 读取 Site Readiness / Git Sync / Gate Engine / Work Indexer / Resource Registry / Handoff Service
  - [ ] 0.1.6 读取 Playwright / E2E / 单元 / 性能 / 安全 / 发布检查脚本
- [ ] Task 0.2: 产出并提交审计报告 `docs/reviews/rc4-code-ux-productization-gap.md`
  - [ ] 0.2.1 已实现能力及代码位置
  - [ ] 0.2.2 仓库自报证据 vs 独立复验结果差异
  - [ ] 0.2.3 任务状态与 Gate 状态冲突
  - [ ] 0.2.4 生产环境与真实工厂外部阻塞项
  - [ ] 0.2.5 超过 800 行页面或高耦合模块清单
  - [ ] 0.2.6 原始字段/JSON/技术术语直接暴露终端的页面清单
  - [ ] 0.2.7 离线/附件/冲突/弱网/恢复风险
  - [ ] 0.2.8 无障碍/性能/可观测性/测试覆盖差距
  - [ ] 0.2.9 P0/P1/P2 排序
  - [ ] 0.2.10 每项改动的依赖/代码所有权/风险/验收方法
  - [ ] 0.2.11 提交审计报告（仅提交报告，不提交大规模改动）

## Phase 1：P0 实施
- [ ] Task 1（UX-001）：角色工作台产品化
  - [ ] 1.1 定义角色 Schema 驱动（操作员/质检员/计划员/班组长/厂长）独立视图配置
  - [ ] 1.2 中文业务标签、单位、时间、百分比、状态、枚举格式化
  - [ ] 1.3 普通用户模式禁止直接显示原始对象 JSON；仅开发者诊断模式显示
  - [ ] 1.4 KPI 定义/数据来源/更新时间/异常解释
  - [ ] 1.5 排序/筛选/保存视图/导出/下钻
  - [ ] 1.6 订单/工单/工序/设备/人员/质量/告警语义链接
  - [ ] 1.7 角色专属快捷动作
  - [ ] 1.8 空/加载/部分失败/权限不足状态
  - [ ] 1.9 后端 role aggregation 对齐新 schema（如需要补充字段）
- [ ] Task 2（UX-002）：因果执行控制台模块化与体验升级
  - [ ] 2.1 建立大型图性能基线脚本并记录实测数据（不得伪造）
  - [ ] 2.2 定义并写入 CI 性能预算
  - [ ] 2.3 拆分 WorkOrchestration 单体为模块：Work Graph / Gate / Evidence / Agent / Risk / Resource / Handoff / Catalog / Git Sync / Site Readiness
  - [ ] 2.4 URL 可恢复的筛选、选中节点、图层、时间范围
  - [ ] 2.5 关键路径/阻塞传播/失败回流/过期证据高亮
  - [ ] 2.6 节点深链接
  - [ ] 2.7 缩略图/可调整面板/保存视图
  - [ ] 2.8 键盘选择/移动/打开/返回
  - [ ] 2.9 大图虚拟化或适配大型 DAG 渲染方案
  - [ ] 2.10 Agent/CI/Git/Gate 状态增量刷新
  - [ ] 2.11 Gate 决策影响预览
  - [ ] 2.12 批准/驳回/条件批准/撤销/历史 Diff
  - [ ] 2.13 所有写操作显示 actor/reason/source/timestamp/rollback point
- [ ] Task 3（UX-003）：移动工作台 Offline-first 升级
  - [ ] 3.1 IndexedDB 持久化任务/步骤/草稿/附件/同步状态
  - [ ] 3.2 图片压缩/容量限制/断点续传/失败重试
  - [ ] 3.3 刷新/重启后数据不丢失
  - [ ] 3.4 本地 vs 服务端冲突检测，展示"本地值/服务端值/差异/推荐选择"
  - [ ] 3.5 自动保存草稿
  - [ ] 3.6 断网状态中心/待同步数量/最后同步时间
  - [ ] 3.7 相机二维码/条码扫描 + 扫码枪键盘输入模式
  - [ ] 3.8 扫描成功/失败/重复声音或震动反馈
  - [ ] 3.9 大触控区域/横屏/低端工业平板适配
  - [ ] 3.10 每个离线操作幂等键 + 完整审计记录
  - [ ] 3.11 校验离线操作不绕过质量/安全/权限/审批状态机
- [ ] Task 4（UX-004）：统一错误恢复体验
  - [ ] 4.1 提取统一错误组件（errorCode/recommendedAction/requestId/重试/返回安全状态/保存草稿/复制诊断信息）
  - [ ] 4.2 权限不足/业务校验失败/连接失败/服务器故障差异化表达
  - [ ] 4.3 在全部最终用户页面接入统一错误组件
  - [ ] 4.4 局部请求失败不导致整页不可操作
- [ ] Task 5（UX-005）：Site Readiness 实施向导
  - [ ] 5.1 环境/工具自动探测
  - [ ] 5.2 数据库/K8s/Helm/对象存储/真实设备检查
  - [ ] 5.3 ERP/设备/组织/身份映射向导
  - [ ] 5.4 Mapping Dry Run
  - [ ] 5.5 导入前后差异预览
  - [ ] 5.6 缺失证据/责任人/截止时间
  - [ ] 5.7 自动修复建议（未经批准不改生产环境）
  - [ ] 5.8 培训/生产批准/业务签署
  - [ ] 5.9 导出可审计验收包/交接包/未决项清单

## Phase 2：P1 实施
- [ ] Task 6（UX-006）：全局应用外壳
  - [ ] 6.1 组织/工厂/产线/环境切换
  - [ ] 6.2 当前版本与数据新鲜度
  - [ ] 6.3 在线/离线/降级状态
  - [ ] 6.4 面包屑
  - [ ] 6.5 全局搜索
  - [ ] 6.6 命令面板
  - [ ] 6.7 最近访问
  - [ ] 6.8 收藏视图
  - [ ] 6.9 未处理风险/审批/同步失败入口
  - [ ] 6.10 所有页面明确当前操作组织/工厂/环境/数据版本
- [ ] Task 7（UX-007）：无障碍与设计系统
  - [ ] 7.1 完整键盘操作/清晰焦点/跳转主内容
  - [ ] 7.2 不只靠颜色表达状态
  - [ ] 7.3 屏幕阅读器语义/对话框焦点管理
  - [ ] 7.4 图表与 DAG 文本替代视图
  - [ ] 7.5 高对比度/触控目标尺寸
  - [ ] 7.6 自动化 axe 检查
  - [ ] 7.7 中文优先+预留 i18n 结构
  - [ ] 7.8 核心流程无 Critical/Serious；无法修复项形成批准例外记录
- [ ] Task 8（UX-008）：性能工程
  - [ ] 8.1 建立并写入 CI 性能预算（首屏/路由切换/大表格/大型 Work Graph/世界回放/移动离线队列/图片处理/API p95/慢查询/低端平板）
  - [ ] 8.2 服务端分页/虚拟列表/按需加载/路由预取/缓存/增量更新
  - [ ] 8.3 优化前后可重复基准数据报告
- [ ] Task 9（UX-009）：端到端体验测试矩阵
  - [ ] 9.1 扩展 Playwright 覆盖角色/登录/权限/会话过期/网络/离线/重启/冲突/扫码/照片/E-SOP/质量/Gate/Handoff/Git Sync/Site Readiness/视觉回归/无障碍/多视口
  - [ ] 9.2 断言最终用户可见状态/动作/数据一致性（不只 HTTP 200）
  - [ ] 9.3 接入 CI
- [ ] Task 10（UX-010）：GitHub 与实时协作闭环
  - [ ] 10.1 WorkItem↔Issue/PR 可追踪映射
  - [ ] 10.2 Dry Run/变更预览
  - [ ] 10.3 冲突检测
  - [ ] 10.4 CI 状态回写
  - [ ] 10.5 审批后执行
  - [ ] 10.6 失败补偿
  - [ ] 10.7 重复事件幂等
  - [ ] 10.8 Webhook/轮询增量同步
  - [ ] 10.9 Agent/PR/测试/Evidence/Gate 统一时间线
  - [ ] 10.10 未经批准不得创建/合并/关闭高风险 PR

## Phase 3：OpenAPI/契约/状态机/迁移收口
- [ ] Task 11：变更契约与迁移收口
  - [ ] 11.1 新增 API 进入 OpenAPI 与契约测试
  - [ ] 11.2 新增状态进入状态机/审计/错误契约
  - [ ] 11.3 数据库增量迁移与回滚脚本 + 兼容性说明
  - [ ] 11.4 更新 repo-facts 事实文件（测试数量增长同步更新）

## Phase 4：独立验证与验收
- [ ] Task 12：独立验证 Agent 运行工程检查
  - [ ] 12.1 `bash scripts/standalone-check.sh`
  - [ ] 12.2 `bash scripts/pilot-readiness-check.sh`
  - [ ] 12.3 `node scripts/audit-repo-facts.js --strict`
  - [ ] 12.4 `node tools/work-indexer/index.js --root . --invariants`
  - [ ] 12.5 `node tools/work-console/index.js --root . --output output/work-console.json --strict`
  - [ ] 12.6 服务端 typecheck/lint/unit/E2E
  - [ ] 12.7 客户端 typecheck/lint/unit
  - [ ] 12.8 Playwright / axe / OpenAPI 一致性 / DB 新鲜安装/升级/RLS/回滚 / 安全扫描 / 性能基准 / 视觉回归
  - [ ] 12.9 保存全部原始输出到 evidence
- [ ] Task 13：产出 15 项最终交付物
  - [ ] 13.1 审计报告
  - [ ] 13.2 P0/P1 实施清单
  - [ ] 13.3 每个任务修改文件与提交 SHA
  - [ ] 13.4 架构与组件拆分说明
  - [ ] 13.5 数据迁移与回滚说明
  - [ ] 13.6 OpenAPI 与契约差异
  - [ ] 13.7 关键页面前后截图
  - [ ] 13.8 自动化测试原始结果
  - [ ] 13.9 性能前后对比
  - [ ] 13.10 无障碍报告
  - [ ] 13.11 安全扫描结果
  - [ ] 13.12 未完成项与外部阻塞项
  - [ ] 13.13 G0-G13 影响说明
  - [ ] 13.14 建议进入真实第二工厂验证的条件
  - [ ] 13.15 明确区分 已实现/仓库报告通过/独立复验通过/需要真实环境/需要人类批准

# Task Dependencies
- Task 0.1 → Task 0.2（先审计后报告）
- Task 0.2 优先于所有 Phase 1/2 实施（先审计后改码）
- Task 1/2/3/4/5（UX-001..005）可并行（独立模块）
- Task 6/7/8/9/10（UX-006..010）依赖 Phase 1 基础模块落地
- Task 11 依赖 Phase 1/2 全部 API/状态
- Task 12 依赖 Task 11 收口
- Task 13 依赖 Task 12 验证通过
- 高风险任务（UX-002 大图性能、UX-003 离线、UX-010 Git Sync）由独立验证 Agent 复核，不由实现 Agent 自签