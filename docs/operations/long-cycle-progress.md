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
