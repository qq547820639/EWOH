# Tasks

> 基线：`main` @ `300a2b0ec639ccb112912a25419b887d1af4dc65`。原则：每项以真实代码/测试/运行结果验证为准；环境不可用 → 如实标 `BLOCKED_BY_ENVIRONMENT` 并给出可复制命令，不伪造通过。
> 完成即提交并推送 `origin/main`（排除调试残留）。

- [x] Task 0: 当前版本真值基线

  - [ ] 记录分支/完整 HEAD/时间/OS/Node/npm/Python/PG/Docker/Helm/浏览器版本；`version.json`/`package.json`/Python `pyproject.toml`/发布文档版本
  - [ ] 记录最新 CI 工作流结果与当前未提交修改（`git status`）
  - [ ] 只读核对 README/CHANGELOG/release bundle/closure checklist/acceptance report/runtime gate matrix/truth-source 产物与当前 SHA 是否一致
  - [ ] 产出基线指纹到 `output/`（机器可读）

- [x] Task 1: 发布真值（SHA 绑定 + 四态 + Production Ready 自动计算）

  - [ ] 扩展 `truth-source.js`/`truth-manifest.js`：报告记录生成时完整 SHA；SHA 不一致显示 STALE
  - [ ] 区分四种状态：未执行 / 执行失败 / 环境阻塞 / 执行成功；`BLOCKED_BY_ENVIRONMENT` 不得计为 PASS
  - [ ] `Production Ready` 由当前 SHA 强制门禁结果自动计算，禁止人工填写
  - [ ] 镜像扫描：CI 未构建镜像时不得显示为已通过（Trivy 步骤在无 image ref 时明确 BLOCKED）
  - [ ] 单元/集成测试 + STALE 失败夹具通过

- [x] Task 2: RoleWorkbench 数据库级查询（核心）

  - [ ] 定位并移除 `.limit(5000)` 全表内存读取（`role-workbench.service.ts` 6 处）
  - [ ] 为工作台核心表迁移/新增 `org_id` 列（`ewoh_schedule_task`、`ewoh_event`、`ewoh_world_state`、`ewoh_spatial_entity`、`ewoh_resource_binding` 等）+ 索引
  - [ ] 重写列表查询为真实 PostgreSQL：参数化 WHERE（含强制 org_id）/ ORDER BY / LIMIT；删除内存 filter/sort/slice
  - [ ] 实现稳定排序键 cursor 分页（协议：total/hasNextPage/nextCursor/一致性排序；处理相同时间戳/优先级重复值）
  - [ ] 页码模式单独实现准确 COUNT（不先读全量再分页）
  - [ ] 工单/质检/异常/设备/物料/人员/风险列表均走数据库查询；按角色/资源授权/数据权限限制结果集
  - [ ] 高频复合索引（org_id/status/assignee/role/occurred_at|created_at|updated_at/priority/稳定唯一键）+ EXPLAIN ANALYZE 验证
  - [ ] 聚合指标（总量/逾期/风险/趋势）用数据库聚合或验证过的物化/缓存，不加载全部明细
  - [ ] 同一工作台页并发查询：明确超时 / AbortSignal 取消 / 部分失败状态 / 慢查询日志与 tracing / 数据新鲜度时间戳
  - [ ] 单元/集成/HTTP+PG E2E/跨组织越权测试；第 5001 条以后仍可查询；游标无重复无遗漏

- [x] Task 3: 消除占位业务数据

  - [ ] 全面搜索固定返回 0 / 空数组 / TODO 后返回默认 / catch 吞错返回空 的占位实现
  - [ ] `overdueInspections`、`dispositions`、`maintenanceTasks`、`capacityDegradation`、`riskTrend` 等改为真实查询/计算/组织隔离/测试
  - [ ] 无数据源的指标返回 `value/status/calculatedAt/dataRange/source(或 sourceVersion)`，status 区分 `no_data/not_configured/permission_denied/source_unavailable/stale`
  - [ ] 前端显示与状态对应的人类可理解表达；“真实为零”与“无数据”在 API 与 UI 表现不同
  - [ ] 单元/集成测试 + 回归测试

- [x] Task 4: 保存视图 PostgreSQL 持久化

  - [ ] 新增 `saved_views` 表 + migration（id/org/owner/name/workbench|role|list/schema_version/filter JSON/sort JSON/visible columns/column order/density/is_default/created_at/updated_at/deleted_at 或等效软删除）
  - [ ] 完成创建/重命名/复制/更新/删除；默认视图唯一性；乐观并发控制；输入 schema 校验
  - [ ] 跨设备与重新登录后的恢复；多实例一致性；组织隔离 + owner 权限
  - [ ] 旧 localStorage 数据一次性迁移后清理；schemaVersion 升级；冲突/迁移失败可恢复提示
  - [ ] 内存实现仅保留为显式 test adapter，生产配置不可误用
  - [ ] 单元/集成/HTTP+PG E2E/服务重启后仍存在/跨组织越权测试

- [x] Task 5: 导出任务真实任务系统

  - [ ] 新增导出任务表 + migration（状态机 queued/running/succeeded/failed/cancelling/cancelled/expired；幂等键；超时/重试/退避/失败原因）
  - [ ] outbox/claim 队列模型；多实例安全领取（原子 claim，双 worker 不重复处理）
  - [ ] PostgreSQL 持久化；页面刷新/服务重启/实例切换后状态可查
  - [ ] 流式或分块游标导出，禁止全量装入内存；复用当前保存视图/过滤/排序/列配置/组织权限
  - [ ] 导出文件存入可替换对象存储适配器；下载用短期签名或受权限保护接口
  - [ ] 审计日志：谁发起/导出范围/记录数/文件大小/完成或失败时间
  - [ ] 前端：进度/取消/重试/失败原因/过期提示/下载完成反馈
  - [ ] 单元/集成/HTTP+PG E2E/worker 重启后可继续或正确恢复/双 worker 不重复/导出内容与视图设置一致测试

- [x] Task 6: 工作台用户体验深化
  - [x] URL 与状态同步：角色/标签页/搜索/过滤/排序/游标或页码/保存视图/打开详情项；前进后退与分享 URL 可正确恢复
  - [x] 数据页明确区分：首次加载/后台刷新/空结果/无业务数据/无权限/数据源异常/弱网/离线缓存/缓存过期/部分模块失败
  - [x] 关键页面显示最近更新时间/是否缓存数据/过滤条件摘要/清除过滤入口/失败后可重试
  - [x] 避免无限 skeleton 掩盖错误；大数据量保持键盘导航/读屏语义/虚拟化不破坏焦点/更新避免滚动跳变/行操作保持上下文
  - [x] 危险或不可逆操作保留明确确认、影响范围与审计结果；关键任务给出下一步
  - [x] 单元 + Playwright 用户链路测试（弱网/离线/键盘/可访问性）

- [x] Task 7: 大数据量性能验收

  - [ ] 生成确定性测试数据集（10k / 100k，必要时 1M）并自动运行
  - [ ] 覆盖：工作台首屏/列表查询/搜索与组合过滤/排序/下一页 cursor/聚合指标/保存视图恢复/CSV 导出/多组织并发/连接池压力
  - [ ] 记录 p50/p95/p99、数据库执行时间、扫描行数、返回行数；防 N+1；防每次刷新读全表
  - [ ] 性能预算写入 CI，超预算即失败（不得仅 warning）；预算/运行环境/数据规模/当前 SHA 写入产物
  - [ ] 不凭本地小数据集宣布大规模性能通过

- [x] Task 8: 生产运行时门禁

  - [ ] PostgreSQL migration：空库升级/上一版本升级/重复执行/失败回滚/生产权限模型
  - [ ] 备份恢复：恢复全新空库/校验行数与业务不变量/校验组织隔离/跨版本恢复/机器可读报告
  - [ ] K8s/Helm：install/upgrade/rollback/readiness|liveness/migration job/Pod 重启/多副本/worker/持久化存储/网络策略
  - [ ] Canary：健康指标/失败阈值/自动回滚/回滚后业务状态验证
  - [ ] Soak/load：真实 API+PG/多组织并发/连接池/队列积压/导出任务/弱网重连/长时间资源泄漏
  - [ ] 容器安全：CI 构建真实镜像/为 Trivy 提供实际 image ref/SBOM+漏洞报告+镜像 digest
  - [ ] 环境不可用项完整实现脚本+workflow+fixtures+说明，标 `BLOCKED_BY_ENVIRONMENT`，给出可复制命令
  - [ ] migration/backup/restore/rollback 测试通过

- [x] Task 9: 依赖、构建体积与前端性能

  - [ ] 重新执行依赖安全审计，逐项处理可升级的中等级别问题
  - [ ] 不能立即升级的依赖记录影响范围/是否可达/临时缓解/owner/到期时间
  - [ ] 分析 CommandMap 及其他大分块：路由级 lazy loading/组件级动态导入/按需加载编辑器图表地图/避免重复依赖
  - [ ] 设置首屏与异步 chunk 性能预算；记录真实浏览器 LCP/INP/CLS/long tasks/JS 执行时间
  - [ ] 不以提高预算数值让门禁变绿

- [ ] Task 10: 验收与交付报告
  - [ ] 运行并记录全部验收命令及结果（本机可运行项全绿；环境不可用项如实 BLOCKED）
  - [ ] 产出 `docs/reviews/deepen-roleworkbench-production-report.md`（基线/最终 SHA、修改文件、migration 说明、已消除的内存/占位、新查询与索引、保存视图、导出状态机、UX、安全与组织隔离、测试命令与结果、10k/100k 性能、CI 产物、环境阻塞项与命令、未完成项、五级结论 YES/NO 及证据）
  - [ ] 更新 README/CHANGELOG/runtime-gates.md/truth-source 产物，确保互不矛盾
  - [ ] 提交并推送 `origin/main`（提交前排除调试残留）

# Task Dependencies
- Task 0 是基线，先行。
- Task 1/2/3/4/5 相互独立，可在 Task 0 后并行；Task 2 是核心。
- Task 6 依赖 Task 2/3 的 API 形态；Task 7 依赖 Task 2/4/5。
- Task 8/9 与 2–5 可并行。
- Task 10 依赖 Task 1–9 全部完成。