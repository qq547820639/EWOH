# EWOH 详细测试方案

> **版本**: v1.0 | **编制**: QA 工程师 (Edward/Yan) | **日期**: 2026-08-21
> **项目**: EWOH (Exoskeleton Worker Operation & Harmony)
> **状态**: 初稿

---

## 目录

1. [测试用例设计方法](#1-测试用例设计方法)
2. [测试数据管理策略](#2-测试数据管理策略)
3. [各模块测试用例概要](#3-各模块测试用例概要)
4. [缺陷跟踪流程](#4-缺陷跟踪流程)
5. [测试通过标准与验收条件](#5-测试通过标准与验收条件)
6. [测试报告模板](#6-测试报告模板)

---

## 1. 测试用例设计方法

### 1.1 等价类划分法

**适用场景**: 输入参数具有连续取值范围或有限离散集合的场景。

| 有效等价类 | 无效等价类 | EWOH 应用示例 |
|-----------|-----------|-------------|
| 合法调度优先级（P1-P5） | 优先级为空/超出范围 | `priority.py`: PriorityLevel 枚举边界 |
| 合法 JWT Token | 过期/格式错误/篡改 Token | 多租户认证接口 `auth.service` |
| 正常 loadLevel (0.0-1.0) | 负值/超过 1.0/非数字 | `scoring.py` 人员负载评分 |
| 有效技能标签集合 | 空集合/未注册技能 | `constraints.py` SKILL 约束 |

**EWOH 具体应用**:

```python
# 示例：调度器负载评分等价类
# 有效等价类: [0.0, 0.3) 低负载, [0.3, 0.7) 中负载, [0.7, 0.9] 高负载
# 无效等价类: <0, >1.0, None, 非数值类型
# 边界值: 0.0, 0.3, 0.7, 0.9, 1.0
```

### 1.2 边界值分析法

**适用场景**: 参数有明确数值/长度/数量限制的场景。

| 边界类型 | 边界值 | EWOH 应用 |
|---------|-------|---------|
| 电池电量下限 | 15% (MIN_BATTERY) | `golden_scheduler_scenarios.py` 设备电量约束 |
| 连续工作时长上限 | 制度规定上限分钟数 | `constraints.py` SHIFT_REST 约束 |
| 负载等级阈值 | 0.9 (MAX_LOAD) | 硬约束: person.loadLevel > MAX_LOAD 即拒绝 |
| 严重度等级 | L1/L2/L3 三级边界 | 事件告警分级 |
| SSE 连接超时 | 秒级心跳间隔 | 实时推送保活 |
| RLS 行级隔离 | 跨租户 ID 边界 | PostgreSQL RLS policy |

**EWOH 关键边界测试**:

```python
# 硬约束边界值矩阵
# MIN_BATTERY = 15:  14(拦截) | 15(通过) | 16(通过)
# MAX_LOAD = 0.9:    0.89(通过) | 0.90(通过) | 0.91(拦截)
# 技能匹配:          完全匹配 | 超集 | 缺失一项(拦截) | 空集(拦截)
```

### 1.3 决策表法

**适用场景**: 多条件组合影响业务逻辑的场景。

#### 调度器约束过滤决策表

| 条件 / 动作 | R1 | R2 | R3 | R4 | R5 | R6 |
|:-----------|:--:|:--:|:--:|:--:|:--:|:--:|
| **C1**: 技能匹配 | Y | Y | Y | N | - | - |
| **C2**: 工位授权 | Y | Y | N | - | Y | - |
| **C3**: 健康禁忌 | N | N | - | - | - | Y |
| **C4**: 禁区校验 | N | - | - | - | - | - |
| **C5**: 设备在线 | Y | N | - | - | - | - |
| **C6**: 电量>=15% | Y | - | - | - | - | - |
| **A1**: 进入候选 | ✓ | ✗ | ✗ | ✗ | ✗ | ✗ |
| **A2**: 违规类型 | — | DEVICE_FAULT | STATION_AUTH | SKILL | STATION_AUTH | HEALTH_TABOO |

#### 调度请求状态转换决策表

| 条件 / 动作 | 规则1 | 规则2 | 规则3 | 规则4 | 规则5 |
|:-----------|:-----:|:-----:|:-----:|:-----:|:-----:|
| **当前状态** | SHADOW | PROPOSED | CONFIRMED | REJECTED | EXECUTED |
| **操作: confirm** | →CONFIRMED | →CONFIRMED | 拒绝 | 拒绝 | 拒绝 |
| **操作: reject** | →REJECTED | →REJECTED | 拒绝 | 拒绝 | 拒绝 |
| **操作: execute** | 拒绝 | 拒绝 | →EXECUTED | 拒绝 | 拒绝 |

### 1.4 状态转换法

**适用场景**: 具有明确状态机的业务对象。

#### 任务状态机（task.yaml — 11 状态 / 14 转换）

```
draft → pending_confirm → pending_approval → pending_dispatch → dispatched → received → executing → completed
                      ↘                  ↗                    ↘                    ↗
                       pending_dispatch          cancelled(any_non_terminal)
                                                executing → paused → executing
                                                executing → exception → executing
```

**关键测试路径**:

| 编号 | 测试路径 | 覆盖场景 |
|-----|---------|---------|
| ST-01 | draft → pending_confirm | 必填字段完整时创建 |
| ST-02 | pending_confirm → pending_dispatch | 无需审批的快速通道 |
| ST-03 | executing → paused → executing | 工作中断/恢复循环 |
| ST-04 | executing → exception → executing | 异常检测与恢复 |
| ST-05 | any → cancelled | 任意非终态可取消 |
| ST-06 | completed → * (非法) | 终态不可回退 |
| ST-07 | executing → completed | 正常完工 |
| ST-08 | draft → pending_confirm (缺少字段) | 负测试: 必填字段缺失 |

#### 调度请求状态机（orchestrator.py — 5 状态）

```
SHADOW → PROPOSED → CONFIRMED → EXECUTED
  ↘        ↘           ↗
   REJECTED           (reject 任意阶段)
```

**核心不变量测试**:
- `execute()` 仅在 CONFIRMED 后标记 EXECUTED；无自动执行旁路
- `confirm()` 必须提供 reason（空字符串/None 拒绝）
- `reject()` 在任何阶段都可否决
- REJECTED/EXECUTED 终态不可被 `confirm()` 复活

### 1.5 因果图法

**适用场景**: 输入条件之间存在逻辑关系（与/或/非/互斥）。

#### 设备接入因果分析

```
原因:
  C1: Modbus 连接正常
  C2: OPC UA 认证通过
  C3: Sparkplug B Broker 在线
  C4: 数据格式合法
  C5: 采样频率在阈值内

结果:
  E1: 数据成功入库  (C1∧C4∧C5) ∨ (C2∧C4∧C5) ∨ (C3∧C4∧C5)
  E2: 连接失败告警  ¬C1 ∧ ¬C2 ∧ ¬C3
  E3: 数据质量降级  C1∧(¬C4 ∨ ¬C5)  → 数据标记为 degraded
  E4: 设备离线告警  (C1→¬C1) 触发离线检测
```

#### 调度约束互斥关系

```
# 与关系: 技能匹配 ∧ 工位授权 ∧ 无健康禁忌 → 候选资格
# 互斥关系: 人员已被预订(t=Δt) → 不可同时分配另一任务
# 或关系: 任一硬约束违规 → 取消候选资格
# 非关系: ¬安全封禁 → 允许进入候选
```

### 1.6 正交试验法

**适用场景**: 多因素多水平组合测试，需高效覆盖因素交互。

#### 调度评分参数正交表 L9(3⁴)

| 试验号 | 生产提升期望 | 按时概率 | 当前负载 | 移动距离 | 期望得分趋势 |
|:-----:|:----------:|:-------:|:-------:|:-------:|:-----------:|
| 1 | 高 | 高 | 低 | 近 | 最高 |
| 2 | 高 | 中 | 中 | 远 | 中高 |
| 3 | 高 | 低 | 高 | 中 | 中 |
| 4 | 中 | 高 | 中 | 中 | 中高 |
| 5 | 中 | 中 | 高 | 近 | 中 |
| 6 | 中 | 低 | 低 | 远 | 中低 |
| 7 | 低 | 高 | 高 | 远 | 中低 |
| 8 | 低 | 中 | 低 | 中 | 中 |
| 9 | 低 | 低 | 中 | 近 | 低 |

**用途**: 验证 `scoring.py` 评分权重在多种因素组合下排名的一致性和合理性。

#### 设备接入协议正交表 L4(2³)

| 试验号 | 协议类型 | 数据格式 | 认证方式 |
|:-----:|:-------:|:-------:|:-------:|
| 1 | Modbus | 二进制 | 无 |
| 2 | OPC UA | JSON | 证书 |
| 3 | Sparkplug B | Protobuf | Token |
| 4 | Webhook | JSON | HMAC |

### 1.7 场景法

**适用场景**: 端到端业务流程测试，覆盖基本流、备选流和异常流。

#### 智能调度器 V2 全流程场景

**基本流 (Happy Path)**:
```
世界状态快照生成
  → 优先级排序（P1最高）
    → 资格过滤（硬约束全通过）
      → 路由计算（距离最优）
        → CP-SAT/Heuristic 求解（最优解）
          → 计划生成
            → 人工审批（班组长确认）
              → 资源预留
                → 任务派遣
                  → SSE 实时推送至工人终端
```

**备选流**:

| 编号 | 场景 | 分支点 | 后续行为 |
|-----|------|-------|---------|
| AF-01 | 班组长否决方案 | 人工审批 | 状态→REJECTED，记录否决理由，可申诉 |
| AF-02 | 无满足约束的候选人 | 资格过滤 | 返回空候选列表 + 拦截原因说明 |
| AF-03 | CP-SAT 超时 | 求解阶段 | 降级至 Heuristic 求解器 |
| AF-04 | 资源冲突 | 资源预留 | 冲突检测 → 重新调度或等待 |
| AF-05 | 执行中断 | 工作中 | executing → paused → executing |
| AF-06 | 设备离线 | 工作中 | 触发告警 → 重新评估可行性 |

**异常流**:

| 编号 | 场景 | 预期行为 |
|-----|------|---------|
| EF-01 | 世界状态数据缺失 | 优雅降级，使用上次有效快照 |
| EF-02 | 并发调度同一资源 | 乐观锁/冲突检测，拒绝后者 |
| EF-03 | 网络分区 | 边缘端本地缓存，恢复后同步 |
| EF-04 | 数据库不可用 | 写入操作排队，读取使用缓存 |
| EF-05 | SSE 连接断开 | 自动重连 + 消息回放 |

---

## 2. 测试数据管理策略

### 2.1 测试数据生成工具选型

| 层级 | 推荐工具 | 用途 | 理由 |
|-----|---------|------|------|
| **Python 单元测试** | 标准库 `dataclasses` + `unittest.mock` | 构造测试对象 | EWOH 边缘端要求 stdlib only |
| **Python 集成测试** | `pytest` fixtures + `conftest.py` | 共享测试配置 | 已有基础设施 |
| **Python 边缘端数据** | 手写 Factory 函数（`factories.py`） | 生成标准世界状态快照 | stdlib only 约束 |
| **TypeScript 服务端** | `@faker-js/faker` + `@nestjs/testing` | 生成测试数据 | NestJS 生态标准 |
| **TypeScript E2E** | Playwright fixtures + 自定义 `test-data/` | 端到端数据准备 | 已有 Playwright 配置 |
| **跨语言 Golden** | JSON fixture 文件 (`tests/golden-fixtures/`) | 跨运行时一致性 | 已有 6 个 golden 文件 |

### 2.2 多租户测试数据隔离方案

```
┌───────────────────────────────────────────────────────┐
│                    测试数据隔离架构                      │
├──────────────┬────────────────┬───────────────────────┤
│   层级        │  策略           │  实现                  │
├──────────────┼────────────────┼───────────────────────┤
│ PostgreSQL   │ Schema 隔离     │ 每个测试租户独立 schema  │
│ (服务端)      │ RLS Policy     │ SET app.tenant_id      │
│              │ 事务回滚        │ @Transactional 注解     │
├──────────────┼────────────────┼───────────────────────┤
│ SQLite       │ 数据库文件隔离   │ :memory: 或临时文件     │
│ (边缘端)      │ 测试后清理      │ tearDown 删除 db 文件   │
├──────────────┼────────────────┼───────────────────────┤
│ API 层       │ JWT 租户标识    │ 测试用 JWT 含 org_id   │
│              │ Header 隔离    │ X-Tenant-Id 测试 header │
└──────────────┴────────────────┴───────────────────────┘
```

**具体方案**:

1. **PostgreSQL 测试数据库**:
   - CI 环境使用独立的 `ewoh_test` 数据库
   - 每个测试类使用独立事务，测试结束自动回滚
   - RLS 测试通过 `SET app.tenant_id = '<test-tenant-id>'` 切换租户上下文
   - 租户 A 数据写入后，验证租户 B 查询不可见

2. **SQLite 边缘端测试**:
   - 默认使用 `:memory:` 数据库（零 I/O 开销）
   - 需要文件级测试时使用 `tempfile.mktemp(suffix='.db')`
   - `setUp` 初始化 schema，`tearDown` 清理

3. **飞书侧车测试**:
   - 独立 `test/` 目录，11 个 `node --test` 文件
   - 测试前 seed 固定数据集，测试后清理

### 2.3 Golden Fixture 管理

**现有 Golden Fixtures** (`tests/golden-fixtures/`):

| 文件 | 用途 | 消费方 |
|-----|------|-------|
| `scheduler-golden-scenarios.json` | 调度器求解场景定义 | Python + TS 共享 |
| `scheduler-golden-results.json` | 调度器求解期望结果 | Python 独立仲裁 + TS 漂移门禁 |
| `scheduler-workflow-golden.json` | 调度工作流场景 | 审批/预约/派工全流程 |
| `scheduler-workflow-golden-results.json` | 工作流期望结果 | 跨运行时一致性 |
| `contract-golden-scenarios.json` | 八域契约共享场景 | 跨语言契约测试 |
| `scheduler-contract.golden.json` | 调度器契约基线 | 回归检测 |

**扩展策略**:

```
tests/golden-fixtures/
├── scheduler-golden-scenarios.json      # 现有：求解场景
├── scheduler-golden-results.json        # 现有：求解结果
├── scheduler-workflow-golden.json       # 现有：工作流
├── contract-golden-scenarios.json       # 现有：契约
│
├── device-ingest-scenarios.json         # 新增：设备接入场景
│   ├── modbus-standard.json            #   Modbus 标准采集
│   ├── opcua-auth-scenarios.json       #   OPC UA 认证场景
│   └── sparkplug-b-telemetry.json      #   Sparkplug B 遥测
│
├── alert-rules-scenarios.json           # 新增：告警规则场景
│   ├── risk-event-l1-l2-l3.json        #   三级风险事件
│   └── evidence-window.json            #   证据窗口验证
│
├── rls-isolation-scenarios.json         # 新增：多租户隔离场景
│   ├── cross-tenant-queries.json       #   跨租户查询拦截
│   └── permission-boundary.json        #   权限边界验证
│
└── sse-scenarios.json                   # 新增：SSE 推送场景
    ├── connection-lifecycle.json        #   连接生命周期
    └── message-ordering.json           #   消息顺序验证
```

**Golden Fixture 更新流程**:

1. 新增场景 → 在 `*-scenarios.json` 中定义输入
2. 运行 Python 侧求解/处理 → 生成期望结果到 `*-results.json`
3. TS 侧消费同一份场景 + 结果 → 验证跨语言一致性
4. CI 门禁: 两侧结果比对不一致 → 构建失败（漂移检测）

### 2.4 数据库快照与恢复策略

| 策略 | 适用场景 | 实现方式 |
|-----|---------|---------|
| **事务回滚** | 单元测试 / 集成测试 | 每个测试用例包裹在事务中，结束回滚 |
| **Truncate + Reseed** | 每个测试类开始前 | `TRUNCATE TABLE ... RESTART IDENTITY CASCADE` |
| **pg_dump/pg_restore** | E2E / 系统测试 | 测试前恢复已知数据快照 |
| **Docker Volume Snapshot** | CI 环境 | 容器启动时挂载预置数据卷 |
| **SQLite :memory:** | 边缘端单元测试 | 每个测试创建独立内存数据库 |
| **SQLite 文件复制** | 边缘端集成测试 | 复制模板 db → 测试 → 删除副本 |

### 2.5 边缘端模拟数据生成

```python
# 工具: 标准库 Factory 函数（遵循 stdlib only 约束）
# 文件: src/edge_platform/tests/factories.py（建议新增）

def make_world_state(persons=3, stations=2, devices=4, tasks=2):
    """生成标准化世界状态快照用于测试。"""
    ...

def make_person(person_id=None, status="AVAILABLE", skills=None, load_level=0.3):
    """生成测试人员对象。"""
    ...

def make_device(device_id=None, model="EXO-A1", battery=80, status="ONLINE"):
    """生成测试设备对象。"""
    ...

def make_task(task_id=None, required_skills=None, priority="P3", zone_id="Z1"):
    """生成测试任务对象。"""
    ...

def make_risk_event(severity="L2", zone_id="Z1", person_id=None):
    """生成测试风险事件。"""
    ...
```

---

## 3. 各模块测试用例概要

### 3.1 调度器 V2（CP-SAT + Heuristic）

| 编号 | 测试用例 | 测试方法 | 优先级 | 预期结果 |
|-----|---------|---------|:-----:|---------|
| SCHED-01 | 正常调度: 3 人 2 工位 2 任务，全约束通过 | 场景法 + 等价类 | P0 | 生成可行解，所有任务有分配，无违规 |
| SCHED-02 | 技能不匹配拦截: 人员缺少必要技能 | 决策表 | P0 | 该人员不进入候选，violation_type=SKILL |
| SCHED-03 | 资源不足: 任务数 > 可用人数 | 边界值 | P0 | 未分配任务附 blockingReasons |
| SCHED-04 | 并发调度: 同一资源被两个任务竞争 | 状态转换 + 场景法 | P0 | 互斥检测，后者等待或重新调度 |
| SCHED-05 | CP-SAT 超时降级: 求解时间超过阈值 | 边界值 | P1 | 自动降级至 Heuristic 求解器 |
| SCHED-06 | 设备电量不足: battery < MIN_BATTERY(15%) | 边界值 | P0 | 设备相关分配被拦截 |
| SCHED-07 | 维护封锁: 活跃维护事实 → 人员不可用 | 决策表 | P0 | _blocks() 返回 True，候选标记 blocked |
| SCHED-08 | 质量发现封锁: critical/high 质量发现 | 等价类 + 决策表 | P0 | _quality_blocks() 返回 True |
| SCHED-09 | 禁区校验: 人员当前在禁区中 | 等价类 | P0 | violation_type=FORBIDDEN_ZONE |
| SCHED-10 | 评分排序验证: 多候选按评分降序排列 | 正交试验 | P1 | 排名与 ScoringWeights 权重一致 |
| SCHED-11 | 影子运行→建议升级: promote_to_proposed | 状态转换 | P1 | SHADOW→PROPOSED 状态正确转换 |
| SCHED-12 | 确认必须填写理由: confirm() 空 reason | 边界值 | P0 | ValueError 拒绝，状态不变 |
| SCHED-13 | 未确认不得执行: execute() 在非 CONFIRMED 状态 | 状态转换 | P0 | executed=False，无自动旁路 |
| SCHED-14 | 班次休息约束: 连续工作超限 | 边界值 | P1 | violation_type=SHIFT_REST |
| SCHED-15 | 外骨骼型号兼容: 人-机型号不匹配 | 等价类 | P1 | violation_type=EXO_MODEL_COMPAT |

### 3.2 多租户 RLS

| 编号 | 测试用例 | 测试方法 | 优先级 | 预期结果 |
|-----|---------|---------|:-----:|---------|
| RLS-01 | 跨租户查询隔离: Tenant A 查询不可见 Tenant B 数据 | 等价类 | P0 | 查询结果仅含本租户数据 |
| RLS-02 | 跨租户写入拦截: Tenant A 不可修改 Tenant B 记录 | 边界值 | P0 | 写入被 RLS policy 拒绝 |
| RLS-03 | JWT 中 org_id 篡改: 修改 Token 中的租户标识 | 等价类（无效） | P0 | 认证失败，401/403 |
| RLS-04 | 空租户标识请求: JWT 缺少 org_id | 边界值 | P0 | 请求被拒绝 |
| RLS-05 | Admin 跨租户访问: 系统管理员权限边界 | 决策表 | P1 | 仅特定管理端点可跨租户 |
| RLS-06 | 并发跨租户请求: 同时以两个租户身份操作 | 场景法 | P1 | 无数据串租 |
| RLS-07 | 新租户数据隔离: 创建新租户后数据完全隔离 | 场景法 | P0 | 零数据泄露 |
| RLS-08 | UUID 主键枚举防御: 随机 UUID 不可猜测其他租户数据 | 等价类 | P1 | 枚举不可达 |
| RLS-09 | 审计列隔离: created_by 跨租户不可关联 | 边界值 | P2 | 审计数据隔离 |
| RLS-10 | 迁移后 RLS 一致性: 新增表自动应用 RLS | 状态转换 | P0 | 无遗漏的 RLS policy |
| RLS-11 | SQL 注入跨租户: 注入试图绕过 RLS | 安全测试 | P0 | RLS 在数据库层拦截 |
| RLS-12 | DELETE 级联隔离: 删除租户数据不影响其他租户 | 场景法 | P0 | 级联隔离 |

### 3.3 SSE 实时推送

| 编号 | 测试用例 | 测试方法 | 优先级 | 预期结果 |
|-----|---------|---------|:-----:|---------|
| SSE-01 | 正常连接: 客户端成功建立 SSE 连接 | 场景法 | P0 | 200 + Content-Type: text/event-stream |
| SSE-02 | 心跳保活: 服务端定期发送心跳 | 边界值 | P1 | 心跳间隔在配置范围内 |
| SSE-03 | 断线重连: 网络中断后自动恢复 | 场景法 + 状态转换 | P0 | 自动重连 + 消息回放 |
| SSE-04 | 消息顺序: 多条消息按序到达 | 场景法 | P0 | 顺序与发送一致 |
| SSE-05 | 并发推送: 同时推送多条不同类型消息 | 正交试验 | P1 | 各消息独立且完整 |
| SSE-06 | 客户端断开处理: 客户端异常断开 | 异常流 | P1 | 服务端资源正确释放 |
| SSE-07 | 租户隔离推送: Tenant A 消息不推送给 Tenant B | 等价类 | P0 | 零消息泄露 |
| SSE-08 | 大量客户端并发: 100+ 同时连接 | 性能测试 | P2 | 响应时间在 SLA 内 |
| SSE-09 | 消息回放: 重连后获取错过的消息 | 场景法 | P1 | Last-Event-Id 机制正确 |
| SSE-10 | 恶意客户端: 发送非法数据 | 安全测试 | P0 | 连接被拒绝/关闭 |
| SSE-11 | 调度结果推送: 调度完成后推送分配结果 | 场景法 | P0 | 推送内容与调度结果一致 |
| SSE-12 | 告警实时推送: 风险事件触发即时推送 | 场景法 | P0 | 延迟在 SLA 内 |

### 3.4 设备接入

| 编号 | 测试用例 | 测试方法 | 优先级 | 预期结果 |
|-----|---------|---------|:-----:|---------|
| DEV-01 | Modbus 标准采集: 正常读取传感器数据 | 场景法 | P0 | 数据解析正确，入库成功 |
| DEV-02 | OPC UA 认证: 证书认证连接 | 等价类 | P0 | 认证成功，数据传输正常 |
| DEV-03 | Sparkplug B 遥测: NBIRTH/NDATA/ NDEATH | 状态转换 | P0 | 设备生命周期正确管理 |
| DEV-04 | Webhook 推送接收: 外部系统推送数据 | 场景法 | P1 | 签名验证 + 数据入库 |
| DEV-05 | 数据格式解析错误: 非法/损坏的数据帧 | 等价类（无效） | P0 | 错误记录 + 质量标记 degraded |
| DEV-06 | 断线恢复: 设备短暂离线后恢复 | 场景法 + 状态转换 | P0 | 自动重连 + 补传缺失数据 |
| DEV-07 | 数据质量评级: 完整/延迟/缺失/异常 | 等价类 | P1 | 质量等级正确标记 |
| DEV-08 | 采样频率异常: 过高/过低频率 | 边界值 | P1 | 告警触发或数据节流 |
| DEV-09 | 多协议并发: 同时接入多种协议设备 | 正交试验 | P1 | 各协议独立处理，互不干扰 |
| DEV-10 | 设备模型兼容: AAS 编解码正确 | 场景法 | P1 | JSON/AASX 格式双向转换正确 |
| DEV-11 | 边缘推理结果: 推理输出正常生成事件 | 场景法 | P0 | 推理结果 → 事件生成链路完整 |
| DEV-12 | 设备上线/下线: NDEATH 后清理资源 | 状态转换 | P1 | 资源释放 + 状态标记 |
| DEV-13 | 数据脱敏: 敏感字段正确脱敏 | 安全测试 | P1 | 日志/存储中无明文敏感数据 |

### 3.5 事件告警

| 编号 | 测试用例 | 测试方法 | 优先级 | 预期结果 |
|-----|---------|---------|:-----:|---------|
| EVT-01 | 风险事件触发: 推理输出异常 → 生成风险事件 | 场景法 | P0 | 事件生成 + 风险等级正确 |
| EVT-02 | 严重度分级 L1: 轻微异常 | 等价类 | P0 | severity=L1，仅记录 |
| EVT-03 | 严重度分级 L2: 中等风险 | 等价类 | P0 | severity=L2，通知班组长 |
| EVT-04 | 严重度分级 L3: 严重风险/紧急 | 等价类 | P0 | severity=L3，即时告警 + SSE 推送 |
| EVT-05 | 证据窗口: 事件附带时间窗口内原始数据 | 场景法 | P1 | 证据完整，时间范围正确 |
| EVT-06 | 处置闭环: 事件生成 → 通知 → 确认 → 处置 | 场景法 | P0 | 全流程完整闭环 |
| EVT-07 | 重复事件去重: 相似事件在时间窗口内合并 | 边界值 | P1 | 去重逻辑正确 |
| EVT-08 | 事件与调度联动: 风险事件影响调度约束 | 场景法 | P0 | 人员标记 safety_hold，不进入候选 |
| EVT-09 | 告警升级: L1 → L2 超时未处理 | 状态转换 | P1 | 自动升级 + 扩大通知范围 |
| EVT-10 | 告警抑制: 同类告警在静默期内不重复 | 边界值 | P2 | 静默期内抑制 |
| EVT-11 | 跨租户事件隔离: 事件仅在所属租户可见 | 等价类 | P0 | 零跨租户泄露 |
| EVT-12 | 飞书卡片推送: L2/L3 事件触发飞书通知 | 集成测试 | P1 | 卡片消息正确发送 |
| EVT-13 | 处置回写: 飞书卡片回写 → 事件状态更新 | 集成测试 | P1 | 双向同步正确 |

---

## 4. 缺陷跟踪流程

### 4.1 缺陷生命周期

```
┌──────────┐    ┌──────────┐    ┌──────────┐    ┌──────────┐    ┌──────────┐    ┌──────────┐
│   新建    │───→│   确认    │───→│   分配    │───→│   修复    │───→│   验证    │───→│   关闭    │
│   New    │    │ Confirmed│    │ Assigned │    │  Fixed   │    │ Verified │    │  Closed  │
└──────────┘    └──────────┘    └──────────┘    └──────────┘    └──────────┘    └──────────┘
                     │                                  │               │
                     │              ┌──────────┐        │               │
                     └─────────────→│  拒绝/    │←───────┘               │
                                    │  不予修复  │                        │
                                    │ Rejected  │                        │
                                    └──────────┘                        │
                                                                         │
                                        ┌──────────┐                    │
                                        │  重新打开  │←───────────────────┘
                                        │ Reopened │
                                        └──────────┘
```

**状态说明**:

| 状态 | 负责人 | 动作 |
|-----|-------|------|
| **New** | 发现者 | 填写缺陷报告模板，提交至 GitHub Issues |
| **Confirmed** | QA Lead/Dev Lead | 确认缺陷可复现，评估严重度，指派模块 |
| **Assigned** | Dev Lead | 分配给具体开发人员，设置修复优先级 |
| **Fixed** | 开发人员 | 代码修复完成，提交 PR 并关联 Issue |
| **Verified** | QA 工程师 | 验证修复有效，回归测试通过 |
| **Closed** | QA 工程师 | 确认缺陷已完全修复，关闭 Issue |
| **Rejected** | Dev Lead | 不予修复（设计如此/无法复现/低优先级） |
| **Reopened** | QA 工程师 | 验证失败，缺陷仍然存在 |

### 4.2 缺陷分级标准

| 级别 | 名称 | 定义 | 修复时限 | 示例 |
|:---:|------|------|---------|------|
| **P0** | 致命 (Blocker) | 系统崩溃、数据丢失、安全漏洞、核心功能完全不可用 | **4 小时内响应，24 小时内修复** | RLS 隔离失效导致跨租户数据泄露；调度器自动执行绕过人工确认 |
| **P1** | 严重 (Critical) | 核心功能异常、数据不一致、性能严重退化 | **8 小时内响应，48 小时内修复** | CP-SAT 求解结果不满足硬约束；SSE 推送消息丢失 |
| **P2** | 一般 (Major) | 非核心功能异常、UI 显示错误、边缘场景处理不当 | **24 小时内响应，5 个工作日内修复** | 评分排序边界 case 不正确；告警升级时间窗口偏差 |
| **P3** | 轻微 (Minor) | 文案错误、UI 美化建议、非关键性能优化 | **下个迭代处理** | 日志格式不规范；提示信息不明确 |

### 4.3 缺陷报告模板

```markdown
## Bug Report

### 基本信息
- **标题**: [模块名] 简明描述（如：[Scheduler] CP-SAT 超时后未降级至 Heuristic）
- **严重度**: P0 / P1 / P2 / P3
- **模块**: Scheduler / RLS / SSE / Device / Alert / Feishu / Frontend
- **报告人**: @reporter
- **日期**: YYYY-MM-DD
- **环境**: CI / Dev / Staging / Production
- **关联 PR/Commit**: #xxx 或 commit hash

### 重现步骤
1. 步骤一：...
2. 步骤二：...
3. 步骤三：...

### 预期结果
描述符合设计/PRD 的预期行为

### 实际结果
描述实际观察到的行为

### 附加信息
- **日志/截图**: 附相关日志片段或截图
- **测试数据**: 相关的 golden fixture 或测试用例编号
- **影响范围**: 受影响的模块/用户/场景
- **临时规避方案**: 如有

### 验收条件
- [ ] 缺陷已修复
- [ ] 相关回归测试通过
- [ ] 新增覆盖此场景的测试用例（P0/P1 必须）
```

### 4.4 与 GitHub Issues 集成方案

```
┌─────────────────────────────────────────────────────────┐
│                 GitHub Issues 集成方案                     │
├──────────────┬──────────────────────────────────────────┤
│   Label 体系  │                                          │
│              │  severity/P0  severity/P1  severity/P2   │
│              │  severity/P3                               │
│              │  module/scheduler  module/rls  module/sse │
│              │  module/device  module/alert  module/feishu│
│              │  status/new  status/fixed  status/verified│
│              │  type/bug  type/regression  type/security │
├──────────────┼──────────────────────────────────────────┤
│   Workflow   │  1. QA 创建 Issue → 自动打 label: status/new│
│              │  2. Dev Lead 确认 → label: status/confirmed│
│              │  3. Dev 修复 → PR 关联 Issue (Closes #xxx) │
│              │  4. PR 合并 → 自动打 label: status/fixed   │
│              │  5. QA 验证 → label: status/verified → Close│
├──────────────┼──────────────────────────────────────────┤
│   PR 关联    │  PR 描述中包含 "Fixes #123" 自动关联       │
│              │  P0/P1 缺陷 PR 需 2 人 Code Review        │
├──────────────┼──────────────────────────────────────────┤
│   Dashboard  │  GitHub Projects Board 看板               │
│              │  列: New → Confirmed → Assigned → Fixed   │
│              │      → Verified → Closed                   │
├──────────────┼──────────────────────────────────────────┤
│   通知       │  P0: @channel 即时通知                    │
│              │  P1: @dev-lead + @assignee 通知            │
│              │  P2/P3: 日报汇总                           │
└──────────────┴──────────────────────────────────────────┘
```

---

## 5. 测试通过标准与验收条件

### 5.1 单元测试通过标准

| 指标 | 标准 | 度量方式 |
|-----|------|---------|
| 通过率 | **≥ 100%**（零容忍） | `pytest` / `jest` 输出 |
| 行覆盖率 | **≥ 80%** | `coverage.py` / `jest --coverage` |
| 分支覆盖率 | **≥ 70%** | `coverage.py --branch` |
| 函数覆盖率 | **≥ 90%** | 覆盖率报告 |
| 测试执行时间 | 单个测试 **< 5s**，全套件 **< 5min** | CI 计时 |
| Mock 使用 | 外部依赖必须 Mock | 代码审查 |
| 测试独立性 | 每个测试可独立运行，无顺序依赖 | `pytest --randomly` |

### 5.2 集成测试通过标准

| 指标 | 标准 | 度量方式 |
|-----|------|---------|
| 通过率 | **≥ 100%** | CI 输出 |
| 契约一致性 | Python ↔ TypeScript 契约测试全部通过 | `contract-golden` target |
| 状态机一致性 | 代码 ↔ YAML 契约无漂移 | `contract-state-machine` target |
| 数据库迁移 | 全新库可安装 + 顺序执行 | `migration-fresh-install-check.sh` |
| API 响应时间 | P95 **< 500ms** | 测试计时 |
| 并发安全 | 无数据竞争 | 并发测试用例 |

### 5.3 系统测试通过标准

| 指标 | 标准 | 度量方式 |
|-----|------|---------|
| 通过率 | **≥ 98%**（已知 issue 须文档化） | E2E 测试报告 |
| 关键路径覆盖 | 6 个核心业务流程 100% 覆盖 | 场景矩阵 |
| 跨浏览器 | Chrome / Firefox / Safari 最新 2 版本 | Playwright 多浏览器配置 |
| 多租户隔离 | 零数据泄露 | `cross-tenant-tck` target |
| 可访问性 | WCAG 2.1 AA 级 | `axe-core` 自动扫描 |

### 5.4 性能测试通过标准

| 指标 | 标准 | 测试场景 |
|-----|------|---------|
| **API 响应时间** | P50 < 200ms, P95 < 500ms, P99 < 1s | 标准负载 |
| **调度求解时间** | CP-SAT < 5s (50 人/20 任务), Heuristic < 1s | 最大生产规模 |
| **SSE 推送延迟** | 端到端 < 1s | 单条消息 |
| **数据库查询** | P95 < 100ms | 带 RLS 的查询 |
| **并发用户** | 支持 200+ 同时在线 | 峰值模拟 |
| **吞吐量** | API > 500 req/s | 持续负载 |
| **内存占用** | 稳态 < 512MB (边缘端) | 24 小时耐力测试 |
| **CPU 使用率** | 稳态 < 70% | 峰值负载 |

### 5.5 安全测试通过标准

| 指标 | 标准 | 验证方式 |
|-----|------|---------|
| **认证** | JWT 过期/伪造/重放全部拦截 | `test_identity_contract.py` |
| **授权** | RBAC 角色边界无越权 | 手动 + 自动化测试 |
| **数据隔离** | RLS 零泄露 | `cross-tenant-tck` |
| **输入验证** | SQL 注入/XSS/SSRF 全部防御 | `audit-regression-gates` 10 条主线 |
| **依赖安全** | 零 P0/P1 CVE | `npm audit` / `pip-audit` |
| **敏感数据** | 日志/传输中无明文敏感信息 | `audit-client-security-sinks` |
| **SSRF 防护** | 出站请求白名单校验 | `audit-ssrf-surface` |
| **演示残留** | 生产环境无 stub/mock 代码 | `audit-demo-residue` |

### 5.6 发布验收条件 (Release Criteria)

#### Go/No-Go 门禁清单

| # | 检查项 | 类型 | 必须通过 |
|---|--------|------|:-------:|
| 1 | 所有单元测试通过 (Python + TypeScript) | 自动 | ✅ |
| 2 | 契约测试套件全部通过 (`contract-golden`) | 自动 | ✅ |
| 3 | 状态机契约无漂移 (`contract-state-machine`) | 自动 | ✅ |
| 4 | 十条主线防回归门禁全通过 (`audit-regression-gates`) | 自动 | ✅ |
| 5 | Production Runtime Assembly 门禁通过 (`production-smoke`) | 自动 | ✅ |
| 6 | 跨租户 TCK 通过 (`cross-tenant-tck`) | 自动 | ✅ |
| 7 | 安全扫描零 P0/P1 (`security` + `bandit`) | 自动 | ✅ |
| 8 | 代码覆盖率达标 (行 ≥ 80%, 分支 ≥ 70%) | 自动 | ✅ |
| 9 | 数据库迁移链完整性 (`migration-fresh-install-check`) | 自动 | ✅ |
| 10 | Pilot 就绪检查通过 (`pilot-readiness`) | 自动 | ✅ |
| 11 | E2E 关键路径测试通过 | 手动 + 自动 | ✅ |
| 12 | 性能基准无退化 | 自动 | ✅ |
| 13 | 文档/CHANGELOG 更新 | 手动 | ✅ |
| 14 | 零 P0/P1 未关闭缺陷 | GitHub Issues | ✅ |
| 15 | Truth Manifest 单一事实源检查通过 (`truth-check`) | 自动 | ✅ |

---

## 6. 测试报告模板

### 6.1 测试报告格式

```markdown
# EWOH 测试报告

## 报告信息
- **版本**: v{x.y.z}
- **报告日期**: YYYY-MM-DD
- **测试周期**: YYYY-MM-DD ~ YYYY-MM-DD
- **报告人**: QA Engineer (Edward)
- **审核人**: Dev Lead / QA Lead

---

## 执行摘要

| 维度 | 结果 | 状态 |
|------|------|:----:|
| 单元测试 | XXX/XXX 通过 (XX%) | ✅/❌ |
| 集成测试 | XXX/XXX 通过 (XX%) | ✅/❌ |
| 契约测试 | XXX/XXX 通过 (XX%) | ✅/❌ |
| E2E 测试 | XXX/XXX 通过 (XX%) | ✅/❌ |
| 安全门禁 | XX/XX 通过 | ✅/❌ |
| 性能基准 | 无退化 / 有退化 | ✅/⚠️ |

**总体结论**: ✅ 通过发布 / ❌ 不通过 / ⚠️ 有条件通过

---

## 测试结果统计

### 按层级

| 测试层级 | 总数 | 通过 | 失败 | 跳过 | 阻塞 | 通过率 |
|---------|:----:|:----:|:----:|:----:|:----:|:------:|
| Python 单元测试 | | | | | | |
| TypeScript 单元测试 | | | | | | |
| Python 契约测试 | | | | | | |
| Scheduler Golden TCK | | | | | | |
| Cross-Tenant TCK | | | | | | |
| E2E (Playwright) | | | | | | |
| 飞书侧车测试 | | | | | | |
| **合计** | | | | | | |

### 按模块

| 模块 | 测试数 | 通过 | 失败 | 覆盖率 |
|------|:------:|:----:|:----:|:------:|
| Scheduler V2 | | | | |
| Multi-Tenant RLS | | | | |
| SSE Real-time Push | | | | |
| Device Ingestion | | | | |
| Event & Alert | | | | |
| Feishu Sidecar | | | | |
| Frontend | | | | |

---

## 代码覆盖率分析

| 模块 | 行覆盖 | 分支覆盖 | 函数覆盖 | 达标 |
|------|:------:|:-------:|:-------:|:----:|
| edge_platform (Python) | | | | ✅/❌ |
| server (TypeScript) | | | | ✅/❌ |
| client (React) | | | | ✅/❌ |
| feishu-app (Node.js) | | | | ✅/❌ |

**未达标模块**: [列出覆盖率未达标的模块及原因]

**低覆盖率文件 Top 10**:
1. `path/to/file.py` — 行: XX% — 原因: ...
2. ...

---

## 缺陷分布统计

### 按严重度

| 严重度 | 新增 | 已修复 | 遗留 | 关闭 |
|:------:|:----:|:-----:|:----:|:----:|
| P0 | | | | |
| P1 | | | | |
| P2 | | | | |
| P3 | | | | |
| **合计** | | | | |

### 按模块

| 模块 | P0 | P1 | P2 | P3 | 合计 |
|------|:--:|:--:|:--:|:--:|:----:|
| Scheduler | | | | | |
| RLS | | | | | |
| SSE | | | | | |
| Device | | | | | |
| Alert | | | | | |
| Frontend | | | | | |
| Feishu | | | | | |

### 缺陷趋势

```
新增 ████████████████████████████ (本周)
修复 ██████████████████████████████████ (本周)
遗留 ██ (累积)
```

---

## 性能基准对比

| 指标 | 上版本 | 本版本 | 变化 | 达标 |
|------|:-----:|:-----:|:----:|:----:|
| API P95 响应时间 | ms | ms | | |
| 调度求解时间 (50人/20任务) | s | s | | |
| SSE 推送延迟 | ms | ms | | |
| 并发用户峰值 | | | | |
| 内存占用 (稳态) | MB | MB | | |

---

## 风险评估与建议

### 已知风险

| # | 风险描述 | 影响 | 概率 | 缓解措施 |
|---|---------|------|:----:|---------|
| 1 | [描述] | [影响] | 高/中/低 | [措施] |

### 建议

1. **短期**: ...
2. **中期**: ...
3. **长期**: ...

---

## 附录

### A. 测试环境
- Python: 3.9+
- Node.js: 20.x
- PostgreSQL: 16.x
- Playwright: 最新稳定版
- CI: GitHub Actions

### B. 关联文档
- PRD: [链接]
- 系统设计: [链接]
- 架构文档: [链接]

### C. 签字确认

| 角色 | 姓名 | 日期 | 签字 |
|------|------|------|------|
| QA Engineer | | | |
| Dev Lead | | | |
| QA Lead | | | |
| PM | | | |
```

---

## 附录：Makefile 测试目标速查

| 目标 | 用途 | 推荐执行频率 |
|-----|------|-----------|
| `make test` | Python unittest 全套件 | 每次提交 |
| `make test-contract` | pytest 契约测试 | 每次提交 |
| `make contract-golden` | Golden 契约场景（跨语言） | 每次提交 |
| `make scheduler-golden` | Golden 调度器 TCK | 每次提交 |
| `make contract-state-machine` | 状态机契约一致性 | 涉及状态机变更时 |
| `make production-smoke` | 生产装配门禁 | 每次发布 |
| `make audit-regression-gates` | 十条主线防回归 | 每次发布 |
| `make cross-tenant-tck` | 跨租户全链 TCK | 每次发布 |
| `make pilot-readiness` | Pilot Go/No-Go 检查 | 发布前 |
| `make security` | bandit 安全扫描 | 每日 CI |
| `make lint` | ruff 静态检查 | 每次提交 |

---

*文档结束 — EWOH 详细测试方案 v1.0*
