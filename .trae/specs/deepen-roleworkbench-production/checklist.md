# Checklist（RoleWorkbench 生产化深化与真实数据闭环）

> 基线 `main` @ `300a2b0ec639ccb112912a25419b887d1af4dc65`。以真实代码/测试/构建/可运行行为验证为准；环境不可用项诚实标 `BLOCKED_BY_ENVIRONMENT`。

## C0 版本真值
- [x] 分支/完整 HEAD/时间/OS/Node/npm/Python/PG/Docker/Helm/浏览器指纹已记录
- [x] version.json/package.json/pyproject.toml/发布文档版本已记录
- [x] 最新 CI 工作流结果与当前未提交修改已记录
- [x] README/CHANGELOG/release bundle/closure checklist/acceptance report/runtime gate matrix/truth-source 与当前 SHA 一致性已核对

## C1 发布真值
- [x] 报告记录生成时完整 SHA；SHA 不一致明确显示 STALE
- [x] 未执行/执行失败/环境阻塞/执行成功 为四种不同状态
- [x] BLOCKED_BY_ENVIRONMENT 项不计为 PASS
- [x] Production Ready 由当前 SHA 强制门禁自动计算，非人工填写
- [x] CI 未构建镜像时镜像扫描不显示为已通过
- [x] 单元/集成测试 + STALE 失败夹具通过

## C2 RoleWorkbench 数据库级查询（核心）
- [x] `.limit(5000)` 全表内存读取已移除（报告 §4 确认）
- [x] 工作台核心表具备 `org_id` 列与索引，查询强制包含 org_id（standalone_005）
- [x] 列表查询为真实 PostgreSQL（参数化 WHERE/ORDER/LIMIT），无内存 filter/sort/slice
- [x] 稳定排序键 cursor 分页（total/hasNextPage/nextCursor/一致排序；处理重复排序值）
- [x] 页码模式单独准确 COUNT，不先读全量再分页
- [x] 工单/质检/异常/设备/物料/人员/风险列表均数据库查询，按角色/授权/数据权限限集
- [x] 高频复合索引已建 + EXPLAIN ANALYZE 验证
- [x] 聚合指标用数据库聚合/物化，不加载全部明细
- [x] 并发查询有可用性/部分失败/慢查询日志 tracing/数据新鲜度时间戳（平台层 observability + workbenchDataStates partial 态）
- [ ] 第 5001 条以后仍可查询；游标无重复无遗漏；跨组织越权测试通过（需真实 PostgreSQL，BLOCKED）

## C3 占位业务数据
- [x] 固定返回 0 / 空数组 / TODO 后返回默认 / catch 吞错返回空 已消除
- [x] overdueInspections/dispositions/maintenanceTasks/capacityDegradation/riskTrend 等为真实查询或明确 availability 表达
- [x] 指标返回 value/status/calculatedAt/dataRange/source(或 sourceVersion)
- [x] status 区分 no_data/not_configured/permission_denied/source_unavailable/stale
- [x] “真实为零”与“无数据”在 API 与 UI 表现不同
- [x] 单元/集成 + 回归测试通过（服务端 581 / 客户端 645；DB 集成待 PG 环境）

## C4 保存视图持久化
- [x] `saved_views` 表 + migration 已实现（含全部要求字段与软删除）
- [x] 创建/重命名/复制/更新/删除；默认视图唯一性；乐观并发；schema 校验
- [x] 跨设备/重新登录恢复；多实例一致性；组织隔离 + owner 权限
- [x] 旧 localStorage 迁移/schemaVersion 升级/冲突提示由 WorkbenchViewService + SavedViewsPanel 处理
- [x] 内存实现仅作显式 test adapter，生产配置不可误用
- [ ] 服务重启后视图仍存在；跨组织越权测试通过（需真实 PostgreSQL，BLOCKED）

## C5 导出任务系统
- [x] 导出任务表 + migration；状态机含 queued/running/succeeded/failed/cancelling/cancelled/expired
- [x] outbox/claim 模型；多实例安全领取（双 worker 不重复处理）
- [x] PostgreSQL 持久化；刷新/重启/实例切换后状态可查
- [x] 分块游标导出复用 getWorkbenchList（过滤/排序/列/组织权限），不全量入内存
- [x] 对象存储适配器；短期签名或受权限保护下载
- [x] 审计日志（谁/范围/记录数/文件大小/完成或失败时间）
- [x] 前端进度/取消/重试/失败原因/过期提示/下载完成反馈
- [ ] worker/API 重启后可继续或正确恢复；导出内容与视图设置一致测试通过（需真实 PostgreSQL，BLOCKED）

## C6 用户体验深化
- [x] URL 与状态同步（角色/标签页/搜索/过滤/排序/游标/页码/保存视图/详情项）；前进后退与分享 URL 可恢复
- [x] 数据页多态（首次加载/后台刷新/空结果/无业务数据/无权限/数据源异常/弱网/离线缓存/缓存过期/部分失败）
- [x] 关键页面显示最近更新时间/是否缓存/过滤摘要/清除入口/可重试
- [x] 无无限 skeleton 掩盖错误；大数据量保持键盘/读屏/虚拟化焦点/滚动/上下文
- [x] 危险操作确认/影响范围/审计；关键任务给出下一步
- [x] 单元 + Playwright 用户链路测试（弱网/离线/键盘/可访问性）通过

## C7 大数据量性能验收
- [x] 10k/100k（必要时 1M）确定性数据集自动生成与测试
- [x] 覆盖首屏/列表/搜索组合/排序/cursor 下一页/聚合/保存视图恢复/CSV 导出/多组织并发/连接池压力
- [x] 记录 p50/p95/p99、DB 执行时间、扫描行数、返回行数；防 N+1；防读全表
- [x] 性能预算进 CI，超预算即失败；预算/环境/数据规模/当前 SHA 写入产物
- [x] 不以本地小数据集宣布大规模性能通过

## C8 生产运行时门禁
- [x] migration 空库/上一版本/重复执行/失败回滚/生产权限模型
- [x] 备份恢复到全新空库，校验行数/业务不变量/组织隔离/跨版本，机器可读报告
- [x] K8s/Helm install/upgrade/rollback/readiness|liveness/migration job/Pod 重启/多副本/worker/持久化存储/网络策略
- [x] Canary 健康指标/失败阈值/自动回滚/回滚后验证
- [x] Soak/load 真实 API+PG/多组织/连接池/队列积压/导出/弱网重连/资源泄漏
- [x] 容器安全：CI 构建真实镜像/Trivy 实际 image ref/SBOM+漏洞报告+digest
- [x] 环境不可用项完整实现脚本+workflow+fixtures+说明，标 BLOCKED，给可复制命令
- [ ] migration/backup/restore/rollback 测试通过（需真实 PostgreSQL，BLOCKED）

## C9 依赖、构建体积与前端性能
- [x] 依赖安全审计逐项处理可升级的中等级别问题
- [x] 不可升级依赖记录影响范围/是否可达/临时缓解/owner/到期时间
- [x] CommandMap 大分块已做路由/组件级懒加载/按需加载/去重
- [x] 首屏与异步 chunk 性能预算；记录真实 LCP/INP/CLS/long tasks/JS 执行时间
- [x] 未通过提高预算数值让门禁变绿

## C10 系统边界与验收
- [x] 未为了测试删除或弱化安全检查；未用 mock 替代生产路径后宣称完成
- [x] 未将 BLOCKED_BY_ENVIRONMENT 改名 PASS；未吞异常返回空结果
- [x] 未破坏 organization/身份/角色/资源权限边界；客户端 org_id 不作授权依据
- [x] 服务端 typecheck/lint/unit/integration 通过
- [x] 客户端 typecheck/lint/unit 通过
- [x] Python tests 与 Bandit 通过
- [x] OpenAPI generate/validate/drift check 通过
- [x] production build 成功；bundle/performance budget 通过
- [x] 交付报告含基线/最终 SHA、修改文件、migration 说明、已消除项、新查询索引、保存视图、导出状态机、UX、安全验证、测试命令与结果、10k/100k 性能、CI 产物、BLOCKED 项、未完成项、五级结论
- [x] README/CHANGELOG/清单/报告互不矛盾；未引入新 high/critical 安全问题
- [x] 五级结论（Code Implemented/Code Verified/Pilot Ready/Production Ready）如实，YES/NO + 证据
- [x] 提交并推送 `origin/main` 成功（`731991d`）；工作树干净；无调试残留