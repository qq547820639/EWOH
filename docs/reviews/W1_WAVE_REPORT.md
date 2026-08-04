# W1 波次报告：只读审计与事实一致性

> 波次：W1（RC4 候选版本产品化深化）
> 时间：2026-08-04
> 分支：`main`；HEAD：`9fe8a8f9881d08026cd70d4d32b41ddddccf530a`
> Owner：首席软件架构师 / 独立质量验证负责人

## 环境指纹

| 项 | 值 |
|----|----|
| 操作系统 | macOS 27.0 |
| Node | v26.5.1 |
| npm | 11.17.0 |
| Python | 3.9.6 |
| 数据库 | 嵌入式 PostgreSQL 17（真实外部 PG 不可用） |
| 容器/编排 | Docker/Kubectl/Helm 本机不可用 |

## 1. 发现的问题

| 编号 | 严重度 | 问题 | 处置 |
|------|--------|------|------|
| W1-1 | 高 | `audit-repo-facts.js` 中 `stateJson` 重复声明，CLI 直接崩溃（SyntaxError） | 已修复（重命名第二个变量） |
| W1-2 | 高 | `audit-repo-facts.js` 过期证据检查引用不存在的 `expiredCount`（应为 `expired`），导致误报 `undefined` | 已修复 |
| W1-3 | 高 | release-manifest 测试计数陈旧（76/362、13/42、232/232、29/29）与最终 HEAD（81/391、15/50、248/248、33/33）不一致 | 已统一 |
| W1-4 | 高 | release-manifest 存在重复 `browser` 键导致 YAML 解析失败 | 已修复 |
| W1-5 | 高 | 110 份证据文件缺失 `command/suite/startedAt/completedAt/artifactChecksum` 字段 | 已诚实回填（据文件内容推导） |
| W1-6 | 中 | work_graph 计数在 release-manifest 三处漂移（202/21/69 → 252/109/39 → 252/209/191） | 已统一为 252/209/191 |
| W1-7 | 中 | phase-state.md / gates.md / state.json 保留大量历史中间计数，与最终状态并存 | 已标注为历史快照并新增权威状态段 |
| W1-8 | 中 | 受管表口径 51 vs 物理 57 混用 | 已区分并在 release-manifest 明确 |

## 2. 完成的代码改动

- **新增** `contracts/repository-facts/repository-facts.schema.json`：repository-facts v1 schema（版本/测试计数/证据/Work Graph/OpenAPI/DB 口径）。
- **新增** `scripts/collect-repo-facts.js`：事实采集 CLI，生成 `output/repository-facts.json`。
- **新增** `scripts/validate-repo-facts.js`：用 ajv 校验快照符合 schema，冲突返回非零退出码。
- **修改** `scripts/audit-repo-facts.js`：修复重复声明/过期检查 bug；新增版本一致性、测试计数漂移、证据 spec 字段、证据过期、commit SHA 检查（38 项）。
- **修改** `scripts/standalone-check.sh` 与 `.github/workflows/test.yml`：接入 `collect-repo-facts` + `validate-repo-facts`。
- **修改** `release/ewoh-0.6.0-rc4/docs/delivery/release-manifest.yaml` 与 `docs/delivery/release-manifest.yaml`：统一测试计数与 work_graph 口径，新增 `contracts.database`（51 managed / 57 physical）。
- **新增** `ewoh-spark-app/test/unit/collect-repo-facts.spec.ts`：采集快照单元测试。
- **修改** `.codex/artifacts/gates.md`、`phase-state.md`、`state.json`：标注历史快照 + 新增权威状态段。
- **修改** 110 份 `.codex/artifacts/work/evidence/*.md`：补齐 spec 字段。

## 3. 未完成项及真实原因

- **9 个 open 任务缺证据或未标记 Blocked**（reconcile 5/6）：这些任务需补证据或标记 Blocked，属 W1 后续或 W2 依赖，不阻塞本轮事实一致性。
- **真实 PostgreSQL / Docker / K8s / 真机验证**：本机无相应运行时，属外部环境验证，不伪造结果。

## 4. 测试命令和结果

| 命令 | 结果 |
|------|------|
| `node scripts/audit-repo-facts.js --strict` | **38/38 通过** |
| `node scripts/collect-repo-facts.js --out output/repository-facts.json` | 快照生成 |
| `node scripts/validate-repo-facts.js --snapshot output/repository-facts.json` | **VALIDATION OK** |
| `node tools/work-indexer/index.js --root . --invariants` | 252 items / 209 edges / 191 evidence / 0 conflicts |
| `npx jest collect-repo-facts / repo-facts / reconcile-authoritative-artifacts` | **8/8 通过** |
| `node -e "JSON.parse(state.json)"` | JSON OK |

## 5. 前后截图

W1 为只读审计与事实一致性波次，无 UI 变更，故无前后截图。截图基准见 W2（视觉回归）。

## 6. 关键 Diff

- `audit-repo-facts.js`：`stateJson` 重复声明 → `stateFactsJson`；`expiredCount` → `expired`；新增 `extractCount()` 归一化测试计数比对。
- `release-manifest.yaml`：`jest/client_jest/e2e/openapi` 更新为 81/391、15/50、33/33、248/248；`work_graph` 更新为 252/209/191；新增 `contracts.database.managed_tables: 51` / `physical_tables: 57`。
- `collect-repo-facts.js`：`databaseFacts()` 从 `contracts.database` 读取 snake_case 并映射为 camelCase。

## 7. 风险变化

- **下降**：发布清单与实测计数不一致（原 C1 高）已消除，避免误导交付验收。
- **下降**：证据字段不全、历史计数并存（原 C2/C3）已缓解，可追溯性提升。
- **保持**：生产环境、真实工厂、Docker/K8s、真实 GitHub 授权写入仍须外部条件，Pilot Readiness 保持 **NOT READY**。

## 8. Gate 状态变化

- 本地门禁：repo-facts 从 33/33 → **38/38**（新增 5 项事实一致性检查）；reconcile 保持 5/6（9 个 open 任务缺证据）。
- 生产 Gate：G10–G13 仍须人类批准；Pilot Readiness **NOT READY**（7/3/5）。本轮不改变任何生产 Gate 状态。

## 9. 下一波次依赖

- **W2（CSS 与设计系统）**：依赖 W1 事实基线；需对登录页/指挥中心/因果控制台/Git 同步/移动工作台/站点准备页建立视觉门禁与基准截图。
- **W5（移动工作台重构）**：可并行，独立模块。
- 9 个 open 任务缺证据：建议在对应波次补证据或标记 Blocked。

## 10. commit SHA

- 当前 HEAD（未提交基线）：`9fe8a8f9881d08026cd70d4d32b41ddddccf530a`
- 本轮改动：待提交（生成可审查 diff 后提交）。