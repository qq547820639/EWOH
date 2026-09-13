# 变更日志

本文件遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/) 1.1.0 规范，
并使用[语义化版本](https://semver.org/lang/zh-CN/) 2.0.0 进行版本管理。

## [Unreleased]

### Added
- **批次交付（NO-67a/b/c/d）：执行边界进浏览器验收 + 单设备投递配额 + 轮换提示 + 清理自证**：
  - **NO-67a 执行边界浏览器验收**：`test/browser/execution-boundary.spec.js`
    （**30 项 = 5 用例 × 6 浏览器画像**，含 axe 无障碍扫描；已接入 `npm run test:browser:mock`
    → 该套件由 100 → **105** 项）覆盖：在飞 / **排队（设备忙）** /
    已撤回逐条区分、授权可信度**两维**（指纹方案 + 是否复核）、违规留痕单列为安全事件、
    空列表"无命令 ≠ 设备正常"、读面失败显式报错。修掉 3 处 Playwright strict-mode 定位问题
    （同一文案在摘要与逐条说明重复出现 → 限定容器或用 count 断言**分布**，而不是"至少出现一次"）。
  - **NO-67b 单设备投递配额**：`EWOH_CONTROL_DELIVERY_QUOTA_PER_MINUTE`（默认 60；`<=0` 显式关闭）。
    真实设备控制通道吞吐有限（现场总线/WiFi/PLC 周期），平台"有多少投多少"会把设备打爆且
    平台侧看不出异常。配额用尽 → 普通命令显式排队（`deferred[{reason: quota, blockedBy: quota:N/min}]`，
    保持 `sent`，下一分钟自动继续）；**`stop` 插队且不占配额**。
    **同轮修掉一个口径缺陷**：首版用 `authorization_verified_at` 计配额，但该列在**下发**时也写
    （下发前同样过授权闸门）→ 刚下发的命令立刻把配额算成用尽（e2e 实测 `delivered=0/quotaDeferred=4`）。
    现在拆成两个事实：`authorization_verified_at`（授权复核通过）与 **`delivered_at`（已交付网关）**
    ——迁移 **095** 建列 + 部分索引（NULL = 从未交付），配额/审计/页面统一按 `delivered_at` 计。
    e2e 证据（步骤 19）：4 条 `pause` → **3 投递 + 1 排队（reason=quota）**。
  - **NO-67c 轮换窗口提示**：平台启动检测到 `EWOH_CONTROL_FINGERPRINT_SECRET_PREVIOUS` 会打醒目告警
    （窗口必须有期限：清零后立即移除，否则被替换的旧密钥一直可用）。
  - **NO-67d 清理自证推广**：`e2e:plan-staleness` 收尾删除后**计数**，残留甚至清理异常都记 FAIL
    （异常不许只 `warn`——NO-64 的教训）。
  - 验收：`e2e:control-actuator` **29 PASS / 0 FAIL / 0 SKIP**、浏览器 **30 项全绿**（mock 套件 105）、
    `migration-fresh-chain` **93/93**、控制域单测 59 例。

- **批次交付（NO-66a/b/c/d）：把执行边界的事实**交回现场**，并补上密钥轮换与场景预检**：
  - **NO-66a 设备执行边界人面读面（现场可用性）**：平台早已记录命令的完整生命周期
    （下发/投递确认/执行回执/授权复核撤回/未授权执行/一车一活排队/指纹方案），但此前
    **只有网关（机器身份）能读** `pending` —— 现场问"这台设备为什么不动""刚才那条命令
    为什么被拒"只能翻库或问工程师（违背原则 5/6）。新增
    `GET /api/control/requests?deviceId=`（只读；RBAC + 租户收敛）与设备抽屉里的
    **「执行边界」面板**：逐条区分待投递 / **排队（设备忙，暂缓≠失败）** / 已投递未回执 /
    已执行 / 失败 / 已撤回（附原因码与人话说明）；授权**指纹方案**与**是否复核通过**
    分开显示（不把"没验过"渲染成已验证）；违规留痕（`delivery_rejected` /
    `authorization_violation`）单独提示为**安全事件**；空列表显式说明"无命令 ≠ 设备正常"，
    读失败显式报错（不显示"一切正常"的假状态）。排队判定与投递闸门**同一实现**（不写第二套）。
    e2e 证据（步骤 17b/17c，真实 PG）：同一台设备"在飞=1、排队=1、占用者正确"对现场可见；
    未认证访问 401。`e2e:control-actuator` 由 26 → **28 项**。
  - **NO-66b 授权指纹密钥轮换窗口**：`EWOH_CONTROL_FINGERPRINT_SECRET_PREVIOUS` 让复核
    同时接受上一把密钥，而**签发只用当前密钥**——否则一次轮换会把现场正在执行的在飞命令
    判成"签名不符"并撤回。纪律：`previous == current` 不放宽；窗口只放宽**密钥**，
    仍拒绝被改写的范围；窗口有期限（runbook 四步：挪旧→切新→等在飞清零→立即移除）。
  - **NO-66c 过期处置接入 golden/wave**：两个场景的审批段改用共享助手
    `approveWithReplan`（诊断 → 重排 → 再审批，有界 2 轮），不再"过期即换候选/放弃"。
    实测：golden **22/22**、wave **12/12**（0 FAIL / 0 SKIP）。
  - **NO-66d 链前能力漂移预检**：`e2e-chain` 开头跑只读巡检（`capability-drift-check.js`），
    把"环境漂移"与"产品缺陷"在第一屏就分开（此前 116 台 `exo-lift` 漂移曾让
    `e2e:exo-session` 误报"没有具备该能力的设备"）。
  - 验收：控制域单测 **57 例**（新增读面 2 例 + 轮换 5 例）、面板渲染 **6 例**、
    OpenAPI 路由 **463/687**（新增 1 条读面契约，0 未登记）、
    `e2e:control-actuator` **28 PASS / 0 FAIL / 0 SKIP**。

- **批次交付（NO-65a/b/c/d）：把执行边界的"证据"从一致性升级为**可验证的凭证**，并修掉两处现场可用性缺陷**：
  - **NO-65a 签名授权范围指纹**：v1（FNV-1a）只能发现**偶然**漂移——算法公开、无密钥，
    任何持有边缘 ingest key 的一方能算出"看起来对"的指纹（真实产线上就是一条伪造通道）。
    现在平台用 `EWOH_CONTROL_FINGERPRINT_SECRET` 对授权范围做 **HMAC-SHA256**
    （`hmac-sha256:v2:<32hex>`，材料 = 请求/设备/命令/审批实例/参数），`pending` 同时下发
    **可重建的 `authorizationScope`**，边缘持同一密钥即可**验签**，验不过**不碰设备**
    （`fingerprint_signature_invalid`）；验签结论写进 ack 详情（"验过"与"没验"可区分）。
    平台复核按**已存指纹的方案**进行：v2 行缺密钥 → 显式拒绝
    （`revoked_reason=fingerprint_key_missing`，迁移 **094**），**绝不**退回无密钥校验；
    未配密钥时退化为 v1 并**启动告警**（不静默降级）。跨语言固定向量（TS/Python 同一断言）。
    实测：改写参数 → 平台复核即撤回（`fingerprint_mismatch` + `delivery_rejected`），
    边缘拿不到、设备不动。
  - **NO-65b 一车一活投递闸门**：设备上有**已投递未回执**（`gateway_received`）的运动命令时，
    同一设备的下一条运动命令**暂缓投递**（`deferred[{reason: device_busy, blockedBy}]`，
    命令保持 `sent`、设备空下来自动解除）；**安全动作永不暂缓**（stop/pause/return_to_dock/
    clear_fault 必须能插队）。首版实现把 `sent` 也算"在飞"→ 候选命令把自己当占用者，
    被单测当场抓出（`ids` 里同时出现占用者与候选），口径修正为"已投到设备"。
  - **NO-65c 能力停用漂移巡检与恢复**：被中断的运行只恢复"它这一轮停用的那批"，
    历史 `status='disabled'` 行会累积（实测 **exo-lift 116 台**）→ 别的场景报
    "没有具备 exo-lift 的设备"，**环境漂移被伪装成产品缺陷**。新增
    `scripts/capability-drift-check.js`（只读巡检 + 阈值退出码 + 处置指引）与
    `scripts/capability-restore.js`（走**产品审批路径**恢复；dry-run 默认；只恢复
    "设备仍声明该能力"的行，恢复等于凭空授予的一律跳过）。实测：漂移 116 → 恢复 116/116
    （单个批量审批）→ 巡检清零。
  - **NO-65d 场景清理自证**：清理语句执行后**数一遍**，有残留直接记 FAIL
    （NO-64 的真实缺陷就是清理引用了不存在的表/列、异常被 warn 吞掉）。
  - 验收：`e2e:control-actuator` **26 PASS / 0 FAIL / 0 SKIP**（含 v2 签名、参数改写撤回、
    一车一活、清理自证）；服务端签发/复核 7 例 + 边缘验签 6 例 + 跨语言向量 2 例。

- **批次交付（NO-64b）：审批确认人的身份边界 + 场景残留清理（两个真实缺陷）**：
  - **审计/授权边界缺陷**：`ewoh_schedule_plan.confirmed_by` 原写入**客户端自报**的
    `body.operator`，而它是"独立审批"安全闸门的输入（`hasIndependentApproval`：
    `createdBy ≠ confirmedBy`，回执授权 `RECEIPT_PLAN_NOT_AUTHORIZED` 读它）。
    写自报字段 = 审批人可以用别人的名字落库、也能把"自己生成自己审批"伪装成独立审批。
    现在一律写**认证主体** `ctx.userId`，自报操作者只作为**声明**进审计文案（可追溯、不参与判定）。
    实测代价：本仓库 e2e 里 created=admin/confirmed=admin（自报造成）→ 回执被正确拒绝，
    但根因在入库口径——修掉后 `e2e:receipt` 由 **7 FAIL + 3 SKIP** 变为 **19 PASS / 0 FAIL / 0 SKIP**。
  - **场景残留缺陷**：`e2e:agv-transport` 的收尾清理引用了**不存在的表名与列**
    （`ewoh_schedule_assignment.schedule_task_id`；真实表是 `ewoh_scheduling_plan_assignment`，
    关联列是 `task_id`）→ 清理语句抛错并被 `try/catch` 吞成一行 `console.warn`，
    于是该场景的 assignment/执行/反馈**从未被清理**；残留被 `e2e:receipt` 捡到（它挑选
    "非终态执行记录"）→ 看起来像回执链路坏了。现在按 `task_id` 清理
    预占/执行/事件/反馈/assignment（顺序保证引用先删），并补了 31s 冷却等待
    （MANUAL 触发去抖会"复用既有方案"，等待是确定性事实而不是运气）。
  - 验收：`e2e:receipt` 20/20、`e2e:agv-transport` 11/11、调度域单测 1155 例全绿；
    **同轮 e2e 链首次全绿：18/18 场景、420 PASS / 0 FAIL / 0 SKIP**（`make e2e-chain`）。
  - 场景确定性（同日）：`e2e:capability-explain` 固定目标能力（`EWOH_E2E_CAP_TARGET` 可覆盖，
    默认 `exo-lift`）并把"停用说明"断言校准为"至少一条完整停用留痕 + 缺失不得说成停用"——
    此前库里 `interact.assist` 覆盖 127 台设备，大量"从未声明该能力"的设备让断言误判（10 FAIL）。

- **批次交付（NO-64a）：把"审批窗口"从"记 SKIP"变成产品级修复——事实变化 vs 证据老化的分档闸门**：
  第 61–63 轮反复记录同一条环境事实：**方案到达即过期**（`PLAN_STALE`），导致 golden/receipt/wave/agv
  的审批腿要么记 SKIP、要么靠重排绕行。本轮审计确认这不是"环境噪声"，而是**判定口径缺陷**：
  `entityVersions` 摘要里混进了**随时间自然变化的派生字段**——
  - 设备 `status`/`online` 由遥测新鲜度推导（60s 没上报就变 OFFLINE）；
  - `telemetryUpdatedAt` 是**证据时钟本身**（每来一帧心跳就变，哪怕内容一模一样）。
  于是"什么都没发生、只是过了 60 秒"或"车照常报了一次心跳"都会让方案被判过期 →
  在大库里**没有任何方案批得下去**（真实工厂同样如此：AGV 1Hz 上报）。
  修复（`freshnessContentVersionGate`）：
  - 快照新增 `entityContentVersions`（**内容版本**：排除上述派生字段；证据新鲜时 `status` 仍计入
    ——人工停用/改派不会被漏判）与 `entityEvidence`（来源时间/质量/状态）；
  - 审批与派工**共用同一判定**：① 内容版本不同 → 事实变化 → 拒绝（`CONTENT_CHANGED`）；
    ② 仅版本不同（内容相同）→ 证据老化：方案**依赖**该实体且其 `dataQuality≠FRESH` → 拒绝
    （`EVIDENCE_STALE`，不拿过期证据背书）；**与方案无关** → 不阻断并如实报告；
    ③ 老快照缺内容版本 → 一律严格判定（fail-closed，不静默放宽）；
  - 过期诊断**分档呈现**：`severity` ∈ {content, blocked_evidence, evidence} + `usedByPlan` +
    `stalenessReason`，页面按"事实变化 / 依赖资源证据过期（需重采）/ 仅证据老化（不阻断）"三类展示
    （原则 5/7：可解释、不静默）；
  - 场景侧配套：`approveWithReplan` 新增 `beforeReplan` 钩子（重排是对**当前世界**重新求解，
    重排前补齐设备/人员心跳是现场事实，不是绕过闸门）；派工断言改为以 **assignment=dispatched**
    为准（执行行由现场开工时创建，"暂时没有执行行"是过度断言）。
  - **验收**：`e2e:agv-transport` 从"10 PASS + 1 SKIP"变为 **11 PASS / 0 FAIL / 0 SKIP**
    （审批经诊断→重排→再审批 200、派工 200、assignment 落 `dispatched`、本设备执行行已生成）；
    分档闸门 7 例单测 + 客户端 2 例。

- **批次交付（NO-62d）：Modbus/TCP 真实协议路径（真帧 + 假从站 + 寄存器契约）**：
  第 59 轮起"真机协议"一直挂在"外部条件"下；本轮把**协议路径本身**做成可跑通、可验证的：
  `ModbusTcpActuatorTransport`（主站：MBAP 头、FC03 读 / FC06 / FC10 写、异常响应 `0x83`+异常码、
  越界/非法功能/非法值一律异常响应**不返回 0 假装读到**）+ `FakeModbusSlave`（从站：真实帧解析，
  寄存器背后的设备是 `LoopbackActuatorTransport` 数字孪生）+ `RegisterMap` 寄存器契约
  （状态/坐标/电量/故障/目标 + 命令/参数/序号，参数先写、命令码最后写=提交点，避免半成品状态）；
  CLI 增 `--transport modbus --modbus-host/--modbus-port --source-type`（真机部署传 `real`，
  来源隔离不混）。测试 **13 例**：MBAP 定界与裸 socket 帧自证、异常码三态、越界拒绝、
  参数写入不触发动作、命令往返（dispatch/pause/resume/stop）、故障码编解码、
  从站不可达不伪造状态、传输关闭显式报错、**适配器授权顺序与传输无关**
  （被拒绝的命令不写任何命令寄存器）、**CLI 走真帧端到端**（平台命令 → Modbus 帧 → 从站 →
  设备 moving + 目标工位 → ack/回执）。**诚实边界**：线上协议是真的、设备是模拟的；
  不实现 RTU 的 CRC16（Modbus/TCP 用 MBAP 定界）；16 位工位哈希只用于协议内关联
  （真值在主站侧保留）——实测教训：直接截取 FNV-1a-64 前 4 位十六进制时 `ST-1`/`ST-2` 撞车，
  改为异或折叠并对 32 个工位号做分散性自证。

- **批次交付（NO-62a/b/c）：执行边界在投递路径上 fail-closed + 下行优先级 + 方案过期可解释（一次做完并验证）**：
  第 61 轮把"搬运任务真的派给 AGV"打通后，留下三个**真实缺陷**，本轮逐个销账：
  - **NO-62a 投递前授权复核（安全缺陷，不是缺功能）**：平台原来只在**人工下发**那一步校验审批
    （`ensureApprovedForSend`）。命令落成 `sent` 之后，网关轮询只看"请求行是否终态"——
    于是「审批通过 → 下发 → 网关投递」之间审批被撤销/过期，命令照样会投到 AGV 上执行：
    **授权链在投递路径上是 fail-open 的**。本轮：
    - 命令级**授权范围指纹**（`fnv1a64:v1`，覆盖 请求/设备/命令/审批实例/参数；平台与边缘
      Python **逐位一致**，固定向量双向钉死）随命令下发，网关 ack/回执**原样回传**，平台比对不符即拒绝；
    - 网关每次投递前**重新复核**审批（实例存在/已通过/未过期/租户一致）与指纹，
      任一不过 → 命令撤回（`status=revoked` + 封闭原因码 `authorization_expired` /
      `approval_missing` / `approval_not_granted` / `fingerprint_mismatch` / `request_terminal` /
      `device_org_mismatch`）+ `delivery_rejected` 结果行 + 审计 + 确定性提醒 `NTF-CTRL-*`，**不投给设备**；
    - `ack`（投递确认）与回执路径同样复核：审批撤销后网关才 ack 会被 409 拒绝；设备若在授权失效后
      **仍然执行**，回执**照记**（事实不能被静默改写）并**额外**落 `authorization_violation`
      （未授权执行）结果行 + 审计 + critical 提醒——"执行了"与"被授权执行"是两件事；
    - 迁移 `standalone_093`（授权指纹/复核时间/撤回原因列 + 撤回原因 CHECK + 投递部分索引）
      与 5 类契约兜底探测（半成品撤回、未知原因、有时间无原因等一律被 DB 拒绝）；
    - **同轮抓到的第二个真缺陷**：`ensureApprovedForSend` 对"已 CAS 成 approved 的高危请求"
      直接短路返回、不算审批实例号，而投递复核按高危口径重算 → 指纹必然不符（高危请求的第二条命令
      会被误撤回）。现在下发与复核**共用同一判定基准**（`risk_level=high` 或 `pending_approval`）；
  - **NO-62b 下行投递优先级（排序即安全语义）**：此前 `GET /api/control/commands/pending`
    一律 `sentAt ASC + limit`——一条排队中的 `stop`（安全停机）会被前面几十条 `dispatch_task`
    挤出窗口，现场按下急停却要等搬运命令投完才生效。现在按共享词表优先级排序
    （`stop=0` → `pause` → `return_to_dock` → `clear_fault` → `resume` → `dispatch_task=5`；
    未登记命令键排最后，不靠"未知"插队），边缘侧**再排一次**并核对平台顺序，不一致上报
    `platformOrderViolation`（纵深防御）；`pending` 同时返回 `queued`/`oldestSentAt`/`revoked`/`truncated`，
    "还有多少条待投、最久多久、这一轮拦下几条"现场可见；
  - **NO-62c 方案过期可解释 + 一键重排**：第 61 轮记录的"长期求解数分钟 vs 设备新鲜度 60s"只被
    记成 SKIP，用户侧仍然是"审批被拒 → 弹一句『请重新计算』"。现在：
    - 审批 409 `PLAN_STALE` 的响应体带上**差异事实**（`entityVersions` + `reservations` 的增删改），
      并区分**外部变化**与**本方案自身执行效果**（已派工 assignment / 已建预占）——
      不把"我刚派的第一波"误报成外部干扰；
    - 新增只读 `GET /api/scheduler/plans/{planId}/staleness`（与审批路径**同一实现**，
      不存在"页面说新鲜、审批说过期"的第二套口径）；
    - 页面：审批被拒或主动点"检查新鲜度"时摊开差异面板（外部变化在前、本方案自身效果标注、
      超出 8 项折叠计数、快照已清理时显式说明"无法比较"），并给出一键**按最新状态重新排程**
      （重排仍走完整调度与审批链，不绕过任何闸门）；
    - 动作契约新增**只读动作**类别（`READ_ACTIONS`），与写动作/导航动作三分互斥——
      "点了会不会改东西"从契约即可判断；
  - 测试：平台控制服务 **+8 例**（指纹落库/换审批实例必变/优先级插队/审批过期撤回/指纹不符撤回/
    ack 复核 409/未授权执行留痕/撤回走独立事务）+ 跨语言契约 **+6 例**、边缘 **+7 例**（指纹回传、
    平台拒绝投递、安全命令插队与顺序违规上报、固定向量自证）、调度诊断 **+4 例**、客户端 **+9 例**
    （解析/排序/面板渲染）；e2e `e2e:control-actuator` **24 项** + 新场景 `e2e:plan-staleness` **7 项**；
  - **同轮抓到的三个真实缺陷（都在本批修掉）**：① `POST /plans/:id/replan` 省略可选字段
    `lockedConstraints` → `[...undefined]` → 重排接口 **500**（新 e2e 场景当场抓到）；
    ② **拒绝路径上的写入被请求事务回滚**——`OrgContextInterceptor` 把请求包在事务里，
    "撤回/事件化 + 抛 4xx"会把刚写的撤回、审计、结果行、outbox 事件一起回滚（实测：授权复核拒绝后
    命令仍在 `sent`，下一轮还会投给设备；`stale_plan` 事件从未真正落库）。新增
    `RequestDatabaseContext.runDetachedTransaction`（独立连接 + 独立事务 + 新 ALS 上下文，
    GUC/RLS 仍生效）承载拒绝路径上必须存活的写入；③ SQL CHECK 的**三值逻辑**：
    `revoked_reason IN (...)` 在 `revoked_reason IS NULL` 时求值为 NULL，`false OR NULL = NULL`
    → "有时间无原因"的半成品撤回被静默放行（093 verify 探针当场抓到；092 行动项归属 CHECK
    同类问题一并烧掉并补第三个探针）。

- **批次交付（NO-61a）：搬运任务 → 执行机构调度（一次做完并验证）**：
  审计发现第 59 轮把执行机构接进了设备台账（类别/能力），第 60 轮打通了授权→执行→回执，
  但**调度并不会真的把搬运任务派给 AGV**：AGV 会出现在候选里，却恒被 `battery_unknown`
  挡在 eligible 之外——它的位置/电量只落在 `world_state.state_json`，
  **设备行 `battery_pct` / `location_lat/lng` 是空的**（调度只看设备行）。本轮：
  - **执行机构状态投影到设备台账（`projectActuatorDeviceState`）**：电量/位置/故障码/在线
    随状态帧刷新；合并语义 fail-closed——帧里没有的电量/位置用 `COALESCE` **保留上一次已知值**
    （不把刚测到的 88% 擦成"未知"），故障码按当前状态写/清，类别不被自动路径改写；
  - **验证"调度真的派给 AGV"**：`e2e:agv-transport`（10 PASS / 0 FAIL / 1 SKIP，真实 PG）——
    状态帧 → 设备台账/快照可见（能力 `transport.move` + 电量 + 坐标）→ 建搬运任务并走**任务状态机**
    进入待派发 → 候选里出现该 AGV 且**至少一条 eligible** → **调度方案把该任务派给该 AGV** →
    （授权/执行腿由 `e2e:control-actuator` 覆盖）→ 同一台 AGV 的命令闭环 executed；
  - **同轮发现的真实约束（如实记录，不掩盖）**：设备遥测新鲜度 **60s**、而本开发库
    单次求解要数分钟（候选空间约 8800 条）→ 方案到达时快照已失效，`approve` 被
    `assertFreshForApprove` 正确拒绝（`PLAN_STALE`）。场景对此记 **SKIP + 原因**（不是 PASS），
    并在文档里给出下一步设计选项（run 完成后显式标 stale + 一键 replan / 冻结窗口审批）；
  - **同轮修掉一个真缺陷（NO-61b，由"库变大"暴露）**：学习信号的提醒记忆只读**最近 2000 条**，
    于是**最老的待处置积压**会被近期噪声挤出取数窗口——"提醒疲劳"信号恰恰要看最老的积压，
    结果就是「陈旧积压因取数上限而消失」（原则 7 禁止的静默缺口；本轮 e2e 因此 11/16）。
    现在分两条读：最近窗口（处置率口径）+ **待处置积压按最老优先**，合并去重后计算，
    `truncated` 如实反映任一来源触顶；回归测试在旧行为下**必红**（已实测）；
  - 测试：平台 ingest **+2 例**（投影合并语义、故障态故障码）+ 学习信号 **+1 例**（旧积压可见性，反向验证过）+ E2E 10 项；
    执行机构必须**持续上行**（否则 60s 后判离线、调度不再派工）这一现场约束写进文档与场景注释。
- **批次交付（NO-60a）：平台授权 → 边缘执行 → 回执 闭环（一次做完并验证）**：
  审计发现两轮成果之间**没有通道**——平台控制命令域早就有审批/台账/回执接口，边缘（NO-59b）也有了
  执行机构适配器，但平台 `sendCommand` 只往库里写一行 `sent`：**命令永远到不了设备，也不会有回执**。
  本轮打通，并顺手修掉执行边界的一处分裂：
  - **平台：命令参数（payload）**：`sendCommand(..., payload)` 落库并读回；校验 fail-closed
    （非对象/超 4KB 拒绝；`dispatch_task` **必须**给 `targetStationId`——不说"去哪"的命令不许发出去，
    这条由单测抓出：原实现"payload 为空直接放行"）；
  - **平台：网关命令面（机器身份，IngestGuard 密钥+租户绑定）**：
    `GET /api/control/commands/pending`（只返回本租户 + 目标设备 + `sent` 且请求非终态的命令，
    每条带**平台签发授权号** `control:<requestId>` 与 payload）、
    `POST /api/control/commands/:commandId/ack`（投递确认 `pending_gateway → gateway_received`；
    未投递必须给原因 → `failed`；重复 ack 幂等 `alreadyAcked`；终态 409）、
    `POST /api/control/commands/:commandId/receipt`（机器身份回执执行结果，按 commandId 复用
    同一套校验与落库——原人面回执要 Bearer 用户令牌，边缘网关没有也不该持有）；
  - **执行边界统一（原则 3/4）**：平台高危词表 `HIGH_RISK_COMMAND_KEYS` **并入共享契约**
    `ACTUATOR_HIGH_RISK_COMMANDS`（`dispatch_task`/`resume`/`clear_fault`）。此前平台不知道
    `dispatch_task` 是高危 → 一条会让设备在共享空间动起来的命令可以**绕过审批直达设备**；
  - **边缘：命令代理**：`edge/bridge/control_downlink.py`（轮询 → 授权号核对
    `control:<requestId>` 不一致即拒绝且不碰设备 → 调 `ActuatorAdapter.send_command` →
    ack 投递确认 → 回执 `executed|failed`）+ `tools/edge_control_agent.py`（现场 CLI：`--once`/常驻）；
  - 测试：平台控制服务 **+14 例**（payload 校验/待投递/ack 幂等/按 commandId 回执/跨租户不可见）、
    边缘 **7 例**（本地桩平台：正常路径、授权号不匹配、缺授权号、设备故障→投递确认成功但执行失败、
    平台不可达不撒谎、无本地适配器不动状态、CLI 子进程跑通）；
    E2E `e2e:control-actuator` **18 项**（真实 PG：高危创建→未审批下发 403→自批 403→独立审批→
    缺 payload 400→下发含 payload→边缘轮询拿授权号→边缘代理执行→台账 executed→结果表区分
    `gateway_ack`/`command_receipt`→审计→终态 409→孤立命令不投递→无密钥 401/重复 ack 幂等）；
  - **场景自建前置条件（同轮修复）**：`e2e:capability-explain` 依赖"当前有生效中的高风险执行能力"，
    而上一轮被中断的运行会把 `exo-lift` 留在**已停用**状态 → 脚本继续往下断言、报出一串与
    "停用解释链路"无关的 FAIL（并让 `e2e:exo-session` 找不到可用的外骨骼设备）。现在：
    先按**规范审批路径**恢复一台设备的能力（另一身份审批），恢复不了才 SKIP 并写明原因——
    环境状态不再被伪装成产品缺陷；
  - **验证链入库**：`scripts/e2e-chain.sh` + `make e2e-chain`——16 个场景的主产品闭环链
    （含本轮新增 `e2e:control-actuator`）此前只存在于本地 /tmp，本轮变成仓库资产：
    `pipefail` 防吃退出码、逐场景完整日志 + FAIL/SKIP 明细、三态退出码（0/1/2）；
  - **本轮 e2e 自证抓到的两个真缺陷**：① 人面回执路径机器身份不可达 → 命令停在 `gateway_received`、
    执行结果丢失（新增网关回执面）；② 详情读面形状是 `{request, status}` 而我按平铺读
    （断言读到 undefined）——顺带把"读面形状"写进断言。
- **批次交付（NO-59b）：执行机构（AGV/PLC）适配层 + 命令面授权 + 状态上行（一次做完并验证）**：
  审计发现执行层在边缘侧**完全没有通道**——平台侧有控制命令域（`/api/control/requests`：
  高危命令必须审批、`/:id/commands` 下发、`/:id/receipts` 回收执），设备台账里却既没有
  "执行机构"这个类别、也没有任何边缘适配器能把命令送到 AGV/PLC 上，更没有状态上行。
  本轮补齐（决策原则 11：无真机也要有硬件抽象 + 数字孪生 + 可替换模拟）：
  - **边缘协议面**：`edge/adapters/actuator/protocol.py` 定义 `ActuatorTransport`（真实实现接口：
    Modbus/OPC-UA/厂商 API/网关字节流）+ `LoopbackActuatorTransport`（**确定性回环模拟器**：
    派工→移动→到达、暂停/恢复、返航、故障注入、低电量自停；无随机、无真实时钟依赖）；
  - **授权 fail-closed（两条独立闸门）**：边缘 RBAC（`manage_devices`）之外，高危命令
    （`dispatch_task`/`resume`/`clear_fault`）**必须带平台授权号**（`control:`/`approval:`/`plan:`/`task:`），
    缺失 → 403 `authorization_required`、形状非法 → 400 `authorization_ref_invalid`
    （"没给"与"给错"必须可区分）；**`stop` 是安全动作，永不要求授权号，故障态也允许**——
    安全停机不能被审批链卡住（唯一"绕过授权"的路径，且只朝向更安全的方向）；
  - **命令留痕**：接受与被拒都写审计（`actuator.command`，含命令/授权号/结果/原因），
    命令面绝不"悄悄没发出去"；适配器另存最近命令日志供页面核对；
  - **状态上行**：`POST /api/ingest/actuator` → 世界状态实体行（`state_json.actuator`，含位置/
    电量/故障/当前任务/**最后授权号**）+ 设备登记（类别 `agv`）+ 能力声明；fail-closed：
    状态词表外 → 400 并回显词表（不默认 idle 假装在线）、缺租户/时间戳超前 → 拒绝、同 `record_id` 幂等；
  - **平台词表与能力**：设备类别新增 `agv`；能力新增 `transport.move`（执行，high：
    会让设备在共享空间动起来）与 `observe.actuator_state`（观测）；`shared/actuator.ts` 与边缘
    Python 常量**逐项对账**（读源码比对，改一侧不改另一侧立刻失败）；OpenAPI 新增 1 条路由 + 1 个 schema；
  - 测试：边缘 **17 例**（适配器/模拟器/授权矩阵）+ 边缘 API **11 例**（HTTP + 审计 + 状态码区分）
    + 帧契约 **5 例** + 能力字段对账扩展；平台 **6 例**（世界状态落库/能力声明/词表拒绝/租户/时钟漂移/幂等）
    + 契约对账 **7 例**；
  - **端到端（真实 PG）**：`e2e:edge` 新增 2k~2k5（模拟 AGV → 归一化 → 上行桥 →
    `POST /api/ingest/actuator` → 世界状态实体行 + 设备类别 `agv` + 三项能力），
    场景 **59/59 PASS**；新增适配器必须**追加在故障注入适配器列表末尾**（共享 RNG 的抽取顺序
    决定既有时序断言，插到前面会让 `2d 迟到帧` 下线——本轮实测踩到并修正）；
- **批次交付（NO-59a + 工程债）：外骨骼关节角接入动作融合 + 删除冲突孪生实现（一次做完并验证）**：
  - **NO-59a 关节角 → 动作（§5 源策略扩展）**：审计发现 `ewoh_telemetry.joint_angles`
    **一直被摄入、被 SELECT，却从未参与融合**——动作维度只有视觉一个源（模型给的英文动作词）。
    本轮：①共享契约 `deriveExoAction`（双膝 ≥60°→squatting、双膝不对称 ≥25° 且大侧 ≥45°→kneeling、
    俯仰 ≥45°→bending、俯仰 <15° 且双膝 <30°→standing；**中间态/缺角返回 null + 明确原因**，
    行走明确说明"关节角不足以判定，需步态周期"）；②融合服务产出外骨骼动作观测（判定不了就如实写 note）；
    ③新增**动作交叉验证**：外骨骼（关节角，实测）与视觉（模型动作词）直立性相反 → 记 `action` 冲突，
    两源取值都保留；未知动作词不参与（不猜）；
  - **置信度按"源"计权（同轮实测缺陷）**：聚合时按**观测**累加 → 同一源报 3 个维度就拿 3 倍权重，
    置信度被结构性抬高并被 `min(1, …)` 掩盖成"高置信"（与契约"可用源权重和 / 应有源权重和"不符）。
    改为每源只计一次（源内多维度取最好证据的系数），basis 如实写出维度数；
  - **`null → 0` 强制转换缺陷（本轮测试抓到）**：`Number(pitchDeg)` 把"俯仰未知"变成"俯仰 0°"，
    使缺俯仰的输入被判成 `standing`（原则 7 禁止的"缺失被伪造成确定事实"）→ 显式处理 null/undefined/空串；
  - **删除冲突孪生实现（原则 9）**：`SchedulerQueryService.buildConflicts` 是与 `ConflictService`
    并行的第二份"世界状态 → 冲突"推导（约 470 行），已漂移（缺 `reservation_expiring`/
    `perception_inconsistent`，生命周期与 SSE 各写一套），且让 **GET /conflicts 产生 SSE 写副作用**。
    本轮删除：冲突读面统一委托 `ConflictService`；未装配即**显式失败**（不回退第二份推导）；
    19 个既有冲突场景测试改为直接打真实 `ConflictService`（覆盖反而变强），facade 表征测试改为钉住
    新契约（未装配显式失败 + 读面无副作用）；
  - 测试：感知契约 **+9 例**（关节角映射/别名/中间态/交叉验证/按源计权）、感知服务 **+5 例**、SSE 契约
    **重写 3 例**、冲突场景 **19 例改打真实实现**；e2e：`e2e:perception-fusion` **+2 项**
    （7g 动作冲突、7h 中间态不猜）→ **20 项**全过；
- **批次交付（NO-58a/b/c）：行动项复发度量 + 感知门控接入上游 + 视觉骨架姿态交叉验证（一次做完并验证）**：
  - **NO-58a 对象归属与复发度量（§9 学习回路）**：审计发现改进行动项只有 `source_ref`（复盘号），
    **没有对象归属** → "这类改进是否降低了复发"根本算不出来（没有对象就没有可比的前后窗口）。
    本轮：①从复盘 `scope=incident` 的 `target_id` **确定性派生** `subject_type/subject_id`
    （`person:` → 人员、`station:`/`workstation:` → 工位、其余按设备；plan/shift 复盘**显式 null**——
    不可度量，不硬算成某台设备）；②迁移 `standalone_092`（成对 CHECK + 封闭词表，
    两列必须同时有或同时无，半成品不许落库）；③`GET /api/learning/actions/:actionId/effect`
    完成前后各一窗口统计该对象偏差：**样本合计 < 3 不给趋势结论**、未完成只给完成前计数、
    无归属直接 `no_subject`；④页面显式区分"未绑定（复发不可度量）"与"没有复发"，
    计数下降附**"只是事实，不等于这条改进有效"**（订单结构/季节变化同样影响）；
  - **NO-58b 感知门控接入上游（§5 → §18/§6）**：融合结论"不许强建议"此前只躺在感知卡片里。
    本轮把门控真正接到两个上游：①**推理**——相关事实注入 `perceptionGate`，结论标 `advisoryOnly`
    并带原因（`reasoning-trace` 增加门控一致性校验：门控说不许强建议则结论必须标 advisory，
    标了 advisory 必须给原因；**门控字段只在有门控时出现**——"未评估"用缺省表达而不是 `false`，
    这样调用方能区分"平台没评估过"与"评估过且允许"，也保持与边缘运行时及跨语言金标场景的
    结论形状逐字段一致，本轮正是金标场景先红才发现）；感知页把"仅提示（原因）"渲染成徽标
    （原则 5/6：建议必须带约束与原因）；②**调度冲突面**——新增冲突类型 `perception_inconsistent`
    （提示层：只叫人核对感知来源，**不阻断任何调度**；与在飞任务无关的主体**不进冲突面**，
    否则闲置信设备的感知噪声会淹没真冲突；读取失败只记日志并跳过，其余冲突照旧）；
    冲突号按"主体 + 不一致类型"稳定（不把 fusedAt 放进种子，避免每次融合生成新冲突行）；
  - **NO-58c 视觉骨架 → 躯干角（§5 多模态源策略扩展）**：视觉此前只贡献"有人/工位/动作词"，
    姿态维度只有外骨骼**一个**角度源（"交叉验证"是空话）。本轮：①共享契约
    `deriveVisionTrunkPitch`（双肩/双髋中点连线 → 躯干相对竖直方向夹角；支持命名与 COCO 序号；
    缺要点/置信度 < 0.3/向量退化 → **null + 明确原因**，绝不猜 0°）；②融合服务把
    `detections[].skeleton` 换算成视觉姿态观测（算不出就如实写 note）；③新增数值交叉验证规则：
    两个独立角度源差值 ≥ 30° 记**姿态角度冲突**（各源取值都保留），原有的"角度 vs 动作词"
    规则保留（互补）；
  - 测试：行动项契约 **+7 例**、服务 **+5 例**、客户端 **+8 例**、浏览器 **+4 例**；
    感知契约 **+11 例**、感知服务 **+5 例**、调度冲突面 **+10 例**；e2e：
    `e2e:improvement-action` **+4 项**（对象归属落库 / 复发下降 / no_subject / 空归属成对落库）、
    `e2e:perception-fusion` **+4 项**（7d 骨架角度冲突 / 7e 缺要点如实说明 / 7f 冲突面可见）；
  - 契约：`SchedulingConflictType` 新增 `perception_inconsistent`（词表 + 中文文案 + 面板图标 +
    完整性测试同步）；OpenAPI 新增 1 条路由（行动项复发度量）；
  - **工程债清零（同轮）**：`db/migration-verify-baseline.txt` **12 项历史失败全部修好、基线文件清空**
    （全新库全链 verify **90/90 PASS，已知基线失败 0**）。全部是"验证资产自身"的缺陷：缺自证标记
    （058/059/060/067/068）／标记写错迁移号（065→057）／verify 从未登记进 `SIMPLE_VERIFY_COMMANDS`
    （063，runner 报 `path argument must be of type string`）／`FROM (VALUES 'a','b')` 语法错误
    （057）／psql 专属 `\gset`（064/069）／探针未满足后续收紧的 CHECK 且异常被静默吞掉（053）／
    可见性探针在 owner（superuser）身份下被 RLS 绕过（056 → 改 `SET LOCAL ROLE ewoh_api`）；
- **批次交付（NO-57a/b/c）：订单链消费面 + 预计vs实际对账 + 经验回流知识（一次做完并验证）**：
  - **NO-57a 订单链（§6 世界模型消费面）**：审计发现"订单/物料进世界模型"的**投影已有**，
    真正缺的是消费面——而且投影里 `taskIds`/`remainingOperations` **被写死为空/null**，
    而 MES 建单时 `schedule_task_id = 订单号`、工序行就在 `ewoh_schedule_task_step` 里：
    **链路一直存在，只是投影从没读它**。本轮：
    ①修投影（真读任务号 + 未完成工序数，失败时保持显式缺口并留痕）；
    ②新增共享契约 `shared/order-chain.ts`（链路视图 + 封闭缺口词表 + 逾期优先排序 + 摘要）与
    `GET /api/world/order-chains`（断链逐单显式：无任务/无工序/无物料/无期限）；
    ③把"未完工订单"词表收敛为**唯一口径**（`OPEN_ORDER_STATUSES` 共享常量——本轮实测两处各写一份，
    链路服务里的 `'open'` 在物料侧根本不存在，会出现"链路说没完工、物料说不存在"）；
    ④Operations 页面新增「订单链」卡片（逾期/断链/缺料逐条可见）；
    ⑤物料口径**复用 MaterialsService**（自写的 `ewoh_erp_outbound` 表根本不存在 → 接口 500，
    这是本轮自证的第二个真缺陷：ERP 出站是**事件**不是表）；
  - **NO-57b 预计 vs 实际对账（§7 反馈腿）**：共享契约 `shared/planned-vs-actual.ts` +
    `GET /api/scheduler/planned-vs-actual` + 班次工作台卡片。三条诚实边界：
    ①不可比**分类别**（缺计划/计划为 0/缺实际/未完工），缺失不当 0 参与统计；
    ②**样本不足（可比 < 5）不给比率**（全部 null + notes 说明门槛）；
    ③只报事实与分布（覆盖率、绝对偏差中位/均值/P90、超时-提前-准时计数、偏差类型分布、
    系统性倾向提示"先看偏差类型再谈排产口径"），不替现场下"排产不准"的结论；
    没有任何执行行时**不给"证据不足"结论**（那是"还没有数据可谈"，与"数据缺失"分开）；
  - **NO-57c 经验回流（§9 学习回路）**：行动项完成时把结果**回流成知识条目**
    （`KnowledgeEntryCreated`，`scope=factory`，带验收判据/结果说明/负责人/时间），并把条目号写回
    行动项的 `outcomeRef`/`outcomeKind`（迁移 `standalone_091`，CHECK 兜底：两者同时有或同时无、
    只有 completed 可带）。**回流失败不阻断"已完成"**，但如实记 note 且 `outcomeRef` 为空——
    页面能区分"已完成且已回流"与"已完成但未回流"；
    **只回流规范身份证据**（知识契约要求 `event:`/`task:`/…；复盘号与行动项号都不是规范身份，
    直接塞会被 `bad_evidence_ref` 拒——本轮实测）；一条规范证据都没有时不造知识条目；
  - 测试：订单链契约 **8 例** + 服务 **5 例** + 快照投影回归 **3 例**、对账契约 **8 例** + 服务 **4 例**、
    行动项知识回流 **3 例**（成功/失败降级/未装配），客户端 **+9 例**；
    e2e：`e2e:materials` **27/27**（新增 NO-57a/57a2/57b：订单链缺口封闭词表 + 对账 null 口径）、
    `e2e:improvement-action` **23/23**（新增 17c：完成后行动项带 outcomeRef 且知识条目可检索）；
  - 契约：OpenAPI 新增 2 条路由 + 3 个 schema（`OrderChain`/`OrderChainResult`/`PlannedVsActualSummary`）
    并补 `outcomeRef/outcomeKind`；路由清单 **456 controller / 676 spec**，0 未文档化 / 0 未实现；
  - **过程纠正**：§3 清单改为"先审计后立项、成批交付"——本轮先审计销掉三项"其实已有"
    （执行机构动作闭环、订单/物料投影、预测侧 shadow），再把这批真缺口一次做完。
  - **同轮全量验证（NO-57a/b/c）**：server jest **339 suites / 3048 tests**、client **160 suites / 1597 tests**、
    pytest 1079、门禁十一条、全新库迁移链 apply PASS + verify **77/89**（12 基线 0 回归）、
    truth-check 24/24 + 584/584、reconcile 6/6、OpenAPI **456 controller / 676 spec**（0 未文档化）、
    e2e 链 **15 场景 359 PASS / 0 FAIL / 1 SKIP**、browser mock 94、UX-009 385+119 skipped、real 3。

- **批量收口：环境多源融合 + 两个"写了没做"的债务（NO-56b）**——一次交付三件事，不再一轮一件：
  - **环境多源（区域级同类多源交叉验证，§5 融合层扩展）**：新增 `env_sensor` 源与 `ambient` 维度，
    读 `ewoh_environment`（温度/振动/噪声/空气质量四通道）→ 新增**区域主体**（`station:<工位>` /
    `area:<实体>`）；同一通道多台传感器：一致 → `consistent` + 代表值（均值）+ 极差可见；
    **不一致 → `conflict` + 代表值置空（不取平均掩盖分歧）**；只有一台 → `single_source`
    （明确"没有第二个独立源确认"，不吹成一致）；超过关注阈值（温度 35°C/振动 8/噪声 85/空气质量 150）
    **只报事实**并写明"是否停工由现场按规程决定"；同一类错误顺手修掉：源"应有集合"改为**按主体类型**
    （人员看 UWB/外骨骼/视觉/工位/任务；区域看环境/视觉/工位）——否则人员级融合会因"缺环境源"永远降级；
  - **`quality_aging` 桶从"预留未写入"变成真实写入方**：数据质量扫描对超过 24h 仍未了结的告警
    **补发 aging 桶提醒**（同一告警号前缀 + 同一收件人，只有桶不同 → 通知号确定性地分成
    "刚发生"与"还没人处理"两条；人工判定按前缀一次性把两条都落到终态），并新增 `agingNudged` 计数；
  - **行动项逾期主动叫人（接进统一提醒契约）**：新通知族 `NTF-ACT-<行动项号>-action_overdue-<角色|人>-<收件人>-<渠道>`
    + 新通知类型 `improvement_action`；`POST /api/learning/actions/overdue-sweep` 与后台 worker
    （30 分钟一次，`IMPROVEMENT_ACTION_OVERDUE_WORKER_DISABLED=1` 可关）把"到期未完成"叫到
    **负责人账号**（经受控 SECURITY DEFINER 函数 `ewoh_find_active_users_by_person` 反查）
    + 班组长兜底；负责人没绑账号 → 如实进 `unresolvedOwners`（不假装"已经叫到了"）；
    **完成/放弃/拒绝时把提醒落到终态**（`action_completed` / `action_dropped`，与主事实**同一事务**），
    并新增迁移 `standalone_090_improvement_action_orgs`（后台 worker 的租户清单函数——后台没有 GUC，
    直查业务表会被 RLS 全挡，这正是"worker 静默 0 条"的老坑）；
  - 测试：融合契约 **+8 例**（通道聚合四种形态）、融合服务 **+4 例**（区域主体/非法工位/人员不把环境当应有源）、
    数据质量 **+2 例**（aging 触发与不刷屏）、行动项 **+3 例**（逾期提醒/无逾期不打扰/完成即了结）；
    e2e 三场景同步扩容并全部通过：`e2e:perception-fusion` **14/14**（含 7b/7c 环境多源）、
    `e2e:data-quality` **15/15**（含 12b aging）、`e2e:improvement-action` **22/22**
    （含 16b/16c 逾期提醒幂等、17b 完成后 `action_completed` 终态）；
  - 契约：`openapi/ewoh.yaml` 新增逾期扫描路由（含"只读行动项 + 同事务了结"说明），
    路由清单 **454 controller / 672 spec**，0 未文档化 / 0 未实现；`quality_aging` 与
    `improvement_action` 两个词表不再是"死词表"。
- **过程纠正（对"列了清单却每轮只做一项"的回应）**：`capability-alignment.md` 的 Top-5
  改为**按证据重新推导**（先审计代码，再决定做什么）：本轮审计发现原清单里
  "执行机构动作闭环"**早已实现**（`/api/control/requests` 全链 + 高危命令走审批链）、
  "订单/物料进世界模型"的投影**已存在**（DR-6 快照行）、"预测→实际"已有
  `prediction_shadow_observation`（含 actual 回填）——三项从清单销账；
  剩余真缺口（订单-任务-物料**消费面**、任务维度**预计vs实际**偏差记忆、行动项证据回流）
  合并为**下一批一次做完**（这三个是唯一未完成项，不再一轮一项）。
  **同轮验证（NO-56a+NO-56b 全量）**：server jest **334 suites / 3017 tests**、client **160/1588**、
  pytest 1079、门禁十一条、全新库迁移链 apply PASS + verify **76/88**（12 基线 0 回归）、
  truth-check 24/24、reconcile 6/6、OpenAPI **454 controller / 672 spec**（0 未文档化）、
  e2e 链 **15 场景 356 PASS / 0 FAIL / 1 SKIP**、browser mock 94、UX-009 385+119 skipped、real 3。

- **多模态感知融合：把 §5 的融合公式与五条可解释规则落到契约、纯函数与快照（NO-56a，原则 5/7）**：
  - 缺口（上一轮 §3 Top-5 #1，也是九层里最大的一块）：`embodied_factory.md` §5 早就写了
    `人员状态 = f(UWB位置, 外骨骼IMU姿态, 视觉骨架, 工位语义, 任务上下文)` 与五条可解释规则，
    但仓库里只有**分散的单源判定**：没有一致性/冲突结论，没有可解释的置信度，
    更没有"当时系统看到的是什么、可信吗"的快照——上游也就无法据"低置信度不生成强建议"做门控；
  - **共享契约 `shared/perception-fusion.ts`（纯函数）**：源策略登记表（权重/TTL/支持维度）、
    观测（源/硬件 id/维度/时间/质量/置信度/归属方式）、融合结果（一致性/位置/姿态/工位/
    置信度/冲突/规则留痕/`strongAdviceAllowed`）+ `validateFusedPerception` fail-closed；
    五条规则逐条落成 `ruleTrace`：①UWB×视觉同工位才算**交叉验证一致**；②不一致即**记录冲突**
    （各源取值都保留，不静默丢弃）；③视觉缺失→继续推断并降级；④任一源缺失→置信度按缺失权重下降
    但不中断输出；⑤低置信度/有冲突 → `strongAdviceAllowed=false`（上游不得据此生成强建议）；
  - **三条诚实边界**：置信度是**可解释加权**（可用源权重和/应有源权重和，含质量×新鲜度×源置信度系数）
    并明确写进 `confidence.basis`"不是概率"；**过期/不可信/维度不符的证据逐条进 `excludedSources`**
    （带原因），缺失源进 `missingSources`，不用默认值顶替；无可用源时 `level=unknown`+`score=null`
    （**不显示成 0%**）；坐标解析不到工位就 `stationId=null`（附距离/半径依据），
    视觉 track 未绑定主体就如实计数（**不按"最像的人"分配**）；
  - **服务 `PerceptionFusionService`**（`POST /api/perception/fusion/sweep` + `GET /api/perception/fusion`）：
    读真实落库的多源观测（`ewoh_world_state` 定位行/相机 person 检测行、`ewoh_telemetry` 外骨骼行）、
    工位/相机实体、在飞任务（`ewoh_production_task` 非终态 → 任务上下文；多个不同工位即有歧义→置空）
    → 融合 → 幂等 upsert `ewoh_perception_fusion`（迁移 `standalone_089`，TENANT_SCOPED + RLS +
    契约 CHECK 兜底）；**只读感知事实**，只写快照与 `perception.fusion_sweep` 审计；
  - **班次工作台新增「感知融合」卡片**：人在哪个工位、姿态、可信度（含加权依据）、
    可用/缺失源、被排除证据、冲突逐条、以及**"不得据此生成强建议"**的显式声明；
    读取失败显式报错，不显示成"现场没人"；
  - 测试：契约 **20 例**（五条规则/三条边界/确定性/校验器）、服务 **10 例**（含只读性与幂等）、
    客户端展示 **5 例**、浏览器 **+5 例**、真实 PG 场景 `npm run e2e:perception-fusion`
    （**12 项全通过**：三源**真实摄入** → 一致/冲突/降级/证据不足/不猜/幂等/只读/读取面）；
  - 契约：`openapi/ewoh.yaml` 新增 2 条路由 + 2 个 schema，路由清单 **453 controller / 672 spec**，
    0 未文档化 / 0 未实现；
  - **递归修复（本轮 e2e 自证发现的两个真实数据通路缺陷，都在摄入映射层）**：
    ① **`pose.pitch_deg` 被静默丢弃**：mapper 只认 `pose.trunk_pitch_deg`（边缘桥接器/真机适配器的
    规范名），而边缘模拟器与桩、部分直连设备用 `pose.pitch_deg` → 俯仰角落 NULL，
    "看不到姿态"会一路传到疲劳规则与感知融合（本体现在**两种方言都认，规范字段优先**，
    DTO 也补齐并注明两种来源）；
    ② **帧内 `entity_id` 被身份映射覆盖**：单帧与批量两条路径都无条件把 `entityId` 覆盖成
    ADR-006 身份映射结果（未登记映射即 NULL）→ **"这条遥测说的是谁"永久丢失**，
    多模态融合只能报"缺外骨骼源"；现在帧内 `entity_id` 是第一事实源、身份映射仅在缺主体时兜底；
    顺带把单帧路径**改为复用批量路径同一个 mapper**（此前两套实现各写一份字段映射，
    正是上面两处静默分叉的温床），并抽出 `resolveCanonicalEntityId` 复用身份解析的 fail-closed 语义；
    新增 **3 例** 摄入映射回归测试钉住这两条（方言优先级 / entity_id 保留 / 规范字段优先）。

- **经验 → 行动：复盘经验条目与缺口变成有人负责、有期限、有完成证据的改进行动项（NO-55a，原则 4/5/6/7）**：
  - 缺口（上一轮 §3 原 #1 的剩余部分）：复盘已经能产出**结构化经验条目**（`RetrospectiveLesson`）
    与**缺口清单**（`gaps`），但条目落进复盘记录之后就**没有人负责、没有期限、没有完成证据**——
    "运行记忆 → 经验"有，"经验 → 行动"是断的；
  - **为什么不塞进阈值提案**（关键架构决策）：阈值提案的语义是"改一个可激活的参数"，激活即生效；
    而绝大多数经验是**做法/培训/工具/维护**类改进，没有可激活的参数，塞进去只能靠编造映射。
    因此新增**改进行动项**与阈值提案**并列**，二者可互相引用：
    `kind='threshold_review'` 表示"这条经验需要人去提案面板改参数"（目标值仍由人给）；
  - **共享契约 `shared/improvement-action.ts`**：类型（做法/培训/工具/维护/阈值复核）、
    状态机（`proposed → accepted → completed`／`rejected`／`dropped`，终态不可再动）、
    确定性行动项号 `ACT-<lesson|gap>-<来源复盘>-<标题 slug>`、以及三条硬边界：
    ①**接受必须有人 + 期限 + 验收判据**（"做完了"要能被别人判断，平台不替现场承诺期限）；
    ②**完成必须有完成人/时间/结果说明**；③**拒绝/放弃必须给理由**（§33 不静默作废）；
  - **服务 `ImprovementActionService`**：`POST /api/learning/actions/scan` 扫**已发布复盘**
    （warning/critical 经验 + 缺口；info 级只作记忆保留，不把每条总结都变成待办）→
    幂等 upsert（重复扫描只刷新来源事实，**责任/期限/完成/拒绝痕迹永不覆盖**）；
    `accept`/`complete`/`decision` 三个由人驱动的动作，错误顺序统一为
    **404 → 409（状态不允许）→ 400（必填事实缺失）**；新增 `GET /api/learning/actions/overdue`
    给接班班组长看逾期待办；支持**聚焦扫描** `{retrospectiveIds}`（只扫指定复盘）；
  - **迁移 `standalone_088_improvement_action`**：`ewoh_improvement_action`（TENANT_SCOPED +
    RLS `improvement_action_org_isolation` + UNIQUE(org_id, action_id)），契约用 CHECK 兜底：
    接受/完成/拒绝的门槛、`proposed` 不得带完成时间、证据数组非空；
  - **学习控制台新增「改进行动项」卡片**：来源复盘 + 证据 + 优先级 + 建议类型（标注"建议"待人确认）、
    逾期徽标、接受（负责人/期限/判据/类型）、完成（结果说明）、拒绝/放弃（理由）；
    读取失败显式报错，**不显示成"没有待办"**；
  - 测试：契约 **14 例**、服务 **15 例**、客户端展示 **10 例**、浏览器 **+6 例**、
    新增真实 PG 场景 `npm run e2e:improvement-action`（**19 项全通过**：
    权限边界 → 只扫已发布（草稿不扫）→ info 不立项 → 来源/证据/建议类型 →
    扫描只读复盘且幂等 → 接受门槛与重复接受 409 → 完成门槛与终态不可转移 →
    拒绝必须给理由 → 逾期待办口径 → 重复扫描保留人的决定 → 落库事实与响应一致）；
  - 契约：`openapi/ewoh.yaml` 新增 6 条路由 + 2 个 schema（含聚焦扫描参数），
    路由清单 **451 controller / 668 spec**，0 未文档化 / 0 未实现；
  - **递归修复（本轮自证发现的三个问题）**：
    ①**slug 撞号吞掉经验**：行动项号里的标题 slug 只保留 ASCII 前缀时，
    `"E2E abc 甲条目"` 与 `"E2E abc 乙条目"` 会塌成同一个号，两条不同经验被 dedup
    **静默合并成一条待办**（实测：critical 留下、warning 消失）；改为把整串标题的稳定摘要
    拼进 slug 并补回归用例；
    ②**UI 草案字段名与校验器不一致**：卡片草案用 `criteria`，而校验器读 `acceptanceCriteria`
    → 判据永远被判定为空、接受按钮永远不可用（由新浏览器用例先失败发现）；
    ③**场景与共享开发库的十条上限冲突**：扫描有条数上限，开发库里其它已发布复盘会把本场景的
    候选挤出榜单（表现为"只派生 1 条"）；为此新增**聚焦扫描**参数（只扫指定复盘），
    既修场景也补上了页面"从这篇复盘生成行动项"的能力；
    ④**实测 flaky 用例**：`replan-multi-instance.spec.ts` 的降级路径用例把
    `minimumReplanIntervalMs` 设成 **5ms** 来表达"同一时间窗"，于是"第 3 次被抑制"依赖
    三次调用落在 5ms 内——单文件跑必过、全量 jest（并行 + 机器有负载）时超时即随机失败
    （本轮全量验证正好命中）。抑制语义本由"窗口内次数已满 + 仍在最小间隔内"共同决定，
    已把间隔改为远大于测试时长（60s）：语义不变、与机器速度无关，并连跑 3 次 + 整个
    scheduler 套件（111 suites / 989 tests）确认稳定。

- **学习回路接线：运行记忆 → 信号 → 人点"生成提案"（NO-54a，原则 4/5/6/7）**：
  - 缺口（上一轮 §3 结构缺口 #1）：学习提案此前只有"人手工填规则 + 目标值"一条入口，
    **运行记忆没有接线**——提醒治理指标（处置率/账龄/反复来源）、数据质量待核实积压、
    执行偏差复发这些**已经落库的事实**，从来不会变成"该不该调策略"的候选；
  - **共享契约 `shared/learning-signal.ts`**：三类信号（`notification_fatigue` /
    `data_quality_backlog` / `deviation_repeat`）、确定性信号号
    `SIG-<KIND>-<subject>-<window>d-<severity>`、以及三条硬边界：
    ①**样本不足不下结论**（`sampleSize < 5` → `confidence=null`，且 `actionable` 必为 null）；
    ②**不作数值决策**（只给方向 raise/lower + 依据 + 风险，**目标值必须由人给**）；
    ③**不可执行必须写理由**（`notActionableReason` 必填，页面要能读出"为什么只能提示"）；
  - **服务 `LearningSignalService`**：`POST /api/learning/signals/scan` 扫实测记忆
    （提醒治理走**与治理页同一个共享纯函数** `summarizeNotificationDisposition`，
    数据质量数 open 告警与待核实提醒，偏差按对象+类型聚合）→ 派生信号 →
    幂等 upsert（重复扫描只刷新实测快照，**人的 promoted/dismissed 决定永不覆盖**；
    条件恶化即严重度升级 → 新信号号，"变严重了"是新事实）；
    `POST …/:signalId/promote` 由**人**给目标阈值 → 创建学习提案（进既有影子评估 →
    人审激活阶梯）；`POST …/:signalId/dismiss` 理由必填（§33 不静默忽略）；
  - **迁移 `standalone_087_learning_signal`**：`ewoh_learning_signal`（TENANT_SCOPED +
    RLS `learning_signal_org_isolation` + UNIQUE(org_id, signal_id)），契约用 CHECK 兜底：
    可信度必须有样本（`confidence IS NULL OR sample_size >= 5`）、不可执行必须有理由、
    可执行三件套要么全空要么全有、promoted 必须带提案号与决定人、dismissed 必须带非空理由；
  - **学习控制台新增「运行记忆信号」卡片**：证据引用+时间范围、实测快照、
    可信度（样本不足时明确写"不给结论"）、假设/预期影响/风险、方向与当前基线；
    可执行的填目标值即可生成提案，不可执行的写明理由；忽略必须填理由；
    读取失败显式报错，**不显示成"没有信号"**；
  - 测试：契约 **16 例**（样本不足/不可执行必须有理由/证据与指标必填/确定性 id +
    严重度升级换号）、服务 **16 例**（含幂等刷新、不覆盖人的决定、基线漂移 409、
    已决定不可重复决定、404/400/409 边界）、客户端 **19 例**、浏览器 **+6 例**、
    新增真实 PG 场景 `npm run e2e:learning-signal`（**19 项全通过**：
    权限边界 → 真实摄入产生质量积压 → 扫描派生三类信号（证据/样本/可信度/方向）→
    扫描不创建提案 → 幂等 → 忽略必须给理由且不被覆盖 → 不可执行拒绝提案 →
    **基线漂移 409** → 重新扫描 → 人生成提案（基线=扫描时值、目标=人给值、
    停在人审阶梯之前）→ 不可重复提案）；
  - 契约：`openapi/ewoh.yaml` 新增 4 条路由 + `LearningSignal`/`LearningSignalScanResult`
    两个 schema，路由清单 **445 controller / 660 spec**，0 未文档化 / 0 未实现；
  - **递归修复（本轮自证发现的三个问题）**：
    ①**假"处置率"**：初版用 `resolved / comparable` 计算某类提醒的处置率，
    而 `comparable` 只统计"已了结且两端时间戳可用"的行 → 该比值恒接近 1，
    会把"大部分提醒没人处置"读成"处置率很高"（方向直接判反）；改为
    `resolved / total` 并注明口径；
    ②**契约与规则自相矛盾**：偏差复发信号在复发 3–4 次时给了 `confidence='low'`，
    但契约要求 `sampleSize >= 5` 才能有可信度 → 信号被自己的校验拦下（`derived=1` 但
    `signals=[]`，页面表现为"扫描了什么都没有"）；改为不足 5 次即 `confidence=null`
    并把"复发次数不足"写进 `missing`；
    ③**测试替身两处失真**：`drizzle-fake-matcher` 对 `Date` 参数的大小比较按本地化文本比较
    （`timestamptz` 条件恒 false，行被整批过滤），且缺列映射不报错只静默失效；
    已让替身按时间戳比较并解包 drizzle 的 Param 包装，测试里补全列名映射表并注明
    "漏映射 = 条件恒 false 是最难查的一类测试自伤"；
    ④**页面诚实性**：卡片在读取失败时仍渲染"暂无信号"空态——"没有信号"与"读不到信号"
    是两件事，已加 `!isError` 门（由新浏览器用例先失败后修复）。

- **数据质量"待核实提醒"：把"数据不可信"叫到人，并让判定与提醒终态同事务落账（NO-53a，原则 4/5/6/7）**：
  - 缺口（上一轮 §3 结构缺口 #1）：摄入侧会自动分级并开 `DataQualityAlert`，人工也能
    `confirmed|contested`，但**没有人被主动叫到**——告警只是躺在事件表里，直到有人恰好打开
    工作台。而"数据质量"正是原则 7（缺失/延迟/冲突数据不得静默当事实）的入口层；
  - **共享契约 `shared/data-quality-notification.ts`**：通知号前缀 `NTF-DQ-<告警号>-`、
    桶 `quality_alert`/`quality_aging`、告警码运维标签、**只有需要人核实的码才打扰人**
    （`requiresHumanVerification`：ENTITY_NOT_FOUND / CLOCK_DRIFT / BATTERY_OUT_OF_RANGE /
    QUALITY_DEGRADED / DUPLICATE_RECORD）、严重度→收件角色（critical/high 加安全员）、
    正文生成（缺字段如实写"未知"，不猜）；
  - **扫描服务 `DataQualityNotificationService`**（`POST /api/data-quality/gap-sweep` +
    worker 默认 10 分钟）：扫本租户 **open 的 `DataQualityAlert`** → 责任人（复用 NO-49a/51a
    的班次路由：本班优先/全天兜底/**他班只报缺口**）+ 角色兜底 → 确定性通知号幂等写入；
    **只读业务事实**（不改告警状态、不写 evidence），只写提醒与 `data_quality.notify_sweep` 审计；
    跨租户扫描经受控 SECURITY DEFINER 函数 `ewoh_open_quality_alert_orgs(interval)`
    （迁移 `standalone_086`）再逐租户开 GUC 事务读明细——否则 RLS 挡行，表现为"接口正常、
    worker 静默 0 提醒"；
  - **判定即闭环**：`DataQualityService.confirm` 现在把"判定主事实"与"待核实提醒终态"
    放进**同一个事务**（`resolvedNotificationCount` 随响应返回）；处置码区分
    `data_quality_confirmed`（数据可信）与 `data_quality_contested`（**数据不可信，相关决策需复核**，
    不是"没事"）；`read` 仍不等于 `resolved`；
  - **班次工作台新增「待核实数据提醒」卡片**：谁被叫到、等了多久、投递失败几条、
    已读未处置几条逐条可见；同一告警的多个收件人合并一行；无源事件号显式写"无法回写判定"；
    读取失败显式报错（绝不显示成"已经叫到人"）；确认/质疑直接复用确认接口；
  - 测试：扫描服务 **7 例**（只扫 open、责任人+角色、幂等、严重度角色、缺设备、跨租户 GUC、失败如实上报）、
    判定与终态 **+7 例**（confirmed/contested 处置码、幂等、合法链了结、不误关源事件）、
    客户端展示 **8 例**、浏览器**新套件 6 例**（已接入 `test:browser:mock`）、
    新增真实 PG 场景 `npm run e2e:data-quality`（**14 项全通过**：拒帧落告警 → 扫描点名 →
    幂等 → 只读 → 判定 → 终态 → 权限边界 → 待办清空）；
  - 契约：`NOTIFICATION_KINDS` 新增 `data_quality` 族并登记进 `NOTIFICATION_ID_FAMILIES`
    （通知号族门禁强制：源码里出现的前缀必须在族表登记）；`openapi/ewoh.yaml` 新增扫描路由与
    `resolvedNotificationCount` 字段说明，路由清单 **441 controller / 655 spec**，0 未文档化 / 0 未实现；
  - **递归修复（本轮 e2e 自证发现的两个真缺陷）**：
    ①**死代码级联动**：DR-4 的 "confirmed → 联动 resolve 同源 DataQualityAlert" **从未生效**——
    ADR-031 告警状态机刻意不提供 `open → closed`（SH-004 还把"跳过确认直接关闭"钉成非法），
    旧实现直接调 `transitionAlert(id,'resolve')` 在 open 告警上必然抛
    `Transition resolve not allowed from open`，而调用处只 warn 不报错；DR-4 的 e2e 只**打印**
    `linkedAlertsResolved` 从不断言，于是"数字一直是 0"没人发现。现在改为按**合法链**
    `open→acknowledged→processing→closed` 逐级了结（每一步都由做出判定的人记审计），
    并且**人直接在告警上判定**这条最短路径也纳入（此前只有"在源事件上判定"才会去关告警）；
    状态不在链上立即停手，不猜、不伪造处置事实；
    ②**注释与实现对不上**：`ingest.service` 里"写入告警事件并返回 400"与实现（HTTP 201 +
    `accepted:false`/`data_quality:invalid` 帧级结果）矛盾——调用方按错误注释写重试逻辑会把
    "帧非法"当传输失败无限重试；已改正注释并把 e2e 断言钉在真实契约上。

- **交接班前的责任人核对：把"接班那班谁负责"变成交接动作（NO-52a，原则 1/2/7）**：
  - 缺口：NO-51a 让责任人有了班次维度，但**交接班时没人核对**——交班的人看不到
    "下一班哪些设备没人负责"，接班的人不知道自己接手了什么缺口。班次维度的价值
    只在"提醒触发时"体现，而那时人可能已经下班了；
  - **核对接口** `GET /api/device-responsibilities/coverage?shiftId=…`：按给定班次给出
    覆盖快照（total/covered/gaps/uncovered + 逐台缺口原因 + 口径 notes）；
    口径与提醒路由一致（本班优先、全天兜底、**他班只报缺口**），但**不要求已绑定账号**
    ——这里回答"有没有人负责"，账号缺口由提醒链路口径回答（两处口径在 notes 里写明，
    避免"看板说有人、提醒发不到"）；
    当前班次解析不到 → `shiftUnknown=true`（不猜默认班）；
  - **迁移 `standalone_085_handover_responsibility_snapshot`**：交接记录新增
    `responsibility_snapshot_json`——**存交接时刻的快照**而不是回看时重算：
    审计要回答的是"交接当时知不知道没人负责"，按现状重算会得到不同答案；
  - **班次工作台新增「接班人核对」卡片**：口径行 + "本班覆盖 N 台 · 本班缺口 M 台 ·
    未登记责任人 K 台"、缺口逐台列出（含"只有别的班次责任人"的具体班次）、
    班次未知显式说明、**一键写进交接遗留事项**（仍由人提交，平台不代填）、
    读取失败显式报错（绝不显示成"无人负责"）；
  - 测试：共享覆盖率纯函数 **5 例**（本班/全天/他班、班次未知、未登记单列、口径说明）、
    服务层 **+3 例**（覆盖率与缺口排序、当前班次口径、缺 org 400）、
    客户端展示 **+4 例**、浏览器**新套件 4 例**（已接入 `test:browser:mock`）、
    `e2e:edge` 52 → **54 项**（5k 核对快照 / 5l 交接记录保存快照）；
  - 契约：`openapi/ewoh.yaml` 新增核对路由（含"两处口径不同"的说明），
    路由清单 **440 controller / 654 spec**，0 未文档化 / 0 未实现；
  - **递归修复（本轮自证发现的两个真缺陷）**：
    ①**假"不阻塞"**：交接时计算快照的 try/catch 拦不住"事务已中止"——核对 SQL 一报错，
    外层事务进入 aborted 状态，随后的交接插入照样 500；现在快照计算放进
    **嵌套事务（savepoint）**，失败只回滚这一步（这才是真的不阻塞主流程）；
    ②**类型不匹配**：`ewoh_device.org_id` 是 uuid（身份域），
    `ewoh_device_responsibility.org_id` 是 varchar（业务域），跨表比较报
    `operator does not exist: character varying = uuid`；已显式 `d.org_id::text` 并注释原因。

### Fixed
- **迁移链"全新库全量 verify"从未真正跑通：修掉 4 类验证资产缺陷，并把它固化成命令（NO-53a）**：
  - 缺口：主线 5（`migration-fresh-install-check.sh`）默认只做静态顺序校验，真实空库模式
    需要主机装 `psql`；于是"迁移链在全新库上能不能装、verify 能不能过"长期没有可复现的跑法。
    本轮用仓库自带的 node 迁移 runner 在**全新库**上跑完整链：apply 84/84 成功，
    但 verify 只有 72/84 通过，一次性暴露 12 项失败；
  - 已修（机械类，共 20 个文件）：
    ① `standalone_028` verify 的 `COALESCE(pa.org_id, p.org_id)`——
    `ewoh_assignment_event`/`ewoh_scheduling_plan_assignment` 的 org_id 是 **varchar（业务域）**、
    `ewoh_schedule_plan` 是 **uuid（身份域）**，必须 `p.org_id::text`（与第 52 轮
    `ewoh_device` vs `ewoh_device_responsibility` 同一类坑）；
    ② **17 个 verify 脚本**查 `pg_policies` 视图却用 `pg_get_expr(polqual, polrelid)`——
    那是 `pg_policy` 的列名，视图里叫 `qual`/`with_check`，语句必然报
    `column "polqual" does not exist`；
    ③ `standalone_048` / `standalone_050` verify 往 **uuid** 的 `org_id` 列写
    `'verify-048'` 这类可读串 → `invalid input syntax for type uuid`，改为合法 uuid 字面量；
    ④ `standalone_051` verify 的 `RAISE` 占位符比参数多一个（必然
    `too few parameters specified for RAISE`），按 9 个布尔值修正；
  - **固化**：新增 `make migration-fresh-chain`（`scripts/migration-fresh-chain-check.js`）——
    自动建临时库 → 全链 apply → 全量 verify → 与 `db/migration-verify-baseline.txt`
    （**只许缩小**的已知失败基线）比对，基线外新失败即非零退出；
  - 剩余 12 项已如实登记进基线（psql 专属语法 3 项、早期探针与后续收紧约束冲突、
    断言/类型漂移等），每条写明具体原因——本轮的纪律是**登记并可见**，而不是把它从门禁里摘掉；
  - **实测**：`make migration-fresh-chain` → apply 84/84 PASS；verify 72/84 PASS、
    12 项 BASELINE、0 项 REGRESSION；`standalone_085`/`standalone_086` verify 均 PASS。
- **验证脚手架不得吞掉退出码（NO-53a 自查）**：e2e 链脚本用 `npm run e2e:x | tail -3`
  收集输出，管道让**失败场景的退出码被 `tail` 吃掉**——实测 Golden Path 报
  `21 PASS / 1 FAIL`，整步却仍 `exit=0`（汇总行与真实结果相反）。已改为
  `set -o pipefail` + 每场景完整日志 + 打印 FAIL/SKIP 明细；改后复跑 **12 个场景
  302 PASS / 0 FAIL / 0 SKIP**（含本轮新增的 `e2e:data-quality` 14 项）。


### Added
- **设备责任人的班次维度：本班优先、全天兜底、他班只报缺口（NO-51a，原则 1/3/7）**：
  - 缺口：NO-49a/NO-50a 的责任关系只有 (设备, 职责, 人)——现实里**同一台设备不同班次由不同人负责**
    （A 班张三、B 班李四）。缺这一维时现场只能"谁当班就把责任人改成谁"：另一班的事实被覆盖、
    夜班提醒常常发给**已经下班的人**；
  - **迁移 `standalone_084_responsibility_shift`**：`shift_id varchar(255) NOT NULL DEFAULT ''`
    （**空串 = 全天**；刻意不用 NULL——NULL 在唯一索引里互不相等，会破坏"同职责唯一"约束，实测教训），
    唯一索引升级为 (org, device, responsibility, shift_id) WHERE active，
    另加班次查询索引；rollback 会先把非全天行**停用**（保留事实）再恢复旧索引；
  - **路由语义（本班优先 → 全天兜底 → 他班只报缺口）**：共享纯函数
    `planResponsibilityRecipients(facts, accounts, { currentShiftId })`
    给每个收件人标注 `matchedBy`（`current_shift` / `all_shift` / `shift_unknown`）；
    **只覆盖别的班次的责任人不发提醒**（不该当班的人不该被叫），但进
    `outOfShiftPersons`/`outOfShiftResponsiblePersons` 缺口清单；角色兜底照旧；
  - **当前班次判定复用班次域**（`ShiftService.resolveCurrentShift` + 共享 `resolveShiftAt`）：
    解析不到/不在任何班次内 → **不猜默认班**，按全天兜底并标注 `shiftUnknown`；
    班次域不可用也**不阻塞**提醒（按全天兜底 + 如实标注）；
  - **页面**：责任人面板新增班次选择（全天 / 各启用班次），责任人条目显示"·班次 <id>"，
    单条汇总带班次标签（现场要知道这人是哪个班的）；
  - 测试：共享纯函数 +7 例（本班优先/全天兜底/他班缺口/班次未知/一人多职责去重/向后兼容）、
    服务层 +3 例（同职责不同班次是两条独立关系、换人只影响本班、班次域抛错不阻塞 + 当日解析）、
    oee 升级 +1 例（他班缺口汇总且角色照发）、展示口径 +2 例；
    `e2e:edge` 50 → **52 项**（5i 他班责任人→不发但报缺口 / 5j 本班责任人→点名到人）；
  - 契约：`openapi/ewoh.yaml` 的责任人写/删接口补 `shiftId`（含"他班不叫、只报缺口"的口径），
    路由清单 439 controller / 652 spec 不变（无新路由）。

### Added
- **设备责任人页面（NO-50a，原则 1/10）：把"谁负责这台设备"变成现场能维护的事实**：
  - 缺口：NO-49a 打通了"责任人 → 提醒点名到人"的链路，但**没有页面入口**——
    班组长只能用 API/脚本维护责任关系，现场等于用不上（上一轮风险清单第 2 条）；
  - **批量读接口** `GET /api/device-responsibilities?deviceIds=a,b,c`：设备台账一页
    几十台设备，逐台请求会退化成 N+1；独立前缀（不与既有 `GET /api/devices/:id` 撞路径），
    租户作用域一律来自调用者上下文（绝不接受跨租户参数）；
  - **台账页新增"责任人"列**：已登记显示"姓名（职责）等 N 项"；**未登记显式写
    "未登记责任人（提醒只能发到角色）"**（原则 7：缺失不能留白，否则班组长以为"这事不用管"）；
    顶部汇总"未登记责任人的设备 N 台"，把缺口变成待办；
  - **责任人设置面板**：三种职责**固定展示、空位保留**（要一眼看出哪个职责空着）；
    可选择人员（花名册）设置/换人（同职责换人 = 旧记录保留 + 新记录生效）、
    按职责收回；面板写明影响面——**该责任人会直接收到本设备的安灯与升级提醒，
    没有绑定登录账号只会进缺口清单**；
  - **不猜名字**：人员 id 解析不到姓名时原样显示 id（与更正对话框同一纪律）；
  - 测试：展示口径纯函数 **9 例**（固定顺序 / 空位保留 / 缺失显式 / 多职责汇总 /
    忽略停用与未登记职责 / 批量分组）、浏览器 **+3 例**
    （责任人列与顶部汇总 / 面板设置与收回 / 读取失败不伪装成"未登记"），设备台账
    浏览器套件 7 → **10 项**；
  - 契约：`openapi/ewoh.yaml` 新增批量读路由，路由清单 **439 controller / 652 spec**，
    0 未文档化 / 0 未实现。

### Added
- **设备责任人：让提醒"点名到人"而不是只广播角色（NO-49a，原则 1/3/7）**：
  - 缺口（本轮审计）：安灯/升级提醒一直发到**固定角色**（dispatcher / workshop_lead /
    safety_admin），而"这台设备是谁的"这个车间基本事实在平台里**没有位置**——
    结果是谁都收到、常常没人真去；对无人值守设备更是完全没有人被点名；
  - **数据模型**（迁移 `standalone_083_device_responsibility`）：(设备, 职责, 人) 三元组，
    职责封闭词表 `owner` / `operator` / `maintainer`；**同一设备同一职责同时只有一位 active**
    （部分唯一索引），换人 = 旧行置 `active=false`（带停用时间/停用者，历史保留——
    审计能回答"当时是谁负责的"）；`device_id` 用业务设备号（与安灯/遥测同一 id 空间）；
    RLS 租户隔离 + 四条 CHECK（职责词表 / 停用必带时间）；
  - **API**：`GET/POST /api/devices/:deviceId/responsibilities` +
    `DELETE /api/devices/:deviceId/responsibilities/:responsibility`（读=任何已认证角色，
    写=班组长/安全员/管理员）。**设备必须在本租户台账**（否则 404，不建影子设备）；
    同人重复设置**幂等**（不产生无意义历史行）；不同人换人走**同事务 CAS**，
    并发下命中 0 行 → **409**（不静默产生"同职责两位 active"）；收回不存在 → 409；
  - **提醒路由**（云侧开灯 / 边缘安灯 / SLA 升级三处统一）：收件人 =
    **设备责任人（点名到人）** + 角色兜底；person → 登录账号的反查走既有受控函数
    `ewoh_find_active_users_by_person`（不新开身份表读权限）；
    **责任人没有绑定账号 → 如实进 `unresolvedResponsiblePersons`**
    （扫描结果里显式列出，不假装通知到了），且**不阻塞**角色提醒；
  - **移动的部件都进了确定性通知号**：`NTF-ANDON-<安灯>-<桶>-<role|user>-<收件人>-<渠道>`
    ——不同收件人各自独立可幂等；
  - 测试：共享纯函数 **8 例**（职责词表与文案、身份归一、账号去重、缺口、无责任关系）、
    服务层 **13 例**（台账校验 404 / 幂等 / 换人历史 / CAS 并发 409 / 收回 409 /
    收件人解析与缺口）、oee 开灯路由 **1 例**；`e2e:edge` 47 → **50 项**
    （5f 责任人→点名到人 / 5g 无账号→缺口显式且角色兜底 / 5h 收回与重复收回 409）；
  - 契约：`openapi/ewoh.yaml` 新增三条设备责任人路由（含"404 不建影子设备""并发 409"
    的口径），路由清单 **438 controller / 650 spec**，0 未文档化 / 0 未实现；
  - **递归修复（本轮自证发现的两个真缺陷）**：
    ①迁移把 `_created_by` 写成 `uuid`——本仓库的审计主体是**登录账号 id（username）**，
    写入直接 `invalid input syntax for type uuid`（e2e 实测 500）；已改为 `varchar(255)`
    并回滚重放验证；
    ②责任人换人的 UPDATE **没链 `.returning()`**——假 DB 暴露"写操作没执行却静默通过"；
    真实 drizzle 下虽会执行，但**没有影响行数就无法发现并发窗口**；现在显式 CAS +
    0 行即 409，并把假 DB 的 `where()` 做成"可 await 也可 returning"（防止同类静默空操作）。

### Added
- **安灯"没人接手"的主动升级 + 重新开灯显式提醒（NO-48a，原则 1/2/6）**：
  - 缺口（本轮审计发现的安全盲区）：安灯现有的 SLA 升级**只在"有人接手但接晚了"时触发**
    （`transitionAndon` 的 acknowledge 分支）。真实且危险的场景是**红灯亮了、没人接手**——
    事件停在 `open`，既不升级、也不叫第二个人，直到有人偶然打开看板。
    另外 `closed → reopened`（挂账后重新开灯）此前**不发任何提醒**：现场只会看到状态变了；
  - **新增扫描服务** `AndonSlaService`（`POST /api/oee/andons/sla-sweep` + 定时 worker）：
    - 只升级**未接手**的安灯（`open`），`acknowledged`/`processing` 不重复升级（那是噪音不是安全）；
    - 分档：>1×SLA → **L1**（班组长 + 调度）；>2×SLA → **L2**（追加安全员）；
    - **只读业务事实**：不改状态、不写 evidence（升级是提醒与审计留痕，不代替人处置），
      但每次升级写一条 `oee.andon.sla_breach` 审计（谁在何时把哪条安灯升到哪一级）；
    - **缺失不下结论**：`openedAt` 无法解析 → 计入 `undecidable` 并如实返回，
      绝不用"现在"当开启时间（也就不会伪造出超期或没超期）；
    - 未记录 SLA → 用默认 15 分钟并在正文里**说明这是默认口径**；
  - **重新开灯提醒**：`closed → reopened` 在同一事务里给指派人与班组长发确定性提醒
    （桶 `reopened`），避免"关过一次"的安灯再次亮起时无人被告知；
  - **通知号再升级**（NO-47a 的延续）：安灯通知号加入**桶 + 收件人**段
    `NTF-ANDON-<安灯号>-<桶>-<role|user>-<收件人>-<渠道>`——升级要同时叫到调度/班组长/安全员，
    没有收件人段会互相覆盖；桶词表扩展为
    `raised` / `sla_escalation` / `sla_breach_l1` / `sla_breach_l2` / `reopened`；
  - **迁移 `standalone_082_open_andon_orgs`**：受控 SECURITY DEFINER 函数
    `ewoh_open_andon_orgs(interval)`——只返回"有未接手安灯的租户"org_id 列表
    （不含任何业务细节），供后台 worker 逐租户开 GUC 事务读明细；
    否则 RLS 会把行全挡住、worker 静默扫 0 条（NO-37a 的实测教训）；
    verify 自证"只返回一列 + SECURITY DEFINER + service_role 可执行 + PUBLIC 不可执行"；
  - 测试：共享纯函数 **9 例**（分档边界、缺时间不下结论、时间倒流、受众按级别、文案含"无人接手"）、
    扫描服务 **8 例**（只升级 open / L1·L2 受众 / 幂等 / undecidable / 默认 SLA 说明 /
    不改业务事实 / 审计留痕）、oee 重新开灯 **1 例**；`e2e:edge` 44 → **47 项**
    （5c 升级、5d 分桶共存 + 幂等、5e 升级随关灯了结）；
  - 契约：`openapi/ewoh.yaml` 新增 `POST /api/oee/andons/sla-sweep`（含"只读业务事实""缺失不下结论"
    的口径），路由清单 **435 controller / 646 spec**，0 未文档化 / 0 未实现；
  - **递归修复（本轮自证发现的两个真缺陷，都由"看日志"而不是测试暴露）**：
    ①受控函数实参没转 `::interval`——`ewoh_open_andon_orgs(($1 || ' days'))` 传 text，
    PostgreSQL 不隐式转 interval → `function ... does not exist`，worker **每 tick 都失败**
    且只留一行"失败 1 个"；现在把 SQL 构造抽成可测函数 `buildOpenAndonOrgsQuery`
    并由单测钉死 `::interval`；
    ②跨租户扫描只拿了租户清单、**没有逐租户开 GUC 事务**——RLS 把 `ewoh_event` 明细全部挡住，
    worker 静默扫 0 条（这正是 NO-37a 记录过的坑，我只做了一半）；现在每个租户都在
    `requestDatabaseContext.runInTransaction(buildGucSettings(systemCtx), …)` 里读明细，
    并由单测断言"清单里每个租户都开了一次 GUC 事务"；
    真机复验：`安灯 SLA 扫描：租户 1 个，超期未接手 1 条，新增升级提醒 3 条，重复跳过 0 条，无法判定 0 条，失败 0 个`。

### Added
- **安灯/Agent 提醒的确定性身份与处置闭环 + 通知号契约门禁（NO-47a，原则 1/6/10）**：
  - 缺口（本轮审计发现两类真问题）：
    ①**安灯提醒用随机 id**（`NTF-<8hex>`）：既不幂等（边缘重复上行/投影重放就重复打扰），
    也无法被治理度量归类——`shared/notification-metrics` 里登记的 `andon` 类型
    **没有任何写入方产生**，是"死词表"：页面上安灯这一类永远是 0，看起来"很干净"，
    实际是"看不见"；
    ②**安灯与 Agent 待批命令的提醒没有终态**：灯关了、"请值班长审批"的事办了，
    提醒还挂在待办里（与 NO-44a/NO-45a 已解决的会话/授权两类形成明显不一致）；
  - **安灯**：通知号改为确定性 `NTF-ANDON-<安灯号清洗>-<桶>-<渠道>`
    （桶：`raised` / `sla_escalation`，两者互不覆盖）+ `ON CONFLICT DO NOTHING`；
    **关灯（`closed`）时在同一事务内**把该安灯的提醒落 `andon_cleared`
    （`acknowledged`/`processing` **不**关闭——那时告警仍然有效；`reopened` 不复活旧提醒，
    那是需要人重新处置的新事实）；
  - **Agent 待批命令**：通知号改为确定性 `NTF-AGENT-<审批号清洗>-pending-app`；
    `resolveRow`（批准/驳回/超时作废）改为**台账 CAS 与提醒终态同事务**，
    处置码区分 `agent_approval_decided` 与 `agent_approval_expired`（超时是显式状态）；
  - **新增通知号契约门禁**（`test/unit/notification/notification-id-families.spec.ts`）：
    双向断言 ①server 源码里出现的每个 `NTF-` 字面量前缀都在族表登记、
    ②每个族的样本都能被分类器归到声明的类型、③每个已登记类型都有族覆盖（杜绝"死词表"）、
    ④族前缀互不前缀重叠。族表在 `shared/notification-metrics.ts`（`NOTIFICATION_ID_FAMILIES`）；
  - **新增共享假 DB 谓词求值助手**（`test/helpers/drizzle-fake-matcher.ts` + 自证 9 例）：
    同类缺陷已第三次出现（按值嗅探吞掉未知取值、`inArray` 裸数组 chunk、
    `like` 内联字面量），现在收敛到一处并**对未识别形态抛错**（宁可替身失败，
    也不让"条件没生效"伪装成测试通过）；
  - 测试：安灯助手 5 例（确定性 id/桶区分/渠道策略/租户为空的兼容）、
    oee 关灯闭环 1 例（状态 CAS 与提醒终态同事务 + 不误关其它安灯）、
    通知号契约 4 例、匹配器助手 9 例、Agent 侧 3 例（确定性 id + 可分类、处置了结、
    超时作废与"人处理过"可区分）；`e2e:edge` 41 → **44 项**
    （5/5a/5b：真库走完"边缘开灯 → 提醒到人 → 人关灯 → 提醒了结"）；
  - 契约：`openapi/ewoh.yaml` 的 `resolution` 枚举补齐（`andon_cleared` /
    `agent_approval_decided` / `agent_approval_expired`），route manifest 不变（无新路由）。

### Added
- **提醒治理与处置度量：把"人在环里"变成可读的运行记忆（NO-46a，原则 1/2/5）**：
  - 缺口：NO-44a/NO-45a 让"处置后提醒有终态"成立，但**没有任何人能回答管理问题**——
    现场处置得快不快？哪些提醒反复出现？有多少被放着没人管？投递失败有没有被漏掉？
    没有度量，"闭环"只是机制存在，无法被管理、也无法改进（原则 2 的反馈段是空的）；
  - **接口** `GET /api/notifications/metrics?days=N`（只读，班组长/安全员/管理员）：
    返回 totals（已处置/待处理/已读未处置/投递失败）、`dispositionRate`
    （= 已处置 / 扫描，**样本 < 3 条返回 null**，页面显示"证据不足"而不是 0%）、
    处置时长中位数/均值（**只统计可比样本**：创建与处置时间都可解析且顺序合理；
    缺时间戳/时间倒流单独计数 notComparable，绝不按 0 参与）、待处理账龄分布
    （1h/8h/24h/超 24h + "时间未记录"）、按类型计数、**反复出现的对象 Top 5**
    （按主事实 externalRef 聚合）、口径 notes；
  - **作用域与通知列表完全一致**（租户 + 角色 + 点名到人 + global 全量）：
    度量不会比明细看得更多——否则"我看到的数字"和"我能处理的提醒"对不上；
    取数按创建时间窗口（默认 30 天，1–365 规范化）+ 2000 行上限并如实标记 `truncated`；
  - **提醒类型是确定性分类，不是从标题猜**：`shared/notification-metrics.ts` 按各写入方的
    id 约定分类（会话超时/连续佩戴过久/佩戴人不符/疑似未佩戴/授权即将失效/授权已失效/
    安灯/其它/未识别），未登记形态归入 `other`/`unknown` 并原样保留，
    不猜成已知类型（原则 7）；
  - **前端**：审批控制台通知中心新增「提醒治理（运行记忆）」卡片——口径行、概览、
    处置率、处置时长、账龄（**零值桶不渲染**，不制造一排 0 的假信息）、按类型、
    反复出现的对象、口径说明逐条透出；读取失败时明说失败且**不显示成 0**；
  - 测试：共享纯函数 **12 例**（分类含"点名到人/渠道后缀"形态、样本门槛、
    可比/不可比时长判定、账龄分桶、Top N、投递失败分列、空列表形状、未识别类型不丢）、
    客户端展示换算 **6 例**（含"证据不足"绝不出 0%、截断口径、无数据≠0）、
    浏览器 **+2 例**（卡片渲染与零值桶不渲染 / 样本不足文案），
    `e2e:approval-expiry` 19 → **22 项**（7/7a/7b：真库度量计数与分类、
    非法窗口参数规范化）；
  - 契约：`openapi/ewoh.yaml` 新增 `/api/notifications/metrics`（含"作用域不放大""样本不足
    不给比率""类型来自 id 约定而非猜测"的口径说明），路由清单 434 controller / 645 spec，
    0 未文档化 / 0 未实现。

### Added
- **处置即闭环推广到第二类提醒：执行边界授权到期（NO-45a，原则 1/6/10）**：
  - 缺口：NO-44a 让"处置后提醒有终态"在外骨骼会话上成立，但**审批到期提醒**仍是老样子：
    授权真的失效之后，"即将失效，请尽快处理"那条提醒还挂在待办里——它的前提（还有时间处理）
    已经消失，现场每次打开通知中心都在看一条**无法执行**的催促；而重新申请成功之后，
    "已失效，请重新申请"的前提同样消失，却继续堆积。不同语义的提醒被一视同仁地留着；
  - **机制收敛**（避免第二个模块再写一套）：新增通用
    `server/modules/notification/notification-resolution.link.ts`
    （`resolveNotificationsFor` + `escapeLikePattern`），外骨骼侧退化为薄封装
    （`exo-session-notification-link.ts` 只保留 `NTF-EXO-` 前缀与词表）；
    词表扩展为**按主事实命名空间化**的封闭集合：
    `session_ended` / `session_aborted` / `session_corrected` /
    **`approval_expired`** / **`approval_superseded`**；
  - **授权失效 → 关闭催促**：到期扫描发现授权已失效时，同一轮把它的 `expiring` 桶提醒
    关成 `approval_expired`（`resolvedBy=system:expiry-sweep`）；
    **`expired` 桶保持待办**——"已失效，请重新申请"是需要人做决定的事实，两者绝不一起关。
    扫描结果新增 `resolved` 计数（单租户与跨租户两处）；
  - **重新申请并通过 → 旧提醒了结**：审批决策事务内（与 step/instance 的 CAS 同一事务），
    以 `approval_superseded` 关闭**同一对象**更早审批的待处置提醒，
    `resolutionRef` 指向新审批号（可从提醒反查"是哪次重新申请关掉了它"）。
    候选集不是"最近 N 张旧审批"，而是**直接从通知表反查"还挂着待办提醒的旧审批"**——
    实测踩过：旧审批时间戳会被回拨（e2e）或补录（真实数据），按时间取"最近"会漏掉真正的
    上一张，表现成"重新申请后旧提醒没关"；
  - **LIKE 转义（安全修正）**：通知号前缀可能含 `_`（会话号允许 `exo-session:LINE_A-1`），
    直接拼进 SQL LIKE 会把 `_` 当"任意单字符"，于是**另一条会话的提醒会被一起关掉**。
    新增 `escapeLikePattern`（转义 `\` / `%` / `_`），并在真库 e2e 中用
    "只差一个字符"的对照会话验证（`NO45_A` vs `NO45XA`：关 A 只关 A）；
  - **不覆盖先前的处置依据**：`resolution IS NULL` 守卫让第一次了结它的事实留痕
    （e2e 6b：先 `approval_expired` 的那条不会被后来的 `approval_superseded` 改写）；
  - 测试：通用链接 spec 8 例（fail-closed / 三重限定 / **LIKE 转义** / 幂等 /
    已读只补痕 / 投递状态不碰 / 处置引用按调用方写死）、共享词表 +1 例、
    客户端逻辑 +1 例、`e2e:approval-expiry` 16 → **19 项**
    （5h 失效关闭催促且保留"已失效"待办 / 6a 重新申请关闭旧提醒并指向新审批 / 6b 依据不被覆盖）、
    `e2e:exo-session` 51 → **52 项**（10h 真库 LIKE 转义对照）；
  - 契约：`openapi/ewoh.yaml` 补两个处置码与 `resolved` 计数语义，重新生成 `openapi.d.ts`
    与路由清单（433/643）。

### Added
- **处置即闭环：提醒必须有终态，但不静默消失（NO-44a，原则 6/7/8）**：
  - 缺口：NO-41a/NO-42a/NO-43a 之后，"异常被感知 → 主动叫到人 → 人核实 → 落成事实"
    已经通了，但**提醒本身没有终态**：班组长处置完，通知还挂在"未读"里，
    每次打开都在看已经处理完的事（现场噪音）；手工点"已读"只能表达"我看过了"，
    无法表达"这件事按某次处置了结"；事后也回答不了"这条提醒最后怎么了结、谁了结的、
    依据哪次处置"；
  - **第二个终态维度**（迁移 `standalone_081_notification_resolution`）：
    `ewoh_notification` 增加 `resolution`（封闭词表 `session_ended` / `session_aborted` /
    `session_corrected`）+ `resolved_at` + `resolved_by` + `resolution_ref`
    （更正=新会话号，收工/中止=会话号，可从提醒反查那次处置）+ 部分索引
    `(org_id, external_ref) WHERE status='pending'`（历史通知无限增长也不拖慢处置路径）；
    `read` 与"已处置"**互不替代**：`read`=人看过了，`resolution`=事情被处置了结；
  - **同一事务完成**（`server/modules/exo/exo-session-notification-link.ts`）：
    会话收工/中止/更正时，在同一事务内把该会话的待处置提醒落到 `status='resolved'`
    （`pending → resolved`）或补写处置痕迹（`read` 行状态不动、只加处置四列）。
    半成品状态（会话已收工但提醒还挂着 / 提醒关了但会话没收工）在平台侧不允许出现；
  - **三重限定，绝不误关**：租户 + `external_ref = 会话号` + 通知号前缀 `NTF-EXO-`；
    别人的会话、别的通知种类（andon/审批到期）、别的租户一律不碰；
    `sent`/`failed` 是**投递**事实，与业务处置无关，**不动**（否则投递失败会被悄悄吞掉）；
  - **幂等**：两个 UPDATE 都带 `resolution IS NULL`，重复收工/重复调用返回
    已终态且**不返回关闭计数**——"本次调用没有发生处置" ≠ "关闭了 0 条"（原则 7）；
  - **接口与页面**：收工/中止/更正响应新增 `resolvedNotificationCount`
    （=关闭的待办数）与 `annotatedNotificationCount`（已读行补痕数），并在事件证据里
    落同一组事实；`GET /api/notifications?status=resolved` 可单独查询；
    通知中心把"已处置"从"未读/已读"里独立出来（标题栏 `已处置 N`，
    列表显示"已随会话收工/中止/佩戴人更正关闭 · 处置人 · 时间 · 指向"），
    未知处置码原样透出；`markRead` 不把"已处置"降级成"已读"；
    `/exo` 收工/中止/更正的成功提示会说明"已同步关闭 N 条相关提醒"；
  - **顺带修掉两个测试替身缺陷（同类问题第二次出现，值得记）**：
    ①通知服务 spec 的"按值嗅探"匹配器把**未知取值静默当成"没有条件"**——
    `status='paused'` 的过滤条件整个消失，假 DB 返回全部行，于是"非法状态不静默按全部处理"
    这条契约在单元层永远测不出来；现在改为**按列名**递归求值（eq/inArray/isNull/and/or）。
    ②两个匹配器都不认识 drizzle 的 **`inArray` 右值形态**（裸数组 chunk，
    元素是 `Param` 包装），条件被静默丢掉：实测表现为"角色过滤失效、越权行可见"
    与"在飞任务状态集合判定为空"。现在解包后做集合成员判定；
    同一轮还补上了 `like` 的字面量内联形态（会话提醒只按 `NTF-EXO-%` 限定范围）。
    这类缺陷的共同特征是**测试通过但条件根本没生效**，比断言失败危险得多；
  - 测试：共享词表 +5 例、服务层 +7 例（收工关闭并留痕、幂等不覆盖第一次依据、
    中止用独立处置码、只动本会话/本租户/本类通知、已读行只补痕不改状态、
    更正指向新会话、事件证据带关闭条数）、通知服务 +3 例（resolved 单独查询、
    markRead 不降级、非法状态过滤不静默按全部）、客户端纯逻辑 +4 例、
    浏览器 +1 例（已处置独立展示 + 投递失败不被吞掉）、`e2e:exo-session` 扩到 **50 项**
    （10d 收工关闭 2 条 / 10e 重复收工不重复处置 / 10f 收件人视角看到"已处置"且不再挂待办 /
    15g 更正关闭的提醒指向新会话）；
  - 契约：`openapi/ewoh.yaml` 补 `status=resolved`、处置四列语义与两个计数字段
    （明确"幂等路径不返回计数"的口径），重新生成 `openapi.d.ts` 与路由清单（433/643）。

### Added
- **按实际佩戴人更正会话：人核实之后必须能落成事实（NO-43a，原则 4/5/6/8）**：
  - 缺口：NO-41a/NO-42a 让"会话说 A 在戴、遥测说是 B"**可见**且能**叫到人**，
    但核实完之后**没有任何动作能把结论写成事实**——现场只剩两个坏选择：
    把 A 的会话"核实并收工"（等于丢掉 B 正在佩戴这段事实：B 没有会话，
    后续"佩戴中"资格判定与偏差复盘全都失真），或者不改（世界模型继续错着）。
    这是"人在环里"的断点：平台能发现问题，却不能接受人的结论；
  - **新命令** `POST /api/exo/sessions/{sessionId}/correct-wearer`（**交接语义，不是改字段**）：
    单事务内 ①以 CAS 结束旧会话（`status='ended'` + 结束人 + 理由 + `correctedTo` 指向新会话，
    旧佩戴人**永不就地覆盖**——审计要能回答"谁戴过、谁核实的、依据什么"）；
    ②锁设备行（与"开始会话""派工"同一把锁 = 同一互斥机制）并复查在飞任务边界，
    新佩戴人同样受执行边界约束，人机同体的合法组合照旧放行；
    ③按实际佩戴人开新会话（继承任务与仍在未来的计划结束时间，写 `correctedFrom` /
    `correctionReason`），返回 `{corrected, fromPersonId, toPersonId, reason, ended, started}`；
  - **更正链路双向可见**（否则审计只看到两条互不相关的会话）：会话响应透出
    `correctedTo`（旧会话 → 交接给谁）与 `correctedFrom`（新会话 ← 由谁更正而来），
    未经过更正的会话**不返回**这两个字段（缺失 = 没发生，不是空串）；
    `/exo` 会话行显示「已交接给 …」/「由 … 更正而来」，e2e 断言两个指针互指；
  - **拒绝路径都显式**：缺 `personId` → 400；裸人员 id 与 `person:<uuid>` 等价（ADR-006）；
    佩戴人未变 → 400 `EXO_SESSION_WEARER_UNCHANGED`（不产生无意义的新会话）；
    会话已非进行中 → 409 `EXO_SESSION_NOT_ACTIVE`；并发终结 → 事务内 CAS 失败即回滚；
    在飞任务冲突 → 409（沿用 NO-39a 判定，不另造一套）；
  - **人永远在环里**：平台**不会**自动调用它。遥测只是证据，`needsHumanCheck` 只是"请人看一眼"；
    `activity_only` / `stale_telemetry` / `no_telemetry` 这些"没指名别人"的结论
    **一律不给更正动作**（缺证据 ≠ 事实，平台不替人指认谁在戴）；
  - **权限比收工更严**（原则 8）：收工只终结自己的事实，而更正会**替另一个人**建立
    "正在佩戴"的事实（影响其资格判定、派工边界与偏差统计），因此该命令限定
    `workshop_lead` / `safety_admin` / `global_admin`；现场人员仍可自由收工/中止自己的会话。
    e2e 用**现场账号**实测越权被拒（403）且**被拒后无副作用**（进行中的会话不受影响）；
  - **前端 `/exo`**：只有 `wearer_mismatch` 才出现「按遥测佩戴人更正」；确认面板把决策原则
    要求的五件事摆全再让人点——**来源**（哪一帧）、**时间**（帧时间 + 证据年龄）、
    **影响面**（旧会话以"交接"结束并留在台账、为实际佩戴人新开进行中会话、
    **设备仍被占用不会自动交回**）、**约束与风险**（遥测可能失真/滞后、更正写入审计、
    反向判断请改用结束或中止）、**更正对象**（姓名 + id，解析不到就只显示 id，不猜名字）；
  - **修一处显示口径缺陷（顺带）**：会话行的"需人核实"配色此前只看 `needsHumanCheck`，
    于是 `stale_telemetry`（证据过期）与 `inactive_suspect`（疑似离岗）被显示成中性灰——
    等于把待核实的事实降级成正常状态。新增单一来源 `EXO_VERDICT_SEVERITY` /
    `isExoVerdictActionable`（页面与浏览器测试共用同一次序）；
  - 测试：服务层 +6 例（交接语义与指针、裸 id 规范化、同人 400、非活跃 409、在飞任务冲突、
    任务计划结束时间继承）、客户端纯逻辑 +9 例（严重度、证据年龄文案、更正计划的
    证据/影响面/风险、六种判定只有一种可执行、缺证据不指认）、浏览器 +1 例
    （按钮只在冲突会话出现、确认前展示证据/影响面/风险、提交规范化 `person:` id、
    成功后关闭对话框）、`e2e:exo-session` 扩到 **45 项**（15/15a–15e：缺 personId 400 →
    同人 400 且原会话不动 → 更正后旧会话 ended 带理由、新会话是遥测指名的实际佩戴人 →
    一致性翻转为 `consistent` → 历史仍可追溯 → 新会话可按常规流程收工释放设备）；
  - 契约：`openapi/ewoh.yaml` 补 `correct-wearer`（含"交接而非覆盖""平台不自动触发"口径），
    重新生成 `client/src/types/openapi.d.ts` 与路由清单（**433 controller / 643 spec**，
    undocumented 0 / unimplemented 0）；
  - 修复测试替身（顺带）：`exo-session.service.spec.ts` 的假 DB 此前让**每行共用同一个
    uuid 主键**，而按主键更新的 CAS 会顺带改掉同租户的其它会话（实测表现为
    "更正别人的会话"没报 400）；现在由 `sessionId` 派生稳定 uuid，并把"按值猜列"的匹配器
    换成**按列名**匹配（`COL_TO_KEY` + drizzle `queryChunks` 遍历），
    消除"uuid 形状的值被误当主键比较"这类隐患。

### Added
- **遥测冲突主动叫到人 + 带证据的处置动作 + 可比样本率（NO-42a，原则 1/2/5）**：
  - 缺口：NO-41a 让"会话声明 × 遥测证据"的冲突**在页面上可见**，但仍是**被动**的——
    班组长不打开 `/exo` 就不知道"会话说 A 在戴、遥测说是 B"；而对现场来说，
    真正需要的是一句"现在该做什么"；
  - **冲突进入主动提醒**（复用 NO-37a 的幂等通道，同一实现、不另算一套口径）：
    `ExoSessionReminderService.sweep` 现在同时扫两个维度——时间（overdue/long_running）
    与**证据**：`telemetry_wearer_mismatch`（high）/ `telemetry_inactive_suspect`（medium）；
    `consistent` / `activity_only` / `stale_telemetry` / `no_telemetry` **一律不打扰**；
    每个标签一条确定性通知 id（`NTF-EXO-<会话>-<标签>[-user-<收件人>]-<渠道>`），
    收件人仍是班组长 + 佩戴者本人绑定账号；
  - **修复一处真实缺陷（e2e 实测）**：账号↔人员解析此前只覆盖"时间桶命中"的会话，
    于是"刚开始佩戴、还没超时但遥测冲突"的会话**发不到佩戴者本人**（实测 role=true /
    wearer=false）。现在解析范围覆盖**扫描到的全部活跃会话**，并加回归用例；
  - **前端处置动作**：命中"需人核实"的会话多一个「核实并收工」按钮——结束理由里写入
    校验判定与依据（`遥测校验（wearer_mismatch）：…`），让"为什么结束这次会话"可复盘；
  - **可比样本率（KPI）**：偏差复盘新增 `plannedCoverageRate` = 可比会话 / 已收工会话
    （无样本 → `null`，不是 0%），并在卡片口径行展示——用来度量 NO-40a
    "预计结束时间可继承"的结构性改进是否真的生效，而不是停留在感觉上；
  - 测试：提醒服务 +4 例（冲突提醒与收件人、疑似无人佩戴、幂等、**刚佩戴会话也要点名到人**）、
    共享聚合 +1 例（可比样本率含无样本 null）、浏览器 +1 例（核实并收工带证据理由）
    并断言可比样本率展示；`e2e:exo-session` 扩到 **39 项**
    （14c/14d：冲突 → 班组长 + 佩戴者本人各一条 → 重复扫描不重复打扰）；
  - 契约：`POST /api/exo/sessions/reminder-sweep` 的 OpenAPI 说明补齐"两个维度 + 六种判定
    中只有两种打扰"，重新生成 `openapi.d.ts`。

### Added
- **佩戴事实的双源交叉校验：会话声明 × 设备遥测（NO-41a，原则 3/7）**：
  - 缺口：外骨骼会话是**人工声明**（谁戴了哪台），而遥测里本来就有"当时是谁在戴"这一路证据
    （边缘统一帧的 `worker_id`，能力台账 `observe.wearer` 的字段）。但平台从未接收该字段，
    落库即丢弃——世界模型只有一条"声明"，无法回答现场最常见的两类问题：
    会话说 A 在戴、遥测显示是 B；会话还开着、设备早已无活动（人走了没收工）；
  - **迁移 `standalone_080_telemetry_worker_id`**：`ewoh_telemetry.worker_id`（可空；
    NULL = 该帧未上报佩戴人，是**数据缺口**，不是"没人戴"）+ `(org_id, device_id, ts DESC)`
    索引（支撑"每台设备最近一帧"，既有索引按设备过滤会退化成扫窗口）；
  - **摄入接收并落库**（`ExoskeletonFrameDto.worker_id`）：单帧与批量两条映射路径共用
    `normalizeWorkerId` —— 实测踩过"批量带佩戴人、单帧不带"的静默分叉；
  - **判定词表（封闭，六种，纯函数 `classifyExoTelemetryConsistency`）**：
    `consistent`（帧里写明的佩戴人 = 会话佩戴者）／`wearer_mismatch`（**硬冲突**，需人核实，
    平台不替任何一方下结论）／`activity_only`（设备在动作但未上报佩戴人：只能证明"有人在用"）／
    `inactive_suspect`（未上报佩戴人且指标全静：**疑似**未佩戴，用词绝不升格为事实）／
    `stale_telemetry`（最近帧超新鲜窗口或时间不可解析：证据过期，不下结论）／
    `no_telemetry`（窗口内没有任何帧：**无佐证**，不是"没有佩戴"）；
  - **接口** `GET /api/exo/sessions/consistency`（只读、租户作用域）：一次 `DISTINCT ON (device_id)`
    取每台设备最近一帧，逐条给出判定、理由、证据年龄与需人核实标记，并把口径写进 `notes`
    供前端**逐字展示**；
  - **前端 `/exo`**：进行中会话行展示"遥测校验：与遥测一致／佩戴人与遥测不符（需核实）／
    遥测显示有人在用但未上报佩戴人／疑似未佩戴已离岗／证据已过期／无遥测佐证"+ 理由；
    冲突标红，终态会话不再显示（已收工，一致性无意义）；
  - 测试：判定纯函数 8 例（六种判定 + 阈值可配置 + 会话佩戴者缺失）、服务层 3 例
    （一致/无遥测并存、佩戴人不符需核实、缺 org 400）、浏览器 1 例（一致与冲突分别展示、
    终态不显示）、`e2e:exo-session` 扩到 **37 项**（14/14a/14b：走**真实摄入通道**上报两帧，
    分别判成"与遥测一致"与"佩戴人不符"，并断言响应自带口径说明）；
  - 契约：`GET /api/exo/sessions/consistency` 与摄入帧 `worker_id` 进 OpenAPI，
    重新生成 `openapi.d.ts` 与 `route-manifest.json`（432/642）。

### Added
- **会话 ↔ 任务关联：让"预计 vs 实际"有可比样本（NO-40a，原则 2/3/5/7）**：
  - 缺口一：会话记的是"谁戴了哪台设备"，**没记在干哪张任务**——"任务 ↔ 会话"只能靠
    设备+人员间接推断，现场与调度都答不出"这次佩戴是在做哪张单"；
  - 缺口二（更直接的产品后果）：上一轮偏差复盘实测 **90 条已收工会话只有 23 条可比**
    （其余缺"预计结束"）。原因不是现场不愿填，而是**没人知道该填什么**：任务的
    `plan_end` 本来就在库里，只是会话与任务没有关联，无法自动继承；
  - **迁移 `standalone_079_exo_session_task_link`**：`ewoh_exo_session.task_id`
    （可空，NULL = 未关联任何任务，**不是**"没有任务"）+ `(org_id, task_id)` 索引；
    **刻意不加外键**——任务可被取消/回退，而会话是物理发生过的事实，级联删除会抹掉现场事实；
  - **开始会话可绑定任务**（`POST /api/exo/sessions { taskId }`）：
    · 未填 `expectedEndAt` → **继承任务计划结束时间**（且只继承"晚于开始时间"的计划，
      过去的时间不拿来充数），来源记为 `task_plan_end`；
    · 现场手填 → 手填优先，来源记为 `operator`（不覆盖人的判断）；
    · 任务不存在/非本租户 → 400 `task_not_found`（不静默忽略绑定声明）；
    · 任务关联的是另一台设备 → 409 `EXO_SESSION_TASK_DEVICE_MISMATCH`（错的关联不落库）；
  - **设备上下文**（`GET /api/exo/sessions/device-context`，只读）：返回该设备是否在台账、
    当前活跃会话、**在飞任务**与一条"可执行建议"——唯一在飞任务才建议绑定，多任务
    **不给建议**（绑定哪张是人的决定，平台不替现场猜）；受派人 ≠ 本次佩戴人员时仍给出
    任务但标记不匹配并说明"会被执行边界拒绝"；计划结束时间已过期/缺失则如实说明不继承；
  - **前端 `/exo`**：选定设备后展示设备上下文（在飞任务、当前佩戴、建议理由），
    默认勾选"绑定在飞任务并继承计划结束时间"（可取消），会话列表标注关联任务与
    "（继承任务计划）"来源；
  - 测试：纯函数 5 例（唯一/无/多任务、受派人不匹配、过期与缺失计划）、服务层 6 例
    （继承、手填优先、过期不继承、任务不存在、设备不匹配、不绑定合法）、
    客户端逻辑 1 例（透传与非法来源 fail-closed）、浏览器 1 例（上下文面板 + 携带 taskId）、
    `e2e:exo-session` 扩到 **34 项**（13/13a/13b/13c）；
  - 契约：`GET /api/exo/sessions/device-context` 与 `taskId` 请求字段进 OpenAPI，
    重新生成 `openapi.d.ts` 与 `route-manifest.json`（431/640）。

### Added
- **反方向的执行边界：开始会话时查"在飞任务"（NO-39a，原则 3/7/8）**：
  - 缺口：NO-36a 只做了一个方向的判定——**派工时**查"设备是否正被别人佩戴"。
    反方向漏了：先把任务下发给 A、B 现场再戴上这台外骨骼，两侧各自都"没看见对方"，
    结果是"任务已下发给 A + B 正在佩戴"这种物理上不可能的状态被写进台账；
  - **规则（与派工侧完全对称，纯函数单点）** `findExoSessionStartConflicts`：
    · 只收**在飞任务**（`TASK_LOCKED_STATUSES` = dispatched/received/executing/paused/
      exception）；`draft`/`pending_*` 只是方案与待批，**不是执行边界**（原则 6），
      不反过来卡住合法的现场佩戴——它们真被下发时由派工侧事务内复查拦住；
    · 在飞任务受派人 == 佩戴者 → 合法（同一个人，人机同体）；
    · 受派人 ≠ 佩戴者 → `assignee_mismatch`；在飞任务没写受派人 → `assignee_missing`
      （谁去用？不能猜）；佩戴者引用不可解析 → fail-closed；
  - **409 `EXO_SESSION_TASK_CONFLICT`**：消息给出任务标题/编号/状态、受派人、佩戴者与
    解决方向（改派给佩戴者、回退/取消该任务、或换一台设备）；
  - **并发硬化（双向互斥）**：开始会话在事务内先 `SELECT ... FOR UPDATE` 锁住设备行，
    派工事务对本波涉及的设备行按 id 排序后同样加锁（避免多设备死锁）。
    两个方向因此被串行化：先提交者的写入一定被后者的检查读到，不会"各读旧状态、双写成功"；
  - **只锁台账设备**：设备不在台账（如 e2e 的临时设备号）时无行可锁、也无法被任务引用，
    此时不做判定（不猜、不阻塞）；
  - 测试：规则纯函数 7 例（他人/本人/无受派人/他人设备/不可解析/空输入/文案）、
    服务层 4 例（409 且不落库不发事件、本人放行、无受派人拒绝、非台账设备不判定）、
    `e2e:exo-session` 扩到 **30 项**（12/12a/12b：在飞任务 → 409 且消息带任务号 →
    受派人本人佩戴放行 → 回退派工后约束解除不残留假封锁）；
  - 契约：`POST /api/exo/sessions` 的 OpenAPI 说明补两条执行边界与 409 响应，
    重新生成 `client/src/types/openapi.d.ts`。

### Added
- **偏差复盘：把"预计 vs 实际"变成可判定、且不撒谎的经验（NO-38a，原则 2/5/7）**：
  - 缺口：NO-36b 让单条会话能比较预计与实际，但**没人把它们聚起来**——班组长看不到
    "这台外骨骼/这个人最近是不是总超时"，闭环缺最后一步"形成可追溯的经验"；
  - **服务端口径**（`GET /api/exo/sessions/deviation-summary`，只读、租户作用域）：
    只统计**已收工**（ended/aborted）且 `started_at` 落在窗口内（默认 30 天，上限 365）的会话；
    行数上限 2000 并在触顶时返回 `truncated=true`（不把部分窗口说成全部历史）；
  - **聚合纯函数** `summarizeExoSessionDeviations`（`shared/exo-session.ts`，前后端同一实现）：
    按设备/人员分组，给出会话数/已收工/可比/准时/提前/超时/不可比、平均与中位偏差、
    最差超时、最多提前；
  - **诚实边界（本轮的核心口径）**：
    · 只有**同时**记录"预计结束 + 实际结束"的会话才可比；缺任一时间戳的会话计入
      `notComparable` 并在 notes 里说明——**缺失 ≠ 准时**；
    · 可比样本 < `EXO_DEVIATION_MIN_SAMPLE`（3 条）时 `onTimeRate = null` 且明说
      "只给计数，不给准时率结论"，**绝不用 0% 冒充**（1 次超时不足以宣布"总是超时"）；
    · 全局 notes 说明口径与门槛，页面必须展示（避免把"不可比"读成"表现良好"）；
  - 实测（本地真实库）：62 条已收工会话中 **47 条不可比**（历史多未填预计结束时间）——
    系统如实说"这些会话的准时与否无证据"，而不是给一个好看的假比率；
  - **前端**：`/exo` 作业台新增「偏差复盘」卡片——按设备/人员切换、合计行 + 分组行、
    准时率/平均/中位/最差超时、样本不足标签与逐条说明、截断告警与失败显式报错
    （不显示成"没有偏差"）；
  - 测试：共享聚合 6 例（比率门槛、不可比计数、分组、空输入、参数规范化）、
    客户端展示 6 例（比率透传、证据不足不显示 0%、排序、无偏差文案、带符号偏差）、
    浏览器 1 例（卡片渲染 + 证据不足文案 + axe 覆盖）、`e2e:exo-session` 扩到 **27 项**
    （11/11a/11b：真实库上"可比/不可比计数 + 说明"、"按人员分组"、非法窗口被规范化）。
- **人机同体配对的正向说明（NO-38b，原则 5）**：
  - 缺口：拒绝侧有 `device_in_active_session`，但**合法的那一条**（佩戴者本人）此前
    没有任何说明——现场看到"只有他能接"却不知道为什么，也无法判断换人要做什么；
  - 候选引擎新增 `buildSessionNotes`：设备处于外骨骼会话且**候选人员就是佩戴者**时，
    给出"设备 X 正由该人员佩戴（会话 Y，开始于 Z）：本候选是人机同体配对；
    若要改派他人，需先结束会话或由现场改派佩戴者"；只解释、不参与判定
    （eligible 仍由资格服务决定），非佩戴者不会得到该说明；
  - 契约/展示：`TaskCandidateResource.sessionNotes` + `CandidateEvaluation.sessionNotes`
    → `candidateExplainVM` 透传 → 任务智能面板渲染（前端不重算、不编造）；
  - 测试：候选引擎 1 例（佩戴者有说明、他人没有）、客户端 VM 1 例（透传 + 缺字段为空数组）；
  - 文档/契约：`openapi/ewoh.yaml` 补 `GET /api/exo/sessions/deviation-summary`，
    重新生成 `openapi.d.ts` 与 `route-manifest.json`（430/638，未文档化 0 / 未实现 0）。

### Added
- **外骨骼会话主动提醒：平台要主动叫人，而不是等人打开页面（NO-37a，原则 1/5/7）**：
  - 缺口：NO-36b 让"超过预计结束 / 长时间佩戴"在 `/exo` 页面上可见，但那是**被动**的——
    班组长不打开页面就不知道有人戴着外骨骼没收工。忘记收工有两个真实后果：
    ① 设备被占住，后续派工按"佩戴中"硬约束被拒；② 世界模型里的物理事实与现实脱节
    （人已离岗，系统还以为他在用）。与"授权到期提醒"同类：占用会失效，人必须被叫醒；
  - **桶与阈值**（`shared/exo-session.ts` 单一来源，页面与通知同口径）：
    `overdue`（超过预计结束 **+15 分钟宽限**，严重度 high）优先于
    `long_running`（连续佩戴 **≥4 小时**，medium）；宽限内不打扰（5 分钟轻微超时不叫人）；
    没填预计结束但戴满 4 小时同样提醒（"没记录计划"≠"可以一直戴着"）；
    终态不提醒（已经收工），开始时间不可解析则既不猜也不误报；
  - **收件人**：角色 `workshop_lead`（班组长，现场负责人）+ **佩戴者本人绑定账号**
    （`ewoh_user.person_id` ↔ 会话 `person_id`，经 NO-36 的账号↔人员绑定）。
    查不到绑定不是错误，但必须**如实列出**在 `unresolvedWearers` 里，不静默丢弃；
  - **幂等**：通知 id 由 (会话号, 桶, 收件人, 渠道) 确定性推导
    （`NTF-EXO-<会话号>-<桶>[-user-<收件人>]-<渠道>`）+ `notification_id` 唯一约束 +
    `ON CONFLICT DO NOTHING`——重复扫描/多实例只累加 duplicates，一次超时只叫一次；
  - **只读扫描**：绝不改会话状态、不代替人收工；通知正文写明设备/佩戴者/开始/已佩戴/
    预计结束/已超时与"平台只管理会话绑定，不下发任何设备指令"的边界；
  - **交付面**：`POST /api/exo/sessions/reminder-sweep`（workshop_lead/safety_admin/
    global_admin，幂等）+ 定时 worker `ExoSessionReminderWorkerService`
    （`EXO_SESSION_REMINDER_WORKER_DISABLED` / `EXO_SESSION_REMINDER_WORKER_INTERVAL_MS`，
    默认 10 分钟）；
  - **数据访问收口（standalone_078，实测踩坑）**：运行角色对身份表 `ewoh_user`
    **没有任何直接授权**（RLS + 无 policy + REVOKE ALL），直查得到
    `permission denied for table ewoh_user`（接口 500）→ 新增两个 **SECURITY DEFINER**
    受控函数：`ewoh_find_active_users_by_person(org, person_ids)`（只返回
    username/person_id，不暴露口令哈希/角色）与 `ewoh_active_exo_session_orgs()`
    （后台 worker 用的跨租户租户清单，只返回 org_id）；
  - **后台 worker 的 RLS/GUC 教训**：worker 没有请求上下文 → 根句柄无
    `app.current_org_id` → `ewoh_exo_session` 的 RLS 挡住全部行，表现为
    **"接口上提醒正常、定时 worker 静默 0 提醒"**。修法：租户清单走受控函数，
    之后**逐租户** `runInTransaction(buildGucSettings(systemCtx))` 再读明细/写通知——
    租户隔离在真正读写数据那一步照旧生效（已写入运维 runbook）；
  - 测试：共享分类 7 例（宽限/阈值/终态/时间不可解析）、服务单测 6 例（收件人、
    正文事实、幂等、未绑定如实列出、逐租户失败隔离 + **GUC 事务断言**）、
    `e2e:exo-session` 扩到 **24 项**（10/10a/10b/10c：扫描出提醒 → 幂等 →
    **佩戴者本人账号能读到点名给自己的提醒** → 收工后不再提醒），
    并额外用 8 秒间隔的 worker 实测"无人操作也会自动提醒"（实测日志：租户 1 个、
    新增提醒 2 条）；
  - 迁移：`standalone_078_person_user_lookup`（apply/rollback/verify 三件套 +
    runner 注册；verify 断言 PUBLIC 无 EXECUTE、身份表仍 fail-closed）。

### Added
- **2026-09-11 具身工厂闭环补全批次（DR-2~DR-6：班次 / 数据质量确认 / 方案回滚 / 复盘运行记忆 / 世界模型扩展）**：
  以"感知—理解—决策—授权—执行—反馈—学习"闭环为目标，补齐审计发现的五个结构性缺口。
  全链验收：`make e2e-fault-replan`（真实后端 + 真实 PostgreSQL，18/18 断言 PASS）。
  - **班次域（DR-2，standalone_074）**：`ewoh_shift` / `ewoh_shift_handover` 两表（RLS 租户隔离 + 窗口/状态 CHECK 生效探测）；共享纯函数 `resolveShiftAt`（前后端同构判定，窗口间隙显式 unknown 不猜默认班；容 PG time 列含秒格式）；`/api/shifts*` 五端点 + `ShiftHandoverRecorded` 目录事件；`/shift-workbench` 班次工作台（当班横幅 / 当班异常 + 数据质量确认 / 待审批方案 / 执行偏差 / 物料缺口 / 交接班登记 / 班次定义）；种子三班制（早/中/夜跨零点）。
  - **数据质量人工确认（DR-4，standalone_076）**：闭环第②步的落点——`ewoh_data_quality_confirmation` 台账（confirmed=可信可用于决策 / contested=不可信相关决策需复核；判定人取服务端会话；同事件 UNIQUE 幂等改判）；confirmed 联动 resolve 同源 open DataQualityAlert（失败不阻断主事实）；`DataQualityConfirmed` 目录事件；班次工作台确认/质疑入口。
  - **方案取消/回滚（DR-5，standalone_077）**：`POST /plans/:planId/cancel`（reason 必填、审计、PlanCancelled outbox/SSE）；部分回退语义——未开始 assignment（proposed/approved/dispatched/acknowledged）→ cancelled + 释放预占 + 任务回退；已开始的物理不可撤销、显式列入 irreversibleAssignmentIds 如实回报；任务状态机契约扩展 `rollback_dispatch`（dispatched/received → pending_dispatch，task.yaml + TS + Python 三方锁步）；未开始 Execution 标记 CANCELLED；方案状态机新增终态 `cancelled`（前后端动作矩阵/徽章/流程带同步）；排产页"取消派工/回滚"危险动作。
  - **复盘/运行记忆（DR-3，standalone_075）**：`ewoh_retrospective` 台账（scope=plan/incident/shift；同 target 部分唯一索引——至多一条非 superseded）；`POST /api/retrospective/from-plan` 六段组装（感知/数据质量/决策/授权/执行/反馈）——只引用既有台账证据（evidenceIds），缺失环节显式进 gaps 不伪造；AI 总结（Ark LLM 事务外调用 + 规则模板兜底，narrationSource=llm|rule_fallback 双路留痕）；结构化经验条目（AI 建议 + 人工可修订）；发布/RetrospectiveRecorded 事件；学习控制台"复盘·运行记忆"面板（列表 + 组装 + 发布 + 缺口清单）。
  - **世界模型扩展（DR-6）**：调度世界快照新增 `materials`（缺口/低于阈值行 + 口径 note）、`orders`（未完工 ERP 订单）、`shifts`（班次定义）三个 advisory 投影（不进 entityVersions 新鲜度比较——物料事实变化不使既有方案失效）；物料聚合 per-org 15s TTL 缓存（租户隔离键，限流 collectState 高频成本）。
  - **闭环 UX 真实化**：顶栏待办收件箱从演示占位改为真实计数（open 异常 + 待审批方案 + 离线队列；失败显式"—"不冒充 0）；`DataCredibility` 孤儿组件接线（班次工作台"本页数据可信度"面板）。
  - **事件目录扩至 69 类**：PlanCancelled / DataQualityConfirmed / ShiftHandoverRecorded / RetrospectiveRecorded（yaml + TS + Python 镜像三方一致，audit-event-catalog 门禁通过）；OpenAPI 契约 +10 路径（428 操作全文档化，no-drift 门禁通过）。
  - **全闭环 E2E（`make e2e-fault-replan`）**：生产正常执行中突发设备故障的完整叙事——班次解析 → 方案生成（3 候选）→ AI 解释留痕 → 独立审批 → 派工 17 项 → 现场回执（开始/完成）→ 预计 vs 实际 → 故障事件感知（真实 ingest 通道）→ 数据质量确认（含词表外 fail-closed）→ 取消回滚（16 回退 / 1 已执行不可回退如实回报 / 任务回池）→ 复盘六段组装 + 发布 → 快照扩展字段断言。

### Added
- **外骨骼会话 = 提交时刻的执行边界（NO-36a，原则 3/7/8）**：
  - 缺口：上一轮让候选池知道了"哪台外骨骼正被谁佩戴"，但**下发时刻**没人再判一次。
    方案从生成→审批→下发可能隔几分钟到几十分钟，期间现场有人先戴上那台设备，
    于是平台会把一个物理上不可能完成的指派写成"已派工"（现场做不了，看板却说已下发）；
    任务创建还允许直接写 `assigneeId + deviceId`，完全绕开这条硬约束；
  - **规则单点**：新增纯函数模块 `server/modules/exo/exo-assignment-guard.ts`——
    佩戴者本人 + 该设备 = 合法（人机同体）；指派别人 → `wearer_mismatch`；
    有会话却没指派人员 → `assignee_missing`（不能猜谁去用）；佩戴者引用不可解析 →
    冲突而不是放行（fail-closed）；无会话 → 不阻塞（缺数据 ≠ 有冲突）；
  - **两个事实适配器，一条规则**：派工事务用世界模型快照
    （`activeSessionFactsFromDevices`，与安全阻断/工位容量同一次 `collectState`）；
    任务写入用会话权威表直读（`ExoSessionService.findActiveSessionsForDevices`：
    `ewoh_exo_session` ⋈ `ewoh_device`，按 `'device:' || device_id` join）——
    规则实现只有一处，避免"预检说行、提交说不行"；
  - **派工**：事务前 fail-fast → 409 `EXO_SESSION_DISPATCH_CONFLICT`；事务内复查
    → 409 `EXO_SESSION_DISPATCH_CONFLICT_TX`（与 R2-SSV-14 的安全阻断复查同一模式，
    事务回滚保证要么整波下发、要么一条都不下发）；
  - **任务创建**：409 `EXO_SESSION_ASSIGNMENT_CONFLICT`；本实例未装配会话服务时
    503 `EXO_SESSION_GUARD_UNAVAILABLE`（**缺装配 ≠ 放行**，这是 2026-09
    "审批端口缺失导致闸门静默失效"的同类风险）；
  - 测试：守卫纯函数 12 例（含"佩戴者前缀/裸 uuid 视为同一人"、"缺数据 fail-closed"）、
    派工集成 3 例（预检 409 / TOCTOU 事务内 409 且零预占 / 佩戴者放行）、
    任务创建 3 例（409 不落库 / 同体放行 / 缺装配 503）；
- **预计 vs 实际：会话偏差进运行记忆（NO-36b，原则 2/5/7）**：
  - 缺口：会话有 `expectedEndAt` 也有 `actualEndAt`，但**没人比较**——"预测—执行—实际结果"
    这条记忆链在最有数据的地方断了；现场只能看到"已进行 5 小时"，看不出比计划晚了多久；
  - **共享纯函数** `projectExoSessionTiming`（`shared/exo-session.ts`）：时长、偏差
    `deviationState ∈ {unknown, early, on_time, over}`（±5 分钟容差）、进行中
    `overdue/overdueMs/remainingMs`；无预计结束时间 → `unknown` 且文案明确"无法比较"，
    **绝不把"没记录"说成准时**；开始时间不可解析只影响时长，偏差仍按"预计+实际"给出；
  - **服务端**：会话 API 每行带 `timing`；`ExoSessionEnded` 事件 `evidenceJson` 写入
    `expectedEndAt/actualEndAt/durationMs/deviationMs/deviationState`（可复盘/可学习）；
  - **前端**：`/exo` 作业台逐条显示"已超时 1 小时 20 分 / 距预计结束还有 30 分钟 /
    超时 2 小时结束 / 在预计时间内结束 / 未记录预计结束时间（无法比较）"，
    汇总行给出"超过预计结束 N 台"；前端与服务端消费同一函数（同一口径）；
  - 测试：共享契约 6 例、客户端纯逻辑 5 例、浏览器验收 2 例（偏差文案 + axe 扫描）；
    `e2e:exo-session` 扩到 **20 项**（新增 8/8a 偏差事实、9/9a/9b 指派写入边界），
    并改为**场景自足**（没有现成的 exo-lift 任务时自己造一个探针任务，不再依赖历史状态）；
- 工程质量：`make audit-regression-gates` 增加**主线11**（前端软底徽标对比度 WCAG 2.2 AA
  数值模型 + 软底文字令牌策略扫描），把上一轮的对比度回归从客户端测试提升为门禁主线；
  `/exo` 浏览器验收新增 axe 扫描（serious/critical 零违规）。

### Fixed
- **`/exo` 页面"开始会话"按钮实际不可用：裸业务 id 未规范成契约身份（2026-09-11 浏览器门禁实测）**：
  - 现象：新写的浏览器用例点下"开始会话"后，请求体里是
    `{"exoId":"EXO-1","personId":"P-1001"}`——设备下拉用的是 `ewoh_device.device_id`，
    人员下拉用的是裸 uuid；而 ADR-006/ADR-032 要求会话写入必须是**规范身份**
    （`device:<id>` / `person:<uuid>`），服务端 fail-closed → 现场点这个按钮必然
    400 `bad_exo_identity`；
  - 为什么会漏：此前 `/exo` 的浏览器用例只覆盖"结束/中止/排序/告警"，**从没点过开始**，
    真实会话全部由 e2e 脚本用规范身份直接调 API 创建；
  - 修法：新增纯函数 `canonicalExoIdentity`（`client/src/lib/exoIdentity.ts`，
    与 `lib/http` 解耦以便单测）：裸 id 补 `device:`/`person:` 前缀；已带任意 `kind:`
    前缀的原样保留（前缀写错是调用方的声明错误，交给服务端 fail-closed，不在客户端
    悄悄改写）；空值原样（必填校验在页面与服务端）。`api/exo.ts` 的 `startExoSession`
    统一过这一层；
  - 回归：新增 `client/src/lib/exoIdentity.test.ts`（4 例）+ 浏览器用例断言请求体为
    `device:EXO-1` / `person:P-1001`；顺带修掉该 spec 里 personnel 端点 mock 路径写错
    （`/api/organization/personnel` → 真实 `/api/personnel`，此前页面拿不到人员列表）。

- **2026-09-11 全量验证暴露的三处「门禁/夹具」缺陷（产品行为未变，观测与选材修好）**：
  - **学习控制台「复盘 · 运行记忆」的方案 ID 输入框缺可访问名称**：只写了
    `placeholder`，屏幕阅读器与 `collectA11yIssues`（17 个浏览器 spec 共用）都读不到
    标签 → 全量 mock 套件 1 例红。补 `aria-label`（placeholder 不是标签，这是
    WCAG 4.1.2/3.3.2 的常见断点）。该输入框是条件渲染的，只有"无真实回执"这一状态
    才出现，所以此前单跑没抓到；
  - **UX-009 mock 夹具缺应用外壳端点默认桩**：顶栏待办收件箱/组织切换器会**无条件**
    请求 `GET /api/organization`、`GET /api/scheduler/active-plans`、
    `GET /api/dashboard/events`，夹具没 mock 就 404 → 浏览器打印 console error →
    `ux009-visual-gate` 的指挥中心/移动工作台两道视觉门禁（5 个浏览器项目 ×2）
    集体变红。现在夹具给这三个端点默认桩（组织列表与注入会话的 `orgId` 一致；
    若默认空数组会让"当前组织"解析不到，实测 200% 缩放用例因此 h1 不渲染），
    需要特定数据的 spec 仍用同名 key 覆盖；
  - **`capability-disabled-plan-explain` 选材不稳**：原来取"设备列表里第一个非
    `observe.*` 能力"，一旦落在中风险能力（`exo-lite`/`vacuum`）上，"无审批恢复"
    本就不该 409 → 7 项高风险闸门断言误报失败。改为**优先选高风险执行能力**
    （`exo-lift`/`crane`/`interact.assist`），确无高风险能力时显式 SKIP 并说明；
  - 顺带修好 e2e 的**失败诊断**：五个脚本此前把登录失败一律写成"缺少
    `EWOH_E2E_ADMIN_PASS`"——实测把 503「认证存储不可用」误报成环境变量没设，
    浪费排查时间。现在如实回报 `HTTP <status> + 服务端 message/code`。

- **2026-09-11 闭环收口批次（学习标注面 / 运行记忆可读性 / 迁移链幂等）**：
  - **结果标注判定人可伪造（完整性缺陷）**：`POST /api/learning/annotations` 此前
    把请求体原样透传，`judgedBy` 是客户端断言——标注是学习回路的真值来源，
    判定人可被冒名。修复后判定人一律取服务端会话 `userContext.userId`
    （与 learning-proposal.proposedBy 同一 B5 标准），缺失即 400 fail-closed，
    请求体携带的值被忽略并覆盖（已用真实后端验证：伪造 `person:impostor`
    落库为会话身份 `admin`）；新增控制器级回归测试
    `outcome-annotation.controller.spec.ts`；
  - **系统审计事件混入"现场异常"注意力列表**：`OutcomeAnnotationRecorded`、
    `SimulationRun*` 等学习/仿真台账事件曾与真实风险事件并列展示为"现场异常"，
    违反状态明确区分原则。`/api/dashboard/events` 投影补 `sourceType`，
    FactoryOperations 注意力列表三分：现场异常（≤4）/ 调度决策（≤4）/
    系统记录（≤2，尾部分组，"系统审计记录（非现场异常）· 查看台账详情"），
    学习/仿真来源显示"学习台账/仿真记录"而非"来源未提供"；
  - **执行回执与现场作业台的 raw UUID**：执行记录本体只存 ID，班组长/调度员
    此前直接看到 `任务 65000000-… / 人员 63000000-…`。`GET /api/scheduler/executions`
    按当前页 distinct ID 批量回填 `taskTitle`（ewoh_production_task）与
    `personName`（ewoh_personnel），解析不到如实为 null（UI 显示"未知"，不回退
    显示 ID、不伪造）；`field/my-work` 增加 `personName`（db 直查优先，
    回填值兜底），现场身份卡显示"张伟（63000000-…）"；
  - **上下文栏组织显示 raw UUID**：ContextBar 经 `GET /api/organization`
    解析组织名（失败退回 UUID，不阻塞渲染）；
  - **迁移链不可重跑（两处，破坏一键启动与全新安装验证）**：
    · `standalone_002_users` 三个 SECURITY DEFINER 函数改为"不存在才创建"——
      `standalone_072` 以 6 列形态（+person_id）重建 `ewoh_find_active_user`，
      PostgreSQL 不允许 CREATE OR REPLACE 改返回类型，已应用 072 的库上重跑
      002 必失败（fresh scratch 库全链 apply×2 + verify 27/27 验证通过）；
    · `standalone_009` 验证改为同时接受最终形态（`standalone_022` 的
      `..._person_device` EXCLUDE）——全新安装上 009 先于 017（建表）执行被
      to_regclass 守卫跳过，旧验证只认旧约束名导致 fresh install 恒 FAIL；
  - **namespaces 死配置**：`API_NAMESPACES.workstation`（/api/workstation）与
    `eventRule`（/api/event-rules）服务端从未提供对应 controller，删除以免
    误导后续开发；
  - **测试可重复性**：`execution-receipt-closed-loop.mjs` 的"本人可回执"步骤
    按执行状态选择动作（PLANNED→START / STARTED→COMPLETED），不再对已 START
    记录重发冲突事实（服务端以 RECEIPT_FEEDBACK_FACT_CONFLICT 正确拒绝——
    是脚本跨轮重跑不健壮，不是业务缺陷）。

### Added
- **2026-09-11 一键本地启动与结果标注用户面**：
  - `make local-up`（`scripts/local-up.sh`）：PG(docker:55432) + 迁移链校验 +
    种子 + 三账号（admin / approver.li / worker.zhangwei，B5 审批独立性 +
    账号↔人员绑定）+ standalone 构建 + 启动，幂等可重复；支持
    `REBUILD_DB=1`（重建库）/ `SKIP_BUILD=1` / `NO_SERVER=1`。启动脚本显式在
    `ewoh-spark-app` 目录内拉起服务——standalone-main 以 `process.cwd()` 解析
    `dist/client`，从仓库根启动会导致 SPA 全部 404（实测踩坑）；
  - 学习控制台新增「结果标注（运行记忆的真值来源）」面板：对象类型
    （plan/decision/proposal/agent_command）+ 目标编号 + 结果判定
    （success/partial_success/failure/invalid）+ 可选 key=value 度量快照 +
    备注，判定人由服务端会话推导并在页面说明"不可代他人标注"；最近标注
    列表如实展示判定/时间/判定人/度量，空态说明"模型准确率只能显示未标注"；
  - 客户端 `api/learning.ts` 补齐标注三 API 与 `getLatestEvaluation`
    （400 learning_evaluation_not_found 归一化为 null，不当作异常）。

### Fixed

- **软底徽标对比度缺陷：axe color-contrast 偶发 serious（4.16:1）的静止态 + 过渡态双根因**：
  - 现象：`e2e:check`（UX-009，reduced-motion 单 worker）**偶发** 1 例
    `color-contrast(serious)`：`.bg-risk-normal/20 > .font-semibold`（新鲜度徽标"实时"），
    fg `#ed6e0c` / bg `#442d1e` / 4.16:1；同一用例单跑必过、全量跑偶发失败。
    CDP `CSS.getMatchedStylesForNode` 显示该元素只有一条 `color` 规则且
    `--risk-normal-foreground` 解析为 `#89dc97`，静态级联无法解释 → 逐层探针定位到
    **两层独立缺陷**；
  - **静止态缺陷（真实可达）**：`bg-warning/20 text-warning`（新鲜度 `STALE`）与
    `bg-info/20 text-info`（`SHADOW`/`RESYNCING`）在恒深表面
    （`data-inverse-surface`，Command Map 全屏壳）上天然不达标——实测
    warning/20 = **4.16:1**、info/20 与 primary/20 = **2.70:1**（WCAG 2.2 AA 要求
    ≥ 4.5:1，9px 粗体不属于大字号例外）。旧设计只给 destructive 做了软底专配前景色，
    warning/info/primary 漏掉了；
  - **过渡态缺陷（假失败放大器）**：reduced-motion 全局规则只把 `transition-duration`
    压到 `0.01ms !important`，而 `transition-property` 仍是初始值 `all` → 每次色调
    变化（无证据 `STALE` → 数据到达 `LIVE`）都会生成一条 CSSTransition；帧饥饿时
    `page.getAnimations()` 可见 `currentTime: 0 / playState: running` 持续数百毫秒，
    `getComputedStyle` 因此返回**上一种色调**的颜色，axe 采样到的正是"过期橙"叠在
    软底上。这不只是测试问题：界面在这段时间里显示的是**已经不成立的事实**；
  - **修复**：
    · `tokens.css` 新增 `--warning-on-soft` / `--info-on-soft` / `--primary-on-soft`
      （亮色 `:root` 取深色、`[data-theme="dark"]` 与 `[data-inverse-surface]` 取提亮色，
      经 `@theme inline` 暴露为 `text-*-on-soft`），与既有 `--destructive-on-soft`
      同一策略：**软底上的文字一律走 `-foreground` / `-on-soft`**；实测亮色/深色两张
      表面上全部 ≥ 4.5:1（深色 5.92–7.92:1、亮色 5.59–8.04:1）；
    · `FRESHNESS_STATUS_CLASSES` 的 `STALE`/`SHADOW`/`RESYNCING` 以及
      `DataSourceBadge`、`OnlineStatusBadge`、`SolverStatusChain`、
      `CommandMapShell` 主色胶囊、`PageDutyHeader` 一次性收敛到 on-soft 令牌；
    · `DataFreshnessBadge` 增加 `[transition-property:none]`：色调是事实指示，必须
      **立即生效**，不允许把上一种色调当现状展示；
  - **回归测试**：新增 `client/src/lib/softSurfaceContrast.test.ts`（17 例）——
    颜色模型对历史组合复算 **4.16**（与 axe 报告一致，锁定口径不漂移）、9 个新鲜度
    色调 + 6 个数据来源徽标在**亮色与深色两张表面**上逐项断言 ≥ 4.5:1、
    "软底文字必须是 `*-foreground`/`*-on-soft`"、以及源码级策略扫描
    （禁止同一类名串里出现 `bg-<主色>` + `text-<主色>`）；
    `ux009-command-map-axe.spec.js` 新增 1 例：断言新鲜度行每个徽标
    `transition-property === 'none'` 且 `color-contrast` 规则零违规（该文件 6 例全绿）；
  - 文档：`docs/design/ui-design-system.md` 第 4.1 节把"禁止主色作软底文字"从
    risk 色板扩展到 warning/info/primary，并记录"色调徽标禁用颜色过渡"的口径。

### Added
- **佩戴中的外骨骼 = 派工硬约束：会话事实进世界模型（NO-34a，原则 3/7/8）**：
  - 缺口：上一轮让现场能开始/结束会话了，但**调度完全不知道**有会话——一台正在被
    张伟佩戴的外骨骼，照样会被派给李伟的任务。这在物理上不可能（一台设备同时只能
    一个人穿戴），属于统一世界模型缺的一类事实；
  - **世界模型**：快照设备项新增 `activeExoSession: {sessionId, personId, startedAt} | null`
    （资源投影按 `device:<业务设备号>` 规范身份与 `ewoh_device.device_id` 显式 join；
    无会话 → null，终态会话不算佩戴中，形状不符的会话**忽略而不猜**）；
  - **资格判定**：设备存在活跃会话 → 拒绝普通派工，新增拒绝原因
    **`device_in_active_session`（"设备正在外骨骼会话中（已绑定佩戴人员）"）**——
    写进封闭词表 `CANDIDATE_REJECT_REASONS`（缺文案会编译失败，现场不会看到裸键）；
  - 边界说明写在代码与文档里：要解除约束，要么结束会话，要么把任务交给正在佩戴的人
    （当前候选模型不支持"指定佩戴者"配对，因此一律拒绝并说明，而不是猜一个人）；
  - 测试：候选引擎 3 例（有会话被拒/无会话不误拒/文案可得）、
    **e2e:exo-session 扩到 14 项**：真实后端验证"活跃会话进入快照并带佩戴人"
    → "佩戴中的外骨骼在候选里被拒且原因含 `device_in_active_session`"
    → "结束会话后约束解除、不残留假封锁"；
  - 修复连带缺陷：无租户上下文的投影路径（测试替身）不支持无条件 `.where` →
    会话查询与其它三条同构（有 ctx 才加 where，无 ctx 时状态过滤退到内存）。
- **外骨骼作业台：会话闭环的产品面（NO-33a，原则 1/2/3/10）**：
  - 缺口：后端会话 API（ADR-032/033）与客户端封装（`client/src/api/exo.ts`）早已存在，
    但**没有任何页面消费**——现场看不到自己外骨骼的会话状态，班组长也判断不了
    "谁还戴着没交回"。"外骨骼是工厂的感知与人机交互层"在**产品层**是断的；
  - 新增 `/exo`「外骨骼作业台」（worker / workshop_lead / dispatcher / device_ops / global_admin）：
    · 「开始会话」：选设备（台账里 `exoskeleton` 类别，无设备时明说"不会凭空造设备"）+
      选人员 + 可选预计结束；两个下拉都为空时按钮禁用并说明原因（绑定是显式事实，不猜）；
    · 会话列表：**进行中优先、同进行中按时长最长优先**（最可能出问题的排前面），
      显示起止时间、已进行/持续时长、预计结束、结束人、理由；
    · **长时间未收工告警**：进行中且 ≥4 小时 → "请核实是否忘记收工"（人走了会话还开着会
      占住设备并让后续派工判定失真）；终态即使超过 4 小时也不告警（已经收工）；
    · 「结束会话」走正常收工；「中止」必须写理由（结束事实完整），终态不可复开；
    · 页面明确声明边界：**平台只管理会话绑定，不下发关节/力矩/助力/限速指令**；
  - 修复一个真实缺陷（e2e 抓到）：同一台外骨骼的第二个活跃会话返回 **500** 而不是显式冲突——
    drizzle 的 `db.transaction` 会把驱动错误包一层，只查顶层 `err.code` 漏判 23505。
    新增 `extractPgErrorCode`（沿 `cause` 链、深度有界）并补回归测试；
  - 测试：纯逻辑 12 例（时长三态/告警阈值/终态不告警/时间非法未知/缺口如实/排序/汇总/中止理由）、
    浏览器 4 例（长会话告警与排序、结束端点、中止必须写理由、空态与不造设备）、
    **新增真实后端 e2e 场景 `e2e:exo-session` 11 项**（开始 → 活跃冲突显式 →
    结束需 endedBy → 正常结束 → 幂等 → 终态不可复开 → 中止留理由 → 历史保留两类终态）。
- **通知支持"点名到人"：授权到期提醒同时发给发起人（NO-32a，原则 1/5/8）**：
  - 缺口：NO-30a 的到期提醒**只投给 `safety_admin` 角色**，而发起人（正在等这张授权
    的人，往往只是调度员/班组长）**收不到任何提醒**——通知写了却永远读不到；
  - 读取面扩展（`resolveNotificationScope` 纯函数）：`global_admin → all`（仍受 org 过滤）、
    有角色 → `role+user`（角色通知 ∪ **点名给自己**的通知）、只有用户 id → `user`、
    都没有 → `none`（fail-closed）；安全边界只放宽到**调用者自己的 id**，他人通知依旧不可见；
    角色列表去重（单值 `role` 与 `roles` 数组合并）；
  - 写入面扩展（到期扫描）：每个授权在原有 `safety_admin` 角色通知之外，再给
    **发起人本人**写一条（`recipientType='user'`，标题标注"（你发起的）"），
    确定性 id 带收件人（`NTF-EXPR-<审批号>-<桶>-user-<who>-<渠道>`），幂等语义不变；
    发起人缺失或为 `system` 时不写（不凭空造收件人）；
  - 测试：范围解析纯函数 6 例（四种分支 + 去重 + 空白剔除）、到期服务用例更新为
    "双收件人 + 幂等 duplicates=2"，**e2e:approval-expiry 扩到 16 项**：
    真实后端验证"发起人本人收到并看到'你发起的'""第三方用户看不到该提醒（不串号）"。
- **高危控制指令审批接入时效闸门（NO-31a，原则 4/6/8）**：
  - 缺口：`control_request`（急停/载人移动一类高危物理指令）的审批闸门只校验
    `status === 'approved'`——**一张半年前批的"同意"今天照样能放行**，而现场条件、
    人员、设备状态早已变了。能力闸门在 NO-22a 已有 24 小时时效，控制闸门却没有；
  - 抽出共享实现 `verifyApprovalFreshness`（从 `verifyApprovalFingerprint` 提取，
    控制类审批没有能力指纹但同样需要时效），控制闸门改为：状态 approved **且** 在
    **24 小时**有效期内通过；缺失通过时间同样拒绝（无法判断时效的凭证不算有效凭证）；
    超期 → **409 `APPROVAL_INVALID`** 并说明"通过于何时/有效期多久/请重新审批"；
  - 重放防护本已由控制请求状态机保证（`pending_approval → approved` 的 CAS 只能成功一次），
    本轮补的是**时窗**语义；
  - 授权视图纳入 `control_request`（`CAPABILITY_CHANGE_ENTITY_TYPES` 扩到三类）：
    高危控制审批与能力放宽/恢复一样，都是"批准一次即授予执行权力"的凭证，
    因此同样出现在审批台的授权区块并**同样享受到期主动提醒**（NO-30a 复用，零新机制）；
  - 前端实体类型标签已有 `control_request → 高危控制指令`（本轮确认无重复登记，
    由 lint 的类型检查抓出一处重复键并修掉）；
  - 测试：共享时效函数 +1 例、控制服务 +3 例（超期 409 / 缺通过时间 409 / 有效期内放行
    不误伤）、到期服务 +1 例（控制授权同样提醒且范围如实写"范围未记录"）、
    客户端标签断言 +1 行，**e2e:approval-expiry 扩到 14 项**：真实后端验证
    "控制请求联动审批进入授权视图""未批准时下发 403""批准后回拨 25 小时 → 下发 409
    APPROVAL_INVALID""过期控制授权同样生成已失效提醒"。
- **执行边界授权到期主动提醒（NO-30a，原则 5/6/8）**：
  - 缺口：NO-22a 给了授权 24 小时有效期、NO-24a 让它在审批台可见，但两者都是**被动**的
    ——没人打开审批台，就不会有人知道"这张授权 40 分钟后失效"，现场执行时才撞 409；
  - 新增 `ApprovalExpiryService`：扫描执行边界授权，剩余有效期 ≤ **2 小时** → `expiring`、
    已过期且在 **24 小时**窗口内 → `expired`；离失效还远 / 过期太久 / 待批 / 已驳回
    **都不提醒**（避免噪音与永久提醒）；
  - 提醒内容可照做：剩余时间（或失效时刻）、审批号、覆盖范围（能力 + 台数）、
    发起人、已消耗对象数，以及"如需在有效期内执行请尽快处理 / 已不可用需重新申请"；
    收件人是**有权重新审批的** `safety_admin` 角色；
  - **幂等**：通知 id 由 `(审批号, 桶, 渠道)` 确定性推导（`NTF-EXPR-…`）+
    `notification_id` 唯一约束 + `ON CONFLICT DO NOTHING`——重复扫描只增加 `duplicates`，
    不会重复打扰（不是先查后写，无竞态窗口）；渠道 app 恒发，lark/email 仅在已配置时发；
  - **定时 worker**（`ApprovalExpiryWorkerService`，默认 5 分钟，`APPROVAL_EXPIRY_WORKER_DISABLED`
    / `…_INTERVAL_MS<=0` 可关）：只扫"最近 7 天有审批实例"的租户，单租户失败留痕不影响其它；
  - 手动触发面 `POST /api/approvals/authorizations/expiry-sweep`（`safety_admin` / `global_admin`），
    返回 scanned/expiringSoon/expired/created/duplicates 逐条明细；扫描**只读**，
    绝不改变授权状态（提醒不代替人重新审批）；
  - 授权视图补充 `createdBy`（发起人），提醒正文才能指出"该找谁"；
  - 测试：服务层 9 例（分桶/窗口边界/幂等/只读/多租户逐租户失败隔离/窗口常量锁定）、
    **新增真实后端 e2e 场景 `e2e:approval-expiry` 10 项**（真回拨审批时间造出"剩余 1 小时"
    → 扫描生成提醒 → 正文可照做 → 重扫幂等 → 过期分桶 → 只读语义）；
  - 契约与门禁同步：`openapi/ewoh.yaml` + route-manifest + 生成类型（415/616 全文档化）。
- **库存精确聚合（去掉隐形窗口）+ 单位对齐守卫（NO-29a/29b，原则 5/7）**：
  - 缺口一（**静默失真**）：库存此前是"取最近 2000 条 ERP 出站事件在内存里投影"——
    超过窗口的出入库会被**静默丢掉**，库存偏大偏小都可能，而现场只看到一个确定数字。
    现在改为**在数据库侧对全部历史做精确聚合**（`sum`/`count`/`array_agg`，按物料分组）：
    `onHand`/`receipts`/`consumptions`/`movementCount`/单位集合/最近阈值及声明时间/
    最近 20 条证据事件 id 全部由 SQL 一次算出；响应新增 `aggregationComplete` +
    `aggregationNote`，**明确声明"覆盖全部历史、不截断窗口"**；无法解析的历史载荷
    另用一条 `IS NULL` 查询计数（同样不受窗口影响）；
  - 缺口二（**拿不同单位做比较**）：库存是 kg、BOM 写 件 时，此前会照样算出"缺口 45"
    ——那是编造，不是计算。现在 BOM 行可声明 `unit`（可选，但给了就必须是**非空合法字符串**，
    否则入口 400），影响面新增状态 **`unit_mismatch`（"库存与 BOM 计量单位不一致（无法比较）"）**，
    优先于缺口计算；BOM 自身出现多种单位同样不比较；
  - 前端「物料与库存」把这些状态一并计入"无法判定"，不把未知渲染成 0 或"正常"；
  - 测试：共享逻辑 +4 例（单位不一致不比较/BOM 多单位/单位一致不误报/需求侧无单位仍可比较）、
    ERP 入口 +2 例（合法单位落库/空串 400），**e2e:materials 扩到 24 项**：
    新增"聚合精确（movements=2 / 入库 1 / 领用 1）""响应声明全量聚合"
    "kg vs 件 → unit_mismatch""非法 BOM 单位 400"四步真实后端断言；
  - 无新增路由与表（库存依然是事件投影，只是不再截断）。
- **物料需求与缺口影响面 + 物料与库存页（NO-28a，原则 1/2/5/7/10）**：
  - 缺口：上一轮让库存可见了，但现场看到"低于再订货点"仍不知道该先补哪个料——
    没有**需求**，库存数字无法排序处置优先级；
  - 需求来源：**未完工 ERP 订单的 BOM**（订单事件里已有 `bom`）。关键是 BOM 数量的
    **口径必须显式声明**（`bomBasis`: per_unit 每件用量 / per_order 整单用量）——
    两者相差一个订单数量，猜错就是几倍的缺口。因此：
    · 新订单缺省按 `per_unit` 并在事件里**写明**（"这单需求怎么算的"永远可核对）；
    · 显式传入非法口径 → **400**（不静默取默认）；
    · 未声明口径的历史订单 → **不参与需求计算**，单独列出"无法计算需求"，
      而不是按某个默认值算出一个看起来很确定的错误数字；
    · 订单数量非法 / BOM 行非法 → 逐条隔离并说明（不因一条脏数据丢掉整批需求）；
  - **缺口影响面**（`buildMaterialImpact`）：需求 > 库存 → `below_demand`（"不足以覆盖
    未完工订单"，比低于再订货点更紧迫）并给出**差多少 + 受影响订单号 + 是否含逾期订单**；
    需求可覆盖但低于再订货点 → `below_threshold`；未声明阈值 → `no_threshold`；
    单位不一致 → `mixed_units`；只有需求没有出入库记录 → `库存未知`（不是 0，也不假装短缺）；
  - **前端 `/materials` 物料与库存页**（调度员/班组长/设备运维/全局管理员）：余额表
    （现有量/再订货点/未完工需求/缺口/状态/影响面）+ 未纳入需求计算的订单 +
    历史不可解析载荷 + 来源与扫描量；读取失败**显式报错**且不再停在"加载中…"，
    空数据明说"不会凭空生成物料"；
  - 测试：共享逻辑 +12 例（per_unit/per_order/口径未声明不计算/脏数据隔离/逾期标记/
    五态影响面/未知不等于 0）、ERP 订单口径 3 例（缺省写明/显式接受/非法 400）、
    浏览器 3 例（缺口与影响面、空态、失败态），**e2e:materials 扩到 20 项**
    （订单 BOM → 需求 60、缺口 45、below_demand、逾期标记、非法口径 400）；
  - 无新增路由（复用 `/api/materials/inventory`），route-manifest 保持 414/615 一致。
- **物料流动契约 + 库存投影：让 `rule:material-shortage` 真正可用（NO-27a，原则 2/3/5/7/13）**：
  - 缺口：物料短缺规则早已在推理引擎注册，但**没有事实来源**——世界模型没有库存列、
    仓库里没有物料台账；而工厂里唯一权威的物料流动事实（ERP 出站 `inventory_receipt`
    入库 / `material_consumption` 领用）此前只是自由格式 `payload`，没有任何契约；
  - **给物料流动一个契约**（`shared/material-inventory.ts`）：数量必须为正有限数
    （缺失/非法 → 逐条错误，不做 `Number(null)=0` 的静默伪造）；`unit` 可选但
    **单位不一致不求和**（把 kg 与 件 加起来是伪造）；入库可声明 `minThreshold`
    （ERP 再订货点）；
  - **写路径 fail-closed 且不破坏历史**：ERP 出站里合法物料载荷 → 规范化写入
    `evidence.materialMovement`；**完全不含物料字段的历史载荷** → 放行但显式标注
    `materialMovementParse='legacy'`；含物料字段却形状非法 → **400**（宁可拒绝也不写脏事实）；
  - **库存 = 入库 − 领用**（`GET /api/materials/inventory`，零新表：从出站事件投影）：
    每物料给出 `onHand`/`unit`/`minThreshold`（取最近一次声明）/`receipts`/`consumptions`/
    `lastMovementAt`/`negative`（领用多于入库如实标记为负，不当 0）/`mixedUnits`/
    **`evidenceIds`（可追到具体单据）**；历史不可解析载荷单列 `unparsable`；
  - **推理接线**：`collectMaterialFacts` 只在"有库存记录**且**声明了再订货点"时产出
    `material:<id>` 事实（`inventory`/`minThreshold`/`negativeOnHand`）——**没有阈值不判定
    短缺**（`no_threshold`），绝不拿编造的默认值报警；物料投影失败**降级可见**
    （`material_projection_failed`）且不牵连无关结论（如振动风险照常产出）；
  - 证据链使用注册表内的 `event:` 身份（自造 kind 会被推理契约 fail-closed 拒绝——
    本轮又一次踩到并被测试挡住）；
  - 测试：共享契约/投影 14 例（解析三态/负库存/多单位/无阈值/证据规范化）、
    ERP 写路径 4 例（合法规范化/legacy 放行/非法 400 不写库/非物料类型不受影响）、
    推理服务 +3 例（短缺结论/无阈值与不可解析可见/投影失败降级不牵连）、前端原因文案 +3 条，
    **新增真实后端 e2e 场景 `e2e:materials` 15 项**（入库→领用→非法 400→legacy→
    库存 100−85=15 与证据→无阈值可见→实时评估产出物料短缺结论）；
  - 契约与门禁同步：`openapi/ewoh.yaml` 两条新路由 + route-manifest + 生成类型
    （414/615 全文档化、0 未实现）。
- **ERP/MES/WMS 能力主数据导入适配器（NO-26a，原则 1/4/5/7/8）**：
  - 缺口：设备"能做什么"此前只有两条来源——自动化摄入（按类别推导）与人工单点登记；
    真实工厂这份清单在 **ERP/MES 主数据**里，现场既不可能逐台手点，也不该让外部系统
    直接写库。这是"真实数据接入适配接口"交付项里缺的一块；
  - 新增 `POST /api/master-data/capabilities/import`（角色 `device_ops` / `global_admin`）：
    · **来源封闭注册表**（erp/mes/wms/manual_file）+ `sourceRef` 必填 → 未知来源/缺批次号
      直接 400，防止"有人手工伪造 ERP 行"；单次 ≤ 500 条；
    · **词表 fail-closed**：能力名必须在契约词表内，词表外拒绝写入并给出"疑似笔误：
      是否指 X？"（复用共享的相似度实现）；
    · **只写本租户已有设备**（外部系统不能凭空造设备）；
    · **人工停用永远优先**：设备能力被人为停用后，导入**不会**复活它，而是返回
      `skipped_human_disabled` 并回报"谁/何时/为何停用"，汇总里明确"主数据不得覆盖
      人工安全决定"（原则 4/7）；
    · **幂等**：同一 `source+sourceRef` 重复导入 → `unchanged`（不重复写、不重复审计）；
    · **dry-run**（`?dryRun=1`）：完整跑校验与冲突判定但不写库，先看影响面；
    · **非阻断一致性提示**：声明超出设备类别标准能力集（如给摄像头声明 vacuum）仍写入，
      但逐行与汇总都提示核对主数据；
    · **逐行结果按输入顺序返回**（对接方可与源文件对齐）；台账行写入
      `provenance{channel,source,sourceRef,importedAt,importedBy}`，可回答"这行从哪来"；
    · **全过程审计**（含 dry-run 预览，明确标注 `dryRun`）；
  - 测试：服务层 13 例（输入 fail-closed/新声明写来源/人工停用不复活/笔误与未知设备/
    幂等 unchanged/跨来源 updated 且不动 status/字段映射/dry-run 不写库/类别一致性提示）、
    **新增真实后端 e2e 场景 `e2e:master-data` 15 项**（dry-run 不改库 → apply 逐行 →
    台账来源可追溯 → 重复导入 unchanged → 人工停用后导入被跳过且状态保持 disabled →
    审计含预览）；
  - 契约与门禁同步：`openapi/ewoh.yaml` + route-manifest + 生成类型（412/611 全文档化）。
- **修复：负 `worldVersion` 让"实时评估"整条链路 400（NO-25a 回归修复）**：
  `worldVersion` 是 32 位哈希（**可能为负**），而推理契约要求 `snapshotVersion` 为非负
  整数——负值时 `POST /api/reasoning/evaluate-live` 直接 400，而 `GET /api/reasoning/live-facts`
  仍是 200（只读视图不校验该字段），问题因此藏得很深，表现为"评估时好时坏"。
  现在做**同一数值的无符号重解释**（`>>> 0`：确定性、双射、不编造新数值），
  非整数/缺失一律 0（表示无版本信息）；补回归测试（负值 → 无符号且结论正常产出）。
- **观测 → 推理：把"感知到的事实"接进确定性预测（NO-25a，原则 2/3/5/7/13）**：
  - 缺口：推理引擎（ADR-020）注册了 `rule:machine-vibration-risk` 等六条规则，但
    **生产路径没有人供给事实**——规则只有手工 POST facts 才会触发；而观测能力
    （`observe.vibration` 等）的读数早已落进 `ewoh_environment`。"感知"与
    "理解/预测"之间缺了一环，等于买了传感器却没有判断；
  - 新增 `shared/observation-facts.ts`（纯投影，确定性、无 LLM）：把**环境读数**投影成
    机器类事实（振动超标），把**世界模型列**投影成资源类事实（人员负荷/外骨骼电量/
    工位质量阻塞/未处置高等级告警）。六道闸全部通过才产出事实：有值 → 超阈值 →
    **新鲜**（15 分钟窗口）→ **可信**（`data_confidence` ≥ 0.5）→ 能映射到世界模型对象 →
    该设备**声明了**对应观测能力（能力模型权威）；任何一步不通过都进 `skipped`
    并写明原因，绝不"凑一个事实"（原则 7）；
  - 阈值显式且随结论返回：振动 7.1 mm/s（ISO 10816 类 II 的"不可接受"线）；温度/噪声/
    空气质量**当前不产出事实**——本仓库没有与之匹配的已注册规则，凭空造一条"温度风险"
    属于"注册了没有确定性引擎的类型"，明确不做；
  - 新增 `POST /api/reasoning/evaluate-live`（从权威世界模型快照 + 最近观测读数评估，
    走与 `evaluate` 完全相同的规则引擎与 L4 台账落账路径）与 `GET /api/reasoning/live-facts`
    （只读投影，不评估不落账）；响应同时给出**依据**（数值/阈值/单位/观测时间/数据质量/
    来源）与**未采用数据**（原因可读），现场能回答"这个风险为什么出现"和
    "我明明看到超标为什么没报警"；
  - 前端新增 `/reasoning` 实时风险页（调度与执行分组，角色 dispatcher/workshop_lead/
    safety_admin/global_admin）：区分「立即评估」（真正跑规则并落台账，人工触发）
    与「查看事实」（只读，不落账）；结论按严重度排序 + 依据摘要 + 台账 id +
    未采用数据清单 + 生效阈值与来源时间；
  - 测试：投影纯函数 13 例（新鲜/过期/低置信/未知对象/未声明能力/多帧合并/阈值覆盖/
    资源类事实缺值不猜 0）、服务层 6 例（实时评估结论与依据、低置信被拒、缺 org 400、
    无事实不抛错、只读不落账）、前端纯逻辑 7 例、浏览器 3 例（命中+依据+未采用数据+
    台账 id；只读视图不评估；全空也说清楚）、**新增真实后端 e2e 场景
    `e2e:observation-reasoning` 12 项**（摄入 → 实时评估 → 证据/阈值/台账 →
    低置信被拒 → 只读视图不落账）；
  - 契约与门禁同步：`openapi/ewoh.yaml` 新增两条路由（411/610 全文档化、0 未实现），
    route-manifest 与生成类型同步；新浏览器用例纳入 `test:browser:mock` 门禁。
- **执行边界授权视图：有效期与用量可见（NO-24a，原则 5/6/7）**：
  - 缺口：NO-22a 之后"已授权"是**有时效（24 小时）、会被逐台消耗**的凭证，但审批台
    只列**待批**清单——"已通过但已过期"在界面上完全不可见，只有现场真去执行时才会
    撞到 409；同一张批量审批已经用在哪几台设备上也查不到；
  - 新增 `GET /api/approvals/authorizations`（org 作用域，无新表）：列出
    `device_capability_change` / `task_capability_change` 两类授权，含
    `status` / `approvedAt` / `expiresAt` / `expired` / `remainingMs` / 对象描述符快照
    （指纹 metrics）与**消耗明细**（按 `causation_id` 归组的 `approval_usage` 事件行：
    哪个对象、谁、何时、什么理由）；
  - 语义：只有 `approved` 才有"通过时间"（未通过不伪造时效）；已过期授权**保留并标记
    expired**而不是消失（现场要能看到"我有过一张授权，但它失效了"）；排序为
    "最快过期 → 有效 → 已过期 → 待批/终态"，与闸门口径一致；
  - 客户端审批台新增「执行边界授权」区块：状态标签区分 **有效 / 即将过期（2 小时内）/
    已过期（不可用）/ 待审批（不可用）/ 已驳回**，显示剩余有效期与"已消耗 N 个对象"
    的逐条明细（谁/何时/备注），读取失败显式报错而不是静默显示为空；
  - 实体类型标签补齐 `task_capability_change`（任务能力放宽）与
    `device_capability_change`（设备能力恢复）——此前会把原始 entityType 直接甩到界面上；
  - 契约与门禁同步：`openapi/ewoh.yaml` 新增该路由（409/607 全文档化、0 未实现），
    `openapi/route-manifest.json` 与生成类型同步重生成；
  - 测试：审批持久化新增 7 例（时效投影/过期标记/未通过不伪造时效/消耗归组/排序/
    缺租户 400/空结果）、客户端纯逻辑新增 6 例（状态分级与汇总、范围与用量渲染、
    任务侧范围、空指纹如实写"未记录"）、浏览器新增 3 例（有效显示剩余、已过期标注
    不可用、空态与读取失败）；`e2e:capability-explain` 扩到 **28 项**：7f 实时核对
    授权视图（`remainingMs>0`、失效时间 = 通过时间 + 24 小时、已用对象逐条可查）、
    7g 被回拨 25 小时的审批在视图里如实 `expired=true`。
- **批量恢复设备能力：一次检修 → 一张审批 → 逐台带号落地（NO-23a，原则 1/6/10）**：
  - 缺口：后端（NO-21a）已支持"一张审批覆盖一批设备"，但界面只有**单台**路径——
    同一批外骨骼/吊具检修完，现场要开 N 次抽屉、填 N 次理由、申请 N 次审批；
    结果是"能少恢复一台就少一台"，设备被悄悄永久排除在派工之外；
  - 新增设备页「批量恢复能力」入口 + 批量对话框：从**世界模型快照**
    （`GET /api/scheduler/snapshot` 的 `disabledCapabilities` + 停用留痕）聚合出
    "被人为停用"的能力批次，高风险批次（crane/exo-lift/interact.assist/forklift）
    排前、同批内**停用最久优先**（避免长期停用被遗忘）；设备默认全选，逐台显示
    「谁/何时/为什么停用 + 已停用天数 + 数据质量」；
  - 高风险批次：对话框内直接申请一张覆盖**选中名单**的审批（指纹 = 排序后的
    `deviceIds`，与设备抽屉/服务端同一 shared 实现）、显示审批状态与剩余有效期，
    未获批时执行按钮禁用（前端不做放行判定）；低/中风险批次不需审批，直接恢复；
  - 选择是**显式**的：默认全选只发生在"切换批次"时（依赖键是能力名，快照刷新不会
    把现场取消的勾选又变回全选）；取消全部勾选 → 明确提示"本次不会恢复任何设备"，
    而不是悄悄回退成全选；审批覆盖名单与当前选择不一致 → 拦下并说明差在哪
    （批 A 恢复 B 会被服务端逐台拒绝，现场只会看到一串看不懂的失败）；
    审批单未携带对象描述时如实提示"未能读到覆盖名单，执行时由服务端逐台核对"；
  - 执行结果逐台列出并**如实区分三态**：全部成功 / 部分成功（成功 N 台、失败 M 台）/
    全部失败；失败项给出可照做的原因（无审批 / 已过期 / 已消耗 / 服务端并发冲突…），
    并明确"失败项未消耗审批额度，可直接重试"（服务端消耗与写入同事务），
    提供「重试失败项」；
  - 数据缺口不静默：缺业务设备号的停用项单独计数并提示"无法通过状态接口恢复，
    需先补登"；快照读取失败显式报错并可重试；
  - 测试：批量纯逻辑 9 例（分组/排序/缺口计数/三态汇总/失败文案/指纹排序）+
    浏览器 1 例（聚合 → 默认全选 → 审批指纹 `EXO-1,EXO-2` → 逐台带号恢复 →
    部分成功文案与失败原因可见 → 重试入口；含"取消全选不回退""选择变了拦下"两段
    反向断言），client jest 153→154 suites、1436→1451 tests。
- **执行边界授权有时效、且一次现场决定只放行一次（NO-22a，原则 4/6/7/8）**：
  - 缺口：上一轮把设备侧恢复接进审批闸门，但**审批号本身是永久通行证**——
    "上个月批的那次检修"今天照样能把 crane/exo-lift 放回可用集；而且同一张批量审批
    可以被反复使用（设备再次因新故障停用后，旧审批仍然"有效"）；
  - 时效：审批实例投影新增 `approvedAt`（= 实例行最后写入时刻，即最后一步放行时间，
    步骤另带 `decidedAt`）；`verifyApprovalFingerprint` 增加**有效期 24 小时**
    校验（`CAPABILITY_APPROVAL_VALIDITY_MS`）：超期 → 409 并说明"通过于何时 / 有效期
    多久 / 现场条件可能已变化，请重新审批"；**缺少或无法解析通过时间同样拒绝**
    （无法判断时效的凭证不得被当成有效凭证，原则 7）；
  - 消耗：新增 `ApprovalPersistenceService.claimUsage`——消耗记录写成
    `ewoh_event` 行，`event_id = approval_usage:<审批号>:<消耗键>`，靠既有
    **event_id 唯一约束**保证"一次授权只能被同一对象消耗一次"（不是先查后写，
    没有竞态窗口）；重复使用 → 409 `APPROVAL_ALREADY_CONSUMED`，并回读
    "谁在何时因何用过"如实告知；批量审批仍可逐台落地（每台各消耗一次）；
  - **原子性**：消耗与业务写入（能力台账 / 任务要求）在**同一事务**内——
    写失败则消耗回滚，不会出现"审批被烧掉但什么都没做"的假消耗；
  - 顺序修正：幂等 no-op 判定移到闸门**之前**——重复点击/网络重试不再白烧一次授权
    （什么都没做就不需要授权，语义也更准确）；
  - 审计留痕：`device.capability.restore` / `task.requirements.update` 的 metadata
    增记 `approvalApprovedAt` / `approvalExpiresAt`，事后可核对"这次放行是否在时效内"；
  - 前端：审批状态旁显示**剩余有效期**（`capability-restore-approval-freshness`），
    并把三类拒绝翻译成不同的下一步（去申请 / 必须重新申请 / 重新申请），
    过期或已消耗时自动清空审批号输入（避免现场反复用同一个号撞墙）；任务侧
    （指挥地图候选面板）同样显示时效（`task-capability-approval-freshness`），
    两处共用 `shared` 的同一实现，避免口径漂移；
  - 测试：shared 5 例（24 小时边界 23h/25h、缺时间拒绝、消耗键形状）、审批持久化
    6 例（approvedAt/decidedAt 投影 + claimUsage 首次/重复/非法键/事务连接）、
    设备侧 5 例（过期/缺时间/已消耗/no-op 先于闸门/审计留痕）、任务侧 4 例；
    `e2e:capability-explain` 扩到 **26 项**：7c 真造一张"25 小时前通过"的审批
    （DB 回拨 `_updated_at`）验证过期被拒、7d 复用已消耗审批被拒、
    7e 重新申请后正常放行（证明闸门不堵死合法流程）。
- **统一执行边界授权：设备侧"恢复高风险能力"也走审批闸门（NO-21a/21b，原则 3/4/6/8/13）**：
  - 缺口：上一轮只把**任务侧**的能力要求变更接进审批（NO-20a），但执行边界还有另一半——
    `POST /api/devices/:id/capabilities/:key/status` 的**恢复**动作。人工停用是收紧（现场
    自己就能做），而"恢复 exo-lift / crane / interact.assist / forklift"等于让设备重新
    具备高风险作业资格，现场（班组长/设备员）却能单方面放行——同一类决定，两条口径；
  - 现在：恢复**高风险**能力（`deviceCapabilityChangeNeedsApproval`：目标 active +
    原状态非 active + `capabilityRisk=high`）必须有已获批审批：
    · 无审批号 → **409 `HIGH_RISK_CAPABILITY_RESTORE_REQUIRES_APPROVAL`**，响应内直接给出
      可照做的审批请求（`entityType:'device_capability_change'`、
      `entityId:'capability:<能力名>'`、`subject` 含排序后的 `deviceIds` 指纹）；
    · 带审批号 → 核对**审批已通过**（无未完成步骤）、**对象是 `capability:<能力名>`**、
      **本设备在获批名单内**；任一不符 → 409 `APPROVAL_INVALID` 并说明差在哪；
    · **一次审批可授权一批设备**（`metrics.deviceIds` 逗号列表，逐字比对指纹）——
      贴合"这批设备检修完统一放行"的现场作业，而不是逼现场逐台开单；
  - 复用既有审批模块（零新表）：`APPROVAL_ROLE_POLICY` 新增
    `device_capability_change: ['safety_admin']`；发起人回避（403）与 global_admin
    代安全角色沿用既有职责分离规则；
  - fail-honest 修复（实测抓到）：`DashboardModule` 漏 `import ApprovalModule`，
    `@Optional()` 静默注入 `undefined`，导致**真实存在且已通过**的审批被判成
    `APPROVAL_INVALID`（运维会去排查一张并不缺的审批单）。现在显式装配，且"端口缺失"
    单独报 **503 `APPROVAL_PORT_UNAVAILABLE`**（既不静默放行、也不谎报审批不存在），
    任务侧同样处理；两条回归测试钉死（模块 imports + 503 语义）；
  - 前端（NO-21b）：设备抽屉的能力对话框在**打开时**就告知高风险恢复需安全审批
    （不是等点了才被拒），提供「申请安全审批」（带变更理由构造同一指纹，shared 实现
    与后端同源）+「审批号」输入 +「刷新审批状态」；审批未通过时确认按钮禁用并写明
    **为什么不能提交**（后端仍兜底校验，前端不做放行判定）；
  - 测试：shared 闸门 3 例（高风险恢复才拦 / 名单校验 / 非高风险与停用不拦）、
    dashboard 生命周期新增 2 例（模块装配 + 503 语义，共 21 例）、前端 devicesLogic
    3 例、浏览器 `devices-inventory` 新增 1 例（提前告知 → 发起审批 → 状态可见 →
    获批后带号恢复，且断言请求体真的带 `approvalId`）；`e2e:capability-explain`
    扩到 **23 项**：7 无审批 409、7a **一次审批覆盖整批设备**（自批 403 → 他人批准 →
    逐台带号恢复）、7b 恢复后世界模型重新计入可用能力。
- **高风险能力放宽接入审批闸门（NO-20a，原则 4/6/8）**：
  - 缺口：上一轮把高风险放宽做成了**文案警告**——调度员依然可以一个人把 crane/exo-lift
    从任务要求里去掉（等于放宽"谁可以承接该任务"）。警告不是闸门；
  - 现在：`PATCH /api/tasks/:id/requirements` 检测"**被放宽**的高风险能力"（原来要求、
    变更后不再要求；**新增高风险要求是收紧，不拦**）：
    · 无审批号 → **409 `HIGH_RISK_CAPABILITY_RELAXATION_REQUIRES_APPROVAL`**，
      响应里直接给出可照做的审批请求（entityType/entityId/subject 指纹），
      现场不必猜怎么发起；
    · 带审批号 → 逐条核对**审批已通过**（且无未完成步骤）、**对象是本任务**、
      **变更指纹逐字一致**（被放宽的高风险能力集合 + 变更后的设备/工位能力要求）；
      任一不符 → 409 `APPROVAL_INVALID` 并说明差在哪；
  - 复用既有审批模块（零新表）：`APPROVAL_ROLE_POLICY` 新增
    `task_capability_change: ['safety_admin']`；发起人回避与 global_admin 代安全角色
    沿用既有职责分离规则；
  - 审计与返回留痕：`task.requirements.update` 的 metadata 记录 `approvalId` 与
    `relaxedHighRiskCapabilities`，响应回传审批依据；
  - 前端：保存被闸门拦下时展示服务端原因 + 「发起安全审批」按钮（用同一 shared 实现
    构造指纹，避免前端与后端口径漂移）+ 审批号输入与「检查审批状态」；
    **平台不自动放宽、也不自动代发起审批**（改要求始终是人工动作）；
  - 测试：shared 闸门纯函数 4 例（识别放宽/指纹构造/校验放行/五类拒绝，
    含"拿只批了 crane 的审批去放宽 crane+exo-lift 必须拒绝"）、任务服务 5 例
    （无审批 409/带获批审批放行并审计/未通过或指纹不符 409/收紧不拦/低风险不拦）、
    前端 3 例；`e2e:capability-explain` 扩到 **20 项**：6b 高风险能力复原走完整审批链
    （无审批被拒 → 发起 → 自批 403 → 他人批准 → 带号落地），7b/7c/7d 改用中风险能力
    （vacuum/exo-lite）验证建议与组合建议（不再误触高风险闸门），8a–8f 验证
    无审批 409 + 指引、审批创建、自批被拒、安全审批通过、带号放行、**旧审批放大范围被拒**。
- **能力安全等级 + 高风险放宽必须安全复核（NO-19a，原则 4/5/6）**：### Fixed
- **并发上限测试改为结构性断言（flake 根治，测试基础设施）**：
  `test_concurrency_cap_returns_429_when_saturated` 依赖"6 个请求同时到达 + 假求解器 sleep 5s"，
  在整仓并行/CPU 饱和时假失败（实测全量套件 3 次里失败 2 次，单独跑必过）。现在：假求解器
  **阻塞到测试释放**（有界 20s），测试**分两批**发请求——先发 2 个并等到确认开跑（占满 cap=2），
  再发 4 个撞排队上限 → 断言从"至少 1 个 200 / 至少 1 个 429"升级为**恰好 2 / 恰好 4**；
  在 5 个 CPU 忙循环并行下全量 1079 项仍然全过（此前同一条件必失败）。
- **能力安全等级 + 高风险放宽必须安全复核（NO-19a，原则 4/5/6）**：
  - 缺口：放宽能力要求的建议此前只报"能多出几个候选"，把"放宽吊装能力（crane）"与
    "放宽温度观测（observe.temperature）"说成同一件事——建议可能被当成可以直接采纳的
    操作，而其中一部分实际在动**执行边界**；
  - 契约新增 `capabilityRiskLevels`（low/medium/high）、`capabilityRisk`（21 个已知能力逐项
    定级）与 `rules.highRiskRelaxationRequiresSafetyReview`；口径写进契约描述：
    **high** = 直接作用于人体或吊装载荷（exo-lift / interact.assist / crane / forklift）；
    **medium** = 有执行动作但风险可控，或"观测人员"涉及隐私（exo-lite / vacuum /
    observe.person_detection|pose|action|position|wearer / material_handling）；
    **low** = 设备自身状态与环境量、普通作业资格；
  - 建议携带 `risk` / `requiresSafetyReview`：high → 文案写"**该要求涉及高风险能力…放宽必须由
    安全负责人确认**，调度员不得单独决定"；medium → 与安全/工艺负责人确认；
    **未登记等级的能力 → `risk=null` 且如实写"未登记风险等级（无法判断）"**（不假装低风险）；
  - 前端：放宽建议在**行首**就标注"⚠ 高风险 · 需安全负责人确认"（不埋在长文案里）；
    设备抽屉每个能力新增风险徽标（高风险用告警色，title 给出行动含义）；
  - 三运行时一致：`shared/device-capability.ts` 的 spec 逐项 `risk` 与契约对账，
    Python 侧新增 `CAPABILITY_RISK_LEVELS`/`CAPABILITY_RISK` 并由 parity 测试锁定；
  - 测试：TS↔契约逐项一致 2 例、Python parity 4 例、引擎风险策略 3 例
    （high 需复核 / low 不制造假警报 / 未登记等级如实说明）、前端 3 例；
    `e2e:capability-explain` 新增 7b2（crane → risk=high、requiresSafetyReview=true、
    文案含"安全负责人确认/调度员不得单独决定"），14 项全过。
- **组合放宽建议 + 能力名笔误提示（NO-18a/NO-18b，原则 1/5/7）**：- **组合放宽建议 + 能力名笔误提示（NO-18a/NO-18b，原则 1/5/7）**：
  - **组合建议**：上一轮的反事实建议只做"单项放宽"，漏掉了真实现场常见情形——任务同时要求
    两种专用能力，而现场只有一种替代资源，"只放宽任一项"依然没有候选。现在单项全零时
    继续评估**能力对**（要求数 ≤5、最多 6 对、命中即停），返回 `kind='combination'` 与
    `capabilities[]`，文案明确"需要**同时**放宽这 N 项才有效"；组合意味着"放宽任一项都无效"，
    现场不会误以为改一项就够；
  - **笔误提示**：能力名是精确字符串匹配，`exo_lift` / `ExoLift` 与 `exo-lift` 在系统看来是
    三个不同能力，任务会永远匹配不到资源，而现场极难意识到是拼写问题。新增纯函数
    `suggestSimilarCapabilityNames`（先归一化分隔符/大小写，再做 Levenshtein，精确命中的
    已知名不算笔误）：任务能力要求的 warnings 与设备能力停用的 404 都会给"疑似笔误：是否指
    `exo-lift`？"；**只提示不自动改写**（命名是现场语义，平台不替现场决定）；
  - 契约：`capabilityRelaxationSuggestions[]` 增加 `capabilities[]` / `label` / `kind`，
    保留 `capability` 作兼容字段；
  - 测试：笔误检测 5 例（分隔符/大小写/缺字母/换字母/不相关不猜）、组合建议 2 例
    （组合给出且写明"同时"、单项可行时不触发组合）、前端文案 3 例；
    `e2e:capability-explain` 新增 7d（组合建议 `crane + vacuum` → `kind=combination added=5`），
    13 项全过。
- **能力要求的反事实放宽建议（NO-17a，原则 4/5/6）**：- **能力要求的反事实放宽建议（NO-17a，原则 4/5/6）**：
  - 场景缺口：能力要求写错/写多时任务永远没有候选，现场只知道"匹配不到"，不知道该放宽
    哪一项、放宽后会得到什么资源——上一轮的解释只说到"缺哪个能力/被谁停用"；
  - 候选端点新增 `capabilityRelaxationSuggestions`：对每个设备能力要求做一次**反事实评估**
    （去掉该项后重跑同一资格判定），报告"新增合格候选数 + 那些候选设备**实际具备**的能力"
    （后者的语义是"供现场判断可替代性"，**不是**等价能力声明）；
  - 边界（逐条明确）：仅在**零合格候选且拒绝原因包含能力**时计算（有候选不制造噪音）；
    安全/其他硬约束不参与建议（放宽后仍须通过全部其他约束）；最多 5 条、按收益排序；
  - **绝不自动放宽**：任务要求保持不变，平台不为了"派出去"而擅自降低执行边界；
    `note` 明确写出"仅建议（不会自动放宽）…是否可替代需现场确认；确认后请修改能力要求
    并重新生成方案"；
  - 前端：候选面板在建议出现时以醒目条目展示（含设备实际能力与边界说明），
    与上方的"修改要求"入口形成"解释 → 建议 → 人工修改 → 重排"闭环；
  - 测试：引擎 4 例（给出建议 / 有候选不给 / 非能力原因不给 / 无要求不给，并断言
    要求未被修改）、候选面板渲染 1 例、纯函数 1 例；`e2e:capability-explain` 新增 2 项
    （7b 建议链路 12 项全过、7c 断言"建议不自动放宽"）。
- **任务能力要求的写入口 + 现场就地修改（NO-16a，原则 1/3/8）**：- **任务能力要求的写入口 + 现场就地修改（NO-16a，原则 1/3/8）**：
  - 仓库事实：`ewoh_production_task.required_device_capabilities` /
    `required_station_capabilities` **没有任何 API 写入口**（只有种子与直连库）——
    调度的能力匹配（`requiredDeviceCapabilities ⊆ device.capabilities`）因此在实际作业里
    用不起来，上一轮 e2e 只能直连数据库构造任务要求；
  - 新增 `PATCH /api/tasks/:id/requirements`（`@Roles(global_admin, dispatcher, workshop_lead)`）：
    形状非法 400（非数组/非字符串/超长/超量，**不猜不截断**）；能力名是开放词表——
    未登记/当前无法匹配的名称**允许**写入但返回 `warnings` 显式提示（否则会得到
    "永远匹配不到资源"的任务而现场无从知晓）；变更写审计（before/after）+ 触发
    `TASK_UPDATED` 重排（旧方案是按旧要求算出来的）；
  - `POST /api/tasks` 同步支持这两列，并补 `task.create` 审计（原先创建路径无审计）；
  - **修掉一条死的接线**：`createTask` 过去不带 actor 发 `TASK_CREATED`，而调度桥接对
    缺 actor/org 的事件 fail-closed 拒绝——新建任务从未真正触发重排；现在创建与状态
    变更同一口径透传 actor；
  - 前端：指挥地图「候选资源」面板新增"能力要求"区块（当前要求按设备/工位分组展示，
    "未设置"显式说明，可就地修改并保存→自动刷新候选）；**候选为空时不再提前 return**，
    因为"没有候选"恰恰是最需要看到并修改要求的场景；保存后的 warnings 在面板内与
    toast 同时可见；
  - 契约：`TaskCandidatesResponse` 增 `requiredDeviceCapabilities/requiredStationCapabilities`
    （编辑器 prefill 用，与调度匹配同一来源）；`openapi/ewoh.yaml` 文档化新路由 +
    两个 schema；路由清单与生成类型同步；
  - 测试：规范化/提示纯函数 6 例、任务写路径 7 例（含 400 与审计/事件）、
    候选面板渲染 4 例、编辑器 VM 7 例；`e2e:capability-explain` 改为**经 API** 构造
    能力要求（不再直连库）并新增"形状非法 400"检查，10 项全过。
- **方案级能力解释 + 执行能力入词表（NO-15c，原则 3/5/8）**：- **方案级能力解释 + 执行能力入词表（NO-15c，原则 3/5/8）**：
  本轮由一条新的端到端场景（`npm run e2e:capability-explain`）逐层逼出**八个真实缺陷**：
  1. **方案层看不到能力细节**：未派工条目只带拒绝原因键（"capability_disabled ×2"），
     班组长不知道是哪个能力、谁停的、为什么 → 规则/MILP/启发式三套求解器的未派工条目
     现在都带 `capabilityNotes`（引擎按停用留痕生成），冲突层渲染进方案条目；
  2. **启发式求解器的未派工条目连拒绝原因都没有**（只有嵌套 `alternatives`，而 UI 读平铺
     `rejectReasons`）→ 补齐平铺原因 + 能力细节，方案解释不再因求解器实现路径而不同；
  3. **执行类能力不在权威词表内**：`exo-lift`/`vacuum`/`crane`/`exo-lite` 只存在于调度侧
     型号白名单，既不可校验也不可人工停用（"能做什么"的能力不可管控）→ 三个运行时
     （schema/TS/Python）同步登记 21 个 knownValues，执行类能力 `deviceObservationFields=[]`
     （空数组＝不产生观测列，不是"未登记"）；
  4. **型号派生能力停不掉**（台账无行 → 404）→ 首次停用**物化人工决定**为台账行
     （status=disabled + lifecycle + `materializedBy: human_disable`），带契约校验与审计；
  5. **停用会被白名单/列悄悄加回来**（人去停用、白名单又把它并回可用集）→ 可用集与观测集
     一律**减去**人工停用的能力（人工决定优先于一切自动来源）；
  6. **物化后误报 `changed=false` 且不写审计**（刚写完库却报"未变化"）→ 物化路径显式
     返回 changed=true 并补审计；
  7. **历史方案失读**：早期启发式方案只写嵌套 `alternatives[].reasons` → 冲突层回退展开，
     升级不丢旧数据解释；
  8. **长期停用会被遗忘**（设备悄悄永久失去派工资格）→ 设备抽屉显示"已停用 N 天"，
     超过 7 天提示复核。
  测试：求解器聚合 1 例、冲突层聚合/回退 2 例、停用优先于派生来源 2 例、物化 3 例、
  长期停用 1 例；新场景 E2E **9 项全过**（含"任务能力要求无 API 写入口，直连库构造并
  复原"的诚实处理）。
- **能力解释闭环：缺失 ≠ 人为停用（NO-15b，原则 5/7）**：- **能力解释闭环：缺失 ≠ 人为停用（NO-15b，原则 5/7）**：
  - 上一轮建成"人工停用能力"后暴露新的解释缺陷：停用会让相关任务无候选，但世界模型里
    这个能力**直接消失**，于是报的是通用的"缺少设备能力"——现场会去查一个根本不存在的
    能力，或把人工决定当成设备缺陷排查；
  - 台账读取不再只取 `status='active'`：`DeviceCapabilityLedger` 新增
    `disabledNames` / `disabledLifecycle`（谁/何时/为什么），被停用的能力作为**事实**
    进入世界模型但**不进**可用能力集；
  - 资源视图与调度快照设备项透出 `disabledCapabilities` +
    `disabledCapabilityLifecycle`；**世界状态摘要**纳入停用能力（"能做什么"变了 →
    旧方案必须判 stale，不能带着失效能力继续派工）；
  - 资格判定分流拒绝原因：缺的能力**全部**是被停用的 → 新原因 `capability_disabled`
    （"需复核停用决定或恢复"）；否则保守报 `missing_device_capability`（不掩盖未声明的
    缺口）；词表与文案同步登记（守卫已覆盖该键）；
  - 候选解释新增 `capabilityNotes`：由引擎按停用留痕生成"任务要求的能力 / 该设备当前
    可用能力 / 能力 X 已被人工停用：谁 · 何时 · 理由"；前端只透传并在候选面板展示；
  - 测试：台账 3 例（停用事实/留痕不全/解析透出）、资格 3 例（停用 vs 缺失 vs 混合）、
    引擎 2 例（含"不编造停用细节"）、前端 VM 1 例、真实后端 E2E 新增 2q4b
    （快照保留"被人为停用"事实）与 2q6 扩展（恢复后停用事实清除），edge 链路 41 项全过。
- **设备能力生命周期（人工停用/恢复）——NO-15a，能力台账的唯一人工写入口**：- **设备能力生命周期（人工停用/恢复）——NO-15a，能力台账的唯一人工写入口**：
  - 仓库事实发现**保护不可达**：摄入声明路径刻意"不复活被人工停用的能力"
    （`ON CONFLICT` 不覆盖 `status`），但此前**没有任何 API 能设置 status**——
    能力台账只有自动写入一个入口；而能力直接决定派工资格
    （`requiredDeviceCapabilities ⊆ capabilities`），误声明只能改库；
  - 新增 `POST /api/devices/:id/capabilities/:capabilityKey/status`（`@HttpCode(200)`，
    状态变更不是创建资源）：契约**逐条明确**——
    未知状态 400 / 空理由 400（理由必填，写入台账留痕与审计）/ 幂等
    （状态相同 → `changed=false`，不写库不记审计）/ 租户隔离（跨租户 404，不泄露存在性）/
    **恢复 fail-closed**（按 ADR-043 权威契约重新校验，不合规 409；词表外能力名无法校验
    即拒绝恢复）/ 时间语义（停用写 `effective_to`，恢复写 `effective_from` 并清空
    `effective_to`）/ 审计 `device.capability.disable|restore`（含 before/after 与理由）；
  - **历史脏字段自愈并如实列出**：`kind`/`capabilityId`/`subject` 由能力名与提供方推导
    （与摄入声明同一 helper），恢复时按词表纠正并在 `repairedFields` 中列出；
  - **不擦除人工留痕**：摄入路径刷新 `capability_value` 改为 jsonb `||` 合并
    （此前整对象覆盖会让"谁因什么停用它"在下一帧到达时凭空消失——能力仍是停用状态，
    现场却看不到原因）；
  - 读路径透出 `lifecycle`（谁/何时/为什么；形状不全 → null，**自动声明不冒充人工确认**），
    设备抽屉新增状态徽标、人工留痕与"停用/恢复"入口（理由对话框必填、幂等提示如实）；
  - 测试：Service 单测 12 例（参数/租户/幂等/停用/恢复/自愈/审计失败/留痕解析）、
    控制器委派 1 例、前端纯逻辑 4 例（状态标签/留痕渲染/动作与可操作性）、
    浏览器用例 1 例（理由必填 → 请求体带理由 → 状态与留痕可见）、
    真实后端 E2E **8 项**（2q1–2q8：空理由 400 / 停用生效 / 幂等 / 调度不再看到 /
    自动摄入不复活且不擦理由 / 恢复后调度重新看到 / 详情留痕 / 两类审计行）。
- **拒绝/冲突原因唯一词表 + 现场可读解释（NO-14h，原则 5/7）**- **拒绝/冲突原因唯一词表 + 现场可读解释（NO-14h，原则 5/7）**：
  - 仓库事实发现**三处真实缺陷**：(1) `eligibility.service.ts` 用无类型 `string[]`
    收集拒绝原因，实际产出 **30** 个键而 `CandidateRejectReason` 只声明 **22** 个——
    NO-05c/NO-05d 的维护/质量封锁、`continuous_work_exceeded`、`device_unavailable`
    等 8 个键在类型之外，靠调用方 `as` 断言掩盖（类型在说谎）；
    (2) 同一个键在 **5 张前端映射表**里有 3 种中文（`device_data_unavailable` 分别写作
    "电量数据不可用"/"设备电量数据不可用"/"设备数据不可用"），且多张表漏键 →
    现场直接看到英文键；(3) 求解器"没有合格候选"时给出的 `rejectReasons`
    （为什么没派出去）在指挥地图冲突层被**完全忽略**；
  - 新增 `shared/reject-reason.ts` 作为唯一来源：运行时数组派生
    `CandidateRejectReason` 类型 + `Record<...>` **编译期穷尽**的文案表
    （新增原因不补文案直接编译失败）；同义键复用共享文案常量，并由单测锁定
    跨词表一致性；历史键（`device_data_unavailable` 等）保留别名，旧数据仍可读；
  - `device_data_unavailable` 更名为 `battery_unknown`（该键在两个词表里都只表示
    "电量未上报"，旧名会误导为"所有设备数据缺口"）；`type` 列是普通 varchar，
    无需迁移，历史行经别名正常显示；
  - 未登记键**不静默**：码型键显示"未登记原因（key）"并保留原码，自由文本
    （如"负荷均衡：选中 P-Li"）原样展示；触发码的实体后缀不再被丢弃
    （`DEVICE_OFFLINE:D-1` → "设备离线（D-1）"）；
  - 新增纯逻辑模块 `intelligence-layers-logic.ts` + 导出 `PlanIssueList`：
    违反项按唯一词表中文化，并把候选拒绝原因**按次数聚合**呈现
    （"电量未知（未上报，不派工）×2、缺少设备能力"），未知码提示"存在未登记原因"；
  - 测试：新增词表/漂移守卫 12 例（含**扫描 eligibility/候选引擎/冲突服务/四套求解器
    源码**断言"产出码 ⊂ 词表"，防止词表再次落后于实现）、聚合逻辑 9 例、
    渲染 smoke 3 例；更新 5 张前端映射表相关用例。
- **成本段术语中文化（第六个词表）**：候选引擎写入的 `softCosts` 键是 camelCase
  （`latenessMs`/`travelMs`/`waitMs`/`changeCost`/`riskMs`/`energyPenalty`），
  与策略权重词表（UPPER_SNAKE，如 `MIN_TRAVEL_TIME`）**不是同一套键**——此前指挥地图
  成本段直接渲染 `软成本 · latenessMs 1500.00`。现新增
  `TRACE_SOFT_COST_LABELS` 与 `SOFT_CONSTRAINT_LABELS`（含 `EXCLUDED_RESOURCE`
  与硬约束同义复用），并由单测扫描候选引擎源码守卫"写入的键 ⊂ 词表"。
- **求解器违反项词表**：`VIOLATION_TYPE_LABELS` / `VIOLATION_REASON_LABELS`
  （`UNASSIGNED_RULE_BASED`、`no_eligible_candidate`、`predecessor_cycle` 等），
  冲突层不再显示 `违反约束 · UNASSIGNED_RULE_BASED：no_eligible_candidate`。

### Fixed
- **能力语义一分为二：执行/交互能力（调度匹配）≠ 观测能力（世界模型）（NO-14g）**：
  - 真实回归：把台账当"能力覆盖"用之后，外骨骼的**执行能力 `exo-lift`（型号白名单派生）
    被观测台账挤掉** → 需要助力能力的任务永远无候选 → golden 路径 `18-19. Reservation +
    Dispatch` 失败（实测 21 PASS / 1 FAIL）。台账目前只声明观测/交互维度，
    两者是不同粒度事实，必须**取并集**而非覆盖；
  - `resolveDeviceCapabilities` 现按契约 `mode` 拆分：`capabilities` = 台账执行/交互 ∪
    `ewoh_device.capabilities` 列 ∪ 型号白名单（去重排序）；`observedCapabilities` =
    `mode='observation'` 名称集，单独透出给世界模型/AI；词表外能力名保守归入执行侧；
  - `derivedFromModelWhitelist` 只在白名单**确实贡献**了能力且台账/列都没贡献时为真
    （此前"台账只有观测能力 + 无白名单"会被误标为派生，掩盖未知）；
  - 观测能力进世界状态摘要（`device:<uuid>` 版本哈希），设备换传感器对调度可见；
  - 资源视图/快照契约新增 `observedCapabilities`；测试 14 例（含"执行能力取并集、
    观测不挤掉 `exo-lift`"回归）；E2E 新增 `2p`（外骨骼 `exec=exo-lift|interact.assist`、
    `observed=observe.*`）与改写后的 `2o`（传感器 `exec` 为空、`observed` 4 项 —— 只"能看"
    不能"做"必须诚实）。
- **org 谓词审计：一次假阴性、五处真实跨租户读写（NEST-ORG-02）**：
  - 修掉审计本身的两个假阴性：(1) `methodRegion` 要求"签名与 `{` 同行"，跨行签名方法
    会把 region 回溯到**上一个**方法，混进无关方法的 org 谓词而逃过检查；
    (2) 判定用大小写敏感的 `/orgId/`，`viewerOrgId`/`primaryOrgId` 这类**确实按租户
    过滤**的方法被误报为违规。现在：跨行签名可识别 + 租户标识符大小写不敏感 +
    `systemTransaction` 与 `runInTransaction` 同等看待 + 排除"读 org 列/类型声明"
    （`orgId: t.orgId`、`orgId: string | null` 不构成谓词——这正是让
    `world-state` 豁免显示为"僵尸豁免"的原因）；
  - 审计暴露并修复五处真实缺陷：模拟器 `handleDeviceOffline` 只按 `device_id` 更新
    设备（唯一键是 `(org_id, device_id)` → 会把**他租户**同号设备改成离线）；
    规则引擎 `countRecentDegraded`/`hasRecentEvent` 只按 `device_id` 读遥测/事件
    （同号设备跨租户串读），且摄入路径未透传批次 org（现补 `evaluate({ orgId })`
    两条调用链）；`plan.service.attachPreApprovalSimulation` 只按 `run_id` 读
    `ewoh_simulation_run`（唯一键 `(org_id, run_id)`）；幂等键读取只按 `(scope, key)`
    过滤（唯一索引是 `(org_id, scope, key)` → 跨租户回放他租户响应），
    现与列默认值同源（导出 `CURRENT_ORG_ID_FALLBACK_SQL`）；审批
    `findLatestForEntity` 首查不带租户（取回后才 404）；
  - 新增 3 条经核验的豁免（`plan_id`/`session_id` 为全局唯一列 + 系统级复制流程），
    删除 1 条失效登记（文件里只剩 2 条链）；审计注册表 12 → 16 条，全部有效
    （无僵尸豁免、无未登记违规）；
  - 测试：`ingest.guard.spec` 抓出限流配置被写成**模块作用域静态字段**（import 期求值
    → 运行期/测试改 env 无效）→ 改为实例字段（启动时快照生效值），61 例通过。
- **调度新鲜度比较一律以快照自身租户为准（PLAN_STALE 复发修复）**：
  `assertFreshForApprove` 未透传 ctx 时，`collectState` 退化为**跨租户**收集，
  而能力台账等租户作用域数据源返回空 → 同一状态算出不同摘要 → 刚生成的方案审批即被
  判 `PLAN_STALE`（golden 链路连续 SKIP）。新增 `loadSnapshotRow()`（返回快照 + 归属
  租户）与 `comparisonContext()`（调用方有 org 用它，否则回落快照自身 org），
  `isSnapshotFresh`/`assertFreshForWave` 共用；豁免登记保留为
  `ewohWorldStateSnapshot#1`（按服务端生成的版本键跨租户单条读，属设计语义）。

### Fixed
- **a11y 扫描不再在过渡中途取样（flake 修复）**：`ux009-axe.spec.js` 的 `runAxeScan`
  在页面过渡未结束时扫描，会把"半透明文字"测成对比度不足（`实时` 徽标 4.16 < 4.5，
  reduced-motion 项目连续两次运行一次通过一次失败）。axe 的 `color-contrast` 依赖
  **计算后**颜色，故扫描前等待过渡结束（`networkidle` + 600ms 稳定窗）——
  治因不放宽判据；修复后同一项目连续 3 次全绿。
- **不再伪造电量：帧未上报电量写 NULL 而非 100%（原则 7）**：
  摄入路径首建 `ewoh_device` 时把缺失电量写成 `100`——"电量未知"因此看起来像
  "满电可用"，属于把缺失数据静默伪造成确定事实。现写 `NULL`（未知），并保持
  既有语义边界：冲突更新仍用 `?? undefined` **保留已登记电量**（不会把已知值擦成
  NULL）；调度对未知电量的处理是显式且 fail-closed 的（候选评估给无穷能耗罚 →
  不派工），设备详情/列表显示"不适用"而不是 100%。golden 22/22、edge 32/32 复验通过。
- **设备能力被调度消费 + 世界模型身份 join 键（NO-14f，ADR-043/ADR-044，§3/§5/§7）**：
  - 仓库事实发现**能力链路断了三处**：(1) 能力台账自建立后**没有任何消费方**；
    (2) 调度读的 `ewoh_device.capabilities` 列实测全为 `[]`（无写入方）→
    `task.requiredDeviceCapabilities ⊆ device.capabilities` **永远匹配不到设备**；
    (3) 资源投影 `project()` 与 `projectForSnapshot()` 各有一份设备能力语义，
    只改一处会让快照路径仍然读空列（"能力接了一半"）；
  - 新增台账读取器 `loadDeviceCapabilityLedger`（租户作用域、仅 `status='active'`、
    分批 IN、契约校验、非设备 kind 显式记缺口、缺 org 绝不跨租户读）；
  - 新增**唯一解析器** `resolveDeviceCapabilities`：优先级
    台账 → `ewoh_device.capabilities` 列 → 型号白名单兜底（derived 标记），
    `project()` 与 `projectForSnapshot()` 共用（消除两份语义）；
  - 快照/资源视图透出台账记录（`capabilityRecords` 含 subject/evidence/providerType）
    与缺口（`capabilityLedgerIssues` → 快照 `capabilityProjectionIssues`）；
  - **世界模型身份 join 键**：资源视图与快照设备项新增 `deviceId`（业务设备号）——
    此前快照只有 `id`（uuid），平台无法把边缘遥测/能力台账（业务号）与调度资源关联；
    顺带修正 `capabilitySubject` 曾把设备号整体 `toLowerCase` 的**身份改写**缺陷
    （大小写敏感的业务标识被折叠，可能撞号），现在值部分原样保留、前缀小写；
  - 台账 upsert 冲突时同步纠正 `kind`/`capabilityId`（历史自造 kind 的行重新声明即自愈）；
  - 测试：新增 `device-capability-ledger.spec.ts` 11 例（读取/契约缺口/租户守卫/
    优先级/派生兜底）+ 契约 spec 增身份大小写锁定；E2E 31 项（+快照消费断言：
    按业务号定位设备并核对其能力名称集与契约记录）。

- **设备能力台账对齐 Canonical Capability Model（NO-14e，ADR-043，§3/§4/§33）**：
  - 仓库事实发现**同一概念两套词表**：上一轮新增的设备能力台账自造了
    `observation`/`interaction` 当 kind，而平台早已有权威能力契约
    （`contracts/capability/capability.schema.json` + `shared/capability.ts` +
    `src/edge_platform/contracts/capability.py`，ADR-043 / NO-12t）——
    台账因此无法被既有能力消费方（人员技能/资质/工位能力）统一读取；
  - 对齐：能力记录改为构造权威 `CapabilityRecord` 并**写入前用
    `validateCapability` fail-closed 校验**（不合法即跳过 + ERROR 留痕）：
    `kind` = `device_capability` / `exo_capability`，`providerType` = `device` /
    `exo`，`subject` = `device:<id>` / `exo:<id>`（满足契约 `^[a-z0-9_]+:.+$`），
    `evidence` = 来源字段；观测/交互形态降级为 `mode` 子属性，`capabilityId`
    确定性生成（`cap:<subject>:<name>`）；
  - 词汇登记：12 个能力名（`observe.*` / `interact.*`）登记进权威
    `knownValues`（schema + Python + TS 三处一致，由既有
    `audit-domain-contracts` 精确比对 + 新增 jest 对账补上 TS 这条腿）；
  - 新增契约数据 `deviceObservationFields`（能力名 → **平台摄入 DTO 字段路径**）
    作为字段漂移的单一事实源；
  - 读面/UI：设备详情返回 `name/kind/providerType/mode/capabilityId/fields/
    grantedAt/registered`（`key` 作为兼容别名保留），抽屉按权威 kind 展示
    「设备能力/外骨骼能力」+ 观测/交互徽章；
  - 测试：新增 jest 契约对账 6 例（词汇登记/三运行时一致/kind 一致性/字段一致/
    字段真实存在于摄入 DTO/类别无孤儿引用）+ Python 字段对账 5 例（归一化载荷
    真的产出这些字段）；平台 ingest 22 例（+台账行可被契约读回）；E2E 30 项
    （+权威形状 subject/providerType/evidence 与详情读面）。

- **能力模型落地（NO-14d，§1/§3/§5/§8/§33）**：
  - 仓库事实发现**能力层完全空缺**：DDL 早有 `ewoh_device_capability`
    （含 `UNIQUE (org_id, device_id, capability_key)`），但 ORM 未映射、
    无任何写入方（实测 0 行）——世界模型只知道"有这台设备"，不知道
    "它能观测/执行什么"，调度/约束校验/AI 解释都缺这层事实（原则 3）；
  - 新增 `shared/device-capability.ts`：能力键词表（12 项：温度/振动/噪声/空气质量/
    人员检测/姿态/动作/位置/负荷/电量/佩戴人/助力交互）+ 类别→能力映射
    （`CAPABILITIES_BY_CATEGORY`）+ 展示名与"是否词表内"判定；未登记类别 → 不声明；
  - ORM 补 `ewohDeviceCapability` 映射（闭合 DDL↔ORM 漂移，含 `(org,device,key)`
    唯一索引）；
  - 声明路径（幂等，`ON CONFLICT` 只刷新时间与来源字段，**不复活**人工停用的能力）：
    环境/摄像头/定位在摄入成功且设备登记后按类别声明；外骨骼在 `upsertDevice`
    成功后声明 4 项（含 `interact.assist`）；被拒帧（坏时钟/重复）不声明；
    声明失败不阻断数据落库但显式留痕；
  - 读面：`GET /api/devices/:id` 详情返回 `capabilities`（key/type/label/status/
    fields/registered）；列表不带（避免 N+1 与 payload 膨胀）；`orgCondition`
    放宽为任意 org 列（各表 org_id 类型 varchar/uuid 不同，语义一致）；
  - 前端：设备抽屉"绑定关系"页新增「设备能力」区块（词表内→中文名+类型+来源字段；
    停用→显式标出状态不隐藏；词表外→原样展示 key 并标注"未登记能力键"）；
    设备信息区新增「设备类别」；无空间实体时显示**"位置未登记（地图与空间约束
    不覆盖该设备）"**而不是留白；
  - 测试：平台 ingest 21 例（+4：按类别声明/互不串味/被拒不声明/未登记类别不声明）、
    客户端逻辑 27 例（+6：能力视图 ×4 + 位置登记判定 ×2）、浏览器 4 例（+1）、
    边缘 E2E 新增 4 项能力断言（含外骨骼路径）。

- **感知层进入平台设备台账（NO-14c，§1/§3/§7/§8/§33）**：
  - 仓库事实发现**结构性缺失**：`ewoh_device.device_category` 列早在 001 DDL 就存在，
    但**没有任何代码写它**（实测 dev 库 8 行全 NULL、TS/seed/前端零引用），
    且环境/摄像头/定位三条摄入路径**只写业务表、不登记设备** → 平台设备台账只有
    外骨骼，感知层设备在设备页/在线率/新鲜度上完全不存在；
  - 新增 `shared/device-category.ts` 词表（exoskeleton / environment_sensor /
    camera / location_tag，未识别一律 `unknown`——显式未知，绝不猜相近类别）
    + `INGEST_CATEGORY_BY_KIND` 唯一映射点（与边缘 `FRAME_KIND_*` 对齐）；
  - `SensorIngestService.registerSensorDevice`：首次摄入即登记（幂等，
    `ON CONFLICT (org_id, device_id)`），重复只更新在线/最近遥测/来源，
    **绝不覆盖**已登记类别与型号（人工登记是权威）；被拒帧（坏时钟/重复）不登记；
    登记失败不阻断数据落库但显式留痕；
  - **电量诚信**：登记显式写 `battery_pct = NULL`（列默认 100 会把"没有电池"
    填成"满电"，实测踩到）；`DeviceInfo.batteryPct` 读取侧不再把 NULL 强转 0
    （原实现让传感器显示"0% 低电量"——把"不适用"伪装成告警）；
  - **定位帧补物理设备 id**：`LocationFrameDto.tag_id`（边缘统一帧一直有，上行时
    被丢掉）→ 平台据此登记定位标签；缺省回落 `entity_id`（台账不留空档）；
  - 设备 API/UI：`GET /api/devices|/api/dashboard/devices` 支持 `category` 过滤、
    `DeviceInfo.deviceCategory` 如实回传（未知 → `unknown`）；设备页新增类别列与
    类别过滤，无电池设备显示"不适用"（不渲染低电量红条）；
  - 测试：平台 ingest 17 例（+5：登记/兜底/被拒不登记/登记失败不阻断）、
    设备契约 2 例、客户端逻辑 21 例（+3：类别标签/过滤选项/电量读数）、
    浏览器 3 例（`devices-inventory.spec.js`，含 a11y）+ 边缘 E2E 新增 5 项断言
    （台账行/在线与最近遥测/电量 NULL/类别可查/类别过滤不猜近似）。

- **边缘多源传感器上行闭环（NO-14b，§1/§3/§7/§8/§33）**：
  - 仓库事实发现**结构性断点**：`AdapterManager._read_loop` 只把分组外骨骼帧转成
    存储行，环境/摄像头/定位帧原样透传给要求 `record_id/device_id/timestamp` 的
    `insert_telemetry` → 必然 KeyError → 帧只留在 ERROR 日志（本地库没有、平台也
    没有；平台侧 `/api/ingest/{environment,camera,location}` 三个已实现端点从未被
    边缘喂过数据）；
  - 新增 `edge/modeling/sensor_frames.py` 作为**唯一帧→契约转换点**：四类显式映射
    （本地行讲边缘统一帧词汇，上行载荷讲平台 DTO 词汇）、确定性 `record_id`
    （`edge:<kind>:<dev摘要>:<ts_ms>:<seq|载荷摘要>`，同帧重发同 id）、
    `quality_status`/`source_type` 缺失显式 `unknown`（绝不默认 good/real）；
  - 边缘存储：`ensure_device` 设备自动登记（此前非外骨骼设备从未进 device 表，
    `last_seen/online` 更新命中 0 行）、`frame_dead_letter` 死信表（不可归一化帧
    留痕 + 计数 + 该设备 health `degraded`）、`insert_telemetry` 缺字段显式抛
    `FrameContractError`；新增 `STREAM_SENSOR_FRAMES` 分流（不污染推理管线输入）；
  - 新增 `edge/bridge/sensor_uplink.py` 多源上行桥：按 endpoint 路由、每类 FIFO、
    有界缓冲（满丢最旧 + `dropped_overflow`）、入队即落盘（O(1) JSONL）、跨重启
    断点续传、4xx 死信（不阻塞队头）、429/5xx/网络退避重试、`retarget` 原地切换
    目标（避免换实例造成订阅空窗或双写队列）、按端点细分计数与记录 id 明细；
  - 平台侧：`environment/camera/location` 三条摄入路径补**传输级幂等**
    （`(org_id, scope, record_id)` 认领，复用 `ewoh_idempotency_keys` 唯一索引；
    重放 `skipped=true` 不双写；写入失败释放认领）、**时间语义**（迟到 >10min 标记
    `is_late` + `degraded` 仍落库；超前 >5min 显式拒绝 `CLOCK_DRIFT_FUTURE_TS`）、
    `IngestResponse.retryable` 显式区分"永远不该写入"与"这次没写成功"、
    `world_state` 行落 `record_id`（幂等键可追溯）、摄入限流可配
    （`INGEST_RATE_LIMIT`/`_WINDOW_SEC`，默认 100/60s 不变）；
  - 可运行模拟器 `tools/edge_sensor_sim.py`：真实适配器 + 故障注入
    （断网窗口/重复/乱序/迟到/坏时钟/坏帧），输出**账目闭合**统计
    （`published == bridge_received`，`received+replayed == sent+duplicates+rejected+buffer+dropped`）；
  - 新增 E2E `test/e2e/edge-multisource-uplink.mjs`（`make e2e-edge`）：
    真实边缘运行时 + 真实平台 + 真实 PostgreSQL，逐条核对发布/落库/不双写/
    迟到标记/坏时钟被拒/死信留痕（20 项断言，含逐条 record_id 抽样核对）；
  - 测试：边缘新增 28 例（帧契约 14 + 上行桥 14）、平台 ingest 13 例
    （幂等 ×4 / 时间语义 ×2 / record_id 可追溯 ×1 等）；边缘套件 1042→**1070**。

- **学习提案审批独立性与阈值基线读面（NO-14a，standalone_073，B5 同族治理，§2/§8/§33）**：
  - 仓库事实发现**结构性自批**：`ewoh_learning_proposal` 只有 `approved_by`，
    无提议人字段 → "提案人不得审批自己的提案"这条回避规则无从执行（与
    standalone_069 对 `ewoh_schedule_plan.created_by` 的处置同族）；
  - 迁移 073（apply/rollback/verify + runner 注册）：新增 `proposed_by varchar(128)`
    + `chk_ewoh_learning_proposal_generator_avoidance`（`status<>'approved' OR
    proposed_by IS NULL OR approved_by IS DISTINCT FROM proposed_by`；NULL=存量放行，
    避免历史提案被永久锁死）；verify 用**写入探测**自证（自批 INSERT 必被
    check_violation 拒绝 + 跨人审批可写 + 探测行清除），不只查字典；
  - 服务端：`propose` 提议人取 `userContext.userId`（请求体 `proposedBy` 不可伪造，
    已用真实后端验证），缺身份 fail-closed 400；`approve` 在任何写入前拒绝自批 →
    `403 SELF_APPROVAL_FORBIDDEN`（语义与方案侧一致）；
  - 新增只读 `GET /api/learning/thresholds`：每个可提案参数返回 engineDefault /
    effective / source（engine_default | approved_proposal | engine_default_unknown）/
    provenance（提案、提议人、审批人、批准时间、影子证据来源）/ 在途与历史计数；
    无覆盖时**如实标注"引擎内置常量，未经人审激活"**；引擎常量单一来源
    `DEFAULT_WORKLOAD_THRESHOLD`（与规则求值同源）；
  - 前端：学习控制台新增「阈值基线与受控变更」面板 + 提案卡显示提议人、
    本人提案的"批准"被禁用并说明需他人审批（**拒绝仍可用**：撤回自己的提案
    服务端允许，UI 不得凭空收紧）；
  - 测试：服务端 21 例 + 客户端 33 例 + 浏览器 mock 17 例 + 真实后端 UI 闭环 1 例；
  - OpenAPI：新增 `/api/learning/thresholds` + `LearningThresholdBaseline` 组件 +
    `LearningProposal.proposedBy`；route-manifest 405/601 → 406/603。
- **Model Training Policy v1（租户隔离强制，NO-13u，ADR-070，R-91，§15/§16/§33）**：
  - 仓库事实发现真实泄漏风险（retrain 无 org 过滤混合全租户反馈训练
    全局模型）→ v1 政策 = **租户作用域训练**（跨租户聚合显式 OFF，
    无授权/匿名化机制前禁止）；
  - modelId org 命名空间：`task-duration-empirical:<orgId>` /
    `:<orgId>:<taskType>`（orgIdFromModelId 解析；旧全局模型显式
    弃用不回填）；provider org 键控（orgModels + refreshForOrg；
    预测必须携带 task.orgId，缺 → 确定性基线显式 §33）；
  - `retrain(orgId)` / `hydrateFromRegistry(orgId)` 强制（缺 orgId
    → 400；feedback org_id 过滤）；controller 端点注入 userContext
    org；cardJson 携带 orgId 判定事实；
  - 测试：provider spec org 键控更新 + training spec 跨租户隔离
    + 缺 org 400（9 例）；default jest 266 suites 1976→**1978**
    tests；
  - 无 schema/OpenAPI/env 变更；§15/§16 机器强制收口（ADR-056/067
    遗留边界关闭）。
- **Exo Support Mode 观测边界复核与锁定（NO-13t，ADR-069，R-90，§7/§33）**：
  - 仓库事实复核：NY-EXO-A1 协议确认书 2.3 TELEMETRY 20B 布局无
    mode 字节（assist_pct 为助力强度连续量非模式分类）；IDENT/
    FAULT/HEARTBEAT 无 mode；VENDOR_TO_UNIFIED 无 mode 语义路径；
    UnifiedExoFrame 无 supportMode 字段——**阻塞仍成立**（厂商协议
    升级前不伪造观测）；
  - 机器锁定边界：test_ny_exo_a1_contract.py +3 例（TELEMETRY
    字段集锁定 / 统一语义帧无 support_mode / VENDOR_TO_UNIFIED
    无 mode 语义路径——协议升级触发失败即漂移信号）；pytest
    1340 passed/10 skipped 全绿（含 +3）；
  - assist_level 数值事实照常观测（与配置 mode 并列，不推导
    分类）；无实现变更（仅测试 + 文档）。
- **SimulationConsole 数据型页面渲染 smoke（NO-13s，ADR-068，R-89，§17/§18/§31/§33）**：
  - 提取 `SimulationRunList` 纯展示组件（rows/selectedRunId/
    onSelectRun props 零网络；控制台委托渲染行为逐字一致，
    data-testid 保留）；TONE_TEXT/TONE_BORDER 上移
    simulationConsoleLogic（§31 单一来源）；
  - 渲染 smoke 2 例（数据行契约字段透出 / 失败行 failureReason
    显式头条 + aria-pressed 选中态——R-87 模式推广）；client jest
    119→120 suites 968→**970** tests；
  - 数据型页面渲染 smoke 缺口第二项关闭；无 DB/OpenAPI/env 变更。
- **per-taskType 经验时长模型分组（NO-13r，ADR-067，R-88，§10/§21/§33）**：
  - modelId 词表：全局 `task-duration-empirical`（v1 语义不变）+
    分组 `task-duration-empirical:<taskType>`（taskType 为任务登记
    事实非猜测；无类型仅计全局）；
  - 预测两级回退显式：taskType 分组模型 → 全局模型 → 确定性基线
    （source/modelVersion 如实标注，§33 不静默）；
  - `retrain` = 全局 + 分组独立落版（每 modelId 版本链 supersede +
    递增；分组样本 < MIN_SAMPLES → 显式 skipped 不落版；cardJson
    携带 taskType 判定事实）；RetrainSummary.perTaskType additive；
  - `hydrateFromRegistry` 全量回填（isEmpiricalModelId 前缀过滤 +
    按 modelId 最新 active 重建分组映射，冷启动恢复分组训练态）；
  - 测试：empirical-duration-prediction.spec +2 例（分组优先 /
    两级回退）+ duration-model-training.service.spec +2 例（分组
    独立 modelId 链 + 不足跳过 / hydrate 映射重建）；default jest
    266 suites 1972→**1976** tests；
  - shadow-only 边界不变；无 DB/OpenAPI/env 变更；ADR-056 决策 3
    后续收口。
- **Decision History 控制台 UI（NO-13q，ADR-066，R-87，§17/§18/§33）**：
  - 数据型页面三层：`decisionHistoryLogic`（8 kind / 5 status /
    5 authority 标签 + 风险档 tone + 行模型——未知词表值原样透出
    不猜测 + sources 摘要）/ `DecisionHistoryTable`（纯展示，契约
    字段透出零网络）/ `DecisionHistoryConsole`（react-query 消费
    ADR-065 端点 + kind/status 过滤 + "加载更多"分页 +
    skippedInvalid 显式横幅（§33 非法记录绝不静默）+ 错误/空/
    加载态）；
  - `fetchDecisionHistory`（client/api/decisions.ts，类型复用
    @shared/decision §31）；路由 /decision-history + 侧边栏 nav 项
    （决策历史，dispatcher/workshop_lead/global_admin）；
  - 测试：decisionHistoryLogic.test 4 例 + DecisionHistoryTable
    .render.test 2 例（数据行透出 / 非法横幅 + 空态）；client jest
    117→119 suites 962→**968** tests；
  - 另修复 rule-based-scheduling-solver.spec 重放 deep-equal 的
    createdAt 墙钟 flake（strip 纳入 createdAt——测试确定性卫生）；
  - 无 DB/OpenAPI/env 变更；数据型页面渲染 smoke 缺口关闭。
- **Decision History 跨 kind 检索端点（NO-13p，ADR-065，R-86，§12/§15/§18/§33）**：
  - `DecisionHistoryService`：Decision Catalog 8 类 kind 跨四表统一
    读面（schedule_plan.decision_records_json + agent_approval /
    learning_proposal / scheduling_policy .decision_json）——记录级
    租户过滤统一面（plan 表无 org_id 列显式边界；org 作用域表
    org_id 列过滤 + 记录过滤双保险；scheduling_policy 全局 null 行
    不进入租户查询显式边界）；全部记录过 validateDecision（§31
    单一校验器），非法 → 显式 skippedInvalid 计数（§33 绝不静默
    丢弃）；decidedAt 降序 + decisionId 字典序稳定排序；limit 缺省
    50 cap 100；kind/status 过滤器 fail-closed（未知值 400）；
  - `GET /api/scheduler/decision-history`（只读；零写入零事件）；
    OpenAPI +1 路径（397→398 controllers / 588→590 spec）+ client
    types 再生成；
  - 测试：decision-history.service.spec 3 例（四表聚合 + 他租户
    剔除 + sources 扫描量审计 / kind+status 过滤 + fail-closed +
    cap + offset / 非法 skippedInvalid + 缺租户 400）；default jest
    265→266 suites 1969→**1972** tests、client jest 117/962 全绿；
  - 无 DB/env 变更；决策历史面板 UI 后续立项。
- **Policy Activation Decision 接线（NO-13o，ADR-064，R-85，§2/§8/§12/§18/§33）**：
  - `projectPolicyActivationDecision`：Decision Catalog kind #8——
    decisionId=`decision:policy:v<version>:activation` 确定性幂等
    （单记录列重复激活同 id 覆盖为最新决策，语义显式）；kind=
    policy_activation / status=executed / authority=human
    （approver 强制人审门）/ subject=policy:v\<v\> / riskLevel=
    'high' 类型推导规则锁测试（策略激活直接翻转生产调度行为）/
    requiresApproval=false（本记录即人审激活事实）/ selected.reason
    =[人审理由||'activated'] / approver 判定事实 / evidence=
    version:\<v\>；
  - `SchedulingPolicyService.activatePolicyVersion` active 翻转与
    decisionJson **同一 UPDATE 原子写**（reason 由
    SchedulerPlanApplicationService 透传 body.reason）+ savePolicy
    直接激活路径 INSERT 携带（reason 缺省 policy-save-activated）；
    投影缺口 log 显式留 NULL 不阻断激活主流程（§2/§33；全局策略
    orgId null 缺口显式边界——契约强制 tenantId 不伪造）；
  - standalone_054 原地加固（计数不变 74/77；旧行 NULL=未投影）：
    runner 全套注册 + check script 成对回滚 + CI step + state.json +
    schema-manifest new→altered；
  - 测试：decision-projection.spec +3 例（判定事实 / 缺省理由 +
    幂等 / 缺口显式）+ policy-version.spec +2 例（activate 行翻转
    decisionJson 落库 + validateDecision 门 / savePolicy 路径）；
    default jest 265 suites 1964→**1969** tests；
  - **Decision Catalog 8 类 kind 全收敛收口**（§12 Decision History
    全链覆盖：task_assignment / plan_approval / agent_approval /
    resource_reservation / dispatch / replan / learning_proposal_
    activation / policy_activation）；无 OpenAPI/env 变更。
- **Learning Proposal Activation Decision 接线（NO-13n，ADR-063，R-84，§2/§10/§12/§18/§33）**：
  - `projectLearningProposalActivationDecision`：Decision Catalog
    kind #7——decisionId=`decision:<proposalId>:activation` 确定性
    幂等（状态机单向转移）；kind=learning_proposal_activation；
    status 映射：approve→approved / reject→rejected / rollback→
    superseded（激活决策被回滚取代）；authority=human（三路径强制
    人审身份+理由）；subject=proposal:\<id\>；riskLevel='medium'
    类型推导规则锁测试（阈值激活间接触发调度建议面）；
    requiresApproval=false（本决策即人审事实）；selected：
    approve→opt:activate（缺省 approved）/ reject·rollback→
    opt:keep（必填理由事实）；approver 判定事实；evidence=
    proposal+kind 链接；
  - `approve`/`reject`/`rollback` 与状态终态**同一 UPDATE 语句**
    原子写 decision_json（standalone_053 原地加固，计数不变
    74/77；旧行 NULL=未投影）；投影缺口 log 显式留 NULL 绝不阻断
    提案主流程（§2/§33）；
  - 测试：decision-projection.spec +3 例（approve 判定事实 /
    reject·rollback 状态映射+理由强制 / 幂等 + 缺口显式）+
    learning-proposal.service.spec +3 例（三路径 decisionJson
    落库 + validateDecision 门）；default jest 265 suites
    1958→**1964** tests；
  - Decision Catalog kind #7 接线（§12 Decision History 覆盖学习
    提案激活全链；其余 1 类后续逐类收敛）；无 OpenAPI/env 变更。
- **Replan Decision 接线（NO-13m，ADR-062，R-83，§2/§8/§12/§18/§31/§33）**：
  - `projectReplanDecision`：Decision Catalog kind #6——
    decisionId=`decision:<planId>:replan` 确定性幂等（同一 planId 至多
    持久化一次）；kind=replan / status=proposed（新方案 shadow 待
    审批）/ authority=policy（触发链=政策驱动）/ subject=plan:\<id\> /
    riskLevel=触发类型推导规则锁测试（SAFETY_EVENT / ZONE_RESTRICTED
    →high；PERSON_UNAVAILABLE / DEVICE_OFFLINE→medium；其余→low）/
    requiresApproval=true / selected.reason=trigger:\<type\>:
    affected:\<n\> / evidence=run+trigger+affected+entity 链接 /
    auditTrail actor=policy:replan-trigger（自动触发不伪造 human
    身份）；
  - `replan-coordinator` persistPlan 后逐方案追加（handleTrigger +
    handleConflictBatch 双路径；投影缺口/追加失败 log 显式绝不阻断
    重排主流程，§2/§33；抑制路径（debounce/storm/low-improvement）
    不产生记录——事实一致）；
  - **§31 收口**：`decision-ledger.ts`（appendPlanDecisionRecords
    读-追加-回写单一实现）——plan.service（审批追加）+
    dispatch-coordinator（派工追加）+ replan-coordinator（重排追加）
    三处消费收敛（既有 spec 回归锁定）；
  - 测试：decision-projection.spec +3 例（判定事实 / 风险类型规则 /
    幂等 + 缺口显式）+ replan-decision-persistence.spec 2 例（kind
    #6 台账 + validateDecision 门 + 去抖幂等）；default jest 264
    suites 1953→**1958** tests；
  - Decision Catalog kind #6 接线（其余 2 类后续逐类收敛）；无
    DB/OpenAPI/env 变更。
- **Dispatch Decision 接线（NO-13l，ADR-061，R-82，§2/§12/§18/§33）**：
  - `projectDispatchDecision`：Decision Catalog kind #5——
    decisionId=`decision:<planId>:dispatch` 确定性幂等（double-
    dispatch CAS）；kind=dispatch / status=executed（执行步骤留痕）/
    authority=policy（派工链含政策门 SAFETY_BLOCK_DISPATCH /
    ADVISORY fail-closed / 快照新鲜度强校验）/ subject=plan:\<id\> /
    riskLevel=分配风险档聚合 max 规则（任一 high→high / 否则任一
    medium→medium / 否则 low——复用 ADR-048 决策 2 单条映射，聚合
    规则锁测试）/ requiresApproval=false（审批事实在 kind #2）/
    selected.reason=dispatched:\<count\>（真实派工数）/ evidence=
    outbox 事件 id 链接；
  - `DispatchCoordinator.dispatch` 事务末与 kind #4 记录**单次**
    读-追加-回写 decision_records_json（projectReservationDecision
    Records + appendDecisionRecords 重构；投影缺口/追加失败 log
    显式绝不阻断派工主流程，§2/§33）；getPlan 读回自动携带；
  - 测试：decision-projection.spec +3 例（判定事实 / 风险聚合 max
    规则 / 缺口显式）+ dispatch-integration.spec 主链路断言补强
    （kind #5 台账 + getPlan 读回携带）；default jest 264 suites
    1950→**1953** tests；
  - Decision Catalog kind #5 接线（派工链全链留痕：kind #2 审批 →
    kind #4 预占 → kind #5 派工；其余 3 类后续逐类收敛）；无
    DB/OpenAPI/env 变更。
- **Resource Reservation Decision 接线（NO-13k，ADR-060，R-81，§2/§12/§18/§33）**：
  - `projectResourceReservationDecision`：Decision Catalog kind #4——
    decisionId=`decision:<planId>:reservation:<assignmentId>:<reservationId>`
    确定性幂等（reservationId 单次生成 + double-dispatch CAS）；
    kind=resource_reservation / status=executed（执行步骤留痕非提议）/
    authority=rule_based（预占输入由 assignment 字段确定性推导）/
    subject=`resource:<type>:<id>` / riskLevel 复用 ADR-048 决策 2
    映射规则（§31 单一规则）/ requiresApproval=false（审批事实在
    kind #2）/ selected.reason=台账行唯一链接（reservationId:type:
    id:窗口）/ auditTrail actor=user:\<id\>|system:dispatch；
  - `DispatchCoordinator.dispatch` 预占循环收集真实 reserve() 结果 →
    **与派工同事务**读-追加-回写 decision_records_json（无第二事实源；
    投影缺口/追加失败 log 显式绝不阻断派工主流程，§2/§33）；
    getPlan 读回自动携带；
  - 测试：decision-projection.spec +3 例（判定事实 / 缺省 actor +
    幂等 / 缺口显式）+ dispatch-integration.spec 主链路断言补强
    （派工后方案决策台账含 kind #4 + getPlan 读回携带）；default
    jest 264 suites 1947→**1950** tests；
  - Decision Catalog kind #4 接线（§12 Decision History 覆盖派工
    预占全链；其余 4 类后续逐类收敛）；无 DB/OpenAPI/env 变更。
- **Agent Approval Decision 接线（NO-13j，ADR-059，R-80，§2/§11/§12/§18/§33）**：
  - `projectAgentApprovalDecision`：Decision Catalog kind #3——
    decisionId=`decision:<approvalId>:agent-approval` 确定性幂等
    （ADR-039 CAS 单次解析）；kind=agent_approval；status=approved/
    rejected（expired → rejected，reason=approval_expired）；
    authority 区分人工=human / TTL 超期=policy（不伪造 human 身份）；
    riskLevel 映射自 manifest.riskLevel 真实清单事实（critical 收敛
    high + evidence `manifest_risk:<level>` 留原始档）；
    requiresApproval=false（本决策即审批事实）；approver 判定事实
    （user:\<id\> / policy:agent-approval-ttl）；validateDecision 门；
  - `resolveApproval` 三路径（approved/rejected/expired）投影 +
    resolveRow 唯一权威写路径：decision_json 与解析终态**同事务原子
    落库**（standalone_052 原地加固，计数不变 74/77；旧行 NULL=
    未投影）；投影缺口/契约失败 log 显式留 NULL，绝不阻断审批主流程
    （§2/§33，与 ADR-057 同纪律）；
  - 测试：decision-projection.spec +5 例（kind #3 判定事实 / 驳回
    缺省理由 + 幂等 / expired policy / 风险映射规则 / 缺口显式）+
    agent.service.spec +3 例（approved/rejected/expired decisionJson
    落库 + validateDecision 门）；default jest 264 suites
    1939→**1947** tests；
  - Decision Catalog kind #3 接线（§12 Decision History 覆盖 Agent
    审批解析全链；其余 5 类后续逐类收敛；跨 kind 检索端点后续立项）。
- **MILP Scheduling Solver 接入（NO-13i，ADR-058，R-79，§8/§9/§31/§33）**：
  - `milp-scheduling-solver.ts`（HiGHS 1.15.2 WASM 真实 MILP 求解器，
    MIT，进程内无外部服务依赖；`highs` npm 依赖无传递依赖）——§8
    求解器阶梯第 4 类落地（CP-SAT / heuristic / rule-based / MILP）；
  - 语义（ADR-058 决策 1，§9 差异边界显式）：共享 CandidateEngine
    候选面（§31）→ 二元变量 + 联合行（每任务至多一候选 / 人员·设备
    重叠互斥 / 工位窗口容量（capacity K 大 M 线性化）/ DAG 闭包与
    时序冲突对）；目标 = 与 heuristic 同一 per-candidate 加性评分 +
    M·未分配罚（M=1+⌈Σcost⌉ 可证明"先最大化分配数、再最小化成本"）；
    heuristic=顺序贪心 vs MILP=联合精确最优（唯一差异边界）；
  - `solver.service` 路由 `policy.solverVersion='milp-v1'` 显式选择
    （不参与 CP-SAT 激活阶梯、无隐式回退；solverActivation.state=
    'MILP' 如实标记，SolverActivationState 联合 additive）；
    solverVersion='milp-v1' + solverStatus='OPTIMAL' 如实标记；
    HiGHS 非 Optimal/加载失败显式抛出（§33 不静默降级）；
  - 测试：milp-scheduling-solver.spec 9 例（真实 HiGHS 求解：最优性
    vs 穷举 / 容量冲突 / DAG 闭包·时序 / 工位容量互斥 / 重放
    deep-equal / 空任务 / WASM 失败显式抛出）；default jest
    263→264 suites 1930→**1939** tests；
  - OPEN-DECISIONS MILP 环境阻塞解除（ADR-053 决策 3 再评估）；剩余
    缺口 = CP-SAT 生产启用（部署环境，OPEN-DECISIONS 唯一项）；
    solver-pluggability 矩阵保持 Partial（§36 口径不提前升级）。
- **Plan Approval Decision 接线（NO-13h，ADR-057，R-78，§12/§18/§33）**：
  - `projectPlanApprovalDecision`：Decision Catalog kind #2——
    decisionId=`decision:<planId>:approval:v<version>` 确定性幂等；
    kind=plan_approval / authority=human + approver 判定事实 /
    riskLevel='high'（类型推导规则锁测试）/ requiresApproval=false
    （本决策即审批事实）/ selected.reason=审批理由（缺省结果动作词）；
  - `approvePlan` / `rejectPlan` 台账追加：审批决策以契约形态追加进
    `decision_records_json`（读-追加-回写 CAS；投影缺口/失败 log 显式
    绝不阻断审批主流程，§2 人审门语义不变）；getPlan 读回自动携带；
  - 测试：decision-projection.spec +3 例 + plan-decision-persistence
    .spec +2 例（approve 追加既有保留 / reject 追加）；
  - Decision Catalog kind #2 接线（§12 Decision History 覆盖求解提议
    + 人审结果全链；其余 6 类后续逐类收敛）；无 DB/OpenAPI/env 变更。
- **经验时长统计模型 + 模型重训/激活闭环（NO-13g，ADR-056，R-77，§10/§12/§33）**：
  - `empirical-duration-model`：真实执行反馈 → 非参数经验分布（median/p90
    最近秩百分位/count/spread；确定性可重放）；置信度由样本量与离散度
    真实推导（0.1..0.95）；样本 < 5 → `not_enough_data` 显式 OOD；
  - `EmpiricalDurationPredictionProvider` 替换 PREDICTION_PROVIDER
    （shadow-only 边界不变）：任务自带时长 = 任务级真实事实 → 确定性
    路径；已训练 → median + ml 来源 + 真实置信度；未训练 → 显式回退
    确定性基线（§33 绝不静默）；
  - `DurationModelTrainingService` 唯一权威写路径：真实反馈 → 训练 →
    `ewoh_model_registry` 落版（版本 = 既有最大数字版本 + 1，旧 active
    supersede）+ 内存刷新；冷启动 `hydrateFromRegistry` 回填；
    POST /api/scheduler/predictions/task-duration/retrain 显式触发
    （OpenAPI 397/588 零漂移）；
  - 测试：empirical-duration-prediction.spec 8 例 + duration-model-
    training.service.spec 5 例；default jest 261→263 suites
    1912→**1925** tests；无 DB/env 变更；
  - intelligence-l7-learning §36 升 **Implemented**（矩阵
    53/2/0/1→54/1/0/1——L7 四腿闭环：决策→结果 / 策略阈值 / Outcome
    标注 / 模型重训激活全部落地）；per-taskType 分组与跨租户训练政策
    为后续（显式边界）。
- **Console 手动主题切换 + 页面渲染测试补强（NO-13f，ADR-055，R-76，§17/§31/§33）**：
  - 主题偏好单一事实源（contrastMode：ThemePreference=system/dark/light，
    localStorage `ewoh.theme`——system 移除键显式默认；三态循环
    system→dark→light→system 纯函数锁定）；index.tsx 启动偏好感知
    （system 时媒体变化才重放，manual 忽略媒体变化）；
  - `ThemeToggle` 组件（图标+文字双重表达）+ Layout 侧栏接线——
    手动主题切换闭环（偏好持久化 + data-theme 即时同步）；
  - 页面渲染 smoke 补强：ThemeToggle 3 例 + Forbidden/NotFound 静态页
    2 例（MemoryRouter + auth mock）；client jest 115→117 suites
    952→**962** tests；walkthrough 三项缺口全部关闭——
    factory-operating-console §36 升 **Implemented**（矩阵
    52/3/0/1→53/2/0/1）；无 DB/OpenAPI/env 变更。
- **Factory Operating Console 深化（NO-13e，ADR-054，R-75，§17/§33）**：
  - 视口 culling 生产接线：`worldBoundsFromTransform` 变换数学纯函数
    （xMidYMid meet 居中偏移 + pan/zoom 屏幕↔世界映射；非法输入
    fail-safe 全量渲染）；FactoryMap `onTransform` 上报 +
    `onVisibleBoundsChange`（lastBounds 等值守卫防渲染循环）；
    CommandMapShell → store `viewport.visibleBounds` 唯一写点——
    pan/zoom → 世界可视范围 → 实体剔除进入生产调用链（此前纯函数/
    消费面/store 全备唯缺生产者断点）；
  - 深色模式半成品收口：index.tsx 启动 `applyDarkClass` +
    prefers-color-scheme 监听（tokens.css 暗色令牌生效，系统偏好跟随）；
  - 页面级渲染 smoke：MapViewport.render.test 3 例（模式分支/叠加层/
    接线面，renderToStaticMarkup 同栈）+ viewportCulling 变换数学
    5 例；client jest 114→115 suites 944→**952** tests；
  - factory-operating-console 证据深化（矩阵保持 Partial：手动主题
    切换 + 更广页面渲染覆盖为后续）；无 DB/OpenAPI/env 变更。
- **Rule-based Scheduling Solver（NO-13d，ADR-053，R-74，§8/§9/§18/§31/§33）**：
  - `rule-based-scheduling-solver.ts`：求解器插拔阶梯第 3 类——确定性
    L1 地板（任务序 due 升序→priority 降序→id 字典序 + first-eligible
    纯规则；共享 CandidateEngine 硬约束语义 §31；**不做软成本 argmin**
    （与 heuristic 8 权重优化的差异边界显式）；无可行/前置未就绪 →
    `UNASSIGNED_RULE_BASED` 显式（§33 不伪造分配）；统一评估器
    （P0-5）；status=shadow / solverStatus=`RULE_BASED` /
    solverVersion=`rule-based-v1` 如实标记（绝不冒充 heuristic/CP-SAT）；
  - 策略显式选择：`policy.solverVersion='rule-based-v1'` → solver.service
    路由（无隐式自动回退）；SolverStatus/SolverActivationState additive
    +RULE_BASED；
  - `rule-based-scheduling-solver.spec` 7 例（确定性重放 deep-equal /
    任务序 / priority tie-break / first-eligible+rejectedHard / DAG 前置
    UNASSIGNED / lockedAssignments 透传 / routeCost 映射）；
  - solver-pluggability 证据深化（矩阵保持 Partial：MILP 环境阻塞 +
    CP-SAT 生产启用待部署环境）；无 DB/OpenAPI/env 变更。
- **Canonical Exo Configuration Model 契约层（NO-13b，ADR-051，R-72，§3/§7/§33）**：
  - `contracts/exo/exo-config.schema.json` + `exo-config.test-vectors.json`
    （22 向量）：§7 Support Mode / Assist Profile / Fit / Calibration
    跨运行时契约——kind 封闭注册表（assist_profile/fit/calibration）；
    supportMode 封闭 8 类 v1 目录（vendor_specific 显式桶：
    vendorModeName 必填，未知厂商模式绝不静默改写）；calibrationKind
    封闭（zeroing/load_cell/imu）；status 按 kind 封闭；
  - 判定事实完整：assist_profile 必带 supportMode + effectiveFrom +
    superseded 必带 supersededBy + assistLevel∈[0,1]；fit 必带
    personId（person:）+ fittedAt + fitter；calibration 必带
    calibrationKind + result + calibratedAt/calibratedBy；时间不倒退；
    configId 前缀 `exo-config:` / exoId `device:` / tenantId 必填 /
    auditTrail 非空强制；
  - Python/TS 双实现锁步（`src/edge_platform/contracts/exo_config.py` +
    `ewoh-spark-app/shared/exo-config.ts`）；audit-domain-contracts
    exo-config 域独立 JS 仲裁 545→**581/581**；Golden 第 25 场景
    `exo_config_contract`（9 案例双执行器）；本机 pytest 23 例 +
    jest 8 例；
  - 台账（standalone_051）+ 边缘 Support Mode 观测 = NO-13c（§30
    先修契约再修实现；exoskeleton-domain-model 保持 Partial）；
    无 DB/OpenAPI/env 变更。
- **Exo Configuration 台账与写路径接线（NO-13c，ADR-052，R-73，§5/§7/§15）**：
  - `ewoh_exo_config` 台账（standalone_051，TENANT_SCOPED + RLS
    exo_config_org_isolation + 唯一 (org_id, config_id) + kind/status
    按 kind/support_mode/profile·fit·calibration 判定事实/时间 CHECK）；
    record_json = ADR-051 契约形态全量留痕；
  - `ExoConfigService` 唯一权威写路径：record（validateExoConfig 契约门
    fail-closed → 幂等（同 org+configId 返回既有行）→ insert + audit +
    目录事件 ExoConfigRecorded）；activateProfile（同 (org, exo, mode)
    既有 active CAS→superseded（supersededBy=新 id）→ 新 active）；
    list/get 租户作用域（§15）；
  - API：POST /api/exo/configs + GET /api/exo/configs + GET
    /api/exo/configs/:id + POST /api/exo/configs/:id/activate（OpenAPI
    再生成，路由审计零漂移）；事件目录 64→65（ExoConfigRecorded +
    channel exo.config_recorded + 双投影锁步）；
  - 边缘 Support Mode 自动观测 = NO-13d（NY-EXO-A1 协议 2.3 无 mode
    字节，§33 不伪造观测——显式边界）；exoskeleton-domain-model §36
    全绿升 **Implemented**（矩阵 51/4/0/1→52/3/0/1）；
  - 全 lockstep：迁移 + 回滚 + verify（10 自证拒绝 + 控制组）+ runner
    dispatch/verify handler/rollback 链 + CI 专属步骤 + check.sh 成对
    回滚 + state.json verification_state + **受管表 73 → 74**、
    verify 列表 67→68、reconcile spec 74、release-manifest gate 74。
- **执行反馈完成腿（NO-13a，ADR-050，R-71，§5/§20/§21/§33）**：
  - `recordActuals` 回填真实执行事实后追加状态推进：assignment
    dispatched→executing（actualStart）/ {dispatched,executing}→completed
    （actualEnd）——CAS 幂等 + `ewohAssignmentEvent` 事件留痕；
    task 经 `taskActionPath`（task.yaml 锁步图 BFS 最短合法链）逐动作
    `transitionTaskState`（每步 CAS + 审计）；
  - 边界显式：start 源集 assignment={dispatched}·task={dispatched,
    received}；end 源集 assignment={dispatched,executing}·task=
    {executing,received,paused}；exception 不隐式 resolve（dispatcher
    显式动作）；pending_dispatch 不收 start（乱序 skip+log）；终态
    no-op；无 start 观测时 dispatched→completed 单事件（不伪造中间态）；
  - 推进 summary additive 透出（advancedAssignments/advancedTaskSteps/
    skips）——失败只 log 不阻断反馈写入（§33 不吞异常）；
  - canonical-execution-model §36 全绿升 **Implemented**（矩阵
    50/5/0/1→51/4/0/1）；无 DB/OpenAPI/env 变更。
- **Canonical Execution Model 语义审计 + 跨运行时锁步（NO-12z，ADR-049，R-70，§3/§9/§31）**：
  - §9 审计确认 R-3 遗留已收口（边缘 ADR-029 task↔assignment 双向同步 +
    云侧 dispatch→transitionTaskState('dispatch')）；审计结论入档；
  - TS 任务状态机数据化为 `TASK_ACTIONS` / `TASK_NON_TERMINAL` /
    `TASK_TERMINAL` 契约消费面（行为逐字一致，task.service.spec 回归绿）；
  - 新增 `task-state-machine-contract.spec`（7 例）：task.yaml 逐条比对
    （无缺失/无契约外转换）+ 11 状态 × 14 动作穷举负例 + 检查器负测试
    + task-lifecycle 分类集合锁步——TS↔契约漂移构建期显式暴露
    （与 Python contract-state-machine 门禁同纪律）；
  - 三套执行词汇表（task 11 态 / AssignmentStatus 9 态 / execution
    词汇表）差异边界显式声明；执行反馈完成腿 NO-13a 立项
    （canonical-execution-model 保持 Partial）；
  - walkthrough R-3 行复核更正；无 DB/OpenAPI/env 变更。
- **Decision 契约生产投影接线（NO-12y，ADR-048，R-69，§3/§12/§18/§33）**：
  - `decision-projection.ts` 纯模块：DecisionTrace→DecisionRecord
    （ADR-047 契约形态）唯一投影点——kind=task_assignment / status=
    proposed / authority=optimization；decisionId 确定性幂等
    （`decision:<planId>:<taskId>`）；options←candidates（optionId 组合
    确定性推导；baseline reuse 快速路径 selected 补入保契约不变式）；
    selected.reason 非空过滤（空→显式缺口）；rejectedAlternatives←
    rejectedAlternatives+rejectedHard（空原因跳过，绝不伪造）；
  - riskLevel 映射自真实 route-graph 风险事实（high→high /
    medium→medium / null→low——null=路径无被标记高/中风险边，
    确定性映射锁测试，§33 非伪造）；requiresApproval=true 恒真
    （task_assignment 提议必经方案审批，§2 人审留痕）；
  - `persistPlan` 唯一投影点：生成记录必过 `validateDecision`（共享
    契约实现 §31）；缺口显式计数 `decisionProjectionIssues`
    （decision_tenant_unknown / decision_no_selected_reason /
    decision_no_trace / decision_invalid:<code>）——绝不静默丢弃；
  - standalone_050：`ewoh_schedule_plan` += `decision_records_json`
    JSONB（既有受管表原地加固，计数不变 73/76；runner/check script/
    CI/state.json/schema-manifest 全 lockstep）；persist→getPlan 读回
    一致；canonical-decision-model §36 全绿升 **Implemented**
    （矩阵 49/6/0/1→50/5/0/1）；
  - 测试：decision-projection.spec 7 例 + plan-decision-persistence
    .spec 3 例；无 OpenAPI/env 变更。
- **Canonical Decision Model 契约层（NO-12x，ADR-047，R-68，§2/§3/§18/§24）**：
  - `contracts/decision/decision.schema.json` + `decision.test-vectors.json`
    （23 向量）：Decision Catalog v1 封闭注册表（kind 8 类 / status 5 态 /
    decisionAuthority 5 类）；riskLevel 复用 risk 契约 SEVERITY_LADDER
    （§31 单一事实源，仲裁逐位比对）；
  - 判定事实完整：decisionId 规范前缀 `decision:` / subject 规范身份 /
    tenantId 必填 / requiresApproval 显式布尔 / selected.reason 非空强制 /
    selected∈options / options 内 optionId 唯一 / human 决策或
    approved·rejected 状态必带 approver / approver.at≥decidedAt /
    auditTrail 非空强制（actor 规范身份 + action 非空 + at ISO）；
  - Python/TS 双实现锁步（`src/edge_platform/contracts/decision.py` +
    `ewoh-spark-app/shared/decision.ts`）；audit-domain-contracts decision
    域独立 JS 仲裁 511→**545/545**；Golden 第 24 场景 `decision_contract`
    （9 案例双执行器）；本机 pytest 25 例 + jest 10 例；
  - DecisionTrace→DecisionRecord 生产投影为下一轮（NO-12y，§30 先修
    契约再修实现）；无 DB/OpenAPI/env 变更。
- **邮件 STARTTLS 升级（NO-12w，ADR-046，R-67，§20/§33）**：
  - SMTP 客户端机会式 STARTTLS（RFC 3207 子集）：凭据 + 明文 →
    STARTTLS（期望 220）→ `tls.connect({socket, servername})` 升级
    （secureConnect 等待 + 10s 超时）→ 重新 EHLO → AUTH LOGIN；
  - 服务器不支持（502）→ `smtp_auth_requires_tls`（与 v1 错误码
    兼容，客户端重试语义不变）；升级失败 → `smtp_starttls_failed`
    显式；无凭据明文不发起 STARTTLS（内网中继路径不变）；
  - 凭据安全不变式延续（AUTH 仅 TLS 后，绝不明文传凭据）；无新
    env 键（`EWOH_SMTP_SECURE=1` 隐式 TLS 语义保留）；
  - email-transport.spec 10→12 例（+STARTTLS 升级序 / 502 拒绝 /
    无凭据不发起）；default jest 250 suites / 1856 tests 全绿。
- **Record 化匹配收敛（NO-12v，ADR-045，R-66，§3/§30/§31）**：
  - capability-projection 增补 5 纯函数（capabilityNames /
    personSkillNames / deviceCapabilityNames / stationCapabilityNames /
    personCertificationExpiryMap——契约形态优先 + legacy 直呼同源投影
    回退，§31 单一语义）；
  - eligibility 技能/设备能力/工位能力匹配 + 证书到期事实改读契约
    形态（证书存在性保持 raw——certification 记录缺 issuer/expiry 被
    契约缺口丢弃是显式特性，改按记录存在性会改变语义）；求解器
    personBySkill/deviceByCapability 预筛索引 + candidate-engine/
    solver 上下文 stationCapabilityRecordsById 同步收敛；
  - 等价断言锁定（records 与 raw 语义逐字一致）；capability-projection
    .spec 14 例；default jest 250 suites / 1854 tests 全绿；
  - canonical-capability-model 证据深化（矩阵计数不变 49/6/0/1）。
- **Capability 契约消费方投影接线（NO-12u，ADR-044，R-65，§3/§30/§33）**：
  - `capability-projection.ts` 纯模块：人员技能/认证、设备能力、工位
    能力 → Canonical CapabilityRecord（ADR-043 契约）；certification
    缺到期事实 → `certification_missing_expiry` 显式缺口、数据源无
    issuer → 契约门拒绝后 `certification_missing_issuer` 显式缺口
    （绝不伪造，§33）、违规记录 `projection_invalid` 显式计数；
  - `buildSnapshot` 唯一投影点：WorldStateSnapshot 实体 +=
    `capabilityRecords` + 顶层 `capabilityProjectionIssues`（additive，
    世界契约自检不受影响）；能力事实首次以契约形态进入生产调用链；
  - 测试：capability-projection.spec 8 例；default jest 250 suites /
    1848 tests、client jest 114 suites / 944 tests 全绿；
  - canonical-capability-model 证据深化（矩阵计数不变 49/6/0/1）。
- **Canonical Capability Model 契约（NO-12t，ADR-043，R-64，§3/§4）**：
  - `contracts/capability/`（schema + 13 条共享向量）：CapabilityRecord
    ——kind（5 类）/providerType（7 类）封闭注册表 + name 开放词表
    （knownValues 平台已知值登记）+ certification issuer/expiresAt
    判定事实完整 + 时间不倒退 + subject 规范身份形状 + auditTrail 强制；
  - Python（`edge_platform/contracts/capability.py`）/ TS（`shared/
    capability.ts` + 8 例 spec）双实现语义逐项一致；audit-domain-contracts
    capability 域（**493→511/511**：schema 形状 + rules 实例 + 13 向量
    JS 仲裁 + 3 注册表跨语言锁步）；Golden 第 23 场景（7 案例双执行器）
    + pytest `test_capability_contract.py`（14 例）；
  - canonical-capability-model 升 Implemented（矩阵 **49/6/0/1**）；
    既有消费方（人员技能/认证、设备能力匹配、工位能力匹配）向契约
    逐点接线为后续轮次（§30 先契约后实现）。
- **审批前自动布局仿真预验证（NO-12s，ADR-042，R-63，§8/§13/§18）**：
  - `pre-approval-simulation.ts` 纯函数：方案分配 + 快照工位坐标 →
    人员移动图（按人分组 / plannedStart 排序 / 相邻异工位 = trips=1 边；
    缺 plannedStart/personId/stationId 与坐标 null 显式跳过计数，不伪造）；
  - `PlanService.approvePlan` 硬守卫通过后自动运行 layout 仿真
    （runId 确定性 `plan-approval:<planId>` 台账幂等；scenarioId=
    `plan:<planId>`）——结果入审批审计 `after.preApprovalSimulation` +
    `getPlan` 附 `preApprovalSimulation` 字段（台账回读），求解器
    walkingMeters 的独立确定性交叉可审计；
  - advisory 语义：仿真失败/未装配/无移动链 → error/skippedReason
    显式留痕，**绝不阻断审批**（§2 人工决策门）；SchedulingPlanV2
    加可选字段（additive）；scheduler.module += SimulationModule；
  - 测试：推导 7 例 + 服务接线 3 例；default jest 250 suites /
    1831 tests、client jest 114 suites / 944 tests 全绿；
  - intelligence-l6-simulation 证据深化（矩阵计数不变 48/7/0/1）。
- **邮件推送渠道（NO-12r，ADR-041，R-62，andon-loop 收口，§17/§20/§33）**：
  - `email-transport.ts` 标准库最小 SMTP 客户端（RFC 5321 子集：EHLO /
    AUTH LOGIN / MAIL FROM / RCPT TO / DATA+dot-stuffing / QUIT + 多行
    回复 + 10s 超时，无新依赖）；传输形态显式：无凭据=明文（内网中继）、
    带凭据必须 `EWOH_SMTP_SECURE=1` 隐式 TLS（非 TLS+凭据 →
    `smtp_auth_requires_tls` 绝不明文传凭据；STARTTLS 升级为后续演进）；
  - 派发器渠道注册表 `PUSH_CHANNELS=['lark','email']`（按启用集动态
    领取 + 逐行分派 + 单行失败独立）；`insertAndonNotifications` 三渠道
    同语义（app/lark/email，oee+ingest 共用 §31）；通知中心渠道标签
    += 邮件；env 7 键（env-inventory 117→124 PASS）；
  - 测试：email-transport 10 例 + dispatcher +3 例 + oee +1 例 +
    client 标签；default jest 248 suites / 1821 tests、client jest
    114 suites / 944 tests 全绿；
  - andon-loop 按 §36 升 Implemented（矩阵 **48/7/0/1**）。
- **边缘 AndonRaised 上行（NO-12q，ADR-040，R-61，§3/§6）**：
  - 边缘一等开灯 API `POST /api/andon/raise`（device: 规范身份 + 标题必填 +
    severity 封闭词表 + slaSeconds 校验 fail-closed；AndonRaised Catalog
    信封 source=edge:andon 经 STREAM_EVENTS → EventUplink 离线续传上行）；
  - 云侧 ingest 将边缘 AndonRaised 投影为 canonical andon evidence 形状
    （eventCode=ANDON / severity=normalizeEventSeverity / andonId /
    slaMinutes / escalationLevel / timeline——与 oee.openAndon 同形状，
    listAndons/transitionAndon/SLA 升级统一消费）+ 开灯通知经共享助手
    `insertAndonNotifications`（oee 与 ingest 共用，§31）；
  - 修复 registry POST 分发缺口（exo 绑定 API 从未经 HTTP 分发，直接
    handler 测试掩盖）+ dispatch 级回归锁定；测试：edge 9 例
    （unittest 954→963 OK）+ ingest +3 例（default jest 248 suites /
    1807 tests 全绿）；
  - andon-loop 缺口收窄为邮件 SMTP 渠道（矩阵计数不变 47/8/0/1）。
- **Agent 审批跨重启持久化（NO-12p，ADR-039，standalone_049，§11/§20）**：
  - `ewoh_agent_approval` 台账（TENANT_SCOPED + RLS agent_approval_org_isolation +
    唯一 (org_id, approval_id) + status/resolved/roles CHECK）——Agent 待批
    命令从进程内存迁至台账（ADR-030 决策 4 边界收口）：propose 落 pending、
    resolve 经 CAS 写 approved/rejected/expired + resolved_at/resolved_by/
    resolution_json（重复解析显式拒绝，§20）；待批清单/解析全部台账读，
    进程重启后审批不消失不失效（新服务实例解析既有待批已 spec 实证）；
  - 全 lockstep：迁移 + 回滚 + verify（4 自证拒绝 + 控制组）+ runner
    dispatch/verify handler/rollback 链 + CI 专属步骤 + check.sh 成对回滚 +
    state.json verification_state + **受管表 72 → 73**、verify 列表 66→67、
    reconcile spec 73；
  - AgentService 移除 ApprovalModule 内存状态机依赖（agent-policy-approval
    已知边界消除，矩阵计数不变 47/8/0/1）。
- **Shadow Plan 隔离 DB 纵深防御（NO-12o，ADR-038，standalone_048，§13）**：
  - `ewoh_schedule_plan` 新增 CHECK `chk_ewoh_schedule_plan_shadow_not_production`：
    `is_shadow=true` 行禁止生产状态（approved/dispatched/executing/completed
    + 遗留 confirmed/proposed）且禁止确认事实（confirmed_by/confirmed_at）——
    服务层 hard guard 之外的数据库兜底；
  - 全 lockstep：迁移 + 回滚 + verify（5 自证拒绝 + 2 控制组）+ runner
    dispatch/verify handler/rollback 链 + CI 专属步骤 + check.sh 成对回滚 +
    state.json verification_state + schema-manifest 原地加固注记
    （受管表计数 72 不变——既有表原地加固，无新表）；
  - simulation-production-isolation 升 Implemented（矩阵 **47/8/0/1**）。
- **Andon 通知推送渠道（NO-12n，ADR-037，R-58，§15/§17/§20）**：
  - `channel-dispatcher.service`：封闭渠道注册表 `PUSH_CHANNELS=['lark']`
    （只注册有真实投递实现的渠道，§33）+ 飞书自定义机器人 webhook 真实
    投递（fetch POST / 5s 超时 / 非 2xx 显式抛错）+ 15s 派发 tick 领取
    pending 推送行 CAS 写回 sent/failed（多实例防重复投递）+ 未配置
    webhook = 渠道显式禁用（不建 doomed 行）；
  - `POST /api/notifications/:id/retry` 人工重试（failed → pending；
    dispatcher/workshop_lead/global_admin；app 通知/非 failed 显式拒绝）；
  - oee `openAndon` + SLA 升级双触发点入通知（app 恒建 + lark 配置时建）
    + **§15 修复通知缺 orgId（孤儿行）**；
  - 审批控制台通知中心「推送状态（飞书）」分组（渠道标签 + 待投递/
    已投递/失败 + 重试按钮）+ `toNotification` 增补 sentAt/errorMessage；
  - env `EWOH_LARK_WEBHOOK_URL` / `EWOH_NOTIFICATION_DISPATCH_INTERVAL_MS`
    （env-inventory 117/118 PASS）；OpenAPI +1 路由 392 零漂移；
  - 测试：dispatcher 11 例 + notification.service +5 例 + oee +2 例 +
    client 通知逻辑 +4 例；default jest 248 suites / 1802 tests 全绿、
    client jest 114 suites / 944 tests 全绿；
  - andon-loop 缺口收窄为邮件渠道（SMTP）+ 边缘 AndonRaised 上行。
- **仿真运行控制台（NO-12m，ADR-036，L6 生产消费面，§10/§13/§17）**：
  - `/simulation` 页面（决策支持组，dispatcher/workshop_lead/global_admin）：
    四类确定性评估器运行面板（What-if / 产能 / 布局 / 物料流）+ 基准快照
    引用 + 参数 JSON 编辑（示例模板预填）+ 本租户台账 30s 轮询 + 详情 /
    原始参数；
  - 纯逻辑 `simulationConsoleLogic`：四类参数预检（镜像评估器输入契约，
    服务端仍权威 fail-closed）+ 结果摘要（字段缺失显式 '—'、未知 kind
    原样透出）+ 运行列表行（状态文案/语调/失败理由头条）；18 例 node 测试；
  - `api/simulation.ts`（POST/GET /api/simulation/runs）+ queryKeys +
    导航/路由注册；client jest 113→114 suites / 923→941 tests；
  - intelligence-l6-simulation 升 Implemented（矩阵 **46/9/0/1**）。
  - 无 DB/契约/服务端变更（复用 ADR-025 SimulationRun 全资产）。
- **地图端执行偏差图层（NO-12k，ADR-035，R-6 收口，§17/§37）**：
  - 纯 VM `executionDeviationMapVM`（executions + 快照坐标 → 地图视图：
    deviated=deviationType 非空（含终态历史可见）/ ontrack=无偏差进行中；
    计划点=任务工位（回退 execution.stationId）、实际点=执行人当前位置
    （回退设备）；坐标缺失显式 null + missingCoordinates 禁止伪坐标；
    delta 按偏差类型取事实对 + 带符号 label；未知 deviationType 原样
    透出（§33 不静默））；13 例 node 测试。
  - `ExecutionDeviationLayer`（多通道视觉：空心方框=计划 / 实心圆点=
    实际 / 虚线=偏差 / 实线=进行中 + 偏差徽标 + title 全事实）；
  - executions 入 CommandMapAggregate（30s 轮询 enabled=有选中方案，
    React Query 与列表面板同缓存；executionsError 显式错误提示）；
  - `CommandMapLayer` += execution-deviation + `toggleLayer` 纯函数 +
    地图视口桌面端图层开关 chip 组（activeLayers 首次生产可操作）。
  - logistics-task-loop / closed-loop-execution-feedback 升 Implemented
    （矩阵 **45/10/0/1**）；无 DB/契约变更（纯 UI/VM 投影层）。
- **Outcome 标注面（NO-12j，ADR-034，§10 Level 7 模型腿前置）**：
  - `contracts/learning/outcome-annotation.schema.json` + 共享向量
    （8 条：targetType/outcomeKind 封闭注册表 + judgedBy/judgedAt 判定
    事实完整 + measured 有限数值（缺省=显式不携带）；Python/TS 双实现 +
    门禁 outcome_annotation 域（**493/493**）+ Golden 第 22 场景。
  - standalone_047 `ewoh_outcome_annotation`（TENANT_SCOPED RLS +
    target/kind/judger CHECK + 唯一 (org_id, annotation_id)；全 lockstep：
    受管表 71 → 72、verify 列表 65→66、回滚链、CI、state.json）。
  - 云侧 OutcomeAnnotationService（create 契约 fail-closed + annotationId
    幂等回读 / listByTarget / listRecent org 作用域）+ 目录事件
    OutcomeAnnotationRecorded（**63→64**）+ OpenAPI 3 路由 391 零漂移。
  - modelAccuracy 保持显式 unknown 直至真实可训练模型 + 最小样本门槛
    （§33 不造假——模型重训闭环随真实模型落地后立项）。
  - intelligence-l7-learning 缺口收窄为模型重训/激活（矩阵 44/11/0/1）。
- **边缘绑定事实→云 ExoSession 台账端到端（NO-12i，ADR-033，§7 收口）**：
  - 边缘一等绑定 API：`exo_binding` 存储表 + `POST /api/exo/bind|unbind`
    （规范身份 fail-closed / 活跃绑定唯一冲突显式 / 状态机 + ended_by
    必填）；6 例 unittest；
  - 绑定事实经既有事件骨干上行（ExoSessionStarted/Ended Catalog 信封 →
    EventUplink at-least-once 断点续传，无第二上传路径）；
  - 云侧 ingest 投影：ExoSessionService 应用层幂等（同 sessionId start
    回读 / 重复 end 原样返回；投影失败显式留痕不阻断事件主事实）；
    目录 payload 增补 startedAt/endedBy/actualEndAt（additive）；
  - worker-exoskeleton-loop 按 §36 升 Implemented（矩阵 **44/11/0/1**）。
- **外骨骼↔人员 Session 域模型（NO-12h，ADR-032，§7 一等实体绑定）**：
  - `contracts/exo/exo-session.schema.json` + 共享向量（9 条：status 状态机
    active→ended/aborted 终态 + 规范身份 device:/person: + 结束事实完整 +
    时间不倒退 + auditTrail）；Python/TS 双实现 + 门禁 exo 域
    （**479/479**）+ Golden 第 21 场景。
  - standalone_046 `ewoh_exo_session`（TENANT_SCOPED RLS + 部分唯一索引
    (org_id, exo_id) WHERE status=active——**一台外骨骼同时一个活跃会话
    机器强制** + 四类 CHECK；全 lockstep：
    受管表 70 → 71、verify 列表 64→65、回滚链、CI、state.json）。
  - 云侧 ExoSessionService（start 契约 fail-closed + 活跃冲突显式 /
    end/abort 状态机 + endedBy 必填 + list org 作用域）+ 目录事件
    ExoSessionStarted/Ended（**61→63**）+ OpenAPI 5 路由 388 零漂移。
  - worker-exoskeleton-loop 缺口收窄为边缘上行贯通（矩阵 43/12/0/1）。
- **Andon Loop 贯通（NO-12g，ADR-031，§6 Phase 6 Andon Loop）**：
  - 状态机单一事实源：`contracts/state-machines/alert.yaml` →
    `shared/alert-state-machine.ts` 锁定表 + 门禁
    `alert_state_machine_ts_vs_yaml`（**465→466/466**）；alert/andon
    双面复用（消除两份手写 switch，§31）；reopen 仅 safety_admin
    角色条件机器执行；
  - `AndonRaised` 目录事件真实产出（OEE openAndon：canonical
    eventType + envelope 嵌入 + level=规范词表 + slaMinutes 派生）；
    历史 'andon' 行查询侧过渡兼容；
  - shared/alert-state-machine.spec 7 例；oee spec 8 例（+AndonRaised
    产出 + reopen 角色强制）。
  - andon-loop 缺口收窄为通知推送渠道 + 边缘上行（矩阵 43/12/0/1）。
- **客户端审批控制台（NO-12f 收口，ADR-030 延续，§17 "是否批准？"）**：
  - `/approval-console` 页面：Agent 命令审批批准/驳回（过期显式禁用操作，
    §33）+ 调度审批展开详情按 pending step 批准/驳回（stepAction 真实
    闭环）+ 通知中心未读列表/标记已读（通知读写消费面）；
  - `src/api/approvals.ts`（6 API 函数）+ 纯逻辑 4 例（剩余时间格式化/
    两清单合并排序/过期显式禁用/通知分组）；
  - 路由 + 导航注册（dispatcher/workshop_lead/global_admin）；
  - client jest 110→**111 suites / 898→902 tests**；client tsc PASS。
  - agent-policy-approval 按 §36 升 Implemented（矩阵 **43/12/0/1**；
    已知边界=Agent 审批 pendingCommands 进程内存，ADR-030 决策 4）。
- **Agent 审批交互面（NO-12f，ADR-030，§17 人工审批闭环交互面）**：
  - 统一待批清单：`GET /api/approvals/pending`（调度审批持久化清单）+ 
    `GET /api/agents/approvals`（Agent 命令审批清单，过期显式标记绝不
    静默消失，§33）；
  - 通知闭环：审批创建即插 `ewoh_notification`（role 通知，externalRef=
    approvalId 可追溯）+ 新 Notification 模块（`GET /api/notifications`
    租户+角色作用域（无角色 fail-closed 不猜）/ `POST /api/notifications/
    :id/read` 幂等乐观已读）；ewoh_notification drizzle 补 org_id 映射；
  - 审批角色配置化：`EWOH_AGENT_APPROVAL_ROLES`（逗号分隔，默认
    workshop_lead；env-inventory 115/116 PASS）；
  - OEE 安灯通知 severity 'L2'→'high'（ADR-027 词表收口补漏）；
  - OpenAPI +4 路由 **383 零漂移**；agent.service.spec 21→24、
    notification.service.spec 5 例。
  - agent-policy-approval 缺口收窄为客户端审批 UI（矩阵计数不变）。
- **边缘任务↔派工状态机同步（NO-12e，ADR-029，R-3 收口，§3 任务事实单一化）**：
  - `execute()` 派工落账后同步推进 Task（pending_dispatch→dispatched，
    乐观锁 + TASK_TRANSITIONS 状态机校验 + 幂等跳过 + 任务缺失显式跳过）；
  - `update_task()` 推进任务 → 其派工沿同一状态机收敛（最短合法链补全，
    不回调任务防递归）；`set_assignment_status` 重构为共享转换器
    `_apply_assignment_transition`（消除内联重复）；
  - 同步失败显式留痕绝不静默（ADR-029 决策 4）；7 例新回归
    （test_task_assignment_sync）+ edge unittest **941→948**；
  - R-3 风险闭合（CR-EDGE-HYDRATE-COMPLETENESS）；logistics-task-loop
    缺口收窄为地图端偏差图层（矩阵计数不变）。
- **Edge→Cloud 指标上行（NO-12d，ADR-028，§19 观测腿补全）**：
  - 边缘 ewoh_* 18 家族入规范注册表（**15→33 家族**，labelKeys +=
    table/edge_id，connector_active_total += connector_id）——命名收敛
    不重命名（单一事实源，重命名会破坏本地 Prometheus 消费方）；
  - 边缘 `MetricsUplink`（周期快照 → 规范样本批次 POST
    /api/observability/edge-metrics；与 EventUplink 显式差异边界：指标
    为 latest-wins 快照不建磁盘队列，失败显式 logging/stats + 指数退避，
    exporter METRIC_DEFS 单一映射源）+ 8 例 unittest + 5 项 env 配置
    （env-inventory 114/115 PASS）；
  - 云侧 `EdgeMetricsService`（逐条 validateMetricSample fail-closed
    违规显式、per-org 有界 TTL 快照注册表、IngestGuard 机器通道）+
    导出面 org 作用域 + 上行健康 connector_* 家族计数（无新事件类型——
    指标批次非工业事实）；spec 7 例；
  - OpenAPI +1 路由 **379 零漂移**；Golden metrics 场景 +3 边缘案例
    （11 案例双执行器）。
  - observability 证据深化（矩阵计数不变）。
- **云侧严重度词表收敛（NO-02c-b，ADR-027，§3 Factory Truth 接线）**：
  - 同一 severity 列两套相反词表（边缘 L1=最严重 vs 云 UI L3=最严重）→
    唯一词表 Canonical Risk Ladder（critical>high>medium>low；无风险判定
    显式 `unknown`，§33 绝不伪装 normal）；
  - 12 个服务写入点按生产者意图逐类确定性迁移（ERP L1/L2→critical/high；
    信息性生命周期事件 L3→low；DeadLetter→medium；ingest 边缘事件→
    unknown；world 时间线标记→low）+ 入口归一化 `normalizeEventSeverity`
    （规范直通/L1-L3 映射/其余显式 unknown，与 `normalizeSeverity`
    fail-closed 分工：域契约校验拒绝、事件事实落账显式标记）；
  - 消费方收敛：priority-engine {critical,high,medium}=risky、supervisor
    critical/high、learning riskOutcomeRate canonical（过渡期 legacy
    UNION 注释兼容存量行）、gamification critical 风暴；
  - 客户端全量收敛：EventCenterPanel 筛选与徽章、Timeline/TimelinePanel
    配色（critical=红/high=橙/medium=黄/low=绿/unknown=灰）、AlertToast
    `aggregateL3`→`aggregateCriticalEvents`、DeviceConfigDrawer、perf fixture。
  - canonical-risk-model 按 §36 升 Implemented（矩阵 43/12/0/1）。
- **持续学习回路反馈腿 v2（NO-12b，ADR-026，§10 Level 7 + §12 反馈腿）**：
  - `contracts/learning/learning-proposal.schema.json` + 共享向量（kind 封闭
    注册表 v1=rule_threshold——只有具备确定性影子评估器的类型才允许注册 +
    thresholdRules 白名单（⊆ reasoning-trace 注册表，门禁交叉校验）+
    影子评估前置（无影子证据的激活在验证层被拒绝）+ 人审激活阶梯
    （approved 必须 approver+时间，§2 绝不隐式自动执行）+ rejected/
    rolled_back 理由强制）；Python/TS 双实现 + 确定性影子评估器
    （历史事实重放 fired 差集 + riskLevel 阶梯）+ 门禁 learning_proposal
    域（**465/465**）+ Golden 第 20 场景（8 契约 + 2 影子评估 + 1 状态机
    执行跨语言仲裁）。
  - standalone_045 `ewoh_learning_proposal`（TENANT_SCOPED RLS + kind/
    status/rule/parameter/values/shadow-gate/approval/rejection/rollback
    CHECK + 唯一 (org_id, proposal_id)；全 lockstep：
    受管表 69 → 70、verify 列表 63→64、回滚链、CI、state.json）。
  - 云侧学习提案运行时（propose 契约 fail-closed + 影子评估落账 +
    shadow/approve/reject/rollback 状态机 + getActiveThresholds 激活面）+
    **真实激活接线**：ReasoningService 评估时应用本租户 approved 提案的
    阈值覆盖（evaluateReasoningRules thresholds 参数，Python/TS 语义
    逐项一致；回滚即回落内置常量）；LearningProposalCreated/Resolved
    目录事件（**61/61**）+ OpenAPI 7 路由 378 零漂移。
  - intelligence-l7-learning 缺口收窄为模型腿（矩阵计数不变）。
- **Digital Twin 仿真体系（NO-12a，ADR-025，§13 数字孪生成体系）**：
  - `contracts/simulation/simulation-run.schema.json` + 共享向量（4 kind /
    4 status 封闭注册表 + isSimulation=true 隔离强制 + baseRef 可追溯 +
    completed/failed 终态契约）；Python/TS 双实现 + 四类确定性评估器
    （what-if 结论差集 / capacity 瓶颈 / layout 行程 / material-flow 载荷）
    + 门禁 simulation 域（**444/444**）+ Golden 第 19 场景。
  - standalone_044 `ewoh_simulation_run`（TENANT_SCOPED RLS + kind/status/
    is_simulation=true 表级 CHECK 隔离（§13 三层强制之 DB 层）+ completed/
    failed CHECK + 唯一 (org_id, run_id)；全 lockstep：
    受管表 68 → 69、verify 列表 62→63、回滚链、CI、state.json）。
  - 云侧 `simulation` 模块（run 契约 fail-closed / 评估器确定性执行 /
    completed|failed 终态落账）；SimulationRunCreated/Completed 目录事件
    （**59/59**）。
  - digital-twin-simulation 按 §36 升 Implemented（矩阵 42/13/0/1）。
- **Dead Letter 体系（NO-11a，ADR-024，§20 Reliability 收口）**：
  - `contracts/reliability/dead-letter.schema.json` + 共享向量（5 reason /
    3 status 封闭注册表 + envelope 快照必填 + 人审重放语义 + discard 理由
    强制）；Python/TS 双实现 + 门禁 reliability 域（**427/427**）+
    Golden 第 18 场景。
  - standalone_043 `ewoh_dead_letter`（TENANT_SCOPED RLS + reason/status/
    attempts/discard CHECK + 唯一 (org_id, letter_id)；全 lockstep：
    受管表 67 → 68、verify 列表 61→62、回滚链、CI、state.json）。
  - 云侧 `reliability` 模块（record 契约 fail-closed / 幂等 / 人审
    requeue（attempts+1，杜绝自动无限重试）/ discard 必带理由）；
    首个生产接线 = ingest 事件上行永久失败（envelope_invalid /
    unknown_event_type fail-closed 拒绝 → 死信）；DeadLetterRecorded
    目录事件（**57/57**）。
  - reliability-hybrid 按 §36 升 Implemented（矩阵 41/14/0/1）。
- **全链路 trace 贯通（NO-10a，ADR-022，§19 Observability trace 腿）**：
  - standalone_042 `ewoh_trace_span`（span 持久化追踪索引：7 天 TTL + 行上限
    bounded；trace_span_org_or_global 可见性策略（org lineage 或全局管理员，
    非 loose）；全 lockstep：受管表 66 → 67、verify 列表 60→61、回滚链、
    CI、state.json）。
  - HTTP traceId = §19 端到端 correlation id：事件信封 correlationId 六类
    规范生产者贯通（workorder/agent/knowledge/inference/reasoning/learning；
    非 HTTP 路径显式 null 绝不伪造）+ 审计 request_id 既有自动关联；
    缝合查询 GET /api/observability/traces/:traceId（spans + events + audit
    三面，§19「从一次用户操作追踪到…」查询面）。
  - Scheduler/Agent/Connector 指标体系留 NO-10b（observability 矩阵保持
    Partial 至指标腿成体系）。
- **持续学习回路 v1（NO-09a，ADR-021，Phase 12）**：
  - `contracts/learning/learning-evaluation.schema.json` + 共享向量（七项指标
    封闭注册表 + null 语义（无数据/显式 unknown，绝不伪造）+ period 契约 +
    basis 非空）；Python/TS 双实现 + 门禁 learning 域（**400/400**）+
    Golden 第 16 场景。
  - standalone_041 `ewoh_learning_evaluation`（TENANT_SCOPED RLS + 唯一
    (org_id, eval_id) + type/period CHECK；全 lockstep：受管表 65 → 66、
    verify 列表 59→60、回滚链、CI、state.json）。
  - 云侧 `learning` 模块（真实事实聚合：A2→A3 接受率 / KpiService 复用 /
    事件结局 / override 计数；modelAccuracy=unknown 显式声明；幂等重评估
    不重发事件）；LearningEvaluationRecorded 目录事件（**56/56**）；
    OpenAPI 3 路由。
  - continuous-learning 按 §36 升 Implemented（矩阵 39/16/0/1）。
- **独立工业推理层（NO-08b，ADR-020，Phase 8 Level 4）**：
  - `contracts/reasoning/reasoning-trace.schema.json` + 共享向量（六规则封闭
    注册表 / premises+evidenceIds 非空规范身份 / canonical severity 阶梯 /
    确定性置信度=1 / 空结论显式语义）；Python/TS 双实现（Python 含标准库
    规则评估器供跨语言仲裁）。
  - 门禁 reasoning_trace 域（**390/390**）+ Golden 第 15 场景
    `reasoning_trace_contract`（11 案例：8 契约仲裁 + 3 引擎执行跨语言仲裁，
    Python 2 tests / TS 16 tests）。
  - 云侧 `reasoning` 模块：确定性规则引擎（§18 模板渲染非 LLM 编造；输入
    fail-closed；trace 契约自检违规绝不返回；结论逐条 L4 InferenceResult
    台账落账——ADR-019 台账复用不新建表）；OpenAPI `/api/reasoning/*`
    2 路由（**358 零漂移**）；service spec 8 例 + shared spec 7 例 +
    pytest 11 例。
  - intelligence-l4-reasoning 独立推理层缺口闭合（矩阵证据深化）。
- **云侧推理结果运行时（NO-08a，ADR-019，Phase 8 深化）**：
  - standalone_040 `ewoh_inference_result`（TENANT_SCOPED RLS + 唯一
    (org_id, inference_id) + level/confidence/dataQuality/OOD 一致性 CHECK；
    全 lockstep：受管表 64 → 65、verify 列表 58→59、回滚链、CI、state.json）。
  - 云侧 `inference` 模块（record 契约 fail-closed / 创建幂等回读不重发事件 /
    list/get 租户作用域）；InferenceResultRecorded 目录事件（**55/55**，
    双运行时投影）；OpenAPI `/api/inference/results*` 3 路由（**356 零漂移**）；
    spec 10 例。
  - 首个真实生产接线：A2 建议流确定性规则基础 → L1 InferenceResult 台账
    （confidence=1 如实声明 + 快照完备度→dataQuality；LLM 文本增强继续由
    ReasoningResult 承载，两契约分工不混用）；ai.service.spec +3 例。
  - 修复 schema-manifest 结构漂移：032-040 的 8 张表条目自 Round 12 起误挂
    `additional_hardened_existing_tables` 段，已移回 `managed_tables`
    （computed=65 与 reconcile 口径一致；run_migrations 的 core 期望值与
    001 verify 列表 59 名对齐）。
- **Factory Knowledge System 运行时（NO-07b，ADR-018 Amendment 1，Phase 12 收口）**：
  - standalone_039 硬化既有 `ewoh_knowledge_entry`（ALTER 不新建同义表）：
    content→body 单一事实源 + 契约列（kind/scope/summary/source_evidence_ids/
    provenance/verified_by/valid_from/valid_to/audit_trail）+ scope-tenant
    一致性 CHECK（共享层 global/industry=哨兵 org
    00000000-0000-4000-8000-000000000000、租户层=真实 org）+ provenance
    CHECK + RLS `knowledge_entry_service_all`（替换遗留通用策略，租户行仅本
    租户可见、共享行全租户可读）+ UNIQUE (org_id, entry_id)；非法
    kind/scope/status、共享层落租户 org、private_operational 带 provenance
    由 verify 自证拒绝；全 lockstep（runner 映射 + 专用 verify handler +
    回滚链 + CI 步骤 + state.json 记录）。
  - 云侧 `knowledge` 模块（注册契约 fail-closed / 跨租户注册显式拒绝 /
    创建幂等回读不重发事件 / 检索五层阶梯（共享层 ∪ 本租户层，他租户行
    物理不可见）/ 共享检索仅 global+industry fail-closed（绝不越过
    private_operational）/ 状态转移 draft→verified 必须 verifiedBy、
    superseded 终态、共享层租户只读）；spec 13 例。
  - Knowledge Agent（ADR-016 Manifest 注册：role=Knowledge，L1 人审；
    契约命令注册表 +`register_knowledge`（schema/Python/TS lockstep 扩展）+
    新 Tool ×2；agent.service.spec +4 例，共 21 例）。
  - 事件目录 +KnowledgeEntryCreated（**54/54**，双运行时投影）；
    OpenAPI `/api/knowledge/*` 5 路由（**353 零漂移**）。
  - knowledge-system 按 §36 升 **Implemented**（矩阵 **38/17/0/1**）。
- **Factory Knowledge System 立项契约层（NO-07，ADR-018，Phase 12）**：
  - `contracts/knowledge/`（6 kind / 5 层 scope 有序阶梯 / 3 status 注册表 +
    证据链非空可追溯 + 五层租户语义 + provenance 声明（global/industry 必填、
    private_operational 禁止）+ 双时态 + auditTrail 强制）。
  - Python/TS 双实现 + 门禁 knowledge 域独立仲裁（**374/374**）+ Golden 第
    14 场景 + spec 6 例。
  - **矩阵 Missing 清零（37/18/0/1）**——56 项能力全部至少 Partial；
    cross-factory 知识隔离政策并入五层 scope 语义。
- **AgentTask 编排引擎运行时（NO-06f，AD-LC-026，Phase 9 主体收口）**：
  - standalone_038 `ewoh_agent_task`（TENANT_SCOPED RLS + 唯一 (org_id,task_id)
    + kind/priority/status CHECK；全 lockstep：manifest 63→64/66→67、
    verify 列表 57→58、回滚链、CI）。
  - `AgentOrchestratorService`：创建唯一入口（契约校验 + 依赖环 BFS 检测 +
    每角色并发预算上限 10 fail-closed + AgentTaskCreated 事件）；状态推进
    唯一写者（状态机 + DB CAS）；dispatch 依赖门控（依赖未 completed 拒绝）；
    终态 AgentTaskCompleted 事件 + 审计。
  - OpenAPI `/api/agents/tasks*` 6 路由（**348 零漂移**）；orchestrator
    spec 10 例；intelligence-l5-agentic 升 **Implemented**（矩阵 37/17/1/1）。
- **AgentTask 编排契约（NO-06e，ADR-017，intelligence-l5-agentic 立项）**：
  - `contracts/agent_task/`（3 kind / 4 priority / 6 status 注册表 +
    dependencies DAG 自引用拒绝 + assignedRole 与 agent-manifest 同源 +
    dueTime 时间语义 + budget/auditTrail 同规则）+
    `contracts/state-machines/agent-task.yaml`。
  - Python/TS 双实现 + 门禁 agent_task 域独立仲裁（**351/351**，含角色注册表
    交叉核对）+ Golden 第 13 场景 + shared spec 6 例。
  - 事件目录 +AgentTaskCreated/AgentTaskCompleted（53/53，双运行时投影）；
    intelligence-l5-agentic 矩阵 Missing→Partial（**36/18/1/1**）。
- **领域命令执行器与审批超时（NO-06d，AD-LC-024，Phase 9）**：
  - `create_work_order` 接入真实 WorkOrderService 权威写路径（载荷校验
    fail-closed；失败经 fallback 语义 delegateHuman→delegated 不假装执行）；
    `record_evidence` 落审计事实。
  - 审批超时语义（24h TTL，超期解析为拒绝留痕不无限悬挂）。
  - intelligence-l5-agentic 评估立项（多 Agent 结构化任务编排面，NO-06e
    契约先行）；agent.service.spec 17 例。
- **Agent 审批桥接与首个真实 Agent（NO-06c，AD-LC-023，Phase 9）**：
  - 审批桥接：needsApproval → 正式审批实例（复用 approval 状态机，
    roles=workshop_lead）+ 待执行命令登记；`resolveApproval` 批准→执行/
    驳回→拒绝闭环（批准仍受 budget/fallback 强制）。
  - FactorySupervisor L1 建议型端到端：世界状态 → 事实数字驱动的确定性建议
    → propose_plan → 审批（`/api/agents/supervisor/run`）。
  - Agent Policy TCK 决策表 10 例（等级×门控×预算×回退矩阵）；
    agent-runtime 升 Implemented、agent-policy-approval 升 Partial
    （矩阵 **36/17/2/1**）；OpenAPI 342 路由零漂移。
- **Agent Runtime 运行时（NO-06b，AD-LC-022，Phase 9）**：
  - standalone_037 `ewoh_agent_manifest`（TENANT_SCOPED RLS + 唯一
    (org_id,agent_id) + CHECK（**L4 由 DB 兜底排除**）；全 lockstep：
    manifest 62→63/65→66、verify 列表 56→57、回滚链、CI）。
  - 云侧 agent 模块：注册唯一入口（契约校验 + Tool 注册表 fail-closed +
    版本单调幂等）；执行强制（writeScope 白名单 / L0 advisory_only / L1
    一律人审 / L2-L3 approvalRequiredFor 门控 / budget-timeout 强制 /
    fallback 四策略显式语义）；AgentTaskProposed / AgentDecisionRecorded
    目录事件（51/51）+ 审计同源。
  - OpenAPI `/api/agents/*` 4 路由（340 零漂移）；agent.service.spec 10 例。
- **Agent Runtime 立项契约层（NO-06，ADR-016，Phase 9 启动）**：
  - ADR-016 目标架构：Agent 不得绕过系统架构（正式 Tools + 结构化 Command +
    World Model 依赖 + 禁止直连 DB）；Autonomous Level 显式阶梯 L0..L3
    （L4 永不允许，§2）。
  - `contracts/agent/`（agent-manifest.schema.json + test-vectors.json 15 条）：
    15 角色 / 12 作用域 token / 8 命令 / 风险等级 / 自治阶梯 / 回退策略六注册表
    ＋十六字段校验——L2/L3 必须显式审批、critical 仅 L0/L1、Safety 仅 L0/L1
    且写空、auditTrail 强制、budget/timeout 下界。
  - Python/TS 双实现 + 门禁 agent 域独立仲裁（**329/329**）+ Golden 第 12
    场景 `agent_manifest_contract`（双执行器）+ shared spec 6 例；
    agent-runtime 矩阵 Missing→Partial（35/17/3/1）。
- **Event Backbone 收口（NO-04c，AD-LC-020，Phase 4 主体完成）**：
  - 上行队列跨重启断点续传：`EventUplink` 侧车持久化（`<db>.uplink-queue.json`
    入队即落盘/原子替换/成功截断；加载损坏显式 ERROR 空队列启动）。
  - 云侧乱序/回放补全策略：事件行按 occurredAt 落库（createdAt=occurredAt），
    消费端按发生时刻排序；历史回放补全幂等接受 + isLate 标记不改写。
  - 时钟漂移运行态策略：flag-only 不修正（修正会制造第二事实源）。
  - `event-backbone` / `time-semantics` 按 §36 升 Implemented（矩阵 35/16/4/1）。
- **Edge→Cloud 事件上行通道（NO-04b，AD-LC-019，Phase 4 事件骨干）**：
  - 事件目录类型双运行时锁定投影（`shared/event-catalog.ts` +
    `contracts/event_catalog.py`，audit-event-catalog 集合核对，单一事实源）。
  - standalone_036 `ewoh_ingest_event_dedup`（TENANT_SCOPED RLS + 唯一
    (org_id,source,event_id) + is_late/clock_drift 时间语义列 + 重复插入自证；
    全 lockstep：runner/manifest/verify 列表 55→56/回滚链/CI）。
  - 云侧 `POST /api/ingest/events`：信封契约校验 + Catalog 白名单 fail-closed +
    传输级幂等去重（duplicate 不重复投递）+ 迟到/漂移随台账落库；OpenAPI
    336 路由零漂移。
  - 边缘 `EventUplink`（STREAM_EVENTS → 契约校验 → 批量上行 + 内存缓冲退避，
    at-least-once 由云端幂等去重兜底）；EWOH_EVENT_UPLINK_* 配置 +
    /api/status 健康。
  - edge unittest 932 OK、pytest 224 passed、ingest spec 21 例、truth 族全 PASS。
- **Event Backbone 第一批（NO-04a，AD-LC-018，Phase 4 启动）**：
  - 事件目录 +EntityDeclared/EntityStateObserved（49 messages / 49 channels，
    audit-event-catalog PASS）——实体声明/观测随事件骨干上行的事实载体。
  - 边缘 `TelemetryWorldProjector` 发射 Catalog 信封事件（ADR-009 契约校验
    fail-closed；落边缘事件库 + STREAM_EVENTS；声明/首观测各单次发射防风暴）。
  - 云侧 ingest 帧级时间语义：isLate（>10min 迟到标记不丢弃）/ clockDrift
    （越 5min 容忍界标记不重写）逐帧透出 + late_count/clock_drift_count
    批量聚合；同批次 DataQualityAlert (eventCode,device) 语义去重（防风暴）。
  - edge unittest 927 OK、pytest 224 passed、ingest spec 15 例、truth 族全 PASS。
- **感知自动接线（NO-03c，AD-LC-017，Phase 3 收口）**：
  - E-03 修复：config 驱动适配器工厂（`edge/adapter_factory.py`，EWOH_ADAPTERS
    四类 kind——ny_exo_a1/camera/environment/mes；未知 kind/参数/构造失败
    fail-closed；空列表=合法空管理器）；run.py 注册 + 启动输出每适配器 health，
    真实模式"永不产生遥测"的链路性失效终结。
  - `TelemetryWorldProjector`（`world_model/projection.py`）：订阅
    STREAM_TELEMETRY 自动投影进 ContractWorldStore——EWOH_WORLD_TENANT_ID/
    FACTORY_ID/KIND_MAP 三项缺一显式关闭（绝不猜测实体类别）；首帧
    declare_entity + 每帧 set_state + ENTITY_OBSERVED 因果事件；非契约
    source_type 拒绝计数；/api/status 暴露 world_projection 健康。
  - deploy/.env.example 增 4 项（audit-env-inventory 106/107 零漂移）；
    云侧联动评估：实体声明上行随 Phase 4 事件骨干走 envelope 事件，不新开
    旁路通道。edge unittest 925 OK、pytest 224 passed、truth 族全 PASS。
- **Entity Model 生产调用链收口（NO-03b 收口，ADR-015 Amendment 2，Phase 3）**：
  - 因果链实体引用强制规范身份（`build_shift_chain`/`ContractWorldStore.record_event`
    对 person_id/device_id/task_id/station_id/zone_id fail-closed，裸 ID 拒绝）。
  - 边缘世界模型六端点（`routes/replay.py`）：`/api/world/{snapshot,entities,states,
    replay,events,predictions}`——声明登记/状态写入（声明-状态机器互锁）/契约快照/
    时间轴回放/因果事件/短期预测；`server.Context` 注入 `world_store`（未装配一律
    503 fail-closed，绝不静默降级）。
  - 离线持久化：`run.py` 启动恢复 + 停机落盘 `<db>.worldstate.json`（状态+声明+
    因果事件整体序列化，失败显式 ERROR）。
  - Entity Contract 生成器 `scripts/gen-contract-registries.js`：schema 单一事实源
    生成 Python/TS 注册表代码块，`--check` 挂 `make truth-check`；
    audit-domain-contracts 独立仲裁双保险。
  - `canonical-entity-model` 按 §36 升 Implemented（矩阵 35/16/4/1）；
    edge unittest 912 OK、pytest 224 passed、truth 族全 PASS。
- **Entity Model 运行时接线（NO-03b，ADR-015 Amendment 1，Phase 3）**：
  - kind 前缀一致性机器规则（entityId kind 前缀 ∈ 45 类且等于声明 kind；
    身份专属 kind device/session 拒绝承载实体声明：kind_prefix_mismatch /
    kind_prefix_unknown）+ projectionDivision（stateProjectable 22 /
    identityOnly 2 / entityOnly 5）与 projectionBuckets（person/device/station/
    task，device 桶 = 遗留身份桶 + 设备类实体 kind）以 schema 实例值锁定；
    门禁 277→299/299（前缀仲裁 + 差集独立推导核对 + 投影桶双运行时一致）。
  - 边缘 `ContractWorldStore.declare_entity`（不可变字段/版本单调/来源不可回改/
    时间不回拨）+ set_state 交叉校验（entity_not_state_projectable /
    entity_type_mismatch / state_precedes_declaration）+ to_dict/from_dict
    持久化；Predictor 目标实体规范身份 fail-closed（夹具 4 处裸 ID 现代化）。
  - 云侧 `validateCloudWorldSnapshot` 改由投影桶校验（device 桶接受
    device/exo/machine/robot/agv/sensor）；Golden #11 扩至 9 案例双执行器。
- **Factory Entity Model 契约（ADR-015 / NO-03a，Phase 3 世界模型契约层）**：
  - `contracts/entity/`（entity-model.schema.json + test-vectors.json）：45 类
    entityKindRegistry 唯一权威清单 + EntityKind 常量 + EntityDeclaration
    字段契约；22（世界快照）⊆ 45（实体模型）由审计门强制；命名 `exo` 与
    Identity/World 一致（不引入 exoskeleton 别名）。
  - Python（`src/edge_platform/contracts/entity_model.py`，stdlib-only）+
    TypeScript（`ewoh-spark-app/shared/entity-model.ts`）同构锁定实现 +
    共享向量 + 门禁扩展（audit-domain-contracts 258→277 项 + entity 域 +
    entity_snapshot_subset 交叉校验）+ Golden Scenario 第 11 场景
    `entity_model_contract`（双执行器）+ shared spec 5 例。
- **ReasoningResult 生产接线（NO-08d，Phase 8 推理双契约收官）**：
  - `ark.service.ts` `buildReasoningResult`：Ark 文本结果 → Canonical
    ReasoningResult（level 按 kind 登记、modelVersion 缺省 unversioned 如实
    标注、confidence 必须 null + confidenceBasis uncalibrated、契约自检
    contract_violations 留痕）；chat/ask 透传 kind/inputVersion；旧字段
    ok/text/model/error 兼容保留。
  - `ai.service.ts` 建议/分析流附着 reasoning（成功解析/失败回退/解析失败三
    路径均留痕；规则模板回退不伪造）；AiSuggestion 增可选 reasoning 字段。
  - 测试：ark.service.spec +3 例、ai.service.spec 3 例；
    capability-matrix intelligence-l4-reasoning 升 Implemented（34/17/4/1）。
- **Level 4/5 文本结果元数据契约（ADR-014 / NO-08c，Phase 8）**：
  - `contracts/reasoning/`（reasoning-result.schema.json + test-vectors.json）：
    LLM/Ark 文本结果（建议/解释/分析/聊天）无标定置信度——confidence 必须 null
    （伪造数值拒绝 confidence_forbidden）、confidenceBasis 显式 uncalibrated、
    ok=false 必带 error、content 成功必填、subjectId null 合法或规范身份、
    evidence.generatedAt；与 InferenceResult（统计判定）显式分工。
  - Python（`src/edge_platform/contracts/reasoning_result.py`）+ TypeScript
    （`ewoh-spark-app/shared/reasoning-result.ts`）锁定实现 + 共享向量 + 门禁
    扩展（audit-domain-contracts 238→257 项）+ Golden Scenario 第 10 场景
    `reasoning_result_contract`（双执行器）+ shared spec 6 例。
- **Inference Result 生产接线（NO-08b，Phase 8）**：
  - 边缘 `pipeline._infer` 结果规范化：level（L1 规则/L2 模型）、input_version
    （模型卡 dataset_version，缺省 unversioned 如实标注）、subject_id
    （device:<id>，云端 identity mapping 解析）、ood_indicator（unknown 六路
    归一）；契约自检 validate_inference_result fail-closed 留痕
    （contract_violations 字段，不阻断推理主路）；旧字段兼容保留。
  - 云侧 Model Registry inputVersion 元数据对齐（cardJson.inputVersion，
    缺省不伪造）。
  - 测试：edge unittest 891→894（+3 wiring）；model.service.spec 3 例；
    capability-matrix intelligence-l2-ml 升 Implemented（33/18/4/1）。
- **Industrial Intelligence 契约层（ADR-013 / NO-08a，Phase 8 启动）**：
  - `contracts/intelligence/`（inference-result.schema.json + test-vectors.json）：
    Level 1-7 分层注册表 + 模型结果元数据必填（modelId/modelVersion/
    inputVersion）+ confidence∈[0,1] 越界拒绝 + OOD 六路封闭注册表
    flag↔reasons 双向一致 + **Unknown 合法化**（unknown 必带 OOD 理由）+
    dataQuality {good,degraded,invalid}（边缘窗口质量词表入契约）+
    evidence 窗口时间戳/isRule。
  - Python（`src/edge_platform/contracts/inference_result.py`）+ TypeScript
    （`ewoh-spark-app/shared/inference-result.ts`）锁定实现 + 共享向量 + 门禁
    扩展（audit-domain-contracts 216→238 项）+ Golden Scenario 第 9 场景
    `inference_result_contract`（双执行器）+ shared spec 6 例。
- **Golden Scheduler TCK 补全重排/反馈段（NO-07c，Phase 7 收官）**：
  - 共享场景 `execution_feedback_and_replan`（scheduler-workflow-golden.json
    第二场景）：执行反馈回流（真实 SchedulingFeedbackService.recordActuals 幂等
    覆盖）→ 事件驱动重排（PlanService.replan：版本+1、新 planId={planId}-R{v+1}、
    旧方案 superseded + supersededBy、**真实求解器**对新快照求解并 persistPlan）
    → 新版本审批收敛。
  - TS 执行器升级为真实求解器（solve→persistPlan→supersede 全真实）+ feedback/
    replan 操作处理器；Python 标准库状态机重放同步扩展；调度黄金 TCK 覆盖
    完整闭环（快照→候选→求解→审批→预约→派工→反馈→重排）。
- **Golden Scheduler Workflow TCK（NO-07b，Phase 7 工作流段）**：
  - 共享场景 `tests/golden-fixtures/scheduler-workflow-golden.json`
    （方案全生命周期）：审批 CAS 双校验（plan version / 快照新鲜度 →
    PLAN_STALE 拒绝且状态不变 + 观测型 stale_plan 通知）→ 审批收敛 →
    预约重叠冲突（RESOURCE_CONFLICT）→ 派工前置与收敛（dispatched +
    outbox assignment.dispatched / plan.dispatched）。
  - TS 执行器 `golden-scheduler-workflow.spec.ts`（3 例）：真实 PlanService /
    ResourceReservationService / DispatchCoordinatorService 在状态化 fake-db
    上执行（外设 mock 边界显式声明），结果制品漂移门禁。
  - Python 执行器 `tests/test_golden_scheduler_workflow.py`（3 例）：标准库
    状态机重放独立仲裁（不依赖 ortools/TS 运行时）；Makefile scheduler-golden
    扩至求解段 + 工作流段；CI 步骤更新。
- **Golden Scheduler TCK + 调度语义统一（NO-07，Phase 7）**：
  - heuristic 求解器补齐 NO-05c/05d 接线：枚举路径 eligiblePerson/eligibleDevice
    增 maintenance/qualityFindings、station 维护/质量封锁映射进 eligibility ctx；
    reuseBaseline 快速路径增三守卫（人员/设备/工位）——消除"快照带事实、
    求解器无视"的路径分叉。
  - 共享场景定义 `tests/golden-fixtures/scheduler-golden-scenarios.json`
    （skill 基线 / 维护封锁设备·人员 / 质量封锁工位四场景）+ TS 求解器
    `golden-scheduler-scenarios.spec.ts`（6 例，结果制品漂移门禁）+
    Python 标准库独立硬约束仲裁 `tests/test_golden_scheduler_scenarios.py`
    （3 例，不依赖 ortools）；Makefile `scheduler-golden` + CI 步骤。
  - `solver-maintenance-quality.spec.ts` 4 例 reuse 守卫回归；
    capability-matrix cross-language-scheduler-conformance 证据扩充。
- **Work Order 持久化与模块（ADR-012 / NO-05e-b，Phase 6 工单闭环收官）**：
  - 迁移 `db/migrations/standalone_035_work_order.sql`（+rollback+verify）：
    ewoh_work_order（TENANT_SCOPED、RLS work_order_org_isolation、
    type/origin/severity/status/completion/cancellation CHECK、
    唯一 (org_id, work_order_id)）；schema-manifest managed_count 60→61、
    001/standalone_001 verify 列表 54→55 lockstep；standalone-postgres-check.sh
    apply + 成对回滚链；CI standalone.yml 专用步骤。
  - 云侧 `server/modules/workorder/`：create（契约 fail-closed + ID 确定性推导 +
    唯一键冲突幂等回读）/transition（in_progress 起不可取消、completed/closed
    落 completedAt、cancelled 必带 reason）/list；WorkOrderCreated/Completed
    信封事件；9 例 spec。
  - maintenance/quality 服务委托 WorkOrderService（工单唯一权威写路径，消除
    双写）；OpenAPI +3 路由（audit 332→335 零漂移）。
  - **修复潜伏缺陷**：run_migrations.js 专项迁移（032/034/035）which 映射与
    专用 verify handler 缺失（命令在 read(undefined) 崩溃，CI 从未运行未提交
    改动故未触发）；standalone-postgres-check destructive rollback 链缺成对
    回滚（"回滚到 0 对象"断言必然失败）；001_verify.sql 孪生列表 51→55。
- **Canonical Work Order（ADR-012 / NO-05e-a，Phase 6 维护/质量工单闭环契约层）**：
  - `contracts/workorder/`（work-order.schema.json + test-vectors.json）：
    workOrderType {maintenance, quality_rework, inspection} + origin
    {maintenance_condition, quality_finding} 必填可追溯 + 六态生命周期
    （in_progress 起不可取消；completed/closed 必带 completedAt；cancelled 必带
    reason；severity 走 Risk 契约、subject 走 Identity 契约）。
  - Python（`src/edge_platform/contracts/workorder.py`）+ TypeScript
    （`ewoh-spark-app/shared/workorder.ts`）锁定实现 + 共享向量 + 门禁扩展
    （audit-domain-contracts 182→216 项）+ Golden Scenario 第 8 场景
    `workorder_loop`（双执行器）。
  - 事件目录 +2 类型：WorkOrderCreated / WorkOrderCompleted（47 messages /
    47 channels）。
  - 云侧事件发端：maintenance 转 work_order_created（带引用）/ quality
    disposition=rework（links[0] 为执行落点）→ WorkOrderCreated 信封事件；
    内部 workOrderId=wo:sha256(originKind:originId)[:12] 确定性推导
    （server/common/workorder-ids.ts），MES 工单号仅作 evidence alias。
- **Quality State 入调度（ADR-011 / NO-05d，Phase 6 Quality Incident Loop 收口）**：
  - `shared/quality.ts` 增 `QualityFindingProjection` + `qualityFindingsBlockDispatch`
    （critical/high 硬封锁、medium/low 仅事实可见、未知严重度 fail-closed 按封锁）；
    ResourceState / WorldStateSnapshot persons/devices/stations 增可选
    `qualityFindings` 事实视图（向后兼容）。
  - ResourceProjectionService `loadActiveQualityFindings()`：活跃发现
    （status ∈ {open, under_review}）按 links 中 station/device/person 规范身份
    附着（order/material/batch 不误锁）；质量事实不改变资源状态。
  - EligibilityService 增 `person/device/station_quality_blocked`（legacy L1-L3
    归一化触发；dispositioned/closed 即解除）；candidate-engine 建
    stationQualityBlockedById。
  - 测试：quality-projection.spec.ts 12 例；scheduler+shared 123 suites /
    883 tests 全绿。决策：docs/decisions/ADR-011 + 决策日志 AD-LC-006。
- **Identity §36 收口（NO-02d，Phase 2）**：canonical-identity-model 证据核实——
  Golden Scenario `identity_mapping_conflict`（Python/TS 双执行器共享）+
  scripts/reconcile-identity-legacy.mjs（UUIDv5 确定性、append-only、dry-run
  默认、CI 真实 PG 幂等链）均在，capability-matrix 摘要文本漂移修正。
- **Maintenance / Quality 生产接线 + 调度集成（ADR-010 / NO-05b + NO-05c，Phase 6）**：
  - 迁移 `db/migrations/standalone_034_maintenance_quality.sql`（+rollback+verify）：
    ewoh_maintenance_condition + ewoh_quality_finding（TENANT_SCOPED、RLS
    maintenance_condition_org_isolation / quality_finding_org_isolation、
    lifecycle 与 disposition-required CHECK）；schema-manifest managed_count
    58→60、001/standalone_001 verify 列表 52→54 lockstep；CI standalone.yml 步骤。
  - 云侧模块 `server/modules/{maintenance,quality}/`：create/list/transition 契约
    fail-closed + severity 归一化 + 生命周期顺序强制 + 信封事件落库
    （MaintenanceConditionDetected/Resolved、QualityFindingDetected/Dispositioned）；
    16 例 spec。
  - OpenAPI +4 路径（/api/maintenance/conditions{,…}、/api/quality/findings{,…}）
    + 8 schemas；route audit 326→332 零漂移。
  - NO-05c 调度集成：ResourceState / WorldStateSnapshot 增 maintenance 事实视图；
    ResourceProjection 状态收敛（critical→OFFLINE、其余→DEGRADED、绝不升级）；
    Eligibility 对活跃维护事实 fail-closed 拒派（person/device/station
    *_maintenance_blocked，人审解除）；11 例 spec。
  - 门禁：jest 全量 210 suites / 1441 tests 全绿；make truth-check、
    repo-facts 39/39（counts-generative 漂移修复）、feature-status 31/31、
    reconcile 6/6 全 PASS；capability-matrix maintenance-loop /
    quality-incident-loop 升 Implemented（32 Implemented / 19 Partial /
    4 Missing / 1 Prototype）。
- **Maintenance / Quality 契约层（ADR-010 / NO-05a，Phase 6）**：
  - `contracts/maintenance/` + `contracts/quality/`：MaintenanceCondition
    （conditionType 注册表 6 类 + 生命周期含 work_order 前置 + overdue 判定）与
    QualityFinding（findingType 注册表 5 类 + 处置生命周期 + disposition 必带决策
    accept/rework/scrap/return）；severity 走 Risk 契约、引用走 Identity 契约。
  - Python（`src/edge_platform/contracts/{maintenance,quality}.py`，零依赖）与
    TypeScript（`ewoh-spark-app/shared/{maintenance,quality}.ts`）锁定实现，
    消费同一份共享向量。
  - 门禁 `scripts/audit-domain-contracts.js` 增两域独立仲裁（182/182）；
    Golden Scenario 第 7 场景 `maintenance_quality_loop`（双执行器）；
    事件目录增补 MaintenanceConditionDetected/Resolved +
    QualityFindingDetected/Dispositioned（45 messages / 45 channels）。
  - 测试：tests/test_mq_contracts.py 7 例 + shared/maintenance-quality.spec.ts 3 例
    （pytest 218 passed / jest 1414 passed）；capability-matrix maintenance-loop
    升 Partial（30 Implemented / 21 Partial / 4 Missing / 1 Prototype）。
- **Phase 5 收尾与 Phase 6 启动（NO-05 / ADR-010）**：
  - 设备数据质量透出：`GET /api/devices/{id}/quality`（adapter DQ 计数器
    bad_crc/malformed/packet_loss/backfill/duplicates/dropped + 遥测质量分布
    storage.quality_stats）；`GET /api/status` 新增 `ingest_chain`
    {ok, adapters_registered, adapters_healthy, details}（无注册如实 false，
    防"真实模式空转"无感）。
  - ADR-010 Maintenance/Quality 领域模型决策（MaintenanceCondition 生命周期+
    逾期判定+维护状态入调度；QualityFinding 处置生命周期+质量状态入调度；
    Event→Outcome 闭环；事件目录 +4 类型计划）。
  - 测试：edge unittest 891 OK（+3 端点例）；capability-matrix
    device-discovery-health-dq 按 §36 升 Implemented
    （30 Implemented / 20 Partial / 5 Missing / 1 Prototype）。
- **Event Envelope 全链路接线（ADR-009 / NO-04b，Phase 4 收口）**：
  - 事件目录增补 6 类规则事件（DeviceLowBattery / WorkerHighLoad /
    WorkerPostureRisk / DeviceOffline / DataDegraded / DataQualityAlert），
    audit-event-catalog 41 messages / 41 channels（修复云侧规则引擎事件类型
    不在目录的既有漂移）。
  - 边缘 EventEngine 开事件产出信封（occurred/observed/received + schemaVersion +
    目录 eventType，EVENT_CODE_CATALOG_TYPE 映射）；既有字段兼容保留。
  - 云侧 rule-engine（RULE_EVENT_TYPE_MAP）/ ingest（DataQualityAlert）/
    identity 三条事件写路径收敛目录类型 + evidenceJson 内嵌 envelope 与
    envelopeSemantics（兼容层，不破坏既有列语义）。
  - shared/event-envelope.ts 新增 buildEventEnvelope / envelopeForEvidence。
  - 测试：edge unittest 888 OK（+2 wiring）；jest 1410 passed（+2 rule-engine
    envelope）；capability-matrix event-backbone / time-semantics 按 §36 升
    Implemented（29 Implemented / 21 Partial / 5 Missing / 1 Prototype）。
- **Canonical Event Envelope 契约（ADR-009 / NO-04，Phase 4 启动）**：
  - `contracts/events/envelope.schema.json` + envelope-test-vectors.json：
    16 字段信封（必填 eventId/eventType/schemaVersion/occurredAt/source）+ 确定性
    规则（时间三态漂移容忍 5min 标记 clockDrift 不改写 / 迟到 10min 标记 isLate
    不丢弃 / (source,eventId) 幂等去重 / actor-subject 规范身份 /
    eventType 必须命中事件目录）。
  - Python（`src/edge_platform/contracts/envelope.py`，零第三方依赖）与 TypeScript
    （`ewoh-spark-app/shared/event-envelope.ts`）锁定实现，消费同一份共享向量。
  - 独立仲裁门禁 `scripts/audit-event-envelope.js`（24 项断言：schema + 向量 JS
    重实现仲裁 + eventType 与 event-catalog.yaml 交叉校验 + 双运行时常量一致），
    挂 `make truth-check` 与新增 `make contract-envelope`，CI test.yml 新增步骤。
  - Golden Scenario 增补第 6 场景 `event_envelope_semantics`（双执行器扩展）。
  - 测试：tests/test_event_envelope.py + shared/event-envelope.spec.ts
    （pytest 211 passed / jest 1408 passed）。
- **Canonical World State 生产接线（ADR-008 / NO-03b，Phase 3 收口）**：
  - 云侧：`validateCloudWorldSnapshot` 快照构建自检（worldVersion / entityVersions
    规范身份键 / 实体规范引用 kind 匹配），collectState 附 `contractCheck`
    {valid, errors} + 失败 warn 留痕；WorldStateSnapshot/ResourceState 实体增可选
    `entityId`（person:/device:/station:/task: 规范身份引用，与原 id 并存），
    两路投影填充。
  - 边缘：`ContractWorldStore`（set_state 契约校验 fail-closed + 双时态/版本递增 +
    snapshot 自检 + 来源画像）进入真实装配链（production/development 均产出
    world_store 组件，real_components 快照含之）。
  - 测试：edge unittest 886 OK（+contract_world_store 8 例）；jest 1403 passed
    （+validateCloudWorldSnapshot 4 例 + entityId 投影 1 例）。
  - capability-matrix：factory-world-model / world-state-store-history 按 §36
    升 Implemented（27 Implemented / 23 Partial / 5 Missing / 1 Prototype）。
- **Canonical Factory World State 契约（ADR-008 / NO-03，Phase 3 启动）**：
  - `contracts/world/world-state.schema.json` + test-vectors.json：StateRecord
    双时态（[valid_from, valid_to) + sourceType real/simulated/derived +
    confidence [0,1] + version）+ 22 类实体注册表 + Snapshot（entityVersions 键
    必须规范身份）+ 确定性规则（区间不重叠 / 版本单调（快照单记录豁免）/
    模拟隔离 simulated 绝不参与 real 判定 / fail-closed）。
  - Python（`src/edge_platform/contracts/world.py`，零第三方依赖）与 TypeScript
    （`ewoh-spark-app/shared/world-contract.ts`）锁定实现，消费同一份共享向量。
  - 门禁 `scripts/audit-domain-contracts.js` 增 world 域独立仲裁（JS 重实现三套
    校验语义 + Python/TS 注册表一致），134/134。
  - Golden Scenario 增补第 5 场景 `world_state_projection_rules`（双执行器扩展）。
  - 测试：tests/test_world_contract.py + shared/world-contract.spec.ts
    （pytest 207 passed / jest 1398 passed）。
- **Canonical Contract Golden Scenarios 与 legacy reconcile（§26 / NO-02d，Phase 2 收口）**：
  - 共享场景定义 `tests/golden-fixtures/contract-golden-scenarios.json`（四域：
    身份映射冲突 fail-closed / legacy 严重度归一 / 脏空间类型拒绝 / 资源新鲜度
    fail-closed）+ Python（tests/test_golden_contract_scenarios.py）与 TS
    （shared/golden-contract-scenarios.spec.ts）双执行器；`make contract-golden` +
    CI test.yml 步骤（§26 每次架构变更重跑）。
  - `scripts/reconcile-identity-legacy.mjs`：legacy 设备 → identity_mapping 的
    append-only reconcile（ON CONFLICT DO NOTHING 绝不改写存量；确定性 RFC 4122
    UUIDv5 目标身份；dry-run 默认 + --apply 显式；幂等可重入）；CI standalone.yml
    真实 PG 验证 dry-run → apply → 复跑 planned=0。
  - capability-matrix：canonical-identity / risk / location / resource 四域按 §36
    判据升 Implemented（25 Implemented / 25 Partial / 5 Missing / 1 Prototype）。
- **Canonical Risk / Location / Resource 生产接线（ADR-007 / NO-02c-b）**：
  - Risk：规则引擎/ingest 写路径 severity 归一化（`normalizeSeverity`，
    L2→high/L3→medium，未知值 fail-closed 不落事件）；identity 事件 severity 收敛
    'low'；dashboard 统计口径 legacy+canonical 并集（存量/新量不漂移）。
  - Location：`SpatialEntityType = SpatialKind`（移除 `| string` 逃生舱）；
    ingestSpatialScan 拒绝非注册表 entity_type（fail-closed）；spatial 读边界
    校验存量脏行。
  - Resource：`ResourceState.status: ResourceStatus`（六态+UNKNOWN 锁定）；
    ResourceProjection `toCanonicalStatus` 显式归一（fault→DEGRADED/
    online→AVAILABLE/offline→OFFLINE/active→AVAILABLE/working→BUSY/
    unavailable→UNKNOWN，未知→UNKNOWN+warn 不猜测），覆盖 getUnifiedResourceState
    与 projectForSnapshot；eligibility/solver/conflict/前端消费点切换规范词表。
  - 回归：25 个调度 spec + 14 个 JSON fixture + benchmark 生成器词表规范化，
    jest 全量 202 suites / 1388 tests 全绿。
- **Canonical Risk / Location / Resource 契约（ADR-007 / NO-02c，Phase 2 收尾）**：
  - 契约层 `contracts/{risk,location,resource}/`：risk（severity 阶梯
    critical>high>medium>low + legacy 映射 L1→critical/L2→high/L3→medium +
    生命周期含复开边 + category 注册表）、location（空间类型封闭注册表 21 类 +
    坐标类型 FACTORY_CARTESIAN/WGS84/UNKNOWN + 记录校验：米制 +X 东 +Y 北 +Z 上、
    yaw [0,360)、WGS84 边界、UNKNOWN 禁止坐标冒泡）、resource（六态+UNKNOWN +
    FRESH/STALE/UNKNOWN + AUTHORITATIVE/DERIVED + 可用性 fail-closed
    「仅 AVAILABLE ∧ FRESH 可用」）。
  - Python（`src/edge_platform/contracts/{risk,location,resource}.py`，零第三方依赖）
    与 TypeScript（`ewoh-spark-app/shared/{risk,location,resource}.ts`）锁定实现，
    消费同一份共享测试向量（§31 跨语言一致性）。
  - 独立仲裁门禁 `scripts/audit-domain-contracts.js`（113 项断言：schema 形状 +
    向量 JS 重实现仲裁 + Python/TS 注册表与 schema 一致，有序注册表逐位比较），
    挂 `make truth-check` 与新增 `make contract-domain`，CI test.yml 新增
    「Domain 契约一致性门禁」步骤。
  - 测试：`tests/test_domain_contracts.py` 13 例 + `shared/domain-contracts.spec.ts`
    5 例（pytest 全量 200 passed）。
- **Canonical Industrial Identity 生产接线（ADR-006 / NO-02b）**：
  - 迁移 `standalone_032_identity_mapping`：`ewoh_identity_mapping`
    （TENANT_SCOPED：org_id NOT NULL + RLS `identity_mapping_org_isolation` +
    CHECK 约束 + 唯一业务键 (org_id, source_system, source_id)）+ 
    `ewoh_telemetry.entity_id`（additive 可空 + 索引）；成对 rollback +
    verify（表/RLS/策略/约束/自证）+ CI 迁移链（apply → verify → rollback → re-apply）。
  - 云侧 Identity 模块（`server/modules/identity/`）：注册幂等（同目标版本递增 /
    异目标 superseded + 新 active）、契约校验 fail-closed、解析走共享
    `resolveIdentityMapping`（active/时间窗口/ambiguous_identity）、
    `resolveBatch`（ingest 一次 IN 查询）、注册写 `EntityIdentityMapped` 事件
    （ewoh_event，org 归属）。
  - ingest 生产调用链：单帧/批量解析（`edge-device` 命名空间）→
    `ewoh_telemetry.entity_id`；未映射/无租户上下文 → NULL（legacy 行为不变）。
  - OpenAPI：`POST /api/identity/mappings`、`GET /api/identity/mappings`、
    `GET /api/identity/mappings/resolve` + 5 个 schema；gen:openapi 再生成；
    audit-openapi-routes 326 controllers / 0 漂移；route-manifest 再生成。
  - 治理接线：runner 注册 032 三命令；schema-manifest managed_count 57→58 +
    verify expected 列表 56→57 锁步；standalone-postgres-check 先应用 032；
    schema.ts 与迁移对齐（031 同纪律）。
  - 测试：identity.service.spec 8 例；ingest spec 补 IdentityService mock；
    audit-repo-facts 39/39（counts-generative 告警清零）。
- **Canonical Industrial Identity（ADR-006，Phase 2 首项）**：
  - 契约层 `contracts/identity/`：`identity.schema.json`（kind:value 语法 + 42 类封闭
    注册表 + 确定性规则，唯一事实源）、`identity-mapping.schema.json`（第三方 ID →
    规范身份映射记录：active/时间窗口/ambiguous_identity fail-closed）、
    `test-vectors.json`（43 valid / 15 invalid / 6 mapping 场景，跨语言共享向量）。
  - Python 实现 `src/edge_platform/contracts/identity.py`（零第三方依赖）与 TypeScript
    实现 `ewoh-spark-app/shared/identity.ts`：parse/format/解析映射/记录校验，语义逐项
    一致（内部 ID 必须 EWOH 生成，第三方 ID 仅 alias）。
  - 独立仲裁门禁 `scripts/audit-identity-contracts.js`（22 项断言：契约形状 + 向量
    JS 重实现仲裁 + Python KINDS / TS IDENTITY_KINDS 与 schema 注册表逐项一致），
    挂入 `make truth-check` 与新增 `make contract-identity`，CI test.yml 新增
    「Identity 契约一致性门禁」步骤；jest testMatch 纳入 `shared/**/*.spec.ts`。
  - 事件目录新增 `EntityIdentityMapped`（`com.ewoh.identity.mapped`，35 messages/35 channels）。
  - 测试：`tests/test_identity_contract.py` 18 例 + `shared/identity.spec.ts` 13 例
    （pytest 187 passed / shared jest 13/13）。
- **长期架构治理层（long-cycle-governance）**：
  - 新增长期 Agent 外置记忆 `docs/agent/project-state.yaml`（current_phase / 已完成 /
    部分 / 缺失能力 / 架构债 / 关键风险 / 迁移 / 下一目标 / 阻塞项 / 决策 /
    权威事实源 / 测试状态）+ 回合报告 `docs/agent/round-reports/2026-08-14-round-01.md`。
  - 新增 Phase 0/1 架构工件：`docs/architecture/current-state.md`、`target-state.md`、
    `domain-map.md`、`data-flow.md`、`runtime-map.md`、`decision-log.md`（决策日志索引，
    指向既有 docs/decisions/ 体系）、`docs/capabilities/capability-matrix.yaml`
    （56 项能力 × 状态词表 × 证据路径：21 Implemented / 28 Partial / 6 Missing /
    1 Prototype）、`docs/contracts/index.md`（契约权威源导航）。
  - 基线复测：仓库级 pytest 169 passed / 10 skipped；truth-feature-status 31/31；
    audit-repo-facts 39/39（本回合实测，与 feature-status.yaml 单一事实源一致）。
- **产品化深化批（close-loop-and-converge，路线图执行）**：
  - **执行反馈可视化（SchedulePanel）**：新增 `ExecutionDeviationList`——真实消费
    `GET /api/scheduler/executions?planId=`（计划 vs 实际 + 偏差事实），30s 轮询 +
    三态；`pickPreviousApprovedPlanId` 纯函数 + 「对比上一已批准方案」回看动作
    （值班员评估回退目标，复用 PlanCompare 端点，绝不兜底列表首个）。
  - **方案状态流转指示**：`planStatusStepVM` + `PlanStatusStepper` 组件——影子方案→
    已批准→已派工→执行中四步流转（done/current/todo），方案状态徽标同步中文化。
  - **L3 告警聚合去抖**：`alertToastLogic.aggregateL3` 按设备聚合近窗口事件，
    AlertToast 一张卡展示「设备 × N 条」+ 展开列表按设备分组（风暴不刷屏）。
  - **中文化残留清理**：churn→换人成本/换人、STALE CONTEXT→上下文已过期、
    seq→序号、asOf→截至。
  - **Pilot Soak 真值环境（文档+编排）**：`docs/operations/pilot-soak-runbook.md`
    （部署前 7 项检查 / 8 周 soak 协议 / 故障注入日历 / runtimeVerified 验收表）+
    `scripts/pilot-soak.sh`（本机 13 项检查 + 真实环境项如实 BLOCKED，退出码 0/1/2
    语义诚实，--report 输出小时摘要）。
- **治理收敛（converge）**：
  - **边缘 production RBAC 落地（R-1）**：`action_for_request(method, path)` 把请求
    映射为 9 动作矩阵；do_GET/do_POST/do_PATCH 在认证门禁之后按会话角色执行
    `is_allowed`（fail-closed，403 forbidden）——operator 不能建任务/改派工，
    viewer/data_analyst 不可读审计；development/simulation 保持离线演示语义；
    回归测试 9 例（`test_rbac_enforcement.py`）。
  - **边缘 hydrate 补齐（R-3）**：重启后恢复正式派工 `_assignments`（可查/可续
    状态流转）、执行反馈 `_feedback`（学习闭环）、active 预约
    （ReservationService.restore → confirm 冲突检测跨重启有效，防双预约）；
    存储行按模型字段过滤构造对象（额外列 recommended_by 等不再致恢复失败）；
    回归测试 2 例 + `SchedulerService.list_feedback`。
  - **云侧 N+1 消除（R-5）**：`listActivePlans`/`listRuns`/`getActivePlans` 的分配明细改为
    `inArray` 批量加载（`loadAssignmentsBatched`/`listPlansBatched`，原每方案
    1-2 次查询，且保留 per-plan 损坏跳过语义）；facade/runs-snapshot 表征测试 mock 同步。
  - **删除死脚手架**：`server/modules/hello`（整文件注释模板）移除。

### Fixed
- **清理"僵尸豁免"**：租户隔离静态审计（`audit-org-predicates`）报出
  `dashboard.service.ts::ewohDevice#4` 已不再违规——本轮重构后该查询链
  可被静态判定为租户作用域，白名单条目必须移除（防僵尸豁免掩盖真实回归）；
  豁免登记 13 → 12 条。
- **设备详情调用了不存在的路由**（真实后端 E2E 抓到，mock 用例掩盖）：客户端
  `getDeviceDetail` 打的是 `/api/dashboard/devices/:id`，而该详情只有
  `/api/devices/:id`（dashboard 控制器无此路由）→ 抽屉能力区块永远 404。
  mock 因为拦截自定义路径而"通过"，真实后端一跑就暴露；已修正客户端路径、
  同步 mock 到生产路由，并在 E2E 中加"详情接口必须 200"的断言。
- **设备页把"没有电池"显示成"0% 低电量"**：`mapDeviceRows` 把 NULL 强转 0，
  传感器设备因此长期显示低电量告警（把"不适用"伪装成故障）。
- **设备类别过滤只在前端生效**：页面与 DTO 都支持 `category`，但
  `client/src/api/dashboard.ts` 没有把它拼进请求（浏览器用例实测抓到），
  用户选了类别仍返回全量——已在 API 客户端补齐并加断言。
- **设备页 3 个输入框无可访问名**（关键字/电量上下限）：浏览器 a11y 扫描报出，
  已补 `label/htmlFor` 与 `aria-label`。
- 修正 `docs/architecture/data-flow.md` §4.4 的**过期缺陷登记**：其中"edge_to_spark
  批量失效""边缘 query_telemetry/query_inference 全表加载"两项在 2026-08-19 与
  EDGE-004/005 已修复，文档仍标"待修"——文档与代码不一致本身是缺陷。
- **摄入限流硬编码 100 req/min**：多源传感器机群通常共用一个边缘出口 IP，
  正常流量即被打满（实测桥 `retried=203`、队列堆积），现改为可配置并打印生效值。
- **E2E 场景把"限流"误读成"没有数据"（§33 不静默）**：连续跑多个场景时全局
  读接口限流（`RATE_LIMIT_MAX` 默认 300/60s）返回 429，脚本把 429 当成
  "库中没有可用方案" → 报出一个错误的业务结论。现改为显式识别 429 并报
  SKIP + 处置说明（限流 ≠ 没有数据）；本地 e2e env 增加 `RATE_LIMIT_MAX`
  放宽说明。
- **复位后立刻重跑场景被触发冷却挡住（实测）**：调度去抖按
  `(org, triggerType, entityId)` 最近触发 + `triggerCooldownMs`（默认 30s）
  判定，复位后立即重跑会被判 `debounced` → 不生成方案 → 场景报 SKIP。
  `reset-scenario-data.js` 现同时清理本组织 `ewoh_replan_trigger` 台账
  （场景簿记，非人工决策审计），使"复位 → 立刻重跑"成立。
- **`make scenario-reset` 的 `ORG_ID` 未给默认值**：原样传空串会被脚本
  拒绝（"需要一个 uuid"）。现默认 seed 租户，跨租户仍可显式覆盖。

- **全仓系统性走读整改（systematic-code-walkthrough-2026-08-14，P0×3 + P1×5）**：
  - **边缘 P0-1 静态目录穿越**：`server.py` 的 `translate_path` 覆盖丢失了标准库的 `..` 清洗，
    `GET /../../../demo.db` 可匿名读取仓库任意文件（含 110MB 全量数据库，运行时实测 200）。
    修复为镜像标准库语义（丢弃 `.`/`..` 段，绝不越出 STATIC_DIR），新增回归测试
    `test_server_patch_and_static_safety.py`（穿越/绝对路径/编码变体 → 404）。
  - **边缘 P0-2 do_PATCH 写路径无 production 门禁与审计**：`/api/tasks/{id}` PATCH 与 do_POST 不对称，
    production 匿名可写且不落审计。修复为复用 production 认证 fail-closed + 自动审计
    （action=PATCH …），`_flush_post_audit` 泛化支持任意方法；rate_limiter 同步覆盖 do_PATCH。
  - **云侧 P0-1 SSE 被全局拦截器破坏**：`OrgContextInterceptor` 用 `lastValueFrom(next.handle())`
    包裹 `@Sse` 无限流——永不 resolve，客户端收不到任何调度事件，且请求级事务/连接被占满
    （连接池 max=20）。修复：SSE 处理器（`SSE_METADATA`）直通不进事务（租户隔离由应用层
    orgId 过滤保证），新增直通单测（org-context.interceptor.spec.ts 6/6）。
  - **Simulator fail-closed（P1）**：`onModuleInit` 自动启动改为显式 `EWOH_SIMULATOR_ENABLED=1`
    才启动；`deploy/.env.example` 默认 `EWOH_SIMULATOR_DISABLED=1`（此前生产 standalone 会把
    仿真遥测写入真实表、破坏快照新鲜度 PLAN_STALE）。
  - **边缘安全 fail-closed 补全（P1×2）**：视觉理解出站地址 SSRF 防护——
    `ark_vision.describe_image` 新增 `validate_outbound_url`（仅公网 http/https，
    DNS 解析后拒绝环回/内网/链路本地/云元数据地址），请求级 base_url/image_url 覆盖
    无法再把服务端出站请求指向内部网络（保留云侧 Ark 配置代理功能）；
    `/api/command-map/stream` production 下要求有效 Bearer token（匿名订阅 401 fail-closed），
    development/simulation 保留离线演示直连；均带回归测试（内网地址拒绝/公网放行/
    端点 502/SSE 401/开发直连）。
  - **决策驾驶舱执行反馈闭环（P1，执行反馈断链修复）**：`SCHEDULING_FEEDBACK` 段由显式
    空态改为真实消费 `GET /api/scheduler/executions`（planned vs actual + deviation 事实）：
    汇总指标（执行中/完成/失败取消/按时完成率/平均延误）+ 最近 5 条执行事件（人员/任务/
    状态文案/偏差标签），30s 轮询 + 加载/错误重试/空态三态（空态文案如实说明"方案派工后
    显示执行进度"）。新增纯映射 `executionFeedbackVM.ts`（不重算任何资格/成本/硬约束，
    仅状态→文案映射）+ 单测 6 例 + render-only 静态约束；queryKeys 新增
    `schedulerExecutions(planId)`。client 测试 108 套件 / 886 通过。
  - **真机遥测动作分类恒 unknown（P0，E-01）修复——三层字段契约对齐**：
    NXP1 设备不提供 roll_deg/3D 角速度/3D 加速度，旧特征提取强制要求三者齐备 →
    `extract_features` 恒 None → 推理恒 unknown/data_quality + ACTION_ANOMALY_LOW_QUALITY
    持续误报。修复：`features._sample_values` 核心通道（pitch/torque/assist）与可选通道
    （roll/角速度/加速度，缺失维度聚合为 None）分离，标量角速度模长 `angular_velocity_dps`
    折算为 gyro_mag；`extract_features` 可选维度 None 不判 invalid；规则路径 None-safe
    （gyro/accel 缺失计 0）；`_infer` 对「模型 12 维契约 vs 设备通道子集」诚实降级规则路径；
    `_KEY_CHANNELS` 收敛为核心通道（可选通道缺失不再触发 sensor_channel_missing）。
    回归测试 10 例：`DeviceSubsetChannelTest`（8）+ `RealDeviceChainTest`（2，真机形状
    UnifiedExoFrame→frame_adapter→extract_features→walk/bend 标签端到端）。
  - **边缘存储索引补齐（E-08）**：inference(device_id, ts_end)、risk_event(start_time/status/device_id)、
    scheduling_request(status)、scheduling_plan(status)、world_state_snapshot(timestamp)——
    消除推理/事件/调度列表全表扫描的索引缺口（幂等 CREATE INDEX IF NOT EXISTS）。
  - **CP-SAT worker 时间基准与目标分解修复（P0×3，纯算术一致性，可单测）**：
    `to_relative_minutes` 统一模型时间基准——frozen/reservation/due/mustFinish
    原以 epoch 毫秒整除分钟（≈2.9e7）与相对分钟变量混入同一 AddNoOverlap/MaxEquality，
    导致预约/冻结约束对普通任务完全失效、lateness 恒 0、硬截止从不生效；
    `late_domain_upper` 修复 late 变量域溢出（原固定 horizon+10 上界被表达式越过
    → 模型不可满足）；objectiveBreakdown 由「输出权重值」改为输出求解出的真实分量
    （unassigned/lateness/stationWait/travel/churn 自然单位）。新增纯函数回归测试
    （test_cpsat_solver.py TestTimeBasisHelpers + test_cpsat_reservation.py 相对分钟语义）。
    注：无 ortools 环境仍以 UNAVAILABLE fail-closed 回退，真实求解验证留待部署环境。
  - **边缘调度只读边界 403（P1）**：readonly/advisory 模式下 POST /api/tasks 原 500、
    PATCH /api/tasks 原 400，现统一 `403 SCHEDULING_READ_ONLY`（与 plan confirm/execute
    一致），任务写路径如实告知「正式调度写权限归 NestJS 控制面」；回归测试 2 例。
  - **审计身份防伪造（P1）**：routes/scheduler.py、routes/world.py 的 actor/handler/author 由
    「客户端自报优先」改为「服务端 token 身份优先」（`_util.resolve_actor`），未认证才降级
    客户端字段（仅 development/simulation 演示便利）；新增回归测试。
  - **边缘采集链路机械缺陷（E-05/06/07/10/19）**：`UnifiedExoFrame` 新增 `sequence`/`backfill`
    采集溯源字段并全链路透传（frame_adapter → storage/规则层，契约测试同步扩展）；
    `PACKET_LOSS_BURST` 死规则改读生产字段 `packet_loss_pct`（兼容旧字段 0-1 换算）；
    TIME_SYNC_ANOMALY 跳过补传历史帧（重连补传不再误报）；firmware_version 透传恢复白名单校验；
    SEQ 丢包统计仅计实时 TELEMETRY 帧（IDENT/FAULT/BACKFILL 不再污染期望帧数）。
  - **飞书侧车（P1×3）**：健康探针如实报告——`syncAllToFeishu` 聚合子项失败
    （任一失败 → `recordFeishuSync(false, 首错)`，此前恒报 true）；`GET /api/feishu/report`
    改 POST（飞书建文档副作用归入写鉴权 fail-closed），README 同步；内置 web UI 处置表单
    与写鉴权脱节（永久 401/503）——顶栏新增「写权限」按钮（Bearer 头注入 + 401/503 可行动
    错误提示 + localStorage 持久），处置闭环恢复可用。
  - **测试红灯修复**：`stateCoverage.test.ts` 移除已删除孤儿页（Overview/Events）的期望
    （client 879/879 恢复全绿）。
  - **前端包体清理（P2）**：移除随 SPA 发布的死静态副本 `client/public/command_map`
    （232KB，生产 React CommandMap 不使用；历史原型保留在仓库根 `ui/command_map`），
    并修正 `app.tsx` 过期的「全屏 iframe」注释。
  - **文档/部署漂移**：README 路由口径 307/461 → 实测 323/481（唯一 323）并移除不存在的
    `GET /api/scheduler/weights` 行；`deploy/cloud/.env.compose.example` 版本 rc2 → rc4。

### Fixed
- **权威事实源收敛 + UX 缺口闭合（close-head-truth-ux-gaps）**：
  - **事实源假阴性修正**：`feature-status.yaml` 的 `decisionCockpit` 由「未实现」修正为已实现
    （CommandMap 决策驾驶舱 tab 已真实接线并调用后端 API），同步 README 能力状态清单。
  - **失效证据清理**：`schedulerV2` / `benchmarkScheduler` 引用已不存在的 `output/bench-*.json`
    替换为真实存在的基准文件。
  - **DB 受管表口径修正**：`schema-manifest.yaml` 与 `state.json` 的受管表数由 73 修正为 57
    （与 `managed_tables` 列表及 CHANGELOG/release-manifest 一致），`reconcile` dbConsistent 恢复 PASS。
  - **决策驾驶舱反馈诚实闭合**：调度反馈段由静默 `null` 改为显式「暂无调度反馈数据」空态。
  - **UX 缺口闭合**：状态色收敛至语义设计 Token；设备详情接入统一时间线；角色化 Quick Start 入口；
    清理未接线孤儿页（Overview/Events/CenterPlaceholder/ExamplePage）；修正 Alerts 离线横幅文案。
  - **代码质量债**：ingest 幂等查询 DB 失败由 fail-open 改为 fail-closed + 日志；work-orchestration
    死代码清理；audit 模块导入卫生；飞书 API 错误响应脱敏；跨工厂/CP-SAT 占位能力加 fail-closed 边界标注。

### Added
- **智能调度闭环补全（任务写路径接线 + 事件节流基础设施）**：
  - **任务写路径自动重排（10.1 关闭）**：TaskService 新增 `onTaskEvent` 回调注册表（task 模块零依赖，
    保持依赖叶子），TaskSchedulingBridge（scheduler 模块）注册回调 → `injectSchedulingEvent`
    （TASK_CREATED/TASK_UPDATED），fire-and-forget 不阻塞任务写路径；复用冷却去抖/级联/SAFETY 熔断。
  - **outbox 节流入队 `enqueueThrottled`（C4）**：合并窗口内同 eventType+entityId 的 pending 事件
    仅覆盖 payload（最终态合并），不新增行——resource.state_changed 等高频事件的事件风暴防护基础设施；
    合并不更新 sequence（无 SSE 缺口副作用），跨实体独立窗口。
  - 测试：task-scheduling-bridge（4）+ outbox-throttled（2）

### Fixed
- **运行时可用性收尾（走读报告 M1-M4 + L1-L3 全闭环）**：
  - **飞书 M1**：lark-cli spawnSync 加 20s 硬超时（防挂死永久阻塞事件循环），超时走 SIGTERM 错误路径。
  - **飞书 M2**：flushTelemetry 失败保留 buffer 重试（此前失败即清空 → 遥测数据丢失），
    成功移除已发送行 + 5000 条上限裁剪防无界增长；新增回归测试 2 例。
  - **边缘 M3**：`/api/status` 按 `_running` 状态如实报告（此前对象存在即报 healthy，未启动的
    inference/manager 冒充健康）；pipeline 补运行状态标记。
  - **边缘 L2**：演示 token 24h 过期 + 登录惰性清理（此前永不过期内存缓慢增长）。
  - **边缘 L3**：5 处静默 `except Exception: pass` 补日志（会话校验/body 排空/审计/模型信息/埋点）。
  - **飞书 L1**：卡片回调注释诚实化——仅支持事件订阅信封，旧格式 `{open_id, action}` 缺
    header.token 必然 401（安全边界，不提供无验签兼容路径）。
  - **M4**：legacy 入口启动打印装配差异警告（缺 12 模块 + metrics/ratelimit），引导 standalone。

### Added
- **智能调度 v0.7 第四批（Batch 10-11，调度闭环 + 前端结构 + 工程治理资产）**：
  - **影子评估自动化**：事件驱动 run 每 10 次自动对比候选策略（listVersions 找到 v+1）与活跃策略，
    结果写审计（scheduler.policy.shadow_eval），不激活任何候选（仅观测）。
  - **地图模式状态机**：新增 `map-mode-machine.ts` 纯函数模块（mode/level/replay 三态转换规则 +
    副作用映射），CommandMap 消费（handleViewOnMap 经状态机计算含 L3 联动）。
  - **地图着色纯函数抽取**：`entityColors.ts`（isExoDevice/getEntityColor/getDeviceColor/
    priorityLevelColor/resourceStatusColor），消除 FactoryMap 内联重复（走读 M 项）。
  - **工程治理资产**：`docs/decisions/OPEN-DECISIONS.md`（4 未决项：任务写路径接线/RLS 覆盖/
    CP-SAT 启用/lark-cli 异步化）；ADR-001（权重收敛）/ADR-002（事件驱动重排）/ADR-003（CP-SAT worker）；
    SECURITY.md 补充多租户隔离边界（RLS 白名单 vs 全局共享表）；verify 期望值来源注释；
    CI 增加 OpenAPI 路由零漂移门禁步骤。
- **智能调度 v0.7 第三批（Batch 8 剩余 + G5，边缘运行时与治理收敛）**：
  - **遥测帧格式对齐（H2 修复）**：新增 `edge/modeling/frame_adapter.py` 纯函数转换
    （分组帧 entity_id/event_time/pose/load → 扁平 device_id/timestamp/telemetry），
    `AdapterManager._read_loop` 插入转换（兼容双格式），消除生产路径 KeyError 隐患；
    与 inference features 消费键完全对齐。
  - **RLS 缓解**：`listRuns` 增加应用层 org 过滤（actor.primaryOrgId → 按 org 过滤运行历史，
    缺省不过滤向后兼容）；审计文档 `docs/reviews/rls-coverage-audit-2026-08-08.md`。
  - **verify 期望值去硬编码（G5）**：`run_migrations.js` 的 F61-02 域表计数从
    `schema-manifest.yaml` 派生（js-yaml），消除硬编码 6。
  - **迁移双基线收敛（8.2）**：`001_ewoh_managed_tables.sql` 头部标注 DEPRECATED（standalone 链唯一事实源）。
  - **双总线澄清（8.3 修正）**：确认 MessageBus（流式数据通道）与 EventBus（SSE 广播）职责分离，
    `kafka` 仅为兼容命名别名，无需统一（原 H1 判定修正并记录）。
- **智能调度 v0.7 第二批（Batch 5-9，实施计划 `docs/reviews/next-steps-implementation-plan.md`）**：
  - **权重体系收敛**：`SchedulingPolicyConfig` 新增可选 `weights` 段（workloadBalance/stationWait/changeCost/energy），
    `buildPolicy` 从配置读取（缺省保持现值 1/1/0.5/minBattery/30 向后兼容），策略调参不再需要改代码。
  - **SSE 去重有界化**：`seenEventIds` 改 LRU（5000 上限，超限淘汰最老一半），消除长期运行内存无界增长。
  - **设备能力匹配**：设备 `capabilities` 从型号派生（EXO-Pro → exo-lift）、任务 `requiredDeviceCapabilities`
    从 taskType 派生（搬运类 → exo-lift），资格/求解器能力约束首次真实生效。
  - **事件驱动级联**：`injectSchedulingEvent` service 层入口（事件 → 局部重排 → 世界状态路由/预占冲突
    scoped 级联重排，冷却去抖防风暴）；metrics 埋点（recordRun/recordFallback）。
  - **SAFETY_EVENT 派工熔断**：派工涉及安全阻断（L2/L3 open）人员/设备 → `SAFETY_BLOCK_DISPATCH` 拒绝下发。
  - **前端深化**：`execution.deviation` 事件失效 worldState（地图位置近实时）；冲突中心"定位地图"按钮
    （选中实体+收起面板）；覆盖面板候选资源选择器（按评分/技能/负荷排序，不可行候选含排除原因）。
  - **CP-SAT Worker 部署就绪**：`src/edge_platform/scheduler/cpsat/worker.py`（纯标准库 HTTP worker，
    POST /api/scheduler/v2/solve + health 探针）+ `deploy/cloud/Dockerfile.cpsat` + compose `cpsat` 可选服务
    （`deploy/cloud/docker-compose.standalone.yml` 内建 cpsat 服务，另提供独立
    `deploy/cloud/docker-compose.cpsat.yml` 仅启动 worker）；ortools 版本锁定 `==9.11.4210`
    （与 `src/edge_platform/scheduler/cpsat/requirements.txt` 一致）；
    ortools 缺失时如实返回 UNAVAILABLE 由云侧回退 heuristic。
- **智能调度 v0.7（四批增量，指挥地图 → 智能调度驾驶舱）**：
  - **任务派生建模**（`world-state.service.ts`）：`productionImpact`（priority 映射 urgent=1.0→low=0.1）、
    `safetyCritical`（taskType 白名单）、`candidateStations`（空间拓扑推导）从既有字段派生，无 schema 变更；
    PriorityEngine 生产影响因子首次真实生效。
  - **冲突增强**：新增第 13 类 `reservation_expiring`（预占 15min 倒计时预警）；
    `buildConflicts` 新冲突经 outbox 推送 `conflict.detected` SSE（内存去重防轮询重复推送）。
  - **事件驱动智能重排**：`POST /api/scheduler/events`（局部重排：影响分析→冻结无关任务→子图求解→熔断）；
    `POST /api/scheduler/feedback/actuals`（执行实际值回填，覆盖式更新幂等，回填后推送 `execution.deviation` SSE）；
    ingest 设备故障/离线转换自动触发 `DEVICE_OFFLINE` 重排（fire-and-forget，熔断不阻断真机接入）；

    `ReplanCoordinator.handleTrigger` 失败熔断（run 置 failed 不再卡 queued）。
  - **前端智能交互**（CommandMap）：新增「冲突中心」（13 类过滤/严重度排序/建议处置/三态）与「人工覆盖」
    （LOCK/EXCLUDE/PREFER/BOOST/LOCK_TIME → 重排 → before/after diff）；`useSchedulerStream` 消费
    `conflict.detected`/`execution.deviation` 实时刷新。
  - **OpenAPI 同步**：304 → 306 条路径零漂移；客户端 TS 类型重生成。
- **飞书侧车生产级加固 v1.1.0**（`ewoh-feishu-app`）：
  - **API 统一鉴权**：写操作 fail-closed（token 未配置 → 503，不匹配 → 401），Bearer/X-API-Key 双格式，常量时间比较。
  - **SQLite 落盘持久化**：默认文件库（WAL + busy_timeout）替代 `:memory:`，进程退出数据保留。
  - **webhook 业务幂等**：`webhook_dedup` 表 `(event_id, action_type)` 唯一约束，重复投递返回 `duplicated:true`；
    失败回滚可重试；closed 事件禁止再处置（409）。
  - **签名协议修复**：HMAC 时间戳按飞书协议用秒级字符串（原毫秒导致 encrypt_key 校验永远失败）。
  - **规则单一事实源**：规则引擎从 DB 加载（阈值可运行时调参）。
  - **启动不阻塞**：飞书集成延迟至 HTTP 就绪后初始化（lark-cli 不再阻塞 listen）。
- **AI 接入修复**：`ark.service.ts` 配置保存改用全局哨兵 org_id（原 INSERT 缺 org_id → NULL →
  `ON CONFLICT` 永不触发 → 无限插行且读取常拿到旧行，AI 接入整体失效）；`getConfig` 按哨兵精确读取 + 排序。

### Fixed
- **AI 接入失效**：`saveConfig` 未提供 `org_id` 列 → NULL → PG 唯一索引视 NULL 互不相等 →
  `ON CONFLICT (org_id, config_key)` 永不触发，每次保存插入新行；`getConfig` 无 org 过滤 + 无排序读取不确定行。
  修复为显式全局哨兵 `GLOBAL_ORG_SENTINEL`（固定 UUID）+ 按哨兵过滤 + `_updated_at desc` 排序。
- **Feishu webhook 签名**：HMAC source 使用毫秒时间戳（协议要求秒字符串），配置 encrypt_key 时签名永远不匹配。
- **Feishu 事件处置接口无鉴权**：`/api/events/:id/handle` 等写端点全站无鉴权，任何人可改事件状态。
- **Feishu 数据丢失**：SQLite `:memory:` 进程退出数据全丢，与 30s 全量同步设计矛盾。
- **调度 run 卡死**：`handleTrigger` 失败时 run 永远停留在 queued；现置为 failed 并记录日志。

- **角色工作台生产化深化与真实数据闭环**（`deepen-roleworkbench-production`）：
  - **数据库级列表查询**：`RoleWorkbenchService.getWorkbenchList` 改为真实 PostgreSQL 查询
    （参数化 WHERE 含强制 `org_id` / ORDER BY / LIMIT），删除 `.limit(5000)` 全表内存读取；
    稳定排序键 cursor 分页（`(sort, uniqueId)` 处理重复时间戳/优先级，无重复无遗漏）；
    页码模式单独准确 COUNT；`workbench-list-query.ts` 提供 cursor 编解码与稳定排序协议。
  - **占位业务数据消除**：`overdueInspections`/`dispositions`/`maintenanceTasks`/
    `capacityDegradation`/`riskTrend` 等改为真实 SQL 聚合或明确 `value/status/calculatedAt/
    dataRange/source` availability 表达（`no_data`/`not_configured`/`permission_denied`/
    `source_unavailable`/`stale`），前端 `workbenchDataStates.ts` 区分「真实为零」与「无数据」。
  - **保存视图 PostgreSQL 持久化**：`saved_views` 表 + `standalone_005_workbench_prod.sql`，
    org+owner 隔离、默认视图唯一、软删除；`PostgresWorkbenchViewStore` 为生产存储，
    内存实现仅作 test adapter。
  - **导出任务真实任务系统**：`workbench_export_tasks` 表 + `workbench-export-state.ts`
    状态机（queued/running/succeeded/failed/cancelling/cancelled/expired）、原子 claim
    （双 worker 不重复）、幂等、重试/退避、到期；`PostgresWorkbenchExportStore` 生产存储；
    审计日志记录谁/范围/记录数/文件大小/完成时间。
  - **发布真值**：`scripts/truth-status.js` 统一四态（NOT_RUN/FAILED/BLOCKED_BY_ENVIRONMENT/
    SUCCEEDED），`BLOCKED_BY_ENVIRONMENT` 不计为 PASS；Production Ready 由当前 SHA 门禁
    自动计算；`truth-gate.js` 对 STALE/SHA 漂移 fail-closed；镜像未构建时扫描不入 PASS。
  - **大数据量性能验收**：`scripts/perf/seed-workbench-data.js` + `workbench-benchmark.js` +
    `perf-gate.js` 生成 10k/100k 确定性数据并记录 p50/p95/p99、DB 执行/扫描/返回行数；
    `perf.yml` 接入 CI，超预算即失败。
  - **生产运行时门禁**：`runtime-gates.yml` + `verify-migration-prod.mjs` /
    `verify-backup-restore.mjs` / `verify-helm-runtime.sh` / `canary-deploy.sh` /
    `soak-load.js` / `container-image-gate.sh`；环境不可用项如实标 `BLOCKED_BY_ENVIRONMENT`
    并给出可复制命令。
  - **前端性能深化**：`bundle-budget.mjs` 首屏/异步 chunk 预算（首屏 175.09kB gzip < 460kB
    PASS；单异步 chunk 243.57kB < 520kB PASS）；`browser-metrics.mjs` 记录真实 LCP/INP/CLS。
  - 验收报告：`docs/reviews/deepen-roleworkbench-production-report.md`。

- 代码深化与用户体验闭环验收（全量门禁证据采集）：
  - **语义化设计系统**：`client/src/lib/designTokens.ts` + `client/src/tokens.css` 集中
    semantic design tokens（背景/表面/边框/文本、success/warning/danger/info、
    normal/degraded/offline/blocked/conflict/unknown、spacing/radius/typography/
    elevation/motion/z-index）；深色/高对比/prefers-reduced-motion 适配；
    `scripts/lint-design-tokens.mjs` 静态检查阻断业务页面新增未经批准硬编码样式值。
  - **统一对象时间线**：`server/modules/timeline/*` 统一时间线 DTO（鉴权+组织隔离），
    `GET /api/timeline/events`；`client/src/lib/timelineModel.ts` 客户端只消费统一 DTO；
    OpenAPI 契约注册（TimelineSource/PermissionVisibility/TimelineCredibility/
    TimelineEvidenceRef/TimelineEvent）。
  - **首次使用与样例工厂闭环**：角色化 Quick Start、可清除样例工厂、五分钟闭环引导
    （可跳过/恢复/重开+版本记录）、统一空状态与无权限/无设备/无数据/断连/同步中/
    初始化失败路径、匿名化产品事件。
  - **性能预算**：`client/src/lib/perfBudget.ts` + `scripts/bundle-budget.mjs` 真实
    预算门禁（首屏 JS 174.72kB gzip < 460kB；单异步 chunk 319.60kB < 520kB）。
  - **跨浏览器弱网与视觉回归**：可移植弱网注入（登录后断连/提交断连/离线队列重放/
    重复提交/冲突 409/SW 更新/刷新/多标签并发）；`ux009-weaknetwork.spec.js`；
    Linux Chromium 主金基线 + 本地 darwin 自检基线。
  - **前端资源生命周期统一**：`client/src/lib/runtimeLifecycle.ts` 统一 session/runtime
    生命周期（BroadcastChannel/WS/SSE/SW listener/timer/retry/AbortController/
    IndexedDB/Blob URL/event listener），覆盖卸载/登出/Token 失效/租户切换/角色切换/
    后台/网络恢复/SW 升级。
  - **安全扫描固定 CI**：Bandit 锁定 1.8.6（`security.yml` 实际运行+JSON 报告+
    `bandit-gate.py` 阻断未豁免 HIGH）、Gitleaks 秘密扫描（基线豁免历史遗留）、Node 生产
    依赖审计、SBOM（CycloneDX）校验、镜像漏洞扫描（Trivy，BLOCKED_BY_ENVIRONMENT）、
    suppressions 文件（带原因/责任人/到期）。
  - **真实运行门禁**：`docs/runtime-gates.md` 记录 PG migration 往返/HTTP+PG E2E/并发/
    备份恢复/Docker 健康的 CI 自动化与 Helm/soak 等 BLOCKED + 一键命令。
  - **错误与恢复体验**：核心页面 12 态一致 + 统一错误组件 `AppErrorState.tsx`
    （现象/影响/是否已保存/可执行下一步/可复制 trace|request id）。
  - 验收报告：`docs/reviews/code-deepening-ux-closed-loop-report.md`（修改内容/风险/
    文件清单/测试清单/验证命令/性能对比/无障碍跨浏览器/BLOCKED/技术债务/五级结论）。
  - **单一事实源**：`scripts/truth-manifest.js` + `scripts/truth-source.js` 由 CI 运行时读取
    `GITHUB_SHA`/`git rev-parse HEAD`，从 Jest JSON 自动取测试计数并生成 evidence manifest
    （evaluatedCommitSha/branch/buildVersion/environmentFingerprint/dependencyVersions/
    testStartedAt/testFinishedAt/verifier/workflowRunId/artifactDigest/expiration）；
    `version.json` 为唯一版本源头；`make truth-check` 漂移校验；漂移夹具与回归测试。
    `output/evidence-manifest.json` 为运行时/CI 派生产物不入库（避免自指失效与跨环境漂移）。
  - **前端可观测性贯通**：后端 `frontend-metrics` ingestion API（契约/DTO/校验/限流/组织隔离），
    前端批量发送/采样/失败退避/sendBeacon/离线暂存重放，发送成功前不清空本地；采集
    LCP/CLS/INP/TTFB/路由/API 延迟/失败率/白屏/异常/离线指标；关联 requestId/traceId/组织/页面/
    构建版本/设备类别并脱敏；后端摄取测试。
  - **离线队列端到端幂等**：所有离线写操作发送 `idempotencyKey`，后端持久化幂等结果、重复提交
    副作用只执行一次、不同 payload 拒绝；附件/action 同 IndexedDB transaction 与孤儿清理；
    多标签页 leader election；401 暂停引导重认证；409/412 冲突展示差异；真实加密与密钥生命周期。
  - **Service Worker 重构**：区分 app shell/静态资源/HTML/API/用户文件/鉴权/敏感响应；API 与
    敏感内容默认不缓存；新版本提示、「安全更新/稍后更新」、更新前保存草稿、上一稳定 shell 回滚。
  - **上传安全贯通**：服务端 magic bytes/真实 content-type/路径穿越/压缩包炸弹校验接真实入口；
    隔离区扫描状态；S3 签名 URL 组织边界；断点续传/取消/进度/失败恢复/requestId。
  - **角色任务工作台深化**：默认角色来自认证用户；服务端 RBAC 判定、不信任前端 role；行点击跳转
    具体实体；服务端分页/筛选/排序/导出（异步+进度+权限+到期+审计）；保存视图服务端持久化；
    危险操作影响预览/幂等确认/撤销；键盘/扫码/触摸/单手/手套输入。
  - **真实业务 E2E 与工业 UX**：`test/browser/ux009-uxindustrial.spec.js` 覆盖角色流程、会话过期、
    多标签登出、权限拒绝、跨租户、陈旧/部分失败、弱网/抖动/上传中断、浏览器关闭恢复、200% 缩放、
    键盘焦点、屏幕阅读器、reduced motion、高对比、触控目标、长时间运行/内存/队列堆积；跨浏览器
    （chromium/firefox/webkit/mobile/industrial-tablet）真实运行，非 Chromium 弱网用可移植
    `page.route` 网络注入。
  - **性能与依赖可复现性**：`bundle-budget.mjs` 真实 bundle 分析（main chunk 176.94KB gzip < 460KB）；
    路由懒加载避免首屏重模块；`check-licenses.mjs` 许可证扫描（0 强 copyleft）；SBOM（CycloneDX）；
    移除未使用高危依赖（xlsx/jspdf/html2canvas/echarts）并升级 axios/form-data/postcss；
    无 `@latest`、Actions 固定版本、确定性构建（CI 两次构建字节一致）。
- F61-01 单一事实源语义一致性：7 个版本化 JSON Schema、14 条跨文件语义规则、
  13 类漂移夹具检测；`audit-repo-facts.js --strict` 任一未豁免冲突即非零退出。
- F61-02 领域状态持久化（Code Complete / Runtime Verification Blocked）：
  6 张领域表 `ewoh_resource_locks` / `ewoh_handoffs` / `ewoh_git_sync_state` /
  `ewoh_evidence_metadata` / `ewoh_factory_replication_sessions` /
  `ewoh_idempotency_keys` 迁移（`standalone_004_ewoh_domain.sql`）与可逆回滚脚本；
  乐观锁 `version` CAS 列用于资源锁（holder+version 校验），其余事实由唯一约束/
  幂等键保证多实例安全；时间戳命名与 Drizzle Schema 对齐。
- `DomainPersistenceService` 作为持久化事实源，替换进程内 Map 单例；六类领域事实
  读路径以数据库为准，旧 Map/数组/JSON 仅作缓存或灾备副本。
- 事务边界：获取锁+审计、交接+责任转移、接受交接+状态更新、git-sync+证据、
  复制步骤推进+输出证据、幂等键+业务对象创建均置于显式 `db.transaction`，中途
  失败无部分写入。
- 多实例正确性：DB 时间 `now()`、唯一约束竞争锁、版本 CAS、过期锁安全接管、
  非持有者拒绝续租/释放、并发冲突返回明确错误。
- 代码层测试：`domain-persistence.service.spec.ts` 29/29 通过；真实 HTTP +
  PostgreSQL E2E 代码完整且标记 `BLOCKED_BY_ENVIRONMENT`（不伪造、不静默跳过）。
- CI 环境验证入口：GitHub Actions `standalone.yml` 提供 PostgreSQL Service Container，
  应用/验证/回滚/重放迁移、双实例并发（`scripts/verify-domain-concurrency.js`）、
  真实 HTTP E2E，并保存证据 artifact `f61-02-ci-evidence-<sha>`。

### Notes
- **F61-02 最终状态：`F61-02 Code Complete / Runtime Verification Blocked`**。真实
  HTTP + PostgreSQL E2E 因本地无 PostgreSQL / docker 暂阻塞，运行时门禁已移至 CI
  （`EWOH_E2E_RUNTIME_DATABASE_URL`）。在真实 E2E 解锁通过前不宣称 Production /
  Scale Ready，不启动 F61-03。

## [0.6.0-rc4] - 2026-08-04

### Added
- 仓库事实源一致性门禁：`scripts/audit-repo-facts.js` 校验 README 导航、CHANGELOG、
  发布清单、Task Board、门禁、OpenAPI 路由清单、数据来源词汇与错误契约；
  已接入 `scripts/standalone-check.sh` 与 `test.yml`（30/30 通过）。
- 统一错误契约补全：错误响应增加 `errorCode`、`requestId`、`retryable`、
  `recommendedAction` 与 `details`，`requestId` 与 Tracing 的 `x-trace-id` 关联。
- 数据来源词汇扩展为 `real / controlled_test / simulated / replayed / stale /
  offline`，OpenAPI 枚举同步；新增可复用 `DataSourceBadge`，设备页接入。
- `RequestDatabaseContext.runInTransaction` 复用活动请求事务，避免 Scheduler
  在 HTTP 事务内再开根事务连接。
- 移动工作台：SOP 说明展示、暂停/恢复、异常上报（写 `resultJson.exception`）、
  质检（新 `POST /api/mobile/.../quality`）、离线提示与失败重试入口。
- 全局 `ValidationPipe`（`APP_PIPE`）注册到 Legacy 与 Standalone 两个启动路径，
  `class-validator` 错误映射为统一 `fieldErrors` 与 `VALIDATION_ERROR` 422 响应。
- 指挥地图实体详情：人员档案（组织/岗位/班组/技能/风险/外骨骼）与设备档案
  （电量/固件/协议/故障/温度/最近通信），并展示关联告警、最近事件与处置入口。
- 移动工作台离线待同步队列：离线操作进入 `localStorage` 队列并显示待同步数量，
  恢复联网后按顺序自动提交；队列工具与单元测试覆盖。
- 控制指令状态守卫：终态（executed/timeout）禁止再次发送或回执，同一指令存在
  in-flight 尝试时禁止重复发送，终态尝试禁止重复回执；失败后仍允许重试发送。
- Work Orchestration 交接状态机：open → accepted/rejected → closed，非法跳转
  拒绝；门禁决定重复提交幂等，变更前决定写入 `gate-decision-history.json`。
- Scale 幂等守卫：已 installed/uninstalled 的场景包重复安装/卸载直接返回；
  fleet upgrade/rollback 跳过已处于目标状态的 Profile；已 resolved 的工厂
  差异重复解决直接返回。
- 本地真实 PostgreSQL E2E：HTTP + PostgreSQL 29/29 通过（embedded PG 17，
  `127.0.0.1:55432`），覆盖鉴权/RBAC、组织隔离、MES/OEE/ERP、Scale、
  参数、AAS、Work Orchestration 与幂等场景。
- 移动异常照片附件：异常上报表单支持选择 JPG/PNG/WebP 照片，先经
  `/api/files` 上传并把文件引用写入 `resultJson.exception.attachments`。
- PWA 可安装基础：`manifest.webmanifest` + 最小 Service Worker + 客户端注册，
  Standalone 页面可安装到移动端/工业平板；repo-facts 增加 PWA 资产门禁。
- 离线照片队列：离线异常照片以 Data URL 存入待同步队列（约 2MB 上限），
  恢复联网后先上传 `/api/files`，再把文件引用写入异常附件后提交。
- 发布验证证据：`RELEASE DRILL PASSED`（PG apply/verify/RLS/audit/rollback/
  rebuild + 全门禁 + E2E 29/29）；性能冒烟 4610 QPS / p95 26.83ms；
  `STANDALONE SECURITY VERIFY OK`。
- 浏览器证据：Playwright 对 Standalone `/login` 在移动端（390x844）与桌面端
  （1440x900）截图，输出到 `output/playwright/iteration-login-*.png`。
- 请求关联：TracingInterceptor 通过 `AsyncLocalStorage` 把 `requestId` 传给
  审计写入路径，`AuditLogEntry.requestId` 自动填充；repo-facts 增加
  `request_context_correlation` 门禁。
- 错误脱敏：`HttpException` 不再把原始响应对象序列化进 `details`；
  Site Readiness 解析失败只返回通用错误码，不泄露底层异常文本。
- 设备页加载状态：失败时显示可重试错误状态，并展示最近更新时间，避免把
  加载失败误渲染为“未找到设备”。
- 静态安全扫描本地可执行：`python3 -m bandit -r src/edge_platform -ll`
  扫描 28286 行，0 medium/high。
- 指挥地图查询状态：空间实体/世界状态/总览/环境任一查询失败时显示错误横幅
  与“全部重试”，不再静默渲染为空地图。
- 版本同步：Helm appVersion、Compose/K8s 默认值、运行时默认版本与相关测试
  从 `0.6.0-rc3` 提升到 `0.6.0-rc4`。
- 认证浏览器测试：新增 `npm run test:browser`，用真实 PostgreSQL fixture 启动
  Standalone，Playwright 完成 dispatcher 登录、指挥中心、指挥地图、移动工作台
  和风险告警渲染（4/4），截图到
  `output/playwright/browser-authenticated-command-center.png`。
- CI 接入：`standalone.yml` 在 E2E 后安装 Playwright Chromium 并运行
  `npm run test:browser`，推送/PR 都会执行认证浏览器流程。
- 交付文档同步：`acceptance-evidence.md` 与 `release-checklist.md` 记录 RC4
  本地门禁、E2E、浏览器、性能、安全和发布包证据。
- README 更新为全栈产品导航：Python 边缘平台、Standalone 云产品命令、
  Playwright 浏览器门禁与 `0.6.0-rc4` 发布包校验。
- Pilot 就绪门禁重跑：本地 7 项通过（含数据库验证/运行库连接），3 项因
  本机无 Docker/Kubectl/Helm 失败，5 项等待外部批准与现场输入。
- 运维备份/恢复门禁重跑：`standalone-ops-check.sh` PASSED，57 表逻辑备份、
  恢复到一次性数据库、行数校验与身份序列推进全部通过。
- P0 移动工作台硬化：工作台按 `assigned_person_id` + `org_id` 过滤并
  fail-closed；扫码支持工单/工序/设备/物料/批次/工位/工厂类型识别；
  异常附件服务端持久化；离线队列增加
  `local/queued/syncing/synced/failed/conflict` 状态，单项失败不再阻塞后续项；
  `worker` 角色开放移动工作台。
- Work Graph 证据绑定与失效：证据 Markdown 支持 front matter
  （`commitSha/branch/buildVersion/envFingerprint/dependencyVersion/testTime/
  verifier/expiresAt`），解析器自动推导并输出
  `valid/stale/expired/unbound` 状态；`--invariants` 检查孤立边、循环依赖、
  重复 ID 与无 Owner 任务。
- 新增 `tools/work-console` 一键阻塞诊断 CLI：回答当前卡点、原因、解除人、
  缺失证据与受影响任务；接入 `standalone-check.sh` 与 CI。
- 修正 Task Graph 依赖引用为真实节点 ID，消除 19 条孤立边；重新生成
  `output/work-graph.json`、`output/gate-decisions.json`、
  `output/git-sync.json` 并新增 `output/work-console.json`。
- 独立审查修复：worker 只能操作 `assigned_person_id` 归属自己的工序；
  离线冲突项提供丢弃入口且不再自动重放；CI 使用
  `work-indexer --strict --invariants`；扫码空请求体返回 400 而非 500。
- Onboarding F0-F3 真执行：F0 校验场地就绪证据，F2 发布并核验连接器，
  F3 安装并核验场景包，均写审计。
- 映射 Dry Run：`POST /api/scale/mappings/:id/dry-run` 对样本载荷执行规则，
  返回 `REQUIRED_FIELD_MISSING`/`TRANSFORM_ERROR` 并定位源字段与目标字段。
- 真实数据库验证：HTTP+PostgreSQL E2E 29/29 通过，认证浏览器流程 4/4 通过。
- 世界回放统一时间轴：`/api/world/replay` 合并任务/工序/物料/质检/告警泳道，
  新增事件前后对比接口与从回放创建跟进问题的审计链路。
- E-SOP：`/api/mes/sops` 支持版本注册、发布与 Diff；工序可绑定 SOP、强制
  步骤、必需工具/物料；开工与报工前强制签收并记录签名。
- 质检方案：`/api/mes/quality-schemes` 支持首检/巡检/终检方案注册、发布与
  自动匹配；质检接口强制必检项并校验结果一致性。
- 慢查询观测：数据库事务支持 `statement_timeout` 与慢事务阈值记录，新增
  `GET /api/observability/slow-queries` 与 `ewoh_slow_queries_total` 指标。
- 前端性能：页面路由改为 `React.lazy` 分块加载，Standalone 主包从约 2.3MB
  降至约 374KB；世界状态与回放请求支持 `AbortSignal` 取消。
- MES 角色工作台：`GET /api/operations/role-workbench` 聚合操作员、班组长、
  质检、设备与管理者视图，新增 `/role-workbench` 页面。
- 渐进列表：新增 `progressiveSlice/hasMoreItems/nextProgressiveLimit`，
  角色工作台大列表先渲染 50 条并支持“加载更多”。
- Pilot Go/No-Go 重跑：7 通过 / 3 失败（本机无 Docker/Kubectl/Helm）/
  5 待批准，结果仍为 NOT READY。
- 事件中心新增“回放上下文”：展示事发前/事发时/处置后的快照摘要。
- 编排控制台新增受写回与人工批准保护的 `POST /api/work/git-sync/apply`。
- 最终全量门禁重跑：`ALL STANDALONE CHECKS PASSED`（真实 PG E2E 33/33、
  浏览器 5/5、server 81/391、client 15/50、OpenAPI 253/253）。

## [0.6.0-rc3] - 2026-08-04

### Added
- 采用 Final 6.0 权威基线：`authoritative-plan-final6.txt` 入库，
  决策 D-033 记录；新增 EWOH Work Orchestration Control Plane 产品主线。
- C7 Work Graph / C8 Asset Catalog / C9 Factory Profile 契约：
  `contracts/work/work-graph.schema.json`、`contracts/work/artifact-paths.json`、
  `contracts/catalog/asset-catalog.schema.json`、
  `contracts/factory/factory-profile.schema.json` 及示例与严格审计脚本。
- Work Graph 文件化索引器：`tools/work-indexer` 将 `.codex/artifacts` 解析为
  `ewoh:///work-graph/v1`，含路径注册表、校验和、冲突检测与严格 CLI。
- Gate Engine：`tools/gate-engine` 分离规则状态与人类决定，G10-G13 默认
  要求人工批准。
- 资源锁与交接服务：`tools/resource-registry`、`tools/handoff-service`，
  锁/交接记录以文件形式落盘并受 `EWOH_WORK_WRITABLE` 门禁。
- Work Orchestration API：`/api/work/*` 提供 overview/graph/items/evidence/
  agents/gates/risks/resources/handoffs/catalog 以及资源锁、交接和门禁决定
  写接口；`openapi/work-orchestration.yaml` 契约。
- GitHub Issue/PR 同步（离线优先）：`tools/git-sync/` 生成
  `ewoh:///git-sync/v1` 计划，`GET /api/work/git-sync` 与控制台 Git 同步页
  展示 issue/PR 关联缺口；真实创建必须人工批准并显式启用。
- 工厂复制验收：`tools/factory-replication/` 与
  `contracts/factory/replication-report.schema.json` 校验“无核心分支、Profile
  回放、配置/资产满足率≥80%、定制≤20%、差异已解决”的验收规则。
- 场地就绪检查：`tools/factory-replication/site-readiness.js` 与
  `contracts/factory/site-readiness.schema.json` 校验第二/第三工厂上线前
  的设备台账、ERP 端点、网络批准、培训计划和数据保留证据。
- 控制台体验深化：因果 DAG 支持缩放/平移、节点搜索、门禁状态筛选、
  证据类型/结果筛选；后端 `/api/work/items` 与 `/api/work/evidence` 支持
  `q/limit/offset`，资源锁按 `expiresAt` 自动过期释放。
- 证据内容预览：`GET /api/work/evidence/:id/content` 提供最多 500 行的
  证据文件摘要，前端证据抽屉内置行内预览。
- 门禁批量记录：`POST /api/work/gates/batch-decision` 一次写入多个门禁的
  人工决定；资源锁列表显示到期倒计时。
- 工厂场地就绪控制台：`GET /api/work/site-readiness` 扫描
  `catalog/factory-sites/*.json`，控制台新增“场地就绪”页签展示
  Go/No-Go 汇总。
- 交接状态流转：`POST /api/work/handoffs/:id/state` 支持接收/拒绝/关闭，
  状态写回 Markdown 记录，交接页提供对应操作按钮。
- 前端测试门禁：`client/jest.config.cjs` 与 `npm run test:client`，7 套件 /
  25 测试纳入 `standalone-check.sh`；审计链新增 100 条连续追加压力用例。
- 发布版本提升至 `0.6.0-rc3`：Helm appVersion、Compose/K8s/Standalone 环境
  默认版本同步更新；`release/ewoh-0.6.0-rc3` 包含 Final 6 工具、目录、
  制品与控制平面源码，1537 个文件并生成校验和。
- React 执行控制台：`/work-orchestration` 页面提供因果 DAG、门禁、证据抽屉、
  Agent、风险、资源锁、交接和 Final 6 资产目录视图。
- Final 6 资产目录：Order-to-Delivery、移动 E-SOP、质量追溯、库存协同四个
  场景包 Manifest，ERP 订单/库存连接器 Manifest，ERP→EWOH 订单/库存映射。
- 部署环境契约：`EWOH_WORK_ARTIFACTS_DIR`、`EWOH_WORK_TOOLS_DIR`、
  `EWOH_WORK_WRITABLE` 贯通 Standalone、Compose、Kubernetes 与 Helm；
  Docker 运行时镜像携带 `catalog/`、`tools/` 与 `.codex/artifacts/`。
- 验证证据：`round69-final6-work-orchestration.md`；Jest 74 套件 / 331 测试，
  前端 7 套件 / 27 测试，E2E 29/29，OpenAPI 231/231，Work Graph 202 节点 / 0 冲突，
  Python unittest 667 / pytest 120 / ruff 通过，release-drill 全通过，
  PostgreSQL 17 DDL/RLS/审计/回滚/重建全通过，本地门禁扫描全通过，
  性能冒烟 1368 QPS / p95 74.80ms，备份恢复 57 表通过，
  Release Review 34/34。

## [0.6.0-rc2] - 2026-08-03

### Added
- 真机接入协议对齐：`UnifiedExoFrame.to_storage_dict()` 标准格式（`entity_id`
  与嵌套 `pose`/`load`/`device`/`quality`）全量映射到 Ingestion 网关。
- 机器对机器租户上下文：`X-Org-Id` 或 `EWOH_INGEST_ORG_ID` 建立请求级
  `app.current_org_id` GUC，Ingestion 落库遵循 RLS 组织隔离。
- 游戏化资源分配真实持久化 E2E：`ewoh_schedule_plan` 与
  `ewoh_schedule_audit` 均验证 org 归属。
- 新增 IngestService/IngestGuard/GamificationService 单元测试与
  edge bridge 契约测试。
- PostgreSQL 逻辑备份/恢复工具：`scripts/postgres-logical-backup.mjs`，
  支持全部 `ewoh_*` 表导出、恢复、行数比对与身份序列回填。
- 一键恢复演练：`scripts/standalone-ops-check.sh`，覆盖建库、Schema、
  逻辑备份、恢复、行数校验与恢复后写入冒烟。
- 运维手册补全：告警分级与处置 SOP、故障注入、恢复演练、应急停止、
  自动运维检查均从占位升级为可执行流程。
- 培训计划升级为可执行版本 v1.1：四类 Session、角色化练习、真机接入、
  运维恢复练习与讲师复核要求。
- Prometheus 指标端点 `GET /metrics`：HTTP 请求计数、活跃请求、进程运行
  时间、数据库就绪检查计数。
- 部署工件本地校验：`scripts/verify-deploy-artifacts.js` 检查 Kubernetes、
  docker-compose 与 Dockerfile，共 62 项检查。
- 采用 Final 4.0 权威基线：`authoritative-plan-final4.txt` 与
  `delivery/01_开发基线/...最新研究升级版_Final4.0.docx` 入库，Final 3.0 保留
  为历史基线。
- MES P0 生产执行闭环：工单创建/释放/开工/完工、工序
  开工/报工/审核/交收、投料消耗、质量检验与审计，映射到既有
  `ewoh_schedule_task` / `ewoh_schedule_task_step` / `ewoh_resource_binding` /
  `ewoh_event`，48 张受管表包装不变。
- OEE/安灯闭环：设备状态时序、OEE 计算与停机原因分布、安灯状态机、
  SLA 升级通知与审计，复用 `ewoh_event` / `ewoh_notification`。
- ERP 连接器：入站订单幂等并自动生成工单、出站消息队列与确认/失败状态、
  对账汇总，复用 `ewoh_event` / `ewoh_schedule_task` /
  `ewoh_schedule_task_step`。
- 质量追溯图：工单→工序→投料→质量检验的节点与关系图。
- 移动工作台 API：按人员列出待办工序、扫码查工单、移动端工序状态流转。
- 移动工作台前端页面：扫码查单、待办工序列表、开工/报工/审核/交收操作。
- 采用 Final 5.0 规模化复制版权威基线：
  `authoritative-plan-final5.txt` 与 `delivery/01_开发基线/...Final5.0.docx`
  入库，Final 4.0 保留为历史基线。
- 规模化内核：工厂模板注册/继承/生命周期、模板安装生成工厂 Profile、
  资产包注册；新增 `ewoh_factory_template` / `ewoh_factory_profile` /
  `ewoh_asset_package`，受管表 48 → 57。
- 连接器/场景包目录：连接器（runtime/protocol/configSchema）与场景包
  （requires/workflows/policies）复用资产包注册；同一模板可安装多个工厂
  Profile，验证“第二工厂无分叉”。
- 资产一致性检查（TCK）：按连接器/场景包/模板/部署类型校验 Manifest。
- 工厂 Profile 回放：模板配置与 Profile 覆盖值合并，状态置为
  `replayed` 并写审计。
- 场景包安装门禁：安装前必须通过场景 TCK，失败返回 400 并保留审计。
- 舰队升级/回滚：`POST /api/scale/fleet/upgrade` /
  `/api/scale/fleet/rollback` 对组织可见 Factory Profile 批量变更状态并写审计。
- AsyncAPI/CloudEvents 事件目录：`contracts/events/event-catalog.yaml` 定义
  13 个事件类型与 13 条通道，`GET /api/events/catalog` 与
  `GET /api/events/catalog/:type` 提供只读 API，独立契约审计接入
  `standalone-check.sh`。
- Docker 运行时镜像携带 `/app/contracts`，事件目录在生产容器内可读。
- Helm 部署工厂：新增 `deploy/cloud/helm/ewoh` Chart，包含 Factory Values
  （工厂 ID/名称/升级环）、迁移 Job Hook、Deployment/Service/Ingress/HPA/PDB/
  本地 PVC 模板；Chart 不从 values 生成密钥。
- Helm 静态审计：`scripts/verify-helm-chart.js` 校验 Chart 元数据、values
  路径、模板清单与全部 `.Values.*` 引用；`npm run verify:helm` 与
  `test/contract/helm-chart.spec.ts` 纳入常规测试。
- Golden Factory Profile：`contracts/factory/golden-factory.yaml` 定义 7 个
  模块、3 个必需连接器与 4 个场景包；`POST /api/scale/golden-factory/install`
  一次完成模板发布、连接器发布、场景包 TCK 安装与工厂 Profile 安装/复用。
- Golden Factory 契约审计：`scripts/audit-golden-factory.js`（47 项检查）、
  `npm run contract:golden` 与 `test/contract/golden-factory.spec.ts`。
- Mapping DSL 与 Schema Registry：`contracts/mapping/mapping-schema.json`
  定义 `mappingId/name/version/source/target/rules` 契约，并提供
  `exoskeleton-telemetry-v1` 规范示例。
- Mapping 资产 API：`POST/GET /api/scale/mappings` 与
  `GET /api/scale/mappings/:id` 复用资产包注册表；TCK 增加 mapping 一致性
  检查（source/target/rules/schemaVersion）。
- Mapping 契约审计：`scripts/audit-mapping-contracts.js`（10 项检查）、
  `npm run contract:mapping` 与 `test/contract/mapping.spec.ts`。
- 升级环与 Fleet Ops：`fleet/upgrade` 与 `fleet/rollback` 支持按
  `dev/integration/shadow/pilot/small/full` 升级环分批执行，未指定环时保持
  全量操作兼容。
- Fleet 状态注册表：`GET /api/scale/fleet/status` 返回工厂 Profile 的环、
  状态、模板/资产包计数与环/状态分布。
- Support Bundle：`POST /api/scale/fleet/support-bundle` 生成脱敏诊断包
  （`includesSecrets: false`）并写审计。
- 舰队状态机契约：`contracts/state-machines/fleet.yaml` 冻结升级环与
  installed/replayed/upgraded/rolled_back 迁移关系。
- OTel 资源属性：`/metrics` 输出 `ewoh_resource_info`，携带工厂 ID、名称、
  升级环、发布版本与区域；环境契约贯通 Standalone、Compose、Kubernetes 与
  Helm。
- 部署工件校验升级到 66 项，覆盖 Compose 资源属性环境契约；Helm Chart
  静态审计 125 项。
- 兼容目录：`GET /api/scale/compatibility` 返回资产包与核心版本兼容矩阵，
  支持 `>=/<=/>/</=` 与空格 AND 范围；未声明范围的资产标记
  `unconstrained` 兼容。
- 策略引擎：`contracts/policy/policy-schema.json` 定义策略契约；
  `POST /api/policies/evaluate` 按 dot-path 规则求值，`GET /api/policies/examples`
  提供规范示例；`scripts/audit-policy-contracts.js` 纳入一键检查。
- 模板配置差异预览：`POST /api/scale/templates/:id/diff-preview` 只读合并
  模板默认配置与请求覆盖配置，返回 `added/changed/removed` 键差异，便于
  第二工厂安装前评估影响。
- 连接器运行时：`src/edge_platform/connectors/runtime.py` 提供 Manifest
  加载/校验、配置校验、健康检查、密钥脱敏与生命周期；新增
  `exoskeleton-frame` 与 `equipment-state` 样例连接器包。
- 工厂上线：`GET /api/scale/onboarding/checklist` 提供 F0-F6 步骤清单，
  `POST /api/scale/onboarding/run` 真实执行模板发布、连接器/场景包安装、
  Profile 安装、TCK 与 Support Bundle，并输出步骤级证据与审计。
- Scale Release 评审：`scripts/scale-release-review.js` 作为打包门禁，检查
  发布清单、包完整性、契约/文档/OpenAPI 与全部静态审计；已接入
  `scripts/package-release.sh` 与 `npm run release:review`。
- Workflow 引擎骨架：`contracts/workflow/workflow-schema.json` 定义
  角色化步骤流转；`POST /api/workflows/advance` 返回当前动作许可与
  角色过滤后的下一步；`mes-execution` 规范流程示例纳入契约审计。
- Feature Flag：`GET/PUT /api/system/feature-flags` 在
  `ewoh_system_config` 持久化组织级 `feature.*` 开关，写入限定
  `global_admin`，读取按 RLS 组织隔离。
- 边缘乱序/补传：`src/edge_platform/edge/backfill.py` 提供 `SequenceBuffer`，
  按序列号连续释放帧并拒绝重复/过期/超窗帧；补传后自动续传。
- 数字孪生资产包：`src/edge_platform/twin/package.py` 提供 Twin Manifest
  校验、标定健康检查与脱敏；新增离散机加工线/装配单元样例资产包。
- 伙伴影子交付：`GET /api/scale/onboarding/partner/checklist` 与
  `POST /api/scale/onboarding/partner/shadow-run` 复用真实 F0-F6 上线路径，
  配置标记 `partnerShadow` 并输出步骤级证据。
- Deployment TCK：`scripts/deployment-tck.js` 将部署工件（66项）、Helm Chart
  （125项）与 Scale Release 评审（24项）串成统一部署验收门禁；
  `npm run deployment:tck` 一键执行。
- 规模化运营前端：新增 `/scale` 页面，展示模板/Profile/资产/兼容目录，
  并支持从页面执行 F0-F6 工厂上线运行。
- ERP/MES 连接器 Profile：新增 `erp-mes-profile-1.0.0` Manifest，配置使用
  `secretName` 引用而非内嵌凭证，并纳入 Connector Runtime 测试集。
- 规模化指标：`GET /api/scale/metrics` 输出模板/Profile/资产/场景/连接器/
  映射计数、发布率、升级环分布与兼容性汇总。
- 场景包卸载：`POST /api/scale/scenario-packs/:id/uninstall` 将场景包置为
  `uninstalled` 并写审计，补齐安装/演示/验收/移除生命周期。
- 连接器 TCK：`scripts/connector-tck.py` 与 `make connector-tck` 执行 11 项
  Manifest/配置/健康/脱敏/乱序补传检查。
- 场景包 TCK：`scripts/scenario-tck.js` 与 `npm run scenario:tck` 将
  Golden Factory/策略/Workflow/Mapping/事件目录 5 个审计串成场景验收门禁。
- 第三工厂演练：E2E 从同一已发布模板仅凭配置安装第三个工厂 Profile，
  验证无代码分叉、配置持久化与组织隔离。
- 工厂差异回收：`POST/GET /api/scale/differences` 将工厂差异登记为
  `diff.*` 配置项并写审计，支持后续平台化回收。
- 差异解决：`POST /api/scale/differences/:key/resolve` 将已回收差异标记为
  `resolved` 并写审计。
- 跨租户 TCK：`scripts/cross-tenant-tck.sh`、`make cross-tenant-tck` 与
  `npm run cross-tenant:tck` 把 HTTP+PostgreSQL 组织隔离 E2E 串成门禁。
- 工厂差异界面：`/scale` 页面新增差异登记表单、状态徽标与逐行解决操作，
  接入真实差异 API。
- Workflow 实例：`POST/GET /api/workflows/instances` 与
  `POST /api/workflows/instances/:key/advance` 将实例持久化到
  `workflow.*` 配置键，角色门禁推进并写审计。
- Support Bundle 界面：`/scale` 页面一键生成脱敏诊断包并展示
  bundleId/工厂数/敏感信息状态。
- Fleet 升级环界面：`/scale` 页面展示环分布，并支持按环升级/回滚操作。
- Workflow 实例界面：`/scale` 页面支持启动、列表与角色推进 Workflow 实例。
- 场景包界面：`/scale` 资产表支持场景包安装/卸载操作。
- 运营能力包：新增 `/api/operations/*`（17 条路由）覆盖维保资产/任务/工装
  生命周期、工作中心能力开关、标准工时与人员效率，记录复用
  `ewoh_scheduler_config` 并保持 RLS 组织隔离与审计链。
- 维保闭环：资产 `active/maintenance_required/decommissioned`、任务
  `planned/in_progress/completed/cancelled`，任务完成自动刷新资产下次维保
  日期并记录结果/备件/历史。
- 工装校验：校准周期、上次/下次校准时间与校准历史，支持校准/报废操作。
- 工作中心配置：首检、投料、报工审核、交收、扫码、外骨骼、风险确认与
  工装点检八类功能开关按工作中心持久化。
- 标准工时与人员效率：按工作中心/工序登记标准分钟，实际报工自动计算
  偏差、效率与人员公平性标准差。
- 运营管理前端：新增 `/operations` 页面，包含总览、维保资产、维保任务、
  工装校验、工作中心、标准工时与人员效率七个视图并接入真实 API。
- Sparkplug B 连接器：`src/edge_platform/connectors/sparkplug.py` 提供
  `spBv1.0` 主题解析、纯标准库 protobuf 载荷解码、出生/死亡/会话/序号状态
  与统一遥测帧适配器；新增 `sparkplug-b-1.0.0` Manifest 并纳入连接器 TCK。
- 连接器 TCK 升级：`scripts/connector-tck.py` 由 11 项扩展到 17 项，覆盖
  Sparkplug 主题、载荷、规范帧与会话状态检查。
- OpenFeature 语义功能开关：`POST /api/system/feature-flags/evaluate` 支持
  按组织/工厂/升级环/角色进行定位评估，默认安全关闭并返回
  `reason/variant/targetingApplied` 评估原因。
- 系统管理页新增功能开关评估器：输入开关键、升级环、工厂 ID 与角色即可
  查看当前上下文下的开启状态与评估原因。
- 参数注册中心：新增 `/api/parameters/*`（8 条路由）支持
  `number/integer/string/boolean/json` 类型参数、范围/来源/有效期、
  数值/枚举/正则校验、审批门禁、版本历史与回滚，记录复用
  `ewoh_scheduler_config` 并保持 RLS 组织隔离与审计链。
- 系统管理页新增参数注册中心 UI：登记表单、行内更新、
  审批/回滚/停用操作与汇总统计均接入真实 API。
- AAS/IEC 63278 资产壳：新增 `src/edge_platform/aas/codec.py`，纯标准库实现
  AAS 3.0 JSON 子集解析/导出、AASX 类似 OPC 包导入导出、孪生子模型双向映射
  与敏感值脱敏；提供离散机加工线 AAS 示例。
- AAS TCK：`scripts/aas-tck.py` 与 `make aas-tck` 执行 7 项检查，覆盖
  样例解析、JSON 往返、孪生映射、AASX 往返与脱敏。
- OPA 风格策略即代码：新增 `src/edge_platform/policy/rego.py`，纯标准库实现
  Rego 子集解释器（package/default/allow/deny[msg]、input 路径、比较、
  `in`/`not` 与消息捕获），并新增 `contracts/policy/deploy-gate.rego`
  部署门禁策略。
- Rego 部署门禁接入：`make rego-tck`（4 项检查）、`scripts/deployment-tck.js`
  扩展为 4 道门禁，`scripts/standalone-check.sh` 纳入 Rego TCK。
- AAS 资产注册 API：新增 `/api/aas/assets`（4 条路由）支持 AAS 资产导入、
  列表、详情与孪生语义映射，记录复用 `ewoh_scheduler_config` 并保持
  RLS 组织隔离与审计链。
- 数据资产页新增 AAS 资产壳视图：JSON 导入表单、资产清单与语义映射查看器
  均接入真实 API。
- OPC UA 连接器：`src/edge_platform/connectors/opcua.py` 提供节点 ID 解析、
  数据点规范化、质量码映射与边缘适配器；新增 `opcua-generic-1.0.0`
  Manifest 并纳入连接器 TCK（21 项检查）。
- Modbus TCP 连接器：`src/edge_platform/connectors/modbus.py` 提供寄存器
  地址/功能码/缩放校验、规范化遥测帧与边缘适配器；新增
  `modbus-tcp-generic-1.0.0` Manifest 并纳入连接器 TCK（25 项检查）。
- HTTP/Webhook 连接器：`src/edge_platform/connectors/webhook.py` 提供载荷
  规范化、常量时间 HMAC 签名校验与边缘适配器；新增
  `http-webhook-generic-1.0.0` Manifest 并纳入连接器 TCK（29 项检查）。
- CSV/File 连接器：`src/edge_platform/connectors/csvfile.py` 提供表头映射、
  行数据规范化与批量入队适配器；新增 `csv-file-generic-1.0.0` Manifest
  并纳入连接器 TCK（32 项检查）。
- OTel 风格请求追踪：`TracingInterceptor` 为每个 HTTP 请求生成
  `traceId/spanId` 并返回 `x-trace-id` 响应头；`TracingService` 维护有界
  追踪缓冲，`GET /api/observability/traces` 提供只读查询。
- Support Bundle 追踪：`POST /api/scale/fleet/support-bundle` 携带最近 20 条
  脱敏请求追踪与 `traceCount`，诊断包可直接用于伙伴/支持排查。
- 系统管理页新增请求追踪视图：展示最近 50 条 trace 的方法、路径、状态、
  耗时、开始时间与错误信息，并按运营刷新周期自动更新。
- RC2 发布包重新构建：`scripts/package-release.sh` 重新生成
  `release/ewoh-0.6.0-rc2`（1315 文件）与 `SHA256SUMS.txt`，Scale Release
  Review 24/24 通过。
- 最终门禁扫描：逻辑备份/恢复、场景 TCK、部署 TCK、AAS TCK、Rego TCK、
  连接器 TCK 与跨租户 E2E 全部通过，作为本轮交付证据。
- Pilot 就绪检查：`scripts/pilot-readiness-check.sh` 与 `make pilot-readiness`
  提供可执行 Go/No-Go 门禁，明确列出容器工具、数据库、试点工厂、生产批准、
  培训、验收签署与真机配置等未决阻塞项。
- RC2 发布包再次更新：将 Pilot 就绪门禁与最新证据纳入
  `release/ewoh-0.6.0-rc2`（1316 文件），校验和重新生成。

### Changed
- `ewoh_telemetry.assist_level` 由 `varchar(50)` 改为 `real`，与规范数值口径一致。
- 边缘桥接脚本与建模采集脚本支持 `--org-id` 并透传 `X-Org-Id`。
- 组织层级解析改为 `ewoh_find_org` / `ewoh_find_org_children`
  `SECURITY DEFINER` 函数，鉴权阶段不再回退到主组织。

### Fixed
- 真机帧因扁平字段不匹配而 400 的问题。
- 公共 Ingestion 端点缺少租户上下文导致 RLS 写入失败的问题。
- 安全探针固定夹具 UUID 与种子组织冲突，清理时误删“集团A”等种子行的问题；
  探针夹具已改为随机 UUID。

### Security
- Ingestion 缺少 `X-Org-Id` 且未配置 `EWOH_INGEST_ORG_ID` 时拒绝请求。
- OpenAPI 为全部 7 条 Ingestion 路由增加 `X-Org-Id` 必填参数契约。
- 运行时角色通过 `SECURITY DEFINER` 查询组织层级，业务表 RLS 不被绕过。

## [0.6.0-rc1] - 2026-08-03

### Added
- 六类共享契约冻结：C1 数据、C2 API（106 条路由全量 OpenAPI）、C3 状态机、
  C4 安全、C5 UI、C6 DevOps，G2 门禁通过。
- 真实 HTTP + PostgreSQL E2E：11 条用例覆盖认证、RBAC、刷新令牌轮换/撤销、
  组织 A/B 隔离、控制/世界/审批持久化与系统配置组织隔离。
- 审批持久化：审批实例/步骤/操作映射到 `ewoh_event`、`ewoh_event_chain`、
  `ewoh_audit_log`，不新增物理表。
- 浏览器级 UI 回归：Playwright 覆盖登录、指挥中心、指挥地图、设备、告警。
- 发布准备：`scripts/standalone-check.sh` 一键检查、性能冒烟、
  `docs/delivery/release-manifest.yaml`。

### Changed
- RolesGuard 默认拒绝未声明角色的业务路由；refresh token 轮换与登出撤销。
- 系统配置唯一索引调整为 `(org_id, config_key)`；模拟器后台写库纳入 GUC 事务。
- 指挥地图回放改为真实快照投影；3D 模式按 mode 着色并支持 WebGL 降级。

### Fixed
- `QueryClientProvider` 缺失导致指挥地图/设备页白屏。
- `/api/world/replay` 时间参数序列化导致 500。
- 数据库 verify SQL 的 `policy_missing` 标量子查询缺陷。

### Security
- 刷新令牌不再可无限重放；登出会撤销服务端会话。
- 审计接口限制为安全/全局管理员；客户端登出同步调用服务端撤销。
- Python 静态安全扫描归零：bandit `-ll` 0 medium/high，ruff 0 错误。
- GitHub Actions 三工作流全绿：standalone/test/security，含 Docker 镜像构建。

## [Unreleased]

本次版本将现有单机演示原型升级为受控试点系统（spec 阶段 0 Task 2：建立工程基线）。

### Added
- 工程基线：新增 `pyproject.toml`、`requirements-dev.txt`、`.env.example`、`Makefile`，
  声明纯标准库零运行时依赖，统一 unittest 测试发现与 ruff/bandit 静态检查入口。
- 适配器标准化：定义统一适配层契约（`edge/protocol`、`edge/adapter`），支持
  `real` / `controlled_test` / `simulated` 三类数据源的可配置端口映射
  （`EWOH_ADAPTER_PORTS`），为真机接入与受控测试提供一致接口。
- 生产数据库：引入 `postgres` 作为可选生产后端（`EWOH_DB_BACKEND=postgres`），
  保留 SQLite 用于开发/单机；DB 仅接入内部网络，不直接对普通用户网开放。
- API 完善：补齐 OpenAPI 3.0 规范（`docs/api/openapi.yaml`），覆盖
  auth/me/devices/telemetry/events/tasks/query/audit/models/rules/scenario/reset 全部端点。
- 身份权限：引入认证后端选择（customer/oidc/local）、JWT 会话、角色化导出权限
  （`EWOH_EXPORT_ALLOWED_ROLES`）、登录失败锁定与会话超时。
- 审计：所有写操作与导出动作落入审计日志，可在 `GET /api/audit` 查询。
- 监控：定义系统/设备/推理/业务四级监控指标与告警处理流程（见 `docs/operations/`）。
- 备份恢复：定义数据库与证据数据的备份策略、保留窗口与恢复流程占位。
- 测试与故障注入：定义 13 层测试层级与 16 类故障注入清单（见 `docs/acceptance/`）。
- 现场试点分阶段：定义四区部署拓扑（`docs/deployment/`）与分阶段上线策略。
- Go/No-Go 门禁：定义 15 条上线门禁清单作为试点放行依据。
- CI/CD：新增 GitHub Actions（test/security/package）与 CODEOWNERS 安全边界审查。
- 安全策略：新增 `SECURITY.md`，明确平台安全边界声明与漏洞报告流程。
- 服务编排：新增 `docker-compose.yml`，定义 edge-gateway / ewoh-api / ewoh-adapter /
  ewoh-inference / postgres / redis / ewoh-logs 服务与内外网络隔离。

### Changed
- 项目版本由演示原型基线提升至 `0.6.0`，描述更新为「EWOH 受控试点系统」。
- 运行入口 `python -m edge_platform.run` 保持不变，新增 `--stub` 显式回退开关的工程化说明。

### Security
- 明确平台不得写入急停 / 限扭 / 关节实时控制 / 助力实时闭环 / 限速放宽 /
  异常退出保护 / 设备失联安全态 / 绕过本地安全检查的调试指令，这些保留在设备控制器。
- 默认不采集姓名 / 身份证 / 长期精确轨迹 / 视频 / 生理数据。
- 高频原始遥测保留 7-30 天，超期降采样或清除。
- 默认不开放公网，TLS 由 edge-gateway 终结。
