# 全仓库逐行代码审计 Spec

## Why
仓库经历 40+ 轮 spec 迭代（调度器、契约收敛、控制台深化、飞书集成等），主树累计约 13 万行源码；上一次全仓审计（`docs/audit/2026-08-08-full-repo-audit.md`）之后又合入了大量变更。需要基于当前 HEAD 做一次**逐行**审计，系统性暴露安全、正确性、一致性、可维护性问题，形成可追踪、可复核的发现清单，为后续修复立项提供唯一事实源。

## What Changes
- 新增审计报告 `docs/audit/2026-08-17-line-by-line-audit.md`：按域分章，逐条发现含编号、文件:行号、严重级别、问题描述、证据（代码引用）、修复建议。
- **只读审计**：本轮不修改任何生产代码、契约、迁移或配置；发现项仅记录，修复另行立项。
- 审计产出机器可读汇总（报告附录表：编号/域/级别/位置/状态）。
- 不删除、不改动既有 spec 与权威制品。

### 审计维度（每个文件逐行检查）
1. **安全**：鉴权/授权缺口、SQL 注入、路径穿越、密钥硬编码、SSRF、不安全反序列化、RLS/org_id 租户隔离绕过、fail-open 逻辑。
2. **正确性**：逻辑错误、边界条件、时区/时间戳口径、并发与竞态、事务完整性、幂等性、空值处理。
3. **契约一致性**：代码与 OpenAPI / DB schema-manifest / contracts/ JSON Schema / 事件目录的漂移。
4. **错误处理**：空 catch、吞异常、未处理 Promise rejection、丢失的错误上下文。
5. **性能**：N+1 查询、无界查询/内存、同步阻塞、缺失索引暗示、前端重复渲染与包体超标。
6. **可维护性**：死代码、重复实现（双写口径）、绕过唯一写路径的直写、误导性命名/注释。
7. **依赖与配置风险**：过期/漏洞依赖、CI/部署配置与文档漂移、环境变量缺省值不安全。

### 严重级别定义
- **Critical**：可被利用的安全漏洞、数据损坏/丢失、租户越权。
- **High**：正确性缺陷（生产必现或高频触发）、核心契约漂移。
- **Medium**：边界条件、性能隐患、局部双写、错误处理缺失。
- **Low**：可维护性、命名、注释漂移、轻微冗余。

## Scope（逐行覆盖范围）
| 域 | 路径 | 规模 |
|---|---|---|
| Python 边缘平台 | `src/` | ~54.9k 行 / 248 文件 |
| NestJS 服务端 | `ewoh-spark-app/server/` | ~95.7k 行 |
| 前端 | `ewoh-spark-app/client/src/` | 待登记（Task 1 实测） |
| 共享契约层 | `ewoh-spark-app/shared/` | ~10.3k 行 |
| 飞书应用 | `ewoh-feishu-app/` | ~6.0k 行 |
| 数据库 SQL | `db/`（migrations/seed/verify/runner） | ~15.6k 行 |
| 构建与工具脚本 | `scripts/`、`tools/` | ~17.5k 行 |
| Python 测试 | `tests/`（正确性与契约有效性角度） | ~5.4k 行 |

**核对项（非逐行，逐项核对）**：`contracts/`、`openapi/`、`catalog/`、`security/`、`deploy/`、`.github/workflows/`、根配置（Makefile / pyproject / package.json / version.json / feature-status.yaml）。

**排除**：`node_modules`、`package-lock.json`、`ewoh-spark-app/output/`（生成产物）、`release/ewoh-0.6.0-rc*/` 打包副本（仅抽查与主树的一致性，不逐行）、二进制与交付物（`delivery/`）。

## Impact
- Affected specs: 无代码影响；报告供后续 remediation spec 引用。
- Affected code: 只读；唯一新增文件为 `docs/audit/2026-08-17-line-by-line-audit.md` 及本 spec 目录三份文档。
- 风险：审计子代理的误报 —— 通过主控抽样复核（每域 ≥10% 发现项）控制。

## ADDED Requirements

### Requirement: 全仓库逐行代码审计
系统 SHALL 基于当前 HEAD 对 Scope 表列出的全部代码域执行逐行审计，并产出分级发现报告。

#### Scenario: 逐行覆盖
- **WHEN** 审计完成
- **THEN** Scope 表内每个源文件均被阅读并按 7 个维度检查，报告附录的文件覆盖率登记表与 Task 1 登记的文件清单 100% 对账。

#### Scenario: 发现可追踪
- **WHEN** 报告任一发现被引用
- **THEN** 其编号全局唯一，含文件:行号、严重级别、问题、证据、建议，且可据编号直接定位原文。

#### Scenario: 误报控制
- **WHEN** 域审计产出发现清单
- **THEN** 主控对每域 ≥10% 的发现（含全部 Critical）抽样复核源码证实，复核结果记录在报告复核章。

#### Scenario: 只读约束
- **WHEN** 审计全程结束
- **THEN** `git status` 显示除 `docs/audit/` 报告与 `.trae/specs/audit-full-repo-line-by-line/` 外无任何工作区改动。

#### Scenario: 分级统计与结论
- **WHEN** 报告完成
- **THEN** 含 Critical/High/Medium/Low 计数、按域分布、Top 风险摘要，以及「整体结论」一节（不改码、只裁决）。
