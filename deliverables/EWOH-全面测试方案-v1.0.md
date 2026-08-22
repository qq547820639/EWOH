# EWOH 全面测试方案

> **版本**: v1.0 | **编制**: 软件开发团队 · 主理人齐活林（Qi）协调 | **日期**: 2026-08-21
> **项目**: EWOH (Exoskeleton Worker Operation & Harmony) v0.6.0-rc4
> **状态**: 初稿

---

## 目录

- [第一部分：测试架构设计](#第一部分测试架构设计)
  - [1. 测试分层架构](#1-测试分层架构)
  - [2. 测试环境架构](#2-测试环境架构)
  - [3. 覆盖率与质量门禁](#3-覆盖率与质量门禁)
  - [4. 关键模块专项测试策略](#4-关键模块专项测试策略)
  - [5. 测试工具链与配置](#5-测试工具链与配置)
- [第二部分：详细测试方案](#第二部分详细测试方案)
  - [6. 测试用例设计方法](#6-测试用例设计方法)
  - [7. 测试数据管理策略](#7-测试数据管理策略)
  - [8. 各模块测试用例概要](#8-各模块测试用例概要)
  - [9. 缺陷跟踪流程](#9-缺陷跟踪流程)
  - [10. 测试通过标准与验收条件](#10-测试通过标准与验收条件)
  - [11. 测试报告模板](#11-测试报告模板)

---

# 第一部分：测试架构设计

## 1. 测试分层架构

### 1.1 整体分层模型

```
┌─────────────────────────────────────────────────────────────────┐
│                        EWOH 测试金字塔                            │
├─────────────────────────────────────────────────────────────────┤
│                                                                 │
│                     ┌───────────────┐                           │
│                     │  E2E / 系统测试 │  ← Playwright + 手工     │
│                     │   (少量, 慢)    │                          │
│                     └───────┬───────┘                           │
│                  ┌──────────┴──────────┐                        │
│                  │     集成测试          │  ← pytest + Jest      │
│                  │  (契约/跨模块/DB)     │    + supertest        │
│                  └──────────┬──────────┘                        │
│          ┌──────────────────┴──────────────────┐                │
│          │            单元测试                   │  ← unittest   │
│          │  (大量, 快速, 覆盖核心业务逻辑)        │    + Jest     │
│          └─────────────────────────────────────┘                │
│                                                                 │
│  横切面: 性能测试 | 安全测试 | 视觉回归测试 | 混沌测试           │
└─────────────────────────────────────────────────────────────────┘
```

### 1.2 各运行时测试策略

| 运行时 | 单元测试框架 | 集成测试框架 | E2E 框架 | 现有测试数 |
|--------|------------|------------|----------|:----------:|
| **Python Edge** | `unittest` (stdlib) | `pytest` + fixtures | — | 63+ 单元 / 31+ 契约 |
| **NestJS Cloud** | `Jest 29.x` + `ts-jest` | `@nestjs/testing` + `supertest` | `Playwright` | 1353+ spec 文件 |
| **React Frontend** | `Jest` + `@testing-library/react` | `MSW` (Mock Service Worker) | `Playwright` | client/jest.config.cjs |
| **Feishu Sidecar** | `node --test` (built-in) | `supertest` | — | 11 个测试文件 |

### 1.3 测试矩阵

```
                    Python Edge    NestJS Cloud    React Frontend    Feishu Sidecar
                    ───────────    ────────────    ──────────────    ──────────────
单元测试               ✅               ✅              ✅                ✅
集成测试               ✅               ✅              ✅                ✅
契约测试(跨语言)        ✅               ✅              —                 —
E2E                  —                ✅              ✅                —
性能测试              ✅               ✅              ✅                —
安全测试              ✅               ✅              ✅                ✅
视觉回归              —                —               ✅                —
```

### 1.4 契约测试架构（跨语言一致性）

EWOH 核心调度逻辑同时在 Python（边缘端）和 TypeScript（云端）实现，**Golden Fixture** 是跨语言一致性的单一事实源：

```
tests/golden-fixtures/
├── scheduler-golden-scenarios.json       # 输入场景（Python + TS 共享）
├── scheduler-golden-results.json         # 期望输出（Python 独立仲裁）
├── scheduler-workflow-golden.json        # 工作流场景
├── scheduler-workflow-golden-results.json
├── contract-golden-scenarios.json        # 八域契约共享
└── scheduler-contract.golden.json        # 调度器契约基线

                 ┌──────────────┐
                 │ Golden JSON  │  ← 单一事实源
                 │  Fixtures    │
                 └──────┬───────┘
            ┌───────────┴───────────┐
            ▼                       ▼
   ┌────────────────┐     ┌────────────────┐
   │ Python pytest  │     │ TypeScript Jest│
   │ (edge_platform)│     │ (spark-app)    │
   └────────┬───────┘     └────────┬───────┘
            │                      │
            └──────────┬───────────┘
                       ▼
              CI 漂移检测门禁
         (两侧结果不一致 → 构建失败)
```

---

## 2. 测试环境架构

### 2.1 四层环境模型

```
┌─────────────────────────────────────────────────────────────────┐
│                        环境分层                                   │
├──────────┬──────────────┬───────────────┬───────────────────────┤
│  本地开发  │   CI/CD      │   预发布       │   生产                │
│  (Local)  │  (GitHub     │  (Staging)    │  (Production)        │
│           │   Actions)   │               │                      │
├──────────┼──────────────┼───────────────┼───────────────────────┤
│ 单元测试   │ 全量单元+集成 │ 全量E2E       │ 烟雾测试              │
│ 快速反馈   │ 契约+安全    │ 性能基准       │ 合成监控              │
│ SQLite    │ PostgreSQL   │ PostgreSQL    │ 生产数据库             │
│ :memory:  │ (Docker)     │ (类生产配置)   │ 只读探针              │
├──────────┼──────────────┼───────────────┼───────────────────────┤
│ < 2min    │ < 15min      │ < 30min       │ < 5min               │
└──────────┴──────────────┴───────────────┴───────────────────────┘
```

### 2.2 CI/CD 环境详细配置

**GitHub Actions 现有 7 个 Workflow**:

| Workflow | 文件 | 职责 | 触发条件 |
|----------|------|------|---------|
| `standalone.yml` | 44KB | 主 CI/CD 管线 | push/PR |
| `test.yml` | — | 测试套件 | push/PR |
| `runtime-gates.yml` | 32KB | 运行时门禁 | push/PR |
| `security.yml` | — | 安全扫描 | 每日 + push |
| `perf.yml` | — | 性能测试 | 定期 + 手动 |
| `feishu.yml` | — | 飞书应用测试 | push |
| `package.yml` | — | 包验证 | release |

**CI 数据库配置**:
```yaml
# PostgreSQL 服务容器（CI 专用）
services:
  postgres:
    image: postgres:17
    env:
      POSTGRES_DB: ewoh_test
      POSTGRES_USER: test
      POSTGRES_PASSWORD: test
    options: >-
      --health-cmd pg_isready
      --health-interval 10s
      --health-timeout 5s
      --health-retries 5
```

### 2.3 本地开发环境

```bash
# Python 边缘端（stdlib only，零依赖）
python -m unittest discover -s src/edge_platform/tests -p "test_*.py"

# TypeScript 云端
cd ewoh-spark-app && npm test

# 全量测试（Makefile）
make test              # Python 全套件
make test-contract     # 契约测试
make contract-golden   # Golden 跨语言一致性
make lint              # 静态检查
```

---

## 3. 覆盖率与质量门禁

### 3.1 覆盖率目标

| 运行时 | 工具 | 行覆盖目标 | 分支覆盖目标 | 函数覆盖目标 |
|--------|------|:----------:|:----------:|:----------:|
| Python Edge | `coverage.py` | ≥ 80% | ≥ 70% | ≥ 90% |
| NestJS Cloud | `jest --coverage` | ≥ 80% | ≥ 70% | ≥ 90% |
| React Frontend | `jest --coverage` | ≥ 75% | ≥ 65% | ≥ 85% |
| Feishu Sidecar | `c8` / `nyc` | ≥ 70% | ≥ 60% | ≥ 80% |

### 3.2 质量门禁（Quality Gates）

```
┌─────────────────────────────────────────────────────────────────┐
│                     质量门禁流水线                                 │
├──────────────┬──────────────────────────────────────────────────┤
│   Gate 1     │  提交门禁（每次 push / PR）                        │
│   提交级      │  ✅ 全量单元测试通过 (100%)                        │
│              │  ✅ lint 零告警                                    │
│              │  ✅ 契约测试通过                                    │
│              │  ✅ 行覆盖率 ≥ 80%（不降级）                        │
│              │  ✅ 类型检查通过 (tsc --noEmit)                     │
├──────────────┼──────────────────────────────────────────────────┤
│   Gate 2     │  合并门禁（PR 合并前）                              │
│   合并级      │  ✅ Gate 1 全部通过                                │
│              │  ✅ Code Review ≥ 1 人批准                         │
│              │  ✅ Golden 跨语言一致性通过                          │
│              │  ✅ 安全扫描零 P0/P1                                │
│              │  ✅ 十条主线防回归门禁通过                            │
├──────────────┼──────────────────────────────────────────────────┤
│   Gate 3     │  发布门禁（release 前）                             │
│   发布级      │  ✅ Gate 2 全部通过                                │
│              │  ✅ Production Runtime Assembly 通过               │
│              │  ✅ 跨租户 TCK 通过                                 │
│              │  ✅ 性能基准无退化                                   │
│              │  ✅ Pilot 就绪检查通过                               │
│              │  ✅ 零 P0/P1 未关闭缺陷                              │
│              │  ✅ 数据库迁移链完整性                                │
│              │  ✅ Truth Manifest 检查通过                          │
└──────────────┴──────────────────────────────────────────────────┘
```

### 3.3 覆盖率与 CI 集成

```yaml
# 建议：在 GitHub Actions 中添加覆盖率检查步骤
- name: Check coverage threshold
  run: |
    coverage report --fail-under=80
    # TS 侧
    cd ewoh-spark-app && npx jest --coverage --coverageThreshold='{"global":{"lines":80,"branches":70,"functions":90}}'
```

---

## 4. 关键模块专项测试策略

### 4.1 调度器 V2（CP-SAT + Heuristic 双求解器）

**测试策略**: 分层验证 + Golden Fixture 跨语言一致性

```
┌───────────────────────────────────────────────────────────┐
│                    调度器测试分层                            │
├───────────────────────────────────────────────────────────┤
│  L1: 约束单元测试                                          │
│      - 每个约束函数独立测试（SKILL/CERT/SHIFT_REST/...）     │
│      - 边界值 + 等价类 + 决策表                             │
│                                                           │
│  L2: 求解器集成测试                                         │
│      - CP-SAT Worker 完整求解流程                           │
│      - Heuristic 回退路径                                   │
│      - 超时降级（CP-SAT → Heuristic）                       │
│      - Golden Fixture 场景回归                              │
│                                                           │
│  L3: 调度编排器集成测试                                      │
│      - 完整 8 步流水线                                      │
│      - 快照 → 排序 → 过滤 → 路由 → 求解 → 计划 → 审批 → 派遣 │
│      - 影子运行 + 建议升级                                   │
│                                                           │
│  L4: 跨语言一致性测试                                        │
│      - Python ↔ TypeScript Golden Fixture 比对              │
│      - CI 漂移检测门禁                                       │
└───────────────────────────────────────────────────────────┘
```

**关键测试场景**:
- 正常调度（Happy Path）
- 硬约束冲突（技能/工位/健康/禁区/电量/设备）
- 资源不足降级
- CP-SAT 超时 → Heuristic 回退
- 并发调度互斥
- 状态机不可变性（REJECTED/EXECUTED 终态不可复活）

### 4.2 多租户 RLS 隔离

**测试策略**: 数据库层 + API 层双重验证

```
┌───────────────────────────────────────────────────────────┐
│                    RLS 测试策略                              │
├───────────────────────────────────────────────────────────┤
│  DB 层:                                                    │
│    - SET app.tenant_id → 验证查询结果仅含本租户数据           │
│    - 跨租户 INSERT/UPDATE/DELETE 被拒绝                      │
│    - RLS policy 覆盖所有业务表                               │
│    - 新增表自动继承 RLS（迁移检查）                            │
│                                                           │
│  API 层:                                                   │
│    - JWT 含 org_id → 验证 API 响应数据边界                   │
│    - JWT 篡改 org_id → 401/403                             │
│    - 空 org_id → 请求拒绝                                   │
│    - Admin 端点权限边界                                      │
│                                                           │
│  跨语言 TCK:                                               │
│    - cross-tenant-tck Makefile target                      │
│    - 覆盖 CRUD 全操作 × 多租户场景                           │
└───────────────────────────────────────────────────────────┘
```

### 4.3 SSE 实时推送

**测试策略**: 连接生命周期 + 消息可靠性

```
┌───────────────────────────────────────────────────────────┐
│                    SSE 测试策略                              │
├───────────────────────────────────────────────────────────┤
│  连接管理:                                                  │
│    - 建立连接 / 心跳保活 / 正常断开                           │
│    - 异常断开后资源释放                                      │
│    - 大量并发连接（100+）                                    │
│                                                           │
│  消息可靠性:                                                │
│    - 消息顺序保证                                           │
│    - 断线重连 + Last-Event-Id 回放                          │
│    - 租户隔离推送（零消息泄露）                               │
│                                                           │
│  业务集成:                                                  │
│    - 调度结果推送                                           │
│    - 风险告警实时推送                                        │
│    - 命令地图状态同步                                        │
│                                                           │
│  性能:                                                     │
│    - 端到端延迟 < 1s                                        │
│    - 200+ 并发连接稳定性                                     │
└───────────────────────────────────────────────────────────┘
```

### 4.4 边缘端离线/弱网

**测试策略**: stdlib Mock + 网络注入

```
┌───────────────────────────────────────────────────────────┐
│                    边缘端测试策略                             │
├───────────────────────────────────────────────────────────┤
│  离线模式:                                                  │
│    - SQLite 本地缓存正常工作                                 │
│    - 断网后数据采集不中断                                    │
│    - 恢复连接后数据同步                                      │
│                                                           │
│  弱网模式:                                                  │
│    - 延迟注入（stdlib socket 模拟）                          │
│    - 数据分片传输                                           │
│    - 超时重试机制                                           │
│                                                           │
│  数据质量:                                                  │
│    - 完整/延迟/缺失/异常 四级评级                             │
│    - degraded 数据标记正确                                   │
│    - 降级策略验证                                           │
└───────────────────────────────────────────────────────────┘
```

---

## 5. 测试工具链与配置

### 5.1 工具链总览

| 类别 | 工具 | 用途 | 状态 |
|------|------|------|:----:|
| **Python 单元** | `unittest` (stdlib) | 边缘端单元测试 | ✅ 已有 |
| **Python 集成** | `pytest` | 契约测试 + 集成测试 | ✅ 已有 |
| **Python 覆盖率** | `coverage.py` | 行/分支覆盖率 | ⚠️ 需配置 |
| **Python Lint** | `ruff` | 静态代码检查 | ✅ 已有 |
| **Python 安全** | `bandit` | 安全扫描 | ✅ 已有 |
| **TS 单元** | `Jest 29.x` + `ts-jest` | 服务端/客户端单元测试 | ✅ 已有 |
| **TS 覆盖率** | `jest --coverage` | 行/分支覆盖率 | ⚠️ 需配置 |
| **E2E** | `Playwright` | 浏览器端到端测试 | ✅ 已有 |
| **视觉回归** | `Playwright visual` | 截图比对 | ⚠️ 待扩展 |
| **API 测试** | `supertest` | HTTP 接口测试 | ✅ 已有 |
| **Mock** | `MSW` / `jest.mock` | 前端/后端 Mock | ✅ 已有 |
| **性能** | `k6` / `autocannon` | 负载/压力测试 | ⚠️ 需引入 |
| **依赖审计** | `npm audit` / `pip-audit` | CVE 扫描 | ✅ 已有 |
| **DAST** | `OWASP ZAP` | 动态安全测试 | ⚠️ 需引入 |

### 5.2 性能测试工具选型建议

| 场景 | 推荐工具 | 理由 |
|------|---------|------|
| API 负载测试 | `k6` (Grafana) | 脚本化、CI 可集成、指标丰富 |
| Node.js HTTP 基准 | `autocannon` | 轻量、零配置 |
| 数据库查询基准 | `pgbench` | PostgreSQL 原生 |
| 前端性能 | `Lighthouse CI` | Core Web Vitals |
| 边缘端内存 | `tracemalloc` (Python stdlib) | 零外部依赖 |

### 5.3 需新增的配置文件

```
# 覆盖率配置（Python）
# pyproject.toml 中已有 pytest 配置，需补充:
[tool.coverage.run]
source = ["src/edge_platform"]
branch = true

[tool.coverage.report]
fail_under = 80
show_missing = true

# 覆盖率配置（TypeScript）
# ewoh-spark-app/package.json 中补充:
"jest": {
  "coverageThreshold": {
    "global": {
      "lines": 80,
      "branches": 70,
      "functions": 90
    }
  }
}
```

---

# 第二部分：详细测试方案

## 6. 测试用例设计方法

### 6.1 等价类划分法

**适用场景**: 输入参数具有连续取值范围或有限离散集合的场景。

| 有效等价类 | 无效等价类 | EWOH 应用示例 |
|-----------|-----------|-------------|
| 合法调度优先级（P1-P5） | 优先级为空/超出范围 | `priority.py`: PriorityLevel 枚举边界 |
| 合法 JWT Token | 过期/格式错误/篡改 Token | 多租户认证接口 `auth.service` |
| 正常 loadLevel (0.0-1.0) | 负值/超过 1.0/非数字 | `scoring.py` 人员负载评分 |
| 有效技能标签集合 | 空集合/未注册技能 | `constraints.py` SKILL 约束 |

### 6.2 边界值分析法

**适用场景**: 参数有明确数值/长度/数量限制的场景。

| 边界类型 | 边界值 | EWOH 应用 |
|---------|-------|---------|
| 电池电量下限 | 15% (MIN_BATTERY) | 设备电量约束 |
| 连续工作时长上限 | 制度规定上限分钟数 | SHIFT_REST 约束 |
| 负载等级阈值 | 0.9 (MAX_LOAD) | 硬约束: person.loadLevel > MAX_LOAD 即拒绝 |
| 严重度等级 | L1/L2/L3 三级边界 | 事件告警分级 |
| SSE 连接超时 | 秒级心跳间隔 | 实时推送保活 |

**关键边界测试矩阵**:
```python
# MIN_BATTERY = 15:  14(拦截) | 15(通过) | 16(通过)
# MAX_LOAD = 0.9:    0.89(通过) | 0.90(通过) | 0.91(拦截)
# 技能匹配:          完全匹配 | 超集 | 缺失一项(拦截) | 空集(拦截)
```

### 6.3 决策表法

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

### 6.4 状态转换法

**适用场景**: 具有明确状态机的业务对象。

#### 任务状态机（11 状态 / 14 转换）

```
draft → pending_confirm → pending_approval → pending_dispatch → dispatched → received → executing → completed
                      ↘                  ↘                    ↘                    ↗
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

#### 调度请求状态机（5 状态）

```
SHADOW → PROPOSED → CONFIRMED → EXECUTED
  ↘        ↘           ↗
   REJECTED           (reject 任意阶段)
```

**核心不变量**:
- `execute()` 仅在 CONFIRMED 后标记 EXECUTED；无自动执行旁路
- `confirm()` 必须提供 reason（空字符串/None 拒绝）
- REJECTED/EXECUTED 终态不可被 `confirm()` 复活

### 6.5 因果图法

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

### 6.6 正交试验法

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

### 6.7 场景法

**适用场景**: 端到端业务流程测试，覆盖基本流、备选流和异常流。

#### 智能调度器 V2 全流程场景

**基本流 (Happy Path)**:
```
世界状态快照生成 → 优先级排序 → 资格过滤 → 路由计算 → CP-SAT/Heuristic 求解 → 计划生成 → 人工审批 → 资源预留 → 任务派遣 → SSE 实时推送
```

**备选流**:

| 编号 | 场景 | 分支点 | 后续行为 |
|-----|------|-------|---------|
| AF-01 | 班组长否决方案 | 人工审批 | 状态→REJECTED，记录否决理由 |
| AF-02 | 无满足约束的候选人 | 资格过滤 | 返回空候选列表 + 拦截原因 |
| AF-03 | CP-SAT 超时 | 求解阶段 | 降级至 Heuristic 求解器 |
| AF-04 | 资源冲突 | 资源预留 | 冲突检测 → 重新调度 |
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

## 7. 测试数据管理策略

### 7.1 测试数据生成工具选型

| 层级 | 推荐工具 | 用途 | 理由 |
|-----|---------|------|------|
| Python 单元测试 | 标准库 `dataclasses` + `unittest.mock` | 构造测试对象 | EWOH 边缘端要求 stdlib only |
| Python 集成测试 | `pytest` fixtures + `conftest.py` | 共享测试配置 | 已有基础设施 |
| Python 边缘端数据 | 手写 Factory 函数 | 生成标准世界状态快照 | stdlib only 约束 |
| TypeScript 服务端 | `@faker-js/faker` + `@nestjs/testing` | 生成测试数据 | NestJS 生态标准 |
| TypeScript E2E | Playwright fixtures + 自定义 `test-data/` | 端到端数据准备 | 已有 Playwright 配置 |
| 跨语言 Golden | JSON fixture 文件 | 跨运行时一致性 | 已有 6 个 golden 文件 |

### 7.2 多租户测试数据隔离方案

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

### 7.3 Golden Fixture 扩展策略

```
tests/golden-fixtures/
├── scheduler-golden-scenarios.json      # 现有：求解场景
├── scheduler-golden-results.json        # 现有：求解结果
├── scheduler-workflow-golden.json       # 现有：工作流
├── contract-golden-scenarios.json       # 现有：契约
│
├── device-ingest-scenarios.json         # 新增：设备接入场景
├── alert-rules-scenarios.json           # 新增：告警规则场景
├── rls-isolation-scenarios.json         # 新增：多租户隔离场景
└── sse-scenarios.json                   # 新增：SSE 推送场景
```

### 7.4 边缘端模拟数据生成

```python
# 文件: src/edge_platform/tests/factories.py（建议新增）
# 遵循 stdlib only 约束

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
```

---

## 8. 各模块测试用例概要

### 8.1 调度器 V2（CP-SAT + Heuristic）

| 编号 | 测试用例 | 测试方法 | 优先级 | 预期结果 |
|-----|---------|---------|:-----:|---------|
| SCHED-01 | 正常调度: 3 人 2 工位 2 任务 | 场景法 + 等价类 | P0 | 生成可行解，所有任务有分配 |
| SCHED-02 | 技能不匹配拦截 | 决策表 | P0 | 该人员不进入候选，violation_type=SKILL |
| SCHED-03 | 资源不足: 任务数 > 可用人数 | 边界值 | P0 | 未分配任务附 blockingReasons |
| SCHED-04 | 并发调度: 同一资源被两个任务竞争 | 状态转换 + 场景法 | P0 | 互斥检测，后者等待或重新调度 |
| SCHED-05 | CP-SAT 超时降级 | 边界值 | P1 | 自动降级至 Heuristic 求解器 |
| SCHED-06 | 设备电量不足: battery < 15% | 边界值 | P0 | 设备相关分配被拦截 |
| SCHED-07 | 维护封锁: 活跃维护 → 人员不可用 | 决策表 | P0 | _blocks() 返回 True |
| SCHED-08 | 质量发现封锁: critical/high 质量发现 | 等价类 + 决策表 | P0 | _quality_blocks() 返回 True |
| SCHED-09 | 禁区校验: 人员当前在禁区中 | 等价类 | P0 | violation_type=FORBIDDEN_ZONE |
| SCHED-10 | 评分排序验证 | 正交试验 | P1 | 排名与权重一致 |
| SCHED-11 | 影子运行→建议升级 | 状态转换 | P1 | SHADOW→PROPOSED 正确转换 |
| SCHED-12 | 确认必须填写理由 | 边界值 | P0 | ValueError 拒绝，状态不变 |
| SCHED-13 | 未确认不得执行 | 状态转换 | P0 | executed=False，无自动旁路 |
| SCHED-14 | 班次休息约束 | 边界值 | P1 | violation_type=SHIFT_REST |
| SCHED-15 | 外骨骼型号兼容 | 等价类 | P1 | violation_type=EXO_MODEL_COMPAT |

### 8.2 多租户 RLS

| 编号 | 测试用例 | 测试方法 | 优先级 | 预期结果 |
|-----|---------|---------|:-----:|---------|
| RLS-01 | 跨租户查询隔离 | 等价类 | P0 | 查询结果仅含本租户数据 |
| RLS-02 | 跨租户写入拦截 | 边界值 | P0 | 写入被 RLS policy 拒绝 |
| RLS-03 | JWT 中 org_id 篡改 | 等价类（无效） | P0 | 认证失败，401/403 |
| RLS-04 | 空租户标识请求 | 边界值 | P0 | 请求被拒绝 |
| RLS-05 | Admin 跨租户访问 | 决策表 | P1 | 仅特定管理端点可跨租户 |
| RLS-06 | 并发跨租户请求 | 场景法 | P1 | 无数据串租 |
| RLS-07 | 新租户数据隔离 | 场景法 | P0 | 零数据泄露 |
| RLS-08 | UUID 主键枚举防御 | 等价类 | P1 | 枚举不可达 |
| RLS-09 | 审计列隔离 | 边界值 | P2 | 审计数据隔离 |
| RLS-10 | 迁移后 RLS 一致性 | 状态转换 | P0 | 无遗漏的 RLS policy |
| RLS-11 | SQL 注入跨租户 | 安全测试 | P0 | RLS 在数据库层拦截 |
| RLS-12 | DELETE 级联隔离 | 场景法 | P0 | 级联隔离 |

### 8.3 SSE 实时推送

| 编号 | 测试用例 | 测试方法 | 优先级 | 预期结果 |
|-----|---------|---------|:-----:|---------|
| SSE-01 | 正常连接 | 场景法 | P0 | 200 + text/event-stream |
| SSE-02 | 心跳保活 | 边界值 | P1 | 心跳间隔在配置范围内 |
| SSE-03 | 断线重连 | 场景法 + 状态转换 | P0 | 自动重连 + 消息回放 |
| SSE-04 | 消息顺序 | 场景法 | P0 | 顺序与发送一致 |
| SSE-05 | 并发推送 | 正交试验 | P1 | 各消息独立且完整 |
| SSE-06 | 客户端断开处理 | 异常流 | P1 | 服务端资源正确释放 |
| SSE-07 | 租户隔离推送 | 等价类 | P0 | 零消息泄露 |
| SSE-08 | 大量客户端并发 | 性能测试 | P2 | 响应在 SLA 内 |
| SSE-09 | 消息回放 | 场景法 | P1 | Last-Event-Id 正确 |
| SSE-10 | 恶意客户端 | 安全测试 | P0 | 连接被拒绝/关闭 |
| SSE-11 | 调度结果推送 | 场景法 | P0 | 推送与调度结果一致 |
| SSE-12 | 告警实时推送 | 场景法 | P0 | 延迟在 SLA 内 |

### 8.4 设备接入

| 编号 | 测试用例 | 测试方法 | 优先级 | 预期结果 |
|-----|---------|---------|:-----:|---------|
| DEV-01 | Modbus 标准采集 | 场景法 | P0 | 数据解析正确，入库成功 |
| DEV-02 | OPC UA 认证 | 等价类 | P0 | 认证成功，数据传输正常 |
| DEV-03 | Sparkplug B 遥测 | 状态转换 | P0 | 设备生命周期正确管理 |
| DEV-04 | Webhook 推送接收 | 场景法 | P1 | 签名验证 + 数据入库 |
| DEV-05 | 数据格式解析错误 | 等价类（无效） | P0 | 错误记录 + 质量标记 degraded |
| DEV-06 | 断线恢复 | 场景法 + 状态转换 | P0 | 自动重连 + 补传 |
| DEV-07 | 数据质量评级 | 等价类 | P1 | 质量等级正确标记 |
| DEV-08 | 采样频率异常 | 边界值 | P1 | 告警触发或数据节流 |
| DEV-09 | 多协议并发 | 正交试验 | P1 | 各协议独立处理 |
| DEV-10 | AAS 编解码 | 场景法 | P1 | JSON/AASX 双向转换正确 |
| DEV-11 | 边缘推理结果 | 场景法 | P0 | 推理结果 → 事件生成完整 |
| DEV-12 | 设备上线/下线 | 状态转换 | P1 | 资源释放 + 状态标记 |
| DEV-13 | 数据脱敏 | 安全测试 | P1 | 无明文敏感数据 |

### 8.5 事件告警

| 编号 | 测试用例 | 测试方法 | 优先级 | 预期结果 |
|-----|---------|---------|:-----:|---------|
| EVT-01 | 风险事件触发 | 场景法 | P0 | 事件生成 + 风险等级正确 |
| EVT-02 | 严重度分级 L1 | 等价类 | P0 | severity=L1，仅记录 |
| EVT-03 | 严重度分级 L2 | 等价类 | P0 | severity=L2，通知班组长 |
| EVT-04 | 严重度分级 L3 | 等价类 | P0 | severity=L3，即时告警 + SSE |
| EVT-05 | 证据窗口 | 场景法 | P1 | 证据完整，时间范围正确 |
| EVT-06 | 处置闭环 | 场景法 | P0 | 全流程完整闭环 |
| EVT-07 | 重复事件去重 | 边界值 | P1 | 去重逻辑正确 |
| EVT-08 | 事件与调度联动 | 场景法 | P0 | 人员标记 safety_hold |
| EVT-09 | 告警升级 | 状态转换 | P1 | 自动升级 + 扩大通知 |
| EVT-10 | 告警抑制 | 边界值 | P2 | 静默期内抑制 |
| EVT-11 | 跨租户事件隔离 | 等价类 | P0 | 零跨租户泄露 |
| EVT-12 | 飞书卡片推送 | 集成测试 | P1 | 卡片消息正确发送 |
| EVT-13 | 处置回写 | 集成测试 | P1 | 双向同步正确 |

---

## 9. 缺陷跟踪流程

### 9.1 缺陷生命周期

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

### 9.2 缺陷分级标准

| 级别 | 名称 | 定义 | 修复时限 | 示例 |
|:---:|------|------|---------|------|
| **P0** | 致命 | 系统崩溃、数据丢失、安全漏洞 | **4h 响应，24h 修复** | RLS 隔离失效；调度器绕过人工确认 |
| **P1** | 严重 | 核心功能异常、数据不一致 | **8h 响应，48h 修复** | CP-SAT 不满足硬约束；SSE 消息丢失 |
| **P2** | 一般 | 非核心功能异常、边缘场景 | **24h 响应，5 日修复** | 评分排序边界 case；告警升级偏差 |
| **P3** | 轻微 | 文案错误、UI 美化建议 | **下个迭代处理** | 日志格式不规范 |

### 9.3 GitHub Issues 集成方案

| 维度 | 方案 |
|------|------|
| **Label 体系** | `severity/P0-P3` + `module/scheduler\|rls\|sse\|device\|alert\|feishu` + `status/new\|fixed\|verified` |
| **Workflow** | 创建 → 自动 label:status/new → 确认 → 分配 → PR 关联 (Closes #xxx) → 合并 → 验证 → 关闭 |
| **PR 关联** | PR 描述含 "Fixes #123" 自动关联；P0/P1 需 2 人 Code Review |
| **Dashboard** | GitHub Projects Board: New → Confirmed → Assigned → Fixed → Verified → Closed |
| **通知** | P0: @channel 即时；P1: @dev-lead + @assignee；P2/P3: 日报汇总 |

---

## 10. 测试通过标准与验收条件

### 10.1 各层级通过标准

| 层级 | 指标 | 标准 | 度量方式 |
|------|------|------|---------|
| **单元测试** | 通过率 | ≥ 100% | pytest / jest 输出 |
| | 行覆盖率 | ≥ 80% | coverage.py / jest --coverage |
| | 分支覆盖率 | ≥ 70% | coverage.py --branch |
| | 函数覆盖率 | ≥ 90% | 覆盖率报告 |
| | 执行时间 | 单个 < 5s，全套件 < 5min | CI 计时 |
| **集成测试** | 通过率 | ≥ 100% | CI 输出 |
| | 契约一致性 | Python ↔ TS 全部通过 | contract-golden target |
| | 状态机一致性 | 代码 ↔ YAML 无漂移 | contract-state-machine |
| | API 响应时间 | P95 < 500ms | 测试计时 |
| **系统测试** | 通过率 | ≥ 98% | E2E 测试报告 |
| | 关键路径覆盖 | 6 个核心流程 100% | 场景矩阵 |
| | 跨浏览器 | Chrome/Firefox/Safari 最新 2 版本 | Playwright |
| | 多租户隔离 | 零数据泄露 | cross-tenant-tck |

### 10.2 性能测试通过标准

| 指标 | 标准 | 测试场景 |
|-----|------|---------|
| API P50 响应时间 | < 200ms | 标准负载 |
| API P95 响应时间 | < 500ms | 标准负载 |
| API P99 响应时间 | < 1s | 标准负载 |
| 调度求解时间 | CP-SAT < 5s (50人/20任务) | 最大生产规模 |
| 调度求解时间 | Heuristic < 1s | 最大生产规模 |
| SSE 推送延迟 | 端到端 < 1s | 单条消息 |
| 数据库查询 | P95 < 100ms | 带 RLS 查询 |
| 并发用户 | 200+ 同时在线 | 峰值模拟 |
| 吞吐量 | API > 500 req/s | 持续负载 |
| 内存占用 | 稳态 < 512MB (边缘端) | 24h 耐力 |
| CPU 使用率 | 稳态 < 70% | 峰值负载 |

### 10.3 安全测试通过标准

| 指标 | 标准 | 验证方式 |
|-----|------|---------|
| 认证 | JWT 过期/伪造/重放全部拦截 | test_identity_contract.py |
| 授权 | RBAC 角色边界无越权 | 自动化测试 |
| 数据隔离 | RLS 零泄露 | cross-tenant-tck |
| 输入验证 | SQL 注入/XSS/SSRF 全部防御 | audit-regression-gates |
| 依赖安全 | 零 P0/P1 CVE | npm audit / pip-audit |
| SSRF 防护 | 出站请求白名单校验 | audit-ssrf-surface |
| 演示残留 | 生产环境无 stub/mock 代码 | audit-demo-residue |

### 10.4 发布 Go/No-Go 门禁清单

| # | 检查项 | 类型 | 必须 |
|---|--------|------|:----:|
| 1 | 所有单元测试通过 (Python + TypeScript) | 自动 | ✅ |
| 2 | 契约测试套件全部通过 (contract-golden) | 自动 | ✅ |
| 3 | 状态机契约无漂移 (contract-state-machine) | 自动 | ✅ |
| 4 | 十条主线防回归门禁全通过 (audit-regression-gates) | 自动 | ✅ |
| 5 | Production Runtime Assembly 门禁通过 (production-smoke) | 自动 | ✅ |
| 6 | 跨租户 TCK 通过 (cross-tenant-tck) | 自动 | ✅ |
| 7 | 安全扫描零 P0/P1 (security + bandit) | 自动 | ✅ |
| 8 | 代码覆盖率达标 (行 ≥ 80%, 分支 ≥ 70%) | 自动 | ✅ |
| 9 | 数据库迁移链完整性 (migration-fresh-install-check) | 自动 | ✅ |
| 10 | Pilot 就绪检查通过 (pilot-readiness) | 自动 | ✅ |
| 11 | E2E 关键路径测试通过 | 手动+自动 | ✅ |
| 12 | 性能基准无退化 | 自动 | ✅ |
| 13 | 文档/CHANGELOG 更新 | 手动 | ✅ |
| 14 | 零 P0/P1 未关闭缺陷 | GitHub Issues | ✅ |
| 15 | Truth Manifest 单一事实源检查通过 (truth-check) | 自动 | ✅ |

---

## 11. 测试报告模板

### 11.1 报告格式

```markdown
# EWOH 测试报告

## 报告信息
- **版本**: v{x.y.z}
- **报告日期**: YYYY-MM-DD
- **测试周期**: YYYY-MM-DD ~ YYYY-MM-DD
- **报告人**: QA Engineer
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

**低覆盖率文件 Top 10**:
1. `path/to/file.py` — 行: XX% — 原因: ...

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

## 签字确认

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

*文档结束 — EWOH 全面测试方案 v1.0*
