# Tasks — 全仓系统走读整改（一次性执行集）

> 原则：走读发现的每一项都**终态化**——要么修复、要么明确裁决并落地（不保留「后续建议」悬挂项）。走读子代理关于「引用不存在文件」的 3 项经主控复核为**误报**，故不执行对应改动。

- [x] Task 1: 部署事实源修复（安全）
  - [x] 1.1 移除 `deploy/docker-compose.yml` 把 SQLite 旧 schema 挂载为 PostgreSQL 初始化脚本的配置。
  - [x] 1.2/1.3 「引用不存在文件」3 项复核为误报，不执行。
- [x] Task 2: 边缘导出鉴权 fail-closed
  - [x] 2.1 `routes/auth.py` production 下无 token/会话无效一律拒绝。
- [x] Task 3: 限流接入运行时
  - [x] 3.1 `server.py` production 下接入 `rate_limiter()`。
- [x] Task 4: ingest 批量路径 fail-closed
  - [x] 4.1 `ingest.service.ts` 批量预检失败 re-throw。
- [x] Task 5: 回归 + 门禁 + 提交（首轮）
- [x] Task 6: 电池字段统一（`battery_pct` 为唯一规范字段）
  - [x] 6.1 `routes/health.py` low_battery 统计改读 `battery_pct`（回退 `battery_level`/`battery_percent`）。
  - [x] 6.2 `inference/rules.py` LOW_BATTERY 规则改读 `battery_pct`（回退 `battery_percent`/`battery_level`）。
  - [x] 6.3 `routes/world.py` 统一为 `battery_pct`（保留回退）。
- [x] Task 7: 时区口径统一（证据窗口 UTC/本地一致）
  - [x] 7.1 统一 `services.parse_ts`/`iso` 与 `inference.ts_to_ms/ms_to_ts` 的时间戳语义，消除 UTC vs 本地偏移。
  - [x] 7.2 新增回归测试证明证据窗口跨 UTC/本地边界不漂移。
- [x] Task 8: OEE performance 接入真实指标
  - [x] 8.1 `computeOee` 由 `outputQty`/`idealRatePerSec` 计算 performance（无数据回退 1）。
  - [x] 8.2 `calculateOee` 复用该 performance，修正 OEE = A×P×Q。
- [x] Task 9: 受管表口径收敛（`run_migrations.js` 51 vs `schema-manifest.yaml` 57）
  - [x] 9.1 以 `schema-manifest.yaml` 为唯一事实源，消除 `run_migrations.js`/`001_verify.sql` 的硬编码 51 与 manifest 57 的口径漂移。
- [x] Task 10: Mobile 与 MES 端点重复收敛
  - [x] 10.1 确认 Mobile 为 MES 的薄 facade（无逻辑重复），标注非权威地位并保留 worker 入口。
- [x] Task 11: Nest 世界状态双源收敛（world.service vs world-cursor.service）
  - [x] 11.1 游离表纳入 Drizzle schema，`world-cursor.service.ts` 改用 schema 对象读写。
- [x] Task 12: `StateMachineGuard`/`@StateMachine` 死代码清理
  - [x] 12.1 删除零生产引用的 guard/装饰器与单测。
- [x] Task 13: ERP 绕过 MES 直写调度表（双写）收敛
  - [x] 13.1 抽取 `MesService.writeScheduleOrder` 为唯一写路径，ERP 复用消除直写。
- [x] Task 14: 边缘 `world_model/scenario/aas/twin/policy/connectors/collection` 能力孤岛处理
  - [x] 14.1 核实为「SDK/库 + WIP」且被测试/脚本引用，裁决保留，不删除。
- [ ] Task 15: 全量回归 + 门禁 + 提交
  - [ ] 15.1 Python 全量 edge 测试通过。
  - [ ] 15.2 `tsc -b --force` 0 错误；相关 jest 通过。
  - [ ] 15.3 `npm run openapi:no-drift` 通过。
  - [ ] 15.4 提交并推送 `main`。

# Task Dependencies

- Task 6/7/8/9/10/11/12/13/14 相互独立，可并行。
- Task 15 依赖全部。
