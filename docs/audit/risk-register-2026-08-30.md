# EWOH 风险登记册（2026-08-30）

> 汇总来源：深度排查报告（`deep-scan-2026-08-30.md` F-1~F-6）、重构 backlog（`refactoring-backlog-2026-08-30.md` P0~P2）、交付遗留（LEGACY-001~005）。
> 今日验证标注：标 ★ 的"当前状态"为本日实际代码/环境复核结论（非复述）。
> 责任人为角色建议；「AI 代办」项可在授权下由助手直接执行。

---

## 一、P0（本周处置）

| ID | 问题 | 影响范围 | 触发条件 | 当前状态 | 排查/处置步骤 | 责任人 |
|----|------|----------|----------|----------|---------------|--------|
| R-01 | **E2E 与生产 DB 访问路径分叉**：e2e server 未设 `EWOH_DB_REQUIRE_TX`，E2E 全程走根句柄回落（无 GUC/RLS） | 测试有效性——RLS 租户隔离回归可能漏测 | 任何未显式开启开关的测试环境 | ★ 已验证：`standalone-e2e-server.ts` 无该变量；生产开关 fail-closed 已存在 | ① e2e server 默认 `EWOH_DB_REQUIRE_TX ??= '1'`；② 跑全量 E2E 暴露非事务查询；③ 逐一补 `runInTransaction`；④ CI 同步该默认值 | 后端 + AI 代办 |
| R-02 | **错误契约被绕过**：`parseError` 仅 2 文件消费，119 处三元 + 151 处裸 `toast.error`（含 `err.message` 直显） | 全站错误提示一致性；脱敏策略（堆栈/内部信息不入 UI）持续面临绕过风险 | 每次新增/修改页面代码 | ★ 已验证计数不变 | 按 backlog P0-1：抽 `errorMessage()`/`mutationErrorToast()` → codemod → lint 禁回潮 | 前端 + AI 代办 |
| R-03 | **生产部署 rc43 缺失**：main 已含 a11y 修复、AI SSE 死链修复、迁移链收口（`2221526`），生产仍在 rc42 | 生产用户未获得修复；两版本差异随时间扩大 | 生产环境按 rc42 运行 | ★ SSH 无免密凭据（root@121.43.230.202 Permission denied），助手无法代执行 | 运维人工执行 runbook：rsync → ECS 原生构建 → compose tag rc43 → `up -d --no-deps api` → 验证 `/health/ready`；或为本机配置 ECS SSH key 后交 AI 代办 | **运维** |
| R-04 | **迁移链在全新环境断链**（runner 白名单漏登记已修，但需一次真实演练闭环） | 全新环境/灾备重建部署失败风险 | 全新库执行全量迁移 | ★ 8-29 已在本地嵌入式 PG 验证 68 文件/102 表安装成功；修复已推送（`c1f3c87`） | ① 在 CI 或 ECS 临时库再演练一次 `run_migrations` 全链（非本地）；② 给 CI standalone.yml 增加真实空库迁移 job（利用 `EWOH_PG_URL` 机制） | 后端 + QA |

## 二、P1（两周内）

| ID | 问题 | 影响范围 | 触发条件 | 当前状态 | 排查/处置步骤 | 责任人 |
|----|------|----------|----------|----------|---------------|--------|
| R-05 | **work-orchestration 全同步文件 I/O**：`readFileSync/writeFileSync/rmSync/existsSync` 共 **9 处**（evidence 读取 `:350-353`、目录列举 `:604-611`、catalog 加载 `:634-645`、写入 `:881`、锁管理）——比前报评估范围更大 | 事件循环阻塞随文件量/并发放大；GET 列表接口受累 | 锁文件/evidence 数量增长或并发叠加 | ★ 已验证：`node:fs` 同步 API 9 处全在该 service | ① `loadLockFile`/`loadEvidence` 改 `fs/promises`；② `artifactsDir()` memoize；③ 锁过期清理移出读路径；④ 补基准测试 | 后端 |
| R-06 | **email-transport 连接死亡竞态**：`realSmtpConnector.nextLine()` 的 `errorReject` 为单值——错误事件在无等待者时**静默丢弃**，后续 `nextLine()` 从陈旧 `waiters` 缓冲取行继续在死连接上发命令，最终挂到 10s timeout | 通知渠道（andon-loop）投递延迟与超时噪音；有派发器 failed+人工重试兜底，无数据风险 | SMTP 服务器中途 RST/断连 | ★ 本日完成逐行审查（推翻"待定"）：整体实现质量高（STARTTLS fail-closed/头注入双层防护/DOT-stuffing/多行回复/超时均有），仅此一处竞态 | ① error/close 事件存为 pending rejection，`nextLine()` 优先消费；② 补"连接中断时挂起命令立即失败"单测 | 后端 |
| R-07 | **9 处状态徽章映射重复**（backlog P0-2） | 全站状态色一致性；下次全站样式变更成本 | 新增状态或调整色 token | 已入库 | `lib/statusTone.ts` 收敛 + lint 禁硬编码 | 前端 + AI 代办 |
| R-08 | **119 处错误三元 + 12+ 处时间格式化重复**（backlog P0-1/P0-3） | 维护成本/一致性问题持续累积 | 日常开发 | 已入库 | 与 R-02 同批 codemod | 前端 + AI 代办 |
| R-09 | **scale.service 43 方法 / solver 81KB / work-orchestration 52KB 巨石**（backlog P1-4/5/7） | 三大业务域演进效率与回归成本 | 持续性技术债 | 已入库，Strangler 模式有先例 | 按 backlog 各自步骤，独立 PR 串行 | 后端 |
| R-10 | **scheduler 装配模式收尾**（backlog P1-6）：8 个 `new` 集中在构造函数 | 组合件测试性 | 新增组合件 | 已入库 | 抽 `buildSchedulerComponents()`；ESLint 例外注释随重构更新 | 后端 |

## 三、P2（下一迭代）

| ID | 问题 | 说明 | 责任人 |
|----|------|------|--------|
| R-11 | 生成物 634KB+142KB 混入源码路径 | tsc/eslint 扫描拖慢 + 审计信噪比；移 `generated/` + exclude | 前端/后端 + AI 代办 |
| R-12 | invalidateQueries 82 处散点 | 失效组合靠记忆；queryKeys 语义化组合函数试点 mobile 域 | 前端 |
| R-13 | Operations 7 tab 拆文件 + lazy 分包 | URL 同步已落地；按使用数据决定优先级（Devices 426KB chunk 为前车之鉴） | 前端 |
| R-14 | CommandMapShell/FactoryMap 48.6KB×2 分帧 | 先抽 TopBar/帮助对话框/快捷键三块 | 前端 |
| R-15 | gamification:603 防御风格统一 + travel-cost 比较器断言（F-2/F-5） | 当前不可达/低风险，随域内改动顺带修复 | 后端 |
| R-16 | LEGACY-003 告警规则硬编码（阈值 20% 写死） | 迁移为配置驱动（规则表或 env），支持在线调整 | 后端 + 产品 |
| R-17 | LEGACY-001 AGV/焊接机器人 10 台未绑定 | 等业务明确绑定语义（绑工位/绑人）后处理 | **产品+业务** |

## 四、P3（归档观察）

| ID | 问题 | 说明 | 责任人 |
|----|------|------|--------|
| R-18 | Python 测试 ResourceWarning ×6 + replay_device 无 finally | 测试态噪音 + 脚本级泄漏，无生产影响 | QA + AI 代办 |
| R-19 | ux009-auth:98 webkit flaky（角色矩阵） | 重试后过；建议 playwright retries=1 作为矩阵默认，根因另查（时序竞态） | QA |
| R-20 | i18n 词条覆盖率低（页面文案硬编码中文） | 架构预留了翻译层；出海需求出现前归档 | 产品决策后启动 |

## 五、已关闭（登记备查）

| ID | 问题 | 关闭依据 |
|----|------|----------|
| ~~LEGACY-005~~ | world/state 缓存待部署 | rc42 已于 8-23 部署并实测（<300ms 达标） |
| ~~F-4 待定~~ | email-transport 审查悬置 | 本日完成逐行审查（R-06 承接遗留竞态）；同时确认 **LEGACY-004 状态应更新**：邮件通知渠道代码已实现（R-62/ADR-041，未配置 SMTP 显式禁用），原"无邮件通知"表述过时 |
| ~~LEGACY-002 部分确认~~ | 设备绑定 API 缺口 | ★ 本日复核：`bindDevice` 仍只写 `ewoh_spatial_entity`，不写 `ewoh_device_binding`（unbound 标志消除依赖后者）——缺口**仍然存在**，维持开放（并入 R-21） |
| R-21（新立） | 设备绑定 API 与绑定事实源不一致 | 开发：`bindDevice` 补 `ewoh_device_binding` 写路径（或决策废弃该端点改走管理接口）；产品：明确两表关系 | 产品+后端 |

---

## 建议执行顺序

1. **AI 代办立即批**：R-01（E2E 开关）→ R-07/R-08（机械替换批）→ R-18/R-11——全部有测试基座，一天内可完成并全量回归。
2. **人工并行**：R-03（运维部署，唯一阻塞项）+ R-04 演练 + R-05/R-06 后端排期。
3. **产品决策项**：R-17、R-21、R-20 需要业务输入，建议下周例会决策。
