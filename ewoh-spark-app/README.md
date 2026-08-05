# EWOH Spark App（NestJS 后端 + React 前端）

EWOH（工厂具身智能操作系统）的应用层。本目录承载 **NestJS 后端** 与 **React 前端**，
提供组织/业务/权限/控制/控制台等业务能力，与仓库中的 Python 边缘平台
（`../src/edge_platform/`）、PostgreSQL 数据库、文件化多 Agent 编排控制台
（`../tools/`、`../.codex/artifacts/`）共同构成完整系统。

当前发布候选版本：`0.6.0-rc4`。

> 本仓库为**受控试点（V0.6）**，处于 `candidate-for-production (approval-gated)` 阶段。
> 生产 DDL/部署、凭证/权限变更、不可逆数据操作、真实 GitHub issue/PR 创建等
> 均需人工审批，详见 `../docs/delivery/release-manifest.yaml`。

---

## 1. 架构概览

```
浏览器 (React SPA, Vite)
      │  HTTPS /api/*
      ▼
NestJS 服务 (server/)
      │  Drizzle ORM (postgres-js) 查询 + 事务
      ▼
PostgreSQL 17 (ewoh_* 表, RLS 行级安全, 审计链)
```

- **后端 `server/`**：NestJS 模块化服务，暴露 `/api/*`，包含组织、人员、设备、
  MES 工单/步骤/质检、安灯/OEE、ERP 连接器、工作编排控制面、领域持久化、
  审计、世界状态/回放等模块。
- **前端 `client/`**：React 19 + Vite + React Query + TailwindCSS 4，含
  `/login`、命令中心、命令地图、移动工作台、工作编排 DAG、缩放控制台等页面。
- **契约 `../openapi/`、`../contracts/`**：OpenAPI 契约与路由清单、状态机、
  事件目录、Schema，与运行时严格对齐（`audit-openapi-routes.js --strict`）。
- **领域持久化 `server/modules/.../domain-persistence`**：六类领域事实
  （资源锁/交接/Git 同步/证据元数据/工厂复制会话/幂等键）以数据库为事实源，
  事务 + 唯一约束 + 乐观锁保证多实例正确性。

## 2. 环境要求

| 依赖     | 版本要求                          | 用途                 |
|----------|-----------------------------------|----------------------|
| Node.js  | `>=22.0.0`（见 `engines`）        | 运行/构建             |
| npm      | `>=10.0.0`                        | 依赖管理             |
| PostgreSQL | 17（推荐）                       | 持久化（迁移/RLS/审计） |
| Playwright | 浏览器测试（随 devDependencies 安装） | `test:browser`      |

Redis 可选（有内存回退），文件存储本地磁盘或 S3 兼容对象存储，均通过环境变量开关。

## 3. 快速开始

### 3.1 安装依赖

```bash
cd ewoh-spark-app
npm install
```

### 3.2 开发模式

```bash
npm run dev            # 并行启动后端 dev:server 与前端 dev:client（见 scripts/dev.sh）
# 或分别启动：
npm run dev:server     # NODE_ENV=development nest start --watch
npm run dev:client     # NODE_ENV=development vite --config vite.config.ts
```

本地开发默认使用内存/降级数据源即可跑通大部分功能；要连真实 PostgreSQL，见 §5。

### 3.3 生产构建与启动

```bash
npm run build:prod              # 构建 server + client
NODE_ENV=production node main.js                    # 常规产物
# 或 standalone 目标（无外部 CDN，含 PWA）：
npm run build:prod:standalone
NODE_ENV=production EWOH_DEPLOY_TARGET=standalone node dist/server/main.js
```

部署编排（Compose / Kubernetes / Helm）位于 `../deploy/cloud/`，Helm 校验：
`npm run verify:helm`。

## 4. 运行测试

| 命令                         | 说明                                                       |
|------------------------------|------------------------------------------------------------|
| `npm test`                   | Jest 单元测试（server + 部分 test/）                        |
| `npm run test:client`        | 前端 Jest（`client/jest.config.cjs`）                       |
| `npm run test:browser`       | Playwright 浏览器端到端（`playwright.config.ts`）           |
| `npm run test:browser:visual`| Playwright 视觉回归（`playwright.visual.config.ts`）        |
| `npm run test:e2e`           | HTTP + PostgreSQL 端到端（需真实 DB，见 §5）                |
| `npm run test:watch`         | 监视模式                                                   |
| `npm run type:check`         | 前后端 `tsc --noEmit`                                       |
| `npm run lint`               | ESLint + Stylelint                                         |
| `npm run e2e:check`          | 运行 `../scripts/e2e-check.sh` 门禁                        |

仓库级门禁（含 Python 平台、契约、工作图一致性）统一由
`../scripts/standalone-check.sh` 驱动；单一事实源语义一致性由
`node ../scripts/audit-repo-facts.js --strict` 执行。

## 5. 连接真实 PostgreSQL

需要真实 PostgreSQL 17 时，通过环境变量提供连接串（**不要**把凭据提交到仓库）：

| 变量                              | 用途                                            |
|-----------------------------------|-------------------------------------------------|
| `EWOH_DATABASE_URL`               | 迁移/DDL/安全校验所用的 owner 连接串             |
| `EWOH_RUNTIME_DATABASE_URL`       | 运行时应用连接串（非 owner 角色）               |
| `EWOH_E2E_RUNTIME_DATABASE_URL`   | E2E 测试运行时连接串（与 `EWOH_RUNTIME_DATABASE_URL` 二选一） |
| `EWOH_API_DATABASE_PASSWORD`      | 应用 DB 角色密码（postgres-check 必需）          |
| `EWOH_BOOTSTRAP_ADMIN_USERNAME` / `EWOH_BOOTSTRAP_ADMIN_PASSWORD` | 初始化管理员      |
| `EWOH_DB_STATEMENT_TIMEOUT_MS`    | 语句超时（默认 0，standalone 模板 30000）        |
| `EWOH_DB_SLOW_THRESHOLD_MS`       | 慢查询记录阈值（默认 1000ms）                    |
| `EWOH_ALLOW_DDL` / `EWOH_ALLOW_DESTRUCTIVE_ROLLBACK` | 迁移/回滚开关（本地校验脚本置 1） |

### 独立脚本（位于 `../scripts/`）

```bash
# 完整 PostgreSQL 门禁：迁移/回滚/RLS/审计/重建（需 owner 连接）
EWOH_DATABASE_URL=... EWOH_RUNTIME_DATABASE_URL=... \
EWOH_API_DATABASE_PASSWORD=... \
EWOH_BOOTSTRAP_ADMIN_USERNAME=... EWOH_BOOTSTRAP_ADMIN_PASSWORD=... \
bash ../scripts/standalone-postgres-check.sh

# F61-02 双实例域并发校验（锁 CAS / 交接 / 幂等键）
EWOH_DATABASE_URL=... node ../scripts/verify-domain-concurrency.js
```

> 说明：`verify-domain-concurrency.js` 从本应用的 `package.json`（`postgres` 依赖）
> 解析驱动，因此须在本目录已安装依赖的前提下，从仓库根或脚本目录运行。

## 6. 浏览器测试（Playwright）

```bash
npm run test:browser              # 核心浏览器套件（登录/命令中心/命令地图/移动工作台/告警）
npm run test:browser:visual       # 视觉回归
npm run test:browser:ux009        # 仅运行 UX-009 用例
```

Playwright 会安装 Chromium；CI（`../.github/workflows/standalone.yml`）在
PostgreSQL Service Container 上执行浏览器套件。首次运行若提示缺少浏览器，执行
`npx playwright install chromium`。

## 7. 常见失败与排查

- **`EWOH_E2E_RUNTIME_DATABASE_URL` 不可用导致 E2E/域持久化用例失败**：
  这些用例需要真实 PostgreSQL，刻意不伪造、不静默跳过。本地无 PG 时属
  `BLOCKED_BY_ENVIRONMENT`，请提供连接串或依赖 CI。
- **`audit-repo-facts.js --strict` 报 `head-consistency`**：声明 HEAD 与
  实际 git HEAD 不一致，属预期；提交后更新 `.codex/artifacts/phase-state.md`
  声明的 HEAD 即可。
- **迁移/DDL 失败**：确认 `EWOH_DATABASE_URL` 为 owner 连接、`EWOH_ALLOW_DDL=1`。
- **`npm run type:check` 报错**：先 `npm install`；确认 Node ≥ 22。
- **浏览器套件启动失败**：`npx playwright install chromium`，并确认服务已起、
  `PUBLIC_BASE_URL`/`CORS_ORIGINS` 配置正确。
- **`standalone-postgres-check.sh` 报变量缺失**：五个必需变量缺一即退出，
  见 §5 表。

## 8. 安全边界

本应用是**只读监督/编排控制面**，明确定义以下安全边界，请勿逾越：

- **只读监督**：工作编排默认 `EWOH_WORK_WRITABLE=false`，写操作（如
  `POST /api/work/git-sync/apply`）在未显式开启写入门禁时一律返回 400；真实
  GitHub issue/PR 创建还需 `EWOH_GIT_SYNC_ENABLED` + `GITHUB_TOKEN` +
  `EWOH_GIT_SYNC_APPROVED`。
- **不控制设备安全**：本平台下达的是**受控指令/交接**，不承担设备物理安全
  控制职责；控制命令拒绝向终态回路重复发送/接收，交接遵循严格状态机。
- **不伪造实时数据**：数据来源词汇为 `real / controlled_test / simulated /
  replayed / stale / offline`，界面以 `DataSourceBadge` 标注来源；模拟/回放
  数据绝不冒充真实设备实时数据。
- **组织隔离（RLS）**：所有业务表启用 PostgreSQL 行级安全（RLS），
  `ewoh_find_org` / `ewoh_find_org_children` 以 `SECURITY DEFINER` 解析组织范围，
  跨组织读写被隔离；交叉租户由 `../scripts/cross-tenant-tck.sh` 验证。
- **RBAC**：`@Roles` 守卫 + 路由级授权，`worker` 等角色读写路径 fail-closed，
  敏感字段（如 `/api/personnel/:id/sensitive`）掩码。
- **审计**：`ewoh_append_audit_log` 统一落审计链，`requestId` 与 Tracing
  `x-trace-id` 关联，`GET /api/audit` 分页/过滤；关键写路径均记审计。
- **状态机**：任务/资源/交接/门禁等所有状态迁移走严格状态机契约，拒绝非法转移，
  幂等重放安全。
- **幂等性**：`ewoh_idempotency_keys` + 唯一约束 + 乐观锁（`version` CAS）保证
  重复请求/多实例并发不产生重复副作用；规模升级/回滚、场景安装/卸载、
  工厂差异解决等均幂等。
- **事务边界**：多实体写操作放入显式 `db.transaction`，中途失败无部分写入；
  嵌套事务复用当前事务，避免调度器嵌套根事务。

## 9. 相关链接

- 仓库总览与环境：`../README.md`
- 变更日志：`../CHANGELOG.md`
- 发布清单（含门禁与待批项）：`../docs/delivery/release-manifest.yaml`
- 部署编排：`../deploy/cloud/`
- 数据库迁移/验证：`../db/`
- 工作编排控制台工具：`../tools/work-console/`、`../tools/work-indexer/`