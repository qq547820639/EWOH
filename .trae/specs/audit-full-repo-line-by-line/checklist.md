# Checklist — 全仓库逐行代码审计

- [x] 基线记录完整：HEAD SHA、分支、时间戳、环境版本写入报告（HEAD 4871513e，main，Python 3.14.7 / Node 24.1.0）
- [x] 覆盖率登记表与各域实测文件清单 100% 对账（含 `client/src` 实测行数 107.7k）
- [x] 排除项（output/、release/ 副本、node_modules、lock）已声明且有抽查结论（REL-001~007）
- [x] `src/` 边缘平台逐行审计完成，发现含编号与文件:行号（EDGE 107 条 + EDT 18 条）
- [x] `ewoh-spark-app/server/`（database/modules/common/入口）逐行审计完成（NEST 334 + NESP 36 条）
- [x] `ewoh-spark-app/client/src/` 逐行审计完成（CLI 258 条，含测试补齐 88 文件）
- [x] `ewoh-spark-app/shared/` 逐行审计完成，契约漂移已记录（SH 20 条）
- [x] `ewoh-feishu-app/` 逐行审计完成（FS 21 条）
- [x] `db/`（migrations/seed/verify/runner/manifest）逐行审计完成（SQL 64 条）
- [x] `scripts/` + `tools/` 逐行审计完成，CI 门禁绕过类风险已检查（SCR 43 + TOOL 17 条）
- [x] `tests/` 逐行审计 + contracts/openapi/catalog/security/deploy/workflows/根配置核对完成（TEST 15 + CFG 10 条）
- [x] 每条发现含：编号、位置、严重级别、问题、证据、建议（管道符分隔统一格式）
- [x] 严重级别按 spec 定义校准（Critical/High/Medium/Low；74/161/430/285，合计 950）
- [x] 每域 ≥10% 发现 + 全部 Critical 经主控复核，复核结论记录在报告 §7（24 项 Critical 实证，24/24 成立，0 误报）
- [x] 报告含分级统计、按域分布、Top 风险、整体结论（§3/§4/§8）
- [x] 报告落盘 `docs/audit/2026-08-17-line-by-line-audit.md`
- [x] 只读约束满足：`git status` 除报告与本 spec 目录外无改动（仅新增 `docs/audit/2026-08-17-line-by-line-audit.md`；`.trae-html-share-packages/` 为审计前已存在的未跟踪目录）
- [x] tasks.md 中全部任务勾选完毕
