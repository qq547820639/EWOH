# F61-01 独立复核结论（第二轮 · 覆盖性复核）

> 本文件为只读验证 Agent 允许写入的唯一新文件，覆盖上一轮 `F61-01_INDEPENDENT_VERIFICATION.md`。

- 验证时间：2026-08-04（Asia/Shanghai）
- 验证 Agent：EWOH F61-01 独立复核 Agent（只读，不修改任何源码 / 权威制品 / schema / 夹具 / 测试）
- 基线 HEAD：`6e6a67f0c3e6bbe74082ba960267d070722b59c7`（工作树含未提交的 F61-01 实现，以工作树当前内容为准；`git rev-parse HEAD` 实测一致）
- 任务范围：复核 F61-01「单一事实源语义一致性」的规则注册、schema、strict 模式、13 个漂移夹具真实覆盖、上一轮缺陷修复（R-a/R-b/R1/R-c/R2）、9 类真实仓库冲突、--fix 边界

---

## 0. 结论摘要

| 项目 | 结论 | 说明 |
|------|------|------|
| 8 条验证命令退出码 | 7 条为 0，1 条为 1 | pilot-readiness 预期 NOT READY（见 §1） |
| 14 条语义规则 | 全部存在并注册 | `RULE_META` / `ALL_RULES` 各 14 条，id 与预期一致 |
| 7 个 schema | 全部存在且版本化 | `$id: ewoh:///artifact/<name>/v1` |
| strict 模式行为 | 正确 | 任一未豁免冲突（error 或 warning）即非零 |
| 13 个漂移夹具 | 13/13 真实触发目标规则 | 上一轮空触发的 fixture-06/07 已修复 |
| 5 项缺陷修复 | 全部解决 | R-a/R-b/R1/R-c/R2 均确认已修复 |
| 9 类真实仓库冲突 | 9/9 已修复 | 含 workGraph 计数 220/4 已同步 |
| --fix 边界 | 正确 | 仅 head-consistency / task-section-status 可自动修复 |
| 是否允许进入 F61-02 | **允许** | 真实仓库零未豁免语义冲突，规则与夹具覆盖健壮 |

---

## 1. 实际运行命令与真实退出码（只读复核）

| # | 命令 | 真实退出码 | 关键输出 |
|---|------|:---:|----------|
| 1 | `node tools/semantic-rules/index.js --root . --strict` | **0** | `Semantic rules: 0 findings (0 errors / 0 warnings) across 14 rules` |
| 2 | `node tools/semantic-rules/index.js --root . --check --json` | **0** | `gitHead=6e6a67f0…, summary{total:0,errors:0,warnings:0,pass:true,rulesRun:14}, findings:[]` |
| 3 | `node tools/semantic-rules/run-fixtures.js` | **0** | `13/13 PASSED`（每个夹具 drift strict exit=1） |
| 4 | `node scripts/audit-repo-facts.js --strict` | **0** | `REPO FACTS AUDIT: 39/39 passed` |
| 5 | `node tools/work-indexer/index.js --root . --strict --invariants` | **0** | `252 items / 209 edges / 48 actors / 191 evidence / 14 gates / 0 conflicts` |
| 6 | `node tools/work-console/index.js --root . --output output/work-console.json --strict` | **0** | `0 blocked / 220 missing evidence / 4 gates need approval / 0 invariant conflicts` |
| 7 | `bash scripts/standalone-check.sh` | **0** | `ALL STANDALONE CHECKS PASSED`（含 standalone build、DDL hygiene） |
| 8 | `bash scripts/pilot-readiness-check.sh` | **1** | `PILOT READINESS: NOT READY`（passed=5 failed=3 pending=7；docker/kubectl/helm 缺失、DB/批准未就绪） |

> 说明：命令 8 退出码 1 为**预期结果**，因外部依赖（docker/kubectl/helm/DB 环境/人工批准/验收签署）缺失，属预期性 NOT READY，不构成缺陷。

---

## 2. 语义规则注册与数量核对

`tools/semantic-rules/lib/rules.js` 中 `RULE_META`（行 922-1007）与 `ALL_RULES`（行 1009-1024）各注册 **14 条**，id 与任务预期完全一致：
`head-consistency, task-section-status, gate-release-ready, risk-unreviewed, counts-generative, evidence-incomplete, evidence-invalid, planned-next, version-consistency, task-evidence-missing, console-no-direct-fix, no-self-exemption, pilot-env-fingerprint, workgraph-count-drift`。✓

（较上一轮 13 条新增 `workgraph-count-drift`，用于校验 workGraph 缺失证据 / 待批准门计数与实时 work-console 一致，对应 R1 修复。）

---

## 3. artifact-schemas 7 个 Schema 核对

`contracts/artifact-schemas/` 下 7 个 JSON Schema 全部存在且带版本标识（Grep `"$id"` 实测）：

| 文件 | `$id` |
|------|-------|
| state.schema.json | `ewoh:///artifact/state/v1` |
| task-board.schema.json | `ewoh:///artifact/task-board/v1` |
| gate.schema.json | `ewoh:///artifact/gate/v1` |
| risk.schema.json | `ewoh:///artifact/risk/v1` |
| decision.schema.json | `ewoh:///artifact/decision/v1` |
| evidence.schema.json | `ewoh:///artifact/evidence/v1` |
| release-manifest.schema.json | `ewoh:///artifact/release-manifest/v1` |

✓ 7/7 齐全且版本化。

---

## 4. strict 模式行为核对

- `lib/engine.js:272`：`summary.pass = opts.strict ? unexempted.length === 0 : findings.length === 0`，其中 `unexempted = findings.filter(f => !exempted.has(f.ruleId))`。**strict 下任一未豁免语义冲突（error **或** warning）均判失败。** ✓
- `index.js:140`：`process.exitCode = options.strict && !report.summary.pass ? 1 : 0`。实测真实仓库 strict=0（0 findings）；夹具 strict 全部返回 1。✓
- 豁免授权由 `no-self-exemption` 强制：仅当决策日志存在含 `exempt / semantic / waive` 的 D- 条目时才接受对高风险规则的豁免，否则报错。（fixture-13 实测验证，见 §5。）✓

---

## 5. 13 个漂移夹具逐项核对（解析 `summary.byRule`）

对每个夹具运行 `node tools/semantic-rules/index.js --root <fixture> --strict --json`（fixture-13 加 `--exempt head-consistency`），解析 `summary.byRule`。**全部 13 个夹具真实触发其目标规则，无一空触发。**

| 夹具 | 目标规则 | 实际 byRule | 真实覆盖 |
|------|----------|-------------|:---:|
| fixture-01 stale-head | head-consistency | `{head-consistency:1}` | ✅ |
| fixture-02 task-done-section-inprogress | task-section-status | `{task-section-status:1}` | ✅ |
| fixture-03 gate-pending-scale-ready | gate-release-ready | `{gate-release-ready:1, counts-generative:4}` | ✅ |
| fixture-04 planned-next-done | planned-next | `{planned-next:1, counts-generative:4}` | ✅ |
| fixture-05 planned-next-nonexistent | planned-next | `{planned-next:1, counts-generative:4}` | ✅ |
| fixture-06 risk-fixed-unreviewed | risk-unreviewed | `{risk-unreviewed:1}` | ✅（**唯一**触发，非靠其他规则） |
| fixture-07 evidence-missing-commit | evidence-incomplete（缺 commit） | `{evidence-incomplete:1}` | ✅ |
| fixture-08 evidence-expired | evidence-invalid（过期） | `{evidence-invalid:1}` | ✅ |
| fixture-09 openapi-count-drift | counts-generative | `{counts-generative:5}` | ✅ |
| fixture-10 pilot-env-fingerprint | pilot-env-fingerprint | `{pilot-env-fingerprint:1, task-section-status:1, counts-generative:4}` | ✅ |
| fixture-11 db-count-drift | counts-generative | `{counts-generative:6}` | ✅ |
| fixture-12 workgraph-missing-evidence | task-evidence-missing | `{task-evidence-missing:2, gate-release-ready:1, counts-generative:4}` | ✅ |
| fixture-13 no-self-exemption | no-self-exemption | `{no-self-exemption:1, head-consistency:1}` | ✅（**唯一**触发 no-self-exemption；head-consistency 因 `--exempt` 被排除于失败判定） |

重点确认：
- **fixture-06**：byRule 仅 `{risk-unreviewed:1}`，确认真正触发 risk-unreviewed（夹具 risk-register.md 表头为 `Current Mitigation`，R-001 为 `Implemented in PR #42`）。→ 对应 R-a 修复已生效。
- **fixture-13**：byRule 含 `{no-self-exemption:1}`（decision-log.md 仅 D-001 "does NOT authorize any semantic exemption"，故对 `--exempt head-consistency` 的高风险豁免无授权 → 被拒绝）。→ 对应 R-c 修复已生效。
- **fixture-07**：ev-001.md 无 `commitSha` 字段 → `evidence-incomplete` 触发（缺 commit）。→ 对应 R2 修复已生效。

---

## 6. 上一轮缺陷修复确认（R-a / R-b / R1 / R-c / R2）

| 缺陷 | 描述 | 修复状态 |
|------|------|:---:|
| **R-a** | risk-unreviewed 表头仅匹配 `current_mitigation`/`mitigation`，与真实 `Current mitigation`（带空格）不匹配 → 死代码 | ✅ **已修复**。`extractRiskRows`（rules.js:124-127）现对表头做 `toLowerCase().replace(/[_\s]+/g,' ')` 并匹配 `current mitigation`/`mitigation`；fixture-06 实测触发 `risk-unreviewed` |
| **R-b** | console-no-direct-fix 扫描不存在的 `client/src/pages/WorkOrchestration` | ✅ **已修复**。扫描目标（rules.js:830-833）现为 `ewoh-spark-app/client/src/pages/WorkOrchestration` |
| **R1** | workGraph 缺失证据计数陈旧（210 vs 实际 220），且无规则校验 | ✅ **已修复**。state.json `final_authoritative.workGraph` 现为 `220 missing evidence / 4 gates need approval`，与实时 work-console（220/4）一致；新增 `workgraph-count-drift` 规则校验该计数 |
| **R-c** | no-self-exemption 无夹具覆盖 | ✅ **已修复**。新增 fixture-13 并实测触发 `no-self-exemption` |
| **R2** | fixture-07 空触发（不测 evidence-incomplete 缺 commit） | ✅ **已修复**。fixture-07 现真正触发 `evidence-incomplete` |

---

## 7. 9 类真实仓库冲突核对（读 .codex/artifacts 文件核对，非仅信工具输出）

| # | 要求 | 真实文件核对 | 结论 |
|---|------|------|:---:|
| 1 | phase-state.md / gates.md HEAD = 6e6a67f0… | phase-state.md 行 6、gates.md 行 20 均含 `HEAD 6e6a67f0c3e6bbe74082ba960267d070722b59c7` | ✅ |
| 2 | W0 (done)、T-001~T-011 全部 Done | task-board.md 行 6 `## Wave W0 - Baseline, Contracts, Probes (done)`；T-001~T-011 全部 `Done` | ✅ |
| 3 | planned_next 仅含未完成项 | state.json `planned_next = ["approval physical persistence mapping","production DDL/deploy approval gate"]`（均为审批/遗留非任务项） | ✅ |
| 4 | openapi = 253/253 | state.json `"openapi":"253/253"` | ✅ |
| 5 | pilotReadiness 绑定环境指纹 | state.json `"pilotReadiness":"NOT READY (env-fingerprint: no-runtime-env)"`、`"pilotEnvironmentFingerprint":"no-runtime-env"` | ✅ |
| 6 | R-013/014/015 含 reviewedAt/reviewer/resolutionEvidence/status=open（未自签关闭） | risk-register.md 行 19-21 三条均含 `reviewedAt: 2026-08-04 / reviewer: EWOH-Final6.1-独立验证 / resolutionEvidence: 待补 / status: open` | ✅ |
| 7 | workGraph 含 `220 missing evidence / 4 gates need approval` | state.json `final_authoritative.workGraph` 含 `220 missing evidence / 4 gates need approval`（与 work-console 220/4 一致） | ✅ |
| 8 | 51/57 标记 unverified 且未写入 final_authoritative | phase-state.md 行 17 明确 `51 managed / 57 physical 为未独立验证的自报，未采纳`；`final_authoritative` 键仅含 serverJest/clientJest/openapi/e2e/browser/repoFacts/workGraph/pilotReadiness/pilotEnvironmentFingerprint，**不含 db/managed/physical** | ✅ |
| 9 | 测试数量来自机器生成结果 | `serverJest 81 suites/391 tests, clientJest 15 suites/50 tests, e2e 33/33, browser 5/5`，与 `standalone-check.sh` 实测输出一致 | ✅ |

**结论：9/9 全部修复。**

---

## 8. --fix 边界核对

- `rules.js` 中 `fixable:true` 仅 `head-consistency`（行 299）与 `task-section-status`（行 352）；其余 12 条规则全部 `fixable:false`。
- `applyFixes`（engine.js:284-325）仅对 `fixable && typeof fix==='function'` 的 finding 执行确定性机械补丁。
- **Gate 人工批准、风险关闭、生产状态、业务 Owner 签署均不会被 `--fix` 自动修复。** ✓

---

## 9. 工作台输出（可选）

`output/work-console.json` 已由命令 6 重新生成（generatedAt 2026-08-04T18:08:42Z，itemCount=252、evidenceCount=191、missingEvidence 计数与 state 一致）。✓

---

## 10. 最终结论

- **真实仓库零未豁免语义冲突**：`semantic-rules --strict` 报告 0 findings / 14 rules；`audit-repo-facts` 39/39；`work-indexer --strict --invariants` 0 conflicts；`work-console --strict` 0 invariant conflicts。**独立通过。**
- **规则与夹具覆盖健壮**：上一轮 5 项缺陷（R-a/R-b/R1/R-c/R2）全部确认修复；13 个夹具全部真实触发目标规则，无空触发。
- **9 类真实仓库冲突全部修复**，含 workGraph 计数已同步为 220/4。
- **strict 模式与 --fix 边界语义正确。**
- **pilot-readiness NOT READY** 属外部依赖缺失的预期结果，不构成阻塞。

### 是否允许进入 F61-02

**判定：允许。**

理由：进入 F61-02 的门槛「真实仓库零未豁免语义冲突且独立通过」已完全满足，且实现本身（规则注册、schema 版本化、strict 语义、夹具真实覆盖、--fix 边界）经独立复核健壮。上一轮报告的阻塞性缺陷（R-a/R-b/R1/R-c/R2）均已修复并由夹具/文件实锤验证。无遗留阻塞项。