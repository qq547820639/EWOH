# ADR-027：云侧事件严重度词表收敛 —— Canonical Risk Ladder 全链路接线

- 状态：Accepted
- 日期：2026-08-16
- 关联：ADR-007（Canonical Risk Model）、§3（Factory Truth）、§5（事件语义）、§33

## 背景

ADR-007 已交付 Canonical Risk Ladder（critical>high>medium>low + legacy
L1→critical/L2→high/L3→medium）与双运行时实现，但云侧生产调用链仍存在两套
互相矛盾的裸字符串严重度词表：

- **边缘词表**（inference/events.py `sev_order`）：L1 最严重（L1→critical）；
- **云侧 UI 词表**（EventCenterPanel/Timeline/alertToastLogic）：L3 最严重
  （L3=红色、L1=绿色）——与边缘完全相反；
- 12 个服务写 `ewohEvent.severity` 时随意使用 L1/L2/L3 字面量（生命周期
  事件写 L3、ERP 写 L1/L2、ingest 对所有边缘事件硬编码 L3），语义无定义；
- 消费方各按自己的理解读：priority-engine 读 L2/L3、supervisor 读 L1/L2、
  learning riskOutcomeRate 读 L1/L2。

同一列、同一字段、两种相反语义 = §3 禁止的"无法判定优先级的事实源"。
本 ADR 完成词表收敛与全链路接线。

## 决策

### 决策 1：ewohEvent.severity 唯一词表 = Canonical Risk Ladder

规范值仅 `critical / high / medium / low`；无风险判定的事件显式写
`unknown`（§33：绝不把 unknown 当 normal 伪装成 medium/low）。

### 决策 2：按事件类别的确定性迁移映射（非机械映射）

旧值语义因生产者而异，映射按"生产者意图"逐类确定（ADR 附表）：

| 事件类别（生产者） | 旧值 | 新值 | 依据 |
|---|---|---|---|
| ERP 派生风险事件 | L1 / L2 | critical / high | ERP 严重度 1=最严重 |
| 维护/质量/规则引擎 | 已规范 | 不变 | 入口已 normalizeSeverity |
| 信息性生命周期事件（learning/inference/knowledge/agent/orchestrator/simulation/proposal） | L3 | low | 非风险事件，最低注意力 |
| Dead Letter 终态 | L3 | medium | 失败证据需处置但非人身/设备风险 |
| Edge 上行事件（ingest 主路径） | L3（硬编码） | unknown | 边缘事件无风险判定，显式 unknown |
| 时间线合成标记（world timeline task/step/material） | L1 | low | 车道装饰标记，非风险 |
| priority-engine 读取 | L2/L3=risky | {critical,high,medium}=risky | 除 low/unknown 外均为风险事件 |
| supervisor 读取 | L1/L2 | critical/high | 高严重度事件计数 |
| learning riskOutcomeRate 读取 | L1/L2 | critical/high | 风险结局定义不变 |

### 决策 3：入口归一化与存量兼容

- 新增 `normalizeEventSeverity(value)`（shared/risk.ts）：规范值直通；
  legacy L1→critical / L2→high / L3→medium；其余 → 显式 `unknown`
  （事件写入不因严重度未知而丢弃其他事实，但绝不静默伪装）；
- 存量 DB 行保留历史值：跨迁移窗口的查询（learning riskOutcomeRate）以
  显式注释的过渡期双词表 UNION 兼容（critical/high ∪ L1/L2），新写入
  全部规范值后移除。

### 决策 4：客户端严重度面收敛

EventCenterPanel 筛选与徽章、Timeline 严重度配色、AlertToast L3 风暴
聚合全部切换到 canonical ladder（critical=红/high=橙/medium=黄/low=绿/
unknown=灰）；aggregateL3 更名 aggregateCriticalEvents（L3=最严重的旧
词表语义在新词表下即 critical）。

## 后果

- 正：同一列单一词表、单一排序语义（critical>high>medium>low）；
  边缘/云/UI/学习/调度五类消费方首次同语义；入口未知显式化。
- 负/边界：L4/L5 从未在事件严重度列出现（边缘只有 L1-L3），无迁移面；
  历史行词表混合靠过渡期读取 UNION + 注释承载，待真实 PG 首推后按需
  backfill 收紧。
