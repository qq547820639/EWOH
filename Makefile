# EWOH 受控试点系统 - 常用命令
# 用法：make <target>   例如 make test / make lint / make run
# 开发环境推荐以进程方式运行（make run），docker-compose 用于试点部署。
# 代码采用 src/ 布局，运行入口通过 PYTHONPATH=src 解析 edge_platform 包。

.PHONY: run run-stub demo scenario-reset capability-drift e2e-golden e2e-receipt e2e-wave e2e-learning e2e-learning-signal e2e-improvement-action e2e-perception-fusion e2e-control-actuator e2e-agv-transport e2e-plan-staleness e2e-chain e2e-edge browser-real e2e-closed-loop test test-contract production-smoke connector-tck aas-tck rego-tck cross-tenant-tck contract-identity contract-domain contract-golden contract-envelope audit-regression-gates pilot-readiness lint lint-fix security format clean help

PYTHON ?= python3

help:  ## 显示所有可用目标
	@grep -E '^[a-zA-Z0-9_-]+:.*?## .*$$' $(MAKEFILE_LIST) | awk 'BEGIN {FS = ":.*?## "}; {printf "  \033[36m%-16s\033[0m %s\n", $$1, $$2}'

run:  ## 启动平台（development：默认真实组件；stub 需显式 EWOH_ALLOW_STUB=1 或 --stub）
	PYTHONPATH=src $(PYTHON) -m edge_platform.run

run-stub:  ## 显式 simulation 模式（仅工程自测，不作为真机验收依据）
	PYTHONPATH=src $(PYTHON) -m edge_platform.run --stub

demo:  ## 一键演示：启动 stub 平台并自动打开指挥地图（Ctrl-C 停止）
	$(PYTHON) tools/run_demo.py --port 8765

.PHONY: demo-closed-loop
demo-closed-loop:  ## 运行故障重排的 HTTP/SQLite 模拟闭环并导出证据
	$(PYTHON) tools/run_closed_loop_demo.py

.PHONY: migration-fresh-chain
migration-fresh-chain:  ## 全新临时库跑完整迁移链 + 全部 verify（需 EWOH_PG_URL=owner 连接串；失败清单对照 db/migration-verify-baseline.txt）
	@test -n "$(EWOH_PG_URL)" || { echo "需要 EWOH_PG_URL（owner 权限连接串）"; exit 2; }
	node scripts/migration-fresh-chain-check.js $(if $(KEEP),--keep,)

.PHONY: local-up
local-up:  ## 一键本地启动：PG(docker) + 迁移 + 种子 + 三账号 + standalone 服务（参数：REBUILD_DB=1 / SKIP_BUILD=1 / NO_SERVER=1）
	@bash scripts/local-up.sh $(if $(REBUILD_DB),--rebuild-db,) $(if $(SKIP_BUILD),--skip-build,) $(if $(NO_SERVER),--no-server,)

# ── 主产品闭环场景（真实 NestJS + PostgreSQL；需先启动后端与数据库）──────────
# 前置：数据库已迁移 + seed，后端已启动（见 docs/operations/local-closed-loop.md）
# 环境：EWOH_E2E_BACKEND_URL / EWOH_E2E_ADMIN_USER / EWOH_E2E_ADMIN_PASS /
#       EWOH_E2E_APPROVER_USER / EWOH_E2E_APPROVER_PASS /
#       EWOH_E2E_OPERATOR_USER / EWOH_E2E_OPERATOR_PASS /
#       EWOH_E2E_FIELD_USER / EWOH_E2E_FIELD_PASS / EWOH_E2E_PG_URL
# ORG_ID 默认取 seed 租户；复位脚本仍然"必须显式给出组织"（拒绝猜一个 org 再清空它），
# 因此这里只是把本地 seed 租户做成默认值，跨租户请显式 ORG_ID=<uuid>。
ORG_ID ?= 00000000-0000-4000-8000-000000000001

scenario-reset:  ## 复位 seed 场景数据（dry-run；加 YES=1 执行；ORG_ID 默认 seed 租户）
	@node db/runner/reset-scenario-data.js --org-id "$(ORG_ID)" $(if $(YES),--yes,)

e2e-golden:  ## 主产品 Golden Path：调度→审批(独立身份)→派工→策略治理全链
	cd ewoh-spark-app && npm run e2e:golden

e2e-receipt:  ## 执行回执闭环：开始/完成回执→反馈→来源与训练资格→现场身份授权
	cd ewoh-spark-app && npm run e2e:receipt

e2e-wave:  ## 分波次派工（部分执行）：波次范围/计划状态语义/全有或全无
	cd ewoh-spark-app && npm run e2e:wave

# 学习段治理闭环：模拟外骨骼帧 → 真实摄入 API（含设备↔人员身份映射）→
# ewoh_telemetry → 服务端影子重放 → 提案（提议人归属取会话）→ 自批被拒 →
# 他人审批激活 → 基线读面给出覆盖来源 → 回滚复原。
# 需要摄入密钥（EWOH_E2E_INGEST_KEY，默认本地开发密钥）与
# EWOH_E2E_OWNER_DATABASE_URL（仅用于登记模拟空间实体，帧数据仍走真实摄入通道）。
e2e-learning:  ## 学习段治理闭环：摄入→影子→提案→自批回避→审批激活→回滚
	cd ewoh-spark-app && npm run e2e:learning

.PHONY: e2e-learning-signal
e2e-learning-signal:  ## 学习回路接线（NO-54a）：运行记忆→信号（证据/样本/可信度）→人点生成提案→基线漂移拒绝
	cd ewoh-spark-app && npm run e2e:learning-signal

.PHONY: e2e-improvement-action
e2e-improvement-action:  ## 经验→行动（NO-55a）：复盘经验/缺口→行动项（负责人/期限/验收判据/完成证据）
	cd ewoh-spark-app && npm run e2e:improvement-action

.PHONY: e2e-perception-fusion
.PHONY: e2e-agv-transport
e2e-agv-transport:  ## 搬运任务→执行机构（NO-61a）：AGV 状态投影→候选合格→方案派给 AGV→（授权/执行腿见 e2e-control-actuator）
	cd ewoh-spark-app && npm run e2e:agv-transport

.PHONY: capability-drift
capability-drift:  ## 能力停用漂移巡检（NO-65c；只读；超阈值非零退出；缺 EWOH_DATABASE_URL 时自动从 /tmp/ewoh-e2e-env.sh 加载）
	@if [ -z "$(EWOH_DATABASE_URL)" ] && [ -f /tmp/ewoh-e2e-env.sh ]; then \
	  set -a && . /tmp/ewoh-e2e-env.sh && set +a; \
	fi; \
	test -n "$${EWOH_DATABASE_URL:-$$EWOH_E2E_OWNER_DATABASE_URL}" || { echo "需要 EWOH_DATABASE_URL 或 EWOH_E2E_OWNER_DATABASE_URL（owner 连接串）"; exit 2; }; \
	node scripts/capability-drift-check.js $(if $(ORG_ID),--org-id $(ORG_ID),)

.PHONY: e2e-chain
e2e-chain:  ## 主产品闭环 E2E 链（16 个场景，真实后端 + 真实 PG；需 EWOH_E2E_* 凭据）
	bash scripts/e2e-chain.sh

.PHONY: e2e-control-actuator
e2e-control-actuator:  ## 平台授权→边缘执行→回执（NO-60a/62a/62b）：审批→下发→边缘执行→ack/回执 + 投递前授权复核 + 安全停机插队
	cd ewoh-spark-app && npm run e2e:control-actuator

.PHONY: e2e-plan-staleness
e2e-plan-staleness:  ## 方案过期可解释（NO-62c）：差异诊断 + 审批 409 带差异 + 重排仍走审批
	cd ewoh-spark-app && npm run e2e:plan-staleness

e2e-perception-fusion:  ## 多模态感知融合（NO-56a）：真实接入三源→§5 五条规则（一致/冲突/降级/证据不足/不强建议）
	cd ewoh-spark-app && npm run e2e:perception-fusion

# 边缘多源上行闭环：真实边缘运行时（环境/摄像头/UWB 适配器 → 归一化 → SQLite
# → 有界缓冲上行桥）注入断网/重复/乱序/迟到/坏时钟，再在平台侧逐条核对
# （落库/不双写/迟到标记/坏时钟被拒/死信留痕）。
# 需要：EWOH_E2E_OWNER_DATABASE_URL（平台侧事实断言）+ EWOH_E2E_BACKEND_URL，
# 且平台侧 INGEST_RATE_LIMIT 需按机群规模上调（本地建议 100000）。
e2e-edge:  ## 边缘多源上行闭环：断网补传/重放不双写/坏时钟拒绝/死信留痕
	cd ewoh-spark-app && npm run e2e:edge

# 注意：golden / receipt / wave 都会**消费**可调度任务（派工或回执后任务不再可排程）。
# 实测（2026-09-10，真实 PostgreSQL）：三个场景各自运行前都应先 scenario-reset，
# 否则后续场景会如实报 SKIP（未验证 ≠ 通过）——"golden 之后直接 receipt"会产生
# 0 assignment 的方案，receipt 找不到可回执 assignment。
# learning 不消费任务（自带模拟遥测与身份映射），可在任意顺序运行。
# 真实后端 + 真实浏览器的 UI 闭环（前端 → NestJS → PostgreSQL）。
# 需要 owner 与 runtime 连接串：runtime 必须是**非超级用户、无 BYPASSRLS**（RLS 生效）。
# 每个用例使用独立租户，运行结束回收。
browser-real:  ## 浏览器×真实后端：分波派工 UI 全链（需 EWOH_E2E_*_DATABASE_URL）
	cd ewoh-spark-app && npm run test:browser:real

e2e-closed-loop:  ## 主产品完整闭环（golden + receipt），真实 PostgreSQL
	cd ewoh-spark-app && npm run e2e:closed-loop

# DR-2~DR-6 全闭环（2026-09-11）：故障感知→数据质量确认→方案→审批→派工→回执
# →偏差→取消回滚→复盘运行记忆→班次解析。消费可调度任务：先 scenario-reset YES=1。
e2e-receipt-fresh:  ## NO-99a：清库后全路径复验 receipt（reset → 清执行事实 → receipt）
	@if [ ! -f /tmp/ewoh-e2e-env.sh ]; then echo "缺凭证：先准备 /tmp/ewoh-e2e-env.sh（runbook 模板）"; exit 2; fi
	set -a && . /tmp/ewoh-e2e-env.sh && set +a; \
	EWOH_DATABASE_URL=$${EWOH_DATABASE_URL:-postgresql://ewoh_owner:devownerpw@127.0.0.1:55432/ewoh} \
	  node db/runner/reset-scenario-data.js --org-id 00000000-0000-4000-8000-000000000001 --yes; \
	node db/runner/clear-execution-facts.js --org-id 00000000-0000-4000-8000-000000000001; \
	cd ewoh-spark-app && npm run e2e:receipt

e2e-agv-fresh:  ## NO-99a：清库后全路径复验 agv-transport（reset → 清执行事实 → agv）
	@if [ ! -f /tmp/ewoh-e2e-env.sh ]; then echo "缺凭证：先准备 /tmp/ewoh-e2e-env.sh（runbook 模板）"; exit 2; fi
	set -a && . /tmp/ewoh-e2e-env.sh && set +a; \
	EWOH_DATABASE_URL=$${EWOH_DATABASE_URL:-postgresql://ewoh_owner:devownerpw@127.0.0.1:55432/ewoh} \
	  node db/runner/reset-scenario-data.js --org-id 00000000-0000-4000-8000-000000000001 --yes; \
	node db/runner/clear-execution-facts.js --org-id 00000000-0000-4000-8000-000000000001; \
	cd ewoh-spark-app && npm run e2e:agv-transport

e2e-golden-fresh:  ## NO-87a：清库后全路径复验 golden（reset → gate → activate → rollback）
	@if [ -f /tmp/ewoh-e2e-env.sh ]; then \
	  set -a && . /tmp/ewoh-e2e-env.sh && set +a; \
	else \
	  echo "缺凭证：请先准备 /tmp/ewoh-e2e-env.sh（模板见 runbook『E2E 凭证的角色分工』）"; exit 2; \
	fi; \
	EWOH_DATABASE_URL=$${EWOH_DATABASE_URL:-postgresql://ewoh_owner:devownerpw@127.0.0.1:55432/ewoh} \
	  node db/runner/reset-scenario-data.js --org-id 00000000-0000-4000-8000-000000000001 --yes; \
	node db/runner/clear-execution-facts.js --org-id 00000000-0000-4000-8000-000000000001; \
	cd ewoh-spark-app && npm run e2e:golden

e2e-fault-replan:  ## 全闭环验收：感知/质量/决策/授权/执行/反馈/回滚/复盘/班次
	cd ewoh-spark-app && npm run e2e:fault-replan

test:  ## 运行 unittest 测试套件
	$(PYTHON) -m unittest discover -s src/edge_platform/tests -v

test-contract:  ## 运行契约测试（tests/，需 pytest；也可用 unittest 运行）
	PYTHONPATH=src $(PYTHON) -m pytest tests/ -q

audit-contract-touchpoints:  ## NO-84b：契约桩触达面审计（桩返回值 vs 现行词表；防 r76 类事故）
	node scripts/audit-contract-touchpoints.js

contract-state-machine:  ## P1-contract：校验 Python 状态机与 contracts/state-machines/*.yaml 一致
	PYTHONPATH=src $(PYTHON) -m pytest tests/test_state_machine_contract.py -q

contract-identity:  ## ADR-006：跨运行时 Identity 契约门禁（schema/vectors/Python/TS 一致）+ 契约测试
	@node scripts/audit-identity-contracts.js
	PYTHONPATH=src $(PYTHON) -m pytest tests/test_identity_contract.py -q

contract-domain:  ## ADR-007：跨运行时 Risk/Location/Resource 契约门禁（独立仲裁 + 注册表一致）+ 契约测试
	@node scripts/audit-domain-contracts.js
	@node scripts/audit-event-envelope.js
	PYTHONPATH=src $(PYTHON) -m pytest tests/test_domain_contracts.py -q

contract-golden:  ## §26：Canonical Contract Golden Scenarios（八域共享场景定义，Python 侧执行；TS 侧在 jest）
	PYTHONPATH=src $(PYTHON) -m pytest tests/test_golden_contract_scenarios.py tests/test_domain_contracts.py tests/test_identity_contract.py tests/test_world_contract.py tests/test_event_envelope.py tests/test_mq_contracts.py -q

scheduler-golden:  ## Phase 7 / NO-07+NO-07b：Golden Scheduler TCK（求解段 + 审批/预约/派工工作流段；共享场景，Python 侧独立仲裁；TS 侧在 jest 并漂移门禁）
	PYTHONPATH=src $(PYTHON) -m pytest tests/test_golden_scheduler_scenarios.py tests/test_golden_scheduler_workflow.py -q

contract-envelope:  ## ADR-009：Event Envelope 契约门禁（独立仲裁 + 目录交叉校验）+ 契约测试
	@node scripts/audit-event-envelope.js
	PYTHONPATH=src $(PYTHON) -m pytest tests/test_event_envelope.py -q

audit-regression-gates:  ## 审计 §4 十二条主线防回归门禁（W13 十条 + 前端软底徽标对比度/设计令牌策略 + RLS 裁决清单）
	@echo '── 主线1 租户隔离：org 表查询链静态扫描（audit-org-predicates）'
	@node scripts/audit-org-predicates.js
	@echo '── 主线2 边缘 GET 面鉴权：路由清单完整性 + production 匿名 401 TCK'
	PYTHONPATH=src $(PYTHON) -m pytest src/edge_platform/tests/test_get_route_auth_matrix.py -q
	@echo '── 主线3 SSRF：出站凭据/地址请求体键名白名单比对（audit-ssrf-surface）'
	@node scripts/audit-ssrf-surface.js
	@echo '── 主线4 前端 XSS/凭据：storage 凭据 + href sink 扫描（audit-client-security-sinks）'
	@node scripts/audit-client-security-sinks.js
	@echo '── 主线5 迁移链：全新库可安装顺序校验（默认静态；设 EWOH_PG_URL 启用真实空库执行）'
	bash scripts/migration-fresh-install-check.sh
	@echo '── 主线6 门禁自测：canonical ID 正则向量 + truth-manifest 缺 baseline fail（Jest）'
	cd ewoh-spark-app && npx jest --silent test/unit/scripts/gate-scripts.selftest.spec.ts
	@echo '── 主线7 调度事务边界：persistPlan 调用点 + 关键链路清单（audit-scheduler-transactions）'
	@node scripts/audit-scheduler-transactions.js
	@echo '── 主线8 契约漂移：TS↔Python parity 全共享契约（pytest 门禁，复用既有测试）'
	PYTHONPATH=src $(PYTHON) -m pytest tests/test_ts_python_contract_parity.py -q
	@echo '── 主线9 状态机 role 约束：yaml↔TS 锁定表双向一致 TCK（audit-state-machine-roles）'
	@node scripts/audit-state-machine-roles.js
	@echo '── 主线10 演示/伪造残留：grep 白名单登记制扫描（audit-demo-residue）'
	@node scripts/audit-demo-residue.js
	@echo '── 主线11 前端软底徽标对比度：WCAG 2.2 AA ≥4.5:1 数值模型 + 软底文字令牌策略（Jest）'
	cd ewoh-spark-app && npx jest --config client/jest.config.cjs --runInBand src/lib/softSurfaceContrast.test.ts
	@echo '── 主线12 RLS 裁决：含 org_id 却未开 RLS 的表必须在显式裁决清单内（audit-unrls-tenant-tables）' && node scripts/audit-unrls-tenant-tables.js
	@echo '✅ audit-regression-gates：十二条主线门禁全部通过'

production-smoke:  ## P0-EDGE-006：Production Runtime Assembly 门禁（真实装配 + no-stub + Bus 契约）
	PYTHONPATH=src $(PYTHON) -m pytest tests/test_production_assembly.py tests/test_bus_contract.py -q

connector-tck:  ## 运行连接器 TCK（Manifest/配置/健康/脱敏/乱序补传）
	PYTHONPATH=src $(PYTHON) scripts/connector-tck.py

aas-tck:  ## 运行 AAS/IEC 63278 编解码 TCK（JSON/AASX/映射/脱敏）
	PYTHONPATH=src $(PYTHON) scripts/aas-tck.py

rego-tck:  ## 运行 Rego 策略即代码 TCK（部署门禁）
	PYTHONPATH=src $(PYTHON) scripts/rego-tck.py

pilot-readiness:  ## 运行 Pilot 就绪检查（Go/No-Go 门禁）
	bash scripts/pilot-readiness-check.sh

cross-tenant-tck:  ## 运行跨租户全链 TCK（需 E2E 数据库环境）
	bash scripts/cross-tenant-tck.sh

lint:  ## 静态检查（ruff，不修改代码）
	ruff check src/edge_platform

lint-fix:  ## 自动修复可修复的 lint 问题（import 排序等）
	ruff check --fix src/edge_platform

# 安全扫描解释器：bandit 1.8.6 在 Python 3.14 上无法解析任何文件（见 requirements-dev.txt）。
# 若存在 .venv-security（uv venv .venv-security --python 3.12 && uv pip install --python
# .venv-security/bin/python bandit==1.8.6），优先用它；否则回退 $(PYTHON) 并由门禁
# 如实报错（未扫描=失败，绝不假装通过）。
BANDIT_PYTHON ?= $(shell test -x .venv-security/bin/python && echo .venv-security/bin/python || echo $(PYTHON))

security:  ## 静态安全扫描门禁（bandit JSON → scripts/bandit-gate.py；未扫描=失败）
	@mkdir -p output
	@$(BANDIT_PYTHON) -m bandit -r src/edge_platform -ll -f json -o output/bandit-report.json --exit-zero
	@$(PYTHON) scripts/bandit-gate.py output/bandit-report.json

truth-check:  ## 生成并列示单一事实源证据清单（无漂移，P0 门禁）
	@node scripts/truth-manifest.js --out output/evidence-manifest.json
	@node scripts/truth-manifest.js --check --out output/evidence-manifest.json
	@node scripts/audit-repo-facts.js --strict
	@node scripts/audit-identity-contracts.js
	@node scripts/audit-domain-contracts.js
	@node scripts/audit-event-envelope.js
	@node scripts/gen-contract-registries.js --check

format:  ## 代码格式化（ruff format）
	ruff format src/edge_platform

clean:  ## 清理构建产物与临时文件
	find . -type d -name __pycache__ -prune -exec rm -rf {} +
	find . -type f -name '*.pyc' -delete
	rm -f src/edge_platform/demo.db ./demo.db
	rm -rf logs .pytest_cache .ruff_cache
