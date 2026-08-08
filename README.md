# EWOH 工厂具身智能操作系统

外骨骼人员作业协同、设备/安灯/ERP 业务闭环与规模化工厂复制平台。
仓库由 Python 边缘平台、NestJS 后端、React 客户端、PostgreSQL 数据库与
文件化多 Agent 编排控制台组成；发布候选为 `0.6.0-rc4`。

本仓库是一套**多运行时、契约驱动**的工业软件单仓库：

```text
EWOH
├── src/edge_platform/    Python 边缘运行时（采集/推理/边缘调度/本地 API）
├── ewoh-spark-app/       NestJS 后端 + React 前端（主产品云侧）
├── ewoh-feishu-app/      飞书侧车应用（Express + SQLite）
├── contracts/            跨运行时契约（状态机/事件/工厂/Schema）
├── openapi/              HTTP API 契约与路由清单
├── db/                   数据库迁移/回滚/Seed/验证/Schema 清单
├── catalog/              工厂模板/场景/连接器/映射资产
├── deploy/               Docker/Compose/K8s/Helm 部署编排
├── docs/                 活跃开发文档（API/部署/运维/验收/架构/整改）
├── scripts/ tools/       工程治理（门禁/审计/发布/Work Graph）
├── tests/                仓库级契约与验收测试
├── security/             安全基线与访问矩阵
├── ui/command_map/       历史指挥地图原型（UX 参考，非生产事实源）
├── delivery/             冻结交付包（不可当活跃源码）
└── release/              RC 发布快照与校验和
```

## 顶层目录

| 目录/文件                  | 说明                                                          |
|----------------------------|---------------------------------------------------------------|
| `src/edge_platform/`       | Python 边缘平台（采集/协议适配/推理/边缘调度/API）            |
| `ewoh-spark-app/`          | NestJS 后端 + React 前端（组织/业务/权限/调度 V2/控制台）     |
| `ewoh-feishu-app/`         | 飞书版轻量集成应用（Express + SQLite + 验签 webhook）         |
| `contracts/`               | 状态机、事件目录、工厂模板、Schema 与共享契约                 |
| `openapi/`                 | OpenAPI 契约与路由清单（`ewoh.yaml`、`work-orchestration.yaml`）|
| `db/`                      | 迁移、回滚、Seed、验证与 Schema 清单                          |
| `catalog/`                 | 工厂模板、场景包、连接器与字段映射资产目录                    |
| `release/`                 | RC 发布包（README、变更日志、安全声明与校验和）               |
| `deploy/`                  | Compose、Kubernetes、Helm 与云部署编排                        |
| `docs/`                    | 活跃开发文档（API/部署/运维/验收/架构/整改 ADR）              |
| `tests/`                   | 仓库级契约与验收测试                                          |
| `scripts/`                 | 门禁、审计、DDL、部署与发布脚本                               |
| `tools/`                   | Work Graph、门禁引擎、资源注册、工厂复制等治理工具            |
| `security/`                | 访问矩阵与安全基线                                            |
| `ui/command_map/`          | 历史指挥地图静态原型（UX 参考，生产前端为 React 实现）        |
| `README.md`                | 本文件（仓库导航）                                            |
| `CHANGELOG.md`             | 变更日志                                                      |
| `SECURITY.md`              | 安全策略与平台安全边界声明                                    |
| `Makefile`                 | 常用命令入口（run/test/门禁/安全/format/clean）              |
| `pyproject.toml`           | Python 项目元数据与工具配置（src 布局）                       |
| `version.json`             | 当前发布版本（`0.6.0-rc4`）                                  |

## 一站式质量门禁

```bash
bash scripts/standalone-check.sh    # 类型/静态检查/Jest/OpenAPI/契约/DDL 计划
make production-smoke               # Python Production 真实装配门禁（真实组件 + no-stub + Bus 契约）
make contract-state-machine         # 契约状态机一致性（Python models vs contracts/state-machines）
bash scripts/pilot-readiness-check.sh
make truth-check                    # 单一事实源证据清单（无漂移，P0 门禁）
node scripts/audit-repo-facts.js --strict
node tools/work-indexer/index.js --root . --invariants
node tools/work-console/index.js --root . --output output/work-console.json --strict
```

仓库事实源一致性（README 导航、CHANGELOG、发布清单、Task Board、门禁、
OpenAPI 路由清单、数据来源词汇与错误契约）由
`scripts/audit-repo-facts.js` 自动校验，发现漂移时门禁失败。

## 快速开始（开发环境）

### Python 边缘平台

```bash
python -m pip install -r requirements-dev.txt   # 可选：ruff/bandit/pytest
python run.py                                   # 最简启动，访问 http://127.0.0.1:8765
make run                                        # 等价方式
make test                                       # unittest 测试套件
make test-contract                              # 契约测试（pytest）
make production-smoke                           # Production 真实装配门禁
make lint                                       # ruff 静态检查
```

代码采用 `src/` 布局，运行模式由 `EWOH_RUNTIME_MODE` 控制（默认 `development`）：

- **development（默认）**：装配真实组件；需要 stub 必须显式 `EWOH_ALLOW_STUB=1` 或 `--stub`。
- **production**：只允许真实组件；任何真实组件装配错误都会 `log ERROR + 非零退出`，
  绝不静默回退 stub（`make production-smoke` 在 CI 强制校验）。
- **simulation**：显式运行 Stub/Simulator（`make run-stub`，仅工程自测，不作为真机验收依据）。

> 注意：`python -m edge_platform.run` 需先设置 `PYTHONPATH=src`；根目录 `run.py` 免去这一步。

### Standalone 云产品（NestJS + React + PostgreSQL）

```bash
cd ewoh-spark-app
npm ci
npm run type:check
npm run lint
npm test -- --runInBand
npm run test:client
npm run build:prod:standalone
```

带真实 PostgreSQL 环境的完整门禁：

```bash
EWOH_E2E_RUNTIME_DATABASE_URL='postgresql://ewoh_api:...@127.0.0.1:55432/postgres' \
  bash ../scripts/standalone-check.sh
```

认证浏览器流程（Playwright）：

```bash
EWOH_E2E_RUNTIME_DATABASE_URL='postgresql://ewoh_api:...@127.0.0.1:55432/postgres' \
  npm run test:browser
```

### 关键环境变量（安全相关）

| 变量 | 作用 | 缺失时行为 |
| ---- | ---- | ---------- |
| `EWOH_RUNTIME_MODE` | Edge 运行模式（development/production/simulation） | development（默认真实组件） |
| `EWOH_ALLOW_STUB` | development 下显式允许 stub | 关闭（真实装配失败抛错） |
| `INGEST_API_KEY` | Ingest 机器对机器鉴权 | **production 启动失败 + 请求 503（fail-closed）** |
| `JWT_SECRET` | Standalone JWT 密钥 | **启动失败（需 ≥32 字符）** |
| `DATABASE_URL` | Standalone PostgreSQL 连接 | **启动失败（fail-closed）** |
| `EWOH_CORS_ORIGINS` | Edge HTTP CORS 显式 allowlist | 不回送 CORS 头（同源阻止） |
| `FEISHU_VERIFICATION_TOKEN` | Feishu webhook 验签 | **webhook 写操作 fail-closed** |
| `FEISHU_SIMULATOR_ENABLED` | Feishu simulator 开关 | 默认 `false`；production 开启需双开关 |

## 调度与求解器

- **Production Canonical Solver = `HeuristicSchedulingSolver`**（Scheduler V2）。
- CP-SAT 为 **OPTIONAL / EXPERIMENTAL**（未部署 OR-Tools，不生产启用）；
  solver 元数据（`solverUsed` / `solverStatus` / `fallbackReason`）如实上报，绝不冒充。
- 调度闭环：`World State → Snapshot → Priority → Eligibility → Route → Solver →
  Plan → Approve/Override → Reservation → Dispatch → Outbox/SSE`。

## 试点部署

```bash
cd deploy/cloud
cp .env.compose.example .env   # 按现场填写（含必填密钥）
docker compose -f docker-compose.standalone.yml up -d
```

迁移由 `migrate` 服务自动执行（`db/runner/run_migrations.js`），
**不使用 `delivery/` 或 `release/` 中的 SQL**。详见 `docs/deployment/README.md`。

## 安全边界

EWOH 是只读监督与风险分析平台，**不参与设备实时安全控制**。急停、限扭、关节实时控制、
助力闭环等能力永久保留在设备控制器本地。详见 `SECURITY.md`。

## 生产化整改与验收记录

- `docs/audit/` — 全仓架构审计报告
- `docs/remediation/` — P0/P1 生产化整改 + 第二轮架构收敛（含 ADR）
- `docs/acceptance/` — 准生产验收与 Go/No-Go 判定
- `docs/operations/production-runbook.md` — 生产运维手册
- `docs/architecture/adr-*.md` — 架构决策记录（MES→V2、Scheduler/Ingest 拆分等）

## 交付包校验

V1.0 冻结交付包位于 `delivery/`，校验清单见 `delivery/00_交付总览/SHA256SUMS.txt`：

```bash
cd delivery
sha256sum -c 00_交付总览/SHA256SUMS.txt
```
