# EWOH 仓库系统性代码走读报告（2026-08-13）

**日期**：2026-08-13
**版本**：0.6.0-rc4（version.json）
**走读方式**：主线程侦察 + 8 个并行走读子代理 + 1 个静态检查/抽样测试子代理；只读分析，未修改任何业务源码。
**走读边界**：排除 `node_modules/`、`dist/`、`logs/`、`playwright-report/`、`test-results/`、`output/`、`delivery/`、`release/`、`__pycache__/`、`demo.db*`、`.git/`、`.playwright-cli/`、`*.tsbuildinfo`、`models/`（空目录）。

---

## 0. 执行摘要

（待合成后回填）

## 1. 仓库总体拓扑与体量

| 层 | 目录 | 技术栈 | 文件数 | 代码行（约） | 定位 |
|---|---|---|---|---|---|
| 边缘运行时 | `src/edge_platform/` | Python ≥3.9 标准库 | 202 .py | ≈46.4K | 设备采集/推理/规则/边缘调度/本地 API（离线可用） |
| 云侧后端 | `ewoh-spark-app/server/` | NestJS 10 + Drizzle + PG17 RLS | 344 .ts | ≈76.2K | 主产品 API：43 个业务模块 |
| 云侧前端 | `ewoh-spark-app/client/` | React 19 + Vite + Tailwind | 545 .ts/.tsx | ≈103.8K | 指挥地图/决策驾驶舱/工作台/控制台 SPA |
| 共享层 | `ewoh-spark-app/shared/` | TypeScript | — | ≈3.5K | 前后端共享类型/契约 |
| 飞书侧车 | `ewoh-feishu-app/` | Express + better-sqlite3 | 30 | ≈6.5K | 消息推送/卡片处置/事件同步 |
| 契约层 | `contracts/` `openapi/` `db/` `catalog/` | YAML/JSON/SQL | 156 | — | 跨运行时唯一事实源 |
| 治理工具 | `tools/` | Node/Python | 96 | ≈4.2K | 门禁引擎/工作台/工厂复制等 |
| 工程脚本 | `scripts/` | Node/Bash | 56 | ≈11.4K | 门禁/审计/TCK/发布脚本 |
| 仓库级测试 | `tests/` | pytest | 19 | ≈3.1K | 契约与验收测试 |
| 历史原型 | `ui/command_map/` | 静态 HTML/JS | 22 | ≈5.6K | UX 参考，非生产事实源 |
| 冻结交付 | `delivery/` `release/` | 打包产物 | — | — | 不参与运行时 |
| 文档 | `docs/`（98）+ README/CHANGELOG/SECURITY | Markdown | — | — | 活跃开发文档 |

> 说明：沙箱内无 `git` 可执行文件，本报告基于工作副本快照；基线报告（`docs/reviews/codebase-walkthrough-2026-08-09.md`）记录当时为 main@6dc14b5、273 commits。

## 2. 多运行时架构总览

```text
┌─────────────── 现场/边缘 ───────────────┐
│ 物理设备/传感器/MES ─▶ Adapter(连接器) ─▶ MessageBus ─▶ 推理/规则 ─▶ 风险事件
│                                   └─────▶ SQLite 本地存储 + 本地 HTTP/SSE API（离线可用）
└──────────────────────┬────────────────┘
                       │ Edge Bridge（edge_to_spark.py，批量≤100，断线补传）
┌──────────────────────▼──── 云端/主产品 ─────────────────────────┐
│ React SPA ─▶ NestJS（AccessTokenGuard→RolesGuard→OrgContextInterceptor│
│               →RequestDatabaseContext→RLS→Service→PostgreSQL）      │
│ Ingest（X-Ingest-Key fail-closed）▶ 遥测/事件 ▶ World/CommandMap    │
│ Scheduler V2：快照→优先级→资格→路径→求解(heuristic canonical)       │
│   →方案→审批/覆盖→预约→派工→Outbox→SSE                             │
└──────────────────────┬────────────────┘
                       │ webhook/推送
┌──────────────────────▼────────────────┐
│ 飞书侧车（Express+SQLite+验签 webhook） │
└────────────────────────────────────────┘
契约层：contracts/（状态机/事件/工厂/策略）+ openapi/（路由零漂移门禁）+ db/（31 步 standalone 迁移链）
```

## 3. 关键调用链（已主线程核实）

- **Web 请求链**：`AccessTokenGuard（JWT）→ RolesGuard（RBAC）→ OrgContextInterceptor（buildGucSettings：app.user_id/current_org_id/current_org_ids/is_global_admin，set_config 事务级）→ RequestDatabaseContext（AsyncLocalStorage 请求级事务）→ RLS → Service → DB`。证据：`ewoh-spark-app/server/modules/shared/org-context.interceptor.ts:39-93`、`standalone-app.module.ts:98-131`。
- **独立生产入口**：`standalone-main.ts`（abortOnError 生产 fail-fast、CORS 禁 `*`、TRUST_PROXY=true 抛错、安全头、SPA fallback）；legacy `main.ts` 需 `EWOH_LEGACY_ENABLED=1`。
- **Ingest 机器对机器链**：`IngestGuard`（timingSafeEqual 常量时间比较；未配置 key → production 503 fail-closed；100 req/min 限流；X-Org-Id 租户上下文）→ `ingest.service.ts`（823 行）→ 遥测/事件表。
- **调度闭环**：Scheduler 模块 50+ 文件（heuristic-scheduling-solver.ts 73.9KB、plan.service.ts、replan-coordinator.service.ts、outbox.service.ts、scheduler-stream.service.ts）；CP-SAT 阶梯 fail-closed（feature-status.yaml cpSat + solver-activation 门控）。

## 4. 目录层级走读

（待子代理报告回填：每目录职责/入口/关键模块）

## 5. 配置与依赖清单

（待回填）

## 6. 数据流与持久化

（待回填）

## 7. 工程质量亮点

（待回填）

## 8. 代码质量问题与改进点

（待回填：P0/P1/P2 表格 + 证据 + 建议）

## 9. 静态检查与抽样测试验证结果

（待验证子代理回填）

## 10. 附录

- 子报告：`tmp/walkthrough/01~09-*.md`
- 基线对照：`docs/reviews/codebase-walkthrough-2026-08-09.md`（含 15+ 项修复记录，本报告已核对其中关键项的当前状态）
