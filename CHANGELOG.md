# 变更日志

本文件遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/) 1.1.0 规范，
并使用[语义化版本](https://semver.org/lang/zh-CN/) 2.0.0 进行版本管理。

## [0.6.0-rc2] - 2026-08-03

### Added
- 真机接入协议对齐：`UnifiedExoFrame.to_storage_dict()` 标准格式（`entity_id`
  与嵌套 `pose`/`load`/`device`/`quality`）全量映射到 Ingestion 网关。
- 机器对机器租户上下文：`X-Org-Id` 或 `EWOH_INGEST_ORG_ID` 建立请求级
  `app.current_org_id` GUC，Ingestion 落库遵循 RLS 组织隔离。
- 游戏化资源分配真实持久化 E2E：`ewoh_schedule_plan` 与
  `ewoh_schedule_audit` 均验证 org 归属。
- 新增 IngestService/IngestGuard/GamificationService 单元测试与
  edge bridge 契约测试。
- PostgreSQL 逻辑备份/恢复工具：`scripts/postgres-logical-backup.mjs`，
  支持全部 `ewoh_*` 表导出、恢复、行数比对与身份序列回填。
- 一键恢复演练：`scripts/standalone-ops-check.sh`，覆盖建库、Schema、
  逻辑备份、恢复、行数校验与恢复后写入冒烟。
- 运维手册补全：告警分级与处置 SOP、故障注入、恢复演练、应急停止、
  自动运维检查均从占位升级为可执行流程。
- 培训计划升级为可执行版本 v1.1：四类 Session、角色化练习、真机接入、
  运维恢复练习与讲师复核要求。
- Prometheus 指标端点 `GET /metrics`：HTTP 请求计数、活跃请求、进程运行
  时间、数据库就绪检查计数。
- 部署工件本地校验：`scripts/verify-deploy-artifacts.js` 检查 Kubernetes、
  docker-compose 与 Dockerfile，共 62 项检查。
- 采用 Final 4.0 权威基线：`authoritative-plan-final4.txt` 与
  `delivery/01_开发基线/...最新研究升级版_Final4.0.docx` 入库，Final 3.0 保留
  为历史基线。
- MES P0 生产执行闭环：工单创建/释放/开工/完工、工序
  开工/报工/审核/交收、投料消耗、质量检验与审计，映射到既有
  `ewoh_schedule_task` / `ewoh_schedule_task_step` / `ewoh_resource_binding` /
  `ewoh_event`，48 张受管表包装不变。
- OEE/安灯闭环：设备状态时序、OEE 计算与停机原因分布、安灯状态机、
  SLA 升级通知与审计，复用 `ewoh_event` / `ewoh_notification`。
- ERP 连接器：入站订单幂等并自动生成工单、出站消息队列与确认/失败状态、
  对账汇总，复用 `ewoh_event` / `ewoh_schedule_task` /
  `ewoh_schedule_task_step`。
- 质量追溯图：工单→工序→投料→质量检验的节点与关系图。
- 移动工作台 API：按人员列出待办工序、扫码查工单、移动端工序状态流转。
- 移动工作台前端页面：扫码查单、待办工序列表、开工/报工/审核/交收操作。
- 采用 Final 5.0 规模化复制版权威基线：
  `authoritative-plan-final5.txt` 与 `delivery/01_开发基线/...Final5.0.docx`
  入库，Final 4.0 保留为历史基线。
- 规模化内核：工厂模板注册/继承/生命周期、模板安装生成工厂 Profile、
  资产包注册；新增 `ewoh_factory_template` / `ewoh_factory_profile` /
  `ewoh_asset_package`，受管表 48 → 51。
- 连接器/场景包目录：连接器（runtime/protocol/configSchema）与场景包
  （requires/workflows/policies）复用资产包注册；同一模板可安装多个工厂
  Profile，验证“第二工厂无分叉”。
- 资产一致性检查（TCK）：按连接器/场景包/模板/部署类型校验 Manifest。
- 工厂 Profile 回放：模板配置与 Profile 覆盖值合并，状态置为
  `replayed` 并写审计。
- 场景包安装门禁：安装前必须通过场景 TCK，失败返回 400 并保留审计。
- 舰队升级/回滚：`POST /api/scale/fleet/upgrade` /
  `/api/scale/fleet/rollback` 对组织可见 Factory Profile 批量变更状态并写审计。
- AsyncAPI/CloudEvents 事件目录：`contracts/events/event-catalog.yaml` 定义
  13 个事件类型与 13 条通道，`GET /api/events/catalog` 与
  `GET /api/events/catalog/:type` 提供只读 API，独立契约审计接入
  `standalone-check.sh`。
- Docker 运行时镜像携带 `/app/contracts`，事件目录在生产容器内可读。
- Helm 部署工厂：新增 `deploy/cloud/helm/ewoh` Chart，包含 Factory Values
  （工厂 ID/名称/升级环）、迁移 Job Hook、Deployment/Service/Ingress/HPA/PDB/
  本地 PVC 模板；Chart 不从 values 生成密钥。
- Helm 静态审计：`scripts/verify-helm-chart.js` 校验 Chart 元数据、values
  路径、模板清单与全部 `.Values.*` 引用；`npm run verify:helm` 与
  `test/contract/helm-chart.spec.ts` 纳入常规测试。
- Golden Factory Profile：`contracts/factory/golden-factory.yaml` 定义 7 个
  模块、3 个必需连接器与 4 个场景包；`POST /api/scale/golden-factory/install`
  一次完成模板发布、连接器发布、场景包 TCK 安装与工厂 Profile 安装/复用。
- Golden Factory 契约审计：`scripts/audit-golden-factory.js`（47 项检查）、
  `npm run contract:golden` 与 `test/contract/golden-factory.spec.ts`。
- Mapping DSL 与 Schema Registry：`contracts/mapping/mapping-schema.json`
  定义 `mappingId/name/version/source/target/rules` 契约，并提供
  `exoskeleton-telemetry-v1` 规范示例。
- Mapping 资产 API：`POST/GET /api/scale/mappings` 与
  `GET /api/scale/mappings/:id` 复用资产包注册表；TCK 增加 mapping 一致性
  检查（source/target/rules/schemaVersion）。
- Mapping 契约审计：`scripts/audit-mapping-contracts.js`（10 项检查）、
  `npm run contract:mapping` 与 `test/contract/mapping.spec.ts`。
- 升级环与 Fleet Ops：`fleet/upgrade` 与 `fleet/rollback` 支持按
  `dev/integration/shadow/pilot/small/full` 升级环分批执行，未指定环时保持
  全量操作兼容。
- Fleet 状态注册表：`GET /api/scale/fleet/status` 返回工厂 Profile 的环、
  状态、模板/资产包计数与环/状态分布。
- Support Bundle：`POST /api/scale/fleet/support-bundle` 生成脱敏诊断包
  （`includesSecrets: false`）并写审计。
- 舰队状态机契约：`contracts/state-machines/fleet.yaml` 冻结升级环与
  installed/replayed/upgraded/rolled_back 迁移关系。
- OTel 资源属性：`/metrics` 输出 `ewoh_resource_info`，携带工厂 ID、名称、
  升级环、发布版本与区域；环境契约贯通 Standalone、Compose、Kubernetes 与
  Helm。
- 部署工件校验升级到 66 项，覆盖 Compose 资源属性环境契约；Helm Chart
  静态审计 125 项。
- 兼容目录：`GET /api/scale/compatibility` 返回资产包与核心版本兼容矩阵，
  支持 `>=/<=/>/</=` 与空格 AND 范围；未声明范围的资产标记
  `unconstrained` 兼容。
- 策略引擎：`contracts/policy/policy-schema.json` 定义策略契约；
  `POST /api/policies/evaluate` 按 dot-path 规则求值，`GET /api/policies/examples`
  提供规范示例；`scripts/audit-policy-contracts.js` 纳入一键检查。
- 模板配置差异预览：`POST /api/scale/templates/:id/diff-preview` 只读合并
  模板默认配置与请求覆盖配置，返回 `added/changed/removed` 键差异，便于
  第二工厂安装前评估影响。
- 连接器运行时：`src/edge_platform/connectors/runtime.py` 提供 Manifest
  加载/校验、配置校验、健康检查、密钥脱敏与生命周期；新增
  `exoskeleton-frame` 与 `equipment-state` 样例连接器包。
- 工厂上线：`GET /api/scale/onboarding/checklist` 提供 F0-F6 步骤清单，
  `POST /api/scale/onboarding/run` 真实执行模板发布、连接器/场景包安装、
  Profile 安装、TCK 与 Support Bundle，并输出步骤级证据与审计。
- Scale Release 评审：`scripts/scale-release-review.js` 作为打包门禁，检查
  发布清单、包完整性、契约/文档/OpenAPI 与全部静态审计；已接入
  `scripts/package-release.sh` 与 `npm run release:review`。
- Workflow 引擎骨架：`contracts/workflow/workflow-schema.json` 定义
  角色化步骤流转；`POST /api/workflows/advance` 返回当前动作许可与
  角色过滤后的下一步；`mes-execution` 规范流程示例纳入契约审计。
- Feature Flag：`GET/PUT /api/system/feature-flags` 在
  `ewoh_system_config` 持久化组织级 `feature.*` 开关，写入限定
  `global_admin`，读取按 RLS 组织隔离。
- 边缘乱序/补传：`src/edge_platform/edge/backfill.py` 提供 `SequenceBuffer`，
  按序列号连续释放帧并拒绝重复/过期/超窗帧；补传后自动续传。
- 数字孪生资产包：`src/edge_platform/twin/package.py` 提供 Twin Manifest
  校验、标定健康检查与脱敏；新增离散机加工线/装配单元样例资产包。
- 伙伴影子交付：`GET /api/scale/onboarding/partner/checklist` 与
  `POST /api/scale/onboarding/partner/shadow-run` 复用真实 F0-F6 上线路径，
  配置标记 `partnerShadow` 并输出步骤级证据。
- Deployment TCK：`scripts/deployment-tck.js` 将部署工件（66项）、Helm Chart
  （125项）与 Scale Release 评审（24项）串成统一部署验收门禁；
  `npm run deployment:tck` 一键执行。
- 规模化运营前端：新增 `/scale` 页面，展示模板/Profile/资产/兼容目录，
  并支持从页面执行 F0-F6 工厂上线运行。
- ERP/MES 连接器 Profile：新增 `erp-mes-profile-1.0.0` Manifest，配置使用
  `secretName` 引用而非内嵌凭证，并纳入 Connector Runtime 测试集。
- 规模化指标：`GET /api/scale/metrics` 输出模板/Profile/资产/场景/连接器/
  映射计数、发布率、升级环分布与兼容性汇总。
- 场景包卸载：`POST /api/scale/scenario-packs/:id/uninstall` 将场景包置为
  `uninstalled` 并写审计，补齐安装/演示/验收/移除生命周期。
- 连接器 TCK：`scripts/connector-tck.py` 与 `make connector-tck` 执行 11 项
  Manifest/配置/健康/脱敏/乱序补传检查。
- 场景包 TCK：`scripts/scenario-tck.js` 与 `npm run scenario:tck` 将
  Golden Factory/策略/Workflow/Mapping/事件目录 5 个审计串成场景验收门禁。
- 第三工厂演练：E2E 从同一已发布模板仅凭配置安装第三个工厂 Profile，
  验证无代码分叉、配置持久化与组织隔离。
- 工厂差异回收：`POST/GET /api/scale/differences` 将工厂差异登记为
  `diff.*` 配置项并写审计，支持后续平台化回收。
- 差异解决：`POST /api/scale/differences/:key/resolve` 将已回收差异标记为
  `resolved` 并写审计。
- 跨租户 TCK：`scripts/cross-tenant-tck.sh`、`make cross-tenant-tck` 与
  `npm run cross-tenant:tck` 把 HTTP+PostgreSQL 组织隔离 E2E 串成门禁。
- 工厂差异界面：`/scale` 页面新增差异登记表单、状态徽标与逐行解决操作，
  接入真实差异 API。
- Workflow 实例：`POST/GET /api/workflows/instances` 与
  `POST /api/workflows/instances/:key/advance` 将实例持久化到
  `workflow.*` 配置键，角色门禁推进并写审计。
- Support Bundle 界面：`/scale` 页面一键生成脱敏诊断包并展示
  bundleId/工厂数/敏感信息状态。
- Fleet 升级环界面：`/scale` 页面展示环分布，并支持按环升级/回滚操作。
- Workflow 实例界面：`/scale` 页面支持启动、列表与角色推进 Workflow 实例。
- 场景包界面：`/scale` 资产表支持场景包安装/卸载操作。

### Changed
- `ewoh_telemetry.assist_level` 由 `varchar(50)` 改为 `real`，与规范数值口径一致。
- 边缘桥接脚本与建模采集脚本支持 `--org-id` 并透传 `X-Org-Id`。
- 组织层级解析改为 `ewoh_find_org` / `ewoh_find_org_children`
  `SECURITY DEFINER` 函数，鉴权阶段不再回退到主组织。

### Fixed
- 真机帧因扁平字段不匹配而 400 的问题。
- 公共 Ingestion 端点缺少租户上下文导致 RLS 写入失败的问题。
- 安全探针固定夹具 UUID 与种子组织冲突，清理时误删“集团A”等种子行的问题；
  探针夹具已改为随机 UUID。

### Security
- Ingestion 缺少 `X-Org-Id` 且未配置 `EWOH_INGEST_ORG_ID` 时拒绝请求。
- OpenAPI 为全部 7 条 Ingestion 路由增加 `X-Org-Id` 必填参数契约。
- 运行时角色通过 `SECURITY DEFINER` 查询组织层级，业务表 RLS 不被绕过。

## [0.6.0-rc1] - 2026-08-03

### Added
- 六类共享契约冻结：C1 数据、C2 API（106 条路由全量 OpenAPI）、C3 状态机、
  C4 安全、C5 UI、C6 DevOps，G2 门禁通过。
- 真实 HTTP + PostgreSQL E2E：11 条用例覆盖认证、RBAC、刷新令牌轮换/撤销、
  组织 A/B 隔离、控制/世界/审批持久化与系统配置组织隔离。
- 审批持久化：审批实例/步骤/操作映射到 `ewoh_event`、`ewoh_event_chain`、
  `ewoh_audit_log`，不新增物理表。
- 浏览器级 UI 回归：Playwright 覆盖登录、指挥中心、指挥地图、设备、告警。
- 发布准备：`scripts/standalone-check.sh` 一键检查、性能冒烟、
  `docs/delivery/release-manifest.yaml`。

### Changed
- RolesGuard 默认拒绝未声明角色的业务路由；refresh token 轮换与登出撤销。
- 系统配置唯一索引调整为 `(org_id, config_key)`；模拟器后台写库纳入 GUC 事务。
- 指挥地图回放改为真实快照投影；3D 模式按 mode 着色并支持 WebGL 降级。

### Fixed
- `QueryClientProvider` 缺失导致指挥地图/设备页白屏。
- `/api/world/replay` 时间参数序列化导致 500。
- 数据库 verify SQL 的 `policy_missing` 标量子查询缺陷。

### Security
- 刷新令牌不再可无限重放；登出会撤销服务端会话。
- 审计接口限制为安全/全局管理员；客户端登出同步调用服务端撤销。
- Python 静态安全扫描归零：bandit `-ll` 0 medium/high，ruff 0 错误。
- GitHub Actions 三工作流全绿：standalone/test/security，含 Docker 镜像构建。

## [Unreleased]

本次版本将现有单机演示原型升级为受控试点系统（spec 阶段 0 Task 2：建立工程基线）。

### Added
- 工程基线：新增 `pyproject.toml`、`requirements-dev.txt`、`.env.example`、`Makefile`，
  声明纯标准库零运行时依赖，统一 unittest 测试发现与 ruff/bandit 静态检查入口。
- 适配器标准化：定义统一适配层契约（`edge/protocol`、`edge/adapter`），支持
  `real` / `controlled_test` / `simulated` 三类数据源的可配置端口映射
  （`EWOH_ADAPTER_PORTS`），为真机接入与受控测试提供一致接口。
- 生产数据库：引入 `postgres` 作为可选生产后端（`EWOH_DB_BACKEND=postgres`），
  保留 SQLite 用于开发/单机；DB 仅接入内部网络，不直接对普通用户网开放。
- API 完善：补齐 OpenAPI 3.0 规范（`docs/api/openapi.yaml`），覆盖
  auth/me/devices/telemetry/events/tasks/query/audit/models/rules/scenario/reset 全部端点。
- 身份权限：引入认证后端选择（customer/oidc/local）、JWT 会话、角色化导出权限
  （`EWOH_EXPORT_ALLOWED_ROLES`）、登录失败锁定与会话超时。
- 审计：所有写操作与导出动作落入审计日志，可在 `GET /api/audit` 查询。
- 监控：定义系统/设备/推理/业务四级监控指标与告警处理流程（见 `docs/operations/`）。
- 备份恢复：定义数据库与证据数据的备份策略、保留窗口与恢复流程占位。
- 测试与故障注入：定义 13 层测试层级与 16 类故障注入清单（见 `docs/acceptance/`）。
- 现场试点分阶段：定义四区部署拓扑（`docs/deployment/`）与分阶段上线策略。
- Go/No-Go 门禁：定义 15 条上线门禁清单作为试点放行依据。
- CI/CD：新增 GitHub Actions（test/security/package）与 CODEOWNERS 安全边界审查。
- 安全策略：新增 `SECURITY.md`，明确平台安全边界声明与漏洞报告流程。
- 服务编排：新增 `docker-compose.yml`，定义 edge-gateway / ewoh-api / ewoh-adapter /
  ewoh-inference / postgres / redis / ewoh-logs 服务与内外网络隔离。

### Changed
- 项目版本由演示原型基线提升至 `0.6.0`，描述更新为「EWOH 受控试点系统」。
- 运行入口 `python -m edge_platform.run` 保持不变，新增 `--stub` 显式回退开关的工程化说明。

### Security
- 明确平台不得写入急停 / 限扭 / 关节实时控制 / 助力实时闭环 / 限速放宽 /
  异常退出保护 / 设备失联安全态 / 绕过本地安全检查的调试指令，这些保留在设备控制器。
- 默认不采集姓名 / 身份证 / 长期精确轨迹 / 视频 / 生理数据。
- 高频原始遥测保留 7-30 天，超期降采样或清除。
- 默认不开放公网，TLS 由 edge-gateway 终结。
