# Tasks — 全仓系统走读整改（本轮执行集）

> 原则：只修「明确、安全、可验证」的高价值项。走读子代理关于「引用不存在文件」的 3 项发现经主控复核为**误报**（`.codex/artifacts/authoritative-plan-final6.txt` 与 `contracts/data-contract.md`/`security-contract.md` 实际存在），故不执行对应改动。

- [x] Task 1: 部署事实源修复（安全）
  - [x] 1.1 移除 `deploy/docker-compose.yml` 把 SQLite 旧 schema 挂载为 PostgreSQL 初始化脚本的配置（已核实为功能性错误）。
  - [~] 1.2 「`artifact-paths.json` 引用不存在的 final6 文件」——复核为误报（文件存在），不执行。
  - [~] 1.3 「`schema-manifest.yaml` 源文件不存在」——复核为误报（文件存在），不执行。
- [x] Task 2: 边缘导出鉴权 fail-closed
  - [x] 2.1 `routes/auth.py` 的 `enforce_export_role` 在 production 下无 token/会话无效/认证不可用一律拒绝（401/503）；非 production 保留演示兼容。
- [x] Task 3: 限流接入运行时
  - [x] 3.1 `server.py` 的 `build_server` 在 production 下接入 `rate_limiter()`（默认 60 req/min/IP）。
  - [~] `validate_input` 为按端点 schema 调用的辅助函数（非中间件），全局接入需逐端点 schema，列为后续项。
- [x] Task 4: ingest 批量路径 fail-closed
  - [x] 4.1 `ingest.service.ts` 批量 entity/raw_ref 预检失败由吞异常改为 re-throw（fail-closed，与单帧一致）。
- [x] Task 5: 回归 + 门禁 + 提交
  - [x] 5.1 Python 全量 edge 测试 840 passed；`tests/test_production_assembly.py` 通过。
  - [x] 5.2 `npx tsc -b --force` 0 错误；ingest jest 28 passed（4 套件）。
  - [x] 5.3 `npm run openapi:no-drift` 通过。
  - [x] 5.4 提交并推送 `main`。

# 后续建议（本轮不执行，需进一步核实或较大改动）

- 受管表 51/54/57 口径冲突（`run_migrations.js:888` vs `schema-manifest.yaml`）——需先核实真实计数。
- Nest 世界状态双源（`world.service` vs `world-cursor.service`，游标表游离 Drizzle schema）。
- ERP 绕过 MES 直写调度表（双写事实源）。
- 巨型 god-file 拆分（dashboard/scale/work-orchestration/operations/mes 等数万行）。
- `StateMachineGuard`/`@StateMachine` 死代码 + 各模块手写状态表重复。
- 边缘 `world_model/scenario/aas/twin/policy/connectors/collection` 未接线（能力孤岛）。
- 时区口径不一致（UTC vs 本地）导致 evidence 窗口偏移；电池字段三套并存。
- OEE performance/quality 硬编码=1；Mobile 与 MES 端点重复；`validate_input` 逐端点接入。

# Task Dependencies

- Task 2/3/4 相互独立，可并行。
- Task 5 依赖全部。
