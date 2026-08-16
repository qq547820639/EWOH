# ADR-069：Exo Support Mode 观测边界复核与锁定（NO-13t）

- 状态：Accepted
- 日期：2026-08-16
- 关联：ADR-051/052（Exo Configuration 契约/台账；NO-13d 边界）、
  NY-EXO-A1 协议确认书 2.3、§7/§33

## 背景

NO-13d/ADR-052 声明：边缘 Support Mode 自动观测受厂商协议阻塞
（NY-EXO-A1 协议确认书 2.3 无 mode 字节）。NO-13t 复核仓库事实：
确认阻塞是否仍然成立，并以测试机器锁定边界（§33 不伪造观测）。

## 仓库事实复核结论

- TELEMETRY 20B 布局（protocol.parse_telemetry_payload）：9×i16
  （pitch/roll/accel×3/gyro×3/torque）+ assist_pct u8 + battery_pct
  u8——**无 mode 字节**；assist_pct 为助力强度百分比（连续量），
  非 categorical Support Mode；
- IDENT/FAULT/HEARTBEAT 载荷同样无 mode 字段；
- VENDOR_TO_UNIFIED 映射无任何 mode/support 语义路径；
- UnifiedExoFrame：load.assist_level（数值强度事实）——无
  supportMode 字段；
- 结论：**阻塞仍然成立**——Support Mode（passive/lift_assist/…）
  的自动观测在厂商协议升级前不可观测；assist_level 数值事实可
  观测但不得推导为模式分类（§33）。

## §29 十八问（实现前作答）

1. **Domain**：外骨骼遥测观测面（§7）。
2. **Canonical Contract**：UnifiedExoFrame（edge 语义帧）；Support
   Mode 词表 = ADR-051 ExoConfigRecord（人工声明配置契约）。
3. **Authoritative Source**：NY-EXO-A1 协议确认书 2.3（厂商帧
   布局唯一事实源）+ 协议解析器实现。
4. **如何改变 Factory World**：零改变（边界复核 + 测试锁定）。
5. **Event**：无。
6. **谁消费**：遥测消费链（不变）。
7. **失败会怎样**：协议升级引入 mode 字节 → 边界测试失败（显式
   提示回此边界复核——机器守护而非静默漂移）。
8. **离线会怎样**：不适用。
9. **重复消息会怎样**：不适用。
10. **权限边界**：不适用。
11. **租户边界**：不适用。
12. **安全风险**：不伪造观测本身即安全语义（§2 边界不变）。
13. **Human Approval**：不适用。
14. **如何解释 Decision**：supportMode 仅来源于人工声明配置
    （ExoConfigRecord）；遥测 assist_level 数值与配置 mode 并列
    呈现，绝不推导分类。
15. **如何测试**：test_ny_exo_a1_contract.py +3 例边界锁（20B
    布局无 mode 字节字段集锁定 / 统一语义帧无 support_mode 字段 /
    VENDOR_TO_UNIFIED 无 mode 语义路径）。
16. **如何审计**：协议升级触发测试失败 → 变更留痕（§24）。
17. **如何迁移**：无代码变更（仅测试锁定 + 文档）。
18. **如何回滚**：删除测试即回滚（无实现变更）。

## 决策

### 决策 1：边界维持（阻塞仍成立）

Support Mode 自动观测继续显式阻塞（OPEN 边界，随厂商协议升级
解除）；不引入任何基于 assist_pct 阈值的模式分类推导（§33）。

### 决策 2：机器锁定边界

+3 例契约测试：TELEMETRY 字段集锁定（多出字段即协议变化）、
统一语义帧无 support_mode 字段、VENDOR_TO_UNIFIED 无 mode 语义
路径——协议升级时必须显式回此 ADR 复核（失败即漂移信号）。

### 决策 3：assist_level 数值事实照常观测

assist_level（数值强度）继续进入统一帧（真实事实，与配置 mode
并列呈现）——与"不伪造分类"边界不冲突。

## 后果

- 正：边界以测试机器锁定（§33 不伪造观测的守护）；协议升级时的
  漂移信号显式；无实现变更风险。
- 负：无。
- 无破坏性变更（仅测试 + 文档）。
