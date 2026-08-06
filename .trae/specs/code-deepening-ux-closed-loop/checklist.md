# Checklist（代码深化与用户体验闭环）

> 基线 `main` @ `5a810c7`。以真实代码/测试/构建/可运行行为验证为准；真实环境不可用项诚实标 BLOCKED。

## S0 环境与基线
- [x] 环境与仓库指纹已记录（branch/HEAD/time/OS/Node/Python/PG/Docker/Helm/浏览器）
- [x] 只读核对 README/CHANGELOG/docs/reviews/UX backlog/CI/DB/OpenAPI/客户端/Python 完成
- [x] 既有可运行门禁基线已运行并记录

## S1 语义化设计系统
- [x] 硬编码样式值扫描清单已产出
- [x] 集中式 semantic design tokens 已建立（背景/表面/边框/文本；success/warning/danger/info；normal/degraded/offline/blocked/conflict/unknown；spacing/radius/typography/elevation/motion/z-index）
- [x] 共享组件与核心页面已迁移到 Token
- [x] 深色/高对比/reduced-motion 适配已实现并有测试
- [x] 静态检查能阻断业务页面新增未经批准硬编码值
- [x] 既有风险颜色业务语义未改变

## S2 统一对象时间线
- [x] 统一事件模型与 DTO 已定义并实现（含鉴权/组织隔离）
- [x] 客户端只消费统一 DTO，无各自拼装不兼容时间线结构
- [x] 按对象/事件类型/风险等级/操作者/时间筛选可用
- [x] 告警→决策→命令→执行→回执→复盘追踪可用
- [x] 锚点链接/证据预览/复制标识/审计导出可用
- [x] 单元/集成测试 + OpenAPI 契约/漂移校验通过

## S3 首次使用与样例工厂闭环
- [x] 角色化 Quick Start 已实现（管理员/调度员/工程师/现场操作员）
- [x] 样例工厂可重复初始化、可安全清除、不污染正式数据
- [x] “五分钟闭环”引导可跳过/可恢复/可重新打开且记录版本避免重复弹出
- [x] 统一空状态与无权限/无设备/无数据/断连/同步中/初始化失败处理路径
- [x] 匿名化首次任务完成率/放弃步骤/失败原因已上报（无敏感业务内容）
- [x] 单元/浏览器测试通过（单元：server 16 + client 14 全绿；浏览器用例归 S10/S5）

## S4 性能预算
- [x] bundle 构成分析报告已产出
- [x] 重型页面路由级懒加载/组件拆分/按需加载完成
- [x] 大表格/因果图/命令地图/时间线/证据预览无全量渲染（虚拟化/增量/Worker/缓存/分层）
- [x] 预算表含初始 JS、单异步 Chunk、首屏可交互、大表格操作、大图渲染、低端平板内存峰值、离线恢复与队列重放
- [x] 全部预算接入 CI，超预算即失败并输出可定位报告
- [x] 性能前后对比已记录

## S5 跨浏览器弱网与视觉回归
- [x] 可跨浏览器复用的弱网注入场景已建立（延迟/带宽/随机断连/超时/错误注入）
- [x] 覆盖登录后断网/提交断网/离线队列重放/重复提交/冲突/SW 更新/刷新/多标签并发
- [x] Linux Chromium 固定为视觉黄金基线；字体/浏览器/OS 差异策略明确
- [x] 保留移动 Chrome/工业平板/reduced-motion；未无限提高截图容差
- [x] Chromium/Firefox/WebKit 弱网 + 视觉回归已执行并记录

## S6 前端资源生命周期
- [x] 统一 session/runtime 生命周期管理已实现（BroadcastChannel/WS/SSE/SW listener/timer/retry/AbortController/IndexedDB/Blob URL/event listener）
- [x] 覆盖卸载/登出/Token 失效/租户切换/角色切换/后台/网络恢复/SW 升级的关闭或重建
- [x] 登录→退出→重登、多标签退出、租户切换自动化测试通过（旧会话不再收消息/写数据）

## S7 安全扫描固定到 CI
- [x] Bandit（锁定版本）在 CI 实际运行并输出机器可读报告
- [x] Node 生产依赖审计/秘密扫描/SBOM/镜像漏洞扫描统一接入质量门禁
- [x] suppressions 文件含原因/责任人/到期时间
- [x] 高严重度问题阻断合并；缺工具不记为 PASS

## S8 真实运行门禁
- [x] 可用环境自动化的门禁已执行（PG migration 往返/HTTP+PG E2E/并发幂等锁/Docker 健康/Helm install-upgrade-rollback+smoke/备份恢复/边缘断连积压重放/灰度回滚/soak）
- [x] 真实环境不可用项均输出 BLOCKED + 一键命令 + 环境变量/基础设施/预期证据，未用 mock 替代

## S9 错误与恢复体验
- [x] 核心页面 12 态一致（loading/empty/partial/stale/degraded/offline/unauthorized/forbidden/conflict/error/recovery/success）
- [x] 错误含现象/影响/是否已保存/可执行下一步/可复制 trace|request id
- [x] 未向普通用户暴露原始堆栈/大段 JSON/开发者内部文本

## S10 验收与交付
- [x] 服务端 typecheck/lint/unit/integration 通过
- [x] 客户端 typecheck/lint/unit 通过
- [x] Python tests 与 Bandit 通过
- [x] OpenAPI generate/validate/drift check 通过
- [x] DB migration plan/apply/verify/rollback/re-apply（或 BLOCKED + 命令）记录
- [x] Playwright Chromium/Firefox/WebKit/移动端/工业平板/reduced-motion 执行
- [x] accessibility 测试通过
- [x] weak-network 测试通过
- [x] visual regression 通过
- [x] production build 成功
- [x] bundle/performance budget 通过
- [x] Docker/Helm smoke 测试（或 BLOCKED + 命令）
- [x] repository facts/work graph/evidence audit 通过
- [x] 交付报告含：修改内容/风险/文件清单/测试清单/验证命令与结果/性能前后对比/无障碍跨浏览器/BLOCKED 项/技术债务/五级结论
- [x] 五级结论如实（Code Implemented/Code Verified/Runtime Verified/Pilot Ready/Production Ready），仅真实证据支撑提升
- [x] 提交并推送 `origin/main` 成功；工作树干净；无调试残留