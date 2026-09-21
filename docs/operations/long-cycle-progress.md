# 长周期工程强化进度（单一进度事实源）

> 目标：消除全仓审计确认的结构性风险（E2E 状态敏感、双钟混用、契约告警不阻断、派工死旅程、无 CI）。
> 断点续接：新会话先读本文件，从最近未完成阶段继续。每完成一个子任务更新并提交。

基线冻结（2026-09-19，HEAD fa65b3e5）：Jest 387/3485 全绿；pytest 697；type:check 0 错；
eslint/ruff/bandit/truth-check/audit-regression-gates 全过；E2E 全链 0 失败；契约告警 0。

## 阶段一：E2E 场景租户隔离 —— 状态：已完成（2026-09-19）

### 设计裁决（ADR 要点）
- 原计划"每场景随机 UUID 租户"受两个产品约束阻塞：
  1. org 上下文绑定 JWT（每租户需独立用户与账号体系）；
  2. ingest 密钥为环境变量静态绑定（INGEST_API_KEYS），随机租户无法摄入帧。
- 裁决：阶段一先落地**"每场景全量重建基线"**的密闭机制（DROP/CREATE + 迁移 + 种子 +
  账号，实测 ~8s/次；服务端 postgres-js 池自动重连已实测验证）——达成"字节级一致
  起点"的同一目标，且不依赖产品新增能力。
- 遗留（转后续阶段/ADR）：org 级多租户需要摄入密钥管理 API（DB 背书密钥 + env 作
  bootstrap），作为独立产品特性另行立项。

### 已完成
- [x] e2e-chain.sh：每场景前重建基线（E2E_NO_REBUILD=1 可退回旧白名单 reset 作逃生门）
- [x] golden：回滚腿自建前置（再次激活产生回退目标后回滚），消除对遗留激活状态的依赖

### 已验证（2026-09-19）
- [x] 连续 3 轮全链：每轮 0 失败 / 0 跳过，结果完全一致（含 agv 就绪顺序修复、
      golden 回滚自建前置、receipt 确定性三处验证轮发现缺陷的修复，提交
      8b4f08c0 / 2000b38e / fa65b3e5 前后共 4 轮链证据）
- [x] "脏库"一致性：第 2、3 轮链在刚跑完整链的库上运行，每场景前重建基线
      使起点与全新库等价，结果与全新库一致

### 验证轮发现并修复的缺陷（证据）
- agv：就绪推进在审批后执行 → 刚批准的方案立即失效（409 PLAN_STALE）→
  移至审批前（与 receipt/golden 顺序对齐）
- golden：回滚自建前置首版用"重复激活同版本"被 409 already ACTIVE 正确拒绝 →
  改为注册 v2 候选 + ack 激活 + 回滚 v2
- receipt：越权目标行误用执行行 person_id 筛选（与 plan_assignment.person_id
  不一致时误把自己被改派的任务当他人任务，服务端正确放行 201）→ 改用
  plan_assignment.person_id 筛选；主腿行跨轮复位为洁净 DISPATCHED

## 阶段二：时钟源统一抽象 —— 状态：已完成（2026-09-19）

### 已完成
- [x] ADR-084：新鲜度分类时间原点 = DB 时钟（clock_timestamp，每投影收集取一次）；
      取时失败回落宿主机 Date.now()；5s 偏差容忍保留为纵深防御
- [x] dbClockMs() 接入 project() / projectForSnapshot() 两处分类原点
- [x] 单测：DB 时钟超前宿主机 27ms 写后立读 → FRESH（resource-state.spec）

### 已验证
- [x] jest 全量 387 套件 / 3486 测试通过
- [x] E2E：device-physics 18/18；golden（全新库）24/24/0（含 v2 自建回滚）；
      receipt 19/19/0

### 附：算法对比实测（2026-09-19，数字化验证产出）

规模实测（heuristic，200 人 / 80 设备，默认堆 4GB）：
- 200 任务：100% 可行，1.06s；500 任务：100% 可行，2.89s（可扩展性达标）
- 50 任务 + 200 人（特定种子）：**OOM 崩溃**（候选笛卡尔积爆炸，8GB 堆后通过：351ms/100%）
- CP-SAT（50 任务 × 200 人 × 80 设备）：模型 640 万 presence 布尔量级，
  构建+求解远超 8s 超时 → 熔断回落启发式（正确标注，未伪造数据）
- MILP（HiGHS WASM）：本环境加载失败（缺失依赖，另立项）

结论：候选生成是「任务 × 人 × 设备 × 工位」全笛卡尔积，是 CP-SAT 与
heuristic 在中大规模下的共同可扩展性瓶颈。修复路径（下一迭代）：
top-K 候选剪枝前移到候选引擎（按工位距离预剪 + 路由成本排序）。

## 阶段三：契约自检升级为阻断门禁 —— 状态：已完成（2026-09-19）

### 已完成
- [x] buildSnapshot（调度 run 持久化路径）契约违约 fail-closed：
      WORLD_SNAPSHOT_CONTRACT_VIOLATION 拒绝持久化/生成方案；只读路径保持告警
- [x] scripts/audit-world-snapshot-contract.js 门禁（最近 5 快照独立复核键规范
      与值域；无库环境显式跳过）；纳入 Makefile audit-regression-gates 主线13

### 已验证
- [x] 红绿实证：注入违约快照 → 门禁 exit 1（列明 3 类违约）；移除 → exit 0
- [x] 单测：非法路由边 → buildSnapshot rejects WORLD_SNAPSHOT_CONTRACT_VIOLATION
- [x] jest 全量 387 套件 / 3487 测试通过；audit-regression-gates 十三条全过
- [x] 正常链路不误伤：重建基线后 golden/receipt/device-physics 全绿

## 阶段四：死旅程产品化 —— 状态：已完成（2026-09-19）

### 已完成
- [x] task-lifecycle：TASK_STATE_RECOVERY_ACTIONS / nextRecoveryAction（恢复动作权威数据源）
- [x] dispatch-coordinator：PLAN_TASK_NOT_DISPATCHABLE 409 内嵌 error.recovery.actions
      （taskId/currentStatus/action/actorRole/endpoint/method），message 前缀不变
- [x] golden 18b / wave wave1 消费内嵌恢复动作（golden 实测连环恢复：
      draft→submit→PLAN_STALE→重选→pending_confirm→skip_approval→重派成功）
- [x] 单测：nextRecoveryAction 映射（task-lifecycle.spec）

### 范围说明
- receipt 保留「就绪推进在审批前」的既有顺序（推进写事实会使刚拿到的批准失效，
  见脚本注释与 2109396d）；阶段四能力由 golden/wave 验证。

### 已验证
- [x] jest 全量 387 套件 / 3489 测试通过
- [x] E2E 全链 0 失败 / 0 跳过；golden 26/26/0；wave 全绿

## 阶段五：CI 矩阵落地 —— 状态：已实现；首跑确认被外部凭据/网络阻塞（2026-09-19）

### 已完成
- [x] .github/workflows/long-cycle-gates.yml：
      · static-gates job：truth-check / bandit 门禁 / audit-regression-gates
        （十三条主线含世界快照契约）/ openapi 无漂移
      · e2e-core-scenarios job：postgres:17 服务容器 + 迁移/种子/账号
        （与 local-up 同序）+ standalone 构建/启动 + golden/receipt/
        device-physics/agv 四场景
- [x] 已推送 origin/main（059cb19c），Actions 自动触发

### 已完成
- [x] actionlint v1.7.7 校验 workflow：0 问题（语法/表达式/钩子静态层面
      已排除首跑失败的主要风险）

### 待确认（外部输入，连续三轮）
- [ ] GitHub Actions 首跑绿灯确认：gh 未认证且仓库私有（匿名 API 404），
      需在仓库 Actions 页查看，或 `gh auth login` 后 `gh run watch` 确认。
- [ ] 本地 act 模拟：act 0.2.89 已安装，但 runner 镜像（GB 级）拉取在当前
      网络下不可行（实测 7.7MB 耗时 6 分钟）；网络改善后可用
      `act -j static-gates` 本地模拟。


## 阶段六（提案）：架构收敛——战略/架构层批评的数字化工序 —— 状态：未开始

来源：外部批判指出的架构层/战略层问题（2026-09-19 综合评估）。按可数字化程度排序：

### A. 契约单源生成（双语言求解器漂移根治）—— 可数字化 85%
- 把 SolverRequest/Response 抽为 contracts/ JSON Schema；TS 类型与 Python
  dataclass 由 schema 生成；CI 门禁：生成物 diff 为零。
- 验收：人为改动一端类型 → 门禁红。工程量 3-5 会话。

### B. 世界状态分区 + TTL —— 可数字化 90%
- ewoh_world_state_snapshot / ewoh_event 按月分区 + TTL 策略；
  purge 工具退役为应急手段。
- 验收：500 万行规模下求解延迟不退化。工程量 2-3 会话。

### C. 世界状态读取路径统一（单投影服务）—— 可数字化 80%
- buildSnapshot / buildSnapshotReadOnly / SchedulingContext 三路径收敛；
  竞态回归测试（PLAN_NOT_APPROVED 类）覆盖。
- 验收：并行写压测下无版本撕裂。工程量 3-5 会话。

### D. NEST-504 默认 fail-closed 翻转 —— 可数字化 100%
- EWOH_DB_REQUIRE_TX 默认 1；全量回归暴露旁路点逐个修复。
- 验收：全量测试绿 + 无 NEST-504 告警。工程量 1-2 会话。

### E. 死代码/未消费模块门禁 —— 可数字化 95%
- knip/ts-prune 扫描脚本 + audit-regression-gates 新主线。
- 验收：报告产出 + 基线锁定。工程量 1 会话。

### F. exo 域可选化（战略解耦）—— 可数字化 70%
- 外骨骼域 feature-flag 化，系统在无外骨骼场景下完整可用
  （回应"为不存在的城市修路"：路可换用途）。
- 验收：无 exo 配置下全链绿。工程量 2-3 会话。

### 不可数字化（诚实边界）
- 真实客户验证、真实产线试点、外骨骼硬件人因、组织/市场进入。
- 数字化手段的上限：把「虚拟试点长跑（7×24 全仿真）+ 对标矩阵 +
  解耦架构」做完，使线下试点的风险与成本降到最低——这是战略层
  数字化工序的天花板。

## 阶段七（提案）：虚拟试点长跑 —— 状态：未开始
- 仿真工厂连续 7×24 运行（边缘仿真器 + 外骨骼机群 + 设备物理 + 合成订单），
  产出 KPI 趋势/降级路径/故障恢复率报告；作为真实试点的前置风险消减。
- 前置：阶段六 A/B/C 完成（否则长跑会被状态敏感噪音污染）。

## 阶段八：验证可信化与边缘执行安全 —— 状态：已完成（2026-09-20）

### 已完成
- [x] E2E 链失败/跳过语义修复：重置失败终止、SKIP 退出码 2、失败优先、
      仅允许本机专用业务库、owner/runtime 库一致性、非法合并场景拒绝。
- [x] fresh 目标改用同一验证 runner；移除已不存在的 clear-execution-facts 依赖。
- [x] 本地启动修复：数据库目标校验、缺库创建、迁移 verify 必须有 VERIFY OK、
      账号失败阻断、readiness 探活、进程退出检测、PID 归属校验和本项目端口隔离。
- [x] 审计账本绑定原始字节 SHA-256 与审阅哈希；报告现场重算并要求行区间完整并集；
      仓库内符号链接按真实目标审计，外链拒绝。
- [x] 边缘执行顺序改为“授权复核接受 → 设备动作 → 执行回执”；ack 未知/409 不碰设备。
- [x] 增加失败回执 JSON Lines 持久账本，重启后按原 commandId 补投；CLI/runbook 补齐配置。
- [x] 失败回执区分瞬时失败与确定性拒绝：4xx/5xx 都先持久记账，避免崩溃丢事实；
      下轮补投时瞬时失败保留，确定性拒绝进入死信并有计数，不再无限重放。
- [x] 回执账本崩溃窗口收口：新事实先 O_APPEND+fsync，再原子压缩；唯一临时文件
      + 目录 fsync；崩溃残留重复行按命令事实键去重。
- [x] 边缘桥接批逐行审阅完成并修复 P1：production 下 `SensorUplinkBridge.retarget`
      到 HTTP 曾先替换安全 URL，可能让运行中的 flush 循环带机器密钥走明文；
      现在整体拒绝不安全目标、保留原 URL，并给运行循环增加 disabled 防御。
- [x] 多源适配器批审发现并修复 P1：环境/摄像头/UWB/MES 载荷曾可自报
      `source_type`，摄像头/环境身份也可被载荷改写；现在部署登记与适配器配置
      是权威，载荷不能改写来源或冒充其他设备。
- [x] 外骨骼批审发现并修复两个 P1：CRC 通过但帧尾损坏的帧不再进入上层；
      NXP1 IDENT 不能改写部署登记设备身份，8B 线上 ID 只作为完整登记 ID 的
      前缀校验依据。
- [x] 边缘存储/设备驱动批审修复三项：人员授权缺省从 granted 改为 unknown；
      审计日志 limit 增加 1000 硬上限；重复活跃外骨骼绑定从“告警继续启动”
      改为启动期 fail-closed。
- [x] 边缘运行时批审修复两项 P1：普通存储异常重试失败后不再丢帧，而是带原始
      载荷进死信；配置装配拒绝重复设备标识，避免 Manager 命令路由和数据归属歧义。
- [x] 外骨骼统一帧与反序列化缺省来源从 real 改为 unknown，缺失 provenance 不得
      冒充真机证据。
- [x] 空间建模批审修复两项：LiDAR 配准不再在未执行 ICP 时伪造 aligned=true；
      locator/LiDAR/Splat 在 production 下拒绝明文 HTTP 携带 ingest key。
- [x] 帧适配缺省 provenance 从 real/good 改为 unknown/unknown，缺失证据不再冒充
      正常真机遥测。
- [x] MessageBus range 从 ISO 字典序改为 instant 语义，修复混合时区偏移下的事件
      窗口错判；非时间值保留原字符串语义。
- [x] 平台 Agent 编排批审修复 P1：任务依赖缺失时原先不会进入“未完成依赖”过滤，
      派发可继续；现在缺失依赖显式 dependency_not_found 并阻止派发。
- [x] 定向升级高危依赖并统一 npm/pnpm overrides；恢复 pnpm-lock 可追踪。

### 当前工作树实测
- Python 全量：2014 passed / 5 skipped（本轮后续平台改动另做目标测试）（2 个 asyncua 真栈缺可选依赖；
  3 个 CP-SAT UNAVAILABLE 用例在 OR-Tools 已装环境下不适用）。
- NestJS Jest：387 suites / 3489 tests 全绿；React Jest：175 suites / 1718 tests 全绿。
  Agent 编排修复后另跑目标 Jest 5 passed，server typecheck/eslint 通过。
- 隔离 PostgreSQL：fresh chain apply 通过，100/100 verify 通过，0 baseline 失败。
- 主产品 E2E 全链一次通过：20 场景、503 项断言，0 FAIL / 0 SKIP。
  覆盖 Golden、Receipt、分波、学习治理、能力停用、授权到期、观测推理、
  主数据、物料、外骨骼会话、数据质量、学习信号、改进行动、AGV、
  控制下行、外骨骼仿真、设备物理、方案过期、感知融合和 Edge 上行。
- 真实 Chromium × 真实 PostgreSQL：3 passed；runtime 角色非 owner 且 RLS 生效。
- Edge 模拟闭环：12 次 HTTP 操作通过；世界快照最近 5 个契约全部合规。
- 安全：Bandit 0 critical/high；生产 npm audit `--omit=dev --audit-level=high` 退出 0。
- 构建：standalone server + client 构建通过。
- 边缘 bridge、适配器、外骨骼、存储/驱动、运行时、空间建模、总线和平台
  Agent 编排批：67/2703 通过哈希绑定完整阅读；整体门禁诚实保持 FAIL，
  其余 2636 个活跃文件待审。
- 工作树出现未知 `release/ewoh-0.6.0-rc4/` 展开与 SHA256SUMS 变更（14:05 生成）；
  本轮未据其宣告发布，也未被新账本计入逐行范围，等待来源确认。


### 2026-09-20 安全核心审查补充

- [x] `release/ewoh-0.6.0-rc4/` 来源确认：Git 只跟踪 2 个清单/校验治理文件；
  其余 876 个文件是 `.gitignore` 忽略的本地打包副本；`package-release.sh`
  的权威输出是 `output/release-bundles/`。不再把该展开当作未知发布产物。
- [x] 完成 auth、access-token/org 上下文、RBAC 策略、上传/文件、控制指纹、
  plan 租户守卫和 approval 核心 17 个文件 / 3,723 行完整阅读；账本哈希绑定
  后 reviewed 由 67/2704 提升到 83/2707。
- [x] 修复 P2：访问令牌缺少 `jti` 时原先跳过吊销检查，现已 fail-closed；
  新增 legacy token 回归，目标 auth 套件 12 passed。
- [x] 记录 P3：上传压缩包“100 MiB 展开上限”和“5 秒估算处理上限”在默认
  口径下不一致，实际约 5 MiB 就会拒绝；本轮只记录，不改行为。
- [x] 目标验证：server typecheck PASS；安全核心相关 eslint PASS；
  8 个相关 Jest 套件 / 79 tests 全绿。
- [ ] 全仓逐行审查仍诚实 FAIL：83/2707，剩余 2,624 个文件待审。

## 阶段九：AI 执行边界与运行卫生 —— 状态：已验证（2026-09-20）

### 本轮新增修复
- [x] AI 非流式与流式建议的 LLM 输出均改为运行时 shape 校验；id、快照版本、
      触发人、租户、状态与执行字段只能来自服务端，不能被模型或提示注入改写。
- [x] LLM 生成保存失败时显式返回“未保存”；客户端不再把生成期内容当作已保存
      A2 建议继续使用。
- [x] AI 访问边缘平台的内置密码删除；缺 `EDGE_PLATFORM_PASSWORD` 直接 fail-closed，
      并发登录刷新合并为 single-flight，避免重复认证风暴。
- [x] A3 模拟方案只允许模型填充 shift/actions/kpis/note 展示要点；方案 id、
      suggestionId、版本、simulation 与状态仍由服务端拥有。
- [x] 访问令牌必须携带可吊销 `jti`；旧格式令牌在验证期直接拒绝。
- [x] RetentionService 关闭时同时关闭独立 owner 连接池，避免内嵌 E2E 应用和
      优雅停机泄漏 PostgreSQL socket。
- [x] PostgreSQL 故障注入子进程测试显式等待退出并关闭 stdio；跨租户 TCK 可自然退出。
- [x] 发布包输出改到 `output/release-bundles/<version>`，不再覆盖 Git 内历史
      release 治理快照；打包排除 Python 缓存。

### 最终递归验证
- [x] Python 全量：2014 passed / 5 skipped。
- [x] 服务端 Jest：388 suites / 3497 tests。
- [x] 客户端 Jest：175 suites / 1718 tests。
- [x] 20 场景产品 E2E 链：479 assertions，0 FAIL / 0 SKIP。
- [x] 跨租户 TCK：9 suites / 62 tests，HTTP + PostgreSQL 隔离。
- [x] 真实 Chromium + PostgreSQL：3/3；mock Chromium：121/121。
- [x] fresh migration chain：apply PASS，verify 101/101。
- [x] Bandit 0 critical/high；production npm audit high 阈值 exit 0。
- [x] standalone 构建、类型检查、Lint、13 条回归门禁和世界快照契约通过。

### 诚实缺口
- [ ] 全仓逐行账本仍为 83/2707，不能声称“全仓代码已逐行吃透”。
- [ ] 真实硬件、真实产线数据、真实外骨骼人因和真实部署网络未验证。
- [ ] npm 仍有 1 low / 24 moderate 依赖告警，需依赖供应商升级路线处理。

### 递归补遗（同日）
- [x] 100k 工作台性能门禁：10/10 场景 PASS，N+1 / 全表扫描 / 租户隔离守卫全过。
- [x] 新增 standalone_103 班次工作台查询索引（delayed-order composite + pg_trgm ILIKE），
      fresh chain verify 从 100/100 增至 101/101。
- [x] 性能种子改为可重复 truncate，基准视图名按运行实例隔离，ON CONFLICT 改用
      `(organization_id, task_id)` 真实唯一键；postgres 参数数组误展开修复。
- [x] 边缘适配器在授权确认后异常时也生成可审计 `failed` 回执；回执上传仍失败时
      进入既有持久重投账本。

## 阶段十：核心契约逐行审阅与世界模型修复 —— 状态：已验证（2026-09-20）

### 审阅收口
- [x] 数据库连接/事务上下文、PostgreSQL 故障兜底、数据保留服务完整审阅；
      账本新增 7 个哈希绑定文件。
- [x] Entity / EventEnvelope / Capability / Decision / ReasoningResult /
      PlannedVsActual / WorldContract 及其 TS 测试、Python world 契约与测试
      完整审阅；累计 16 个核心契约文件新增证据。
- [x] 全仓逐行账本推进到 109/2709；剩余 2,600 个文件继续诚实标记未审。

### 发现与修复
- [x] P1：WorldState 区间分组读取不存在的 `stateType`，实际退化为按 entityId
      一组，可把同一实体不同状态类别的合法区间误判重叠/版本断裂。
- [x] 修复：`stateType` 可选保留；缺失时显式回退 `entityType`；TS 与 Python
      分组语义同步，并新增双方 partition 回归。
- [x] P3：Capability subject 只要求冒号字符串，弱于 canonical identity；已登记
      后续契约迁移，不伪造兼容性完成。
- [x] P3：RetentionService 原先用 runtime 连接兜底可被 RLS 静默清空为 0 行；
      已改为显式 owner 串，清理 cutoff/BATCH/id 全参数化，并补测试。

### 验证
- [x] 目标契约/共享测试：7 suites / 54 tests PASS。
- [x] World Python + TS/Python parity：30 tests PASS。
- [x] Retention 边界测试：2 tests PASS。
- [x] standalone build、server/client 全量、Python 全量复跑通过。
- [x] 账本 report：109/2709 reviewed；0 stale / 0 partial / 0 missing。

## 阶段十一：工作编排控制面审阅与治理修复 —— 状态：已验证（2026-09-20）

### 审阅收口
- [x] DomainPersistenceService、WorkOrchestrationService/Controller/Module 及 4 个
      focused 回归完整审阅；账本新增 8 个哈希绑定文件。
- [x] 全仓逐行账本推进到 117/2709；剩余 2,592 个文件继续诚实标记未审。

### 发现与修复
- [x] P1：Git Sync durable 接口曾信任请求体 `actor` 并写入 evidence verifier；
      现改为认证 principal 权威，客户端 actor 兼容保留但不采信。
- [x] P2：带 idempotencyKey 的 handoff 创建曾“先读、先建、后登记幂等键”，并发
      竞争可产生多个交接；现改为业务创建与幂等键登记同事务，并补重放/创建调用测试。
- [x] 保持既有保障：资源锁租户必填、乐观锁与唯一键竞争 409、交接状态机 TOCTOU
      守卫、门禁损坏文件 fail-fast、证据 limit 不静默变空。
- [x] 登记 P3：过期时间非法时保守视为未过期；未来需在 API 边界显式校验 ISO 时间。

### 验证
- [x] 工作编排 focused：5 suites / 54 tests PASS。
- [x] standalone build PASS。
- [x] 服务端全量：389 suites / 3504 tests PASS。
- [x] 账本 report：117/2709 reviewed；0 stale / 0 partial / 0 missing。

## 阶段十二：执行反馈闭环逐行审阅 —— 状态：已验证（2026-09-20）

### 审阅收口
- [x] PlannedVsActual API/service、ExecutionReceipt provenance/state/application、
      ExecutionService 和其回归完整审阅；账本新增 7 个哈希绑定文件。
- [x] 全仓逐行账本推进到 124/2709；剩余 2,585 个文件继续诚实标记未审。

### 发现与修复
- [x] P2：ExecutionService.cancelForAssignments 只按 assignmentId 更新，缺认证租户
      谓词；现认证路径限定 primaryOrgId，无 actor 系统路径只触达显式 legacy NULL-org。
- [x] 补充租户取消与 NULL-org 系统路径回归。
- [x] P3 登记：FAILED 缺显式偏差类型时服务端保守推导 DEVICE_FAILURE，可能误归属；
      后续需契约迁移增加通用失败类型或强制现场显式选择。
- [x] P3 登记：PlannedVsActual 以 createdAt/应用时钟划窗，语义是“最近入账”而非
      “按事件发生时间”；已有触顶提示，未来可按事件时间迁移。

### 验证
- [x] 执行服务回归：10 tests PASS。
- [x] 执行反馈/计划实际/影子/SSV targeted：39 tests PASS。
- [x] standalone build PASS。
- [x] 服务端全量：389 suites / 3506 tests PASS。
- [x] 账本 report：124/2709 reviewed；0 stale / 0 partial / 0 missing。

## 阶段十三：执行边界/状态机/死信契约审阅 —— 状态：已验证（2026-09-20）

### 审阅收口
- [x] 7 个任务/告警/审批/控制/车队状态机、3 个策略契约、死信 schema、
      Actuator/Alert/DeadLetter 共享实现与测试、边缘 Actuator protocol 和
      Python 适配测试完整审阅；账本新增 19 个哈希绑定文件。
- [x] 全仓逐行账本推进到 142/2709；剩余 2,567 个文件继续诚实标记未审。

### 发现与修复
- [x] P3：授权号形状校验曾接受 `control:` 这类空标识；TS/Python 均已要求
      白名单前缀后必须还有非空标识，并补双侧负向向量。
- [x] 登记 P3：`return_to_dock` 会发起运动但按降险动作免授权；真实现场必须
      补路径净空/地理围栏证据，或纳入授权策略。
- [x] 确认既有边界：高危 `dispatch_task/resume/clear_fault` 需授权；`stop`
      永不被审批卡住且投递优先级最高；死信自动无限重试禁止；告警复开仅
      safety_admin；部署门禁 default deny。

### 验证
- [x] shared actuator：14 tests PASS。
- [x] dead-letter + alert state machine：15 tests PASS。
- [x] Python actuator adapter：20 tests PASS。
- [x] 状态机、production assembly/bus、Rego TCK、policy audit：全部 PASS。
- [x] standalone build、客户端全量：PASS。
- [x] 账本 report：142/2709 reviewed；0 stale / 0 partial / 0 missing。

## 阶段十四：统一事件契约逐行审阅 —— 状态：已验证（2026-09-20）

### 审阅收口
- [x] 70 类 AsyncAPI 事件目录、Envelope schema、共享向量、TS/Python 类型投影和
      事件目录审计门禁完整审阅；账本新增 6 个哈希绑定文件，约 2,856 行。
- [x] 全仓逐行账本推进到 148/2709；剩余 2,561 个文件继续诚实标记未审。

### 发现与修复
- [x] P3：事件目录审计此前只检查“通道引用有效”，未强制每个事件类型都有且只有
      一个通道；现新增 message/channel 一对一门禁，70/70 通过。
- [x] 登记语义：事件时间偏移/迟到采用“标记不丢弃”策略，消费者必须尊重
      `clockDrift/isLate`，不得当作确定时序事实。

### 验证
- [x] 事件目录：70 messages / 70 channels，孤儿与重复通道门禁 PASS。
- [x] Envelope contract：24/24 PASS；Python envelope：4 tests PASS。
- [x] TS envelope + golden scenarios：30 tests PASS。
- [x] 账本 report：148/2709 reviewed；0 stale / 0 partial / 0 missing。

## 阶段十五：派工协调器逐行审阅 —— 状态：已验证（2026-09-20）

### 审阅收口
- [x] DispatchCoordinatorService 完整审阅；账本新增 1 个 829 行哈希绑定文件。
- [x] 全仓逐行账本推进到 149/2709；剩余 2,560 个文件继续诚实标记未审。

### 发现与修复
- [x] P2：派工预检、事务内 assignment 分区和状态更新此前只按 planId/assignmentId，
      未继承选中 plan 的组织归属；现三处均绑定 selected plan tenant。
- [x] 保留既有保障：波内全有或全无、快照波次感知校验、安全阻断事务内复查、
      外骨骼会话提交时刻复查、降级安全路线 fail-closed、资源预占与决策台账。
- [x] 登记 P2 后续项：assignment status 更新还需要 version/status CAS，应在
      专用并发批次中补真实/替身集成测试。

### 验证
- [x] dispatch integration/wave/concurrency/route-cost：33 tests PASS。
- [x] TypeScript server check 和 targeted ESLint PASS。
- [x] standalone build PASS。
- [x] 账本 report：149/2709 reviewed；0 stale / 0 partial / 0 missing。

## 阶段十六：重排协调器逐行审阅 —— 状态：已验证（2026-09-20）

### 审阅收口
- [x] ReplanCoordinatorService 完整审阅；账本新增 1 个 1,178 行哈希绑定文件。
- [x] 全仓逐行账本推进到 150/2709；剩余 2,559 个文件继续诚实标记未审。

### 发现与修复
- [x] P1：5 处 scheduling run 状态更新此前只按 runId；schema 唯一性是
      `(orgId, runId)`，跨租户同 runId 可能误改他租户运行记忆。
- [x] 修复：所有 succeeded/failed 更新都绑定认证 `primaryOrgId + runId`。
- [x] 确认既有保障：production 跨实例守卫失败 fail-closed；非生产显式降级并上报；
      影响分析、冻结窗、最低改进抑制、方案持久化/失败闭环均按租户隔离。
- [x] 登记 P3：内部无租户上下文调用会退化 `ALL` 守卫键；对外暴露前必须 fail-closed。

### 验证
- [x] replan targeted：guard/failclosed、KPI、multi-instance、stability、storm、
      impact、dual-instance PostgreSQL E2E — 29 tests PASS。
- [x] TypeScript server check 和 targeted ESLint PASS。
- [x] standalone build PASS。
- [x] 账本 report：150/2709 reviewed；0 stale / 0 partial / 0 missing。

## 阶段十七：方案生命周期服务逐行审阅 —— 状态：已验证（2026-09-20）

### 审阅收口
- [x] PlanService 完整审阅；账本新增 1 个 1,791 行哈希绑定文件。
- [x] 全仓逐行账本推进到 151/2709；剩余 2,558 个文件继续诚实标记未审。

### 发现与修复
- [x] P2：approve/reject 在事务外校验生命周期，事务内只按 planId 更新；并发取消/
      派发后可能把终态方案改回 approved/rejected。现增加源状态限制和
      org/version/status CAS，assignment 更新继承 selected plan org。
- [x] 保留既有保障：审批独立性、shadow hard guard、快照过期结构化诊断、
      安全关键锁定检查、取消原因/不可回退项、约束继承与决策台账。
- [x] 登记 P3：审批前仿真为 advisory，失败不阻断人工审批；需持续监控生产失败。

### 验证
- [x] plan lifecycle/persistence/org/decision/pre-approval/shadow/dispatch targeted：
      6 suites / 56 tests PASS。
- [x] TypeScript server check 和 targeted ESLint PASS。
- [x] standalone build PASS。
- [x] 账本 report：154/2709 reviewed；0 stale / 0 partial / 0 missing。


## 阶段十八：派工 assignment 乐观锁补口 —— 状态：已验证（2026-09-20）

### 审阅收口
- [x] DispatchCoordinatorService 变更重新绑定当前哈希并合并审计台账。
- [x] DispatchTestHarness 全量审阅并合并台账；账本推进到 154/2709（新增 wave 与 concurrency 契约审查）。
- [x] 假数据库事务执行器改为 promise-chain 串行化，使并发测试不再允许
      PostgreSQL 事务不可能发生的交错读写。
- [x] 并发种子补齐 plan/assignment/task 的 org1 隔离字段，避免替身把
      “租户不匹配”误当成并发结果。

### 发现与修复
- [x] assignment 派工更新改为 org + status + version CAS。
- [x] 零行命中显式返回 ASSIGNMENT_CONCURRENT_UPDATE，不静默覆盖。
- [x] wave 回归验证 assignment version 从 1 递增到 2。
- [x] wave 种子原先使用 org-1 而认证上下文为 org1；已统一为 org1，避免假 DB 忽略谓词时掩盖租户不一致。
- [x] 移除临时调试输出；并发断言仍要求 1 成功 / 1 失败。

### 验证
- [x] TypeScript server check PASS。
- [x] targeted ESLint PASS。
- [x] dispatch integration + wave + serialized concurrency：3 suites / 24 tests PASS。
- [x] production standalone build PASS。
- [x] 账本 report：154/2709 reviewed；0 stale / 0 partial / 0 missing。
- [x] 登记测试替身 P3：makeQuery.where 忽略 SQL 谓词，现有业务代码多在后处理过滤，暂未掩盖本轮 CAS；后续需补 SQL 求值或替换替身。
- [ ] DB/RLS、scheduler-core 与 client workbench 审计批次进行中，结果尚未合并。


## 阶段十九：Outbox 租户与事务契约 —— 状态：已验证（2026-09-20）

### 审阅收口
- [x] OutboxService 与 outbox-throttled 契约测试完整审阅；账本推进到 156/2709。
- [x] Golden 派工场景种子补充 assignment version=1，与 assignment CAS 契约一致。

### 发现与修复
- [x] P1：enqueueThrottled 此前只按 eventType/entityId/status/time 合并，
      缺少组织边界；跨租户同形 entityId 可能覆盖 pending payload。
- [x] 修复：merge 条件按调用方 org 精确匹配；系统 NULL 事件只合并 NULL。
- [x] P3：throttled 事件此前不接受 executor 语义，错误路径补偿事件可能被
      事务回滚；现与 enqueue 相同支持显式 executor。
- [x] 新增同 entityId 不同 org 不合并回归。

### 验证
- [x] outbox + RLS + golden：3 suites / 15 tests PASS。
- [x] TypeScript server check 和 targeted ESLint PASS。
- [x] 账本 report：156/2709 reviewed；0 stale / 0 partial / 0 missing。
- [ ] DB/RLS、scheduler-core、client workbench 并行审计仍未返回。


## 阶段二十：standalone_103 数据库迁移审计 —— 状态：已验证（2026-09-20）

### 审阅收口
- [x] standalone_103 apply/rollback/verify 全量审阅并绑定哈希；账本推进到 159/2709。
- [x] 确认索引可重入、schema search_path 固定、复合索引以 org_id 为前导、
      trgm GIN 仅作用于非空 org 行。
- [x] 登记 P3：大表生产升级使用非并发 CREATE INDEX；verify 只按名称计数，
      后续需断言 indexdef 与谓词。

### 验证
- [x] 启动一次性 PostgreSQL 17 容器。
- [x] make migration-fresh-chain：apply PASS；verify 101/101 PASS；基线失败 0。
- [x] 验证后临时数据库与容器已删除。
- [x] 账本 report：159/2709 reviewed；0 stale / 0 partial / 0 missing。
- [ ] scheduler-core 与 client workbench 审计代理仍运行中。


## 阶段二十一：调度租户与策略原子性批次 —— 状态：已验证（2026-09-20）

### 审阅收口
- [x] ResourceReservationService、dispatch test harness、reservation concurrency
      完整审阅；账本推进。
- [x] SchedulerQueryService 与 runs/snapshot 契约测试完整审阅。
- [x] SchedulingPolicyService 与 policy version TCK 完整审阅。
- [x] 全仓逐行账本推进到 165/2709；0 stale / 0 partial / 0 missing。

### 发现与修复
- [x] P1：releaseForPlan 只按 planId 释放，未绑定 org；可能跨租户释放同形
      planId 的资源预占。现按 caller org + legacy NULL 释放，并新增跨租户回归。
- [x] P1：listRuns/getRun 属 HTTP 读面但缺少认证上下文守卫；listRuns 无 actor
      会全量查询。现统一 assertActorForHttp，并验证请求上下文缺 actor 返回 401。
- [x] P2：策略 save 的版本分配、旧 active 停用、新 active 插入不在同一事务；
      legacy activate 同样多步裸写。现通过 RequestDatabaseContext 原子化，
      版本号计算移入事务，缓存在提交后失效。
- [x] P3：active policy 30s 内存缓存依赖服务路径写入失效，直接 DB 改写可能
      读旧；已作为运维约束登记。

### 验证
- [x] 调度核心定向批次：8 suites / 130 tests PASS。
- [x] TypeScript server check PASS。
- [x] targeted ESLint PASS。
- [x] production standalone build PASS。
- [x] 账本 report：165/2709 reviewed；0 stale / 0 partial / 0 missing。
- [ ] scheduler-core 与 client workbench 后台审计仍无产出。


## 阶段二十二：冲突生命周期租户与持久化批次 —— 状态：已验证（2026-09-20）

### 审阅收口
- [x] ConflictService 全量审阅；conflict lifecycle/read-only 契约测试全量审阅。
- [x] 全仓逐行账本推进到 414/2709；0 stale / 0 partial / 0 missing。

### 发现与修复
- [x] P1：人工 resolve/suppress 的 SSE 事件未携带 orgId，跨租户订阅者可能
      收到他租户冲突生命周期事件。现两条路径绑定 caller org。
- [x] P2：批量 INSERT 失败被吞掉后仍广播 detected 并返回成功，形成
      “事件存在但事实未落库”的假成功。现让 reconcile 显式失败且不发事件。
- [x] 生命周期测试补齐 acknowledge/resolve/suppress 的 org 事件断言，
      并新增批量落库失败不广播回归。
- [x] 冲突查询仍保持纯读语义；显式 reconcileNow 才落库和通知。

### 验证
- [x] conflict lifecycle/read-only/perception/SSE/facade：
      5 suites / 83 tests PASS。
- [x] TypeScript server check PASS。
- [x] targeted ESLint PASS。
- [x] production standalone build PASS。
- [x] 账本 report：414/2709 reviewed；0 stale / 0 partial / 0 missing。
- [ ] scheduler-core 与 client workbench 后台审计仍无产出。


## 阶段二十三：世界状态分波新鲜度租户批次 —— 状态：已验证（2026-09-20）

### 审阅收口
- [x] WorldStateSnapshotService 全量审阅；新增跨租户分波回归全量审阅。
- [x] 全仓逐行账本推进到 415/2710；0 stale / 0 partial / 0 missing。
- [x] 后台 client/scheduler 审计代理因 5 小时额度限制停止；主线程继续审计。

### 发现与修复
- [x] P1：assertFreshForWave 只按 planId 查询本方案已派工 assignment 和资源
      预占，未绑定组织。跨租户同形 planId 可能被当作自身效果剔除，掩盖真实
      外部漂移。
- [x] 修复：assignment/reservation 自身效果查询绑定 caller/snapshot org，
      并显式保留 legacy NULL 行。
- [x] 新增回归：同 planId 的 org2 assignment 不会被 org1 剔除，org1 的
      T2 外部漂移仍触发 PLAN_STALE。
- [x] 登记 P3：read-only snapshot version 只找同 org 或 NULL，不虚构跨血缘
      fallback。

### 验证
- [x] world-state wave tenant + scheduler domain + dispatch wave/integration/
      concurrency + plan persistence：6 suites / 69 tests PASS。
- [x] TypeScript server check PASS。
- [x] targeted ESLint PASS。
- [x] production standalone build PASS。
- [x] 账本 report：415/2710 reviewed；0 stale / 0 partial / 0 missing。


## 阶段二十四：候选引擎与求解器租户策略批次 —— 状态：已验证（2026-09-20）

### 审阅收口
- [x] CandidateEngineService 和 SolverService 全量审阅。
- [x] candidate-engine parity 契约测试全量审阅；新增组织回退回归。
- [x] 全仓逐行账本推进到 418/2710；0 stale / 0 partial / 0 missing。

### 发现与修复
- [x] P1：共享候选池缺省策略/配置读取没有 org；buildCandidatePool 也不接受
      调用方已加载配置，反事实池会二次读取。
- [x] P1：SolverService 的 variants/solve/activation/shadow config 读取没有
      opts.orgId；heuristic/rule/MILP 的策略与配置回退同样缺组织。
- [x] 修复：所有策略/配置回退按 opts.orgId 作用域；候选池支持显式 config，
      主池与反事实池共用同一 tenant config；新增 getActivePolicy/getConfig
      收到 orgA 的回归。
- [x] 改动 heuristic/rule/MILP 后已通过对应求解器回归，但这些大文件尚未全量
      逐行标记 reviewed，诚实保留为后续审计项。

### 验证
- [x] candidate/routing/rule/MILP/invariants/activation/CP-SAT shadow：
      11 suites / 125 tests PASS。
- [x] TypeScript server check PASS。
- [x] targeted ESLint PASS。
- [x] production standalone build PASS。
- [x] 账本 report：418/2710 reviewed；0 stale / 0 partial / 0 missing。


## 阶段二十五：rule/MILP/heuristic 求解器全量批次 —— 状态：已验证（2026-09-20）

### 审阅收口
- [x] RuleBasedSchedulingSolver、MilpSchedulingSolver、HeuristicSchedulingSolver
      全量审阅；rule/MILP 契约测试与 candidate parity 全量审阅。
- [x] SchedulingSolver/SolveOptions 接口全量审阅。
- [x] 全仓逐行账本推进到 424/2710；0 stale / 0 partial / 0 missing。

### 发现与修复
- [x] P2：rule/MILP/heuristic 都先加载租户 config，但候选池未接收该 config；
      并发策略激活可能造成候选约束与求解评分口径分裂。
- [x] 修复：同一 config 传入候选池；heuristic/CP-SAT 的公共 load helpers 按
      org 作用域；CP-SAT 模型时长也复用同一 config。
- [x] P3：heuristic 候选比较在 person/device 后缺少 station 终序；已补充
      stationId 确定性 tie-break。
- [x] 新增 rule/MILP org config propagation 和 heuristic org policy/config 断言。

### 验证
- [x] solver 全量相关批次：12 suites / 136 tests PASS。
- [x] 追加 rule/MILP/parity 回归 PASS。
- [x] TypeScript server check PASS。
- [x] targeted ESLint PASS。
- [x] production standalone build PASS。
- [x] 账本 report：424/2710 reviewed；0 stale / 0 partial / 0 missing。
- [ ] CP-SAT worker 实现仍未全量逐行审阅。


## 阶段二十六：CP-SAT 执行边界全量批次 —— 状态：已验证（2026-09-20）

### 审阅收口
- [x] CpSatSchedulingSolver、CpSatCircuitBreaker 及 contract/fallback/malformed/
      circuit/shadow compare 契约测试全量审阅。
- [x] 全仓逐行账本推进到 431/2710；0 stale / 0 partial / 0 missing。

### 发现与修复
- [x] P0：worker 返回的 assignment 此前只校验形状，不校验任务/人员/设备/工位
      是否真实、是否重复、是否通过安全与资格过滤、是否超过工位容量。
- [x] 修复：新增语义响应校验；未知资源、重复任务、资格/安全绕过、工位超容量
      一律拒绝并回退 heuristic。
- [x] 显式 fallbackReason=cpsat_response_semantic_validation_failed，并累计熔断。
- [x] 新增 9 条语义绕过回归；保留合法 OPTIMAL 响应回归。
- [x] 登记 P3：SolverRequest.requestId 与 HTTP correlation UUID 未统一，后续
      需契约安全地收敛。

### 验证
- [x] CP-SAT/breaker/shadow/fallback/malformed + rule/MILP/parity：
      9 suites / 84 tests PASS。
- [x] TypeScript server check PASS。
- [x] targeted ESLint PASS。
- [x] production standalone build PASS。
- [x] 账本 report：431/2710 reviewed；0 stale / 0 partial / 0 missing。


## 阶段二十七：资格闸门安全与可用窗口批次 —— 状态：已验证（2026-09-20）

### 审阅收口
- [x] EligibilityService 全量审阅；eligibility-reservation 契约测试全量审阅。
- [x] 候选引擎与 heuristic 的 safety/device wiring 重新绑定当前哈希。
- [x] 账本保持 431/2710；0 stale / 0 partial / 0 missing。

### 发现与修复
- [x] P0：EligibilityContext 此前只带 safetyBlockedPersonIds，没有设备安全封锁
      集合；heuristic/候选引擎可能给安全封锁设备生成候选。
- [x] 修复：新增 safetyBlockedDeviceIds 硬拒绝，并接入候选引擎、heuristic
      常规枚举与 reuse fast-path。
- [x] P1：person/device/station 可用窗口此前只要求与候选区间重叠；任务可以在
      窗口外执行大部分时间。
- [x] 修复：候选区间必须完整落入至少一个正空间可用窗口。
- [x] 新增 4 条边界回归：安全设备拒绝，人员/设备/工位完整窗口包含。

### 验证
- [x] eligibility/candidate/heuristic/MILP/CP-SAT targeted：
      9 suites / 122 tests PASS。
- [x] TypeScript server check PASS。
- [x] targeted ESLint PASS。
- [x] production standalone build PASS。
- [x] 账本 report：431/2710 reviewed；0 stale / 0 partial / 0 missing。


## 阶段二十八：现场作业台数据可信度批次 —— 状态：已验证（2026-09-20）

### 审阅收口
- [x] FieldOperations 页面、纯逻辑层和逻辑测试全量审阅。
- [x] 全仓逐行账本推进到 434/2710；0 stale / 0 partial / 0 missing。

### 发现与修复
- [x] P1：首次加载或请求失败时 dataUpdatedAt=0 会让页面进入“数据已过期”
      分支，可能立即渲染不可信结论。
- [x] 修复：显式区分 dataAvailable 与 dataFresh；新增 FIELD_DATA_NOT_READY
      状态，首次加载/失败不派生任务提醒，也不冒充“数据已过期”。
- [x] 保持数据真正过期时只显示可信度告警、不产出待办类提醒的既有边界。

### 验证
- [x] FieldOperations targeted：1 suite / 21 tests PASS。
- [x] client type check PASS。
- [x] targeted ESLint PASS。
- [x] production standalone build PASS。
- [x] 账本 report：434/2710 reviewed；0 stale / 0 partial / 0 missing。


## 阶段二十九：调度中心客户端与分波后果批次 —— 状态：已验证（2026-09-20）

### 审阅收口
- [x] Scheduling 页面、方案动作源、过期诊断面板、分波派工面板/逻辑及全部
      Scheduling 客户端测试全量审阅。
- [x] 全仓逐行账本推进到 445/2710；0 stale / 0 partial / 0 missing。

### 发现与修复
- [x] P1：分波派工确认文案声称“当前没有取消派工接口”；但后端 DR-5 已支持
      方案级受控取消/回滚。
- [x] 修复：确认文案改为“未开始项可通过方案级取消/回滚收回；已开始项不可
      回退”，不再夸大不可逆范围。
- [x] 更新分波文案回归，锁定可回退与不可回退边界。

### 验证
- [x] Scheduling 客户端全量 targeted：5 suites / 120 tests PASS。
- [x] client type check PASS。
- [x] targeted ESLint PASS。
- [x] production standalone build PASS。
- [x] 账本 report：445/2710 reviewed；0 stale / 0 partial / 0 missing。


## 阶段三十：审批控制台租户缓存与错误处理批次 —— 状态：已验证（2026-09-20）

### 审阅收口
- [x] ApprovalConsole 页面、纯逻辑层、逻辑测试和渲染测试全量审阅。
- [x] 全仓逐行账本推进到 449/2710；0 stale / 0 partial / 0 missing。

### 发现与修复
- [x] P1：Agent 审批、调度审批、执行边界授权、审批详情和提醒治理缓存使用裸键，
      未按组织分片；切换账号后可能短暂命中上一租户数据。
- [x] 修复：五类查询全部挂到 tenant-scoped approvals/notifications 前缀，
      并新增缓存键回归。
- [x] P2：Agent/调度审批 mutation 缺 onError，横幅展示原始 axios message。
- [x] 修复：失败显式 toast，并使用 parseError 透出服务端原因。

### 验证
- [x] ApprovalConsole targeted：2 suites / 38 tests PASS。
- [x] client type check PASS。
- [x] targeted ESLint PASS。
- [x] production standalone build PASS。
- [x] 账本 report：449/2710 reviewed；0 stale / 0 partial / 0 missing。


## 阶段三十一：调度控制器审计身份与审计理由批次 —— 状态：已验证（2026-09-20）

### 审阅收口
- [x] SchedulerController 与 SchedulerService 全量审阅。
- [x] ConflictService 变更重新绑定当前哈希；conflict lifecycle 测试更新审阅。
- [x] 全仓逐行账本推进到 451/2710；0 stale / 0 partial / 0 missing。

### 发现与修复
- [x] P1：冲突 acknowledge/resolve/suppress 此前可使用 body.operator 覆盖审计
      身份；已改为认证 ctx.userId 唯一权威，客户端 operator 仅兼容保留。
- [x] P1：策略激活/回滚此前可使用 body.operator/approver 作为审计身份；
      控制器现在强制使用认证主体，legacy approver 仅 API 兼容。
- [x] P2：冲突人工确认/解决/抑制此前允许空 reason；现控制器统一拒绝空白理由。
- [x] 新增攻击者 operator 回归：认证主体 u1 不会被 body operator attacker 覆盖。
- [x] 登记 P3：executions 仍接受 personId 参数，后续需为非特权角色添加
      “只能查自己”的服务端显式断言。

### 验证
- [x] conflict/policy/SSE targeted：4 suites / 44 tests PASS。
- [x] TypeScript server check PASS。
- [x] targeted ESLint PASS。
- [x] production standalone build PASS。
- [x] 账本 report：451/2710 reviewed；0 stale / 0 partial / 0 missing。


## 阶段三十二：执行读面身份强约束 —— 状态：已验证（2026-09-20）

### 审阅收口
- [x] SchedulerQueryService 变更重新绑定当前哈希并全量审阅。
- [x] SchedulerController 的 P3 后续项闭环。
- [x] 全仓逐行账本推进到 452/2710；0 stale / 0 partial / 0 missing。

### 发现与修复
- [x] P1：executionList 允许调用方传 personId；worker/device_ops 角色扩展后
      可能查询同组织其他人员的执行台账。
- [x] 修复：非特权 HTTP 调用者必须有 token 绑定 personId；查询他人返回 403；
      省略 personId 时服务端强制收敛为自己。
- [x] 新增未绑定、查询他人、省略 personId 三类回归。

### 验证
- [x] scheduler facade/person scope：1 suite / 59 tests PASS。
- [x] execution/runs targeted：2 suites / 22 tests PASS。
- [x] TypeScript server check PASS。
- [x] production standalone build PASS。
- [x] 账本 report：452/2710 reviewed；0 stale / 0 partial / 0 missing。


## 阶段三十三：班次工作台租户缓存批次 —— 状态：已验证（2026-09-21）

### 审阅收口
- [x] ShiftWorkbench 页面、纯逻辑层、逻辑测试和渲染测试全量审阅。
- [x] queryKeys 新增三个工作台缓存契约并全量审阅。
- [x] 全仓逐行账本推进到 457/2710；0 stale / 0 partial / 0 missing。

### 发现与修复
- [x] P1：设备责任人覆盖、感知融合、预计 vs 实际三个查询使用裸缓存键，
      切换组织后可能短暂显示上一组织数据。
- [x] 修复：新增 tenant-scoped queryKeys，并迁移页面读取和感知融合失效键。
- [x] 新增缓存键回归，证明三个键都带组织作用域。

### 验证
- [x] ShiftWorkbench targeted：2 suites / 42 tests PASS。
- [x] client type check PASS。
- [x] targeted ESLint PASS。
- [x] production standalone build PASS。
- [x] 账本 report：457/2710 reviewed；0 stale / 0 partial / 0 missing。


## 阶段三十四：移动离线库身份隔离批次 —— 状态：已验证（2026-09-21）

### 审阅收口
- [x] MobileWorkbench useOfflineWorkbench 全量审阅；offline shell status 全量审阅。
- [x] offlineDb 核心契约测试全量运行；新增离线库名称作用域回归。
- [x] 全仓逐行账本推进到 459/2710；0 stale / 0 partial / 0 missing。

### 发现与修复
- [x] P0：离线 IndexedDB 此前固定名 ewoh-offline，不区分组织/用户/绑定身份；
      共享设备切换账号后，上一工人的待同步操作和异常照片可能被展示或由新登录
      自动 flush。
- [x] 修复：离线库名按认证 org/user 隔离；监听登录/切换/登出，关闭旧库并清空
      页面投影后打开新身份作用域库。
- [x] Shell 离线状态探针同步使用当前身份作用域，不再统计他人待办。
- [x] 登记 P3：历史全局库中的既有数据不再被消费，但共享设备仍需运维策略
      决定何时物理删除。

### 验证
- [x] MobileWorkbench/FieldOperations targeted：4 suites / 29 tests PASS。
- [x] offlineDb targeted：1 suite / 25 tests PASS。
- [x] client type check PASS。
- [x] production standalone build PASS。
- [x] 账本 report：459/2710 reviewed；0 stale / 0 partial / 0 missing。

## 阶段三十五：遗留离线队列安全迁移批次 —— 状态：已验证（2026-09-21）

### 审阅收口
- [x] offlineDb 源码与契约测试按当前哈希全量审阅。
- [x] 全仓逐行账本推进到 461/2710；0 stale / 0 partial / 0 missing。

### 发现与修复
- [x] P0：旧版 localStorage 队列没有认证 owner/org 绑定；若自动迁移到当前
      身份作用域 IndexedDB，共享设备换人登录时可能把上一工人的操作和照片归属
      到新登录并自动提交。
- [x] 修复：迁移改为 fail closed；不再导入无归属遗留动作，返回 0 条。
- [x] 保留旧 localStorage 原始证据，不自动删除，留给带外负责人审查。
- [x] 写入 skipped=true、reason=legacy_queue_has_no_owner_binding、数量和时间
      的迁移标记，避免反复扫描。
- [x] 修复测试中的存储访问断言，通过 StorageLike.getItem 验证原始数据保留。

### 验证
- [x] targeted ESLint：offlineDb 源码与测试 PASS。
- [x] offlineDb targeted：1 suite / 25 tests PASS。
- [x] production standalone build PASS。
- [x] 账本 report：461/2710 reviewed；0 stale / 0 partial / 0 missing。

## 阶段三十六：角色工作台上下文与共享视图批次 —— 状态：已验证（2026-09-21）

### 审阅收口
- [x] RoleWorkbench 页面、列表、视图、KPI、输入、导出、权限、状态、窗口化和
      优先级模块，以及对应测试全量审阅。
- [x] Workbench saved view 服务、PostgreSQL store 和新增服务测试全量审阅。
- [x] 全仓逐行账本推进到 495/2711；0 stale / 0 partial / 0 missing。

### 发现与修复
- [x] P1：旧版 localStorage 工作台视图没有 owner/org 绑定；共享设备换人后自动
      推送会把上一用户偏好导入当前账号。现改为 fail closed：保留原始数据并写
      skipped 标记，不做自动迁移。
- [x] P2：共享视图列表可见，但删除查找只查本人行，导致共享视图无法删除。
      服务端改为同组织 own-or-shared 解析；删除仍校验 owner/global_admin，
      并继续绑定真实 owner 行。
- [x] P2：导出轮询跨角色继续执行，可能把上一角色任务状态/下载注入新角色。
      现在角色切换和卸载统一取消计时器并重置导出状态。
- [x] P2：角色切换保留旧角色的筛选、排序、页码和已打开视图，现在统一重置。
- [x] P2：分页刷新会丢掉之前“加载更多”页；现在按页号合并并在刷新时替换同页。
- [x] P3：无效截止时间不再污染排序，也不再显示 Invalid Date，改为明确无效提示。

### 验证
- [x] RoleWorkbench client targeted：7 suites / 81 tests PASS。
- [x] Workbench saved view server targeted：1 suite / 4 tests PASS。
- [x] full lint + server/client type check PASS。
- [x] production standalone build PASS。
- [x] 账本 report：495/2711 reviewed；0 stale / 0 partial / 0 missing。

## 阶段三十七：离线存储与移动现场批次 —— 状态：已验证（2026-09-21）

### 审阅收口
- [x] offlineQueue、storageController、offlineLeader 及对应测试全量审阅。
- [x] MobileWorkbench 剩余页面、组件、hooks 和测试全量审阅。
- [x] 全仓逐行账本推进到 513/2712；0 stale / 0 partial / 0 missing。

### 发现与修复
- [x] P2：BroadcastChannel 回退选举在 claim 重叠时可能双主；现按 claim 窗口
      和确定性 token 只允许一个 leader，并补同 tick 并发回归。
- [x] P2：登出/身份清理只清 election 缓存，不释放已解析 leader；现 clear 会
      release leader 并关闭通道，避免新身份被旧租约阻塞。
- [x] P2：移动冲突记录此前一键丢弃；现要求确认不可撤销并提示先导出备份。
- [x] P3：队列选择中的陈旧 id 会被清理，批量重试不再包含已消失项。
- [x] P3：质检 pass/fail/rework 不再暴露原始枚举，改为现场中文标签。

### 验证
- [x] offline storage targeted：3 suites / 30 tests PASS。
- [x] MobileWorkbench targeted：4 suites / 13 tests PASS。
- [x] full lint + server/client type check PASS。
- [x] production standalone build PASS。
- [x] 账本 report：513/2712 reviewed；0 stale / 0 partial / 0 missing。

## 阶段三十八：事件审批失败关闭批次 —— 状态：已验证（2026-09-21）

### 审阅收口
- [x] SchedulerEventApplicationService 全量重新绑定当前哈希并审阅。
- [x] PlanService 审批政策片段在既有全量审阅基础上做变更重审。
- [x] 新增审批失败关闭回归并全量审阅。
- [x] 全仓逐行账本推进到 515/2713；0 stale / 0 partial / 0 missing。

### 发现与修复
- [x] P1：策略配置读取、影响分析或快照读取失败时，人工审批 consult 可能
      返回 null，事件随后自动重排，安全事件在依赖不可用时绕过审批。
- [x] 修复：未知错误不再是“未配置”；事件编排层统一失败关闭为
      HUMAN_APPROVAL_REQUIRED，原因 approval_policy_unavailable，并持久化审批
      事件。只有明确的“无政策配置”契约保留 AUTO_REPLAN。
- [x] PlanService 不再吞掉 resolveReplanApprovalConfig 的读取错误。

### 验证
- [x] event approval fail-closed targeted：1 test PASS。
- [x] facade/preview/event targeted：3 suites / 69 tests PASS。
- [x] full lint + server/client type check PASS。
- [x] production standalone build PASS。
- [x] 账本 report：515/2713 reviewed；0 stale / 0 partial / 0 missing。

## 阶段三十九：实时事件来源与信令批次 —— 状态：已验证（2026-09-21）

### 审阅收口
- [x] SchedulerStreamService、phase2 实时测试、前端 SSE hook、实时纯逻辑核心
      与测试全量审阅。
- [x] 全仓逐行账本推进到 520/2713；0 stale / 0 partial / 0 missing。

### 发现与修复
- [x] P2：outbox payload 缺少 occurredAt 时，服务端用当前映射时间伪造成事件
      发生时间；现回落到 durable source createdAt，serverTs 保持独立。
- [x] P2：前端无法解析的 scheduling.event 曾被静默忽略，畸形 envelope 还可能
      推进续传游标；现显式终止流并进入错误/恢复路径。
- [x] P2：新增运行时事件 envelope 校验，非安全整数 sequence、空 eventType 或
      eventId 不得进入批处理和单调游标。
- [x] SSE 解析兼容 CRLF。

### 验证
- [x] scheduler phase2 realtime targeted：1 suite / 13 tests PASS。
- [x] realtime core targeted：1 suite / 36 tests PASS。
- [x] full lint + server/client type check PASS。
- [x] production standalone build PASS。
- [x] 账本 report：520/2713 reviewed；0 stale / 0 partial / 0 missing。

## 阶段四十：数据库租户/事件迁移批次 —— 状态：已验证（2026-09-21）

### 审阅收口
- [x] 15 个租户、事件、幂等、通知和索引迁移及 3 个对应既有验证 SQL 全量审阅。
- [x] 新增 standalone_104 迁移、回滚和验证 SQL 全量审阅。
- [x] run_migrations 变更做语法与真实库执行验证；文件本体仍不声明完整逐行审阅。
- [x] 全仓逐行账本推进到 539/2716；0 stale / 0 partial / 0 missing。

### 发现与修复
- [x] P2：ewoh_event.confidence 注释声明 [0,1]，但数据库只定义 numeric(5,4)，
      无 CHECK；旁路写入可落入负值或大于 1 的“置信度”。
- [x] 修复：standalone_104 增加 validated CHECK；NULL 继续表示“未声明”。
- [x] 登记 P3：028 显式非空 org 会绕过派生；当前应用写入省略 org 并由触发器
      推导，verify 可查存量错配，未来直写路径需强制权威派生。
- [x] 登记 P3：059 legacy NULL 空间实体在过渡期不参与复合唯一，新路径已 fail closed。
- [x] 登记 P3：060 非 HTTP 无 GUC 默认归入默认组织，是既有迁移契约，运维必须
      设置租户上下文。

### 验证
- [x] 真实 PostgreSQL standalone_104：apply PASS、verify PASS、rollback PASS、
      rollback 后 verify 按预期 FAIL、re-apply PASS、re-verify PASS。
- [x] 全新临时库完整迁移链：104/104 migrations apply PASS；
      102/102 standalone verify PASS；基线失败 0。
- [x] node run_migrations/chain 语法检查 PASS。
- [x] git diff --check PASS。
- [x] 账本 report：539/2716 reviewed；0 stale / 0 partial / 0 missing。

## 阶段四十一：调度事件与 SSE 恢复批次 —— 状态：已验证（2026-09-21）

### 审阅收口
- [x] 六个调度事件/SSE 测试文件全量审阅；Controller 与事件应用服务变更重审。
- [x] 全仓逐行账本推进到 545/2716；0 stale / 0 partial / 0 missing。

### 发现与修复
- [x] P2：SSE replaySince 查询失败时，旧实现只降级为实时流，Last-Event-ID
      到当前序列之间的事件被静默丢失。
- [x] 修复：重放失败现在查询权威 currentSequence 并发送 reason=replay
      unavailable 的 resync；currentSequence 也失败时 fail closed 为 0。
- [x] P3：人工审批路径在可选 preview 服务缺失时不再抛错；审批仍保持失败关闭。
- [x] 更新 batch6 测试替身，明确 resolveReplanApprovalConfig 契约。

### 验证
- [x] scheduler event/stream targeted：7 suites / 44 tests PASS。
- [x] full lint + server/client type check PASS。
- [x] production standalone build PASS。
- [x] 账本 report：545/2716 reviewed；0 stale / 0 partial / 0 missing。

## 阶段四十二：AI/Agent 执行边界批次 —— 状态：已验证（2026-09-21）

### 审阅收口
- [x] Agent 工具注册表、指标、控制器、服务核心全量审阅。
- [x] TypeScript/Python Agent Manifest 校验、共享行为测试和策略 TCK 全量审阅。
- [x] standalone_105 迁移、回滚、验证 SQL 全量审阅。
- [x] 全仓逐行账本推进到 556/2719；0 stale / 0 partial / 0 missing。

### 发现与修复
- [x] P1：任意已认证账号可注册 Agent Manifest，并可能直发自治命令；注册收敛
      global_admin，直发执行收敛 dispatcher/workshop_lead/global_admin。
- [x] P1：L3 契约允许 high 风险和 dispatch_task/create_work_order 等高危写命令，
      可绕过审批。TS、Python 和独立仲裁器同步收紧为 low 风险 + 安全命令白名单 +
      simulationData-only 写作用域。
- [x] P1：存量不合规 L3 可能继续执行；standalone_105 将其 suspended，不删除证据，
      需管理员按新契约重新注册。
- [x] P3：Agent step budget 是进程内防风暴护栏，重启清零；保持文档化诚实边界。
- [x] 策略 TCK 样例从违反新 L3 契约的“high/空审批清单”更新为合规低风险自治。

### 验证
- [x] Agent/shared targeted：6 suites / 96 tests PASS。
- [x] Python 契约/golden targeted：299 tests PASS。
- [x] 独立契约仲裁：589/589 PASS。
- [x] ruff agent contract PASS。
- [x] 真实 PostgreSQL：standalone_105 对不合规 L3 selfcheck PASS，旧清单变为
      suspended。
- [x] 全新 PostgreSQL 完整链：105 migrations apply PASS；103/103 verify PASS。
- [x] full lint + server/client type check PASS。
- [x] production standalone build PASS。
- [x] 账本 report：556/2719 reviewed；0 stale / 0 partial / 0 missing。

## 阶段四十三：推理层事实治理批次 —— 状态：已验证（2026-09-21）

### 审阅收口
- [x] ReasoningController、ReasoningService 和两个测试文件全量审阅。
- [x] 全仓逐行账本推进到 560/2720；0 stale / 0 partial / 0 missing。

### 发现与修复
- [x] P1：任意已认证调用方可手供 facts 并写入 L4 Inference 台账；manual
      evaluate 收敛为 global_admin。权威 evaluate-live 保持已认证工作流可用。
- [x] P2：推理结论台账落账失败原先只写日志，响应无法区分“无结论”与
      “结论未入账”；现返回逐条 ledgerFailures。
- [x] P3：缺省 traceId 原先按秒生成，同秒可碰撞；现改用 UUID。
- [x] 新增控制器角色元数据、租户委托、trace 唯一性和台账失败回归。

### 验证
- [x] reasoning targeted：2 suites / 22 tests PASS。
- [x] full lint + server/client type check PASS。
- [x] production standalone build PASS。
- [x] 账本 report：560/2720 reviewed；0 stale / 0 partial / 0 missing。

## 阶段四十四：AI/Ark 模型边界批次 —— 状态：已验证（2026-09-21）

### 审阅收口
- [x] AiController、AiService、ArkService 和三个 AI 测试文件全量审阅。
- [x] 全仓逐行账本推进到 567/2721；0 stale / 0 partial / 0 missing。

### 发现与修复
- [x] P1：AI 建议端点在租户上下文缺失时可写入无归属建议；同步和流式创建均
      改为必须绑定 primary org，流式端点在打开 SSE 前先做 401 校验。
- [x] P2：调用方声明的 snapshot 元数据曾展示为“当前世界快照”；现在显式校验
      非负整数版本/样本量、合法时间范围和先后顺序，并在 basis/risk/uncertainty
      中声明这是调用方声明、尚未服务端复核。
- [x] P3：Ark SSE 的畸形分片仍会被忽略以保护有效流；记录为已接受边界，不会
      因解析失败而编造文本。
- [x] 复核 Ark 凭据链：无内置密码、服务账号固定、AI 配置仅 global_admin、
      审计不落密钥明文。

### 验证
- [x] AI/Ark targeted：4 suites / 30 tests PASS。
- [x] full lint + server/client type check PASS。
- [x] production standalone build PASS。
- [x] 账本 report：567/2721 reviewed；0 stale / 0 partial / 0 missing。

## 阶段四十五：边缘认证与会话边界批次 —— 状态：已验证（2026-09-21）

### 审阅收口
- [x] 边缘 IdentityBackend、SessionManager 及 auth/auth-failclosed 测试全量审阅。
- [x] 全仓逐行账本推进到 571/2721；0 stale / 0 partial / 0 missing。

### 发现与修复
- [x] P1：runtime_mode 拼写错误此前会被当作 development，公开默认种子口令可能
      生效。现在只允许 development/simulation/production，未知模式 fail closed。
- [x] P2：进程级种子口令校验缓存只按首次环境派生，策略变化后可能复用旧凭据。
      缓存键现在绑定 runtime mode、auth backend 和全部种子口令来源指纹。
- [x] P3：确认内存会话/锁定是单进程边界；多实例生产需共享会话与锁定后端，
      已保留在审计发现中。
- [x] 新增 runtime mode 拼写错误和策略缓存绑定回归。

### 验证
- [x] edge auth targeted：test_auth + auth_failclosed，32 tests PASS。
- [x] broader edge auth/RBAC/security batch：113 tests PASS。
- [x] ruff check edge identity/session PASS。
- [x] 账本 report：571/2721 reviewed；0 stale / 0 partial / 0 missing。

## 阶段四十六：CI/部署门禁批次 —— 状态：已验证（2026-09-21）

### 审阅收口
- [x] security workflow、long-cycle-gates workflow、CODEOWNERS 和世界快照契约
      审计脚本全量审阅。
- [x] 全仓逐行账本推进到 575/2721；0 stale / 0 partial / 0 missing。

### 发现与修复
- [x] P2：long-cycle 只应用完整迁移链，未执行每条迁移 verify；现在 apply 后
      seed/user 前立即执行 standalone-chain --verify，任何迁移结构漂移都会阻断。
- [x] P2：world snapshot contract 在无库 static job 中跳过，而有库 E2E job 反而
      没有执行；现在 E2E 场景后用权威数据库执行该门禁。
- [x] P2：security job 校验未提交的 SBOM 路径，但同 job 不生成该文件；现在先生成
      运行时 SBOM 再校验，security job 不再依赖其他 workflow 的文件产物。
- [x] P3：CODEOWNERS 仍是占位团队句柄，生产落地前必须替换为可执行真实 owner。
- [x] P3：容器 Trivy 扫描在未提供镜像时记录 BLOCKED_BY_ENVIRONMENT，truth manifest
      不得将其计为 production ready。

### 验证
- [x] long-cycle/security workflow YAML parse PASS。
- [x] 真实 PostgreSQL standalone-chain --verify：103 migrations PASS。
- [x] world snapshot contract authoritative DB gate：最近 4 个快照 PASS。
- [x] make truth-check、audit-regression-gates、OpenAPI no-drift PASS。
- [x] make security / Bandit gate PASS（critical+high=0）。
- [x] SBOM 同 job 生成并校验 PASS（CycloneDX）。
- [x] 账本 report：575/2721 reviewed；0 stale / 0 partial / 0 missing。

## 阶段四十七：世界模型核心批次 —— 状态：已验证（2026-09-21）

### 审阅收口
- [x] StateStore、Replay、TelemetryWorldProjector、EventGraph 和 Predictor 全量审阅。
- [x] 世界模型单测与遥测投影测试全量审阅并扩展。
- [x] 全仓逐行账本推进到 582/2721；0 stale / 0 partial / 0 missing。

### 发现与修复
- [x] P2：EventGraph 可添加悬空边、未知关系；from_dict 可导入悬空/非法边和重复
      节点。现在运行时添加与持久化回放全部 fail closed。
- [x] P2：StateStore.from_dict 遇到同一 (entity,state) 多个当前态会静默覆盖。
      现在将损坏快照视为恢复失败，绝不猜测哪一条是事实。
- [x] P3：投影 Catalog 上行保持实体声明/首次状态观测语义，持续事实历史仍由状态
      版本承载；该边界已记录。
- [x] 新增事件边关系/悬空/重复节点回归，以及损坏状态快照多当前态回归。

### 验证
- [x] ruff check world_model + world tests PASS。
- [x] world model/projection/contract/closed-loop targeted：73 tests PASS。
- [x] 账本 report：582/2721 reviewed；0 stale / 0 partial / 0 missing。

## 阶段四十八：契约世界存储批次 —— 状态：已验证（2026-09-21）

### 审阅收口
- [x] ContractWorldStore 源码与契约行为测试全量审阅。
- [x] 全仓逐行账本推进到 584/2721；0 stale / 0 partial / 0 missing。

### 发现与修复
- [x] P2：snapshotVersion 计数器未随离线快照序列化；重启后会回到 0，重启后的旧
      快照可能被误判为比重启前更新。现在计数器持久化并在恢复时校验非负整数。
- [x] P2：恢复 StateStore 状态时绕过契约校验，可能把非法实体、来源、置信度或
      早于实体声明的状态重新导入。现在恢复前逐条重校验并与声明交叉校验。
- [x] P3：为兼容既有离线快照，恢复层同时接受 StateStore snake_case 和契约
      camelCase 字段；新快照继续由 StateStore 序列化。
- [x] 新增快照计数跨重启单调回归和非法恢复状态 fail-closed 回归。

### 验证
- [x] ContractWorldStore targeted：19 tests PASS。
- [x] broader world model/projection/closed-loop batch：74 tests PASS。
- [x] ruff check contract/world model and tests PASS。
- [x] 账本 report：584/2721 reviewed；0 stale / 0 partial / 0 missing。

## 阶段四十九：边缘事件上行批次 —— 状态：已验证（2026-09-21）

### 审阅收口
- [x] EventUplink 源码、事件上行测试和批次核算测试全量审阅。
- [x] 全仓逐行账本推进到 586/2721；0 stale / 0 partial / 0 missing。

### 发现与修复
- [x] P1：runtime mode 读取失败或配置为未知值时，事件上行此前按 development
      处理，production 下明文 HTTP + X-Ingest-Key 可能绕过禁用闸门。现在未知/
      读取失败一律按 production fail closed。
- [x] P3：stop() 原先只停止循环，不取消 STREAM_EVENTS 订阅；重启组件可能重复
      订阅并重复投递。现在 stop 会取消订阅并有限时 join worker。
- [x] 复核持久队列：入队追加、发送后压实、毒信封 dead-letter、有界缓冲和重启
      续传语义保持 at-least-once；云端按 (org,source,eventId) 幂等去重。

### 验证
- [x] event uplink targeted：15 tests PASS。
- [x] event/accounting/sensor uplink broader batch：40 tests PASS。
- [x] ruff check event uplink and tests PASS。
- [x] 账本 report：586/2721 reviewed；0 stale / 0 partial / 0 missing。

## 阶段五十：传感器上行批次 —— 状态：已验证（2026-09-21）

### 审阅收口
- [x] SensorUplinkBridge 源码、sensor uplink 测试和批内结果核算测试全量审阅。
- [x] 全仓逐行账本推进到 587/2721；0 stale / 0 partial / 0 missing。

### 发现与修复
- [x] P1：runtime mode 读取失败或未知值时，传感器上行按 development 处理，
      production 下明文 HTTP + X-Ingest-Key 可能绕过禁用闸门。现在未知/失败一律
      按 production fail closed。
- [x] P3：stop() 原先不取消 STREAM_SENSOR_FRAMES 订阅；重启组件会重复入队。
      现在取消订阅并有限时 join worker。
- [x] 复核批内结果核算：sent/duplicate/rejected 逐帧分类，错位结果退回整组乐观
      口径，拒绝帧转死信且不重复计数。
- [x] 复核队列一致性：入队追加与全量压实同锁串行，避免旧 inode 丢帧。

### 验证
- [x] sensor uplink targeted：18 tests PASS。
- [x] sensor/event uplink and accounting broader batch：38 tests PASS。
- [x] ruff check sensor uplink and tests PASS。
- [x] 账本 report：587/2721 reviewed；0 stale / 0 partial / 0 missing。

## 阶段五十一：治理保留与模型注册批次 —— 状态：已验证（2026-09-21）

### 审阅收口
- [x] RetentionManager、PurgeExecutor、ModelRegistry 全量审阅并修复。
- [x] 扩展治理与治理执行器回归测试。
- [x] 全仓逐行账本推进到 590/2721；0 stale / 0 partial / 0 missing。

### 发现与修复
- [x] P2：保留策略可配置 0 或任意负数；0 会让数据立即到期，小于 -1 会被误当成
      永不清理。现在只允许 -1（永不自动删除）或正整数天数。
- [x] P2：PurgeExecutor 接受 0/负 batch_size 时可在仍有到期数据时死循环；现在
      必须为正整数，非法值直接拒绝且不删除数据。
- [x] P2：ModelRegistry 重复 model_id 会静默覆盖既有治理记录与审计谱系；现在
      重复注册 fail closed。
- [x] P2：canary_ratio 可为 0、负数或大于 1；现在强制 (0,1]，避免灰度范围
      越权或无效。

### 验证
- [x] governance targeted：64 tests PASS（含新增安全回归）。
- [x] ruff check governance source and tests PASS。
- [x] 账本 report：590/2721 reviewed；0 stale / 0 partial / 0 missing。

## 阶段五十二：授权同意与隐私访问审计批次 —— 状态：已验证（2026-09-21）

### 审阅收口
- [x] ConsentManager、推理管道 consent 调用和治理测试全量审阅并修复。
- [x] 全仓逐行账本推进到 593/2721；0 stale / 0 partial / 0 missing。

### 发现与修复
- [x] P1：敏感数据授权检查的访问审计缺少访问发起者身份，无法回答“谁访问过”。
      is_allowed 现在强制 actor_id，check 审计记录该身份。
- [x] P2：授权授予/撤回可接受空人员、空用途、空授予人、空理由或空操作者；
      现在全部 fail closed。
- [x] P3：授权用途和字段去重，空字段路径拒绝；遥测推理管道传入
      inference-pipeline 作为可追溯访问者。
- [x] 新增输入校验、访问者归属、用途/字段去重回归。

### 验证
- [x] governance + inference targeted：126 tests PASS。
- [x] ruff check consent/pipeline/tests PASS。
- [x] 账本 report：593/2721 reviewed；0 stale / 0 partial / 0 missing。

## 阶段五十三：小型 CI 与发布来源批次 —— 状态：已验证（2026-09-21）

### 审阅收口
- [x] feishu/package/tests/test 四个 workflow 与 CODEOWNERS 相关 CI 语义全量审阅。
- [x] 全仓逐行账本推进到 597/2721；0 stale / 0 partial / 0 missing。

### 发现与修复
- [x] P2：package workflow 原先对工作区 tar 打包，可能混入未提交文件、生成产物
      或本地凭证；现在使用 git archive 从 HEAD 已提交树生成源码包。
- [x] P2：release archive 增加 SHA256 校验文件，并上传 tarball + checksum 两个
      provenance 产物。
- [x] P3：test workflow 的 browser metrics 可能如实报告 BLOCKED_BY_ENVIRONMENT；
      production readiness 必须继续由 truth gate 判定，不得把 artifact 视作 PASS。
- [x] P3：feishu JUnit 生成 continue-on-error 仅为诊断 artifact，npm test 仍是
      权威通过/失败门禁。

### 验证
- [x] package workflow YAML parse PASS。
- [x] 本地 Git HEAD archive 生成、SHA256 生成、sha256sum --check PASS。
- [x] archive 内容扫描：未发现 .env 或 node_modules 路径。
- [x] 账本 report：597/2721 reviewed；0 stale / 0 partial / 0 missing。

## 阶段五十四：边缘 HTTP 服务安全批次 —— 状态：已验证（2026-09-21）

### 审阅收口
- [x] Edge server.py 的认证、RBAC、CORS、静态路径、请求体上限、错误脱敏、
      TLS/速率限制接线和路由横切面全量审阅。
- [x] edge security production fixture 全量审阅并修正。
- [x] 全仓逐行账本推进到 599/2721；0 stale / 0 partial / 0 missing。

### 发现与修复
- [x] P2：导出 Content-Disposition 直接拼接请求派生的 device_id，可能通过
      CR/LF、引号或路径字符注入/污染响应头。现在文件名使用 ASCII 安全白名单，
      限制长度并保留稳定 .json 后缀。
- [x] P3：edge security production 测试未提供轮换种子口令，与新的 production
      身份 fail-closed 策略不匹配。fixture 已改用轮换凭据。
- [x] 复核确认：静态路径已阻断 .. 穿越；production GET/POST/PATCH 默认认证并
      RBAC；CORS 仅显式 allowlist；异常响应不回显内部细节；TLS 最小 1.2。

### 验证
- [x] edge server/security/monitoring/auth-failclosed targeted：65 tests PASS。
- [x] ruff check server and tests PASS。
- [x] 账本 report：599/2721 reviewed；0 stale / 0 partial / 0 missing。

## 阶段五十五：边缘认证与路由安全批次 —— 状态：已验证（2026-09-21）

### 审阅收口
- [x] auth.py、registry.py、_util.py、session.py 和 server.py 当前版本全量审阅。
- [x] 未知/不可读运行模式统一 fail closed；服务器认证、RBAC、CORS、速率限制
      和构建入口共用同一安全判定。
- [x] 生产刷新接口在认证后端不可用时拒绝进入演示 token 旋转。
- [x] 生产操作人解析只信任有效 bearer 会话，客户端自报字段仅留给
      development/simulation。
- [x] 会话保存原始 username，刷新和 /api/me 不再把 user_id 冒充用户名。

### 发现与修复
- [x] P1：`runtime_mode == "production"` 直接比较会在配置异常或拼写错误时
      fail open。共享判定现在只接受 development/simulation/production，
      其余和读取失败均按 production。
- [x] P1：production refresh 在 session manager 缺失时可落入演示分支。
      现在返回 503 `auth_unavailable` 且不发放 token。
- [x] P2：production 下 `resolve_actor` 仍可在 token 身份缺失时采纳
      `actor_id` 等客户端字段。现在直接返回 None，由写门禁拒绝。
- [x] P3：refresh 会用 user_id 覆盖 username；Session 现在保存用户名，
      refresh、/api/me 返回并保留原始身份。

### 账本纠偏
- [x] 重建当前内容快照时发现四条旧审查声明无法用现存的当前哈希证据复现；
      不再计入已审。这四项会被后续批次重新逐行审查后再合并。
- [x] `.github/workflows/perf.yml` 当前 234 行全量审阅，YAML 解析 PASS。
- [x] 权威账本：595/2721 reviewed；0 stale / 0 partial / 0 missing。

### 验证
- [x] auth/session/API/edge security/rbac/write-matrix/server targeted：178 tests PASS。
- [x] `ruff check` 认证路由、共享工具、server 和 session PASS。
- [x] `git diff --check` PASS。
- [x] delivery state JSON 解析 PASS。
- [x] audit ledger report：595/2721 reviewed；0 stale / 0 partial / 0 missing。

## 阶段五十六：遥测导出安全批次 —— 状态：已验证（2026-09-21）

### 审阅收口
- [x] telemetry.py 当前 139 行全量审阅；server.py 下载响应路径按当前 695 行复核。
- [x] 认证批次中的 auth.py、_util.py、registry.py 和 server.py 当前哈希一并重建审查证据。
- [x] 全仓逐行账本推进到 600/2722；0 stale / 0 partial / 0 missing。

### 发现与修复
- [x] P1：POST telemetry CSV 导出把请求派生 device_id 直接写入
      `Content-Disposition`，可注入/污染响应头。现在 `send_csv` 统一复用
      ASCII 文件名净化器，并限制长度。
- [x] P2：上一批只净化了 JSON 下载路径，同类 CSV 路径遗漏。回归覆盖 CR/LF、
      引号、路径分隔符和稳定附件名。

### 验证
- [x] telemetry export、download safety、auth、edge security、server characterization
      targeted：121 tests PASS。
- [x] `ruff check src/edge_platform/routes src/edge_platform/server.py` PASS。
- [x] `git diff --check` PASS。
- [x] audit ledger report：600/2722 reviewed；0 stale / 0 partial / 0 missing。

## 阶段五十六：遥测与世界路由批次 —— 状态：已验证（2026-09-21）

### 审阅收口
- [x] telemetry.py、world.py 和 routes/__init__.py 当前版本全量审阅；auth/_util/registry/server 沿用阶段 55 当前哈希证据。
- [x] 本批为既有 HTTP 路由边界的局部缺陷修复，未引入新技术栈，按约定跳过外部选型调研。

### 发现与修复
- [x] P1：GET `/api/telemetry/export` 是敏感数据出站，但 server 只自动审计 POST/PATCH；
      现在导出成功前显式写入 `telemetry/{device_id}` 审计。
- [x] P2：legacy `/api/event/status` 对不存在事件先更新再返回 `ok`；现在统一 404，
      且按 v2 相同语义写入处置事实账和 `risk_event` 审计目标。
- [x] P2：事件状态与处置事实原先分两次写入，第二段失败会留下无证据的状态半事实；
      新增 SQLite `record_event_status` 原子提交，失败整体回滚。
- [x] P2：`/api/reset` 属破坏性动作，现在审计目标明确为 `world/demo_reset`。
- [x] P3：自查发现不存在事件的 legacy 请求会在 404 前污染开/闭事件指标；
      存在性检查已提前，所有 rejected 请求不再进入指标。
- [x] 测试替身补齐 `record_event_status` 契约，避免生产路径与测试语义分叉。

### 账本
- [x] telemetry.py、world.py、routes/__init__.py 以当前 SHA256 全文合并。
- [x] 权威账本：600/2722 reviewed；0 stale / 0 partial / 0 missing。

### 验证
- [x] ruff：routes、storage 和相关测试 PASS。
- [x] targeted Python：API/storage/server safety/security/RBAC/monitoring/P0/write matrix
      共 173 tests PASS（3 个既有 scheduler deprecation warnings，无失败）。
- [x] Bandit 安全门禁 PASS：critical+high=0。
- [x] `git diff --check` PASS；delivery state JSON 解析 PASS。

## 阶段五十七：外骨骼绑定归属批次 —— 状态：已验证（2026-09-21）

### 审阅收口
- [x] exo.py 当前 261 行全量审阅；绑定、归还、服务端会话解析、Catalog 事件
      和唯一活跃绑定冲突路径均已检查。
- [x] 本批为既有边缘归属边界的局部安全修复，未引入新技术栈，按约定跳过外部选型调研。

### 发现与修复
- [x] P1：production 领用此前只依赖 `manage_devices` RBAC，任何可管理设备的
      会话都能把外骨骼指派给任意 person。现在非 admin 必须由服务端会话解析出
      相同 `person:` 身份；admin 可代领用；未知/不可读运行模式按 production fail closed。
- [x] P2：production 归还此前接受客户端 `endedBy` 并写入存储和事件，审计可被伪造。
      现在绑定本人记录服务端解析的 `person:` 身份，admin 代归还记录服务端 actor。
- [x] 回归覆盖：无 token 401、person 不匹配 403 且不落账、本人领用成功、
      admin 代领用与可信 `endedBy` 上行事件。

### 账本
- [x] exo.py 当前 SHA256 全文合并；权威账本推进到 612/2722；
      0 stale / 0 partial / 0 missing。

### 验证
- [x] exo/andon/RBAC/write matrix/edge security/auth fail-closed targeted：53 tests PASS。
- [x] `ruff check` routes/storage/exo regression PASS。
- [x] `git diff --check` PASS。

## 阶段五十六：租户隔离与调度器基础服务批次 —— 状态：已验证（2026-09-21）

### 审阅收口
- [x] org-scope/org-sentinels/ingest guard+controller/identity/policy 完整审阅。
- [x] control controller + inference controller/service + exo-assignment-guard 完整审阅。
- [x] alert/task/resource/scale/world/dashboard service 完整审阅。
- [x] scheduler pre-approval/dispatch-app/replan-app/metrics/plan-compare/replan-preview/
      policy-activation/shadow-policy/policy-replay/kpi/plan-application 完整审阅。
- [x] 全仓逐行账本推进到 629/2722；0 stale / 0 partial / 0 missing。

### 发现与修复
- [x] P3 登记：OrgScopeService.loadEffectiveConfig 层级环检测静默返回空配置而非
      报错（seen 集合阻断无限循环但可能截断配置继承）；后续应改为 fail-closed。
- [x] 复核确认：world.service.ts / resource-projection.service.ts 的 sql.raw ARRAY
      构造使用单引号转义，不可注入（实体 ID 来自 DB）。
- [x] 复核确认：scale.service.ts writeJsonPath 阻断 __proto__/constructor/prototype
      段（CWE-1321 原型污染）。
- [x] 复核确认：policy-activation CAS（R2-SSV-10）、shadow plan 原子标记（R2-SSV-03）、
      gate 证据不足显式确认（2026-09-10 治理修复）均生效。

### 验证
- [x] Server Jest: 394 suites / 3548 tests 全绿（测试修复后）。
- [x] Python: 1293 passed / 2 skipped。
- [x] type:check server+client 0 错。
- [x] truth-check 24/24 + GEN-CONTRACT-REGISTRIES OK。
- [x] 账本 report：629/2722 reviewed；0 stale / 0 partial / 0 missing。
