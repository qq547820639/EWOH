# ADR-001: 调度权重体系收敛为策略版本化可配

## Status: Accepted (2026-08-08)

## Background
`buildPolicy` 硬编码求解器目标权重（workloadBalance=1 / stationWait=1 / changeCost=0.5 /
energy=minBatteryPct/30），调参必须改代码 + 重新部署；且与版本化 SchedulingPolicy 的
"策略可复现、可影子评估"目标冲突。

## Decision
`SchedulingPolicyConfig` 新增可选 `weights` 段（workloadBalance/stationWait/changeCost/energy），
`buildPolicy` 从配置读取，缺省回退既有默认值（完全向后兼容，旧配置行为不变）。
权重随策略版本化存储，调参走既有 policy register/activate 流程（含审计与影子对比）。

## Consequences
- 正面：策略调参不再改代码；权重随版本可复现、可审计、可影子评估
- 负面：旧配置无 weights 段时仍走默认值（无感知）；策略激活需人工审批（既有流程）
- 兼容性：`SchedulingPolicyConfig.weights` 可选 → 旧配置/API 请求体无需变更

## Related ADRs
ADR-002（事件驱动级联）
