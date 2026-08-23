# Continuous Learning 深化方案

**文档版本**: 1.0
**创建日期**: 2026-08-24
**状态**: Draft

## 1. 概述

当前 Continuous Learning 能力（Phase 12）状态为 Partial。已实现基础：
- LearningProposal 契约（ADR-026）
- 确定性影子评估
- 人审激活阶梯
- ReasoningService 真实激活接线

需深化：outcome annotation 结构化 + 模型影子评估机制。

## 2. Outcome Annotation 结构化

### 2.1 Schema 定义

```typescript
interface OutcomeAnnotation {
  annotationId: string;           // UUID
  orgId: string;                  // 租户 ID
  planId: string;                 // 调度计划 ID
  taskId: string;                 // 任务 ID
  
  // 调度结果
  scheduledStartMs: number;       // 计划开始时间
  scheduledEndMs: number;         // 计划结束时间
  assignedWorkerId: string;       // 分配的工人
  assignedDeviceId?: string;      // 分配的设备
  
  // 实际结果
  actualStartMs?: number;         // 实际开始时间
  actualEndMs?: number;           // 实际结束时间
  actualWorkerId?: string;        // 实际执行工人（可能不同）
  completionStatus: 'completed' | 'partial' | 'failed' | 'cancelled';
  
  // 质量指标
  onTime: boolean;                // 是否准时完成
  qualityScore?: number;          // 质量评分 (0-1)
  reworkRequired: boolean;        // 是否需要返工
  
  // 人工调整
  humanOverride: boolean;         // 是否有人工调整
  overrideReason?: string;        // 调整原因
  overrideType?: 'reassign' | 'reschedule' | 'cancel' | 'priority_change';
  
  // 元数据
  annotationSource: 'auto' | 'manual' | 'hybrid';
  confidence: number;             // 标注置信度 (0-1)
  createdAt: Date;
  updatedAt: Date;
}
```

### 2.2 采集点

| 采集点 | 触发条件 | 数据来源 |
|--------|----------|----------|
| 调度执行后 | 任务分配完成 | scheduler.service.ts |
| 任务完成时 | 工人报告完成 | production-task.service.ts |
| 人工修正时 | 管理员调整分配 | scheduler.service.ts |
| 周期性评估 | 每日/每周 | learning.service.ts |

### 2.3 存储方案

复用现有数据库，新增表 `ewoh_outcome_annotation`：

```sql
CREATE TABLE ewoh_outcome_annotation (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id VARCHAR(255) NOT NULL,
  plan_id VARCHAR(255) NOT NULL,
  task_id VARCHAR(255) NOT NULL,
  scheduled_start_ms BIGINT,
  scheduled_end_ms BIGINT,
  assigned_worker_id VARCHAR(255),
  assigned_device_id VARCHAR(255),
  actual_start_ms BIGINT,
  actual_end_ms BIGINT,
  actual_worker_id VARCHAR(255),
  completion_status VARCHAR(50) NOT NULL DEFAULT 'pending',
  on_time BOOLEAN,
  quality_score NUMERIC(5,4),
  rework_required BOOLEAN DEFAULT false,
  human_override BOOLEAN DEFAULT false,
  override_reason TEXT,
  override_type VARCHAR(50),
  annotation_source VARCHAR(50) NOT NULL DEFAULT 'auto',
  confidence NUMERIC(5,4) NOT NULL DEFAULT 1.0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- §15 租户隔离：RLS + org 可见性
ALTER TABLE ewoh_outcome_annotation ENABLE ROW LEVEL SECURITY;

CREATE POLICY ewoh_outcome_annotation_org_select
  ON ewoh_outcome_annotation
  FOR SELECT TO authenticated
  USING (ewoh_org_visible(org_id));

CREATE POLICY ewoh_outcome_annotation_service_all
  ON ewoh_outcome_annotation
  FOR ALL TO service_role
  USING (ewoh_org_visible(org_id))
  WITH CHECK (ewoh_org_visible(org_id));

-- 索引
CREATE INDEX idx_outcome_annotation_org_plan
  ON ewoh_outcome_annotation (org_id, plan_id);
CREATE INDEX idx_outcome_annotation_task
  ON ewoh_outcome_annotation (org_id, task_id);
CREATE INDEX idx_outcome_annotation_status
  ON ewoh_outcome_annotation (org_id, completion_status);
```

**迁移锁步**：作为 standalone_067 迁移（.sql + .rollback.sql + .verify.sql + runner 注册）。

## 3. 影子评估机制

### 3.1 与现有 solver SHADOW 模式的关系

**现有 SHADOW 模式**（`solver.service.ts`，`EWOH_SOLVER_ACTIVATION=SHADOW`）：
- 同时运行 heuristic（生产）和 CP-SAT（影子）
- 对比两者结果（分配数、成本、约束满足率）
- 仅使用 heuristic 结果，CP-SAT 结果仅记录
- **聚焦**：求解器算法对比（heuristic vs CP-SAT）

**本文档的影子评估机制**：
- 在现有 SHADOW 模式基础上扩展，增加 outcome annotation 数据采集
- 不仅对比求解器算法，还对比**模型版本**（如 heuristic-v1 vs heuristic-v2）
- 增加**长期效果评估**（调度结果 vs 实际执行结果）
- **聚焦**：模型/算法的长期效果对比（含 outcome 反馈）

**两者关系**：
```
现有 SHADOW 模式（solver.service.ts）
  └── 求解器算法对比（heuristic vs CP-SAT）
      └── 本文档影子评估（扩展）
          ├── 模型版本对比（v1 vs v2）
          └── 长期效果评估（outcome annotation）
```

### 3.2 影子模型定义

影子模型 = 新模型/算法与现有模型并行运行，仅收集结果不实际执行。

```
┌─────────────────────┐
│   调度请求           │
└─────────┬───────────┘
          │
          ▼
┌─────────────────────┐
│   线上模型（执行）    │ ← 实际分配
└─────────┬───────────┘
          │
          ▼
┌─────────────────────┐
│   影子模型（评估）    │ ← 仅记录结果
└─────────────────────┘
```

### 3.3 评估流程

1. **数据收集**：每次调度请求同时运行线上模型和影子模型
2. **结果记录**：记录两者的结果（分配、成本、约束满足率）
3. **定期对比**：每周生成对比报告
4. **决策阈值**：影子模型优于线上模型 × 连续 N 周 → 考虑切换

### 3.4 评估报告模板

```markdown
# 影子评估报告 - [日期范围]

## 概要
- 评估周期：[开始日期] ~ [结束日期]
- 调度请求数：[N]
- 线上模型：heuristic-v1
- 影子模型：milp-v1

## 性能对比
| 指标 | 线上模型 | 影子模型 | 差异 |
|------|----------|----------|------|
| 平均分配数 | 85.2 | 87.1 | +2.2% |
| 平均成本 | 1234.5 | 1198.3 | -2.9% |
| 约束满足率 | 98.5% | 99.1% | +0.6% |
| P95 求解时间 | 2.3s | 4.8s | +108.7% |

## 结论
影子模型在分配数和成本上优于线上模型，但求解时间显著增加。
建议：继续观察 2 周，如无异常可进入金丝雀模式。

## 决策
- [ ] 继续观察
- [ ] 进入金丝雀模式
- [ ] 终止评估
```

### 3.5 决策阈值

| 条件 | 动作 |
|------|------|
| 影子模型连续 4 周优于线上模型 | 进入金丝雀模式 |
| 影子模型连续 2 周劣于线上模型 | 终止评估 |
| 影子模型求解时间 >10s（P95） | 优化或终止 |
| 影子模型约束满足率 <95% | 终止评估 |

## 4. 分阶段实施路线图

### 阶段 1：Annotation Schema + 采集流程（4 周）

**目标**：建立 outcome annotation 基础设施

**交付物**：
- `ewoh_outcome_annotation` 表（standalone_067）
- `OutcomeAnnotationService`（采集 + 查询）
- 调度执行后自动采集
- 任务完成时自动采集

**里程碑**：
- Week 1：Schema 设计 + 迁移
- Week 2：采集服务实现
- Week 3：集成测试
- Week 4：部署 + 验证

### 阶段 2：影子评估基础设施（6 周）

**目标**：部署影子评估框架

**交付物**：
- `ShadowEvaluatorService`（并行运行 + 结果记录）
- 评估报告生成器
- 周报自动发送

**里程碑**：
- Week 1-2：影子评估框架实现
- Week 3-4：评估报告生成
- Week 5-6：部署 + 运行 1 个候选模型

### 阶段 3：评估决策 + 切换（2 周）

**目标**：根据评估结果决定是否切换

**交付物**：
- 决策阈值配置
- 自动切换机制（可选）
- 切换后监控

**里程碑**：
- Week 1：决策阈值配置
- Week 2：切换验证

## 5. 隐私与合规

### 5.1 数据脱敏

- annotation 数据不包含真实人员姓名
- 使用 worker_id 而非姓名
- 质量评分匿名化

### 5.2 数据保留

- annotation 数据保留 90 天
- 评估报告保留 1 年
- 汇总统计永久保留

### 5.3 访问控制

- annotation 数据仅管理员可访问
- 评估报告仅管理员可访问
- 汇总统计可公开

## 6. 文件清单

| 文件 | 说明 |
|------|------|
| `db/migrations/standalone_067_outcome_annotation.sql` | 迁移文件 |
| `ewoh-spark-app/server/modules/learning/outcome-annotation.service.ts` | 采集服务 |
| `ewoh-spark-app/server/modules/learning/shadow-evaluator.service.ts` | 影子评估 |
| `docs/design/continuous-learning-deepening.md` | 本文档 |
