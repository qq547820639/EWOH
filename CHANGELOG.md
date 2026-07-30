# 变更日志

本文件遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/) 1.1.0 规范，
并使用[语义化版本](https://semver.org/lang/zh-CN/) 2.0.0 进行版本管理。

## [Unreleased]

本次版本将现有单机演示原型升级为受控试点系统（spec 阶段 0 Task 2：建立工程基线）。

### Added
- 工程基线：新增 `pyproject.toml`、`requirements-dev.txt`、`.env.example`、`Makefile`，
  声明纯标准库零运行时依赖，统一 unittest 测试发现与 ruff/bandit 静态检查入口。
- 适配器标准化：定义统一适配层契约（`edge/protocol`、`edge/adapter`），支持
  `real` / `controlled_test` / `simulated` 三类数据源的可配置端口映射
  （`EWOH_ADAPTER_PORTS`），为真机接入与受控测试提供一致接口。
- 生产数据库：引入 `postgres` 作为可选生产后端（`EWOH_DB_BACKEND=postgres`），
  保留 SQLite 用于开发/单机；DB 仅接入内部网络，不直接对普通用户网开放。
- API 完善：补齐 OpenAPI 3.0 规范（`docs/api/openapi.yaml`），覆盖
  auth/me/devices/telemetry/events/tasks/query/audit/models/rules/scenario/reset 全部端点。
- 身份权限：引入认证后端选择（customer/oidc/local）、JWT 会话、角色化导出权限
  （`EWOH_EXPORT_ALLOWED_ROLES`）、登录失败锁定与会话超时。
- 审计：所有写操作与导出动作落入审计日志，可在 `GET /api/audit` 查询。
- 监控：定义系统/设备/推理/业务四级监控指标与告警处理流程（见 `docs/operations/`）。
- 备份恢复：定义数据库与证据数据的备份策略、保留窗口与恢复流程占位。
- 测试与故障注入：定义 13 层测试层级与 16 类故障注入清单（见 `docs/acceptance/`）。
- 现场试点分阶段：定义四区部署拓扑（`docs/deployment/`）与分阶段上线策略。
- Go/No-Go 门禁：定义 15 条上线门禁清单作为试点放行依据。
- CI/CD：新增 GitHub Actions（test/security/package）与 CODEOWNERS 安全边界审查。
- 安全策略：新增 `SECURITY.md`，明确平台安全边界声明与漏洞报告流程。
- 服务编排：新增 `docker-compose.yml`，定义 edge-gateway / ewoh-api / ewoh-adapter /
  ewoh-inference / postgres / redis / ewoh-logs 服务与内外网络隔离。

### Changed
- 项目版本由演示原型基线提升至 `0.6.0`，描述更新为「EWOH 受控试点系统」。
- 运行入口 `python -m edge_platform.run` 保持不变，新增 `--stub` 显式回退开关的工程化说明。

### Security
- 明确平台不得写入急停 / 限扭 / 关节实时控制 / 助力实时闭环 / 限速放宽 /
  异常退出保护 / 设备失联安全态 / 绕过本地安全检查的调试指令，这些保留在设备控制器。
- 默认不采集姓名 / 身份证 / 长期精确轨迹 / 视频 / 生理数据。
- 高频原始遥测保留 7-30 天，超期降采样或清除。
- 默认不开放公网，TLS 由 edge-gateway 终结。
