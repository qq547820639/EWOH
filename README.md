# EWOH 工厂具身智能操作系统

外骨骼人员作业协同、设备/安灯/ERP 业务闭环与规模化工厂复制平台。
仓库由 Python 边缘平台、NestJS 后端、React 客户端、PostgreSQL 数据库与
文件化多 Agent 编排控制台组成；发布候选为 `0.6.0-rc4`。

本仓库分为两层：

- **`delivery/`** — V1.0 一次性交付包（冻结）。包含开发基线、技术规范、数据与算法、
  安全合规、测试验收、V0.5 演示原型、场景评估、商务谈判与源文件，附 SHA256 校验清单。
  进入 `delivery/` 后按 `delivery/00_交付总览/README.md` 使用。
- **`src/edge_platform/`** — V0.6 受控试点系统（活跃开发）。已取代 `delivery/06_Demo_Prototype`
  中的 V0.5 原型。

## 顶层目录

| 目录/文件                  | 说明                                                          |
|----------------------------|---------------------------------------------------------------|
| `delivery/`                | V1.0 冻结交付包（`00_`~`09_` + 项目执行总控台）              |
| `src/edge_platform/`       | Python 边缘平台（采集/协议适配/推理/边缘自治/API）            |
| `ewoh-spark-app/`          | NestJS 后端 + React 前端（组织/业务/权限/控制/控制台）        |
| `contracts/`               | 状态机、事件目录、工厂模板、Schema 与共享契约                 |
| `openapi/`                 | OpenAPI 契约与路由清单（`ewoh.yaml`、`work-orchestration.yaml`）|
| `db/`                      | 迁移、回滚、Seed、验证与 Schema 清单                          |
| `catalog/`                 | 工厂模板、场景包、连接器与字段映射资产目录                    |
| `release/`                 | RC 发布包（README、变更日志、安全声明与校验和）               |
| `deploy/`                  | Compose、Kubernetes、Helm 与云部署编排                        |
| `docs/`                    | 活跃开发文档（API/部署/运维/验收/架构）                       |
| `tests/`                   | 仓库级契约与验收测试                                          |
| `scripts/`                 | 门禁、审计、DDL、部署与发布脚本                               |
| `tools/`                   | Work Graph、门禁引擎、资源注册、工厂复制等治理工具            |
| `security/`                | 访问矩阵与安全基线                                            |
| `README.md`                | 本文件（仓库导航）                                            |
| `CHANGELOG.md`             | 变更日志                                                      |
| `SECURITY.md`              | 安全策略与平台安全边界声明                                    |
| `Makefile`                 | 常用命令入口（run/test/lint/security/format/clean）          |
| `pyproject.toml`           | Python 项目元数据与工具配置（src 布局）                       |

## 一站式质量门禁

```bash
bash scripts/standalone-check.sh    # 类型/静态检查/Jest/OpenAPI/契约/DDL 计划
bash scripts/pilot-readiness-check.sh
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
python run.py     # 最简启动：无需 make/PYTHONPATH，访问 http://127.0.0.1:8765
make run          # 等价方式（真实模块缺失时回退 stub）
make test         # unittest 测试套件
make lint         # ruff 静态检查
```

代码采用 `src/` 布局。`python run.py` 与 `make run`（等价于 `PYTHONPATH=src python -m edge_platform.run`）
都会在真实模块未就绪时自动回退 stub 模式。注意：直接 `python -m edge_platform.run` 需先设置
`PYTHONPATH=src`，否则找不到包；用根目录 `run.py` 可免去这一步。

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

## 发布候选

`release/ewoh-0.6.0-rc4` 包含 Standalone 源码、数据库迁移、部署工件、契约、
Work Orchestration 工具/目录、交付文档与校验和：

```bash
cd release/ewoh-0.6.0-rc4
shasum -a 256 -c SHA256SUMS.txt
```

## 试点部署

```bash
cd deploy
cp .env.example .env   # 按现场填写
docker compose up -d
```

详见 `docs/deployment/README.md`。

## 安全边界

EWOH 是只读监督与风险分析平台，**不参与设备实时安全控制**。急停、限扭、关节实时控制、
助力闭环等能力永久保留在设备控制器本地。详见 `SECURITY.md`。

## 交付包校验

V1.0 冻结交付包位于 `delivery/`，校验清单见 `delivery/00_交付总览/SHA256SUMS.txt`：

```bash
cd delivery
sha256sum -c 00_交付总览/SHA256SUMS.txt
```
