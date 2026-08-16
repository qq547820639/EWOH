# ADR-038：Shadow Plan 隔离 DB 纵深防御（standalone_048，§13 收口）

- 状态：Accepted
- 日期：2026-08-16
- 关联：ADR-025（SimulationRun 三层隔离）、§13（生产/仿真隔离红线）、
  §20（可靠性）、ADR-020 影子策略（standalone_020 policy lifecycle）

## 背景

simulation-production-isolation 能力在 Round 45 已闭合 SimulationRun
路径的三层强制（契约 isSimulation=true + standalone_044 表级 CHECK +
服务层唯一写路径），但 legacy shadow-plan 路径（ewoh_schedule_plan.
is_shadow=true：CP-SAT 对比 / 影子策略评估）只有两层：服务端 hard
guard（plan.service 对 shadow 行拒绝 approve/dispatch/reserve）+
is_shadow DB 标识。若服务层被绕过（SQL 直写/未来代码路径遗漏），
shadow 方案可被置为生产状态——§13「模拟数据绝不能被生产 World
State 当成真实数据」缺数据库最后一层兜底。

## 决策

### 决策 1：表级 CHECK 兜底（服务层之外的第三层）

`chk_ewoh_schedule_plan_shadow_not_production`：
```
CHECK (
  is_shadow = false
  OR (
    status NOT IN ('approved','dispatched','executing','completed','confirmed','proposed')
    AND confirmed_by IS NULL
    AND confirmed_at IS NULL
  )
)
```
- 状态排除集 = V2 生产状态（approved/dispatched/executing/completed）
  ∪ 遗留生产面（confirmed/proposed——scheduler-plan-application 与
  gamification resource_alloc 仍在写）；shadow 行允许
  shadow/draft/rejected/superseded（非生产状态）；
- 确认事实（confirmed_by/confirmed_at）对 shadow 行禁止——approve
  是生产执行链的门，确认事实不得落在 shadow 行；
- 与既有写路径兼容：shadow plan 由求解器以 status='shadow' 落库后
  置 is_shadow=true（无冲突）；生产 approve 走非 shadow 行。

### 决策 2：原地加固，无新表

既有表 ALTER ADD CONSTRAINT（DROP IF EXISTS 幂等可重入）——
managed_count/physical_create_count 不变（72/75），001_verify /
standalone_001_verify 期望列表不变（表早已计数，NO-07b 知识条目
原地加固同模式）。

### 决策 3：verify 自证（5 拒绝 + 2 控制组）

standalone_048 verify：约束存在断言 + DO 块 EXCEPTION 自证——
shadow+approved / shadow+dispatched / shadow+confirmed（遗留）/
shadow+confirmed_by / shadow+confirmed_at 必须被 CHECK 拒绝；
控制组 shadow+status='shadow'（无确认事实）与非 shadow+approved+
确认事实必须可写（随后删除，不落脏数据）。

## 后果

- 正：simulation-production-isolation 按 §36 升 Implemented
  （服务层 guard + DB 标识 + DB CHECK 三层；矩阵 47/8/0/1）；
  §13 隔离红线的数据库兜底不再依赖服务层正确性。
- 负：生产状态排除集需与状态词表演进同步（新生产状态加入时需
  同步扩 CHECK——已在约束 COMMENT 注明语义）。
- 无破坏性变更：约束只拒绝「shadow 行进生产链」这一非法态，
  对既有合法写路径零影响（CI 成对 apply/verify/rollback/re-apply 实证）。
