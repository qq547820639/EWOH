# Tasks — 全仓库逐行代码审计（只读）

> 原则：先登记后审计、逐行不跳读、发现必带证据、不改任何生产代码。
> 编号规则：`[域前缀]-[序号]`，如 `EDGE-01` / `NEST-01` / `CLI-01` / `SQL-01` / `FS-01` / `SH-01` / `TEST-01` / `CFG-01`。

- [x] Task 1: 审计基线与范围登记
  - [x] 1.1 记录 HEAD SHA、分支、时间戳、环境版本；冻结基线。（HEAD 4871513e，main，2026-08-17，Python 3.14.7 / Node 24.1.0）
  - [x] 1.2 生成逐行覆盖文件清单（Scope 表各域实测文件数/行数，含 `client/src` 实测值），写入报告附录登记表。
  - [x] 1.3 声明排除项与理由（output/ 生成产物、release/ 打包副本、node_modules、lock 文件）。
- [x] Task 2: Python 边缘平台逐行审计（`src/`，248 文件）
  - [x] 2.1 逐行审计 `src/edge_platform/` 全部模块。
  - [x] 2.2 输出发现清单 `[EDGE-xx]`/`[EDT-xx]`（107+18 条，3 Critical）。
- [x] Task 3: NestJS 服务端逐行审计（`ewoh-spark-app/server/`）
  - [x] 3.1 逐行审计 `server/database/`（35 文件，NEST-501~525）。
  - [x] 3.2 逐行审计 `server/modules/scheduler/` 代码与内嵌测试（NEST-001~170 / NESP-001~119）。
  - [x] 3.3 逐行审计 `server/modules/` 其余业务模块（NEST-201~648）。
  - [x] 3.4 逐行审计 `server/common/` 与入口。
  - [x] 3.5 汇总 `[NEST-xx]` 发现（334+36 条，53 Critical）。
- [x] Task 4: 前端逐行审计（`ewoh-spark-app/client/src/`）
  - [x] 4.1 逐行审计全部页面/组件/状态/请求层（258 条发现）。
  - [x] 4.2 输出 `[CLI-xx]` 发现（5 Critical：XSS×3、token 存储、弱 IV）。
- [x] Task 5: 共享契约层逐行审计（`ewoh-spark-app/shared/`）
  - [x] 5.1 逐行审计契约 TS 模块与 schema/校验逻辑。
  - [x] 5.2 输出 `[SH-xx]` 发现（20 条，1 Critical）。
- [x] Task 6: 飞书应用逐行审计（`ewoh-feishu-app/`）
  - [x] 6.1 逐行审计 `server/` 全部 JS 模块与 `test/`。
  - [x] 6.2 输出 `[FS-xx]` 发现（21 条）。
- [x] Task 7: 数据库 SQL 逐行审计（`db/`）
  - [x] 7.1 逐行审计 `db/migrations/`、`db/seed/`、`db/verify/`、`db/runner/`、`db/contracts/schema-manifest.yaml`。
  - [x] 7.2 输出 `[SQL-xx]` 发现（64 条，8 Critical）。
- [x] Task 8: 构建/工具脚本逐行审计（`scripts/` + `tools/`）
  - [x] 8.1 逐行审计 `scripts/` 全部 JS/Python 与 `tools/` 各工具。
  - [x] 8.2 输出 `[SCR-xx]`/`[TOOL-xx]` 发现（43+17 条，4 Critical）。
- [x] Task 9: Python 测试与配置核对（`tests/` + 核对项）
  - [x] 9.1 逐行审计 `tests/`（TEST-001~015）。
  - [x] 9.2 逐项核对 contracts/openapi/catalog/security/deploy/workflows/根配置 + release 抽查（CFG-001~010、REL-001~007）。
- [x] Task 10: 汇总报告、交叉复核与定稿
  - [x] 10.1 合并全部域发现（950 条），写入 `docs/audit/2026-08-17-line-by-line-audit.md`。
  - [x] 10.2 主控抽样复核：24 项 Critical（覆盖全部域与模式簇，32%）逐一实证，24/24 成立。
  - [x] 10.3 完成附录：覆盖率登记表、分级统计、Top 风险、整体结论。
  - [x] 10.4 确认 `git status` 满足只读约束。

# Task Dependencies
- Task 1 最先完成（其余全部依赖它）。
- Task 2–9 相互独立，可并行（Task 3 内部 3.1→3.5 有汇总依赖，3.1–3.4 可并行）。
- Task 10 依赖 Task 2–9 全部完成。
