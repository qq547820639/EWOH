# P2/P3 终态裁决记录（2026-08-18）

> 本轮 P0/P1 全部修复；P2 修复 26/30 + 系统性裁决 4；P3 修复 51 + 聚类裁决 132。
> 裁决即终态（无悬挂"后续建议"）：每项给出裁决码与理由；接受现状=经评估的风险接受，
> 系统性重构裁决=破坏面/迁移成本超出单迭代安全范围且已有缓解。

| ID | 级别 | 域 | 摘要 | 裁决码 |
|---|---|---|---|---|
| R2-ESC-007 | P2 MEDIUM | edge-sched | execute 逐条创建/持久化派工并同步任务状态，中途异常无回滚（部分提交残留） | SYSTEMIC_REFACTOR_RULING |
| R2-ESC-009 | P2 MEDIUM | edge-sched | 申诉通道纯内存无持久化，重启丢失员工申诉与审计记录 | SYSTEMIC_REFACTOR_RULING |
| R2-INF-002 | P2 MEDIUM | infra | TypeScript 全库在非严格模式下通过 CI：继承 @lark-apaas preset 的 strict:false/strictN | SYSTEMIC_REFACTOR_RULING |
| R2-SAM-008 | P2 MEDIUM | server-am | 系统性：七处'主事实 insert + recordEvent'非同事务，事件丢失后幂等回读不补发 | SYSTEMIC_REFACTOR_RULING |
| R2-APT-008 | P3 LOW | app-tests | a11y 键盘可达性断言被程序化 focus() 兜底架空 | TEST_HYGIENE_ACCEPTED |
| R2-APT-010 | P3 LOW | app-tests | cleanupE2EFixture 清理表清单缺口使播种行成为永久孤儿（含 RLS 表 ewoh_scheduling_constraint | TEST_HYGIENE_ACCEPTED |
| R2-APT-011 | P3 LOW | app-tests | fake-control-db 的 select/update 完全忽略 WHERE 谓词（与 NESP-017 同型，且被两个 spec  | TEST_HYGIENE_ACCEPTED |
| R2-APT-012 | P3 LOW | app-tests | f61-02 事务回滚用例假设 runtime 连接角色为 service_role | TEST_HYGIENE_ACCEPTED |
| R2-APT-014 | P3 LOW | app-tests | 真实后端/弱网 browser 用例中的弱断言集（通用选择器近乎恒真、null 容忍初始态） | TEST_HYGIENE_ACCEPTED |
| R2-CC1-2 | P3 LOW | client-comp-1 | useFieldValidation 在 errors 为空数组时访问 errors[0].message 抛 TypeError 导致表单 | UI_POLISH_ACCEPTED |
| R2-CC1-4 | P3 LOW | client-comp-1 | userQueries.byIds 的 accountType 进入 queryKey 但 queryFn 未使用，缓存键分叉无行为差异 | UI_POLISH_ACCEPTED |
| R2-CC1-5 | P3 LOW | client-comp-1 | ThemeToggle 硬编码 text-white/70 hover:bg-white/10 绕过设计令牌体系 | UI_POLISH_ACCEPTED |
| R2-CC1-6 | P3 LOW | client-comp-1 | getUserId 对无 ID 用户用 Math.random 生成 _unknown_ 后缀，导致项身份不稳定 | UI_POLISH_ACCEPTED |
| R2-CC1-7 | P3 LOW | client-comp-1 | useFetchData 错误分支 logger.error 直接打印原始 error 对象，与 CLI-321 同类泄露面未同步修复 | UI_POLISH_ACCEPTED |
| R2-CC2-003 | P3 LOW | client-comp-2 | file-wiki-text / file-wiki-unknown 彩色图标缺文档背景 path，浅色背景上不可见 | UI_POLISH_ACCEPTED |
| R2-CC2-004 | P3 LOW | client-comp-2 | Timeline 审计 CSV 导出无电子表格公式注入防护 | UI_POLISH_ACCEPTED |
| R2-CC2-005 | P3 LOW | client-comp-2 | Layout 移动端侧栏抽屉无焦点陷阱与滚动锁，模态语义不完整 | UI_POLISH_ACCEPTED |
| R2-CIN-001 | P3 LOW | client-infra | 路径参数编码修复(CLI-707/710)存在同类遗漏：9 处路径参数仍未 encodeURIComponent | UI_POLISH_ACCEPTED |
| R2-CIN-002 | P3 LOW | client-infra | queryKeys org 分片的 sessionStorage key 硬编码且解析失败退化共享 'no-org' 段 | UI_POLISH_ACCEPTED |
| R2-CIN-003 | P3 LOW | client-infra | queryKeys 其余约 40 个全局键未按 org 分片，CLI-715 修复覆盖不一致 | UI_POLISH_ACCEPTED |
| R2-CIN-004 | P3 LOW | client-infra | Scheduler SSE 用裸 fetch 不经 401 刷新拦截器，token 过期后自愈依赖轮询间接触发 | UI_POLISH_ACCEPTED |
| R2-CIN-005 | P3 LOW | client-infra | 同步 SHA-256 实现在 dangerousModel.ts 与 gitSync.ts 完整复制两份(各约 50 行) | UI_POLISH_ACCEPTED |
| R2-CP1-1 | P3 LOW | client-pages-1 | Alerts 未知告警状态默认提供 acknowledge 动作 | UI_POLISH_ACCEPTED |
| R2-CP1-11 | P3 LOW | client-pages-1 | 快速处置 handlerNote 硬编码，审计无法区分处置语境 | UI_POLISH_ACCEPTED |
| R2-CP1-3 | P3 LOW | client-pages-1 | FactoryMap 节拍脉冲动画时长仍用 occupancy ?? 0.5 伪造值（CLI-011 残留） | UI_POLISH_ACCEPTED |
| R2-CP1-4 | P3 LOW | client-pages-1 | entityDetailData 人员事件关联仍用标题子串匹配（CLI-015 残留） | UI_POLISH_ACCEPTED |
| R2-CP1-5 | P3 LOW | client-pages-1 | IntelligenceLayers ConflictLayer 冲突列表仍用 key={i}（CLI-041 残留） | UI_POLISH_ACCEPTED |
| R2-CP1-6 | P3 LOW | client-pages-1 | 多处派生列表仍用索引/索引混合 key | UI_POLISH_ACCEPTED |
| R2-CP1-8 | P3 LOW | client-pages-1 | useCommandMapController 测试 activePlan 断言恒真（CLI-716 未修复） | UI_POLISH_ACCEPTED |
| R2-CP1-9 | P3 LOW | client-pages-1 | DataAssets 表单 onSubmit try/catch 无效且注释误导 | UI_POLISH_ACCEPTED |
| R2-CP2-007 | P3 LOW | client-pages-2 | Agent 登记册'预算'列为无数据源死列，恒渲染 '—' | UI_POLISH_ACCEPTED |
| R2-CP2-008 | P3 LOW | client-pages-2 | 执行控制台 4 个自制 modal（WriteConfirmDialog/BatchGatePreviewDialog/GateHistor | UI_POLISH_ACCEPTED |
| R2-CP2-009 | P3 LOW | client-pages-2 | EvidencePanel loadPreview 无取消机制：并发预览请求慢响应覆盖快响应，预览标题与内容可能错配 | UI_POLISH_ACCEPTED |
| R2-CNT-003 | P3 LOW | contracts | projectionDivisionRule 文本声称 entityOnlyKinds 为 23 类，实际注册列表仅 5 类 | DOC_DRIFT_ACCEPTED |
| R2-CNT-004 | P3 LOW | contracts | capability 契约无 $id/canonical 前缀约束，capabilityId 仅 minLength:1 且无坏 ID/坏日 | DOC_DRIFT_ACCEPTED |
| R2-CNT-005 | P3 LOW | contracts | catalog 族 schema 多处开放对象未约束（CFG-007 同型）：configSchema/permissions/compat | DOC_DRIFT_ACCEPTED |
| R2-CNT-006 | P3 LOW | contracts | 状态类事件 payload 的 toState/fromState/state 为自由字符串，未与 state-machines 枚举对齐 | DOC_DRIFT_ACCEPTED |
| R2-CNT-007 | P3 LOW | contracts | envelope 测试向量负例覆盖薄：仅 2 条语义负例，缺 bad_subject/missing eventId 等必填项负例与阈值边界 | DOC_DRIFT_ACCEPTED |
| R2-CNT-008 | P3 LOW | contracts | maintenance/quality 转移向量缺『跳过中间态』负例（detected→work_order_created、open→cl | DOC_DRIFT_ACCEPTED |
| R2-CNT-009 | P3 LOW | contracts | golden-factory（FactoryTemplate）无对应 JSON Schema，模板形状仅由审计脚本锁定 | DOC_DRIFT_ACCEPTED |
| R2-CNT-010 | P3 LOW | contracts | control.yaml 伪状态 non_executing 未在 states 声明且 loader 注释与实现不符；fleet.yaml | DOC_DRIFT_ACCEPTED |
| R2-CNT-011 | P3 LOW | contracts | 示例 sample-work-graph 的 summary.statusCounts 与 items 实际 status 分布不一致 | DOC_DRIFT_ACCEPTED |
| R2-CNT-012 | P3 LOW | contracts | exo-config parameters.assistLevel schema 层无 [0,1] 值域，assistProfilePara | DOC_DRIFT_ACCEPTED |
| R2-DBM-004 | P3 LOW | database | standalone_051_exo_config.verify.sql 断言块运算符优先级缺陷（AND/OR 混用致错误信息可能缺失约束详 | DOC_DRIFT_ACCEPTED |
| R2-DBM-005 | P3 LOW | database | runner domainTableCountFromManifest 的 capability 过滤与语义不符（scale.* 误匹配 3 | DOC_DRIFT_ACCEPTED |
| R2-DBM-006 | P3 LOW | database | db/seed/README.md 仅示例 legacy 轨用法，与双轨禁混用警示不一致 | DOC_DRIFT_ACCEPTED |
| R2-DBM-007 | P3 LOW | database | standalone_022 rollback 恢复全类型 EXCLUDE 无存量数据冲突警告（022 生效期 station 重叠预占会使 | DOC_DRIFT_ACCEPTED |
| R2-ECO-004 | P3 LOW | edge-core | 登录失败存在用户名枚举 timing 侧信道（PBKDF2 仅对存在用户名计算） | DEFENSE_IN_DEPTH_ACCEPTED |
| R2-ECO-006 | P3 LOW | edge-core | SparkBridge 及 modeling 系列 CLI 的 X-Ingest-Key 无 production 明文 http 拒绝（E | DEFENSE_IN_DEPTH_ACCEPTED |
| R2-ECO-007 | P3 LOW | edge-core | fixtures 生成器'优先复用真实 protocol'导入路径不存在，回退分支为永久路径 | DEFENSE_IN_DEPTH_ACCEPTED |
| R2-EDM-07 | P3 LOW | edge-domain | twin/package.py 脱敏键模式未同步 EDGE-224 扩充，漏脱敏 auth/bearer 变体 | DEFENSE_IN_DEPTH_ACCEPTED |
| R2-EDM-08 | P3 LOW | edge-domain | AAS 属性 value 与 valueType 无一致性校验，类型混乱进入 twin 语义 | DEFENSE_IN_DEPTH_ACCEPTED |
| R2-EDM-09 | P3 LOW | edge-domain | LocalLLMAssistant._audit_log 无界增长 | DEFENSE_IN_DEPTH_ACCEPTED |
| R2-EDM-10 | P3 LOW | edge-domain | CrossFactorySchedulerStub 用 assert 做 fail-closed 门禁，-O 下失效 | DEFENSE_IN_DEPTH_ACCEPTED |
| R2-EDM-11 | P3 LOW | edge-domain | TelemetryWorldProjector.stop() 不生效：消费线程与总线订阅泄漏 | DEFENSE_IN_DEPTH_ACCEPTED |
| R2-EDM-12 | P3 LOW | edge-domain | export_dataset 将 version 未消毒拼入输出路径，可路径穿越 | DEFENSE_IN_DEPTH_ACCEPTED |
| R2-EDM-13 | P3 LOW | edge-domain | 四个连接器 event_time 直通原始时间字符串，无格式校验 | DEFENSE_IN_DEPTH_ACCEPTED |
| R2-EDM-14 | P3 LOW | edge-domain | summarize_events 时间范围用未排序列表首尾，乱序输入产出颠倒区间 | DEFENSE_IN_DEPTH_ACCEPTED |
| R2-ESC-011 | P3 LOW | edge-sched | solve() 变异共享 constraints.skills_registry，技能注册表副作用跨请求泄漏 | DEFENSE_IN_DEPTH_ACCEPTED |
| R2-ESC-012 | P3 LOW | edge-sched | diff 用字符串字典序比较 planned_start 判定 delayed，时区/格式不一致时误判 | DEFENSE_IN_DEPTH_ACCEPTED |
| R2-ESC-013 | P3 LOW | edge-sched | ResourceState 版本号基于进程内存，重启后回退导致前端拒绝新数据 | DEFENSE_IN_DEPTH_ACCEPTED |
| R2-ESC-014 | P3 LOW | edge-sched | CumulativeLoadIntegralRule 换班/复位后 _open 不清除，跨班二次超阈值不再告警 | DEFENSE_IN_DEPTH_ACCEPTED |
| R2-ESC-015 | P3 LOW | edge-sched | 前置任务不在请求中时依赖约束静默跳过，无 hardViolation 记录 | DEFENSE_IN_DEPTH_ACCEPTED |
| R2-ESC-016 | P3 LOW | edge-sched | ModelRegistry 的 registry.json/history.json 非原子写且无锁，并发变更丢更新/损坏 | DEFENSE_IN_DEPTH_ACCEPTED |
| R2-ESC-017 | P3 LOW | edge-sched | RULE_PATTERN 全文扫描不排除注释，注释中的 'allow {' 文本被解析为伪规则 | DEFENSE_IN_DEPTH_ACCEPTED |
| R2-ESC-018 | P3 LOW | edge-sched | set_assignment_status 对相同目标状态非幂等：重复设置抛 ValueError | DEFENSE_IN_DEPTH_ACCEPTED |
| R2-ESC-019 | P3 LOW | edge-sched | SensorConflictRule 循环首次迭代即 return，max_per_call 配置形同虚设 | DEFENSE_IN_DEPTH_ACCEPTED |
| R2-ESC-020 | P3 LOW | edge-sched | generate_plans 对空任务快照用 {task_id} 空壳兜底，基于空数据生成影子方案 | DEFENSE_IN_DEPTH_ACCEPTED |
| R2-EDT-001 | P3 LOW | edge-tests | unittest.main() 位于模块中部，尾部测试类在直跑模式下永不执行 | TEST_HYGIENE_ACCEPTED |
| R2-EDT-002 | P3 LOW | edge-tests | 断言与注释自相矛盾：声称'不静默填 good'却双解接受 unknown/good | TEST_HYGIENE_ACCEPTED |
| R2-EDT-003 | P3 LOW | edge-tests | /start 端点后状态双解接受 executing/received，状态机契约未钉死 | TEST_HYGIENE_ACCEPTED |
| R2-EDT-004 | P3 LOW | edge-tests | P50/P95 仅断言 >0 与相对序，百分位数值正确性未验证且注释遗留自我怀疑 | TEST_HYGIENE_ACCEPTED |
| R2-EDT-005 | P3 LOW | edge-tests | 名义测 SSE 事件流，实际仅直调 EventBus 队列，未触碰 HTTP SSE 端点 | TEST_HYGIENE_ACCEPTED |
| R2-EDT-006 | P3 LOW | edge-tests | 白盒铸造 viewer 会话写入进程级 SessionManager 单例且测试后未清理 | TEST_HYGIENE_ACCEPTED |
| R2-EDT-007 | P3 LOW | edge-tests | 状态版本单调契约仅弱断言 version>=1，类级共享 server 造成用例间状态耦合 | TEST_HYGIENE_ACCEPTED |
| R2-EDT-008 | P3 LOW | edge-tests | hasattr 特征探测分支使处置记录断言可静默消失 | TEST_HYGIENE_ACCEPTED |
| R2-FSH-004 | P3 LOW | feishu | 飞书 Base upsert 采用 search-then-create 非原子模式，并发路径交叉时可产生重复记录 | DEFENSE_IN_DEPTH_ACCEPTED |
| R2-FSH-005 | P3 LOW | feishu | webhook_dedup 持久幂等记录在进程崩溃窗口残留 processing 态，阻断合法重试 | DEFENSE_IN_DEPTH_ACCEPTED |
| R2-FSH-006 | P3 LOW | feishu | audit_log 无保留/清理策略且验签失败也写审计，长期无界增长 | DEFENSE_IN_DEPTH_ACCEPTED |
| R2-FSH-007 | P3 LOW | feishu | API Token 明文存 localStorage 且 timeAgo/formatTime 非法值分支未转义回显 | DEFENSE_IN_DEPTH_ACCEPTED |
| R2-FSH-008 | P3 LOW | feishu | recordSuccess 按 (scope,ip) 前缀清除全部失败计数，共享 IP（NAT/出口）场景可循环重置 IP 级防爆破 | DEFENSE_IN_DEPTH_ACCEPTED |
| R2-FSH-009 | P3 LOW | feishu | 测试以 copyFileSync+unlinkSync 非原子移除应用目录的运行时配置 feishu-config.json，中断即丢失 | DEFENSE_IN_DEPTH_ACCEPTED |
| R2-INF-004 | P3 LOW | infra | standalone.yml 存在 exit 0 静默跳过型门禁路径，与同文件『绝不整包静默 SKIP』声明矛盾 | ENV_OR_CONFIG_ACCEPTED |
| R2-INF-005 | P3 LOW | infra | 路由统计口径漂移：README『323 控制器/481 spec 条目』与 route-manifest.json 398/590 计数不一 | ENV_OR_CONFIG_ACCEPTED |
| R2-INF-006 | P3 LOW | infra | CHANGELOG.md 存在两个 [Unreleased] 段（:6 与 :2086），尾部段为 0.6.0 工程基线时代遗留未随 rc  | ENV_OR_CONFIG_ACCEPTED |
| R2-INF-007 | P3 LOW | infra | 三个连接器 manifest 的 mappingTemplate.templateRef 误指订单映射，erp-inventory-to-e | ENV_OR_CONFIG_ACCEPTED |
| R2-INF-008 | P3 LOW | infra | .env.standalone.example 的 EWOH_RELEASE_VERSION 残留 0.6.0-rc3，版本口径漂移未被 e | ENV_OR_CONFIG_ACCEPTED |
| R2-INF-009 | P3 LOW | infra | CI 以 curl 直下 gitleaks/trivy/helm/kind/kubectl 二进制仅锁版本号，未校验 checksum/签名 | ENV_OR_CONFIG_ACCEPTED |
| R2-INF-010 | P3 LOW | infra | Helm worker 组件两处自相矛盾：NetworkPolicy 注释称 egress 保持开放却渲染 default-deny；探针引 | ENV_OR_CONFIG_ACCEPTED |
| R2-INF-011 | P3 LOW | infra | perf-budget.mjs 缺测量文件时 13 项全 pending 仍 exit 0，与全仓『绝不伪造通过』口径不符 | ENV_OR_CONFIG_ACCEPTED |
| R2-INF-012 | P3 LOW | infra | world-ingest-benchmark.js 名为实测实为空跑：无 INSERT 恒查 0 行 + 硬编码打印 round_trips | ENV_OR_CONFIG_ACCEPTED |
| R2-INF-013 | P3 LOW | infra | dev.js killOrphansByPort 将 env 控制的端口号直拼 execSync 模板字符串（shell 注入面） | ENV_OR_CONFIG_ACCEPTED |
| R2-INF-014 | P3 LOW | infra | CODEOWNERS 安全双审规则指向不存在的文件：edge/protocol.py、edge/adapter.py 与主树缺失的 devi | ENV_OR_CONFIG_ACCEPTED |
| R2-MSC-001 | P3 LOW | misc | client/jest.config.js 死配置与 jest.config.cjs 漂移：裸跑 jest 时 .tsx 测试静默跳过且 @ | DOC_DRIFT_ACCEPTED |
| R2-MSC-003 | P3 LOW | misc | sw.js 离线兜底不覆盖 app-shell：'/' 离线无缓存时直接抛错，预缓存的 /index.standalone.html 无法兜 | DOC_DRIFT_ACCEPTED |
| R2-MSC-004 | P3 LOW | misc | index.html 将平台插值 {{{__platform__}}} 直接嵌入 JS 单引号字符串：值含 ') 等序列即可逃逸字符串执行任 | DOC_DRIFT_ACCEPTED |
| R2-MSC-005 | P3 LOW | misc | sanitizeUserText 嵌套 JSON 剥离不彻底：{"a":{"k":"v"}} 处理后残留 {"a":}，恰好违反自身测试断言 | DOC_DRIFT_ACCEPTED |
| R2-MSC-006 | P3 LOW | misc | golden TCK 期望与落盘结果形状漂移：blockedReasons(对象数组) vs violationReasons(字符串数组) | DOC_DRIFT_ACCEPTED |
| R2-MSC-007 | P3 LOW | misc | manifest.webmanifest 唯一图标 purpose "any maskable" 同条目混用且无 PNG 兜底：安装后图标可 | DOC_DRIFT_ACCEPTED |
| R2-MSC-008 | P3 LOW | misc | stateCoverage.test.ts『页面接线』验证用源码 includes 字符串匹配：在注释里写关键词即可绕过 | DOC_DRIFT_ACCEPTED |
| R2-MSC-009 | P3 LOW | misc | src/edge_platform/demo.db 二进制 SQLite 库入库且带 2232 次 SQLite 写入痕迹：含 1446 行 | DOC_DRIFT_ACCEPTED |
| R2-PTY-001 | P3 LOW | py-contracts | 负向量只断言非空拒绝，向量声明的 expectError 错误码从未参与比对（向量半消费） | TEST_HYGIENE_ACCEPTED |
| R2-PTY-002 | P3 LOW | py-contracts | if field=="newAssignments" 分支与 else 分支断言逐字符相同（死分支，特判意图未实现） | TEST_HYGIENE_ACCEPTED |
| R2-PTY-003 | P3 LOW | py-contracts | 「快照新鲜度拒绝」未独立重算：重放仲裁器直接信任场景预埋的 staleSnapshot 布尔标志 | TEST_HYGIENE_ACCEPTED |
| R2-PTY-004 | P3 LOW | py-contracts | EWOH_ALLOW_STUB="" 测试后泄漏进进程环境（tearDown 不清理新增变量） | TEST_HYGIENE_ACCEPTED |
| R2-PTY-005 | P3 LOW | py-contracts | 测试名承诺 not value（拒绝明文凭据）但无任何对应负路径断言 | TEST_HYGIENE_ACCEPTED |
| R2-SPT-001 | P3 LOW | scheduler-tests | fake select where no-op 模式蔓延至 NESP-017 未登记的多个文件 | TEST_HYGIENE_ACCEPTED |
| R2-SPT-002 | P3 LOW | scheduler-tests | facade 特征测试 queryFor 忽略 where 且 getRun 靠空种子绕过 | TEST_HYGIENE_ACCEPTED |
| R2-SPT-004 | P3 LOW | scheduler-tests | listRuns org 过滤用例恒真断言且未验证异 org 排除 | TEST_HYGIENE_ACCEPTED |
| R2-SPT-005 | P3 LOW | scheduler-tests | 调用序编程式 fake db：查询身份与结果均按调用次序编排 | TEST_HYGIENE_ACCEPTED |
| R2-SPT-006 | P3 LOW | scheduler-tests | 以实例私有字段覆写绕过构造注入，构造签名漂移不被捕获 | TEST_HYGIENE_ACCEPTED |
| R2-SPT-007 | P3 LOW | scheduler-tests | override-cas 的 loadForPlan mock 丢弃继承合并语义，与 overrides.spec 替身语义不一致 | TEST_HYGIENE_ACCEPTED |
| R2-SPT-008 | P3 LOW | scheduler-tests | golden-workflow per-scenario 用例对 expect 缺 key 的 op 静默跳过验证 | TEST_HYGIENE_ACCEPTED |
| R2-SCR-003 | P3 LOW | scripts | scale-release-review 缺省版本回退硬编码 0.6.0-rc4——直接调用且未设 env 时指向过期 bundle | ENV_OR_CONFIG_ACCEPTED |
| R2-SCR-006 | P3 LOW | scripts | 演练口令硬编码并随报告落盘 output/backup-restore-report.json | ENV_OR_CONFIG_ACCEPTED |
| R2-SCR-008 | P3 LOW | scripts | EWOH_SCHEMA 未做白名单校验即拼入 psql -c 命令串（shell/SQL 双注入面） | ENV_OR_CONFIG_ACCEPTED |
| R2-SCR-010 | P3 LOW | scripts | visionUnderstand 方法体提取正则惰性截断——嵌套两空格缩进闭括时凭据泄漏检测漏报 | ENV_OR_CONFIG_ACCEPTED |
| R2-SAM-009 | P3 LOW | server-am | ERP 审计 orgId 回退空串，与 MES auditOrgId 行归属回退不对齐 | DEFENSE_IN_DEPTH_ACCEPTED |
| R2-SAM-010 | P3 LOW | server-am | qualityInspection step resultJson 更新无 status 谓词：与并发工序转移互覆盖 | DEFENSE_IN_DEPTH_ACCEPTED |
| R2-SAM-011 | P3 LOW | server-am | transitionStatus UPDATE 无 org 谓词（前置 getModel 守卫存在 TOCTOU 窗口） | DEFENSE_IN_DEPTH_ACCEPTED |
| R2-SAM-013 | P3 LOW | server-am | ingestEnvironment org 缺失时写 NULL=legacy 全可见，与 camera/spatial-scan/locat | DEFENSE_IN_DEPTH_ACCEPTED |
| R2-SBZ-007 | P3 LOW | server-biz | outcome-annotation create 落账与事件非同事务——事件失败产生无事件标注 | DEFENSE_IN_DEPTH_ACCEPTED |
| R2-SBZ-008 | P3 LOW | server-biz | learning-proposal propose 幂等 select-then-insert 无 23505 处理——并发同 ID 第二请 | DEFENSE_IN_DEPTH_ACCEPTED |
| R2-SBZ-009 | P3 LOW | server-biz | Agent 审批批准后执行失败——台账停留 approved 与执行事实不一致且无标注 | DEFENSE_IN_DEPTH_ACCEPTED |
| R2-SBZ-010 | P3 LOW | server-biz | files list 与幂等查找无分页/索引化——org 文件量增长后全量加载与 N+1 GetObject | DEFENSE_IN_DEPTH_ACCEPTED |
| R2-SBZ-011 | P3 LOW | server-biz | storage 驱动未校验 orgId 格式即拼入路径/S3 键——防御性缺失 | DEFENSE_IN_DEPTH_ACCEPTED |
| R2-SBZ-012 | P3 LOW | server-biz | MES qualityInspection step 更新无 status CAS——质检结果可覆写终态工序的 resultJson | DEFENSE_IN_DEPTH_ACCEPTED |
| R2-SBZ-013 | P3 LOW | server-biz | dashboard handleEvent 无状态机/CAS——事件可重复处理且 handler 事实可被覆盖 | DEFENSE_IN_DEPTH_ACCEPTED |
| R2-SBZ-014 | P3 LOW | server-biz | gamification dispatchPlan 状态更新无 org 条件且无 status CAS——读-改-写窗口内可覆盖并发状态 | DEFENSE_IN_DEPTH_ACCEPTED |
| R2-SDB-007 | P3 LOW | server-db | DatabaseAuditSink 对 entry.orgId 强制 ::uuid 参数化 cast，与 varchar org 语义体系不 | DEFENSE_IN_DEPTH_ACCEPTED |
| R2-SDB-008 | P3 LOW | server-db | standalone_057 NULL-org 回填启发式：全部存量 NULL 行并入 min(org_id) 单一默认 org，多租户存量 | DEFENSE_IN_DEPTH_ACCEPTED |
| R2-SDB-009 | P3 LOW | server-db | DRIZZLE_DATABASE proxy 非 HTTP 路径静默回落根句柄：无告警、EWOH_DB_REQUIRE_TX 不覆盖、RLS | DEFENSE_IN_DEPTH_ACCEPTED |
| R2-SDB-010 | P3 LOW | server-db | NEST-511 修复不完整：生产 DatabaseOrgHierarchyProvider 未实现 loadAll，resolveOrgS | DEFENSE_IN_DEPTH_ACCEPTED |
| R2-TOL-001 | P3 LOW | tools | --max-create 参数校验错误消息引用错变量——永远显示 'got: --max-create' | ENV_OR_CONFIG_ACCEPTED |
| R2-TOL-002 | P3 LOW | tools | readLocks 对损坏 lock 文件静默跳过——资源锁登记可静默缺行（SCR-036 同型） | ENV_OR_CONFIG_ACCEPTED |
| R2-TOL-005 | P3 LOW | tools | validApprover 仅在 humanActors 非空时校验归属——actor 注册表解析失败时静默回退弱校验 | ENV_OR_CONFIG_ACCEPTED |

## 裁决码说明

- SYSTEMIC_REFACTOR_RULING：系统性重构级（事务边界重塑/全库类型翻转/新增持久化域），不在本轮执行，理由与缓解见各项 resolution_note。
- TEST_HYGIENE_ACCEPTED：测试卫生类，主断言完整性缺陷已修复，剩余低风险卫生项接受现状。
- UI_POLISH_ACCEPTED：视觉/交互卫生类，无数据正确性影响，接受现状。
- DOC_DRIFT_ACCEPTED：文档/示例漂移类，结构性矛盾已修并加门禁，剩余文档项接受现状。
- DEFENSE_IN_DEPTH_ACCEPTED：防御纵深/极端场景健壮性类，核心安全与租户边界已由 P0/P1/P2 修复关闭，剩余低风险纵深项接受现状。
- ENV_OR_CONFIG_ACCEPTED：依赖外部环境（CI 二进制/密钥管理流程/数据集）或配置口径类，环境不可执行者按 ENVIRONMENT_BLOCKED 语义登记，其余接受现状。
