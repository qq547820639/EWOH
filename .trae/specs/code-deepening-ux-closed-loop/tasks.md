# Tasks

> 基线：`main` @ `5a810c7`。原则：每个任务以真实代码/测试/构建产物验证为准；真实环境不可用 → BLOCKED。
> 分工：T1/T2/T3 为新增能力，可并行；T4/T5/T6 依赖既有组件，可并行；T7/T8 为 CI/环境，T9 为横向审计，T10 为验收与报告（依赖前九项）。

- [ ] Task 0: 环境与基线指纹
  - [ ] 记录 branch/完整 HEAD/时间/OS/Node/Python/PostgreSQL/Docker/Helm/浏览器版本
  - [ ] 只读核对 README/CHANGELOG/docs/reviews/UX backlog/CI workflows/DB migrations/OpenAPI/客户端/Python 边缘平台
  - [ ] 运行既有可运行门禁基线并记录结果（typecheck/lint/unit/bundle/perf/audit）
  - [ ] 盘点当前硬编码样式值、时间线结构、空状态、资源生命周期、安全扫描的现状（证据入库）

- [ ] Task 1: 语义化设计系统
  - [ ] 扫描客户端散落硬编码颜色/间距/字号/圆角/阴影/动效/层级，输出清单
  - [ ] 建立集中式 semantic design tokens（background/surface/border/text；success/warning/danger/info；normal/degraded/offline/blocked/conflict/unknown；spacing/radius/typography/elevation/motion/z-index）
  - [ ] 迁移共享组件（components/ui/*、components/*）与核心页面到 Token
  - [ ] 补充深色模式、高对比模式与 prefers-reduced-motion 适配
  - [ ] 新增静态检查（stylelint/自定义 lint 规则）阻断业务页面新增未经批准硬编码值
  - [ ] 单元/静态测试验证：抽查核心页面无新增硬编码值；不改变既有风险颜色业务语义

- [ ] Task 2: 统一对象时间线
  - [ ] 定义统一时间线事件模型（timestamp/actor/source/object type+id/action/prev state/current state/correlation|causation/evidence/credibility/permission visibility）
  - [ ] 服务端输出统一时间线 DTO（含鉴权与组织隔离），客户端只消费该 DTO
  - [ ] 支持按对象/事件类型/风险等级/操作者/时间范围筛选
  - [ ] 支持告警→决策→命令→执行→回执→复盘追踪
  - [ ] 支持锚点链接、证据预览、复制标识、审计导出
  - [ ] 迁移既有页面（设备/告警/工单/命令/审批/人员/证据/系统事件）到统一模型
  - [ ] 单元/集成测试 + OpenAPI 契约/漂移校验

- [x] Task 3: 首次使用与样例工厂闭环
  - [x] 提供管理员/调度员/工程师/现场操作员角色化 Quick Start
  - [x] 提供可重复初始化、可安全清除、不污染正式数据的样例工厂（后端守卫 + 前端入口）
  - [x] 设计“五分钟完成第一条闭环任务”引导（可跳过/可恢复/可重新打开/记录版本避免重复弹出）
  - [x] 统一空状态与无权限/无设备/无数据/连接中断/同步中/初始化失败处理路径
  - [x] 上报匿名化首次任务完成率/放弃步骤/失败原因（不采集敏感业务内容）
  - [x] 单元/浏览器测试（单元已通过：server 16 + client 14；浏览器用例归 S10/S5 执行）

- [ ] Task 4: 真实可阻断性能预算
  - [ ] 分析路由/共享依赖/大型组件 bundle 构成（bundle 分析报告）
  - [ ] 重型页面路由级懒加载/组件级拆分/按需加载
  - [ ] 审计并优化大表格/因果图/命令地图/时间线/证据预览全量渲染（虚拟化/增量/Worker/缓存/分层）
  - [ ] 扩展 perfBudget.ts 预算表（初始 JS、单异步 Chunk、首屏可交互、大表格操作、大图渲染、低端平板内存峰值、离线恢复与队列重放）
  - [ ] 将全部预算接入 CI 失败判定并输出可定位构建报告
  - [ ] 性能前后对比（perf-bench.json / bundle-report.json）

- [ ] Task 5: 跨浏览器弱网与视觉回归
  - [ ] 建立基于代理层/测试服务器的可跨浏览器复用弱网场景（延迟/带宽/随机断连/超时/错误注入）
  - [ ] 覆盖登录后断网/提交断网/离线队列重放/重复提交/冲突/SW 更新/刷新/多标签并发
  - [ ] 固定 Linux Chromium 为主要视觉黄金基线；明确字体/浏览器/OS 差异策略
  - [ ] 保留移动 Chrome/工业平板/reduced-motion 项目；不无限提高截图容差
  - [ ] Chromium/Firefox/WebKit 弱网 + 视觉回归执行并记录

- [ ] Task 6: 前端资源生命周期统一
  - [ ] 建立统一 session/runtime 生命周期管理（BroadcastChannel/WebSocket/SSE/SW listener/timer/retry|backoff/AbortController/IndexedDB transaction|lock/Blob URL/document|window listener）
  - [ ] 覆盖组件卸载/登出/Token 失效/租户切换/角色切换/后台/网络恢复/SW 升级的关闭或重建
  - [ ] 登录→退出→重新登录、多标签页退出、租户切换自动化测试（防旧会话收消息/写数据）
  - [ ] 单测/浏览器测试

- [ ] Task 7: 安全扫描固定到 CI
  - [ ] Bandit（锁定版本）加入依赖/CI 并实际运行，输出机器可读报告
  - [ ] Node 生产依赖审计、秘密扫描、SBOM、镜像漏洞扫描统一接入质量门禁
  - [ ] 建立带原因/责任人/到期时间的 suppressions 文件
  - [ ] 高严重度问题阻断合并；缺工具不得记为 PASS
  - [ ] CI 运行记录

- [ ] Task 8: 真实运行门禁
  - [ ] 自动化（可用环境）：PG migration apply/verify/rollback/re-apply；HTTP+PG E2E；并发/幂等/锁竞争；Docker 镜像启动健康检查；Helm install/upgrade/rollback+smoke；备份恢复/版本兼容；边缘断连/积压/重放/重复消息；灰度回滚；soak/load
  - [ ] 真实环境不可用项输出 BLOCKED：一键命令 + 环境变量/基础设施/预期证据，不使用 mock 替代
  - [ ] 记录每项命令与结果

- [x] Task 9: 错误与恢复体验审计
  - [x] 逐页审计核心页面 12 态一致（loading/empty/partial/stale/degraded/offline/unauthorized/forbidden/conflict/error/recovery/success）
  - [x] 每个错误含现象/影响/是否已保存/可执行下一步/可复制 trace|request id
  - [x] 禁止向普通用户暴露原始堆栈/大段 JSON/开发者内部文本
  - [x] 缺失项补齐并回归测试

- [ ] Task 10: 验收与交付报告
  - [ ] 运行并记录全部验收命令及结果（见 checklist.md 验收节）
  - [ ] 产出 `docs/reviews/code-deepening-ux-closed-loop-report.md`（修改内容/风险/文件清单/测试清单/验证命令/性能前后/无障碍跨浏览器/BLOCKED/技术债务/五级结论）
  - [ ] 更新 CHANGELOG、work graph、gate-decisions、evidence audit
  - [ ] 提交并推送到 `origin/main`（提交前排除调试残留）

# Task Dependencies
- Task 0 是基线，先行。
- Task 1/2/3 相互独立，可在 Task 0 后并行。
- Task 4/5/6 依赖既有组件能力，可并行。
- Task 7/8 为 CI/环境治理，可与 1–6 并行。
- Task 9 横向审计，依赖核心页面存在（1/2/3 后）。
- Task 10 依赖 Task 1–9 全部完成。