# ADR-051：Canonical Exo Configuration Model（Assist Profile / Fit / Calibration，NO-13b）

- 状态：Accepted
- 日期：2026-08-16
- 关联：ADR-032（Exo Session 绑定契约）、ADR-006（规范身份）、
  ADR-043（Capability 契约——kind 封闭注册表 + 判定事实完整的同款
  结构纪律）、§3（Factory Truth）、§7（外骨骼一等实体：Support Mode /
  Assist Profile / Fit / Calibration）、§30/§31/§33

## 背景

§7 要求外骨骼领域模型包含 Support Mode / Assist Profile / Fit /
Calibration。现状（逐实现读码审计）：

- 绑定 Session：已落地（ADR-032 契约 + standalone_046 台账 + R-54
  端到端，worker-exoskeleton-loop Implemented）；
- 遥测：NY-EXO-A1 适配器 → UnifiedExoFrame（pose/load/device/quality
  + assist_level/torque_nm 观测）——**无 Support Mode 观测**（厂商
  协议 2.3 无 mode 字节）；
- Assist Profile / Fit / Calibration：**无任何领域模型**——参数/模式
  语义散落为 raw 遥测数字（assist_level 0..1 无来源语义、无模式、
  无 fit/calibration 事实）。

矩阵 exoskeleton-domain-model 据此保持 Partial（Session 部分已收口，
缺口精确为 Fit/Calibration/Assist Profile + Support Mode 词汇表）。

## §29 十八问（实现前作答）

1. **Domain**：Exo 域（§7 外骨骼一等实体——配置/校准/适配事实）。
2. **Canonical Contract**：新建 `ewoh:///exo/exo-config/v1`（本轮
   建立；此前无契约）。
3. **Authoritative Source**：contracts/exo/exo-config.schema.json +
   test-vectors（Python/TS/JS 仲裁三方锁步消费）。
4. **如何改变 Factory World**：契约层不直接改世界状态——ExoConfig
   记录是外骨骼配置事实（模式/参数/适配/校准），生产接线（边缘
   适配器 Support Mode 观测 + 云侧台账，NO-13c）落地后进入 World
   State 投影（worker↔exo 能力匹配的配置依据）。
5. **Event**：本轮无新事件类型（契约层）；配置事实事件随 NO-13c
   台账接线立项。
6. **谁消费**：调度能力匹配（lift_assist 模式 ↔ 任务工效需求）、
   外骨骼管理面、Session 适配依据。
7. **失败会怎样**：校验 fail-closed——未知 kind/status/supportMode/
   calibrationKind/result 显式拒绝（绝不静默归一）；错误码可解释。
8. **离线会怎样**：边缘用同一 Python 实现离线校验（双实现目标）；
   记录不依赖云可达性。
9. **重复消息会怎样**：契约层只约束形状；configId 幂等去重归持久化
   层；规范前缀 `exo-config:` 保证全局可寻址。
10. **权限边界**：契约不做授权（服务层）；auditTrail 强制 + setBy/
    fitter/calibratedBy 判定事实保证事后可审计。
11. **租户边界**：tenantId 必填（与 decision/entity 契约同口径；
    多租户工厂的设备配置事实隔离）。
12. **安全风险**：配置事实记录（supervisory）；**绝不**下发实时
    助力参数给设备控制器（§2 边界不变——assist_level 等参数是
    平台认知事实，不由 EWOH 写入安全实时闭环）。
13. **Human Approval**：fit/calibration 由人工操作员执行（fitter/
    calibratedBy 必填）；profile 激活为配置管理动作（服务层权限
    控制，契约记录 setBy）。
14. **如何解释 Decision**：记录含来源事实（who/when/status/supersede
    链），状态推进可追溯；无 LLM 参与。
15. **如何测试**：共享测试向量 + Python/TS 双实现逐条 + audit
    domain 独立 JS 仲裁 + Golden 第 25 场景双执行器 + 本机回归。
16. **如何审计**：auditTrail 非空强制（actor 规范身份 + action 非空
    + at ISO，与 decision 契约同规则）。
17. **如何迁移**：无 DB 变更（本轮契约层）；台账（standalone_051）
    与投影接线为 NO-13c（§30 先修契约再修实现）。
18. **如何回滚**：全 additive 新文件——回滚 = 删除契约/双实现/仲裁
    行/Golden 场景。

## 决策

### 决策 1：ExoConfigRecord 契约（kind 封闭 + 判定事实完整）

`contracts/exo/exo-config.schema.json` + 共享向量 + Python/TS 双实现
+ audit-domain-contracts exo-config 域 + Golden 第 25 场景：

- **kind 封闭注册表（3 类）**：assist_profile / fit / calibration；
- **supportMode 封闭注册表（8 类，v1 目录）**：passive / lift_assist
  / carry_assist / stand_assist / balance_assist / upper_limb_assist
  / lower_limb_assist / **vendor_specific**（厂商模式显式桶——
  未知模式合法且显式，vendorModeName 必填，绝不静默改写为平台
  模式，§33）；
- **calibrationKind 封闭注册表（3 类）**：zeroing / load_cell / imu；
- **status 按 kind 封闭**：assist_profile={active, superseded,
  retired}；fit={pending, fitted, adjusted, invalidated}；
  calibration={pending, passed, failed}；
- **判定事实完整（按 kind）**：
  - assist_profile：supportMode 必填；parameters.assistLevel ∈[0,1]
    有限数值（可缺省=显式不携带）；effectiveFrom 必填 ISO；
    effectiveTo ≥ effectiveFrom（时间不倒退）；superseded 必带
    supersededBy；
  - fit：personId 必填（规范身份 person: 前缀——fit 是"这台外骨骼
    适配于这个人"的物理事实）；fittedAt 必填；fitter 必填（规范
    身份）；measuredValues 可选有限数值映射；
  - calibration：calibrationKind 必填；result 必填；calibratedAt/
    calibratedBy 必填；nextDueAt ≥ calibratedAt；
  - 公共：configId 规范前缀 `exo-config:`；exoId 规范身份
    （device: 前缀）；tenantId 必填；auditTrail 非空强制。

### 决策 2：契约层先行（台账/投影为 NO-13c）

本轮交付契约层；standalone_051 台账 + 边缘 Support Mode 观测接线
（厂商协议暴露 mode 语义后）为 NO-13c——与 ADR-043→ADR-044 同纪律
（先立单一事实源，再逐点收敛）。矩阵保持 Partial 直至生产接线。

## 后果

- 正：§7 Support Mode/Assist Profile/Fit/Calibration 获得跨运行时
  契约（模式词汇表封闭 + vendor_specific 显式桶 + 判定事实完整 +
  时间不倒退 + auditTrail 强制）；§3 单一事实源落地。
- 负：契约层未接线前不参与生产调用链（NO-13c 台账/投影）。
- 无破坏性变更（全 additive；既有 exo_session 契约不变）。
