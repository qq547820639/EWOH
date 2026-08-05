# Checklist（生产真实性与用户体验深化收口）

> 基线 `main` @ `5a810c70960702201f5b870c35f5be58c5373e48`。以真实代码/测试/构建/可运行行为验证为准；环境不可用项诚实标 BLOCKED。

## C0 环境与基线
- [ ] 环境与仓库指纹已记录（branch/HEAD/time/OS/Node/npm/Python/PG/Docker/浏览器）
- [ ] 只读核对 README/CHANGELOG/CI/release manifest/truth-manifest/Dockerfile/Playwright 完成
- [ ] 既有可运行门禁基线已运行并记录

## C1 恢复主分支全绿（P0）
- [ ] 干净环境 `npm ci` 成功；`npm audit` 以 JSON 结构化输出
- [ ] high/critical = 0（或书面风险评估+有效期+负责人例外）
- [ ] 未使用 `|| true`/降低 audit level/`fix --force`/无依据 ignore/删除扫描步骤
- [ ] 审计结果输出为 CI artifact + 面向人摘要
- [ ] GitHub Actions 已升级到支持 Node 24 的稳定版本并固定 commit SHA
- [ ] typecheck/lint/Jest/客户端测试/OpenAPI 漂移/PG 迁移+并发/E2E/浏览器矩阵/构建/Docker/仓库卫生全部通过

## C2 统一工程事实源（P0）
- [ ] evidence 记录含完整字段（SHA/branch/workflow/run id/时间/环境指纹/依赖版本/artifact digest/verifier/expiration/状态）
- [ ] 交付状态由当前 CI 动态生成，无人工维护过期数字
- [ ] release manifest/版本页/关于页/交付报告引用同一 derived evidence manifest
- [ ] STALE/FAILED/BLOCKED/NOT VERIFIED 显式标注
- [ ] CI 漂移测试存在：release manifest 与当前 workflow 不一致即失败
- [ ] 历史测试结果明确标注为历史证据
- [ ] 单元/集成测试 + 失败夹具通过

## C3 Playwright 浏览器矩阵（P0）
- [ ] CI 真实安装并执行全部 6 个项目（非仅配置）
- [ ] 每项目输出 JSON/JUnit 结果、HTML report、trace、失败截图、浏览器版本
- [ ] WebKit 受限项按 BLOCKED_BY_ENVIRONMENT 处理并给出原因/证据/后续入口
- [ ] 测试报告与 evidence manifest 浏览器通过数从实际结果派生

## C4 RoleWorkbench 生产数据路径（P0）
- [ ] 分页/筛选/排序服务端执行（cursor 协议：total/hasNextPage/nextCursor/一致排序）
- [ ] 组织隔离与 RBAC 存在，不信任前端角色
- [ ] 筛选/排序/分页/选中状态同步 URL search params
- [ ] 服务端保存视图（创建/重命名/更新/删除/默认/权限/跨设备）
- [ ] CSV 导出为服务端异步任务（进度/取消/通知/过期/权限/审计/最大行数/脱敏）
- [ ] 大型表格行虚拟化
- [ ] 表头排序 button 语义 + aria-sort + 键盘/焦点/读屏/行操作菜单
- [ ] localStorage 旧视图一次性迁移后清理
- [ ] 跨组织/越权导出/陈旧 cursor/视图冲突/并发更新测试通过
- [ ] 1 万/10 万级性能测试通过

## C5 移动工作台与离线体验（P1）
- [x] MobileWorkbench 已拆分为领域 hooks/队列状态机/附件/冲突/展示组件
- [x] 离线队列展示完整字段（类型/创建时间/状态/重试次数/下次重试/失败原因/实体/idempotencyKey）
- [x] 批量/单项重试、放弃、冲突差异、重认证恢复可用
- [x] 401 暂停队列引导重登录；409/412 字段级差异不静默覆盖
- [x] IndexedDB 空间/清理/密钥失效/多标签/时钟偏差可恢复
- [x] 附件断点续传/取消/重试/校验和/孤儿清理/上传前状态
- [x] 在线/离线/弱网/陈旧/同步中/失败显著标识
- [x] 扫码/触控/单手/手套设置持久化
- [x] 关闭恢复/重复提交/队列堆积/存储配额/Wi-Fi 抖动测试通过

## C6 PWA 更新与回滚（P1）
- [x] SW 更新状态机完整（checking/available/saving-drafts/activating/reloading/success/rollback/failed）（swUpdateStateMachine + 单测）
- [x] 更新前持久化草稿与离线队列（saving-drafts → activating 门控）
- [x] 缓存版本化与迁移策略（swCache cacheName/version + sw.js activate + pruneCacheNames）
- [x] 新 shell 失败自动回滚（sw.js rollbackCacheName + fetch 离线回退）
- [x] API/鉴权/敏感数据默认不缓存（sw.js network-only）
- [x] 失效缓存已清理（sw.js activate + pruneCacheNames）
- [x] 安装/激活/失败/回滚/迁移指标上报（recordMetric sw.* + postMessage 生命周期事件）
- [x] 跨两个及以上版本升级自动化测试通过（pruneCacheNames v0/v1/v2 + 状态机跨版本）

## C7 可观测性、隐私与上传安全（P1）
- [x] 前端指标采样率/限速/队列上限/退避/批量/丢弃统计（observability）
- [x] 结构化脱敏（URL/错误/表单/文件名/查询参数/输入）（sensitiveData）
- [x] 脱敏回归测试通过（秘密/令牌/个人信息/业务敏感不出日志或指标）（sensitiveData.test）
- [x] session/requestId/traceId/构建版本与后端链路关联，组织隔离保持（requestCorrelation）
- [x] 上传流式校验 magic bytes，不整文件载入内存（uploadGuard 流式）
- [x] 压缩包限制（文件数/展开尺寸/压缩率/嵌套深度/单文件/处理时间）（upload-validator）
- [x] 隔离区文件扫描完成前不可下载/消费（file.service 扫描门禁 + 组织隔离）
- [x] 恶意文件/伪造扩展名/路径穿越/嵌套压缩包/取消/分片缺失/跨组织测试通过（upload-validator/file.service/resumableUpload 测试）

## C8 工业 UX 与可维护性（P1）
- [x] RoleWorkbench.tsx 与 MobileWorkbench.tsx 等超大页面已拆分（RoleWorkbench 已拆，720→465 行编排器；MobileWorkbench 拆分属 Task 5）
- [x] 网络/会话/离线队列/上传/危险操作/页面查询为可测试状态机（dangerousModel/roleWorkbenchState/workbenchExport）
- [x] 主要页面缩放/键盘/焦点返回/读屏/reduced-motion/contrast/触控/中文/空/部分失败/大数据/长时运行已验证（a11y/a11yAudit 断言 + 测试）
- [x] 危险操作含影响预览/二次确认/幂等键/结果/可撤销窗口/审计（dangerousModel 全闭环）
- [x] 不以颜色为唯一表达；泄漏测试（内存/定时器/监听器/Object URL/缓存）通过（hasNonColorChannel + leakAudit/runtimeLifecycle）
- [x] 按路由 JS/CSS/异步 chunk 预算，超预算 CI 失败；既有工业视觉语言保留（perfBudget 串入 build:client 与 CI test.yml；design-token 维持 hsl）

## C9 系统边界
- [ ] 未改造成实时设备安全控制器；只读监督/审批门禁/人机协同保持
- [ ] 组织隔离/RBAC/RLS/审计链/幂等/不可逆操作审批未被削弱
- [ ] 未用 mock/stub/skip/固定数字替代生产验证
- [ ] 环境不具备项均按 BLOCKED_BY_ENVIRONMENT 报告并说明缺少什么/如何解除/哪些结论不可作

## C10 验收与交付
- [ ] 服务端 typecheck/lint/unit/integration 通过
- [ ] 客户端 typecheck/lint/unit 通过
- [ ] Python tests 与 Bandit 通过
- [ ] OpenAPI generate/validate/drift check 通过
- [ ] DB migration plan/apply/verify/rollback/re-apply（或 BLOCKED + 命令）记录
- [ ] Playwright 全部项目真实执行并记录结果
- [ ] accessibility/weak-network/visual regression 记入结果
- [ ] production build 成功；bundle/performance budget 通过
- [ ] Docker smoke（或 BLOCKED + 命令）
- [ ] repository facts/work graph/evidence audit 通过
- [ ] 交付报告含 A–I 全部要素与五级结论
- [ ] 五级结论如实（Code Implemented/Code Verified/Runtime Verified/Pilot Ready/Production Ready），仅真实证据支撑提升
- [ ] 提交并推送 `origin/main` 成功；工作树干净；无调试残留