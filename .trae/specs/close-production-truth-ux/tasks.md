# Tasks

> 基线：`main` @ `5a810c70960702201f5b870c35f5be58c5373e48`。原则：每项以真实代码/测试/构建产物验证为准；环境不可用 → BLOCKED，不伪造通过。
> 完成即提交并推送 `origin/main`（排除调试残留）。

- [x] Task 0: 环境与基线指纹
  - [x] 记录 branch/完整 HEAD/时间/OS/Node/npm/Python/PostgreSQL/Docker/浏览器版本
  - [x] 只读核对 README/CHANGELOG/CI workflows/release manifest/truth-manifest/Dockerfile/Playwright 配置现状
  - [x] 运行既有可运行门禁基线并记录（typecheck/lint/jest/client/openapi/audit/build）

- [x] Task 1: P0 恢复主分支全绿（本机可运行门禁已全绿；PG/E2E/浏览器/Docker 运行时门禁为 CI-only，本机 BLOCKED）
  - [x] 干净环境 `npm ci`；以 JSON 结构化输出 `npm audit`
  - [x] 定位 high/critical 直接/传递依赖、依赖链、受影响版本与公告
  - [x] 通过升级/替换/合法 overrides/移除无用依赖修复；不用 `|| true`、低 audit level、`fix --force`、无依据 ignore
  - [x] 审计结果输出为 CI artifact + 面向人的摘要
  - [x] 升级 GitHub Actions（checkout/setup-node/setup-python/upload-artifact）到支持 Node 24 的稳定版本并固定 commit SHA（已满足）
  - [x] 完整执行 typecheck/lint/Jest/客户端测试/OpenAPI 漂移/PG 迁移+并发/E2E/浏览器矩阵/构建/Docker/仓库卫生（本机可运行项全部通过；PG/E2E/浏览器/Docker 为 CI-only，见报告 H）

- [x] Task 2: P0 统一工程事实源（验证既有 truth-manifest 实现，`make truth-check` 39/39 无漂移）
  - [x] 扩展 evidence 记录字段（SHA/branch/workflow/run id/startedAt/finishedAt/environment fingerprint/Node/npm/Python/PG/浏览器版本/artifact digest/verifier/expiration/状态）
  - [x] `truth-manifest.js` 从当前 CI run 动态派生，不再人工维护过期数字
  - [x] release manifest/版本页/关于页/交付报告引用同一 derived evidence manifest
  - [x] STALE/FAILED/BLOCKED/NOT VERIFIED 显式标注于界面与清单
  - [x] CI 漂移测试：release manifest 写 passed 但当前 workflow 失败 → 失败
  - [x] 历史测试结果明确标注为历史证据
  - [x] 单元/集成测试 + 失败夹具

- [x] Task 3: P0 修复 Playwright 浏览器矩阵（CI 配置已就绪；真实执行需 CI 运行时环境）
  - [x] CI 真实安装并执行 chromium/firefox/webkit/mobile-chromium/industrial-tablet/reduced-motion（GitHub Actions matrix 或显式 install）
  - [x] 每项目输出 JSON/JUnit 结果、HTML report、trace、失败截图、浏览器版本
  - [x] WebKit 无头受限键盘焦点测试按 BLOCKED_BY_ENVIRONMENT 处理（可复现原因 + Chromium/Firefox 证据 + 后续验证入口）
  - [x] 测试报告与 evidence manifest 浏览器通过数从实际结果派生

- [x] Task 4: P0 贯通 RoleWorkbench 生产数据路径（前端已重接服务端）
  - [x] 服务端分页/筛选/排序（cursor 协议：total/hasNextPage/nextCursor/一致排序）
  - [x] 组织隔离与 RBAC，不信任前端传入角色
  - [x] 筛选/排序/分页/选中状态同步 URL search params（可刷新/返回/复制链接）
  - [x] 服务端保存视图（创建/重命名/更新/删除/默认/权限/跨设备同步）
  - [x] CSV 导出改为服务端异步任务（进度/取消/通知/过期/权限/审计/最大行数/脱敏）
  - [x] 大型表格行虚拟化
  - [x] 表头排序 button 语义 + aria-sort + 键盘/焦点/读屏/行操作菜单
  - [x] localStorage 旧视图一次性迁移后清理
  - [x] 跨组织/越权导出/陈旧 cursor/视图冲突/并发更新测试
  - [x] 1 万/10 万级 API 查询与前端交互性能测试

- [x] Task 5: P1 深化移动工作台与离线体验
  - [x] 拆分 MobileWorkbench 为领域 hooks/队列状态机/附件/冲突/展示组件（StepCard/PendingQueuePanel/OfflineStatusBar/ConflictResolution/labels/useNetworkState/useOfflineSettings/useOfflineWorkbench）
  - [x] 离线队列展示类型/创建时间/状态/重试次数/下次重试/失败原因/业务实体/idempotencyKey（PendingQueuePanel 完整字段 + offlineStatus.computeNextRetryAt）
  - [x] 批量重试/单项重试/放弃/冲突差异/重认证后继续同步（offlineDb onlyIds 批量、authPaused 认证恢复）
  - [x] 401 暂停队列引导重登录；409/412 字段级差异不静默覆盖（useOfflineWorkbench authPaused + ConflictResolution）
  - [x] IndexedDB 空间不足/浏览器清理/密钥失效/多标签竞争/时钟偏差可恢复路径（storageController/offlineLeader/offlineClock）
  - [x] 附件断点续传/取消/重试/校验和/孤儿清理/上传完成前明确状态（resumableUpload checksum + offlineDb 孤儿清理）
  - [x] 在线/离线/弱网/陈旧/同步中/失败显著标识（OfflineStatusBar + networkQuality）
  - [x] 扫码/触控/单手/手套设置持久化（offlineSettings 按用户+设备隔离）
  - [x] 浏览器关闭后恢复/重复提交/队列堆积/存储配额/Wi-Fi 抖动测试（offlineStatus/offlineClock/offlineSettings/networkQuality 等测试）

- [x] Task 6: P1 完善 PWA 更新与回滚
  - [x] SW 更新状态机（checking/available/saving-drafts/activating/reloading/success/rollback/failed）（swUpdateStateMachine.ts 纯 TS 状态机 + 单测；swRegistration/index 接线驱动）
  - [x] 更新前持久化草稿与离线队列（saving-drafts → 保存成功后才 activating；离线队列已持久化）
  - [x] 新旧缓存版本化与迁移策略（swCache cacheName/SW_CACHE_VERSION + sw.js activate 清理；pruneCacheNames 纯函数）
  - [x] 新 shell 启动失败自动回滚上一稳定 shell（sw.js rollbackCacheName + activate 保留 + fetch 离线回退）
  - [x] API/鉴权/用户文件/敏感数据默认不缓存（sw.js strategyForClass/shouldCacheResponse network-only）
  - [x] 清理失效缓存（sw.js activate + pruneCacheNames）
  - [x] 上报安装/激活/失败/回滚/迁移指标（recordMetric sw.* + sw.js postMessage 生命周期事件）
  - [x] 跨两个及以上版本升级自动化测试（pruneCacheNames v0/v1/v2 用例 + 状态机跨版本升级）

- [x] Task 7: P1 可观测性、隐私与上传安全深化
  - [x] 前端指标采样率/限速/队列上限/退避/批量/丢弃统计（observability 采样/退避/批量/有界缓冲/限速/丢弃统计）
  - [x] URL/错误消息/表单字段/文件名/查询参数/输入结构化脱敏（sensitiveData.ts）
  - [x] 脱敏回归测试（sensitiveData.test.ts 口令/令牌/文件名/个人信息用例）
  - [x] session/requestId/traceId/构建版本与后端链路关联，保持组织隔离（requestCorrelation）
  - [x] 上传流式校验 magic bytes，不整文件载入内存（uploadGuard 流式 magic bytes）
  - [x] 压缩包最大文件数/展开尺寸/压缩率/嵌套深度/单文件/处理时间限制（upload-validator.ts）
  - [x] 隔离区文件扫描完成前不可下载/消费（file.service 扫描状态门禁 + 组织隔离）
  - [x] 恶意文件/伪造扩展名/路径穿越/嵌套压缩包/上传取消/分片缺失/跨组织访问测试（upload-validator/file.service/resumableUpload 测试）

- [x] Task 8: P1 工业 UX 与可维护性
  - [x] 拆分 RoleWorkbench.tsx（720 行）与 MobileWorkbench.tsx（1128 行）等超大页面（RoleWorkbench 已拆为 WorkbenchChrome/WorkbenchList/SavedViewsPanel + 纯逻辑模块，465 行编排器；MobileWorkbench 拆分属 Task 5，本任务不改）
  - [x] 网络/会话/离线队列/上传/危险操作/页面查询建模为可测试状态机（dangerousModel/roleWorkbenchState/workbenchExport + 测试）
  - [x] 主要页面验证 200%/400% 缩放/键盘/焦点返回/读屏/reduced-motion/contrast/触控目标/中文长文本/空数据/部分失败/大数据/长时运行（a11y/a11yAudit 焦点序、reachableFocus、非颜色通道断言 + 测试）
  - [x] 危险操作含影响预览/二次确认/幂等键/结果/可撤销窗口/审计（dangerousModel 全闭环 + DangerousActionDialog/useDangerousConfirm）
  - [x] 不以颜色为唯一表达；增加内存/定时器/监听器/Object URL/缓存泄漏测试（hasNonColorChannel + leakAudit/runtimeLifecycle 泄漏回归测试）
  - [x] 按路由 JS/CSS/异步 chunk 预算，超预算 CI 失败；保留既有工业视觉语言（perfBudget 串入 build:client 与 CI test.yml；design-token allowlist 维持 hsl 工业视觉）

- [x] Task 9: 验收与交付报告
  - [x] 运行并记录全部验收命令及结果（本机可运行门禁全绿；PG/E2E/浏览器/Docker 为 CI-only，见报告 H）
  - [x] 产出 `docs/reviews/close-production-truth-ux-report.md`（A 当前 SHA+基线问题清单；B 修改文件+原因；C 安全根因+修复；D 各子系统变化；E 完整命令；F 各测试套件与浏览器真实结果；G evidence manifest 摘要+digest；H 外部验证/审批/环境阻塞；I 未通过项+失败原因；五级结论如实）
  - [x] 提交并推送 P1 收口 `origin/main`（P0 收口 `5133bd8`、P1 收口 `f54cbbe`，工作树干净，无调试残留）
  - [x] security 工作流 gitleaks 首轮失败（feishu-config base_token 真实凭据 + MIGRATION_FLAG_KEY 误报）→ 修复：移除真实凭据入库 + .gitignore + 模板 + 精确豁免；更新报告 A/C/F/I；待 CI 复跑确认（见 checklist C9/C10）
  - [ ] CHANGELOG/version.json/release manifest/版本页/关于页同步 evidence 派生（如本版本无独立发布页则在报告中说明）

# Task Dependencies
- Task 0 是基线，先行。
- Task 1/2/3 相互独立，可在 Task 0 后并行。
- Task 4 依赖既有 RoleWorkbench 服务/前端；Task 5/6/7 依赖既有移动/PWA/上传模块，可并行。
- Task 8 依赖页面与状态机拆分（4/5 后）。
- Task 9 依赖 Task 1–8 全部完成。