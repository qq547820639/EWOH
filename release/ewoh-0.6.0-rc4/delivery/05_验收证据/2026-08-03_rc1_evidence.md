# EWOH RC1 验收证据包

日期：2026-08-03
状态：候选生产（production candidate），生产 DDL/部署仍为审批门禁

## 契约证据

- C1-C6 冻结状态：`.codex/artifacts/contracts/README.md`
- C1 数据契约：`.codex/artifacts/contracts/data-contract.md`
- C2 API 契约：`.codex/artifacts/contracts/api-contract.md`、`openapi/ewoh.yaml`
- C3-C6 契约：`.codex/artifacts/contracts/state-machines.md`、
  `security-contract.md`、`ui-contract.md`、`devops-contract.md`
- 需求追踪：`.codex/artifacts/contracts/requirements-trace.md`

## 独立审查证据

- 安全审查：`.codex/artifacts/work/reviews/security-review-2026-08-03.md`
- 持久化/租户审查：`.codex/artifacts/work/reviews/persistence-tenancy-2026-08-03.md`
- 前端/场景审查：`.codex/artifacts/work/reviews/frontend-scenario-2026-08-03.md`

## 自动化证据

- Jest：39 套件 / 137 测试
- E2E：11/11（HTTP + PostgreSQL）
- OpenAPI：106/106 严格审计
- 一键检查：`scripts/standalone-check.sh` 通过
- 发布演练：`scripts/release-drill.sh` 输出 `RELEASE DRILL PASSED`
- 性能冒烟：1000 req / 50 并发，6718 qps，p95 14.63ms
- 浏览器回归：Playwright 登录/指挥中心/指挥地图/设备/告警
- YAML 契约：13/13 可解析
- GitHub Actions：`codex/rc1-ci-full` @ `7474121` 三个工作流全绿，
  含 Docker 镜像构建、PostgreSQL 迁移/回滚、E2E、bandit、ruff

## 数据库与安全证据

- 48 受管表 / 48 RLS / 审计链 / `scheduler_config_org_key=1`
- `scripts/verify-standalone-security.js`：运行时角色最小权限、A/B 组织隔离、
  全局管理员受控读取、审计链与篡改拒绝全部通过

## 发布清单

- `docs/delivery/release-manifest.yaml`
- `docs/delivery/release-checklist.md`
- `docs/delivery/deployment-runbook.md`
- `docs/delivery/acceptance-evidence.md`

## 尚未完成

- 生产 DDL/部署/凭据变更（需批准）
- Docker/Kubernetes 镜像构建与集群部署
- 真实设备/网关联调、生产监控、培训、业务验收签署
- 后续多期验收与结项
