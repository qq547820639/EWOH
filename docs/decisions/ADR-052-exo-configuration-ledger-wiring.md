# ADR-052：Exo Configuration 台账与写路径接线（NO-13c）

- 状态：Accepted
- 日期：2026-08-16
- 关联：ADR-051（exo-config 契约层，决策 2 的后续轮次）、ADR-032/
  ADR-033（Session 台账 + 事件投影同纪律）、§5/§7/§15/§33/§36

## 背景

ADR-051 落地了 exo-config 契约（kind/supportMode/calibrationKind 封闭
注册表 + 判定事实完整 + 双实现 + 581/581 + Golden 第 25 场景），但
配置事实尚无台账与生产写路径。本轮按 ADR-032→ADR-033 的既有纪律
（契约 → standalone 台账 + 服务唯一权威写路径 + 事件 + API）接线。

## §29 十八问（实现前作答）

1. **Domain**：Exo 域（§7 外骨骼配置事实的台账与写路径）。
2. **Canonical Contract**：`ewoh:///exo/exo-config/v1`（ADR-051；
   写路径复用 validateExoConfig 共享实现 §31）。
3. **Authoritative Source**：contracts/exo/exo-config.*；台账行
   record_json = 契约形态全量（决策留痕）。
4. **如何改变 Factory World**：配置事实落账（设备模式/参数/适配/
   校准历史）——管理面与后续调度投影的单一事实源。
5. **Event**：新增目录事件 `ExoConfigRecorded`（channel
   exo.config_recorded）——与 Session 事件同纪律（§5）。
6. **谁消费**：外骨骼管理面、NO-13d 的 World State 投影（active
   assist_profile → 调度能力匹配）。
7. **失败会怎样**：契约门拒绝（validateExoConfig fail-closed）显式
   400；幂等重放安全（ADR-033 决策 3 模式）。
8. **离线会怎样**：云侧台账；边缘配置事实经既有上行链路提交（与
   绑定事实同路径）。
9. **重复消息会怎样**：同 (org_id, config_id) 幂等返回既有行
   （at-least-once 投影安全）；DB 唯一索引双保险。
10. **权限边界**：API 鉴权（ANY_AUTHENTICATED_ROLES，与 sessions
    同面）；RLS FOR ALL TO service_role。
11. **租户边界**：org_id 作用域（他租户配置绝不可见 §15）；RLS
    exo_config_org_isolation 双保险。
12. **安全风险**：supervisory 配置事实记录（§2 边界不变——绝不
    下发实时助力参数给设备控制器）。
13. **Human Approval**：fit/calibration 由操作员提交（fitter/
    calibratedBy 判定事实在契约强制）；profile 激活为配置管理动作
    （服务层 CAS 收敛 active 唯一）。
14. **如何解释 Decision**：activateProfile 的 supersede 链显式
    （supersededBy 必填）+ audit 留痕。
15. **如何测试**：exo-config.service.spec（契约门拒绝 / 台账往返 /
    幂等 / activate supersede CAS / 租户作用域 / kind 判定事实）；
    controller 经 OpenAPI 路由审计覆盖。
16. **如何审计**：audit log（scheduler 同款 appendAuditLog）+
    record_json 契约形态全量留痕。
17. **如何迁移**：standalone_051 新受管表（managed 73→74、physical
    76→77、verify 列表 67→68；RLS + 唯一索引 + kind/status/时间
    CHECK）；全 lockstep（runner/check script/CI/state.json/
    schema-manifest/CHANGELOG 受管表箭头/release-manifest gate）。
18. **如何回滚**：standalone_051.rollback DROP TABLE；服务端摘除
    模块即回滚（契约层保留）。

## 决策

### 决策 1：standalone_051 ewoh_exo_config（TENANT_SCOPED 受管表）

列：org_id / config_id / kind / exo_id / status / support_mode /
vendor_mode_name / parameters_json / effective_from / effective_to /
superseded_by / set_by / person_id / fitted_at / fitter /
measured_values_json / calibration_kind / result / calibrated_at /
calibrated_by / next_due_at / record_json / created_at / updated_at；
约束：unique (org_id, config_id)、RLS exo_config_org_isolation、
CHECK kind ∈ 3 类、CHECK status 按 kind 合法、CHECK
(effective_to IS NULL OR effective_from IS NOT NULL AND
effective_to >= effective_from)、CHECK (calibration → result 非空、
fit → person_id 非空) 等判定事实纵深（服务层契约门之外的 DB 兜底）。

### 决策 2：ExoConfigService 唯一权威写路径

- record(input, orgId)：构造契约形态 → validateExoConfig 门 →
  幂等（同 org+configId 返回既有行）→ insert + audit + 目录事件
  ExoConfigRecorded；
- activateProfile(exoId, supportMode, params, setBy, orgId)：同
  (org, exo, mode) 既有 active 全部 CAS→superseded（supersededBy=
  新 id）→ 插入新 active（active 唯一性服务层强制）；
- list/get：租户作用域（§15）。

### 决策 3：边缘 Support Mode 观测 = NO-13d（显式边界）

NY-EXO-A1 协议确认书 2.3 无 mode 字节——边缘不伪造 Support Mode
观测（§33）；厂商协议暴露 mode 语义后接线 UnifiedExoFrame.support_
mode 字段 + 投影。本轮台账写路径由操作员/配置管理面驱动（fit/
calibration/profiles 是人工配置事实）。

## 后果

- 正：§7 配置事实进入生产调用链（台账 + 契约门 + 事件 + API）；
  exoskeleton-domain-model §36 全绿升 Implemented（矩阵 51/4/0/1→
  52/3/0/1）；Decision/Exo 台账家族再 +1。
- 负：Support Mode 自动观测待厂商协议升级（NO-13d 显式边界）。
- 无破坏性变更（新表 + 新模块 + 新事件，全 additive）。
