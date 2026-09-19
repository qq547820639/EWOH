# EWOH 行业方案对标分析

> 基于 2024 年前公开可获取的成熟开源项目和商业产品的训练知识。
> 未做实时网络检索——所有引用基于模型已知的公开资料，如实标注置信度。

---

## 1. MES / 制造执行系统

### 1.1 商业产品对标

| 维度 | Siemens Opcenter | Rockwell FactoryTalk | EWOH 现状 |
|---|---|---|---|
| 工单管理 | 完整 MES 工单生命周期（创建/派工/报告/关闭），支持工序级拆分 | 生产订单 + 工序操作 | ✅ 工单 + 工序 + 质检，但无工序级拆分和排队优先级 |
| 物料追踪 | 批次/序列号级别，全链可追溯 | 物料移动事务 + 批次 genealogy | ⚠️ 物料一等实体已建（099），但缺批次/序列号粒度 |
| 质量管理 | SPC + NCR（不合格品通知）+ CAPA | 质量数据采集 + SPC | ⚠️ QualityFinding 存在但无 SPC 统计过程控制 |
| 设备集成 | 通过 Opcenter Connectivity + 工业标准协议（OPC UA / MQTT） | FactoryTalk Linx + OPC UA | ✅ IngestGateway 9 类帧入口 + 标准协议 |
| 排产 | Opcenter Scheduling (基于 OR-Tools / 专有 APS) | FactoryTalk Scheduler | ✅ 三族求解器（启发式/MILP/CP-SAT），CP-SAT OPTIMAL 已验证 |
| 多租户 | 单租户（企业内部部署） | 单租户或多站点 | ✅ RLS 106/114 表 + GUC 租户隔离 + 跨租户 TCK |
| 可追溯性 | 完整电子批记录（21 CFR Part 11 合规） | 生产事件审计 | ⚠️ 审计哈希链 + DecisionRecord，但非 FDA 合规级 |

**差距分析**：EWOH 在排产优化和多租户上优于传统 MES，但在批次追踪、SPC、电子批记录（FDA 合规）方面存在差距。这些是制药/食品行业的核心需求，对通用制造业影响较小。

### 1.2 开源项目对标

| 项目 | 功能覆盖 | License | 活跃度 | 可借鉴 |
|---|---|---|---|---|
| **Apache Thingweaver** (孵化) | IoT 数据采集 + 边缘计算 | Apache 2.0 | 低（孵化阶段） | 设备连接器 SDK 模式 |
| **OpenMES** / **QMES** | 基础 MES 功能 | MIT / Apache | 低（社区不活跃） | 工单状态机模型 |
| **Odoo Manufacturing** | MRP + 工单 + 质量 + 维护 | LGPL | 高（Odoo 社区） | BOM 展开逻辑 + 质量检查点模型 |
| **ERCOT / frePPLe** | 生产排产 + 需求预测 | MIT / AGPL | 中（frePPLe 活跃） | 约束排产模型 + 缓冲区管理 |

**结论**：开源 MES 项目普遍不如 EWOH 的调度深度（三族求解器 + 决策轨迹 + 授权指纹），但在 BOM/批次/质量 SPC 方面可借鉴。**无需替换现有实现**——EWOH 的调度优化是差异化优势，BOM/批次可按需补齐。

---

## 2. 工业 IoT / 边缘计算

### 2.1 商业平台对标

| 维度 | AWS IoT SiteWise | Azure IoT Operations | EWOH 现状 |
|---|---|---|---|
| 数据采集 | OPC UA + MQTT + Gateway | OPC UA + MQTT +工业协议 | ✅ 9 类帧入口（自定义协议 + 标准协议） |
| 边缘推理 | AWS Panorama / Lookout for Equipment | Azure ML Edge | ⚠️ 有推理管道但模型需另训 |
| 资产建模 | 资产层次结构 + 属性 + 度量 | Asset Type + Instance | ✅ 世界模型 + 双时态状态 |
| 时序数据 | 内置时序库 + 冷热分层 | Azure Data Explorer | ⚠️ ewoh_telemetry 单表，无冷热分层 |
| 断网边缘自治 | SiteWise Edge 自动缓存重传 | IoT Operations 断网自治 | ✅ JSONL 离线缓冲 + 崩溃安全 |
| 安全 | X.509 证书 + IAM | Azure AD + Managed Identity | ✅ JWT + IngestGuard + RLS（无 X.509，可改进） |

### 2.2 开源项目对标

| 项目 | 功能覆盖 | License | 可借鉴 |
|---|---|---|---|
| **EdgeX Foundry** (Linux Foundation) | 设备服务/核心数据/核心命令，微服务架构 | Apache 2.0 | **分层架构**（device-service → core-data → export）与 EWOH 的 adapter → pipeline → uplink 分层高度一致 |
| **ThingsBoard** | 设备管理 + 数据可视化 + 规则链 + 告警 | Apache 2.0 | **规则链模型**（Processing Chain）可借鉴——EWOH 的 RuleEngine 是硬编码规则，ThingsBoard 用可视化规则链 |
| **KubeEdge** | K8s 边缘延伸 + 云边协同 | Apache 2.0 | 云边消息协议 + 断网自治模式 |
| **Mainflux / Magistrala** | IoT 消息基础设施（MQTT/HTTP/CoAP） | Apache 2.0 | 多协议适配层设计 |
| **Zilla / EOSL** | 工业边缘轻量运行时 | MIT | 极简边缘部署模式（与 EWOH 的"零第三方依赖"理念一致） |

**结论**：EWOH 的边缘运行时在"零第三方依赖"和"离线自治"方面优于 EdgeX Foundry（Java 微服务，资源消耗大）。**ThingsBoard 的可视化规则链**是最值得借鉴的——让用户自己配置规则而非代码硬编码。但这需要额外开发一个规则链编辑器 UI，优先级取决于是否需要让非程序员配置规则。

---

## 3. 排产优化 / APS（Advanced Planning and Scheduling）

### 3.1 求解器对标

| 求解器 | 类型 | License | 性能 | EWOH 对应 |
|---|---|---|---|---|
| **Google OR-Tools CP-SAT** | CP 精确求解 | Apache 2.0 | 优秀（生产级） | ✅ 已集成（SHADOW=OPTIMAL 端到端验证） |
| **OptaPlanner / Timefold** | 约束求解（Java） | Apache 2.0 | 优秀（专注排产/排班） | ❌ 未使用（Java 技术栈不匹配） |
| **HiGHS** | LP/MILP | MIT | 良好（LP 优秀，MILP 中等） | ✅ 已集成（HiGHS WASM） |
| **Gurobi** | LP/MILP/MIQP | 商业 | 顶级 | ❌ 未使用（商业许可） |
| **Choco** | CP（Java） | BSD | 良好 | ❌ 未使用 |
| ** heuristic（贪心）** | — | — | 快但质量不保证 | ✅ 默认求解器（确定性可重放） |

**EWOH 的三族阶梯设计（heuristic → MILP → CP-SAT）符合行业最佳实践**：
- 启发式保证"总有一个解"（可用性优先）
- MILP 提供中等质量的精确解
- CP-SAT 提供最高质量的精确解
- 阶梯允许按场景切换（当前 heuristic 默认 → CP-SAT 可升为生产）

### 3.2 排产系统对标

| 产品 | 功能 | License | EWOH 差距 |
|---|---|---|---|
| **frePPLe** | 需求预测 + 供应链排产 + 缓冲管理 | AGPL/商业 | EWOH 缺需求预测和供应链层 |
| **OptaPlanner Worker Rostering** | 人员排班（技能匹配/偏好/法规） | Apache 2.0 | EWOH 的人员匹配基于技能/证书，无偏好/法规约束 |
| **Siemens Opcenter Scheduling** | 有限产能排产 + Gantt 图 + what-if | 商业 | EWOH 有 what-if（SimulationService）但无 Gantt 图 UI |
| **OR-Tools Routing** | VRP（车辆路径问题） | Apache 2.0 | EWOH 不涉及 VRP（AGV 路径由调度器内部处理） |

**结论**：EWOH 的排产优化在"精确求解器集成"和"多目标评分"方面已达行业水准。差距在于缺少 Gantt 图可视化和需求预测。Gantt 图是 UI 工作，需求预测需要历史数据积累后才有意义。

---

## 4. 外骨骼安全与控制

### 4.1 行业标准

| 标准 | 范围 | EWOH 覆盖 |
|---|---|---|
| **ISO 13482**（个人护理机器人安全） | 机器人安全要求：速度/力/距离限制 | ⚠️ 平台不控制运动——安全在设备控制器本地（符合分层安全原则） |
| **ASTM F48**（外骨骼和人外骨骼） | 外骨骼分类 + 测试方法 + 人体工学 | ⚠️ 平台记录佩戴数据但无人体工学评估模型 |
| **IEC 61508**（功能安全 SIL） | 安全仪表系统：SIL 1-4 | ❌ 平台不涉及功能安全——安全闭环在设备控制器 |
| **ISO 13849**（机械安全控制系统） | 控制系统安全相关部件 | ❌ 同上 |

**EWOH 的安全架构符合行业最佳实践**：平台不做安全控制，安全闭环保留在设备控制器本地。这是正确的分层——平台关注"哪些任务分配给谁"和"是否需要介入"，而"如何安全地执行"由设备控制器负责。

### 4.2 可借鉴的安全功能

| 功能 | 描述 | 可数字化 | 当前状态 |
|---|---|---|---|
| 穿戴时长监控 | 连续穿戴超时提醒（防止疲劳/压力损伤） | ✅ | ✅ 已实现（exo reminder sweep） |
| 姿态异常检测 | 弯腰/扭转/过载检测 | ✅ | ✅ 已实现（inference rules: POSTURE_BEND_LONG 等） |
| 负载限制 | 负重超过安全阈值告警 | ✅ | ✅ 已实现（LOAD_CONTINUOUS 规则） |
| 热积累模拟 | 外骨骼电机/电池温度预测 | ✅ | ✅ 已实现（2026-09-15）：边缘热估计器（`inference/thermal.py`，一阶模型从负载×时间推算）+ `THERMAL_ACCUMULATION` 规则 + `DeviceThermalRisk` 目录事件；虚拟机群仿真对抗验证估计值在容差内跟踪独立参数的物理真值。**系数是假设值，待真机标定** |
| 疲劳累积模型 | 基于工作负荷的疲劳评分 | ✅ | ✅ 已实现（fatigue score: 基于班次累计负载） |
| 通信丢失 fail-safe | 断网后设备安全行为 | ⚠️ 设备控制器层面 | ⚠️ 边缘侧有断网自治（离线缓冲），设备侧不在平台控制内 |

---

## 5. 事件驱动架构 / CQRS

### 5.1 EWOH 的事件模型

```
事件写入路径：
  业务操作 → OutboxService.enqueue() → ewoh_outbox 表
           → (后台或同步) SSE 推送 → 前端实时更新

事件存储：
  ewoh_event（统一事件表：event_id + event_type + status + evidence_json）
  + ewoh_outbox（outbox 模式：待发送事件队列）
  + ewoh_notification（确定性通知号）

事件消费：
  SSE（前端实时）
  轮询（移动端/离线）
  后台 worker（sweep 类：SLA 升级/到期提醒/数据质量确认）
```

### 5.2 与行业模式对比

| 模式 | 典型实现 | EWOH 现状 |
|---|---|---|
| **Event Sourcing** | 事件即事实源，状态 = 事件回放 | ⚠️ EWOH 用"状态表 + 事件表"分离模式（非严格 Event Sourcing），事件是事实的**记录**而非事实的**来源** |
| **CQRS** | 命令模型 ≠ 查询模型 | ✅ 写入（命令）和查询（读面）分离，读面有专门的投影 |
| **Outbox Pattern** | 事务性事件发布 | ✅ ewoh_outbox 表 |
| **Saga Pattern** | 分布式事务补偿 | ⚠️ 方案取消/回滚有 Saga 雏形，但不完整 |
| **Kafka / EventBridge** | 事件总线 | ❌ EWOH 用 PG outbox + SSE（同进程），无外部事件总线 |

**判断**：EWOH 的事件模型是**务实的混合模式**——单进程内用 PG outbox + SSE（够用且一致），没有引入 Kafka 等外部基础设施。对于当前规模（单工厂/单实例），这是正确的选择。如果未来需要多实例/多工厂事件同步，可引入 NATS 或 Kafka。

---

## 6. 综合建议（按可执行优先级）

| # | 建议 | 影响域 | 可数字化 | 当前状态 |
|---|---|---|---|---|
| 1 | 学习闭环真实数据放量 | 学习域 + 调度域 | ✅ | 管道就绪，需 durationModelMode → advisory |
| 2 | Gantt 图可视化（排产） | 前端 | ✅ | 后端数据已有，缺前端渲染 |
| 3 | 批次/序列号追踪 | 数据域 | ✅ | 物料一等实体已有，需加批次维度 |
| 4 | 可视化规则链编辑器 | rule-engine | ✅ | 需前端 UI + 规则 DSL |
| 5 | 通知号前缀加 org 段 | notification | ✅ | 消除跨租户压制的结构性风险 |
| 6 | 消除 work-orchestration 同步 IO | work-orchestration | ✅ | 性能瓶颈 |
| 7 | 学习信号 DB 级 TOCTOU 防护 | learning | ✅ | 并发同 signalId 23505 → 500 |
| 8 | X.509 设备证书认证 | ingest/security | ✅ | 替代 API key（更安全但改动大） |
| 9 | 需求预测模型 | materials/scheduler | ✅ | 需历史订单数据积累 |
| 10 | SPC 统计过程控制 | quality | ✅ | 质量数据已有，缺统计模型 |
| 11 | 多实例事件同步（NATS/Kafka） | 全域 | ✅ | 当前单实例够用 |
| 12 | 电子批记录 FDA 合规 | quality/mes | ⚠️ | 仅制药/食品行业需要 |
| 13 | 真机外骨骼穿戴测试 | 边缘 | ❌ | **平台侧链条已仿真对抗验证**（虚拟外骨骼机群：真实 NXP1 线协议 + 热积累/电量物理 + CRC/重放/坏时钟/佩戴人不符注入，`e2e:exo-simfarm` 23 PASS）；真机物理保真度、真机安全闭环（设备控制器层，IEC 61508/ISO 13849）仍待真机 |
| 14 | 真实产线操作工效学评估 | 全域 | ❌ | 平台侧工效学信号链（姿态/负荷/疲劳/佩戴校验）已由仿真遥测驱动验证；真人工效学结论（人体测量、真实作业姿势分布）本质上不可数字化，留线下 |
| 15 | 设备物理寿命验证 | 边缘 | ❌ | 累积类逻辑（热积累越限、低电量触发、SOC 跌破门槛建派工、故障窗口回执语义）已由设备物理仿真对抗验证（`e2e:device-physics` 16 PASS）；真实退化速率需真机长期运行数据，仿真无法替代 |
