# EWOH 受控试点系统 - 常用命令
# 用法：make <target>   例如 make test / make lint / make run
# 开发环境推荐以进程方式运行（make run），docker-compose 用于试点部署。
# 代码采用 src/ 布局，运行入口通过 PYTHONPATH=src 解析 edge_platform 包。

.PHONY: run run-stub demo scenario-reset capability-drift e2e-golden e2e-receipt e2e-wave e2e-learning e2e-learning-signal e2e-improvement-action e2e-perception-fusion e2e-control-actuator e2e-agv-transport e2e-plan-staleness e2e-chain e2e-edge browser-real e2e-closed-loop test test-contract production-smoke connector-tck aas-tck rego-tck cross-tenant-tck contract-identity contract-domain contract-golden contract-envelope audit-regression-gates unit-triage pilot-readiness lint lint-fix security format clean help chain-baseline-attribution-shadow chain-baseline-bg-context chain-baseline-d-bucket-collision chain-baseline-verify-wiring chain-baseline-verify-teeth chain-baseline-projection-consistency chain-baseline-context-forwarding chain-baseline-change-amplification chain-baseline-import-closure chain-baseline-instrument-readers chain-baseline-doc-face chain-baseline-preflight chain-baseline-freshness-scope chain-baseline-alias-sync

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
e2e-receipt-fresh:  ## NO-99a：清库后全路径复验 receipt（隔离重置 → receipt）
	@if [ ! -f /tmp/ewoh-e2e-env.sh ]; then echo "缺凭证：先准备 /tmp/ewoh-e2e-env.sh（runbook 模板）"; exit 2; fi
	set -a && . /tmp/ewoh-e2e-env.sh && set +a; \
	bash scripts/e2e-chain.sh --scenario e2e:receipt

e2e-agv-fresh:  ## NO-99a：清库后全路径复验 agv-transport（隔离重置 → agv）
	@if [ ! -f /tmp/ewoh-e2e-env.sh ]; then echo "缺凭证：先准备 /tmp/ewoh-e2e-env.sh（runbook 模板）"; exit 2; fi
	set -a && . /tmp/ewoh-e2e-env.sh && set +a; \
	bash scripts/e2e-chain.sh --scenario e2e:agv-transport

e2e-golden-fresh:  ## NO-87a：清库后全路径复验 golden（隔离重置 → gate → activate → rollback）
	@if [ -f /tmp/ewoh-e2e-env.sh ]; then \
	  set -a && . /tmp/ewoh-e2e-env.sh && set +a; \
	else \
	  echo "缺凭证：请先准备 /tmp/ewoh-e2e-env.sh（模板见 runbook『E2E 凭证的角色分工』）"; exit 2; \
	fi; \
	bash scripts/e2e-chain.sh --scenario e2e:golden

e2e-fault-replan:  ## 全闭环验收：感知/质量/决策/授权/执行/反馈/回滚/复盘/班次
	cd ewoh-spark-app && npm run e2e:fault-replan

test:  ## 运行 unittest 测试套件
	$(PYTHON) -m unittest discover -s src/edge_platform/tests -v

test-contract:  ## 运行契约测试（tests/，需 pytest；也可用 unittest 运行）
	PYTHONPATH=src $(PYTHON) -m pytest tests/ -q

# CI-01：pytest 对跳过的用例退出码仍为 0，因此「跳过」会被读成「通过」。
# test-gated 把每一次跳过与 tests/ci-skip-baseline.txt 逐条比对（基线只允许缩小），
# 并保留 pytest 自身的退出码：测试失败仍以 pytest 的 rc 失败，不被门禁结果掩盖。
# 覆盖范围为 pytest -rs 口径；`make test`（unittest discover）的 skip 不在棘轮内，
# 同一批用例在 pytest 侧已被门禁覆盖。
PYTEST_GATED_TARGETS ?= src/edge_platform tests tools

.PHONY: test-gated
test-gated:  ## CI-01 门禁：跑 pytest 目标并强制每次跳过都已登记（skip≠pass）
	@out="$$(mktemp)"; \
	PYTHONPATH=src $(PYTHON) -m pytest -q -rs $(PYTEST_GATED_TARGETS) > "$$out" 2>&1; rc=$$?; \
	cat "$$out"; \
	$(PYTHON) scripts/assert-test-skips.py --baseline tests/ci-skip-baseline.txt --input "$$out"; gate=$$?; \
	rm -f "$$out"; \
	if [ $$rc -ne 0 ]; then exit $$rc; fi; \
	exit $$gate

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

audit-regression-gates:  ## 审计 §4 防回归门禁（二十七条主线，条数以「── 主线」现抽核对：W13 十条 + 前端令牌 + RLS 裁决 + 世界快照契约 + 无事务读清单 + 重放自检分类 + 边缘进程隔离守卫 + 全量单测归因判据自测 + D 段判据自测与守卫变异 + 用例存量对账判据自测 + CI e2e 前提链跳线自测 + 已闭修法位点自测 + 门禁主线负向控制覆盖度量 + 定时器清场可达性棘轮 + 停止路径钩子分发对照 + 事务边界影子两面差）
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
	@echo '── 主线7 调度事务边界：persistPlan 调用点 + 关键链路清单 + run 终态单一写者（audit-scheduler-transactions）'
	@node scripts/audit-scheduler-transactions.js
	@node scripts/tx-scope-shared.js --self-test
	@node scripts/audit-scheduler-transactions.js --self-test
	@echo '── 主线8 契约漂移：TS↔Python parity 全共享契约（pytest 门禁，复用既有测试）'
	PYTHONPATH=src $(PYTHON) -m pytest tests/test_ts_python_contract_parity.py -q
	@echo '── 主线9 状态机 role 约束 + 写入侧对账：yaml↔TS 双向一致、词表/位点/谓词强度三条棘轮（audit-state-machine-roles）' && node scripts/audit-state-machine-roles.js
	@node scripts/audit-state-machine-roles.js --self-test
	@echo '── 主线10 演示/伪造残留：grep 白名单登记制扫描（audit-demo-residue）'
	@node scripts/audit-demo-residue.js
	@echo '── 主线11 前端软底徽标对比度：WCAG 2.2 AA ≥4.5:1 数值模型 + 软底文字令牌策略（Jest）'
	cd ewoh-spark-app && npx jest --config client/jest.config.cjs --runInBand src/lib/softSurfaceContrast.test.ts
	@echo '── 主线12 RLS 裁决：含 org_id 却未开 RLS 的表必须在显式裁决清单内（audit-unrls-tenant-tables）' && node scripts/audit-unrls-tenant-tables.js
	@echo '── 主线13 世界快照契约：最近持久化快照 entityVersions/自检违约（audit-world-snapshot-contract）' && node scripts/audit-world-snapshot-contract.js
	@echo '── 主线14 身份前/守卫阶段无事务读清单：@Public 可达数据库 + 守卫用句柄，只许缩小的登记面（audit-public-tx-free-reads，CFG-01b 静态面）' && node scripts/audit-public-tx-free-reads.js
	@node scripts/audit-public-tx-free-reads.js --self-test
	@echo '── 主线15 重放环境自检的分类逻辑：四态可分辨 + 空目录不得判成可用 + 水合缺失判 broken（DEP-01 可诊断化，不含主机断言）' && bash scripts/chain-baseline/doctor.sh --self-test
	@echo '── 主线16 边缘测试进程隔离守卫：同进程可达的 run.main() 调用一律拒绝（TEST-01 棘轮，含"能变红"自检）' && PYTHONPATH=src $(PYTHON) -m pytest src/edge_platform/tests/test_run_main_process_isolation.py -q
	@echo '── 主线17 全量单测归因判据自测：失败必须点名、崩掉/空跑不得判成干净（FLAKE-01 可诊断化，不跑真实用例）' && bash scripts/chain-baseline/unit-triage.sh --self-test
	@echo '── 主线18 D/C 段判据自测 + 写入口扇出判据自测 + 形状暴露面镜像判据自测 + 守卫变异对照：0 passed、空汇总、退出 0 但零留痕都不得判成通过，拔掉承重守卫必须被抓；事实表键名解析不到 schema.ts 即"幽灵键"必须拒出数；镜像与门禁分母不符即"读数作废"必须拒出数（V110/V116/V123/V124，不跑真实用例）' && bash scripts/chain-baseline/verify.sh --self-test && node scripts/chain-baseline/schema-probe.mjs --self-test && node scripts/chain-baseline/write-fanout.cjs --self-test && node scripts/chain-baseline/gate-shape-exposure.cjs --self-test && bash scripts/chain-baseline/assert-criterion-mutation.sh
	@echo '── 主线19 链级 spec 用例存量对账判据自测：无守卫的 describe.skip（jest 汇总行不报 skipped）必须被抓，日志自身不一致判"不可判"（V110，用夹具不碰真实产物）' && node scripts/chain-baseline/spec-case-inventory.cjs --self-test
	@echo '── 主线20 CI e2e 前提链跳线自测：镜像落后于 helper、无守卫 skip、preflight 顺序失效、continue-on-error 都必须被抓；"镜像更严"方向必须不误报（V111，全夹具）' && node scripts/chain-baseline/ci-e2e-surface.cjs --self-test
	@echo '── 主线21 已闭修法↔常驻位点核验判据自测：假引用、位点被删、只剩文档措辞、CI-only 接线不误报都必须判对（V114，全夹具）' && node scripts/chain-baseline/fix-sites.cjs --self-test
	@echo '── 主线22 门禁主线自身的负向控制覆盖度量：夹具复制真实语料注入已知缺陷，逐条断言门禁会响（V115，只读仓库）'
	@node scripts/chain-baseline/gate-negative-control.cjs --self-check
	node scripts/chain-baseline/gate-negative-control.cjs
	@echo '── 主线23 已闭修法↔常驻位点真语料核验（V143）：真实登记册上每项已闭修法都必须有活位点（主线21 只跑夹具自测，这条跑真实语料；它体内第一步就是 --self-test）' && make chain-baseline-fix-sites
	@echo '── 主线27 事务边界影子判据（V148）：persistPlan 调用点的结构判据与文本判据两面差都必须为 0（漏判=假绿，误伤=收紧代价；它体内第一步就是 --self-test）' && make chain-baseline-tx-boundary-shadow
	@echo '── 主线25 定时器清场可达性普查（V147）：清场代码写在真钩子/可达方法上吗（死钩子、无清理、env 间隔无守卫三条棘轮；权威名单解析自本机 @nestjs/core，它体内第一步就是 --self-test）' && make chain-baseline-worker-timer-census
	@echo '── 主线26 停止路径探针（V147）：close() 与 SIGTERM 两条路径的钩子分发必须反向（B 案不开火、C 案开火），且拼错的钩子名不得被调用（它体内第一步就是 --self-test）' && make chain-baseline-worker-shutdown-probe
	@echo '── 主线24 六场景矩阵逐格核对（V144）：30 格 = 28 实测 + 2 不适用、证据可解析，且每格证据的常驻档 T1/T2/T3 必须与实测格数闭合（它体内第一步就是 --self-test）' && make chain-baseline-matrix
	@echo '✅ audit-regression-gates：全部主线门禁通过（条数见上「主线总数（Makefile 现抽）」）'

unit-triage:  ## 全量后端单测（归档完整日志 + 失败用例名清单；退出码 0 干净 / 1 有失败 / 3 运行不健康）
	bash scripts/chain-baseline/unit-triage.sh

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

# ── 试点链行为基线（调度→审批→派工→执行→回执；见 docs/audit/current/chain-behavior-baseline.md）
.PHONY: chain-baseline-up chain-baseline-seed chain-baseline-rebuild chain-baseline-verify chain-baseline-down chain-baseline-doctor chain-baseline-doctor-selftest chain-baseline-matrix chain-baseline-client-drift chain-baseline-consistency chain-baseline-inventory chain-baseline-criterion-selftest chain-baseline-ci-surface chain-baseline-fix-sites chain-baseline-negative-control chain-baseline-write-fanout chain-baseline-shape-exposure chain-baseline-copy-census chain-baseline-contract-emitters chain-baseline-event-roles chain-baseline-event-payload chain-baseline-event-readside chain-baseline-instrument-surface chain-baseline-ledger-gap chain-baseline-refactor-backlog chain-baseline-backlog-premise chain-baseline-outbox-probe chain-baseline-worker-timer-census chain-baseline-worker-shutdown-probe chain-baseline-tx-boundary-shadow chain-baseline-ci-cost chain-baseline-contract-arrows chain-baseline-contract-arrow-evidence chain-baseline-status-write-guard chain-baseline-status-target-states chain-baseline-timing-census chain-baseline-optional-fallback chain-baseline-raw-status-writes chain-baseline-state-column-vocabulary chain-baseline-vocabulary-bindings chain-baseline-stored-vocabulary chain-baseline-promotion-readings chain-baseline-writer-drift-shadow
.PHONY: chain-baseline-dist-alias

chain-baseline-up:  ## 建/复用一次性 PostgreSQL（仓库自带 embedded 二进制，不依赖 Docker）
	bash scripts/chain-baseline/up.sh

chain-baseline-seed:  ## 装链基线库：迁移链 + 全量 verify + 种子 + 审批独立性账号
	bash scripts/chain-baseline/seed.sh

chain-baseline-rebuild:  ## 复位基线库（ENV-02/SEED-01）：默认 dry-run 只核三层护栏，REBUILD=1 才真的 DROP+CREATE
	bash scripts/chain-baseline/rebuild.sh $(if $(REBUILD),--yes,--check)

chain-baseline-verify:  ## 一键重放链级基线：全新链校验 + 约束层采集 + 7 场景 + 边界用例 + 边缘关停（WITH_SERVER=1 起后端）
	bash scripts/chain-baseline/verify.sh $(if $(WITH_SERVER),--with-server,) $(SCENARIOS)

chain-baseline-down:  ## 停止基线集群（保留数据目录）
	bash scripts/chain-baseline/down.sh

chain-baseline-matrix:  ## 六场景矩阵逐格核对（V109）：30 格 = 28 实测 + 2 不适用，且每格证据（用例号/spec/场景名）可解析；先跑判据自测
	@node scripts/chain-baseline/matrix-check.cjs --self-test | tail -1
	@node scripts/chain-baseline/matrix-check.cjs

chain-baseline-client-drift:  ## 读侧状态词表对账（V108）：前端硬编码状态字面量 vs 契约/执行面词表；先跑判据自测再扫真实代码
	@node scripts/chain-baseline/client-status-drift.cjs --strict
	@echo '── 上面是严格判据（命中需逐条人工判定，见基线 §5.3bc）；松判据的 71% 假正面率已量出并否决作为门禁'
	@node scripts/chain-baseline/client-status-drift.cjs --self-test >/dev/null && echo '── 判据自测 9/9 通过'

chain-baseline-preflight:  ## 记账前置校验：把**候选**的三份自述产物指向真一致性尺跑一遍（DIR=候选目录）；不过闸就不许安装
	@bash scripts/chain-baseline/recorder-preflight.sh "$(DIR)"

chain-baseline-consistency:  ## 登记册产物一致性自检：文档 §5.4 ↔ 状态件 ↔ CHAIN_SPECS ↔ Makefile/CI 四处对账 + 判据自测
	@node scripts/chain-baseline/artifact-consistency.cjs
	@python3 scripts/chain-baseline/artifact-consistency.selftest.py

chain-baseline-inventory:  ## 链级 spec 用例存量对账 + 断言强度普查（V110）：静态 it( ↔ 运行日志实到逐套件核，揪 jest 汇总行看不见的永久 skip
	@node scripts/chain-baseline/spec-case-inventory.cjs --self-test > /dev/null && echo '── 判据自测 6/6（1 正向 + 5 注入，注入均改变判决；日志自身不一致判"不可判"）'
	@node scripts/chain-baseline/spec-case-inventory.cjs --census

chain-baseline-fix-sites:  ## 已闭修法 ↔ 常驻防回归位点 逐项核验（V114）：位点只认在用例标题/主线/重放场景/入口四类活证据
	@node scripts/chain-baseline/fix-sites.cjs --self-test > /dev/null && echo '── 判据自测（条数由脚本自报；含 V115 B 类"两处都无接线"、V116 "文档提过不算位点"、V143 位点强度分档双向对照）'
	@node scripts/chain-baseline/fix-sites.cjs

chain-baseline-write-fanout:  ## 链上权威事实的写入口扇出对照（V120；V132 加全表横向刻度）：同一套写入侧判据跑 HEAD 与工作树，先跑判据自测（条数由计数器给出，含"幽灵键必须拒出数"），再用同一判据扫全部 93 张映射表出"链 vs 其余"刻度与推广机会清单
	@node scripts/chain-baseline/write-fanout.cjs --self-test
	node scripts/chain-baseline/write-fanout.cjs $(if $(AGAINST),--against $(AGAINST),)
	@node scripts/chain-baseline/write-fanout.cjs --all-tables

chain-baseline-raw-status-writes:  ## 裸 SQL 状态列写入面普查（V281 立，只出读数、**未接**共享门禁主线）：回答"两把 AST 守卫尺看不见的那一面有多大"。四档永不合并（literal／parameter／dynamic＝解不开单列／not-state 照量不算写者），归属按路径四桶＋unattributed 兜底；三条恒等式（Σ四档／Σ归属／站点＋弃档＝`update` 候选词数）任一不成立即"读数作废"非零退出；语料根缺失或遮罩器判畸形走退出码 2（拒出数，不静默读 0）；注释与文档块先遮罩且逐处留痕。判据自测条数由脚本自报，本行不冻结它
	@node scripts/chain-baseline/raw-status-writes.cjs --self-test
	node scripts/chain-baseline/raw-status-writes.cjs

chain-baseline-shape-exposure:  ## 主线1 租户隔离门禁的"形状暴露面"镜像度量（V124）：先跑 7 项判据自测，再分档计数四类门禁看不见的写法，并把镜像分母与门禁自报分母对账（不符即读数作废）
	@node scripts/chain-baseline/gate-shape-exposure.cjs --self-test
	node scripts/chain-baseline/gate-shape-exposure.cjs

chain-baseline-contract-emitters:  ## 契约事件发射方普查（V133）：先跑 11 项判据自测（词边界 + 三种身份），再出 70 条声明的分桶、落桶对账与「无人构造」候选清单（读数纪律见脚本头；"有没有构造点"以 chain-baseline-event-roles 为准）
	@node scripts/chain-baseline/contract-emitters.cjs --self-test
	node scripts/chain-baseline/contract-emitters.cjs

chain-baseline-event-roles:  ## 契约事件角色普查（V135）：70 条声明逐条定性（构造/注册/消费/注释/manifest/测试）+ 反向"有构造点但未登记"清单；11 条正向对照不过则不出数
	python3 scripts/chain-baseline/event-roles.py

chain-baseline-instrument-surface:  ## 量具执行面清点（V140 建；V347 把分母改成 Makefile 现抽）：分母＝`^chain-baseline-*` 目标 − 逐条带理由的生命周期豁免 ＋ 前缀外入口（三个数都由脚本自报）；报哪些真被 CI 调、哪些只有人手敲 make 才跑；「豁免吞量具／豁免过期／两头挂／归错表／桶不闭合」任一成立即退 2（正向对照认得 audit-regression-gates，认不出则"无人跑"全不可信）
	node scripts/chain-baseline/instrument-surface.cjs --self-test
	node scripts/chain-baseline/instrument-surface.cjs

chain-baseline-dist-alias:  ## 服务端产物裸别名检查（V356 建，ARUN-01 的常驻判据位点）：把 verify.sh rebuild 档那道「陈旧 dist 冒充已重建」的自检搬成可 require 的件——扫描 dist/server 的 .js 里残留的裸 `@(server|shared|client)/*` 导入；整行/块注释不算命中（V356 实测文本面提及会假阳性），目录读不到判不可判并按非零退出（不折成干净）
	node scripts/chain-baseline/dist-alias-check.cjs --self-test
	node scripts/chain-baseline/dist-alias-check.cjs ewoh-spark-app/dist/server

chain-baseline-ledger-gap:  ## 审计覆盖账本 ↔ 磁盘现扫 的双向差集（V346，AUDLEDGER-01 的读数面）：现扫总体只向 audit-file-ledger.js 的只读子命令 paths 取（同一条枚举器两个消费者），报未入账／幽灵行／旧内容审阅三个方向，并与 stats 行逐字自证；取不到一律退 3 不折算成"一致"（判据自测条数由脚本自报）
	node scripts/chain-baseline/ledger-gap.cjs --self-test
	node scripts/chain-baseline/ledger-gap.cjs

chain-baseline-refactor-backlog:  ## 重构事项四源对账（V353 建，BACKLOGRE-01 的读数面）：登记册 §5.4 表切片与编号形状**复用** artifact-consistency 的同一判据（两套边界会把 185 行读成 71/470）；现扫总体只向 audit-file-ledger.js 的只读子命令 paths 取；判重必须两轴齐（同一文件 ＋ 至少一个语料内出现 ≤2 行的主题名），只共享热点文件算歧义不算重复；路径先剥后抽符号（带点文件名截断会让 server/scheduler 冒充判别符号）；引用落点用 AST 判符号，只有"唯一候选＋行号超出真实行数"才判红，缩写/重名/自测合成夹具名一律不判红；§5.4 切片取不到退 3 不折成零行（判据自测条数由脚本自报）
	node scripts/chain-baseline/refactor-backlog-reconcile.cjs --self-test
	node scripts/chain-baseline/refactor-backlog-reconcile.cjs

chain-baseline-backlog-premise:  ## 重构前置的在线核数（V353 建，BACKLOGPREM-01 的读数面）：A3 跨租户用**运行角色**双臂实测（owner 会绕过 RLS，用它测等于什么都测不到）＋注入式正向对照（locks 两个 org 各注入、他 org 必须读 0、清理后残留必须 0，否则整批"读 0 行"降级为不可信）＋A5 的 resource_type 值域对契约注册表比（词表取自 contracts/resource/resource.schema.json#resourceTypeRegistry.const，不手抄实现 WHERE）。七档租户面互斥＋值域四态，取不到连接/表缺/词表解析不到一律不可判。--run 需先 source tmp/chain-baseline/env.sh（判据自测条数由脚本自报）
	node scripts/chain-baseline/backlog-premise-probe.cjs --self-test
	node scripts/chain-baseline/backlog-premise-probe.cjs --run

chain-baseline-ci-cost:  ## 试点量具接 CI 的代价实测（V149）：逐件真跑 make <target>（链级集群关掉、不装依赖），按输出签名分五桶 ready/needs-db/needs-dep/failed/not-measured；分桶恒等式不成立即拒出数（不接成主线：它会双跑其它量具）。目标名单不手抄——V348（CCOST-01）起向执行面尺的 analyze() 现抽，两侧不同名即拒出数（判据自测条数由脚本自报）
	node scripts/chain-baseline/ci-onboarding-cost.cjs --self-test
	node scripts/chain-baseline/ci-onboarding-cost.cjs

chain-baseline-contract-arrow-evidence:  ## 契约箭头↔常驻用例对账（V153）：每条 from→to 在用例面上分四档（condition 专有名／来源+目标同现／只有目标态／完全无证据）；先跑 6 项判据自测。pair-in-file 不证明走过这条边，none 逐条人工确认
	node scripts/chain-baseline/contract-arrow-evidence.cjs --self-test
	node scripts/chain-baseline/contract-arrow-evidence.cjs
chain-baseline-status-write-guard:  ## 权威状态写入口的守卫强度普查（V157）：只看 set 侧确实写 status/state 的 UPDATE，按 AST 判 guard 形状（state-guard／identity-only／dynamic-where／no-where）；先跑 8 类形状自测 + 三处已知答案校准（V155/V156/V79），校准不符即 rc=1（本轮不出数不接成主线：判据只有一轮读数）
	node scripts/chain-baseline/status-write-guard-census.cjs --self-test
	node scripts/chain-baseline/status-write-guard-census.cjs
chain-baseline-status-target-states:  ## 权威表"代码能写出的目标态集合"前后对照（V159）：直接 set 字面量 + 顶层入口的调用侧 patch；非字面量/看不见的单列不折算；--against 读旧树（git show，不落盘）；自测条数由脚本自报（V296 起含"被调函数 return 字面量"一档的五支极性控制）
	node scripts/chain-baseline/status-target-states.cjs --self-test
	node scripts/chain-baseline/status-target-states.cjs
chain-baseline-state-column-vocabulary:  ## 越词表状态列写者对账（V296）：只答一句"全仓被 UPDATE 写过取值的状态列里，哪些不在守卫尺／扇出尺的 ['status','state'] 词表上、它们有没有来源态守卫"；独立解析 schema.ts＋set 顶层键，并与 write-fanout 的 FACTS 逐表对账（对不上即读数作废 rc=2）；三态：不可判 rc=3／探针不开火（词表内侧 0 处）rc=2／未守卫 0 处才 rc=0；判据自测条数由脚本自报；**未接进共享门禁**（接不接属 R15 待裁），因此它的自测与读数不在 CI 执行面上
	node scripts/chain-baseline/state-column-vocabulary.cjs --self-test
	node scripts/chain-baseline/state-column-vocabulary.cjs
chain-baseline-condition-labels:  ## 契约 `condition` 标签↔实现对应物的代价尺与裁决面（V330 建、V331 把分类搬进契约、V332 把对应物也搬进契约，CNAM-01）：只答一句"动作类箭头在实现侧到底有没有着落"。七档 Σ=分母硬断言（action-resolved／action-resolved-writer／action-unimplemented／action-dangling／guard／kind-missing／kind-invalid）；kind 缺声明或非法退 6，**dangling 非空退 8**。两根事实源都在契约里：`kind:` 定分类（词形启发式只在缺声明时作建议打印，不参与定档），`writer: 路径#标识符` 定实现侧对应物——裸标识符一律不认（实测 `process`／`simulate`／`cancel` 会被语料里同名无关符号顶开，造成假归因），`unimplemented` 是显式声明"这条边没人实现"、单列一档。欠账报两根口径：全实现语料（含 `src/edge_platform`）与只云侧（V331 的历史口径），差值就是"只在边缘实现"的那几支。判据自测条数由脚本自报（真语料 5 条＋夹具若干，含"文件在但标识符不在"与裸标识符两种必须开火、"声明与词形矛盾不得再报"这一必须不开火），自测不过即不出数。**未接进共享门禁**（CLBL-01：分类与对应物两边都已进制品，剩"接不接、接到哪档"这条动严度问题，按本仓纪律不代拍）
	node scripts/chain-baseline/contract-condition-labels.cjs --self-test
	node scripts/chain-baseline/contract-condition-labels.cjs
chain-baseline-vocabulary-bindings:  ## 状态词表的"表↔词表↔级别"归属复算（V313 起三面、V314 补第四面·WDRV-01 的机器面）：对每张链上写过状态、且 schema 里有 status/state 列的表，同时摆出四面——迁移里的 `CHECK (<col> IN …)`（库强制的那份，跨迁移取最后一个定义、DROP 在后即解除、rollback 不参与）、契约 `states:`（按集合覆盖推导，并列即判 ambiguous 不乱挑）、链上代码可写集合、`ewoh-spark-app/shared/` 的字面量联合（命名规则命中记 ts_type＝强认领；"容得下该表全部可写值"的联合只进取值面＝弱认领，含 export interface 的字段级内联联合；client/ 下的同名 union 是界面镜像不计入）；每行给 db_vs_contract（equals／narrower／has-extra／no-contract-binding／db-shape-unreadable／no-db-check）、code_outside_db／db_not_written、ts_outside_type／ts_value_superset_types／ts_exact_value_match 各面差集；**第三根轴＝自述归属（V316）**：contract_authors 逐字取契约自己写的 `authority_table:`（文件名#顶层块名＋authority_type／行尾分片注释），chosen_self_declared 只答"覆盖率挑中那份有没有把本表写成它的权威表"，其他自述方独有的态进 other_author_states、其中把「词表缺」接住的那部分进 missing_claimed_by_other_author（＝假缺口点名）——这一轴**只点名，任何一档已知词表都不并入**（一份契约自述的是本列的某个分片，并集会替不属那个分片的行消音）；总账 summary 一处叙述（`sent`／`proposed` 这类欠词只在这里点名一次）。常驻位点＝test/unit/chain-baseline/vocabulary-bindings.spec.ts（含三面极性、第四面两根轴与"删掉包装必须翻红"的反向对照；用例数以该文件现抽为准）；本 target 只判产物与事实是否一致（--check，漂移即 rc=2），不代写文件；改规则请改生成器后重生成。**未接进共享门禁**（接不接属 R15 待裁）
	node scripts/chain-baseline/gen-vocabulary-bindings.cjs --check
chain-baseline-stored-vocabulary:  ## 存量取值↔词表三档判据（V314）：链基线库里每张链上表的 status/state 列，把 DDL 默认值与实有取值分别对三档已知词表判——三面（V313：可写∪CHECK∪契约）／强四面（∪命名规则命中的 shared/ 联合）／弱四面（∪"容得下该表全部可写值"的联合）；F1＝默认值在本档外、F2＝存量值在本档外、F3＝0 行不可判、OK-strict＝NOT NULL 无默认。同一份读数一次跑完逐格对齐，输出"消音梯"（每一格到哪一档才不红），只报最宽那档即读数作废；红的存量值若只被**另一份自述方**（契约自述的 authority_table，V316 第三根轴）的词表持有，逐格打「分片归属」点名并写明判语仍红——不折成"已认领"；加 `--by-shard` 那档再按 event_type 把整列读数切到群体上（分片键逐字取契约的 authority_type／行尾注释，不解析成 SQL；只归因不替换判语）。判据自测条数由脚本自报、不在这里冻结，自测不过即不出数；集群未起退 3＝不可判（不是"没有缺陷"）。**只读**，且未接进共享门禁
	node scripts/chain-baseline/probe-stored-state-vocabulary.mjs --self-test
	node scripts/chain-baseline/probe-stored-state-vocabulary.mjs
chain-baseline-promotion-readings:  ## 推广三判据的唯一复算入口出数（V309 建、V315 把轴②接回绑定件、V316 补本目标）：轴①维护成本＝"有状态列的权威表能读出非空可写集合"的表数（三种成因分开：无状态列／有列无写点／有写点集合读不出），轴②业务语义＝逐张表的 契约声明↔链上可写 双向差集，**词表归属读 `scripts/chain-baseline/status-vocabulary-bindings.json`**、手挂 FACTS 只当分母口径与不可判档的诊断退回位（不可判四档：并列词表／库否证主体／覆盖不足／无可对词表，既不折成"没缺口"也不折成违规），轴③恢复能力＝收敛尺汇总行＋《基线》18 格两口径现算。本 target **只出读数、不改严度**（未接进 audit-regression-gates 的共享主线），任一轴分母为 0 即退 3＝判据不可判（不是"没问题"）；常驻位点＝test/unit/chain-baseline/promotion-readings.spec.ts（编号 PRD-01，用例数以该文件现抽为准）
	node scripts/chain-baseline/promotion-readings.cjs
chain-baseline-timing-census:  ## 运气常数／固定 sleep 窗口普查（V182·FLAKE-04，V198 补轴 C·FLAKE-06）：CHAIN_SPECS 分母由 verify.sh 现抽，扫"断言成立与否取决于跑了多少墙上时间"的形状——轴A 时间量比较按阈值分桶（bare-literal／derived／named-bound／sign-zero），轴B 用例体内固定 sleep 分（fixed-settle／bounded-poll），轴C 把 fixed-settle 再切：同块内该 sleep **之后**出现 terminate/kill/SIGKILL/SIGTERM ⇒ bet-window（押注重叠）；宽词形 close()/end() 与"sleep 是否在循环体内"两档**只观察不改判**（前者实测会把 15 处里的 10 处误判，后者会放走改前那条真押注）；分桶是启发式不是裁决，逐条读码定运气常数／语义必需；先跑本件自带的判据自测（条数由脚本自己打印，不在这里冻结），不过即不出数；按 V182 同口径不接成共享门禁主线（读数用于收窄 FLAKE-04/06，非产品回归）
	node scripts/chain-baseline/timing-assertion-census.cjs --self-test
	node scripts/chain-baseline/timing-assertion-census.cjs
chain-baseline-rejection-exposure:  ## 未授予处理的 rejection 暴露面普查（V197·CRASH-02）：服务端源文件里「语句位调用 async／Promise，既没 await/return 承接也没有 .catch」的位点，四档判 exposed／handled-internally（体内每个 await 都落在不重抛的 try 里）／unknown-callee（跨文件求不到定义＝看不见，不折成违规）／sync-seen；只数「位点存在」，不证明某次真实崩溃出自哪一位；先跑本件自带的判据自测（条数由脚本自己打印，不在这里冻结），不过即不出数；按 FLAKE-04／FLAKE-06 同口径不接成共享门禁主线
	node scripts/chain-baseline/unhandled-rejection-exposure.cjs --self-test
	node scripts/chain-baseline/unhandled-rejection-exposure.cjs

chain-baseline-attribution-shadow:  ## 修法位点「小节归属」两档并排对账（V186·GATE-23）：旧档 loose／新档 entry，逐点位点差集与判决翻转清单；只读数不改判据
	node scripts/chain-baseline/attribution-shadow.cjs --self-test
	node scripts/chain-baseline/attribution-shadow.cjs

chain-baseline-writer-drift-shadow:  ## 主线9「词表↔写者」漂移判据的**外推代价**影子档（V319，只出读数、未接共享门禁）：把「代码写入的词 −（挑中的）契约声明的词」这条判据从今天的 2 张表（plan.yaml↔ewohSchedulePlan、control.yaml↔ewohControlCommand）外推到绑定件自报的全部表，三档并排——contract＝绑定件挑中那份契约的 states、face4＝`ewoh-spark-app/shared/` 的 TS 字面量联合（非精确同值与多份合并各自标注）、author＝改由"自己写了本表"的那份契约供声明侧；读数含 可判／不可判·无取词／不可判·无声明侧 三档加总、新表欠账按「归属可信／可疑／无证据」分桶、face4 可救的表与 author 档掉进不可判的表各自点名。三件硬校准：K1 复刻必须与 `node scripts/audit-state-machine-roles.js --report-drift` 逐字同源、K2 外推不许改动两张既有表的判决、K3 加总等于绑定件自报表数——K1/K2 不符 rc=1，K3 不齐 rc=2（读数作废），绑定件或真门禁读不到 rc=3（不可判，不折成"没问题"）；判据自测 11 支（每条判据都配"必须报"与"必须不报"两侧，条数由脚本自报，勿在此冻结）
	node scripts/chain-baseline/writer-drift-shadow.cjs --self-test
	node scripts/chain-baseline/writer-drift-shadow.cjs

chain-baseline-freshness:  ## 重放新鲜度对账（V181）：今天的工作树是否被最近一次全量重放覆盖——分母现算（CHAIN_SPECS＋场景脚本＋七个目录桶＋spec-dep 闭包桶〔V321，常驻 spec/场景脚本沿相对 import 递归可达、既有桶没盖住的那批〕），逐文件内容 sha256 比 stamp；无证据判不可判，绝不读成通过
	node scripts/chain-baseline/replay-freshness.cjs --self-test
	node scripts/chain-baseline/replay-freshness.cjs

chain-baseline-freshness-mint:  ## 全量重放跑绿后铸造新鲜度 stamp（V181）：把覆盖范围内每个文件的内容哈希与 HEAD 记进 tmp/chain-baseline/replay-stamp.json
	node scripts/chain-baseline/replay-freshness.cjs --mint

chain-baseline-freshness-scope:  ## 新鲜度分母的明细（V321/COVSET-01）：逐桶给数，并列出 spec-dep 桶里每个文件是被哪支常驻 spec/场景脚本载入的；判据自测条数由脚本自报
	node scripts/chain-baseline/replay-freshness.cjs --self-test
	node scripts/chain-baseline/replay-freshness.cjs --explain-scope



chain-baseline-contract-arrows:  ## 契约箭头↔写入位点对账（V152）：contracts/state-machines 每条 from→to 分六档（同文件里有来源线索／只写目标态／从不写／伪来源／目标未声明），先跑 8 项判据自测；guard 档只证明同文件同现、不证明 CAS
	node scripts/chain-baseline/contract-arrows.cjs --self-test
	node scripts/chain-baseline/contract-arrows.cjs

chain-baseline-tx-boundary-shadow:  ## 事务边界影子判据（V148）：结构上（AST）逐点重判 persistPlan 调用点，与主线7 的文本判据双向对账（漏判面/误伤面各一条棘轮）；只测不改代码、不放宽任何现有门禁
	node scripts/chain-baseline/tx-boundary-shadow.cjs --self-test
	node scripts/chain-baseline/tx-boundary-shadow.cjs

chain-baseline-worker-timer-census:  ## 定时器清场可达性普查（V147）：12 个 setInterval 站点的 clearInterval 写在哪个成员上、那个成员是否真被框架调用（名单解析自本机 @nestjs/core）；三条判据都是"只许缩小"的棘轮（先跑 7 项自测）
	node scripts/chain-baseline/worker-timer-census.cjs --self-test
	node scripts/chain-baseline/worker-timer-census.cjs

chain-baseline-bg-context:  ## 后台周期任务的数据库上下文判据（V208 候选，只出读数、不接共享门禁）：分母＝服务端 setInterval 站点；沿调用路径（含 DI 跨文件、上下文由调用方建立所以 inTx 要向下继承）找 DB 触点，按 ctx-tx／definer-fn／own-pool／no-db 四形态定档，解不开的单列 indeterminate；red＝碰着 RLS 表且三形态都不成立。V208 那 5 处假 red 的盲点已在 V210 修掉（二跳包装跟随／库侧 RLS 事实新档 bare-nonrls-only／import 与数组成员与形参回调的噪声分诊），当期读数（V218）1 red、1 indeterminate，red 那条已四臂实测定档为 EXPCTX-01，其触点面 7 处（4 处直读＋3 处经同文件注册表并集）；判据自测条数由脚本自报
	node scripts/chain-baseline/bg-task-db-context.cjs --self-test
	node scripts/chain-baseline/bg-task-db-context.cjs --self-test --reading --report-only

chain-baseline-optional-fallback:  ## @Optional() 兜底暴露面普查（V211，只出读数、不接共享门禁）：分母＝产品码里的 @Optional() 注入点，按少装配时走哪条路分八档（fail-closed／skip-path／mixed／default-value／delegated／alt-impl／silent-degrade／unknown，档位加总由脚本硬断言等于分母）；再沿静态装配图（本模块 providers ∪ @Global providers ∪ 被 import 模块 exports）找「本地重提供了带内存兜底的消费者、持久依赖却不可达」的 EXPOSED 点，图解析不到时降级成不可判而不是放行。V213 读数 82 点／65 模块、EXPOSED 0 处、silent-degrade 2 处、mixed 16 处、unknown 0 处（见登记册 §5.3fk 与 §5.3fm）；判据自测条数由脚本自报
	node scripts/chain-baseline/optional-fallback-exposure.cjs --self-test
	node scripts/chain-baseline/optional-fallback-exposure.cjs

chain-baseline-d-bucket-collision:  ## D 桶"被他人未提交挡住"的 hunk 级复核（V217，只出读数）：分母＝登记册 §6.2 D 桶条目列现算，落点取自 .codex/artifacts/d-bucket-fix-sites.json（按 needle 定位，行号一律按当前树现取），脏块取 `git diff -U0` 的新行段；四档 collision／discipline（零重叠，附最近边界距离）／premise-gone（该文件已不脏）／indeterminate（needle 读不到或不唯一），加总由脚本硬断言等于分母，落点清单与 D 桶不同步即非零退出。当期读数 5 行＝1 collision（F-18）／3 discipline／1 premise-gone（见登记册 §5.3fr）；判据自测条数由脚本自报
	node scripts/chain-baseline/d-bucket-collision.cjs --self-test
	node scripts/chain-baseline/d-bucket-collision.cjs

chain-baseline-verify-wiring:  ## 一键重放 A 段「verify N/N PASS」的接线判据（V220，只出读数、未接共享门禁）：分母＝runner 的 EXECUTE_COMMANDS 里 --verify-standalone* 那一筛（与 A 段同源），逐命令按 runner 自己的三张登记面定档 wired-simple／wired-branch／hole（只有 apply 兜底映射接住＝会被静默记成 PASS）／unwired，加总硬断言等于分母，另单列「表驱动与兜底映射双写」的潜伏面；判据自测与注入反证的条数由脚本自报。--inject 档需在隔离集群上另给 EWOH_KEEP_URL（本轮自建的 ewoh_chain_check_<pid>，绝不指链基线库），在临时覆盖树里造一次真回归／一次基线吸收／一次 FIXED 提示／一次 apply 断链／一次静默形状，仓库文件零改动（见登记册 §5.3fs）
	node scripts/chain-baseline/verify-wiring.cjs --self-test
	node scripts/chain-baseline/verify-wiring.cjs

chain-baseline-verify-teeth:  ## 全部 verify 的"空洞性"前置态行走（V221，只出读数、未接共享门禁）：按 standalone-chain --plan 的权威顺序逐支迁移前进，每支**应用之前**先跑它自己那条 verify（对象还不存在），按 runner 自己的输出＋退出码分六档 pass／fail／error-missing／error／silent／other，加总硬断言等于分母；走完后再在终态把全部 verify 跑一遍当控制档（不全绿就说明这座库与 A 段不同形，整份读数作废）。pass-at-prefix 不是"恒真"的同义词，三类成因（对象由更早迁移带出／负向不变量型／集群级角色隔离不掉＝本件自身限度）见脚本头；判据自测条数由脚本自报
	node scripts/chain-baseline/verify-teeth.cjs --self-test
	node scripts/chain-baseline/verify-teeth.cjs

chain-baseline-projection-consistency:  ## 链上派生投影的"一致性有没有被机械核过"复算（V222，只出读数、未接共享门禁）：分母＝.codex/artifacts/projection-map.json 逐格登记的投影（"哪些表算投影"是语义判断，本件不自行扩分母），每格按 needle 现定位（不信行号）复核写入口／补齐路径／是否存在"同一个 it() 块里同时读源与投影并比较"的常驻断言；needle 读不到或不唯一即整格判不可判并非零退出（清单与树不同步不许静默放过），加总硬断言等于分母；判据自测条数由脚本自报
	node scripts/chain-baseline/projection-consistency.cjs --self-test
	node scripts/chain-baseline/projection-consistency.cjs
chain-baseline-context-forwarding:  ## 授权上下文转发判据（V267，读而未转发即判红；**未接共享门禁**，接不接属口径待裁）：分母＝调度模块内按**声明类型**认定为 OrgContext 的成员读点（TypeChecker 比接口符号，不按变量名——按名字实测会造 5 个伪字段），判据＝这些字段必须都在归一化器 toOrgContext 的转发集里；起因＝RCPTCTX-01（V265）转发少两件 roles/personId 让文档写明的回执端点对非 global_admin 全 403。别名/多跳天然覆盖（`const ctx = actor` 之后类型仍是 OrgContext），一跳调用图对此是瞎的。输入读不到判"不可判"（rc=3）不折成干净；自测条数由脚本自报
	node scripts/chain-baseline/context-forwarding.cjs --self-test
	node scripts/chain-baseline/context-forwarding.cjs
chain-baseline-change-amplification:  ## 推广判据①"维护成本"的可数量化（V226，只出读数、未接共享门禁）：一次业务语义改动今天必须同步几个"登记面"，其中几个落在全量重放的覆盖集里（改了机器就看得见）、几个只在人手；**「只在人手」再分两档（V336）——活面（要跟着改）与历史记载（CHANGELOG／交付成稿／带日期快照／ADR／generated_at 定格清单，写定不再随 schema 改）**，两档加总由脚本硬断言等于「仅人手」，漏算即读数作废（原读数把两类混算会高估同步成本：asg_table 的 15 个里 9 个是记载）；**第三根轴（V336）把「仅人手」按链外机器入口再分三档——有入口／已扫面内无入口／不可判**，入口面＝Makefile 配方、package.json 脚本、CI workflow、scripts/*.sh、tests/*.py 与**每一份 jest 跑测档**的覆盖面改由 jest 自己报（每份配置跑一次 `npx jest --listTests`，共约 1.1 秒；自研的 glob＋rootDir＋ignore 匹配器降为**退回档**，权威档跑不起时才用，且读数里点名用的是哪档；`EWOH_AS_JEST=static` 显式关掉权威档；判据自测结构上不 spawn jest；两档同时在场打印**双向差集**——自研档多报＝假阳面、漏报＝假阴面，V338 当期 0／0／0），**第四入口面＝「仓内量具读取」（V339，ENTAX-01 的机械半）**——问"有没有判据把这份文件当输入读"，由 `instrument-readers` 做 AST 绑定追踪（三档：read 实参里的字面量／顶层常量被用作实参／顶层数组对象里某属性被 `read(p.K)` 消费），只看模块顶层、不进函数体、排除量具自身路径；解析器取不到时本面记为**未启用**并在读数里点名，不把"没启用"折成"没人读"（当期读数：`truncated_field` 无入口 15→12、`asg_table` 10→6，被翻档的六个文件全是登记文档，逐条带读取者与档名）（注释面一律剥掉，否则"文档式提及"会算成入口；`<rootDir>` 按各配置自身目录解，写死包根会让 client 那档永远读空），三档加总同样硬断言等于「仅人手」；这一轴只回答"链外还有没有机器面引用这个文件"，**不回答"改了它会不会有机器判红"**（出现即算，被当数据读与被当脚本跑不区分），且执行面是封闭枚举、动态拼路径与别的 harness 读不到 ⇒ 落「已扫面内无入口」不等于"没人跑"；覆盖集不自造，直接复用 replay-freshness 的 collectScope（另写一套枚举器会让两个读数打架）；样本必须是**精确词面**（宽词测的是词面复用度，不是同步面，脚本里记着这条教训）；分类是有序首匹配＋兜底单列打印，判据自测条数由脚本自报；**第五面「测试 import 闭包」（V340）**：jest 权威档与场景脚本的 import 链也算机器入口，于是 `client/src/**` 那批"没人点名但被测试真载入"的文件从此不再算无入口（别名与 .d.ts 都认，拿不到入口清单时点名未启用）
	node scripts/chain-baseline/change-amplification.cjs --self-test
	node scripts/chain-baseline/change-amplification.cjs

# 第五入口面（V340）的说明——某文件有没有被测试代码经 import/require 链间接载入：另认 .d.ts——现行覆盖集那份闭包两处都读不到）。入口清单＝jest 权威档（--listTests，V338）∪ package.json 的 e2e: 场景脚本；
#   别名表取自 ewoh-spark-app/tsconfig.app.json 的 paths，并另认 .d.ts（覆盖集那份闭包两处都读不到）。
#   入口清单＝jest 权威档（--listTests，V338）∪ package.json 的 e2e: 场景脚本；拿不到入口清单或未取到
#   typescript 解析件 ⇒ 读数点名"未启用"，绝不折成"无入口"。判据自测条数由脚本自报，不在此冻结：
#   相对边／.d.ts 边／paths 别名边各一支必须开火；包说明符与盘上不存在的说明符不得造边；
#   「入口清单里盘上不存在的入口」与「paths 前缀命中却解析不到」两类必须单列点名（不静默过滤）。
chain-baseline-import-closure:  ## 推广判据①的第五入口面（V340，ENTAX-01 的 import 闭包半；只出读数、未接共享门禁）：
	node scripts/chain-baseline/import-closure.cjs --self-test
	node scripts/chain-baseline/import-closure.cjs --entries-from-jest

# 别名表同步机检（V341）的判据形状——两条规则各自独立开火，别让一条冒领另一条的功劳：
#   R-1 比的是**解析结果**不是字面：tsconfig 的 paths 相对该文件自己声明的 baseUrl，jest 的 mapper
#   相对该配置的 rootDir（缺省＝配置所在目录），两侧根不同，`@/*`→`./client/src/*` 与
#   `^@/(.*)$`→`<rootDir>/src/$1` 是同一件事；拿字面比会凭空造红。
#   R-2 只按"该 runner 的语料闭包真的走到"判欠映射（不按集合差集），没映射那一侧再用 require.resolve
#   兜第二档：包自己解得出的（如 @lark-apaas/client-toolkit/tools/*）记不判，不冒充缺陷。
#   闭包的别名权威必须沿 extends 链取**最近一份自己声明 paths 的档**（TS 语义是整体覆盖不是合并）；
#   直接拿继承档交给闭包 ⇒ @server/* 整批被当外部包，语料静默缩水（本轮第一版实测 857→866）。
#   mapper 是函数调用（生成档）或变量引用 ⇒ 记不可判，不读成"这个面没有映射"。
chain-baseline-alias-sync:  ## 路径别名表同步机检（V341，ENTAX-01 的机械半（别名表这一族；V344 起另含 R-3 include 落空判据，V349 起再加 R-4「编译器侧输入集」＝R-3 的上界：目录在、include 也写了，仍可能一个输入都拿不到），V350 起 R-4 走整条 config 解析链（自身不声明、全靠 extends 的那两面也照样读数，链断裂判不可判）；只出读数、未接共享门禁，判据自测条数由脚本自报）：同一张别名表在仓里是**两类面各抄一份**——`tsconfig*.json` 的 `compilerOptions.paths`（tsc／vite／ts-jest 编译期靠它）与 jest 的 `moduleNameMapper`（jest 运行期只靠它，ts-jest 不会把 paths 变成 mapper）。V340 那只核了 app 档与 client 跑测档两处同值，其余面没人核，而"以后只改一边"正是这一族唯一会发生的错法。本尺按文件名全枚举（8 份 tsconfig＋每一份 jest 配置，**含没被任何配方接入的那些**＋`package.json#jest` 默认档），R-1 比归一后的绝对目录、R-2 按每个常驻 runner 自己的语料闭包判"用到的别名有没有映射"。**V342 起四份跑测档全是生成档**（`moduleNameMapper: build()` 之类），所以还有一臂把配置件 require 出来读 jest 实际要用的对象（`--no-require` 可关；这一臂会执行配置文件代码，只用于本仓自己的配置面）。默认不 spawn jest（加 `--with-corpus` 才问权威档），拿不到入口清单或未取到解析件一律点名不可判、绝不折成"没有欠映射"。判据自测条数由脚本自报（必须开火：目录分叉／映射指向盘上没有／语料真用到而欠映射且包解不出；必须不开火：字面不同而目录相同／包作用域别名／mapper 已覆盖／语料未启用／生成档；必须点名：单行写法的 mapper、`rootDir: '../..'` 标量、埋在 transform 里的 `tsconfig:`、带转义的键、继承档只作参考、坏 JSON 整面、extends 链覆盖不合并），；R-3（V344）判每份 tsconfig 的 include 相对**该文件自身目录**落不落得到地上——必须开火：整批按父目录写而文件住在子目录（TS18003 那一族）；必须不开火：改成相对自身目录（含 `../server/**`）、glob 第一段是个文件、根本没有 include 这一项（记不判，不折成"没有落空"）；部分 glob 落空只逐条点名不判红（"某条暂时没文件"合法），并配三条真树注入反证（改目标⇒R-1 红；只删 mapper 一条⇒R-1 绿而 R-2 红；把 include 改回死形状⇒R-3 红且退码非 0，还原 sha 相同）
	node scripts/chain-baseline/alias-table-sync.cjs --self-test
	node scripts/chain-baseline/alias-table-sync.cjs --with-corpus

chain-baseline-instrument-readers:  ## 仓内量具读取普查（V339，ENTAX-01 的机械半；只出读数、未接共享门禁）：改了某个文件，仓里有没有哪把量具会去**读**它？动因＝`chain-baseline-change-amplification` 的「链外机器入口」原先只认"配方里提到这个路径"与"jest 收哪些测试文件"，于是登记文档（《基线》《裁决包》ADR／走查表／交付指令）明明被 `artifact-consistency`／`doc-face-reconciliation` 逐行核着，却仍落在「已扫面内无入口」⇒ 判据①读得比实际更贵。三档判读取（AST 绑定追踪，不用文本窗口——V338 实测窗口档同时造假阴与假红）：`direct`＝字面量在 read/exists/require 的实参子树里；`const1hop`＝顶层常量被用作读调用实参；`tableProp`＝字面量嵌在顶层数组／对象里、其属性名以 `X.K` 形式出现在读调用实参里（表驱动判据的形状）。两条排除：量具自身路径；**不进入任何函数体**（自测夹具与真语料断言名单都写在函数里，与入口无关）。字面量在盘上不存在的单独计数，绝不与"没判成读取"混成一格；取不到 typescript 解析器 ⇒ rc=3 不可判，不读成零读取者。先跑 9 项判据自测（三档各一支开火＋"顶层常量在函数体内被读用仍须开火"＋三支不开火＋真语料两支），条数由脚本自报
	node scripts/chain-baseline/instrument-readers.cjs --self-test
	node scripts/chain-baseline/instrument-readers.cjs

chain-baseline-doc-face:  ## 文档面对账（V227，DOCFACE-01 的机械半；未接共享门禁，但本 target 自己有退出码）：文档/注释里"抄写"的封闭词表与位点声明，今天还和权威源一致吗？四类判据＝词表对账（TS as const 数组／DB CHECK 按"最后一个定义 wins"跨迁移解析／代码字面量全集）＋指向性声明对账（注释引用的迁移是否仍是该约束的现行定义）＋引用存在性（带九档分类，"看不见"一律不折成"失效"）＋**未渲染词元（V317 新增第四类；V321 补两族形状）**：三件产物正文里残留的记账模板占位符，三族各判——at 成对包标识符（`@@name@@` 与 V316 自造的半渲染 `@name@`）、Python 命名式 `%(name)s`（V112 在状态件里落了 8 个，旧形状看不见）、位置式 `%d`/`%02s`；点名按形状去重（同形状两次只列一条），反引号里逐字引用不算残留、`%%` 转义不算、读不到判不可判；词表／声明／词元三类进退出码，refs 类只报数；**第五类（V336）＝文档分类表逐行抄写的表级 DDL 事实 ↔ `db/migrations` 现行定义**（`rls_adr_null_bypass`：policy 里还有没有 `org_id IS NULL` 放行分支、org_id 现行是否 NOT NULL；权威按"迁移号最大的那份定义 wins"，认得 DO 块里 `v_tables := ARRAY[…]` 那种动态 EXECUTE 与建表列定义的两种排版，认不到一律判不可判而非判违规），**第六类（V337）＝表格抄写的非 DDL 事实 ↔ 各自权威**（三条目：`rls_audit_isolation` 的「隔离方式」列 ↔ `schema-facts.txt` 的 RLS 开关小节、`mes_adr_writers` 的「拥有者」列 ↔ `status-write-guard-census` 的 prod 站点（类名与文件名归一，普查只扫 drizzle 写点故是下界）、`delivery_columns` 的手抄列清单 ↔ `schema.ts` 该表 pgTable 块（摘要漏列不算漂移）；括号里是举例不是清单、一行两张表算归属歧义必须作废整条读数；新鲜度守卫＝事实档比它要反映的 `db/migrations`／`schema.ts` 还旧 ⇒ 整条转不可判）。记载档允许保留旧表述，条件是同文件有一条点到**自己那类权威**的「现行口径」注记 ⇒ 判 `amended` 不判失败；`ddl` 那根锚仍要求注记写出权威迁移号（写的号与权威不符照样判红），`facts` 那根锚只认权威名字（普查档与 schema.ts 没有迁移号，硬要就会逼人编一个）——两档各有"挂横幅不点名 ⇒ 仍判红"的反证控制；未采到的行单列不可判、不折成一致；两份事实档的产地＝RLS 开关那份由重放 B 段的 schema-probe 写、写者那份由 status-write-guard-census 带 --json 写（0.5 秒，不用起库），守卫只认 mtime 不认内容，所以档在但过期时整条转不可判；分母＝声明的类数，判决加总不等即读数作废；判据自测条数由脚本自报
	node scripts/chain-baseline/doc-face-reconciliation.cjs --self-test
	node scripts/chain-baseline/doc-face-reconciliation.cjs


chain-baseline-tick-reachability:  ## 周期机制 tick 可达性普查（V207）：服务端每个 setInterval 站点两根轴——默认间隔（AST 解析，含 env 缺省侧与一跳 helper）× 常驻面有没有人设过那个 *_INTERVAL_MS（K1 无旋钮／K2 无人设＝默认间隔独大／K3u 只在 unit spec 里设＝只测解析／K3r 常驻链面设过）；两轴不合并，加总必须等于分母；判据自测条数由脚本自报
	node scripts/chain-baseline/tick-reachability.cjs --self-test
	node scripts/chain-baseline/tick-reachability.cjs

chain-baseline-worker-shutdown-probe:  ## 停止路径探针（V147）：close() 与 SIGTERM 分别调用哪些钩子——未 enableShutdownHooks 时收尾钩子一个都不到；含"必须开火/撤销不开火"两侧对照
	node scripts/chain-baseline/worker-shutdown-probe.cjs --self-test
	node scripts/chain-baseline/worker-shutdown-probe.cjs

chain-baseline-outbox-probe:  ## 投递日志运行期探针（V141）：一次链级运行后 ewoh_outbox 落了哪些行、status 是否仍全 pending、published_at 是否仍空、老行是否被裁、游标空洞落在哪个订阅者视角（需先 up/-seed；连不上=退出码 3）
	node scripts/chain-baseline/outbox-runtime-probe.mjs

chain-baseline-event-readside:  ## 契约事件读侧普查（V137）：先备齐 V135/V136 的读数，再跑 3 项夹具对照（能报死等/撤销不报/写侧分支不算消费者），最后出三面合账
	@python3 scripts/chain-baseline/event-roles.py >/dev/null
	@node scripts/chain-baseline/event-payload.cjs >/dev/null
	@python3 scripts/chain-baseline/event-readside.py --self-test
	python3 scripts/chain-baseline/event-readside.py

chain-baseline-event-payload:  ## 契约事件载荷形状普查（V136）：先跑 11 项判据自测（含"必须能看到 payload"的反向证明），再出两条承载面的 required 供给分档与缺口（读实参位，不按名字形状猜）
	@node scripts/chain-baseline/event-payload.cjs --self-test
	node scripts/chain-baseline/event-payload.cjs

chain-baseline-copy-census:  ## 跨表副本普查（V129）：先跑 17 项判据自测（含写入面分区恒等式与一跳增量），再出全仓读数——含"静态可枚举面只有百分之几"这条上限，清单不得被读成"副本面已穷尽"
	@node scripts/chain-baseline/copy-census.cjs --self-test
	node scripts/chain-baseline/copy-census.cjs

chain-baseline-negative-control:  ## 门禁主线「能不能红」的负向控制度量（V115）：干净对照→夹具注入已知缺陷→必须报出预期判据→撤销回绿；含 SKIP→PASS 形状探针
	@node scripts/chain-baseline/gate-negative-control.cjs --self-check
	node scripts/chain-baseline/gate-negative-control.cjs $(GATE_ARGS)

chain-baseline-criterion-selftest:  ## D/C 段判据自测 + B 段覆盖判据自测 + 守卫变异对照（V110/V116，不起后端不跑用例）
	bash scripts/chain-baseline/verify.sh --self-test
	@node scripts/chain-baseline/schema-probe.mjs --self-test
	bash scripts/chain-baseline/assert-criterion-mutation.sh

chain-baseline-ci-surface:  ## CI 侧 e2e 覆盖面与预检镜像漂移核对（V111）：静态判据，不连库不跑用例；先跑跳线自测（注：CI-03 未修前本目标按判据返回 1，那一项就是它该报的红）
	@node scripts/chain-baseline/ci-e2e-surface.cjs --self-test > /dev/null && echo '── 跳线自测 8/8（1 正向 + 7 注入，含"镜像更严不误报"的方向对照）'
	@node scripts/chain-baseline/ci-e2e-surface.cjs

chain-baseline-doctor:  ## 基线环境自检：把「依赖没登记(DEP-01)」与「链跑红了」分开；退出码 0=可用 3=不可用 1=其他故障
	bash scripts/chain-baseline/doctor.sh

chain-baseline-doctor-selftest:  ## 上面那套分类的自测（含"空目录不得判成可用"的反向控制）
	bash scripts/chain-baseline/doctor.sh --self-test
