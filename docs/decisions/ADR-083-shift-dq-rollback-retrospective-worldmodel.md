# ADR-083：班次域 / 数据质量确认 / 方案回滚 / 复盘运行记忆 / 世界模型扩展

日期：2026-09-11 · 状态：Accepted · 关联：DR-2~DR-6（2026-09-11 闭环缺口审计）

## 背景

以"工厂具身智能操作系统"愿景审计仓库现状：十步闭环服务端均有落点、边缘运行时完备、
LLM 双路已接。但存在五个**结构性缺口**：

1. 班次（Shift）是现场第一组织事实，却只有 `personnel.shift` 自由文本——无班次实体、无班次工作台、无交接班留痕；
2. 闭环第②步"系统确认数据质量"只有自动分级，**人工确认/质疑无落点**；
3. `dispatched/executing` 方案无取消路径（WaveDispatchPanel 注释明示"没有取消派工的接口"）——"审批、拒绝、部分执行和回滚"缺最后一块；
4. 学习件散落四张表（evaluation/proposal/annotation/duration-model），**无"预测→决策→授权→执行→实际→经验"的统一运行记忆产物**；
5. 世界快照只投影 4 桶（人/设备/工位/任务），物料/订单不在调度视野。

## 决策

### DR-2 班次域（standalone_074）

- 班次定义 = 一天内循环时间窗（HH:mm + crossesMidnight 显式标记）；判定用共享纯函数 `resolveShiftAt`（前后端同构），**窗口间隙返回 current=null 显式未知，不猜默认班**（原则 7）；
- 交接班：结构化遗留事项（openItems 数组：title/severity/关联对象引用）+ 交接事实留痕；杜绝"口头交接、系统无痕"；
- PG `time` 列返回 "16:00:00"（含秒）——解析容秒（`HH:mm(:ss)?`）且服务端归一为 HH:mm。

### DR-4 数据质量人工确认（standalone_076）

- 语义：**人对单一事件数据质量的最终判定**。confirmed=可信、可作为决策依据（联动 resolve 同源 open DataQualityAlert）；contested=不可信、相关决策需复核（告警保持 open 持续可见）；
- 判定人取服务端会话（不信任客户端自报）；同事件 UNIQUE 幂等（改判=覆盖+审计）；
- 确认是复盘 dataQuality 段的输入，也是"决策解释显示可信度"（原则 5）的人工锚点。

### DR-5 方案取消/回滚（standalone_077）

- **部分回退语义**：物理执行不可撤销——未开始 assignment（proposed/approved/dispatched/acknowledged 且任务未 received/executing）→ cancelled + 释放预占 + 任务回退 pending_dispatch（重新可排程）；已开始的保持原状并**显式列入 irreversibleAssignmentIds**（不静默吞掉）；
- 任务状态机契约扩展 `rollback_dispatch`（dispatched/received → pending_dispatch，condition=rollback_before_start）：task.yaml 唯一事实源 + TS TASK_ACTIONS + Python TASK_TRANSITIONS 三方锁步；
- reason 必填（回滚必须可解释、可审计）；方案状态 CAS → cancelled（并发双取消 409）；PlanCancelled outbox 事件（SSE 实时可见）；高危审计（risk=true）。

### DR-3 复盘/运行记忆（standalone_075）

- **组装产物，不是第二事实源**：六段（感知/数据质量/决策/授权/执行/反馈）各段只引用既有台账证据（evidenceIds 指向事件/方案/执行/标注行）；缺失环节显式进 `gaps`（原则 7：没有数据就说没有）；
- AI 总结：Ark LLM 在 PG 事务外调用（不占连接，同 scheduling-narrator 纪律），失败回落规则模板；`narrativeSource: llm | rule_fallback` 双路留痕——**绝不把模板输出冒充模型产出**；
- 同一 target 至多一条非 superseded 复盘（SQL 部分唯一索引）：重新组装 = 旧 published 置 superseded + 新 draft；发布（draft→published）后进入可检索引用的稳定态；
- 经验条目（lessons）结构化：AI 总结建议 + 人工修订后落账——**运行记忆归人所有**。

### DR-6 世界模型扩展

- 快照新增 `materials`（缺口/低于阈值行 + materialsNote 口径说明）、`orders`（未完工 ERP 订单）、`shifts`（班次定义）三个 **advisory** 投影：供解释/展示/候选引擎参考，**不进 entityVersions 新鲜度比较**——物料事实变化不使既有方案失效（本阶段物料不构成求解器硬约束，避免软事实硬化的伪精确）；
- 物料聚合 per-org 15s TTL 缓存（缓存键含 orgId，租户隔离；限流 collectState 高频轮询成本）。

## 后果

- 闭环第②步（数据质量确认）与第⑩步（可追溯经验）从"文档概念"变为有表、有 API、有 UI、有 E2E 断言的产品能力；
- "审批/拒绝/部分执行/回滚"四态完整（此前回滚缺失）；
- 事件目录 65→69 类、OpenAPI +10 路径、迁移链 073→077；
- 全链验收 `make e2e-fault-replan`：18/18 断言 PASS（真实后端 + 真实 PostgreSQL），其中回滚断言实测"16 项回退 / 1 项已执行不可回退如实回报"。

## 风险与后续

- 物料/订单进快照是 advisory：下一阶段若要将物料短缺变为求解器硬约束（fail-closed 拒排），需独立 ADR 评审约束语义与降级行为；
- 复盘 AI 总结当前环境为 rule_fallback（Ark 未配置 API Key）——LLM 路径已有代码与契约，配置后自动启用；
- 交接班 toUserId 输入的是用户 ID（uuid）：后续应接用户选择器（通讯录）降低录入门槛。
