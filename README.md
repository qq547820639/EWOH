# EWOH 工厂具身智能操作系统

**产品手册** · 版本 `0.6.0-rc4`

EWOH（Exoskeleton Worker Operation & Harmony）是面向制造现场的外骨骼人员作业协同与风险分析平台。它打通设备数据采集、实时推理、事件告警、任务调度、资源管理与多工厂复制，并提供边缘与云端双控制面。

本手册面向最终用户、部署运维人员与开发者，涵盖：产品概述、系统架构、安装部署、配置参数、API 接口、使用场景、FAQ、版本日志与贡献指南。

---

## 目录

1. [产品概述与核心功能](#一产品概述与核心功能)
2. [系统架构说明](#二系统架构说明)
3. [安装与部署指南](#三安装与部署指南)
4. [配置参数详解](#四配置参数详解)
5. [API 接口文档](#五api-接口文档)
6. [使用场景与操作示例](#六使用场景与操作示例)
7. [常见问题解答（FAQ）](#七常见问题解答faq)
8. [版本更新日志](#八版本更新日志)
9. [贡献指南](#九贡献指南)

## 仓库目录导航

| 目录/文件 | 说明 |
|-----------|------|
| `src/edge_platform/` | Python 边缘平台（采集/协议适配/推理/边缘调度/API） |
| `ewoh-spark-app/` | NestJS 后端 + React 前端（组织/业务/权限/调度 V2/控制台） |
| `ewoh-feishu-app/` | 飞书版轻量集成应用（Express + SQLite + 验签 webhook） |
| `contracts/` | 状态机、事件目录、工厂模板、Schema 与共享契约 |
| `openapi/` | OpenAPI 契约与路由清单 |
| `db/` | 迁移、回滚、Seed、验证与 Schema 清单 |
| `catalog/` | 工厂模板、场景包、连接器与字段映射资产目录 |
| `release/` | RC 发布包与校验和 |
| `deploy/` | Compose、Kubernetes、Helm 与云部署编排 |
| `docs/` | 活跃开发文档（API/部署/运维/验收/架构/整改 ADR） |
| `tests/` | 仓库级契约与验收测试 |
| `scripts/` | 门禁、审计、DDL、部署与发布脚本 |
| `tools/` | Work Graph、门禁引擎、资源注册、工厂复制等治理工具 |
| `security/` | 访问矩阵与安全基线 |
| `ui/command_map/` | 历史指挥地图静态原型（UX 参考，非生产事实源） |
| `delivery/` | 冻结交付包（不可当活跃源码） |
| `README.md` | 本文件（产品手册） |
| `CHANGELOG.md` | 变更日志 |
| `SECURITY.md` | 安全策略与平台安全边界声明 |
| `Makefile` | 常用命令入口 |
| `pyproject.toml` | Python 项目元数据与工具配置 |
| `version.json` | 当前发布版本 |

---

## 一、产品概述与核心功能

EWOH 定位为**只读监督、风险分析与受控工作流系统**：平台不参与设备实时安全控制，急停、限扭、关节实时控制、助力闭环等安全能力永久保留在设备控制器本地（详见 [SECURITY.md](SECURITY.md)）。

### 核心能力

| 能力域 | 说明 |
| ------ | ---- |
| **设备接入与采集** | 外骨骼（NY-EXO-A1 等）、环境传感器、摄像头结构化检测、MES/ERP 工单等多源数据接入；支持 Modbus、OPC UA、Sparkplug B、Webhook 等连接器与 TCK 契约测试。 |
| **实时推理与规则** | 滑动窗口特征提取、动作分类（stand/walk/bend/lift/carry/unknown）、疲劳/姿态风险规则、数据质量分级与 unknown 六路触发（低置信度/歧义/固件未验证/分布外/传感器缺失等）。 |
| **事件与告警** | 规则触发风险事件，含证据窗口、严重度分级（L1-L3）、处置闭环（确认/解决/升级）、事件因果链与审计。 |
| **智能调度（Scheduler V2）** | 世界状态快照 → 优先级 → 资格 → 路径 → 求解器 → 方案 → 人工审批 → 资源预约 → 派工 → SSE 实时推送；支持人工覆盖（锁定/排除/偏好/加急/调时）与局部重排。 |
| **数字世界与回放** | Current World State（人员/设备/工位实时位置与状态）、时间轴回放、事件上下文（前后快照）、从回放派生 Issue/Task/Evidence。 |
| **多租户与安全** | JWT 认证、基于角色的访问控制（RBAC）、组织树、PostgreSQL 行级安全（RLS）+ 请求级事务 GUC，数据库层强制组织隔离。 |
| **规模化工厂复制** | 工厂模板、连接器、场景包、字段映射资产目录；onboarding 检查、差异预览、影子运行、Fleet 升级/回滚。 |
| **工程治理** | 契约驱动状态机、OpenAPI 路由门禁、仓库事实源审计、Work Graph、门禁引擎、发布/安全门禁、SBOM。 |

### 运行时构成

仓库为多运行时单仓库：

```text
EWOH
├── src/edge_platform/      Python 边缘运行时（采集/推理/边缘调度/本地 API）
├── ewoh-spark-app/         NestJS 后端 + React 前端（主产品云侧）
├── ewoh-feishu-app/        飞书侧车应用（Express + SQLite + 验签 webhook）
├── contracts/ openapi/ db/ catalog/   跨运行时契约层
├── deploy/ docs/ scripts/ tools/      部署与工程治理
└── delivery/ release/     冻结交付包与发布快照（不参与运行时）
```

---

## 二、系统架构说明

### 2.1 总体架构

```text
┌────────────────────────────────────────────────────────────┐
│                        现场 / 边缘                          │
│  ┌──────────┐   ┌──────────────┐   ┌────────────────────┐ │
│  │ Physical │──▶│ Edge Runtime │──▶│ 本地 HTTP/SSE API  │ │
│  │ Device   │   │ 采集/推理/规则│   │ （离线可用）        │ │
│  └──────────┘   └──────┬───────┘   └────────────────────┘ │
└────────────────────────┼───────────────────────────────────┘
                         │ Edge Bridge（真机数据上行）
┌────────────────────────▼───────────────────────────────────┐
│                       云端 / 主产品                         │
│  ┌────────────┐  ┌────────────┐  ┌──────────────────────┐  │
│  │ React SPA  │─▶│ NestJS API │─▶│ PostgreSQL（RLS）    │  │
│  │ 指挥地图/   │  │ 认证/调度V2 │  │ 业务事实源            │  │
│  │ 工作台/控制台│  │ 世界/回放   │  └──────────────────────┘  │
│  └────────────┘  │ 治理/复制   │  ┌──────────────────────┐  │
│                  └──────┬─────┘  │ Redis（可选限流/缓存） │  │
└─────────────────────────┼────────┴──────────────────────┘  │
                          │
              ┌───────────▼───────────┐
              │  飞书侧车（消息/审批）  │
              └───────────────────────┘
```

### 2.2 关键链路

- **Web 请求链**：`React → Axios → AccessTokenGuard → OrgContextInterceptor → RequestDatabaseContext（请求级事务 + GUC）→ RLS → Service → DB`
- **实时设备数据链**：`Device → Edge Adapter → EventBus → 推理/规则 → World State → Cloud /api/ingest → Telemetry/Event → 指挥地图`
- **调度闭环**：`Task/Person/Device/Spatial → WorldStateSnapshot → Priority/Eligibility → RouteCost → Solver → Plan → Approve/Override → Reservation → Dispatch → Outbox/SSE`
- **世界回放**：`WorldState + Events + ScheduleTask + TaskStep + ResourceBinding → WorldService 时间归并 → Replay Timeline`

### 2.3 调度与求解器（当前事实）

- **Production Canonical Solver = `HeuristicSchedulingSolver`**（Scheduler V2，确定性贪心 + 多目标评分）。
- **CP-SAT 为 OPTIONAL / EXPERIMENTAL**：未部署 OR-Tools，不生产启用；不可用时 `solverStatus=UNAVAILABLE` 并显式回退 heuristic，绝不冒充 CP-SAT 成功。
- 每个正式方案均记录 `solverVersion / solverStatus / fallbackReason / snapshotVersion / policyVersion`。

---

## 三、安装与部署指南

### 3.1 环境要求

| 组件 | 要求 |
| ---- | ---- |
| Python | ≥ 3.9（Edge 运行时，零第三方运行时依赖） |
| Node.js | ≥ 20（云侧与前端构建） |
| PostgreSQL | ≥ 17（云侧业务事实源） |
| Docker | 可选（Compose/K8s 部署方式） |

### 3.2 Python 边缘平台（本地开发）

```bash
python -m pip install -r requirements-dev.txt   # 可选：ruff/bandit/pytest
python run.py                                   # 最简启动 → http://127.0.0.1:8765
```

运行模式由 `EWOH_RUNTIME_MODE` 控制（默认 `development`）：

| 模式 | 语义 |
| ---- | ---- |
| `development`（默认） | 装配真实组件；需要 stub 必须显式 `EWOH_ALLOW_STUB=1` 或 `--stub` |
| `production` | 只允许真实组件；任何装配错误 → ERROR + 非零退出，绝不静默回退 stub |
| `simulation` | 显式运行 Stub/Simulator（`make run-stub`，仅工程自测，不作为真机验收依据） |

```bash
EWOH_RUNTIME_MODE=production python run.py --db /data/ewoh/edge.db
```

### 3.3 云侧 Standalone（NestJS + React + PostgreSQL）

```bash
cd ewoh-spark-app
npm ci
npm run build:prod:standalone        # 构建 server + client
# 启动（需设置安全环境变量，见第四章）
EWOH_DEPLOY_TARGET=standalone \
  DATABASE_URL='postgresql://ewoh_api:...@host:5432/ewoh' \
  JWT_SECRET='<32+ 字符>' \
  INGEST_API_KEY='<key>' \
  node dist/server/main.js
```

### 3.4 Docker 部署（试点）

```bash
cd deploy/cloud
cp .env.compose.example .env          # 按现场填写（含必填密钥）
docker compose -f docker-compose.standalone.yml up -d
```

`migrate` 服务自动执行数据库迁移（`db/runner/run_migrations.js`）并运行 schema 验证；**不使用 `delivery/` 或 `release/` 中的 SQL 初始化数据库**。

### 3.5 数据库迁移

```bash
node db/runner/run_migrations.js --apply-standalone
node db/runner/run_migrations.js --verify-standalone
node db/runner/run_migrations.js --apply-standalone-users
node db/runner/run_migrations.js --apply-standalone-runtime-role
node db/runner/run_migrations.js --seed-standalone-admin
```

Schema 唯一事实源为 `db/migrations/standalone_*`；`server/database/schema.ts` 由 `npm run gen:db-schema` 从数据库反向生成。

---

## 四、配置参数详解

### 4.1 Python 边缘平台

| 变量 | 默认 | 说明 |
| ---- | ---- | ---- |
| `EWOH_RUNTIME_MODE` | `development` | 运行模式（development/production/simulation） |
| `EWOH_ALLOW_STUB` | 空 | development 下显式允许 stub |
| `EWOH_DB_PATH` | `demo.db` | SQLite 数据库路径 |
| `EWOH_HOST` / `EWOH_PORT` | `127.0.0.1` / `8765` | 监听地址与端口 |
| `EWOH_ADAPTER_PORTS` | `9001:real,9002:controlled_test,9003:simulated` | 适配器端口→数据源映射 |
| `EWOH_OFFLINE_AFTER_SEC` | `10` | 无遥测判定离线的秒数 |
| `EWOH_EVIDENCE_WINDOW_SEC` | `30` | 事件证据窗口（前后秒数） |
| `EWOH_DATA_RETENTION_DAYS` | `30` | 数据保留天数 |
| `EWOH_JWT_SECRET` | 空 | JWT 密钥（离线演示可空） |
| `EWOH_ARK_API_KEY` | 空 | 视觉理解 API Key（未配置则明确报错，不伪造） |
| `EWOH_CORS_ORIGINS` | 空 | 显式 CORS allowlist（逗号分隔）；未命中不回送 CORS 头 |

### 4.2 云侧 Standalone

| 变量 | 必填 | 说明 |
| ---- | ---- | ---- |
| `DATABASE_URL` | 是 | PostgreSQL 连接串；缺失 → 启动失败 |
| `JWT_SECRET` | 是 | JWT 密钥，**需 ≥32 字符**；不满足 → 启动失败 |
| `INGEST_API_KEY` | production 是 | Ingest 机器对机器鉴权；production 缺失 → 启动失败 + 请求 503（fail-closed） |
| `EWOH_DEPLOY_TARGET` | 否 | `standalone`（默认）；`EWOH_LEGACY_ENABLED=1` 才启用 legacy 入口 |
| `CORS_ORIGINS` | 否 | 前端跨域白名单；`*` 被禁止 |
| `TRUST_PROXY` | 否 | 反向代理跳数（`true` 被禁止，用数字或 CIDR） |
| `BODY_LIMIT` | `1mb` | 请求体上限 |
| `EWOH_DB_STATEMENT_TIMEOUT_MS` | `0` | SQL 语句超时（0=不设） |
| `CPSAT_WORKER_URL` | `http://127.0.0.1:8000` | CP-SAT worker 地址（当前未启用，heuristic 为 canonical） |

### 4.3 飞书侧车

| 变量 | 默认 | 说明 |
| ---- | ---- | ---- |
| `FEISHU_VERIFICATION_TOKEN` | 空 | webhook 验签；**缺失 → 写操作 fail-closed（拒绝）** |
| `FEISHU_SIMULATOR_ENABLED` | `false` | Simulator 默认关闭；production 开启需 `ALLOW_SIMULATOR_IN_PRODUCTION=true` 双开关 |
| `PORT` | `3000` | 服务端口 |
| `LARK_CLI` | `lark-cli` | lark-cli 可执行文件路径 |

---

## 五、API 接口文档

完整 OpenAPI 契约见 [openapi/ewoh.yaml](openapi/ewoh.yaml)（301 条路径，`node scripts/audit-openapi-routes.js` 保证与 NestJS 路由零漂移）。以下为主要端点速查。

### 5.1 Python Edge API（本地）

| 端点 | 说明 |
| ---- | ---- |
| `GET /api/status` | 平台状态、运行模式、来源标识、数据库计数 |
| `GET /api/devices` `/api/people` | 设备与人员列表（含在线/来源标识） |
| `GET /api/telemetry` `/api/telemetry/series` | 遥测最新帧与时间序列 |
| `GET /api/inference` `/api/inference/metrics` | 推理结果与延迟统计 |
| `GET /api/events` `/api/events/{id}` | 风险事件列表与详情 |
| `POST /api/event/status` `/api/events/{id}/comment` | 事件处置 |
| `POST /api/tasks/recommend` `/api/tasks/confirm` | 任务推荐与人工确认（deprecated，新路径走 Scheduler） |
| `POST /api/tasks` `/api/tasks/{id}` | 任务创建与乐观锁更新 |
| `POST /api/scheduling/requests` | 创建调度请求 |
| `GET /api/scheduling/plans` `/api/scheduling/plans/{id}` | 方案列表/详情 |
| `POST /api/scheduling/plans/{id}/confirm` `/execute` `/reject` `/replan` | 方案确认/派工/驳回/重排 |
| `POST /api/assignments/{id}/start` `/pause` `/complete` `/cancel` | 派工状态转换 |
| `GET /api/resources/state` | 统一资源状态投影 |
| `GET /api/command-map/stream` | SSE 实时事件流 |
| `GET /api/security/policy` | 安全策略（不暴露密钥） |
| `POST /api/auth/login` `/api/auth/refresh` | 登录与令牌刷新 |
| `GET /metrics` | Prometheus 指标 |

### 5.2 NestJS 云侧 API（节选）

| 端点 | 说明 |
| ---- | ---- |
| `POST /api/auth/login` `/api/auth/refresh` | 认证 |
| `GET /api/world/state` | 当前世界状态 |
| `GET /api/world/replay` `/api/world/replay/context/{eventId}` | 时间轴回放与事件上下文 |
| `POST /api/world/replay/items` | 从回放创建 Issue/Task/Evidence |
| `GET /api/spatial/entities` `/api/spatial/topology` | 空间实体与拓扑 |
| `POST /api/ingest/*` | 外骨骼/环境/摄像头/MES/空间扫描/定位接入（需 `X-Ingest-Key`） |
| `GET /api/dashboard/*` | 总览 KPI、设备、事件统计 |
| `POST /api/scheduler/runs` | 触发调度运行并生成方案 |
| `GET /api/scheduler/plans/{id}` | 方案详情（含 DecisionTrace） |
| `POST /api/scheduler/plans/{id}/approve` `/dispatch` `/reject` `/replan` | 审批/派工/驳回/重排 |
| `POST /api/scheduler/plans/{id}/overrides` | 人工覆盖（锁定/排除/偏好/加急/调时） |
| `GET /api/scheduler/conflicts` | 统一调度冲突 |
| `GET /api/scheduler/resources/state` | 资源状态权威投影（ResourceProjection SSOT） |
| `GET /api/scheduler/v2/stream` | SSE 调度事件流（Bearer 认证） |
| `GET /api/scheduler/policy` | 当前调度策略与配置 |
| `GET /api/audit` | 审计日志 |
| `GET /health/live` `/health/ready` | 存活与就绪（ready 校验数据库可达） |
| `GET /metrics` | Prometheus 指标 |

### 5.3 API 约定

- 认证：`Authorization: Bearer <token>`；Ingest 用 `X-Ingest-Key` + `X-Org-Id`。
- 错误响应统一：`{ "error": { "code", "message", "request_id" } }`（内部异常不进响应体）。
- 实时推送：Scheduler/CommandMap 使用 SSE（`text/event-stream`），带 `sequence` 去重、缺口检测→resync、断线重连（Last-Event-ID）与轮询兜底。

---

## 六、使用场景与操作示例

### 6.1 场景一：现场风险监控与处置

1. 设备接入后，边缘实时采集遥测并推理动作/负荷/疲劳。
2. 规则命中（如连续高负荷、姿态异常、低电量）→ 生成风险事件（含证据窗口）。
3. 指挥地图事件中心展示 L1-L3 事件；值班员**确认 / 解决 / 升级**。
4. 飞书侧车推送卡片消息，可通过卡片按钮处置；处置动作写审计。

### 6.2 场景二：智能调度闭环

```bash
# 1. 创建任务
curl -X POST http://localhost:3000/api/tasks -H 'Authorization: Bearer <token>' \
  -H 'Content-Type: application/json' \
  -d '{"title":"搬运任务A","requiredSkills":["搬运"],"priority":5}'

# 2. 触发调度运行（生成方案）
curl -X POST http://localhost:3000/api/scheduler/runs -H 'Authorization: Bearer <token>' \
  -H 'Content-Type: application/json' -d '{"trigger":"MANUAL"}'

# 3. 查看方案（含 solverUsed / DecisionTrace）
curl http://localhost:3000/api/scheduler/plans/<planId> -H 'Authorization: Bearer <token>'

# 4. 审批（携带 version + snapshotVersion，过期拒绝 PLAN_STALE）
curl -X POST http://localhost:3000/api/scheduler/plans/<planId>/approve \
  -H 'Authorization: Bearer <token>' -H 'Content-Type: application/json' \
  -d '{"version":1,"snapshotVersion":"WS-20260808-0001","reason":"确认"}'

# 5. 派工（CAS 防重复下发）
curl -X POST http://localhost:3000/api/scheduler/plans/<planId>/dispatch \
  -H 'Authorization: Bearer <token>'
```

### 6.3 场景三：人工覆盖与重排

通过 `POST /api/scheduler/plans/{id}/overrides` 提交 `LOCK_PERSON / LOCK_DEVICE / LOCK_TIME / EXCLUDE_RESOURCE / PREFER_RESOURCE / BOOST` 等动作 → 转换为调度约束 → 触发重排 → 返回 before/after 差异。**SAFETY_BLOCK 无法被任何覆盖动作绕过**（求解器硬约束）。

### 6.4 场景四：事件回溯与证据

- `GET /api/world/replay` 获取指定时段时间轴；
- `GET /api/world/replay/context/{eventId}` 获取事件前/中/后快照；
- `POST /api/world/replay/items` 从回放创建跟进 Issue/Task/Evidence（写入事件因果链，`sourceType=replayed`）。

---

## 七、常见问题解答（FAQ）

**Q1：Edge 启动提示"真实模块未就绪"并进入 stub？**
当前代码已移除隐式 stub 回退。`EWOH_RUNTIME_MODE=production` 下任何装配失败都会非零退出；development 下需要 stub 必须显式 `EWOH_ALLOW_STUB=1` 或 `--stub`。请检查数据库路径与权限。

**Q2：`/health/ready` 返回 503？**
就绪探针校验 PostgreSQL 可达。请检查数据库连接（`DATABASE_URL`）与迁移状态。

**Q3：Ingest 请求返回 401/503？**
`INGEST_API_KEY` 在 production 为必填（缺失→启动失败+503）；请求需携带 `X-Ingest-Key` 与 `X-Org-Id`。

**Q4：审批方案返回 409 PLAN_STALE？**
方案基于的世界状态已变化（任务/资源/预约变更导致 `snapshotVersion` 过期）。请重新触发调度运行生成新方案，再审批。

**Q5：CP-SAT 求解器是否已启用？**
当前 Production Canonical Solver 为 Heuristic；CP-SAT 为 OPTIONAL/EXPERIMENTAL（未部署 OR-Tools）。所有方案如实标记 `solverStatus`，回退时不会冒充 CP-SAT。

**Q6：前端世界状态与调度不同步？**
世界状态轮询（2s）+ 调度 SSE 双通道。SSE 带 sequence 去重与缺口重同步，断线自动切轮询并恢复实时；短暂不一致属 eventual consistency，有 version/freshness 机制解释。

**Q7：如何重置演示数据？**
Edge 提供 `POST /api/reset`（清空 simulated/controlled_test 数据）。生产环境请勿使用；数据恢复见备份/恢复。

**Q8：Feishu webhook 被拒绝？**
请确保 `FEISHU_VERIFICATION_TOKEN` 配置一致；未配置时写操作 fail-closed（拒绝）。生产禁止 Simulator（需双开关）。

**Q9：飞书侧车依赖 lark-cli 吗？**
是。`feishu.js` 通过 `lark-cli` 子进程调用飞书 OpenAPI；生产部署需安装并配置 `LARK_CLI`。

**Q10：数据库 schema 的事实源是谁？**
`db/migrations/standalone_*.sql` 为唯一权威源；`schema.ts` 由数据库反向生成。生产部署不引用 `delivery/` / `release/` 中的 SQL。

---

## 八、版本更新日志

完整变更见 [CHANGELOG.md](CHANGELOG.md)。当前发布候选 **`0.6.0-rc4`**（见 [version.json](version.json)）。

| 版本 | 关键内容 |
| ---- | -------- |
| `0.6.0-rc4` | 当前候选：Edge 生产装配 fail-fast、EventBus 统一、Feishu 验签/Simulator 默认关、Ingest fail-closed、Scheduler V2 收敛、World State DB 侧查询、Contract 驱动状态机、CommandMap V2 写链、资源状态 SSOT、安全错误脱敏 |
| `0.6.0-rc1/2/3` | Standalone 云侧、RLS 多租户、Work Orchestration、规模化工厂复制逐步落地 |
| `V0.5` | 演示原型（已由 `src/edge_platform` 取代，冻结于 `delivery/06_Demo_Prototype`） |

---

## 九、贡献指南

### 9.1 开发流程

1. **分支**：从 `main` 新建功能分支 `feat/<name>` 或 `fix/<name>`；提交信息采用 `type(scope): 描述`（如 `fix(edge): ...`、`refactor(scheduler): ...`）。
2. **本地验证（必须全绿）**：
   ```bash
   make test                 # Python unittest
   make test-contract        # 契约测试
   make production-smoke     # Production 真实装配门禁
   make contract-state-machine  # 契约状态机一致性
   cd ewoh-spark-app && npm run type:check && npm test -- --runInBand && npm run test:client
   node scripts/audit-openapi-routes.js   # OpenAPI 路由零漂移
   ```
3. **契约优先**：新增/修改 API 必须同步更新 `openapi/ewoh.yaml`（`cd ewoh-spark-app && npm run gen:openapi`）；状态机改动必须更新 `contracts/state-machines/*.yaml` 并保持 Python 模型一致。
4. **安全**：新增写端点默认受鉴权与组织隔离；Ingest 需 `X-Ingest-Key`；不得在日志/响应中输出密钥。
5. **提交**：逻辑小批次提交；CI（`.github/workflows/`）会运行测试、静态检查、契约、事实源审计、性能与安全门禁。

### 9.2 文档约定

- 架构决策：新增/变更跨模块设计请写入 `docs/architecture/adr-*.md`。
- 运维变更：更新 `docs/operations/production-runbook.md`。
- 验收记录：见 `docs/acceptance/` 与 `docs/remediation/`。

### 9.3 安全报告

发现安全问题请遵循 [SECURITY.md](SECURITY.md) 的披露流程；请勿在公开 Issue 中提交敏感凭据。

---

## 附录

- **安全边界声明**：[SECURITY.md](SECURITY.md)
- **运维手册**：[docs/operations/production-runbook.md](docs/operations/production-runbook.md)
- **架构审计与整改记录**：`docs/audit/`、`docs/remediation/`、`docs/architecture/`
- **验收判定**：`docs/acceptance/`
- **交付包校验**：`cd delivery && sha256sum -c 00_交付总览/SHA256SUMS.txt`
